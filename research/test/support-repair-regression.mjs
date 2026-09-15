import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Editor } from '../../js/editor.js';
import { LevelManager, normalizeLevelData } from '../../js/levels.js';
import { ensureLevelSemanticIdentity } from '../../js/bezier-program.js';
import { PHYSICS_CONFIG } from '../../js/physics.js';
import { bumperContactProperties, contactRadius } from '../../js/peg-contact.js';
import { evaluateCompositionGeometry } from '../../js/composition-geometry.js';
import { captureBezierSemanticState as capture, diffBezierSemanticStates as diff, applyBezierSemanticPatch as apply, semanticReplayReport as replay } from '../../js/bezier-semantic.js';
import { prepareRepairSessionExport, startRepairSession, recordRepairTransaction, resumeRepairArchive } from '../../js/repair-session.js';
import { makeStandardPlayPreview } from '../../js/repair-play-preview.js';
import { renderNativeLevelSvg } from '../repair/lib/render-native-level.mjs';
import { buildRadialDefinition } from '../tools/build-radial-loop.mjs';
import { generateRadialLevel } from '../repair/lib/radial-generator.mjs';
import { generateSupportedRadialLevel, SUPPORT_STUDY_SEEDS } from '../repair/lib/external-support-generator.mjs';
import { prepareSupportStudy, buildSupportStudy } from '../tools/build-support-study.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const radial = JSON.parse(await fs.readFile('research/repair/radial-rules-v1.json', 'utf8'));
const supports = JSON.parse(await fs.readFile('research/repair/external-support-rules-v1.json', 'utf8'));
assert.equal(bumperContactProperties({ type: 'bumper' }).bumperBounce, PHYSICS_CONFIG.bounce);
const bumper = { id: 'b', objectId: 'b', memberId: 'b:0', x: 25, y: 300, type: 'bumper', shape: 'circle', bumperScale: 1.6, bumperBounce: 3.2 };
const level = normalizeLevelData({ id: 'bumper-test', pegs: [bumper], pegRadius: 8.5 });
ensureLevelSemanticIdentity(level);
for (const [key, value] of Object.entries({ bumperScale: 2, bumperBounce: 0.7, bumperDisappear: true, bumperOrange: true })) {
  const after = clone(level); after.pegs[0][key] = value;
  const patch = diff(capture(level), capture(after));
  assert.ok(patch.operations.length, `${key} must be observed`);
  assert.equal(replay(capture(after), apply(capture(level), patch), patch).exact, true);
  assert.equal(replay(capture(after), capture(level)).exact, false, `${key} must fail corrupt replay`);
}
const defaults = clone(level); defaults.pegs[0].bumperDisappear = false; defaults.pegs[0].bumperOrange = false;
assert.equal(diff(capture(level), capture(defaults)).operations.length, 0, 'absent false is not an edit');
assert.equal(contactRadius(bumper, 8.5), 13.600000000000001);
assert.match(renderNativeLevelSvg(level), /radius 13\.6/);
const nearWall = clone(level); nearWall.pegs[0].x = 10;
assert.equal(evaluateCompositionGeometry(nearWall).outOfBounds.length, 1);
nearWall.pegs[0].type = 'blue'; assert.equal(evaluateCompositionGeometry(nearWall).outOfBounds.length, 0);

const staticFailures = [];
for (const seed of [...SUPPORT_STUDY_SEEDS, ...Array.from({ length: 40 }, (_, i) => `support-qa-${i}`)]) {
  const base = generateRadialLevel(seed, radial), original = clone(base.level);
  const blue = generateSupportedRadialLevel(seed, radial, supports, 'blue-supports');
  const bounce = generateSupportedRadialLevel(seed, radial, supports, 'side-bumpers');
  assert.deepEqual(blue, generateSupportedRadialLevel(seed, radial, supports, 'blue-supports'));
  assert.deepEqual(blue.level.pegs.slice(0, base.level.pegs.length), base.level.pegs);
  assert.deepEqual(bounce.level.pegs.slice(0, base.level.pegs.length), base.level.pegs);
  assert.deepEqual(blue.level.pegs.map(p => [p.memberId, p.x, p.y]), bounce.level.pegs.map(p => [p.memberId, p.x, p.y]));
  assert.equal(bounce.level.pegs.filter(p => p.type === 'bumper').length, 2);
  const roster = makeStandardPlayPreview(base.level, seed).metadata.playPreview.targetMemberIds;
  for (const item of [blue, bounce]) {
    if (item.staticChecks.status !== 'passed') staticFailures.push({ seed, variant: item.revision, failures: item.staticChecks.failures });
    const preview = makeStandardPlayPreview(item.level, seed, roster);
    assert.deepEqual(preview.pegs.filter(p => p.type === 'orange').map(p => p.memberId).sort(), [...roster].sort());
    assert.deepEqual(preview.pegs.filter(p => p.type === 'bumper'), item.level.pegs.filter(p => p.type === 'bumper'));
    assert.equal(diff(capture(item.level), capture(normalizeLevelData(clone(item.level)))).operations.length, 0);
  }
  assert.deepEqual(base.level, original);
}
assert.deepEqual(staticFailures, [], 'All fixed QA seeds should pass; never silently drop failed candidates');
const invalid = { ...supports, bottomGapPx: 70 };
const invalidRadial = clone(radial); invalidRadial.ranges.centerY = [400, 410];
assert.ok(prepareSupportStudy(invalidRadial, invalid).pairs.some(p => p.sides.some(s => s.staticChecks.status === 'failed')));

