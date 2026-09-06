# Original-source ingestion audit

Inspected sources are deliberately outside the shipped game repository. Exact
source revisions and installed-binary hashes are recorded here so generated
records can cite them.

## Peggle Flash / PeggleFlash2

Repositories inspected:

- `sinceohsix/PeggleFlash` commit
  `92f828344ff72a832bf01b3f959723ed35bfc654`
- `sinceohsix/PeggleFlash2` commit
  `821734a69f1c6437db46bd212c1391f095d2bd06`

Both trees contain `.dat.zip` archives and paired JPG backgrounds. The archive
contains one XML level. Current PeggleFlash2 documentation says backgrounds are
440×378 and its custom loader replaces the configured level archive/background.
The XML itself uses the classic level coordinate space (entities reach roughly
800×600), so background pixel size must not be mistaken for mechanical bounds.

Observed entity classes match Peggle/PeggleEdit conventions: rods/lines (2),
polygons (3), circles (5), bricks (6), holes/teleports (8), plus mover and peg
metadata. The Python extractor parses ZIP/XML with the standard library,
converts known geometry, and preserves each full source entity as decoded XML
data under the canonical object's `source` field.

## Peggle Nights static geometry via PeggleEdit

PeggleEdit inspected at commit
`aea17bb5bf7737d11c8d2f9d75dc87770f9b8581` (2026-03-18).

The prompt's toolchain statement remains true: `Directory.Build.props` targets
`.NET Framework 4.7.2` (`net472`). Current version metadata is 5.2.0. The
authoritative parser is `IntelOrca.PeggleEdit.Tools.Levels.LevelReader`, which
reads the version/header and delegates entries to `LevelEntryFactory` and each
entry's `ReadGenericData`/`ReadData`. Recognized types are rod 2, polygon 3,
circle 5, brick 6, teleport 8, emitter 9, and PeggleEdit generator types
1001–1004. Movement links are resolved after all entries are read.

The research exporter is an adapter around that parser, not a second binary
format implementation. It is built against a caller-supplied pinned PeggleEdit
checkout. No PeggleEdit source or binary is copied into this repository. The
adapter was built successfully with portable .NET SDK 8.0.423 plus the private
.NET Framework reference-assemblies package. Against the installed Nights
`main.pak` it listed 70 `.dat` entries and imported `levels\\Bjorn1.dat` into a
schema-valid record with 83 objects (80 circles, two emitters, one polygon), no
unknown-entry warnings, the archive hash, entry name, and entry hash. Its visual
truth links (without extracting) the matching `levels\\Bjorn1.jp2` background
with an independent SHA-256. That generated commercial-data record remains
under the ignored `research/generated/` directory.

## Haggle runtime telemetry

Haggle inspected at commit
`9faa03966deb167b191d7e869953dd1836a7d6cf` (2026-08-02).

Its top-level README still says Peggle Nights support is coming. Current source
is further along than that suggests: `SexyNightsSDK.hpp`, a substantial
`SexyNights/` wrapper tree, version detection for Nights Deluxe 1.0, and a
Nights main-loop callback implementation are present. But support is not
complete. Nights declares callbacks for level load, begin shot, peg hit, and
level completion while the corresponding `Board` hook is absent and the
`LogicMgr` hooks are commented out. Several declared `LogicMgr` accessors also
have no implementation. Deluxe has the working callback hook paths.

The telemetry mod skeleton writes JSONL. For Deluxe it registers level, shot,
hit, and level-done callbacks; position extraction follows Haggle's example
mod. For Nights it records main-loop state transitions and labels inferred shot
and completion events, while explicitly reporting level-load and peg-hit as
unsupported. Output is append-only and includes the game variant plus a
monotonic sequence number. Premake successfully generates a Visual Studio 2022
x86 solution against the pinned checkout. The DLL itself still requires an x86
Visual Studio C++ toolchain and observed in-game validation before runtime
capture is considered proven.

## Local installations

Observed installed files:

| Source | File version | SHA-256 executable | SHA-256 main archive |
|---|---:|---|---|
| Peggle Deluxe | 1.0.0.1 / product 1.0 | `503f7afcedd7d0e02a2ade8cd3b1e8237a501006c167cce329ed44d7df0ab563` | `19cb8c7d6b59b252552e3dd424da57aa1a95d83cfa904bd47aa388d7c3ef8aca` |
| Peggle Nights | 1.00.3.6632 | `aaa1b2823fb93b6f4b3d1374f44725121687ee4f05bda2dd8532b735051f2067` | `15a523e60fa7b1697353d7b214e9d1816e5cb14b507573469ce8cfa8af763c8a` |

These hashes are ingestion provenance and compatibility checks. Commercial
binaries and extracted assets must remain outside git.

## Pego Deluxe prototype

The local prototype identifies as product version 0.10, executable SHA-256
`1c74df953cb7c78a451be97620cfd3433ec1d6da3626ac6e946480c92f565b60`.
It contains 886 files, including 80 `.dat` level files and unpacked image/audio
assets. The `.dat` files are binary and contain recognizable entity-like floats,
IDs, and strings; they are not assumed to be Peggle Nights format merely because
some class values look related.

This first pass inventories and hashes Pego but does not claim a correct parser.
Future ingestion should first identify the prototype's own source/parser or
establish round-trip evidence. Until then, records may store opaque source files
and metadata, not fabricated canonical geometry.

`research/tools/inventory-local-sources.ps1` recreates the ignored machine-readable
manifest with per-install file counts, extension counts, versions, sizes, and
SHA-256 hashes. Its verified output reports 16 Deluxe files, 29 Nights files,
and 886 Pego files (including the 80 Pego `.dat` files).
