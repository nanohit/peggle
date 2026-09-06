import assert from 'node:assert/strict';

import {
  applySimilarityTransform,
  bakePegsFromSamples,
  estimateSimilarityTransformFromPairs
} from '../../js/bezier-geometry.js';
import { auditNativeLevelBezierIntegrity } from '../../js/bezier-integrity.js';
import { ensureBezierNode, reconcileResearchCommandActivity } from '../../js/bezier-program.js';
import {
  applyBezierSemanticPatch,
  captureBezierSemanticState,
  diffBezierSemanticStates,
  semanticReplayReport
} from '../../js/bezier-semantic.js';
import { compileBezierProgram, evaluateStaticCandidate } from '../repair/lib/program.mjs';

function lineSamples(length) {
  return Array.from({ length: length + 1 }, (_value, index) => ({ x: index, y: 0, angle: 0 }));
}

const clone = value => JSON.parse(JSON.stringify(value));
const withoutSemanticNodes = state => ({ ...clone(state), nodes: {} });

const baked = bakePegsFromSamples(lineSamples(35), { shape: 'brick', spacingPx: 10, brickWidth: 10 });
assert.deepEqual(baked.map(point => point.x), [5, 15, 25, 32.5]);
assert.equal(baked.at(-1).shortenedTail, true);
assert.equal(baked[0].slices.length, 6);

const circleBaked = bakePegsFromSamples(lineSamples(22), { shape: 'circle', pegRadius: 5 });
assert.deepEqual(circleBaked.map(point => point.x), [5.5, 16.5]);
assert.equal(circleBaked[0].slices, undefined);

const source = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
const wanted = { angle: Math.PI / 6, scale: 1.5, tx: 20, ty: -4 };
const pairs = source.map(value => {
  const destination = applySimilarityTransform(value, wanted);
  return { sx: value.x, sy: value.y, dx: destination.x, dy: destination.y };
});
const fit = estimateSimilarityTransformFromPairs(pairs);
assert.ok(Math.abs(fit.scale - wanted.scale) < 1e-10);
assert.ok(Math.abs(fit.angle - wanted.angle) < 1e-10);
assert.ok(fit.maxResidualPx < 1e-10);

const level = {
  metadata: {},
  bezierCurves: {
    curve: {
      start: { x: 0, y: 0 }, end: { x: 30, y: 0 }, h1: { x: 10, y: 0 }, h2: { x: 20, y: 0 },
      pegShape: 'brick', pegType: 'blue', spacingPx: 10, brickWidth: 10, brickHeight: 10.2,
      refPoints: baked.slice(0, 3).map((point, index) => ({ index, x: point.x, y: point.y }))
    },
    orphan: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, h1: { x: 0, y: 0 }, h2: { x: 1, y: 0 } }
  },
  pegs: baked.slice(0, 3).map((point, index) => ({
    id: `volatile-${index}`, bezierGroupId: 'curve', bezierIndex: index,
    x: point.x + 12, y: point.y + 7, angle: point.angle, shape: 'brick', type: 'blue', width: 10, height: 10.2,
    curveSlices: point.slices.map(s => ({ ...s, x: s.x + 12, y: s.y + 7 }))
  }))
};
ensureBezierNode(level, 'curve');
const audit = auditNativeLevelBezierIntegrity(level, { repair: true, thresholdPx: 0.01 });
assert.equal(audit.counts['similarity-reconcilable'], 1);
assert.equal(audit.counts['orphan-curve'], 1);
assert.equal(level.bezierCurves.orphan, undefined);
assert.ok(Math.abs(level.bezierCurves.curve.start.x - 12) < 1e-10);
assert.ok(Math.abs(level.bezierCurves.curve.start.y - 7) < 1e-10);

