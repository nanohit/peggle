import {
  applySimilarityTransform,
  bakePegsFromSamples,
  estimateSimilarityTransformFromPairs,
  GEOMETRY_EPSILON_PX,
  sampleCubicBezier,
  transformBezierCurve
} from './bezier-geometry.js';
import { bakeObjectMembers, hasObjectExecutor, reconcileObjectDefinition, transformObjectDefinition } from './semantic-object-codec.js';
import { bumperContactProperties } from './peg-contact.js';

const POINT_KEYS = ['start', 'end', 'h1', 'h2'];
const RESAMPLE_PROPERTIES = [
  'pegShape', 'pegType', 'spacingPx', 'rotationOffset',
  'pegRadius', 'brickWidth', 'brickHeight', 'bakeVersion'
];
const DEFAULT_THRESHOLD_PX = 1;
// This state describes the composition program, not the entire game level.
// Keep a positive list so newly added gameplay/visual settings cannot silently
// become `missing-language-operation:level-properties` evidence. pegRadius is
// the one level-wide property that changes authored geometry and bake spacing.
export const COMPOSITION_LEVEL_PROPERTY_KEYS = Object.freeze(['pegRadius']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function changedRecordProperties(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of [...keys].sort()) {
    if (same(before?.[key], after?.[key])) continue;
    changes[key] = {
      from: clone(before?.[key]),
      to: clone(after?.[key]),
      remove: !Object.prototype.hasOwnProperty.call(after || {}, key)
    };
  }
  return changes;
}

function applyRecordChanges(target, changes) {
  const result = target && typeof target === 'object' ? target : {};
  for (const [key, change] of Object.entries(changes || {})) {
    if (change.remove) delete result[key];
    else result[key] = clone(change.to);
  }
  return result;
}

function semanticLevelSnapshot(level) {
  const result = {};
  for (const key of COMPOSITION_LEVEL_PROPERTY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(level || {}, key)) result[key] = clone(level[key]);
  }
  return result;
}

function groupFamily(group) {
  if (group?.animation) return 'AnimationGroup';
  if (group?.destructionBody) return 'DestructionGroup';
  return 'PegGroup';
}

function semanticGroups(level, memberIdByRuntimeId) {
  const membersByRuntimeGroup = new Map();
  for (const peg of level?.pegs || []) {
    if (peg?.groupId == null) continue;
    if (!membersByRuntimeGroup.has(peg.groupId)) membersByRuntimeGroup.set(peg.groupId, []);
    membersByRuntimeGroup.get(peg.groupId).push(memberIdByRuntimeId.get(peg.id));
  }
  const result = {};
  for (const [index, group] of (level?.groups || []).entries()) {
    const objectId = String(group.objectId || `legacy-group:${group.id || index}`);
    const properties = {};
    for (const [key, value] of Object.entries(group || {})) {
      if (key === 'id' || key === 'objectId') continue;
      properties[key] = clone(value);
    }
    result[objectId] = {
      objectId,
      family: groupFamily(group),
      memberIds: [...new Set((membersByRuntimeGroup.get(group.id) || []).filter(Boolean))].sort(),
      properties
    };
  }
  return result;
}

function close(left, right, tolerance = 1e-7) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
}

function pointsClose(left, right, tolerance = DEFAULT_THRESHOLD_PX) {
  return !!left && !!right && close(left.x, right.x, tolerance) && close(left.y, right.y, tolerance);
}

function memberPropertiesClose(left = {}, right = {}) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => {
    if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.prototype.hasOwnProperty.call(right, key)) return false;
    // Arc lengths can differ by a few ULPs between Node/V8 versions. This
    // numerical epsilon is NOT the 1px author-edit threshold. Real dimension
    // changes still count and a corrupt replay still fails.
    if (['width', 'height', 'brickBaseRadius', 'bumperScale', 'bumperBounce'].includes(key)
      && Number.isFinite(left[key]) && Number.isFinite(right[key])) return close(left[key], right[key], GEOMETRY_EPSILON_PX);
    return same(left[key], right[key]);
  });
}

function normalizeBrickAngle(value) {
  let angle = Number(value || 0);
  while (angle >= Math.PI / 2) angle -= Math.PI;
  while (angle < -Math.PI / 2) angle += Math.PI;
  return Math.abs(angle) < 1e-12 ? 0 : angle;
}

const DERIVED_OR_VOLATILE_PEG_KEYS = new Set([
  'id', 'memberId', 'objectId', 'groupId', 'bezierGroupId', 'bezierIndex',
  'x', 'y', 'angle', 'shape', 'type', 'curveSlices'
]);
const RUNTIME_PEG_REFERENCE_KEYS = new Set(['pvpMirrorOf', 'portalDestinationId', 'destinationId']);

function memberSnapshot(peg, ordinal = 0, memberIdByRuntimeId = new Map()) {
  const shape = peg.shape || 'circle';
  const properties = shape === 'brick' ? { width: peg.width ?? 34, height: peg.height ?? 10.2, brickBaseRadius: peg.brickBaseRadius ?? 8.5 } : {};
  // Bumpers were already allowed in this checkpoint. Their collision size,
  // bounce and persistence are part of the object, not cosmetic context.
  Object.assign(properties, bumperContactProperties(peg));
  for (const [key, value] of Object.entries(peg || {})) {
    if (DERIVED_OR_VOLATILE_PEG_KEYS.has(key)) continue;
    // Checkpoint one records authored geometry. Creation defaults, effects,
    // colors and mechanics remain in the native archive as context.
    if (!['width', 'height'].includes(key)) continue;
    properties[key] = RUNTIME_PEG_REFERENCE_KEYS.has(key) && memberIdByRuntimeId.has(value)
      ? memberIdByRuntimeId.get(value)
      : clone(value);
  }
  return {
    memberId: String(peg.memberId || (peg.bezierGroupId && Number.isFinite(peg.bezierIndex)
      ? `${peg.objectId || peg.bezierGroupId}:member:${Number(peg.bezierIndex)}`
      : `legacy-member:${peg.id || ordinal}`)),
    index: Number.isFinite(peg.bezierIndex) ? Number(peg.bezierIndex) : ordinal,
    x: Number(peg.x),
    y: Number(peg.y),
    angle: shape === 'brick' ? normalizeBrickAngle(peg.angle) : 0,
    shape,
    type: peg.type || 'blue',
    ...(shape === 'brick' && Array.isArray(peg.curveSlices) ? { curveSlices: clone(peg.curveSlices) } : {}),
    properties
  };
}

