import { PHYSICS_CONFIG, getEffectiveBrickSize } from './physics.js';
import { Utils } from './utils.js';

export const DEEP_FREEZE_SHOTS_PER_USE = 1;

const BASE_STEP_SECONDS = 1 / 120;
const MAX_SLIDE_STEP_PX = 4;
const PEG_SLIDE_FRICTION = 0.9;
const PEG_SLIDE_WALL_BOUNCE = 0.28;
const PEG_STOP_SPEED = 0.08;
const PEG_MAX_SPEED = 16;
const BALL_IMPACT_SCALE = 0.72;
const BALL_IMPACT_MIN_SPEED = 2.4;
const SHOCKWAVE_BASE_SPEED = 8.5;
const SHOCKWAVE_SPEED_MULTIPLIER = 1.85;
const SHOCKWAVE_EDGE_SPEED = 2.5;
const CHAIN_RESTITUTION = 0.82;
const TANGENTIAL_DAMPING = 0.88;
const KINEMATIC_TANGENTIAL_BLEND = 0.35;

function isPortalPeg(peg) {
  return !!peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange');
}

function getPegSlideRadius(peg) {
  if (!peg) return PHYSICS_CONFIG.pegRadius;

  if (peg.shape === 'brick') {
    const { width, height } = getEffectiveBrickSize(peg);
    return Math.max(PHYSICS_CONFIG.pegRadius, Math.hypot(width, height) * 0.5);
  }

  if (peg.type === 'bumper') {
    return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
  }

  return PHYSICS_CONFIG.pegRadius;
}

function getBrickHalfSize(peg) {
  const { width, height } = getEffectiveBrickSize(peg);
  return { halfWidth: width * 0.5, halfHeight: height * 0.5 };
}

function getPegWallExtents(peg) {
  if (!peg || peg.shape !== 'brick') {
    const radius = getPegSlideRadius(peg);
    return { x: radius, y: radius };
  }

  const { halfWidth, halfHeight } = getBrickHalfSize(peg);
  const angle = peg.angle || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: Math.abs(cos) * halfWidth + Math.abs(sin) * halfHeight,
    y: Math.abs(sin) * halfWidth + Math.abs(cos) * halfHeight
  };
}

function getPegMass(peg) {
  if (!peg) return 1;
  if (peg.type === 'obstacle') return 1.45;
  if (peg.type === 'bumper') return peg.bumperDisappear || peg.bumperOrange ? 1.15 : 1.35;
  if (peg.shape === 'brick') return 1.2;
  return 1;
}

function getPairKey(a, b) {
  if (!a || !b) return '';
  return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}

function getMotionState(peg) {
  if (!peg) return null;
  if (!peg._deepFreezeMotion) {
    peg._deepFreezeMotion = {
      vx: 0,
      vy: 0,
      offsetX: 0,
      offsetY: 0,
      sourceBall: null,
      driveDx: 0,
      driveDy: 0,
      baseX: peg.x,
      baseY: peg.y
    };
  }
  return peg._deepFreezeMotion;
}

function clearMotionState(peg) {
  if (!peg) return;
  delete peg._deepFreezeMotion;
  delete peg._deepFreezeActive;
}

function getPegSpeed(peg) {
  const motion = peg?._deepFreezeMotion;
  if (!motion) return 0;
  return Utils.magnitude(motion.vx, motion.vy);
}

function clearAnimationDrive(peg) {
  const motion = peg?._deepFreezeMotion;
  if (!motion) return;
  motion.driveDx = 0;
  motion.driveDy = 0;
  motion.baseX = peg.x;
  motion.baseY = peg.y;
}

