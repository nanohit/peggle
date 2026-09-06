import { sampleCubicBezier } from '../../../js/bezier-geometry.js';
import { normalizeLevelData } from '../../../js/levels.js';
import { evaluateCompositionGeometry } from '../../../js/composition-geometry.js';
import { compileBezierProgram } from './program.mjs';

export const RADIAL_SPLIT = Object.freeze({
  repair: ['radial-repair-01', 'radial-repair-02'],
  holdout: ['radial-transfer-01', 'radial-transfer-02', 'radial-transfer-03', 'radial-transfer-04', 'radial-transfer-05', 'radial-transfer-06']
});

export function hashUnit(text) {
  let h = 2166136261;
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function sampleParameters(seed, rules) {
  if (rules?.format !== 'radial-generator-rules' || rules.version !== 1 || !rules.revision) throw new Error('Unsupported radial rules');
  if (!Number.isInteger(rules.ringCount) || rules.ringCount < 2 || rules.ringCount > 4) throw new Error('ringCount must be 2..4');
  if (!Array.isArray(rules.brickRings) || rules.brickRings.some(i => !Number.isInteger(i) || i < 0 || i >= rules.ringCount)) throw new Error('Invalid brickRings');
  const limits = { centerY: [180, 410], innerRadius: [24, 90], ringStep: [24, 70], verticalScale: [0.8, 1.8],
    topOpeningDegrees: [8, 130], bottomOpeningDegrees: [8, 130], circleSpacing: [18, 36], brickSpacing: [18, 40] };
  const params = { centerX: 200, ringCount: rules.ringCount, brickRings: [...rules.brickRings] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const range = rules.ranges?.[key];
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < min || range[1] > max || range[0] > range[1]) throw new Error(`Invalid ${key} range (${min}..${max})`);
    // Keyed randomness: adding/reordering a rule doesn't change every draw.
    params[key] = range[0] + (range[1] - range[0]) * hashUnit(`${seed}:${key}`);
  }
  for (const key of Object.keys(rules.ranges)) if (!(key in limits)) throw new Error(`Unknown radial parameter: ${key}`);
  return params;
}

function arc(center, rx, ry, start, end) {
  const k = 4 / 3 * Math.tan((end - start) / 4);
  const point = a => ({ x: center.x + rx * Math.cos(a), y: center.y + ry * Math.sin(a) });
  const a = point(start), b = point(end);
  return { start: a, end: b, h1: { x: a.x - k * rx * Math.sin(start), y: a.y + k * ry * Math.cos(start) },
    h2: { x: b.x + k * rx * Math.sin(end), y: b.y - k * ry * Math.cos(end) } };
}

export function generateRadialLevel(seed, rules) {
  const params = sampleParameters(String(seed), rules), strokes = [];
  const center = { x: params.centerX, y: params.centerY }, radians = Math.PI / 180;
  const top = params.topOpeningDegrees * radians / 2, bottom = params.bottomOpeningDegrees * radians / 2;
  const sides = [[-Math.PI / 2 + top, Math.PI / 2 - bottom], [Math.PI / 2 + bottom, 3 * Math.PI / 2 - top]];
  for (let ring = 0; ring < params.ringCount; ring++) {
    const radius = params.innerRadius + ring * params.ringStep;
    const pegShape = params.brickRings.includes(ring) ? 'brick' : 'circle';
    const targetSpacing = pegShape === 'brick' ? params.brickSpacing : params.circleSpacing;
    const segmentCount = ring === 0 ? 1 : 2;
    for (const [side, [start, end]] of sides.entries()) for (let segment = 0; segment < segmentCount; segment++) {
      const curve = arc(center, radius, radius * params.verticalScale,
        start + (end - start) * segment / segmentCount, start + (end - start) * (segment + 1) / segmentCount);
      const samples = sampleCubicBezier(curve);
      const length = samples.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - samples[i].x, p.y - samples[i].y), 0);
      const count = Math.max(3, Math.floor(length / targetSpacing));
      // The editor's midpoint bake gets an integer number of cells. No short
      // final circle can collide with the next segment's first circle.
      const spacingPx = length / count;
      strokes.push({ ...curve, groupId: `radial:ring-${ring}:side-${side}:segment-${segment}`, pegShape, pegType: 'blue',
        spacingPx, brickWidth: spacingPx, brickHeight: 10.2,
        sourceRef: `radial:ring-${ring}`, source: { ring, side, segment, role: ring === params.ringCount - 1 ? 'outer-frame' : 'inner-targets' } });
    }
  }
  const program = { id: `${rules.revision}:${seed}`, name: `Radial · ${seed}`, pegRadius: 8.5, strokes,
    source: { generator: 'radial', revision: rules.revision, seed, parameters: params }, tags: ['standard-generator-loop'] };
  const level = normalizeLevelData(compileBezierProgram(program));
  level.metadata.generatorRecipe = { format: 'radial-recipe', version: 1, revision: rules.revision, seed, parameters: params };
  return { seed, revision: rules.revision, parameters: params, program, level, staticChecks: evaluateCompositionGeometry(level) };
}

export { makeStandardPlayPreview } from '../../../js/repair-play-preview.js';
