# Des5 · playable composition compiler 0.2

Des5 was rewritten after the first catalog failed visual/player review. A green
geometry check and a winning machine route did not justify sparse, repetitive
loops, or cargo that missed its supposed destination.

The starting point is a play composition: a broad board-scale gesture, a rhythm
of useful targets, shot entries and a physical action worth triggering. Geometry
and native simulation check the realization; they do not define design quality.

## What is synthesized

The seed emits a numerical sketch and fresh cubic paths. Open sweeping banks,
unequal converging wings and compound balances organize the field. A vessel is
generated from a mouth, landing, shoulder profiles, asymmetry and dimensions.
The carrier constructor attaches one to three unequal vessels with grown arms
to one native hinged body. Landing depth/width vary from cups to open trays;
ordinary attached counterweights change its mass distribution when hit. These are newly computed formations/attachments,
not references to stored Alea or Blast coordinates.

Supported loads spill into receivers. A compound carrier can hold, tip and
release into a broad lower basin or divided catches. Whole-board warped target
lattices provide aiming and ricochet choices instead of automatically tracing
dots alongside every curve. Existing bumpers, portals and cargo magnets may
contribute; they require native use evidence before catalog acceptance.

This is still a bounded grammar of play intentions and shape operators. It
does not learn new game rules or independently invent a new kind of physics.
In particular, seed variation is not a proof of player-perceived novelty.

## Ordinary Alea rules

- Peg radius 8.5; native ball; full-size bricks and actual joined Bézier ribbons.
- 12 balls, ordinary orange clearing, bucket, native hit timers and physics.
- Native compound rigid bodies and hinges; no scripted cargo trajectory.
- No stages, compulsory sequence, custom defeat condition or new peg type.
- Clearable bearings and arms, not an indestructible gray skeleton.
- Des2/3/4, `/gen`, main and the separate original research remain intact.

## Browser API

```js
import {generateCandidates, generateLevel} from './dist/des5-generator.js';
const levels = generateCandidates({seed:'new-session',count:3,attempts:16,
  genome:{kinetic:.8,branching:.75,lateral:.6,bend:.3}});
const repeatable = generateLevel({seed:'repeat-me'});
```

The compiler and module worker are pure browser-compatible JS; generation uses
no model, network or saved campaign. `kinetic` chooses mechanical emphasis,
`branching` changes compound bay count, `lateral` changes routing/divided catches,
`bend` changes asymmetry, `complexity` changes target budget, `brickWidth` controls
the native ribbon segmentation, and `direction` mirrors routing. Older intent
fields remain accepted for API compatibility; not every field affects every
play intention. Client candidates receive a cheap geometry filter, not the
full offline catalog certification. `/des5` serves the prechecked catalog.

## Evidence and its boundary

`transfers.mjs` observes actual native body/surface contacts. A catch needs cargo
movement of at least 24 px, a contact with a specified receiver, and at least
300 ms of consecutive slow contact with that receiver. White-ball transitions,
idle settling and crossing a nominal mouth do not count. Release interventions
hit ordinary floors and allow the real hit timer/physics to run. Second-transfer
interventions first release upstream loads, then open the carrier landing.
These diagnostic tests are reported separately from catches on a real winning
white-ball route. An observed second transfer requires the same cargo to have
first been retained by the upstream mechanism before contacting the lower
receiver; a direct fall into the bottom cup is separately classified. These tests
do not add any prescribed sequence to the game.

The pipeline rejects thin fields, overlaps in both emitted and actual native
initial poses, waiting losses, missed diagnostic
catches, inaccessible routes, absent real-route catches and unused effects.
Catalog selection compares composition and behavior, then varies sequence
cadence. Every published image must also be reviewed directly. Passing these
checks establishes realization/accessibility; it is not an automated fun score.

Run `npm run generate:des5` for an autonomous offline catalog build, render and
report; `npm run test:des5` for reproducibility and shipping-data checks. Source
fingerprints prevent stale proof reuse. Iteration 06 reused earlier native
results only for exact identical emitted geometry/settings with unchanged
runtime/evaluation code, and records that provenance on those rows.
