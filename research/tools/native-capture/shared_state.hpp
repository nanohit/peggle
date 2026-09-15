#pragma once

#include <Windows.h>

#include <cstdint>
#include <string>

namespace peggle_capture
{
    constexpr std::uint32_t kMagic = 0x50474353; // "PGCS"
    constexpr std::uint16_t kVersion = 1;
    constexpr std::size_t kSessionPathCapacity = 1024;
    constexpr std::size_t kVariantCapacity = 128;

    enum Flags : std::uint32_t
    {
        ready = 1u << 0,
        focused = 1u << 1,
        window_visible = 1u << 2
    };

    struct SharedState
    {
        std::uint32_t magic = kMagic;
        std::uint16_t version = kVersion;
        std::uint16_t size = sizeof(SharedState);
        volatile LONG writeSequence = 0;
        std::uint32_t processId = 0;
        std::uint64_t monotonicMs = 0;
        std::uint64_t gameTimeMs = 0;
        std::int32_t speedMultiplier = 1;
        std::uint32_t flags = 0;
        std::uint64_t inputGeneration = 0;
        std::uint64_t eventGeneration = 0;
        std::uint64_t mainWindow = 0;
        wchar_t sessionDirectory[kSessionPathCapacity] = {};
        wchar_t variant[kVariantCapacity] = {};
    };

    struct Snapshot
    {
        std::uint32_t processId = 0;
        std::uint64_t monotonicMs = 0;
        std::uint64_t gameTimeMs = 0;
        std::int32_t speedMultiplier = 1;
        std::uint32_t flags = 0;
        std::uint64_t inputGeneration = 0;
        std::uint64_t eventGeneration = 0;
        HWND mainWindow = nullptr;
        std::wstring sessionDirectory;
        std::wstring variant;
    };

    inline std::wstring mapping_name(std::uint32_t process_id)
    {
        return L"Local\\PeggleResearchCapture-" + std::to_wstring(process_id);
    }

    inline bool read_consistent(const SharedState* state, Snapshot& snapshot)
    {
        if (!state || state->magic != kMagic || state->version != kVersion ||
            state->size != sizeof(SharedState)) return false;
        for (int attempt = 0; attempt < 20; ++attempt)
        {
            const auto before = state->writeSequence;
            if (before & 1) { YieldProcessor(); continue; }
            MemoryBarrier();
            Snapshot candidate;
            candidate.processId = state->processId;
            candidate.monotonicMs = state->monotonicMs;
            candidate.gameTimeMs = state->gameTimeMs;
            candidate.speedMultiplier = state->speedMultiplier;
            candidate.flags = state->flags;
            candidate.inputGeneration = state->inputGeneration;
            candidate.eventGeneration = state->eventGeneration;
            candidate.mainWindow = reinterpret_cast<HWND>(
                static_cast<std::uintptr_t>(state->mainWindow));
            candidate.sessionDirectory = state->sessionDirectory;
            candidate.variant = state->variant;
            MemoryBarrier();
            const auto after = state->writeSequence;
            if (before == after && !(after & 1))
            {
                snapshot = std::move(candidate);
                return true;
            }
        }
        return false;
    }
}
