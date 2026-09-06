import { runShotSweep } from '../../benchmark/lib/sweep.mjs';
import { validateResearchRecord } from '../../tools/validate-record.mjs';

const DEFAULT_RADIUS = 8.5;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function footprint(object, padding = 0) {
  if (object.kind === 'circle') {
    return {
      kind: 'circle',
      x: finite(object.transform?.x),
      y: finite(object.transform?.y),
      radius: finite(object.geometry?.radius, DEFAULT_RADIUS) + padding
    };
  }
  return {
    kind: 'rectangle',
    x: finite(object.transform?.x),
    y: finite(object.transform?.y),
    rotation: finite(object.transform?.rotation),
    halfWidth: finite(object.geometry?.width, 34) / 2 + padding,
    halfHeight: finite(object.geometry?.height, 10.2) / 2 + padding
  };
}

function rectangleCorners(shape) {
  const cos = Math.cos(shape.rotation);
  const sin = Math.sin(shape.rotation);
  return [
    [-shape.halfWidth, -shape.halfHeight],
    [shape.halfWidth, -shape.halfHeight],
    [shape.halfWidth, shape.halfHeight],
    [-shape.halfWidth, shape.halfHeight]
  ].map(([x, y]) => ({
    x: shape.x + x * cos - y * sin,
    y: shape.y + x * sin + y * cos
  }));
}

function boundsFor(shape) {
  if (shape.kind === 'circle') {
    return {
      minX: shape.x - shape.radius,
      maxX: shape.x + shape.radius,
      minY: shape.y - shape.radius,
      maxY: shape.y + shape.radius
    };
  }
  const corners = rectangleCorners(shape);
  return {
    minX: Math.min(...corners.map(point => point.x)),
    maxX: Math.max(...corners.map(point => point.x)),
    minY: Math.min(...corners.map(point => point.y)),
    maxY: Math.max(...corners.map(point => point.y))
  };
}

function circleCircle(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y) < left.radius + right.radius;
}

function circleRectangle(circle, rectangle) {
  const cos = Math.cos(-rectangle.rotation);
  const sin = Math.sin(-rectangle.rotation);
  const dx = circle.x - rectangle.x;
  const dy = circle.y - rectangle.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  const closestX = clamp(localX, -rectangle.halfWidth, rectangle.halfWidth);
  const closestY = clamp(localY, -rectangle.halfHeight, rectangle.halfHeight);
  return Math.hypot(localX - closestX, localY - closestY) < circle.radius;
}

function rectangleRectangle(left, right) {
  const leftCorners = rectangleCorners(left);
  const rightCorners = rectangleCorners(right);
  const axes = [left.rotation, left.rotation + Math.PI / 2, right.rotation, right.rotation + Math.PI / 2]
    .map(angle => ({ x: Math.cos(angle), y: Math.sin(angle) }));
  for (const axis of axes) {
    const project = corners => corners.map(point => point.x * axis.x + point.y * axis.y);
    const a = project(leftCorners);
    const b = project(rightCorners);
    if (Math.max(...a) <= Math.min(...b) || Math.max(...b) <= Math.min(...a)) return false;
  }
  return true;
}

function footprintsOverlap(left, right) {
  if (left.kind === 'circle' && right.kind === 'circle') return circleCircle(left, right);
  if (left.kind === 'circle') return circleRectangle(left, right);
  if (right.kind === 'circle') return circleRectangle(right, left);
  return rectangleRectangle(left, right);
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round((sorted.length - 1) * clamp(fraction, 0, 1));
  return sorted[index];
}

