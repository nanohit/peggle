import { runHeadlessLab } from '../../tools/run-lab.mjs';
import { mechanicalObjects } from './features.mjs';

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / union.size;
}

export function defaultSweepAngles(count = 17) {
  const safeCount = Math.max(3, Math.trunc(count));
  const min = Math.PI * 0.12;
  const max = Math.PI * 0.88;
  return Array.from({ length: safeCount }, (_value, index) => (
    min + (max - min) * (index / (safeCount - 1))
  ));
}

export async function runShotSweep(levelRecord, options = {}) {
  const angles = options.angles || defaultSweepAngles(options.angleCount);
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps || 3600));
  const seed = String(options.seed || 'benchmark-v0');
  const targetIds = new Set(
    mechanicalObjects(levelRecord)
      .filter(object => object.role === 'target')
      .map(object => object.id)
  );
  const outcomes = [];
  const unionHits = new Set();
  const warningSet = new Set();
  for (let index = 0; index < angles.length; index++) {
    const run = await runHeadlessLab(levelRecord, {
      angle: angles[index],
      maxSteps,
      checkpointEvery: maxSteps,
      seed: `${seed}:${index}`,
      at: options.at
    });
    const targetHits = run.measurements.hitObjectIds.filter(id => targetIds.has(id));
    for (const id of targetHits) unionHits.add(id);
    for (const warning of run.warnings || []) warningSet.add(warning);
    outcomes.push({
      angleRadians: angles[index],
      hitCount: targetHits.length,
      hitObjectIds: targetHits,
      bucketCatches: run.measurements.bucketCatches,
      simulatedSteps: run.measurements.simulatedSteps
    });
  }
  const hitCounts = outcomes.map(outcome => outcome.hitCount);
  const topThreshold = quantile(hitCounts, 0.75);
  const topOutcomes = hitCounts.filter(value => value >= topThreshold);
  const adjacentSimilarities = outcomes.slice(1).map((outcome, index) => (
    jaccard(outcomes[index].hitObjectIds, outcome.hitObjectIds)
  ));
  const uniqueOutcomeCount = new Set(outcomes.map(outcome => outcome.hitObjectIds.join('|'))).size;
  return {
    capability: 'subset-deterministic-angle-sweep',
    angleCount: angles.length,
    angleRangeRadians: [angles[0], angles.at(-1)],
    targetCount: targetIds.size,
    reachableTargetCount: unionHits.size,
    reachableTargetFraction: targetIds.size ? unionHits.size / targetIds.size : 0,
    hitCount: {
      min: Math.min(...hitCounts),
      mean: mean(hitCounts),
      median: median(hitCounts),
      max: Math.max(...hitCounts),
      topQuartileMean: mean(topOutcomes)
    },
    deadShotRate: outcomes.filter(outcome => outcome.hitCount === 0).length / outcomes.length,
    lowValueShotRate: outcomes.filter(outcome => outcome.hitCount <= 1).length / outcomes.length,
    bucketCatchRate: outcomes.filter(outcome => outcome.bucketCatches > 0).length / outcomes.length,
    outcomeDiversity: uniqueOutcomeCount / outcomes.length,
    adjacentAimSensitivity: 1 - mean(adjacentSimilarities),
    skillGradientProxy: mean(topOutcomes) - median(hitCounts),
    unionHitObjectIds: [...unionHits].sort(),
    outcomes,
    warnings: [...warningSet],
    caveats: [
      'One-shot sweep, not a complete-level agent.',
      'Uses the target game PhysicsEngine subset; source Peggle motion and power-up semantics are not simulated.',
      'Reachability is a lower bound over sampled angles, not a proof of inaccessibility.'
    ]
  };
}
