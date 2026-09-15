import { evaluateCompositionGeometry } from './composition-geometry.js';
import {
  applyBezierSemanticPatch,
  captureBezierSemanticState,
  diffBezierSemanticStates,
  semanticReplayReport
} from './bezier-semantic.js';

export const REPAIR_SESSION_FORMAT = 'repair-session';
export const REPAIR_SESSION_RESULT_FORMAT = 'repair-session-result';
export const REPAIR_SESSION_VERSION = 1;
export const REPAIR_SESSION_STORAGE_KEY = 'peggle_active_repair_session_v1';
export const REPAIR_SESSION_DATABASE_NAME = 'peggle_repair_study';
export const REPAIR_SESSION_DATABASE_STORE = 'sessions';
export const REPAIR_SESSION_DATABASE_KEY = 'active';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function activeResearchCommands(commands) {
  return (Array.isArray(commands) ? commands : []).filter(command => command?.retracted !== true);
}

function setTransactionActivity(transaction, retracted, evidence, now) {
  if (!transaction) return;
  transaction.retracted = retracted;
  if (Array.isArray(evidence?.activity)) transaction.activity = clone(evidence.activity);
  else {
    transaction.activity ||= [];
    transaction.activity.push({
      action: evidence?.action || (retracted ? 'undo' : 'redo'),
      at: evidence?.at || now,
      retracted
    });
  }
  if (retracted) transaction.retractedAt = evidence?.retractedAt || evidence?.at || now;
  else transaction.reactivatedAt = evidence?.reactivatedAt || evidence?.at || now;
  if (['undo', 'redo'].includes(evidence?.action) && Number.isInteger(evidence?.sequence)) {
    transaction.historySequence = evidence.sequence;
  }
}

function commandEvidence(level) {
  return activeResearchCommands(level?.metadata?.generatorProgram?.commandLog).map(command => ({
    sequence: command.sequence,
    hints: (command?.patch?.hints || command?.hints || []).map(String),
    operations: command?.patch?.operations || []
  }));
}

function transactionEvidence(candidate) {
  if (!Array.isArray(candidate?.transactionLog) || candidate.transactionLog.length === 0) {
    return commandEvidence(candidate?.currentLevel);
  }
  return activeResearchCommands(candidate.transactionLog).map(transaction => ({
    sequence: transaction.sequence,
    hints: (transaction?.patch?.hints || transaction?.hints || []).map(String),
    operations: transaction?.patch?.operations || []
  }));
}

