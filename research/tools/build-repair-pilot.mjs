#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { sampleCubicBezier } from '../../js/bezier-geometry.js';
import { compileBezierProgram, evaluateStaticCandidate } from '../repair/lib/program.mjs';

// One exploratory example per genuinely different source morphology. These are
// discovery examples, never five replicates of one nominally multi-stratum set.
const DEFAULT_CANDIDATES = [
  { source: 'crisscross', family: 'linear-lattice' },
  { source: 'whirlpool', family: 'radial-concentric' },
  { source: 'hollywoodcircles', family: 'clustered-circular' },
  { source: 'spiderweb', family: 'radial-spoke' },
  { source: 'sunny', family: 'symmetric-emblem' }
];
const DEG = Math.PI / 180;

function parseArgs(argv) {
  const options = {
    dslRoot: path.resolve('research/generated/dsl-roundtrip-deluxe-all/dsl'),
    output: path.resolve('research/generated/repair-pilot-v1'),
    candidates: DEFAULT_CANDIDATES
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--dsl-root') options.dslRoot = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--sources') {
      options.candidates = argv[++index].split(',').map(source => ({ source: source.trim(), family: `custom:${source.trim()}` }));
    } else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function affine(frame) {
  const target = { width: 400, height: 600, top: 92, bottom: 28, launchAxisX: 200 };
  const scaleY = (target.height - target.top - target.bottom) / frame.height;
  const scaleX = 0.532;
  const offsetX = target.launchAxisX - Number(frame.launchAxisX || frame.width / 2) * scaleX;
  return {
    id: 'peggle-landscape-to-alea-portrait-axis-aligned-v2',
    sourceFrame: { width: frame.width, height: frame.height, launchAxisX: frame.launchAxisX },
    targetFrame: target,
    scaleX,
    scaleY,
    offsetX,
    map(point) {
      return { x: offsetX + point.x * scaleX, y: target.top + point.y * scaleY };
    }
  };
}

function lineCurve(from, to) {
  return {
    start: { ...from }, end: { ...to },
    h1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
    h2: { x: from.x + 2 * (to.x - from.x) / 3, y: from.y + 2 * (to.y - from.y) / 3 }
  };
}

function pointBarCurve(stroke) {
  const center = stroke.from || stroke.to;
  const angle = Number(stroke.rotationDeg || 0) * DEG;
  const halfLength = 8;
  return lineCurve(
    { x: center.x - Math.cos(angle) * halfLength, y: center.y - Math.sin(angle) * halfLength },
    { x: center.x + Math.cos(angle) * halfLength, y: center.y + Math.sin(angle) * halfLength }
  );
}

function arcCurves(stroke) {
  const start = Number(stroke.startAngleDeg) * DEG;
  const end = Number(stroke.endAngleDeg) * DEG;
  const span = end - start;
  const segments = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const result = [];
  const center = stroke.center;
  const radius = Number(stroke.radius);
  for (let index = 0; index < segments; index++) {
    const a0 = start + span * index / segments;
    const a1 = start + span * (index + 1) / segments;
    const alpha = 4 / 3 * Math.tan((a1 - a0) / 4);
    const p0 = { x: center.x + radius * Math.cos(a0), y: center.y + radius * Math.sin(a0) };
    const p3 = { x: center.x + radius * Math.cos(a1), y: center.y + radius * Math.sin(a1) };
    result.push({
      start: p0,
      end: p3,
      h1: { x: p0.x - alpha * radius * Math.sin(a0), y: p0.y + alpha * radius * Math.cos(a0) },
      h2: { x: p3.x + alpha * radius * Math.sin(a1), y: p3.y - alpha * radius * Math.cos(a1) }
    });
  }
  return result;
}

function ellipseCurves(stroke) {
  const rotation = Number(stroke.rotationDeg || 0) * DEG;
  const start = Number(stroke.startAngleDeg || 0) * DEG;
  const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
  const pointAt = angle => {
    const x = Number(stroke.radiusU) * Math.cos(angle), y = Number(stroke.radiusV) * Math.sin(angle);
    return { x: stroke.center.x + x * cosR - y * sinR, y: stroke.center.y + x * sinR + y * cosR };
  };
  const derivativeAt = angle => {
    const x = -Number(stroke.radiusU) * Math.sin(angle), y = Number(stroke.radiusV) * Math.cos(angle);
    return { x: x * cosR - y * sinR, y: x * sinR + y * cosR };
  };
  return Array.from({ length: 4 }, (_value, index) => {
    const a0 = start + index * Math.PI / 2, a1 = a0 + Math.PI / 2;
    const alpha = 4 / 3 * Math.tan((a1 - a0) / 4);
    const p0 = pointAt(a0), p3 = pointAt(a1), d0 = derivativeAt(a0), d1 = derivativeAt(a1);
    return {
      start: p0, end: p3,
      h1: { x: p0.x + alpha * d0.x, y: p0.y + alpha * d0.y },
      h2: { x: p3.x - alpha * d1.x, y: p3.y - alpha * d1.y }
    };
  });
}

function curvesForStroke(stroke) {
  if (stroke.type === 'bezier') return [{ start: stroke.start, end: stroke.end, h1: stroke.h1, h2: stroke.h2 }];
  if (stroke.type === 'arc') return arcCurves(stroke);
  if (stroke.type === 'ellipse') return ellipseCurves(stroke);
  if (['line', 'brickChain'].includes(stroke.type)) return [lineCurve(stroke.from, stroke.to)];
  if (stroke.type === 'bar') return [pointBarCurve(stroke)];
  if (stroke.type === 'path') {
    return (stroke.controlPoints || []).slice(1).map((point, index) => lineCurve(stroke.controlPoints[index], point));
  }
  return [];
}

function curveLength(curve) {
  const samples = sampleCubicBezier(curve);
  let length = 0;
  for (let index = 1; index < samples.length; index++) {
    length += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
  }
  return length;
}

function allocateCounts(totalCount, lengths) {
  const count = Math.max(lengths.length, Math.round(Number(totalCount) || lengths.length));
  const totalLength = lengths.reduce((sum, value) => sum + value, 0) || lengths.length;
  const raw = lengths.map(length => length / totalLength * count);
  const result = raw.map(value => Math.max(1, Math.floor(value)));
  while (result.reduce((sum, value) => sum + value, 0) < count) {
    let best = 0;
    for (let index = 1; index < raw.length; index++) {
      if (raw[index] - result[index] > raw[best] - result[best]) best = index;
    }
    result[best]++;
  }
  while (result.reduce((sum, value) => sum + value, 0) > count) {
    let best = -1;
    for (let index = 0; index < result.length; index++) {
      if (result[index] <= 1) continue;
      if (best < 0 || result[index] - raw[index] > result[best] - raw[best]) best = index;
    }
    if (best < 0) break;
    result[best]--;
  }
  return result;
}

function compositionFootprint(level) {
  const xs = level.pegs.map(peg => peg.x), ys = level.pegs.map(peg => peg.y);
  if (xs.length === 0) return { width: 0, height: 0, centroidX: null, centroidY: null };
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    centroidX: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    centroidY: ys.reduce((sum, value) => sum + value, 0) / ys.length
  };
}

