const EPSILON = 1e-9;
export const REPAIR_RELATION_METHOD = Object.freeze({
  version: 1,
  geometry: 'peg centers; field-normalized where reported',
  mirror: 'mean same-shape nearest-neighbor error after reflection across launcher axis; score reaches zero at 12% of field diagonal',
  localDensity: 'mean external peg centers within max(50px, 8.5% of field diagonal)',
  negativeSpace: 'occupied peg-center cells and largest empty axis-aligned rectangle on an 8x12 grid',
  orientation: 'principal component axis; omitted below 0.05 anisotropy',
  detailedObjects: 'three highest-salience changed objects per candidate; distributions cover all changed objects'
});

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function round(value, digits = 4) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function deviation(values, average = mean(values)) {
  return values.length
    ? Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length)
    : 0;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function uniqueMembers(state) {
  const members = new Map();
  for (const [objectId, node] of Object.entries(state?.nodes || {})) {
    for (const member of node?.members || []) {
      const memberId = String(member.memberId || `${objectId}:${member.index}`);
      if (!members.has(memberId)) members.set(memberId, {
        ...member,
        memberId,
        objectId,
        x: finite(member.x),
        y: finite(member.y),
        shape: member.shape || 'circle'
      });
    }
  }
  return [...members.values()];
}

function bounds(points, width, height) {
  if (!points.length) return {
    minX: 0, maxX: 0, minY: 0, maxY: 0,
    width: 0, height: 0, coverageX: 0, coverageY: 0
  };
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    minX: round(minX, 2), maxX: round(maxX, 2),
    minY: round(minY, 2), maxY: round(maxY, 2),
    width: round(maxX - minX, 2), height: round(maxY - minY, 2),
    coverageX: round((maxX - minX) / width), coverageY: round((maxY - minY) / height)
  };
}

function nearestDistances(points) {
  return points.map((point, index) => {
    let nearest = Infinity;
    for (let other = 0; other < points.length; other++) {
      if (other === index) continue;
      nearest = Math.min(nearest, Math.hypot(point.x - points[other].x, point.y - points[other].y));
    }
    return Number.isFinite(nearest) ? nearest : 0;
  });
}

function mirrorStatistics(points, axisX, diagonal, candidates = points) {
  if (points.length < 2) return { score: 0, meanErrorPx: null, medianErrorPx: null };
  const errors = points.map(point => {
    const mirrorX = 2 * axisX - point.x;
    let nearest = Infinity;
    for (const other of candidates) {
      if (other.shape !== point.shape) continue;
      nearest = Math.min(nearest, Math.hypot(mirrorX - other.x, point.y - other.y));
    }
    return Number.isFinite(nearest) ? nearest : diagonal;
  });
  const average = mean(errors);
  return {
    score: round(1 - clamp((average / diagonal) / 0.12)),
    meanErrorPx: round(average, 2),
    medianErrorPx: round(median(errors), 2)
  };
}

function largestEmptyGridRectangle(points, width, height, columns = 8, rows = 12) {
  const occupied = Array.from({ length: rows }, () => Array.from({ length: columns }, () => false));
  for (const point of points) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor((point.x / width) * columns)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((point.y / height) * rows)));
    occupied[row][column] = true;
  }
  let best = { area: 0, left: 0, right: 0, top: 0, bottom: 0 };
  for (let top = 0; top < rows; top++) {
    const available = Array.from({ length: columns }, () => true);
    for (let bottom = top; bottom < rows; bottom++) {
      for (let column = 0; column < columns; column++) available[column] &&= !occupied[bottom][column];
      let start = 0;
      while (start < columns) {
        while (start < columns && !available[start]) start++;
        let end = start;
        while (end < columns && available[end]) end++;
        const area = (end - start) * (bottom - top + 1);
        if (area > best.area) best = { area, left: start, right: end, top, bottom: bottom + 1 };
        start = end + 1;
      }
    }
  }
  const occupiedCells = occupied.flat().filter(Boolean).length;
  return {
    centerOccupancyFraction: round(occupiedCells / (columns * rows)),
    largestEmptyRectangleFraction: round(best.area / (columns * rows)),
    largestEmptyRectangle: {
      x: round(best.left / columns), y: round(best.top / rows),
      width: round((best.right - best.left) / columns),
      height: round((best.bottom - best.top) / rows)
    },
    grid: `${columns}x${rows}`
  };
}

