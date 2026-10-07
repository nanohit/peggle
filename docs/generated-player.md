# Generated levels player

`https://alea.sh/gen` uses the current Better-Visuals player and defaults to the 24 Alea-sized levels from blast_generator0.2.1.

All levels are immediately selectable in Pause → Levels. The collection buttons below Levels select:

- `/gen?set=alea`: 24 Alea-sized levels, native compound Bezier strokes.
- `/gen?set=original`: 24 original blast_generator0.1 levels.
- `/gen?set=blast`: all 292 imported Blast levels, preserving their original campaign graph.

`/gen?set=alea&id=<native-level-id>` opens a specific level.

The campaigns in `data/gen` are byte-for-byte copies of the completed research exports. `catalog.json` records their SHA-256 hashes. Do not regenerate or resize them in the production build.

`build-cdn-shell.mjs` builds `/gen` into a separate same-origin asset directory. The normal homepage continues using the unchanged CDN ref in `cdn-ref.json`. No research files or shared backend campaign records are modified.
