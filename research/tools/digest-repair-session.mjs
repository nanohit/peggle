#!/usr/bin/env node
// Derive a compact, independently recomputed reading package from the full
// repair-session archive. The archive remains the canonical replay source.
//
//   node research/tools/digest-repair-session.mjs <result.json> [outDir]
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --command <sequence>
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --operation <index>
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relation <objectId>
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --level before|after

import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { promisify } from 'node:util';

import {
  analyzeRepairCandidate,
  REPAIR_SESSION_RESULT_FORMAT,
  REPAIR_SESSION_VERSION
} from '../../js/repair-session.js';
import { captureBezierSemanticState } from '../../js/bezier-semantic.js';
import { describeRepairRelations, REPAIR_RELATION_METHOD } from '../repair/lib/relational-descriptors.mjs';
import { renderNativeLevelSvg, renderRepairComparisonSvg } from '../repair/lib/render-native-level.mjs';

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
const kb = value => `${(value / 1024).toFixed(1)} KB`;
const execFile = promisify(execFileCallback);
const MODEL_TEXT_BUDGET_BYTES = 100 * 1024;

function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function roundDeep(value, digits = 4) {
  if (typeof value === 'number') return round(value, digits);
  if (Array.isArray(value)) return value.map(entry => roundDeep(entry, digits));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundDeep(entry, digits)]));
  }
  return value;
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]
    || String(left[0]).localeCompare(String(right[0])));
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    const count = Number(value);
    if (Number.isFinite(count)) target[key] = (target[key] || 0) + count;
  }
}

function comparable(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? round(value, 9) : null;
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, comparable(entry)]));
  }
  return value;
}

function agrees(left, right) {
  return isDeepStrictEqual(comparable(left), comparable(right));
}

function safeName(value) {
  return String(value || 'candidate').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function findRasterBrowser(explicitPath) {
  if (explicitPath) {
    if (!await pathExists(explicitPath)) throw new Error(`Raster browser does not exist: ${explicitPath}`);
    return path.resolve(explicitPath);
  }
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'
  ];
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return null;
}

/**
 * Wait for a screenshot to land and finish being written.
 *
 * Edge and Chrome on Windows hand the work to a detached process and the
 * launcher exits immediately, so the command resolving says nothing about the
 * file existing. Poll until the size stops changing, which also covers a large
 * sheet still being flushed.
 */
