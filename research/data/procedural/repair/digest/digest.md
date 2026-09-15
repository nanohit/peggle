# Repair session digest — radial-v1-50eea9c5-repair-54902cfd

Derived from `research/data/procedural/repair/radial-v1-50eea9c5-repair-54902cfd-draft.json` (466.0 KB, SHA-256 `4ee9883391c8492460947b8a75d377b066a7b05d97e175cbc8348c159dc41412`).
Diffs, replay, gates and metrics below were independently recomputed from embedded before/after levels and active command evidence.
Model-text budget: 65464/100000 bytes for digest.md + digest.json; previews are accounted separately as visual inputs.
Visual evidence: 3 comparison sheets (svg-only).

Result status: **draft**.

> Replay accuracy, repair fallback and final-state fallback must be interpreted together.

## Analysis contract

- Treat the control as pipeline calibration, never as evidence about the author or generator.
- Interpret every operation together with its changed-object relations and before/after/overlay image.
- Separate candidate-specific defects listed under knownProperties from patterns recurring across composition families.
- Do not infer quality from operation or fallback counts alone; report competing explanations and request raw drill-down when the compact evidence is ambiguous.
- State proposed language additions as falsifiable hypotheses tied to candidate ids and operation indices.

Relational descriptor method: {"version":1,"geometry":"peg centers; field-normalized where reported","mirror":"mean same-shape nearest-neighbor error after reflection across launcher axis; score reaches zero at 12% of field diagonal","localDensity":"mean external peg centers within max(50px, 8.5% of field diagonal)","negativeSpace":"occupied peg-center cells and largest empty axis-aligned rectangle on an 8x12 grid","orientation":"principal component axis; omitted below 0.05 anisotropy","detailedObjects":"three highest-salience changed objects per candidate; distributions cover all changed objects"}.

## Integrity warning

Stored editor summaries disagree with independent recomputation:
- `radial-repair-01` — diff=false, replay=true, gates=false

## Control calibration

`control:single-rotation` — **failed**; expected `transform-stroke` on `calibration:0:0`, observed nothing.
Failures: control-operation-count-mismatch, known-defect-not-corrected.
Maximum target residual: 19.54241px (threshold 2px); unaffected state exact=true.

## Aggregate scope

Primary aggregate contains 2 completed, gate-valid study candidates; it excludes the control, deferred/unfixable candidates and failed gates.
Language gaps: none.
Operation types: add-object:fallback×12.

## 0. control:single-rotation — calibration-only

Disposition: **unfixable** — Верхние дуги нессиметричны, как и зачем играть в это непонятно..
Visual evidence: [comparison SVG](previews/01-control-single-rotation.comparison.svg); separate [before](previews/01-control-single-rotation.before.svg) and [after](previews/01-control-single-rotation.after.svg).

```text
gates    replay=passed  lineage=passed  commandLog=passed  transactionLog=passed  staticChecks=passed  control=failed[control-operation-count-mismatch,known-defect-not-corrected]
replay   exact=true accuracy=1 stroke=1 member=1
metrics  repairFallback=0 stateFallback=0 coverage=1
         operations 0 (native 0, fallback 0) changed members 0; final members 28
         precision-only members 0; reconstruction-only fallback members 0
```

Global geometry: members 28→28; objects 4→4; centroid (200,258.76)→(200,258.76); axis offset 0→0px.
Composition: coverage 0.7218×0.4181→0.7218×0.4181; mirror 0.9287→0.9287; nearest-neighbor mean 22.6→22.6px.
Negative space: top opening 133.54→133.54px; occupancy 0.1875→0.1875; largest empty rectangle 0.3333→0.3333.
Net relational delta: {"memberCount":0,"objectCount":0,"centroidDxPx":0,"centroidDyPx":0,"coverageX":0,"coverageY":0,"topOpeningPx":0,"centerOccupancyFraction":0,"largestEmptyRectangleFraction":0,"mirrorScore":0,"mirrorMeanErrorPx":0,"nearestNeighborMeanPx":0}.

