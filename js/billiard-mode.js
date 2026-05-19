import { PHYSICS_CONFIG } from './physics.js';
import { Utils } from './utils.js';
import { isPortalType } from './portal-defaults.js';

export const BILLIARD_RED = 'billiardRed';
export const BILLIARD_YELLOW = 'billiardYellow';
export const BILLIARD_BALL_TYPES = new Set([BILLIARD_RED, BILLIARD_YELLOW]);

const DEFAULTS = Object.freeze({
  enabled: false,
  attractionRadius: 32,
  mergeDurationMs: 320,
  wallBounceAim: true,
  pvpBounce: false,
  fixedMainBalls: false,
  mainBallPenalty: 2
});

const ATTRACTION_RADIUS_MIN = 20;
const ATTRACTION_RADIUS_MAX = 80;
const MERGE_DURATION_MIN_MS = 160;
const MERGE_DURATION_MAX_MS = 900;
const MAIN_BALL_PENALTY_MIN = 0;
const MAIN_BALL_PENALTY_MAX = 10;

const BASE_STEP_SECONDS = 1 / 120;
const MAX_SLIDE_STEP_PX = 3.5;
const PEG_SLIDE_FRICTION = 0.972;
const PEG_SLIDE_WALL_BOUNCE = 0.5;
const PEG_STOP_SPEED = 0.045;
const PEG_MAX_SPEED = 18;
const BALL_IMPACT_SCALE = 0.96;
const BALL_IMPACT_MIN_SPEED = 2.35;
const BALL_IMPACT_GLANCING_FLOOR = 0.18;
const BALL_IMPACT_TANGENT_TRANSFER = 0.12;
const CHAIN_RESTITUTION = 0.92;
const TANGENTIAL_DAMPING = 0.965;
const STATIC_RESTITUTION = 0.76;
const LAUNCHER_REPEL_BOUNCE = 0.62;
const WALL_SAFE_INSET = 52;
const WALL_SAFE_KICK = 0.9;
const LAUNCHER_SAFE_PADDING = 10;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeBilliardSettings(rawSettings = null) {
  const raw = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
    ? rawSettings
    : {};
  return {
    enabled: !!raw.enabled,
    attractionRadius: clampNumber(
      raw.attractionRadius,
      ATTRACTION_RADIUS_MIN,
      ATTRACTION_RADIUS_MAX,
      DEFAULTS.attractionRadius
    ),
    mergeDurationMs: Math.round(clampNumber(
      raw.mergeDurationMs,
      MERGE_DURATION_MIN_MS,
      MERGE_DURATION_MAX_MS,
      DEFAULTS.mergeDurationMs
    )),
    wallBounceAim: raw.wallBounceAim !== false,
    pvpBounce: raw.pvpBounce === true,
    fixedMainBalls: raw.fixedMainBalls === true,
    mainBallPenalty: Math.round(clampNumber(
      raw.mainBallPenalty,
      MAIN_BALL_PENALTY_MIN,
      MAIN_BALL_PENALTY_MAX,
      DEFAULTS.mainBallPenalty
    ))
  };
}

export function ensureLevelBilliard(level) {
  if (!level || typeof level !== 'object') return normalizeBilliardSettings(null);
  level.billiard = normalizeBilliardSettings(level.billiard);
  return level.billiard;
}

export function isBilliardPegType(type) {
  return type === BILLIARD_RED || type === BILLIARD_YELLOW;
}

export function isBilliardPair(a, b) {
  if (!a || !b) return false;
  return (a.type === BILLIARD_RED && b.type === BILLIARD_YELLOW)
    || (a.type === BILLIARD_YELLOW && b.type === BILLIARD_RED);
}

export function isBilliardMovablePeg(peg) {
  if (!peg || peg._billiardMerging) return false;
  return peg.type === BILLIARD_RED
    || peg.type === BILLIARD_YELLOW
    || peg.type === 'blue'
    || (peg.type === 'orange' && peg._billiardPvpBounce === true);
}

function getPairKey(a, b) {
  if (!a || !b) return '';
  return String(a.id) < String(b.id) ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}