const before = captureBezierSemanticState(level);
const moved = clone(level);
for (const key of ['start', 'end', 'h1', 'h2']) moved.bezierCurves.curve[key].x += 5;
for (const point of moved.bezierCurves.curve.refPoints) point.x += 5;
for (const peg of moved.pegs) { peg.x += 5; for (const s of peg.curveSlices) s.x += 5; }
// Volatile peg IDs do not participate in semantic identity.
moved.pegs.forEach((peg, index) => { peg.id = `regenerated-${index}`; });
const after = captureBezierSemanticState(moved);
const patch = diffBezierSemanticStates(before, after, { commandHints: ['move-selection'] });
assert.equal(patch.operations.length, 1);
assert.equal(patch.operations[0].type, 'transform-stroke');
assert.equal(patch.metrics.repairFallbackFraction, 0);
assert.equal(patch.metrics.stateFallbackFraction, 0);
const replayed = applyBezierSemanticPatch(before, patch);
assert.deepEqual(semanticReplayReport(after, replayed, patch), {
  exact: true,
  replayAccuracy: 1,
  strokeAccuracy: 1,
  memberAccuracy: 1,
  repairFallbackFraction: 0,
  stateFallbackFraction: 0,
  stateProgramCoverage: 1,
  fallbackReasonCounts: {}
});

// D1 regression: replay must execute the operation, not copy operation.after.
const corruptedType = clone(patch);
corruptedType.operations[0].type = 'object-exception';
assert.equal(semanticReplayReport(after, applyBezierSemanticPatch(before, corruptedType), corruptedType).exact, false);
const corruptedTransform = clone(patch);
corruptedTransform.operations[0].transform = { angle: 999, scale: -7, tx: 1e6, ty: -1e6 };
assert.equal(semanticReplayReport(after, applyBezierSemanticPatch(before, corruptedTransform), corruptedTransform).exact, false);
assert.equal('after' in patch.operations[0], false);

const changedShape = clone(moved);
changedShape.bezierCurves.curve.pegShape = 'circle';
changedShape.bezierCurves.curve.spacingPx = 18.7;
const resample = diffBezierSemanticStates(after, captureBezierSemanticState(changedShape));
assert.equal(resample.operations[0].type, 'resample-stroke');

const atomic = clone(moved);
atomic.pegs[1].x += 4;
for (const s of atomic.pegs[1].curveSlices) s.x += 4;
atomic.metadata.generatorProgram.nodes.curve.exceptions.overrides['1'] = {
  kind: 'position', x: atomic.pegs[1].x, y: atomic.pegs[1].y, residualPx: 4
};
const fallback = diffBezierSemanticStates(after, captureBezierSemanticState(atomic));
assert.equal(fallback.operations[0].type, 'object-exception');
assert.equal(fallback.metrics.repairFallbackFraction, 1);
assert.equal(fallback.metrics.stateFallbackFraction, 1 / 3);
assert.equal(fallback.metrics.fallbackReasonCounts['atomic-object-edit'], 1);
assert.equal(semanticReplayReport(
  captureBezierSemanticState(atomic), applyBezierSemanticPatch(after, fallback), fallback
).exact, true);

const fiftyFour = compileBezierProgram({
  id: 'metric-denominator', name: 'Metric denominator', pegRadius: 8.5,
  strokes: [{
    groupId: 'long', pegShape: 'circle', spacingPx: 18.7,
    start: { x: 0, y: 500 }, h1: { x: 333.333333333, y: 500 },
    h2: { x: 666.666666667, y: 500 }, end: { x: 1000, y: 500 }
  }]
});
assert.equal(fiftyFour.pegs.length, 54);
const fiftyFourEdited = clone(fiftyFour);
fiftyFourEdited.pegs[20].y -= 5;
fiftyFourEdited.metadata.generatorProgram.nodes.long.exceptions.overrides['20'] = {
  kind: 'position', x: fiftyFourEdited.pegs[20].x, y: fiftyFourEdited.pegs[20].y
};
const denominatorPatch = diffBezierSemanticStates(
  captureBezierSemanticState(fiftyFour), captureBezierSemanticState(fiftyFourEdited)
);
assert.equal(denominatorPatch.metrics.repairFallbackFraction, 1);
assert.equal(denominatorPatch.metrics.stateFallbackFraction, 1 / 54);
assert.equal(denominatorPatch.metrics.stateProgramCoverage, 53 / 54);

