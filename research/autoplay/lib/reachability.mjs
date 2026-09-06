// Reachability map: which aims reach which pegs, and how reliably.
//
// Every angle is fired under several seeds because the engine applies
// deliberate jitter on peg and wall contacts. A peg hit under one seed and
// missed under the others is reachable by luck, not by aim, and the two must
// not be counted the same way. `seedStability` is the level-wide measure of
// that difference.

import { createSeededRandom } from './sim.mjs';

const TWO_PI = Math.PI * 2;

function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

export function sweepAngles(count, minFraction = 0.10, maxFraction = 0.90) {
  const safe = Math.max(3, Math.trunc(count));
  const min = Math.PI * minFraction;
  const max = Math.PI * maxFraction;
  return Array.from({ length: safe }, (_value, index) => min + (max - min) * (index / (safe - 1)));
}

/**
 * Dense angle sweep on the untouched level.
 *
 * Returns per-trial hit sets, a per-peg access profile, pockets (pegs that the
 * same aims reach), and level metrics. All of it is a sampled lower bound: an
 * angle between two samples may reach something nothing here reached.
 */
export function buildReachability(sim, options = {}) {
  const angles = options.angles || sweepAngles(options.angleCount || 96);
  const seedCount = Math.max(1, Math.trunc(options.seedCount || 5));
  const seedPrefix = String(options.seed || 'reach');

  const trials = [];
  const perAngle = [];
  for (let angleIndex = 0; angleIndex < angles.length; angleIndex++) {
    const angle = angles[angleIndex];
    const seedRuns = [];
    for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
      const seed = `${seedPrefix}:${angleIndex}:${seedIndex}`;
      // The bucket sweeps continuously in play, so its launch phase varies too.
      const bucketPhase = createSeededRandom(`${seed}:bucket`)() * TWO_PI;
      const shot = sim.shoot(angle, { seed, bucketPhase });
      const hitSet = new Set(shot.hits);
      const trial = { angleIndex, seedIndex, angle, hits: hitSet, hitCount: shot.hitCount, bucketCatches: shot.bucketCatches, steps: shot.steps };
      seedRuns.push(trial);
      trials.push(trial);
    }
    // Agreement between seeds at the same aim: 1.0 means the aim determines the
    // outcome, low means the result is mostly jitter.
    const pairs = [];
    for (let left = 0; left < seedRuns.length; left++) {
      for (let right = left + 1; right < seedRuns.length; right++) {
        pairs.push(jaccard(seedRuns[left].hits, seedRuns[right].hits));
      }
    }
    perAngle.push({
      angleIndex,
      angle: round(angle, 5),
      meanHits: round(mean(seedRuns.map(run => run.hitCount)), 2),
      maxHits: Math.max(...seedRuns.map(run => run.hitCount)),
      deadSeeds: seedRuns.filter(run => run.hitCount === 0).length,
      bucketSeeds: seedRuns.filter(run => run.bucketCatches > 0).length,
      seedAgreement: round(pairs.length ? mean(pairs) : 1, 3),
      // Union over seeds: what this aim can reach at all.
      union: new Set(seedRuns.flatMap(run => [...run.hits]))
    });
  }

  // Per-peg access profile.
  const access = new Map();
  for (const id of sim.targetIds) access.set(id, { id, angleIndices: new Set(), trialHits: 0 });
  for (const trial of trials) {
    for (const id of trial.hits) {
      const entry = access.get(id);
      if (!entry) continue;
      entry.angleIndices.add(trial.angleIndex);
      entry.trialHits++;
    }
  }
  const trialCount = trials.length || 1;
  for (const entry of access.values()) {
    entry.reliability = round(entry.trialHits / trialCount, 4);
    // Reliability conditional on using one of the aims that ever works.
    entry.conditionalReliability = round(
      entry.angleIndices.size ? entry.trialHits / (entry.angleIndices.size * seedCount) : 0, 3
    );
    entry.reachable = entry.angleIndices.size > 0;
  }

  const reachable = [...access.values()].filter(entry => entry.reachable);
  const pockets = groupIntoPockets(reachable, options.pocketSimilarity ?? 0.45);

  const hitCounts = trials.map(trial => trial.hitCount);
  const adjacent = [];
  for (let index = 1; index < perAngle.length; index++) {
    adjacent.push(1 - jaccard(perAngle[index - 1].union, perAngle[index].union));
  }
  const signatures = new Set(trials.map(trial => [...trial.hits].sort().join('|')));

  return {
    angles,
    seedCount,
    perAngle: perAngle.map(entry => ({ ...entry, union: [...entry.union].sort() })),
    trials: trials.map(trial => ({
      angleIndex: trial.angleIndex,
      seedIndex: trial.seedIndex,
      hits: [...trial.hits].sort(),
      hitCount: trial.hitCount,
      bucketCatches: trial.bucketCatches
    })),
    access: [...access.values()].map(entry => ({
      id: entry.id,
      reachable: entry.reachable,
      angleIndices: [...entry.angleIndices].sort((left, right) => left - right),
      accessWidth: entry.angleIndices.size,
      reliability: entry.reliability,
      conditionalReliability: entry.conditionalReliability
    })),
    pockets,
    metrics: {
      targetCount: sim.targetIds.size,
      trialCount,
      reachableCount: reachable.length,
      reachableFraction: round(sim.targetIds.size ? reachable.length / sim.targetIds.size : 0, 3),
      deadAngleRate: round(trials.filter(trial => trial.hitCount === 0).length / trialCount, 3),
      lowValueAngleRate: round(trials.filter(trial => trial.hitCount <= 1).length / trialCount, 3),
      medianShotHits: round(median(hitCounts), 2),
      meanShotHits: round(mean(hitCounts), 2),
      maxShotHits: Math.max(0, ...hitCounts),
      // How much a small change of aim changes the outcome. Near zero means aim
      // barely matters; near one means the level is knife-edge.
      aimSensitivity: round(mean(adjacent), 3),
      outcomeDiversity: round(signatures.size / trialCount, 3),
      // How much of the outcome is aim rather than jitter.
      seedStability: round(mean(perAngle.map(entry => entry.seedAgreement)), 3),
      bucketReturnRate: round(trials.filter(trial => trial.bucketCatches > 0).length / trialCount, 3),
      pocketCount: pockets.length,
      largestPocketFraction: round(
        reachable.length ? Math.max(0, ...pockets.map(pocket => pocket.pegIds.length)) / reachable.length : 0, 3
      )
    }
  };
}

