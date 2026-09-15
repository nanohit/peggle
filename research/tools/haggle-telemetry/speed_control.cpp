#include "speed_control.hpp"

#include <array>
#include <atomic>
#include <limits>
#include <sstream>
#include <Windows.h>
#include "MinHook.h"

namespace
{
    using QueryPerformanceCounterFn = BOOL(WINAPI*)(LARGE_INTEGER*);
    using GetTickCountFn = DWORD(WINAPI*)();
    using SleepFn = void(WINAPI*)(DWORD);

    QueryPerformanceCounterFn g_real_qpc = nullptr;
    GetTickCountFn g_real_get_tick_count = nullptr;
    SleepFn g_real_sleep = nullptr;

    void* g_qpc_target = nullptr;
    void* g_tick_target = nullptr;
    void* g_sleep_target = nullptr;

    SRWLOCK g_clock_lock = SRWLOCK_INIT;
    std::atomic<int> g_multiplier{1};
    std::atomic<bool> g_installed{false};
    LONGLONG g_qpc_frequency = 0;
    LONGLONG g_real_qpc_base = 0;
    LONGLONG g_virtual_qpc_base = 0;
    DWORD g_real_tick_base = 0;
    std::uint64_t g_virtual_tick_base = 0;

    LONGLONG scaled_qpc_locked(LONGLONG real_now)
    {
        return g_virtual_qpc_base +
            (real_now - g_real_qpc_base) * static_cast<LONGLONG>(g_multiplier.load(std::memory_order_relaxed));
    }

    std::uint64_t scaled_tick_locked(DWORD real_now)
    {
        const auto elapsed = static_cast<DWORD>(real_now - g_real_tick_base);
        return g_virtual_tick_base +
            static_cast<std::uint64_t>(elapsed) * static_cast<std::uint64_t>(g_multiplier.load(std::memory_order_relaxed));
    }

    BOOL WINAPI hooked_qpc(LARGE_INTEGER* counter)
    {
        if (!counter || !g_real_qpc) return FALSE;
        AcquireSRWLockShared(&g_clock_lock);
        LARGE_INTEGER real = {};
        const BOOL result = g_real_qpc(&real);
        if (result) counter->QuadPart = scaled_qpc_locked(real.QuadPart);
        ReleaseSRWLockShared(&g_clock_lock);
        return result;
    }

    DWORD WINAPI hooked_get_tick_count()
    {
        if (!g_real_get_tick_count) return 0;
        AcquireSRWLockShared(&g_clock_lock);
        const auto result = static_cast<DWORD>(scaled_tick_locked(g_real_get_tick_count()));
        ReleaseSRWLockShared(&g_clock_lock);
        return result;
    }

    void WINAPI hooked_sleep(DWORD milliseconds)
    {
        if (!g_real_sleep) return;
        if (milliseconds == INFINITE)
        {
            g_real_sleep(milliseconds);
            return;
        }
        const auto multiplier = static_cast<DWORD>(g_multiplier.load(std::memory_order_relaxed));
        const auto scaled = multiplier > 1 ? milliseconds / multiplier : milliseconds;
        g_real_sleep(scaled);
    }

    bool set_multiplier(int value)
    {
        if (!g_installed.load(std::memory_order_acquire) || value < 1 || value > 3) return false;
        const auto previous = g_multiplier.load(std::memory_order_relaxed);
        if (previous == value) return false;

        AcquireSRWLockExclusive(&g_clock_lock);
        LARGE_INTEGER real_qpc = {};
        g_real_qpc(&real_qpc);
        const auto real_tick = g_real_get_tick_count();
        g_virtual_qpc_base = scaled_qpc_locked(real_qpc.QuadPart);
        g_virtual_tick_base = scaled_tick_locked(real_tick);
        g_real_qpc_base = real_qpc.QuadPart;
        g_real_tick_base = real_tick;
        g_multiplier.store(value, std::memory_order_relaxed);
        ReleaseSRWLockExclusive(&g_clock_lock);
        return true;
    }

    bool key_pressed(int virtual_key)
    {
        static std::array<bool, 256> down = {};
        const auto is_down = (GetAsyncKeyState(virtual_key) & 0x8000) != 0;
        const auto pressed = is_down && !down[virtual_key];
        down[virtual_key] = is_down;
        return pressed;
    }

    const char* minhook_error(MH_STATUS status)
    {
        const auto* text = MH_StatusToString(status);
        return text ? text : "unknown MinHook error";
    }

    bool create_hook(void* target, void* replacement, void** original, std::string& error)
    {
        const auto status = MH_CreateHook(target, replacement, original);
        if (status == MH_OK) return true;
        std::ostringstream message;
        message << "MH_CreateHook failed: " << minhook_error(status);
        error = message.str();
        return false;
    }
}