// D3/D5 regression: a genuine curved reflection is parameterized, never a
// catch-all update operation.
const curvedProgram = {
  id: 'curved-mirror', name: 'Curved mirror', pegRadius: 8.5,
  strokes: [{
    groupId: 's-curve', pegShape: 'brick', pegType: 'blue', rotationOffset: 0.2,
    start: { x: 60, y: 160 }, h1: { x: 300, y: 80 }, h2: { x: 80, y: 330 }, end: { x: 330, y: 400 }
  }]
};
const curved = compileBezierProgram(curvedProgram);
const mirrored = clone(curved);
for (const key of ['start', 'end', 'h1', 'h2']) mirrored.bezierCurves['s-curve'][key].x = 400 - mirrored.bezierCurves['s-curve'][key].x;
for (const point of mirrored.bezierCurves['s-curve'].refPoints) point.x = 400 - point.x;
mirrored.bezierCurves['s-curve'].rotationOffset *= -1;
for (const peg of mirrored.pegs) {
  peg.x = 400 - peg.x; peg.angle = -(peg.angle || 0);
  for (const s of peg.curveSlices) { s.x = 400 - s.x; s.nx = -s.nx; }
}
const mirrorPatch = diffBezierSemanticStates(
  captureBezierSemanticState(curved), captureBezierSemanticState(mirrored), { thresholdPx: 0.01 }
);
assert.deepEqual(mirrorPatch.operations.map(operation => operation.type), ['mirror-stroke']);
assert.equal(mirrorPatch.operations[0].transform.reflect, true);
assert.equal(mirrorPatch.metrics.repairFallbackFraction, 0);
assert.equal(semanticReplayReport(
  captureBezierSemanticState(mirrored),
  applyBezierSemanticPatch(captureBezierSemanticState(curved), mirrorPatch),
  mirrorPatch
).exact, true);

// D4 regression: reason comes from each edit's structure, not the number of
// fallback operations in the patch.
const twoStrokes = compileBezierProgram({
  id: 'two-atomic', name: 'Two atomic', pegRadius: 8.5,
  strokes: [
    { groupId: 'left', pegShape: 'circle', start: { x: 40, y: 180 }, h1: { x: 80, y: 180 }, h2: { x: 120, y: 180 }, end: { x: 160, y: 180 } },
    { groupId: 'right', pegShape: 'circle', start: { x: 240, y: 300 }, h1: { x: 280, y: 300 }, h2: { x: 320, y: 300 }, end: { x: 360, y: 300 } }
  ]
});
const twoAtomic = clone(twoStrokes);
twoAtomic.pegs.find(peg => peg.bezierGroupId === 'left').y += 5;
twoAtomic.pegs.find(peg => peg.bezierGroupId === 'right').y -= 5;
const twoAtomicPatch = diffBezierSemanticStates(
  captureBezierSemanticState(twoStrokes), captureBezierSemanticState(twoAtomic)
);
assert.deepEqual(
  twoAtomicPatch.operations.filter(operation => operation.expressibility === 'fallback').map(operation => operation.reason),
  ['atomic-object-edit', 'atomic-object-edit']
);

// N2/N3 regression: equal deltas are not "regional" unless indices are
// contiguous. A non-contiguous selection transform requires command evidence.
const sparseSelection = clone(fiftyFour);
for (const index of [0, 5, 11]) {
  sparseSelection.pegs[index].y += 6;
  sparseSelection.metadata.generatorProgram.nodes.long.exceptions.overrides[String(index)] = {
    kind: 'position', x: sparseSelection.pegs[index].x, y: sparseSelection.pegs[index].y
  };
}
const sparseWithoutEvidence = diffBezierSemanticStates(
  captureBezierSemanticState(fiftyFour), captureBezierSemanticState(sparseSelection)
);
assert.equal(sparseWithoutEvidence.operations.find(operation => operation.expressibility === 'fallback').reason,
  'multiple-atomic-object-edits');
const sparseWithEvidence = diffBezierSemanticStates(
  captureBezierSemanticState(fiftyFour), captureBezierSemanticState(sparseSelection),
  { commandHints: ['move-selection'], commandScope: 'single' }
);
assert.equal(sparseWithEvidence.operations.find(operation => operation.expressibility === 'fallback').reason,
  'missing-language-operation:selection-transform');
const sparseWithRecordedEvidence = diffBezierSemanticStates(
  captureBezierSemanticState(fiftyFour), captureBezierSemanticState(sparseSelection),
  { commandEvidence: [{
    hints: ['move-selection'],
    operations: [{ groupId: 'long', affectedMemberIndices: [0, 5, 11] }]
  }] }
);
assert.equal(sparseWithRecordedEvidence.operations.find(operation => operation.expressibility === 'fallback').reason,
  'missing-language-operation:selection-transform');
