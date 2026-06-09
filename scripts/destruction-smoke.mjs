import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DestructionPegSystem } from '../js/destruction-mode.js';
import { PhysicsEngine, PHYSICS_CONFIG } from '../js/physics.js';
import { YoyoThreadSystem } from '../js/yoyo-thread.js';

const BOUNDS = {
  width: 480,
  height: 640,
  topY: 0,
  lossY: 720,
  bucketEnabled: true,
  bucket: { x: 240, y: 600, width: 92, height: 18 }
};

function makeSystem(settings = {}) {
  return new DestructionPegSystem({
    enabled: true,
    gravityX: 0,
    gravityY: 0.115,
    damping: 0.994,
    restitution: 0.34,
    friction: 0.72,
    maxSpeed: 14,
    sleepSpeed: 0.055,
    sleepFrames: 8,
    bombImpulse: 12,
    ...settings
  });
}

function circle(id, x, y, props = {}) {
  return {
    id,
    x,
    y,
    type: 'orange',
    shape: 'circle',
    ...props
  };
}

function brick(id, x, y, props = {}) {
  return {
    id,
    x,
    y,
    type: 'orange',
    shape: 'brick',
    width: 42,
    height: 10,
    angle: 0,
    ...props
  };
}

function curvedBrick(id, x, y, props = {}) {
  const width = props.width ?? 48;
  const height = props.height ?? 10;
  const half = width * 0.5;
  const slices = [
    { x: x - half, y: y - 2, nx: 0, ny: 1 },
    { x: x, y: y + 4, nx: -0.12, ny: 0.993 },
    { x: x + half, y: y - 1, nx: 0, ny: 1 }
  ];
  return brick(id, x, y, {
    width,
    height,
    curveSlices: slices,
    ...props
  });
}

function awakeBodies(system) {
  let count = 0;
  for (const body of system.bodies.values()) {
    if (!body.static && !body.sleeping) count++;
  }
  return count;
}

function stepMany(system, pegs, groups, frames, bounds = BOUNDS) {
  let last = null;
  for (let i = 0; i < frames; i++) {
    last = system.step(pegs, groups, 1 / 120, bounds);
  }
  return last;
}

function testStaticWorldSkipsBroadphase() {
  const pegs = [];
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 20; col++) {
      pegs.push(circle(`s-${row}-${col}`, 40 + col * 18, 40 + row * 18, {
        type: 'obstacle',
        destructionStatic: true
      }));
    }
  }
  const system = makeSystem();
  system.reset(pegs, []);
  const beforeBuilds = system.debugStats.colliderBuilds;
  stepMany(system, pegs, [], 30);
  assert.equal(system.debugStats.colliderBuilds, beforeBuilds);
  assert.ok(system.debugStats.skippedSteps >= 30);
}

function testPhysicsOnHitSleepsUntilImpact() {
  const pegs = [circle('wake', 160, 120, { destructionPhysicsOnHit: true })];
  const system = makeSystem();
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  assert.equal(body.sleeping, true);
  const startX = pegs[0].x;
  const startY = pegs[0].y;
  stepMany(system, pegs, [], 20);
  assert.equal(pegs[0].x, startX);
  assert.equal(pegs[0].y, startY);

  const woke = system.applyBallImpact(pegs[0], { x: 130, y: 120, vx: 7, vy: 0 }, { vx: 7, vy: 0, speed: 7 });
  assert.equal(woke, true);
  assert.equal(body.sleeping, false);
  stepMany(system, pegs, [], 8);
  assert.ok(pegs[0].x > startX + 0.2);
}

async function testLevelManagerPreservesMagnetBlastOnAdd() {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
    clear() {}
  };
  try {
    const { LevelManager } = await import('../js/levels.js');
    const manager = new LevelManager();
    manager.createLevel('magnet-copy');
    const peg = manager.addPeg({
      type: 'bombMagnet',
      shape: 'circle',
      x: 120,
      y: 140,
      magnetBlast: true,
      magnetExplosionPower: 2
    });
    assert.equal(peg.magnetBlast, true);
    assert.equal(peg.magnetExplosionPower, 2);
  } finally {
    if (previousStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
  }
}

function testAttachedMagnetSleeperStaysAsleep() {
  const magnet = circle('magnet', 120, 120, {
    type: 'bombMagnet',
    destructionStatic: true,
    magnetRadius: 120,
    magnetStrength: 0.5,
    magnetMode: 'attract'
  });
  const peg = circle('settled', 134, 120);
  const pegs = [magnet, peg];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(peg);
  system.markBodyMagnetAttachment(body, magnet);
  body.sleeping = true;
  body.vx = 0;
  body.vy = 0;
  system.applyMagnetForces(pegs, 1);
  assert.equal(body.sleeping, true);
  assert.equal(body.vx, 0);
  assert.equal(body.vy, 0);
}

function testStackedBricksSettleWithoutDrift() {
  const pegs = [
    brick('floor', 200, 230, { type: 'obstacle', destructionStatic: true, width: 120, height: 12 }),
    brick('bottom', 200, 219, { width: 56, height: 10 }),
    brick('top', 200, 208, { width: 56, height: 10 })
  ];
  const system = makeSystem({ sleepFrames: 4, restitution: 0.18 });
  system.reset(pegs, []);
  stepMany(system, pegs, [], 240);
  assert.ok(Math.abs(pegs[1].x - 200) < 2.5);
  assert.ok(Math.abs(pegs[2].x - 200) < 3.5);
  assert.ok(pegs[1].y < 235);
  assert.ok(pegs[2].y < 225);
}

