import assert from 'node:assert/strict';

import { captureBezierSemanticState, diffBezierSemanticStates } from '../../js/bezier-semantic.js';
import { LevelManager, normalizeLevelData } from '../../js/levels.js';

const clone = value => JSON.parse(JSON.stringify(value));

function freePegLevel(count = 13) {
  return {
    version: 1,
    id: 'free-peg-regression',
    name: 'Free peg regression',
    pegs: Array.from({ length: count }, (_value, index) => ({
      id: `runtime-${index}`,
      type: index === 0 ? 'orange' : 'blue',
      shape: index % 3 === 0 ? 'brick' : 'circle',
      x: 40 + (index % 5) * 55,
      y: 100 + Math.floor(index / 5) * 70,
      angle: index % 3 === 0 ? index * 0.1 : 0,
      ...(index % 3 === 0 ? { width: 34, height: 10 } : {})
    })),
    groups: [],
    bezierCurves: {},
    metadata: {}
  };
}

// A1 regression: adding thirteen non-Bezier pegs must never look like a no-op.
const empty = normalizeLevelData(freePegLevel(0));
const free = normalizeLevelData(freePegLevel(13));
const emptyState = captureBezierSemanticState(empty);
const freeState = captureBezierSemanticState(free);
const addFreePegs = diffBezierSemanticStates(emptyState, freeState);
assert.equal(Object.values(freeState.nodes).reduce((sum, node) => sum + node.members.length, 0), 13);
assert.equal(addFreePegs.operations.length, 13);
assert.equal(addFreePegs.metrics.finalMemberCount, 13);
assert.equal(addFreePegs.metrics.stateProgramCoverage, 0);

// Every physical peg has stable member identity and exactly one semantic owner.
assert.equal(new Set(free.pegs.map(peg => peg.memberId)).size, 13);
assert.equal(new Set(free.pegs.map(peg => peg.objectId)).size, 13);
for (const peg of free.pegs) {
  assert.ok(peg.memberId);
  assert.ok(peg.objectId);
  assert.equal(free.metadata.generatorProgram.nodes[peg.objectId].objectId, peg.objectId);
  assert.equal(free.metadata.generatorProgram.nodes[peg.objectId].family, 'LiteralCluster');
}

// A3 regression: import regenerates volatile runtime IDs, but not semantic IDs.
const beforeImport = clone(free);
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0
};
const manager = new LevelManager();
const imported = manager.importLevel(JSON.stringify(beforeImport));
assert.ok(imported);
assert.notDeepEqual(imported.pegs.map(peg => peg.id), beforeImport.pegs.map(peg => peg.id));
assert.deepEqual(imported.pegs.map(peg => peg.memberId), beforeImport.pegs.map(peg => peg.memberId));
assert.deepEqual(imported.pegs.map(peg => peg.objectId), beforeImport.pegs.map(peg => peg.objectId));
assert.deepEqual(
  Object.keys(imported.metadata.generatorProgram.nodes).sort(),
  Object.keys(beforeImport.metadata.generatorProgram.nodes).sort()
);
assert.equal(diffBezierSemanticStates(freeState, captureBezierSemanticState(imported)).operations.length, 0);

// Non-geometric peg attributes are part of state and replay, not silently lost.
const recolored = clone(imported);
recolored.pegs[4].color = '#123456';
const propertyPatch = diffBezierSemanticStates(
  captureBezierSemanticState(imported), captureBezierSemanticState(recolored)
);
assert.equal(propertyPatch.operations.length, 1);
assert.equal(propertyPatch.operations[0].type, 'object-exception');
assert.equal(propertyPatch.operations[0].reason, 'atomic-object-edit');

console.log('ok semantic object identity and free-peg coverage');
