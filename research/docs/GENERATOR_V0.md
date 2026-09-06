# Constructive generator v0 (no ML)

## Outcome

Generator v0 turns authored Peggle geometry into playable 400x600 Alea levels
without training a model. It is a deterministic baseline for the next round of
human design feedback, not a claim that composition quality is solved.

The generator keeps three kinds of evidence separate:

1. Peggle Deluxe and Nights provide local composition vocabulary.
2. Primary authored Alea levels provide continuous portrait pacing, target
   count, orange ratio, and rectangular-peg ratio.
3. The target game's deterministic physics subset rejects mechanically empty
   candidates. It does not assign an aesthetic score.

## Correct coordinate foundations

| Source | Canonical bounds | Launcher axis | Rule |
| --- | ---: | ---: | --- |
| PeggleEdit Deluxe/Nights | 646x543 | x=327 | Source entry coordinates are the playfield-local frame. The editor maps it into 800x600 with `DrawAdjustX=73`, `DrawAdjustY=43`. |
| Alea standard | 400x600 | x=200 | A disabled survival config must not enlarge the world. |
| Alea survival | 400x`worldHeight` | x=200 | Tall bounds are used only when survival is actually enabled. |

Peggle records are not shifted. Their coordinates were already local to the
646x543 playfield; the old 800x600 declaration and fabricated x=400 marker were
wrong. Correcting the frame recenters the same geometry around the real x=327
launch axis.

## Construction hierarchy

The generator does not place individual rectangular pegs independently.

1. The motif analyzer retains every detected line, arc, and cluster for audit.
2. For generation, each source level gets a greedy non-overlapping motif cover,
   so one peg cannot be instantiated through two motifs.
3. Neighboring cover motifs are joined into connected 12–32-object fragments.
   A fragment preserves source positions, rotations, dimensions, and relations.
4. Two or more fragments from a small source palette are transformed as whole
   units into the 400x600 target frame.
5. A continuous 25-sample pacing curve guides vertical position and horizontal
   occupancy. There are no hard screen sections.
6. Target colors are reassigned to match the authored Alea orange-ratio range.

The full recipe, seed, source level IDs, fragment IDs, transformations, and
object provenance are embedded in every generated research record.

## Acceptance harness

Structural hard gates check:

- schema and IDs;
- exact oriented circle/rectangle footprints and bounds;
- cross-fragment collisions while retaining documented contacts inside an
  authored source fragment;
- launcher clearance;
- top, bottom, and sliding-window vertical coverage;
- target, orange, and rectangular-peg ratios;
- at least two source levels and more than one constituent motif type.

Physics hard gates use an 11-angle, one-shot sweep in the target-game physics
subset. They reject no-value shots, very low sampled reachability, excessive
dead shots, and collapsed outcome diversity. This is a lower-bound mechanical
screen, not a full-level solver and not a fun metric.

## One-command build

From the game repository:

```powershell
npm run research:generator:build
```

The command builds the foundation, generates 12 accepted candidates, writes
native levels and research records, runs all gates, builds the review queue,
and verifies deterministic regeneration end to end.

Important outputs below `research/generated/generator-v0/`:

- `foundation/motif-library.json` — complete motifs, non-overlapping covers,
  connected fragments, provenance, and source relation graphs;
- `foundation/vertical-profile.json` — authored continuous portrait pacing;
- `manifest.json` — accepted and rejected attempts with reason counts;
- `records/` — canonical research records;
- `native-levels/` — game-native JSON ready for controlled playtesting;
- `harness/` — structural and physics evidence per accepted candidate;
- `previews/` — semantic SVG previews;
- `review/benchmark.json` and `review/review.html` — blind targeted review.

To serve the queues without automatic browser opening:

```powershell
python -m http.server 8765
```

Then open either URL manually:

```text
http://localhost:8765/research/generated/generator-v0/review/review.html
http://localhost:8765/research/generated/coordinate-transfer-audit-v1/review.html
```

The generator review compares only candidates that already passed the harness.
It contains balanced pairings and swapped repeat controls. Exported decisions
are summarized transparently as win=1, tie=0.5, loss=0:

```powershell
node research/tools/summarize-generator-review.mjs research/generated/generator-v0/review/benchmark.json <exported-review.json>
```

No learned score is produced.

## Coordinate-label transfer audit

The prior 100 decisions were made with the wrong 800x600 presentation. The
transfer audit selects only old pairs whose unchanged geometry fits the real
646x543 playfield, re-renders 30 balanced pairs with x=327, and measures whether
the old choice survives:

```powershell
npm run research:coordinate-transfer-audit
node research/tools/summarize-coordinate-transfer-audit.mjs research/generated/coordinate-transfer-audit-v1/benchmark.json research/generated/coordinate-transfer-audit-v1/transfer-map.json <new-exported-review.json>
```

The old labels should be carried forward only if corrected-coordinate agreement
is high. This audit is isolated from generator review and never becomes an
automatic acceptance score.

## Next evidence-driven step

Review the generated queue once, then inspect the highest- and lowest-ranked
recipes by source fragment, transformation, and harness measurements. Change
explicit construction rules only where the review shows a repeated failure
mode. Rebuild with the same seeds plus a held-out seed set and compare the two
transparent tournament summaries. That is enough to improve v1 without ML.
