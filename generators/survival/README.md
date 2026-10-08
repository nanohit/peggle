# Survival stream 0.2 — /surv

One continuous native Game and a browser-side deterministic geometry compiler.
No bank of complete boards, server, model, level transitions or chunk objectives.
Seed is kept in the URL; **Новое течение** changes it. Ordinary Alea peg/ball size
is 8.5px and curved bricks are 34×10.2px, baked on real joined Bézier ribbons.

After the user's correction, normal generation expands a drawing program in
`drawing.js`, rather than selecting one of eleven finished formation recipes.
Joined paths can be reflected, nested, repeated, repeated as reflected pairs,
arranged radially or grown into branching drawings. Material and counter-rhythm
belong to the whole composition. Fresh programs change subgroup counts,
relations, path coefficients and silhouettes; peg geometry is compiled later.
The eleven former named forms remain available as explicit calibration examples.

Increasing distance introduces hit-triggered radial objects, source/receiver
episodes, native compound balances, portal returns and magnetic cargo. These
mechanical actions are parts of a picture, not prescribed player stages or the
universal basis of every formation. Components reuse numerical constructors
from Des2/3/4/5. `flow.js` plans a persistent winding gesture with two independent
voices and longer visual phrases. Foreground drawings alternate sides, sometimes
expand across the field, and overlap in vertical extent. A page's advance is
independent of the drawing's bounding box: there is no extra inter-page gap,
entry/exit marker or enclosing frame. Curves share position and tangent across
compiler boundaries; their rests and material changes have a different metre.
Closed drawings reserve their inner negative space. Future foreground forms may
retire only blue voice material generated ahead of the visible viewport, so an
earlier background stroke cannot cut a new silhouette. A bounded rest-pose tail
checks neighbours and moves with world rebasing. Native runs verify realization.
They do not choose the design or establish its quality. See DESIGN_REVIEW.md.

Targets form short phrases and runs within foreground drawings. A native
`gamble` replaces an ordinary peg inside a drawing, opening or counter-phrase;
it keeps that peg's shape and belongs to the composition. Reward spacing varies
by distance, independent of compiler pages. There is no centre-first header
search. It offers 100–130px of smooth pushback and is consumed once, does not reset
generation, and does not change ammunition. Multiball is occasional additional
relief. Existing native portal and magnetic functions remain intact.

Only an unhit orange reaching the gun's upper edge ends the run. Blue pegs,
obstacles and other non-targets can leave the top freely. Hit oranges awaiting
their existing 1200ms clear are safe. There is no finite clear/win condition or
laser line. Reload is fixed at 1600ms even after an early miss; balls are infinite
and previous balls may stay active. Pause freezes normal Game stepping; loss
freezes the stream. Speed starts at 25px/s and rises smoothly toward 41.25px/s
using distance high-water, so a pushback cannot reset difficulty. Active balls
keep the native 120Hz simulation during reload and aiming. The loaded ball and
GPU cannon follow the live camera anchor, including pushback and rebasing.

Runtime generates ~2.2 screens ahead, retains enough passed material for native
knockback, prunes pegs/groups/hit IDs/animation and body storage, and rebases world
coordinates every few screens. Rebasing moves native bodies, hinge anchors,
curve slices, animation rest poses and balls together. It never reloads Game or
reconstructs consumed pegs. Construction is synchronous and small; a dedicated
worker is unnecessary for this first version.

`npm run test:surv` tests native loss, clearing, reload, relief and a 225,000px
transport run. `npm run test:surv-flow` checks continuous curve joins, cross-page
contacts, integrated rewards, safe background retirement and deterministic
rebasing. `npm run study:surv-flow` renders long strips and moving viewport crops
from six seeds, with no manual play. `npm run study:surv` compares 1250/1600/2000ms reload with one
trajectory-based native shooting policy and renders actual states. The results
calibrate a first playable cadence; they do not establish a human optimum or fun
score. Study pictures remain in full Git source, without computer use.

Limits: a bounded drawing grammar and mechanical vocabulary, not unrestricted
invention of new native physics. Sampled mechanics and machine aiming establish
operation, not enjoyment. Real player pressure and phone performance need feedback.
Existing campaigns and the original research dataset remain byte unchanged.