function principalOrientation(points) {
  if (points.length < 2) return { angleDegrees: null, anisotropy: 0 };
  const centerX = mean(points.map(point => point.x));
  const centerY = mean(points.map(point => point.y));
  const xx = mean(points.map(point => (point.x - centerX) ** 2));
  const yy = mean(points.map(point => (point.y - centerY) ** 2));
  const xy = mean(points.map(point => (point.x - centerX) * (point.y - centerY)));
  const root = Math.hypot(xx - yy, 2 * xy);
  const total = xx + yy;
  const anisotropy = total > EPSILON ? root / total : 0;
  let angle = 0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI;
  if (angle < 0) angle += 180;
  return {
    angleDegrees: anisotropy >= 0.05 ? round(angle, 2) : null,
    anisotropy: round(anisotropy)
  };
}

function objectSeparation(leftMembers, rightMembers) {
  let nearest = Infinity;
  for (const left of leftMembers) {
    for (const right of rightMembers) nearest = Math.min(nearest, Math.hypot(left.x - right.x, left.y - right.y));
  }
  return Number.isFinite(nearest) ? nearest : null;
}

function objectDescriptor(objectId, state, context) {
  const node = state?.nodes?.[objectId];
  if (!node) return null;
  const members = (node.members || []).map(member => ({
    ...member, x: finite(member.x), y: finite(member.y), shape: member.shape || 'circle'
  }));
  const xs = members.map(member => member.x), ys = members.map(member => member.y);
  const centroid = {
    x: mean(xs), y: mean(ys)
  };
  const radius = Math.max(50, context.diagonal * 0.085);
  const externalMembers = context.members.filter(member => member.objectId !== objectId);
  const localExternalCounts = members.map(member => externalMembers.filter(other => (
    Math.hypot(member.x - other.x, member.y - other.y) <= radius
  )).length);
  const nearestObjects = Object.entries(state.nodes || {})
    .filter(([otherId]) => otherId !== objectId)
    .map(([otherId, other]) => ({
      objectId: otherId,
      distancePx: objectSeparation(members, other.members || [])
    }))
    .filter(entry => entry.distancePx != null)
    .sort((left, right) => left.distancePx - right.distancePx || left.objectId.localeCompare(right.objectId))
    .slice(0, 2)
    .map(entry => ({ ...entry, distancePx: round(entry.distancePx, 2) }));
  const objectBounds = bounds(members, context.width, context.height);
  return {
    family: node.family || null,
    memberCount: members.length,
    centroid: { x: round(centroid.x, 2), y: round(centroid.y, 2) },
    bounds: { width: objectBounds.width, height: objectBounds.height },
    orientation: principalOrientation(members),
    axisOffsetPx: round(centroid.x - context.axisX, 2),
    neighborhood: {
      localDensity: round(mean(localExternalCounts), 2),
      nearestObjects
    },
    mirror: (() => {
      const value = mirrorStatistics(members, context.axisX, context.diagonal, context.members);
      return { score: value.score, meanErrorPx: value.meanErrorPx };
    })()
  };
}

function levelDescriptor(state, options = {}) {
  const width = Math.max(1, finite(options.width, 400));
  const height = Math.max(1, finite(options.height, 600));
  const axisX = finite(options.axisX, width / 2);
  const launcherY = finite(options.launcherY, 40);
  const diagonal = Math.hypot(width, height);
  const members = uniqueMembers(state);
  const xs = members.map(member => member.x), ys = members.map(member => member.y);
  const centerX = mean(xs), centerY = mean(ys);
  const nearest = nearestDistances(members);
  const nearestMean = mean(nearest);
  const memberBounds = bounds(members, width, height);
  const shapeCounts = Object.fromEntries(tallyStrings(members.map(member => member.shape)));
  return {
    field: { width, height, launcherAxisX: axisX, launcherY },
    memberCount: members.length,
    objectCount: Object.keys(state?.nodes || {}).length,
    shapeCounts,
    centroid: {
      x: round(centerX, 2), y: round(centerY, 2),
      normalizedX: round(centerX / width), normalizedY: round(centerY / height),
      signedAxisOffsetPx: round(centerX - axisX, 2)
    },
    bounds: memberBounds,
    nearestNeighbor: {
      meanPx: round(nearestMean, 2), medianPx: round(median(nearest), 2),
      coefficientOfVariation: round(nearestMean > EPSILON ? deviation(nearest, nearestMean) / nearestMean : 0)
    },
    mirror: mirrorStatistics(members, axisX, diagonal),
    negativeSpace: {
      topOpeningPx: round(members.length ? Math.min(...ys) : height, 2),
      topOpeningFraction: round((members.length ? Math.min(...ys) : height) / height),
      ...largestEmptyGridRectangle(members, width, height)
    },
    _context: { members, width, height, axisX, launcherY, diagonal }
  };
}