function semanticExceptions(exceptions) {
  const deletedIndices = [...new Set((exceptions?.deletedIndices || []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const overrides = {};
  for (const [index, override] of Object.entries(exceptions?.overrides || {}).sort(([left], [right]) => Number(left) - Number(right))) {
    if (!override || !Number.isFinite(override.x) || !Number.isFinite(override.y)) continue;
    overrides[String(index)] = { kind: override.kind || 'position', x: Number(override.x), y: Number(override.y) };
  }
  return { deletedIndices, overrides };
}

function semanticLineage(lineage) {
  if (!lineage || typeof lineage !== 'object') return null;
  const result = {};
  for (const [key, value] of Object.entries(lineage)) {
    if (['integrity', 'nodeId', 'objectId', 'memberIds', 'binding', 'family', 'definition'].includes(key)) continue;
    result[key] = key === 'exceptions' ? semanticExceptions(value) : clone(value);
  }
  return result;
}

export function captureBezierSemanticState(level) {
  const curves = level?.bezierCurves && typeof level.bezierCurves === 'object' ? level.bezierCurves : {};
  const members = new Map();
  const memberIdByRuntimeId = new Map();
  for (const [ordinal, peg] of (level?.pegs || []).entries()) {
    if (!peg) continue;
    memberIdByRuntimeId.set(peg.id, String(peg.memberId || (peg.bezierGroupId && Number.isFinite(peg.bezierIndex)
      ? `${peg.objectId || peg.bezierGroupId}:member:${Number(peg.bezierIndex)}`
      : `legacy-member:${peg.id || ordinal}`)));
  }
  for (const [ordinal, peg] of (level?.pegs || []).entries()) {
    if (!peg) continue;
    const objectId = String(peg.objectId || peg.bezierGroupId || `legacy-object:${peg.memberId || peg.id || ordinal}`);
    if (!members.has(objectId)) members.set(objectId, []);
    members.get(objectId).push(memberSnapshot(peg, ordinal, memberIdByRuntimeId));
  }
  const lineage = level?.metadata?.generatorProgram?.nodes || {};
  const curveBindings = new Map();
  for (const [objectId, node] of Object.entries(lineage)) {
    const groupId = node?.binding?.bezierGroupId
      || (node?.family === 'BezierStroke' ? objectId : null);
    if (groupId) curveBindings.set(String(groupId), String(node?.objectId || objectId));
  }
  for (const groupId of Object.keys(curves)) {
    if (!curveBindings.has(groupId)) curveBindings.set(groupId, groupId);
  }
  const objectIds = new Set([...members.keys(), ...Object.keys(lineage), ...curveBindings.values()]);
  const nodes = {};
  for (const objectId of [...objectIds].sort()) {
    const rawNode = lineage[objectId] || Object.values(lineage).find(node => node?.objectId === objectId) || null;
    const groupId = rawNode?.binding?.bezierGroupId
      || ([...curveBindings].find(([_groupId, boundObjectId]) => boundObjectId === objectId)?.[0] || null);
    const family = String(rawNode?.family || (groupId ? 'BezierStroke' : 'LiteralCluster'));
    const groupMembers = (members.get(objectId) || []).sort((left, right) => (
      (left.index - right.index) || left.memberId.localeCompare(right.memberId)
    ));
    if (!groupId && groupMembers.length === 0 && !rawNode) continue;
    const nodeLineage = semanticLineage(rawNode) || {};
    nodeLineage.family = family;
    if (family === 'BezierStroke' && !nodeLineage.exceptions) nodeLineage.exceptions = semanticExceptions(rawNode?.exceptions);
    nodes[objectId] = {
      objectId,
      family,
      groupId,
      binding: groupId ? { type: 'bezier', bezierGroupId: groupId } : clone(rawNode?.binding || null),
      definition: clone(rawNode?.definition ? reconcileObjectDefinition(rawNode, groupMembers) : null),
      curve: groupId && curves[groupId] ? {
        ...clone(curves[groupId]),
        brickHeight: curves[groupId].brickHeight ?? groupMembers[0]?.properties?.height ?? (level.pegRadius || 8.5) * 1.2
      } : null,
      lineage: nodeLineage,
      members: groupMembers
    };
  }
  return {
    format: 'semantic-object-state',
    version: 4,
    level: semanticLevelSnapshot(level),
    groups: semanticGroups(level, memberIdByRuntimeId),
    nodes
  };
}

function memberKey(member) {
  return String(member?.memberId || `index:${member?.index}`);
}

function bakeNodeMembers(node) {
  if (!node?.curve) return [];
  const curve = node.curve;
  const shape = curve.pegShape === 'brick' ? 'brick' : 'circle';
  const pegRadius = Number.isFinite(curve.pegRadius) ? curve.pegRadius : 8.5;
  const brickWidth = Number.isFinite(curve.brickWidth) ? curve.brickWidth : pegRadius * 4;
  const spacingPx = Number.isFinite(curve.spacingPx)
    ? curve.spacingPx
    : (shape === 'brick' ? brickWidth : pegRadius * 2.2);
  const baked = bakePegsFromSamples(sampleCubicBezier(curve), {
    shape,
    spacingPx,
    brickWidth,
    pegRadius,
    rotationOffset: Number(curve.rotationOffset || 0)
  });
  node.curve.refPoints = baked.map((value, index) => ({ index, x: value.x, y: value.y }));
  const exceptions = semanticExceptions(node.lineage?.exceptions);
  const deleted = new Set(exceptions.deletedIndices);
  return baked.flatMap((value, index) => {
    if (deleted.has(index)) return [];
    const override = exceptions.overrides[String(index)];
    return [{
      memberId: `${node.objectId || node.groupId}:member:${index}`,
      index,
      x: Number.isFinite(override?.x) ? override.x : value.x,
      y: Number.isFinite(override?.y) ? override.y : value.y,
      angle: shape === 'brick' ? normalizeBrickAngle(value.angle) : 0,
      shape,
      type: curve.pegType || 'blue',
      ...(shape === 'brick' ? { curveSlices: clone(value.slices) } : {}),
      properties: shape === 'brick'
        ? { width: Number(curve.brickWidth || brickWidth), height: Number(curve.brickHeight || pegRadius * 1.2), brickBaseRadius: pegRadius }
        : {}
    }];
  });
}

function cleanStrokePayload(node) {
  const payload = {
    objectId: node.objectId || node.groupId,
    family: node.family || 'BezierStroke',
    groupId: node.groupId,
    curve: clone(node.curve),
    lineage: clone(node.lineage)
  };
  if (payload.curve) delete payload.curve.refPoints;
  payload.lineage ||= { family: 'BezierStroke', exceptions: semanticExceptions(null) };
  payload.lineage.exceptions = semanticExceptions(null);
  return payload;
}

function cleanObjectPayload(node) {
  const result = {
    objectId: node.objectId,
    family: node.family || 'LiteralCluster',
    groupId: node.groupId || null,
    binding: clone(node.binding || null),
    definition: clone(node.definition || null),
    curve: clone(node.curve || null),
    lineage: clone(node.lineage || { family: node.family || 'LiteralCluster' }),
    members: clone(node.members || [])
  };
  if (hasObjectExecutor(node)) {
    result.memberDescriptors = result.members.map(({ x, y, ...member }) => member);
    delete result.members;
  }
  return result;
}

function curvePairs(before, after) {
  if (!before || !after) return [];
  return POINT_KEYS.map(key => ({
    sx: Number(before[key]?.x), sy: Number(before[key]?.y),
    dx: Number(after[key]?.x), dy: Number(after[key]?.y)
  })).filter(pair => Object.values(pair).every(Number.isFinite));
}

function transformMember(member, transform) {
  const moved = applySimilarityTransform(member, transform);
  const angle = transform.reflect === true
    ? Number(transform.angle || 0) - Number(member.angle || 0)
    : Number(member.angle || 0) + Number(transform.angle || 0);
  return { ...member, x: moved.x, y: moved.y, angle: member.shape === 'brick' ? normalizeBrickAngle(angle) : 0,
    ...(member.curveSlices ? { curveSlices: member.curveSlices.map(slice => {
      const normal = applySimilarityTransform({ x: slice.nx, y: slice.ny }, { ...transform, scale: 1, tx: 0, ty: 0 });
      return { ...applySimilarityTransform(slice, transform), nx: normal.x, ny: normal.y };
    }) } : {}) };
}

function transformExceptions(exceptions, transform) {
  const result = semanticExceptions(exceptions);
  for (const override of Object.values(result.overrides)) {
    const moved = applySimilarityTransform(override, transform);
    override.x = moved.x;
    override.y = moved.y;
  }
  return result;
}

function changedCurveProperties(before, after) {
  const changes = {};
  for (const key of RESAMPLE_PROPERTIES) {
    const left = before?.[key] ?? null;
    const right = after?.[key] ?? null;
    // Similarity fitting is floating-point work. A pure rigid transform can
    // infer scale as 0.9999999999999998; treating that as a spacing change
    // creates a phantom resample-stroke after an otherwise exact rotation.
    if ((Number.isFinite(left) && Number.isFinite(right) && close(left, right, 1e-7))
        || same(left, right)) continue;
    changes[key] = { from: clone(before?.[key] ?? null), to: clone(after?.[key] ?? null) };
  }
  return changes;
}

function controlPointDeltas(before, after) {
  const deltas = {};
  for (const key of POINT_KEYS) {
    if (!before?.[key] || !after?.[key]) continue;
    const dx = Number(after[key].x) - Number(before[key].x);
    const dy = Number(after[key].y) - Number(before[key].y);
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) deltas[key] = { dx, dy };
  }
  return deltas;
}

function slicesClose(left, right, tolerance) {
  if (!left && !right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((a, i) => pointsClose(a, right[i], tolerance)
    && ((close(a.nx, right[i].nx, 1e-6) && close(a.ny, right[i].ny, 1e-6))
      || (close(a.nx, -right[i].nx, 1e-6) && close(a.ny, -right[i].ny, 1e-6))));
}

function memberDifference(beforeMembers, afterMembers, thresholdPx) {
  const left = new Map((beforeMembers || []).map(member => [memberKey(member), member]));
  const right = new Map((afterMembers || []).map(member => [memberKey(member), member]));
  const changes = [];
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const before = left.get(key) || null;
    const after = right.get(key) || null;
    const index = Number.isFinite(after?.index) ? after.index : before?.index;
    if (!before || !after) {
      changes.push({ memberId: key, index, kind: before ? 'delete-member' : 'add-member', before: clone(before), after: clone(after) });
      continue;
    }
    const positionChanged = !pointsClose(before, after, thresholdPx);
    const propertyChanged = before.shape !== after.shape || before.type !== after.type
      || !close(normalizeBrickAngle(before.angle), normalizeBrickAngle(after.angle), 1e-6)
      || !memberPropertiesClose(before.properties, after.properties);
    if (positionChanged || propertyChanged || !slicesClose(before.curveSlices, after.curveSlices, thresholdPx)) {
      changes.push({ memberId: key, index, kind: 'update-member', before: clone(before), after: clone(after) });
    }
  }
  return changes;
}

function classifyFallbackCause(changes, thresholdPx, context = {}) {
  const geometricMoves = changes.filter(change => change.before && change.after
    && !pointsClose(change.before, change.after, GEOMETRY_EPSILON_PX));
  if (geometricMoves.length === 0 && changes.every(change => change.before && change.after)) {
    return { reason: 'member-property-edit', languageGap: false, evidence: { changedMemberCount: changes.length } };
  }
  if (changes.length === 1) {
    return { reason: 'atomic-object-edit', languageGap: false, evidence: { changedMemberCount: 1 } };
  }
  const indices = changes.map(change => change.index).sort((a, b) => a - b);
  const contiguous = indices.every((value, index) => index === 0 || value === indices[index - 1] + 1);
  const moved = changes.filter(change => change.before && change.after);
  let coherentDisplacement = moved.length === changes.length && moved.length >= 2;
  let referenceDelta = null;
  for (const change of moved) {
    const delta = { x: change.after.x - change.before.x, y: change.after.y - change.before.y };
    referenceDelta ||= delta;
    if (Math.hypot(delta.x - referenceDelta.x, delta.y - referenceDelta.y) > thresholdPx) coherentDisplacement = false;
  }
  // "Regional" is a geometric claim: the changed members must form one run
  // along the stroke. Check that before considering a shared displacement.
  if (contiguous && coherentDisplacement) {
    return {
      reason: 'missing-language-operation:regional-transform', languageGap: true,
      evidence: { changedMemberCount: changes.length, contiguousIndices: true, coherentDisplacement: true }
    };
  }
  if (contiguous) {
    return {
      reason: 'missing-language-operation:regional-object-edit', languageGap: true,
      evidence: { changedMemberCount: changes.length, contiguousIndices: true, coherentDisplacement: false }
    };
  }
  if (coherentDisplacement && context.selectionTransformProven === true) {
    return {
      reason: 'missing-language-operation:selection-transform', languageGap: true,
      evidence: {
        changedMemberCount: changes.length,
        contiguousIndices: false,
        coherentDisplacement: true,
        commandEvidence: 'move-selection'
      }
    };
  }
  return {
    reason: 'multiple-atomic-object-edits', languageGap: false,
    evidence: {
      changedMemberCount: changes.length,
      contiguousIndices: false,
      coherentDisplacement,
      commandEvidence: null
    }
  };
}

function buildFallbackOperation(groupId, changes, afterLineage, thresholdPx, context = {}) {
  const cause = classifyFallbackCause(changes, thresholdPx, context);
  const expectedExceptions = semanticExceptions(afterLineage?.exceptions);
  const changedIndices = new Set(changes.map(change => change.index));
  return {
    type: 'object-exception',
    expressibility: 'fallback',
    objectId: groupId,
    groupId,
    changes,
    exceptionState: {
      deletedIndices: expectedExceptions.deletedIndices.filter(index => changedIndices.has(index)),
      overrides: Object.fromEntries(Object.entries(expectedExceptions.overrides)
        .filter(([index]) => changedIndices.has(Number(index))))
    },
    reason: cause.reason,
    causeEvidence: cause.evidence,
    ...(cause.languageGap ? { languageGapCandidate: cause.reason } : {}),
    affectedMemberCount: changes.length
  };
}

function residualOperations(groupId, changes, afterLineage, thresholdPx, context = {}) {
  const material = [], precision = [];
  for (const change of changes) {
    const subthreshold = change.before && change.after
      && memberDifference([change.before], [change.after], thresholdPx).length === 0;
    (subthreshold ? precision : material).push(change);
  }
  return [
    ...(material.length ? [buildFallbackOperation(groupId, material, afterLineage, thresholdPx, context)] : []),
    ...(precision.length ? [{
      ...buildFallbackOperation(groupId, precision, afterLineage, thresholdPx),
      type: 'precision-correction', expressibility: 'ignored', reason: 'subthreshold-position-residual',
      languageGapCandidate: null
    }] : [])
  ];
}

function applyOperation(result, operation) {
  if (operation.type === 'set-level-properties') {
    result.level = applyRecordChanges(result.level || {}, operation.changes);
    return;
  }
  result.groups ||= {};
  if (operation.type === 'add-group') {
    result.groups[operation.objectId] = clone(operation.group);
    return;
  }
  if (operation.type === 'delete-group') {
    delete result.groups[operation.objectId];
    return;
  }
  if (operation.type === 'set-group-members') {
    if (result.groups[operation.objectId]) {
      result.groups[operation.objectId].memberIds = clone(operation.memberIds || []);
    }
    return;
  }
  if (operation.type === 'set-group-properties') {
    const group = result.groups[operation.objectId];
    if (!group) return;
    group.family = operation.family || group.family;
    group.properties = applyRecordChanges(group.properties || {}, operation.changes);
    return;
  }
  result.nodes ||= {};
  const objectId = String(operation.objectId || operation.groupId || '');
  if (operation.type === 'delete-stroke' || operation.type === 'delete-object') {
    delete result.nodes[objectId];
    return;
  }
  if (operation.type === 'add-stroke') {
    const node = clone(operation.stroke);
    node.members = bakeNodeMembers(node);
    result.nodes[objectId] = node;
    return;
  }
  if (operation.type === 'add-object' || operation.type === 'declare-object') {
    const movedMemberIds = new Set(operation.movedMemberIds || []);
    for (const sourceObjectId of operation.sourceObjectIds || []) {
      const source = result.nodes[sourceObjectId];
      if (!source) continue;
      source.members = (source.members || []).filter(member => !movedMemberIds.has(memberKey(member)));
      if (source.members.length === 0) delete result.nodes[sourceObjectId];
    }
    const node = clone(operation.object || operation.declaredObject);
    if (hasObjectExecutor(node)) node.members = bakeObjectMembers(node);
    if (node) result.nodes[node.objectId || objectId] = node;
    return;
  }
  const node = result.nodes[objectId];
  if (!node) return;
  if (operation.type === 'transform-stroke' || operation.type === 'mirror-stroke') {
    node.curve = transformBezierCurve(node.curve, operation.transform);
    node.members = node.members.map(member => transformMember(member, operation.transform));
    if (node.lineage?.exceptions) node.lineage.exceptions = transformExceptions(node.lineage.exceptions, operation.transform);
    return;
  }
  if (operation.type === 'transform-object' || operation.type === 'mirror-object') {
    node.members = (node.members || []).map(member => transformMember(member, operation.transform));
    if (hasObjectExecutor(node)) node.definition = transformObjectDefinition(node.definition, node.family, operation.transform);
    return;
  }
  if (operation.type === 'update-object-definition') {
    node.family = operation.family || node.family;
    node.definition = clone(operation.definition || null);
    node.lineage = clone(operation.lineage || node.lineage || {});
    if (hasObjectExecutor(node)) node.members = bakeObjectMembers(node);
    return;
  }
  if (operation.type === 'edit-control-points') {
    for (const [key, delta] of Object.entries(operation.deltas || {})) {
      if (!node.curve?.[key]) continue;
      node.curve[key].x += Number(delta.dx || 0);
      node.curve[key].y += Number(delta.dy || 0);
    }
    node.members = bakeNodeMembers(node);
    return;
  }
  if (operation.type === 'resample-stroke') {
    for (const [key, change] of Object.entries(operation.changes || {})) {
      if (change.to == null) delete node.curve[key];
      else node.curve[key] = clone(change.to);
    }
    node.members = bakeNodeMembers(node);
    return;
  }
  if (operation.type === 'object-exception' || operation.type === 'precision-correction') {
    const members = new Map((node.members || []).map(member => [memberKey(member), member]));
    node.lineage ||= { family: node.family || 'LiteralCluster' };
    if (node.family === 'BezierStroke') node.lineage.exceptions = semanticExceptions(node.lineage.exceptions);
    const expectedDeleted = new Set(operation.exceptionState?.deletedIndices || []);
    const expectedOverrides = operation.exceptionState?.overrides || {};
    for (const change of (Array.isArray(operation.changes) ? operation.changes : [])) {
      const key = String(change.memberId || memberKey(change.after || change.before));
      if (!change.after) members.delete(key);
      else members.set(key, clone(change.after));
      if (node.family === 'BezierStroke') {
        node.lineage.exceptions.deletedIndices = node.lineage.exceptions.deletedIndices.filter(index => index !== change.index);
        delete node.lineage.exceptions.overrides[String(change.index)];
        if (expectedDeleted.has(change.index)) node.lineage.exceptions.deletedIndices.push(change.index);
        if (expectedOverrides[String(change.index)]) {
          node.lineage.exceptions.overrides[String(change.index)] = clone(expectedOverrides[String(change.index)]);
        }
      }
    }
    if (node.family === 'BezierStroke') node.lineage.exceptions.deletedIndices.sort((a, b) => a - b);
    node.members = [...members.values()].sort((left, right) => (
      (left.index - right.index) || memberKey(left).localeCompare(memberKey(right))
    ));
  }
}

function contextOperations(before, after) {
  const operations = [];
  const levelChanges = changedRecordProperties(before?.level || {}, after?.level || {});
  if (Object.keys(levelChanges).length) {
    operations.push({
      type: 'set-level-properties',
      expressibility: 'fallback',
      reason: 'missing-language-operation:level-properties',
      languageGapCandidate: 'missing-language-operation:level-properties',
      changes: levelChanges,
      affectedMemberCount: 0
    });
  }
  const groupIds = new Set([...Object.keys(before?.groups || {}), ...Object.keys(after?.groups || {})]);
  for (const objectId of [...groupIds].sort()) {
    const left = before?.groups?.[objectId];
    const right = after?.groups?.[objectId];
    if (!left && right) {
      operations.push({
        type: 'add-group', expressibility: 'native', objectId,
        family: right.family, group: clone(right), affectedMemberCount: right.memberIds.length
      });
      continue;
    }
    if (left && !right) {
      operations.push({
        type: 'delete-group', expressibility: 'native', objectId,
        family: left.family, affectedMemberCount: left.memberIds.length
      });
      continue;
    }
    if (!same(left.memberIds, right.memberIds)) {
      operations.push({
        type: 'set-group-members', expressibility: 'native', objectId,
        family: right.family, memberIds: clone(right.memberIds),
        addedMemberIds: right.memberIds.filter(memberId => !left.memberIds.includes(memberId)),
        removedMemberIds: left.memberIds.filter(memberId => !right.memberIds.includes(memberId)),
        affectedMemberCount: new Set([...left.memberIds, ...right.memberIds]).size
      });
    }
    const propertyChanges = changedRecordProperties(left.properties || {}, right.properties || {});
    if (left.family !== right.family || Object.keys(propertyChanges).length) {
      operations.push({
        type: 'set-group-properties', expressibility: 'fallback', objectId,
        family: right.family,
        reason: 'missing-language-operation:group-properties',
        languageGapCandidate: 'missing-language-operation:group-properties',
        changes: propertyChanges,
        affectedMemberCount: right.memberIds.length
      });
    }
  }
  return operations;
}

function inferDeclarationOperations(before, after) {
  const operations = [];
  const beforeMemberOwner = new Map();
  for (const [objectId, node] of Object.entries(before?.nodes || {})) {
    for (const member of node.members || []) beforeMemberOwner.set(memberKey(member), objectId);
  }
  for (const [objectId, node] of Object.entries(after?.nodes || {})) {
    if (before?.nodes?.[objectId] || node?.lineage?.declared !== true) continue;
    const movedMemberIds = (node.members || []).map(memberKey);
    if (!movedMemberIds.length || !movedMemberIds.every(memberId => beforeMemberOwner.has(memberId))) continue;
    const sourceObjectIds = [...new Set(movedMemberIds.map(memberId => beforeMemberOwner.get(memberId)))];
    const literal = !hasObjectExecutor(node);
    operations.push({
      type: 'declare-object',
      expressibility: literal ? 'fallback' : 'native',
      objectId,
      family: node.family,
      sourceObjectIds,
      movedMemberIds,
      declaredObject: cleanObjectPayload(node),
      reason: literal ? 'declaration-without-executable-sampling' : null,
      changes: literal ? node.members.map(member => ({ memberId: member.memberId, index: member.index, before: null, after: clone(member) })) : [],
      affectedMemberCount: movedMemberIds.length
    });
  }
  return operations;
}

function matchingMemberPairs(beforeMembers, afterMembers) {
  const right = new Map((afterMembers || []).map(member => [memberKey(member), member]));
  return (beforeMembers || []).flatMap(member => {
    const destination = right.get(memberKey(member));
    if (!destination) return [];
    return [{ sx: member.x, sy: member.y, dx: destination.x, dy: destination.y }];
  }).filter(pair => Object.values(pair).every(Number.isFinite));
}

function genericOperationsForNode(before, after, thresholdPx) {
  const operations = [];
  let working = clone(before);
  const sameProgram = before.family === after.family && same(before.lineage || {}, after.lineage || {});
  const pairs = matchingMemberPairs(before.members, after.members);
  let fit = null;
  if (sameProgram && pairs.length === 1) {
    fit = {
      angle: 0, scale: 1,
      tx: pairs[0].dx - pairs[0].sx,
      ty: pairs[0].dy - pairs[0].sy,
      maxResidualPx: 0,
      reflect: false
    };
  } else if (sameProgram && pairs.length >= 3) {
    fit = estimateSimilarityTransformFromPairs(pairs, { allowScale: true, allowReflection: true });
  }
  if (fit && fit.maxResidualPx <= GEOMETRY_EPSILON_PX) {
    const material = fit.reflect || Math.abs(fit.angle) > 1e-9 || Math.abs(fit.scale - 1) > 1e-9
      || Math.abs(fit.tx) > 1e-7 || Math.abs(fit.ty) > 1e-7;
    if (material) {
      const operation = {
        type: fit.reflect ? 'mirror-object' : 'transform-object',
        expressibility: 'native', objectId: after.objectId,
        transform: {
          angle: fit.angle, scale: fit.scale, tx: fit.tx, ty: fit.ty,
          ...(fit.reflect ? { reflect: true } : {})
        },
        residualPx: fit.maxResidualPx,
        affectedMemberCount: before.members.length
      };
      const candidate = { nodes: { [after.objectId]: working } };
      applyOperation(candidate, operation);
      operations.push(operation);
      working = candidate.nodes[after.objectId];
    }
  }

  if (working.family !== after.family
      || !same(working.definition || null, after.definition || null)
      || !same(working.lineage || {}, after.lineage || {})) {
    const operation = {
      type: 'update-object-definition', expressibility: hasObjectExecutor(after) ? 'native' : 'ignored',
      objectId: after.objectId,
      family: after.family, definition: clone(after.definition), lineage: clone(after.lineage),
      affectedMemberCount: Math.max(working.members.length, after.members.length)
    };
    const candidate = { nodes: { [after.objectId]: working } };
    applyOperation(candidate, operation);
    operations.push(operation);
    working = candidate.nodes[after.objectId];
  }

  const fallbackChanges = memberDifference(working.members, after.members, GEOMETRY_EPSILON_PX);
  if (fallbackChanges.length > 0) {
    operations.push(...residualOperations(
      after.objectId, fallbackChanges, after.lineage, thresholdPx
    ));
  }
  return operations;
}

function commandProvesSelectionTransform(groupId, changes, options) {
  if (options.commandScope === 'single'
      && options.hints.some(hint => hint === 'move-selection')) return true;
  const changedIndices = new Set(changes.map(change => change.index));
  return options.commandEvidence.some(command => {
    if (!(command.hints || []).includes('move-selection')) return false;
    return (command.operations || []).some(operation => {
      if (operation.groupId !== groupId) return false;
      const indices = operation.affectedMemberIndices || [];
      return indices.length > 0 && [...changedIndices].every(index => indices.includes(index));
    });
  });
}

function nativeOperationsForNode(before, after, thresholdPx, options) {
  const operations = [];
  let working = clone(before);
  const fit = estimateSimilarityTransformFromPairs(curvePairs(before.curve, after.curve), {
    allowScale: true,
    allowReflection: true
  });
  if (fit && fit.maxResidualPx <= GEOMETRY_EPSILON_PX) {
    const operation = {
      type: fit.reflect ? 'mirror-stroke' : 'transform-stroke', expressibility: 'native',
      objectId: after.objectId, groupId: after.groupId,
      transform: {
        angle: fit.angle, scale: fit.scale, tx: fit.tx, ty: fit.ty,
        ...(fit.reflect ? { reflect: true } : {})
      },
      residualPx: fit.maxResidualPx,
      affectedMemberCount: before.members.length
    };
    const material = fit.reflect || Math.abs(fit.angle) > 1e-9 || Math.abs(fit.scale - 1) > 1e-9
      || Math.abs(fit.tx) > 1e-7 || Math.abs(fit.ty) > 1e-7;
    if (material) {
      const candidate = { nodes: { [after.objectId]: working } };
      applyOperation(candidate, operation);
      operations.push(operation);
      working = candidate.nodes[after.objectId];
    }
  }

  const deltas = controlPointDeltas(working.curve, after.curve);
  if (Object.keys(deltas).length > 0) {
    const operation = {
      type: 'edit-control-points', expressibility: 'native', objectId: after.objectId,
      groupId: after.groupId,
      deltas, affectedMemberCount: Math.max(working.members.length, after.members.length)
    };
    const candidate = { nodes: { [after.objectId]: working } };
    applyOperation(candidate, operation);
    operations.push(operation);
    working = candidate.nodes[after.objectId];
  }

  const changes = changedCurveProperties(working.curve, after.curve);
  if (Object.keys(changes).length > 0) {
    const operation = {
      type: 'resample-stroke', expressibility: 'native', objectId: after.objectId,
      groupId: after.groupId,
      changes, affectedMemberCount: Math.max(working.members.length, after.members.length)
    };
    const candidate = { nodes: { [after.objectId]: working } };
    applyOperation(candidate, operation);
    operations.push(operation);
    working = candidate.nodes[after.objectId];
  }

  const fallbackChanges = memberDifference(working.members, after.members, GEOMETRY_EPSILON_PX);
  if (fallbackChanges.length > 0) {
    const corrections = residualOperations(
      after.objectId,
      fallbackChanges,
      after.lineage,
      thresholdPx,
      { selectionTransformProven: commandProvesSelectionTransform(after.groupId, fallbackChanges, options) }
    );
    const candidate = { nodes: { [after.objectId]: working } };
    for (const correction of corrections) applyOperation(candidate, correction);
    operations.push(...corrections);
    working = candidate.nodes[after.objectId];
  }

  if (!same(working.lineage, after.lineage)) {
    operations.push({
      type: 'metadata-only', expressibility: 'ignored', objectId: after.objectId,
      groupId: after.groupId,
      changedKeys: [...new Set([...Object.keys(working.lineage || {}), ...Object.keys(after.lineage || {})])]
        .filter(key => !same(working.lineage?.[key], after.lineage?.[key]))
    });
  }
  return operations;
}

function nodeBounds(node) {
  const members = node?.members || [];
  if (members.length === 0) return null;
  return {
    minX: Math.min(...members.map(member => member.x)), maxX: Math.max(...members.map(member => member.x)),
    minY: Math.min(...members.map(member => member.y)), maxY: Math.max(...members.map(member => member.y))
  };
}

function deletedRegionEvidence(deleted, evidenceKind) {
  if (deleted.length < 2) return null;
  const boxes = deleted.map(operation => operation.deletedBounds).filter(Boolean);
  if (boxes.length !== deleted.length) return null;
  const centers = boxes.map(box => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }));
  const maximumDistance = Math.max(...centers.flatMap((left, index) => centers.slice(index + 1)
    .map(right => Math.hypot(left.x - right.x, left.y - right.y))), 0);
  if (maximumDistance > 180) return null;
  return {
    reason: 'possible-negative-space-region-delete',
    confidence: 'single-command+geometry',
    commandEvidence: evidenceKind,
    deletedStrokeCount: deleted.length,
    maximumCenterDistancePx: maximumDistance
  };
}