bool speed_control::install(std::string& error)
{
    if (g_installed.load(std::memory_order_acquire)) return true;

    const auto kernel = GetModuleHandleW(L"kernel32.dll");
    if (!kernel)
    {
        error = "kernel32.dll is not loaded";
        return false;
    }

    g_qpc_target = reinterpret_cast<void*>(GetProcAddress(kernel, "QueryPerformanceCounter"));
    g_tick_target = reinterpret_cast<void*>(GetProcAddress(kernel, "GetTickCount"));
    g_sleep_target = reinterpret_cast<void*>(GetProcAddress(kernel, "Sleep"));
    if (!g_qpc_target || !g_tick_target || !g_sleep_target)
    {
        error = "one or more Peggle clock APIs could not be resolved";
        return false;
    }

    LARGE_INTEGER frequency = {};
    LARGE_INTEGER initial_qpc = {};
    if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&initial_qpc))
    {
        error = "QueryPerformanceCounter is unavailable";
        return false;
    }

    const auto minhook = MH_Initialize();
    if (minhook != MH_OK && minhook != MH_ERROR_ALREADY_INITIALIZED)
    {
        error = std::string("MH_Initialize failed: ") + minhook_error(minhook);
        return false;
    }

    g_qpc_frequency = frequency.QuadPart;
    g_real_qpc_base = initial_qpc.QuadPart;
    g_virtual_qpc_base = initial_qpc.QuadPart;
    g_real_tick_base = GetTickCount();
    g_virtual_tick_base = g_real_tick_base;

    if (!create_hook(g_qpc_target, hooked_qpc, reinterpret_cast<void**>(&g_real_qpc), error) ||
        !create_hook(g_tick_target, hooked_get_tick_count, reinterpret_cast<void**>(&g_real_get_tick_count), error) ||
        !create_hook(g_sleep_target, hooked_sleep, reinterpret_cast<void**>(&g_real_sleep), error))
    {
        if (g_qpc_target) MH_RemoveHook(g_qpc_target);
        if (g_tick_target) MH_RemoveHook(g_tick_target);
        if (g_sleep_target) MH_RemoveHook(g_sleep_target);
        return false;
    }

    for (const auto target : {g_qpc_target, g_tick_target, g_sleep_target})
    {
        const auto enabled = MH_EnableHook(target);
        if (enabled != MH_OK && enabled != MH_ERROR_ENABLED)
        {
            error = std::string("MH_EnableHook failed: ") + minhook_error(enabled);
            MH_DisableHook(g_qpc_target);
            MH_DisableHook(g_tick_target);
            MH_DisableHook(g_sleep_target);
            MH_RemoveHook(g_qpc_target);
            MH_RemoveHook(g_tick_target);
            MH_RemoveHook(g_sleep_target);
            return false;
        }
    }

    g_installed.store(true, std::memory_order_release);
    return true;
}

int speed_control::current_multiplier()
{
    return g_multiplier.load(std::memory_order_relaxed);
}

std::uint64_t speed_control::game_time_ms()
{
    if (!g_installed.load(std::memory_order_acquire) || !g_real_qpc || g_qpc_frequency <= 0) return GetTickCount64();
    AcquireSRWLockShared(&g_clock_lock);
    LARGE_INTEGER real = {};
    g_real_qpc(&real);
    const auto virtual_counter = scaled_qpc_locked(real.QuadPart);
    const auto milliseconds = static_cast<std::uint64_t>(
        static_cast<long double>(virtual_counter) * 1000.0L / static_cast<long double>(g_qpc_frequency));
    ReleaseSRWLockShared(&g_clock_lock);
    return milliseconds;
}

bool speed_control::poll_hotkeys(Change& change)
{
    int requested = 0;
    const char* hotkey = "";
    const auto control_down = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    const auto one_pressed = key_pressed('1');
    const auto two_pressed = key_pressed('2');
    const auto three_pressed = key_pressed('3');
    const auto cycle_pressed = key_pressed(VK_F6);

    if (control_down && one_pressed) { requested = 1; hotkey = "Ctrl+1"; }
    else if (control_down && two_pressed) { requested = 2; hotkey = "Ctrl+2"; }
    else if (control_down && three_pressed) { requested = 3; hotkey = "Ctrl+3"; }
    else if (cycle_pressed)
    {
        requested = current_multiplier() % 3 + 1;
        hotkey = "F6";
    }

    if (!requested) return false;
    change.previous = current_multiplier();
    change.current = requested;
    change.hotkey = hotkey;
    return set_multiplier(requested);
}