export function recordRepairTransaction(candidate, nextLevel, now = new Date().toISOString(), options = {}) {
  if (!candidate || !nextLevel) return null;
  if (!Array.isArray(candidate.transactionLog)) candidate.transactionLog = [];
  // Autosave is a state observation, not an author action. Persist the live
  // drag, but keep one pre-command checkpoint until its explicit commit. The
  // pending checkpoint also survives a reload; then the net edit is recovered
  // as state-derived evidence, never lost or counted once per mousemove.
  if (options.commandInProgress) {
    candidate.pendingCommandBefore ||= clone(candidate.currentLevel || candidate.baselineLevel);
    candidate.currentLevel = clone(nextLevel);
    return [];
  }
  const previousLevel = candidate.pendingCommandBefore || candidate.currentLevel || candidate.baselineLevel;
  delete candidate.pendingCommandBefore;
  const previousCommands = previousLevel?.metadata?.generatorProgram?.commandLog || [];
  const nextCommands = nextLevel?.metadata?.generatorProgram?.commandLog || [];
  const previousHistoryEvent = previousLevel?.metadata?.generatorProgram?.historyEvent || null;
  const nextHistoryEvent = nextLevel?.metadata?.generatorProgram?.historyEvent || null;
  const historyTransition = nextHistoryEvent
    && ['undo', 'redo'].includes(nextHistoryEvent.action)
    && nextHistoryEvent.id !== previousHistoryEvent?.id
    ? nextHistoryEvent
    : null;
  const previousEditorSequences = new Set(previousCommands.map(command => command.sequence));
  const alreadyRecorded = new Set(candidate.transactionLog
    .map(transaction => transaction.editorSequence)
    .filter(Number.isInteger));
  const newEditorCommands = nextCommands.filter(command => (
    !previousEditorSequences.has(command.sequence) && !alreadyRecorded.has(command.sequence)
  ));
  const newEditorSequences = new Set(newEditorCommands.map(command => command.sequence));
  const previousBySequence = new Map(previousCommands.map(command => [command.sequence, command]));
  const nextBySequence = new Map(nextCommands.map(command => [command.sequence, command]));
  const recordedByEditorSequence = new Map(candidate.transactionLog
    .filter(transaction => Number.isInteger(transaction?.editorSequence))
    .map(transaction => [transaction.editorSequence, transaction]));
  const activityTransitions = [];
  const knownSequences = new Set([
    ...previousBySequence.keys(),
    ...nextBySequence.keys(),
    ...recordedByEditorSequence.keys()
  ]);
  for (const sequence of knownSequences) {
    if (newEditorSequences.has(sequence)) continue;
    const previous = previousBySequence.get(sequence);
    const next = nextBySequence.get(sequence);
    const wasActive = !!previous && previous.retracted !== true;
    const isActive = !!next && next.retracted !== true;
    if (wasActive === isActive) continue;
    activityTransitions.push({ sequence, retracted: !isActive, command: next || previous || null });
  }
  const appended = [];
  for (const command of newEditorCommands) {
    const transaction = {
      ...clone(command),
      sequence: candidate.transactionLog.length,
      editorSequence: command.sequence,
      source: 'editor-command'
    };
    candidate.transactionLog.push(transaction);
    appended.push(transaction);
  }
  for (const transition of activityTransitions) {
    const transaction = recordedByEditorSequence.get(transition.sequence);
    if (!transaction) continue;
    setTransactionActivity(transaction, transition.retracted, transition.command, now);
  }
  // Some editor actions are captured from state rather than an explicit
  // command. Their undo snapshots cannot name an editor sequence, so use the
  // history event to retract/reactivate the matching raw transaction instead
  // of appending the inverse state diff as a new intention.
  if (historyTransition && activityTransitions.length === 0) {
    let transaction = null;
    if (historyTransition.action === 'undo') {
      transaction = [...candidate.transactionLog].reverse().find(value => value.retracted !== true) || null;
    } else {
      transaction = candidate.transactionLog
        .filter(value => value.retracted === true)
        .sort((left, right) => (
          Number(right.historySequence || 0) - Number(left.historySequence || 0)
          || (Date.parse(right.retractedAt || '') || 0) - (Date.parse(left.retractedAt || '') || 0)
        ))[0] || null;
    }
    setTransactionActivity(transaction, historyTransition.action === 'undo', historyTransition, now);
  }
  if (newEditorCommands.length === 0 && activityTransitions.length === 0 && !historyTransition) {
    const before = captureBezierSemanticState(previousLevel);
    const after = captureBezierSemanticState(nextLevel);
    const patch = diffBezierSemanticStates(before, after);
    if (patch.operations.length > 0) {
      const transaction = {
        sequence: candidate.transactionLog.length,
        at: now,
        source: 'state-derived-transaction',
        hints: ['state-derived-transaction'],
        patch
      };
      candidate.transactionLog.push(transaction);
      appended.push(transaction);
    }
  }
  candidate.currentLevel = clone(nextLevel);
  return appended;
}

