# Repair study workflow

This workflow records the difference between a generated candidate and the
author's repaired level. It does not show expressibility scores while editing.

## 1. Build one self-contained session file

From the repository root:

```powershell
node research/tools/build-repair-session.mjs
```

The output is `research/generated/repair-pilot-v1/repair-session.json`. It has
one calibration control followed by five study candidates in seeded order.

## 2. Repair in the normal editor

Open the editor, click **Start / Resume Repair Study**, and choose the session
JSON. The side panel owns navigation, Before/Current comparison, notes,
friction notes, and Done/Defer/Unfixable dispositions.

The active session is autosaved to IndexedDB after each completed editor
transaction and resumes after a reload. This avoids the small `localStorage`
quota: a session embeds six complete baselines and can be several megabytes.
**Before** is read-only. Defer and Unfixable require a reason.

Use **More → Combine into object** after selecting pegs to declare Ring,
Polygon, Line, Arc, or a literal Cluster. A rejected geometric fit is retained
explicitly as a literal cluster with its rejection reason.

**Finish & export** recomputes semantic replay, peg/group lineage,
command/transaction log integrity, and static checks (bounds, launcher
clearance, and cross-object overlap). It waits for the final durable autosave
and exports one `repair-session-result.json` only after the required gates pass.

## 3. Read the result independently

```powershell
node research/tools/analyze-repair-session.mjs "C:\path\to\repair-session-result.json"
```

The output directory contains `analysis.json`, `report.html`, and SVG before /
after views rendered only from the embedded level JSON. The analyzer recomputes
the final diff, replay and gates instead of trusting metrics stored by the
editor.

For model-assisted interpretation, derive the smaller reading package instead
of uploading the canonical result JSON:

```powershell
node research/tools/digest-repair-session.mjs "C:\path\to\repair-session-result.json"
```

This writes `digest/digest.md`, a minified `digest/digest.json`, deterministic
SVG before/after views, and one model-ready PNG comparison sheet per candidate.
Each sheet shows before, after, and a color-coded overlay. Edge or Chrome is
used headlessly for rasterization; pass `--browser <path>` when it is not in a
standard location, or explicitly opt out with `--no-png`.

The digest independently recomputes the semantic diff, replay, gates, fallback
metrics and aggregates. It retains compact parameters for every final
operation, source-candidate interpretation risks, retracted command markers,
and a SHA-256 link to the exact archive. It also derives global and per-changed-
object relational descriptors: launcher-axis alignment, centroid and bounds,
coverage, spacing, local density, nearest objects, mirror error, and coarse
negative-space occupancy. The primary aggregate contains only completed,
gate-valid study candidates; control and incomplete candidates remain visible
in separate diagnostic cohorts. When many objects change, complete parameter
clusters and delta distributions are retained while three salient objects are
expanded; `--relations` retrieves the uncapped candidate detail.

`digest.md` plus `digest.json` have a categorical combined limit of 102,400
bytes. Preview images are separate visual inputs and are measured separately.
If the text package exceeds the limit, generation fails rather than silently
discarding evidence. Normally upload `digest.md` and the six comparison PNGs;
keep `digest.json` for machine-readable follow-up.

Exact evidence can be retrieved without loading the complete archive:

```powershell
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --command <sequence>
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --operation <index>
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relations
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relation <objectId>
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --level before
```
