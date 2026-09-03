import {
  applySimilarityTransform,
  bakePegsFromSamples,
  estimateSimilarityTransformFromPairs,
  sampleCubicBezier,
  transformBezierCurve
} from './bezier-geometry.js';

const POINT_KEYS = ['start', 'end', 'h1', 'h2'];
const RESAMPLE_PROPERTIES = [
  'pegShape', 'pegType', 'spacingPx', 'rotationOffset',
  'pegRadius', 'brickWidth', 'bakeVersion'
];
const DEFAULT_THRESHOLD_PX = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function close(left, right, tolerance = 1e-7) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
}

function pointsClose(left, right, tolerance = DEFAULT_THRESHOLD_PX) {
  return !!left && !!right && close(left.x, right.x, tolerance) && close(left.y, right.y, tolerance);
}

function normalizeBrickAngle(value) {
  let angle = Number(value || 0);
  while (angle >= Math.PI / 2) angle -= Math.PI;
  while (angle < -Math.PI / 2) angle += Math.PI;
  return Math.abs(angle) < 1e-12 ? 0 : angle;
}

function memberSnapshot(peg) {
  const shape = peg.shape || 'circle';
  return {
    index: Number(peg.bezierIndex),
    x: Number(peg.x),
    y: Number(peg.y),
    angle: shape === 'brick' ? normalizeBrickAngle(peg.angle) : 0,
    shape,
    type: peg.type || 'blue'
  };
}