export function auditSemanticLineage(level) {
  const pegs = Array.isArray(level?.pegs) ? level.pegs : [];
  const groups = Array.isArray(level?.groups) ? level.groups : [];
  const nodes = level?.metadata?.generatorProgram?.nodes || {};
  const missingObjectIds = [], missingMemberIds = [], missingNodes = [], wrongMembership = [];
  const duplicateMemberIds = [];
  const seenMembers = new Set();
  for (const [index, peg] of pegs.entries()) {
    const label = peg?.id || `peg-index:${index}`;
    if (!peg?.objectId) missingObjectIds.push(label);
    if (!peg?.memberId) missingMemberIds.push(label);
    if (peg?.memberId && seenMembers.has(peg.memberId)) duplicateMemberIds.push(peg.memberId);
    if (peg?.memberId) seenMembers.add(peg.memberId);
    const node = peg?.objectId ? nodes[peg.objectId] : null;
    if (peg?.objectId && !node) missingNodes.push(peg.objectId);
    if (node && (!Array.isArray(node.memberIds) || !node.memberIds.includes(peg.memberId))) {
      wrongMembership.push({ objectId: peg.objectId, memberId: peg.memberId });
    }
  }
  const phantomMemberIds = [];
  for (const [objectId, node] of Object.entries(nodes)) {
    if (node?.objectId !== objectId) wrongMembership.push({ objectId, declaredObjectId: node?.objectId || null });
    for (const memberId of node?.memberIds || []) {
      if (!seenMembers.has(memberId)) phantomMemberIds.push({ objectId, memberId });
    }
  }
  const missingGroupObjectIds = [], duplicateGroupObjectIds = [], orphanGroupReferences = [];
  const groupMembershipMismatches = [];
  const seenGroupObjectIds = new Set();
  const groupsByRuntimeId = new Map(groups.map(group => [group?.id, group]));
  for (const [index, group] of groups.entries()) {
    const label = group?.id || `group-index:${index}`;
    if (!group?.objectId) missingGroupObjectIds.push(label);
    if (group?.objectId && seenGroupObjectIds.has(group.objectId)) duplicateGroupObjectIds.push(group.objectId);
    if (group?.objectId) seenGroupObjectIds.add(group.objectId);
  }
  for (const peg of pegs) {
    if (peg?.groupId == null) continue;
    if (!groupsByRuntimeId.has(peg.groupId)) {
      orphanGroupReferences.push({ memberId: peg.memberId || null, groupId: peg.groupId });
    }
  }
  const semanticGroupState = captureBezierSemanticState(level).groups || {};
  for (const group of groups) {
    if (!group?.objectId) continue;
    const expected = pegs.filter(peg => peg.groupId === group.id).map(peg => peg.memberId).filter(Boolean).sort();
    const actual = [...(semanticGroupState[group.objectId]?.memberIds || [])].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      groupMembershipMismatches.push({ objectId: group.objectId, expected, actual });
    }
  }
  const failures = [];
  if (missingObjectIds.length) failures.push('missing-object-id');
  if (missingMemberIds.length) failures.push('missing-member-id');
  if (duplicateMemberIds.length) failures.push('duplicate-member-id');
  if (missingNodes.length) failures.push('missing-object-node');
  if (wrongMembership.length) failures.push('object-membership-mismatch');
  if (phantomMemberIds.length) failures.push('phantom-node-member');
  if (missingGroupObjectIds.length) failures.push('missing-group-object-id');
  if (duplicateGroupObjectIds.length) failures.push('duplicate-group-object-id');
  if (orphanGroupReferences.length) failures.push('orphan-group-reference');
  if (groupMembershipMismatches.length) failures.push('group-membership-mismatch');
  return {
    status: failures.length ? 'failed' : 'passed', failures,
    pegCount: pegs.length, nodeCount: Object.keys(nodes).length, groupCount: groups.length,
    missingObjectIds, missingMemberIds, duplicateMemberIds,
    missingNodes: [...new Set(missingNodes)], wrongMembership, phantomMemberIds,
    missingGroupObjectIds, duplicateGroupObjectIds, orphanGroupReferences, groupMembershipMismatches
  };
}

