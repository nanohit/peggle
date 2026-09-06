import assert from 'node:assert/strict';
import { Editor } from '../../js/editor.js';
import { LevelManager, normalizeLevelData } from '../../js/levels.js';
import { PHYSICS_CONFIG } from '../../js/physics.js';
import { captureBezierSemanticState as capture, diffBezierSemanticStates as diff, applyBezierSemanticPatch as apply, semanticReplayReport as replay } from '../../js/bezier-semantic.js';
import { declareSemanticObject } from '../../js/semantic-objects.js';
import { evaluateRepairStaticChecks } from '../../js/repair-session.js';
import { compileBezierProgram } from '../repair/lib/program.mjs';
import { renderNativeLevelSvg } from '../repair/lib/render-native-level.mjs';

const clone = x => JSON.parse(JSON.stringify(x));
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// Real LevelManager + real editor commands; only canvas/UI callbacks are stubs.
function editorFor(level) {
  const manager = new LevelManager(); manager.levels = [clone(level)]; manager.currentLevelIndex = 0;
  const editor = Object.create(Editor.prototype);
  Object.assign(editor, { levelManager: manager, canvas: { width: 400, height: 600 }, selectedPegIds: new Set(),
    selectedPegType: 'blue', selectedShape: 'circle', selectedPegColor: null, drawPath: [], ghostBricks: [],
    undoStack: [], redoStack: [], maxUndoSteps: 50, researchEditorCommands: [], _researchHistorySequence: 0,
    _researchCommandBefore: null, _researchCommandHints: [], snapToGrid: false,
    survivalRuntime: { isEnabled: () => false },
    setMode() {}, notifySelectionChange() {}, createPvpMirroredCopies() {}, isPegPositionAllowed: () => true });
  PHYSICS_CONFIG.pegRadius = level.pegRadius || 8.5;
  return { editor, manager, level: () => manager.getCurrentLevel() };
}
const program = { id: 'loop-regression', pegRadius: 8.5, strokes: [
  { groupId: 'ribbon', pegShape: 'brick', pegType: 'blue', brickWidth: 23.8, brickHeight: 9.5, spacingPx: 23.8,
    start: { x: 50, y: 180 }, h1: { x: 110, y: 100 }, h2: { x: 270, y: 260 }, end: { x: 350, y: 190 } },
  { groupId: 'dots', pegShape: 'circle', pegType: 'blue', spacingPx: 20,
    start: { x: 60, y: 330 }, h1: { x: 160, y: 290 }, h2: { x: 240, y: 410 }, end: { x: 340, y: 350 } }
] };
const baseline = normalizeLevelData(compileBezierProgram(program));
const numericalNoise = clone(baseline);
numericalNoise.pegs[0].width += 1e-12;
assert.equal(diff(capture(baseline), capture(numericalNoise)).operations.length, 0, 'cross-engine ULPs are not author edits');
assert.equal(replay(capture(baseline), capture(numericalNoise)).exact, true);
numericalNoise.pegs[0].width += 0.01;
assert.ok(diff(capture(baseline), capture(numericalNoise)).operations.length > 0, 'real dimensions remain observable');
assert.equal(replay(capture(baseline), capture(numericalNoise)).exact, false);
for (const groupId of Object.keys(baseline.bezierCurves)) {
  const { editor, level } = editorFor(baseline);
  const before = capture(level());
  assert.equal(editor.beginEditBezierGroup(groupId), true);
  editor.commitGhostBricks();
  const after = capture(level()), patch = diff(before, after);
  assert.deepEqual(patch.operations, [], `no-op recommit ${groupId}: ${JSON.stringify(patch.operations.map(o => o.type))}`);
  assert.equal(replay(after, apply(before, patch), patch).exact, true);
}
for (const dx of [0.5, 1.01, 4]) {
  const { editor, level } = editorFor(baseline), before = capture(level());
  const peg = level().pegs.find(p => p.bezierGroupId === 'dots' && p.bezierIndex === 4);
  editor.selectedPegIds.add(peg.id); editor.beginResearchCommand('move-selection'); editor.saveUndoState();
  editor.captureDragStartPositions(); editor.moveSelectedPegs(dx, 0);
  editor.finalizeBezierSelectionExceptions(); editor.finishResearchCommand('move-selection');
  const after = capture(level()), patch = diff(before, after);
  assert.equal(replay(after, apply(before, patch), patch).exact, true, `replay ${dx}px`);
  assert.ok(!patch.operations.some(o => o.type === 'transform-stroke'), 'one peg is not the whole curve');
  assert.ok(patch.metrics.repairFallbackFraction <= 1);
  assert.equal(patch.metrics.changedMemberCount, dx <= 1 ? 0 : 1);
  assert.equal(patch.metrics.precisionCorrectionMemberCount, dx <= 1 ? 1 : 0);
  editor.undo(); assert.equal(diff(before, capture(level())).operations.length, 0);
  editor.redo(); assert.equal(replay(after, capture(level()), patch).exact, true);
}