function semanticExceptions(exceptions) {
  const deletedIndices = [...new Set((exceptions?.deletedIndices || []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const overrides = {};
  for (const [index, override] of Object.entries(exceptions?.overrides || {}).sort(([left], [right]) => Number(left) - Number(right))) {
    if (!override || !Number.isFinite(override.x) || !Number.isFinite(override.y)) continue;
    overrides[String(index)] = { kind: override.kind || 'position', x: Number(override.x), y: Number(override.y) };
  }
  return { deletedIndices, overrides };
}

function semanticLineage(lineage) {
  if (!lineage || typeof lineage !== 'object') return null;
  const result = {};
  for (const [key, value] of Object.entries(lineage)) {
    if (key === 'integrity' || key === 'nodeId') continue;
    result[key] = key === 'exceptions' ? semanticExceptions(value) : clone(value);
  }
  if (!result.family) result.family = 'BezierStroke';
  if (!result.exceptions) result.exceptions = semanticExceptions(null);
  return result;
}

export function captureBezierSemanticState(level) {
  const curves = level?.bezierCurves && typeof level.bezierCurves === 'object' ? level.bezierCurves : {};
  const members = new Map();
  for (const peg of level?.pegs || []) {
    if (!peg?.bezierGroupId) continue;
    if (!members.has(peg.bezierGroupId)) members.set(peg.bezierGroupId, []);
    members.get(peg.bezierGroupId).push(memberSnapshot(peg));
  }
  const lineage = level?.metadata?.generatorProgram?.nodes || {};
  const groupIds = new Set([...Object.keys(curves), ...members.keys(), ...Object.keys(lineage)]);
  const nodes = {};
  for (const groupId of [...groupIds].sort()) {
    const groupMembers = (members.get(groupId) || []).sort((left, right) => left.index - right.index);
    if (!curves[groupId] && groupMembers.length === 0 && !lineage[groupId]) continue;
    nodes[groupId] = {
      groupId,
      nodeId: String(lineage[groupId]?.nodeId || `bezier:${groupId}`),
      curve: clone(curves[groupId] || null),
      lineage: semanticLineage(lineage[groupId]),
      members: groupMembers
    };
  }
  return { format: 'bezier-semantic-state', version: 2, nodes };
}

function bakeNodeMembers(node) {
  if (!node?.curve) return [];
  const curve = node.curve;
  const shape = curve.pegShape === 'brick' ? 'brick' : 'circle';
  const pegRadius = Number.isFinite(curve.pegRadius) ? curve.pegRadius : 8.5;
  const brickWidth = Number.isFinite(curve.brickWidth) ? curve.brickWidth : pegRadius * 4;
  const spacingPx = Number.isFinite(curve.spacingPx)
    ? curve.spacingPx
    : (shape === 'brick' ? brickWidth : pegRadius * 2.2);
  const baked = bakePegsFromSamples(sampleCubicBezier(curve), {
    shape,
    spacingPx,
    brickWidth,
    pegRadius,
    rotationOffset: Number(curve.rotationOffset || 0)
  });
  node.curve.refPoints = baked.map((value, index) => ({ index, x: value.x, y: value.y }));
  const exceptions = semanticExceptions(node.lineage?.exceptions);
  const deleted = new Set(exceptions.deletedIndices);
  return baked.flatMap((value, index) => {
    if (deleted.has(index)) return [];
    const override = exceptions.overrides[String(index)];
    return [{
      index,
      x: Number.isFinite(override?.x) ? override.x : value.x,
      y: Number.isFinite(override?.y) ? override.y : value.y,
      angle: shape === 'brick' ? normalizeBrickAngle(value.angle) : 0,
      shape,
      type: curve.pegType || 'blue'
    }];
  });
}

function cleanStrokePayload(node) {
  const payload = {
    groupId: node.groupId,
    nodeId: node.nodeId,
    curve: clone(node.curve),
    lineage: clone(node.lineage)
  };
  if (payload.curve) delete payload.curve.refPoints;
  payload.lineage ||= { family: 'BezierStroke', exceptions: semanticExceptions(null) };
  payload.lineage.exceptions = semanticExceptions(null);
  return payload;
}

function curvePairs(before, after) {
  if (!before || !after) return [];
  return POINT_KEYS.map(key => ({
    sx: Number(before[key]?.x), sy: Number(before[key]?.y),
    dx: Number(after[key]?.x), dy: Number(after[key]?.y)
  })).filter(pair => Object.values(pair).every(Number.isFinite));
}

function transformMember(member, transform) {
  const moved = applySimilarityTransform(member, transform);
  const angle = transform.reflect === true
    ? Number(transform.angle || 0) - Number(member.angle || 0)
    : Number(member.angle || 0) + Number(transform.angle || 0);
  return { ...member, x: moved.x, y: moved.y, angle: member.shape === 'brick' ? normalizeBrickAngle(angle) : 0 };
}

function transformExceptions(exceptions, transform) {
  const result = semanticExceptions(exceptions);
  for (const override of Object.values(result.overrides)) {
    const moved = applySimilarityTransform(override, transform);
    override.x = moved.x;
    override.y = moved.y;
  }
  return result;
}

function changedCurveProperties(before, after) {
  const changes = {};
  for (const key of RESAMPLE_PROPERTIES) {
    if (same(before?.[key] ?? null, after?.[key] ?? null)) continue;
    changes[key] = { from: clone(before?.[key] ?? null), to: clone(after?.[key] ?? null) };
  }
  return changes;
}

function controlPointDeltas(before, after) {
  const deltas = {};
  for (const key of POINT_KEYS) {
    if (!before?.[key] || !after?.[key]) continue;
    const dx = Number(after[key].x) - Number(before[key].x);
    const dy = Number(after[key].y) - Number(before[key].y);
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) deltas[key] = { dx, dy };
  }
  return deltas;
}

function memberDifference(beforeMembers, afterMembers, thresholdPx) {
  const left = new Map((beforeMembers || []).map(member => [member.index, member]));
  const right = new Map((afterMembers || []).map(member => [member.index, member]));
  const changes = [];
  for (const index of [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b)) {
    const before = left.get(index) || null;
    const after = right.get(index) || null;
    if (!before || !after) {
      changes.push({ index, kind: before ? 'delete-member' : 'add-member', before: clone(before), after: clone(after) });
      continue;
    }
    const positionChanged = !pointsClose(before, after, thresholdPx);
    const propertyChanged = before.shape !== after.shape || before.type !== after.type
      || !close(normalizeBrickAngle(before.angle), normalizeBrickAngle(after.angle), 1e-6);
    if (positionChanged || propertyChanged) {
      changes.push({ index, kind: 'update-member', before: clone(before), after: clone(after) });
    }
  }
  return changes;
}

function classifyFallbackCause(changes, thresholdPx) {
  if (changes.length === 1) {
    return { reason: 'atomic-object-edit', languageGap: false, evidence: { changedMemberCount: 1 } };
  }
  const indices = changes.map(change => change.index).sort((a, b) => a - b);
  const contiguous = indices.every((value, index) => index === 0 || value === indices[index - 1] + 1);
  const moved = changes.filter(change => change.before && change.after);
  let coherentDisplacement = moved.length === changes.length && moved.length >= 2;
  let referenceDelta = null;
  for (const change of moved) {
    const delta = { x: change.after.x - change.before.x, y: change.after.y - change.before.y };
    referenceDelta ||= delta;
    if (Math.hypot(delta.x - referenceDelta.x, delta.y - referenceDelta.y) > thresholdPx) coherentDisplacement = false;
  }
  if (coherentDisplacement) {
    return {
      reason: 'missing-language-operation:regional-transform', languageGap: true,
      evidence: { changedMemberCount: changes.length, contiguousIndices: contiguous, coherentDisplacement: true }
    };
  }
  if (contiguous) {
    return {
      reason: 'missing-language-operation:regional-object-edit', languageGap: true,
      evidence: { changedMemberCount: changes.length, contiguousIndices: true, coherentDisplacement: false }
    };
  }
  return {
    reason: 'multiple-atomic-object-edits', languageGap: false,
    evidence: { changedMemberCount: changes.length, contiguousIndices: false, coherentDisplacement: false }
  };
}

function buildFallbackOperation(groupId, nodeId, changes, afterLineage, thresholdPx) {
  const cause = classifyFallbackCause(changes, thresholdPx);
  const expectedExceptions = semanticExceptions(afterLineage?.exceptions);
  const changedIndices = new Set(changes.map(change => change.index));
  return {
    type: 'object-exception',
    expressibility: 'fallback',
    groupId,
    nodeId,
    changes,
    exceptionState: {
      deletedIndices: expectedExceptions.deletedIndices.filter(index => changedIndices.has(index)),
      overrides: Object.fromEntries(Object.entries(expectedExceptions.overrides)
        .filter(([index]) => changedIndices.has(Number(index))))
    },
    reason: cause.reason,
    causeEvidence: cause.evidence,
    ...(cause.languageGap ? { languageGapCandidate: cause.reason } : {}),
    affectedMemberCount: changes.length
  };
}

function applyOperation(result, operation) {
  result.nodes ||= {};
  if (operation.type === 'delete-stroke') {
    delete result.nodes[operation.groupId];
    return;
  }
  if (operation.type === 'add-stroke') {
    const node = clone(operation.stroke);
    node.members = bakeNodeMembers(node);
    result.nodes[operation.groupId] = node;
    return;
  }
  const node = result.nodes[operation.groupId];
  if (!node) return;
  if (operation.type === 'transform-stroke' || operation.type === 'mirror-stroke') {
    node.curve = transformBezierCurve(node.curve, operation.transform);
    node.members = node.members.map(member => transformMember(member, operation.transform));
    if (node.lineage?.exceptions) node.lineage.exceptions = transformExceptions(node.lineage.exceptions, operation.transform);
    return;
  }
  if (operation.type === 'edit-control-points') {
    for (const [key, delta] of Object.entries(operation.deltas || {})) {
      if (!node.curve?.[key]) continue;
      node.curve[key].x += Number(delta.dx || 0);
      node.curve[key].y += Number(delta.dy || 0);
    }
    node.members = bakeNodeMembers(node);
    return;
  }
  if (operation.type === 'resample-stroke') {
    for (const [key, change] of Object.entries(operation.changes || {})) {
      if (change.to == null) delete node.curve[key];
      else node.curve[key] = clone(change.to);
    }
    node.members = bakeNodeMembers(node);
    return;
  }
  if (operation.type === 'object-exception') {
    const members = new Map((node.members || []).map(member => [member.index, member]));
    node.lineage ||= { family: 'BezierStroke', exceptions: semanticExceptions(null) };
    node.lineage.exceptions = semanticExceptions(node.lineage.exceptions);
    const expectedDeleted = new Set(operation.exceptionState?.deletedIndices || []);
    const expectedOverrides = operation.exceptionState?.overrides || {};
    for (const change of operation.changes || []) {
      if (!change.after) members.delete(change.index);
      else members.set(change.index, clone(change.after));
      node.lineage.exceptions.deletedIndices = node.lineage.exceptions.deletedIndices.filter(index => index !== change.index);
      delete node.lineage.exceptions.overrides[String(change.index)];
      if (expectedDeleted.has(change.index)) node.lineage.exceptions.deletedIndices.push(change.index);
      if (expectedOverrides[String(change.index)]) {
        node.lineage.exceptions.overrides[String(change.index)] = clone(expectedOverrides[String(change.index)]);
      }
    }
    node.lineage.exceptions.deletedIndices.sort((a, b) => a - b);
    node.members = [...members.values()].sort((left, right) => left.index - right.index);
  }
}

function nativeOperationsForNode(before, after, thresholdPx) {
  const operations = [];
  let working = clone(before);
  const fit = estimateSimilarityTransformFromPairs(curvePairs(before.curve, after.curve), {
    allowScale: true,
    allowReflection: true
  });
  if (fit && fit.maxResidualPx <= thresholdPx) {
    const operation = {
      type: fit.reflect ? 'mirror-stroke' : 'transform-stroke', expressibility: 'native',
      groupId: after.groupId, nodeId: after.nodeId,
      transform: {
        angle: fit.angle, scale: fit.scale, tx: fit.tx, ty: fit.ty,
        ...(fit.reflect ? { reflect: true } : {})
      },
      residualPx: fit.maxResidualPx,
      affectedMemberCount: before.members.length
    };
    const material = fit.reflect || Math.abs(fit.angle) > 1e-9 || Math.abs(fit.scale - 1) > 1e-9
      || Math.abs(fit.tx) > 1e-7 || Math.abs(fit.ty) > 1e-7;
    if (material) {
      const candidate = { nodes: { [after.groupId]: working } };
      applyOperation(candidate, operation);
      operations.push(operation);
      working = candidate.nodes[after.groupId];
    }
  }

  const deltas = controlPointDeltas(working.curve, after.curve);
  if (Object.keys(deltas).length > 0) {
    const operation = {
      type: 'edit-control-points', expressibility: 'native', groupId: after.groupId, nodeId: after.nodeId,
      deltas, affectedMemberCount: Math.max(working.members.length, after.members.length)
    };
    const candidate = { nodes: { [after.groupId]: working } };
    applyOperation(candidate, operation);
    operations.push(operation);
    working = candidate.nodes[after.groupId];
  }

  const changes = changedCurveProperties(working.curve, after.curve);
  if (Object.keys(changes).length > 0) {
    const operation = {
      type: 'resample-stroke', expressibility: 'native', groupId: after.groupId, nodeId: after.nodeId,
      changes, affectedMemberCount: Math.max(working.members.length, after.members.length)
    };
    const candidate = { nodes: { [after.groupId]: working } };
    applyOperation(candidate, operation);
    operations.push(operation);
    working = candidate.nodes[after.groupId];
  }

  const fallbackChanges = memberDifference(working.members, after.members, thresholdPx);
  if (fallbackChanges.length > 0) {
    const operation = buildFallbackOperation(
      after.groupId, after.nodeId, fallbackChanges, after.lineage, thresholdPx
    );
    const candidate = { nodes: { [after.groupId]: working } };
    applyOperation(candidate, operation);
    operations.push(operation);
    working = candidate.nodes[after.groupId];
  }

  if (!same(working.lineage, after.lineage)) {
    operations.push({
      type: 'metadata-only', expressibility: 'ignored', groupId: after.groupId, nodeId: after.nodeId,
      changedKeys: [...new Set([...Object.keys(working.lineage || {}), ...Object.keys(after.lineage || {})])]
        .filter(key => !same(working.lineage?.[key], after.lineage?.[key]))
    });
  }
  return operations;
}

function nodeBounds(node) {
  const members = node?.members || [];
  if (members.length === 0) return null;
  return {
    minX: Math.min(...members.map(member => member.x)), maxX: Math.max(...members.map(member => member.x)),
    minY: Math.min(...members.map(member => member.y)), maxY: Math.max(...members.map(member => member.y))
  };
}

function deletedRegionEvidence(deleted, hints) {
  if (deleted.length < 2 || !hints.some(hint => /negative|space|region|mask/i.test(hint))) return null;
  const boxes = deleted.map(operation => operation.deletedBounds).filter(Boolean);
  if (boxes.length !== deleted.length) return null;
  const centers = boxes.map(box => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }));
  const maximumDistance = Math.max(...centers.flatMap((left, index) => centers.slice(index + 1)
    .map(right => Math.hypot(left.x - right.x, left.y - right.y))), 0);
  if (maximumDistance > 180) return null;
  return { reason: 'possible-negative-space-region-delete', confidence: 'hint+geometry', maximumCenterDistancePx: maximumDistance };
}

