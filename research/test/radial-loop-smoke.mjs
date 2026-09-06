import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateRadialLevel, RADIAL_SPLIT } from '../repair/lib/radial-generator.mjs';
import { makeStandardPlayPreview } from '../../js/repair-play-preview.js';
import { buildRadialDefinition, sourceHash } from '../tools/build-radial-loop.mjs';
import { prepareRadialComparison, writeRadialComparison } from '../tools/compare-radial-revision.mjs';
import { startRepairSession, finishRepairSession, exportRepairSessionDraft, resumeRepairArchive } from '../../js/repair-session.js';
import { captureBezierSemanticState as capture, diffBezierSemanticStates as diff, semanticReplayReport as replay, applyBezierSemanticPatch as apply } from '../../js/bezier-semantic.js';

const clone = x => JSON.parse(JSON.stringify(x));
const rules = JSON.parse(await fs.readFile('research/repair/radial-rules-v1.json', 'utf8'));
assert.equal(sourceHash('one\r\ntwo\r\n'), sourceHash('one\ntwo\n'), 'Git line endings are not a source-code revision');
assert.equal(new Set([...RADIAL_SPLIT.repair, ...RADIAL_SPLIT.holdout]).size, 8);
for (const seed of [...RADIAL_SPLIT.repair, ...RADIAL_SPLIT.holdout, ...Array.from({ length: 32 }, (_, i) => `qa-${i}`)]) {
  const g = generateRadialLevel(seed, rules);
  assert.deepEqual(g, generateRadialLevel(seed, clone(rules)));
  assert.equal(g.staticChecks.status, 'passed', `${seed}: ${g.staticChecks.failures}`);
  assert.ok(g.level.pegs.length >= 75 && g.level.pegs.length <= 130);
  assert.equal(new Set(g.level.pegs.map(p => p.memberId)).size, g.level.pegs.length);
  assert.ok(Object.values(g.level.metadata.generatorProgram.nodes).every(n => n.memberIds.length >= 3));
  assert.equal(g.level.survival.enabled, false); assert.equal(g.level.destruction.enabled, false);
  assert.equal(diff(capture(g.level), capture(g.level)).metrics.stateProgramCoverage, 1);
  const preview = makeStandardPlayPreview(g.level, seed);
  assert.equal(preview.pegs.filter(p => p.type === 'orange').length, 25);
  assert.equal(g.level.pegs.filter(p => p.type === 'orange').length, 0);
  assert.deepEqual(preview, makeStandardPlayPreview(g.level, seed));
}
const definition = buildRadialDefinition(rules), session = startRepairSession(definition);
const draft = exportRepairSessionDraft(session);
assert.equal(draft.status, 'draft'); assert.equal(session.finishedAt, null);
assert.deepEqual(resumeRepairArchive(draft).candidates.map(c => c.currentLevel), session.candidates.map(c => c.currentLevel));
// Synthetic transport fixture only. No author-quality evidence is fabricated.
session.protocol.synthetic = true;
session.candidates[0].currentLevel = clone(session.candidates[0].controlTargetLevel);
session.candidates.forEach(c => { c.disposition = 'done'; c.note = 'SYNTHETIC verification, not author feedback'; });
const result = finishRepairSession(session);
assert.equal(result.status, 'complete', JSON.stringify(result.blockingFailures));
const broken = clone(session); broken.candidates[1].currentLevel.metadata.generatorProgram.nodes[Object.keys(broken.candidates[1].currentLevel.metadata.generatorProgram.nodes)[0]].family = 'Ring';
// A failed gate still exports the canonical pegs.
assert.ok(exportRepairSessionDraft(broken).candidates[1].finalLevel?.pegs || exportRepairSessionDraft(broken).candidates[1].currentLevel?.pegs);

const revision = { ...clone(rules), revision: 'synthetic-v2', basedOn: RADIAL_SPLIT.repair,
  hypothesis: 'SYNTHETIC test of parameter transport; shift shared center 4 pixels, not a learned improvement.' };
revision.ranges.centerY = rules.ranges.centerY.map(x => x + 4);
const comparison = prepareRadialComparison(result, revision);
const tamperedBaseline = clone(result);
tamperedBaseline.candidates[1].baselineLevel.pegs[0].x += 4;
assert.throws(() => prepareRadialComparison(tamperedBaseline, revision), /do not reproduce the archived baseline/);
assert.equal(comparison.pairs.length, 6);
for (const pair of comparison.pairs) {
  const a = pair.sides[pair.labels.indexOf('original')], b = pair.sides[pair.labels.indexOf('revised')];
  assert.ok(Math.abs(b.parameters.centerY - a.parameters.centerY - 4) < 1e-9);
  assert.equal(a.parameters.innerRadius, b.parameters.innerRadius);
  assert.equal(a.level.pegs.length, b.level.pegs.length);
  assert.ok(Math.abs(b.level.pegs[0].y - a.level.pegs[0].y - 4) < 1e-8);
  const patch = diff(capture(a.level), capture(b.level));
  assert.equal(replay(capture(b.level), apply(capture(a.level), patch), patch).exact, true);
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'peggle-radial-test-'));
await writeRadialComparison(comparison, path.join(temporary, 'comparison'));
const resultPath = path.join(temporary, 'synthetic-result.json');
await fs.writeFile(resultPath, JSON.stringify(result));
execFileSync(process.execPath, ['research/tools/digest-repair-session.mjs', resultPath, path.join(temporary, 'digest'), '--no-png'], { stdio: 'pipe' });
const markdown = await fs.readFile(path.join(temporary, 'digest/digest.md'), 'utf8');
const json = await fs.readFile(path.join(temporary, 'digest/digest.json'), 'utf8');
assert.ok(Buffer.byteLength(markdown) + Buffer.byteLength(json) <= 100000);
assert.match(markdown, /centerY/); assert.match(markdown, /radial-v1/);
const invalidRevision = clone(revision); invalidRevision.ranges.centerY = [400, 410]; invalidRevision.ranges.verticalScale = [1.6, 1.7];
const invalidComparison = prepareRadialComparison(result, invalidRevision);
assert.equal(invalidComparison.pairs.length, 6, 'Do not filter failed seeds out of the evaluation denominator');
assert.ok(invalidComparison.pairs.some(p => p.sides[p.labels.indexOf('revised')].staticChecks.status === 'failed'));
console.log(JSON.stringify({ ok: 'radial reproducibility, 40-seed static screen, actual import, draft resume, heldout rule transfer, digest',
  syntheticModelBytes: Buffer.byteLength(markdown) + Buffer.byteLength(json), testArtifacts: temporary }));
