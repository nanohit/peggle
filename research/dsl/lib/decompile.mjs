// Level DSL decompiler.
//
// Turns a canonical research level record back into the authoring gestures that
// most plausibly produced it: skeleton, strokes, motion rigs, orange policy.
//
// Two classes of evidence are kept strictly apart:
//
//   exact    - recovered by inverting parameters the source editor actually
//              stored (PeggleEdit curved-brick Origin/Radius, movement rigs,
//              Alea bezier control points). These are inversions, not guesses.
//   inferred - fitted geometrically from peg positions when the source format
//              stored no authoring parameters (plain circle pegs).
//
// Two rules keep the fitting honest:
//
//   1. A stroke must be CONTIGUOUS and EVENLY SPACED. A set of collinear pegs
//      scattered along an infinite line is not a gesture; splitting on spacing
//      outliers is what separates a drawn chain from a coincidence.
//   2. A moving peg's authored position is its rig ANCHOR, not the snapshot in
//      `transform`. Fitting geometry to a runtime phase fits noise.
//
// Anything that survives neither path stays in `residual` verbatim. The residual
// fraction is the honest measure of how poor the DSL still is.

import { analyzeLevelMotifs } from '../../benchmark/lib/motifs.mjs';
import { arcLengthTable, nearestArcLength, normalizeCurve } from './bezier.mjs';
import { recompileStroke } from './recompile.mjs';
import {
  TWO_PI, centroid, components, convexHull, deviation, distance, finite, fitEllipse,
  greedyChainOrder, halfTurnDelta, mean, median, nearestDistances, normalizeAngle,
  polygonArea, principalAxis, round, simplifyPolyline, splitIntoRows
} from './geometry.mjs';

const TOOL_VERSION = '0.5.0';
const MAX_SPACING_CV = 0.28;
const MAX_PATH_SPACING_CV = 0.38;
const MAX_REPLAY_MEDIAN_PX = 3;
const MAX_REPLAY_P90_PX = 10;
const MIN_RUN = 3;
const MIN_FIELD = 6;

function targetsOf(record) {
  return (record?.authored?.objects || []).filter(object => object.role === 'target');
}

/**
 * The position the designer placed. For a moving object that is the rig anchor;
 * `transform` only records where it happened to be at export phase.
 */
function authoredPoint(object) {
  const movement = object.movement?.Movement;
  if (movement && Number.isFinite(Number(movement.AnchorPointX)) && Number.isFinite(Number(movement.AnchorPointY))) {
    return { x: finite(movement.AnchorPointX), y: finite(movement.AnchorPointY) };
  }
  return { x: finite(object.transform?.x), y: finite(object.transform?.y) };
}

function snapshotPoint(object) {
  return { x: finite(object.transform?.x), y: finite(object.transform?.y) };
}

function isCurvedBrick(object) {
  return object.kind === 'brick' && !!object.geometry?.curved;
}

function brickSize(object) {
  return {
    width: round(finite(object.geometry?.width, 34), 2),
    height: round(finite(object.geometry?.height, 10.2), 2)
  };
}

function spacingCv(values) {
  const average = mean(values);
  return average > 1e-9 ? deviation(values, average) / average : 0;
}

/** Order members around a centre, unrolled from the largest angular gap. */
function orderAroundCenter(members, center, pointOf = authoredPoint) {
  const decorated = members
    .map(object => ({ object, angle: normalizeAngle(Math.atan2(pointOf(object).y - center.y, pointOf(object).x - center.x)) }))
    .sort((left, right) => left.angle - right.angle);
  if (decorated.length < 2) return { ordered: decorated, largestGap: TWO_PI };
  const gaps = decorated.map((item, index) => {
    const next = index + 1 < decorated.length ? decorated[index + 1].angle : decorated[0].angle + TWO_PI;
    return next - item.angle;
  });
  const largestGap = Math.max(...gaps);
  const startIndex = (gaps.indexOf(largestGap) + 1) % decorated.length;
  const ordered = [];
  for (let offset = 0; offset < decorated.length; offset++) {
    const source = decorated[(startIndex + offset) % decorated.length];
    let angle = source.angle;
    while (ordered.length && angle < ordered[ordered.length - 1].angle) angle += TWO_PI;
    ordered.push({ object: source.object, angle });
  }
  return { ordered, largestGap };
}

/** Split an ordered sequence wherever the step jumps well above the norm. */
function splitRuns(items, stepOf, absoluteFloor) {
  if (items.length < 2) return [items];
  const steps = items.slice(1).map((item, index) => stepOf(items[index], item));
  const typical = median(steps.filter(step => step > 1e-9)) || 1e-9;
  const limit = Math.max(typical * 2.2, typical + absoluteFloor);
  const runs = [];
  let current = [items[0]];
  for (let index = 1; index < items.length; index++) {
    if (steps[index - 1] > limit) {
      runs.push(current);
      current = [];
    }
    current.push(items[index]);
  }
  runs.push(current);
  return runs;
}