function annotateDeletedRegions(deleted, options) {
  const batches = [];
  if (options.commandScope === 'single'
      && options.hints.some(hint => hint === 'delete-selection' || /negative|space|region|mask/i.test(hint))) {
    batches.push({ operations: deleted, evidenceKind: options.hints.includes('delete-selection') ? 'delete-selection' : 'explicit-region-hint' });
  }
  for (const command of options.commandEvidence) {
    const hints = command.hints || [];
    if (!hints.some(hint => hint === 'delete-selection' || /negative|space|region|mask/i.test(hint))) continue;
    const deletedIds = new Set((command.operations || [])
      .filter(operation => operation.type === 'delete-stroke')
      .map(operation => operation.groupId));
    const operations = deleted.filter(operation => deletedIds.has(operation.groupId));
    batches.push({ operations, evidenceKind: hints.includes('delete-selection') ? 'delete-selection' : 'explicit-region-hint' });
  }
  const annotated = new Set();
  for (const batch of batches) {
    const key = batch.operations.map(operation => operation.groupId).sort().join('|');
    if (!key || annotated.has(key)) continue;
    annotated.add(key);
    const evidence = deletedRegionEvidence(batch.operations, batch.evidenceKind);
    if (!evidence) continue;
    for (const operation of batch.operations) operation.compressionOpportunity = evidence;
  }
}

