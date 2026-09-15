# Native Peggle fast mode and capture sessions

The deployed x86 stack has three independent responsibilities:

- `peggle-fast-launcher.exe` verifies the exact retail EXE, starts or attaches
  to the unpacked runtime, injects fast mode, and starts the capture sidecar;
- `peggle-fast-mod.dll` owns the continuous 1x/2x/3x virtual clock, focused
  keyboard/pointer observations, and a versioned shared-memory clock feed;
- `peggle-capture-recorder.exe` captures the visible client area into hashed
  JPEG or lossless PNG frames on a fixed **game-time** cadence.

The original EXEs, PAKs, physics constants, and save files are never rewritten.
The experimental `haggle-sdk.dll` and `research-telemetry-mod.dll` are still
built for compatible research layouts, but are not loaded by the production
launcher because these installed PopCap wrapper builds have a different Haggle
function-address layout.

## Normal use

Run `peggle-fast-launcher.exe` from the desired game directory. It can also
attach to a game already at its menu. The window title confirms the current
state with `[FAST 1x]`, `[FAST 2x]`, or `[FAST 3x]`.

Hotkeys:

- `F6`: 1x -> 2x -> 3x -> 1x;
- `Ctrl+1`, `Ctrl+2`, `Ctrl+3`: select directly.

Every launch creates a new raw bundle under
`<game>\research-sessions\<session-id>\`:

```text
session.json             session identity, runtime and stream contract
events.jsonl             inputs, focus, speed and dual-clock events
frames.jsonl             frame timing, SHA-256, cadence gaps and diagnostics
frames/*.{jpg,png}       client-area captures (hashed individually)
capture-summary.json     completion and quality summary
capture.log              sidecar errors, normally empty
```

On clean completion the sidecar also appends one locked JSONL entry to the
shared workspace catalog `research-dataset\capture-sessions.jsonl`. Deluxe and
Nights therefore appear in one automatic raw-session index. Entries remain
`canonicalStatus: "level-unresolved"` until an exact level is supplied; the
catalog never fabricates a training label.

Mouse/key transitions trigger immediate frames. Pointer movement is recorded
at most once per ~16 ms of game time but does not force extra images. Cadence
capture pauses while the game is unfocused/minimized, so another application is
not silently recorded; those missing intervals remain explicit in the summary.

## Acceleration-invariant clocks

`events.jsonl` and `frames.jsonl` contain both unscaled `monotonicMs`, gameplay
`gameTimeMs`, and the active `speedMultiplier`. Frame cadence is scheduled
against `gameTimeMs`. The default 15 game FPS may therefore require up to 45
real captures/sec at 3x. If encoding/storage cannot keep up, the recorder
captures the newest due state and records `missedIntervals`; it never duplicates
a stale image to pretend coverage.

Edit `peggle-capture.ini` to trade temporal density for CPU/storage:

```ini
[capture]
enabled=1
visualFps=15
imageFormat=jpeg
jpegQuality=85
maxFrames=108000
```

`maxFrames=108000` is two game-hours at the default cadence. JPEG is the
large-scale collection default; use `imageFormat=png` for pixel-exact short
sessions. `capture-summary.json` reports actual bytes/frame and an estimated
bytes/game-hour budget. Per-frame SHA-256 and near-black diagnostics make
corrupt/fullscreen capture detectable during finalization.

## Canonical finalization and common dataset

The native binary cannot reliably identify the active authored level in these
layouts. A raw session is therefore not assigned a fabricated level digest.
After ingesting the exact level, finalize and append atomically:

```powershell
node research/tools/finalize-capture-session.mjs `
  "..\Peggle Deluxe\research-sessions\<session-id>" `
  research/generated/<session-id>.run.json `
  --level research/generated/<exact-level>.json `
  --dataset ../research-dataset/dataset.jsonl
```

The finalizer verifies every frame hash, constructs canonical game-time events
and ordered inputs, links first/last screenshots plus the complete frame index,
and appends level+run idempotently. A conflicting record ID aborts instead of
mutating existing dataset truth. Use `--skip-frame-verification` only for a
deliberately faster preliminary pass.

## Build, deploy, and moved installs

```powershell
powershell -ExecutionPolicy Bypass -File research\tools\haggle-telemetry\build.ps1 -HaggleRoot ..\upstream\haggle
powershell -ExecutionPolicy Bypass -File research\tools\haggle-telemetry\deploy.ps1 -WorkspaceRoot ..
```

Deploy verifies both retail EXE hashes, backs up replaced mod files, copies five
binaries, and creates `peggle-capture.ini` only when absent so local tuning
survives redeployment. The launcher self-heals the current user's `InstallPath`
for its verified game copy. To also clean stale machine-wide values after the
workspace moved, run this in elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File research\tools\haggle-telemetry\fix-install-paths.ps1 -WorkspaceRoot ..
```

It exports affected HKLM/HKCU PopCap keys under each game's `fastmod-backup`
before updating only `InstallPath`.

## Rollback

Close the game and remove the five deployed binaries: `peggle-fast-launcher.exe`,
`peggle-fast-mod.dll`, `peggle-capture-recorder.exe`, `haggle-sdk.dll`, and
`research-telemetry-mod.dll`. Configuration, manifest, and `research-sessions`
are outputs and may be retained or removed separately. Restore a registry
export only if `InstallPath` itself must be reverted.
