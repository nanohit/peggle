// Orange placement from the reachability map.
//
// Generator v0 assigned orange by shuffling the peg list. That is a colouring,
// not a route, and it controls nothing: a random draw both lets one lucky shot
// scoop six oranges and scatters the rest so widely that no ten-ball budget can
// finish them.
//
// The goal is not "make it need as many aims as possible" - that direction ends
// in unwinnable levels. It is to land the number of distinct aims inside a
// playable band relative to the ball budget, while capping how much any single
// shot can collect. The cap is auto-tuned: spread the oranges harder until the
// route is long enough, then stop.
//
// `coverShots` here is a cheap static proxy computed on the untouched layout.
// The real number is produced by the beam search in `search.mjs`, which plays
// the assignment with pegs actually disappearing.

function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

function mulberry(seed) {
  let state = 0;
  for (let index = 0; index < seed.length; index++) state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Distinct aims needed to collect every orange, greedily, on the untouched
 * layout. Oranges no sampled shot reaches cost one dedicated shot each.
 */
export function coverShots(trialHitSets, orangeIds) {
  const remaining = new Set(orangeIds);
  let shots = 0;
  let guard = 0;
  while (remaining.size && guard++ < 400) {
    let bestGain = 0;
    let bestSet = null;
    for (const hits of trialHitSets) {
      let gain = 0;
      for (const id of hits) if (remaining.has(id)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        bestSet = hits;
      }
    }
    if (!bestSet) break;
    for (const id of bestSet) remaining.delete(id);
    shots++;
  }
  return { shots: shots + remaining.size, unreachedByAnyShot: remaining.size };
}

function maxYield(trialHitSets, orangeSet) {
  let worst = 0;
  for (const hits of trialHitSets) {
    let count = 0;
    for (const id of hits) if (orangeSet.has(id)) count++;
    if (count > worst) worst = count;
  }
  return worst;
}

function selectWithCap(candidates, trialHitSets, wanted, maxPerShot, angleCount) {
  const chosen = [];
  const chosenSet = new Set();
  const pocketUse = new Map();
  const target = Math.min(wanted, candidates.length);

  while (chosen.length < target) {
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      if (chosenSet.has(candidate.id)) continue;
      chosenSet.add(candidate.id);
      const exceeds = maxYield(trialHitSets, chosenSet) > maxPerShot;
      chosenSet.delete(candidate.id);
      if (exceeds) continue;

      const overlap = chosen.length
        ? Math.max(...chosen.map(entry => jaccard(entry.angleSet, candidate.angleSet)))
        : 0;
      const pocketLoad = pocketUse.get(candidate.pocket) || 0;
      // A narrow access window means the peg demands a specific aim; depth means
      // it only opens up after something else is gone. Both turn an orange into
      // a step in a route. Reliability keeps it off pure jitter.
      const narrowness = 1 - Math.min(1, candidate.accessWidth / Math.max(1, angleCount * 0.35));
      const score = (1 - overlap) * 3
        - pocketLoad * 1.2
        + narrowness * 1.1
        + Math.min(3, candidate.depth - 1) * 0.6
        + candidate.reliability * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (!best) break;
    chosen.push(best);
    chosenSet.add(best.id);
    pocketUse.set(best.pocket, (pocketUse.get(best.pocket) || 0) + 1);
  }
  return { chosen, pocketUse };
}

export function planOranges(reachability, options = {}) {
  const wanted = Math.max(1, Math.trunc(options.count || 0));
  const balls = Math.max(1, Math.trunc(options.balls || 10));
  // A level that needs more aims than balls is unwinnable; one that needs three
  // is a formality. Aim for the upper half of the budget.
  const band = options.band || { min: Math.max(2, Math.ceil(balls * 0.5)), max: Math.max(3, balls - 1) };
  const capCandidates = options.capCandidates || [2, 3, 4, 5, 6, 8];
  const minAccessWidth = Math.max(1, Math.trunc(options.minAccessWidth ?? 1));
  const seed = String(options.seed || 'orange');
  const depthByPeg = new Map((options.depth || []).map(entry => [entry.id, entry.firstHitBall]));

  const trialHitSets = reachability.trials.map(trial => new Set(trial.hits));
  const pocketByPeg = new Map();
  for (const pocket of reachability.pockets) {
    for (const id of pocket.pegIds) pocketByPeg.set(id, pocket.id);
  }
  const candidates = reachability.access
    .filter(entry => entry.reachable && entry.accessWidth >= minAccessWidth)
    .map(entry => ({
      id: entry.id,
      angleSet: new Set(entry.angleIndices),
      accessWidth: entry.accessWidth,
      reliability: entry.conditionalReliability,
      pocket: pocketByPeg.get(entry.id) || null,
      depth: depthByPeg.get(entry.id) ?? 1
    }));

  if (!candidates.length) {
    return { status: 'no-reachable-candidates', orangeIds: [], quality: null, attempts: [] };
  }

  const attempts = [];
  for (const cap of capCandidates) {
    const { chosen, pocketUse } = selectWithCap(candidates, trialHitSets, wanted, cap, reachability.angles.length);
    if (chosen.length < Math.min(wanted, candidates.length) * 0.85) {
      attempts.push({ cap, rejected: 'could-not-place-enough-oranges', placed: chosen.length });
      continue;
    }
    const ids = chosen.map(entry => entry.id).sort();
    const cover = coverShots(trialHitSets, ids);
    attempts.push({
      cap,
      placed: chosen.length,
      coverShots: cover.shots,
      unreachedByAnyShot: cover.unreachedByAnyShot,
      maxShotYield: maxYield(trialHitSets, new Set(ids)),
      pocketsUsed: pocketUse.size,
      inBand: cover.shots >= band.min && cover.shots <= band.max,
      chosen
    });
  }

  const usable = attempts.filter(attempt => attempt.chosen);
  if (!usable.length) {
    return { status: 'no-feasible-plan', orangeIds: [], quality: null, attempts };
  }
  const distanceToBand = attempt => (
    attempt.coverShots < band.min ? band.min - attempt.coverShots
      : attempt.coverShots > band.max ? attempt.coverShots - band.max : 0
  );
  usable.sort((left, right) => (
    distanceToBand(left) - distanceToBand(right)
    || left.maxShotYield - right.maxShotYield
    || right.pocketsUsed - left.pocketsUsed
  ));
  const picked = usable[0];
  const orangeIds = picked.chosen.map(entry => entry.id).sort();

  // Baseline: the shuffle the old generator used, same population, averaged.
  const random = mulberry(seed);
  const pool = reachability.access.filter(entry => entry.reachable).map(entry => entry.id);
  const baselineRuns = [];
  const baselineSamples = [];
  for (let run = 0; run < 8; run++) {
    const shuffled = [...pool];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    const sample = shuffled.slice(0, orangeIds.length);
    baselineSamples.push(sample.sort());
    const cover = coverShots(trialHitSets, sample);
    baselineRuns.push({ cover: cover.shots, maxYield: maxYield(trialHitSets, new Set(sample)) });
  }

  return {
    status: 'planned',
    requested: wanted,
    placed: orangeIds.length,
    band,
    chosenCap: picked.cap,
    orangeIds,
    // Representative random assignments, so the validator can play them too.
    baselineOrangeSamples: baselineSamples.slice(0, 3),
    pocketsUsed: picked.pocketsUsed,
    quality: {
      coverShots: picked.coverShots,
      inBand: picked.inBand,
      unreachedByAnyShot: picked.unreachedByAnyShot,
      maxShotYield: picked.maxShotYield,
      meanAccessWidth: round(mean(picked.chosen.map(entry => entry.accessWidth)), 2),
      meanDepth: round(mean(picked.chosen.map(entry => entry.depth)), 2),
      meanReliability: round(mean(picked.chosen.map(entry => entry.reliability)), 3),
      baseline: {
        method: 'uniform-random-among-reachable',
        meanCoverShots: round(mean(baselineRuns.map(run => run.cover)), 2),
        meanMaxShotYield: round(mean(baselineRuns.map(run => run.maxYield)), 2)
      }
    },
    attempts: attempts.map(({ chosen, ...rest }) => rest),
    selection: picked.chosen.map(entry => ({
      id: entry.id,
      pocket: entry.pocket,
      accessWidth: entry.accessWidth,
      reliability: entry.reliability,
      depth: entry.depth
    }))
  };
}