function getEffectiveMotionProfile(peg, stepScale = 1) {
  const motion = getMotionState(peg);
  const safeScale = Math.max(stepScale, 0.0001);
  const physicalSpeed = Utils.magnitude(motion.vx, motion.vy);
  const driveDistance = Utils.magnitude(motion.driveDx, motion.driveDy);

  if (driveDistance > 0.0001 && physicalSpeed <= PEG_STOP_SPEED) {
    return {
      motion,
      vx: motion.driveDx / safeScale,
      vy: motion.driveDy / safeScale,
      speed: driveDistance / safeScale,
      displacement: driveDistance,
      kinematic: true
    };
  }

  return {
    motion,
    vx: motion.vx,
    vy: motion.vy,
    speed: physicalSpeed,
    displacement: physicalSpeed * safeScale,
    kinematic: false
  };
}

function hasMeaningfulMotion(profile) {
  if (!profile) return false;
  if (profile.kinematic) return profile.displacement > 0.0001;
  return profile.speed > PEG_STOP_SPEED;
}

function clampMotion(motion, maxSpeed = PEG_MAX_SPEED) {
  if (!motion) return;
  const speed = Utils.magnitude(motion.vx, motion.vy);
  if (speed <= maxSpeed || speed <= 0.0001) return;
  const scale = maxSpeed / speed;
  motion.vx *= scale;
  motion.vy *= scale;
}

function normalizeVector(vx, vy, fallbackX = 1, fallbackY = 0) {
  const speed = Utils.magnitude(vx, vy);
  if (speed <= 0.0001) return { x: fallbackX, y: fallbackY, speed: 0 };
  return { x: vx / speed, y: vy / speed, speed };
}

function shiftPegPosition(peg, dx, dy, options = null) {
  if (!peg || (!dx && !dy)) return;
  const trackOffset = options?.trackOffset !== false;
  peg.x += dx;
  peg.y += dy;
  if (trackOffset && peg._deepFreezeMotion) {
    peg._deepFreezeMotion.offsetX += dx;
    peg._deepFreezeMotion.offsetY += dy;
  }
  if (peg.curveSlices) {
    for (const slice of peg.curveSlices) {
      slice.x += dx;
      slice.y += dy;
    }
  }
  peg._wrapCopies = null;
  peg._wrapHideMain = false;
}

function applyStoredOffset(peg) {
  const motion = peg?._deepFreezeMotion;
  if (!motion) return;
  if (Math.abs(motion.offsetX) <= 0.0001 && Math.abs(motion.offsetY) <= 0.0001) return;
  shiftPegPosition(peg, motion.offsetX, motion.offsetY, { trackOffset: false });
}

function getClosestAnimatedAnchor(peg, baseX, baseY) {
  if (!peg) return { x: 0, y: 0 };

  const candidates = [];
  const wrapCopies = Array.isArray(peg._wrapCopies) ? peg._wrapCopies : [];
  if (!peg._wrapHideMain || wrapCopies.length === 0) {
    candidates.push({ x: peg.x, y: peg.y });
  }
  for (const copy of wrapCopies) {
    if (!copy || !Number.isFinite(copy.x) || !Number.isFinite(copy.y)) continue;
    candidates.push({ x: copy.x, y: copy.y });
  }

  if (candidates.length === 0) {
    return { x: peg.x, y: peg.y };
  }

  let best = candidates[0];
  let bestDistSq = (best.x - baseX) * (best.x - baseX) + (best.y - baseY) * (best.y - baseY);
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const distSq = (candidate.x - baseX) * (candidate.x - baseX) + (candidate.y - baseY) * (candidate.y - baseY);
    if (distSq < bestDistSq) {
      best = candidate;
      bestDistSq = distSq;
    }
  }

  return best;
}

