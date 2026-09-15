#include <Windows.h>
#include <wincodec.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "shared_state.hpp"

namespace fs = std::filesystem;

namespace
{
    struct Config
    {
        int visualFps = 15;
        int enabled = 1;
        int maxFrames = 108000;
        int jpegQuality = 85;
        bool losslessPng = false;
    };

    struct FramePixels
    {
        int width = 0;
        int height = 0;
        int stride = 0;
        std::vector<std::uint8_t> bgra;
        double meanLuma = 0;
        double nonBlackRatio = 0;
    };

    std::wstring windows_error(DWORD code)
    {
        wchar_t* buffer = nullptr;
        const auto length = FormatMessageW(
            FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            nullptr, code, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
        std::wstring result = length && buffer ? std::wstring(buffer, length) : L"Windows error " + std::to_wstring(code);
        if (buffer) LocalFree(buffer);
        while (!result.empty() && (result.back() == L'\r' || result.back() == L'\n')) result.pop_back();
        return result;
    }

    fs::path module_directory()
    {
        std::vector<wchar_t> buffer(32768);
        const auto length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (!length || length >= buffer.size()) return fs::current_path();
        return fs::path(std::wstring(buffer.data(), length)).parent_path();
    }

    std::string narrow_ascii(const std::wstring& value)
    {
        std::string result;
        result.reserve(value.size());
        for (const auto c : value) result.push_back(c < 128 ? static_cast<char>(c) : '?');
        return result;
    }

    std::string wide_utf8(const std::wstring& value)
    {
        if (value.empty()) return {};
        const auto size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(),
            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
        if (size <= 0) return narrow_ascii(value);
        std::string result(static_cast<std::size_t>(size), '\0');
        WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
            result.data(), size, nullptr, nullptr);
        return result;
    }

    std::string escape_json(const std::string& input)
    {
        std::ostringstream output;
        for (const unsigned char c : input)
        {
            switch (c)
            {
            case '\\': output << "\\\\"; break;
            case '"': output << "\\\""; break;
            case '\n': output << "\\n"; break;
            case '\r': output << "\\r"; break;
            case '\t': output << "\\t"; break;
            default:
                if (c < 0x20)
                    output << "\\u" << std::hex << std::setw(4) <<
                        std::setfill('0') << static_cast<int>(c);
                else output << c;
            }
        }
        return output.str();
    }

