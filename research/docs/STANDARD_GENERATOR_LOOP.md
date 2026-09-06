# Active experiment: standard Peggle generator → author repair → rule revision

## What this can establish

The active question is **whether an author's repair reveals a shared generation
rule that improves fresh levels**. Expressing a finished repair is necessary for
inspection, but is not proof of a useful generator. A literal patch can replay
perfectly; a bad generator can have perfect language coverage.

The first slice is intentionally small: one radial family, one calibration,
two author repairs, then six matched old/new pairs on different seeds. This is
an exploratory decision, not a statistical estimate of quality or a PopCap-tier
claim. The six seeds have been mechanically tested, not rated by the author.

Scope: a normal 400×600 board, circles and bricks, standard native physics.
No scrolling, destruction, animation design, new mechanics, or automatic
orange-placement optimization. Older corpora and experiments remain available
as references, but benchmark v0/v1/v2, DSL coverage and autoplay are **not**
quality oracles or dependencies of this loop.

## Author flow — one command

From any PowerShell directory:

```powershell
npm --prefix "Z:\Migrated_from_C\Desktop\ultimatepeggle\peggle" run research:repair
```

This builds the standalone player, rebuilds the derived session, and serves
the repository locally. Open `http://127.0.0.1:8765/` yourself; nothing opens
automatically. Keep PowerShell running. Ctrl+C stops this server. If occupied,
append `-- --port 8766` and use that port; no existing process is killed.

The dedicated server routes the editor API to a local read-only stub, not
production Redis. Research runtime levels are also excluded from ordinary
remote autosync. It is a separate local origin: use the same hostname and port
when resuming (localhost and 127.0.0.1 have separate browser storage).

1. **Calibration:** restore the broken symmetry of one rotated brick stroke.
   There are four strokes, only one was rotated by 20°. The instrument checks
   that this node alone is restored within 2px, with one native transform.
   This is an explicit instrument check, not a blind design judgment. If it
   resists normal editing, export a draft: don't waste time fighting the gate.
2. **Two repairs:** edit as you normally would. Addition, deletion, multistep
   transforms, individual pegs and undo are allowed. Don't try to maximize
   measured expressibility. Write one sentence about what you wanted to
   improve; use “Wanted X, did Y” if the editor or representation resisted you.
3. **Before / Current:** compare freely. Undo/redo history survives switching
   candidates, comparison and reload in the same browser. It stays in local
   IndexedDB, not the analysis archive. Exported command evidence retains
   retracted attempts, but excludes them from default intent evidence.
4. **Play preview (optional):** a separate copy gets 25 fixed hash-assigned
   oranges and opens the real game. Current returns to the unmodified repair.
   It is a geometry/physics sanity check, not a difficulty comparison. Avoid
   using the slot/perk controls; this round is ordinary Peggle. If play exposed
   a problem, distinguish it from a visual judgment in your note. Do not mix
   orange/mechanics authoring into this composition round.
5. **Done / Defer / Unfixable:** refusal is useful evidence; add the reason.
   You do not owe a rescue to a bad candidate. Finish & export checks the
   instrument and downloads the full result. Export draft / backup always
   preserves work even when a check fails and leaves the session open.

Use Import session / backup to resume a downloaded result/draft. The level,
notes and command evidence survive; archive import deliberately does not
restore the local undo stack. Replacing an open session offers a backup first.
An unfinished local session is never silently overwritten by a newer link.

Send the downloaded file after **these two** repairs. Do not start 20 more yet.

## What is actually generated

`repair/radial-rules-v1.json` drives `repair/lib/radial-generator.mjs`.
The parameters control a shared vertical center, inner radius, ring spacing,
vertical stretch, top and bottom openings, peg spacing, ring count and which
rings are brick. They change the construction, not just select a random seed.
Keyed randomness keeps unrelated parameter samples fixed during comparison.

The current two study candidates each contain 98 pegs in 14 editable Bézier
strokes. Both originate from a fresh parameterized construction, not direct
copies of commercial levels or handpicked successful repairs. They deliberately
test only interrupted concentric compositions. Symmetry, repeated rings and
empty corridors may be strengths or may be precisely what the author rejects.

Every candidate stores its seed, sampled parameters, original rule definition,
rule hash, relevant source hashes and build git revision. All generation uses
the editor's midpoint arc-length baker, including curved brick geometry.
Static checks cover actual footprints, including same-object overlaps. Small
curved-brick seam contacts have a local endpoint/tangent/side test, not a blanket
exemption for members of one stroke. Passing these checks proves neither good
shot routes nor solvability nor fun.

## From a repair to a generator change

1. Recompute the final before/after patch; inspect comparison sheets, parameter
   deltas and the author's reason together. The journal resolves ambiguities;
   it does not replace final-state evidence. Separate editor friction,
   representation gaps, candidate-specific cleanup and shared design intent.