function changedMemberKeys(before, after, thresholdPx) {
  const keys = new Set();
  const ids = new Set([...Object.keys(before?.nodes || {}), ...Object.keys(after?.nodes || {})]);
  for (const groupId of ids) {
    const left = before?.nodes?.[groupId];
    const right = after?.nodes?.[groupId];
    if (!left || !right) {
      for (const member of left?.members || right?.members || []) keys.add(`${groupId}:${member.index}`);
      continue;
    }
    for (const change of memberDifference(left.members, right.members, thresholdPx)) keys.add(`${groupId}:${change.index}`);
  }
  return keys;
}

export function diffBezierSemanticStates(before, after, options = {}) {
  const thresholdPx = Number.isFinite(options.thresholdPx) ? options.thresholdPx : DEFAULT_THRESHOLD_PX;
  const hints = Array.isArray(options.commandHints) ? options.commandHints.map(String) : [];
  const operations = [];
  const ids = new Set([...Object.keys(before?.nodes || {}), ...Object.keys(after?.nodes || {})]);
  for (const groupId of [...ids].sort()) {
    const left = before?.nodes?.[groupId];
    const right = after?.nodes?.[groupId];
    if (!left && right) {
      const operation = {
        type: 'add-stroke', expressibility: 'native', groupId, nodeId: right.nodeId,
        stroke: cleanStrokePayload(right), affectedMemberCount: right.members.length
      };
      operations.push(operation);
      const simulated = { format: 'bezier-semantic-state', version: 2, nodes: {} };
      applyOperation(simulated, operation);
      const fallbackChanges = memberDifference(simulated.nodes[groupId]?.members, right.members, thresholdPx);
      if (fallbackChanges.length) {
        operations.push(buildFallbackOperation(
          groupId, right.nodeId, fallbackChanges, right.lineage, thresholdPx
        ));
      }
      continue;
    }
    if (left && !right) {
      operations.push({
        type: 'delete-stroke', expressibility: 'native', groupId, nodeId: left.nodeId,
        affectedMemberCount: left.members.length, deletedBounds: nodeBounds(left)
      });
      continue;
    }
    if (same(left, right)) continue;
    operations.push(...nativeOperationsForNode(left, right, thresholdPx));
  }

  const deleted = operations.filter(operation => operation.type === 'delete-stroke');
  const regionEvidence = deletedRegionEvidence(deleted, hints);
  if (regionEvidence) for (const operation of deleted) operation.compressionOpportunity = regionEvidence;

  return {
    format: 'bezier-semantic-patch', version: 2, hints, operations,
    metrics: semanticPatchMetrics(operations, before, after, { thresholdPx })
  };
}

