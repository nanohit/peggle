// Round-trip verification: record -> DSL -> record.
//
// Two different claims are checked with two different metrics, because they are
// two different claims:
//
//   structural strokes - claim a specific gesture. Checked positionally, per
//     stroke and in order: each stroke knows which objects it claims, so replay
//     is compared against exactly those objects. This refuses the accidental
//     credit a global nearest-neighbour match would hand out.
//
//   fields - claim only "this region holds N pegs packed no closer than d".
//     Checked distributionally. Scoring a field positionally would be measuring
//     it against a claim it never made.

import {
  convexHull, distance, finite, matchPointSets, mean, median, nearestDistances,
  polygonArea, quantile, round
} from './geometry.mjs';
import { recompileLevel, recompileStroke } from './recompile.mjs';

function targetIndex(record) {
  const index = new Map();
  for (const object of record.authored?.objects || []) {
    if (object.role !== 'target') continue;
    index.set(String(object.id), {
      x: finite(object.transform?.x),
      y: finite(object.transform?.y),
      kind: object.kind
    });
  }
  return index;
}

function statistics(distances) {
  if (!distances.length) {
    return { count: 0, mean: 0, median: 0, p95: 0, max: 0, within1: 0, within2: 0, within5: 0 };
  }
  const fraction = limit => distances.filter(value => value <= limit).length / distances.length;
  return {
    count: distances.length,
    mean: round(mean(distances), 3),
    median: round(median(distances), 3),
    p95: round(quantile(distances, 0.95), 3),
    max: round(Math.max(...distances), 3),
    within1: round(fraction(1), 3),
    within2: round(fraction(2), 3),
    within5: round(fraction(5), 3)
  };
}

function describeDistribution(points) {
  if (points.length < 3) return { count: points.length, areaPx2: 0, medianSpacingPx: 0, minSpacingPx: 0 };
  const spacings = nearestDistances(points);
  return {
    count: points.length,
    areaPx2: round(polygonArea(convexHull(points)), 0),
    medianSpacingPx: round(median(spacings), 2),
    minSpacingPx: round(Math.min(...spacings), 2)
  };
}

function relativeDelta(actual, expected) {
  if (!expected) return actual ? 1 : 0;
  return round(Math.abs(actual - expected) / expected, 3);
}

export function roundTrip(record, dsl) {
  const index = targetIndex(record);
  const perStroke = [];
  const fields = [];
  const structuralDistances = [];
  const exactDistances = [];
  const inferredDistances = [];

  for (const stroke of dsl.strokes || []) {
    const rebuilt = recompileStroke(stroke);
    const originals = (stroke.objectIds || []).map(id => index.get(String(id))).filter(Boolean);

    if (stroke.type === 'field') {
      const before = describeDistribution(originals);
      const after = describeDistribution(rebuilt);
      fields.push({
        id: stroke.id,
        original: before,
        replayed: after,
        delta: {
          count: relativeDelta(after.count, before.count),
          area: relativeDelta(after.areaPx2, before.areaPx2),
          medianSpacing: relativeDelta(after.medianSpacingPx, before.medianSpacingPx),
          minSpacing: relativeDelta(after.minSpacingPx, before.minSpacingPx)
        }
      });
      continue;
    }

    const pairCount = Math.min(rebuilt.length, originals.length);
    const distances = [];
    for (let position = 0; position < pairCount; position++) {
      distances.push(distance(originals[position], rebuilt[position]));
    }
    structuralDistances.push(...distances);
    if (stroke.evidence === 'exact') exactDistances.push(...distances);
    else inferredDistances.push(...distances);
    perStroke.push({
      id: stroke.id,
      type: stroke.type,
      evidence: stroke.evidence,
      count: stroke.count,
      rebuiltCount: rebuilt.length,
      missingObjects: (stroke.objectIds || []).length - originals.length,
      error: statistics(distances)
    });
  }

  const rebuiltAll = recompileLevel(dsl);
  const global = matchPointSets([...index.values()], rebuiltAll.all);
  const structural = statistics(structuralDistances);

  return {
    format: 'peggle-dsl-roundtrip',
    formatVersion: 1,
    levelId: record.id,
    name: dsl.name,
    targets: index.size,
    rebuilt: rebuiltAll.counts,
    coverage: dsl.coverage,
    compression: dsl.compression,
    error: {
      structural,
      exactEvidence: statistics(exactDistances),
      inferredEvidence: statistics(inferredDistances),
      // Includes fields and verbatim residual, so it always flatters. Reported
      // for completeness only; never used for the verdict.
      globalWithFieldsAndResidual: statistics(global.distances)
    },
    fields,
    perStroke: perStroke.sort((left, right) => right.error.mean - left.error.mean),
    verdict: verdictFor(dsl, structural, fields)
  };
}

function verdictFor(dsl, structural, fields) {
  const problems = [];
  if (dsl.coverage.explainedFraction < 0.9) problems.push('coverage-below-90pct');
  if (dsl.coverage.structuralFraction < 0.6) problems.push('mostly-unstructured-scatter');
  if (structural.count && structural.within2 < 0.9) problems.push('structural-error-above-2px');
  if (dsl.compression.ratio < 2.5) problems.push('compression-below-2.5x');
  if (fields.some(field => field.delta.count > 0.1)) problems.push('field-population-not-reproduced');
  return { status: problems.length ? 'weak' : 'good', problems };
}
