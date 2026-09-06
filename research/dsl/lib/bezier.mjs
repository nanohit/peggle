// Cubic bezier sampling with arc-length parameterization.
//
// The Alea editor draws a curve and bakes pegs along it at a fixed spacing, so a
// stroke is fully described by four control points plus a start offset and a
// spacing. These helpers make that description invertible.

import { finite } from './geometry.mjs';

const SAMPLES = 512;

function pointAt(curve, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.start.x + b * curve.h1.x + c * curve.h2.x + d * curve.end.x,
    y: a * curve.start.y + b * curve.h1.y + c * curve.h2.y + d * curve.end.y
  };
}

/** Dense sample table with cumulative arc length. */
export function arcLengthTable(curve, samples = SAMPLES) {
  const points = [];
  let length = 0;
  let previous = pointAt(curve, 0);
  points.push({ t: 0, s: 0, ...previous });
  for (let index = 1; index <= samples; index++) {
    const t = index / samples;
    const point = pointAt(curve, t);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    points.push({ t, s: length, ...point });
    previous = point;
  }
  return { points, length };
}

/** Position and tangent angle at a given arc length. */
export function pointAtArcLength(table, s) {
  const clamped = Math.max(0, Math.min(table.length, s));
  const points = table.points;
  let low = 0;
  let high = points.length - 1;
  while (low < high - 1) {
    const middle = (low + high) >> 1;
    if (points[middle].s <= clamped) low = middle;
    else high = middle;
  }
  const a = points[low];
  const b = points[high];
  const span = b.s - a.s;
  const fraction = span > 1e-9 ? (clamped - a.s) / span : 0;
  const x = a.x + (b.x - a.x) * fraction;
  const y = a.y + (b.y - a.y) * fraction;
  const tangent = Math.atan2(b.y - a.y, b.x - a.x);
  return { x, y, tangent };
}

/** Arc length of the table point closest to an arbitrary position. */
export function nearestArcLength(table, position) {
  let best = { s: 0, d: Number.POSITIVE_INFINITY };
  for (const point of table.points) {
    const d = Math.hypot(point.x - finite(position.x), point.y - finite(position.y));
    if (d < best.d) best = { s: point.s, d };
  }
  return best;
}

export function normalizeCurve(curve) {
  const point = value => ({ x: finite(value?.x), y: finite(value?.y) });
  return {
    start: point(curve?.start),
    end: point(curve?.end),
    h1: point(curve?.h1),
    h2: point(curve?.h2)
  };
}