export function auditCommandLog(level) {
  const commands = level?.metadata?.generatorProgram?.commandLog;
  const failures = [];
  if (!Array.isArray(commands)) failures.push('command-log-missing');
  let previousSequence = -1;
  for (const [index, command] of (commands || []).entries()) {
    if (!Number.isInteger(command?.sequence) || command.sequence <= previousSequence) {
      failures.push(`non-monotonic-sequence:${index}`);
    }
    previousSequence = Number(command?.sequence ?? previousSequence);
    if (!Array.isArray(command?.hints)) failures.push(`missing-hints:${index}`);
    if (!Array.isArray(command?.patch?.operations)) failures.push(`missing-operations:${index}`);
    if (!Number.isFinite(Date.parse(command?.at))) failures.push(`invalid-timestamp:${index}`);
  }
  return {
    status: failures.length ? 'failed' : 'passed',
    failures: [...new Set(failures)], commandCount: Array.isArray(commands) ? commands.length : 0
  };
}

export function evaluateRepairStaticChecks(level, options = {}) {
  return evaluateCompositionGeometry(level, options);
}

function meaningfulPatchOperations(patch) {
  return (patch?.operations || []).filter(operation => operation.expressibility !== 'ignored');
}

function semanticStateWithoutNode(state, objectId) {
  const result = clone(state);
  if (result?.nodes) delete result.nodes[objectId];
  return result;
}

function operationSummary(operation) {
  if (!operation) return null;
  return {
    type: operation.type,
    objectId: operation.objectId || operation.groupId || null,
    expressibility: operation.expressibility,
    transform: clone(operation.transform || null)
  };
}

function evaluateControlRepair(candidate, actualPatch) {
  if (candidate?.role !== 'control') return { status: 'not-applicable' };
  const baselineState = captureBezierSemanticState(candidate.baselineLevel);
  const expectedDefinition = candidate?.knownDefect?.expectedOperation || null;
  const targetState = candidate.controlTargetLevel
    ? captureBezierSemanticState(candidate.controlTargetLevel)
    : expectedDefinition
      ? applyBezierSemanticPatch(baselineState, {
        format: 'semantic-object-patch',
        version: 4,
        operations: [{ ...clone(expectedDefinition), expressibility: 'native' }]
      })
      : null;
  if (!targetState) return { status: 'failed', failures: ['missing-control-target'] };
  const currentState = captureBezierSemanticState(candidate.currentLevel);
  const expectedPatch = diffBezierSemanticStates(baselineState, targetState);
  const expectedOperations = meaningfulPatchOperations(expectedPatch);
  const actualOperations = meaningfulPatchOperations(actualPatch);
  const expectedOperation = expectedOperations[0] || null;
  const actualOperation = actualOperations[0] || null;
  const expectedObjectId = expectedOperation?.objectId || expectedOperation?.groupId || null;
  const validTransformTypes = new Set(['transform-stroke', 'mirror-stroke', 'transform-object', 'mirror-object']);

  const targetMembers = new Map((targetState.nodes?.[expectedObjectId]?.members || [])
    .map(member => [member.memberId, member]));
  const currentMembers = new Map((currentState.nodes?.[expectedObjectId]?.members || [])
    .map(member => [member.memberId, member]));
  const residuals = [];
  for (const [memberId, target] of targetMembers) {
    const current = currentMembers.get(memberId);
    if (!current) continue;
    residuals.push(Math.hypot(current.x - target.x, current.y - target.y));
  }
  const complete = residuals.length === targetMembers.size && currentMembers.size === targetMembers.size;
  const rmsResidualPx = residuals.length
    ? Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length)
    : Infinity;
  const maxResidualPx = residuals.length ? Math.max(...residuals) : Infinity;
  const thresholdPx = Number(candidate.knownDefect?.acceptanceThresholdPx || 2);
  const targetReplay = semanticReplayReport(targetState, currentState, actualPatch);
  const unaffectedReplay = expectedObjectId
    ? semanticReplayReport(
      semanticStateWithoutNode(baselineState, expectedObjectId),
      semanticStateWithoutNode(currentState, expectedObjectId),
      actualPatch
    )
    : { exact: false, replayAccuracy: 0 };
  const definitionValid = expectedOperations.length === 1
    && validTransformTypes.has(expectedOperation?.type)
    && expectedObjectId != null;
  const operationShapeValid = actualOperations.length === 1
    && actualOperation?.type === expectedOperation?.type
    && (actualOperation?.objectId || actualOperation?.groupId) === expectedObjectId
    && actualOperation?.expressibility === 'native';
  const failures = [];
  if (!definitionValid) failures.push('invalid-control-definition');
  if (actualOperations.length !== 1) failures.push('control-operation-count-mismatch');
  else if (!operationShapeValid) failures.push('control-operation-shape-mismatch');
  if (!complete) failures.push('control-membership-changed');
  else if (maxResidualPx > thresholdPx) failures.push('known-defect-not-corrected');
  if (!unaffectedReplay.exact) failures.push('unaffected-control-state-changed');
  const passed = failures.length === 0;
  return {
    status: passed ? 'passed' : 'failed',
    failures,
    expectedOperation: operationSummary(expectedOperation),
    actualOperation: operationSummary(actualOperation),
    expectedOperationCount: expectedOperations.length,
    actualOperationCount: actualOperations.length,
    matchedMemberCount: residuals.length,
    expectedMemberCount: targetMembers.size,
    rmsResidualPx,
    maxResidualPx,
    thresholdPx,
    targetExact: targetReplay.exact,
    targetReplayAccuracy: targetReplay.replayAccuracy,
    unaffectedStateExact: unaffectedReplay.exact
  };
}

