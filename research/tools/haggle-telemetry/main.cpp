#include "stdafx.hpp"
#include "sdk/HaggleSDK.hpp"
#include "sdk/SexySDK.hpp"
#include "sdk/SexyNightsSDK.hpp"
#include "speed_control.hpp"

namespace
{
    HMODULE g_self = nullptr;
    std::atomic<std::uint64_t> g_sequence{0};
    std::mutex g_file_mutex;
    std::string g_variant = "unknown";

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
                    output << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
                else
                    output << c;
            }
        }
        return output.str();
    }

    std::string output_path()
    {
        char path[MAX_PATH] = {};
        GetModuleFileNameA(nullptr, path, MAX_PATH);
        std::string executable(path);
        const auto slash = executable.find_last_of("\\/");
        const auto directory = slash == std::string::npos ? std::string(".") : executable.substr(0, slash);
        return directory + "\\research-telemetry.jsonl";
    }

    void write_event(const std::string& type, const std::string& data_json)
    {
        std::lock_guard<std::mutex> lock(g_file_mutex);
        const auto sequence = g_sequence.fetch_add(1);
        const auto monotonic_ms = GetTickCount64();
        const auto game_time_ms = speed_control::game_time_ms();
        const auto speed_multiplier = speed_control::current_multiplier();
        std::ofstream stream(output_path(), std::ios::out | std::ios::app | std::ios::binary);
        stream << "{\"format\":\"peggle-haggle-telemetry\",\"version\":2"
               << ",\"sequence\":" << sequence
               << ",\"monotonicMs\":" << monotonic_ms
               << ",\"gameTimeMs\":" << game_time_ms
               << ",\"speedMultiplier\":" << speed_multiplier
               << ",\"gameVariant\":\"" << escape_json(g_variant) << "\""
               << ",\"type\":\"" << escape_json(type) << "\""
               << ",\"data\":" << data_json << "}\n";
        stream.flush();
    }

    void show_speed_overlay(int multiplier)
    {
        std::string text = "Game speed: " + std::to_string(multiplier) + "x";
        if (g_variant == "peggle-deluxe-1.0.1")
            Sexy::LogicMgr::AddStandardText(text, 320.0f, 80.0f, 48);
        else if (g_variant == "peggle-nights-deluxe-1.0")
            SexyNights::LogicMgr::AddStandardText(text, 320.0f, 80.0f, 48);
    }

    void poll_speed_hotkeys()
    {
        speed_control::Change change;
        if (!speed_control::poll_hotkeys(change)) return;
        std::ostringstream data;
        data << "{\"previous\":" << change.previous
             << ",\"current\":" << change.current
             << ",\"hotkey\":\"" << escape_json(change.hotkey) << "\"}";
        write_event("speed_change", data.str());
        show_speed_overlay(change.current);
    }

    template <typename PhysObj, typename RawPhysObj>
    std::pair<double, double> phys_position(PhysObj* object)
    {
        if (!object) return {0.0, 0.0};
        auto* raw = reinterpret_cast<RawPhysObj*>(object);
        const auto vtable = *reinterpret_cast<std::uint32_t*>(raw->data);
        const auto get_x = reinterpret_cast<double(__thiscall*)(PhysObj*)>(*reinterpret_cast<std::uint32_t*>(vtable + 120));
        const auto get_y = reinterpret_cast<double(__thiscall*)(PhysObj*)>(*reinterpret_cast<std::uint32_t*>(vtable + 124));
        return {get_x(object), get_y(object)};
    }

    void register_deluxe()
    {
        g_variant = "peggle-deluxe-1.0.1";
        Sexy::callbacks::init();
        Sexy::callbacks::on(Sexy::callbacks::type::main_loop, poll_speed_hotkeys);
        Sexy::callbacks::on_load_level([](Sexy::Board*, std::string& level_name)
        {
            write_event("level_load", "{\"levelName\":\"" + escape_json(level_name) + "\"}");
        });
        Sexy::callbacks::on_begin_shot([](Sexy::LogicMgr*, bool replay_point)
        {
            std::ostringstream data;
            data << "{\"gunAngleRadians\":" << Sexy::LogicMgr::GetGunAngleRadians()
                 << ",\"gunAngleDegrees\":" << Sexy::LogicMgr::GetGunAngleDegrees()
                 << ",\"replayPoint\":" << (replay_point ? "true" : "false") << "}";
            write_event("shot_begin", data.str());
        });
        Sexy::callbacks::on_peg_hit([](Sexy::Ball*, Sexy::PhysObj* object, bool flag)
        {
            const auto position = phys_position<Sexy::PhysObj, Sexy::PhysObj_>(object);
            std::ostringstream data;
            data << "{\"x\":" << position.first << ",\"y\":" << position.second
                 << ",\"flag\":" << (flag ? "true" : "false") << "}";
            write_event("peg_hit", data.str());
        });
        Sexy::callbacks::on(Sexy::callbacks::type::do_level_done, []()
        {
            write_event("level_done", "{}");
        });
    }

    void register_nights()
    {
        g_variant = "peggle-nights-deluxe-1.0";
        SexyNights::callbacks::init();
        SexyNights::callbacks::on(SexyNights::callbacks::type::main_loop, poll_speed_hotkeys);
        write_event("runtime_capability",
            "{\"levelLoad\":false,\"shotBegin\":\"state-transition-inference\","
            "\"pegHit\":false,\"levelDone\":\"state-transition-inference\","
            "\"reason\":\"current Haggle Nights callbacks are declared but their hooks are not wired\"}");
        SexyNights::callbacks::on(SexyNights::callbacks::type::main_loop, []()
        {
            static auto previous = SexyNights::LogicMgr::State::None;
            static auto** logic_mgr_storage = []()
            {
                const auto haggle = GetModuleHandleW(L"haggle-sdk.dll");
                const auto symbol = haggle
                    ? GetProcAddress(haggle, "?logic_mgr@LogicMgr@SexyNights@@2PAV12@A")
                    : nullptr;
                return reinterpret_cast<SexyNights::LogicMgr**>(symbol);
            }();
            if (!logic_mgr_storage || !*logic_mgr_storage) return;
            const auto current = reinterpret_cast<SexyNights::LogicMgr_*>(*logic_mgr_storage)->state;
            if (current == previous) return;
            std::ostringstream data;
            data << "{\"previous\":" << static_cast<int>(previous)
                 << ",\"current\":" << static_cast<int>(current) << "}";
            write_event("state_change", data.str());
            if (current == SexyNights::LogicMgr::State::Shot)
                write_event("shot_begin", "{\"inferredFromState\":true}");
            if (current == SexyNights::LogicMgr::State::LevelDone)
                write_event("level_done", "{\"inferredFromState\":true}");
            previous = current;
        });
    }

    DWORD WINAPI attach_impl(LPVOID)
    {
        auto version = Haggle::PeggleVersion::Unknown;
        for (int attempt = 0; attempt < 300 && version == Haggle::PeggleVersion::Unknown; ++attempt)
        {
            version = Haggle::get_game_version();
            if (version == Haggle::PeggleVersion::Unknown) Sleep(50);
        }
        const auto supported = version == Haggle::PeggleVersion::Deluxe101 ||
            version == Haggle::PeggleVersion::NightsDeluxe10;

        if (version == Haggle::PeggleVersion::Deluxe101)
            g_variant = "peggle-deluxe-1.0.1";
        else if (version == Haggle::PeggleVersion::NightsDeluxe10)
            g_variant = "peggle-nights-deluxe-1.0";

        std::string speed_error;
        const auto speed_ready = supported && speed_control::install(speed_error);

        if (version == Haggle::PeggleVersion::Deluxe101)
            register_deluxe();
        else if (version == Haggle::PeggleVersion::NightsDeluxe10)
            register_nights();
        else
            write_event("unsupported_game", "{}");

        if (supported)
        {
            if (speed_ready)
            {
                write_event("speed_control_ready",
                    "{\"defaultMultiplier\":1,\"cycleHotkey\":\"F6\","
                    "\"directHotkeys\":[\"Ctrl+1\",\"Ctrl+2\",\"Ctrl+3\"],"
                    "\"clockPolicy\":\"fixed-update-game-time\"}");
            }
            else
            {
                write_event("speed_control_unavailable",
                    "{\"error\":\"" + escape_json(speed_error) + "\"}");
            }
        }
        return 0;
    }

    DWORD WINAPI attach_guarded(LPVOID parameter)
    {
        __try { return attach_impl(parameter); }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            FreeLibraryAndExitThread(static_cast<HMODULE>(parameter), 0xDECEA5ED);
        }
        return 0;
    }
}

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        g_self = module;
        DisableThreadLibraryCalls(g_self);
        CreateThread(nullptr, 0, attach_guarded, g_self, 0, nullptr);
    }
    return TRUE;
}
