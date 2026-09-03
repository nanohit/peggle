import assert from 'node:assert/strict';

import {
  applyBezierSemanticPatch,
  captureBezierSemanticState,
  diffBezierSemanticStates,
  semanticReplayReport
} from '../../js/bezier-semantic.js';
import { normalizeLevelData } from '../../js/levels.js';
import {
  declareSemanticObject,
  describeSemanticSelection,
  fitSemanticObject
} from '../../js/semantic-objects.js';

const ring = normalizeLevelData({
  id: 'declare-ring', name: 'Declare ring', groups: [], bezierCurves: {}, metadata: {},
  pegs: Array.from({ length: 12 }, (_value, index) => {
    const angle = index / 12 * Math.PI * 2;
    return {
      id: `peg-${index}`, type: 'blue', shape: 'circle',
      x: 200 + Math.cos(angle) * 80, y: 260 + Math.sin(angle) * 80, angle: 0
    };
  })
});

const before = captureBezierSemanticState(ring);
assert.equal(describeSemanticSelection(ring, ring.pegs.map(peg => peg.id)).text,
  '12 pegs — 12 objects (12 whole, 0 partial)');
const declaration = declareSemanticObject(ring, ring.pegs.map(peg => peg.id), 'Ring', {
  at: '2026-01-01T00:00:00.000Z'
});
assert.equal(declaration.ok, true);
assert.ok(declaration.fit.diagnostics.maxResidualPx < 1e-8);
assert.equal(describeSemanticSelection(ring, ring.pegs.map(peg => peg.id)).text,
  '12 pegs — whole object (Ring)');
assert.equal(describeSemanticSelection(ring, ring.pegs.slice(0, 11).map(peg => peg.id)).text,
  '11 of 12 pegs — partial object (Ring)');
assert.equal(ring.metadata.generatorProgram.declarationLog.length, 1);
assert.equal(ring.metadata.generatorProgram.declarationLog[0].sequence, 0);

const after = captureBezierSemanticState(ring);
const patch = diffBezierSemanticStates(before, after, { commandHints: ['declare-object:ring'] });
assert.deepEqual(patch.operations.map(operation => operation.type), ['declare-object']);
assert.equal(patch.operations[0].expressibility, 'native');
assert.equal(patch.metrics.stateProgramCoverage, 1);
assert.equal(semanticReplayReport(after, applyBezierSemanticPatch(before, patch), patch).exact, true);

const noise = normalizeLevelData({
  id: 'declare-noise', name: 'Declare noise', groups: [], bezierCurves: {}, metadata: {},
  pegs: [
    { id: 'a', x: 40, y: 90 }, { id: 'b', x: 310, y: 110 }, { id: 'c', x: 130, y: 260 },
    { id: 'd', x: 360, y: 440 }, { id: 'e', x: 90, y: 520 }
  ].map(peg => ({ ...peg, type: 'blue', shape: 'circle', angle: 0 }))
});
const rejectedRing = fitSemanticObject(noise.pegs, 'Ring', { thresholdPx: 2 });
assert.equal(rejectedRing.accepted, false);
const literal = declareSemanticObject(noise, noise.pegs.map(peg => peg.id), 'Cluster');
assert.equal(literal.ok, true);
assert.equal(literal.fit.literalFallback, true);
const literalState = captureBezierSemanticState(noise);
const onlyNode = Object.values(literalState.nodes)[0];
assert.equal(onlyNode.family, 'LiteralCluster');
assert.equal(diffBezierSemanticStates(captureBezierSemanticState({ pegs: [], bezierCurves: {}, metadata: {} }), literalState)
  .metrics.stateProgramCoverage, 0);

console.log('ok semantic object declaration, fitting and replay');