Final semantic diff (0 operations):

- No semantic change.

Evidence sequence: 0 recorded, 0 active, 0 retracted. 0 semantic runs, 0 shown, 0 omitted.
Evidence records, NOT independent author actions. Legacy state observations may overlap editor commands; final net diff is authoritative.
Sources: none; active editor operations=none; active state observations=none; retracted=none.

```text
(no commands recorded)
```

## 1. radial-repair-01 — interrupted-concentric-rings

Disposition: **done**.
Visual evidence: [comparison SVG](previews/02-radial-repair-01.comparison.svg); separate [before](previews/02-radial-repair-01.before.svg) and [after](previews/02-radial-repair-01.after.svg).
Strata: radial-family-exploration.
Generator radial-v1 (50eea9c55b3777367edb93bba29193f427e599bd68b64473cfd00b73197ecde4): {"centerX":200,"ringCount":4,"brickRings":[3],"centerY":301.2616,"innerRadius":36.325,"ringStep":35.1948,"verticalScale":1.344,"topOpeningDegrees":44.8355,"bottomOpeningDegrees":20.9844,"circleSpacing":19.9522,"brickSpacing":24.0028}.
Source footprint: {"bounds":{"minX":52.9882,"maxX":347.0118,"minY":120.54,"maxY":493.7182},"emptyOpeningPx":120.54,"horizontalFraction":0.7351,"verticalFraction":0.622}.
Known property: One deliberately narrow family; not representative of all Peggle designs.

```text
gates    replay=passed  lineage=passed  commandLog=passed  transactionLog=passed  staticChecks=passed  control=not-applicable
replay   exact=true accuracy=1 stroke=1 member=1
metrics  repairFallback=1 stateFallback=0.048544 coverage=0.951456
         operations 5 (native 0, fallback 5) changed members 5; final members 103
         precision-only members 0; reconstruction-only fallback members 0
```

Global geometry: members 98→103; objects 14→19; centroid (200,312.12)→(200.1,310.77); axis offset 0→0.1px.
Composition: coverage 0.709×0.5895→0.8677×0.6273; mirror 1→0.9971; nearest-neighbor mean 22.62→23.21px.
Negative space: top opening 131.56→131.56px; occupancy 0.4375→0.4896; largest empty rectangle 0.1667→0.1667.
Net relational delta: {"memberCount":5,"objectCount":5,"centroidDxPx":0.1,"centroidDyPx":-1.35,"coverageX":0.1587,"coverageY":0.0378,"topOpeningPx":0,"centerOccupancyFraction":0.0521,"largestEmptyRectangleFraction":0,"mirrorScore":-0.0029,"mirrorMeanErrorPx":0.26,"nearestNeighborMeanPx":0.59}.

Changed-object relational context: 5 total, 3 detailed, 2 represented only in the complete distribution below.

Distribution: statuses=added×5; families=LiteralCluster×5; deltas={"meanCentroidDxPx":0,"meanCentroidDyPx":0,"medianCentroidDistancePx":0,"maxCentroidDistancePx":0,"medianAbsoluteOrientationDeltaDegrees":0,"meanMirrorScoreDelta":0,"medianLocalDensityDelta":0,"towardLauncherAxisCount":0,"awayFromLauncherAxisCount":0,"mirrorImprovedCount":0,"mirrorWorsenedCount":0,"totalMemberCountDelta":5}.
Detail selection: added/deleted first, then largest normalized centroid/orientation/mirror/density changes; exact omitted objects remain available by drill-down.

