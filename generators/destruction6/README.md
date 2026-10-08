# Des6 · campaign director 0.1

The main unit is now a journey of distinct levels. Earlier Alea, Blast→Alea,
Des1, Des2, Des3 and Des5 boards keep their complete geometry, physics settings,
groups, hinges and curves. Des6 adds six numerical formation families and a
campaign director, not a combined super-level. Source files remain byte intact.

The new formations are braid, crescents, rosette, chevrons, lanterns and sail.
Each has a different field-level target rhythm. Rosette uses one native
hit-triggered turning assembly. The constructors reuse canonical Bézier baking
and native peg/brick sizes. Old mechanical interactions remain part of the
arsenal: counterweight tipping, source release, handoff, magnetic cargo, portal
return, rotating and translating patterns, and broad static ricochet banks.
No extra objective, peg type, compulsory action sequence or defeat rule is added.

`build-bank.mjs` loads source campaigns and synthesizes new formations. It keeps
native-size ordinary clearing boards, checks 12s idle target conservation, and
requires a full native clearing route plus replay. New constructions receive
actual ribbon/chord overlap and native motion-envelope checks. Existing route
reuse is followed by a current native replay; subsequent proof reuse requires
the identical complete source-level key and native runtime/policy fingerprint.
Source construction code changes do not invalidate a proof for unchanged
emitted level data. Main levels with smaller pegs, non-clearing modes, duplicates
and a single-shot automatic clear are excluded from this portfolio. The legacy
campaigns themselves are retained.

`profile.js` describes the dominant action, formation family, gravity scene,
occupancy, orientation and route cadence. Des1/3/5 are gravity scenes even when
their portal or field is the dominant action: a renamed mechanic must not mask
the repetition of cups and loads.

`director.js` first selects a source-balanced portfolio with family coverage.
Then deterministic simulated annealing arranges that portfolio. It avoids
consecutive identical actions/sources, consecutive gravity scenes, and repeating
a formation within three levels. Every sliding eight-level window has at least
four actions and four sources, with no more than four gravity scenes. A soft
cost promotes visual contrast and variable route cadence, including relief
after a longer route. The seed changes phase and choices; there is no fixed
eight-slot template or steadily increasing difficulty ramp. These are design
rules for the campaign, not gameplay stages or player restrictions.

Default 48-level mix: 6 main Alea, 8 Blast→Alea, 4 Des1, 8 Des2, 6 Des3,
8 Des5 and 8 new formations. These are tunable source weights. Traits and
formation coverage matter too; alternating source names alone is insufficient.

`/des6` starts with a checked itinerary. **Новый маршрут** in the pause menu
builds another itinerary in a browser module worker. The seed is preserved in
the URL, and all levels are unlocked. There is no backend generation or model.
Campaign manifests reference intact source campaigns, rather than duplicating
their coordinates. The source files are fetched from the pinned production CDN.

```js
import {generateSequence,materializeSequence} from './dist/des6-generator.js';
const itinerary = generateSequence(bank.entries,{seed:'my-night',count:48});
const levels = materializeSequence(itinerary,loadedSourceCampaigns);
import {generateFormation} from './dist/des6-formations.js';
const candidate = generateFormation({seed:'a-new-sketch',form:'rosette'});
```

The itinerary generator picks from a finite checked bank. It does not create
new board coordinates when pressing “Новый маршрут”. The separate formation
compiler does synthesize new coordinates, but a new candidate needs offline
native validation before joining the shipping bank. Pure client construction
is not full route certification. A machine clear and descriptor diversity are
evidence of implementation and contrast, not a claim of fun or retention.

Run `npm run generate:des6`, inspect the rendered catalog and native frames,
then `npm run test:des6` and the standard CDN build/launcher checks. Numerical
renders explain shapes/routes; actual play uses the unchanged production Alea
renderer, physics and native level list. Old routes and original research stay.