/* ------------------------------------------------------------------ *
 * Exact recovery
 * ------------------------------------------------------------------ */

/**
 * PeggleEdit stores each curved brick's centre of curvature and radius, so
 * bricks sharing them were emitted by one drawn arc.
 */
function recoverAuthoredArcs(targets) {
  const curved = targets.filter(isCurvedBrick).filter(object => object.source?.raw?.Origin);
  const groups = new Map();
  for (const object of curved) {
    const raw = object.source.raw;
    const key = [Math.round(finite(raw.Origin.x) * 4), Math.round(finite(raw.Origin.y) * 4), Math.round(finite(raw.Radius) * 4)].join('|');
    if (!groups.has(key)) {
      groups.set(key, { center: { x: finite(raw.Origin.x), y: finite(raw.Origin.y) }, radius: finite(raw.Radius), members: [] });
    }
    groups.get(key).members.push(object);
  }
  const strokes = [];
  for (const group of groups.values()) {
    const { ordered } = orderAroundCenter(group.members, group.center, snapshotPoint);
    for (const run of splitRuns(ordered, (left, right) => right.angle - left.angle, 0.02)) {
      if (!run.length) continue;
      const size = brickSize(run[0].object);
      const startAngle = run[0].angle;
      const endAngle = run[run.length - 1].angle;
      const span = endAngle - startAngle;
      const steps = run.slice(1).map((item, index) => item.angle - run[index].angle);
      strokes.push({
        type: 'arc',
        evidence: 'exact',
        source: 'peggleedit-curved-brick-origin',
        pegShape: 'brick',
        center: { x: round(group.center.x, 2), y: round(group.center.y, 2) },
        radius: round(group.radius, 2),
        startAngleDeg: round(startAngle * 180 / Math.PI, 3),
        endAngleDeg: round(endAngle * 180 / Math.PI, 3),
        spanDeg: round(span * 180 / Math.PI, 2),
        count: run.length,
        closed: span >= TWO_PI * 0.97,
        stepCv: round(spacingCv(steps), 3),
        brick: size,
        sectorAngleDeg: round(finite(run[0].object.source?.raw?.SectorAngle), 2),
        objectIds: run.map(item => String(item.object.id))
      });
    }
  }
  return strokes;
}

/** Straight bricks laid end to end along a shared axis are one authored bar. */
function recoverStraightBrickBars(targets, assigned) {
  const bricks = targets.filter(object => (
    object.kind === 'brick' && !isCurvedBrick(object) && !assigned.has(String(object.id))
  ));
  if (!bricks.length) return [];
  const connected = (left, right) => {
    if (Math.abs(halfTurnDelta(finite(left.transform?.rotation), finite(right.transform?.rotation))) > 0.11) return false;
    const a = snapshotPoint(left);
    const b = snapshotPoint(right);
    const gap = distance(a, b);
    const width = Math.max(finite(left.geometry?.width, 34), finite(right.geometry?.width, 34));
    if (gap > width * 1.45) return false;
    return Math.abs(halfTurnDelta(Math.atan2(b.y - a.y, b.x - a.x), finite(left.transform?.rotation))) < 0.45;
  };
  const strokes = [];
  for (const group of components(bricks, connected)) {
    const rotation = finite(group[0].transform?.rotation);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const sorted = [...group].sort((left, right) => (
      (snapshotPoint(left).x * cos + snapshotPoint(left).y * sin)
      - (snapshotPoint(right).x * cos + snapshotPoint(right).y * sin)
    ));
    const from = snapshotPoint(sorted[0]);
    const to = snapshotPoint(sorted[sorted.length - 1]);
    strokes.push({
      type: group.length === 1 ? 'bar' : 'brickChain',
      evidence: 'exact',
      source: 'peggleedit-straight-brick-axis',
      pegShape: 'brick',
      from: { x: round(from.x, 2), y: round(from.y, 2) },
      to: { x: round(to.x, 2), y: round(to.y, 2) },
      rotationDeg: round(rotation * 180 / Math.PI, 3),
      count: group.length,
      brick: brickSize(group[0]),
      objectIds: sorted.map(object => String(object.id))
    });
  }
  return strokes;
}

