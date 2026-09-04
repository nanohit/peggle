#!/usr/bin/env node
// Derive a compact, independently recomputed reading package from the full
// repair-session archive. The archive remains the canonical replay source.
//
//   node research/tools/digest-repair-session.mjs <result.json> [outDir]
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --command <sequence>
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --operation <index>
//   node research/tools/digest-repair-session.mjs <result.json> --candidate <id> --level before|after

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  analyzeRepairCandidate,
  REPAIR_SESSION_RESULT_FORMAT,
  REPAIR_SESSION_VERSION
} from '../../js/repair-session.js';
import { renderNativeLevelSvg } from '../repair/lib/render-native-level.mjs';

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
const kb = value => `${(value / 1024).toFixed(1)} KB`;

function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
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
    if (operation.causeEvidence) entry.causeEvidence = clone(operation.causeEvidence);
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
  if (operation.deletedBounds) entry.deletedBounds = clone(operation.deletedBounds);
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
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
    .map(entry => ({ ...entry, reasons: Object.fromEntries(tally(entry.reasons)) }));
}

function transactionHints(transaction) {
  return (transaction?.patch?.hints || transaction?.hints || []).map(String);
}

function summarizeSequence(operationSequence, collapseAfter = 80) {
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
  if (entries.length <= collapseAfter) return { entries, collapsed: false };
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
  return {
    entries: runs.map(({ signature: _signature, ...entry }) => entry),
    collapsed: runs.length < entries.length
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
    knownProperties: clone(source?.knownProperties || []),
    footprint: clone(source?.footprint || null)
  };
}

function recomputeCandidate(candidate) {
  return analyzeRepairCandidate({
    ...candidate,
    currentLevel: candidate.finalLevel,
    transactionLog: candidate.operationSequence || []
  });
}

function candidateDigest(candidate, index, independent) {
  const { patch, replay, gates } = independent;
  const metrics = patch.metrics || {};
  const sequence = summarizeSequence(candidate.operationSequence);
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
      after: `previews/${previewBase}.after.svg`
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
    operations: (patch.operations || []).map(summarizeOperation),
    sequence: {
      recorded: (candidate.operationSequence || []).length,
      active: (candidate.operationSequence || []).filter(transaction => transaction?.retracted !== true).length,
      retracted: (candidate.operationSequence || []).filter(transaction => transaction?.retracted === true).length,
      collapsed: sequence.collapsed,
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

function renderMarkdown(digest) {
  const lines = [];
  lines.push(`# Repair session digest — ${digest.sessionId}`);
  lines.push('');
  lines.push(`Derived from \`${digest.sourceResult}\` (${kb(digest.archive.resultBytes)}, SHA-256 \`${digest.archive.sha256}\`).`);
  lines.push('Diffs, replay, gates and metrics below were independently recomputed from embedded before/after levels and active command evidence.');
  lines.push('');
  lines.push(`Result status: **${digest.resultStatus}**.`);
  if (digest.protocol?.warning) lines.push(`Protocol warning: ${digest.protocol.warning}`);
  lines.push('');
  lines.push('> Replay accuracy, repair fallback and final-state fallback must be interpreted together.');
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
    lines.push(`Previews: [before](${candidate.previews.before}), [after](${candidate.previews.after}).`);
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
    lines.push(`Final semantic diff (${candidate.operations.length} operations):`);
    lines.push('');
    if (candidate.operations.length) for (const operation of candidate.operations) lines.push(operationLine(operation));
    else lines.push('- No semantic change.');
    lines.push('');
    lines.push(`Command sequence: ${candidate.sequence.recorded} recorded, ${candidate.sequence.active} active, ${candidate.sequence.retracted} retracted.`
      + (candidate.sequence.collapsed ? ' Consecutive commands with identical hint, operation, target and reason were collapsed.' : ''));
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
  throw new Error('Choose one of --command <sequence>, --operation <index>, or --level before|after.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [input, outputArgument] = options.positionals;
  if (options.help || !input) {
    console.error('usage: digest-repair-session.mjs <repair-session-result.json> [outDir] [--candidate <id> --command <n>|--operation <n>|--level before|after]');
    process.exit(options.help ? 0 : 2);
  }
  const resultPath = path.resolve(input);
  const raw = await fs.readFile(resultPath, 'utf8');
  const result = JSON.parse(raw);
  validateResult(result);
  if (options.candidate || options.command != null || options.operation != null || options.level) {
    drillDown(result, options);
    return;
  }

  const output = path.resolve(outputArgument || path.join(path.dirname(resultPath), 'digest'));
  await fs.mkdir(path.join(output, 'previews'), { recursive: true });
  const candidates = [];
  for (const [index, candidate] of result.candidates.entries()) {
    const independent = recomputeCandidate(candidate);
    const entry = candidateDigest(candidate, index, independent);
    candidates.push(entry);
    await Promise.all([
      fs.writeFile(path.join(output, entry.previews.before),
        renderNativeLevelSvg(candidate.baselineLevel, { title: `${candidate.id} — before` })),
      fs.writeFile(path.join(output, entry.previews.after),
        renderNativeLevelSvg(candidate.finalLevel, { title: `${candidate.id} — after` }))
    ]);
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
    version: 2,
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
      'verbose gate evidence such as every offending member id (status, failure codes and key counts are retained)',
      'per-member coordinates except aggregate fallback displacement and added/deleted counts',
      'level configuration outside the composition semantic state'
    ]
  };

  const markdown = renderMarkdown(digest);
  const digestJson = `${JSON.stringify(digest, null, 2)}\n`;
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
    markdownReduction: `${(digest.archive.resultBytes / Math.max(1, markdownBytes)).toFixed(0)}x`,
    storedSummaryMismatches: candidates.filter(candidate => !candidate.integrity.storedSummariesAgreeWithRecomputation.all)
      .map(candidate => candidate.id)
  }, null, 2));
}

await main();
