import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeLevelData } from '../../js/levels.js';
import {
  analyzeRepairCandidate,
  auditSemanticLineage,
  evaluateRepairStaticChecks,
  finishRepairSession,
  loadSavedRepairSession,
  loadSavedRepairSessionDurable,
  recordRepairTransaction,
  saveRepairSession,
  saveRepairSessionDurable,
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

const controlTarget = level('level-0');
const controlBaseline = JSON.parse(JSON.stringify(controlTarget));
controlBaseline.pegs[0].x += 10;
const baselines = [
  controlBaseline,
  ...Array.from({ length: 5 }, (_value, index) => level(`level-${index + 1}`))
];
const definition = {
  format: 'repair-session', version: 1, sessionId: 'test-session', seed: 'fixed',
  protocol: { metricsVisibleDuringRepair: false },
  candidates: Array.from({ length: 6 }, (_value, index) => ({
    id: `candidate-${index}`,
    role: index === 0 ? 'control' : 'study',
    source: index === 2 ? { knownProperties: [{ id: 'large-empty-opening', measured: { topOpeningPx: 230 } }] } : {},
    ...(index === 0 ? {
      knownDefect: { id: 'test-offset' },
      controlTargetLevel: JSON.parse(JSON.stringify(controlTarget))
    } : {}),
    baselineLevel: baselines[index]
  }))
};

assert.equal(validateRepairSessionDefinition(definition).status, 'passed');
const session = startRepairSession(definition, '2026-01-01T00:00:00.000Z');
assert.equal(session.candidates.length, 6);
assert.notEqual(session.candidates[0].baselineLevel, session.candidates[0].currentLevel);
assert.equal(analyzeRepairCandidate(session.candidates[0]).replay.exact, true);
assert.equal(analyzeRepairCandidate(session.candidates[0]).gates.control.status, 'failed');
const contaminatedControl = JSON.parse(JSON.stringify(session.candidates[0]));
contaminatedControl.currentLevel = JSON.parse(JSON.stringify(controlTarget));
contaminatedControl.currentLevel.pegs[1].x += 0.25;
const contaminatedGate = analyzeRepairCandidate(contaminatedControl).gates.control;
assert.equal(contaminatedGate.status, 'failed');
assert.ok(contaminatedGate.failures.includes('unaffected-control-state-changed'));

const memory = new Map();
const storage = {
  setItem: (key, value) => memory.set(key, value),
  getItem: key => memory.get(key) || null
};
saveRepairSession(session, storage);
assert.equal(loadSavedRepairSession(storage).sessionId, session.sessionId);

// The browser path must not put the multi-megabyte study payload in
// localStorage. A small fake IndexedDB exercises the durable structured-clone
// path under an intentionally tiny localStorage quota.
function fakeIndexedDB() {
  const data = new Map();
  let initialized = false;
  const database = {
    objectStoreNames: { contains: () => initialized },
    createObjectStore: () => { initialized = true; },
    close: () => {},
    transaction: () => {
      const transaction = { error: null };
      transaction.objectStore = () => ({
        put: (value, key) => {
          data.set(key, JSON.parse(JSON.stringify(value)));
          queueMicrotask(() => transaction.oncomplete?.());
        },
        get: key => {
          const request = {};
          queueMicrotask(() => {
            request.result = data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : undefined;
            request.onsuccess?.();
          });
          return request;
        },
        delete: key => {
          data.delete(key);
          queueMicrotask(() => transaction.oncomplete?.());
        }
      });
      return transaction;
    }
  };
  return {
    open: () => {
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        if (!initialized) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

const quotaStorage = {
  setItem: (_key, value) => {
    if (value.length > 1024) throw new Error('QuotaExceededError');
  },
  getItem: () => null,
  removeItem: () => {}
};
const durableSession = JSON.parse(JSON.stringify(session));
durableSession.candidates[0].note = 'x'.repeat(2_000_000);
const indexedDB = fakeIndexedDB();
await saveRepairSessionDurable(durableSession, { indexedDB, fallbackStorage: quotaStorage });
assert.equal(durableSession.autosave.status, 'saved');
const durableReload = await loadSavedRepairSessionDurable({ indexedDB, fallbackStorage: quotaStorage });
assert.equal(durableReload.candidates[0].note.length, 2_000_000);

const overlapLevel = level('overlap');
overlapLevel.pegs[0].x = 120;
overlapLevel.pegs[0].y = 180;
overlapLevel.pegs[1].x = 125;
overlapLevel.pegs[1].y = 180;
const overlapCheck = evaluateRepairStaticChecks(overlapLevel);
assert.equal(overlapCheck.status, 'failed');
assert.equal(overlapCheck.crossObjectOverlapCount, 1);
assert.ok(overlapCheck.failures.includes('cross-object-overlap'));
const sharedObject = JSON.parse(JSON.stringify(overlapLevel));
sharedObject.pegs[1].objectId = sharedObject.pegs[0].objectId;
assert.equal(evaluateRepairStaticChecks(sharedObject).crossObjectOverlapCount, 0);

const malformedLineage = level('malformed-group-lineage');
malformedLineage.groups.push({ id: 'runtime-group-without-object-id', name: 'broken' });
malformedLineage.pegs[0].groupId = 'missing-runtime-group';
const malformedAudit = auditSemanticLineage(malformedLineage);
assert.ok(malformedAudit.failures.includes('missing-group-object-id'));
assert.ok(malformedAudit.failures.includes('orphan-group-reference'));

// A save outside Editor.beginResearchCommand still becomes one ordered,
// state-derived transaction instead of disappearing from the chronology.
const propertyEdit = JSON.parse(JSON.stringify(session.candidates[1].currentLevel));
propertyEdit.pegs[0].color = '#445566';
recordRepairTransaction(session.candidates[1], propertyEdit, '2026-01-01T00:10:00.000Z');
assert.equal(session.candidates[1].transactionLog.length, 1);
assert.equal(session.candidates[1].transactionLog[0].source, 'state-derived-transaction');
assert.equal(session.candidates[1].transactionLog[0].patch.operations.length, 1);

// Undo/redo changes command activity in place. It must not append an inverse
// state-derived transaction that analysis could mistake for author intent.
const journalBaseline = level('journal-activity');
const journalCandidate = {
  role: 'study', baselineLevel: journalBaseline,
  currentLevel: JSON.parse(JSON.stringify(journalBaseline)), transactionLog: []
};
const journalEdited = JSON.parse(JSON.stringify(journalBaseline));
journalEdited.pegs[0].x += 12;
const editorCommand = {
  sequence: 0, at: '2026-01-01T00:20:00.000Z', hints: ['move-selection'],
  patch: { format: 'semantic-object-patch', version: 4, operations: [], metrics: {} }
};
journalEdited.metadata.generatorProgram.commandLog = [editorCommand];
recordRepairTransaction(journalCandidate, journalEdited, '2026-01-01T00:20:00.000Z');
assert.equal(journalCandidate.transactionLog.length, 1);
const journalUndone = JSON.parse(JSON.stringify(journalBaseline));
journalUndone.metadata.generatorProgram.commandLog = [{
  ...editorCommand, retracted: true, retractedAt: '2026-01-01T00:21:00.000Z',
  activity: [{ action: 'undo', at: '2026-01-01T00:21:00.000Z', retracted: true }]
}];
recordRepairTransaction(journalCandidate, journalUndone, '2026-01-01T00:21:00.000Z');
assert.equal(journalCandidate.transactionLog.length, 1);
assert.equal(journalCandidate.transactionLog[0].retracted, true);
assert.equal(analyzeRepairCandidate(journalCandidate).patch.operations.length, 0);
const journalRedone = JSON.parse(JSON.stringify(journalEdited));
journalRedone.metadata.generatorProgram.commandLog = [{
  ...editorCommand, retracted: false, reactivatedAt: '2026-01-01T00:22:00.000Z',
  activity: [
    { action: 'undo', at: '2026-01-01T00:21:00.000Z', retracted: true },
    { action: 'redo', at: '2026-01-01T00:22:00.000Z', retracted: false }
  ]
}];
recordRepairTransaction(journalCandidate, journalRedone, '2026-01-01T00:22:00.000Z');
assert.equal(journalCandidate.transactionLog.length, 1);
assert.equal(journalCandidate.transactionLog[0].retracted, false);

const derivedBaseline = level('derived-history-activity');
const derivedCandidate = {
  role: 'study', baselineLevel: derivedBaseline,
  currentLevel: JSON.parse(JSON.stringify(derivedBaseline)), transactionLog: []
};
const derivedEdited = JSON.parse(JSON.stringify(derivedBaseline));
derivedEdited.pegs.push({
  id: 'derived-added', objectId: 'derived-added-object', memberId: 'derived-added-member',
  x: 160, y: 210, type: 'blue', shape: 'circle', angle: 0, groupId: null
});
recordRepairTransaction(derivedCandidate, derivedEdited, '2026-01-01T00:30:00.000Z');
assert.equal(derivedCandidate.transactionLog[0].source, 'state-derived-transaction');
const derivedUndone = JSON.parse(JSON.stringify(derivedBaseline));
derivedUndone.metadata.generatorProgram.historyEvent = {
  id: 'undo:1:test', sequence: 1, action: 'undo', at: '2026-01-01T00:31:00.000Z'
};
recordRepairTransaction(derivedCandidate, derivedUndone, '2026-01-01T00:31:00.000Z');
assert.equal(derivedCandidate.transactionLog.length, 1);
assert.equal(derivedCandidate.transactionLog[0].retracted, true);
assert.equal(analyzeRepairCandidate(derivedCandidate).patch.operations.length, 0);
const derivedRedone = JSON.parse(JSON.stringify(derivedEdited));
derivedRedone.metadata.generatorProgram.historyEvent = {
  id: 'redo:2:test', sequence: 2, action: 'redo', at: '2026-01-01T00:32:00.000Z'
};
recordRepairTransaction(derivedCandidate, derivedRedone, '2026-01-01T00:32:00.000Z');
assert.equal(derivedCandidate.transactionLog.length, 1);
assert.equal(derivedCandidate.transactionLog[0].retracted, false);
assert.equal(derivedCandidate.transactionLog[0].historySequence, 2);

const blocked = finishRepairSession(session, '2026-01-01T01:00:00.000Z');
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.blockingFailures.length, 6);
recordRepairTransaction(
  session.candidates[0],
  JSON.parse(JSON.stringify(controlTarget)),
  '2026-01-01T01:30:00.000Z'
);
const correctedControl = analyzeRepairCandidate(session.candidates[0]).gates.control;
assert.equal(correctedControl.status, 'passed');
assert.equal(correctedControl.actualOperationCount, 1);
assert.equal(correctedControl.actualOperation.type, 'transform-object');
assert.equal(correctedControl.unaffectedStateExact, true);
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
assert.equal(independent.candidates[2].source.knownProperties[0].id, 'large-empty-opening');
assert.match(await fs.readFile(path.join(analysisPath, 'report.html'), 'utf8'), /independently recomputed/);
assert.match(await fs.readFile(path.join(analysisPath, 'report.html'), 'utf8'), /Known candidate properties/);
await fs.access(path.join(analysisPath, independent.candidates[0].beforePreview));
await fs.access(path.join(analysisPath, independent.candidates[0].afterPreview));

// The compact digest must also recompute rather than trust stored summaries,
// retain operation parameters and known interpretation risks, and expose a
// working raw drill-down path without duplicating full levels into the digest.
const digestPath = path.join(temporary, 'digest');
execFileSync(process.execPath, ['research/tools/digest-repair-session.mjs', resultPath, digestPath], {
  cwd: path.resolve('.'), stdio: 'pipe'
});
const digest = JSON.parse(await fs.readFile(path.join(digestPath, 'digest.json'), 'utf8'));
assert.equal(digest.version, 2);
assert.equal(digest.candidates.every(candidate => candidate.integrity.storedSummariesAgreeWithRecomputation.all), true);
assert.equal(digest.candidates[0].gates.control.status, 'passed');
assert.equal(digest.candidates[0].operations[0].transform.tx, -10);
assert.equal(digest.candidates[2].source.knownProperties[0].id, 'large-empty-opening');
assert.equal(Object.hasOwn(digest.candidates[0], 'baselineLevel'), false);
assert.match(await fs.readFile(path.join(digestPath, 'digest.md'), 'utf8'), /independently recomputed/);
await fs.access(path.join(digestPath, digest.candidates[0].previews.before));
await fs.access(path.join(digestPath, digest.candidates[0].previews.after));

const rawOperation = JSON.parse(execFileSync(process.execPath, [
  'research/tools/digest-repair-session.mjs', resultPath,
  '--candidate', 'candidate-0', '--operation', '0'
], { cwd: path.resolve('.'), encoding: 'utf8' }));
assert.equal(rawOperation.type, 'transform-object');

const tampered = JSON.parse(JSON.stringify(complete));
tampered.candidates[0].replay.exact = false;
tampered.candidates[0].finalSemanticDiff.metrics.operationCount = 999;
const tamperedPath = path.join(temporary, 'tampered-result.json');
const tamperedDigestPath = path.join(temporary, 'tampered-digest');
await fs.writeFile(tamperedPath, JSON.stringify(tampered));
execFileSync(process.execPath, ['research/tools/digest-repair-session.mjs', tamperedPath, tamperedDigestPath], {
  cwd: path.resolve('.'), stdio: 'pipe'
});
const tamperedDigest = JSON.parse(await fs.readFile(path.join(tamperedDigestPath, 'digest.json'), 'utf8'));
assert.equal(tamperedDigest.candidates[0].replay.exact, true);
assert.equal(tamperedDigest.candidates[0].metrics.operationCount, 1);
assert.equal(tamperedDigest.candidates[0].integrity.storedSummariesAgreeWithRecomputation.all, false);
assert.match(await fs.readFile(path.join(tamperedDigestPath, 'digest.md'), 'utf8'), /Integrity warning/);

console.log('ok repair session lifecycle, gates and result');
