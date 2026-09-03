import {
  DEFAULT_BEZIER_EXCEPTION_THRESHOLD_PX,
  auditBezierGroup,
  transformBezierCurve
} from './bezier-geometry.js';
import {
  ensureBezierNode,
  removeBezierNode,
  writeBezierIntegrityDiagnostic
} from './bezier-program.js';

function materiallyChanges(transform) {
  return !!transform && (
    transform.reflect === true
    || Math.abs(Number(transform.tx || 0)) > 1e-7
    || Math.abs(Number(transform.ty || 0)) > 1e-7
    || Math.abs(Number(transform.angle || 0)) > 1e-9
    || Math.abs(Number(transform.scale || 1) - 1) > 1e-9
  );
}

export function auditNativeLevelBezierIntegrity(level, options = {}) {
  const thresholdPx = Number.isFinite(options.thresholdPx)
    ? options.thresholdPx
    : DEFAULT_BEZIER_EXCEPTION_THRESHOLD_PX;
  const repair = options.repair === true;
  level.bezierCurves ||= {};
  const reports = [];
  const pegsByGroup = new Map();
  for (const peg of level.pegs || []) {
    if (!peg?.bezierGroupId) continue;
    if (!pegsByGroup.has(peg.bezierGroupId)) pegsByGroup.set(peg.bezierGroupId, []);
    pegsByGroup.get(peg.bezierGroupId).push(peg);
  }
  const groupIds = new Set([...Object.keys(level.bezierCurves), ...pegsByGroup.keys()]);
  for (const groupId of [...groupIds].sort()) {
    const curve = level.bezierCurves[groupId];
    const pegs = pegsByGroup.get(groupId) || [];
    if (!curve) {
      reports.push({ groupId, status: 'missing-curve', pegCount: pegs.length });
      continue;
    }
    if (pegs.length === 0) {
      reports.push({ groupId, status: 'orphan-curve', pegCount: 0 });
      if (repair) {
        delete level.bezierCurves[groupId];
        removeBezierNode(level, groupId);
      }
      continue;
    }
    const diagnostic = auditBezierGroup(curve, pegs, {
      thresholdPx,
      allowScale: true,
      allowReflection: true
    });
    const canReconcile = diagnostic.sufficientLineage && diagnostic.transform && diagnostic.outlierCount === 0;
    const changed = canReconcile && materiallyChanges(diagnostic.transform);
    const status = !diagnostic.sufficientLineage
      ? 'insufficient-lineage'
      : (diagnostic.outlierCount > 0 ? 'exceptions-or-malformed' : (changed ? 'similarity-reconcilable' : 'aligned'));
    reports.push({ groupId, status, ...diagnostic });
    if (repair && canReconcile) {
      if (changed) level.bezierCurves[groupId] = transformBezierCurve(curve, diagnostic.transform);
      ensureBezierNode(level, groupId);
      writeBezierIntegrityDiagnostic(level, groupId, {
        ...diagnostic,
        rmsResidualPx: 0,
        maxResidualPx: 0,
        outlierCount: 0,
        outlierIndices: []
      });
    }
  }
  const counts = {};
  for (const report of reports) counts[report.status] = (counts[report.status] || 0) + 1;
  return { thresholdPx, repaired: repair, counts, reports };
}