function testGroupPreservesOffsets() {
  const pegs = [
    circle('g-a', 120, 140, { groupId: 'tower' }),
    circle('g-b', 150, 140, { groupId: 'tower' })
  ];
  const groups = [{ id: 'tower', destructionBody: true }];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, groups);
  const beforeDistance = Math.hypot(pegs[1].x - pegs[0].x, pegs[1].y - pegs[0].y);
  system.applyBallImpact(pegs[0], { x: 90, y: 140, vx: 3, vy: 0 }, { vx: 3, vy: 0, speed: 3 });
  stepMany(system, pegs, groups, 30);
  const afterDistance = Math.hypot(pegs[1].x - pegs[0].x, pegs[1].y - pegs[0].y);
  assert.ok(Math.abs(afterDistance - beforeDistance) < 0.001);
}

function testGroupCenterOfMassRecomputesAfterRemoval() {
  let pegs = [
    circle('com-a', 140, 160, { groupId: 'beam' }),
    circle('com-b', 160, 160, { groupId: 'beam' }),
    circle('com-c', 180, 160, { groupId: 'beam' }),
    circle('com-d', 200, 160, { groupId: 'beam' }),
    circle('com-e', 220, 160, { groupId: 'beam' })
  ];
  const groups = [{ id: 'beam', destructionBody: true }];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, groups);

  pegs = pegs.filter(peg => peg.id !== 'com-d' && peg.id !== 'com-e');
  system.markStructureDirty();
  system.syncBodies(pegs, groups);

  const body = system.getBodyForPeg(pegs[0]);
  assert.ok(Math.abs(body.x - 160) < 0.001);
  assert.equal(pegs[0].x, 140);
  assert.equal(pegs[2].x, 180);
}

function testUnbalancedGroupTopplesTowardRemainingMass() {
  let pegs = [];
  const beamXs = [115, 132, 149, 166, 183, 200, 217, 234, 251, 268, 285];
  for (let i = 0; i < beamXs.length; i++) {
    pegs.push(circle(`topple-${i}`, beamXs[i], 180, { groupId: 'topple-beam' }));
  }
  pegs.push(brick('topple-support', 200, 198, {
    type: 'obstacle',
    destructionStatic: true,
    width: 12,
    height: 35
  }));
  const groups = [{ id: 'topple-beam', destructionBody: true }];
  const system = makeSystem({ restitution: 0.08 });
  system.reset(pegs, groups);
  stepMany(system, pegs, groups, 120, { ...BOUNDS, bucketEnabled: false });

  pegs = pegs.filter(peg => !['topple-7', 'topple-8', 'topple-9', 'topple-10'].includes(peg.id));
  system.markStructureDirty();
  system.syncBodies(pegs, groups);
  const body = system.getBodyForPeg(pegs[0]);
  assert.ok(Math.abs(body.x - 166) < 0.001);

  system.wakeDynamicBodies();
  stepMany(system, pegs, groups, 24, { ...BOUNDS, bucketEnabled: false });

  const beam = pegs.filter(peg => peg.groupId === 'topple-beam');
  assert.ok(body.angle < -0.12);
  assert.ok(beam[0].y > beam[beam.length - 1].y + 8);
}

function testBrickWakeSpinUsesRealLeverArm() {
  const centerHit = brick('center-hit', 200, 200, { width: 60, height: 12 });
  const centerSystem = makeSystem({ gravityY: 0, damping: 1 });
  centerSystem.reset([centerHit], []);
  const centerBody = centerSystem.getBodyForPeg(centerHit);
  assert.equal(
    centerSystem.applyBallImpact(centerHit, { x: 170, y: 200, vx: 6, vy: 0 }, { vx: 6, vy: 0, speed: 6 }),
    true
  );
  assert.equal(centerBody.av, 0);

  const offCenterHit = brick('off-center-hit', 200, 200, { width: 60, height: 12 });
  const offCenterSystem = makeSystem({ gravityY: 0, damping: 1 });
  offCenterSystem.reset([offCenterHit], []);
  const offCenterBody = offCenterSystem.getBodyForPeg(offCenterHit);
  offCenterSystem.applyBallImpact(offCenterHit, { x: 185, y: 194, vx: 0, vy: 6 }, { vx: 0, vy: 6, speed: 6 });
  assert.ok(offCenterBody.av < -0.03);
}

