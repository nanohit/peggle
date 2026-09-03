import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeLevelData } from '../../js/levels.js';
import {
  analyzeRepairCandidate,
  finishRepairSession,
  loadSavedRepairSession,
  recordRepairTransaction,
  saveRepairSession,
  startRepairSession,
  validateRepairSessionDefinition
} from '../../js/repair-session.js';

function level(id) {
  return normalizeLevelData({
    id, name: id, groups: [], bezierCurves: {}, metadata: {},
    pegs: [
      { id: `${id}:a`, x: 120, y: 180, type: 'blue', shape: 'circle', angle: 0 },
      { id: `${id}:b`, x: 200, y: 260, type: 'blue', shape: 'circle', angle: 0 },
      { id: `${id}:c`, x: 280, y: 340, type: 'orange', shape: 'circle', angle: 0 }
    ]
  });
}

const baselines = Array.from({ length: 6 }, (_value, index) => level(`level-${index}`));
const definition = {
  format: 'repair-session', version: 1, sessionId: 'test-session', seed: 'fixed',
  protocol: { metricsVisibleDuringRepair: false },
  candidates: Array.from({ length: 6 }, (_value, index) => ({
    id: `candidate-${index}`,
    role: index === 0 ? 'control' : 'study',
    ...(index === 0 ? {
      knownDefect: { id: 'test-offset' },
      controlTargetLevel: JSON.parse(JSON.stringify(baselines[0]))
    } : {}),
    baselineLevel: baselines[index]
  }))
};

assert.equal(validateRepairSessionDefinition(definition).status, 'passed');
const session = startRepairSession(definition, '2026-01-01T00:00:00.000Z');
assert.equal(session.candidates.length, 6);
assert.notEqual(session.candidates[0].baselineLevel, session.candidates[0].currentLevel);
assert.equal(analyzeRepairCandidate(session.candidates[0]).replay.exact, true);

const memory = new Map();
const storage = {
  setItem: (key, value) => memory.set(key, value),
  getItem: key => memory.get(key) || null
};
saveRepairSession(session, storage);
assert.equal(loadSavedRepairSession(storage).sessionId, session.sessionId);

// A save outside Editor.beginResearchCommand still becomes one ordered,
// state-derived transaction instead of disappearing from the chronology.
const propertyEdit = JSON.parse(JSON.stringify(session.candidates[1].currentLevel));
propertyEdit.pegs[0].color = '#445566';
recordRepairTransaction(session.candidates[1], propertyEdit, '2026-01-01T00:10:00.000Z');
assert.equal(session.candidates[1].transactionLog.length, 1);
assert.equal(session.candidates[1].transactionLog[0].source, 'state-derived-transaction');
assert.equal(session.candidates[1].transactionLog[0].patch.operations.length, 1);

const blocked = finishRepairSession(session, '2026-01-01T01:00:00.000Z');
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.blockingFailures.length, 6);
for (const candidate of session.candidates) candidate.disposition = 'done';
const complete = finishRepairSession(session, '2026-01-01T02:00:00.000Z');
assert.equal(complete.status, 'complete');
assert.equal(complete.candidates.length, 6);
assert.equal(complete.candidates.every(candidate => candidate.replay.exact), true);
assert.equal(complete.candidates.every(candidate => candidate.finalSemanticDiff.metrics.stateProgramCoverage === 0), true);

// D regression: the offline reader must recompute from embedded level JSON and
// render both views without relying on screenshots or editor state.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'peggle-repair-session-'));
const resultPath = path.join(temporary, 'result.json');
const analysisPath = path.join(temporary, 'analysis');
await fs.writeFile(resultPath, JSON.stringify(complete));
execFileSync(process.execPath, ['research/tools/analyze-repair-session.mjs', resultPath, analysisPath], {
  cwd: path.resolve('.'), stdio: 'pipe'
});
const independent = JSON.parse(await fs.readFile(path.join(analysisPath, 'analysis.json'), 'utf8'));
assert.equal(independent.candidates.length, 6);
assert.equal(independent.candidates.every(candidate => candidate.replay.exact), true);
assert.equal(independent.candidates.every(candidate => candidate.storedResultAgrees), true);
assert.match(await fs.readFile(path.join(analysisPath, 'report.html'), 'utf8'), /independently recomputed/);
await fs.access(path.join(analysisPath, independent.candidates[0].beforePreview));
await fs.access(path.join(analysisPath, independent.candidates[0].afterPreview));

console.log('ok repair session lifecycle, gates and result');