/** Alea bezier strokes: the editor stores the control points outright. */
function recoverAleaBezierStrokes(record, targets, assigned) {
  const curves = record?.extensions?.nativeLevel?.bezierCurves;
  if (!curves || typeof curves !== 'object') return [];
  const byCurve = new Map();
  for (const object of targets) {
    if (assigned.has(String(object.id))) continue;
    const curveId = object.source?.raw?.bezierGroupId ?? object.properties?.bezierGroupId ?? null;
    if (!curveId) continue;
    if (!byCurve.has(curveId)) byCurve.set(curveId, []);
    byCurve.get(curveId).push(object);
  }
  const strokes = [];
  for (const [curveId, members] of byCurve) {
    const curve = curves[curveId];
    if (!curve) continue;
    const ordered = [...members].sort((left, right) => (
      finite(left.source?.raw?.bezierIndex ?? left.properties?.bezierIndex)
      - finite(right.source?.raw?.bezierIndex ?? right.properties?.bezierIndex)
    ));
    const table = arcLengthTable(normalizeCurve(curve));
    const arcPositions = ordered.map(object => nearestArcLength(table, snapshotPoint(object)).s);
    const steps = arcPositions.slice(1).map((value, index) => value - arcPositions[index]);
    strokes.push({
      type: 'bezier',
      evidence: 'exact',
      source: 'alea-bezier-curve-store',
      pegShape: String(curve.pegShape || 'circle'),
      pegType: String(curve.pegType || 'blue'),
      start: { x: round(curve.start?.x, 2), y: round(curve.start?.y, 2) },
      end: { x: round(curve.end?.x, 2), y: round(curve.end?.y, 2) },
      h1: { x: round(curve.h1?.x, 2), y: round(curve.h1?.y, 2) },
      h2: { x: round(curve.h2?.x, 2), y: round(curve.h2?.y, 2) },
      count: ordered.length,
      startOffsetPx: round(arcPositions[0] || 0, 2),
      spacingPx: round(steps.length ? median(steps) : 0, 2),
      curveLengthPx: round(table.length, 2),
      curveId: String(curveId),
      objectIds: ordered.map(object => String(object.id))
    });
  }
  return strokes;
}

/* ------------------------------------------------------------------ *
 * Inferred recovery
 * ------------------------------------------------------------------ */

function makeLineStroke(members, sourceLabel, extra = {}) {
  const points = members.map(authoredPoint);
  const axis = principalAxis(points);
  const cos = Math.cos(axis.angle);
  const sin = Math.sin(axis.angle);
  const sorted = [...members].sort((left, right) => (
    (authoredPoint(left).x * cos + authoredPoint(left).y * sin)
    - (authoredPoint(right).x * cos + authoredPoint(right).y * sin)
  ));
  const spacings = sorted.slice(1).map((object, index) => distance(authoredPoint(object), authoredPoint(sorted[index])));
  const from = authoredPoint(sorted[0]);
  const to = authoredPoint(sorted[sorted.length - 1]);
  return {
    type: 'line',
    evidence: 'inferred',
    source: sourceLabel,
    pegShape: sorted[0].kind === 'brick' ? 'brick' : 'circle',
    from: { x: round(from.x, 2), y: round(from.y, 2) },
    to: { x: round(to.x, 2), y: round(to.y, 2) },
    count: sorted.length,
    spacingPx: round(median(spacings), 2),
    spacingCv: round(spacingCv(spacings), 3),
    objectIds: sorted.map(object => String(object.id)),
    ...extra
  };
}

/**
 * Turn a collinear member set into contiguous, evenly spaced runs. Runs that
 * stay irregular after splitting are rejected: they were never one gesture.
 */
function emitLineRuns(members, sourceLabel, extra = {}) {
  if (members.length < MIN_RUN) return [];
  const points = members.map(authoredPoint);
  const axis = principalAxis(points);
  const cos = Math.cos(axis.angle);
  const sin = Math.sin(axis.angle);
  const sorted = [...members].sort((left, right) => (
    (authoredPoint(left).x * cos + authoredPoint(left).y * sin)
    - (authoredPoint(right).x * cos + authoredPoint(right).y * sin)
  ));
  const runs = splitRuns(sorted, (left, right) => distance(authoredPoint(left), authoredPoint(right)), 4);
  const strokes = [];
  for (const run of runs) {
    if (run.length < MIN_RUN) continue;
    const stroke = makeLineStroke(run, sourceLabel, extra);
    if (stroke.spacingCv > MAX_SPACING_CV) continue;
    strokes.push(stroke);
  }
  return strokes;
}

function emitArcRuns(members, center, sourceLabel) {
  if (members.length < 5) return [];
  const { ordered } = orderAroundCenter(members, center);
  const strokes = [];
  for (const run of splitRuns(ordered, (left, right) => right.angle - left.angle, 0.03)) {
    if (run.length < 5) continue;
    const radii = run.map(item => distance(authoredPoint(item.object), center));
    const steps = run.slice(1).map((item, index) => item.angle - run[index].angle);
    // A tight radius tolerance is what stops an ellipse from being shredded into
    // several plausible-looking circular fragments.
    if (spacingCv(steps) > MAX_SPACING_CV || spacingCv(radii) > 0.02) continue;
    const startAngle = run[0].angle;
    const endAngle = run[run.length - 1].angle;
    strokes.push({
      type: 'arc',
      evidence: 'inferred',
      source: sourceLabel,
      pegShape: run[0].object.kind === 'brick' ? 'brick' : 'circle',
      center: { x: round(center.x, 2), y: round(center.y, 2) },
      radius: round(median(radii), 2),
      startAngleDeg: round(startAngle * 180 / Math.PI, 3),
      endAngleDeg: round(endAngle * 180 / Math.PI, 3),
      spanDeg: round((endAngle - startAngle) * 180 / Math.PI, 2),
      count: run.length,
      closed: (endAngle - startAngle) >= TWO_PI * 0.97,
      stepCv: round(spacingCv(steps), 3),
      objectIds: run.map(item => String(item.object.id))
    });
  }
  return strokes;
}

