# destruction_spectacle 0.1 /des2

A procedural experiment informed by the complete Blast contact sheets and native Alea/destruction audits. It preserves existing campaigns and ordinary orange clearing. No new peg types or objectives, no staged game mode.

`grammar.js`: seeded spatial planning → cubic/compound Bézier curves → canonical arc-length baking and curved brick slices → one leading native mechanic → small destructible loads → sparse accents → stratified target placement. `density` controls counts, circle spacing and island count; `destruction` controls the probability/count of small cargo scenes. Magnets require actual movable cargo because native magnet forces act on destruction bodies, not the launcher ball. Portals recycle lower trajectories. Automatic layout and mechanic selection use independent random streams, so resolved URL options regenerate exactly.

`geometry.js`: actual curved ribbon and native chord collision polygons; bounds, overlaps, portal pairing, target budget, native sizes and relevant leading mechanic. Adjacent bricks of one continuous ribbon can share an edge. Motion is additionally checked at native runtime snapshots, not proven for every possible phase.

`build-catalog.mjs`: deterministic pool, native idle/motion checks, nine broad first shots, dense native trajectory proposals and full Game forks for subsequent shots, independent winning replay. Select one per layout, then maximize occupancy distance with a mechanic repetition penalty. Seeds are not edited manually. See `data/des2/candidates.json` for rejected examples and reasons.

`worker.js`: generate an on-demand variant in a module worker, reject invalid geometry or autonomous target loss, check motion snapshots. This is a brief validation, not the full offline route search. All resolved parameters are in the URL. Generation parameters affect this mode only.

`robustness.mjs`: identical-angle ablation of the leading mechanic, alternative start/RNG streams, and adaptive search on a separate start. A fixed route's sensitivity is not evidence that a level is impossible. Full winning replays under selected conditions do not measure human enjoyment or retention.

Run from repository root:

```
node generators/quality/design-audit.mjs
node generators/quality/machine.mjs
node generators/destruction2/build-catalog.mjs
node generators/destruction2/robustness.mjs
node generators/destruction2/build-report.mjs
npm run build:cdn
node scripts/des2-smoke.mjs
npm run build:cdn-shell
```

Contact sheets use `generators/quality/render.py` and `render-routes.py` (Python/Pillow), without browser automation. Pure Bézier/ribbon geometry modules are vendored from the existing research implementation; the research workspace is not modified. Native evaluator uses Game's frame driver, fixed-step update, seeded collisions, timers and final-peg slowdown, with rendering/input removed. All client code/data/assets are published to immutable commits of `nanohit/peggle` on jsDelivr; Vercel serves tiny HTML launchers.

Next useful improvements: free-space masks and complete moving sweep validation; measured shot rhythm/late cleanup; richer parameterized motifs and symmetry; causal role of each mechanical scene; human session measurements. Do not equate more mechanics, more seeds or solver completion with quality.