export function analyzeRepairCandidate(candidate) {
  const before = captureBezierSemanticState(candidate.baselineLevel);
  const after = captureBezierSemanticState(candidate.currentLevel);
  const patch = diffBezierSemanticStates(before, after, {
    commandEvidence: transactionEvidence(candidate)
  });
  const replayed = applyBezierSemanticPatch(before, patch);
  const replay = semanticReplayReport(after, replayed, patch);
  const lineage = auditSemanticLineage(candidate.currentLevel);
  const commands = auditCommandLog(candidate.currentLevel);
  const transactions = auditTransactionLog(candidate.transactionLog || []);
  const staticChecks = evaluateRepairStaticChecks(candidate.currentLevel, candidate.staticCheckOptions);
  const control = evaluateControlRepair(candidate, patch);
  return {
    patch,
    replay,
    gates: {
      replay: { status: replay.exact ? 'passed' : 'failed', exact: replay.exact, replayAccuracy: replay.replayAccuracy },
      lineage,
      commandLog: commands,
      transactionLog: transactions,
      staticChecks,
      control
    }
  };
}

export function auditTransactionLog(transactions) {
  const failures = [];
  if (!Array.isArray(transactions)) failures.push('transaction-log-missing');
  for (const [index, transaction] of (transactions || []).entries()) {
    if (transaction?.sequence !== index) failures.push(`non-contiguous-sequence:${index}`);
    if (!Array.isArray(transaction?.patch?.operations)) failures.push(`missing-operations:${index}`);
    if (!Number.isFinite(Date.parse(transaction?.at))) failures.push(`invalid-timestamp:${index}`);
    if (!['editor-command', 'state-derived-transaction'].includes(transaction?.source)) {
      failures.push(`invalid-source:${index}`);
    }
  }
  return {
    status: failures.length ? 'failed' : 'passed',
    failures: [...new Set(failures)], transactionCount: Array.isArray(transactions) ? transactions.length : 0
  };
}

export function validateRepairSessionDefinition(definition) {
  const failures = [];
  if (definition?.format !== REPAIR_SESSION_FORMAT) failures.push('invalid-format');
  if (definition?.version !== REPAIR_SESSION_VERSION) failures.push('unsupported-version');
  if (!definition?.sessionId) failures.push('missing-session-id');
  const expectedCount = definition?.protocol?.candidateCount ?? 6;
  if (!Number.isInteger(expectedCount) || expectedCount < 2 || expectedCount > 30
    || !Array.isArray(definition?.candidates) || definition.candidates.length !== expectedCount) failures.push('candidate-count-mismatch');
  const ids = new Set();
  for (const [index, candidate] of (definition?.candidates || []).entries()) {
    if (!candidate?.id || ids.has(candidate.id)) failures.push(`invalid-candidate-id:${index}`);
    ids.add(candidate?.id);
    if (!candidate?.baselineLevel?.pegs) failures.push(`missing-baseline:${index}`);
    if (index === 0 && candidate?.role !== 'control') failures.push('first-candidate-must-be-control');
    if (index === 0 && !candidate?.knownDefect) failures.push('control-missing-known-defect');
    if (index === 0 && !candidate?.controlTargetLevel && !candidate?.knownDefect?.expectedOperation) failures.push('control-missing-target');
  }
  return { status: failures.length ? 'failed' : 'passed', failures };
}