/**
 * Freehand chains. A figurative Peggle level (`baseball`, `bug`) is not built
 * from lines and circles: pegs trace an outline at roughly constant spacing
 * along an arbitrary curve. That is still one gesture, and a simplified
 * polyline is its natural description.
 */
function emitPathStrokes(members, baseSpacing) {
  if (members.length < 4) return [];
  const decorated = members.map(object => ({ ...authoredPoint(object), object }));
  const groups = components(decorated, (left, right) => distance(left, right) <= baseSpacing * 1.75);
  const strokes = [];
  for (const group of groups) {
    if (group.length < 4) continue;
    const ordered = greedyChainOrder(group);
    for (const run of splitRuns(ordered, (left, right) => distance(left, right), 4)) {
      if (run.length < 4) continue;
      const spacings = run.slice(1).map((point, index) => distance(run[index], point));
      if (spacingCv(spacings) > MAX_PATH_SPACING_CV) continue;

      // A chain that closes on itself around a common centre is a ring, not a
      // freehand squiggle. Rings are common in Peggle and cheap to describe.
      const ellipse = fitEllipse(run.map(point => ({ x: point.x, y: point.y })), Math.max(2.5, baseSpacing * 0.18));
      if (ellipse && run.length >= 8) {
        strokes.push({
          type: 'ellipse',
          evidence: 'inferred',
          source: 'geometric-ring-fit',
          pegShape: run[0].object.kind === 'brick' ? 'brick' : 'circle',
          center: { x: round(ellipse.center.x, 2), y: round(ellipse.center.y, 2) },
          radiusU: round(ellipse.radiusU, 2),
          radiusV: round(ellipse.radiusV, 2),
          rotationDeg: round(ellipse.rotation * 180 / Math.PI, 2),
          startAngleDeg: round(ellipse.angles[0] * 180 / Math.PI, 2),
          count: run.length,
          closed: true,
          residualPx: round(ellipse.residual, 2),
          objectIds: run.map(point => String(point.object.id))
        });
        continue;
      }

      const controlPoints = simplifyPolyline(run.map(point => ({ x: point.x, y: point.y })), Math.max(2, baseSpacing * 0.22));
      // A path that needs a control point for nearly every peg explains nothing.
      if (controlPoints.length > Math.max(3, run.length * 0.45)) continue;
      strokes.push({
        type: 'path',
        evidence: 'inferred',
        source: 'geometric-chain-fit',
        pegShape: run[0].object.kind === 'brick' ? 'brick' : 'circle',
        controlPoints: controlPoints.map(point => ({ x: round(point.x, 2), y: round(point.y, 2) })),
        count: run.length,
        spacingPx: round(median(spacings), 2),
        spacingCv: round(spacingCv(spacings), 3),
        objectIds: run.map(point => String(point.object.id))
      });
    }
  }
  return strokes;
}

/**
 * A stroke may only claim objects it can actually reproduce. Without this a
 * degenerate fit - two control points standing in for forty pegs - passes the
 * structural counters while describing nothing. Rejected candidates fall
 * through to the next pass and ultimately to the scatter field, which is the
 * honest place for them.
 *
 * Verification uses authored anchors, because that is what a stroke describes;
 * the rig offset is applied later.
 */
function strokeReplayError(stroke, byId) {
  const rebuilt = recompileStroke(stroke);
  const originals = (stroke.objectIds || []).map(id => byId.get(String(id))).filter(Boolean).map(authoredPoint);
  const pairCount = Math.min(rebuilt.length, originals.length);
  if (!pairCount) return { median: Infinity, p90: Infinity };
  const distances = [];
  for (let position = 0; position < pairCount; position++) {
    distances.push(distance(originals[position], rebuilt[position]));
  }
  const sorted = [...distances].sort((left, right) => left - right);
  return {
    median: median(distances),
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
  };
}

