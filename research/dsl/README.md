# Level DSL: decompiler, recompiler, round-trip

This directory answers one question with a falsifiable experiment:

> Can a small vocabulary of authoring gestures describe a professionally
> designed Peggle level, and can replaying that description rebuild the level?

If the answer is no, generating levels from such a vocabulary is hopeless and
the approach should be abandoned. If yes, the vocabulary is the thing a
generator should sample from, and the corpus becomes a specification rather than
a training set. Nothing here trains a model.

## The vocabulary

A level is a frame, a skeleton, a list of strokes, a list of motion rigs, and an
orange policy.

| Stroke | Meaning | Parameters |
| --- | --- | --- |
| `arc` | pegs along a circular arc | centre, radius, start/end angle, count |
| `ellipse` | pegs around a ring | centre, two radii, rotation, start angle, count |
| `line` | pegs evenly along a segment | from, to, count |
| `path` | pegs along a freehand chain | simplified control points, count, spacing |
| `bezier` | Alea's drawn curve | four control points, start offset, spacing, count |
| `brickChain` | straight bricks laid end to end | from, to, rotation, count |
| `bar` | one hand-placed brick | position, rotation |
| `field` | loosely scattered filler | region polygon, population, packing distance |

`field` is deliberately not a gesture. It is the honest home for pegs a designer
placed one at a time with no reproducible structure, and it is scored
differently from everything else.

## Two classes of evidence

- **exact** — recovered by inverting parameters the source editor actually
  stored. PeggleEdit writes each curved brick's centre of curvature and radius,
  so bricks sharing them came from one drawn arc; it writes full movement rigs;
  the Alea editor writes bezier control points. These are inversions, not
  guesses, and they replay at ~0.005 px.
- **inferred** — fitted from peg positions when the format stored no authoring
  parameters (plain circle pegs).

Two rules keep inference honest:

1. A stroke must be contiguous and evenly spaced. Collinear pegs scattered along
   an infinite line are not a gesture.
2. **A stroke may only claim objects it can reproduce.** Every candidate is
   replayed and compared against its own members before it is accepted; failures
   fall through to the scatter field. Without this check a degenerate fit — two
   control points standing in for forty pegs — inflates the structural counters
   while describing nothing.

A moving peg's authored position is its rig **anchor**, never the exported
snapshot. Fitting geometry to a runtime phase fits noise.

## Metrics, and why there are two

- `struct` — share of objects claimed by a gesture-bearing stroke. This is the
  share a grammar could generate.
- `field` — share claimed only as scatter.
- `exact` — share recovered by inversion rather than fitting.
- `compr` — raw coordinate numbers divided by DSL numbers. A description that
  merely relisted the points would score 1x and would prove nothing.
- `med px` / `<=2px` — ordered per-stroke replay error, **structural strokes
  only**, compared against exactly the objects each stroke claims. Global
  nearest-neighbour matching is reported in the JSON but never used for the
  verdict, because it hands out credit for coincidence.

Fields are excluded from positional error on purpose: they never claimed a
position. They are checked distributionally instead — population, region area,
median and minimum spacing.

## Running it

```powershell
node research/dsl/run-roundtrip.mjs research/generated/peggle-deluxe/corpus.json --limit 55 --out research/generated/dsl-roundtrip-deluxe-all
node research/dsl/run-roundtrip.mjs research/generated/production/corpus.json --levels "Spider,Level 22,Level 26" --out research/generated/dsl-roundtrip-alea
```

Each run writes, under the output directory:

- `dsl/<level>.dsl.json` — the description;
- `reports/<level>.roundtrip.json` — per-stroke replay error and field deltas;
- `previews/<level>.svg` — original beside the replay, strokes colour-coded;
- `report.md` and `summary.json` — the table and the aggregate.

Outputs live under `research/generated/`, which is ignored. Nothing here reads
or writes game state.

## Known gaps

- Sparse regular lattices are not detected; they end up as scatter.
- Bezier replay reconstructs peg positions by arc length from a stored offset
  and spacing, which is an approximation of the editor's baking and costs a
  couple of pixels.
- Skeleton classification is limited to mirror, radial, lattice, and free.
- Alea group animation is recorded but its members' motion is not replayed;
  those groups animate in place, so authored coordinates are unaffected.
