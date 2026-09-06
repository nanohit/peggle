# Peggle research laboratory

This directory is the reproducible, developer-only boundary around the shipped
browser game. It is deliberately separate from gameplay and rendering code.

The first-pass laboratory does four things:

1. converts source levels into one versioned research record format;
2. records browser runs from the existing gameplay-event seam;
3. runs the DOM-free subset of the native physics engine under Node;
4. preserves provenance and source-specific fields so ingestion is loss-aware.

The laboratory now also contains the first deterministic constructive generator.
It deliberately does **not** use ML, a reward model, a learned notion of fun, an
automated player, or quality-diversity search. See `docs/GENERATOR_V0.md`.

The next implemented layer is `docs/BENCHMARK_V0.md`: a reproducible professional
reference corpus, controlled synthetic perturbations, static diagnostics,
grouped synthetic discrimination, a target-physics shot sweep, an external
Peggle Nights holdout, compact LLM dossiers, and a blind A/B review loop. It is
explicitly a screening benchmark rather than a learned definition of fun.

`docs/BENCHMARK_V2.md` documents the earlier 100-decision diagnostic pass. Its
synthetic preference-model experiment is retained only as historical research;
it is not part of the generator or its acceptance path.

## Layout

- `schema/research-record.schema.json` — normative JSON Schema for all records.
- `docs/` — architecture, determinism, data-model, and source-ingestion audits.
- `tools/` — deterministic import, validation, headless-lab, and telemetry tools.
- `fixtures/` — tiny synthetic inputs safe to keep in the repository.
- `examples/` — small checked-in outputs produced from synthetic/native inputs.
- `generated/` — ignored local output for extracted commercial data and runs.

## Quick start

Run all research checks:

```powershell
npm run test:research
```

Rebuild and verify generator v0 from the local Deluxe/Nights corpora and the
production Alea corpus:

```powershell
npm run research:generator:build
```

Convert one native game level and run a deterministic headless shot:

```powershell
node research/tools/import-game-level.mjs data/player/levels/1.json research/generated/native-level-1.json
node research/tools/run-lab.mjs research/generated/native-level-1.json research/generated/native-level-1.run.json --angle 1.5707963267948966
node research/tools/validate-record.mjs research/generated/native-level-1.json research/generated/native-level-1.run.json
node research/tools/digest-level.mjs research/generated/native-level-1.json
node research/tools/replay-lab.mjs research/generated/native-level-1.json research/generated/native-level-1.run.json
```

Extract a Peggle Flash XML archive without third-party Python packages:

```powershell
python research/tools/extract_peggle_flash.py ..\upstream\PeggleFlash2\levels\funnel.dat.zip research/generated/flash-funnel.json --background ..\upstream\PeggleFlash2\levels\funnel.jpg
node research/tools/validate-record.mjs research/generated/flash-funnel.json
```

Recreate the ignored inventory manifest for the three local installations:

```powershell
powershell -ExecutionPolicy Bypass -File research/tools/inventory-local-sources.ps1
```

The PeggleEdit adapter can list and ingest a Nights level directly from the
installed `main.pak`; see `research/tools/peggleedit-exporter/README.md` for the
pinned build and invocation.

Convert a raw Haggle JSONL capture after linking it to an ingested level:

```powershell
node research/tools/import-haggle-telemetry.mjs research-telemetry.jsonl research/generated/deluxe-run.json --level-id level:peggle-deluxe:example --level-sha256 <64-hex-level-digest>
```

## Browser recorder

Build the generated player bundle, start the normal local server, and open
`player.html` with `research=1`, for example:

```powershell
npm run build:player
```

```text
http://localhost:3000/player.html?level=1&research=1
```

The active recorder is exposed as `window.__peggleResearchRecorder`. Recording
includes ordered raw input, semantic gameplay events, sparse mechanical
checkpoints, and composite canvas frames scheduled in simulation time. In the
developer console:

```js
await window.__peggleResearchRecorder.download();
await window.__peggleResearchRecorder.getRecord();
```

`download()` exports one ZIP containing `session.json`, canonical `level.json`
and `run.json`, ready-to-append `dataset.jsonl`, event/frame indexes, and image
frames. `downloadJson()` preserves the JSON-only escape hatch. Long-running
frame blobs use browser OPFS when available rather than accumulating in RAM.

Optional query controls are `researchVisual=0|1`, `researchFps=1..60`,
`researchMaxFrames=N`, and `researchImage=png|webp`. Defaults are WebP quality
0.92 at 15 frames per simulation second; select PNG when exact pixels matter.
Cadence gaps caused by rendering/encoding
pressure are indexed explicitly; wall time never substitutes for game time.

Recording is off unless the query flag is present. The recorder remains a split
dynamic-import chunk, so normal production runs neither download capture code
nor pay its per-step/render cost.

## Data policy

Do not commit extracted commercial levels, screenshots, telemetry containing
personal identifiers, or installed-game binaries. `research/generated/` is
ignored for that reason. Synthetic fixtures and records derived from this
repository's own level files are appropriate to commit.

Every committed or shared run must include the exact game revision, level
digest, research-tool revision, fixed-step/physics configuration, seed policy,
and ordered input sequence. A run missing any of those fields is observational
telemetry, not an exact-replay claim.