export function applyBezierSemanticPatch(state, patch) {
  const result = clone(state || { format: 'bezier-semantic-state', version: 2, nodes: {} });
  result.version = 2;
  result.nodes ||= {};
  for (const operation of patch?.operations || []) applyOperation(result, operation);
  return result;
}

export function semanticPatchMetrics(operations, before = null, after = null, options = {}) {
  const thresholdPx = Number.isFinite(options.thresholdPx) ? options.thresholdPx : DEFAULT_THRESHOLD_PX;
  const meaningful = (operations || []).filter(operation => operation.expressibility !== 'ignored');
  const fallback = meaningful.filter(operation => operation.expressibility === 'fallback');
  const fallbackReasonCounts = {};
  const languageGapReasonCounts = {};
  const fallbackChangedKeys = new Set();
  const fallbackFinalKeys = new Set();
  for (const operation of fallback) {
    const reason = operation.reason || 'unclassified';
    fallbackReasonCounts[reason] = (fallbackReasonCounts[reason] || 0) + 1;
    if (operation.languageGapCandidate) {
      languageGapReasonCounts[operation.languageGapCandidate] = (languageGapReasonCounts[operation.languageGapCandidate] || 0) + 1;
    }
    for (const change of operation.changes || []) {
      fallbackChangedKeys.add(`${operation.groupId}:${change.index}`);
      if (change.after) fallbackFinalKeys.add(`${operation.groupId}:${change.index}`);
    }
  }
  const changedKeys = before && after ? changedMemberKeys(before, after, thresholdPx) : new Set();
  const finalMemberCount = Object.values(after?.nodes || {}).reduce((sum, node) => sum + (node.members?.length || 0), 0);
  for (const [groupId, node] of Object.entries(after?.nodes || {})) {
    for (const index of Object.keys(node?.lineage?.exceptions?.overrides || {})) {
      fallbackFinalKeys.add(`${groupId}:${index}`);
    }
  }
  return {
    operationCount: meaningful.length,
    nativeOperationCount: meaningful.length - fallback.length,
    fallbackOperationCount: fallback.length,
    changedMemberCount: changedKeys.size,
    fallbackChangedMemberCount: fallbackChangedKeys.size,
    repairFallbackFraction: changedKeys.size ? fallbackChangedKeys.size / changedKeys.size : 0,
    finalMemberCount,
    fallbackFinalMemberCount: fallbackFinalKeys.size,
    stateFallbackFraction: finalMemberCount ? fallbackFinalKeys.size / finalMemberCount : 0,
    stateProgramCoverage: finalMemberCount ? 1 - fallbackFinalKeys.size / finalMemberCount : 1,
    fallbackReasonCounts,
    languageGapReasonCounts
  };
}

