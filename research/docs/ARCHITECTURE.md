# Current architecture audit

Audit baseline: game commit `6201ec1120f7dbadecf76a6e40710bb9bacab915`
(2026-07-08). The repository README was not used as an architecture source.

## Runtime boundary

The game is a browser-first vanilla-JavaScript ESM application. `player.html`
loads the generated `dist/player-bootstrap.js` bundle built from
`js/player-bootstrap.js`; `editor.html` loads `js/main.js` directly. There is
no framework-owned state store. `dist/` is ignored and must be rebuilt after
player-source changes (`npm run build:player`; `dev.sh` also builds and watches
it).

`js/game.js` is the orchestration layer. `Game` owns browser input, game mode
state, scoring, turns, balls, peg activation, the fixed-step accumulator,
rendering calls, and the gameplay/UI/performance listener sets. It composes:

- `PhysicsEngine` from `js/physics.js` for balls, peg collision, portals,
  bucket, walls, ball-ball contact, and flippers;
- `Renderer` from `js/renderer.js` for Canvas/WebGL presentation;
- `PegAnimator` from `js/animation.js` for authored peg/group motion;
- `SurvivalRuntime` plus `survival-mode.js` for world/screen coordinates,
  vertical scrolling, lose line, speed curves, and gamble knockback;
- specialized billiard, destruction, yoyo, deep-freeze, bomb, portal, magnet,
  and flipper modules.

`Game.loadLevel(levelData)` is the main authored-to-runtime transition. It
normalizes mode settings, copies groups and pegs, resets physics/animation and
mode systems, sets the global peg radius, creates the launcher ball, and resets
run counters. It currently mutates some mode flags on the supplied level object
when destruction or billiards are enabled; research tooling clones authored
data before this call.

## Timing and physics

`Game.gameLoop` is driven by `requestAnimationFrame`, defaults to a 60 Hz render
cap, and advances mechanics through an accumulator at 120 Hz
(`fixedStepMs = 1000 / 120`). Frame deltas are clamped, accumulated work is
bounded by `maxFrameSteps`, and last-peg slow motion scales accumulated time.

`PhysicsEngine` itself imports only other pure game modules and does not import
the DOM or renderer. It runs under Node today. Its `update(dtSeconds)` processes
ball movement, adaptive collision substeps, portals, peg contacts, ball-ball
contacts, bucket movement/catches, and loss. Ball integration is tick-based:
gravity, friction, and velocity are applied once per engine update rather than
scaled by `dtSeconds`; therefore the 120 Hz caller cadence is part of the
physics definition, not merely a performance choice.

Destruction physics is a separate `DestructionPegSystem` in
`js/destruction-mode.js`. It is also exercised under Node by the existing
destruction smoke suite. It handles dynamic/kinematic bodies, groups,
fractures, sleeping/wake rules, destruction portals, and removal.

## Authored data

`js/levels.js` owns editor-level normalization, cloning, CRUD, import/export,
training-list bookkeeping, and localStorage persistence. `LevelManager` is the
editor-side authority. Baked/player levels are additionally read and cached by
`js/main.js` and `js/player-bootstrap.js` through local or API-backed storage.

Authored levels are JSON objects with stable level IDs, stable peg IDs, pegs,
groups, and optional mechanics such as survival, flippers, yoyo, visuals,
character/dialogue data, and hit-clear timing. Pegs carry shape, transform,
type, geometry, animation, group membership, and mechanic-specific properties.
Runtime-only fields are added to copies during play by animation, destruction,
portals, billiards, and effects.

## Instrumentation seam

`Game.subscribeGameplayEvents(listener)` and `emitGameplayEvent(type, payload)`
are already consumed by portrait reactions and regression tests. Confirmed
events include `shot_launched`, `peg_hit`, `level_clear`, `level_failed`,
`ball_lost_clean`, `ball_lost_after_streak`, `bucket_catch`,
`billiard_merge`, and `billiard_complete`.

This is the primary recorder seam because it observes semantic transitions
without coupling research code to rendering. The research recorder adds an
ordered input record and sparse mechanical checkpoints. Checkpoints are for
diagnosing divergence; they are not substituted for replay inputs. The player
loads the recorder through a split dynamic import only when `research=1`, so
the shipped path does not download the developer-only recorder chunk.

In research mode the recorder also wraps `Game.render` after the original draw
and uses `Renderer.drawCompositeTo(...)`, so base and foreground canvases are
captured from the same completed visual state. The simulation-step clock drives
an ideal visual cadence; requestAnimationFrame delivery is only the opportunity
to observe the newest due state. OPFS is the preferred frame spool, with a
bounded memory fallback and a store-only ZIP export because PNG/WebP is already
compressed.

Native PopCap capture has the same dual-clock contract but different adapters.
The injected fast DLL publishes a seqlock-style shared-memory snapshot and logs
focused inputs; an external sidecar performs client-area capture so PNG
or JPEG encoding cannot block the game thread. Native raw sessions remain level-
unresolved until an exact canonical level record is supplied.

## Headless boundary

The first headless lab intentionally exercises only the proven DOM-free native
`PhysicsEngine` subset. It supports circles, bricks/segments, static obstacles,
bumpers, portals, the bucket, and explicit shot inputs. Full `Game` execution is
not yet headless because its constructor immediately creates a `Renderer`,
installs document/canvas listeners, and composes browser-focused effects.

Animation, survival pacing, destruction, perks, and complete turn semantics
remain browser-runtime responsibilities until each is moved behind an explicit
simulation adapter and parity-tested. The data model already has room for them;
the first lab does not pretend to simulate unsupported mechanics.

## Server and deployment code

`api/` and `server/` provide level/campaign/character/asset persistence and PvP
duel endpoints. They are not part of deterministic mechanics. `scripts/`
contains asset, regression, destruction, and browser probes. Research tooling
is isolated in `research/` so it can use Node, Python, .NET, or native tools
without adding dependencies to mobile gameplay.
