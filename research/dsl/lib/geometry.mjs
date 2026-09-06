// Shared numeric helpers for the level DSL. Deliberately dependency-free so the
// decompiler, recompiler, and round-trip checker agree on every definition.

export const EPSILON = 1e-9;
export const TWO_PI = Math.PI * 2;

export function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}

export function deviation(values, average = mean(values)) {
  return values.length
    ? Math.sqrt(mean(values.map(value => (value - average) ** 2)))
    : 0;
}

export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

/** Normalize to [0, 2pi). */
export function normalizeAngle(angle) {
  let value = angle % TWO_PI;
  if (value < 0) value += TWO_PI;
  return value;
}

/** Normalize an undirected direction to [0, pi). */
export function normalizeHalfTurn(angle) {
  let value = angle % Math.PI;
  if (value < 0) value += Math.PI;
  return value;
}

/** Smallest signed difference between two undirected directions. */
export function halfTurnDelta(left, right) {
  let delta = normalizeHalfTurn(left) - normalizeHalfTurn(right);
  if (delta > Math.PI / 2) delta -= Math.PI;
  if (delta < -Math.PI / 2) delta += Math.PI;
  return delta;
}

export function distance(left, right) {
  return Math.hypot(finite(left.x) - finite(right.x), finite(left.y) - finite(right.y));
}

export function centroid(points) {
  return { x: mean(points.map(point => finite(point.x))), y: mean(points.map(point => finite(point.y))) };
}

/**
 * Principal axis of a point set. `angle` is the elongation direction in [0, pi),
 * `elongation` is the ratio of major to minor variance.
 */
export function principalAxis(points) {
  const center = centroid(points);
  const xx = mean(points.map(point => (point.x - center.x) ** 2));
  const yy = mean(points.map(point => (point.y - center.y) ** 2));
  const xy = mean(points.map(point => (point.x - center.x) * (point.y - center.y)));
  const trace = xx + yy;
  const root = Math.sqrt(Math.max(0, ((xx - yy) ** 2) + 4 * xy * xy));
  const major = Math.max(EPSILON, (trace + root) / 2);
  const minor = Math.max(EPSILON, (trace - root) / 2);
  return {
    angle: normalizeHalfTurn(0.5 * Math.atan2(2 * xy, xx - yy)),
    elongation: major / minor,
    center
  };
}

/** Nearest-neighbour distance for every point (used as the natural length unit). */
export function nearestDistances(points) {
  return points.map((point, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let other = 0; other < points.length; other++) {
      if (other === index) continue;
      nearest = Math.min(nearest, distance(point, points[other]));
    }
    return nearest;
  }).filter(Number.isFinite);
}

/**
 * Split a point set into rows perpendicular to `angle`. Returns arrays ordered
 * along the row direction. Used to turn a lattice-like blob back into the rows a
 * designer would actually have drawn.
 */
export function splitIntoRows(points, angle, tolerance) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const normalX = -sin;
  const normalY = cos;
  const decorated = points.map(point => ({
    point,
    along: point.x * cos + point.y * sin,
    across: point.x * normalX + point.y * normalY
  })).sort((left, right) => left.across - right.across);
  const rows = [];
  let current = [];
  let anchor = null;
  for (const item of decorated) {
    if (anchor === null || Math.abs(item.across - anchor) <= tolerance) {
      if (anchor === null) anchor = item.across;
      current.push(item);
    } else {
      rows.push(current);
      current = [item];
      anchor = item.across;
    }
  }
  if (current.length) rows.push(current);
  return rows.map(row => row.sort((left, right) => left.along - right.along).map(item => item.point));
}

/**
 * Greedy nearest-neighbour matching from `from` to `to`. Returns per-point
 * distances plus the unmatched counts. Deterministic: candidates are consumed in
 * ascending distance order.
 */
export function matchPointSets(from, to) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < from.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < to.length; rightIndex++) {
      pairs.push({ leftIndex, rightIndex, d: distance(from[leftIndex], to[rightIndex]) });
    }
  }
  pairs.sort((left, right) => left.d - right.d || left.leftIndex - right.leftIndex || left.rightIndex - right.rightIndex);
  const usedLeft = new Set();
  const usedRight = new Set();
  const matched = [];
  for (const pair of pairs) {
    if (usedLeft.has(pair.leftIndex) || usedRight.has(pair.rightIndex)) continue;
    usedLeft.add(pair.leftIndex);
    usedRight.add(pair.rightIndex);
    matched.push({ ...pair });
  }
  return {
    matched,
    distances: matched.map(pair => pair.d),
    unmatchedFrom: from.length - matched.length,
    unmatchedTo: to.length - matched.length
  };
}

function perpendicularDistance(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return distance(point, from);
  return Math.abs(dy * point.x - dx * point.y + to.x * from.y - to.y * from.x) / length;
}

/**
 * Douglas-Peucker simplification. Turns a baked peg chain back into the few
 * control points a hand would have moved through.
 */
