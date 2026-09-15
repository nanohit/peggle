#include <Windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <climits>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "shared_state.hpp"
#include "speed_control.hpp"

namespace fs = std::filesystem;

namespace
{
    HMODULE g_self = nullptr;
    std::atomic<std::uint64_t> g_sequence{0};
    std::atomic<std::uint64_t> g_event_generation{0};
    std::atomic<std::uint64_t> g_input_generation{0};
    std::mutex g_file_mutex;
    std::ofstream g_event_stream;
    std::string g_variant = "unknown";
    std::wstring g_base_window_title;
    fs::path g_session_directory;
    std::string g_session_id;
    HANDLE g_mapping = nullptr;
    peggle_capture::SharedState* g_shared = nullptr;

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

    std::string narrow_ascii(const std::wstring& value)
    {
        std::string result;
        result.reserve(value.size());
        for (const auto c : value) result.push_back(c < 128 ? static_cast<char>(c) : '?');
        return result;
    }

    fs::path module_directory()
    {
        std::vector<wchar_t> buffer(32768);
        const auto length = GetModuleFileNameW(g_self, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (!length || length >= buffer.size()) return fs::current_path();
        return fs::path(std::wstring(buffer.data(), length)).parent_path();
    }

    std::string utc_timestamp(bool filename)
    {
        SYSTEMTIME time = {};
        GetSystemTime(&time);
        char buffer[64] = {};
        if (filename)
            std::snprintf(buffer, sizeof(buffer), "%04u%02u%02uT%02u%02u%02u.%03uZ",
                time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
                time.wSecond, time.wMilliseconds);
        else
            std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
                time.wSecond, time.wMilliseconds);
        return buffer;
    }

    struct WindowSearch { DWORD processId; HWND window; };

    BOOL CALLBACK find_main_window(HWND window, LPARAM parameter)
    {
        auto* search = reinterpret_cast<WindowSearch*>(parameter);
        DWORD process_id = 0;
        GetWindowThreadProcessId(window, &process_id);
        if (process_id == search->processId && IsWindowVisible(window) && GetWindowTextLengthW(window) > 0)
        {
            search->window = window;
            return FALSE;
        }
        return TRUE;
    }

    HWND main_window()
    {
        WindowSearch search{GetCurrentProcessId(), nullptr};
        EnumWindows(find_main_window, reinterpret_cast<LPARAM>(&search));
        return search.window;
    }

    void identify_variant()
    {
        const auto directory = module_directory().filename().wstring();
        if (_wcsicmp(directory.c_str(), L"Peggle Deluxe") == 0)
            g_variant = "peggle-deluxe-popcap-1.0.0.1";
        else if (_wcsicmp(directory.c_str(), L"Peggle Nights") == 0)
            g_variant = "peggle-nights-popcap-1.0.3.6632";
    }

    bool initialize_session()
    {
        const auto pid = GetCurrentProcessId();
        const auto executable_hash = g_variant == "peggle-deluxe-popcap-1.0.0.1"
            ? "503f7afcedd7d0e02a2ade8cd3b1e8237a501006c167cce329ed44d7df0ab563"
            : (g_variant == "peggle-nights-popcap-1.0.3.6632"
                ? "aaa1b2823fb93b6f4b3d1374f44725121687ee4f05bda2dd8532b735051f2067"
                : "unknown");
        g_session_id = g_variant + "-" + utc_timestamp(true) + "-p" + std::to_string(pid);
        g_session_directory = module_directory() / L"research-sessions" /
            fs::path(std::wstring(g_session_id.begin(), g_session_id.end()));
        std::error_code error;
        fs::create_directories(g_session_directory / L"frames", error);
        if (error) return false;
        g_event_stream.open(g_session_directory / L"events.jsonl",
            std::ios::out | std::ios::binary | std::ios::trunc);
        if (!g_event_stream) return false;

        std::ofstream manifest(g_session_directory / L"session.json",
            std::ios::out | std::ios::binary | std::ios::trunc);
        manifest << "{\n"
                 << "  \"format\": \"peggle-capture-session\",\n"
                 << "  \"version\": 1,\n"
                 << "  \"sessionId\": \"" << escape_json(g_session_id) << "\",\n"
                 << "  \"status\": \"started\",\n"
                 << "  \"startedAt\": \"" << utc_timestamp(false) << "\",\n"
                 << "  \"runtime\": {\"kind\":\"native-windows-x86\",\"game\":\""
                 << escape_json(g_variant) << "\",\"processId\":" << pid
                 << ",\"executableSha256\":\"" << executable_hash << "\"},\n"
                 << "  \"clock\": {\"canonical\":\"gameTimeMs\",\"wall\":\"monotonicMs\","
                    "\"accelerationInvariant\":true},\n"
                 << "  \"streams\": {\"events\":\"events.jsonl\",\"frames\":\"frames.jsonl\","
                    "\"frameDirectory\":\"frames/\"}\n"
                 << "}\n";
        return true;
    }