function applyWallBounce(peg, width, height) {
  if (!peg) return;
  const motion = getMotionState(peg);
  const extents = getPegWallExtents(peg);

  if (Number.isFinite(width) && width > 0) {
    if (peg.x - extents.x < 0) {
      shiftPegPosition(peg, extents.x - peg.x, 0);
      motion.vx = Math.abs(motion.vx) * PEG_SLIDE_WALL_BOUNCE;
    } else if (peg.x + extents.x > width) {
      shiftPegPosition(peg, width - extents.x - peg.x, 0);
      motion.vx = -Math.abs(motion.vx) * PEG_SLIDE_WALL_BOUNCE;
    }
  }

  if (Number.isFinite(height) && height > 0) {
    if (peg.y - extents.y < 0) {
      shiftPegPosition(peg, 0, extents.y - peg.y);
      motion.vy = Math.abs(motion.vy) * PEG_SLIDE_WALL_BOUNCE;
    } else if (peg.y + extents.y > height) {
      shiftPegPosition(peg, 0, height - extents.y - peg.y);
      motion.vy = -Math.abs(motion.vy) * PEG_SLIDE_WALL_BOUNCE;
    }
  }
}

function circleCircleOverlap(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const radiusA = getPegSlideRadius(a);
  const radiusB = getPegSlideRadius(b);
  const minDist = radiusA + radiusB;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return null;

  const dist = Math.sqrt(distSq);
  if (dist > 0.0001) {
    return {
      nx: dx / dist,
      ny: dy / dist,
      depth: minDist - dist
    };
  }

  return { nx: 1, ny: 0, depth: minDist };
}

function circleRectOverlap(circlePeg, rectPeg) {
  const angle = rectPeg.angle || 0;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = circlePeg.x - rectPeg.x;
  const dy = circlePeg.y - rectPeg.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  const { halfWidth, halfHeight } = getBrickHalfSize(rectPeg);
  const closestX = Utils.clamp(localX, -halfWidth, halfWidth);
  const closestY = Utils.clamp(localY, -halfHeight, halfHeight);
  const distX = localX - closestX;
  const distY = localY - closestY;
  const distSq = distX * distX + distY * distY;
  const radius = getPegSlideRadius(circlePeg);
  if (distSq >= radius * radius) return null;

  let normalLocalX;
  let normalLocalY;
  let depth;
  const dist = Math.sqrt(distSq);
  if (dist <= 0.0001) {
    const overlapX = halfWidth - Math.abs(localX);
    const overlapY = halfHeight - Math.abs(localY);
    if (overlapX < overlapY) {
      normalLocalX = localX >= 0 ? 1 : -1;
      normalLocalY = 0;
      depth = radius + overlapX;
    } else {
      normalLocalX = 0;
      normalLocalY = localY >= 0 ? 1 : -1;
      depth = radius + overlapY;
    }
  } else {
    normalLocalX = distX / dist;
    normalLocalY = distY / dist;
    depth = radius - dist;
  }

  const worldCos = Math.cos(angle);
  const worldSin = Math.sin(angle);
  const rectToCircleX = normalLocalX * worldCos - normalLocalY * worldSin;
  const rectToCircleY = normalLocalX * worldSin + normalLocalY * worldCos;
  return {
    nx: -rectToCircleX,
    ny: -rectToCircleY,
    depth
  };
}

function projectRectRadius(rectPeg, axisX, axisY) {
  const angle = rectPeg.angle || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const { halfWidth, halfHeight } = getBrickHalfSize(rectPeg);
  const ux = cos;
  const uy = sin;
  const vx = -sin;
  const vy = cos;
  return halfWidth * Math.abs(axisX * ux + axisY * uy)
    + halfHeight * Math.abs(axisX * vx + axisY * vy);
}

