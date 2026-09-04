// Semantic object lineage shared by every editor object family. The file keeps
// its historical name because the editor already imports it in many places.

export const GENERATOR_PROGRAM_SCHEMA_VERSION = 2;
export const BEZIER_PROGRAM_SCHEMA_VERSION = GENERATOR_PROGRAM_SCHEMA_VERSION;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function newSemanticId(prefix = 'object') {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  return `${prefix}:${suffix}`;
}

export function createSemanticObjectId(prefix = 'object') {
  return newSemanticId(prefix);
}

function uniqueId(preferred, used, prefix) {
  let value = typeof preferred === 'string' && preferred ? preferred : newSemanticId(prefix);
  while (used.has(value)) value = newSemanticId(prefix);
  used.add(value);
  return value;
}

export function ensureGeneratorProgram(level) {
  if (!isRecord(level)) return null;
  level.metadata = isRecord(level.metadata) ? level.metadata : {};
  if (!isRecord(level.metadata.generatorProgram)) {
    level.metadata.generatorProgram = {
      schemaVersion: GENERATOR_PROGRAM_SCHEMA_VERSION,
      nodes: {},
      declarationLog: [],
      commandLog: []
    };
  }
  const program = level.metadata.generatorProgram;
  program.schemaVersion = GENERATOR_PROGRAM_SCHEMA_VERSION;
  if (!isRecord(program.nodes)) program.nodes = {};
  if (!Array.isArray(program.declarationLog)) program.declarationLog = [];
  if (!Array.isArray(program.commandLog)) program.commandLog = [];
  return program;
}

// Backward-compatible export used by the existing editor and compiler.
export const ensureBezierProgram = ensureGeneratorProgram;

function normalizeNode(raw, objectId, fallbackFamily = 'LiteralCluster') {
  const node = isRecord(raw) ? raw : {};
  node.objectId = String(objectId);
  if (!node.sourceRef && node.nodeId && String(node.nodeId) !== String(objectId)) {
    node.sourceRef = String(node.nodeId);
  }
  delete node.nodeId;
  node.family = String(node.family || fallbackFamily);
  if (!Array.isArray(node.memberIds)) node.memberIds = [];
  node.memberIds = [...new Set(node.memberIds.filter(value => typeof value === 'string' && value))];
  if (node.family === 'BezierStroke') {
    if (!isRecord(node.binding)) node.binding = {};
    node.binding.type = 'bezier';
    node.exceptions = isRecord(node.exceptions) ? node.exceptions : { deletedIndices: [], overrides: {} };
    if (!Array.isArray(node.exceptions.deletedIndices)) node.exceptions.deletedIndices = [];
    if (!isRecord(node.exceptions.overrides)) node.exceptions.overrides = {};
  }
  return node;
}

function findBezierObjectId(program, bezierGroupId) {
  for (const [key, raw] of Object.entries(program.nodes)) {
    if (!isRecord(raw)) continue;
    if (raw.family === 'BezierStroke'
        && (raw.binding?.bezierGroupId === bezierGroupId || raw.bezierGroupId === bezierGroupId || key === bezierGroupId)) {
      return String(raw.objectId || key);
    }
  }
  return null;
}

export function ensureSemanticObjectNode(level, objectId, family = 'LiteralCluster') {
  if (!objectId) return null;
  const program = ensureGeneratorProgram(level);
  const key = String(objectId);
  const node = normalizeNode(program.nodes[key], key, family);
  if (!node.family || node.family === 'LiteralCluster') node.family = family;
  program.nodes[key] = node;
  return node;
}

export function ensureBezierNode(level, bezierGroupId) {
  if (!bezierGroupId) return null;
  const program = ensureGeneratorProgram(level);
  const objectId = findBezierObjectId(program, String(bezierGroupId)) || String(bezierGroupId);
  let source = program.nodes[objectId];
  if (!source && isRecord(program.nodes[bezierGroupId])) source = program.nodes[bezierGroupId];
  const node = normalizeNode(source, objectId, 'BezierStroke');
  node.family = 'BezierStroke';
  node.binding = { type: 'bezier', bezierGroupId: String(bezierGroupId) };
  program.nodes[objectId] = node;
  if (objectId !== String(bezierGroupId)) delete program.nodes[bezierGroupId];
  return node;
}

/**
 * Upgrade/mend semantic identity without touching volatile runtime IDs.
 * Every physical peg belongs to exactly one object node.
 */