function inferStrokesFromPositions(record, targets, assigned) {
  const remaining = targets.filter(object => !assigned.has(String(object.id)));
  if (remaining.length < MIN_RUN) return { strokes: [], residual: remaining };

  // Motif detection must see authored anchors, not runtime phase snapshots.
  const projected = remaining.map(object => ({
    ...object,
    transform: { ...object.transform, ...authoredPoint(object) }
  }));
  const analysis = analyzeLevelMotifs({
    authored: { objects: projected, coordinateSystem: record.authored.coordinateSystem }
  });
  const byId = new Map(remaining.map(object => [String(object.id), object]));
  const claimed = new Set();
  const strokes = [];
  const accept = candidates => {
    for (const stroke of candidates) {
      if (stroke.objectIds.some(id => claimed.has(String(id)))) continue;
      const replay = strokeReplayError(stroke, byId);
      if (replay.median > MAX_REPLAY_MEDIAN_PX || replay.p90 > MAX_REPLAY_P90_PX) continue;
      stroke.replayMedianPx = round(replay.median, 3);
      strokes.push(stroke);
      stroke.objectIds.forEach(id => claimed.add(String(id)));
    }
  };

  for (const motif of analysis.motifs) {
    const members = motif.objectIds
      .map(id => byId.get(String(id)))
      .filter(object => object && !claimed.has(String(object.id)));
    if (members.length < MIN_RUN) continue;

    if (motif.type === 'arc' && motif.center) {
      accept(emitArcRuns(members, { x: finite(motif.center.x), y: finite(motif.center.y) }, 'geometric-arc-fit'));
      continue;
    }
    if (motif.type === 'line') {
      accept(emitLineRuns(members, 'geometric-line-fit'));
      continue;
    }
    // grid / cluster: decompose into the rows a designer would have drawn.
    const points = members.map(authoredPoint);
    const axis = principalAxis(points);
    const spacing = Math.max(8, median(nearestDistances(points)) || 24);
    const rows = splitIntoRows(members.map(object => ({ ...authoredPoint(object), object })), axis.angle, spacing * 0.45);
    for (const row of rows) {
      if (row.length < MIN_RUN) continue;
      accept(emitLineRuns(row.map(item => item.object), `geometric-${motif.type}-row-fit`, { latticeOf: motif.type }));
    }
  }

  // Second pass: whatever regular lines and arcs could not claim may still be a
  // freehand chain.
  const leftover = remaining.filter(object => !claimed.has(String(object.id)));
  if (leftover.length >= 4) {
    const baseSpacing = Math.max(8, median(nearestDistances(leftover.map(authoredPoint))) || 24);
    accept(emitPathStrokes(leftover, baseSpacing));
  }

  // Third pass: hand-scattered filler. Positions here are not a gesture, so the
  // field records where and how densely, and replay is judged distributionally.
  const scattered = remaining.filter(object => !claimed.has(String(object.id)));
  if (scattered.length >= MIN_FIELD) {
    const field = makeFieldStroke(scattered);
    if (field) {
      strokes.push(field);
      field.objectIds.forEach(id => claimed.add(String(id)));
    }
  }

  remaining.forEach(object => {
    if (claimed.has(String(object.id))) assigned.add(String(object.id));
  });
  return { strokes, residual: remaining.filter(object => !claimed.has(String(object.id))) };
}

/**
 * Hand-scattered filler pegs. A designer thinks "loosely fill this area", not
 * "put a peg at 412,287". Exact positions carry no intent, so a field stores the
 * region, the population, and the packing distance - and the round trip judges
 * it on those, never on positional error.
 */
function makeFieldStroke(members) {
  const points = members.map(authoredPoint);
  const hull = simplifyPolyline([...convexHull(points), convexHull(points)[0]], 6).slice(0, -1);
  if (hull.length < 3) return null;
  const spacings = nearestDistances(points);
  return {
    type: 'field',
    evidence: 'inferred',
    source: 'scatter-region-fit',
    pegShape: members[0].kind === 'brick' ? 'brick' : 'circle',
    region: hull.map(point => ({ x: round(point.x, 1), y: round(point.y, 1) })),
    areaPx2: round(polygonArea(hull), 0),
    count: members.length,
    minSpacingPx: round(Math.min(...spacings), 2),
    medianSpacingPx: round(median(spacings), 2),
    spacingCv: round(spacingCv(spacings), 3),
    seed: `field:${members.length}:${Math.round(polygonArea(hull))}`,
    objectIds: members.map(object => String(object.id))
  };
}

/* ------------------------------------------------------------------ *
 * Rigs, skeleton, orange
 * ------------------------------------------------------------------ */

/**
 * How a rig displaces its object from the anchor. PeggleEdit rig names encode
 * the path shape, and each shape needs a different one-parameter description of
 * where along it a given member currently sits.
 */
const RIG_GEOMETRY = new Map([
  ['Circle', 'circular'], ['RotateAroundCircle', 'circular'], ['RetraceCircle', 'circular'],
  ['HorizontalCycle', 'horizontal'], ['HorizontalWrap', 'horizontal'],
  ['HorizontalInfinity', 'horizontal'], ['HorizontalArc', 'horizontal'],
  ['VerticalCycle', 'vertical'], ['VerticalWrap', 'vertical'], ['VericalInfinity', 'vertical'],
  ['Rotate', 'inPlace'], ['RotateBackAndForth', 'inPlace'], ['NoMovement', 'inPlace']
]);

function rigGeometry(name) {
  return RIG_GEOMETRY.get(String(name)) || 'free';
}

/**
 * Motion rigs are grouped by KIND, not by anchor: in a level like `dna` every
 * peg rides its own anchor with the same radius and period, and the anchors are
 * the drawn geometry. One phase parameter per member makes the snapshot
 * replayable without storing coordinates twice.
 */
