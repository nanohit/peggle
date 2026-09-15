#pragma once

#include <cstdint>
#include <string>

namespace speed_control
{
    struct Change
    {
        int previous = 1;
        int current = 1;
        const char* hotkey = "";
    };

    // Installs a process-local virtual clock over the three APIs imported by
    // the supported Peggle executables. The original executables stay intact.
    bool install(std::string& error);

    int current_multiplier();
    std::uint64_t game_time_ms();

    // F6 cycles 1x/2x/3x. Ctrl+1, Ctrl+2, and Ctrl+3 select directly.
    bool poll_hotkeys(Change& change);
}