const session = startRepairSession(buildRadialDefinition(radial));
session.candidates[0].disposition = 'unfixable'; session.candidates[0].dispositionReason = 'SYNTHETIC refused calibration';
session.candidates.slice(1).forEach(c => { c.disposition = 'done'; });
session.autosave = { status: 'failed', error: 'SYNTHETIC quota' };
const delivered = prepareRepairSessionExport(session);
assert.equal(delivered.result.status, 'blocked'); assert.equal(session.finishedAt, null);
assert.equal(JSON.parse(delivered.text).candidates.length, 3);
assert.equal(resumeRepairArchive(JSON.parse(delivered.text)).candidates[0].disposition, 'unfixable');
const crashed = prepareRepairSessionExport(session, '2026-01-01', () => { throw new Error('SYNTHETIC analyzer failure'); });
assert.equal(crashed.result.status, 'draft');
assert.deepEqual(JSON.parse(crashed.text).candidates[1].currentLevel, session.candidates[1].currentLevel);

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const manager = new LevelManager(); manager.levels = [clone(level)]; manager.currentLevelIndex = 0;
const editor = Object.create(Editor.prototype);
Object.assign(editor, { levelManager: manager, selectedPegIds: new Set(['b']), undoStack: [], redoStack: [], maxUndoSteps: 50,
  researchEditorCommands: [], _researchCommandBefore: null, _researchCommandHints: [], _researchHistorySequence: 0,
  notifySelectionChange() {}, notifyPegCountChange() {} });
const candidate = { baselineLevel: clone(level), currentLevel: clone(level), transactionLog: [] };
editor.beginResearchCommand('edit-bumper-properties'); editor.saveUndoState();
for (const value of [1.1, 1.2, 1.5, 2.4]) {
  editor.setSelectedBumperBounce(value);
  recordRepairTransaction(candidate, manager.getCurrentLevel(), undefined, { commandInProgress: true });
}
assert.equal(candidate.transactionLog.length, 0); assert.equal(candidate.currentLevel.pegs[0].bumperBounce, 2.4);
const interrupted = clone(candidate);
recordRepairTransaction(interrupted, interrupted.currentLevel);
assert.equal(interrupted.transactionLog.length, 1, 'reload must recover one net uncommitted edit');
editor.finishResearchCommand('edit-bumper-properties');
recordRepairTransaction(candidate, manager.getCurrentLevel());
assert.equal(candidate.transactionLog.length, 1); assert.equal(candidate.transactionLog[0].source, 'editor-command');
editor.undo(); recordRepairTransaction(candidate, manager.getCurrentLevel());
assert.equal(candidate.transactionLog.length, 1); assert.equal(candidate.transactionLog[0].retracted, true);
assert.equal(candidate.currentLevel.pegs[0].bumperBounce, 3.2);
editor.redo(); recordRepairTransaction(candidate, manager.getCurrentLevel());
assert.equal(candidate.transactionLog.length, 1); assert.equal(candidate.transactionLog[0].retracted, false);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'peggle-support-regression-'));
await buildSupportStudy(null, path.join(temporary, 'study'));
const manifest = JSON.parse(await fs.readFile(path.join(temporary, 'study/comparison-manifest.json'), 'utf8'));
assert.equal(manifest.pairs.length, 6); assert.equal(new Set(manifest.pairs.map(p => p.seed)).size, 3);
// Optional real-author regression is read-only; production tests use synthetic data.
if (process.argv[2]) {
  const raw = await fs.readFile(process.argv[2]);
  const archive = JSON.parse(raw);
  const study = prepareSupportStudy(archive.source.rules, supports, archive);
  assert.equal(study.observations[0].gates.control, 'failed');
  execFileSync(process.execPath, ['research/tools/digest-repair-session.mjs', process.argv[2], path.join(temporary, 'digest'), '--no-png'], { stdio: 'pipe' });
  const digestText = await fs.readFile(path.join(temporary, 'digest/digest.json'), 'utf8');
  const md = await fs.readFile(path.join(temporary, 'digest/digest.md'), 'utf8');
  assert.ok(Buffer.byteLength(md) + Buffer.byteLength(digestText) <= 100000);
  assert.match(digestText, /bumperBounce/); assert.match(md, /bumperScale/);
  assert.doesNotMatch(md, /"0":\{\}/);
  assert.deepEqual(await fs.readFile(process.argv[2]), raw, 'Canonical author archive must remain byte-identical');
}
console.log(JSON.stringify({ ok: 'Bumper semantics, frozen targets, constructive supports (43 seeds), export failure paths, real Editor undo and pending autosave', temporary }));