function rectRectOverlap(a, b) {
  const axes = [
    { x: Math.cos(a.angle || 0), y: Math.sin(a.angle || 0) },
    { x: -Math.sin(a.angle || 0), y: Math.cos(a.angle || 0) },
    { x: Math.cos(b.angle || 0), y: Math.sin(b.angle || 0) },
    { x: -Math.sin(b.angle || 0), y: Math.cos(b.angle || 0) }
  ];

  const centerDx = b.x - a.x;
  const centerDy = b.y - a.y;
  let bestAxis = null;
  let minOverlap = Infinity;

  for (const axis of axes) {
    const centerDistance = Math.abs(centerDx * axis.x + centerDy * axis.y);
    const radiusA = projectRectRadius(a, axis.x, axis.y);
    const radiusB = projectRectRadius(b, axis.x, axis.y);
    const overlap = radiusA + radiusB - centerDistance;
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      bestAxis = axis;
    }
  }

  if (!bestAxis) return null;
  const dot = centerDx * bestAxis.x + centerDy * bestAxis.y;
  const nx = dot >= 0 ? bestAxis.x : -bestAxis.x;
  const ny = dot >= 0 ? bestAxis.y : -bestAxis.y;
  return {
    nx,
    ny,
    depth: minOverlap
  };
}

function resolvePegOverlap(a, b) {
  if (!a || !b) return null;
  if (isPortalPeg(a) || isPortalPeg(b)) return null;

  if (a.shape === 'brick' && b.shape === 'brick') {
    return rectRectOverlap(a, b);
  }
  if (a.shape === 'brick') {
    const overlap = circleRectOverlap(b, a);
    return overlap ? { nx: -overlap.nx, ny: -overlap.ny, depth: overlap.depth } : null;
  }
  if (b.shape === 'brick') {
    return circleRectOverlap(a, b);
  }
  return circleCircleOverlap(a, b);
}

export class DeepFreezeSystem {
  constructor() {
    this.active = false;
    this.movedDuringShot = false;
    this.activePairs = new Set();
  }

  isActive() {
    return this.active;
  }

  startShot(pegs = []) {
    this.active = true;
    this.movedDuringShot = false;
    this.activePairs.clear();

    for (const peg of pegs) {
      clearMotionState(peg);
    }

    for (const peg of pegs) {
      if (!peg) continue;
      peg._deepFreezeActive = true;
      peg._wrapCopies = null;
      peg._wrapHideMain = false;
      const motion = getMotionState(peg);
      motion.vx = 0;
      motion.vy = 0;
      motion.offsetX = 0;
      motion.offsetY = 0;
      motion.sourceBall = null;
      motion.driveDx = 0;
      motion.driveDy = 0;
      motion.baseX = peg.x;
      motion.baseY = peg.y;
    }
  }

  finishShot(pegs = []) {
    const moved = this.movedDuringShot;
    this.active = false;
    this.movedDuringShot = false;
    this.activePairs.clear();

    for (const peg of pegs) {
      clearMotionState(peg);
    }

    return moved;
  }

  addImpactVelocity(peg, vx, vy, sourceBall = null) {
    if (!this.active || !peg || isPortalPeg(peg)) return false;

    const motion = getMotionState(peg);
    clearAnimationDrive(peg);
    const mass = getPegMass(peg);
    motion.vx += vx / mass;
    motion.vy += vy / mass;
    if (sourceBall) {
      motion.sourceBall = sourceBall;
    }
    clampMotion(motion);

    if (Utils.magnitude(motion.vx, motion.vy) > PEG_STOP_SPEED) {
      this.movedDuringShot = true;
      peg._deepFreezeActive = true;
    }
    return true;
  }

  applyBallImpact(peg, ball, impact = null) {
    if (!this.active || !peg || isPortalPeg(peg)) return false;

    const impactVx = Number.isFinite(impact?.vx) ? impact.vx : (ball?.vx || 0);
    const impactVy = Number.isFinite(impact?.vy) ? impact.vy : (ball?.vy || 0);
    const normalized = normalizeVector(impactVx, impactVy);
    const speed = Number.isFinite(impact?.speed) ? impact.speed : normalized.speed;
    if (speed <= 0.0001) return false;

    const impulseSpeed = Utils.clamp(speed * BALL_IMPACT_SCALE, BALL_IMPACT_MIN_SPEED, PEG_MAX_SPEED);
    return this.addImpactVelocity(
      peg,
      normalized.x * impulseSpeed,
      normalized.y * impulseSpeed,
      ball || null
    );
  }

