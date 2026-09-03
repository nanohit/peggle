#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { compileBezierProgram, evaluateStaticCandidate } from '../repair/lib/program.mjs';

// Chosen after static-only screening: no launcher obstruction, out-of-bounds
// footprint, or cross-stroke overlap. They span two source skeleton classes and
// a wide target-count range; no autoplay score participates in selection.
const DEFAULT_SOURCES = ['crisscross', 'fever', 'car', 'waves', 'gateway'];
const DEG = Math.PI / 180;

function parseArgs(argv) {
  const options = {
    dslRoot: path.resolve('research/generated/dsl-roundtrip-deluxe-all/dsl'),
    output: path.resolve('research/generated/repair-pilot-v0'),
    sources: DEFAULT_SOURCES,
    maxSourceStrokes: 6
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--dsl-root') options.dslRoot = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--sources') options.sources = argv[++index].split(',').map(item => item.trim()).filter(Boolean);
    else if (value === '--max-strokes') options.maxSourceStrokes = Math.max(1, Number(argv[++index]) || 1);
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function affine(frame) {
  const margin = { left: 28, right: 28, top: 92, bottom: 28 };
  const scaleX = (400 - margin.left - margin.right) / frame.width;
  const scaleY = (600 - margin.top - margin.bottom) / frame.height;
  return {
    id: 'peggle-landscape-to-alea-portrait-affine-v1',
    sourceFrame: { width: frame.width, height: frame.height },
    targetFrame: { width: 400, height: 600, margin },
    scaleX,
    scaleY,
    map(point) {
      return { x: margin.left + point.x * scaleX, y: margin.top + point.y * scaleY };
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
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const pointAt = angle => {
    const x = Number(stroke.radiusU) * Math.cos(angle);
    const y = Number(stroke.radiusV) * Math.sin(angle);
    return { x: stroke.center.x + x * cosR - y * sinR, y: stroke.center.y + x * sinR + y * cosR };
  };
  const derivativeAt = angle => {
    const x = -Number(stroke.radiusU) * Math.sin(angle);
    const y = Number(stroke.radiusV) * Math.cos(angle);
    return { x: x * cosR - y * sinR, y: x * sinR + y * cosR };
  };
  return Array.from({ length: 4 }, (_value, index) => {
    const a0 = start + index * Math.PI / 2;
    const a1 = a0 + Math.PI / 2;
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
  if (stroke.type === 'path') {
    return (stroke.controlPoints || []).slice(1).map((point, index) => lineCurve(stroke.controlPoints[index], point));
  }
  return [];
}

function transferProgram(dsl, maxSourceStrokes) {
  const transform = affine(dsl.frame);
  const eligible = (dsl.strokes || [])
    .filter(stroke => stroke.type !== 'field' && curvesForStroke(stroke).length > 0)
    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0))
    .slice(0, maxSourceStrokes);
  const strokes = [];
  for (const sourceStroke of eligible) {
    for (const [segmentIndex, curve] of curvesForStroke(sourceStroke).entries()) {
      const groupId = `source-${sourceStroke.id}-segment-${String(segmentIndex + 1).padStart(2, '0')}`;
      strokes.push({
        groupId,
        nodeId: `transfer:${dsl.sourceLevelId}:${sourceStroke.id}:${segmentIndex}`,
        pegShape: sourceStroke.pegShape === 'brick' ? 'brick' : 'circle',
        pegType: 'blue',
        start: transform.map(curve.start), end: transform.map(curve.end),
        h1: transform.map(curve.h1), h2: transform.map(curve.h2),
        source: {
          levelId: dsl.sourceLevelId,
          strokeId: sourceStroke.id,
          strokeType: sourceStroke.type,
          segmentIndex,
          evidence: sourceStroke.evidence
        }
      });
    }
  }
  return {
    format: 'bezier-repair-program',
    version: 1,
    id: `repair-pilot-${dsl.name}`,
    name: `Repair pilot — ${dsl.name}`,
    pegRadius: 8.5,
    tags: ['source:peggle-deluxe', `skeleton:${dsl.skeleton?.type || 'unknown'}`],
    source: { levelId: dsl.sourceLevelId, name: dsl.name, dslId: dsl.id },
    transfer: {
      id: transform.id,
      sourceFrame: transform.sourceFrame,
      targetFrame: transform.targetFrame,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      note: 'Exploratory lower-bound transfer: strongest source strokes only; filler and negative-space operations intentionally absent.'
    },
    strata: [
      `source-skeleton:${dsl.skeleton?.type || 'unknown'}`,
      'defect-surface:global-transform',
      'defect-surface:stroke-geometry',
      'defect-surface:resampling',
      'known-language-gap:negative-space',
      'known-language-gap:filler'
    ],
    strokes
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = [];
  for (const source of options.sources) {
    const dslPath = path.join(options.dslRoot, `${source}.dsl.json`);
    const dsl = JSON.parse(await fs.readFile(dslPath, 'utf8'));
    const program = transferProgram(dsl, options.maxSourceStrokes);
    const level = compileBezierProgram(program);
    const staticCheck = evaluateStaticCandidate(level);
    await writeJson(path.join(options.output, 'programs', `${source}.program.json`), program);
    await writeJson(path.join(options.output, 'levels', `${source}.level.json`), level);
    candidates.push({
      source,
      sourceLevelId: dsl.sourceLevelId,
      sourceSkeleton: dsl.skeleton?.type || 'unknown',
      programPath: `programs/${source}.program.json`,
      levelPath: `levels/${source}.level.json`,
      strokeCount: program.strokes.length,
      pegCount: level.pegs.length,
      strata: program.strata,
      staticCheck
    });
  }
  const byStratum = {};
  for (const candidate of candidates) {
    for (const stratum of candidate.strata) byStratum[stratum] = (byStratum[stratum] || 0) + 1;
  }
  const manifest = {
    format: 'bezier-repair-pilot',
    version: 1,
    phase: 'exploratory-do-not-include-in-confirmatory-metrics',
    candidateOrigin: 'Peggle Deluxe DSL strokes transferred through one explicit landscape-to-portrait affine operator.',
    interpretation: 'Expressibility is a lower bound because filler and negative-space operations are intentionally absent from language v0.',
    metricsPolicy: {
      alwaysPublishTogether: ['semanticReplay.replayAccuracy', 'semanticPatch.fallbackFraction'],
      reportFallbackByReason: true,
      aggregateExpressibilityByStratum: true,
      exploratoryCandidatesExcludedFromConfirmation: true
    },
    byStratum,
    candidates
  };
  await writeJson(path.join(options.output, 'manifest.json'), manifest);
  console.log(JSON.stringify({ candidates: candidates.length, statuses: candidates.map(candidate => candidate.staticCheck.status) }, null, 2));
}

await main();