async function waitForStableFile(filePath, timeoutMs = 20000, quietMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    let size = -1;
    try {
      size = (await fs.stat(filePath)).size;
    } catch { size = -1; }
    if (size > 0 && size === lastSize) {
      if (stableSince && Date.now() - stableSince >= quietMs) return size;
      if (!stableSince) stableSince = Date.now();
    } else {
      stableSince = 0;
    }
    lastSize = size;
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${path.basename(filePath)}.`
    + ' The browser may have failed to render the sheet; pass --no-png to build an SVG-only package.');
}

async function rasterizeSvg(svgPath, pngPath, browserPath, width, height) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'peggle-digest-browser-'));
  try {
    await fs.rm(pngPath, { force: true });
    await execFile(browserPath, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking',
      '--force-device-scale-factor=1', `--user-data-dir=${profile}`,
      `--screenshot=${pngPath}`, `--window-size=${width},${height}`,
      pathToFileURL(svgPath).href
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    await waitForStableFile(pngPath);
  } finally {
    const resolvedProfile = path.resolve(profile);
    const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (resolvedProfile.startsWith(resolvedTemp)
        && path.basename(resolvedProfile).startsWith('peggle-digest-browser-')) {
      await fs.rm(resolvedProfile, { recursive: true, force: true });
    }
  }
}

function summarizeBounds(members) {
  if (!Array.isArray(members) || members.length === 0) return null;
  const xs = members.map(member => Number(member.x)).filter(Number.isFinite);
  const ys = members.map(member => Number(member.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  return {
    minX: round(Math.min(...xs)), maxX: round(Math.max(...xs)),
    minY: round(Math.min(...ys)), maxY: round(Math.max(...ys))
  };
}

function summarizeFallbackChanges(changes) {
  const values = Array.isArray(changes) ? changes : [];
  const moved = [], added = [], deleted = [], indices = [];
  for (const change of values) {
    if (Number.isFinite(Number(change.index))) indices.push(Number(change.index));
    if (change.before && change.after) {
      const dx = Number(change.after.x) - Number(change.before.x);
      const dy = Number(change.after.y) - Number(change.before.y);
      moved.push({ dx, dy, distance: Math.hypot(dx, dy) });
    } else if (change.after) added.push(change);
    else if (change.before) deleted.push(change);
  }
  const mean = key => moved.length ? moved.reduce((sum, value) => sum + value[key], 0) / moved.length : null;
  return {
    changed: values.length,
    moved: moved.length,
    added: added.length,
    deleted: deleted.length,
    indices: indices.length <= 24 ? indices : [...indices.slice(0, 24), `+${indices.length - 24} more`],
    ...(moved.length ? {
      displacement: {
        meanDx: round(mean('dx')), meanDy: round(mean('dy')),
        meanDistance: round(mean('distance')),
        maxDistance: round(Math.max(...moved.map(value => value.distance)))
      }
    } : {})
  };
}

function compactChanges(changes) {
  return Object.fromEntries(Object.entries(changes || {}).map(([key, change]) => [key, {
    from: clone(change?.from), to: clone(change?.to)
  }]));
}

function compactCurvePoints(curve) {
  return Object.fromEntries(['start', 'h1', 'h2', 'end']
    .filter(key => curve?.[key])
    .map(key => [key, { x: round(curve[key].x), y: round(curve[key].y) }]));
}

function summarizeOperation(operation, index) {
  const objectId = operation.objectId || operation.groupId || null;
  const entry = {
    index,
    type: operation.type || 'unknown',
    objectId,
    expressibility: operation.expressibility || 'native',
    affectedMemberCount: Number(operation.affectedMemberCount || 0)
  };
  if (operation.reason) entry.reason = operation.reason;
  if (operation.languageGapCandidate) entry.languageGapCandidate = operation.languageGapCandidate;
  if (operation.transform) {
    entry.transform = {
      angleDegrees: round(Number(operation.transform.angle || 0) * 180 / Math.PI, 2),
      scale: round(operation.transform.scale ?? 1, 5),
      tx: round(operation.transform.tx), ty: round(operation.transform.ty),
      reflect: operation.transform.reflect === true
    };
  }
  if (Number.isFinite(Number(operation.residualPx))) entry.residualPx = round(operation.residualPx, 5);
  if (operation.deltas) {
    entry.controlPointDeltas = Object.fromEntries(Object.entries(operation.deltas)
      .map(([key, delta]) => [key, { dx: round(delta.dx), dy: round(delta.dy) }]));
  }
  if (operation.type === 'object-exception') {
    entry.fallbackChanges = summarizeFallbackChanges(operation.changes);
    if (operation.causeEvidence) entry.causeEvidence = roundDeep(operation.causeEvidence);
  } else if (operation.changes) entry.changes = compactChanges(operation.changes);
  if (operation.stroke) {
    entry.stroke = {
      family: operation.stroke.family || null,
      memberCount: operation.stroke.members?.length || operation.affectedMemberCount || 0,
      bounds: summarizeBounds(operation.stroke.members),
      curvePoints: compactCurvePoints(operation.stroke.curve),
      pegShape: operation.stroke.curve?.pegShape || null,
      pegType: operation.stroke.curve?.pegType || null,
      spacingPx: round(operation.stroke.curve?.spacingPx),
      pegRadius: round(operation.stroke.curve?.pegRadius),
      brickWidth: round(operation.stroke.curve?.brickWidth),
      rotationOffset: round(operation.stroke.curve?.rotationOffset)
    };
  }
  if (operation.object || operation.declaredObject) {
    const object = operation.object || operation.declaredObject;
    entry.object = {
      family: object.family || null,
      memberCount: object.members?.length || operation.affectedMemberCount || 0,
      bounds: summarizeBounds(object.members),
      definition: clone(object.definition || null)
    };
  }
  if (operation.definition) entry.definition = clone(operation.definition);
  if (operation.sourceObjectIds) entry.sourceObjectIds = clone(operation.sourceObjectIds);
  if (operation.movedMemberIds) entry.movedMemberCount = operation.movedMemberIds.length;
  if (operation.group) entry.group = {
    family: operation.group.family || null,
    memberCount: operation.group.memberIds?.length || 0,
    properties: clone(operation.group.properties || {})
  };
  if (operation.deletedBounds) entry.deletedBounds = roundDeep(operation.deletedBounds);
  if (operation.family) entry.family = operation.family;
  if (operation.memberIds) entry.memberCount = operation.memberIds.length;
  return entry;
}

function groupOperations(operations) {
  const groups = new Map();
  for (const operation of operations || []) {
    const expressibility = operation.expressibility || 'native';
    const key = `${operation.type}|${expressibility}`;
    if (!groups.has(key)) groups.set(key, {
      type: operation.type, expressibility, count: 0, affectedMemberReferences: 0, reasons: []
    });
    const entry = groups.get(key);
    entry.count++;
    entry.affectedMemberReferences += Number(operation.affectedMemberCount || 0);
    if (operation.reason) entry.reasons.push(operation.reason);
    const parameterKey = operationParameterKey(operation);
    if (!entry.parameterClusters) entry.parameterClusters = new Map();
    if (!entry.parameterClusters.has(parameterKey)) entry.parameterClusters.set(parameterKey, {
      parameters: operationParameterSummary(operation), count: 0, objectIds: []
    });
    const cluster = entry.parameterClusters.get(parameterKey);
    cluster.count++;
    const objectId = operation.objectId || operation.groupId;
    if (objectId && cluster.objectIds.length < 6) cluster.objectIds.push(objectId);
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
    .map(entry => ({
      ...entry,
      reasons: Object.fromEntries(tally(entry.reasons)),
      parameterClusters: [...entry.parameterClusters.values()].map(cluster => ({
        ...cluster,
        omittedObjectIds: Math.max(0, cluster.count - cluster.objectIds.length)
      }))
    }));
}

function operationParameterSummary(operation) {
  if (operation.transform) return {
    angleDegrees: round(Number(operation.transform.angle || 0) * 180 / Math.PI, 1),
    scale: round(operation.transform.scale ?? 1, 4),
    tx: round(operation.transform.tx, 1), ty: round(operation.transform.ty, 1),
    reflect: operation.transform.reflect === true
  };
  if (operation.type === 'object-exception') return {
    reason: operation.reason || 'unclassified',
    changedMembers: operation.changes?.length || 0
  };
  if (operation.changes) return { changedProperties: Object.keys(operation.changes).sort() };
  if (operation.deltas) return { changedControlPoints: Object.keys(operation.deltas).sort() };
  return { family: operation.family || operation.stroke?.family || operation.object?.family || null };
}

function operationParameterKey(operation) {
  return JSON.stringify(operationParameterSummary(operation));
}

function selectOperationDetails(operations, limit = 3) {
  const values = (operations || []).map((operation, index) => ({ operation, index }));
  if (values.length <= limit) return { values, omitted: 0, policy: 'all' };
  const ranked = [...values].sort((left, right) => {
    const priority = value => value.operation.expressibility === 'fallback' ? 0
      : ['add-stroke', 'delete-stroke', 'add-object', 'delete-object', 'declare-object'].includes(value.operation.type) ? 1
        : value.operation.transform ? 3 : 2;
    return priority(left) - priority(right)
      || Number(right.operation.affectedMemberCount || 0) - Number(left.operation.affectedMemberCount || 0)
      || left.index - right.index;
  });
  const selected = ranked.slice(0, limit).sort((left, right) => left.index - right.index);
  return {
    values: selected,
    omitted: values.length - selected.length,
    policy: 'fallback/add-delete/non-transform first, then largest transforms; parameter clusters retain the full distribution'
  };
}

function transactionHints(transaction) {
  return (transaction?.patch?.hints || transaction?.hints || []).map(String);
}

function summarizeSequence(operationSequence, detailLimit = 24) {
  const entries = (operationSequence || []).map((transaction, index) => {
    const operations = (transaction.patch?.operations || []).filter(operation => operation.expressibility !== 'ignored');
    return {
      seq: Number.isInteger(transaction.sequence) ? transaction.sequence : index,
      editorSeq: Number.isInteger(transaction.editorSequence) ? transaction.editorSequence : null,
      hints: transactionHints(transaction),
      retracted: transaction.retracted === true,
      types: Object.fromEntries(tally(operations.map(operation => operation.type || 'unknown'))),
      objects: [...new Set(operations.map(operation => operation.objectId || operation.groupId).filter(Boolean))].sort(),
      fallbackReasons: Object.fromEntries(tally(operations
        .filter(operation => operation.expressibility === 'fallback')
        .map(operation => operation.reason || 'unclassified')))
    };
  });
  const aggregate = {
    hints: Object.fromEntries(tally(entries.flatMap(entry => entry.hints))),
    activeTypes: Object.fromEntries(tally(entries.filter(entry => !entry.retracted)
      .flatMap(entry => Object.entries(entry.types).flatMap(([type, count]) => Array.from({ length: count }, () => type))))),
    retractedTypes: Object.fromEntries(tally(entries.filter(entry => entry.retracted)
      .flatMap(entry => Object.entries(entry.types).flatMap(([type, count]) => Array.from({ length: count }, () => type))))),
    fallbackReasons: Object.fromEntries(tally(entries
      .flatMap(entry => Object.entries(entry.fallbackReasons).flatMap(([reason, count]) => Array.from({ length: count }, () => reason)))))
  };
  const objectTouches = new Map();
  for (const entry of entries) for (const objectId of entry.objects) {
    objectTouches.set(objectId, (objectTouches.get(objectId) || 0) + 1);
  }
  const sortedTouches = [...objectTouches.entries()].sort((left, right) => right[1] - left[1]
    || left[0].localeCompare(right[0]));
  aggregate.mostTouchedObjects = sortedTouches.slice(0, 8).map(([objectId, count]) => ({ objectId, count }));
  aggregate.omittedTouchedObjects = Math.max(0, sortedTouches.length - aggregate.mostTouchedObjects.length);

  const runs = [];
  for (const entry of entries) {
    const signature = JSON.stringify({
      hints: entry.hints, retracted: entry.retracted, types: entry.types,
      objects: entry.objects, fallbackReasons: entry.fallbackReasons
    });
    const previous = runs.at(-1);
    if (previous?.signature === signature) {
      previous.runLength++;
      previous.endSeq = entry.seq;
    } else runs.push({ ...entry, endSeq: entry.seq, runLength: 1, signature });
  }
  let selected = runs;
  let selection = 'all collapsed runs';
  if (runs.length > detailLimit) {
    const chosen = new Set([
      ...runs.slice(0, 5),
      ...runs.slice(-5),
      ...runs.filter(entry => entry.retracted || Object.keys(entry.fallbackReasons).length)
    ]);
    for (const entry of runs) {
      if (chosen.size >= detailLimit) break;
      chosen.add(entry);
    }
    selected = [...chosen].slice(0, detailLimit).sort((left, right) => left.seq - right.seq);
    selection = 'first/last runs plus fallback and retracted evidence; aggregate counts cover every command';
  }
  return {
    entries: selected.map(({ signature: _signature, ...entry }) => entry),
    collapsed: runs.length < entries.length,
    runCount: runs.length,
    omittedRuns: Math.max(0, runs.length - selected.length),
    selection,
    aggregate
  };
}

function compactGate(name, gate) {
  const result = { status: gate?.status || 'unknown' };
  if (gate?.failures?.length) result.failures = [...new Set(gate.failures.map(String))];
  if (name === 'lineage') Object.assign(result, {
    pegCount: gate?.pegCount ?? null, nodeCount: gate?.nodeCount ?? null, groupCount: gate?.groupCount ?? null
  });
  if (name === 'commandLog') result.commandCount = gate?.commandCount ?? null;
  if (name === 'transactionLog') result.transactionCount = gate?.transactionCount ?? null;
  if (name === 'staticChecks') Object.assign(result, {
    pegCount: gate?.pegCount ?? null,
    outOfBoundsCount: gate?.outOfBounds?.length || 0,
    crossObjectOverlapCount: gate?.crossObjectOverlapCount ?? null,
    launcherClearance: round(gate?.launcherClearance),
    minimumLauncherClearance: round(gate?.minimumLauncherClearance)
  });
  if (name === 'control' && gate?.status !== 'not-applicable') Object.assign(result, {
    expectedOperation: gate?.expectedOperation ? summarizeOperation(gate.expectedOperation, 0) : null,
    actualOperation: gate?.actualOperation ? summarizeOperation(gate.actualOperation, 0) : null,
    expectedOperationCount: gate?.expectedOperationCount ?? null,
    actualOperationCount: gate?.actualOperationCount ?? null,
    maxResidualPx: round(gate?.maxResidualPx, 5),
    thresholdPx: round(gate?.thresholdPx, 5),
    unaffectedStateExact: gate?.unaffectedStateExact === true
  });
  return result;
}

function sourceContext(source) {
  return {
    source: source?.source || null,
    sourceLevelId: source?.sourceLevelId || null,
    compositionFamily: source?.compositionFamily || null,
    sourceSkeleton: source?.sourceSkeleton || null,
    strata: clone(source?.strata || []),
    knownProperties: roundDeep(source?.knownProperties || []),
    footprint: roundDeep(source?.footprint || null)
  };
}

function recomputeCandidate(candidate) {
  return analyzeRepairCandidate({
    ...candidate,
    currentLevel: candidate.finalLevel,
    transactionLog: candidate.operationSequence || []
  });
}

function candidateRelations(candidate, independent, changedObjectDetailLimit = 3) {
  const width = Number(candidate.staticCheckOptions?.width || 400);
  const height = Number(candidate.staticCheckOptions?.height
    || candidate.finalLevel?.survival?.worldHeight || candidate.baselineLevel?.survival?.worldHeight || 600);
  return describeRepairRelations(
    captureBezierSemanticState(candidate.baselineLevel),
    captureBezierSemanticState(candidate.finalLevel),
    independent.patch.operations,
    { width, height, axisX: width / 2, launcherY: 40, changedObjectDetailLimit }
  );
}

function candidateDigest(candidate, index, independent, relations, rasterEnabled) {
  const { patch, replay, gates } = independent;
  const metrics = patch.metrics || {};
  const sequence = summarizeSequence(candidate.operationSequence);
  const operationDetails = selectOperationDetails(patch.operations);
  const agreement = {
    finalSemanticDiff: agrees(candidate.finalSemanticDiff, patch),
    replay: agrees(candidate.replay, replay),
    gates: agrees(candidate.gates, gates)
  };
  agreement.all = Object.values(agreement).every(Boolean);
  const previewBase = `${String(index + 1).padStart(2, '0')}-${safeName(candidate.id)}`;
  return {
    id: candidate.id,
    order: candidate.order ?? index,
    role: candidate.role || 'study',
    disposition: candidate.disposition || 'unresolved',
    dispositionReason: candidate.dispositionReason || '',
    note: candidate.note || '',
    frictionNote: candidate.frictionNote || '',
    source: sourceContext(candidate.source),
    knownDefect: candidate.knownDefect ? {
      id: candidate.knownDefect.id,
      objectId: candidate.knownDefect.objectId || candidate.knownDefect.expectedOperation?.objectId || null,
      expectedOperation: candidate.knownDefect.expectedOperation
        ? summarizeOperation(candidate.knownDefect.expectedOperation, 0)
        : null,
      acceptanceThresholdPx: candidate.knownDefect.acceptanceThresholdPx ?? null
    } : null,
    previews: {
      before: `previews/${previewBase}.before.svg`,
      after: `previews/${previewBase}.after.svg`,
      comparisonSvg: `previews/${previewBase}.comparison.svg`,
      comparisonPng: rasterEnabled ? `previews/${previewBase}.comparison.png` : null
    },
    integrity: { storedSummariesAgreeWithRecomputation: agreement },
    gates: Object.fromEntries(Object.entries(gates || {}).map(([name, gate]) => [name, compactGate(name, gate)])),
    replay: {
      exact: replay.exact === true,
      replayAccuracy: round(replay.replayAccuracy, 6),
      strokeAccuracy: round(replay.strokeAccuracy, 6),
      memberAccuracy: round(replay.memberAccuracy, 6)
    },
    metrics: {
      repairFallbackFraction: round(metrics.repairFallbackFraction, 6),
      stateFallbackFraction: round(metrics.stateFallbackFraction, 6),
      stateProgramCoverage: round(metrics.stateProgramCoverage, 6),
      operationCount: metrics.operationCount ?? null,
      nativeOperationCount: metrics.nativeOperationCount ?? null,
      fallbackOperationCount: metrics.fallbackOperationCount ?? null,
      changedMemberCount: metrics.changedMemberCount ?? null,
      fallbackChangedMemberCount: metrics.fallbackChangedMemberCount ?? null,
      finalMemberCount: metrics.finalMemberCount ?? null,
      fallbackFinalMemberCount: metrics.fallbackFinalMemberCount ?? null
    },
    fallbackReasonCounts: clone(metrics.fallbackReasonCounts || {}),
    languageGapReasonCounts: clone(metrics.languageGapReasonCounts || {}),
    operationGroups: groupOperations(patch.operations),
    operationDetailPolicy: {
      total: patch.operations?.length || 0,
      reported: operationDetails.values.length,
      omitted: operationDetails.omitted,
      selection: operationDetails.policy
    },
    operations: operationDetails.values.map(({ operation, index: operationIndex }) => (
      summarizeOperation(operation, operationIndex)
    )),
    relations,
    sequence: {
      recorded: (candidate.operationSequence || []).length,
      active: (candidate.operationSequence || []).filter(transaction => transaction?.retracted !== true).length,
      retracted: (candidate.operationSequence || []).filter(transaction => transaction?.retracted === true).length,
      collapsed: sequence.collapsed,
      runCount: sequence.runCount,
      omittedRuns: sequence.omittedRuns,
      selection: sequence.selection,
      aggregate: sequence.aggregate,
      entries: sequence.entries
    }
  };
}

function failedRequiredGates(candidate) {
  const required = ['replay', 'lineage', 'commandLog', 'transactionLog'];
  if (candidate.disposition === 'done') required.push('staticChecks');
  return required.filter(name => candidate.gates[name]?.status !== 'passed');
}

function aggregateCandidates(candidates) {
  const fallbackReasonCounts = {};
  const languageGapReasonCounts = {};
  const operationTypeCounts = {};
  for (const candidate of candidates) {
    addCounts(fallbackReasonCounts, candidate.fallbackReasonCounts);
    addCounts(languageGapReasonCounts, candidate.languageGapReasonCounts);
    for (const group of candidate.operationGroups) {
      const key = `${group.type}:${group.expressibility}`;
      operationTypeCounts[key] = (operationTypeCounts[key] || 0) + group.count;
    }
  }
  return {
    candidateIds: candidates.map(candidate => candidate.id),
    candidateCount: candidates.length,
    fallbackReasonCounts,
    languageGapReasonCounts,
    operationTypeCounts
  };
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {}).sort((left, right) => right[1] - left[1]
    || left[0].localeCompare(right[0]));
  return entries.length ? entries.map(([key, count]) => `${key}×${count}`).join(', ') : 'none';
}

function operationLine(operation) {
  const fields = [`${operation.index}. \`${operation.type}\``, operation.expressibility];
  if (operation.objectId) fields.push(`object=${operation.objectId}`);
  if (operation.affectedMemberCount) fields.push(`members=${operation.affectedMemberCount}`);
  if (operation.transform) fields.push(`angle=${operation.transform.angleDegrees}° scale=${operation.transform.scale}`
    + ` tx=${operation.transform.tx} ty=${operation.transform.ty}`
    + (operation.transform.reflect ? ' reflected' : ''));
  if (operation.controlPointDeltas) fields.push(`controlPoints=${JSON.stringify(operation.controlPointDeltas)}`);
  if (operation.changes) fields.push(`changes=${JSON.stringify(operation.changes)}`);
  if (operation.fallbackChanges) fields.push(`fallback=${JSON.stringify(operation.fallbackChanges)}`);
  if (operation.reason) fields.push(`reason=${operation.reason}`);
  if (operation.languageGapCandidate) fields.push(`gap=${operation.languageGapCandidate}`);
  if (operation.stroke) fields.push(`stroke=${JSON.stringify(operation.stroke)}`);
  if (operation.object) fields.push(`objectDefinition=${JSON.stringify(operation.object)}`);
  if (operation.definition) fields.push(`definition=${JSON.stringify(operation.definition)}`);
  if (operation.group) fields.push(`group=${JSON.stringify(operation.group)}`);
  if (operation.sourceObjectIds) fields.push(`sources=[${operation.sourceObjectIds.join(',')}]`);
  if (operation.movedMemberCount) fields.push(`movedMembers=${operation.movedMemberCount}`);
  if (operation.deletedBounds) fields.push(`deletedBounds=${JSON.stringify(operation.deletedBounds)}`);
  return `- ${fields.join(' · ')}`;
}