    bool initialize_shared_state()
    {
        const auto name = peggle_capture::mapping_name(GetCurrentProcessId());
        g_mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
            sizeof(peggle_capture::SharedState), name.c_str());
        if (!g_mapping) return false;
        g_shared = static_cast<peggle_capture::SharedState*>(MapViewOfFile(
            g_mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(peggle_capture::SharedState)));
        if (!g_shared) return false;
        *g_shared = peggle_capture::SharedState{};
        g_shared->processId = GetCurrentProcessId();
        wcsncpy_s(g_shared->sessionDirectory, g_session_directory.c_str(), _TRUNCATE);
        const std::wstring variant(g_variant.begin(), g_variant.end());
        wcsncpy_s(g_shared->variant, variant.c_str(), _TRUNCATE);
        return true;
    }

    void publish_shared(HWND window, bool focused)
    {
        if (!g_shared) return;
        InterlockedIncrement(&g_shared->writeSequence);
        MemoryBarrier();
        g_shared->monotonicMs = GetTickCount64();
        g_shared->gameTimeMs = speed_control::game_time_ms();
        g_shared->speedMultiplier = speed_control::current_multiplier();
        g_shared->flags = peggle_capture::ready |
            (focused ? peggle_capture::focused : 0) |
            (window && IsWindowVisible(window) ? peggle_capture::window_visible : 0);
        g_shared->inputGeneration = g_input_generation.load(std::memory_order_relaxed);
        g_shared->eventGeneration = g_event_generation.load(std::memory_order_relaxed);
        g_shared->mainWindow = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(window));
        MemoryBarrier();
        InterlockedIncrement(&g_shared->writeSequence);
    }

    void write_event(const std::string& type, const std::string& data_json,
        bool input = false, bool request_frame = false)
    {
        std::lock_guard<std::mutex> lock(g_file_mutex);
        const auto sequence = g_sequence.fetch_add(1);
        const auto monotonic_ms = GetTickCount64();
        const auto game_time_ms = speed_control::game_time_ms();
        g_event_stream << "{\"format\":\"peggle-capture-event\",\"version\":1"
                       << ",\"sequence\":" << sequence
                       << ",\"monotonicMs\":" << monotonic_ms
                       << ",\"gameTimeMs\":" << game_time_ms
                       << ",\"speedMultiplier\":" << speed_control::current_multiplier()
                       << ",\"gameVariant\":\"" << escape_json(g_variant) << "\""
                       << ",\"type\":\"" << escape_json(type) << "\""
                       << ",\"data\":" << data_json << "}\n";
        g_event_stream.flush();
        g_event_generation.fetch_add(1, std::memory_order_relaxed);
        if (input && request_frame) g_input_generation.fetch_add(1, std::memory_order_relaxed);
    }

    void show_speed(int multiplier)
    {
        const auto window = main_window();
        if (!window) return;
        if (g_base_window_title.empty())
        {
            std::vector<wchar_t> title(1024);
            const auto length = GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
            if (length > 0) g_base_window_title.assign(title.data(), length);
        }
        if (!g_base_window_title.empty())
        {
            const auto title = g_base_window_title + L"  [FAST " + std::to_wstring(multiplier) + L"x]";
            SetWindowTextW(window, title.c_str());
        }
    }

    const char* key_name(int key)
    {
        switch (key)
        {
        case VK_LBUTTON: return "mouse_left";
        case VK_RBUTTON: return "mouse_right";
        case VK_MBUTTON: return "mouse_middle";
        case VK_XBUTTON1: return "mouse_x1";
        case VK_XBUTTON2: return "mouse_x2";
        default: return nullptr;
        }
    }

    void poll_input(HWND window, bool focused)
    {
        static std::array<bool, 256> previous = {};
        static POINT previous_cursor{LONG_MIN, LONG_MIN};
        static std::uint64_t previous_move_game_ms = 0;
        static bool previous_focus = false;

        if (focused != previous_focus)
        {
            write_event("input.focus", focused ? "{\"focused\":true}" : "{\"focused\":false}", true, true);
            previous_focus = focused;
        }
        if (!focused || !window)
        {
            for (auto& value : previous) value = false;
            return;
        }

        POINT cursor = {};
        if (GetCursorPos(&cursor))
        {
            POINT client = cursor;
            ScreenToClient(window, &client);
            RECT rect = {};
            GetClientRect(window, &rect);
            const auto game_ms = speed_control::game_time_ms();
            if ((cursor.x != previous_cursor.x || cursor.y != previous_cursor.y) &&
                game_ms >= previous_move_game_ms + 16)
            {
                const auto width = std::max<LONG>(1, rect.right - rect.left);
                const auto height = std::max<LONG>(1, rect.bottom - rect.top);
                std::ostringstream data;
                data << "{\"screenX\":" << cursor.x << ",\"screenY\":" << cursor.y
                     << ",\"x\":" << client.x << ",\"y\":" << client.y
                     << ",\"normalizedX\":" << std::setprecision(9)
                     << static_cast<double>(client.x) / width
                     << ",\"normalizedY\":" << static_cast<double>(client.y) / height
                     << ",\"clientWidth\":" << width << ",\"clientHeight\":" << height << "}";
                write_event("input.pointer_move", data.str(), true, false);
                previous_cursor = cursor;
                previous_move_game_ms = game_ms;
            }
        }

        for (int key = 1; key < 256; ++key)
        {
            const auto down = (GetAsyncKeyState(key) & 0x8000) != 0;
            if (down == previous[key]) continue;
            previous[key] = down;
            std::ostringstream data;
            data << "{\"virtualKey\":" << key << ",\"down\":" << (down ? "true" : "false");
            if (const auto name = key_name(key)) data << ",\"name\":\"" << name << "\"";
            data << "}";
            write_event(key_name(key) ? "input.pointer_button" : "input.key", data.str(), true, true);
        }
    }

    DWORD WINAPI run(LPVOID)
    {
        identify_variant();
        if (!initialize_session()) return 0;
        std::string error;
        if (!speed_control::install(error))
        {
            write_event("speed_control_unavailable", "{\"error\":\"" + escape_json(error) + "\"}");
            return 0;
        }
        initialize_shared_state();
        show_speed(1);
        write_event("session_started", "{\"sessionId\":\"" + escape_json(g_session_id) + "\"}");
        write_event("speed_control_ready",
            "{\"defaultMultiplier\":1,\"cycleHotkey\":\"F6\"," 
            "\"directHotkeys\":[\"Ctrl+1\",\"Ctrl+2\",\"Ctrl+3\"],"
            "\"clockPolicy\":\"continuous-scaled-game-time-with-real-monotonic-time\"," 
            "\"runtimePatch\":\"process-local-api-hooks\"}");

        for (;;)
        {
            const auto window = main_window();
            const auto foreground = GetForegroundWindow();
            const auto focused = window && (foreground == window || IsChild(window, foreground));
            speed_control::Change change;
            if (speed_control::poll_hotkeys(change))
            {
                show_speed(change.current);
                std::ostringstream data;
                data << "{\"previous\":" << change.previous << ",\"current\":" << change.current
                     << ",\"hotkey\":\"" << escape_json(change.hotkey) << "\"}";
                write_event("speed_change", data.str(), true, true);
            }
            poll_input(window, focused);
            publish_shared(window, focused);
            WaitForSingleObject(GetCurrentProcess(), 5);
        }
    }
}

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        g_self = module;
        DisableThreadLibraryCalls(g_self);
        CreateThread(nullptr, 0, run, nullptr, 0, nullptr);
    }
    return TRUE;
}
