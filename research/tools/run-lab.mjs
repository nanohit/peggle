#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ball, PHYSICS_CONFIG, PhysicsEngine } from '../../js/physics.js';
import { cloneResearchValue, makeResearchRunRecord, researchLevelDigestPayload } from '../../js/research-format.js';
import { readJson, sha256Value, writeJson } from './lib/node-io.mjs';
import { validateResearchRecord } from './validate-record.mjs';

const GAME_REVISION = '6201ec1120f7dbadecf76a6e40710bb9bacab915';
const TOOL_VERSION = '0.1.0';

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function createSeededRandom(seed) {
  let state = Number.parseInt(sha256Value(String(seed)).slice(0, 8), 16) >>> 0;
  return function mulberry32() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function objectToNativePeg(object, pegRadius) {
  const transform = object.transform || {};
  const geometry = object.geometry || {};
  const source = object.source?.raw || {};
  const type = object.kind === 'portal'
    ? (object.targetType || (object.portal?.channel === 'orange' ? 'portalOrange' : 'portalBlue'))
    : (object.targetType || (object.role === 'obstacle' ? 'obstacle' : 'blue'));
  if (object.kind === 'segment' || object.kind === 'rod') {
    const x1 = finite(geometry.x1, transform.x);
    const y1 = finite(geometry.y1, transform.y);
    const x2 = finite(geometry.x2, transform.x);
    const y2 = finite(geometry.y2, transform.y);
    return {
      id: object.id,
      type,
      shape: 'brick',
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      angle: Math.atan2(y2 - y1, x2 - x1),
      width: Math.hypot(x2 - x1, y2 - y1),
      height: finite(geometry.thickness, pegRadius * 1.2)
    };
  }
  if (!['circle', 'brick', 'bumper', 'portal'].includes(object.kind)) return null;
  const peg = {
    ...cloneResearchValue(source),
    id: object.id,
    type,
    shape: object.kind === 'brick' ? 'brick' : 'circle',
    x: finite(transform.x),
    y: finite(transform.y),
    angle: finite(transform.rotation),
    ...(cloneResearchValue(object.properties || {}))
  };
  if (peg.shape === 'brick') {
    peg.width = finite(geometry.width, 34);
    peg.height = finite(geometry.height, pegRadius * 1.2);
    if (Array.isArray(geometry.curveSlices) && geometry.curveSlices.length > 0) {
      peg.curveSlices = cloneResearchValue(geometry.curveSlices);
    }
  }
  if (object.kind === 'portal') {
    peg.type = String(type);
    peg.portalScale = finite(object.portal?.scale, finite(peg.portalScale, 1));
    peg.portalOneWay = !!object.portal?.oneWay;
    peg.portalOneWayFlip = object.portal?.oneWayFlip !== false;
    if (object.portal?.destinationId) peg.portalDestinationId = object.portal.destinationId;
  }
  if (object.kind === 'bumper') peg.type = 'bumper';
  return peg;
}

function mechanicalState(engine, pegs, ball, hitIds) {
  return {
    balls: ball && ball.active ? [{
      id: ball.id,
      active: ball.active,
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      radius: ball.radius,
      stuck: ball.stuck,
      portalCooldown: ball.portalCooldown
    }] : [],
    bucket: {
      enabled: engine.bucketEnabled,
      x: engine.bucket.x,
      y: engine.bucket.y,
      width: engine.bucket.width,
      height: engine.bucket.height,
      speed: engine.bucket.speed,
      phase: engine.bucket._phase
    },
    hitObjectIds: [...hitIds].sort(),
    objects: pegs.map(peg => ({
      id: peg.id,
      type: peg.type,
      x: peg.x,
      y: peg.y,
      angle: finite(peg.angle),
      hit: hitIds.has(peg.id)
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
}

function makeCheckpoint(step, fixedStepSeconds, state) {
  return {
    step,
    timeSeconds: step * fixedStepSeconds,
    sha256: sha256Value(state),
    state
  };
}

export async function runHeadlessLab(levelRecord, options = {}) {
  const validation = validateResearchRecord(levelRecord);
  if (!validation.valid || levelRecord.recordType !== 'level') {
    throw new Error(`Invalid level record: ${validation.errors.join('; ') || 'recordType is not level'}`);
  }
  const bounds = levelRecord.authored.coordinateSystem.bounds;
  const width = bounds.maxX - bounds.minX;
  const height = levelRecord.authored.coordinateSystem.viewport?.height || (bounds.maxY - bounds.minY);
  const mechanics = levelRecord.authored.mechanics || {};
  const pegRadius = finite(mechanics.pegRadius, 8.5);
  const fixedStepSeconds = finite(options.fixedStepSeconds, 1 / 120);
  const angle = finite(options.angle, Math.PI / 2);
  const power = finite(options.power, 7.5);
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps || 7200));
  const checkpointEvery = Math.max(1, Math.trunc(options.checkpointEvery || 60));
  const physicsConfig = {
    gravity: finite(options.physicsConfig?.gravity, 0.12),
    friction: finite(options.physicsConfig?.friction, 0.998),
    bounce: finite(options.physicsConfig?.bounce, 0.65),
    pegRadius,
    maxVelocity: finite(options.physicsConfig?.maxVelocity, 16),
    launchPower: power,
    timeScale: finite(options.physicsConfig?.timeScale, 1),
    brickWidth: finite(options.physicsConfig?.brickWidth, 34),
    brickHeight: finite(options.physicsConfig?.brickHeight, 10.2)
  };
  const previousPhysics = { ...PHYSICS_CONFIG };
  Object.assign(PHYSICS_CONFIG, physicsConfig);
  try {
    const unsupported = [];
    const pegs = [];
    for (const object of levelRecord.authored.objects) {
      const peg = objectToNativePeg(object, pegRadius);
      if (peg) pegs.push(peg);
      else unsupported.push(`${object.id}:${object.kind}`);
    }
    const seed = String(options.seed || '0');
    const engine = new PhysicsEngine(width, height, { random: createSeededRandom(seed) });
    engine.setPegs(pegs);
    engine.setBucketEnabled(mechanics.bucket?.enabled !== false);
    engine.setBallTopY(bounds.minY);
    engine.setBallLossY(bounds.maxY + 50);
    const launcher = mechanics.launcher || { x: width / 2, y: 40 };
    const ball = new Ball(finite(launcher.x, width / 2), finite(launcher.y, 40));
    ball.id = 'ball:shot:0';
    engine.setBall(ball);
    ball.launch(angle, power);

    const levelDigest = sha256Value(researchLevelDigestPayload(levelRecord));
    const events = [{
      sequence: 0,
      step: 0,
      timeSeconds: 0,
      type: 'shot_launched',
      data: { angleRadians: angle, power, launcher: { x: ball.x, y: ball.y } },
      mechanical: { ball: { id: ball.id, x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy } }
    }];
    const hitIds = new Set();
    const checkpoints = [makeCheckpoint(0, fixedStepSeconds, mechanicalState(engine, pegs, ball, hitIds))];
    let sequence = 1;
    let bucketCatches = 0;
    let finalStep = 0;
    for (let step = 1; step <= maxSteps; step++) {
      finalStep = step;
      const result = engine.update(fixedStepSeconds);
      const seenThisStep = new Set();
      for (const event of result.hitEvents) {
        const pegId = String(event?.peg?.id ?? '');
        const key = `${pegId}:${event.portalHit ? 'portal' : (event.isBumper ? 'bumper' : 'hit')}`;
        if (!pegId || seenThisStep.has(key)) continue;
        seenThisStep.add(key);
        if (!event.portalHit && !event.obstacleHit && !event.bumperAnimOnly) hitIds.add(pegId);
        events.push({
          sequence: sequence++,
          step,
          timeSeconds: step * fixedStepSeconds,
          type: event.portalHit ? 'portal_crossed' : (event.isBumper ? 'bumper_hit' : (event.obstacleHit ? 'obstacle_hit' : 'peg_hit')),
          data: {
            objectId: pegId,
            objectType: event.peg?.type ?? null,
            exitId: event.portalExit?.id ?? null,
            impact: cloneResearchValue(event.impact || null)
          },
          mechanical: {
            ball: { id: ball.id, x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy }
          }
        });
      }
      if (result.bucketCatchCount > 0) {
        bucketCatches += result.bucketCatchCount;
        events.push({
          sequence: sequence++,
          step,
          timeSeconds: step * fixedStepSeconds,
          type: 'bucket_catch',
          data: { count: result.bucketCatchCount }
        });
      }
      if (step % checkpointEvery === 0 || result.ballsRemaining === 0) {
        checkpoints.push(makeCheckpoint(step, fixedStepSeconds, mechanicalState(engine, pegs, ball, hitIds)));
      }
      if (result.ballsRemaining === 0) break;
    }
    if (checkpoints[checkpoints.length - 1]?.step !== finalStep) {
      checkpoints.push(makeCheckpoint(finalStep, fixedStepSeconds, mechanicalState(engine, pegs, ball, hitIds)));
    }
    events.push({
      sequence: sequence++,
      step: finalStep,
      timeSeconds: finalStep * fixedStepSeconds,
      type: 'shot_finished',
      data: { hitCount: hitIds.size, bucketCatches, active: ball.active }
    });

    const runKey = sha256Value({ levelDigest, angle, power, physicsConfig, fixedStepSeconds, seed });
    return makeResearchRunRecord({
      id: `run:headless-lab:${runKey.slice(0, 24)}`,
      provenance: {
        source: { system: 'nanohit-peggle-headless-lab', revision: GAME_REVISION },
        ingestion: {
          tool: 'run-lab.mjs',
          toolVersion: TOOL_VERSION,
          toolRevision: GAME_REVISION,
          at: options.at || new Date().toISOString()
        }
      },
      levelRef: { id: levelRecord.id, sha256: levelDigest },
      reproduction: {
        capability: 'subset-deterministic',
        game: { id: 'nanohit-peggle-physics-engine', revision: GAME_REVISION },
        tool: { id: 'headless-research-lab', version: TOOL_VERSION, revision: GAME_REVISION },
        fixedStepSeconds,
        physicsConfig,
        seed: {
          algorithm: 'mulberry32-from-sha256-prefix',
          master: seed,
          streams: { mechanics: seed },
          unseededStreams: []
        },
        inputs: [{ sequence: 0, step: 0, type: 'launch', data: { angleRadians: angle, power, launcher } }],
        platform: { runtime: 'node', adapter: 'PhysicsEngine-only' },
        floatPolicy: { storage: 'IEEE-754 JSON numbers', checkpointComparison: 'exact-canonical-json' }
      },
      events,
      checkpoints,
      measurements: {
        hitCount: hitIds.size,
        hitObjectIds: [...hitIds].sort(),
        bucketCatches,
        simulatedSteps: finalStep,
        simulatedSeconds: finalStep * fixedStepSeconds
      },
      extensions: {
        unsupportedObjects: unsupported,
        supportedSubset: ['circle', 'brick', 'segment', 'rod', 'bumper', 'portal', 'bucket'],
        labOptions: { maxSteps, checkpointEvery }
      },
      warnings: unsupported.length > 0 ? [`Skipped unsupported objects: ${unsupported.join(', ')}`] : [],
      losses: unsupported.length > 0 ? ['Unsupported object kinds were not simulated.'] : []
    });
  } finally {
    Object.assign(PHYSICS_CONFIG, previousPhysics);
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) options[key] = true;
    else { options[key] = next; index++; }
  }
  return { positional, options };
}

async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath) {
    console.error('Usage: node research/tools/run-lab.mjs <level.json> <run.json> [--angle radians] [--power n] [--steps n] [--seed value]');
    process.exitCode = 2;
    return;
  }
  const levelRecord = await readJson(inputPath);
  const run = await runHeadlessLab(levelRecord, {
    angle: options.angle == null ? undefined : Number(options.angle),
    power: options.power == null ? undefined : Number(options.power),
    maxSteps: options.steps == null ? undefined : Number(options.steps),
    checkpointEvery: options['checkpoint-every'] == null ? undefined : Number(options['checkpoint-every']),
    seed: options.seed
  });
  await writeJson(outputPath, run);
  console.log(`wrote ${outputPath} (${run.measurements.hitCount} hits, ${run.measurements.simulatedSteps} steps)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
