# Canonical research data model

The canonical interchange is UTF-8 JSON using the envelope defined by
`research/schema/research-record.schema.json`.

Every record starts with:

```json
{
  "format": "peggle-research",
  "formatVersion": 1,
  "recordType": "level",
  "id": "level:game:example",
  "provenance": {}
}
```

Datasets use newline-delimited JSON (`.jsonl`) containing the same envelopes;
there is no second dataset-only schema. A normal `.json` file contains one
envelope.

Raw multi-file capture uses a separate `peggle-capture-session/v1` transport.
It is intentionally not a canonical record: a native session may not yet know
which exact level digest it observed. Browser bundles immediately include
canonical level+run records because the authored level is in memory. Native
bundles become canonical only through `finalize-capture-session.mjs` with an
explicit level record.

Completed native bundles are automatically discoverable through the shared
workspace `research-dataset/capture-sessions.jsonl` raw catalog. This catalog
is an inventory, not canonical training truth: its entries explicitly retain
`canonicalStatus: "level-unresolved"`. Finalization atomically adds the exact
level/run pair to the separate canonical dataset.

## Level records

A level record has three deliberately separate areas:

- `authored` is mechanical design intent: coordinate system, objects, groups,
  launcher/bucket/physics/mode settings, animation definitions, movement,
  portals, and destruction properties.
- `visual` is player-visible authored truth: background assets, framing,
  screenshots, semantic renders, and presentation-only source metadata.
- `extensions` preserves source-specific fields and raw/unknown entries that the
  canonical schema cannot yet interpret.

An authored object has a stable ID, semantic `kind`, role, transform, geometry,
and optional mechanics. Supported kinds include circles, bricks, segments,
polygons, rods, bumpers, portals, emitters, holes, and unknown entries. The
schema is extensible; unknown entries are kept as `kind: "unknown"` with their
source class and decoded/raw fields under `source` or `extensions`.

Classic Peggle records simply omit mechanics they do not have. Missing portal,
destruction, survival, or mobile layout data is not filled with invented
defaults. The source coordinate system remains landscape and is never silently
stretched into the game's vertical frame.

## Run records

A run record links to a level by ID and a SHA-256 mechanical-content digest.
The digest is canonical JSON over `{ format, formatVersion, authored }`; it
deliberately excludes ingestion timestamps, local source paths, and visual
artifact locations. Backgrounds, semantic renders, and screenshots carry their
own digests. Compute it with `node research/tools/digest-level.mjs <level.json>`.
A run contains:

- `reproduction`: game/tool versions, fixed step, physics config, seed policy,
  platform, capability claim, and ordered input sequence;
- `events`: semantic events with sequence number, simulation step/time, type,
  payload, and optional mechanical subject snapshots;
- `checkpoints`: sparse mechanical states/checksums for divergence diagnosis;
- `measurements`: independent scalar/vector outputs, not a single fun score;
- `artifacts`: references to exact JSON, semantic renders, screenshots, logs,
  or trajectories.

Continuous visuals use one SHA-addressed `frame-index` artifact rather than
thousands of top-level artifacts. Each index row carries image digest,
dimensions, actual/scheduled game time, wall time, speed multiplier, capture
reason, and missed cadence count. First/last images remain direct `screenshot`
artifacts for cheap discovery and previews.

Authored object state is never overwritten by run state. A peg's authored
position belongs in the linked level record. Its hit state, current transform,
velocity, destruction body, or color assignment during a run belongs in an
event/checkpoint.

## Coordinates

Every level declares units, origin, axis direction, bounds, and orientation.
Source coordinates are preserved exactly. Transformations such as landscape to
portrait are new derived level records with explicit parent digest and operator
metadata; they do not alter the ingested source record.

This allows later work to compare transferable relationships—arcs, funnels,
clusters, gates, routes, slides, symmetry, recovery space—without treating
classic absolute positions as target-game ground truth.

## Provenance and loss awareness

At minimum provenance records source system, source path/URI, source digest,
ingestion tool/version, and ingestion time. Repository sources also include the
exact commit. Installed binaries include file version and SHA-256.

An importer reports `losses` and `warnings`. Unknown source fields are retained
under `extensions`, even when the current schema cannot interpret them. A clean
validation result means the envelope is structurally valid; it does not mean an
importer understood every source mechanic.

## Versioning

`formatVersion` changes only for incompatible envelope semantics. Additive
optional fields do not require a version bump. Physics implementations,
extractors, generators, agents, and feature definitions carry their own
versions/digests inside provenance or reproduction metadata.