    std::string utc_timestamp()
    {
        SYSTEMTIME time = {};
        GetSystemTime(&time);
        char buffer[64] = {};
        std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
            time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
            time.wSecond, time.wMilliseconds);
        return buffer;
    }

    Config read_config(const fs::path& directory)
    {
        const auto path = (directory / L"peggle-capture.ini").wstring();
        Config config;
        config.enabled = GetPrivateProfileIntW(L"capture", L"enabled", 1, path.c_str()) ? 1 : 0;
        config.visualFps = (std::clamp)(static_cast<int>(GetPrivateProfileIntW(
            L"capture", L"visualFps", 15, path.c_str())), 1, 60);
        config.maxFrames = (std::clamp)(static_cast<int>(GetPrivateProfileIntW(
            L"capture", L"maxFrames", 108000, path.c_str())), 1, 10000000);
        config.jpegQuality = (std::clamp)(static_cast<int>(GetPrivateProfileIntW(
            L"capture", L"jpegQuality", 85, path.c_str())), 1, 100);
        wchar_t format[16] = {};
        GetPrivateProfileStringW(L"capture", L"imageFormat", L"jpeg",
            format, static_cast<DWORD>(std::size(format)), path.c_str());
        config.losslessPng = _wcsicmp(format, L"png") == 0;
        return config;
    }

    std::uint64_t count_lines(const fs::path& path)
    {
        std::ifstream stream(path, std::ios::in | std::ios::binary);
        std::uint64_t count = 0;
        std::string line;
        while (std::getline(stream, line)) if (!line.empty()) ++count;
        return count;
    }

    bool append_catalog(const fs::path& path, const std::string& record,
        std::wstring& error)
    {
        std::error_code directory_error;
        fs::create_directories(path.parent_path(), directory_error);
        if (directory_error)
        {
            error = L"Cannot create common capture catalog directory: " +
                path.parent_path().wstring();
            return false;
        }
        // Some migrated/network-backed Windows volumes reject LockFileEx.
        // Serialize all local Peggle catalog writers with a named mutex, then
        // use append-only file access so the JSONL boundary stays atomic.
        const auto mutex = CreateMutexW(nullptr, FALSE, L"Local\\PeggleResearchCatalog-v1");
        if (!mutex)
        {
            error = L"Cannot create common capture catalog mutex: " + windows_error(GetLastError());
            return false;
        }
        const auto waited = WaitForSingleObject(mutex, 10000);
        if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED)
        {
            error = L"Timed out waiting for common capture catalog mutex";
            CloseHandle(mutex);
            return false;
        }
        const auto file = CreateFileW(path.c_str(), FILE_APPEND_DATA,
            FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE)
        {
            error = L"Cannot open common capture catalog: " + windows_error(GetLastError());
            ReleaseMutex(mutex);
            CloseHandle(mutex);
            return false;
        }
        const auto line = record + "\n";
        DWORD written = 0;
        const auto ok = WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &written, nullptr) &&
            written == static_cast<DWORD>(line.size()) && FlushFileBuffers(file);
        if (!ok) error = L"Cannot append common capture catalog: " + windows_error(GetLastError());
        CloseHandle(file);
        ReleaseMutex(mutex);
        CloseHandle(mutex);
        return ok;
    }

    bool sha256_file(const fs::path& path, std::string& digest)
    {
        BCRYPT_ALG_HANDLE algorithm = nullptr;
        BCRYPT_HASH_HANDLE hash = nullptr;
        HANDLE file = INVALID_HANDLE_VALUE;
        std::vector<unsigned char> hash_object;
        std::array<unsigned char, 32> bytes = {};
        bool ok = false;
        do
        {
            if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) break;
            DWORD object_size = 0, received = 0;
            if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &received, 0) < 0) break;
            hash_object.resize(object_size);
            if (BCryptCreateHash(algorithm, &hash, hash_object.data(), object_size, nullptr, 0, 0) < 0) break;
            file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
            if (file == INVALID_HANDLE_VALUE) break;
            std::vector<unsigned char> buffer(1024 * 1024);
            for (;;)
            {
                DWORD read = 0;
                if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) break;
                if (!read)
                {
                    if (BCryptFinishHash(hash, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0) break;
                    std::ostringstream output;
                    output << std::hex << std::setfill('0');
                    for (const auto byte : bytes) output << std::setw(2) << static_cast<int>(byte);
                    digest = output.str();
                    ok = true;
                    break;
                }
                if (BCryptHashData(hash, buffer.data(), read, 0) < 0) break;
            }
        } while (false);
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        if (hash) BCryptDestroyHash(hash);
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        return ok;
    }

    bool capture_client(HWND window, FramePixels& frame, std::wstring& error)
    {
        if (!window || !IsWindow(window) || IsIconic(window))
        {
            error = L"game window is unavailable or minimized";
            return false;
        }
        RECT rect = {};
        if (!GetClientRect(window, &rect))
        {
            error = L"GetClientRect failed: " + windows_error(GetLastError());
            return false;
        }
        const auto width = rect.right - rect.left;
        const auto height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0)
        {
            error = L"game client area is empty";
            return false;
        }
        POINT origin = {0, 0};
        if (!ClientToScreen(window, &origin))
        {
            error = L"ClientToScreen failed: " + windows_error(GetLastError());
            return false;
        }

        const auto screen = GetDC(nullptr);
        const auto memory = CreateCompatibleDC(screen);
        BITMAPINFO bitmap = {};
        bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bitmap.bmiHeader.biWidth = width;
        bitmap.bmiHeader.biHeight = -height;
        bitmap.bmiHeader.biPlanes = 1;
        bitmap.bmiHeader.biBitCount = 32;
        bitmap.bmiHeader.biCompression = BI_RGB;
        void* bits = nullptr;
        const auto dib = CreateDIBSection(screen, &bitmap, DIB_RGB_COLORS, &bits, nullptr, 0);
        if (!screen || !memory || !dib || !bits)
        {
            if (dib) DeleteObject(dib);
            if (memory) DeleteDC(memory);
            if (screen) ReleaseDC(nullptr, screen);
            error = L"unable to allocate capture bitmap";
            return false;
        }
        const auto previous = SelectObject(memory, dib);
        const auto copied = BitBlt(memory, 0, 0, width, height, screen,
            origin.x, origin.y, SRCCOPY | CAPTUREBLT);
        GdiFlush();
        if (copied)
        {
            frame.width = width;
            frame.height = height;
            frame.stride = width * 4;
            frame.bgra.assign(static_cast<std::uint8_t*>(bits),
                static_cast<std::uint8_t*>(bits) + static_cast<std::size_t>(frame.stride) * height);
            double luma = 0;
            std::size_t sampled = 0;
            std::size_t non_black = 0;
            const auto pixel_count = static_cast<std::size_t>(width) * height;
            const auto stride = std::max<std::size_t>(1, pixel_count / 4096);
            for (std::size_t pixel = 0; pixel < pixel_count; pixel += stride)
            {
                const auto index = pixel * 4;
                const auto b = frame.bgra[index];
                const auto g = frame.bgra[index + 1];
                const auto r = frame.bgra[index + 2];
                const auto value = 0.0722 * b + 0.7152 * g + 0.2126 * r;
                luma += value;
                if (value > 4) ++non_black;
                ++sampled;
            }
            frame.meanLuma = sampled ? luma / sampled : 0;
            frame.nonBlackRatio = sampled ? static_cast<double>(non_black) / sampled : 0;
        }
        SelectObject(memory, previous);
        DeleteObject(dib);
        DeleteDC(memory);
        ReleaseDC(nullptr, screen);
        if (!copied) error = L"BitBlt failed: " + windows_error(GetLastError());
        return copied != FALSE;
    }

    bool encode_image(IWICImagingFactory* factory, const fs::path& path,
        const FramePixels& frame, const Config& config, std::wstring& error)
    {
        IWICStream* stream = nullptr;
        IWICBitmapEncoder* encoder = nullptr;
        IWICBitmapFrameEncode* encoded_frame = nullptr;
        IPropertyBag2* properties = nullptr;
        IWICBitmap* bitmap = nullptr;
        IWICFormatConverter* converter = nullptr;
        bool ok = false;
        do
        {
            if (FAILED(factory->CreateStream(&stream))) break;
            if (FAILED(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE))) break;
            const auto& container = config.losslessPng ? GUID_ContainerFormatPng : GUID_ContainerFormatJpeg;
            if (FAILED(factory->CreateEncoder(container, nullptr, &encoder))) break;
            if (FAILED(encoder->Initialize(stream, WICBitmapEncoderNoCache))) break;
            if (FAILED(encoder->CreateNewFrame(&encoded_frame, &properties))) break;
            if (!config.losslessPng && properties)
            {
                PROPBAG2 option = {};
                option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
                VARIANT value;
                VariantInit(&value);
                value.vt = VT_R4;
                value.fltVal = static_cast<float>(config.jpegQuality) / 100.0f;
                properties->Write(1, &option, &value);
                VariantClear(&value);
            }
            if (FAILED(encoded_frame->Initialize(properties))) break;
            if (FAILED(encoded_frame->SetSize(frame.width, frame.height))) break;
            if (FAILED(factory->CreateBitmapFromMemory(frame.width, frame.height,
                GUID_WICPixelFormat32bppBGRA, frame.stride, static_cast<UINT>(frame.bgra.size()),
                const_cast<BYTE*>(frame.bgra.data()), &bitmap))) break;
            IWICBitmapSource* source = bitmap;
            auto format = GUID_WICPixelFormat32bppBGRA;
            if (!config.losslessPng)
            {
                if (FAILED(factory->CreateFormatConverter(&converter))) break;
                BOOL convertible = FALSE;
                if (FAILED(converter->CanConvert(GUID_WICPixelFormat32bppBGRA,
                    GUID_WICPixelFormat24bppBGR, &convertible)) || !convertible) break;
                if (FAILED(converter->Initialize(bitmap, GUID_WICPixelFormat24bppBGR,
                    WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) break;
                source = converter;
                format = GUID_WICPixelFormat24bppBGR;
            }
            if (FAILED(encoded_frame->SetPixelFormat(&format))) break;
            if (FAILED(encoded_frame->WriteSource(source, nullptr))) break;
            if (FAILED(encoded_frame->Commit()) || FAILED(encoder->Commit())) break;
            ok = true;
        } while (false);
        if (converter) converter->Release();
        if (bitmap) bitmap->Release();
        if (properties) properties->Release();
        if (encoded_frame) encoded_frame->Release();
        if (encoder) encoder->Release();
        if (stream) stream->Release();
        if (!ok) error = config.losslessPng ? L"WIC PNG encoding failed" : L"WIC JPEG encoding failed";
        return ok;
    }

    int fail(const std::wstring& message)
    {
        std::wcerr << L"ERROR: " << message << L"\n";
        return 1;
    }
}