function testRestingCurvedBrickStackDoesNotTopple() {
  const pegs = [
    brick('curve-floor', 200, 248, {
      type: 'obstacle',
      destructionStatic: true,
      width: 180,
      height: 12
    }),
    curvedBrick('curve-bottom', 200, 234, { width: 90, height: 10 }),
    curvedBrick('curve-top', 200, 220, { width: 90, height: 10 })
  ];
  const system = makeSystem({ restitution: 0.08 });
  system.reset(pegs, []);
  const bottom = system.getBodyForPeg(pegs[1]);
  const top = system.getBodyForPeg(pegs[2]);
  stepMany(system, pegs, [], 420, { ...BOUNDS, bucketEnabled: false });

  assert.ok(Math.abs(pegs[1].x - 200) < 2);
  assert.ok(Math.abs(pegs[2].x - 200) < 3);
  assert.ok(Math.abs(pegs[1].angle || 0) < 0.03);
  assert.ok(Math.abs(pegs[2].angle || 0) < 0.04);
  assert.equal(bottom.sleeping, true);
  assert.equal(top.sleeping, true);
}

function testCurvedBrickSlicesMoveWithBody() {
  const pegs = [curvedBrick('curve', 180, 140)];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  const startPegX = pegs[0].x;
  const startSliceX = pegs[0].curveSlices[0].x;
  body.sleeping = false;
  body.vx = 3;
  stepMany(system, pegs, [], 12, { ...BOUNDS, bucketEnabled: false });
  const pegDx = pegs[0].x - startPegX;
  const sliceDx = pegs[0].curveSlices[0].x - startSliceX;
  assert.ok(pegDx > 0.25);
  assert.ok(Math.abs(sliceDx - pegDx) < 0.001);
}

function testGroupedCurvedBrickSlicesMoveWithBody() {
  const pegs = [
    curvedBrick('curve-a', 160, 140, { groupId: 'curve-group' }),
    curvedBrick('curve-b', 215, 140, { groupId: 'curve-group' })
  ];
  const groups = [{ id: 'curve-group', destructionBody: true }];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, groups);
  const body = system.getBodyForPeg(pegs[0]);
  const startA = pegs[0].curveSlices[0].x;
  const startB = pegs[1].curveSlices[0].x;
  body.sleeping = false;
  body.vx = 3;
  stepMany(system, pegs, groups, 12, { ...BOUNDS, bucketEnabled: false });
  assert.ok(pegs[0].curveSlices[0].x > startA + 0.2);
  assert.ok(pegs[1].curveSlices[0].x > startB + 0.2);
  assert.ok(Math.abs((pegs[1].curveSlices[0].x - pegs[0].curveSlices[0].x) - (startB - startA)) < 0.001);
}

function testNormalPhysicsHitsCurvedBrickRibbon() {
  const peg = curvedBrick('curve-physics', 110, 110, {
    curveSlices: [
      { x: 220, y: 220, nx: 0, ny: 1 },
      { x: 260, y: 230, nx: -0.24, ny: 0.971 },
      { x: 300, y: 220, nx: 0, ny: 1 }
    ]
  });
  const physics = new PhysicsEngine(480, 640);
  physics.setPegs([peg]);
  physics._buildPegGrid();
  const candidates = physics._getPegCandidateIndices({
    x: 260,
    y: 230,
    radius: PHYSICS_CONFIG.pegRadius
  });
  assert.deepEqual(candidates, [0]);
  const hit = physics._detectPegCollision({
    x: 260,
    y: 230,
    vx: 0,
    vy: 0,
    radius: PHYSICS_CONFIG.pegRadius
  }, peg);
  assert.ok(hit?.collision);
  const invisibleCenterHit = physics._detectPegCollision({
    x: peg.x,
    y: peg.y,
    vx: 0,
    vy: 0,
    radius: PHYSICS_CONFIG.pegRadius
  }, peg);
  assert.equal(invisibleCenterHit, null);
}