2. Propose **one substantive shared rule change** and a prediction for fresh
   levels. Example form: “these repairs open the center; change how the opening
   is constructed, and predict fewer blocked central entries.” Do not infer a
   general rule from operation frequency alone. Two different intentions can
   produce the same translation. Ask the author when intent is unresolved.
3. Create a new rules JSON with a new `revision`, a concrete `hypothesis`, and
   `basedOn` listing the repair candidate IDs motivating it. If the required
   change has no existing parameter, change the generator deliberately; don't
   disguise per-level patches or fitted coordinates as a shared rule.
4. For a **rules-only** revision, build the matched comparison:

   ```powershell
   npm run research:repair:compare -- "path\result.json" "path\revised-rules.json"
   ```

   The tool verifies baseline rules against archived geometry and source hashes,
   recomputes replay/lineage/command gates, and requires the calibration. It
   keeps all six seeds, including static failures. Output is an ignored
   `research/generated/<comparison-id>/index.html`, served by the same local
   server. Open that path manually. The manifest stores side identities;
   the review page does not name old/new.
5. On fresh pairs, record composition preference **and** whether each side is
   usable without major repair. “Both bad” is not a tie and must survive export.
   Optional native play has its own preference and played-A/B markers: do not
   interpret a play preference without both played. Play outcomes are still
   confounded if peg counts/topology change: hash colors are reproducible, not
   an optimized or perfectly matched orange policy.
6. Retain a change only on the merits of the fresh results and reasons. Six
   pairs do not prove significance or generalization beyond this family. After
   inspecting them, these seeds are development data. A later revision needs
   a newly frozen evaluation batch for a fresh generalization claim, not
   repeated “holdout” claims on the same six.

Changed generator/compiler/physics code invalidates a rules-only comparison.
Use the archive's git revision to regenerate the old side in a separate
checkout, retain both implementations and hashes, then define that comparison
explicitly. The current tool stops instead of silently rewriting the baseline.

**Decision after the first cycle:** if repairs are mostly coherent and the rule
helps new candidates, extend the same family a little or add a second family.
If both require wholesale redrawing, change the construction/family before
collecting more. If replay or editor behavior fails, fix the instrument from
the raw draft without attributing the failure to author taste. If visual
improvement consistently hurts play, make play repair the next separate
checkpoint rather than inflating this composition experiment.

## Archive versus model input

```powershell
npm run research:repair:digest -- "path\result.json"
```

The archive is canonical and is not overwritten. The digest independently
recomputes facts, checks stored summaries, includes generator parameters,
compact operation parameters and distributions, spatial context, notes,
retractions, gates and explicit omissions. It writes before/after/overlay PNG
sheets (one sheet per candidate) plus SVG sources. No API is required: upload
`digest.md` and the three comparison PNGs to a normal chat; `digest.json` is an
alternative machine-readable view, not mandatory duplicated context.

`digest.md` + `digest.json` together have a hard **100,000-byte** text limit.
Exceeding it fails explicitly; evidence is not silently truncated. Images and
the full archive are outside that text budget. Text bytes are not model tokens,
and image cost depends on resolution. This is a selective reading packet, not
a claim that compression preserves every potentially important detail.

Exact evidence is available on demand:

```powershell
node research/tools/digest-repair-session.mjs "path\result.json" --candidate radial-repair-01 --operation 0
node research/tools/digest-repair-session.mjs "path\result.json" --candidate radial-repair-01 --command 0
node research/tools/digest-repair-session.mjs "path\result.json" --candidate radial-repair-01 --level after
```

Always read replay accuracy with repair fallback and state coverage together.
Repair fallback counts actually changed member identities, not stroke-sized
operations. Reconstruction-only overhead and subpixel precision corrections
are reported separately. Native operations must execute their parameters;
wrong transform/radius/curve parameters can fail replay. Ring/Arc/Line object
declarations currently have executors only for supported circle members;
Polygon and unsupported brick declarations remain literal/fallback. Naming an
object does not make it a generation rule or confer meaningful compression.

## Verification and limits

```powershell
npm run test:repair
npm run check
npm run test:research
npm run test:player-regression
```

Optional isolated headless Edge tests are in `test/repair-browser-smoke.mjs`
and `test/radial-comparison-browser.mjs` (Playwright required). With the local
server on port 8876, they exercise import, real editor commands, comparison,
reload, undo/redo, a real shot, draft/strict export, archive import and the
standalone holdout player. They generate synthetic evidence only, outside git.
The numerical suite also corrupts executable patches, checks physical brick
geometry and samples 40 generator seeds. These are engineering checks, not
40 author approvals. No learned quality rule has been established yet.