function recoverMotionRigs(targets) {
  const moving = targets.filter(object => object.movement?.Movement);
  const rigs = new Map();
  for (const object of moving) {
    const m = object.movement.Movement;
    const key = [
      String(m.Type), Math.round(finite(m.Radius1) * 10), Math.round(finite(m.Radius2) * 10),
      Math.round(finite(m.TimePeriod)), Math.round(finite(m.Speed) * 100), m.Reverse ? 1 : 0
    ].join('|');
    if (!rigs.has(key)) rigs.set(key, { movement: m, members: [] });
    rigs.get(key).members.push(object);
  }
  return [...rigs.values()].map(rig => {
    const m = rig.movement;
    const geometry = rigGeometry(m.Type);
    const displacements = rig.members.map(object => {
      const anchor = authoredPoint(object);
      const snapshot = snapshotPoint(object);
      return { dx: snapshot.x - anchor.x, dy: snapshot.y - anchor.y };
    });
    // A PeggleEdit circular rig carries two radii: the orbit is an ellipse, and
    // the phase only means anything in that ellipse's parameter space.
    const radiusU = finite(m.Radius1) || finite(m.Radius2) || 1;
    const radiusV = finite(m.Radius2) || finite(m.Radius1) || 1;
    const phases = displacements.map(displacement => {
      if (geometry === 'circular') {
        return round(Math.atan2(displacement.dy / radiusV, displacement.dx / radiusU) * 180 / Math.PI, 2);
      }
      if (geometry === 'horizontal') return round(displacement.dx, 2);
      if (geometry === 'vertical') return round(displacement.dy, 2);
      if (geometry === 'inPlace') return 0;
      return round(displacement.dx, 2);
    });
    const secondary = geometry === 'free' ? displacements.map(displacement => round(displacement.dy, 2)) : null;
    const magnitudes = displacements.map(displacement => Math.hypot(displacement.dx, displacement.dy));
    return {
      type: 'motionRig',
      evidence: 'exact',
      source: 'peggleedit-movement-info',
      rig: String(m.Type),
      geometry,
      radius1: round(finite(m.Radius1), 2),
      radius2: round(finite(m.Radius2), 2),
      observedOffsetPx: round(median(magnitudes), 2),
      speed: round(finite(m.Speed), 3),
      timePeriodMs: round(finite(m.TimePeriod), 0),
      reverse: !!m.Reverse,
      objectCount: rig.members.length,
      phases,
      ...(secondary ? { phasesSecondary: secondary } : {}),
      objectIds: rig.members.map(object => String(object.id))
    };
  });
}

function recoverAleaRigs(record, targets) {
  const groups = record?.extensions?.nativeLevel?.groups || [];
  const membersByGroup = new Map();
  for (const object of targets) {
    const groupId = object.source?.raw?.groupId ?? object.properties?.groupId ?? null;
    if (!groupId) continue;
    if (!membersByGroup.has(String(groupId))) membersByGroup.set(String(groupId), []);
    membersByGroup.get(String(groupId)).push(String(object.id));
  }
  return groups.filter(group => group?.animation).map(group => {
    const a = group.animation;
    const objectIds = membersByGroup.get(String(group.id)) || [];
    return {
      type: 'motionRig',
      evidence: 'exact',
      source: 'alea-group-animation',
      rig: a.circularPath ? 'Circle' : (finite(a.rotation) ? 'Rotate' : (a.wrap ? 'Wrap' : 'Cycle')),
      dx: round(finite(a.dx), 2),
      dy: round(finite(a.dy), 2),
      rotationRad: round(finite(a.rotation), 4),
      durationSec: round(finite(a.duration), 3),
      easing: String(a.easing || 'linear'),
      hitTrigger: !!a.hitTrigger,
      hitMode: a.hitMode ? String(a.hitMode) : null,
      hitSteps: finite(a.hitSteps, 0) || null,
      wrap: !!a.wrap,
      groupId: String(group.id),
      objectCount: objectIds.length,
      // Alea groups animate in place; members keep their authored coordinates,
      // so no per-member phase is needed.
      geometry: 'inPlace',
      objectIds
    };
  });
}

