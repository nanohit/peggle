// Pure geometry shared by the editor, research compiler, and tests.
// Keep peg baking here: two implementations that are merely "equivalent"
// inevitably drift at the half-spacing offset and shortened tail.

export const BEZIER_BAKE_VERSION = 1;
export const DEFAULT_BEZIER_EXCEPTION_THRESHOLD_PX = 1;
// Reconstruction precision is not a perceptual threshold for author intent.
export const GEOMETRY_EPSILON_PX = 1e-6;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function sampleCubicBezier(curve, options = {}) {
  const p0 = curve?.start || { x: 0, y: 0 };
  const p1 = curve?.h1 || p0;
  const p2 = curve?.h2 || curve?.end || p0;
  const p3 = curve?.end || p0;
  const approximateLength = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    + Math.hypot(p2.x - p1.x, p2.y - p1.y)
    + Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const minimum = Math.max(2, Math.trunc(finite(options.minPoints, 96)));
  const points = Math.max(minimum, Math.ceil(approximateLength / 2));
  const samples = [];
  let previousAngle = 0;
  for (let index = 0; index <= points; index++) {
    const t = index / points;
    const inverse = 1 - t;
    const x = inverse ** 3 * p0.x + 3 * inverse ** 2 * t * p1.x + 3 * inverse * t ** 2 * p2.x + t ** 3 * p3.x;
    const y = inverse ** 3 * p0.y + 3 * inverse ** 2 * t * p1.y + 3 * inverse * t ** 2 * p2.y + t ** 3 * p3.y;
    const dx = 3 * inverse ** 2 * (p1.x - p0.x) + 6 * inverse * t * (p2.x - p1.x) + 3 * t ** 2 * (p3.x - p2.x);
    const dy = 3 * inverse ** 2 * (p1.y - p0.y) + 6 * inverse * t * (p2.y - p1.y) + 3 * t ** 2 * (p3.y - p2.y);
    let angle = Math.atan2(dy, dx);
    if (!Number.isFinite(angle)) angle = previousAngle;
    previousAngle = angle;
    samples.push({ x, y, angle, t });
  }
  return samples;
}

export function sampleAtArcLength(samples, cumulativeLengths, targetLength) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  if (samples.length === 1) return { ...samples[0] };
  let index = 0;
  while (index < samples.length - 1 && cumulativeLengths[index + 1] < targetLength) index++;
  if (index >= samples.length - 1) return { ...samples[samples.length - 1] };
  const segmentLength = cumulativeLengths[index + 1] - cumulativeLengths[index];
  const fraction = segmentLength > 0 ? (targetLength - cumulativeLengths[index]) / segmentLength : 0;
  const left = samples[index];
  const right = samples[index + 1];
  let angleDelta = finite(right.angle) - finite(left.angle);
  while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
  while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
  return {
    x: finite(left.x) + (finite(right.x) - finite(left.x)) * fraction,
    y: finite(left.y) + (finite(right.y) - finite(left.y)) * fraction,
    angle: finite(left.angle) + angleDelta * fraction
  };
}

export function bakePegsFromSamples(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const shape = options.shape === 'brick' ? 'brick' : 'circle';
  const isBrick = shape === 'brick';
  let spacing = finite(options.spacingPx, isBrick
    ? finite(options.brickWidth, 34)
    : finite(options.pegRadius, 8.5) * 2.2);
  if (!(spacing > 0)) return [];

  const cumulativeLengths = [0];
  for (let index = 1; index < samples.length; index++) {
    cumulativeLengths.push(cumulativeLengths[index - 1] + Math.hypot(
      finite(samples[index].x) - finite(samples[index - 1].x),
      finite(samples[index].y) - finite(samples[index - 1].y)
    ));
  }
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  if (totalLength < spacing * 0.4) return [];

  if (options.closedLoop) {
    const count = Math.max(1, Math.round(totalLength / spacing));
    spacing = totalLength / count;
  }

  const result = [];
  const sliceCount = Math.max(1, Math.trunc(finite(options.sliceCount, 5)));
  let edgePosition = 0;
  while (edgePosition + spacing * 0.4 <= totalLength) {
    const edgeEnd = Math.min(edgePosition + spacing, totalLength);
    const centerLength = (edgePosition + edgeEnd) / 2;
    const center = sampleAtArcLength(samples, cumulativeLengths, centerLength);
    const baked = {
      x: center.x,
      y: center.y,
      angle: center.angle + finite(options.rotationOffset),
      arcLength: centerLength,
      edgeStart: edgePosition,
      edgeEnd,
      shortenedTail: edgeEnd - edgePosition < spacing - 1e-7
    };
    if (isBrick) {
      baked.slices = [];
      for (let slice = 0; slice <= sliceCount; slice++) {
        const arcLength = edgePosition + (edgeEnd - edgePosition) * slice / sliceCount;
        const point = sampleAtArcLength(samples, cumulativeLengths, Math.min(arcLength, totalLength));
        baked.slices.push({
          x: point.x,
          y: point.y,
          nx: -Math.sin(point.angle),
          ny: Math.cos(point.angle)
        });
      }
    }
    result.push(baked);
    edgePosition += spacing;
  }
  return result;
}

