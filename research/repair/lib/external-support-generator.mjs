import { ensureLevelSemanticIdentity } from '../../../js/bezier-program.js';
import { evaluateCompositionGeometry } from '../../../js/composition-geometry.js';
import { generateRadialLevel } from './radial-generator.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
export const SUPPORT_STUDY_SEEDS = Object.freeze(['external-support-01', 'external-support-02', 'external-support-03']);

// A small explicit rule, not inverse design or automatically learned language.
// The intact radial recipe supplies the silhouette. Sites have durable roles
// and identity; editor edits remain honest LiteralCluster fallback until a
// constructive semantic executor for relations actually exists.
export function generateSupportedRadialLevel(seed, radialRules, supportRules, variant = 'blue-supports') {
  if (!['base', 'blue-supports', 'side-bumpers'].includes(variant)) throw new Error('Unknown support variant');
  if (supportRules?.format !== 'external-support-rules' || supportRules.version !== 1 || !supportRules.revision) throw new Error('Invalid support rules');
  const limits = { upperNormalizedY: [-0.95, -0.3], horizontalGapPx: [20, 65], bottomGapPx: [20, 70],
    minimumWallGapPx: [0, 20], bumperScale: [1, 3], bumperBounce: [0.5, 7] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (!Number.isFinite(supportRules[key]) || supportRules[key] < min || supportRules[key] > max) throw new Error(`Invalid support parameter: ${key}`);
  }
  const generated = generateRadialLevel(seed, radialRules), level = clone(generated.level), p = generated.parameters;
  const rx = p.innerRadius + (p.ringCount - 1) * p.ringStep, ry = rx * p.verticalScale;
  const reservedRadius = level.pegRadius * supportRules.bumperScale;
  const minX = reservedRadius + supportRules.minimumWallGapPx;
  const plan = [];
  for (const [band, ny] of [['upper', supportRules.upperNormalizedY], ['side', 0]]) {
    for (const direction of [-1, 1]) {
      const role = `${band}-${direction < 0 ? 'left' : 'right'}`;
      const desiredX = p.centerX + direction * (rx * Math.sqrt(1 - ny * ny) + supportRules.horizontalGapPx);
      const x = Math.min(400 - minX, Math.max(minX, desiredX));
      plan.push({ role, x, y: p.centerY + ny * ry, normalizedY: ny, desiredX,
        wallAdjustmentPx: x - desiredX });
    }
  }
  plan.push({ role: 'exit-center', x: p.centerX, y: p.centerY + ry + supportRules.bottomGapPx, wallAdjustmentPx: 0 });
  if (variant !== 'base') for (const site of plan) {
    const objectId = `support:${site.role}`, bumper = variant === 'side-bumpers' && site.role.startsWith('side-');
    if (level.metadata.generatorProgram.nodes[objectId]) throw new Error(`Support identity collision: ${objectId}`);
    level.pegs.push({ id: objectId, objectId, memberId: `${objectId}:member:0`, x: site.x, y: site.y,
      shape: 'circle', type: bumper ? 'bumper' : 'blue', angle: 0, groupId: null,
      ...(bumper ? { bumperScale: supportRules.bumperScale, bumperBounce: supportRules.bumperBounce,
        bumperDisappear: false, bumperOrange: false } : {}) });
    level.metadata.generatorProgram.nodes[objectId] = { objectId, family: 'LiteralCluster', memberIds: [`${objectId}:member:0`],
      source: { generator: supportRules.revision, role: site.role, relation: site.role === 'exit-center' ? 'below-frame-exit' : 'outside-frame' } };
  }
  ensureLevelSemanticIdentity(level);
  const supportRecipe = { revision: supportRules.revision, variant, rules: clone(supportRules),
    frame: { centerX: p.centerX, centerY: p.centerY, rx, ry }, plan,
    limitations: 'Wall-constrained sites are recorded, never silently rejected or resampled. Static checks do not predict useful ricochets; no scrolling/destruction or learned inverse rule.' };
  level.metadata.supportRecipe = supportRecipe;
  level.id = `${supportRules.revision}:${seed}:${variant}`;
  level.name = `${seed} · ${variant}`;
  return { ...generated, revision: variant === 'base' ? radialRules.revision : `${supportRules.revision}:${variant}`,
    parameters: { ...p, supports: supportRecipe }, level, staticChecks: evaluateCompositionGeometry(level) };
}