/** Best vertical mirror axis and how much of the level actually obeys it. */
function detectMirrorSkeleton(record, targets) {
  const points = targets.map(object => ({ ...authoredPoint(object), kind: object.kind, id: String(object.id) }));
  if (points.length < 6) return { axisX: 0, symmetry: 0, matched: 0, total: points.length, tolerancePx: 0 };
  const bounds = record.authored.coordinateSystem?.bounds || { minX: 0, maxX: 646 };
  const launchAxis = finite(record.authored.mechanics?.launchAxis?.x, (finite(bounds.minX) + finite(bounds.maxX)) / 2);
  const center = centroid(points);
  const spacing = Math.max(8, median(nearestDistances(points)) || 24);
  const tolerance = Math.max(5, spacing * 0.32);
  const candidates = new Set([
    round(launchAxis, 1),
    round((finite(bounds.minX) + finite(bounds.maxX)) / 2, 1),
    round(center.x, 1)
  ]);
  for (let offset = -24; offset <= 24; offset += 1.5) candidates.add(round(center.x + offset, 1));
  let best = { axisX: center.x, matched: 0, score: 0 };
  for (const axisX of candidates) {
    let matched = 0;
    for (const point of points) {
      if (Math.abs(point.x - axisX) <= tolerance) { matched++; continue; }
      const mirrorX = 2 * axisX - point.x;
      const found = points.some(other => (
        other.id !== point.id && other.kind === point.kind
        && Math.abs(other.x - mirrorX) <= tolerance && Math.abs(other.y - point.y) <= tolerance
      ));
      if (found) matched++;
    }
    const score = matched / points.length;
    if (score > best.score) best = { axisX, matched, score };
  }
  return {
    axisX: round(best.axisX, 2),
    symmetry: round(best.score, 3),
    matched: best.matched,
    total: points.length,
    tolerancePx: round(tolerance, 2)
  };
}

function classifySkeleton(mirror, strokes, targets) {
  const arcs = strokes.filter(stroke => stroke.type === 'arc');
  const arcShare = arcs.reduce((sum, stroke) => sum + stroke.count, 0) / Math.max(1, targets.length);
  let radial = null;
  if (arcs.length >= 2) {
    const centers = arcs.map(stroke => stroke.center);
    const middle = centroid(centers);
    const spread = mean(centers.map(point => distance(point, middle)));
    if (spread < 60 && arcShare > 0.35) {
      radial = { center: { x: round(middle.x, 2), y: round(middle.y, 2) }, spreadPx: round(spread, 2) };
    }
  }
  const lattice = strokes.filter(stroke => stroke.latticeOf).reduce((sum, stroke) => sum + stroke.count, 0)
    / Math.max(1, targets.length);
  let type = 'free';
  if (mirror.symmetry >= 0.72) type = 'mirrored';
  else if (radial) type = 'radial';
  else if (lattice >= 0.5) type = 'lattice';
  return { type, mirror, radial, latticeShare: round(lattice, 3), arcShare: round(arcShare, 3) };
}

function orangePolicy(targets) {
  const withPegInfo = targets.filter(object => object.source?.raw?.PegInfo);
  if (withPegInfo.length) {
    const excluded = withPegInfo.filter(object => !object.source.raw.PegInfo.CanBeOrange);
    return {
      policy: 'runtime-random-among-eligible',
      evidence: 'exact',
      note: 'Source stores eligibility only; the game draws orange pegs at load.',
      eligibleCount: withPegInfo.length - excluded.length,
      excludedCount: excluded.length,
      eligibleFraction: round((withPegInfo.length - excluded.length) / withPegInfo.length, 3),
      excludedIds: excluded.map(object => String(object.id)).sort()
    };
  }
  const orange = targets.filter(object => String(object.targetType || '').toLowerCase().includes('orange'));
  return {
    policy: 'authored-explicit',
    evidence: 'exact',
    orangeCount: orange.length,
    orangeFraction: round(targets.length ? orange.length / targets.length : 0, 3)
  };
}

/**
 * Parameter cost of the DSL against the raw coordinate list. A description that
 * merely relisted the points would score 1.0 and would prove nothing.
 */
function measureCompression(strokes, rigs, residual, targets) {
  const strokeCost = strokes.reduce((sum, stroke) => {
    if (stroke.type === 'arc') return sum + 6 + (stroke.pegShape === 'brick' ? 2 : 0);
    if (stroke.type === 'bezier') return sum + 11;
    // A lone brick is one hand-placed object, not a gesture: x, y, rotation.
    if (stroke.type === 'bar') return sum + 3;
    if (stroke.type === 'brickChain') return sum + 8;
    if (stroke.type === 'path') return sum + 2 + (stroke.controlPoints?.length || 0) * 2;
    if (stroke.type === 'field') return sum + 3 + (stroke.region?.length || 0) * 2;
    if (stroke.type === 'ellipse') return sum + 7;
    return sum + 5;
  }, 0);
  const rigCost = rigs.reduce((sum, rig) => (
    sum + 6 + (rig.phases?.length || 0) + (rig.phasesSecondary?.length || 0)
  ), 0);
  const residualCost = residual.reduce((sum, object) => sum + (object.kind === 'brick' ? 3 : 2), 0);
  const rawCost = targets.reduce((sum, object) => sum + (object.kind === 'brick' ? 3 : 2), 0);
  const dslCost = strokeCost + rigCost + residualCost;
  return {
    rawNumbers: rawCost,
    dslNumbers: dslCost,
    ratio: round(dslCost > 0 ? rawCost / dslCost : 0, 2),
    breakdown: { strokes: strokeCost, rigs: rigCost, residual: residualCost }
  };
}

/* ------------------------------------------------------------------ */

