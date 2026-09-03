import assert from 'node:assert/strict';

import {
  applySimilarityTransform,
  bakePegsFromSamples,
  estimateSimilarityTransformFromPairs
} from '../../js/bezier-geometry.js';
import { auditNativeLevelBezierIntegrity } from '../../js/bezier-integrity.js';
import { ensureBezierNode } from '../../js/bezier-program.js';
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
      pegShape: 'brick', pegType: 'blue', spacingPx: 10,
      refPoints: baked.slice(0, 3).map((point, index) => ({ index, x: point.x, y: point.y }))
    },
    orphan: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, h1: { x: 0, y: 0 }, h2: { x: 1, y: 0 } }
  },
  pegs: baked.slice(0, 3).map((point, index) => ({
    id: `volatile-${index}`, bezierGroupId: 'curve', bezierIndex: index,
    x: point.x + 12, y: point.y + 7, angle: point.angle, shape: 'brick', type: 'blue'
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
for (const peg of moved.pegs) peg.x += 5;
// Volatile peg IDs do not participate in semantic identity.
moved.pegs.forEach((peg, index) => { peg.id = `regenerated-${index}`; });
const after = captureBezierSemanticState(moved);
const patch = diffBezierSemanticStates(before, after, { commandHints: ['move-selection'] });
assert.equal(patch.operations.length, 1);
assert.equal(patch.operations[0].type, 'transform-stroke');
assert.equal(patch.metrics.fallbackFraction, 0);
const replayed = applyBezierSemanticPatch(before, patch);
assert.deepEqual(replayed, after);
assert.deepEqual(semanticReplayReport(after, replayed, patch), {
  exact: true,
  replayAccuracy: 1,
  fallbackFraction: 0,
  fallbackReasonCounts: {}
});

const changedShape = clone(moved);
changedShape.bezierCurves.curve.pegShape = 'circle';
changedShape.bezierCurves.curve.spacingPx = 18.7;
const resample = diffBezierSemanticStates(after, captureBezierSemanticState(changedShape));
assert.equal(resample.operations[0].type, 'resample-stroke');

const atomic = clone(moved);
atomic.pegs[1].x += 4;
const fallback = diffBezierSemanticStates(after, captureBezierSemanticState(atomic));
assert.equal(fallback.operations[0].type, 'object-exception');
assert.equal(fallback.metrics.fallbackFraction, 1);
assert.equal(fallback.metrics.fallbackReasonCounts['atomic-object-edit'], 1);

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
assert.equal(evaluateStaticCandidate(compiled).status, 'passed');

console.log('ok bezier repair foundation');
