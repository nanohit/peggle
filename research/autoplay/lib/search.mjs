// Multi-shot beam search.
//
// The single-shot sweep answers "what can be reached right now". This answers
// the question that actually matters for difficulty: what becomes reachable
// only after something else has been cleared. A peg that no first shot can
// touch but a third shot can is the raw material of a designed route; a peg no
// branch ever touches is a defect.
//
// With `objectiveIds` the search plays for those pegs specifically, which is how
// an orange assignment gets validated: not by a static proxy on the untouched
// layout, but by counting the balls a competent player needs once pegs start
// disappearing.
//
// It is a play-strength probe, not a player. It ignores scoring, power-ups,
// free balls and perks, and it has no notion of saving a shot for later.

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

function signatureOf(removed) {
  return [...removed].sort().join('|');
}

export function searchCollect(sim, options = {}) {
  const angles = options.angles || [];
  const balls = Math.max(1, Math.trunc(options.balls || 10));
  const beamWidth = Math.max(1, Math.trunc(options.beamWidth || 6));
  const seedPrefix = String(options.seed || 'search');
  const objective = options.objectiveIds ? new Set(options.objectiveIds) : null;
  const targetCount = sim.targetIds.size;
  const objectiveCount = objective ? objective.size : targetCount;

  const firstHitBall = new Map();
  let shotsSimulated = 0;

  const countObjective = removed => {
    if (!objective) return removed.size;
    let total = 0;
    for (const id of removed) if (objective.has(id)) total++;
    return total;
  };

  let beam = [{ removed: new Set(), path: [], objectiveCount: 0, clearedCount: 0, ballsUsed: 0 }];
  let best = beam[0];

  for (let ball = 1; ball <= balls; ball++) {
    const children = [];
    const seen = new Set();
    for (let stateIndex = 0; stateIndex < beam.length; stateIndex++) {
      const state = beam[stateIndex];
      if (state.objectiveCount >= objectiveCount) {
        children.push(state);
        continue;
      }
      for (let angleIndex = 0; angleIndex < angles.length; angleIndex++) {
        const shot = sim.shoot(angles[angleIndex], {
          removed: state.removed,
          seed: `${seedPrefix}:${ball}:${stateIndex}:${angleIndex}`
        });
        shotsSimulated++;
        if (!shot.hitCount) continue;
        for (const id of shot.hits) {
          if (!firstHitBall.has(id) || firstHitBall.get(id) > ball) firstHitBall.set(id, ball);
        }
        const removed = new Set(state.removed);
        for (const id of shot.hits) removed.add(id);
        const signature = signatureOf(removed);
        if (seen.has(signature)) continue;
        seen.add(signature);
        children.push({
          removed,
          objectiveCount: countObjective(removed),
          clearedCount: removed.size,
          ballsUsed: ball,
          path: [...state.path, { ball, angleIndex, angle: round(angles[angleIndex], 5), hitCount: shot.hitCount }]
        });
      }
    }
    if (!children.length) break;
    children.sort((left, right) => (
      right.objectiveCount - left.objectiveCount
      || right.clearedCount - left.clearedCount
      || left.ballsUsed - right.ballsUsed
      || signatureOf(left.removed).localeCompare(signatureOf(right.removed))
    ));
    beam = children.slice(0, beamWidth);
    const leader = beam[0];
    if (leader.objectiveCount > best.objectiveCount
        || (leader.objectiveCount === best.objectiveCount && leader.clearedCount > best.clearedCount)) {
      best = leader;
    }
    if (best.objectiveCount >= objectiveCount) break;
  }

  const everHit = new Set(firstHitBall.keys());
  const neverHit = [...sim.targetIds].filter(id => !everHit.has(id)).sort();

  return {
    balls,
    beamWidth,
    angleCount: angles.length,
    shotsSimulated,
    objectiveCount,
    collectedCount: best.objectiveCount,
    collectedFraction: round(objectiveCount ? best.objectiveCount / objectiveCount : 0, 3),
    // Balls the search actually needed. Equal to the budget when it never
    // finished, so read it together with `complete`.
    ballsUsed: best.ballsUsed,
    complete: best.objectiveCount >= objectiveCount,
    bestClearedCount: best.clearedCount,
    bestClearedFraction: round(targetCount ? best.clearedCount / targetCount : 0, 3),
    bestPath: best.path,
    depth: [...firstHitBall.entries()]
      .map(([id, ball]) => ({ id, firstHitBall: ball }))
      .sort((left, right) => left.firstHitBall - right.firstHitBall || left.id.localeCompare(right.id)),
    neverHitIds: neverHit,
    neverHitFraction: round(targetCount ? neverHit.length / targetCount : 0, 3),
    caveats: [
      'Beam search is a play-strength probe, not a human player.',
      'Scoring, power-ups, free balls and perks are not simulated.',
      'Authored animation and motion rigs are frozen at their authored phase.'
    ]
  };
}

/** Clear-everything variant: the objective is every target. */
export function searchClear(sim, options = {}) {
  return searchCollect(sim, { ...options, objectiveIds: null });
}
