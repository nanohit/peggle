// Level DSL recompiler: turns a DSL description back into peg positions.
//
// This is the falsification half of the round trip. If the DSL captured the
// authoring gesture, replaying it reproduces the original layout; if it only
// captured a summary, the error shows up here.

import { createRandom } from '../../benchmark/lib/random.mjs';
import { arcLengthTable, normalizeCurve, pointAtArcLength } from './bezier.mjs';
import { boundsOf, finite, pointInPolygon, resamplePolyline, round } from './geometry.mjs';

const DEG = Math.PI / 180;

function interpolate(from, to, count) {
  if (count <= 0) return [];
  if (count === 1) return [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }];
  return Array.from({ length: count }, (_value, index) => {
    const fraction = index / (count - 1);
    return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
  });
}

function recompileArc(stroke) {
  const count = Math.max(1, Math.trunc(stroke.count));
  const start = finite(stroke.startAngleDeg) * DEG;
  const end = finite(stroke.endAngleDeg) * DEG;
  const radius = finite(stroke.radius);
  const center = { x: finite(stroke.center?.x), y: finite(stroke.center?.y) };
  const step = count > 1 ? (end - start) / (count - (stroke.closed ? 0 : 1)) : 0;
  return Array.from({ length: count }, (_value, index) => {
    const angle = start + step * index;
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
      rotation: angle,
      kind: stroke.pegShape === 'brick' ? 'brick' : 'circle'
    };
  });
}

function recompileLine(stroke) {
  const from = { x: finite(stroke.from?.x), y: finite(stroke.from?.y) };
  const to = { x: finite(stroke.to?.x), y: finite(stroke.to?.y) };
  const rotation = stroke.rotationDeg === undefined
    ? Math.atan2(to.y - from.y, to.x - from.x)
    : finite(stroke.rotationDeg) * DEG;
  return interpolate(from, to, Math.max(1, Math.trunc(stroke.count))).map(point => ({
    ...point,
    rotation,
    kind: stroke.pegShape === 'brick' ? 'brick' : 'circle'
  }));
}

function recompileBezier(stroke) {
  const table = arcLengthTable(normalizeCurve(stroke));
  const count = Math.max(1, Math.trunc(stroke.count));
  const startOffset = finite(stroke.startOffsetPx);
  const spacing = finite(stroke.spacingPx) || (count > 1 ? (table.length - startOffset * 2) / (count - 1) : 0);
  return Array.from({ length: count }, (_value, index) => {
    const sample = pointAtArcLength(table, startOffset + spacing * index);
    return {
      x: sample.x,
      y: sample.y,
      rotation: sample.tangent,
      kind: stroke.pegShape === 'brick' ? 'brick' : 'circle'
    };
  });
}

/**
 * A stroke describes where pegs were placed. If those pegs sit on a motion rig,
 * their exported snapshot is the anchor displaced by the rig radius at each
 * member's phase, so replay has to apply that offset to be comparable.
 */
function applyRig(points, rig) {
  if (!rig || rig.geometry === 'inPlace') return points;
  const radiusU = finite(rig.radiusU, finite(rig.radiusPx));
  const radiusV = finite(rig.radiusV, radiusU);
  return points.map((point, index) => {
    const phase = finite(rig.phases?.[index]);
    switch (rig.geometry) {
      case 'circular':
        return { ...point, x: point.x + radiusU * Math.cos(phase * DEG), y: point.y + radiusV * Math.sin(phase * DEG) };
      case 'horizontal':
        return { ...point, x: point.x + phase };
      case 'vertical':
        return { ...point, y: point.y + phase };
      case 'inPlace':
        return point;
      default:
        return { ...point, x: point.x + phase, y: point.y + finite(rig.phasesSecondary?.[index]) };
    }
  });
}

/**
 * Deterministic dart-throwing inside the field region. Positions will not match
 * the original and are not supposed to: a field claims a population and a
 * packing distance, and that is what the round trip checks.
 */
function recompileField(stroke) {
  const region = (stroke.region || []).map(point => ({ x: finite(point.x), y: finite(point.y) }));
  if (region.length < 3) return [];
  const box = boundsOf(region);
  const random = createRandom(String(stroke.seed || 'field'));
  const minSpacing = Math.max(1, finite(stroke.minSpacingPx, 12));
  const wanted = Math.max(1, Math.trunc(stroke.count));
  const placed = [];
  const limit = wanted * 400;
  for (let attempt = 0; attempt < limit && placed.length < wanted; attempt++) {
    const candidate = {
      x: random.range(box.minX, box.maxX),
      y: random.range(box.minY, box.maxY)
    };
    if (!pointInPolygon(candidate, region)) continue;
    if (placed.some(point => Math.hypot(point.x - candidate.x, point.y - candidate.y) < minSpacing)) continue;
    placed.push(candidate);
  }
  return placed.map(point => ({
    ...point,
    rotation: 0,
    kind: stroke.pegShape === 'brick' ? 'brick' : 'circle'
  }));
}

