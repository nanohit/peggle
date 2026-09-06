import {
  createSemanticObjectId,
  ensureLevelSemanticIdentity,
  ensureSemanticObjectNode,
  recordBezierDeletedException,
  removeBezierNode,
  removeSemanticNode
} from './bezier-program.js';

export const DECLARABLE_OBJECT_FAMILIES = Object.freeze([
  { value: 'Ring', label: 'Ring', minimumMembers: 5 },
  { value: 'Polygon', label: 'Polygon', minimumMembers: 3 },
  { value: 'Line', label: 'Line', minimumMembers: 2 },
  { value: 'Arc', label: 'Arc', minimumMembers: 3 },
  { value: 'LiteralCluster', label: 'Cluster', minimumMembers: 1 }
]);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function finitePoint(peg) {
  return peg && Number.isFinite(peg.x) && Number.isFinite(peg.y);
}

function centroid(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function residualStats(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { rmsResidualPx: Infinity, maxResidualPx: Infinity };
  return {
    rmsResidualPx: Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length),
    maxResidualPx: Math.max(...finite)
  };
}

function solve3(matrix, vector) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-9) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let index = column; index < 4; index++) a[column][index] /= divisor;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let index = column; index < 4; index++) a[row][index] -= factor * a[column][index];
    }
  }
  return a.map(row => row[3]);
}

function fitCircle(points) {
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  let sz = 0, sxz = 0, syz = 0;
  for (const point of points) {
    const z = -(point.x * point.x + point.y * point.y);
    sx += point.x; sy += point.y; sxx += point.x * point.x;
    syy += point.y * point.y; sxy += point.x * point.y;
    sz += z; sxz += point.x * z; syz += point.y * z;
  }
  const solution = solve3(
    [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]],
    [sxz, syz, sz]
  );
  if (!solution) return null;
  const [a, b, c] = solution;
  const center = { x: -a / 2, y: -b / 2 };
  const radiusSquared = center.x * center.x + center.y * center.y - c;
  if (!(radiusSquared > 0)) return null;
  const radius = Math.sqrt(radiusSquared);
  const stats = residualStats(points.map(point => Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - radius)));
  const angles = points.map(point => Math.atan2(point.y - center.y, point.x - center.x));
  const sorted = [...angles].sort((left, right) => left - right);
  let largestGap = 0;
  let gapEnd = sorted[0] || 0;
  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index];
    const next = index === sorted.length - 1 ? sorted[0] + Math.PI * 2 : sorted[index + 1];
    if (next - current > largestGap) {
      largestGap = next - current;
      gapEnd = next;
    }
  }
  return {
    center, radius, angles,
    phase: sorted[0] || 0,
    coveredAngle: Math.PI * 2 - largestGap,
    arcStart: gapEnd % (Math.PI * 2),
    ...stats
  };
}

function fitLine(points) {
  const center = centroid(points);
  let xx = 0, yy = 0, xy = 0;
  for (const point of points) {
    const dx = point.x - center.x, dy = point.y - center.y;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };
  const projections = points.map(point => (
    (point.x - center.x) * direction.x + (point.y - center.y) * direction.y
  ));
  const residuals = points.map(point => Math.abs(
    (point.x - center.x) * normal.x + (point.y - center.y) * normal.y
  ));
  return {
    definition: {
      center, direction,
      startOffset: Math.min(...projections), endOffset: Math.max(...projections),
      memberOffsets: projections
    },
    ...residualStats(residuals)
  };
}