function changedMemberKeys(before, after, thresholdPx) {
  // Changing ownership (e.g. declaring a ring) isn't a geometric delete + add.
  const members = state => Object.values(state?.nodes || {}).flatMap(node => node.members || []);
  return new Set(memberDifference(members(before), members(after), thresholdPx).map(change => change.memberId));
}

export function diffBezierSemanticStates(before, after, options = {}) {
  const thresholdPx = Number.isFinite(options.thresholdPx) ? options.thresholdPx : DEFAULT_THRESHOLD_PX;
  const hints = Array.isArray(options.commandHints) ? options.commandHints.map(String) : [];
  const commandEvidence = Array.isArray(options.commandEvidence) ? options.commandEvidence : [];
  const classificationOptions = {
    hints,
    commandEvidence,
    commandScope: options.commandScope === 'single' ? 'single' : 'aggregate'
  };
  const contextualOperations = contextOperations(before, after);
  const declarationOperations = inferDeclarationOperations(before, after);
  const workingBefore = clone(before || {
    format: 'semantic-object-state', version: 4, level: {}, groups: {}, nodes: {}
  });
  for (const operation of [...contextualOperations, ...declarationOperations]) applyOperation(workingBefore, operation);
  const operations = [...contextualOperations, ...declarationOperations];
  const ids = new Set([...Object.keys(workingBefore?.nodes || {}), ...Object.keys(after?.nodes || {})]);
  for (const objectId of [...ids].sort()) {
    const left = workingBefore?.nodes?.[objectId];
    const right = after?.nodes?.[objectId];
    if (!left && right) {
      const isBezier = right.family === 'BezierStroke';
      const isLiteral = !hasObjectExecutor(right);
      const operation = isBezier ? {
        type: 'add-stroke', expressibility: 'native', objectId, groupId: right.groupId || objectId,
        stroke: cleanStrokePayload(right), affectedMemberCount: right.members.length
      } : {
        type: 'add-object', expressibility: isLiteral ? 'fallback' : 'native',
        objectId, object: cleanObjectPayload(right),
        reason: isLiteral ? 'undeclared-literal-object' : null,
        affectedMemberCount: right.members.length,
        changes: isLiteral ? right.members.map(member => ({
          memberId: memberKey(member), index: member.index, kind: 'add-member', before: null, after: clone(member)
        })) : []
      };
      operations.push(operation);
      const simulated = { format: 'semantic-object-state', version: 4, level: {}, groups: {}, nodes: {} };
      applyOperation(simulated, operation);
      const fallbackChanges = memberDifference(simulated.nodes[objectId]?.members, right.members, GEOMETRY_EPSILON_PX);
      if ((isBezier || !isLiteral) && fallbackChanges.length) {
        operations.push(...residualOperations(
          objectId, fallbackChanges, right.lineage, thresholdPx,
          { selectionTransformProven: commandProvesSelectionTransform(objectId, fallbackChanges, classificationOptions) }
        ));
      }
      continue;
    }
    if (left && !right) {
      operations.push(left.family === 'BezierStroke' ? {
        type: 'delete-stroke', expressibility: 'native', objectId, groupId: left.groupId || objectId,
        affectedMemberCount: left.members.length, deletedBounds: nodeBounds(left)
      } : {
        type: 'delete-object', expressibility: 'native', objectId,
        family: left.family, affectedMemberCount: left.members.length, deletedBounds: nodeBounds(left)
      });
      continue;
    }
    if (same(left, right)) continue;
    if (left.family === 'BezierStroke' && right.family === 'BezierStroke') {
      operations.push(...nativeOperationsForNode(left, right, thresholdPx, classificationOptions));
    } else {
      operations.push(...genericOperationsForNode(left, right, thresholdPx));
    }
  }

  const deleted = operations.filter(operation => operation.type === 'delete-stroke');
  annotateDeletedRegions(deleted, classificationOptions);

  return {
    format: 'semantic-object-patch', version: 4, hints, operations,
    metrics: semanticPatchMetrics(operations, before, after, { thresholdPx })
  };
}