int wmain(int argc, wchar_t** argv)
{
    DWORD process_id = 0;
    for (int index = 1; index + 1 < argc; ++index)
        if (_wcsicmp(argv[index], L"--pid") == 0) process_id = wcstoul(argv[++index], nullptr, 10);
    if (!process_id) return fail(L"Usage: peggle-capture-recorder.exe --pid <runtime-pid>");

    const auto process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
    if (!process) return fail(L"Cannot open game process: " + windows_error(GetLastError()));

    HANDLE mapping = nullptr;
    peggle_capture::SharedState* shared = nullptr;
    const auto mapping_name = peggle_capture::mapping_name(process_id);
    for (int attempt = 0; attempt < 200 && !mapping; ++attempt)
    {
        mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mapping_name.c_str());
        if (!mapping) Sleep(50);
    }
    if (!mapping)
    {
        CloseHandle(process);
        return fail(L"Timed out waiting for fast-mode shared state.");
    }
    shared = static_cast<peggle_capture::SharedState*>(MapViewOfFile(
        mapping, FILE_MAP_READ, 0, 0, sizeof(peggle_capture::SharedState)));
    if (!shared)
    {
        CloseHandle(mapping);
        CloseHandle(process);
        return fail(L"MapViewOfFile failed: " + windows_error(GetLastError()));
    }

    peggle_capture::Snapshot snapshot;
    for (int attempt = 0; attempt < 200; ++attempt)
    {
        if (peggle_capture::read_consistent(shared, snapshot) &&
            !snapshot.sessionDirectory.empty() && (snapshot.flags & peggle_capture::ready)) break;
        Sleep(25);
    }
    if (snapshot.sessionDirectory.empty())
    {
        UnmapViewOfFile(shared);
        CloseHandle(mapping);
        CloseHandle(process);
        return fail(L"Fast mode did not publish a session directory.");
    }

    const fs::path session_directory(snapshot.sessionDirectory);
    const auto config = read_config(module_directory());
    std::ofstream frames(session_directory / L"frames.jsonl", std::ios::out | std::ios::binary | std::ios::trunc);
    std::ofstream log(session_directory / L"capture.log", std::ios::out | std::ios::binary | std::ios::trunc);
    if (!frames || !log)
    {
        UnmapViewOfFile(shared);
        CloseHandle(mapping);
        CloseHandle(process);
        return fail(L"Cannot create capture session streams.");
    }

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IWICImagingFactory* factory = nullptr;
    const auto factory_result = CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
    if (FAILED(factory_result)) log << "WIC factory unavailable; visual capture disabled\n";

    const auto interval_ms = 1000.0 / config.visualFps;
    double next_game_ms = static_cast<double>(snapshot.gameTimeMs);
    std::uint64_t previous_input_generation = snapshot.inputGeneration;
    std::uint64_t frame_count = 0;
    std::uint64_t missed_intervals = 0;
    std::uint64_t capture_errors = 0;
    std::uint64_t black_frames = 0;
    std::uint64_t total_frame_bytes = 0;
    std::uint64_t dropped_at_limit = 0;
    const auto started_at = utc_timestamp();

    while (WaitForSingleObject(process, 1) == WAIT_TIMEOUT)
    {
        peggle_capture::Snapshot current;
        if (!peggle_capture::read_consistent(shared, current)) continue;
        const auto game_ms = static_cast<double>(current.gameTimeMs);
        const auto due = game_ms + 1e-7 >= next_game_ms;
        const auto input_due = current.inputGeneration != previous_input_generation;
        previous_input_generation = current.inputGeneration;
        std::uint64_t missed = 0;
        double scheduled_game_ms = game_ms;
        if (due)
        {
            missed = static_cast<std::uint64_t>((std::max)(
                0.0, std::floor((game_ms - next_game_ms) / interval_ms + 1e-9)));
            scheduled_game_ms = next_game_ms + missed * interval_ms;
            next_game_ms += (missed + 1) * interval_ms;
            missed_intervals += missed;
        }
        if (!due && !input_due) continue;
        const auto capture_available =
            (current.flags & peggle_capture::focused) &&
            (current.flags & peggle_capture::window_visible);
        if (!capture_available)
        {
            if (due) ++missed_intervals;
            continue;
        }
        if (!config.enabled || !factory) continue;
        if (frame_count >= static_cast<std::uint64_t>(config.maxFrames))
        {
            ++dropped_at_limit;
            continue;
        }

        FramePixels pixels;
        std::wstring error;
        if (!capture_client(current.mainWindow, pixels, error))
        {
            ++capture_errors;
            if (due) ++missed_intervals;
            log << "capture error: " << narrow_ascii(error) << "\n";
            Sleep(10);
            continue;
        }
        std::wstringstream filename;
        filename << L"frame-" << std::setfill(L'0') << std::setw(8) << frame_count
                 << (config.losslessPng ? L".png" : L".jpg");
        const auto relative = fs::path(L"frames") / filename.str();
        const auto absolute = session_directory / relative;
        if (!encode_image(factory, absolute, pixels, config, error))
        {
            ++capture_errors;
            if (due) ++missed_intervals;
            log << "encode error: " << narrow_ascii(error) << "\n";
            continue;
        }
        std::string digest;
        if (!sha256_file(absolute, digest))
        {
            ++capture_errors;
            if (due) ++missed_intervals;
            log << "hash error: " << narrow_ascii(absolute.wstring()) << "\n";
            DeleteFileW(absolute.c_str());
            continue;
        }
        if (pixels.nonBlackRatio < 0.01) ++black_frames;
        const auto size = fs::file_size(absolute);
        total_frame_bytes += size;
        frames << "{\"sequence\":" << frame_count
               << ",\"path\":\"frames/" << narrow_ascii(filename.str()) << "\""
               << ",\"sha256\":\"" << digest << "\""
               << ",\"mediaType\":\"" << (config.losslessPng ? "image/png" : "image/jpeg") << "\""
               << ",\"width\":" << pixels.width << ",\"height\":" << pixels.height
               << ",\"byteLength\":" << size
               << ",\"monotonicMs\":" << current.monotonicMs
               << ",\"gameTimeMs\":" << current.gameTimeMs
               << ",\"scheduledGameTimeMs\":" << std::fixed << std::setprecision(3) << scheduled_game_ms
               << ",\"speedMultiplier\":" << current.speedMultiplier
               << ",\"missedIntervals\":" << missed
               << ",\"reasons\":[" << (due ? "\"cadence\"" : "")
               << (due && input_due ? "," : "") << (input_due ? "\"input\"" : "") << "]"
               << ",\"diagnostics\":{\"meanLuma\":" << std::setprecision(4) << pixels.meanLuma
               << ",\"nonBlackRatio\":" << pixels.nonBlackRatio
               << ",\"captureMethod\":\"screen-bitblt-client\"}}\n";
        frames.flush();
        ++frame_count;
    }

    const auto ended_at = utc_timestamp();
    DWORD game_exit_code = STILL_ACTIVE;
    GetExitCodeProcess(process, &game_exit_code);
    const auto game_exited_cleanly = game_exit_code == 0;
    const auto event_count = count_lines(session_directory / L"events.jsonl");
    const auto workspace_root = session_directory.parent_path().parent_path().parent_path();
    const auto catalog_path = workspace_root / L"research-dataset" / L"capture-sessions.jsonl";
    std::ofstream summary(session_directory / L"capture-summary.json",
        std::ios::out | std::ios::binary | std::ios::trunc);
    summary << "{\n"
            << "  \"format\": \"peggle-capture-summary\",\n"
            << "  \"version\": 1,\n"
            << "  \"status\": \"complete\",\n"
            << "  \"gameExitCode\": " << game_exit_code << ",\n"
            << "  \"gameExitedCleanly\": " << (game_exited_cleanly ? "true" : "false") << ",\n"
            << "  \"startedAt\": \"" << started_at << "\",\n"
            << "  \"endedAt\": \"" << ended_at << "\",\n"
            << "  \"targetGameFps\": " << config.visualFps << ",\n"
            << "  \"imageFormat\": \"" << (config.losslessPng ? "png" : "jpeg") << "\",\n"
            << "  \"jpegQuality\": " << config.jpegQuality << ",\n"
            << "  \"maxFrames\": " << config.maxFrames << ",\n"
            << "  \"eventCount\": " << event_count << ",\n"
            << "  \"frameCount\": " << frame_count << ",\n"
            << "  \"byteLength\": " << total_frame_bytes << ",\n"
            << "  \"averageFrameBytes\": " << (frame_count ? total_frame_bytes / frame_count : 0) << ",\n"
            << "  \"estimatedBytesPerGameHour\": "
            << (frame_count ? total_frame_bytes / frame_count * static_cast<std::uint64_t>(config.visualFps) * 3600 : 0) << ",\n"
            << "  \"missedScheduleIntervals\": " << missed_intervals << ",\n"
            << "  \"droppedAtFrameLimit\": " << dropped_at_limit << ",\n"
            << "  \"captureErrors\": " << capture_errors << ",\n"
            << "  \"nearBlackFrames\": " << black_frames << ",\n"
            << "  \"clock\": \"gameTimeMs\",\n"
            << "  \"accelerationInvariant\": true,\n"
            << "  \"commonCatalog\": \"" << escape_json(wide_utf8(catalog_path.wstring())) << "\",\n"
            << "  \"captureMethod\": \"screen-bitblt-client\"\n"
            << "}\n";
    summary.close();

    std::ostringstream catalog_record;
    catalog_record << "{\"format\":\"peggle-capture-catalog-entry\",\"version\":1"
                   << ",\"sessionId\":\"" << escape_json(wide_utf8(session_directory.filename().wstring())) << "\""
                   << ",\"gameVariant\":\"" << escape_json(wide_utf8(snapshot.variant)) << "\""
                   << ",\"status\":\"complete\",\"canonicalStatus\":\"level-unresolved\""
                   << ",\"gameExitCode\":" << game_exit_code
                   << ",\"gameExitedCleanly\":" << (game_exited_cleanly ? "true" : "false")
                   << ",\"startedAt\":\"" << started_at << "\",\"endedAt\":\"" << ended_at << "\""
                   << ",\"sessionPath\":\"" << escape_json(wide_utf8(session_directory.wstring())) << "\""
                   << ",\"eventCount\":" << event_count << ",\"frameCount\":" << frame_count
                   << ",\"byteLength\":" << total_frame_bytes
                   << ",\"targetGameFps\":" << config.visualFps
                   << ",\"imageFormat\":\"" << (config.losslessPng ? "png" : "jpeg") << "\""
                   << ",\"captureErrors\":" << capture_errors
                   << ",\"nearBlackFrames\":" << black_frames << "}";
    std::wstring catalog_error;
    if (!append_catalog(catalog_path, catalog_record.str(), catalog_error))
        log << "catalog error: " << narrow_ascii(catalog_error) << "\n";
    else
        log << "catalog: " << narrow_ascii(catalog_path.wstring()) << "\n";

    if (factory) factory->Release();
    CoUninitialize();
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    CloseHandle(process);
    return 0;
}