- `literal:id-1flyz3g2k` added: 1 members, centroid=(326.21,142.88), bounds=0×0, mirror=0, nearest=radial:ring-3:side-0:segment-0:34.97px|radial:ring-2:side-0:segment-0:75.62px.
- `literal:id-iyx4odjur` added: 1 members, centroid=(79.9,141.86), bounds=0×0, mirror=0, nearest=radial:ring-3:side-1:segment-1:31.54px|radial:ring-2:side-1:segment-1:71.48px.
- `literal:id-notm8gly2` added: 1 members, centroid=(27.99,316.78), bounds=0×0, mirror=0, nearest=radial:ring-3:side-1:segment-1:31.3px|radial:ring-3:side-1:segment-0:35.98px.

Final semantic diff (5 operations):

- 5 × `add-object` (fallback), affected-member references=5, reasons=undeclared-literal-object×5 — clusters: 1×{"changes":[{"index":102,"after":{"type":"blue","shape":"circle","x":326.2,"y":142.9}}]} objects=literal:id-1flyz3g2k; 1×{"changes":[{"index":101,"after":{"type":"blue","shape":"circle","x":79.9,"y":141.9}}]} objects=literal:id-iyx4odjur; 1×{"changes":[{"index":99,"after":{"type":"bumper","shape":"circle","x":28,"y":316.8,"properties":{"bumperScale":1.6,"bumperBounce":3.2,"bumperDisappear":false,"bumperOrange":false}}}]} objects=literal:id-notm8gly2; 1×{"changes":[{"index":98,"after":{"type":"blue","shape":"circle","x":201,"y":508}}]} objects=literal:id-ufvqmzhqu; 1×{"changes":[{"index":100,"after":{"type":"bumper","shape":"circle","x":375.1,"y":311.7,"properties":{"bumperScale":1.6,"bumperBounce":3.2,"bumperDisappear":false,"bumperOrange":false}}}]} objects=literal:id-ujwajs9t5

Representative operation details: 3 shown, 2 omitted.
Selection policy: fallback/add-delete/non-transform first, then largest transforms; parameter clusters retain the full distribution.

- 0. `add-object` · fallback · object=literal:id-1flyz3g2k · members=1 · changes=[{"index":102,"after":{"type":"blue","shape":"circle","x":326.2,"y":142.9}}] · reason=undeclared-literal-object · objectDefinition={"family":"LiteralCluster","memberCount":1,"bounds":{"minX":326.209,"maxX":326.209,"minY":142.881,"maxY":142.881},"definition":null}
- 1. `add-object` · fallback · object=literal:id-iyx4odjur · members=1 · changes=[{"index":101,"after":{"type":"blue","shape":"circle","x":79.9,"y":141.9}}] · reason=undeclared-literal-object · objectDefinition={"family":"LiteralCluster","memberCount":1,"bounds":{"minX":79.898,"maxX":79.898,"minY":141.864,"maxY":141.864},"definition":null}
- 2. `add-object` · fallback · object=literal:id-notm8gly2 · members=1 · changes=[{"index":99,"after":{"type":"bumper","shape":"circle","x":28,"y":316.8,"properties":{"bumperScale":1.6,"bumperBounce":3.2,"bumperDisappear":false,"bumperOrange":false}}}] · reason=undeclared-literal-object · objectDefinition={"family":"LiteralCluster","memberCount":1,"bounds":{"minX":27.99,"maxX":27.99,"minY":316.78,"maxY":316.78},"definition":null}

Evidence sequence: 22 recorded, 22 active, 0 retracted. 22 semantic runs, 22 shown, 0 omitted.
Evidence records, NOT independent author actions. Legacy state observations may overlap editor commands; final net diff is authoritative.
Sources: state-derived-transaction×13, editor-command×9; active editor operations=add-object×5, delete-object×2, transform-object×2; active state observations=add-object×7, transform-object×5, object-exception×1; retracted=none.