function cross(origin, left, right) {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

function convexHull(points) {
  const sorted = [...points].sort((left, right) => (left.x - right.x) || (left.y - right.y));
  if (sorted.length <= 2) return sorted;
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (const point of sorted.slice().reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function fitPolygon(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  const residuals = points.map(point => Math.min(...hull.map((start, index) => (
    distanceToSegment(point, start, hull[(index + 1) % hull.length])
  ))));
  return {
    definition: { center: centroid(points), vertices: hull.map(point => ({ x: point.x, y: point.y })) },
    ...residualStats(residuals)
  };
}

export function fitSemanticObject(pegs, requestedFamily, options = {}) {
  const points = (pegs || []).filter(finitePoint);
  const family = requestedFamily === 'Cluster' ? 'LiteralCluster' : requestedFamily;
  const config = DECLARABLE_OBJECT_FAMILIES.find(entry => entry.value === family);
  if (!config) return { accepted: false, family, reason: 'unsupported-family' };
  if (points.length < config.minimumMembers) {
    return { accepted: false, family, reason: 'insufficient-members', memberCount: points.length };
  }
  const thresholdPx = Number.isFinite(options.thresholdPx) ? options.thresholdPx : 4;
  if (family === 'LiteralCluster') {
    const center = centroid(points);
    return {
      accepted: true, requestedFamily, family, literalFallback: true,
      definition: {
        center,
        memberOffsets: points.map(point => ({ x: point.x - center.x, y: point.y - center.y }))
      },
      diagnostics: { memberCount: points.length, rmsResidualPx: 0, maxResidualPx: 0 }
    };
  }
  if (family === 'Line') {
    const fit = fitLine(points);
    return {
      accepted: fit.maxResidualPx <= thresholdPx, requestedFamily, family,
      reason: fit.maxResidualPx <= thresholdPx ? null : 'fit-residual-too-large',
      definition: fit.definition,
      diagnostics: { memberCount: points.length, rmsResidualPx: fit.rmsResidualPx, maxResidualPx: fit.maxResidualPx, thresholdPx }
    };
  }
  if (family === 'Ring' || family === 'Arc') {
    const fit = fitCircle(points);
    if (!fit) return { accepted: false, requestedFamily, family, reason: 'degenerate-circle-fit' };
    const ringCoverageOk = family !== 'Ring' || fit.coveredAngle >= Math.PI * 1.5;
    const arcCoverageOk = family !== 'Arc' || fit.coveredAngle < Math.PI * 1.95;
    const accepted = fit.maxResidualPx <= thresholdPx && ringCoverageOk && arcCoverageOk;
    return {
      accepted, requestedFamily, family,
      reason: fit.maxResidualPx > thresholdPx ? 'fit-residual-too-large'
        : (!ringCoverageOk ? 'insufficient-ring-coverage' : (!arcCoverageOk ? 'arc-is-closed' : null)),
      definition: {
        center: fit.center, radius: fit.radius,
        phase: fit.phase, coveredAngle: fit.coveredAngle, arcStart: fit.arcStart,
        memberAngles: fit.angles
      },
      diagnostics: {
        memberCount: points.length, rmsResidualPx: fit.rmsResidualPx,
        maxResidualPx: fit.maxResidualPx, thresholdPx, coveredAngle: fit.coveredAngle
      }
    };
  }
  const fit = fitPolygon(points);
  if (!fit) return { accepted: false, requestedFamily, family, reason: 'degenerate-polygon-fit' };
  return {
    accepted: fit.maxResidualPx <= thresholdPx, requestedFamily, family,
    reason: fit.maxResidualPx <= thresholdPx ? null : 'fit-residual-too-large',
    definition: fit.definition,
    diagnostics: { memberCount: points.length, rmsResidualPx: fit.rmsResidualPx, maxResidualPx: fit.maxResidualPx, thresholdPx }
  };
}

export function declareSemanticObject(level, selectedPegIds, requestedFamily, options = {}) {
  ensureLevelSemanticIdentity(level);
  const selectedIds = new Set(selectedPegIds || []);
  const pegs = (level?.pegs || []).filter(peg => selectedIds.has(peg.id));
  const requestedFit = fitSemanticObject(pegs, requestedFamily, options);
  let fit = requestedFit;
  if (!fit.accepted && options.fallbackToLiteral !== false && requestedFamily !== 'Cluster'
      && requestedFamily !== 'LiteralCluster' && pegs.length > 0) {
    fit = fitSemanticObject(pegs, 'LiteralCluster', options);
    fit.requestedFamily = requestedFamily;
    fit.fallbackReason = requestedFit.reason;
    fit.requestedFit = clone(requestedFit.diagnostics || null);
  }
  if (!fit.accepted) return { ok: false, fit: requestedFit };

  const program = level.metadata.generatorProgram;
  const sourceObjectIds = [...new Set(pegs.map(peg => peg.objectId))];
  const objectId = createSemanticObjectId(fit.family === 'LiteralCluster' ? 'cluster' : fit.family.toLowerCase());
  const selectedMemberIds = new Set(pegs.map(peg => peg.memberId));
  const touchedBezierGroups = new Set();

  for (const peg of pegs) {
    if (peg.bezierGroupId && Number.isFinite(peg.bezierIndex)) {
      touchedBezierGroups.add(String(peg.bezierGroupId));
      recordBezierDeletedException(level, peg.bezierGroupId, peg.bezierIndex);
    }
    peg.objectId = objectId;
    peg.bezierGroupId = null;
    peg.bezierIndex = null;
  }

  for (const sourceObjectId of sourceObjectIds) {
    const survivors = level.pegs.filter(peg => peg.objectId === sourceObjectId);
    if (survivors.length === 0) removeSemanticNode(level, sourceObjectId);
  }
  for (const groupId of touchedBezierGroups) {
    if (level.pegs.some(peg => peg.bezierGroupId === groupId)) continue;
    delete level.bezierCurves[groupId];
    removeBezierNode(level, groupId);
  }

  const node = ensureSemanticObjectNode(level, objectId, fit.family);
  node.family = fit.family;
  node.definition = clone(fit.definition);
  node.definition.memberIds = pegs.map(peg => peg.memberId);
  node.memberIds = [...selectedMemberIds];
  node.declared = true;
  node.fit = clone(fit.diagnostics);
  node.literalFallback = fit.literalFallback === true;
  program.declarationLog.push({
    sequence: program.declarationLog.length,
    at: options.at || new Date().toISOString(),
    action: 'combine-into-object',
    requestedFamily,
    family: fit.family,
    objectId,
    sourceObjectIds,
    memberIds: [...selectedMemberIds],
    fit: clone(fit.diagnostics),
    literalFallback: fit.literalFallback === true,
    fallbackReason: fit.fallbackReason || null
  });
  ensureLevelSemanticIdentity(level);
  return { ok: true, objectId, node, fit, sourceObjectIds, requestedFit };
}

export function describeSemanticSelection(level, selectedPegIds) {
  ensureLevelSemanticIdentity(level);
  const selectedIds = new Set(selectedPegIds || []);
  const selected = (level?.pegs || []).filter(peg => selectedIds.has(peg.id));
  if (!selected.length) return { text: '', selectedCount: 0, objects: [] };
  const byObject = new Map();
  for (const peg of level.pegs) {
    if (!byObject.has(peg.objectId)) byObject.set(peg.objectId, { total: 0, selected: 0 });
    const entry = byObject.get(peg.objectId);
    entry.total++;
    if (selectedIds.has(peg.id)) entry.selected++;
  }
  const objects = [...new Set(selected.map(peg => peg.objectId))].map(objectId => {
    const counts = byObject.get(objectId);
    const node = level.metadata.generatorProgram.nodes[objectId];
    return {
      objectId,
      family: node?.family || 'LiteralCluster',
      selected: counts.selected,
      total: counts.total,
      whole: counts.selected === counts.total
    };
  });
  if (objects.length === 1) {
    const object = objects[0];
    return {
      selectedCount: selected.length, objects,
      text: object.whole
        ? `${object.total} pegs — whole object (${object.family})`
        : `${object.selected} of ${object.total} pegs — partial object (${object.family})`
    };
  }
  const whole = objects.filter(object => object.whole).length;
  return {
    selectedCount: selected.length, objects,
    text: `${selected.length} pegs — ${objects.length} objects (${whole} whole, ${objects.length - whole} partial)`
  };
}
