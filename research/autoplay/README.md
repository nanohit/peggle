# Autoplayer: reachability, search, and orange planning

The DSL work established what a level is made of. This establishes what a level
*does* when it is played, using the game's own `PhysicsEngine` under Node.

Three things come out of it:

1. a **reachability map** — which aims reach which pegs, and how reliably;
2. a **beam search** — what becomes reachable only after other pegs clear, and
   what nothing ever reaches;
3. an **orange plan** — orange chosen so collecting it is a route rather than a
   colouring, validated by playing it.

```powershell
node research/autoplay/run-autoplay.mjs research/generated/production/corpus.json --levels "Level 22,Level 48" --out research/generated/autoplay-alea
node research/autoplay/run-autoplay.mjs research/generated/peggle-deluxe/corpus.json --limit 6 --out research/generated/autoplay-deluxe
```

Roughly 5-25 s per level. Outputs land under `research/generated/`, which is
ignored: per-level JSON, a two-panel SVG, `report.md`, `summary.json`.

## Why the simulator is separate from `run-lab.mjs`

`run-lab.mjs` is the auditable path: it validates the record against the schema,
records every event, and hashes checkpoints. That machinery costs far more than
the physics, and a search needs thousands of shots. `lib/sim.mjs` runs the same
engine on the same converted pegs — `objectToNativePeg` is imported, not
duplicated — and returns only hits, bucket catches and step count. Physics
globals are patched once per level rather than per shot.

## Seeds are not a formality

`js/physics.js` applies deliberate jitter on peg contacts and on ball-ball
contacts. A single deterministic run therefore describes one roll of the dice,
not the level. Every aim is fired under several seeds, and the agreement between
them is reported as **`seedStability`**:

- high — the aim determines the outcome, so skill is being measured;
- low — the outcome is mostly engine jitter, and the level is a lottery.

The bucket phase at launch is drawn from the seed too, because the bucket sweeps
continuously in a real game.

## What the numbers mean

| Column | Meaning |
| --- | --- |
| `reach` | share of pegs some sampled first shot touches. A sampled lower bound |
| `stabl` | seed agreement at a fixed aim; low means luck dominates |
| `aimsen` | how much the outcome changes between neighbouring aims |
| `pkts` | pockets — groups of pegs that the same aims reach |
| `clear` | best share the beam search cleared inside the ball budget |
| `max/s` | most oranges any single sampled shot collects under the plan |
| `rndmx` | the same for a random assignment of equal size |
| `plan` / `random` | the search playing each assignment with pegs disappearing |

## Orange planning

Generator v0 assigned orange with `random.shuffle`. That is a colouring, and it
controls nothing: a random draw both lets one shot scoop nine oranges and
scatters the rest so widely that no ball budget finishes them.

The plan picks oranges that are least redundant with each other — different
pockets, narrow access windows, greater depth — under a cap on how many any
single sampled shot may collect. The cap is **auto-tuned**: spread harder until
the number of distinct aims needed lands inside a playable band relative to the
ball budget, then stop. Maximising that number is explicitly not the goal; that
direction produces unwinnable levels.

The static cover count is only an inner proxy, computed on the untouched layout.
The reported result is the beam search actually playing both the planned and
several random assignments with pegs being removed.

## Scope, stated plainly

This is the DOM-free physics subset:

- authored animation and Peggle motion rigs are frozen at their authored phase;
- power-ups, perks, free balls and scoring do not exist;
- the beam search maximises pegs collected, which is not a human objective;
- reachability is sampled over a finite angle grid, so it under-reports and
  never proves a peg unreachable.

Every level report repeats these caveats in its `caveats` field.
