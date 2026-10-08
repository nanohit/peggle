# Des5 / orchestration 0.1

`generateLevel({seed, genome})` emits new numerical boundary programs, a growing interaction graph and ordinary Alea level JSON. It does not read a campaign, select a saved drawing, call a model or require a server. The generation code uses ES modules and also builds to `dist/des5-generator.js` and `dist/des5-worker.js`.

The vocabulary consists of physical operations: route, enclose, support a load, receive, redistribute and rebound. Native hinges, loose bodies, joined cubic ribbons, rotation, oriented portals and fields implement those operations. The vocabulary is bounded; the generator does not invent new engine behaviors or learn new rules by itself.

## What grows

- A genome controls focus, kinetic response, branching, openness, lateral travel, structural budget and shared curvature/material rhythm.
- The frontier contains unmet discharge regions. Growth can continue, split a broad region, add a compatible upstream load, place a bearing in a pocket, redirect sideways or reconnect into an existing aperture. The graph determines geometry and allocation; it is not a compulsory player sequence.
- Numerical fields synthesize new harmonic boundaries, radial growth paths, spline flow skeletons and asymmetric receiving surfaces. A support network derives spans and ranks from its envelope. These programs contain computed anchors, coefficients and topology rather than stored board coordinates.
- Spatial search scores full-size geometry, reserved flight corridors, motion envelopes and remaining response/material budget. An incompatible addition is omitted rather than shrunk or stuffed into empty space.
- Target mass and contiguous color runs are allocated to the complete system. Contribution ratios measure actual structural ink from the Des2/3/4 subsystems. There is no requirement to include every subsystem in every level.

`plan` records ports, reservations, decisions, computed programs, node degrees and actual contribution ratios. It distinguishes the proposed graph from the events observed in native simulation. A white-ball transition, body contact, crossing of an authored aperture and a portal transfer are reported separately. Authored apertures approximate a moving receiver; this evidence does not prove every proposed connection is causally necessary.

## Automatic production pipeline

```sh
npm run generate:des5
npm run test:des5
```

Candidate synthesis → full-size geometry → idle/motion checks → real `Game` angle search and exact replay → interaction evidence → farthest-first selection by geometry, intent, contribution and behavior → cadence → independent native search. No human edits to individual coordinates are required. The public `/des5` is the resulting precomputed, unlocked campaign. Human visual review remains useful for aesthetics and play quality; machine completion alone does not certify fun.

The source fingerprint ties the catalog to generator, evaluator and native runtime. All older campaign files and the separate research checkout are preserved. `autonomy.json` records paired unpublished seeds with low/high branch intent, checking that the parameter changes actual topology, not only styling.

## Browser use

```js
import {generateCandidates} from './dist/des5-generator.js';
const levels = generateCandidates({
  seed: 'a-new-system', count: 3, attempts: 12,
  genome: {branching: .7, openness: .8, kinetic: .6}
});
```

For a phone, run this in the supplied module worker to keep the UI responsive:

```js
const worker = new Worker('./dist/des5-worker.js', {type: 'module'});
worker.onmessage = ({data}) => console.log(data.levels, data.validation);
worker.postMessage({requestId: 1, seed: 'another-system', count: 3});
```

Browser candidates pass initial geometry and minimum composition checks. They are not the physically certified public campaign. The complete native evaluation/selection pipeline runs offline under Node; both synthesis and that evaluation are autonomous and need no LLM. More expressive parameter ranges should be widened with new geometric and native evidence, not arbitrary noise.