function operationGroupLine(group) {
  const clusters = group.parameterClusters.map(cluster => {
    const examples = cluster.objectIds.length ? ` objects=${cluster.objectIds.join('|')}` : '';
    const omitted = cluster.omittedObjectIds ? ` +${cluster.omittedObjectIds}` : '';
    return `${cluster.count}×${JSON.stringify(cluster.parameters)}${examples}${omitted}`;
  }).join('; ');
  return `- ${group.count} × \`${group.type}\` (${group.expressibility}), affected-member references=${group.affectedMemberReferences}`
    + `${Object.keys(group.reasons).length ? `, reasons=${formatCounts(group.reasons)}` : ''}`
    + `${clusters ? ` — clusters: ${clusters}` : ''}`;
}

function globalRelationLines(relations) {
  const before = relations.global.before, after = relations.global.after, delta = relations.global.delta;
  return [
    `Global geometry: members ${before.memberCount}→${after.memberCount}; objects ${before.objectCount}→${after.objectCount}; centroid (${before.centroid.x},${before.centroid.y})→(${after.centroid.x},${after.centroid.y}); axis offset ${before.centroid.signedAxisOffsetPx}→${after.centroid.signedAxisOffsetPx}px.`,
    `Composition: coverage ${before.bounds.coverageX}×${before.bounds.coverageY}→${after.bounds.coverageX}×${after.bounds.coverageY}; mirror ${before.mirror.score}→${after.mirror.score}; nearest-neighbor mean ${before.nearestNeighbor.meanPx}→${after.nearestNeighbor.meanPx}px.`,
    `Negative space: top opening ${before.negativeSpace.topOpeningPx}→${after.negativeSpace.topOpeningPx}px; occupancy ${before.negativeSpace.centerOccupancyFraction}→${after.negativeSpace.centerOccupancyFraction}; largest empty rectangle ${before.negativeSpace.largestEmptyRectangleFraction}→${after.negativeSpace.largestEmptyRectangleFraction}.`,
    `Net relational delta: ${JSON.stringify(delta)}.`
  ];
}