function transferProgram(dsl, family) {
  const transform = affine(dsl.frame);
  const strokes = [];
  let structuralSourcePegCount = 0;
  let omittedFieldPegCount = 0;
  for (const sourceStroke of dsl.strokes || []) {
    if (sourceStroke.type === 'field') {
      omittedFieldPegCount += Number(sourceStroke.count || 0);
      continue;
    }
    const sourceCurves = curvesForStroke(sourceStroke);
    if (sourceCurves.length === 0) continue;
    const curves = sourceCurves.map(curve => ({
      start: transform.map(curve.start), end: transform.map(curve.end),
      h1: transform.map(curve.h1), h2: transform.map(curve.h2)
    }));
    const lengths = curves.map(curveLength);
    const sourceCount = Math.max(sourceCurves.length, Number(sourceStroke.count || sourceCurves.length));
    const counts = allocateCounts(sourceCount, lengths);
    structuralSourcePegCount += counts.reduce((sum, value) => sum + value, 0);
    for (const [segmentIndex, curve] of curves.entries()) {
      const count = counts[segmentIndex];
      const spacingPx = lengths[segmentIndex] / count;
      const shape = sourceStroke.pegShape === 'brick' ? 'brick' : 'circle';
      const groupId = `source-${sourceStroke.id}-segment-${String(segmentIndex + 1).padStart(2, '0')}`;
      strokes.push({
        groupId,
        nodeId: `transfer:${dsl.sourceLevelId}:${sourceStroke.id}:${segmentIndex}`,
        pegShape: shape,
        pegType: 'blue',
        spacingPx,
        ...(shape === 'brick' ? {
          brickWidth: Math.max(12, Math.min(30, spacingPx * 0.9)),
          brickHeight: 10.2
        } : {}),
        ...curve,
        source: {
          levelId: dsl.sourceLevelId,
          strokeId: sourceStroke.id,
          strokeType: sourceStroke.type,
          segmentIndex,
          sourcePegCount: count,
          evidence: sourceStroke.evidence
        }
      });
    }
  }
  return {
    format: 'bezier-repair-program',
    version: 2,
    id: `repair-pilot-${dsl.name}`,
    name: `Repair pilot — ${dsl.name}`,
    pegRadius: 8.5,
    tags: ['source:peggle-deluxe', `composition-family:${family}`, `source-skeleton:${dsl.skeleton?.type || 'unknown'}`],
    source: { levelId: dsl.sourceLevelId, name: dsl.name, dslId: dsl.id },
    transfer: {
      id: transform.id,
      sourceFrame: transform.sourceFrame,
      targetFrame: transform.targetFrame,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      offsetX: transform.offsetX,
      launchAxisErrorPx: transform.offsetX + Number(dsl.frame.launchAxisX || dsl.frame.width / 2) * transform.scaleX - 200,
      structuralSourcePegCount,
      omittedFieldPegCount,
      note: 'All structural source strokes and their source peg counts are retained. Scatter fields remain an explicit language gap.'
    },
    compositionFamily: family,
    strata: [`composition-family:${family}`, `source-skeleton:${dsl.skeleton?.type || 'unknown'}`],
    strokes
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = [];
  for (const specification of options.candidates) {
    const dslPath = path.join(options.dslRoot, `${specification.source}.dsl.json`);
    const dsl = JSON.parse(await fs.readFile(dslPath, 'utf8'));
    const program = transferProgram(dsl, specification.family);
    const level = compileBezierProgram(program);
    const staticCheck = evaluateStaticCandidate(level);
    const footprint = compositionFootprint(level);
    const retainedSourceFraction = level.pegs.length
      / Math.max(1, level.pegs.length + program.transfer.omittedFieldPegCount);
    const acceptanceFailures = [
      ...(staticCheck.status === 'passed' ? [] : staticCheck.failures.map(failure => `static:${failure}`)),
      ...(level.pegs.length >= 90 && level.pegs.length <= 140 ? [] : ['density-outside-90-140']),
      ...(program.strokes.length >= 10 && program.strokes.length <= 60 ? [] : ['stroke-count-outside-10-60']),
      ...(Math.abs(program.transfer.launchAxisErrorPx) <= 0.5 ? [] : ['launcher-axis-misaligned']),
      ...(retainedSourceFraction >= 0.8 ? [] : ['retains-less-than-80pct-source-pegs']),
      ...(footprint.width >= 180 && footprint.height >= 280 ? [] : ['composition-footprint-too-small']),
      ...(Math.abs(footprint.centroidX - 200) <= 25 ? [] : ['composition-centroid-off-launch-axis'])
    ];
    await writeJson(path.join(options.output, 'programs', `${specification.source}.program.json`), program);
    await writeJson(path.join(options.output, 'levels', `${specification.source}.level.json`), level);
    candidates.push({
      source: specification.source,
      sourceLevelId: dsl.sourceLevelId,
      sourceSkeleton: dsl.skeleton?.type || 'unknown',
      compositionFamily: specification.family,
      programPath: `programs/${specification.source}.program.json`,
      levelPath: `levels/${specification.source}.level.json`,
      strokeCount: program.strokes.length,
      pegCount: level.pegs.length,
      structuralSourcePegCount: program.transfer.structuralSourcePegCount,
      omittedFieldPegCount: program.transfer.omittedFieldPegCount,
      retainedSourceFraction,
      launchAxisErrorPx: program.transfer.launchAxisErrorPx,
      footprint,
      strata: program.strata,
      staticCheck,
      acceptance: { status: acceptanceFailures.length ? 'rejected' : 'passed', failures: acceptanceFailures }
    });
  }
  const familyCounts = {};
  for (const candidate of candidates) familyCounts[candidate.compositionFamily] = (familyCounts[candidate.compositionFamily] || 0) + 1;
  const duplicatedFamilies = Object.entries(familyCounts).filter(([_family, count]) => count > 1).map(([family]) => family);
  const manifest = {
    format: 'bezier-repair-pilot',
    version: 2,
    phase: 'exploratory-do-not-aggregate-or-include-in-confirmatory-metrics',
    candidateOrigin: 'Peggle Deluxe structural compositions transferred through an axis-aligned landscape-to-portrait operator.',
    interpretation: 'Each exploratory candidate represents one morphology. It discovers vocabulary; it does not estimate family performance.',
    metricsPolicy: {
      alwaysPublishTogether: [
        'semanticReplay.replayAccuracy',
        'semanticPatch.repairFallbackFraction',
        'semanticPatch.stateFallbackFraction'
      ],
      noSingleAmbiguousFallbackFraction: true,
      reportFallbackByEvidenceBasedReason: true,
      exploratoryAggregationForbidden: true,
      confirmationMinimumPerFamily: 3,
      confirmationDensityBand: { minimumPegs: 90, maximumPegs: 140 }
    },
    familyCounts,
    designValidation: {
      status: duplicatedFamilies.length === 0 && candidates.every(candidate => candidate.acceptance.status === 'passed')
        ? 'passed' : 'rejected',
      duplicatedFamilies,
      rejectedCandidates: candidates.filter(candidate => candidate.acceptance.status !== 'passed')
        .map(candidate => ({ source: candidate.source, failures: candidate.acceptance.failures }))
    },
    candidates
  };
  await writeJson(path.join(options.output, 'manifest.json'), manifest);
  console.log(JSON.stringify({
    candidates: candidates.length,
    candidatesSummary: candidates.map(candidate => ({
      source: candidate.source,
      family: candidate.compositionFamily,
      strokes: candidate.strokeCount,
      pegs: candidate.pegCount,
      omittedFields: candidate.omittedFieldPegCount,
      launchAxisErrorPx: candidate.launchAxisErrorPx,
      staticStatus: candidate.staticCheck.status,
      acceptanceStatus: candidate.acceptance.status,
      failures: candidate.acceptance.failures
    }))
  }, null, 2));
  if (manifest.designValidation.status !== 'passed') process.exitCode = 1;
}

await main();