export function applyBezierSemanticPatch(state, patch) {
  const result = clone(state || { format: 'semantic-object-state', version: 4, level: {}, groups: {}, nodes: {} });
  result.format = 'semantic-object-state';
  result.version = 4;
  result.level ||= {};
  result.groups ||= {};
  result.nodes ||= {};
  for (const operation of patch?.operations || []) applyOperation(result, operation);
  return result;
}

export function semanticPatchMetrics(operations, before = null, after = null, options = {}) {
  const thresholdPx = Number.isFinite(options.thresholdPx) ? options.thresholdPx : DEFAULT_THRESHOLD_PX;
  const meaningful = (operations || []).filter(operation => operation.expressibility !== 'ignored');
  const fallback = meaningful.filter(operation => operation.expressibility === 'fallback');
  const fallbackReasonCounts = {};
  const languageGapReasonCounts = {};
  const fallbackChangedKeys = new Set();
  const fallbackFinalKeys = new Set();
  for (const operation of fallback) {
    const reason = operation.reason || 'unclassified';
    fallbackReasonCounts[reason] = (fallbackReasonCounts[reason] || 0) + 1;
    if (operation.languageGapCandidate) {
      languageGapReasonCounts[operation.languageGapCandidate] = (languageGapReasonCounts[operation.languageGapCandidate] || 0) + 1;
    }
    for (const change of (Array.isArray(operation.changes) ? operation.changes : [])) {
      const key = change.memberId || memberKey(change.after || change.before);
      fallbackChangedKeys.add(key);
    }
  }
  const changedKeys = before && after ? changedMemberKeys(before, after, thresholdPx) : new Set();
  const repairFallbackKeys = new Set([...fallbackChangedKeys].filter(key => changedKeys.has(key)));
  const precisionKeys = new Set((operations || []).filter(op => op.type === 'precision-correction')
    .flatMap(op => op.changes || []).map(change => change.memberId));
  const finalMemberCount = Object.values(after?.nodes || {}).reduce((sum, node) => sum + (node.members?.length || 0), 0);
  for (const node of Object.values(after?.nodes || {})) {
    let reconstructed = [];
    if (node.family === 'BezierStroke' && node.curve) {
      const program = clone(node);
      program.lineage.exceptions = semanticExceptions(null);
      reconstructed = bakeNodeMembers(program);
    } else if (hasObjectExecutor(node)) reconstructed = bakeObjectMembers(node);
    const differences = new Set(memberDifference(reconstructed, node.members, thresholdPx).map(change => change.memberId));
    for (const member of node.members || []) {
      if (differences.has(memberKey(member))) fallbackFinalKeys.add(memberKey(member));
    }
  }
  return {
    operationCount: meaningful.length,
    nativeOperationCount: meaningful.length - fallback.length,
    fallbackOperationCount: fallback.length,
    contextOperationCount: meaningful.filter(operation => [
      'set-level-properties', 'add-group', 'delete-group', 'set-group-members', 'set-group-properties'
    ].includes(operation.type)).length,
    fallbackContextOperationCount: fallback.filter(operation => [
      'set-level-properties', 'set-group-properties'
    ].includes(operation.type)).length,
    changedMemberCount: changedKeys.size,
    fallbackChangedMemberCount: repairFallbackKeys.size,
    repairFallbackFraction: changedKeys.size ? repairFallbackKeys.size / changedKeys.size : 0,
    // Intermediate reconstruction costs aren't manual before/after edits.
    reconstructionFallbackMemberCount: fallbackChangedKeys.size,
    reconstructionOnlyFallbackMemberCount: fallbackChangedKeys.size - repairFallbackKeys.size,
    precisionCorrectionMemberCount: precisionKeys.size,
    meaningfulPositionThresholdPx: thresholdPx,
    finalMemberCount,
    fallbackFinalMemberCount: fallbackFinalKeys.size,
    stateFallbackFraction: finalMemberCount ? fallbackFinalKeys.size / finalMemberCount : 0,
    stateProgramCoverage: finalMemberCount ? 1 - fallbackFinalKeys.size / finalMemberCount : 1,
    fallbackReasonCounts,
    languageGapReasonCounts
  };
}