const physical = clone(baseline), physicalBefore = capture(physical);
for (const s of physical.pegs[0].curveSlices) s.x += 100;
const physicalAfter = capture(physical), physicalPatch = diff(physicalBefore, physicalAfter);
assert.ok(physicalPatch.operations.some(o => o.type === 'object-exception'));
assert.equal(replay(physicalAfter, physicalBefore, physicalPatch).exact, false);
assert.equal(replay(physicalAfter, apply(physicalBefore, physicalPatch), physicalPatch).exact, true);
assert.notEqual(renderNativeLevelSvg(baseline), renderNativeLevelSvg(physical));
assert.ok(renderNativeLevelSvg(baseline).includes('<polygon'));
const coincident = clone(baseline); coincident.pegs = [clone(baseline.pegs.at(-1)), clone(baseline.pegs.at(-1))];
coincident.pegs[1].memberId += ':duplicate';
assert.equal(evaluateRepairStaticChecks(coincident).sameObjectOverlapCount, 1);
const coincidentRibbons = clone(baseline);
coincidentRibbons.pegs = [clone(baseline.pegs[0]), clone(baseline.pegs[0])];
coincidentRibbons.pegs[1].memberId += ':duplicate';
assert.equal(evaluateRepairStaticChecks(coincidentRibbons).sameObjectOverlapCount, 1, 'identical ribbons are not an end-to-end seam');

const ring = normalizeLevelData({ id: 'executable-ring', pegs: Array.from({ length: 12 }, (_, i) => ({
  id: `r${i}`, x: 200 + 80 * Math.cos(i * Math.PI / 6), y: 280 + 80 * Math.sin(i * Math.PI / 6), shape: 'circle', type: 'blue'
})), metadata: {}, groups: [], bezierCurves: {} });
const ringBefore = capture(ring); declareSemanticObject(ring, ring.pegs.map(p => p.id), 'Ring');
const ringAfter = capture(ring), ringPatch = diff(ringBefore, ringAfter);
const declaration = ringPatch.operations.find(o => o.type === 'declare-object');
assert.equal(declaration.declaredObject.members, undefined, 'native declaration must not carry the answer');
assert.equal(replay(ringAfter, apply(ringBefore, ringPatch), ringPatch).exact, true);
declaration.declaredObject.definition.radius *= 2;
assert.equal(replay(ringAfter, apply(ringBefore, ringPatch), ringPatch).exact, false, 'corrupt radius MUST fail');

const longJournal = editorFor(normalizeLevelData({ id: 'journal', pegs: [{ id: 'j', x: 200, y: 300 }], groups: [], metadata: {}, bezierCurves: {} }));
for (let i = 0; i < 505; i++) {
  longJournal.editor.beginResearchCommand('move-selection'); longJournal.level().pegs[0].x += 0.01;
  longJournal.editor.finishResearchCommand('move-selection');
}
assert.equal(longJournal.editor.researchEditorCommands.length, 505);
assert.equal(new Set(longJournal.editor.researchEditorCommands.map(c => c.sequence)).size, 505);
console.log('ok real editor recommit, subpixel edits, undo/redo, physical ribbons, executable declarations, >500 commands');
