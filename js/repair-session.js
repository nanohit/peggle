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

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function commandEvidence(level) {
  return (level?.metadata?.generatorProgram?.commandLog || []).map(command => ({
    sequence: command.sequence,
    hints: (command?.patch?.hints || command?.hints || []).map(String),
    operations: command?.patch?.operations || []
  }));
}

function transactionEvidence(candidate) {
  if (!Array.isArray(candidate?.transactionLog) || candidate.transactionLog.length === 0) {
    return commandEvidence(candidate?.currentLevel);
  }
  return candidate.transactionLog.map(transaction => ({
    sequence: transaction.sequence,
    hints: (transaction?.patch?.hints || transaction?.hints || []).map(String),
    operations: transaction?.patch?.operations || []
  }));
}

export function recordRepairTransaction(candidate, nextLevel, now = new Date().toISOString()) {
  if (!candidate || !nextLevel) return null;
  if (!Array.isArray(candidate.transactionLog)) candidate.transactionLog = [];
  const previousLevel = candidate.currentLevel || candidate.baselineLevel;
  const previousCommands = previousLevel?.metadata?.generatorProgram?.commandLog || [];
  const nextCommands = nextLevel?.metadata?.generatorProgram?.commandLog || [];
  const previousEditorSequences = new Set(previousCommands.map(command => command.sequence));
  const alreadyRecorded = new Set(candidate.transactionLog
    .map(transaction => transaction.editorSequence)
    .filter(Number.isInteger));
  const newEditorCommands = nextCommands.filter(command => (
    !previousEditorSequences.has(command.sequence) && !alreadyRecorded.has(command.sequence)
  ));
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
  if (newEditorCommands.length === 0) {
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
  const failures = [];
  if (missingObjectIds.length) failures.push('missing-object-id');
  if (missingMemberIds.length) failures.push('missing-member-id');
  if (duplicateMemberIds.length) failures.push('duplicate-member-id');
  if (missingNodes.length) failures.push('missing-object-node');
  if (wrongMembership.length) failures.push('object-membership-mismatch');
  if (phantomMemberIds.length) failures.push('phantom-node-member');
  return {
    status: failures.length ? 'failed' : 'passed', failures,
    pegCount: pegs.length, nodeCount: Object.keys(nodes).length,
    missingObjectIds, missingMemberIds, duplicateMemberIds,
    missingNodes: [...new Set(missingNodes)], wrongMembership, phantomMemberIds
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

function pegExtent(peg, pegRadius) {
  if (peg.shape !== 'brick') return { x: pegRadius, y: pegRadius };
  const width = Number(peg.width || pegRadius * 4);
  const height = Number(peg.height || pegRadius * 1.2);
  const angle = Number(peg.angle || 0);
  return {
    x: Math.abs(Math.cos(angle)) * width / 2 + Math.abs(Math.sin(angle)) * height / 2,
    y: Math.abs(Math.sin(angle)) * width / 2 + Math.abs(Math.cos(angle)) * height / 2
  };
}

export function evaluateRepairStaticChecks(level, options = {}) {
  const width = Number(options.width || 400);
  const height = Number(options.height || level?.survival?.worldHeight || 600);
  const pegRadius = Number(level?.pegRadius || 8.5);
  const launcher = options.launcher || { x: width / 2, y: 40 };
  const minimumLauncherClearance = Number(options.minimumLauncherClearance || 42);
  const outOfBounds = [];
  let launcherClearance = Infinity;
  for (const peg of level?.pegs || []) {
    const extent = pegExtent(peg, pegRadius);
    if (peg.x - extent.x < 0 || peg.x + extent.x > width
        || peg.y - extent.y < 0 || peg.y + extent.y > height) outOfBounds.push(peg.memberId || peg.id);
    launcherClearance = Math.min(launcherClearance,
      Math.hypot(peg.x - launcher.x, peg.y - launcher.y) - Math.hypot(extent.x, extent.y));
  }
  const failures = [];
  if (outOfBounds.length) failures.push('out-of-bounds');
  if (launcherClearance < minimumLauncherClearance) failures.push('launcher-clearance');
  if (!(level?.pegs?.length > 0)) failures.push('empty-level');
  return {
    status: failures.length ? 'failed' : 'passed', failures,
    pegCount: level?.pegs?.length || 0, outOfBounds,
    launcherClearance, minimumLauncherClearance, width, height
  };
}

function evaluateControlRepair(candidate) {
  if (candidate?.role !== 'control') return { status: 'not-applicable' };
  if (!candidate.controlTargetLevel) return { status: 'failed', failures: ['missing-control-target'] };
  const targetMembers = new Map();
  for (const node of Object.values(captureBezierSemanticState(candidate.controlTargetLevel).nodes)) {
    for (const member of node.members || []) targetMembers.set(member.memberId, member);
  }
  const currentMembers = new Map();
  for (const node of Object.values(captureBezierSemanticState(candidate.currentLevel).nodes)) {
    for (const member of node.members || []) currentMembers.set(member.memberId, member);
  }
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
  const thresholdPx = Number(candidate.knownDefect?.acceptanceThresholdPx || 2);
  const passed = complete && rmsResidualPx <= thresholdPx;
  return {
    status: passed ? 'passed' : 'failed',
    failures: passed ? [] : [complete ? 'known-defect-not-corrected' : 'control-membership-changed'],
    matchedMemberCount: residuals.length,
    expectedMemberCount: targetMembers.size,
    rmsResidualPx,
    thresholdPx
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
  const control = evaluateControlRepair(candidate);
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
  if (!Array.isArray(definition?.candidates) || definition.candidates.length !== 6) failures.push('expected-six-candidates');
  const ids = new Set();
  for (const [index, candidate] of (definition?.candidates || []).entries()) {
    if (!candidate?.id || ids.has(candidate.id)) failures.push(`invalid-candidate-id:${index}`);
    ids.add(candidate?.id);
    if (!candidate?.baselineLevel?.pegs) failures.push(`missing-baseline:${index}`);
    if (index === 0 && candidate?.role !== 'control') failures.push('first-candidate-must-be-control');
    if (index === 0 && !candidate?.knownDefect) failures.push('control-missing-known-defect');
    if (index === 0 && !candidate?.controlTargetLevel) failures.push('control-missing-target');
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
  const raw = storage?.getItem?.(REPAIR_SESSION_STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return parsed?.format === REPAIR_SESSION_FORMAT && parsed?.version === REPAIR_SESSION_VERSION ? parsed : null;
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
    candidateResults.push({
      id: candidate.id, order: candidate.order, role: candidate.role,
      source: clone(candidate.source || {}), knownDefect: clone(candidate.knownDefect || null),
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
