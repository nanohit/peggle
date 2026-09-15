#include <Windows.h>
#include <TlHelp32.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace
{
    constexpr wchar_t kDeluxeExe[] = L"Peggle.exe";
    constexpr wchar_t kNightsExe[] = L"PeggleNights.exe";
    constexpr wchar_t kRuntimeExe[] = L"popcapgame1.exe";
    constexpr wchar_t kDeluxeRuntimeDirectory[] = L"Peggle";
    constexpr wchar_t kNightsRuntimeDirectory[] = L"PeggleNights";
    constexpr char kDeluxeSha256[] = "503f7afcedd7d0e02a2ade8cd3b1e8237a501006c167cce329ed44d7df0ab563";
    constexpr char kNightsSha256[] = "aaa1b2823fb93b6f4b3d1374f44725121687ee4f05bda2dd8532b735051f2067";

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
        if (!length || length == buffer.size()) throw std::runtime_error("Unable to resolve launcher path");
        return fs::path(std::wstring(buffer.data(), length)).parent_path();
    }

    bool sha256_file(const fs::path& path, std::string& digest, std::wstring& error)
    {
        BCRYPT_ALG_HANDLE algorithm = nullptr;
        BCRYPT_HASH_HANDLE hash = nullptr;
        HANDLE file = INVALID_HANDLE_VALUE;
        std::vector<unsigned char> hash_object;
        std::array<unsigned char, 32> bytes = {};
        bool ok = false;

        do
        {
            if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
            {
                error = L"BCryptOpenAlgorithmProvider(SHA-256) failed";
                break;
            }
            DWORD object_size = 0;
            DWORD received = 0;
            if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &received, 0) < 0)
            {
                error = L"BCryptGetProperty(BCRYPT_OBJECT_LENGTH) failed";
                break;
            }
            hash_object.resize(object_size);
            if (BCryptCreateHash(algorithm, &hash, hash_object.data(), object_size, nullptr, 0, 0) < 0)
            {
                error = L"BCryptCreateHash failed";
                break;
            }

            file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
            if (file == INVALID_HANDLE_VALUE)
            {
                error = L"Cannot read " + path.wstring() + L": " + windows_error(GetLastError());
                break;
            }

            std::vector<unsigned char> buffer(1024 * 1024);
            for (;;)
            {
                DWORD read = 0;
                if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr))
                {
                    error = L"ReadFile failed: " + windows_error(GetLastError());
                    break;
                }
                if (!read)
                {
                    if (BCryptFinishHash(hash, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0)
                    {
                        error = L"BCryptFinishHash failed";
                        break;
                    }
                    std::ostringstream output;
                    output << std::hex << std::setfill('0');
                    for (const auto byte : bytes) output << std::setw(2) << static_cast<int>(byte);
                    digest = output.str();
                    ok = true;
                    break;
                }
                if (BCryptHashData(hash, buffer.data(), read, 0) < 0)
                {
                    error = L"BCryptHashData failed";
                    break;
                }
            }
        } while (false);

        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        if (hash) BCryptDestroyHash(hash);
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        return ok;
    }

    bool equals_ignore_case(const wchar_t* left, const wchar_t* right)
    {
        return _wcsicmp(left, right) == 0;
    }

    bool set_user_install_path(const wchar_t* product, const fs::path& directory,
        std::wstring& error)
    {
        const auto subkey = std::wstring(L"Software\\PopCap\\") + product;
        HKEY key = nullptr;
        const auto opened = RegCreateKeyExW(HKEY_CURRENT_USER, subkey.c_str(), 0, nullptr,
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &key, nullptr);
        if (opened != ERROR_SUCCESS)
        {
            error = L"Unable to open HKCU\\" + subkey + L": " + windows_error(opened);
            return false;
        }
        const auto value = fs::absolute(directory).wstring();
        const auto written = RegSetValueExW(key, L"InstallPath", 0, REG_SZ,
            reinterpret_cast<const BYTE*>(value.c_str()),
            static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
        RegCloseKey(key);
        if (written != ERROR_SUCCESS)
        {
            error = L"Unable to update HKCU\\" + subkey + L"\\InstallPath: " +
                windows_error(written);
            return false;
        }
        return true;
    }

    bool wait_for_game_startup(HANDLE process, DWORD milliseconds, std::wstring& error)
    {
        const auto slices = milliseconds / 50;
        for (DWORD attempt = 0; attempt < slices; ++attempt)
        {
            if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0)
            {
                DWORD exit_code = 0;
                GetExitCodeProcess(process, &exit_code);
                error = L"Peggle exited during startup (exit code " +
                    std::to_wstring(exit_code) + L")";
                return false;
            }
            Sleep(50);
        }
        return true;
    }

    fs::path runtime_path(const wchar_t* runtime_directory)
    {
        std::vector<wchar_t> buffer(32768);
        const auto length = GetEnvironmentVariableW(
            L"ProgramData", buffer.data(), static_cast<DWORD>(buffer.size()));
        if (!length || length >= buffer.size())
            throw std::runtime_error("Unable to resolve ProgramData");
        return fs::path(std::wstring(buffer.data(), length)) /
            L"PopCap Games" / runtime_directory / kRuntimeExe;
    }

    DWORD find_process_id(const wchar_t* executable_name, const fs::path& expected_path)
    {
        const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) return 0;
        PROCESSENTRY32W entry = {};
        entry.dwSize = sizeof(entry);
        DWORD result = 0;
        if (Process32FirstW(snapshot, &entry))
        {
            do
            {
                if (equals_ignore_case(entry.szExeFile, executable_name))
                {
                    const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,
                        FALSE, entry.th32ProcessID);
                    if (process)
                    {
                        wchar_t process_path[32768] = {};
                        DWORD process_path_length = static_cast<DWORD>(
                            sizeof(process_path) / sizeof(process_path[0]));
                        const auto matches = QueryFullProcessImageNameW(process, 0,
                            process_path, &process_path_length) &&
                            equals_ignore_case(process_path, expected_path.c_str());
                        CloseHandle(process);
                        if (matches)
                        {
                            result = entry.th32ProcessID;
                            break;
                        }
                    }
                }
            } while (Process32NextW(snapshot, &entry));
        }
        CloseHandle(snapshot);
        return result;
    }

    struct WindowSearch
    {
        DWORD process_id = 0;
        bool found = false;
    };

    BOOL CALLBACK find_visible_window(HWND window, LPARAM parameter)
    {
        auto* search = reinterpret_cast<WindowSearch*>(parameter);
        DWORD process_id = 0;
        GetWindowThreadProcessId(window, &process_id);
        if (process_id == search->process_id && IsWindowVisible(window) &&
            GetWindowTextLengthW(window) > 0)
        {
            search->found = true;
            return FALSE;
        }
        return TRUE;
    }

    bool has_visible_window(DWORD process_id)
    {
        WindowSearch search{process_id, false};
        EnumWindows(find_visible_window, reinterpret_cast<LPARAM>(&search));
        return search.found;
    }

    bool start_game(const fs::path& game, std::wstring& error)
    {
        STARTUPINFOW startup = {};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process = {};
        const auto working_directory = game.parent_path().wstring();
        if (!CreateProcessW(game.c_str(), nullptr, nullptr, nullptr, FALSE, 0,
            nullptr, working_directory.c_str(), &startup, &process))
        {
            error = L"Unable to start " + game.filename().wstring() + L": " +
                windows_error(GetLastError());
            return false;
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return true;
    }

    bool start_capture_recorder(const fs::path& executable, DWORD process_id,
        PROCESS_INFORMATION& capture, std::wstring& error)
    {
        if (!fs::is_regular_file(executable))
        {
            error = L"Required capture recorder is missing: " + executable.wstring();
            return false;
        }
        std::wstring command = L"\"" + executable.wstring() + L"\" --pid " +
            std::to_wstring(process_id);
        std::vector<wchar_t> mutable_command(command.begin(), command.end());
        mutable_command.push_back(L'\0');
        STARTUPINFOW startup = {};
        startup.cb = sizeof(startup);
        if (!CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr,
            FALSE, CREATE_NO_WINDOW, nullptr, executable.parent_path().c_str(),
            &startup, &capture))
        {
            error = L"Unable to start visual capture recorder: " + windows_error(GetLastError());
            return false;
        }
        return true;
    }

    std::uintptr_t remote_module_base(DWORD process_id, const wchar_t* module_name)
    {
        // A process returned by CreateProcess can briefly reject module
        // snapshots while the loader is still publishing its module list.
        for (int attempt = 0; attempt < 100; ++attempt)
        {
            const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, process_id);
            if (snapshot != INVALID_HANDLE_VALUE)
            {
                MODULEENTRY32W entry = {};
                entry.dwSize = sizeof(entry);
                if (Module32FirstW(snapshot, &entry))
                {
                    do
                    {
                        if (equals_ignore_case(entry.szModule, module_name))
                        {
                            const auto result = reinterpret_cast<std::uintptr_t>(entry.modBaseAddr);
                            CloseHandle(snapshot);
                            return result;
                        }
                    } while (Module32NextW(snapshot, &entry));
                }
                CloseHandle(snapshot);
            }
            Sleep(50);
        }
        return 0;
    }

    void* remote_function_address(DWORD process_id, const char* function_name, std::wstring& error)
    {
        const auto kernel = GetModuleHandleW(L"kernel32.dll");
        const auto local_function = kernel ? GetProcAddress(kernel, function_name) : nullptr;
        if (!local_function)
        {
            error = L"Cannot resolve local LoadLibraryW";
            return nullptr;
        }

        MEMORY_BASIC_INFORMATION memory = {};
        if (!VirtualQuery(local_function, &memory, sizeof(memory)))
        {
            error = L"VirtualQuery(LoadLibraryW) failed";
            return nullptr;
        }
        const auto local_module = static_cast<HMODULE>(memory.AllocationBase);
        wchar_t local_module_path[MAX_PATH] = {};
        if (!GetModuleFileNameW(local_module, local_module_path, MAX_PATH))
        {
            error = L"Cannot identify the module that owns LoadLibraryW";
            return nullptr;
        }
        const auto module_name = fs::path(local_module_path).filename().wstring();
        const auto remote_base = remote_module_base(process_id, module_name.c_str());
        if (!remote_base)
        {
            error = L"Cannot find " + module_name + L" in the Peggle process";
            return nullptr;
        }
        const auto offset = reinterpret_cast<std::uintptr_t>(local_function) -
            reinterpret_cast<std::uintptr_t>(local_module);
        return reinterpret_cast<void*>(remote_base + offset);
    }

    bool inject_library(const PROCESS_INFORMATION& process, const fs::path& library, std::wstring& error)
    {
        const auto absolute = fs::absolute(library).wstring();
        if (!fs::is_regular_file(absolute))
        {
            error = L"Required DLL is missing: " + absolute;
            return false;
        }
        const auto load_library = remote_function_address(process.dwProcessId, "LoadLibraryW", error);
        if (!load_library) return false;

        const auto bytes = (absolute.size() + 1) * sizeof(wchar_t);
        const auto remote_path = VirtualAllocEx(process.hProcess, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!remote_path)
        {
            error = L"VirtualAllocEx failed: " + windows_error(GetLastError());
            return false;
        }

        bool ok = false;
        HANDLE thread = nullptr;
        do
        {
            if (!WriteProcessMemory(process.hProcess, remote_path, absolute.c_str(), bytes, nullptr))
            {
                error = L"WriteProcessMemory failed: " + windows_error(GetLastError());
                break;
            }
            thread = CreateRemoteThread(process.hProcess, nullptr, 0,
                reinterpret_cast<LPTHREAD_START_ROUTINE>(load_library), remote_path, 0, nullptr);
            if (!thread)
            {
                error = L"CreateRemoteThread failed: " + windows_error(GetLastError());
                break;
            }
            if (WaitForSingleObject(thread, 15000) != WAIT_OBJECT_0)
            {
                error = L"Timed out while loading " + library.filename().wstring();
                break;
            }
            DWORD module_handle = 0;
            if (!GetExitCodeThread(thread, &module_handle) || !module_handle)
            {
                error = L"LoadLibraryW rejected " + library.filename().wstring();
                break;
            }
            ok = true;
        } while (false);

        if (thread) CloseHandle(thread);
        VirtualFreeEx(process.hProcess, remote_path, 0, MEM_RELEASE);
        return ok;
    }

    int fail(const std::wstring& message)
    {
        std::wcerr << L"ERROR: " << message << L"\n";
        MessageBoxW(nullptr, message.c_str(), L"Peggle Fast Launcher", MB_OK | MB_ICONERROR);
        return 1;
    }
}