/**
 * Pegs the same aims reach belong to the same pocket. Grouping is connected
 * components over an access-set similarity threshold, which is coarse but is
 * exactly the property orange placement needs: two pegs in one pocket fall to
 * one shot, two pegs in different pockets cost two.
 */
function groupIntoPockets(entries, threshold) {
  const adjacency = entries.map(() => []);
  for (let left = 0; left < entries.length; left++) {
    for (let right = left + 1; right < entries.length; right++) {
      if (jaccard(entries[left].angleIndices, entries[right].angleIndices) >= threshold) {
        adjacency[left].push(right);
        adjacency[right].push(left);
      }
    }
  }
  const seen = new Set();
  const pockets = [];
  for (let index = 0; index < entries.length; index++) {
    if (seen.has(index)) continue;
    const members = [];
    const stack = [index];
    seen.add(index);
    while (stack.length) {
      const current = stack.pop();
      members.push(entries[current]);
      for (const next of adjacency[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const angleUnion = new Set(members.flatMap(member => [...member.angleIndices]));
    pockets.push({
      id: `pocket-${String(pockets.length + 1).padStart(2, '0')}`,
      pegIds: members.map(member => member.id).sort(),
      size: members.length,
      angleIndices: [...angleUnion].sort((left, right) => left - right),
      meanAccessWidth: round(mean(members.map(member => member.angleIndices.size)), 2),
      meanReliability: round(mean(members.map(member => member.conditionalReliability)), 3)
    });
  }
  return pockets.sort((left, right) => right.size - left.size);
}
