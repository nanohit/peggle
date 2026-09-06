# Determinism and exact-replay audit

Audit baseline: game commit `6201ec1120f7dbadecf76a6e40710bb9bacab915`.

The game is deterministic for useful physics subsets when the full initial
state and exact tick/input sequence are controlled. It is **not yet valid to
claim byte-exact full-game replay**. The items below are replay requirements,
not optional metadata.

## Already favorable

- Gameplay uses a fixed-step accumulator, normally 120 Hz.
- Peg IDs are authored and stable across load/copy operations.
- `aimAngle`, `shotsFired`, per-turn hits, score, balls, and mode state are
  explicit fields rather than inferred from rendering.
- `PhysicsEngine` is independent of DOM and rendering.
- Gameplay events expose semantic shot/hit/end transitions.
- Destruction has a Node smoke suite with fixed `1 / 120` stepping.

## State required for an exact replay

Record or derive all of the following before replay is described as exact:

1. Game commit/content digest, research-tool version, browser/JS engine, and
   enabled mode/perk implementation versions.
2. Canonical authored-level digest plus the original source revision/digest.
3. Canvas/world dimensions, survival world height/camera origin, launcher
   position, loss/top bounds, bucket enabled state, and flipper configuration.
4. Complete `PHYSICS_CONFIG`, level peg radius, fixed-step duration,
   `maxFrameSteps`, frame-delta clamp policy, and time-scale policy.
5. Ordered input sequence at simulation-step resolution: aim changes, launch,
   press/release transitions for flippers, launcher selection, QTE/perk input,
   gamble decisions, pauses/resumes, resize/orientation changes, and debug input.
6. Seed and algorithm for every gameplay random stream, even if a particular
   run did not happen to consume it.
7. Initial and checkpoint state for balls, bucket phase, hit sets, animator,
   portals, destruction bodies, survival camera, yoyo, billiards, perks,
   pending clears/end sequences, and all mode-specific cooldowns.

## Nondeterministic or hidden inputs found in source

### Randomness

Gameplay randomness still defaults to `Math.random()`: the physics
collision/portal jitter now goes through an injectable engine stream, while
gamble perk selection, random peg conversion, player/campaign shuffling, and
PvP slot simulation still call ambient randomness elsewhere.
Visual/personality randomness also exists in portrait effects and reaction
selection. These must be split into named seeded streams (`mechanics`,
`generation`, `agent`, `visual`) so visual draws cannot perturb mechanics.

`PhysicsEngine` now accepts an injected random function while defaulting to
`Math.random()` for normal play. The first headless lab injects a named seeded
Mulberry32 stream. The remaining browser gameplay calls are not replaced yet;
a full replay must reject runs that consumed an unseeded mechanics stream.

### Browser clock and frame delivery

`requestAnimationFrame`, `performance.now()`, frame-rate capping, clamped frame
deltas, and a bounded accumulator decide how many fixed steps execute. A long
frame can discard simulation work at the accumulator cap. Last-peg slow motion
also changes scaled time from render-frame deltas. Exact replay must drive a
recorded sequence of fixed steps directly; wall-clock frame delivery must not
be the replay clock.

### Tick-based integration

`Ball.updateVelocity()` and `stepPosition()` use global `PHYSICS_CONFIG.timeScale`
per engine update and do not scale gravity/friction by `dtSeconds`. Changing
simulation Hz changes mechanics. The fixed-step rate must be versioned with the
physics configuration.

### Mutable module globals and identities

`PHYSICS_CONFIG` is mutable and shared. `Game.loadLevel` changes the global peg
radius. Ball IDs come from a module-level counter, so two simulations in the
same JS process can receive different IDs unless identity state is reset or
canonical replay IDs are injected. Event ordering must not rely on unordered
object iteration or implementation-generated IDs.

### Authored/runtime mutation

`Game.loadLevel` mutates supplied mode flags and many runtime systems add
underscore-prefixed fields to runtime peg copies. The recorder must snapshot
authored data before load and must never write runtime hit/color/physics state
back into the authored object.

### Animation and moving geometry

`PegAnimator` owns base transforms, group links, hit-triggered animation,
wrapping, easing, freeform path lookup tables, suspended physics-owned pegs, and
time accumulators. Exact replay requires its state or a deterministic rebuild
from authored definitions plus step-indexed hit inputs.

### Destruction

`DestructionPegSystem` maintains dynamic body identity, sleeping, contact
caches, fracture queues, runtime pieces, wake budgets, portal cooldowns, and
kinematic ownership. Its complete state is not represented by peg positions
alone. Full destruction replay needs an explicit serializer and parity test.

### Survival and browser geometry

Survival uses world coordinates plus a camera, viewport height, scroll curve,
knockback interpolation, lose line, and mode cooldowns. Resize/orientation is a
mechanical input because it changes transforms and bounds. CSS/device-pixel
ratio is visual only unless it leaks through input coordinate conversion.

## Mechanical truth versus visual truth

Exact JSON state stores mechanical transforms, velocities, identities, flags,
and counters. Semantic renders derive from authored/mechanical state. Player
screenshots capture the actual presentation, including assets and viewport.
They are three linked artifacts and must not overwrite one another.

Visual-only randomness, particles, haptics, audio, WebGL effects, portrait
flames, and frame interpolation do not belong in a mechanical checksum. They do
belong in screenshot/provenance records when studying player-visible truth.

## First-pass replay contract

The Node lab claims deterministic replay only for its documented PhysicsEngine
subset. It stores explicit shot inputs, fixed step, physics config, level digest,
and state checkpoints. Re-running the same record must reproduce the mechanical
digest.

Browser recorder output is presently a reproducible experiment record and a
future replay input, not proof of exact full-game replay. The record marks its
replay capability accordingly. Promote it to `exact` only after seeded streams,
state serializers, and browser-vs-headless parity tests cover every enabled
mechanic in that run.

## Next determinism gates

1. Introduce named seeded PRNG streams and remove mechanics `Math.random()`.
2. Add explicit ball-ID allocation/reset or recorded IDs.
3. Extract a simulation clock that can be driven without rAF.
4. Serialize/restore animator, survival, destruction, yoyo, billiard, and perk
   runtime state.
5. Add canonical mechanical checksums at fixed intervals.
6. Run the same recorded input in browser and headless adapters and require
   checkpoint equality within an explicitly versioned float policy.