export function decompileLevel(record, options = {}) {
  const targets = targetsOf(record);
  const assigned = new Set();
  const strokes = [];

  for (const stroke of recoverAuthoredArcs(targets)) {
    strokes.push(stroke);
    stroke.objectIds.forEach(id => assigned.add(id));
  }
  for (const stroke of recoverAleaBezierStrokes(record, targets, assigned)) {
    strokes.push(stroke);
    stroke.objectIds.forEach(id => assigned.add(id));
  }
  for (const stroke of recoverStraightBrickBars(targets, assigned)) {
    strokes.push(stroke);
    stroke.objectIds.forEach(id => assigned.add(id));
  }
  const inferred = inferStrokesFromPositions(record, targets, assigned);
  strokes.push(...inferred.strokes);

  const identified = strokes.map((stroke, index) => ({ id: `s${String(index + 1).padStart(2, '0')}`, ...stroke }));
  const rigs = [...recoverMotionRigs(targets), ...recoverAleaRigs(record, targets)]
    .map((rig, index) => ({ id: `g${String(index + 1).padStart(2, '0')}`, ...rig }));

  // Link each stroke to the rig its members belong to, so replay can apply the
  // phase offset and so a reader sees "this arc spins" rather than two lists.
  const rigByObject = new Map();
  for (const rig of rigs) {
    for (const id of rig.objectIds || []) rigByObject.set(String(id), rig);
  }
  for (const stroke of identified) {
    const rigsUsed = new Set((stroke.objectIds || []).map(id => rigByObject.get(String(id))?.id).filter(Boolean));
    if (rigsUsed.size === 1) {
      const rig = rigs.find(item => item.id === [...rigsUsed][0]);
      const pick = (source, id) => {
        if (!Array.isArray(source)) return 0;
        const position = (rig.objectIds || []).indexOf(String(id));
        return position >= 0 ? finite(source[position]) : 0;
      };
      stroke.rig = {
        id: rig.id,
        kind: rig.rig,
        geometry: rig.geometry,
        radiusU: rig.radius1 || rig.radius2,
        radiusV: rig.radius2 || rig.radius1,
        phases: stroke.objectIds.map(id => pick(rig.phases, id)),
        ...(rig.phasesSecondary ? { phasesSecondary: stroke.objectIds.map(id => pick(rig.phasesSecondary, id)) } : {})
      };
    }
  }

  const mirror = detectMirrorSkeleton(record, targets);
  const skeleton = classifySkeleton(mirror, identified, targets);
  const residual = inferred.residual;
  const explained = targets.length - residual.length;

  return {
    format: 'peggle-level-dsl',
    formatVersion: 1,
    tool: { id: 'decompile.mjs', version: TOOL_VERSION },
    id: `dsl:${record.id}`,
    sourceLevelId: record.id,
    name: record.authored?.name || null,
    frame: {
      width: round(finite(record.authored?.coordinateSystem?.bounds?.maxX, 646), 1),
      height: round(finite(record.authored?.coordinateSystem?.bounds?.maxY, 543), 1),
      orientation: String(record.authored?.coordinateSystem?.orientation || 'landscape'),
      launchAxisX: round(finite(record.authored?.mechanics?.launchAxis?.x
        ?? record.authored?.mechanics?.launcher?.x, 327), 1)
    },
    budget: {
      targets: targets.length,
      circles: targets.filter(object => object.kind === 'circle').length,
      straightBricks: targets.filter(object => object.kind === 'brick' && !isCurvedBrick(object)).length,
      curvedBricks: targets.filter(isCurvedBrick).length,
      movingObjects: targets.filter(object => object.movement?.Movement).length
    },
    skeleton,
    strokes: identified,
    rigs,
    orange: orangePolicy(targets),
    coverage: (() => {
      const share = predicate => round(targets.length
        ? identified.filter(predicate).reduce((sum, stroke) => sum + stroke.count, 0) / targets.length
        : 0, 3);
      const structuralStrokes = identified.filter(stroke => stroke.type !== 'field');
      return {
        explained,
        explainedFraction: round(targets.length ? explained / targets.length : 0, 3),
        // Structure carrying an authoring gesture, as opposed to scatter.
        structuralFraction: share(stroke => stroke.type !== 'field'),
        fieldFraction: share(stroke => stroke.type === 'field'),
        exactFraction: share(stroke => stroke.evidence === 'exact'),
        strokeCount: structuralStrokes.length,
        fieldCount: identified.length - structuralStrokes.length,
        rigCount: rigs.length,
        residualCount: residual.length
      };
    })(),
    compression: measureCompression(identified, rigs, residual, targets),
    residual: residual.map(object => ({
      id: String(object.id),
      kind: object.kind,
      x: round(finite(object.transform?.x), 2),
      y: round(finite(object.transform?.y), 2),
      rotationDeg: round(finite(object.transform?.rotation) * 180 / Math.PI, 2),
      ...(object.kind === 'brick' ? { brick: brickSize(object) } : {})
    })),
    createdAt: options.at || new Date().toISOString()
  };
}