export function startRepairSession(definition, now = new Date().toISOString()) {
  const validation = validateRepairSessionDefinition(definition);
  if (validation.status !== 'passed') throw new Error(`Invalid repair session: ${validation.failures.join(', ')}`);
  return {
    format: REPAIR_SESSION_FORMAT,
    version: REPAIR_SESSION_VERSION,
    sessionId: definition.sessionId,
    seed: definition.seed,
    protocol: clone(definition.protocol || {}),
    source: clone(definition.source || {}),
    startedAt: now,
    updatedAt: now,
    activeIndex: 0,
    comparisonView: 'current',
    finishedAt: null,
    candidates: definition.candidates.map((candidate, index) => ({
      ...clone(candidate), order: index,
      baselineLevel: clone(candidate.baselineLevel),
      currentLevel: clone(candidate.baselineLevel),
      disposition: 'pending',
      note: '', frictionNote: '', dispositionReason: '',
      transactionLog: [],
      completedAt: null
    }))
  };
}

export function serializeRepairSession(session) {
  return JSON.stringify(session);
}

export function saveRepairSession(session, storage = globalThis.localStorage) {
  session.updatedAt = new Date().toISOString();
  try {
    storage?.setItem?.(REPAIR_SESSION_STORAGE_KEY, serializeRepairSession(session));
    session.autosave = { status: 'saved', at: session.updatedAt, error: null };
  } catch (error) {
    session.autosave = { status: 'failed', at: session.updatedAt, error: error?.message || String(error) };
  }
  return session;
}

export function loadSavedRepairSession(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(REPAIR_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.format === REPAIR_SESSION_FORMAT && parsed?.version === REPAIR_SESSION_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

let durableSaveQueue = Promise.resolve();

function indexedDbFrom(options) {
  return Object.prototype.hasOwnProperty.call(options || {}, 'indexedDB')
    ? options.indexedDB
    : globalThis.indexedDB;
}

function fallbackStorageFrom(options) {
  return Object.prototype.hasOwnProperty.call(options || {}, 'fallbackStorage')
    ? options.fallbackStorage
    : globalThis.localStorage;
}

function openRepairSessionDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(REPAIR_SESSION_DATABASE_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REPAIR_SESSION_DATABASE_STORE)) {
        database.createObjectStore(REPAIR_SESSION_DATABASE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open repair-session database'));
    request.onblocked = () => reject(new Error('Repair-session database upgrade was blocked'));
  });
}

async function writeDurableSession(indexedDB, snapshot) {
  const database = await openRepairSessionDatabase(indexedDB);
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(REPAIR_SESSION_DATABASE_STORE, 'readwrite');
      transaction.objectStore(REPAIR_SESSION_DATABASE_STORE).put(snapshot, REPAIR_SESSION_DATABASE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Repair-session write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('Repair-session write aborted'));
    });
  } finally {
    database.close();
  }
}

async function readDurableSession(indexedDB) {
  const database = await openRepairSessionDatabase(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(REPAIR_SESSION_DATABASE_STORE, 'readonly');
      const request = transaction.objectStore(REPAIR_SESSION_DATABASE_STORE).get(REPAIR_SESSION_DATABASE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Repair-session read failed'));
    });
  } finally {
    database.close();
  }
}