export function applySimilarityTransform(point, transform = {}) {
  const scale = finite(transform.scale, 1);
  const angle = finite(transform.angle);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = finite(point?.x) * scale;
  const y = finite(point?.y) * scale * (transform.reflect === true ? -1 : 1);
  return {
    ...point,
    x: x * cos - y * sin + finite(transform.tx),
    y: x * sin + y * cos + finite(transform.ty)
  };
}

export function estimateSimilarityTransformFromPairs(pairs, options = {}) {
  const valid = (Array.isArray(pairs) ? pairs : []).filter(pair => (
    Number.isFinite(pair?.sx) && Number.isFinite(pair?.sy)
    && Number.isFinite(pair?.dx) && Number.isFinite(pair?.dy)
  ));
  if (valid.length === 0) return null;
  const fitOrientation = reflect => {
    let sourceX = 0, sourceY = 0, destinationX = 0, destinationY = 0;
    for (const pair of valid) {
      sourceX += pair.sx;
      sourceY += reflect ? -pair.sy : pair.sy;
      destinationX += pair.dx;
      destinationY += pair.dy;
    }
    sourceX /= valid.length;
    sourceY /= valid.length;
    destinationX /= valid.length;
    destinationY /= valid.length;

    let dot = 0, cross = 0, sourceNorm = 0;
    for (const pair of valid) {
      const ax = pair.sx - sourceX;
      const ay = (reflect ? -pair.sy : pair.sy) - sourceY;
      const bx = pair.dx - destinationX;
      const by = pair.dy - destinationY;
      dot += ax * bx + ay * by;
      cross += ax * by - ay * bx;
      sourceNorm += ax * ax + ay * ay;
    }
    const angle = Math.atan2(cross, dot);
    const inferredScale = sourceNorm > 1e-12 ? Math.hypot(dot, cross) / sourceNorm : 1;
    const scale = options.allowScale === false ? 1 : inferredScale;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tx = destinationX - scale * (sourceX * cos - sourceY * sin);
    const ty = destinationY - scale * (sourceX * sin + sourceY * cos);
    const transform = { angle, scale, tx, ty, reflect };
    const residuals = valid.map(pair => {
      const transformed = applySimilarityTransform({ x: pair.sx, y: pair.sy }, transform);
      return Math.hypot(transformed.x - pair.dx, transformed.y - pair.dy);
    });
    return {
      ...transform,
      determinantSign: reflect ? -1 : 1,
      pairCount: valid.length,
      residuals,
      maxResidualPx: Math.max(0, ...residuals),
      rmsResidualPx: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length)
    };
  };

  const direct = fitOrientation(false);
  if (options.allowReflection !== true) return direct;
  const reflected = fitOrientation(true);
  // Prefer the orientation-preserving fit on a tie. Collinear point sets do
  // not contain enough information to distinguish a mirror from a rotation.
  return reflected.rmsResidualPx + 1e-12 < direct.rmsResidualPx ? reflected : direct;
}

export function transformBezierCurve(curve, transform) {
  const transformed = { ...curve };
  for (const key of ['start', 'end', 'h1', 'h2']) {
    if (curve?.[key]) transformed[key] = applySimilarityTransform(curve[key], transform);
  }
  if (Array.isArray(curve?.refPoints)) {
    transformed.refPoints = curve.refPoints.map(point => applySimilarityTransform(point, transform));
  }
  if (Number.isFinite(curve?.spacingPx) && Number.isFinite(transform?.scale)) {
    transformed.spacingPx = curve.spacingPx * Math.abs(transform.scale);
  }
  if (transform?.reflect === true && Number.isFinite(curve?.rotationOffset)) {
    transformed.rotationOffset = -curve.rotationOffset;
  }
  return transformed;
}

export function auditBezierGroup(curve, pegs, options = {}) {
  const thresholdPx = finite(options.thresholdPx, DEFAULT_BEZIER_EXCEPTION_THRESHOLD_PX);
  const references = new Map((curve?.refPoints || [])
    .filter(point => Number.isFinite(point?.index) && Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map(point => [point.index, point]));
  const pairs = [];
  for (const peg of pegs || []) {
    const reference = references.get(peg?.bezierIndex);
    if (!reference || !Number.isFinite(peg?.x) || !Number.isFinite(peg?.y)) continue;
    pairs.push({ sx: reference.x, sy: reference.y, dx: peg.x, dy: peg.y, index: peg.bezierIndex });
  }
  const fit = estimateSimilarityTransformFromPairs(pairs, {
    allowScale: options.allowScale !== false,
    allowReflection: options.allowReflection === true
  });
  const outlierIndices = [];
  const residuals = [];
  if (fit) {
    fit.residuals.forEach((residual, index) => {
      residuals.push({ index: pairs[index].index, residualPx: residual });
      if (residual > thresholdPx) outlierIndices.push(pairs[index].index);
    });
  }
  return {
    pairCount: pairs.length,
    sufficientLineage: pairs.length >= 3,
    pegCount: Array.isArray(pegs) ? pegs.length : 0,
    thresholdPx,
    transform: fit ? {
      angle: fit.angle,
      scale: fit.scale,
      tx: fit.tx,
      ty: fit.ty,
      reflect: fit.reflect === true
    } : null,
    rmsResidualPx: fit?.rmsResidualPx ?? null,
    maxResidualPx: fit?.maxResidualPx ?? null,
    outlierCount: outlierIndices.length,
    outlierIndices,
    residuals
  };
}
