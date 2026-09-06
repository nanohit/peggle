// Lean shot simulator.
//
// `run-lab.mjs` is the auditable single-shot path: it validates the record,
// records every event, and hashes checkpoints. That machinery costs far more
// than the physics itself, which makes it unusable for the thousands of shots a
// search needs. This module runs the same `PhysicsEngine` on the same converted
// pegs and returns only what a search consumes.
//
// It is a strict subset of the game, and the omissions are load-bearing:
//   - authored animation and Peggle motion rigs do not move;
//   - power-ups, perks, free balls, and scoring do not exist;
//   - a shot ends when the ball leaves play or the step budget runs out.
// Reachability derived from it is a sampled lower bound, never a proof.

import { Ball, PHYSICS_CONFIG, PhysicsEngine } from '../../../js/physics.js';
import { objectToNativePeg } from '../../tools/run-lab.mjs';
import { sha256Value } from '../../tools/lib/node-io.mjs';

const DEFAULT_POWER = 7.5;
const DEFAULT_MAX_STEPS = 2400;
const FIXED_STEP_SECONDS = 1 / 120;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function createSeededRandom(seed) {
  let state = Number.parseInt(sha256Value(String(seed)).slice(0, 8), 16) >>> 0;
  return function mulberry32() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a reusable simulator for one level. The physics globals are patched for
 * the lifetime of the simulator and restored by `dispose()`, so a batch pays
 * that cost once instead of per shot.
 */
export function createSimulator(levelRecord, options = {}) {
  const bounds = levelRecord.authored.coordinateSystem.bounds;
  const width = finite(bounds.maxX) - finite(bounds.minX);
  const height = finite(levelRecord.authored.coordinateSystem.viewport?.height, finite(bounds.maxY) - finite(bounds.minY));
  const mechanics = levelRecord.authored.mechanics || {};
  const pegRadius = finite(mechanics.pegRadius, 8.5);
  const power = finite(options.power, DEFAULT_POWER);
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps || DEFAULT_MAX_STEPS));
  // Alea records carry an explicit launcher; PeggleEdit records carry the
  // playfield launch axis instead, and that axis is x=327, not the frame centre.
  const launcher = mechanics.launcher || {};
  const launchX = finite(launcher.x, finite(mechanics.launchAxis?.x, width / 2));
  const launchY = finite(launcher.y, 40);

  const allPegs = [];
  const unsupported = [];
  for (const object of levelRecord.authored.objects) {
    const peg = objectToNativePeg(object, pegRadius);
    if (peg) allPegs.push(peg);
    else unsupported.push(`${object.id}:${object.kind}`);
  }
  const targetIds = new Set(
    levelRecord.authored.objects.filter(object => object.role === 'target').map(object => String(object.id))
  );
  const movingIds = new Set(
    levelRecord.authored.objects
      .filter(object => object.movement?.Movement || object.source?.raw?.groupId)
      .map(object => String(object.id))
  );

  const savedPhysics = { ...PHYSICS_CONFIG };
  Object.assign(PHYSICS_CONFIG, {
    gravity: finite(options.gravity, 0.12),
    friction: finite(options.friction, 0.998),
    bounce: finite(options.bounce, 0.65),
    pegRadius,
    maxVelocity: finite(options.maxVelocity, 16),
    launchPower: power,
    timeScale: 1,
    brickWidth: finite(options.brickWidth, 34),
    brickHeight: finite(options.brickHeight, 10.2)
  });

  let shotCount = 0;

  /**
   * One shot from the launcher at `angle`. `removed` names pegs already cleared
   * in earlier turns; hit pegs are NOT removed mid-shot, matching Peggle, so
   * cascades off a peg that is about to clear still happen.
   */
  function shoot(angle, shotOptions = {}) {
    const removed = shotOptions.removed instanceof Set ? shotOptions.removed : new Set(shotOptions.removed || []);
    const pegs = removed.size ? allPegs.filter(peg => !removed.has(String(peg.id))) : allPegs;
    const engine = new PhysicsEngine(width, height, { random: createSeededRandom(shotOptions.seed ?? 'shot') });
    engine.setPegs(pegs.map(peg => ({ ...peg })));
    engine.setBucketEnabled(mechanics.bucket?.enabled !== false);
    engine.setBallTopY(finite(bounds.minY));
    engine.setBallLossY(finite(bounds.maxY) + 50);
    // The bucket oscillates continuously in a real game, so its phase at launch
    // is part of the shot, not a constant.
    if (engine.bucket && Number.isFinite(Number(shotOptions.bucketPhase))) {
      engine.bucket._phase = Number(shotOptions.bucketPhase);
    }

    const ball = new Ball(launchX, launchY);
    ball.id = `ball:${shotCount++}`;
    engine.setBall(ball);
    ball.launch(angle, power);

    const hits = new Set();
    let bucketCatches = 0;
    let steps = 0;
    for (let step = 1; step <= maxSteps; step++) {
      steps = step;
      const result = engine.update(FIXED_STEP_SECONDS);
      for (const event of result.hitEvents) {
        if (event.portalHit || event.obstacleHit || event.bumperAnimOnly) continue;
        const id = String(event?.peg?.id ?? '');
        if (id) hits.add(id);
      }
      if (result.bucketCatchCount > 0) bucketCatches += result.bucketCatchCount;
      if (result.ballsRemaining === 0) break;
    }
    const targetHits = [...hits].filter(id => targetIds.has(id));
    return {
      angle,
      hits: targetHits.sort(),
      hitCount: targetHits.length,
      bucketCatches,
      steps,
      timedOut: steps >= maxSteps && ball.active
    };
  }

  return {
    shoot,
    dispose() { Object.assign(PHYSICS_CONFIG, savedPhysics); },
    info: {
      width,
      height,
      launcher: { x: launchX, y: launchY },
      power,
      maxSteps,
      pegRadius,
      targetCount: targetIds.size,
      pegCount: allPegs.length,
      unsupported,
      // Levels whose objects are driven by a rig or an animated group are only
      // simulated in their authored phase.
      staticallySimulatedMovingObjects: movingIds.size
    },
    targetIds,
    allPegs
  };
}

export const SIM_CONSTANTS = { FIXED_STEP_SECONDS, DEFAULT_POWER, DEFAULT_MAX_STEPS };