function recompileEllipse(stroke) {
  const count = Math.max(1, Math.trunc(stroke.count));
  const center = { x: finite(stroke.center?.x), y: finite(stroke.center?.y) };
  const radiusU = finite(stroke.radiusU);
  const radiusV = finite(stroke.radiusV);
  const rotation = finite(stroke.rotationDeg) * DEG;
  const start = finite(stroke.startAngleDeg) * DEG;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const step = (Math.PI * 2) / count;
  return Array.from({ length: count }, (_value, index) => {
    const angle = start + step * index;
    const u = radiusU * Math.cos(angle);
    const v = radiusV * Math.sin(angle);
    return {
      x: center.x + u * cos - v * sin,
      y: center.y + u * sin + v * cos,
      rotation: angle,
      kind: stroke.pegShape === 'brick' ? 'brick' : 'circle'
    };
  });
}

function recompilePath(stroke) {
  const controlPoints = (stroke.controlPoints || []).map(point => ({ x: finite(point.x), y: finite(point.y) }));
  if (!controlPoints.length) return [];
  return resamplePolyline(controlPoints, Math.max(1, Math.trunc(stroke.count))).map(sample => ({
    x: sample.x,
    y: sample.y,
    rotation: finite(sample.tangent),
    kind: stroke.pegShape === 'brick' ? 'brick' : 'circle'
  }));
}

export function recompileStroke(stroke) {
  let points;
  switch (stroke.type) {
    case 'arc': points = recompileArc(stroke); break;
    case 'bezier': points = recompileBezier(stroke); break;
    case 'path': points = recompilePath(stroke); break;
    case 'field': points = recompileField(stroke); break;
    case 'ellipse': points = recompileEllipse(stroke); break;
    case 'line':
    case 'bar':
    case 'brickChain': points = recompileLine(stroke); break;
    default: return [];
  }
  return applyRig(points, stroke.rig);
}

/**
 * Full replay: every stroke plus the residual objects the DSL failed to explain.
 * Residual points are copied verbatim and flagged, so they can be excluded from
 * any honest accuracy claim.
 */
export function recompileLevel(dsl) {
  const points = [];
  for (const stroke of dsl.strokes || []) {
    for (const point of recompileStroke(stroke)) {
      points.push({ ...point, strokeId: stroke.id, strokeType: stroke.type, evidence: stroke.evidence });
    }
  }
  const residual = (dsl.residual || []).map(object => ({
    x: finite(object.x),
    y: finite(object.y),
    rotation: finite(object.rotationDeg) * DEG,
    kind: object.kind,
    strokeId: null,
    strokeType: 'residual',
    evidence: 'verbatim'
  }));
  return {
    points,
    residual,
    all: [...points, ...residual],
    counts: {
      fromStrokes: points.length,
      verbatimResidual: residual.length,
      total: points.length + residual.length
    }
  };
}

export function summarizeStroke(stroke) {
  const shape = stroke.pegShape === 'brick' ? 'brick' : 'peg';
  switch (stroke.type) {
    case 'arc':
      return `arc r=${round(stroke.radius, 0)} span=${round(stroke.spanDeg, 0)}° ×${stroke.count} ${shape}${stroke.closed ? ' (closed ring)' : ''}`;
    case 'bezier':
      return `bezier len=${round(stroke.curveLengthPx, 0)} step=${round(stroke.spacingPx, 0)} ×${stroke.count} ${shape}`;
    case 'brickChain':
      return `brick chain ${round(stroke.rotationDeg, 0)}° ×${stroke.count}`;
    case 'bar':
      return `single brick ${round(stroke.rotationDeg, 0)}°`;
    case 'line':
      return `line step=${round(stroke.spacingPx, 0)} ×${stroke.count} ${shape}${stroke.latticeOf ? ` (${stroke.latticeOf} row)` : ''}`;
    case 'path':
      return `freehand path ${stroke.controlPoints?.length ?? 0} control points step=${round(stroke.spacingPx, 0)} ×${stroke.count} ${shape}`;
    default:
      return `${stroke.type} ×${stroke.count}`;
  }
}