function compareSemanticStates(expected, actual, tolerancePx = 1e-5) {
  const ids = new Set([...Object.keys(expected?.nodes || {}), ...Object.keys(actual?.nodes || {})]);
  let strokeUnits = 0, matchedStrokeUnits = 0, memberUnits = 0, matchedMemberUnits = 0;
  let contextUnits = 1, matchedContextUnits = same(expected?.level || {}, actual?.level || {}) ? 1 : 0;
  const groupIds = new Set([...Object.keys(expected?.groups || {}), ...Object.keys(actual?.groups || {})]);
  for (const objectId of groupIds) {
    contextUnits++;
    if (same(expected?.groups?.[objectId], actual?.groups?.[objectId])) matchedContextUnits++;
  }
  for (const groupId of ids) {
    strokeUnits++;
    const left = expected?.nodes?.[groupId];
    const right = actual?.nodes?.[groupId];
    if (left && right && left.objectId === right.objectId && left.family === right.family
        && same(left.definition || null, right.definition || null)
        && (left.family !== 'BezierStroke' || (
          POINT_KEYS.every(key => pointsClose(left.curve?.[key], right.curve?.[key], tolerancePx))
          && same(changedCurveProperties(left.curve, right.curve), {})
        ))
        && same(left.lineage, right.lineage)) matchedStrokeUnits++;
    const expectedMembers = new Map((left?.members || []).map(member => [memberKey(member), member]));
    const actualMembers = new Map((right?.members || []).map(member => [memberKey(member), member]));
    const indices = new Set([...expectedMembers.keys(), ...actualMembers.keys()]);
    for (const index of indices) {
      memberUnits++;
      const before = expectedMembers.get(index), after = actualMembers.get(index);
      if (before && after && memberDifference([before], [after], tolerancePx).length === 0) matchedMemberUnits++;
    }
  }
  const totalUnits = contextUnits + strokeUnits + memberUnits;
  return {
    exact: matchedContextUnits === contextUnits
      && matchedStrokeUnits === strokeUnits && matchedMemberUnits === memberUnits,
    replayAccuracy: totalUnits ? (matchedContextUnits + matchedStrokeUnits + matchedMemberUnits) / totalUnits : 1,
    strokeAccuracy: strokeUnits ? matchedStrokeUnits / strokeUnits : 1,
    memberAccuracy: memberUnits ? matchedMemberUnits / memberUnits : 1
  };
}

export function semanticReplayReport(expected, actual, patch) {
  return {
    ...compareSemanticStates(expected, actual),
    repairFallbackFraction: Number(patch?.metrics?.repairFallbackFraction || 0),
    stateFallbackFraction: Number(patch?.metrics?.stateFallbackFraction || 0),
    stateProgramCoverage: Number(patch?.metrics?.stateProgramCoverage ?? 1),
    fallbackReasonCounts: clone(patch?.metrics?.fallbackReasonCounts || {})
  };
}