function compareSemanticStates(expected, actual, tolerancePx = 1e-5) {
  const ids = new Set([...Object.keys(expected?.nodes || {}), ...Object.keys(actual?.nodes || {})]);
  let strokeUnits = 0, matchedStrokeUnits = 0, memberUnits = 0, matchedMemberUnits = 0;
  for (const groupId of ids) {
    strokeUnits++;
    const left = expected?.nodes?.[groupId];
    const right = actual?.nodes?.[groupId];
    if (left && right && left.nodeId === right.nodeId
        && POINT_KEYS.every(key => pointsClose(left.curve?.[key], right.curve?.[key], tolerancePx))
        && same(changedCurveProperties(left.curve, right.curve), {})
        && same(left.lineage, right.lineage)) matchedStrokeUnits++;
    const expectedMembers = new Map((left?.members || []).map(member => [member.index, member]));
    const actualMembers = new Map((right?.members || []).map(member => [member.index, member]));
    const indices = new Set([...expectedMembers.keys(), ...actualMembers.keys()]);
    for (const index of indices) {
      memberUnits++;
      const before = expectedMembers.get(index), after = actualMembers.get(index);
      if (before && after && memberDifference([before], [after], tolerancePx).length === 0) matchedMemberUnits++;
    }
  }
  const totalUnits = strokeUnits + memberUnits;
  return {
    exact: matchedStrokeUnits === strokeUnits && matchedMemberUnits === memberUnits,
    replayAccuracy: totalUnits ? (matchedStrokeUnits + matchedMemberUnits) / totalUnits : 1,
    strokeAccuracy: strokeUnits ? matchedStrokeUnits / strokeUnits : 1,
    memberAccuracy: memberUnits ? matchedMemberUnits / memberUnits : 1
  };
}

export function semanticReplayReport(expected, actual, patch) {
  return {
    ...compareSemanticStates(expected, actual),
    repairFallbackFraction: Number(patch?.metrics?.repairFallbackFraction || 0),
    stateFallbackFraction: Number(patch?.metrics?.stateFallbackFraction || 0),
    stateProgramCoverage: Number(patch?.metrics?.stateProgramCoverage ?? 1),
    fallbackReasonCounts: clone(patch?.metrics?.fallbackReasonCounts || {})
  };
}
