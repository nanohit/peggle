import assert from 'node:assert/strict';

import { captureBezierSemanticState, diffBezierSemanticStates } from '../../js/bezier-semantic.js';
import { applyBezierSemanticPatch, semanticReplayReport } from '../../js/bezier-semantic.js';
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

// Group structure remains semantic, while level-wide semantic state is an
// explicit composition whitelist. Gameplay and presentation settings survive
// native import but must not become composition-language gaps.
const grouped = normalizeLevelData({
  ...freePegLevel(3),
  id: 'grouped-regression',
  pegRadius: 9,
  aimLength: 220,
  flippers: { enabled: true, y: 540, xOffset: 80, length: 72 },
  groups: [{
    id: 'runtime-group', name: 'Moving crown', pattern: 'custom',
    animation: { dx: 20, dy: 5, rotation: 0.1, duration: 2, easing: 'easeInOut' }
  }]
});
for (const peg of grouped.pegs) peg.groupId = grouped.groups[0].id;
grouped.pegs[0].pvpMirrorOf = grouped.pegs[1].id;
grouped.pegs[1].portalDestinationId = grouped.pegs[2].id;
grouped.pegs[2].destinationId = grouped.pegs[0].id;
normalizeLevelData(grouped);
const groupedState = captureBezierSemanticState(grouped);
assert.equal(Object.keys(groupedState.groups).length, 1);
assert.equal(Object.values(groupedState.groups)[0].family, 'AnimationGroup');
assert.equal(Object.values(groupedState.groups)[0].memberIds.length, 3);
assert.equal(groupedState.level.pegRadius, 9);
assert.equal(groupedState.level.aimLength, undefined);
assert.equal(groupedState.level.flippers, undefined);
assert.equal(Object.values(grouped.metadata.generatorProgram.nodes).some(node => 'nodeId' in node), false);

const importedGrouped = manager.importLevel(JSON.stringify(grouped));
assert.equal(diffBezierSemanticStates(groupedState, captureBezierSemanticState(importedGrouped)).operations.length, 0);
assert.equal(importedGrouped.groups[0].objectId, grouped.groups[0].objectId);

const changedContext = clone(grouped);
changedContext.pegRadius = 10;
changedContext.aimLength = 180;
changedContext.visuals.background.color = '#123456';
changedContext.character = { id: 'out-of-scope-character' };
changedContext.dialogue = { enabled: true, entries: [] };
changedContext.survival.initialBalls = 999;
changedContext.flippers.xOffset = 96;
changedContext.groups[0].animation.dx = 33;
const changedContextState = captureBezierSemanticState(changedContext);
const contextPatch = diffBezierSemanticStates(groupedState, changedContextState);
assert.deepEqual(contextPatch.operations.map(operation => operation.type), [
  'set-level-properties', 'set-group-properties'
]);
assert.equal(semanticReplayReport(
  changedContextState, applyBezierSemanticPatch(groupedState, contextPatch), contextPatch
).exact, true);
assert.deepEqual(Object.keys(contextPatch.operations[0].changes), ['pegRadius']);

console.log('ok semantic object identity and free-peg coverage');