function getPegSlideRadius(peg) {
  if (!peg) return PHYSICS_CONFIG.pegRadius;
  if (peg.type === 'bumper') return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
  if (peg.shape === 'brick') {
    const width = Number.isFinite(peg.width) ? peg.width : PHYSICS_CONFIG.brickWidth;
    const height = Number.isFinite(peg.height) ? peg.height : PHYSICS_CONFIG.brickHeight;
    return Math.max(PHYSICS_CONFIG.pegRadius, Math.hypot(width, height) * 0.5);
  }
  return PHYSICS_CONFIG.pegRadius;
}

function getBrickHalfSize(peg) {
  return {
    halfWidth: (Number.isFinite(peg?.width) ? peg.width : PHYSICS_CONFIG.brickWidth) * 0.5,
    halfHeight: (Number.isFinite(peg?.height) ? peg.height : PHYSICS_CONFIG.brickHeight) * 0.5
  };
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
  if (peg.type === 'blue') return 1.08;
  if (peg.shape === 'brick') return 1.24;
  return 1;
}

function shiftPegPosition(peg, dx, dy) {
  if (!peg || (!dx && !dy)) return;
  peg.x += dx;
  peg.y += dy;
  if (peg.curveSlices) {
    for (const slice of peg.curveSlices) {
      slice.x += dx;
      slice.y += dy;
    }
  }
  peg._wrapCopies = null;
  peg._wrapHideMain = false;
}

function getMotionState(peg) {
  if (!peg) return null;
  if (!peg._billiardMotion) {
    peg._billiardMotion = {
      vx: 0,
      vy: 0,
      sourceBall: null
    };
  }
  return peg._billiardMotion;
}

function clearMotionState(peg) {
  if (!peg) return;
  delete peg._billiardMotion;
  delete peg._billiardActive;
  delete peg._billiardMergeT;
  delete peg._billiardPvpBounce;
}

function getPegSpeed(peg) {
  const motion = peg?._billiardMotion;
  if (!motion) return 0;
  return Utils.magnitude(motion.vx, motion.vy);
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

function applyWallBounce(peg, width, height) {
  if (!peg) return;
  const motion = getMotionState(peg);
  const extents = getPegWallExtents(peg);
  const safeX = Math.max(extents.x, WALL_SAFE_INSET);
  const safeY = Math.max(extents.y, WALL_SAFE_INSET);
  let corrected = false;

  if (Number.isFinite(width) && width > 0) {
    if (peg.x < safeX) {
      shiftPegPosition(peg, safeX - peg.x, 0);
      motion.vx = Math.max(Math.abs(motion.vx) * PEG_SLIDE_WALL_BOUNCE, WALL_SAFE_KICK);
      corrected = true;
    } else if (peg.x > width - safeX) {
      shiftPegPosition(peg, width - safeX - peg.x, 0);
      motion.vx = -Math.max(Math.abs(motion.vx) * PEG_SLIDE_WALL_BOUNCE, WALL_SAFE_KICK);
      corrected = true;
    }
  }

  if (Number.isFinite(height) && height > 0) {
    if (peg.y < safeY) {
      shiftPegPosition(peg, 0, safeY - peg.y);
      motion.vy = Math.max(Math.abs(motion.vy) * PEG_SLIDE_WALL_BOUNCE, WALL_SAFE_KICK);
      corrected = true;
    } else if (peg.y > height - safeY) {
      shiftPegPosition(peg, 0, height - safeY - peg.y);
      motion.vy = -Math.max(Math.abs(motion.vy) * PEG_SLIDE_WALL_BOUNCE, WALL_SAFE_KICK);
      corrected = true;
    }
  }

  if (corrected) {
    peg._billiardActive = true;
    clampMotion(motion);
  }
}

function applyLauncherRepel(peg, launchers = []) {
  if (!isBilliardMovablePeg(peg) || !Array.isArray(launchers)) return;
  const motion = getMotionState(peg);
  const radius = getPegSlideRadius(peg);
  for (const launcher of launchers) {
    if (!launcher || !Number.isFinite(launcher.x) || !Number.isFinite(launcher.y)) continue;
    const padding = Number.isFinite(launcher.safePadding) ? Math.max(0, launcher.safePadding) : LAUNCHER_SAFE_PADDING;
    const hardClearance = (launcher.radius || 24) + radius + padding;
    const safeInset = Number.isFinite(launcher.safeInset) ? Math.max(0, launcher.safeInset) : 0;
    const clearance = Math.max(hardClearance, safeInset);
    const dx = peg.x - launcher.x;
    const dy = peg.y - launcher.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= clearance) continue;
    const fallbackAngle = Number.isFinite(launcher.defaultAngle) ? launcher.defaultAngle : Math.PI / 2;
    const nx = dist > 0.0001 ? dx / dist : Math.cos(fallbackAngle);
    const ny = dist > 0.0001 ? dy / dist : Math.sin(fallbackAngle);
    shiftPegPosition(peg, nx * (clearance - dist + 1.25), ny * (clearance - dist + 1.25));
    const vn = motion.vx * nx + motion.vy * ny;
    if (vn < 0) {
      motion.vx -= (1 + LAUNCHER_REPEL_BOUNCE) * vn * nx;
      motion.vy -= (1 + LAUNCHER_REPEL_BOUNCE) * vn * ny;
    }
    const safeKick = Number.isFinite(launcher.safeKick) ? Math.max(0, launcher.safeKick) : 0.8;
    const nextVn = motion.vx * nx + motion.vy * ny;
    if (nextVn < safeKick) {
      motion.vx += (safeKick - nextVn) * nx;
      motion.vy += (safeKick - nextVn) * ny;
    }
    peg._billiardActive = true;
    clampMotion(motion);
  }
}