export function simplifyPolyline(points, tolerance) {
  if (points.length <= 2) return [...points];
  let worst = 0;
  let index = 0;
  for (let position = 1; position < points.length - 1; position++) {
    const deviationValue = perpendicularDistance(points[position], points[0], points[points.length - 1]);
    if (deviationValue > worst) {
      worst = deviationValue;
      index = position;
    }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyPolyline(points.slice(0, index + 1), tolerance);
  const right = simplifyPolyline(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** Place `count` points at equal arc length along a polyline. */
export function resamplePolyline(points, count) {
  if (!points.length) return [];
  if (count <= 1 || points.length === 1) return [{ ...points[0] }];
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total < EPSILON) return Array.from({ length: count }, () => ({ ...points[0] }));
  const result = [];
  for (let step = 0; step < count; step++) {
    const target = (total * step) / (count - 1);
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment] < target) segment++;
    const span = cumulative[segment] - cumulative[segment - 1];
    const fraction = span > EPSILON ? (target - cumulative[segment - 1]) / span : 0;
    const a = points[segment - 1];
    const b = points[segment];
    result.push({
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction,
      tangent: Math.atan2(b.y - a.y, b.x - a.x)
    });
  }
  return result;
}

/**
 * Order a blob of points as if they had been drawn in one stroke: start at the
 * point farthest from the centroid and always step to the nearest unvisited
 * neighbour. Chains come out in drawing order; genuine blobs come out zigzagged
 * and are then rejected by the spacing-regularity test.
 */
export function greedyChainOrder(points) {
  if (points.length < 2) return [...points];
  const center = centroid(points);
  let startIndex = 0;
  let best = -Infinity;
  for (let index = 0; index < points.length; index++) {
    const value = distance(points[index], center);
    if (value > best) {
      best = value;
      startIndex = index;
    }
  }
  const visited = new Set([startIndex]);
  const order = [points[startIndex]];
  let current = startIndex;
  while (visited.size < points.length) {
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let index = 0; index < points.length; index++) {
      if (visited.has(index)) continue;
      const value = distance(points[current], points[index]);
      if (value < nearestDistance) {
        nearestDistance = value;
        nearest = index;
      }
    }
    if (nearest < 0) break;
    visited.add(nearest);
    order.push(points[nearest]);
    current = nearest;
  }
  return order;
}

/**
 * Approximate ellipse fit for points spread evenly around a ring. Uses the
 * principal axes and the extent along each; exact enough for deciding whether a
 * chain was drawn as a ring, and cheap enough to run on every candidate.
 * Returns null when the points do not lie on the fitted ellipse.
 */
export function fitEllipse(points, tolerance) {
  if (points.length < 6) return null;
  const axis = principalAxis(points);
  const center = axis.center;
  const cos = Math.cos(axis.angle);
  const sin = Math.sin(axis.angle);
  const local = points.map(point => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
  });
  const radiusU = Math.max(...local.map(point => Math.abs(point.u)));
  const radiusV = Math.max(...local.map(point => Math.abs(point.v)));
  if (radiusU < EPSILON || radiusV < EPSILON) return null;
  // Residual measured as radial distance from the fitted ellipse.
  const residuals = local.map(point => {
    const normalized = Math.hypot(point.u / radiusU, point.v / radiusV);
    const scale = normalized > EPSILON ? 1 / normalized : 1;
    return Math.hypot(point.u - point.u * scale, point.v - point.v * scale);
  });
  const worst = quantile(residuals, 0.9);
  if (worst > tolerance) return null;
  return {
    center,
    radiusU,
    radiusV,
    rotation: axis.angle,
    residual: mean(residuals),
    // Parametric angle of each point, in input order.
    angles: local.map(point => Math.atan2(point.v / radiusV, point.u / radiusU))
  };
}

/** Andrew monotone chain convex hull, counter-clockwise, no repeated endpoint. */
export function convexHull(points) {
  if (points.length < 3) return points.map(point => ({ x: point.x, y: point.y }));
  const sorted = [...points]
    .map(point => ({ x: point.x, y: point.y }))
    .sort((left, right) => left.x - right.x || left.y - right.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function polygonArea(polygon) {
  let total = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function boundsOf(points) {
  return {
    minX: Math.min(...points.map(point => point.x)),
    maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)),
    maxY: Math.max(...points.map(point => point.y))
  };
}

/** Connected components over an adjacency predicate. O(n^2), fine at this scale. */
export function components(items, connected) {
  const adjacency = items.map(() => []);
  for (let left = 0; left < items.length; left++) {
    for (let right = left + 1; right < items.length; right++) {
      if (connected(items[left], items[right])) {
        adjacency[left].push(right);
        adjacency[right].push(left);
      }
    }
  }
  const seen = new Set();
  const result = [];
  for (let index = 0; index < items.length; index++) {
    if (seen.has(index)) continue;
    const group = [];
    const stack = [index];
    seen.add(index);
    while (stack.length) {
      const current = stack.pop();
      group.push(items[current]);
      for (const next of adjacency[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    result.push(group);
  }
  return result;
}
