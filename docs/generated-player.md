# Generated levels player

All public player/editor launchers use one immutable `nanohit/peggle` commit on jsDelivr. Vercel output contains only 1–2 KB HTML launchers; client JS/CSS, fonts, catalogues and report documents are on the CDN. Shared campaign APIs stay on the page origin. `build:cdn` publishes the player, editor, destruction editor and native validation worker with shared code chunks. Publish that Git commit first, then pin its full SHA in `cdn-ref.json` and deploy the shell.

`/gen` defaults to eight distinct Alea-sized compositions. `/gen?set=original` has eight original compositions. `?variants=1` restores all 24 source variants, interleaved by family. `/gen?set=blast` keeps all 292 imported Blast levels. `?id=<native-level-id>` selects a specific variant even in a curated playlist.

The three `data/gen/*.json` source exports remain byte-for-byte identical to research. The source repository `/Users/pavel/Desktop/peggle-procedural` is not modified.

`/des` has eight compositions; `?variants=1` opens all 16 historical seed variants. Central bridge openings now admit the standard 17px ball; their blue lock spans the opening below the two leaves. The earlier selection routes are historical, while `physics-check.json` records current stability and interaction probes.

`/des1` uses a separately generated graph of physical intentions. Every selected composition has native capture/release/transport witnesses, an exact route replay and an independent route with different timing/randomness. All levels are unlocked. New construction generation runs the real game in a cancellable worker and publishes only a candidate with a complete native route. Direct seed URLs are reproducible but bypass worker validation unless that seed was generated in this session.

Retries retain generated geometry. The normal campaign keeps its established defeat/mirror behavior. Local editing at `/des/editor` imports the current level without changing the production campaign. `/editor.html` also uses the same shared physics from the CDN.