function tallyStrings(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function orientationDelta(before, after) {
  if (before == null || after == null) return null;
  let delta = after - before;
  while (delta > 90) delta -= 180;
  while (delta <= -90) delta += 180;
  return round(delta, 2);
}

function objectDelta(before, after, width, height) {
  if (!before || !after) return null;
  const centroidDxPx = after.centroid.x - before.centroid.x;
  const centroidDyPx = after.centroid.y - before.centroid.y;
  return {
    centroidDxPx: round(centroidDxPx, 2),
    centroidDyPx: round(centroidDyPx, 2),
    centroidDistancePx: round(Math.hypot(centroidDxPx, centroidDyPx), 2),
    centroidDxNormalized: round(centroidDxPx / width),
    centroidDyNormalized: round(centroidDyPx / height),
    boundsWidthRatio: round(before.bounds.width > EPSILON ? after.bounds.width / before.bounds.width : null),
    boundsHeightRatio: round(before.bounds.height > EPSILON ? after.bounds.height / before.bounds.height : null),
    orientationDeltaDegrees: orientationDelta(before.orientation.angleDegrees, after.orientation.angleDegrees),
    nearestObjectDistanceDeltaPx: round(
      (after.neighborhood.nearestObjects[0]?.distancePx ?? 0)
      - (before.neighborhood.nearestObjects[0]?.distancePx ?? 0), 2
    ),
    localDensityDelta: round(
      after.neighborhood.localDensity - before.neighborhood.localDensity, 2
    ),
    mirrorScoreDelta: round(after.mirror.score - before.mirror.score)
  };
}

function summarizeChangedObjects(objects, reportedCount) {
  const statusCounts = Object.fromEntries(tallyStrings(objects.map(object => object.status)));
  const familyCounts = Object.fromEntries(tallyStrings(objects
    .map(object => object.after?.family || object.before?.family || 'unknown')));
  const changed = objects.filter(object => object.delta);
  const values = key => changed.map(object => object.delta[key]).filter(Number.isFinite);
  const towardAxis = changed.filter(object => (
    Math.abs(object.after.axisOffsetPx) + 1e-6 < Math.abs(object.before.axisOffsetPx)
  )).length;
  const awayFromAxis = changed.filter(object => (
    Math.abs(object.after.axisOffsetPx) > Math.abs(object.before.axisOffsetPx) + 1e-6
  )).length;
  const mirrorImproved = changed.filter(object => object.delta.mirrorScoreDelta > 1e-4).length;
  const mirrorWorsened = changed.filter(object => object.delta.mirrorScoreDelta < -1e-4).length;
  return {
    total: objects.length,
    reported: reportedCount,
    omitted: Math.max(0, objects.length - reportedCount),
    selection: objects.length > reportedCount
      ? 'added/deleted first, then largest normalized centroid/orientation/mirror/density changes; exact omitted objects remain available by drill-down'
      : 'all',
    statusCounts,
    familyCounts,
    deltaDistribution: {
      meanCentroidDxPx: round(mean(values('centroidDxPx')), 2),
      meanCentroidDyPx: round(mean(values('centroidDyPx')), 2),
      medianCentroidDistancePx: round(median(values('centroidDistancePx')), 2),
      maxCentroidDistancePx: round(Math.max(0, ...values('centroidDistancePx')), 2),
      medianAbsoluteOrientationDeltaDegrees: round(median(values('orientationDeltaDegrees').map(Math.abs)), 2),
      meanMirrorScoreDelta: round(mean(values('mirrorScoreDelta'))),
      medianLocalDensityDelta: round(median(values('localDensityDelta')), 2),
      towardLauncherAxisCount: towardAxis,
      awayFromLauncherAxisCount: awayFromAxis,
      mirrorImprovedCount: mirrorImproved,
      mirrorWorsenedCount: mirrorWorsened,
      totalMemberCountDelta: objects.reduce((sum, object) => (
        sum + Number((object.after?.memberCount || 0) - (object.before?.memberCount || 0))
      ), 0)
    }
  };
}

function changedObjectSalience(object, width, height) {
  if (object.status === 'added' || object.status === 'deleted') return 1e6 + Math.max(
    object.before?.memberCount || 0, object.after?.memberCount || 0
  );
  if (!object.delta) return 0;
  return object.delta.centroidDistancePx / Math.hypot(width, height)
    + Math.abs(object.delta.orientationDeltaDegrees || 0) / 180
    + Math.abs(object.delta.mirrorScoreDelta || 0)
    + Math.abs(object.delta.localDensityDelta || 0) / 20
    + Math.abs((object.after?.memberCount || 0) - (object.before?.memberCount || 0)) / 20;
}

function stripContext(descriptor) {
  const { _context: _ignored, ...result } = descriptor;
  return result;
}

function globalDelta(before, after) {
  return {
    memberCount: after.memberCount - before.memberCount,
    objectCount: after.objectCount - before.objectCount,
    centroidDxPx: round(after.centroid.x - before.centroid.x, 2),
    centroidDyPx: round(after.centroid.y - before.centroid.y, 2),
    coverageX: round(after.bounds.coverageX - before.bounds.coverageX),
    coverageY: round(after.bounds.coverageY - before.bounds.coverageY),
    topOpeningPx: round(after.negativeSpace.topOpeningPx - before.negativeSpace.topOpeningPx, 2),
    centerOccupancyFraction: round(
      after.negativeSpace.centerOccupancyFraction - before.negativeSpace.centerOccupancyFraction
    ),
    largestEmptyRectangleFraction: round(
      after.negativeSpace.largestEmptyRectangleFraction - before.negativeSpace.largestEmptyRectangleFraction
    ),
    mirrorScore: round(after.mirror.score - before.mirror.score),
    mirrorMeanErrorPx: round((after.mirror.meanErrorPx ?? 0) - (before.mirror.meanErrorPx ?? 0), 2),
    nearestNeighborMeanPx: round(after.nearestNeighbor.meanPx - before.nearestNeighbor.meanPx, 2)
  };
}

export function describeRepairRelations(beforeState, afterState, operations, options = {}) {
  const beforeGlobal = levelDescriptor(beforeState, options);
  const afterGlobal = levelDescriptor(afterState, options);
  const objectIds = [...new Set((operations || [])
    .map(operation => operation?.objectId || operation?.groupId)
    .filter(Boolean))].sort();
  const objects = objectIds.map(objectId => {
    const before = objectDescriptor(objectId, beforeState, beforeGlobal._context);
    const after = objectDescriptor(objectId, afterState, afterGlobal._context);
    return {
      objectId,
      status: before && after ? 'changed' : before ? 'deleted' : after ? 'added' : 'context-only',
      before,
      after,
      delta: objectDelta(before, after, beforeGlobal._context.width, beforeGlobal._context.height)
    };
  });
  const detailLimit = Math.max(0, Math.floor(finite(options.changedObjectDetailLimit, 8)));
  const selectedObjects = [...objects]
    .sort((left, right) => (
      changedObjectSalience(right, beforeGlobal._context.width, beforeGlobal._context.height)
      - changedObjectSalience(left, beforeGlobal._context.width, beforeGlobal._context.height)
      || left.objectId.localeCompare(right.objectId)
    ))
    .slice(0, detailLimit)
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  return {
    global: {
      before: stripContext(beforeGlobal),
      after: stripContext(afterGlobal),
      delta: globalDelta(beforeGlobal, afterGlobal)
    },
    changedObjectSummary: summarizeChangedObjects(objects, selectedObjects.length),
    changedObjects: selectedObjects
  };
}