export function ensureLevelSemanticIdentity(level) {
  if (!isRecord(level)) return null;
  if (!Array.isArray(level.pegs)) level.pegs = [];
  if (!isRecord(level.bezierCurves)) level.bezierCurves = {};
  const program = ensureGeneratorProgram(level);

  const migrated = {};
  const usedObjectIds = new Set();
  const bezierObjectIds = new Map();
  for (const [legacyKey, raw] of Object.entries(program.nodes)) {
    if (!isRecord(raw)) continue;
    const groupId = raw.binding?.bezierGroupId || raw.bezierGroupId
      || (raw.family === 'BezierStroke' ? legacyKey : null);
    const preferred = raw.objectId || (groupId ? legacyKey : raw.nodeId) || legacyKey;
    const objectId = uniqueId(String(preferred), usedObjectIds, 'object');
    const node = normalizeNode(raw, objectId, groupId ? 'BezierStroke' : 'LiteralCluster');
    if (groupId) {
      node.family = 'BezierStroke';
      node.binding = { type: 'bezier', bezierGroupId: String(groupId) };
      bezierObjectIds.set(String(groupId), objectId);
    }
    migrated[objectId] = node;
  }

  for (const groupId of Object.keys(level.bezierCurves)) {
    if (bezierObjectIds.has(groupId)) continue;
    const objectId = uniqueId(groupId, usedObjectIds, 'bezier');
    const node = normalizeNode(null, objectId, 'BezierStroke');
    node.family = 'BezierStroke';
    node.binding = { type: 'bezier', bezierGroupId: groupId };
    migrated[objectId] = node;
    bezierObjectIds.set(groupId, objectId);
  }

  const usedMemberIds = new Set();
  const membersByObject = new Map();
  for (const peg of level.pegs) {
    const bezierGroupId = peg.bezierGroupId ? String(peg.bezierGroupId) : null;
    let objectId;
    if (bezierGroupId) {
      objectId = bezierObjectIds.get(bezierGroupId);
      if (!objectId) {
        objectId = uniqueId(bezierGroupId, usedObjectIds, 'bezier');
        const node = normalizeNode(null, objectId, 'BezierStroke');
        node.family = 'BezierStroke';
        node.binding = { type: 'bezier', bezierGroupId };
        migrated[objectId] = node;
        bezierObjectIds.set(bezierGroupId, objectId);
      }
    } else if (typeof peg.objectId === 'string' && peg.objectId) {
      objectId = peg.objectId;
      if (!migrated[objectId]) {
        usedObjectIds.add(objectId);
        migrated[objectId] = normalizeNode(null, objectId, 'LiteralCluster');
      }
    } else {
      objectId = uniqueId(null, usedObjectIds, 'literal');
      migrated[objectId] = normalizeNode(null, objectId, 'LiteralCluster');
    }
    peg.objectId = objectId;

    const derivedMemberId = bezierGroupId && Number.isFinite(peg.bezierIndex)
      ? `${objectId}:member:${Number(peg.bezierIndex)}`
      : null;
    peg.memberId = uniqueId(derivedMemberId || peg.memberId, usedMemberIds, 'member');
    if (!membersByObject.has(objectId)) membersByObject.set(objectId, []);
    membersByObject.get(objectId).push(peg.memberId);
  }

  for (const [objectId, node] of Object.entries(migrated)) {
    node.memberIds = membersByObject.get(objectId) || [];
    const boundCurve = node.family === 'BezierStroke'
      && level.bezierCurves[node.binding?.bezierGroupId];
    if (node.memberIds.length === 0 && !boundCurve) delete migrated[objectId];
  }
  for (const group of level.groups || []) {
    group.objectId = uniqueId(group.objectId, usedObjectIds, 'group');
  }
  program.nodes = migrated;
  return program;
}

export function removeSemanticNode(level, objectId) {
  const nodes = level?.metadata?.generatorProgram?.nodes;
  if (isRecord(nodes) && objectId) delete nodes[String(objectId)];
}

export function removeBezierNode(level, bezierGroupId) {
  const program = level?.metadata?.generatorProgram;
  if (!isRecord(program?.nodes)) return;
  for (const [objectId, node] of Object.entries(program.nodes)) {
    if (node?.family !== 'BezierStroke') continue;
    if (node.binding?.bezierGroupId === String(bezierGroupId) || objectId === String(bezierGroupId)) {
      delete program.nodes[objectId];
    }
  }
}

export function recordBezierPositionException(level, bezierGroupId, bezierIndex, peg, residualPx) {
  if (!Number.isFinite(bezierIndex) || !peg) return null;
  const node = ensureBezierNode(level, bezierGroupId);
  node.exceptions.overrides[String(bezierIndex)] = {
    kind: 'position', x: Number(peg.x), y: Number(peg.y),
    residualPx: Number.isFinite(residualPx) ? residualPx : null
  };
  return node;
}

export function recordBezierDeletedException(level, bezierGroupId, bezierIndex) {
  if (!Number.isFinite(bezierIndex)) return null;
  const node = ensureBezierNode(level, bezierGroupId);
  const indices = new Set(node.exceptions.deletedIndices.map(Number).filter(Number.isFinite));
  indices.add(bezierIndex);
  node.exceptions.deletedIndices = [...indices].sort((left, right) => left - right);
  delete node.exceptions.overrides[String(bezierIndex)];
  return node;
}

export function clearBezierExceptions(level, bezierGroupId) {
  const node = ensureBezierNode(level, bezierGroupId);
  node.exceptions = { deletedIndices: [], overrides: {} };
  return node;
}

export function writeBezierIntegrityDiagnostic(level, bezierGroupId, diagnostic) {
  const node = ensureBezierNode(level, bezierGroupId);
  node.integrity = {
    pairCount: Number(diagnostic?.pairCount || 0),
    sufficientLineage: diagnostic?.sufficientLineage === true,
    pegCount: Number(diagnostic?.pegCount || 0),
    thresholdPx: Number(diagnostic?.thresholdPx || 0),
    rmsResidualPx: Number.isFinite(diagnostic?.rmsResidualPx) ? diagnostic.rmsResidualPx : null,
    maxResidualPx: Number.isFinite(diagnostic?.maxResidualPx) ? diagnostic.maxResidualPx : null,
    outlierCount: Number(diagnostic?.outlierCount || 0),
    outlierIndices: [...(diagnostic?.outlierIndices || [])]
  };
  return node.integrity;
}