function changedObjectLine(entry) {
  if (entry.status === 'added' || entry.status === 'deleted') {
    const state = entry.after || entry.before;
    return `- \`${entry.objectId}\` ${entry.status}: ${state.memberCount} members, centroid=(${state.centroid.x},${state.centroid.y}), bounds=${state.bounds.width}×${state.bounds.height}, mirror=${state.mirror.score}, nearest=${formatNearest(state.neighborhood.nearestObjects)}.`;
  }
  if (!entry.before || !entry.after) return `- \`${entry.objectId}\` ${entry.status}.`;
  return `- \`${entry.objectId}\`: members ${entry.before.memberCount}→${entry.after.memberCount}; centroid (${entry.before.centroid.x},${entry.before.centroid.y})→(${entry.after.centroid.x},${entry.after.centroid.y}); bounds ${entry.before.bounds.width}×${entry.before.bounds.height}→${entry.after.bounds.width}×${entry.after.bounds.height}; orientation ${entry.before.orientation.angleDegrees}°→${entry.after.orientation.angleDegrees}°; net=${JSON.stringify(entry.delta)}; mirror ${entry.before.mirror.score}→${entry.after.mirror.score}; density ${entry.before.neighborhood.localDensity}→${entry.after.neighborhood.localDensity}; nearest before=${formatNearest(entry.before.neighborhood.nearestObjects)}, after=${formatNearest(entry.after.neighborhood.nearestObjects)}.`;
}

