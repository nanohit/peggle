export const BEZIER_PROGRAM_SCHEMA_VERSION = 1;

export function ensureBezierProgram(level) {
  if (!level || typeof level !== 'object') return null;
  level.metadata = level.metadata && typeof level.metadata === 'object' ? level.metadata : {};
  const existing = level.metadata.generatorProgram;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    level.metadata.generatorProgram = {
      schemaVersion: BEZIER_PROGRAM_SCHEMA_VERSION,
      nodes: {}
    };
  }
  const program = level.metadata.generatorProgram;
  program.schemaVersion = BEZIER_PROGRAM_SCHEMA_VERSION;
  if (!program.nodes || typeof program.nodes !== 'object' || Array.isArray(program.nodes)) program.nodes = {};
  return program;
}

export function ensureBezierNode(level, bezierGroupId) {
  if (!bezierGroupId) return null;
  const program = ensureBezierProgram(level);
  const current = program.nodes[bezierGroupId];
  const node = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  node.nodeId = String(node.nodeId || `bezier:${bezierGroupId}`);
  node.family = 'BezierStroke';
  if (!node.exceptions || typeof node.exceptions !== 'object' || Array.isArray(node.exceptions)) {
    node.exceptions = { deletedIndices: [], overrides: {} };
  }
  if (!Array.isArray(node.exceptions.deletedIndices)) node.exceptions.deletedIndices = [];
  if (!node.exceptions.overrides || typeof node.exceptions.overrides !== 'object' || Array.isArray(node.exceptions.overrides)) {
    node.exceptions.overrides = {};
  }
  program.nodes[bezierGroupId] = node;
  return node;
}

export function removeBezierNode(level, bezierGroupId) {
  const nodes = level?.metadata?.generatorProgram?.nodes;
  if (nodes && typeof nodes === 'object') delete nodes[bezierGroupId];
}

export function recordBezierPositionException(level, bezierGroupId, bezierIndex, peg, residualPx) {
  if (!Number.isFinite(bezierIndex) || !peg) return null;
  const node = ensureBezierNode(level, bezierGroupId);
  node.exceptions.overrides[String(bezierIndex)] = {
    kind: 'position',
    x: Number(peg.x),
    y: Number(peg.y),
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
