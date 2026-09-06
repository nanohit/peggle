// Pure standard-board geometry. Curved collision bodies match physics.js:
// one oriented rectangle per centerline segment, NOT a peg-sized flat brick.
export function effectiveCompositionSize(peg, radius = 8.5) {
  const base = Number.isFinite(peg.brickBaseRadius) && peg.brickBaseRadius > 0 ? peg.brickBaseRadius : 8.5;
  const scale = radius / base;
  return {
    width: (peg.width ?? 34) * (peg.curveSlices?.length >= 2 ? 1 : scale),
    height: (peg.height ?? 10.2) * scale
  };
}

export function compositionFootprints(peg, radius = 8.5) {
  if (peg.shape !== 'brick') return [{ kind: 'circle', x: peg.x, y: peg.y, radius }];
  const { width, height } = effectiveCompositionSize(peg, radius);
  if (peg.curveSlices?.length >= 2) return peg.curveSlices.slice(1).flatMap((b, index) => {
    const a = peg.curveSlices[index], length = Math.hypot(b.x - a.x, b.y - a.y);
    return length > 0.001 ? [{ kind: 'rectangle', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      rotation: Math.atan2(b.y - a.y, b.x - a.x), halfWidth: length / 2, halfHeight: height / 2 }] : [];
  });
  return [{ kind: 'rectangle', x: peg.x, y: peg.y, rotation: peg.angle || 0, halfWidth: width / 2, halfHeight: height / 2 }];
}

export function rectangleCorners(shape) {
  const cos = Math.cos(shape.rotation), sin = Math.sin(shape.rotation);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = sx * shape.halfWidth, y = sy * shape.halfHeight;
    return { x: shape.x + x * cos - y * sin, y: shape.y + x * sin + y * cos };
  });
}

export function curvedBrickOutline(peg, radius = 8.5) {
  if (!(peg.curveSlices?.length >= 2)) return null;
  const halfH = effectiveCompositionSize(peg, radius).height / 2;
  const edge = sign => peg.curveSlices.map(s => ({ x: s.x + sign * (s.nx ?? 0) * halfH, y: s.y + sign * (s.ny ?? 1) * halfH }));
  return [...edge(1), ...edge(-1).reverse()];
}

export function footprintBounds(shapes) {
  const points = shapes.flatMap(s => s.kind === 'circle'
    ? [{ x: s.x - s.radius, y: s.y - s.radius }, { x: s.x + s.radius, y: s.y + s.radius }]
    : rectangleCorners(s));
  return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
}

export function distanceToFootprint(point, shape) {
  if (shape.kind === 'circle') return Math.hypot(point.x - shape.x, point.y - shape.y) - shape.radius;
  const cos = Math.cos(-shape.rotation), sin = Math.sin(-shape.rotation);
  const dx = point.x - shape.x, dy = point.y - shape.y;
  return Math.hypot(Math.max(0, Math.abs(dx * cos - dy * sin) - shape.halfWidth),
    Math.max(0, Math.abs(dx * sin + dy * cos) - shape.halfHeight));
}

function intersects(a, b, tolerance) {
  if (a.kind === 'circle' && b.kind === 'circle') return Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius - tolerance;
  if (a.kind === 'circle') return distanceToFootprint(a, b) < a.radius - tolerance;
  if (b.kind === 'circle') return distanceToFootprint(b, a) < b.radius - tolerance;
  const ac = rectangleCorners(a), bc = rectangleCorners(b);
  return [a.rotation, a.rotation + Math.PI / 2, b.rotation, b.rotation + Math.PI / 2].every(angle => {
    const project = corners => corners.map(p => p.x * Math.cos(angle) + p.y * Math.sin(angle));
    const x = project(ac), y = project(bc);
    return Math.min(Math.max(...x), Math.max(...y)) - Math.max(Math.min(...x), Math.min(...y)) > tolerance;
  });
}

export function evaluateCompositionGeometry(level, options = {}) {
  const width = Number(options.width || 400), height = Number(options.height || 600);
  const radius = Number(level.pegRadius || 8.5), tolerance = Number(options.overlapTolerancePx ?? 0.05);
  const launcher = options.launcher || { x: width / 2, y: 40 };
  const minimumLauncherClearance = Number(options.minimumLauncherClearance ?? 42);
  const invalidGeometry = [], outOfBounds = [], footprints = [];
  let launcherClearance = Infinity;
  for (const [index, peg] of (level.pegs || []).entries()) {
    const id = peg.memberId || peg.id || String(index), shapes = compositionFootprints(peg, radius);
    const bounds = footprintBounds(shapes);
    if (![peg.x, peg.y, ...Object.values(bounds)].every(Number.isFinite)
      || (peg.shape === 'brick' && !(effectiveCompositionSize(peg, radius).height > 0))
      || (peg.curveSlices || []).some(s => ![s.x, s.y, s.nx, s.ny].every(Number.isFinite))) invalidGeometry.push(id);
    if (bounds.minX < -tolerance || bounds.maxX > width + tolerance || bounds.minY < -tolerance || bounds.maxY > height + tolerance) outOfBounds.push(id);
    launcherClearance = Math.min(launcherClearance, ...shapes.map(s => distanceToFootprint(launcher, s)));
    footprints.push({ peg, id, shapes, bounds });
  }
  const overlaps = [], sameObjectOverlaps = [], crossObjectOverlaps = [];
  for (let i = 0; i < footprints.length; i++) for (let j = i + 1; j < footprints.length; j++) {
    const a = footprints[i], b = footprints[j];
    if (a.bounds.maxX <= b.bounds.minX || b.bounds.maxX <= a.bounds.minX || a.bounds.maxY <= b.bounds.minY || b.bounds.maxY <= a.bounds.minY) continue;
    if (!a.shapes.some(x => b.shapes.some(y => intersects(x, y, tolerance)))) continue;
    const pair = [a.id, b.id]; overlaps.push(pair);
    (a.peg.objectId && a.peg.objectId === b.peg.objectId ? sameObjectOverlaps : crossObjectOverlaps).push(pair);
  }
  const failures = [];
  if (invalidGeometry.length) failures.push('invalid-geometry');
  if (outOfBounds.length) failures.push('out-of-bounds');
  if (sameObjectOverlaps.length) failures.push('same-object-overlap');
  if (crossObjectOverlaps.length) failures.push('cross-object-overlap');
  if (launcherClearance < minimumLauncherClearance) failures.push('launcher-clearance');
  if (!footprints.length) failures.push('empty-level');
  const allBounds = footprintBounds(footprints.flatMap(x => x.shapes));
  return { status: failures.length ? 'failed' : 'passed', failures, width, height,
    pegCount: footprints.length, invalidGeometry, outOfBounds,
    overlapCount: overlaps.length, overlapExamples: overlaps.slice(0, 20),
    sameObjectOverlapCount: sameObjectOverlaps.length, crossObjectOverlapCount: crossObjectOverlaps.length,
    crossObjectOverlapExamples: crossObjectOverlaps.slice(0, 20), launcherClearance, minimumLauncherClearance,
    coverage: footprints.length ? { bounds: allBounds, emptyOpeningPx: allBounds.minY,
      horizontalFraction: (allBounds.maxX - allBounds.minX) / width, verticalFraction: (allBounds.maxY - allBounds.minY) / height } : null,
    limitations: 'Static geometry only: no prediction of fun, shot diversity or solvability.' };
}
