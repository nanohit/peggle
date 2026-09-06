import { applySimilarityTransform, estimateSimilarityTransformFromPairs, GEOMETRY_EPSILON_PX } from './bezier-geometry.js';

const clone = value => JSON.parse(JSON.stringify(value));

// Named declarations are geometry programs only when there is an executor.
// Polygon remains an annotation/literal object until a sampling rule exists.
export function hasObjectExecutor(node) {
  return ['Ring', 'Arc', 'Line'].includes(node?.family) && !!node?.definition
    && Array.isArray(node.definition.memberIds)
    && (node.members || node.memberDescriptors || []).every(member => member.shape === 'circle');
}

export function objectProgramPoints(node) {
  if (!hasObjectExecutor(node)) return [];
  const d = node.definition;
  return d.memberIds.map((memberId, index) => {
    const point = node.family === 'Line'
      ? { x: d.center.x + d.direction.x * d.memberOffsets[index], y: d.center.y + d.direction.y * d.memberOffsets[index] }
      : { x: d.center.x + d.radius * Math.cos(d.memberAngles[index]), y: d.center.y + d.radius * Math.sin(d.memberAngles[index]) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid object sampling parameters');
    return { memberId, ...point };
  });
}

export function bakeObjectMembers(node) {
  const descriptors = new Map((node.memberDescriptors || node.members || []).map(member => [member.memberId, member]));
  return objectProgramPoints(node).map((point, index) => {
    const descriptor = descriptors.get(point.memberId);
    if (!descriptor) throw new Error(`Missing descriptor for ${point.memberId}`);
    return { ...clone(descriptor), index: descriptor.index ?? index, ...point };
  }).sort((a, b) => a.index - b.index || a.memberId.localeCompare(b.memberId));
}

export function transformObjectDefinition(definition, family, transform) {
  const d = clone(definition);
  d.center = applySimilarityTransform(d.center, transform);
  const scale = Math.abs(transform.scale ?? 1);
  const angle = transform.angle || 0;
  const transformAngle = value => (transform.reflect ? -value : value) + angle;
  if (family === 'Line') {
    const heading = transformAngle(Math.atan2(d.direction.y, d.direction.x));
    d.direction = { x: Math.cos(heading), y: Math.sin(heading) };
    d.memberOffsets = d.memberOffsets.map(value => value * scale);
    d.startOffset *= scale; d.endOffset *= scale;
  } else {
    d.radius *= scale;
    d.memberAngles = d.memberAngles.map(transformAngle);
    d.phase = transformAngle(d.phase);
    d.arcStart = transformAngle(d.arcStart);
  }
  return d;
}

export function reconcileObjectDefinition(node, members) {
  if (!hasObjectExecutor(node)) return node.definition;
  const destinations = new Map(members.map(member => [member.memberId, member]));
  const points = objectProgramPoints(node);
  if (points.length !== members.length || points.length < 3) return node.definition;
  const pairs = points.flatMap(point => destinations.has(point.memberId) ? [{
    sx: point.x, sy: point.y, dx: destinations.get(point.memberId).x, dy: destinations.get(point.memberId).y
  }] : []);
  if (pairs.length !== points.length) return node.definition;
  const fit = estimateSimilarityTransformFromPairs(pairs, { allowScale: true, allowReflection: true });
  if (!fit || fit.maxResidualPx > GEOMETRY_EPSILON_PX) return node.definition;
  if (Math.abs(fit.tx) < 1e-7 && Math.abs(fit.ty) < 1e-7 && Math.abs(fit.angle) < 1e-9 && Math.abs(fit.scale - 1) < 1e-9 && !fit.reflect) return node.definition;
  return transformObjectDefinition(node.definition, node.family, fit);
}