export function evaluateStructuralGates(record, pacing, options = {}) {
  const validation = validateResearchRecord(record);
  const targets = (record.authored?.objects || []).filter(object => object.role === 'target');
  const bounds = record.authored?.coordinateSystem?.bounds || { minX: 0, minY: 0, maxX: 400, maxY: 600 };
  const padded = targets.map(object => ({ object, shape: footprint(object, finite(options.collisionPadding, 0.6)) }));
  const trustedRelationPairs = new Set((record.extensions?.generatorRecipe?.placements || [])
    .filter(placement => placement.relation?.anchorGroupId)
    .map(placement => [placement.groupId, placement.relation.anchorGroupId].sort().join('|')));
  const outOfBounds = padded.filter(({ shape }) => {
    const box = boundsFor(shape);
    return box.minX < bounds.minX || box.maxX > bounds.maxX || box.minY < bounds.minY || box.maxY > bounds.maxY;
  }).map(({ object }) => object.id);
  const overlaps = [];
  const retainedSourceContacts = [];
  for (let left = 0; left < padded.length; left++) {
    for (let right = left + 1; right < padded.length; right++) {
      if (footprintsOverlap(padded[left].shape, padded[right].shape)) {
        const leftGroups = new Set(padded[left].object.groupIds || []);
        const rightGroups = padded[right].object.groupIds || [];
        const sameMotif = rightGroups.some(groupId => leftGroups.has(groupId));
        const trustedSourceRelation = [...leftGroups].some(leftGroup => rightGroups.some(rightGroup => (
          trustedRelationPairs.has([leftGroup, rightGroup].sort().join('|'))
        )));
        const pair = [padded[left].object.id, padded[right].object.id];
        if (sameMotif || trustedSourceRelation) retainedSourceContacts.push(pair);
        else overlaps.push(pair);
      }
    }
  }
  const launch = record.authored?.mechanics?.launcher || { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY + 40 };
  const launcherClearance = targets.length
    ? Math.min(...padded.map(({ shape }) => Math.hypot(shape.x - launch.x, shape.y - launch.y) - (
      shape.kind === 'circle' ? shape.radius : Math.hypot(shape.halfWidth, shape.halfHeight)
    )))
    : 0;
  const sortedY = targets.map(object => finite(object.transform?.y)).sort((a, b) => a - b);
  const internalGaps = sortedY.slice(1).map((value, index) => value - sortedY[index]);
  const topGap = sortedY.length ? sortedY[0] - bounds.minY : Infinity;
  const bottomGap = sortedY.length ? bounds.maxY - sortedY.at(-1) : Infinity;
  const windowHeight = finite(options.windowHeight, 180);
  const windowStep = finite(options.windowStep, 40);
  const windows = [];
  for (let start = bounds.minY + 80; start + windowHeight <= bounds.maxY - 10; start += windowStep) {
    windows.push({
      minY: start,
      maxY: start + windowHeight,
      targetCount: targets.filter(object => object.transform.y >= start && object.transform.y <= start + windowHeight).length
    });
  }
  const groups = record.authored?.groups || [];
  const placements = record.extensions?.generatorRecipe?.placements || [];
  const sourceLevels = new Set(placements.map(placement => placement.sourceLevelId).filter(Boolean));
  const motifTypes = new Set(placements.flatMap(placement => placement.motifTypes || [placement.motifType]).filter(Boolean));
  const usesConnectedFragments = placements.some(placement => String(placement.motifType || '').startsWith('fragment:'));
  const targetCountRange = pacing?.targetCount
    ? { min: Math.max(20, Math.floor(pacing.targetCount.low * 0.75)), max: Math.ceil(pacing.targetCount.high * 1.35) }
    : { min: 24, max: 100 };
  const orangeCount = targets.filter(object => object.targetType === 'orange').length;
  const orangeFraction = targets.length ? orangeCount / targets.length : 0;
  const brickCount = targets.filter(object => object.kind === 'brick').length;
  const brickFraction = targets.length ? brickCount / targets.length : 0;
  const orangeRange = pacing?.orangeFraction
    ? { min: Math.max(0.1, pacing.orangeFraction.low - 0.08), max: Math.min(0.9, pacing.orangeFraction.high + 0.08) }
    : { min: 0.1, max: 0.9 };
  const brickRange = pacing?.brickFraction
    ? { min: Math.max(0.15, pacing.brickFraction.low - 0.18), max: Math.min(0.95, pacing.brickFraction.high + 0.12) }
    : { min: 0.15, max: 0.95 };
  const failures = [];
  if (!validation.valid) failures.push('schema-invalid');
  if (outOfBounds.length) failures.push('out-of-bounds');
  if (overlaps.length) failures.push('object-overlap');
  if (launcherClearance < finite(options.minLauncherClearance, 48)) failures.push('launcher-clearance');
  if (targets.length < targetCountRange.min || targets.length > targetCountRange.max) failures.push('target-count-outlier');
  if (topGap > finite(options.maxTopGap, 190)) failures.push('empty-opening');
  if (bottomGap > finite(options.maxBottomGap, 155)) failures.push('empty-ending');
  if (internalGaps.length && Math.max(...internalGaps) > finite(options.maxInternalGap, 145)) failures.push('vertical-dead-zone');
  if (windows.length && Math.min(...windows.map(window => window.targetCount)) < finite(options.minWindowTargets, 3)) failures.push('sparse-window');
  if (groups.length < finite(options.minMotifGroups, usesConnectedFragments ? 2 : 3)) failures.push('too-few-motifs');
  if (sourceLevels.size < Math.min(2, groups.length)) failures.push('single-source-composition');
  if (motifTypes.size < Math.min(2, groups.length)) failures.push('single-motif-vocabulary');
  if (orangeFraction < orangeRange.min || orangeFraction > orangeRange.max) failures.push('orange-ratio-outlier');
  if (brickFraction < brickRange.min || brickFraction > brickRange.max) failures.push('rectangular-peg-ratio-outlier');
  return {
    status: failures.length ? 'rejected' : 'passed',
    failures,
    validation,
    targetCount: targets.length,
    orangeCount,
    orangeFraction,
    brickCount,
    brickFraction,
    targetCountRange,
    orangeRange,
    brickRange,
    objectKindCounts: Object.fromEntries([...new Set(targets.map(object => object.kind))].sort().map(kind => [
      kind, targets.filter(object => object.kind === kind).length
    ])),
    outOfBounds,
    overlapCount: overlaps.length,
    overlapExamples: overlaps.slice(0, 20),
    retainedSourceContactCount: retainedSourceContacts.length,
    retainedSourceContactExamples: retainedSourceContacts.slice(0, 20),
    launcherClearance,
    verticalCoverage: {
      topGap,
      bottomGap,
      maximumInternalGap: internalGaps.length ? Math.max(...internalGaps) : null,
      medianInternalGap: quantile(internalGaps, 0.5),
      windows
    },
    composition: {
      motifGroupCount: groups.length,
      sourceLevelCount: sourceLevels.size,
      motifTypeCount: motifTypes.size,
      sourceLevelIds: [...sourceLevels].sort(),
      motifTypes: [...motifTypes].sort()
    }
  };
}