const contiguousSelection = clone(fiftyFour);
for (const index of [0, 1, 2]) {
  contiguousSelection.pegs[index].y += 6;
  contiguousSelection.metadata.generatorProgram.nodes.long.exceptions.overrides[String(index)] = {
    kind: 'position', x: contiguousSelection.pegs[index].x, y: contiguousSelection.pegs[index].y
  };
}
const contiguousPatch = diffBezierSemanticStates(
  captureBezierSemanticState(fiftyFour), captureBezierSemanticState(contiguousSelection)
);
assert.equal(contiguousPatch.operations.find(operation => operation.expressibility === 'fallback').reason,
  'missing-language-operation:regional-transform');

// N1 regression: delete-selection is evidence only inside one command and is
// combined with the existing spatial-closeness test.
const nearStrokes = compileBezierProgram({
  id: 'near-deletion', name: 'Near deletion', pegRadius: 8.5,
  strokes: [
    { groupId: 'near-a', pegShape: 'circle', start: { x: 80, y: 220 }, h1: { x: 100, y: 220 }, h2: { x: 120, y: 220 }, end: { x: 140, y: 220 } },
    { groupId: 'near-b', pegShape: 'circle', start: { x: 160, y: 250 }, h1: { x: 180, y: 250 }, h2: { x: 200, y: 250 }, end: { x: 220, y: 250 } }
  ]
});
const nearState = captureBezierSemanticState(nearStrokes);
const deleteAllState = withoutSemanticNodes(nearState);
const unscopedDelete = diffBezierSemanticStates(nearState, deleteAllState, {
  commandHints: ['delete-selection']
});
assert.equal(unscopedDelete.operations.some(operation => operation.compressionOpportunity), false);
const scopedDelete = diffBezierSemanticStates(nearState, deleteAllState, {
  commandHints: ['delete-selection'], commandScope: 'single'
});
assert.equal(scopedDelete.operations.filter(operation => operation.type === 'delete-stroke')
  .every(operation => operation.compressionOpportunity?.commandEvidence === 'delete-selection'), true);
const replayedDeleteEvidence = diffBezierSemanticStates(nearState, deleteAllState, {
  commandEvidence: [{
    hints: ['delete-selection'],
    operations: [{ type: 'delete-stroke', groupId: 'near-a' }, { type: 'delete-stroke', groupId: 'near-b' }]
  }]
});
assert.equal(replayedDeleteEvidence.operations.filter(operation => operation.type === 'delete-stroke')
  .every(operation => operation.compressionOpportunity), true);

// D6 regression: two correspondences can always be fit exactly and therefore
// do not constitute an integrity verdict.
const twoPointLevel = clone(level);
twoPointLevel.pegs = twoPointLevel.pegs.slice(0, 2);
twoPointLevel.bezierCurves.curve.refPoints = twoPointLevel.bezierCurves.curve.refPoints.slice(0, 2);
const twoPointAudit = auditNativeLevelBezierIntegrity(twoPointLevel, { repair: false, thresholdPx: 0.01 });
assert.equal(twoPointAudit.reports.find(report => report.groupId === 'curve').status, 'insufficient-lineage');

// D7 regression: object key insertion order has no semantic meaning.
const reordered = clone(moved);
const oldCurve = reordered.bezierCurves.curve;
reordered.bezierCurves.curve = Object.fromEntries(Object.entries(oldCurve).reverse());
assert.equal(diffBezierSemanticStates(after, captureBezierSemanticState(reordered)).operations.length, 0);

const compiled = compileBezierProgram({
  id: 'no-op', name: 'No-op', pegRadius: 8.5,
  strokes: [{
    groupId: 'circle-stroke', pegShape: 'circle', pegType: 'blue',
    start: { x: 80, y: 180 }, h1: { x: 140, y: 180 }, h2: { x: 200, y: 180 }, end: { x: 260, y: 180 }
  }]
});
const recompiled = compileBezierProgram({
  id: 'no-op', name: 'No-op', pegRadius: 8.5,
  strokes: [{
    groupId: 'circle-stroke', pegShape: 'circle', pegType: 'blue',
    start: { x: 80, y: 180 }, h1: { x: 140, y: 180 }, h2: { x: 200, y: 180 }, end: { x: 260, y: 180 }
  }]
});
recompiled.pegs.forEach((peg, index) => { peg.id = `import-regenerated-${index}`; });
const noOp = diffBezierSemanticStates(captureBezierSemanticState(compiled), captureBezierSemanticState(recompiled));
assert.equal(noOp.operations.length, 0);
// The native midpoint/tail bake shortens the last spacing: this fixture has
// a real intra-stroke circle overlap, which the old same-object skip hid.
assert.equal(evaluateStaticCandidate(compiled).status, 'rejected');
assert.equal(evaluateStaticCandidate(compiled).sameObjectOverlapCount, 1);