function formatNearest(entries) {
  return entries?.length ? entries.map(entry => `${entry.objectId}:${entry.distancePx}px`).join('|') : 'none';
}

function renderMarkdown(digest) {
  const lines = [];
  lines.push(`# Repair session digest — ${digest.sessionId}`);
  lines.push('');
  lines.push(`Derived from \`${digest.sourceResult}\` (${kb(digest.archive.resultBytes)}, SHA-256 \`${digest.archive.sha256}\`).`);
  lines.push('Diffs, replay, gates and metrics below were independently recomputed from embedded before/after levels and active command evidence.');
  lines.push(`Model-text budget: ${digest.modelInputBudget.combinedBytes}/${digest.modelInputBudget.maxCombinedBytes} bytes for digest.md + digest.json; previews are accounted separately as visual inputs.`);
  lines.push(`Visual evidence: ${digest.visualEvidence.comparisonSheets} comparison sheets (${digest.visualEvidence.format}`
    + `${digest.visualEvidence.totalComparisonPngBytes != null ? `, ${kb(digest.visualEvidence.totalComparisonPngBytes)} PNG total` : ''}).`);
  lines.push('');
  lines.push(`Result status: **${digest.resultStatus}**.`);
  if (digest.protocol?.warning) lines.push(`Protocol warning: ${digest.protocol.warning}`);
  lines.push('');
  lines.push('> Replay accuracy, repair fallback and final-state fallback must be interpreted together.');
  lines.push('');
  lines.push('## Analysis contract');
  lines.push('');
  for (const rule of digest.analysisContract) lines.push(`- ${rule}`);
  lines.push('');
  lines.push(`Relational descriptor method: ${JSON.stringify(digest.relationalMethod)}.`);
  lines.push('');

  const mismatches = digest.candidates.filter(candidate => !candidate.integrity.storedSummariesAgreeWithRecomputation.all);
  if (mismatches.length) {
    lines.push('## Integrity warning');
    lines.push('');
    lines.push('Stored editor summaries disagree with independent recomputation:');
    for (const candidate of mismatches) {
      const agreement = candidate.integrity.storedSummariesAgreeWithRecomputation;
      lines.push(`- \`${candidate.id}\` — diff=${agreement.finalSemanticDiff}, replay=${agreement.replay}, gates=${agreement.gates}`);
    }
    lines.push('');
  }

  const control = digest.candidates.find(candidate => candidate.role === 'control');
  if (control) {
    const gate = control.gates.control || { status: 'unknown' };
    lines.push('## Control calibration');
    lines.push('');
    lines.push(`\`${control.id}\` — **${gate.status}**; expected \`${control.knownDefect?.expectedOperation?.type || 'unknown'}\``
      + ` on \`${control.knownDefect?.objectId || 'unknown'}\`, observed ${control.operations.map(operation => `\`${operation.type}\` on \`${operation.objectId}\``).join(', ') || 'nothing'}.`);
    if (gate.failures?.length) lines.push(`Failures: ${gate.failures.join(', ')}.`);
    if (gate.maxResidualPx != null) lines.push(`Maximum target residual: ${gate.maxResidualPx}px (threshold ${gate.thresholdPx}px); unaffected state exact=${gate.unaffectedStateExact}.`);
    lines.push('');
  }

  lines.push('## Aggregate scope');
  lines.push('');
  lines.push(`Primary aggregate contains ${digest.aggregates.primaryStudy.candidateCount} completed, gate-valid study candidates; it excludes the control, deferred/unfixable candidates and failed gates.`);
  lines.push(`Language gaps: ${formatCounts(digest.aggregates.primaryStudy.languageGapReasonCounts)}.`);
  lines.push(`Operation types: ${formatCounts(digest.aggregates.primaryStudy.operationTypeCounts)}.`);
  if (digest.excludedStudy.length) {
    lines.push('Excluded study candidates:');
    for (const excluded of digest.excludedStudy) lines.push(`- \`${excluded.id}\` — ${excluded.reasons.join(', ')}`);
  }
  lines.push('');

  if (digest.refusals.length) {
    lines.push('Refusals / deferrals:');
    for (const refusal of digest.refusals) lines.push(`- \`${refusal.id}\` — ${refusal.disposition} — ${refusal.reason || '(no reason given)'}`);
    lines.push('');
  }

  for (const candidate of digest.candidates) {
    const family = candidate.source.compositionFamily;
    lines.push(`## ${candidate.order}. ${candidate.id}${family ? ` — ${family}` : ''}`);
    lines.push('');
    lines.push(`Disposition: **${candidate.disposition}**${candidate.dispositionReason ? ` — ${candidate.dispositionReason}` : ''}.`);
    lines.push(`Visual evidence: [comparison SVG](${candidate.previews.comparisonSvg})`
      + `${candidate.previews.comparisonPng ? `, [model-ready PNG](${candidate.previews.comparisonPng})` : ''}`
      + `; separate [before](${candidate.previews.before}) and [after](${candidate.previews.after}).`);
    if (candidate.source.strata.length) lines.push(`Strata: ${candidate.source.strata.join(', ')}.`);
    if (candidate.source.footprint) lines.push(`Source footprint: ${JSON.stringify(candidate.source.footprint)}.`);
    for (const property of candidate.source.knownProperties) {
      lines.push(`Known property \`${property.id}\`: ${JSON.stringify(property.measured || {})}`
        + (property.interpretationRisk ? ` — ${property.interpretationRisk}` : ''));
    }
    lines.push('');
    lines.push('```text');
    lines.push(`gates    ${Object.entries(candidate.gates).map(([name, gate]) => `${name}=${gate.status}${gate.failures?.length ? `[${gate.failures.join(',')}]` : ''}`).join('  ')}`);
    lines.push(`replay   exact=${candidate.replay.exact} accuracy=${candidate.replay.replayAccuracy}`
      + ` stroke=${candidate.replay.strokeAccuracy} member=${candidate.replay.memberAccuracy}`);
    lines.push(`metrics  repairFallback=${candidate.metrics.repairFallbackFraction}`
      + ` stateFallback=${candidate.metrics.stateFallbackFraction}`
      + ` coverage=${candidate.metrics.stateProgramCoverage}`);
    lines.push(`         operations ${candidate.metrics.operationCount}`
      + ` (native ${candidate.metrics.nativeOperationCount}, fallback ${candidate.metrics.fallbackOperationCount})`
      + ` changed members ${candidate.metrics.changedMemberCount}; final members ${candidate.metrics.finalMemberCount}`);
    lines.push('```');
    lines.push('');
    for (const line of globalRelationLines(candidate.relations)) lines.push(line);
    lines.push('');
    if (candidate.relations.changedObjectSummary.total) {
      const summary = candidate.relations.changedObjectSummary;
      lines.push(`Changed-object relational context: ${summary.total} total, ${summary.reported} detailed, ${summary.omitted} represented only in the complete distribution below.`);
      lines.push('');
      lines.push(`Distribution: statuses=${formatCounts(summary.statusCounts)}; families=${formatCounts(summary.familyCounts)}; deltas=${JSON.stringify(summary.deltaDistribution)}.`);
      if (summary.omitted) lines.push(`Detail selection: ${summary.selection}.`);
      lines.push('');
      for (const entry of candidate.relations.changedObjects) lines.push(changedObjectLine(entry));
      lines.push('');
    }
    lines.push(`Final semantic diff (${candidate.operationDetailPolicy.total} operations):`);
    lines.push('');
    if (candidate.operationGroups.length) for (const group of candidate.operationGroups) lines.push(operationGroupLine(group));
    else lines.push('- No semantic change.');
    lines.push('');
    if (candidate.operations.length) {
      lines.push(`Representative operation details: ${candidate.operationDetailPolicy.reported} shown, ${candidate.operationDetailPolicy.omitted} omitted.`);
      if (candidate.operationDetailPolicy.omitted) lines.push(`Selection policy: ${candidate.operationDetailPolicy.selection}.`);
      lines.push('');
      for (const operation of candidate.operations) lines.push(operationLine(operation));
      lines.push('');
    }
    lines.push(`Command sequence: ${candidate.sequence.recorded} recorded, ${candidate.sequence.active} active, ${candidate.sequence.retracted} retracted.`
      + ` ${candidate.sequence.runCount} semantic runs, ${candidate.sequence.entries.length} shown, ${candidate.sequence.omittedRuns} omitted.`
      + (candidate.sequence.collapsed ? ' Consecutive commands with identical hint, operation, target and reason were collapsed.' : ''));
    lines.push(`Command aggregate: hints=${formatCounts(candidate.sequence.aggregate.hints)}; active types=${formatCounts(candidate.sequence.aggregate.activeTypes)}; retracted types=${formatCounts(candidate.sequence.aggregate.retractedTypes)}; fallback=${formatCounts(candidate.sequence.aggregate.fallbackReasons)}; most touched=${candidate.sequence.aggregate.mostTouchedObjects.map(entry => `${entry.objectId}:${entry.count}`).join('|') || 'none'}${candidate.sequence.aggregate.omittedTouchedObjects ? ` (+${candidate.sequence.aggregate.omittedTouchedObjects} objects)` : ''}.`);
    if (candidate.sequence.omittedRuns) lines.push(`Run selection: ${candidate.sequence.selection}.`);
    lines.push('');
    lines.push('```text');
    for (const entry of candidate.sequence.entries) {
      const range = entry.runLength > 1 ? `${entry.seq}-${entry.endSeq} (x${entry.runLength})` : String(entry.seq);
      lines.push(`${range.padStart(10)}  ${entry.retracted ? '[retracted] ' : ''}`
        + `${entry.hints.join(',') || '(no hint)'}  ${formatCounts(entry.types)}`
        + `${entry.objects.length ? `  [${entry.objects.join(',')}]` : ''}`
        + `${Object.keys(entry.fallbackReasons).length ? `  fallback:${formatCounts(entry.fallbackReasons)}` : ''}`);
    }
    if (!candidate.sequence.entries.length) lines.push('(no commands recorded)');
    lines.push('```');
    lines.push('');
    if (candidate.frictionNote) lines.push(`**Where the tool fought the intent:** ${candidate.frictionNote}`, '');
    if (candidate.note) lines.push(`Note: ${candidate.note}`, '');
  }

  lines.push('## What this digest dropped');
  lines.push('');
  for (const entry of digest.dropped) lines.push(`- ${entry}`);
  lines.push('');
  lines.push('The archive is intact. Use the drill-down commands below to retrieve exact raw evidence without loading the whole archive:');
  lines.push('');
  lines.push('```powershell');
  lines.push('node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --command <sequence>');
  lines.push('node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --operation <index>');
  lines.push('node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relations');
  lines.push('node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --relation <objectId>');
  lines.push('node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --level before|after');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { positionals: [] };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--candidate') options.candidate = argv[++index];
    else if (value === '--command') options.command = Number(argv[++index]);
    else if (value === '--operation') options.operation = Number(argv[++index]);
    else if (value === '--level') options.level = argv[++index];
    else if (value === '--relations') options.relations = true;
    else if (value === '--relation') options.relation = argv[++index];
    else if (value === '--browser') options.browser = argv[++index];
    else if (value === '--no-png') options.noPng = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else options.positionals.push(value);
  }
  return options;
}