function testBucketVelocitySurvivesSubsteps() {
  const pegs = [circle('falling', 108, 128)];
  const system = makeSystem({ gravityY: 0, restitution: 0.45 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.sleeping = false;
  body.vy = 12;
  system._lastBucketX = 120;
  const boundsB = { ...BOUNDS, bucket: { x: 150, y: 140, width: 90, height: 18 } };
  const beforeBuilds = system.debugStats.colliderBuilds;
  system.step(pegs, [], 1 / 120, boundsB);
  assert.equal(system.debugStats.colliderBuilds - beforeBuilds, 1);
  assert.ok(body.vx > 0.15);
}

function testBucketCenterIsOpen() {
  const pegs = [circle('center-fall', 240, 584)];
  const system = makeSystem({ gravityY: 0, restitution: 0.45 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.sleeping = false;
  body.vy = 8;
  system.step(pegs, [], 1 / 120, BOUNDS);
  assert.ok(Math.abs(body.vx) < 0.05);
  assert.ok(body.vy > 7.5);
  assert.ok(pegs[0].y > 584);
}

function testBombWakeBudgetDrains() {
  const pegs = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 10; col++) {
      pegs.push(circle(`bomb-${row}-${col}`, 96 + col * 32, 160 + row * 32, {
        destructionPhysicsOnHit: true
      }));
    }
  }
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const immediate = system.applyShockwaveTargets(pegs, 240, 240, 260, null, 12);
  assert.equal(immediate, 24);
  assert.equal(awakeBodies(system), 24);
  assert.equal(system.getPendingWakeCount(), 36);
  system.step(pegs, [], 1 / 120, BOUNDS);
  assert.equal(awakeBodies(system), 48);
  assert.equal(system.getPendingWakeCount(), 12);
  system.step(pegs, [], 1 / 120, BOUNDS);
  assert.equal(system.getPendingWakeCount(), 0);
}

function testPhysicsOnHitBallOnlyIgnoresPegAndBomb() {
  const target = circle('ball-only', 180, 160, {
    destructionPhysicsOnHit: true,
    destructionPhysicsOnHitBallOnly: true
  });
  const hitter = circle('hitter', 180, 132);
  const pegs = [target, hitter];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const targetBody = system.getBodyForPeg(target);
  const hitterBody = system.getBodyForPeg(hitter);
  assert.equal(targetBody.sleeping, true);

  hitterBody.sleeping = false;
  hitterBody.vy = 5;
  stepMany(system, pegs, [], 20, { ...BOUNDS, bucketEnabled: false });
  assert.equal(targetBody.sleeping, true);

  const shockwaveCount = system.applyShockwaveTargets([target], 180, 160, 100, null, 12);
  assert.equal(shockwaveCount, 0);
  assert.equal(targetBody.sleeping, true);

  const woke = system.applyBallImpact(target, { x: 160, y: 160, vx: 6, vy: 0 }, { vx: 6, vy: 0, speed: 6 });
  assert.equal(woke, true);
  assert.equal(targetBody.sleeping, false);
}

function testWakeOnHitRefreshBecomesDynamic() {
  const pegs = [circle('toggle', 180, 140, { destructionPhysicsOnHit: true })];
  const system = makeSystem();
  system.reset(pegs, []);
  let body = system.getBodyForPeg(pegs[0]);
  assert.equal(body.wakeOnHit, true);
  assert.equal(body.sleeping, true);

  pegs[0].destructionPhysicsOnHit = false;
  system.markStructureDirty();
  system.syncBodies(pegs, []);
  body = system.getBodyForPeg(pegs[0]);
  assert.equal(body.wakeOnHit, false);
  assert.equal(body.sleeping, false);
}

function testLowGripSlidesOnSlopeMoreThanHighGrip() {
  const run = (surfaceGrip) => {
    const pegs = [
      brick('slope', 220, 220, {
        type: 'obstacle',
        destructionStatic: true,
        width: 180,
        height: 12,
        angle: 0.32
      }),
      circle('slider', 220, 198)
    ];
    const system = makeSystem({ surfaceGrip, restitution: 0.08, sleepFrames: 12 });
    system.reset(pegs, []);
    stepMany(system, pegs, [], 260, { ...BOUNDS, bucketEnabled: false });
    return pegs[1].x;
  };

  const lowGripX = run(0);
  const highGripX = run(1);
  assert.ok(Math.abs(lowGripX - 220) > Math.abs(highGripX - 220) + 4);
}

function testDefaultGripRowSlidesOnStaticSlope() {
  const pegs = [
    brick('slope', 240, 260, {
      type: 'obstacle',
      destructionStatic: true,
      width: 300,
      height: 12,
      angle: -0.28
    })
  ];
  for (let i = 0; i < 16; i++) {
    pegs.push(circle(`row-${i}`, 120 + i * 17, 229 - i * 4.9));
  }

  const startX = pegs.slice(1).map(peg => peg.x);
  const system = makeSystem({ surfaceGrip: 0.18, restitution: 0.08 });
  system.reset(pegs, []);
  stepMany(system, pegs, [], 360, { ...BOUNDS, bucketEnabled: false });
  const averageDx = pegs
    .slice(1)
    .reduce((sum, peg, index) => sum + (peg.x - startX[index]), 0) / startX.length;

  assert.ok(averageDx < -18);
  assert.ok(awakeBodies(system) > 0);
}

function testSlopedSleeperRequestsFixedStepAndWakes() {
  const pegs = [
    brick('slope', 220, 220, {
      type: 'obstacle',
      destructionStatic: true,
      width: 180,
      height: 12,
      angle: -0.28
    }),
    circle('sleeper', 220, 198)
  ];
  const system = makeSystem({ surfaceGrip: 0.18, restitution: 0.08 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[1]);
  body.sleeping = true;
  body.staticSupportMemory = 8;
  body.staticSupportDot = Math.cos(0.28);

  assert.equal(system.needsFixedStep(), true);
  system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
  assert.equal(body.sleeping, false);
}

function testSleeperOnDynamicSupportWakesWhenSupportMoves() {
  const pegs = [
    circle('support-body', 220, 220),
    circle('upper-body', 220, 202)
  ];
  const system = makeSystem({ gravityY: 0, restitution: 0.08 });
  system.reset(pegs, []);
  const support = system.getBodyForPeg(pegs[0]);
  const upper = system.getBodyForPeg(pegs[1]);

  support.sleeping = false;
  support.vy = 3;
  upper.sleeping = true;
  upper.dynamicSupportBodyId = support.id;
  upper.dynamicSupportMemory = 8;

  assert.equal(system.needsFixedStep(), true);
  system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
  assert.equal(upper.sleeping, false);
}

function testBallGetsDestructionSurfaceSlideAssist() {
  const physics = new PhysicsEngine(480, 640);
  physics.setDestructionContactSettings({ enabled: true, surfaceGrip: 0.15 });
  const angle = 0.34;
  const ball = {
    x: 200,
    y: 200,
    vx: 0,
    vy: 0,
    radius: PHYSICS_CONFIG.pegRadius,
    stuck: true,
    stuckFrames: 30
  };
  const normal = { x: -Math.sin(angle), y: -Math.cos(angle) };
  const slide = physics.getDestructionSurfaceSlide(ball, normal, { id: 'slope', type: 'obstacle' });
  assert.ok(slide);
  physics.applyDestructionSurfaceSlide(ball, slide);
  assert.ok(Math.hypot(ball.vx, ball.vy) > 0.01);
  assert.equal(ball.stuck, false);
}

function testHardBallImpactKeepsBounceOnAwakeDestructionPeg() {
  const physics = new PhysicsEngine(480, 640);
  physics.setDestructionContactSettings({ enabled: true, surfaceGrip: 0.15, dynamicPegBallBounce: 0.45 });
  const ball = {
    x: 200,
    y: 200,
    vx: 0,
    vy: 5,
    radius: PHYSICS_CONFIG.pegRadius,
    stuck: false,
    stuckFrames: 0
  };
  const peg = circle('awake-surface', 200, 218, {
    type: 'orange',
    _destructionAwake: true
  });

  physics.resolveCollision(ball, {
    normal: { x: 0, y: -1 },
    depth: 1,
    relativeVelocityNormal: -5
  }, peg);

  assert.ok(ball.vy < -2);
}

function testDynamicPegBallBounceSettingTunesImpactBounce() {
  const run = (dynamicPegBallBounce) => {
    const physics = new PhysicsEngine(480, 640);
    physics.setDestructionContactSettings({ enabled: true, surfaceGrip: 0.15, dynamicPegBallBounce });
    const ball = {
      x: 200,
      y: 200,
      vx: 0,
      vy: 5,
      radius: PHYSICS_CONFIG.pegRadius,
      stuck: false,
      stuckFrames: 0
    };
    const peg = circle('awake-surface', 200, 218, {
      type: 'orange',
      _destructionAwake: true
    });

    physics.resolveCollision(ball, {
      normal: { x: 0, y: -1 },
      depth: 1,
      relativeVelocityNormal: -5
    }, peg);
    return ball.vy;
  };

  const softBounceVy = run(0.15);
  const hardBounceVy = run(0.95);
  assert.ok(hardBounceVy < softBounceVy - 2.8);
}

function testFlipperKinematicWakesDestructionBody() {
  const pegs = [circle('flip-target', 180, 180, { destructionPhysicsOnHit: true })];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  assert.equal(body.sleeping, true);

  system.step(pegs, [], 1 / 120, {
    ...BOUNDS,
    bucketEnabled: false,
    flipperRects: [{
      x: 180,
      y: 180,
      angle: 0,
      width: 80,
      height: 10,
      vx: 0,
      vy: -9
    }]
  });

  assert.equal(body.sleeping, false);
  assert.ok(body.vy < -0.1);
}

function testAnimatedStaticBodyActsAsKinematicCollider() {
  const animated = circle('anim-platform', 100, 180, {
    type: 'obstacle',
    destructionStatic: true
  });
  const sleeper = circle('anim-target', 125, 180, { destructionPhysicsOnHit: true });
  const pegs = [animated, sleeper];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const targetBody = system.getBodyForPeg(sleeper);
  assert.equal(targetBody.sleeping, true);

  animated.x = 116;
  assert.equal(system.syncAnimatedBodies(new Set(['anim-platform']), 1 / 120), true);
  assert.equal(system.needsFixedStep(), true);
  system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });

  assert.equal(targetBody.sleeping, false);
  assert.ok(targetBody.vx > 0.1);
}

function testAnimatedBodyDetachesAfterPhysicsWake() {
  const peg = circle('anim-wake', 100, 120, { destructionPhysicsOnHit: true });
  const pegs = [peg];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(peg);

  peg.x = 112;
  system.syncAnimatedBodies(new Set(['anim-wake']), 1 / 120);
  assert.equal(body.kinematic, true);
  assert.equal(body.x, 112);

  assert.equal(
    system.applyBallImpact(peg, { x: 80, y: 120, vx: 7, vy: 0 }, { vx: 7, vy: 0, speed: 7 }),
    true
  );
  assert.equal(body.animationDetached, true);
  const physicsX = body.x;
  peg.x = 180;
  system.syncAnimatedBodies(new Set(['anim-wake']), 1 / 120);
  assert.equal(body.x, physicsX);
  assert.ok(system.getPhysicsOwnedPegIds().includes('anim-wake'));
}

function testNestedAnimatedGroupsDoNotDetach() {
  // Two animated physics-on-hit bodies overlapping like concentric rings. The outer one
  // orbits with real linear velocity (as from an offset Origin/pivot) while overlapping
  // the inner — exactly what used to trip wakeSleepingBodyFromKinematic and knock the
  // inner ring into physics. Neither may detach from the contact; only a ball/blast can.
  const inner = circle('ring-inner', 150, 180, { destructionPhysicsOnHit: true });
  const outer = circle('ring-outer', 160, 180, { destructionPhysicsOnHit: true });
  const pegs = [inner, outer];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const innerBody = system.getBodyForPeg(inner);
  const outerBody = system.getBodyForPeg(outer);
  assert.equal(innerBody.sleeping, true);
  assert.equal(outerBody.sleeping, true);

  const animated = new Set(['ring-inner', 'ring-outer']);
  for (let i = 0; i < 40; i++) {
    outer.x = 160 + Math.sin(i * 0.7) * 5;
    outer.y = 180 + Math.cos(i * 0.7) * 5;
    system.syncAnimatedBodies(animated, 1 / 120);
    system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
    assert.equal(innerBody.animationDetached, false, `inner detached on frame ${i}`);
    assert.equal(outerBody.animationDetached, false, `outer detached on frame ${i}`);
    assert.equal(innerBody.kinematic, true, `inner left animation on frame ${i}`);
  }
  assert.equal(innerBody.sleeping, true);
  assert.equal(outerBody.sleeping, true);

  // A genuine ball hit still hands the inner ring over to physics.
  assert.equal(
    system.applyBallImpact(inner, { x: 120, y: 180, vx: 8, vy: 0 }, { vx: 8, vy: 0, speed: 8 }),
    true
  );
  assert.equal(innerBody.animationDetached, true);
}

function testActiveDebrisWakesAnimatedPhysicsOnHit() {
  // An animated (kinematic) physics-on-hit body must STILL wake when a real, active
  // (non-kinematic) body — e.g. a peg the ball knocked loose — falls onto it. The nested-
  // animated-group guard lives only in wakeSleepingBodyFromKinematic, so this generic
  // dynamic-vs-kinematic contact (via maybeWakeSleepingCollisionBody) is unaffected.
  const target = circle('anim-target', 150, 200, { destructionPhysicsOnHit: true });
  const debris = circle('debris', 150, 172, { destructionPhysicsOnHit: true });
  const pegs = [target, debris];
  const system = makeSystem({ gravityY: 0.2 });
  system.reset(pegs, []);
  const targetBody = system.getBodyForPeg(target);
  const debrisBody = system.getBodyForPeg(debris);

  // Ball knocks the debris loose; it falls onto the animated target below it.
  assert.equal(
    system.applyBallImpact(debris, { x: 150, y: 158, vx: 0, vy: 7 }, { vx: 0, vy: 7, speed: 7 }),
    true
  );
  assert.equal(debrisBody.animationDetached, true);

  // Keep the target animation-owned (kinematic, parked in place) every frame.
  const animatedSet = new Set(['anim-target']);
  let woke = false;
  for (let i = 0; i < 40 && !woke; i++) {
    system.syncAnimatedBodies(animatedSet, 1 / 120);
    assert.equal(targetBody.kinematic || targetBody.animationDetached, true);
    system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
    woke = targetBody.animationDetached === true;
  }
  assert.equal(woke, true, 'falling debris should hand the animated body to physics');
  assert.equal(targetBody.kinematic, false);
}

function testDestructionBodyTeleportsThroughPortal() {
  const mover = circle('portal-body', 120, 90);
  const blue = {
    id: 'portal-blue',
    x: 120,
    y: 110,
    type: 'portalBlue',
    shape: 'circle',
    angle: 0,
    portalScale: 3,
    portalOneWay: false,
    portalOneWayFlip: true
  };
  const orange = {
    id: 'portal-orange',
    x: 300,
    y: 150,
    type: 'portalOrange',
    shape: 'circle',
    angle: 0,
    portalScale: 3,
    portalOneWay: false,
    portalOneWayFlip: true
  };
  const pegs = [mover, blue, orange];
  const system = makeSystem({ gravityY: 0, damping: 1 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(mover);
  body.vy = 24;

  const result = system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
  assert.equal(result.portalHits.length, 1);
  assert.equal(result.portalHits[0].entry.id, 'portal-blue');
  assert.equal(result.portalHits[0].exit.id, 'portal-orange');
  assert.ok(Math.abs(mover.x - 300) < 4);
  assert.ok(mover.y > 150);
  assert.ok(body.portalCooldown > 0);
}

function testYoyoConstrainedAtWallsDuringRetraction() {
  const yoyo = new YoyoThreadSystem(480, 640, {
    enabled: true,
    triggerDropRatio: 0.5,
    retractSpeed: 600
  });
  const ball = {
    id: 'yoyo-wall',
    active: true,
    yoyoEligible: true,
    x: -45,
    y: 520,
    vx: -10,
    vy: 6,
    radius: PHYSICS_CONFIG.pegRadius,
    speedCapBoost: 0
  };

  yoyo.setLaunchAnchor(240, 40);
  yoyo.registerBallLaunch(ball, 240, 40);
  for (let i = 0; i < 12; i++) {
    yoyo.step([ball], [], 1 / 60, { retractStartY: 430 });
  }
  assert.ok(ball.x >= ball.radius - 0.001);
  const threads = yoyo.getRenderThreads();
  for (const thread of threads) {
    for (let i = 0; i < thread.pointCount; i++) {
      assert.ok(thread.points[i * 2] >= -0.001);
    }
  }
}

function testRemovalWakesSleepingDynamicSupportDependents() {
  const pegs = [
    brick('support', 220, 232, {
      type: 'obstacle',
      destructionStatic: true,
      width: 120,
      height: 12
    }),
    brick('top', 220, 218, {
      width: 52,
      height: 10
    })
  ];
  const system = makeSystem({ gravityY: 0.115 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[1]);
  body.sleeping = true;
  body.sleepFrames = 0;

  pegs.splice(0, 1);
  system.markStructureDirty();
  system.syncBodies(pegs, []);
  const woke = system.wakeDynamicBodies();

  assert.equal(woke, 1);
  assert.equal(body.sleeping, false);
}

function testDestructionBodyHitReportsBumperEvent() {
  const pegs = [
    circle('falling', 220, 168),
    circle('bumper', 220, 180, {
      type: 'bumper',
      destructionStatic: true,
      bumperDisappear: true,
      bumperBounce: 1.4
    })
  ];
  const system = makeSystem({ gravityY: 0, restitution: 0.15 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.sleeping = false;
  body.vy = 4;

  const result = system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
  assert.equal(result.bumperHits.length, 1);
  assert.equal(result.bumperHits[0].peg.id, 'bumper');
  assert.ok(body.vy < 0);
}

function testGroupFracturesIntoRuntimePieces() {
  const pegs = [
    circle('fa', 140, 140, { groupId: 'breakable' }),
    circle('fb', 166, 140, { groupId: 'breakable' }),
    circle('fc', 192, 140, { groupId: 'breakable' }),
    circle('fd', 218, 140, { groupId: 'breakable' })
  ];
  const groups = [{ id: 'breakable', destructionBody: true }];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, groups);
  const body = system.getBodyForPeg(pegs[0]);
  assert.equal(system.bodies.size, 1);
  assert.equal(system.queueBodyFracture(body, 180, 140, 9, 1, 0), true);
  system.step(pegs, groups, 1 / 120, { ...BOUNDS, bucketEnabled: false });
  const bodyIds = new Set(pegs.map(peg => system.getBodyForPeg(peg)?.id));
  assert.ok(bodyIds.size > 1);
  assert.ok([...bodyIds].every(id => id?.startsWith('split:')));
}

function testFractureRebuildPreservesOtherFallingBody() {
  const pegs = [
    circle('u1', 120, 120, { groupId: 'upper', destructionPhysicsOnHit: true }),
    circle('u2', 146, 120, { groupId: 'upper', destructionPhysicsOnHit: true }),
    circle('l1', 260, 220, { groupId: 'lower' }),
    circle('l2', 286, 220, { groupId: 'lower' }),
    circle('l3', 312, 220, { groupId: 'lower' }),
    circle('l4', 338, 220, { groupId: 'lower' })
  ];
  const groups = [
    { id: 'upper', destructionBody: true },
    { id: 'lower', destructionBody: true }
  ];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, groups);
  const upper = system.getBodyForPeg(pegs[0]);
  const lower = system.getBodyForPeg(pegs[2]);

  upper.sleeping = false;
  upper.wakeOnHitConsumed = true;
  upper.vy = 3.4;
  upper.av = 0.02;

  assert.equal(system.queueBodyFracture(lower, 286, 220, 9, 1, 0), true);
  system.step(pegs, groups, 1 / 120, { ...BOUNDS, bucketEnabled: false });

  const restoredUpper = system.getBodyForPeg(pegs[0]);
  assert.equal(restoredUpper.id, 'group:upper');
  assert.equal(restoredUpper.sleeping, false);
  assert.equal(restoredUpper.wakeOnHitConsumed, true);
  assert.ok(restoredUpper.vy > 3);
  assert.ok(Math.abs(restoredUpper.av) > 0.01);
}

function testColliderBuildsOnceAcrossSubsteps() {
  const pegs = [circle('fast', 220, 180)];
  const system = makeSystem({ gravityY: 0, maxSpeed: 14 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.sleeping = false;
  body.vy = 14;

  const before = system.debugStats.colliderBuilds;
  system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
  const builds = system.debugStats.colliderBuilds - before;
  assert.equal(builds, 1);
}

function testRuntimeFlagsAndAabbCacheSurviveForceRebuild() {
  const pegs = [circle('runtime', 220, 180)];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);

  pegs[0]._destructionFalling = true;
  pegs[0]._destructionAwake = true;
  pegs[0]._destructionAabbCache = { sentinel: true };
  system.markStructureDirty();
  system.syncBodies(pegs, [], { forceRebuild: true });

  assert.equal(pegs[0]._destructionFalling, true);
  assert.equal(pegs[0]._destructionAwake, true);
  assert.equal(pegs[0]._destructionAabbCache.sentinel, true);
}

function testColliderPoolClearsStalePegReferences() {
  const pegs = [
    circle('a', 220, 180),
    circle('b', 250, 180)
  ];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  for (const peg of pegs) {
    const body = system.getBodyForPeg(peg);
    body.sleeping = false;
  }
  system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });
  assert.ok(system._colliders.some(collider => collider?.peg === pegs[1]));

  pegs.pop();
  system.markStructureDirty();
  system.syncBodies(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.sleeping = false;
  system.step(pegs, [], 1 / 120, { ...BOUNDS, bucketEnabled: false });

  for (let i = system._colliderCount; i < system._colliders.length; i++) {
    const collider = system._colliders[i];
    assert.equal(collider.peg, null);
    assert.equal(collider.body, null);
    assert.equal(collider._bodyRef, null);
  }

  system.reset([], []);
  assert.equal(system._colliders.length, 0);
  assert.equal(system._colliderCount, 0);
}

function testNeedsFixedStepUsesCachedRuntimeCounters() {
  const pegs = [circle('cached', 220, 180)];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.sleeping = true;
  system._pendingFallenCheck = false;
  system.markRuntimeCountersDirty();

  assert.equal(system.needsFixedStep(), false);
  const rebuilt = system.debugStats.runtimeCounterRebuilds;
  for (let i = 0; i < 20; i++) {
    assert.equal(system.needsFixedStep(), false);
  }
  assert.equal(system.debugStats.runtimeCounterRebuilds, rebuilt);

  body.sleeping = false;
  system.markRuntimeCountersDirty();
  assert.equal(system.needsFixedStep(), true);
  assert.equal(system.debugStats.runtimeCounterRebuilds, rebuilt + 1);
  for (let i = 0; i < 20; i++) {
    assert.equal(system.needsFixedStep(), true);
  }
  assert.equal(system.debugStats.runtimeCounterRebuilds, rebuilt + 1);
}

function testFallenOrangeIsReported() {
  const pegs = [circle('orange-fallen', 220, 500)];
  const system = makeSystem();
  system.reset(pegs, []);
  const result = system.step(pegs, [], 1 / 120, { ...BOUNDS, lossY: 400 });
  assert.equal(result.fallenPegs.length, 1);
  assert.equal(result.fallenPegs[0].peg.id, 'orange-fallen');
}

function testAngleStaysBounded() {
  const pegs = [brick('spin', 220, 180)];
  const system = makeSystem({ gravityY: 0 });
  system.reset(pegs, []);
  const body = system.getBodyForPeg(pegs[0]);
  body.av = 0.13;
  body.sleeping = false;
  stepMany(system, pegs, [], 1200, { ...BOUNDS, bucketEnabled: false });
  assert.ok(Math.abs(body.angle) <= Math.PI);
  assert.ok(Math.abs(pegs[0].angle) <= Math.PI);
}

function benchStaticSkip() {
  const pegs = [];
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 20; col++) {
      pegs.push(circle(`bench-${row}-${col}`, 36 + col * 19, 36 + row * 19, {
        type: 'obstacle',
        destructionStatic: true
      }));
    }
  }
  const system = makeSystem();
  system.reset(pegs, []);
  stepMany(system, pegs, [], 20);
  const start = performance.now();
  stepMany(system, pegs, [], 240);
  const average = (performance.now() - start) / 240;
  return average;
}

const tests = [
  testStaticWorldSkipsBroadphase,
  testPhysicsOnHitSleepsUntilImpact,
  testLevelManagerPreservesMagnetBlastOnAdd,
  testAttachedMagnetSleeperStaysAsleep,
  testStackedBricksSettleWithoutDrift,
  testGroupPreservesOffsets,
  testGroupCenterOfMassRecomputesAfterRemoval,
  testUnbalancedGroupTopplesTowardRemainingMass,
  testBrickWakeSpinUsesRealLeverArm,
  testRestingCurvedBrickStackDoesNotTopple,
  testCurvedBrickSlicesMoveWithBody,
  testGroupedCurvedBrickSlicesMoveWithBody,
  testNormalPhysicsHitsCurvedBrickRibbon,
  testBucketVelocitySurvivesSubsteps,
  testBucketCenterIsOpen,
  testBombWakeBudgetDrains,
  testPhysicsOnHitBallOnlyIgnoresPegAndBomb,
  testWakeOnHitRefreshBecomesDynamic,
  testLowGripSlidesOnSlopeMoreThanHighGrip,
  testDefaultGripRowSlidesOnStaticSlope,
  testSlopedSleeperRequestsFixedStepAndWakes,
  testSleeperOnDynamicSupportWakesWhenSupportMoves,
  testBallGetsDestructionSurfaceSlideAssist,
  testHardBallImpactKeepsBounceOnAwakeDestructionPeg,
  testDynamicPegBallBounceSettingTunesImpactBounce,
  testFlipperKinematicWakesDestructionBody,
  testAnimatedStaticBodyActsAsKinematicCollider,
  testAnimatedBodyDetachesAfterPhysicsWake,
  testNestedAnimatedGroupsDoNotDetach,
  testActiveDebrisWakesAnimatedPhysicsOnHit,
  testDestructionBodyTeleportsThroughPortal,
  testYoyoConstrainedAtWallsDuringRetraction,
  testRemovalWakesSleepingDynamicSupportDependents,
  testDestructionBodyHitReportsBumperEvent,
  testGroupFracturesIntoRuntimePieces,
  testFractureRebuildPreservesOtherFallingBody,
  testColliderBuildsOnceAcrossSubsteps,
  testRuntimeFlagsAndAabbCacheSurviveForceRebuild,
  testColliderPoolClearsStalePegReferences,
  testNeedsFixedStepUsesCachedRuntimeCounters,
  testFallenOrangeIsReported,
  testAngleStaysBounded
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}

const staticAverage = benchStaticSkip();
console.log(`static-skip-average-ms ${staticAverage.toFixed(4)}`);