  applyShockwaveTargets(targets, centerX, centerY, radius, sourceBall = null, options = null) {
    if (!this.active || !Array.isArray(targets) || targets.length === 0) return 0;

    const speedMultiplier = Number.isFinite(options?.speedMultiplier)
      ? Math.max(0.1, options.speedMultiplier)
      : SHOCKWAVE_SPEED_MULTIPLIER;

    let pushed = 0;
    for (const peg of targets) {
      if (!peg || isPortalPeg(peg)) continue;

      const dx = peg.x - centerX;
      const dy = peg.y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = Math.max(1, radius + getPegSlideRadius(peg));
      const normalized = dist > 0.0001
        ? { x: dx / dist, y: dy / dist }
        : normalizeVector(sourceBall?.vx || 1, sourceBall?.vy || 0);
      const falloff = 1 - Utils.clamp(dist / reach, 0, 1);
      const impulseSpeed = SHOCKWAVE_EDGE_SPEED + (SHOCKWAVE_BASE_SPEED * speedMultiplier - SHOCKWAVE_EDGE_SPEED) * falloff;
      if (this.addImpactVelocity(peg, normalized.x * impulseSpeed, normalized.y * impulseSpeed, sourceBall)) {
        pushed++;
      }
    }

    return pushed;
  }

  syncPegPositions(pegs = [], animatedPegIds = null) {
    if (!this.active || !Array.isArray(pegs) || pegs.length === 0) return;
    const animatedSet = animatedPegIds instanceof Set ? animatedPegIds : null;
    for (const peg of pegs) {
      if (!peg || isPortalPeg(peg)) continue;
      const motion = getMotionState(peg);
      motion.driveDx = 0;
      motion.driveDy = 0;

      if (animatedSet && animatedSet.has(peg.id)) {
        const anchor = getClosestAnimatedAnchor(peg, motion.baseX, motion.baseY);
        motion.driveDx = anchor.x - motion.baseX;
        motion.driveDy = anchor.y - motion.baseY;
        motion.baseX = anchor.x;
        motion.baseY = anchor.y;
        applyStoredOffset(peg);
        continue;
      }

      motion.baseX = peg.x;
      motion.baseY = peg.y;
    }
  }

