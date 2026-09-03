import { applySimilarityTransform, estimateSimilarityTransformFromPairs } from './bezier-geometry.js';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function point(value) {
  return { x: Number(value?.x || 0), y: Number(value?.y || 0) };
}

function memberSnapshot(peg) {
  return {
    index: Number(peg.bezierIndex),
    x: Number(peg.x),
    y: Number(peg.y),
    angle: Number(peg.angle || 0),
    shape: peg.shape || 'circle',
    type: peg.type || 'blue'
  };
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
      lineage: clone(lineage[groupId] || null),
      members: groupMembers
    };
  }
  return { format: 'bezier-semantic-state', version: 1, nodes };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function curvePairs(before, after) {
  const pairs = [];
  for (const key of ['start', 'end', 'h1', 'h2']) {
    if (!before?.[key] || !after?.[key]) return [];
    pairs.push({ sx: before[key].x, sy: before[key].y, dx: after[key].x, dy: after[key].y });
  }
  return pairs;
}

function curveNonGeometry(curve) {
  if (!curve) return null;
  const copy = clone(curve);
  for (const key of ['start', 'end', 'h1', 'h2', 'refPoints']) delete copy[key];
  return copy;
}

function memberTransformResidual(before, after, transform) {
  const afterByIndex = new Map((after || []).map(member => [member.index, member]));
  let maximum = 0;
  for (const member of before || []) {
    const destination = afterByIndex.get(member.index);
    if (!destination) return Infinity;
    const transformed = applySimilarityTransform(member, transform);
    maximum = Math.max(maximum, Math.hypot(transformed.x - destination.x, transformed.y - destination.y));
  }
  return maximum;
}

function classifyNodeUpdate(before, after, thresholdPx) {
  const beforeCurve = before.curve;
  const afterCurve = after.curve;
  if (beforeCurve && afterCurve) {
    const shapeChanged = beforeCurve.pegShape !== afterCurve.pegShape;
    const spacingChanged = Number(beforeCurve.spacingPx || 0) !== Number(afterCurve.spacingPx || 0);
    if (shapeChanged || spacingChanged || before.members.length !== after.members.length) {
      return {
        type: 'resample-stroke',
        expressibility: 'native',
        changes: {
          shape: shapeChanged ? { before: beforeCurve.pegShape, after: afterCurve.pegShape } : null,
          spacingPx: spacingChanged ? { before: beforeCurve.spacingPx, after: afterCurve.spacingPx } : null,
          memberCount: before.members.length === after.members.length ? null : { before: before.members.length, after: after.members.length }
        }
      };
    }
    const fit = estimateSimilarityTransformFromPairs(curvePairs(beforeCurve, afterCurve), { allowScale: true });
    const memberResidualPx = fit ? memberTransformResidual(before.members, after.members, fit) : Infinity;
    if (fit && fit.maxResidualPx <= thresholdPx && memberResidualPx <= thresholdPx
        && same(curveNonGeometry(beforeCurve), curveNonGeometry(afterCurve))) {
      return {
        type: 'transform-stroke',
        expressibility: 'native',
        transform: { angle: fit.angle, scale: fit.scale, tx: fit.tx, ty: fit.ty },
        residualPx: Math.max(fit.maxResidualPx, memberResidualPx)
      };
    }
    if (!same(beforeCurve, afterCurve)) {
      return { type: 'update-stroke', expressibility: 'native' };
    }
  }
  if (!same(before.lineage?.exceptions, after.lineage?.exceptions) || !same(before.members, after.members)) {
    return {
      type: 'object-exception',
      expressibility: 'fallback',
      reason: 'unclassified-fallback'
    };
  }
  return { type: 'metadata-only', expressibility: 'ignored' };
}

export function diffBezierSemanticStates(before, after, options = {}) {
  const thresholdPx = Number.isFinite(options.thresholdPx) ? options.thresholdPx : 1;
  const hints = Array.isArray(options.commandHints) ? options.commandHints.map(String) : [];
  const operations = [];
  const ids = new Set([...Object.keys(before?.nodes || {}), ...Object.keys(after?.nodes || {})]);
  for (const groupId of [...ids].sort()) {
    const left = before?.nodes?.[groupId];
    const right = after?.nodes?.[groupId];
    if (!left && right) {
      operations.push({ type: 'add-stroke', expressibility: 'native', groupId, nodeId: right.nodeId, after: clone(right) });
      continue;
    }
    if (left && !right) {
      operations.push({ type: 'delete-stroke', expressibility: 'native', groupId, nodeId: left.nodeId, before: clone(left) });
      continue;
    }
    if (same(left, right)) continue;
    operations.push({
      ...classifyNodeUpdate(left, right, thresholdPx),
      groupId,
      nodeId: right.nodeId || left.nodeId,
      before: clone(left),
      after: clone(right)
    });
  }
  const fallbackOperations = operations.filter(operation => operation.expressibility === 'fallback');
  for (const operation of fallbackOperations) {
    operation.reason = fallbackOperations.length === 1
      ? 'atomic-object-edit'
      : 'missing-language-operation:regional-or-bulk-object-edit';
  }
  const deletedStrokes = operations.filter(operation => operation.type === 'delete-stroke');
  if (deletedStrokes.length >= 2) {
    for (const operation of deletedStrokes) {
      operation.languageGapCandidate = 'missing-language-operation:negative-space-or-region-delete';
    }
  }
  return {
    format: 'bezier-semantic-patch',
    version: 1,
    hints,
    operations,
    metrics: semanticPatchMetrics(operations)
  };
}

export function applyBezierSemanticPatch(state, patch) {
  const result = clone(state || { format: 'bezier-semantic-state', version: 1, nodes: {} });
  result.nodes ||= {};
  for (const operation of patch?.operations || []) {
    if (operation.type === 'delete-stroke') delete result.nodes[operation.groupId];
    else if (operation.after) result.nodes[operation.groupId] = clone(operation.after);
  }
  return result;
}

export function semanticPatchMetrics(operations) {
  const meaningful = (operations || []).filter(operation => operation.expressibility !== 'ignored');
  const fallback = meaningful.filter(operation => operation.expressibility === 'fallback');
  const reasonCounts = {};
  const languageGapReasonCounts = {};
  for (const operation of fallback) {
    const reason = operation.reason || 'unclassified';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  for (const operation of meaningful) {
    if (!operation.languageGapCandidate) continue;
    languageGapReasonCounts[operation.languageGapCandidate] = (languageGapReasonCounts[operation.languageGapCandidate] || 0) + 1;
  }
  return {
    operationCount: meaningful.length,
    nativeOperationCount: meaningful.length - fallback.length,
    fallbackOperationCount: fallback.length,
    fallbackFraction: meaningful.length ? fallback.length / meaningful.length : 0,
    fallbackReasonCounts: reasonCounts,
    languageGapReasonCounts
  };
}

export function semanticReplayReport(expected, actual, patch) {
  const expectedText = JSON.stringify(expected);
  const actualText = JSON.stringify(actual);
  return {
    exact: expectedText === actualText,
    replayAccuracy: expectedText === actualText ? 1 : 0,
    fallbackFraction: Number(patch?.metrics?.fallbackFraction || 0),
    fallbackReasonCounts: clone(patch?.metrics?.fallbackReasonCounts || {})
  };
}