export function saveRepairSessionDurable(session, options = {}) {
  const indexedDB = indexedDbFrom(options);
  const fallbackStorage = fallbackStorageFrom(options);
  if (!indexedDB?.open) return Promise.resolve(saveRepairSession(session, fallbackStorage));

  const at = new Date().toISOString();
  const revision = Number(session.autosaveRevision || 0) + 1;
  session.updatedAt = at;
  session.autosaveRevision = revision;
  session.autosave = { status: 'saving', at, error: null };
  const snapshot = clone(session);
  snapshot.autosave = { status: 'saved', at, error: null };
  durableSaveQueue = durableSaveQueue.catch(() => null).then(async () => {
    try {
      await writeDurableSession(indexedDB, snapshot);
      // Remove a legacy multi-megabyte localStorage copy after the durable write.
      try { fallbackStorage?.removeItem?.(REPAIR_SESSION_STORAGE_KEY); } catch { /* best effort migration */ }
      if (session.autosaveRevision === revision) session.autosave = { status: 'saved', at, error: null };
    } catch (error) {
      if (session.autosaveRevision === revision) {
        session.autosave = { status: 'failed', at, error: error?.message || String(error) };
      }
    }
    return session;
  });
  return durableSaveQueue;
}

export async function loadSavedRepairSessionDurable(options = {}) {
  const indexedDB = indexedDbFrom(options);
  const fallbackStorage = fallbackStorageFrom(options);
  if (!indexedDB?.open) return loadSavedRepairSession(fallbackStorage);
  try {
    const saved = await readDurableSession(indexedDB);
    if (saved?.format === REPAIR_SESSION_FORMAT && saved?.version === REPAIR_SESSION_VERSION) return saved;
  } catch {
    // A legacy localStorage session remains a valid recovery path when IDB is unavailable.
  }
  const legacy = loadSavedRepairSession(fallbackStorage);
  if (legacy) await saveRepairSessionDurable(legacy, { indexedDB, fallbackStorage });
  return legacy;
}

export async function clearSavedRepairSessionDurable(options = {}) {
  const indexedDB = indexedDbFrom(options);
  const fallbackStorage = fallbackStorageFrom(options);
  try { fallbackStorage?.removeItem?.(REPAIR_SESSION_STORAGE_KEY); } catch { /* best effort */ }
  if (!indexedDB?.open) return;
  const database = await openRepairSessionDatabase(indexedDB);
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(REPAIR_SESSION_DATABASE_STORE, 'readwrite');
      transaction.objectStore(REPAIR_SESSION_DATABASE_STORE).delete(REPAIR_SESSION_DATABASE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Repair-session delete failed'));
      transaction.onabort = () => reject(transaction.error || new Error('Repair-session delete aborted'));
    });
  } finally {
    database.close();
  }
}

