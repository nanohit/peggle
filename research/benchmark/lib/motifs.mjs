const EPSILON = 1e-9;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values, average = mean(values)) {
  return values.length
    ? Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length)
    : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeHalfTurn(angle) {
  let value = angle % Math.PI;
  if (value < 0) value += Math.PI;
  return value;
}

function targetPoints(levelRecord) {
  return (levelRecord?.authored?.objects || [])
    .filter(object => object.role === 'target')
    .map(object => ({
      id: String(object.id),
      object,
      x: Number(object.transform?.x),
      y: Number(object.transform?.y),
      rotation: finite(object.transform?.rotation),
      kind: object.kind
    }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function nearestDistances(points) {
  return points.map((point, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let otherIndex = 0; otherIndex < points.length; otherIndex++) {
      if (index === otherIndex) continue;
      nearest = Math.min(nearest, Math.hypot(point.x - points[otherIndex].x, point.y - points[otherIndex].y));
    }
    return nearest;
  }).filter(Number.isFinite);
}

function principalAxis(points) {
  const centerX = mean(points.map(point => point.x));
  const centerY = mean(points.map(point => point.y));
  const xx = mean(points.map(point => (point.x - centerX) ** 2));
  const yy = mean(points.map(point => (point.y - centerY) ** 2));
  const xy = mean(points.map(point => (point.x - centerX) * (point.y - centerY)));
  const trace = xx + yy;
  const root = Math.sqrt(Math.max(0, ((xx - yy) ** 2) + 4 * xy * xy));
  const major = Math.max(EPSILON, (trace + root) / 2);
  const minor = Math.max(EPSILON, (trace - root) / 2);
  return {
    angle: normalizeHalfTurn(0.5 * Math.atan2(2 * xy, xx - yy)),
    elongation: major / minor
  };
}

function rhythm(points) {
  const distances = nearestDistances(points);
  const average = mean(distances);
  const cv = average > EPSILON ? deviation(distances, average) / average : 0;
  return { spacing: median(distances), coefficientOfVariation: cv, regularity: 1 / (1 + cv) };
}

function describeMotif(type, points, extra = {}) {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const axis = principalAxis(points);
  const pattern = rhythm(points);
  return {
    id: '',
    type,
    objectIds: points.map(point => point.id).sort(),
    size: points.length,
    centroid: { x: mean(xs), y: mean(ys) },
    bounds: {
      minX: Math.min(...xs), minY: Math.min(...ys),
      maxX: Math.max(...xs), maxY: Math.max(...ys)
    },
    principalAngle: extra.principalAngle ?? axis.angle,
    elongation: axis.elongation,
    spacing: extra.spacing ?? pattern.spacing,
    spacingCv: extra.spacingCv ?? pattern.coefficientOfVariation,
    regularity: clamp(extra.regularity ?? pattern.regularity),
    confidence: clamp(extra.confidence ?? 0.5),
    ...extra
  };
}

function lineCandidates(points, spacing) {
  const tolerance = Math.max(4, Math.min(12, spacing * 0.28));
  const keys = new Map();
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const neighbors = points
      .map((other, otherIndex) => ({ otherIndex, distance: Math.hypot(point.x - other.x, point.y - other.y) }))
      .filter(item => item.otherIndex !== index && item.distance > EPSILON)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, Math.min(12, points.length - 1));
    for (const neighbor of neighbors) {
      const other = points[neighbor.otherIndex];
      const angle = normalizeHalfTurn(Math.atan2(other.y - point.y, other.x - point.x));
      const normalX = -Math.sin(angle);
      const normalY = Math.cos(angle);
      const offset = point.x * normalX + point.y * normalY;
      const key = `${Math.round(angle / (Math.PI / 90))}:${Math.round(offset / tolerance)}`;
      if (!keys.has(key)) keys.set(key, { angle, offset });
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const candidate of keys.values()) {
    const cos = Math.cos(candidate.angle);
    const sin = Math.sin(candidate.angle);
    const normalX = -sin;
    const normalY = cos;
    const members = points.filter(point => (
      Math.abs(point.x * normalX + point.y * normalY - candidate.offset) <= tolerance
    ));
    if (members.length < 4) continue;
    const memberKey = members.map(point => point.id).sort().join('|');
    if (seen.has(memberKey)) continue;
    seen.add(memberKey);
    const projections = members.map(point => point.x * cos + point.y * sin).sort((left, right) => left - right);
    const gaps = projections.slice(1).map((value, index) => value - projections[index]).filter(value => value > EPSILON);
    const gapMean = mean(gaps);
    const gapCv = gapMean > EPSILON ? deviation(gaps, gapMean) / gapMean : 1;
    const residual = mean(members.map(point => Math.abs(point.x * normalX + point.y * normalY - candidate.offset)));
    const regularity = 1 / (1 + gapCv + residual / Math.max(tolerance, EPSILON));
    candidates.push({
      members,
      angle: candidate.angle,
      spacing: median(gaps),
      spacingCv: gapCv,
      regularity,
      confidence: clamp((members.length / 8) * 0.55 + regularity * 0.45),
      score: members.length + regularity * 3 - residual / tolerance
    });
  }
  return candidates.sort((left, right) => right.score - left.score || right.members.length - left.members.length);
}

function circleThrough(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-5) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  const x = (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d;
  const y = (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d;
  const radius = Math.hypot(a.x - x, a.y - y);
  return Number.isFinite(radius) ? { x, y, radius } : null;
}

function angularDescriptor(members, center, baseSpacing) {
  const angles = members.map(point => {
    let angle = Math.atan2(point.y - center.y, point.x - center.x);
    if (angle < 0) angle += Math.PI * 2;
    return { point, angle };
  }).sort((left, right) => left.angle - right.angle);
  const circularGaps = angles.map((value, index) => {
    const next = index + 1 < angles.length ? angles[index + 1].angle : angles[0].angle + Math.PI * 2;
    return next - value.angle;
  });
  const largestGap = Math.max(...circularGaps);
  const largestIndex = circularGaps.indexOf(largestGap);
  const ordered = [];
  const startIndex = (largestIndex + 1) % angles.length;
  for (let offset = 0; offset < angles.length; offset++) {
    const source = angles[(startIndex + offset) % angles.length];
    let angle = source.angle;
    if (ordered.length && angle < ordered[ordered.length - 1].angle) angle += Math.PI * 2;
    ordered.push({ point: source.point, angle });
  }
  const gaps = ordered.slice(1).map((value, index) => value.angle - ordered[index].angle);
  const chordDistances = ordered.slice(1).map((value, index) => (
    Math.hypot(value.point.x - ordered[index].point.x, value.point.y - ordered[index].point.y)
  ));
  const gapMean = mean(gaps);
  const gapCv = gapMean > EPSILON ? deviation(gaps, gapMean) / gapMean : 1;
  const continuityFraction = chordDistances.length
    ? chordDistances.filter(distance => distance <= baseSpacing * 1.85).length / chordDistances.length
    : 0;
  const chordSpacing = median(chordDistances);
  return {
    startAngle: ordered[0].angle,
    endAngle: ordered[ordered.length - 1].angle,
    span: Math.PI * 2 - largestGap,
    spacingCv: gapCv,
    regularity: 1 / (1 + gapCv),
    continuityFraction,
    chordSpacing
  };
}

function arcCandidates(points, spacing, diagonal) {
  if (points.length < 6) return [];
  const tolerance = Math.max(2.25, Math.min(5, spacing * 0.15));
  const triples = [];
  const tripleKeys = new Set();
  const count = Math.min(420, Math.max(80, points.length * 5));
  for (let index = 0; index < count; index++) {
    const a = (index * 17 + Math.floor(index / 7)) % points.length;
    const b = (index * 31 + 7) % points.length;
    const c = (index * 47 + 13) % points.length;
    if (a === b || a === c || b === c) continue;
    const indices = [a, b, c].sort((left, right) => left - right);
    const key = indices.join(':');
    if (tripleKeys.has(key)) continue;
    tripleKeys.add(key);
    triples.push(indices);
  }

  const candidates = [];
  const seen = new Set();
  for (const [a, b, c] of triples) {
    const circle = circleThrough(points[a], points[b], points[c]);
    if (!circle || circle.radius < spacing * 1.5 || circle.radius > diagonal * 1.4) continue;
    const members = points.filter(point => (
      Math.abs(Math.hypot(point.x - circle.x, point.y - circle.y) - circle.radius) <= tolerance
    ));
    if (members.length < 6) continue;
    const memberKey = members.map(point => point.id).sort().join('|');
    if (seen.has(memberKey)) continue;
    seen.add(memberKey);
    const residual = mean(members.map(point => (
      Math.abs(Math.hypot(point.x - circle.x, point.y - circle.y) - circle.radius)
    )));
    const angular = angularDescriptor(members, circle, spacing);
    if (angular.span < Math.PI / 3
        || angular.regularity < 0.42
        || angular.continuityFraction < 0.72
        || angular.chordSpacing < spacing * 0.55
        || angular.chordSpacing > spacing * 1.65
        || residual > tolerance * 0.52) continue;
    const confidence = clamp(
      (members.length / 12) * 0.45
      + angular.regularity * 0.35
      + Math.min(1, angular.span / Math.PI) * 0.20
      + angular.continuityFraction * 0.15
      - residual / tolerance * 0.25
    );
    candidates.push({
      members,
      center: { x: circle.x, y: circle.y },
      radius: circle.radius,
      ...angular,
      residual,
      confidence,
      score: members.length + confidence * 4 - residual / tolerance
    });
  }
  return candidates.sort((left, right) => right.score - left.score || right.members.length - left.members.length);
}

function takeDisjoint(candidates, assigned, minimumRetained, makeMotif) {
  const motifs = [];
  for (const candidate of candidates) {
    const members = candidate.members.filter(point => !assigned.has(point.id));
    if (members.length < minimumRetained || members.length < candidate.members.length * 0.70) continue;
    const motif = makeMotif(candidate, members);
    motifs.push(motif);
    members.forEach(point => assigned.add(point.id));
  }
  return motifs;
}

function proximityComponents(points, threshold) {
  const adjacency = new Map(points.map(point => [point.id, []]));
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      if (Math.hypot(points[left].x - points[right].x, points[left].y - points[right].y) <= threshold) {
        adjacency.get(points[left].id).push(points[right]);
        adjacency.get(points[right].id).push(points[left]);
      }
    }
  }
  const visited = new Set();
  const components = [];
  for (const point of points) {
    if (visited.has(point.id)) continue;
    const component = [];
    const stack = [point];
    visited.add(point.id);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const next of adjacency.get(current.id)) {
        if (!visited.has(next.id)) {
          visited.add(next.id);
          stack.push(next);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function finalizeMotifs(motifs) {
  return motifs
    .filter(motif => motif.objectIds.length >= 3)
    .sort((left, right) => (
      right.confidence - left.confidence
      || right.size - left.size
      || left.objectIds[0].localeCompare(right.objectIds[0])
    ))
    .map((motif, index) => ({ ...motif, id: `motif-${String(index + 1).padStart(3, '0')}-${motif.type}` }));
}

export function analyzeLevelMotifs(levelRecord) {
  const points = targetPoints(levelRecord);
  const bounds = levelRecord?.authored?.coordinateSystem?.bounds || { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  const width = Math.max(EPSILON, finite(bounds.maxX) - finite(bounds.minX));
  const height = Math.max(EPSILON, finite(bounds.maxY) - finite(bounds.minY));
  const diagonal = Math.hypot(width, height);
  if (points.length < 3) {
    return {
      motifs: [],
      summary: {
        motifCount: 0, coverageFraction: 0, lineFraction: 0, arcFraction: 0,
        gridFraction: 0, clusterFraction: 0, meanRegularity: 0,
        meanSizeFraction: 0, separation: 0, framingMinMargin: 0, framingBalance: 0
      }
    };
  }

  const spacing = Math.max(8, median(nearestDistances(points)) || diagonal * 0.03);
  const assigned = new Set();
  const motifs = [];
  motifs.push(...takeDisjoint(
    arcCandidates(points, spacing, diagonal),
    assigned,
    6,
    (candidate, members) => describeMotif('arc', members, {
      center: candidate.center,
      radius: candidate.radius,
      startAngle: candidate.startAngle,
      endAngle: candidate.endAngle,
      angularSpan: candidate.span,
      spacingCv: candidate.spacingCv,
      regularity: candidate.regularity,
      confidence: candidate.confidence
    })
  ));

  const unassignedAfterArcs = points.filter(point => !assigned.has(point.id));
  motifs.push(...takeDisjoint(
    lineCandidates(unassignedAfterArcs, spacing),
    assigned,
    4,
    (candidate, members) => describeMotif('line', members, {
      principalAngle: candidate.angle,
      spacing: candidate.spacing,
      spacingCv: candidate.spacingCv,
      regularity: candidate.regularity,
      confidence: candidate.confidence
    })
  ));

  const leftovers = points.filter(point => !assigned.has(point.id));
  const components = proximityComponents(leftovers, Math.max(18, spacing * 1.75));
  for (const component of components.filter(value => value.length >= 3)) {
    const axis = principalAxis(component);
    const type = axis.elongation >= 5 ? 'line' : (component.length >= 8 ? 'grid' : 'cluster');
    motifs.push(describeMotif(type, component, {
      confidence: type === 'grid' ? 0.72 : (type === 'line' ? 0.66 : 0.55)
    }));
    component.forEach(point => assigned.add(point.id));
  }

  if (!motifs.length && points.length >= 4) {
    motifs.push(describeMotif('cluster', points, { confidence: 0.4 }));
    points.forEach(point => assigned.add(point.id));
  }

  const finalized = finalizeMotifs(motifs);
  const covered = new Set(finalized.flatMap(motif => motif.objectIds));
  const weightedFraction = type => finalized
    .filter(motif => motif.type === type)
    .reduce((sum, motif) => sum + motif.size, 0) / points.length;
  const motifCentroids = finalized.map(motif => motif.centroid);
  const centroidNearest = motifCentroids.map((center, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let other = 0; other < motifCentroids.length; other++) {
      if (other === index) continue;
      nearest = Math.min(nearest, Math.hypot(center.x - motifCentroids[other].x, center.y - motifCentroids[other].y));
    }
    return nearest;
  }).filter(Number.isFinite);
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const margins = [
    (minX - bounds.minX) / width,
    (bounds.maxX - maxX) / width,
    (minY - bounds.minY) / height,
    (bounds.maxY - maxY) / height
  ];
  const horizontalBalance = 1 - clamp(Math.abs(margins[0] - margins[1]));
  const verticalBalance = 1 - clamp(Math.abs(margins[2] - margins[3]));
  return {
    motifs: finalized,
    summary: {
      motifCount: finalized.length,
      coverageFraction: covered.size / points.length,
      lineFraction: weightedFraction('line'),
      arcFraction: weightedFraction('arc'),
      gridFraction: weightedFraction('grid'),
      clusterFraction: weightedFraction('cluster'),
      meanRegularity: mean(finalized.map(motif => motif.regularity)),
      meanSizeFraction: mean(finalized.map(motif => motif.size / points.length)),
      separation: centroidNearest.length ? mean(centroidNearest) / diagonal : 0,
      framingMinMargin: Math.min(...margins),
      framingBalance: (horizontalBalance + verticalBalance) / 2,
      unassignedTargetCount: points.length - covered.size,
      baseSpacing: spacing
    }
  };
}