function applySafetyGuards(peg, bounds = null) {
  if (!isBilliardMovablePeg(peg)) return;
  applyWallBounce(peg, bounds?.width, bounds?.height);
  applyLauncherRepel(peg, bounds?.launchers);
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

function resolvePegOverlap(a, b) {
  if (!a || !b || a._billiardMerging || b._billiardMerging) return null;
  if (isPortalType(a.type) || isPortalType(b.type)) return null;

  if (a.shape === 'brick' && b.shape === 'brick') {
    return null;
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

function easeInOutCubic(t) {
  const k = Math.max(0, Math.min(1, t));
  return k < 0.5
    ? 4 * k * k * k
    : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

export class BilliardPegSystem {
  constructor(settings = null) {
    this.configure(settings);
    this.active = false;
    this.activePairs = new Set();
    this.activeMerges = new Map();
  }

  configure(settings = null) {
    this.settings = normalizeBilliardSettings(settings);
    return this.settings;
  }

  isActive() {
    return this.active || this.activeMerges.size > 0;
  }

  startShot(pegs = []) {
    this.active = true;
    this.activePairs.clear();
    for (const peg of pegs) {
      if (!isBilliardMovablePeg(peg)) continue;
      const motion = getMotionState(peg);
      motion.vx = 0;
      motion.vy = 0;
      motion.sourceBall = null;
      peg._billiardActive = true;
    }
  }

  finishShot(pegs = []) {
    this.active = false;
    this.activePairs.clear();
    for (const peg of pegs) {
      if (!peg?._billiardMotion) continue;
      peg._billiardMotion.vx = 0;
      peg._billiardMotion.vy = 0;
      peg._billiardMotion.sourceBall = null;
      delete peg._billiardActive;
    }
  }

  clear(pegs = []) {
    this.active = false;
    this.activePairs.clear();
    this.activeMerges.clear();
    for (const peg of pegs) {
      clearMotionState(peg);
      delete peg._billiardMerging;
    }
  }

  hasMovingPegs(pegs = []) {
    if (this.activeMerges.size > 0) return true;
    if (!Array.isArray(pegs)) return false;
    return pegs.some(peg => isBilliardMovablePeg(peg) && getPegSpeed(peg) > PEG_STOP_SPEED);
  }

  applySafety(pegs = [], bounds = null, options = null) {
    if (!Array.isArray(pegs) || pegs.length === 0) return false;
    const settle = options?.settle === true;
    let changed = false;

    for (const peg of pegs) {
      if (!isBilliardMovablePeg(peg)) continue;
      const beforeX = peg.x;
      const beforeY = peg.y;
      applySafetyGuards(peg, bounds);
      if (Math.abs(peg.x - beforeX) > 0.001 || Math.abs(peg.y - beforeY) > 0.001) {
        changed = true;
      }
      if (settle && peg._billiardMotion) {
        peg._billiardMotion.vx = 0;
        peg._billiardMotion.vy = 0;
        peg._billiardMotion.sourceBall = null;
        delete peg._billiardActive;
      }
    }

    return changed;
  }

  addImpactVelocity(peg, vx, vy, sourceBall = null) {
    if (!this.active || !isBilliardMovablePeg(peg)) return false;

    const motion = getMotionState(peg);
    const mass = getPegMass(peg);
    motion.vx += vx / mass;
    motion.vy += vy / mass;
    if (sourceBall) motion.sourceBall = sourceBall;
    clampMotion(motion);

    if (Utils.magnitude(motion.vx, motion.vy) > PEG_STOP_SPEED) {
      peg._billiardActive = true;
    }
    return true;
  }

  applyBallImpact(peg, ball, impact = null) {
    if (!this.active || !isBilliardMovablePeg(peg)) return false;

    const impactVx = Number.isFinite(impact?.vx) ? impact.vx : (ball?.vx || 0);
    const impactVy = Number.isFinite(impact?.vy) ? impact.vy : (ball?.vy || 0);
    const incoming = normalizeVector(impactVx, impactVy);
    const speed = Number.isFinite(impact?.speed) ? impact.speed : incoming.speed;
    if (speed <= 0.0001) return false;

    let impulseX = impactVx;
    let impulseY = impactVy;
    if (Number.isFinite(impact?.normalX) && Number.isFinite(impact?.normalY)) {
      const normal = normalizeVector(impact.normalX, impact.normalY, incoming.x, incoming.y);
      const tangentX = -normal.y;
      const tangentY = normal.x;
      const normalSpeed = Math.max(
        speed * BALL_IMPACT_GLANCING_FLOOR,
        impactVx * normal.x + impactVy * normal.y
      );
      const tangentSpeed = impactVx * tangentX + impactVy * tangentY;
      impulseX = normal.x * normalSpeed + tangentX * tangentSpeed * BALL_IMPACT_TANGENT_TRANSFER;
      impulseY = normal.y * normalSpeed + tangentY * tangentSpeed * BALL_IMPACT_TANGENT_TRANSFER;
    }

    const normalized = normalizeVector(impulseX, impulseY, incoming.x, incoming.y);
    const impulseMagnitude = Utils.magnitude(impulseX, impulseY);
    const impulseSpeed = Utils.clamp(impulseMagnitude * BALL_IMPACT_SCALE, BALL_IMPACT_MIN_SPEED, PEG_MAX_SPEED);
    return this.addImpactVelocity(
      peg,
      normalized.x * impulseSpeed,
      normalized.y * impulseSpeed,
      ball || null
    );
  }

  step(pegs = [], dtSeconds = BASE_STEP_SECONDS, bounds = null) {
    if (!Array.isArray(pegs) || pegs.length === 0) {
      return { completedMerges: [], moving: false };
    }

    const completedMerges = this.stepMerges(pegs, dtSeconds);
    if (!this.active && this.activeMerges.size === 0) {
      return { completedMerges, moving: completedMerges.length > 0 };
    }

    const timeScale = Number.isFinite(PHYSICS_CONFIG.timeScale) ? PHYSICS_CONFIG.timeScale : 1;
    const safeDt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : BASE_STEP_SECONDS;
    const stepScale = Math.max(0.1, (safeDt / BASE_STEP_SECONDS) * timeScale);
    let maxMove = 0;
    let hasDynamicPeg = false;

    for (const peg of pegs) {
      applySafetyGuards(peg, bounds);
    }

    for (const peg of pegs) {
      if (!isBilliardMovablePeg(peg)) continue;
      const speed = getPegSpeed(peg);
      if (speed <= PEG_STOP_SPEED) continue;
      hasDynamicPeg = true;
      maxMove = Math.max(maxMove, speed * stepScale);
    }

    if (hasDynamicPeg) {
      const subSteps = Math.max(1, Math.ceil(maxMove / MAX_SLIDE_STEP_PX));
      const subScale = stepScale / subSteps;
      const framePairs = new Set();

      for (let step = 0; step < subSteps; step++) {
        for (const peg of pegs) {
          if (!isBilliardMovablePeg(peg)) continue;
          const motion = getMotionState(peg);
          if (Utils.magnitude(motion.vx, motion.vy) <= PEG_STOP_SPEED) continue;
          shiftPegPosition(peg, motion.vx * subScale, motion.vy * subScale);
          applyWallBounce(peg, bounds?.width, bounds?.height);
          applyLauncherRepel(peg, bounds?.launchers);
        }

        const dynamicIndices = [];
        const isDynamic = new Array(pegs.length).fill(false);
        for (let i = 0; i < pegs.length; i++) {
          const peg = pegs[i];
          if (!isBilliardMovablePeg(peg)) continue;
          if (getPegSpeed(peg) <= PEG_STOP_SPEED) continue;
          dynamicIndices.push(i);
          isDynamic[i] = true;
        }

        for (const i of dynamicIndices) {
          const a = pegs[i];
          if (!a) continue;
          for (let j = 0; j < pegs.length; j++) {
            if (j === i) continue;
            const b = pegs[j];
            if (!b || b._billiardMerging) continue;
            if (isDynamic[j] && j < i) continue;
            const overlap = resolvePegOverlap(a, b);
            if (!overlap) continue;
            const pairKey = getPairKey(a, b);
            framePairs.add(pairKey);
            this.resolvePegCollision(a, b, overlap);
          }
        }
      }

      const frictionScale = Math.pow(PEG_SLIDE_FRICTION, stepScale);
      for (const peg of pegs) {
        if (!peg?._billiardMotion) continue;
        const motion = peg._billiardMotion;
        motion.vx *= frictionScale;
        motion.vy *= frictionScale;
        if (Utils.magnitude(motion.vx, motion.vy) <= PEG_STOP_SPEED) {
          motion.vx = 0;
          motion.vy = 0;
          motion.sourceBall = null;
        }
      }

      this.activePairs = framePairs;
    } else {
      this.activePairs.clear();
    }

    for (const peg of pegs) {
      applySafetyGuards(peg, bounds);
    }

    this.startNearbyMerges(pegs);
    return {
      completedMerges,
      moving: this.hasMovingPegs(pegs) || completedMerges.length > 0
    };
  }

  resolvePegCollision(a, b, overlap) {
    const aDynamic = isBilliardMovablePeg(a);
    const bDynamic = isBilliardMovablePeg(b);
    if (!aDynamic && !bDynamic) return;

    const nx = overlap.nx;
    const ny = overlap.ny;
    const tx = -ny;
    const ty = nx;

    if (aDynamic && !bDynamic) {
      shiftPegPosition(a, -nx * (overlap.depth + 0.25), -ny * (overlap.depth + 0.25));
      const motion = getMotionState(a);
      const vn = motion.vx * nx + motion.vy * ny;
      if (vn > 0) {
        motion.vx -= (1 + STATIC_RESTITUTION) * vn * nx;
        motion.vy -= (1 + STATIC_RESTITUTION) * vn * ny;
      }
      clampMotion(motion);
      return;
    }

    if (!aDynamic && bDynamic) {
      shiftPegPosition(b, nx * (overlap.depth + 0.25), ny * (overlap.depth + 0.25));
      const motion = getMotionState(b);
      const vn = motion.vx * nx + motion.vy * ny;
      if (vn < 0) {
        motion.vx -= (1 + STATIC_RESTITUTION) * vn * nx;
        motion.vy -= (1 + STATIC_RESTITUTION) * vn * ny;
      }
      clampMotion(motion);
      return;
    }

    const motionA = getMotionState(a);
    const motionB = getMotionState(b);
    const massA = getPegMass(a);
    const massB = getPegMass(b);
    const totalMass = massA + massB;

    const sepA = overlap.depth * (massB / totalMass);
    const sepB = overlap.depth * (massA / totalMass);
    shiftPegPosition(a, -nx * sepA, -ny * sepA);
    shiftPegPosition(b, nx * sepB, ny * sepB);

    const vaN = motionA.vx * nx + motionA.vy * ny;
    const vbN = motionB.vx * nx + motionB.vy * ny;
    const vaT = motionA.vx * tx + motionA.vy * ty;
    const vbT = motionB.vx * tx + motionB.vy * ty;
    const relNormal = vbN - vaN;

    if (relNormal < 0) {
      const nextVaN = (
        vaN * (massA - CHAIN_RESTITUTION * massB) +
        vbN * (1 + CHAIN_RESTITUTION) * massB
      ) / totalMass;
      const nextVbN = (
        vbN * (massB - CHAIN_RESTITUTION * massA) +
        vaN * (1 + CHAIN_RESTITUTION) * massA
      ) / totalMass;

      motionA.vx = tx * (vaT * TANGENTIAL_DAMPING) + nx * nextVaN;
      motionA.vy = ty * (vaT * TANGENTIAL_DAMPING) + ny * nextVaN;
      motionB.vx = tx * (vbT * TANGENTIAL_DAMPING) + nx * nextVbN;
      motionB.vy = ty * (vbT * TANGENTIAL_DAMPING) + ny * nextVbN;
      clampMotion(motionA);
      clampMotion(motionB);
    }

    const speedA = Utils.magnitude(motionA.vx, motionA.vy);
    const speedB = Utils.magnitude(motionB.vx, motionB.vy);
    if (speedA > speedB && motionA.sourceBall && !motionB.sourceBall) {
      motionB.sourceBall = motionA.sourceBall;
    } else if (speedB > speedA && motionB.sourceBall && !motionA.sourceBall) {
      motionA.sourceBall = motionB.sourceBall;
    }
  }

  startNearbyMerges(pegs = []) {
    const available = pegs.filter(peg => isBilliardPegType(peg?.type) && !peg._billiardMerging);
    if (available.length < 2) return;

    const pairs = [];
    const radius = this.settings.attractionRadius;
    for (let i = 0; i < available.length; i++) {
      const a = available[i];
      for (let j = i + 1; j < available.length; j++) {
        const b = available[j];
        if (!isBilliardPair(a, b)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;
        pairs.push({ a, b, dist });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    const used = new Set();
    for (const pair of pairs) {
      if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
      this.startMerge(pair.a, pair.b);
      used.add(pair.a.id);
      used.add(pair.b.id);
    }
  }

  startMerge(a, b) {
    if (!a || !b || !isBilliardPair(a, b)) return false;
    const key = getPairKey(a, b);
    if (this.activeMerges.has(key)) return false;

    const targetX = (a.x + b.x) * 0.5;
    const targetY = (a.y + b.y) * 0.5;
    const merge = {
      key,
      aId: a.id,
      bId: b.id,
      elapsedMs: 0,
      durationMs: this.settings.mergeDurationMs,
      aStartX: a.x,
      aStartY: a.y,
      bStartX: b.x,
      bStartY: b.y,
      targetX,
      targetY
    };

    const motionA = getMotionState(a);
    const motionB = getMotionState(b);
    motionA.vx = 0;
    motionA.vy = 0;
    motionB.vx = 0;
    motionB.vy = 0;
    a._billiardMerging = { key };
    b._billiardMerging = { key };
    this.activeMerges.set(key, merge);
    return true;
  }

  stepMerges(pegs = [], dtSeconds = BASE_STEP_SECONDS) {
    if (this.activeMerges.size === 0) return [];
    const byId = new Map(pegs.map(peg => [peg?.id, peg]).filter(([id, peg]) => id && peg));
    const completed = [];
    const dtMs = Math.max(0, (Number(dtSeconds) || BASE_STEP_SECONDS) * 1000);

    for (const [key, merge] of [...this.activeMerges.entries()]) {
      const a = byId.get(merge.aId);
      const b = byId.get(merge.bId);
      if (!a || !b) {
        this.activeMerges.delete(key);
        if (a) delete a._billiardMerging;
        if (b) delete b._billiardMerging;
        continue;
      }

      merge.elapsedMs += dtMs;
      const t = Math.max(0, Math.min(1, merge.elapsedMs / Math.max(1, merge.durationMs)));
      const eased = easeInOutCubic(t);

      const nextAX = merge.aStartX + (merge.targetX - merge.aStartX) * eased;
      const nextAY = merge.aStartY + (merge.targetY - merge.aStartY) * eased;
      const nextBX = merge.bStartX + (merge.targetX - merge.bStartX) * eased;
      const nextBY = merge.bStartY + (merge.targetY - merge.bStartY) * eased;
      shiftPegPosition(a, nextAX - a.x, nextAY - a.y);
      shiftPegPosition(b, nextBX - b.x, nextBY - b.y);
      a._billiardMergeT = t;
      b._billiardMergeT = t;

      if (t >= 1) {
        completed.push({
          key,
          aId: merge.aId,
          bId: merge.bId,
          x: merge.targetX,
          y: merge.targetY
        });
        this.activeMerges.delete(key);
      }
    }

    return completed;
  }
}