  step(pegs = [], dtSeconds = BASE_STEP_SECONDS, bounds = null) {
    if (!this.active || !Array.isArray(pegs) || pegs.length === 0) return [];

    const timeScale = Number.isFinite(PHYSICS_CONFIG.timeScale) ? PHYSICS_CONFIG.timeScale : 1;
    const safeDt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : BASE_STEP_SECONDS;
    const stepScale = Math.max(0.1, (safeDt / BASE_STEP_SECONDS) * timeScale);
    let maxMove = 0;
    let hasDynamicPeg = false;

    for (const peg of pegs) {
      if (!peg || isPortalPeg(peg)) continue;
      const profile = getEffectiveMotionProfile(peg, stepScale);
      if (!hasMeaningfulMotion(profile)) continue;
      hasDynamicPeg = true;
      maxMove = Math.max(maxMove, profile.displacement);
    }

    if (!hasDynamicPeg) {
      this.activePairs.clear();
      return [];
    }

    const subSteps = Math.max(1, Math.ceil(maxMove / MAX_SLIDE_STEP_PX));
    const subScale = stepScale / subSteps;
    const framePairs = new Set();
    const chainEvents = [];
    const chainedPairKeys = new Set();

    for (let step = 0; step < subSteps; step++) {
      for (const peg of pegs) {
        if (isPortalPeg(peg)) continue;
        const profile = getEffectiveMotionProfile(peg, stepScale);
        if (profile.kinematic || profile.speed <= PEG_STOP_SPEED) continue;
        const motion = profile.motion;
        shiftPegPosition(peg, motion.vx * subScale, motion.vy * subScale);
        applyWallBounce(peg, bounds?.width, bounds?.height);
      }

      const dynamicIndices = [];
      const isDynamic = new Array(pegs.length).fill(false);
      for (let i = 0; i < pegs.length; i++) {
        const peg = pegs[i];
        if (!peg || isPortalPeg(peg)) continue;
        const profile = getEffectiveMotionProfile(peg, stepScale);
        if (!hasMeaningfulMotion(profile)) continue;
        dynamicIndices.push(i);
        isDynamic[i] = true;
      }

      if (dynamicIndices.length === 0) {
        continue;
      }

      for (const i of dynamicIndices) {
        const a = pegs[i];
        if (!a) continue;

        for (let j = 0; j < pegs.length; j++) {
          if (j === i) continue;
          if (isDynamic[j] && j < i) continue;
          const b = pegs[j];
          if (!b || isPortalPeg(b)) continue;

          const overlap = resolvePegOverlap(a, b);
          if (!overlap) continue;

          const pairKey = getPairKey(a, b);
          framePairs.add(pairKey);
          const event = this.resolvePegCollision(a, b, overlap, stepScale);
          if (event && !this.activePairs.has(pairKey) && !chainedPairKeys.has(pairKey)) {
            chainedPairKeys.add(pairKey);
            chainEvents.push({
              ...event,
              pairKey
            });
          }
        }
      }
    }

    const frictionScale = Math.pow(PEG_SLIDE_FRICTION, stepScale);
    for (const peg of pegs) {
      if (isPortalPeg(peg)) continue;
      const motion = peg._deepFreezeMotion;
      if (!motion) continue;
      motion.vx *= frictionScale;
      motion.vy *= frictionScale;
      if (Utils.magnitude(motion.vx, motion.vy) <= PEG_STOP_SPEED) {
        motion.vx = 0;
        motion.vy = 0;
        motion.sourceBall = null;
      }
    }

    this.activePairs = framePairs;
    return chainEvents;
  }