const compiledState = captureBezierSemanticState(compiled);
const emptyState = withoutSemanticNodes(compiledState);
const addPatch = diffBezierSemanticStates(emptyState, compiledState);
assert.deepEqual(addPatch.operations.map(operation => operation.type), ['add-stroke']);
assert.equal(addPatch.operations.some(operation => 'after' in operation), false);
assert.equal(semanticReplayReport(
  compiledState, applyBezierSemanticPatch(emptyState, addPatch), addPatch
).exact, true);
const deletePatch = diffBezierSemanticStates(compiledState, emptyState);
assert.deepEqual(deletePatch.operations.map(operation => operation.type), ['delete-stroke']);
assert.equal(semanticReplayReport(
  emptyState, applyBezierSemanticPatch(compiledState, deletePatch), deletePatch
).exact, true);

const resampledLevel = compileBezierProgram({
  id: 'no-op', name: 'No-op', pegRadius: 8.5,
  strokes: [{
    groupId: 'circle-stroke', pegShape: 'brick', pegType: 'blue', spacingPx: 28,
    start: { x: 80, y: 180 }, h1: { x: 140, y: 180 }, h2: { x: 200, y: 180 }, end: { x: 260, y: 180 }
  }]
});
const nativeResamplePatch = diffBezierSemanticStates(
  captureBezierSemanticState(compiled), captureBezierSemanticState(resampledLevel)
);
assert.deepEqual(nativeResamplePatch.operations.map(operation => operation.type), ['resample-stroke']);
assert.equal(nativeResamplePatch.operations.some(operation => 'after' in operation), false);
assert.equal(semanticReplayReport(
  captureBezierSemanticState(resampledLevel),
  applyBezierSemanticPatch(captureBezierSemanticState(compiled), nativeResamplePatch),
  nativeResamplePatch
).exact, true);

const bentProgram = clone({
  id: 'no-op', name: 'No-op', pegRadius: 8.5,
  strokes: [{
    groupId: 'circle-stroke', pegShape: 'circle', pegType: 'blue',
    start: { x: 80, y: 180 }, h1: { x: 130, y: 140 }, h2: { x: 210, y: 220 }, end: { x: 260, y: 180 }
  }]
});
const bentLevel = compileBezierProgram(bentProgram);
const controlPatch = diffBezierSemanticStates(
  captureBezierSemanticState(compiled), captureBezierSemanticState(bentLevel)
);
assert.deepEqual(controlPatch.operations.map(operation => operation.type), ['edit-control-points']);
assert.equal(semanticReplayReport(
  captureBezierSemanticState(bentLevel),
  applyBezierSemanticPatch(captureBezierSemanticState(compiled), controlPatch),
  controlPatch
).exact, true);

const rawCommands = [
  { sequence: 0, hints: ['move-selection'] },
  { sequence: 1, hints: ['rotate-selection'] }
];
const afterUndo = reconcileResearchCommandActivity(
  rawCommands,
  [rawCommands[0]],
  'undo',
  '2026-01-01T00:00:00.000Z'
);
assert.equal(afterUndo[0].retracted, undefined);
assert.equal(afterUndo[1].retracted, true);
assert.deepEqual(afterUndo[1].activity, [{
  action: 'undo', at: '2026-01-01T00:00:00.000Z', retracted: true
}]);
const afterRedo = reconcileResearchCommandActivity(
  afterUndo,
  rawCommands,
  'redo',
  '2026-01-01T00:01:00.000Z'
);
assert.equal(afterRedo[1].retracted, false);
assert.equal(afterRedo[1].activity.length, 2);

console.log('ok bezier repair foundation');
