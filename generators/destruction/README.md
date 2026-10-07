# Destruction generator 0.1

This branch uses the production Alea renderer and native 400 × 600 world. Pegs and
balls retain the standard radius 8.5. It does not modify the Blast research data.

`grammar.js` is deterministic, browser-compatible numerical geometry. Five
construction recipes (supported tower, seesaw, split bridge, breakable ring,
hanging frame) compose five assemblies across three vertical bands. Eight
families combine those recipes. Each native level keeps its seed, assembly plan,
roles, support contacts and **intended** flow. Intended flow is not simulation evidence.

The seesaw is a revolute joint, not a scripted animation. The solver constrains its
world pin, conserves lever-arm impulses, responds to gravity/load changes and has
angular stops. A hanging frame uses a breakable pin; a normal seesaw stays pinned.
Editor construction adds a beam and a separate static bearing. Hinge settings
survive saving, duplication, import and mirrored retries.

`native-simulator.mjs` injects rendering and input out of the actual `Game` class,
mutes audio and calls `Game.update` at 120 Hz. It runs native collisions, timed
clears, fall scoring, bucket recovery and end-of-turn rules. Complete graph forks
keep deformation, sleep state, contacts and the RNG stream between shots. A forked
route must match a fresh replay exactly. The trajectory preview only proposes
angles; scores come from the full moving-body simulation.

`evaluate.mjs` checks geometry/shooter/bucket clearances, ten seconds of idle
stability, late drift, broad first-shot coverage, a clearing route within eight
launches, and a second physics seed with an earlier first shot. Accepted levels
must also have at least three targets cleared by falling and at least one actual
impact between different assemblies. Those measurements establish plausibility,
not human difficulty or universal solvability under every timing/angle.

Run `node generators/destruction/build-catalog.mjs` to generate, evaluate and
select a batch. Results cache expensive native trials and include a fingerprint
of geometry, evaluator and native physics; changes invalidate the cache.
`data/des/campaign.json` contains selected native levels; `quality.json` contains
both witness routes and rejected candidates. The browser's “Новая конструкция”
creates new reproducible seeds directly; these fresh seeds are explicitly marked
as unfiltered. `/des/editor` stores local levels separately and does not autosync
them into the main campaign.

After the rolling-contact fix, the unchanged catalogue is checked with
`node generators/destruction/check-rolling.mjs`: ten-second idle stability and
two independent native launch probes per level. `physics-check.json` records the
current implementation fingerprint. Original `quality.json`/`proof.json` routes
remain historical evidence for their recorded physics fingerprint; they are not
clearing witnesses for the new solver. The public report distinguishes these.

Deploy through the existing CDN-shell build. `/`, `/gen` and `/des` now load the
same current game bundle so physics fixes reach every player. The main CSS,
visual assets and campaign snapshots remain on the pinned CDN release; `/gen`
retains its three exact collections, and `/des` uses the production materials.
