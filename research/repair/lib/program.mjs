import { evaluateCompositionGeometry } from '../../../js/composition-geometry.js';
import {
  BEZIER_BAKE_VERSION,
  bakePegsFromSamples,
  sampleCubicBezier
} from '../../../js/bezier-geometry.js';
import { ensureBezierNode } from '../../../js/bezier-program.js';

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
      rotationOffset: finite(stroke.rotationOffset), pegRadius, brickWidth, brickHeight,
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
        type: stroke.pegType || 'blue',
        shape,
        x, y,
        angle: shape === 'brick' ? point.angle : 0,
        ...(shape === 'brick' ? { width: brickWidth, height: brickHeight, brickBaseRadius: pegRadius,
          curveSlices: point.slices.map(slice => ({ ...slice, x: slice.x + x - point.x, y: slice.y + y - point.y })) } : {}),
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

export function evaluateStaticCandidate(level, options = {}) {
  const result = evaluateCompositionGeometry(level, options);
  return { ...result, status: result.status === 'passed' ? 'passed' : 'rejected',
    strokeCount: Object.keys(level.bezierCurves || {}).length,
    crossStrokeOverlapCount: result.overlapCount, crossStrokeOverlapExamples: result.overlapExamples };
}