```text
         0  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-ufvqmzhqu]  fallback:undeclared-literal-object×1
         1  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-ufvqmzhqu]
         2  [editor-command] move-selection  transform-object×1  [literal:id-ufvqmzhqu]
         3  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-notm8gly2]  fallback:undeclared-literal-object×1
         4  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-notm8gly2]  fallback:undeclared-literal-object×1
         5  [state-derived-transaction] state-derived-transaction  object-exception×1  [literal:id-notm8gly2]  fallback:member-property-edit×1
         6  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-1jasnakdv]  fallback:undeclared-literal-object×1
         7  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-1jasnakdv]
         8  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-1jasnakdv]  fallback:undeclared-literal-object×1
         9  [editor-command] move-selection  transform-object×1  [literal:id-1jasnakdv]
        10  [editor-command] delete-selection  delete-object×1  [literal:id-1jasnakdv]
        11  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-ujwajs9t5]  fallback:undeclared-literal-object×1
        12  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-ujwajs9t5]
        13  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-ujwajs9t5]  fallback:undeclared-literal-object×1
        14  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-xy3pp6gtc]  fallback:undeclared-literal-object×1
        15  [editor-command] delete-selection  delete-object×1  [literal:id-xy3pp6gtc]
        16  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-iyx4odjur]  fallback:undeclared-literal-object×1
        17  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-iyx4odjur]
        18  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-iyx4odjur]  fallback:undeclared-literal-object×1
        19  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-1flyz3g2k]  fallback:undeclared-literal-object×1
        20  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-1flyz3g2k]
        21  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-1flyz3g2k]  fallback:undeclared-literal-object×1
```

Note: Прикольно, но по бокам очень пусто, шар сразу улелаета вниз.

## 2. radial-repair-02 — interrupted-concentric-rings

Disposition: **done**.
Visual evidence: [comparison SVG](previews/03-radial-repair-02.comparison.svg); separate [before](previews/03-radial-repair-02.before.svg) and [after](previews/03-radial-repair-02.after.svg).
Strata: radial-family-exploration.
Generator radial-v1 (50eea9c55b3777367edb93bba29193f427e599bd68b64473cfd00b73197ecde4): {"centerX":200,"ringCount":4,"brickRings":[3],"centerY":299.4454,"innerRadius":36.4094,"ringStep":38.5168,"verticalScale":1.0804,"topOpeningDegrees":28.1272,"bottomOpeningDegrees":20.6416,"circleSpacing":19.5929,"brickSpacing":23.9086}.
Source footprint: {"bounds":{"minX":42.9431,"maxX":357.0569,"minY":135.2825,"maxY":465.96},"emptyOpeningPx":135.2825,"horizontalFraction":0.7853,"verticalFraction":0.5511}.
Known property: One deliberately narrow family; not representative of all Peggle designs.

```text
gates    replay=passed  lineage=passed  commandLog=passed  transactionLog=passed  staticChecks=passed  control=not-applicable
replay   exact=true accuracy=1 stroke=1 member=1
metrics  repairFallback=1 stateFallback=0.066667 coverage=0.933333
         operations 7 (native 0, fallback 7) changed members 7; final members 105
         precision-only members 0; reconstruction-only fallback members 0
```

Global geometry: members 98→105; objects 14→21; centroid (200,302.29)→(200.18,303.69); axis offset 0→0.18px.
Composition: coverage 0.7592×0.5239→0.9109×0.568; mirror 1→0.9934; nearest-neighbor mean 21.81→23.25px.
Negative space: top opening 143.8→143.8px; occupancy 0.4583→0.5; largest empty rectangle 0.1667→0.1667.
Net relational delta: {"memberCount":7,"objectCount":7,"centroidDxPx":0.18,"centroidDyPx":1.4,"coverageX":0.1517,"coverageY":0.0441,"topOpeningPx":0,"centerOccupancyFraction":0.0417,"largestEmptyRectangleFraction":0,"mirrorScore":-0.0066,"mirrorMeanErrorPx":0.57,"nearestNeighborMeanPx":1.44}.

Changed-object relational context: 7 total, 3 detailed, 4 represented only in the complete distribution below.