function validateResult(result) {
  if (result?.format !== REPAIR_SESSION_RESULT_FORMAT) {
    throw new Error(`Expected ${REPAIR_SESSION_RESULT_FORMAT}; received ${result?.format || 'no format'}.`);
  }
  if (result.version !== REPAIR_SESSION_VERSION) throw new Error(`Unsupported repair result version: ${result.version}.`);
  if (!Array.isArray(result.candidates) || result.candidates.length === 0) throw new Error('Result has no candidates.');
  for (const candidate of result.candidates) {
    if (!candidate?.id || !candidate.baselineLevel || !candidate.finalLevel) {
      throw new Error(`Candidate ${candidate?.id || '(unnamed)'} lacks id, baselineLevel or finalLevel.`);
    }
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function drillDown(result, options) {
  if (!options.candidate) throw new Error('Drill-down requires --candidate <id>.');
  const candidate = result.candidates.find(value => value.id === options.candidate);
  if (!candidate) throw new Error(`Unknown candidate: ${options.candidate}.`);
  if (Number.isInteger(options.command)) {
    const command = (candidate.operationSequence || []).find(value => value.sequence === options.command);
    if (!command) throw new Error(`Candidate ${candidate.id} has no command sequence ${options.command}.`);
    printJson(command);
    return;
  }
  if (Number.isInteger(options.operation)) {
    const operation = recomputeCandidate(candidate).patch.operations?.[options.operation];
    if (!operation) throw new Error(`Candidate ${candidate.id} has no final operation ${options.operation}.`);
    printJson(operation);
    return;
  }
  if (options.level) {
    if (!['before', 'after'].includes(options.level)) throw new Error('--level must be before or after.');
    printJson(options.level === 'before' ? candidate.baselineLevel : candidate.finalLevel);
    return;
  }
  if (options.relations || options.relation) {
    const independent = recomputeCandidate(candidate);
    const relations = candidateRelations(candidate, independent, Number.MAX_SAFE_INTEGER);
    if (options.relation) {
      const entry = relations.changedObjects.find(value => value.objectId === options.relation);
      if (!entry) throw new Error(`Candidate ${candidate.id} has no changed-object relation for ${options.relation}.`);
      printJson(entry);
    } else printJson(relations);
    return;
  }
  throw new Error('Choose --command <sequence>, --operation <index>, --relations, --relation <objectId>, or --level before|after.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [input, outputArgument] = options.positionals;
  if (options.help || !input) {
    console.error('usage: digest-repair-session.mjs <repair-session-result.json> [outDir] [--browser <path>|--no-png] [--candidate <id> --command <n>|--operation <n>|--relations|--relation <objectId>|--level before|after]');
    process.exit(options.help ? 0 : 2);
  }
  const resultPath = path.resolve(input);
  const raw = await fs.readFile(resultPath, 'utf8');
  const result = JSON.parse(raw);
  validateResult(result);
  if (options.candidate || options.command != null || options.operation != null
      || options.level || options.relations || options.relation) {
    drillDown(result, options);
    return;
  }

  const output = path.resolve(outputArgument || path.join(path.dirname(resultPath), 'digest'));
  await fs.mkdir(path.join(output, 'previews'), { recursive: true });
  const rasterBrowser = options.noPng ? null : await findRasterBrowser(options.browser);
  if (!options.noPng && !rasterBrowser) {
    throw new Error('No Edge/Chrome browser found for PNG comparison sheets. Pass --browser <path>, or --no-png to explicitly produce SVG only.');
  }
  const candidates = [];
  for (const [index, candidate] of result.candidates.entries()) {
    const independent = recomputeCandidate(candidate);
    const width = Number(candidate.staticCheckOptions?.width || 400);
    const height = Number(candidate.staticCheckOptions?.height
      || candidate.finalLevel?.survival?.worldHeight || candidate.baselineLevel?.survival?.worldHeight || 600);
    const relations = candidateRelations(candidate, independent);
    const entry = candidateDigest(candidate, index, independent, relations, !!rasterBrowser);
    candidates.push(entry);
    const comparisonSvg = renderRepairComparisonSvg(candidate.baselineLevel, candidate.finalLevel, {
      title: `${candidate.id} — repair comparison`, width, height
    });
    await Promise.all([
      fs.writeFile(path.join(output, entry.previews.before),
        renderNativeLevelSvg(candidate.baselineLevel, { title: `${candidate.id} — before`, width, height })),
      fs.writeFile(path.join(output, entry.previews.after),
        renderNativeLevelSvg(candidate.finalLevel, { title: `${candidate.id} — after`, width, height })),
      fs.writeFile(path.join(output, entry.previews.comparisonSvg), comparisonSvg)
    ]);
    if (rasterBrowser) {
      await rasterizeSvg(
        path.join(output, entry.previews.comparisonSvg),
        path.join(output, entry.previews.comparisonPng),
        rasterBrowser,
        width * 3,
        height + 38
      );
    }
    entry.previews.comparisonSvgBytes = (await fs.stat(path.join(output, entry.previews.comparisonSvg))).size;
    entry.previews.comparisonPngBytes = rasterBrowser
      ? (await fs.stat(path.join(output, entry.previews.comparisonPng))).size
      : null;
  }

  const primaryStudy = candidates.filter(candidate => candidate.role === 'study'
    && candidate.disposition === 'done' && failedRequiredGates(candidate).length === 0);
  const excludedStudy = candidates.filter(candidate => candidate.role === 'study' && !primaryStudy.includes(candidate))
    .map(candidate => ({
      id: candidate.id,
      reasons: [
        ...(candidate.disposition === 'done' ? [] : [`disposition:${candidate.disposition}`]),
        ...failedRequiredGates(candidate).map(name => `gate:${name}`)
      ]
    }));
  const digest = {
    format: 'repair-session-digest',
    version: 3,
    sessionId: result.sessionId,
    seed: result.seed,
    resultStatus: result.status || 'unknown',
    blockingFailures: clone(result.blockingFailures || []),
    sourceResult: path.relative(process.cwd(), resultPath).split(path.sep).join('/'),
    protocol: clone(result.protocol || {}),
    archive: {
      resultBytes: Buffer.byteLength(raw, 'utf8'),
      sha256: crypto.createHash('sha256').update(raw).digest('hex')
    },
    modelInputBudget: {
      scope: 'digest.md + minified digest.json; preview images are separate visual inputs',
      maxCombinedBytes: MODEL_TEXT_BUDGET_BYTES,
      markdownBytes: 0,
      jsonBytes: 0,
      combinedBytes: 0
    },
    visualEvidence: {
      comparisonSheets: candidates.length,
      format: rasterBrowser ? 'png+svg' : 'svg-only',
      rasterizer: rasterBrowser ? path.basename(rasterBrowser) : null,
      totalComparisonSvgBytes: candidates.reduce((sum, candidate) => sum + candidate.previews.comparisonSvgBytes, 0),
      totalComparisonPngBytes: rasterBrowser
        ? candidates.reduce((sum, candidate) => sum + candidate.previews.comparisonPngBytes, 0)
        : null
    },
    analysisContract: [
      'Treat the control as pipeline calibration, never as evidence about the author or generator.',
      'Interpret every operation together with its changed-object relations and before/after/overlay image.',
      'Separate candidate-specific defects listed under knownProperties from patterns recurring across composition families.',
      'Do not infer quality from operation or fallback counts alone; report competing explanations and request raw drill-down when the compact evidence is ambiguous.',
      'State proposed language additions as falsifiable hypotheses tied to candidate ids and operation indices.'
    ],
    relationalMethod: clone(REPAIR_RELATION_METHOD),
    aggregates: {
      primaryStudy: aggregateCandidates(primaryStudy),
      excludedStudy: aggregateCandidates(candidates.filter(candidate => excludedStudy.some(value => value.id === candidate.id))),
      control: aggregateCandidates(candidates.filter(candidate => candidate.role === 'control')),
      allDiagnostic: aggregateCandidates(candidates)
    },
    excludedStudy,
    refusals: candidates.filter(candidate => candidate.role === 'study' && candidate.disposition !== 'done')
      .map(candidate => ({ id: candidate.id, disposition: candidate.disposition, reason: candidate.dispositionReason })),
    candidates,
    dropped: [
      'full baselineLevel and finalLevel bodies (available through --level)',
      'raw per-operation payloads (compact parameters and fallback displacement statistics are retained; exact payloads are available through --operation)',
      'raw per-command patch bodies (hint, operation counts, target ids, fallback reasons and retraction are retained; exact payloads are available through --command)',
      'full relational detail for low-salience changed objects when a candidate changes more than three objects (complete distributions are retained; exact relations are available through --relations/--relation)',
      'verbose gate evidence such as every offending member id (status, failure codes and key counts are retained)',
      'per-member coordinates except aggregate fallback displacement and added/deleted counts',
      'level configuration outside the composition semantic state'
    ]
  };

  let markdown = '', digestJson = '';
  for (let iteration = 0; iteration < 5; iteration++) {
    markdown = renderMarkdown(digest);
    digestJson = `${JSON.stringify(digest)}\n`;
    const measured = {
      markdownBytes: Buffer.byteLength(markdown, 'utf8'),
      jsonBytes: Buffer.byteLength(digestJson, 'utf8')
    };
    measured.combinedBytes = measured.markdownBytes + measured.jsonBytes;
    const stable = measured.markdownBytes === digest.modelInputBudget.markdownBytes
      && measured.jsonBytes === digest.modelInputBudget.jsonBytes
      && measured.combinedBytes === digest.modelInputBudget.combinedBytes;
    Object.assign(digest.modelInputBudget, measured);
    if (stable) break;
  }
  markdown = renderMarkdown(digest);
  digestJson = `${JSON.stringify(digest)}\n`;
  const finalCombinedBytes = Buffer.byteLength(markdown, 'utf8') + Buffer.byteLength(digestJson, 'utf8');
  if (finalCombinedBytes > MODEL_TEXT_BUDGET_BYTES) {
    throw new Error(`Model text package is ${finalCombinedBytes} bytes; hard limit is ${MODEL_TEXT_BUDGET_BYTES}. Raw evidence was not truncated. Reduce the session or revise the explicit digest policy.`);
  }
  await Promise.all([
    fs.writeFile(path.join(output, 'digest.json'), digestJson),
    fs.writeFile(path.join(output, 'digest.md'), markdown)
  ]);
  const markdownBytes = Buffer.byteLength(markdown, 'utf8');
  console.log(JSON.stringify({
    output,
    candidates: candidates.length,
    primaryStudyCandidates: primaryStudy.length,
    archiveBytes: digest.archive.resultBytes,
    digestJsonBytes: Buffer.byteLength(digestJson, 'utf8'),
    digestMarkdownBytes: markdownBytes,
    combinedModelTextBytes: finalCombinedBytes,
    maxCombinedModelTextBytes: MODEL_TEXT_BUDGET_BYTES,
    comparisonPngs: rasterBrowser ? candidates.length : 0,
    markdownReduction: `${(digest.archive.resultBytes / Math.max(1, markdownBytes)).toFixed(0)}x`,
    storedSummaryMismatches: candidates.filter(candidate => !candidate.integrity.storedSummariesAgreeWithRecomputation.all)
      .map(candidate => candidate.id)
  }, null, 2));
}

await main();
