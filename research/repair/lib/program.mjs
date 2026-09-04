import {
  BEZIER_BAKE_VERSION,
  bakePegsFromSamples,
  sampleCubicBezier
} from '../../../js/bezier-geometry.js';
import { ensureBezierNode } from '../../../js/bezier-program.js';
import {
  collisionBounds,
  collisionFootprint,
  collisionFootprintsOverlap
} from '../../generator/lib/collision.mjs';

const DEFAULT_PEG_RADIUS = 8.5;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function compileBezierProgram(program) {
  const pegRadius = finite(program.pegRadius, DEFAULT_PEG_RADIUS);
  const pegs = [];
  const bezierCurves = {};
  for (const [strokeIndex, stroke] of (program.strokes || []).entries()) {
    const groupId = String(stroke.groupId || `program-stroke-${String(strokeIndex + 1).padStart(2, '0')}`);
    const shape = stroke.pegShape === 'brick' ? 'brick' : 'circle';
    const brickWidth = finite(stroke.brickWidth, pegRadius * 4);
    const brickHeight = finite(stroke.brickHeight, pegRadius * 1.2);
    const spacingPx = finite(stroke.spacingPx, shape === 'brick' ? brickWidth : pegRadius * 2.2);
    const curve = {
      start: { ...stroke.start }, end: { ...stroke.end }, h1: { ...stroke.h1 }, h2: { ...stroke.h2 },
      pegType: stroke.pegType || 'blue', pegShape: shape, spacingPx,
      rotationOffset: finite(stroke.rotationOffset), pegRadius, brickWidth,
      bakeVersion: BEZIER_BAKE_VERSION
    };
    const baked = bakePegsFromSamples(sampleCubicBezier(curve), {
      shape, spacingPx, brickWidth, pegRadius, rotationOffset: curve.rotationOffset
    });
    curve.refPoints = baked.map((point, index) => ({ index, x: point.x, y: point.y }));
    bezierCurves[groupId] = curve;
    const deleted = new Set((stroke.exceptions?.deletedIndices || []).map(Number));
    const overrides = stroke.exceptions?.overrides || {};
    for (const [index, point] of baked.entries()) {
      if (deleted.has(index)) continue;
      const override = overrides[String(index)];
      const x = Number.isFinite(override?.x) ? override.x : point.x;
      const y = Number.isFinite(override?.y) ? override.y : point.y;
      pegs.push({
        id: `${groupId}:${index}`,
        objectId: groupId,
        memberId: `${groupId}:member:${index}`,
        type: stroke.pegType || (index === 0 ? 'orange' : 'blue'),
        shape,
        x, y,
        angle: shape === 'brick' ? point.angle : 0,
        ...(shape === 'brick' ? { width: brickWidth, height: brickHeight, curveSlices: point.slices } : {}),
        groupId: null,
        bezierGroupId: groupId,
        bezierIndex: index
      });
    }
  }
  const level = {
    version: 1,
    id: String(program.id || 'bezier-repair-candidate'),
    name: String(program.name || 'Bezier repair candidate'),
    difficulty: 1,
    tags: ['research-repair-pilot', ...(program.tags || [])],
    pegs,
    groups: [],
    bezierCurves,
    pegRadius,
    aimLength: 300,
    flippers: null,
    survival: { enabled: false, worldHeight: 600 },
    destruction: { enabled: false },
    billiard: { enabled: false },
    pvp: { enabled: false },
    metadata: {
      created: new Date(0).toISOString().slice(0, 10),
      modified: new Date(0).toISOString(),
      playCount: 0,
      avgCompletionRate: null,
      authorNotes: '',
      repairPilot: {
        source: program.source || null,
        transfer: program.transfer || null,
        strata: program.strata || []
      }
    }
  };
  for (const [strokeIndex, stroke] of (program.strokes || []).entries()) {
    const groupId = String(stroke.groupId || `program-stroke-${String(strokeIndex + 1).padStart(2, '0')}`);
    const node = ensureBezierNode(level, groupId);
    node.sourceRef = String(stroke.sourceRef || stroke.nodeId || `bezier:${groupId}`);
    node.objectId = groupId;
    node.memberIds = pegs.filter(peg => peg.objectId === groupId).map(peg => peg.memberId);
    node.source = stroke.source || null;
    node.exceptions = stroke.exceptions || { deletedIndices: [], overrides: {} };
  }
  return level;
}

function pegObject(peg, pegRadius) {
  return {
    id: peg.id,
    kind: peg.shape === 'brick' ? 'brick' : 'circle',
    transform: { x: peg.x, y: peg.y, rotation: peg.angle || 0 },
    geometry: peg.shape === 'brick'
      ? { width: peg.width, height: peg.height }
      : { radius: pegRadius }
  };
}

export function evaluateStaticCandidate(level, options = {}) {
  const width = finite(options.width, 400);
  const height = finite(options.height, 600);
  const launcher = options.launcher || { x: width / 2, y: 40 };
  const minimumLauncherClearance = finite(options.minimumLauncherClearance, 48);
  const pegRadius = finite(level.pegRadius, DEFAULT_PEG_RADIUS);
  const padded = level.pegs.map(peg => ({ peg, shape: collisionFootprint(pegObject(peg, pegRadius), 0.25) }));
  const outOfBounds = padded.filter(({ shape }) => {
    const bounds = collisionBounds(shape);
    return bounds.minX < 0 || bounds.maxX > width || bounds.minY < 0 || bounds.maxY > height;
  }).map(({ peg }) => peg.id);
  const overlaps = [];
  const sourceStrokeByGroup = new Map(Object.entries(level?.metadata?.generatorProgram?.nodes || {})
    .map(([groupId, node]) => [groupId, node?.source?.strokeId || null]));
  for (let left = 0; left < padded.length; left++) {
    for (let right = left + 1; right < padded.length; right++) {
      if (padded[left].peg.bezierGroupId === padded[right].peg.bezierGroupId) continue;
      const leftSourceStroke = sourceStrokeByGroup.get(padded[left].peg.bezierGroupId);
      const rightSourceStroke = sourceStrokeByGroup.get(padded[right].peg.bezierGroupId);
      // Cubic segmentation is an implementation detail. Adjacent segments of
      // one source arc are allowed to meet exactly as they did in the source.
      if (leftSourceStroke && leftSourceStroke === rightSourceStroke) continue;
      if (collisionFootprintsOverlap(padded[left].shape, padded[right].shape)) {
        overlaps.push([padded[left].peg.id, padded[right].peg.id]);
      }
    }
  }
  const launcherClearance = padded.length ? Math.min(...padded.map(({ shape }) => (
    Math.hypot(shape.x - launcher.x, shape.y - launcher.y)
      - (shape.kind === 'circle' ? shape.radius : Math.hypot(shape.halfWidth, shape.halfHeight))
  ))) : Infinity;
  const failures = [];
  if (outOfBounds.length) failures.push('out-of-bounds');
  if (overlaps.length) failures.push('cross-stroke-overlap');
  if (launcherClearance < minimumLauncherClearance) failures.push('launcher-clearance');
  return {
    status: failures.length ? 'rejected' : 'passed',
    failures,
    pegCount: level.pegs.length,
    strokeCount: Object.keys(level.bezierCurves || {}).length,
    outOfBounds,
    crossStrokeOverlapCount: overlaps.length,
    crossStrokeOverlapExamples: overlaps.slice(0, 20),
    launcherClearance
  };
}