  resolvePegCollision(a, b, overlap, stepScale = 1) {
    const profileA = getEffectiveMotionProfile(a, stepScale);
    const profileB = getEffectiveMotionProfile(b, stepScale);
    const motionA = profileA.motion;
    const motionB = profileB.motion;
    const massA = getPegMass(a);
    const massB = getPegMass(b);
    const totalMass = massA + massB;
    const nx = overlap.nx;
    const ny = overlap.ny;
    const tx = -ny;
    const ty = nx;

    if (profileA.kinematic && profileB.kinematic) {
      return null;
    }

    const vaN = profileA.vx * nx + profileA.vy * ny;
    const vbN = profileB.vx * nx + profileB.vy * ny;
    const vaT = profileA.vx * tx + profileA.vy * ty;
    const vbT = profileB.vx * tx + profileB.vy * ty;
    const relNormal = vbN - vaN;

    if (profileA.kinematic !== profileB.kinematic) {
      const drivingPeg = profileA.kinematic ? a : b;
      const impactedPeg = profileA.kinematic ? b : a;
      const drivingProfile = profileA.kinematic ? profileA : profileB;
      const impactedProfile = profileA.kinematic ? profileB : profileA;
      const targetMotion = impactedProfile.motion;
      const normalX = profileA.kinematic ? nx : -nx;
      const normalY = profileA.kinematic ? ny : -ny;
      const tangentX = -normalY;
      const tangentY = normalX;

      shiftPegPosition(impactedPeg, normalX * overlap.depth, normalY * overlap.depth);
      clearAnimationDrive(impactedPeg);

      const sourceNormal = drivingProfile.vx * normalX + drivingProfile.vy * normalY;
      const sourceTangent = drivingProfile.vx * tangentX + drivingProfile.vy * tangentY;
      const targetNormal = targetMotion.vx * normalX + targetMotion.vy * normalY;
      const targetTangent = targetMotion.vx * tangentX + targetMotion.vy * tangentY;
      const closingSpeed = sourceNormal - targetNormal;

      if (closingSpeed > 0) {
        const nextTargetNormal = targetNormal + closingSpeed * CHAIN_RESTITUTION;
        const nextTargetTangent = targetTangent + (sourceTangent - targetTangent) * KINEMATIC_TANGENTIAL_BLEND;
        targetMotion.vx = tangentX * nextTargetTangent + normalX * nextTargetNormal;
        targetMotion.vy = tangentY * nextTargetTangent + normalY * nextTargetNormal;
        clampMotion(targetMotion);
      }

      if (!targetMotion.sourceBall && drivingProfile.motion.sourceBall) {
        targetMotion.sourceBall = drivingProfile.motion.sourceBall;
      }

      if (!hasMeaningfulMotion(drivingProfile) && getPegSpeed(impactedPeg) <= PEG_STOP_SPEED) {
        return null;
      }

      this.movedDuringShot = true;
      return {
        sourcePeg: drivingPeg,
        targetPeg: impactedPeg,
        sourceBall: drivingProfile.motion.sourceBall || targetMotion.sourceBall || null,
        suspendSource: false
      };
    }

    if (profileA.kinematic) {
      clearAnimationDrive(a);
    }
    if (profileB.kinematic) {
      clearAnimationDrive(b);
    }

    const sepA = overlap.depth * (massB / totalMass);
    const sepB = overlap.depth * (massA / totalMass);
    shiftPegPosition(a, -nx * sepA, -ny * sepA);
    shiftPegPosition(b, nx * sepB, ny * sepB);

    const resolvedVaN = motionA.vx * nx + motionA.vy * ny;
    const resolvedVbN = motionB.vx * nx + motionB.vy * ny;
    const resolvedVaT = motionA.vx * tx + motionA.vy * ty;
    const resolvedVbT = motionB.vx * tx + motionB.vy * ty;
    const resolvedRelNormal = resolvedVbN - resolvedVaN;

    if (resolvedRelNormal < 0) {
      const nextVaN = (
        resolvedVaN * (massA - CHAIN_RESTITUTION * massB) +
        resolvedVbN * (1 + CHAIN_RESTITUTION) * massB
      ) / totalMass;
      const nextVbN = (
        resolvedVbN * (massB - CHAIN_RESTITUTION * massA) +
        resolvedVaN * (1 + CHAIN_RESTITUTION) * massA
      ) / totalMass;

      motionA.vx = tx * (resolvedVaT * TANGENTIAL_DAMPING) + nx * nextVaN;
      motionA.vy = ty * (resolvedVaT * TANGENTIAL_DAMPING) + ny * nextVaN;
      motionB.vx = tx * (resolvedVbT * TANGENTIAL_DAMPING) + nx * nextVbN;
      motionB.vy = ty * (resolvedVbT * TANGENTIAL_DAMPING) + ny * nextVbN;
      clampMotion(motionA);
      clampMotion(motionB);
    }

    const speedA = Utils.magnitude(motionA.vx, motionA.vy);
    const speedB = Utils.magnitude(motionB.vx, motionB.vy);
    if (speedA <= PEG_STOP_SPEED && speedB <= PEG_STOP_SPEED) {
      return null;
    }

    let sourcePeg = a;
    let targetPeg = b;
    if (speedB > speedA) {
      sourcePeg = b;
      targetPeg = a;
    }

    const sourceMotion = sourcePeg === a ? motionA : motionB;
    const sourceSpeed = sourcePeg === a ? speedA : speedB;
    if (sourceSpeed <= PEG_STOP_SPEED) return null;

    if (!targetPeg._deepFreezeMotion?.sourceBall && sourceMotion.sourceBall) {
      getMotionState(targetPeg).sourceBall = sourceMotion.sourceBall;
    }

    this.movedDuringShot = true;
    return {
      sourcePeg,
      targetPeg,
      sourceBall: sourceMotion.sourceBall || null,
      suspendSource: true
    };
  }
}