Distribution: statuses=added×7; families=LiteralCluster×7; deltas={"meanCentroidDxPx":0,"meanCentroidDyPx":0,"medianCentroidDistancePx":0,"maxCentroidDistancePx":0,"medianAbsoluteOrientationDeltaDegrees":0,"meanMirrorScoreDelta":0,"medianLocalDensityDelta":0,"towardLauncherAxisCount":0,"awayFromLauncherAxisCount":0,"mirrorImprovedCount":0,"mirrorWorsenedCount":0,"totalMemberCountDelta":7}.
Detail selection: added/deleted first, then largest normalized centroid/orientation/mirror/density changes; exact omitted objects remain available by drill-down.

- `literal:id-0lvenqg8c` added: 1 members, centroid=(383.21,296.44), bounds=0×0, mirror=0, nearest=radial:ring-3:side-0:segment-0:31.58px|radial:ring-3:side-0:segment-1:37.98px.
- `literal:id-6gnp7o098` added: 1 members, centroid=(44.27,167.29), bounds=0×0, mirror=0, nearest=radial:ring-3:side-1:segment-1:48.31px|radial:ring-2:side-1:segment-1:87.14px.
- `literal:id-9725aflii` added: 1 members, centroid=(201.02,484.58), bounds=0×0, mirror=0, nearest=radial:ring-3:side-0:segment-1:46.15px|radial:ring-3:side-1:segment-0:47.84px.

Final semantic diff (7 operations):

- 7 × `add-object` (fallback), affected-member references=7, reasons=undeclared-literal-object×7 — clusters: 1×{"changes":[{"index":104,"after":{"type":"blue","shape":"circle","x":383.2,"y":296.4}}]} objects=literal:id-0lvenqg8c; 1×{"changes":[{"index":102,"after":{"type":"blue","shape":"circle","x":44.3,"y":167.3}}]} objects=literal:id-6gnp7o098; 1×{"changes":[{"index":98,"after":{"type":"blue","shape":"circle","x":201,"y":484.6}}]} objects=literal:id-9725aflii; 1×{"changes":[{"index":100,"after":{"type":"blue","shape":"circle","x":363.9,"y":426.6}}]} objects=literal:id-ir8hszr2e; 1×{"changes":[{"index":101,"after":{"type":"blue","shape":"circle","x":367.9,"y":176.4}}]} objects=literal:id-nkkga2pog; 1×{"changes":[{"index":99,"after":{"type":"blue","shape":"circle","x":40.2,"y":417.5}}]} objects=literal:id-so809z25a; 1×{"changes":[{"index":103,"after":{"type":"blue","shape":"circle","x":18.8,"y":293.4}}]} objects=literal:id-zzjm5lvyw

Representative operation details: 3 shown, 4 omitted.
Selection policy: fallback/add-delete/non-transform first, then largest transforms; parameter clusters retain the full distribution.

- 0. `add-object` · fallback · object=literal:id-0lvenqg8c · members=1 · changes=[{"index":104,"after":{"type":"blue","shape":"circle","x":383.2,"y":296.4}}] · reason=undeclared-literal-object · objectDefinition={"family":"LiteralCluster","memberCount":1,"bounds":{"minX":383.206,"maxX":383.206,"minY":296.441,"maxY":296.441},"definition":null}
- 1. `add-object` · fallback · object=literal:id-6gnp7o098 · members=1 · changes=[{"index":102,"after":{"type":"blue","shape":"circle","x":44.3,"y":167.3}}] · reason=undeclared-literal-object · objectDefinition={"family":"LiteralCluster","memberCount":1,"bounds":{"minX":44.275,"maxX":44.275,"minY":167.288,"maxY":167.288},"definition":null}
- 2. `add-object` · fallback · object=literal:id-9725aflii · members=1 · changes=[{"index":98,"after":{"type":"blue","shape":"circle","x":201,"y":484.6}}] · reason=undeclared-literal-object · objectDefinition={"family":"LiteralCluster","memberCount":1,"bounds":{"minX":201.018,"maxX":201.018,"minY":484.576,"maxY":484.576},"definition":null}