int wmain(int argc, wchar_t** argv)
{
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleTitleW(L"Peggle Fast + Research Launcher");

    fs::path launcher_dir;
    try { launcher_dir = module_directory(); }
    catch (const std::exception& exception)
    {
        const std::string message = exception.what();
        return fail(L"Unable to resolve launcher directory: " + std::wstring(message.begin(), message.end()));
    }

    fs::path game;
    if (argc >= 2) game = fs::absolute(argv[1]);
    else if (fs::is_regular_file(launcher_dir / kDeluxeExe)) game = launcher_dir / kDeluxeExe;
    else if (fs::is_regular_file(launcher_dir / kNightsExe)) game = launcher_dir / kNightsExe;
    else return fail(L"Put this launcher beside Peggle.exe or PeggleNights.exe, or pass the game path as its first argument.");

    const auto name = game.filename().wstring();
    const char* expected_hash = nullptr;
    const wchar_t* runtime_directory = nullptr;
    if (equals_ignore_case(name.c_str(), kDeluxeExe))
    {
        expected_hash = kDeluxeSha256;
        runtime_directory = kDeluxeRuntimeDirectory;
    }
    else if (equals_ignore_case(name.c_str(), kNightsExe))
    {
        expected_hash = kNightsSha256;
        runtime_directory = kNightsRuntimeDirectory;
    }
    else return fail(L"Unsupported executable name: " + name);

    std::wstring error;
    std::string actual_hash;
    if (!sha256_file(game, actual_hash, error)) return fail(error);
    if (actual_hash != expected_hash)
    {
        return fail(L"Executable hash is not supported. No DLL was injected.\n\nFile: " + game.wstring() +
            L"\nSHA-256: " + std::wstring(actual_hash.begin(), actual_hash.end()));
    }

    // The PopCap launch stub resolves its payload through InstallPath. Keep the
    // per-user value aligned with this verified copy so moving the workspace
    // between drives does not require elevation or a separate registry step.
    if (!set_user_install_path(runtime_directory, game.parent_path(), error)) return fail(error);

    std::wcout << L"Verified: " << game.filename().wstring() << L"\n";
    std::wcout << L"Hotkeys: F6 cycles 1x/2x/3x; Ctrl+1, Ctrl+2, Ctrl+3 select directly.\n";
    std::wcout << L"Telemetry keeps a separate logical game clock, so acceleration does not compress dataset time.\n";

    fs::path expected_runtime;
    try { expected_runtime = runtime_path(runtime_directory); }
    catch (const std::exception& exception)
    {
        const std::string message = exception.what();
        return fail(std::wstring(message.begin(), message.end()));
    }

    // Both retail EXEs are launch stubs. The actual unpacked game runs as
    // ProgramData\PopCap Games\<product>\popcapgame1.exe. Injecting the stub
    // races the old packer and crashes during handoff, so attach only to the
    // verified unpacked runtime after its menu is visible.
    auto process_id = find_process_id(kRuntimeExe, expected_runtime);
    if (!process_id)
    {
        std::wcout << L"Starting " << name << L" and waiting for its unpacked runtime.\n";
        if (!start_game(game, error)) return fail(error);
        for (int attempt = 0; attempt < 240; ++attempt)
        {
            process_id = find_process_id(kRuntimeExe, expected_runtime);
            if (process_id && has_visible_window(process_id)) break;
            process_id = 0;
            Sleep(250);
        }
        if (!process_id)
            return fail(L"Timed out waiting for the visible Peggle runtime window.");
    }
    std::wcout << L"Attaching to the unpacked " << name << L" runtime.\n";

    PROCESS_INFORMATION process = {};
    process.dwProcessId = process_id;
    process.hProcess = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION |
        PROCESS_VM_OPERATION | PROCESS_VM_WRITE | SYNCHRONIZE,
        FALSE, process_id);
    if (!process.hProcess)
        return fail(L"OpenProcess failed: " + windows_error(GetLastError()));

    wchar_t process_path[32768] = {};
    DWORD process_path_length = static_cast<DWORD>(sizeof(process_path) / sizeof(process_path[0]));
    if (!QueryFullProcessImageNameW(process.hProcess, 0, process_path, &process_path_length) ||
        !equals_ignore_case(process_path, expected_runtime.c_str()))
    {
        CloseHandle(process.hProcess);
        return fail(L"A different process with the expected filename is already running; no DLL was injected.");
    }

    if (!wait_for_game_startup(process.hProcess, 250, error))
    {
        if (process.hThread) CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return fail(error);
    }

    const auto fast_mod = launcher_dir / L"peggle-fast-mod.dll";
    if (!inject_library(process, fast_mod, error))
    {
        if (process.hThread) CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return fail(error);
    }

    PROCESS_INFORMATION capture = {};
    const auto capture_recorder = launcher_dir / L"peggle-capture-recorder.exe";
    if (!start_capture_recorder(capture_recorder, process.dwProcessId, capture, error))
    {
        CloseHandle(process.hProcess);
        return fail(error);
    }

    std::wcout << L"Fast mode and research capture loaded successfully.\n";
    std::wcout << L"Session bundles are written under research-sessions. The original EXE was not modified.\n";
    WaitForSingleObject(process.hProcess, INFINITE);
    if (capture.hProcess)
    {
        WaitForSingleObject(capture.hProcess, 15000);
        CloseHandle(capture.hThread);
        CloseHandle(capture.hProcess);
    }
    if (process.hThread) CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