export function finishRepairSession(session, now = new Date().toISOString()) {
  const candidateResults = [];
  const blockingFailures = [];
  for (const candidate of session.candidates || []) {
    const analysis = analyzeRepairCandidate(candidate);
    const resolved = ['done', 'deferred', 'unfixable'].includes(candidate.disposition);
    const reasonRequired = ['deferred', 'unfixable'].includes(candidate.disposition);
    const candidateFailures = [];
    if (!resolved) candidateFailures.push('unresolved-disposition');
    if (reasonRequired && !candidate.dispositionReason.trim()) candidateFailures.push('missing-disposition-reason');
    if (analysis.gates.replay.status !== 'passed') candidateFailures.push('replay-gate');
    if (analysis.gates.lineage.status !== 'passed') candidateFailures.push('lineage-gate');
    if (analysis.gates.commandLog.status !== 'passed') candidateFailures.push('command-log-gate');
    if (analysis.gates.transactionLog.status !== 'passed') candidateFailures.push('transaction-log-gate');
    if (analysis.gates.control.status === 'failed') candidateFailures.push('control-gate');
    if (candidate.disposition === 'done' && analysis.gates.staticChecks.status !== 'passed') {
      candidateFailures.push('static-check-gate');
    }
    if (candidateFailures.length) blockingFailures.push({ candidateId: candidate.id, failures: candidateFailures });
    const knownDefect = clone(candidate.knownDefect || null);
    if (candidate.role === 'control' && knownDefect && !knownDefect.expectedOperation
        && analysis.gates.control?.expectedOperation) {
      // Keep the exported archive independently auditable without duplicating
      // the complete control target level (roughly another full candidate).
      knownDefect.expectedOperation = clone(analysis.gates.control.expectedOperation);
    }
    candidateResults.push({
      id: candidate.id, order: candidate.order, role: candidate.role,
      source: clone(candidate.source || {}), knownDefect,
      staticCheckOptions: clone(candidate.staticCheckOptions || {}),
      disposition: candidate.disposition, dispositionReason: candidate.dispositionReason,
      note: candidate.note, frictionNote: candidate.frictionNote,
      baselineLevel: clone(candidate.baselineLevel), finalLevel: clone(candidate.currentLevel),
      operationSequence: clone(candidate.transactionLog || []),
      finalSemanticDiff: analysis.patch,
      replay: analysis.replay,
      gates: analysis.gates,
      fallbackReasonCounts: clone(analysis.patch.metrics?.fallbackReasonCounts || {}),
      languageGapReasonCounts: clone(analysis.patch.metrics?.languageGapReasonCounts || {})
    });
  }
  const result = {
    format: REPAIR_SESSION_RESULT_FORMAT,
    version: REPAIR_SESSION_VERSION,
    sessionId: session.sessionId,
    seed: session.seed,
    source: clone(session.source || {}),
    protocol: clone(session.protocol || {}),
    startedAt: session.startedAt,
    finishedAt: now,
    status: blockingFailures.length ? 'blocked' : 'complete',
    blockingFailures,
    candidates: candidateResults
  };
  if (!blockingFailures.length) session.finishedAt = now;
  return result;
}

// A diagnostic gate must never hold the author's work hostage. Ordinary
// drafts are readable by the digest; even a broken analyzer has a raw escape.
export function exportRepairSessionDraft(session, now = new Date().toISOString()) {
  try {
    const result = finishRepairSession(clone(session), now);
    return { ...result, status: 'draft', finishedAt: null, exportedAt: now };
  } catch (error) {
    return { ...clone(session), status: 'draft', exportedAt: now, exportError: String(error?.message || error) };
  }
}

// Delivery and scientific acceptance are independent. Analyze a copy so a
// successful analysis cannot close the live session before a download works.
export function prepareRepairSessionExport(session, now = new Date().toISOString(), analyze = finishRepairSession) {
  let result;
  try { result = analyze(clone(session), now); }
  catch (error) {
    result = { ...clone(session), status: 'draft', exportedAt: now,
      exportError: String(error?.message || error) };
  }
  return { result, text: JSON.stringify(result),
    filename: `${session.sessionId.replace(/[^a-z0-9_-]/gi, '_')}-${result.status === 'draft' ? 'draft' : 'result'}.json` };
}

export function resumeRepairArchive(archive) {
  if (archive?.format !== REPAIR_SESSION_RESULT_FORMAT || archive.version !== REPAIR_SESSION_VERSION
    || !archive.candidates?.every(c => c.baselineLevel?.pegs && c.finalLevel?.pegs)) throw new Error('Invalid repair archive');
  const candidates = archive.candidates.map(c => ({ id: c.id, role: c.role, order: c.order, source: clone(c.source),
    knownDefect: clone(c.knownDefect), staticCheckOptions: clone(c.staticCheckOptions), baselineLevel: clone(c.baselineLevel) }));
  const session = startRepairSession({ ...archive, format: REPAIR_SESSION_FORMAT, candidates }, archive.startedAt);
  for (const [i, candidate] of session.candidates.entries()) {
    const c = archive.candidates[i];
    Object.assign(candidate, { currentLevel: clone(c.finalLevel), transactionLog: clone(c.operationSequence || []),
      disposition: c.disposition || 'pending', note: c.note || '', frictionNote: c.frictionNote || '', dispositionReason: c.dispositionReason || '' });
  }
  return session;
}