Evidence sequence: 24 recorded, 24 active, 0 retracted. 24 semantic runs, 24 shown, 0 omitted.
Evidence records, NOT independent author actions. Legacy state observations may overlap editor commands; final net diff is authoritative.
Sources: state-derived-transaction×16, editor-command×8; active editor operations=transform-object×5, add-object×4; active state observations=transform-object×8, add-object×7, object-exception×3; retracted=none.

```text
         0  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-9725aflii]  fallback:undeclared-literal-object×1
         1  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-9725aflii]
         2  [editor-command] move-selection  transform-object×1  [literal:id-9725aflii]
         3  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-so809z25a]  fallback:undeclared-literal-object×1
         4  [state-derived-transaction] state-derived-transaction  object-exception×1  [literal:id-so809z25a]  fallback:member-property-edit×1
         5  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-so809z25a]
         6  [editor-command] move-selection  transform-object×1  [literal:id-so809z25a]
         7  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-so809z25a]
         8  [editor-command] move-selection  transform-object×1  [literal:id-so809z25a]
         9  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-ir8hszr2e]  fallback:undeclared-literal-object×1
        10  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-ir8hszr2e]
        11  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-ir8hszr2e]  fallback:undeclared-literal-object×1
        12  [state-derived-transaction] state-derived-transaction  object-exception×1  [literal:id-so809z25a]  fallback:member-property-edit×1
        13  [state-derived-transaction] state-derived-transaction  object-exception×1  [literal:id-ir8hszr2e]  fallback:member-property-edit×1
        14  [editor-command] move-selection  transform-object×1  [literal:id-ir8hszr2e]
        15  [state-derived-transaction] state-derived-transaction  add-object×2  [literal:id-6gnp7o098,literal:id-nkkga2pog]  fallback:undeclared-literal-object×2
        16  [state-derived-transaction] state-derived-transaction  transform-object×2  [literal:id-6gnp7o098,literal:id-nkkga2pog]
        17  [editor-command] duplicate-selection,move-selection  add-object×2  [literal:id-6gnp7o098,literal:id-nkkga2pog]  fallback:undeclared-literal-object×2
        18  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-zzjm5lvyw]  fallback:undeclared-literal-object×1
        19  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-zzjm5lvyw]
        20  [editor-command] move-selection  transform-object×1  [literal:id-zzjm5lvyw]
        21  [state-derived-transaction] state-derived-transaction  add-object×1  [literal:id-0lvenqg8c]  fallback:undeclared-literal-object×1
        22  [state-derived-transaction] state-derived-transaction  transform-object×1  [literal:id-0lvenqg8c]
        23  [editor-command] duplicate-selection,move-selection  add-object×1  [literal:id-0lvenqg8c]  fallback:undeclared-literal-object×1
```

Note: То же самое, по бокам пусто и нижний центр пустой, шар почти сразу падает вниз, не за что зацепиться на первых шагах.

## What this digest dropped

- full baselineLevel and finalLevel bodies (available through --level)
- raw per-operation payloads (compact parameters and fallback displacement statistics are retained; exact payloads are available through --operation)
- raw per-command patch bodies (hint, operation counts, target ids, fallback reasons and retraction are retained; exact payloads are available through --command)
- full relational detail for low-salience changed objects when a candidate changes more than three objects (complete distributions are retained; exact relations are available through --relations/--relation)
- verbose gate evidence such as every offending member id (status, failure codes and key counts are retained)
- per-member coordinates except compact changed-member payloads and fallback displacement summaries
- level configuration outside the composition semantic state

The archive is intact. Use the drill-down commands below to retrieve exact raw evidence without loading the whole archive:

```powershell
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --command <sequence>
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --operation <index>
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relations
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relation <objectId>
node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --level before|after
```