export function evaluatePhysicsGates(sweep, options = {}) {
  const failures = [];
  if (sweep.hitCount.max < finite(options.minBestShotHits, 3)) failures.push('no-meaningful-shot');
  if (sweep.reachableTargetFraction < finite(options.minReachableFraction, 0.12)) failures.push('low-sampled-reachability');
  if (sweep.deadShotRate > finite(options.maxDeadShotRate, 0.45)) failures.push('too-many-dead-shots');
  if (sweep.outcomeDiversity < finite(options.minOutcomeDiversity, 0.3)) failures.push('low-outcome-diversity');
  return { status: failures.length ? 'rejected' : 'passed', failures, sweep };
}

export async function runGeneratorHarness(record, pacing, options = {}) {
  const structural = evaluateStructuralGates(record, pacing, options.structural);
  let physics = null;
  if (structural.status === 'passed' && options.physics !== false) {
    const sweep = await runShotSweep(record, {
      angleCount: options.physics?.angleCount || 11,
      maxSteps: options.physics?.maxSteps || 2400,
      seed: options.physics?.seed || `generator-harness:${record.id}`,
      at: options.at
    });
    physics = evaluatePhysicsGates(sweep, options.physics);
  }
  const failures = [
    ...structural.failures.map(code => `structural:${code}`),
    ...(physics?.failures || []).map(code => `physics:${code}`)
  ];
  return {
    format: 'peggle-generator-harness',
    formatVersion: 1,
    levelId: record.id,
    createdAt: options.at || new Date().toISOString(),
    status: failures.length ? 'rejected' : 'passed',
    failures,
    structural,
    physics,
    caveats: [
      'Structural gates reject malformed or obviously unplayable layouts; they do not measure fun.',
      'Physics is a deterministic one-shot angle sweep in the target-game subset, not a full-game solver.',
      'Final composition quality remains a targeted human-review decision.'
    ]
  };
}
