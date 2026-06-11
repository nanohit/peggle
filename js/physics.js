// Peggle Physics Engine - Custom lightweight physics

import { Utils } from './utils.js';
import { getPortalScale, isPortalType } from './portal-defaults.js';
import { FLIPPER_DEFAULTS } from './flipper-defaults.js';

// Default physics config - can be modified at runtime
export const PHYSICS_CONFIG = {
  gravity: 0.12,
  friction: 0.998,
  bounce: 0.65,
  pegRadius: 8.5,
  maxVelocity: 16,
  launchPower: 7.5,
  timeScale: 1.0,  // Speed multiplier

  // Brick dimensions (when shape is 'brick')
  brickWidth: 34,
  brickHeight: 10.2
};

// Canonical peg radius all legacy content was authored against. A level's
// optional `level.pegRadius` (absent ⇒ this value) is applied to
// PHYSICS_CONFIG.pegRadius at load, which scales the ball, circle pegs and
// brick thickness together. Bricks remember the radius they were authored at in
// `peg.brickBaseRadius` so they can be re-scaled relative to it without drift.
export const DEFAULT_PEG_RADIUS = 8.5;

// Get ball radius (always same as peg radius)
export function getBallRadius() {
  return PHYSICS_CONFIG.pegRadius;
}

function getGravityX(source) {
  const vector = source?.gravityVector;
  return vector && Number.isFinite(vector.x) ? vector.x : 0;
}

function getGravityY(source) {
  const vector = source?.gravityVector;
  return vector && Number.isFinite(vector.y) ? vector.y : PHYSICS_CONFIG.gravity;
}

let BALL_ID = 0;

export class Ball {
  constructor(x, y) {
    this.id = `ball-${BALL_ID++}`;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.radius = getBallRadius();
    this.active = false;
    this.stuck = false;
    this.stuckFrames = 0;
    this.speedCapBoost = 0;
    this.portalCooldown = 0;
    this.launcherSpawnAnim = 1;
    this.side = null;
    this.gravityVector = null;
    this.lossYMin = null;
    this.lossYMax = null;
    this.disableCollisionJitter = false;
  }

  launch(angle, power = PHYSICS_CONFIG.launchPower) {
    this.vx = Math.cos(angle) * power;
    this.vy = Math.sin(angle) * power;
    this.active = true;
    this.stuck = false;
    this.stuckFrames = 0;
    this.speedCapBoost = 0;
    this.portalCooldown = 0;
    this._lastPortalTeleport = null;
    this._portalOscillationCount = 0;
    this.radius = getBallRadius();
    this.launcherSpawnAnim = 1;
  }

  // Phase 1: update velocity (gravity, friction, clamp). No position change.
  updateVelocity() {
    if (!this.active) return;

    const timeScale = PHYSICS_CONFIG.timeScale;

    this.vx += getGravityX(this) * timeScale;
    this.vy += getGravityY(this) * timeScale;

    const frictionScale = Math.pow(PHYSICS_CONFIG.friction, timeScale);
    this.vx *= frictionScale;
    this.vy *= frictionScale;

    const speed = Utils.magnitude(this.vx, this.vy);
    const maxSpeed = PHYSICS_CONFIG.maxVelocity + (this.speedCapBoost || 0);
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      this.vx *= scale;
      this.vy *= scale;
    }

    // Flipper boost decays quickly so only fresh flipper hits can exceed base cap.
    if (this.speedCapBoost > 0) {
      this.speedCapBoost *= 0.9;
      if (this.speedCapBoost < 0.05) this.speedCapBoost = 0;
    }
    if (this.portalCooldown > 0) {
      this.portalCooldown--;
    }

    // Stuck detection
    if (speed < 0.3 && Math.abs(this.vy) < 0.5) {
      this.stuckFrames++;
      if (this.stuckFrames > 180) this.stuck = true;
    } else {
      this.stuckFrames = 0;
    }
  }

  // Phase 2: advance position by a fraction of the frame's movement.
  // fraction = 1/numSubSteps for each sub-step.
  stepPosition(fraction) {
    const timeScale = PHYSICS_CONFIG.timeScale;
    this.x += this.vx * timeScale * fraction;
    this.y += this.vy * timeScale * fraction;
  }

  // How many pixels the ball will travel this frame (for sub-step calculation)
  getFrameSpeed() {
    return Utils.magnitude(this.vx, this.vy) * PHYSICS_CONFIG.timeScale;
  }

  reset(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.active = false;
    this.stuck = false;
    this.stuckFrames = 0;
    this.speedCapBoost = 0;
    this.portalCooldown = 0;
    this._lastPortalTeleport = null;
    this._portalOscillationCount = 0;
    this.radius = getBallRadius();
    this.launcherSpawnAnim = 1;
  }
}

// Collision detection for brick (rotated rectangle) vs circle
function circleRectCollision(ball, brick) {
  // Transform ball position to brick's local coordinate system
  const cos = Math.cos(-(brick.angle || 0));
  const sin = Math.sin(-(brick.angle || 0));
  
  const dx = ball.x - brick.x;
  const dy = ball.y - brick.y;
  
  // Rotate point to brick's local space
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  
  // Use brick's own dimensions or scale with pegRadius
  const halfW = (brick.width || PHYSICS_CONFIG.pegRadius * 4) / 2;
  const halfH = (brick.height || PHYSICS_CONFIG.pegRadius * 1.2) / 2;
  
  // Find closest point on rectangle to circle center
  const closestX = Utils.clamp(localX, -halfW, halfW);
  const closestY = Utils.clamp(localY, -halfH, halfH);
  
  // Distance from closest point to circle center
  const distX = localX - closestX;
  const distY = localY - closestY;
  const dist = Math.sqrt(distX * distX + distY * distY);
  
  if (dist >= ball.radius) return null;
  
  // Collision detected
  let normalLocalX, normalLocalY;
  
  if (dist === 0) {
    // Ball center is inside rectangle - push out the shortest way
    const overlapX = halfW - Math.abs(localX);
    const overlapY = halfH - Math.abs(localY);
    
    if (overlapX < overlapY) {
      normalLocalX = localX > 0 ? 1 : -1;
      normalLocalY = 0;
    } else {
      normalLocalX = 0;
      normalLocalY = localY > 0 ? 1 : -1;
    }
  } else {
    normalLocalX = distX / dist;
    normalLocalY = distY / dist;
  }
  
  // Rotate normal back to world space
  const brickAngle = brick.angle || 0;
  const normalX = normalLocalX * Math.cos(brickAngle) - normalLocalY * Math.sin(brickAngle);
  const normalY = normalLocalX * Math.sin(brickAngle) + normalLocalY * Math.cos(brickAngle);
  
  // Relative velocity along normal
  const dvn = ball.vx * normalX + ball.vy * normalY;
  
  if (dvn > 0) return null;
  
  return {
    normal: { x: normalX, y: normalY },
    depth: ball.radius - dist,
    relativeVelocityNormal: dvn
  };
}

function hasCurveSlices(peg) {
  return !!(peg?.shape === 'brick' && Array.isArray(peg.curveSlices) && peg.curveSlices.length >= 2);
}

// Per-level size scale for a brick: currentPegRadius / authoringPegRadius.
// A brick authored at `brickBaseRadius` (absent ⇒ DEFAULT_PEG_RADIUS) presents
// at the current level's size regardless of when it was drawn — the base cancels
// for bricks created from getBrickWidth/Height, and scales proportionally
// otherwise. Absent base + default pegRadius ⇒ 1 ⇒ byte-identical to legacy.
export function getBrickScale(peg) {
  const base = Number.isFinite(peg?.brickBaseRadius) ? peg.brickBaseRadius : DEFAULT_PEG_RADIUS;
  if (!(base > 0)) return 1;
  return PHYSICS_CONFIG.pegRadius / base;
}

// Effective brick dimensions after per-level scaling. Flat bricks scale BOTH
// width and height (uniform shrink). Curved/draw-mode ribbons scale ONLY the
// thickness (height) — the centerline (curveSlices, in absolute world coords)
// is left untouched, so seams and the authored shape/position are preserved.
export function getEffectiveBrickSize(peg) {
  const rawW = Number.isFinite(peg?.width) ? peg.width : PHYSICS_CONFIG.brickWidth;
  const rawH = Number.isFinite(peg?.height) ? peg.height : PHYSICS_CONFIG.brickHeight;
  const scale = getBrickScale(peg);
  if (scale === 1) return { width: rawW, height: rawH };
  if (hasCurveSlices(peg)) return { width: rawW, height: rawH * scale };
  return { width: rawW * scale, height: rawH * scale };
}

function getCurveSliceShift(peg, pose = null) {
  return {
    x: Number.isFinite(pose?.x) ? pose.x - peg.x : 0,
    y: Number.isFinite(pose?.y) ? pose.y - peg.y : 0
  };
}

function getCurveBrickBounds(peg, pose = null) {
  if (!hasCurveSlices(peg)) return null;
  const halfH = getEffectiveBrickSize(peg).height * 0.5;
  const shift = getCurveSliceShift(peg, pose);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const slice of peg.curveSlices) {
    if (!slice || !Number.isFinite(slice.x) || !Number.isFinite(slice.y)) continue;
    const nx = Number.isFinite(slice.nx) ? slice.nx : 0;
    const ny = Number.isFinite(slice.ny) ? slice.ny : 1;
    const x = slice.x + shift.x;
    const y = slice.y + shift.y;
    const x1 = x + nx * halfH;
    const x2 = x - nx * halfH;
    const y1 = y + ny * halfH;
    const y2 = y - ny * halfH;
    minX = Math.min(minX, x1, x2);
    maxX = Math.max(maxX, x1, x2);
    minY = Math.min(minY, y1, y2);
    maxY = Math.max(maxY, y1, y2);
  }

  if (!Number.isFinite(minX)) return null;
  const poseX = Number.isFinite(pose?.x) ? pose.x : peg.x;
  const poseY = Number.isFinite(pose?.y) ? pose.y : peg.y;
  return {
    minX,
    maxX,
    minY,
    maxY,
    radius: Math.max(
      PHYSICS_CONFIG.pegRadius,
      Math.hypot(maxX - poseX, maxY - poseY),
      Math.hypot(maxX - poseX, minY - poseY),
      Math.hypot(minX - poseX, maxY - poseY),
      Math.hypot(minX - poseX, minY - poseY)
    )
  };
}

function getCurveBrickCollision(ball, peg, pose = null) {
  if (!hasCurveSlices(peg)) return null;
  const shift = getCurveSliceShift(peg, pose);
  const height = getEffectiveBrickSize(peg).height;
  let best = null;

  for (let i = 0; i < peg.curveSlices.length - 1; i++) {
    const a = peg.curveSlices[i];
    const b = peg.curveSlices[i + 1];
    if (!a || !b) continue;
    const ax = a.x + shift.x;
    const ay = a.y + shift.y;
    const bx = b.x + shift.x;
    const by = b.y + shift.y;
    const dx = bx - ax;
    const dy = by - ay;
    const width = Math.hypot(dx, dy);
    if (!Number.isFinite(width) || width <= 0.001) continue;
    const collision = circleRectCollision(ball, {
      x: (ax + bx) * 0.5,
      y: (ay + by) * 0.5,
      angle: Math.atan2(dy, dx),
      width,
      height
    });
    if (!collision) continue;
    if (!best || collision.depth > best.depth) best = collision;
  }

  return best;
}

// Overlap test for circle vs rotated rectangle — like circleRectCollision
// but does NOT reject based on velocity direction. Returns { normal, depth }
// whenever shapes overlap, regardless of ball movement direction.
function circleRectOverlap(ball, brick) {
  const cos = Math.cos(-(brick.angle || 0));
  const sin = Math.sin(-(brick.angle || 0));

  const dx = ball.x - brick.x;
  const dy = ball.y - brick.y;

  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  const halfW = (brick.width || PHYSICS_CONFIG.pegRadius * 4) / 2;
  const halfH = (brick.height || PHYSICS_CONFIG.pegRadius * 1.2) / 2;

  const closestX = Utils.clamp(localX, -halfW, halfW);
  const closestY = Utils.clamp(localY, -halfH, halfH);

  const distX = localX - closestX;
  const distY = localY - closestY;
  const dist = Math.sqrt(distX * distX + distY * distY);

  if (dist >= ball.radius) return null;

  let normalLocalX, normalLocalY;
  if (dist === 0) {
    const overlapX = halfW - Math.abs(localX);
    const overlapY = halfH - Math.abs(localY);
    if (overlapX < overlapY) {
      normalLocalX = localX > 0 ? 1 : -1;
      normalLocalY = 0;
    } else {
      normalLocalX = 0;
      normalLocalY = localY > 0 ? 1 : -1;
    }
  } else {
    normalLocalX = distX / dist;
    normalLocalY = distY / dist;
  }

  const brickAngle = brick.angle || 0;
  const normalX = normalLocalX * Math.cos(brickAngle) - normalLocalY * Math.sin(brickAngle);
  const normalY = normalLocalX * Math.sin(brickAngle) + normalLocalY * Math.cos(brickAngle);

  return {
    normal: { x: normalX, y: normalY },
    depth: ball.radius - dist
  };
}

export class PhysicsEngine {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ballTopY = 0;
    this.ballLossY = height + 50;
    this.bucketEnabled = true;
    this.balls = [];
    this.pegs = [];
    this.hitPegs = new Set(); // Track which pegs were hit (for scoring only)
    this.flippers = null;
    this.bucket = {
      x: width / 2,
      y: height - 25,
      width: 70,
      height: 16,
      speed: 1.5,
      // Sine-based oscillation: _phase tracks position in cycle [0, 2*PI)
      _phase: Math.PI / 2 // start centered (sin(PI/2) = 1 → middle)
    };
    this.portalPegs = [];
    this._pegGrid = null;
    this._pegGridCellSize = 0;
    this._pegGridStamp = null;
    this._pegGridStampId = 1;
    this._pegGridCandidates = [];
    this._maxPegCollisionRadius = PHYSICS_CONFIG.pegRadius;
    this.destructionContactSettings = null;
  }

  setBall(ball) {
    this.balls = ball ? [ball] : [];
  }

  setBalls(balls) {
    this.balls = Array.isArray(balls) ? balls : [];
  }

  addBall(ball) {
    if (!ball) return;
    this.balls.push(ball);
  }

  setPegs(pegs) {
    this.pegs = pegs;
    this.hitPegs.clear();
    this.portalPegs = Array.isArray(this.pegs)
      ? this.pegs.filter(p => this.isPortalPeg(p))
      : [];
    this._pegGridDirty = true;
  }

  markPegGridDirty() {
    this._pegGridDirty = true;
  }

  // True when pegs were added/removed/moved since the grid was last built.
  // Every per-frame peg mover marks the grid dirty (see the grid invariant),
  // so this doubles as a cheap "did any peg change" signal for callers.
  isPegGridDirty() {
    return !!this._pegGridDirty;
  }

  setFlippers(flippers) {
    this.flippers = flippers;
  }

  setBucketEnabled(enabled) {
    this.bucketEnabled = !!enabled;
  }

  setBallLossY(lossY) {
    if (!Number.isFinite(lossY)) return;
    this.ballLossY = lossY;
  }

  setBallTopY(topY) {
    if (!Number.isFinite(topY)) return;
    this.ballTopY = topY;
  }

  setDestructionContactSettings(settings = null) {
    if (!settings || settings.enabled === false) {
      this.destructionContactSettings = null;
      return;
    }
    const surfaceGrip = Number.isFinite(settings.surfaceGrip)
      ? Utils.clamp(settings.surfaceGrip, 0, 1)
      : 0.18;
    const dynamicPegBallBounce = Number.isFinite(settings.dynamicPegBallBounce)
      ? Utils.clamp(settings.dynamicPegBallBounce, 0, 1.25)
      : 0.45;
    this.destructionContactSettings = { surfaceGrip, dynamicPegBallBounce };
  }

  isPortalPeg(peg) {
    return !!peg && isPortalType(peg.type);
  }

  getPegCollisionRadius(peg) {
    if (!peg) return PHYSICS_CONFIG.pegRadius;
    if (peg.type === 'bumper') return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
    if (this.isPortalPeg(peg)) return PHYSICS_CONFIG.pegRadius * getPortalScale(peg);
    return PHYSICS_CONFIG.pegRadius;
  }

  _getPegCollisionPoses(peg) {
    if (!peg) return [];

    const poses = [];
    const wrapCopies = Array.isArray(peg._wrapCopies) ? peg._wrapCopies : [];
    if (!peg._wrapHideMain || wrapCopies.length === 0) {
      poses.push({ x: peg.x, y: peg.y, isWrapCopy: false });
    }

    for (const copy of wrapCopies) {
      if (!copy || !Number.isFinite(copy.x) || !Number.isFinite(copy.y)) continue;
      poses.push({ x: copy.x, y: copy.y, isWrapCopy: true });
    }

    if (poses.length === 0) {
      poses.push({ x: peg.x, y: peg.y, isWrapCopy: false });
    }

    return poses;
  }

  getPortalHalfLength(portal) {
    if (!portal) return PHYSICS_CONFIG.pegRadius;
    return PHYSICS_CONFIG.pegRadius * getPortalScale(portal);
  }

  _getPegGridCellSize() {
    const pegSize = PHYSICS_CONFIG.pegRadius * 4;
    const brickW = PHYSICS_CONFIG.brickWidth || 0;
    const brickH = PHYSICS_CONFIG.brickHeight || 0;
    return Math.max(24, pegSize, brickW, brickH);
  }

  _getPegBounds(peg, pose = null) {
    if (!peg) return null;
    const pegX = Number.isFinite(pose?.x) ? pose.x : peg.x;
    const pegY = Number.isFinite(pose?.y) ? pose.y : peg.y;
    if (peg.shape === 'brick') {
      const curveBounds = getCurveBrickBounds(peg, pose);
      if (curveBounds) return curveBounds;
      const { width: w, height: h } = getEffectiveBrickSize(peg);
      const hw = w / 2;
      const hh = h / 2;
      const angle = peg.angle || 0;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const extX = Math.abs(c) * hw + Math.abs(s) * hh;
      const extY = Math.abs(s) * hw + Math.abs(c) * hh;
      const radius = Math.hypot(extX, extY);
      return {
        minX: pegX - extX,
        maxX: pegX + extX,
        minY: pegY - extY,
        maxY: pegY + extY,
        radius
      };
    }

    const r = this.getPegCollisionRadius(peg);
    return {
      minX: pegX - r,
      maxX: pegX + r,
      minY: pegY - r,
      maxY: pegY + r,
      radius: r
    };
  }

  _detectPegCollision(ball, peg) {
    if (!ball || !peg || this.isPortalPeg(peg) || peg._billiardMerging) return null;

    const poses = this._getPegCollisionPoses(peg);
    let best = null;

    for (const pose of poses) {
      let collision;
      if (peg.shape === 'brick') {
        collision = hasCurveSlices(peg)
          ? getCurveBrickCollision(ball, peg, pose)
          : circleRectCollision(ball, { ...peg, x: pose.x, y: pose.y, ...getEffectiveBrickSize(peg) });
      } else {
        collision = Utils.circleCollision(ball, {
          x: pose.x,
          y: pose.y,
          radius: this.getPegCollisionRadius(peg)
        });
      }

      if (!collision) continue;
      if (!best || collision.depth > best.collision.depth) {
        best = { collision, pose };
      }
    }

    return best;
  }

  _snapPegToCollisionPose(peg, pose) {
    if (!peg || !pose?.isWrapCopy) return;

    const dx = pose.x - peg.x;
    const dy = pose.y - peg.y;
    peg.x = pose.x;
    peg.y = pose.y;
    peg._wrapCopies = null;
    peg._wrapHideMain = false;
    peg._animWrapShiftX = 0;
    peg._animWrapShiftY = 0;

    if (peg.curveSlices) {
      for (const slice of peg.curveSlices) {
        slice.x += dx;
        slice.y += dy;
      }
    }

    this._pegGridDirty = true;
  }

  _buildPegGrid() {
    if (!this._pegGridDirty && this._pegGrid) return;
    this._pegGridDirty = false;

    const pegs = this.pegs;
    if (!Array.isArray(pegs) || pegs.length === 0) {
      this._pegGrid = null;
      this._maxPegCollisionRadius = PHYSICS_CONFIG.pegRadius;
      return;
    }

    const cellSize = this._getPegGridCellSize();
    this._pegGridCellSize = cellSize;
    const grid = new Map();
    let maxRadius = PHYSICS_CONFIG.pegRadius;

    for (let i = 0; i < pegs.length; i++) {
      const peg = pegs[i];
      if (this.isPortalPeg(peg) || peg._billiardMerging) continue;
      const poses = this._getPegCollisionPoses(peg);
      for (const pose of poses) {
        const bounds = this._getPegBounds(peg, pose);
        if (!bounds) continue;
        if (Number.isFinite(bounds.radius)) {
          maxRadius = Math.max(maxRadius, bounds.radius);
        }
        const minCellX = Math.floor(bounds.minX / cellSize);
        const maxCellX = Math.floor(bounds.maxX / cellSize);
        const minCellY = Math.floor(bounds.minY / cellSize);
        const maxCellY = Math.floor(bounds.maxY / cellSize);

        for (let cx = minCellX; cx <= maxCellX; cx++) {
          for (let cy = minCellY; cy <= maxCellY; cy++) {
            const key = `${cx},${cy}`;
            let bucket = grid.get(key);
            if (!bucket) {
              bucket = [];
              grid.set(key, bucket);
            }
            bucket.push(i);
          }
        }
      }
    }

    this._pegGrid = grid;
    this._maxPegCollisionRadius = maxRadius;
    if (!this._pegGridStamp || this._pegGridStamp.length < pegs.length) {
      this._pegGridStamp = new Int32Array(pegs.length);
    }
    if (!this._pegGridCandidates) this._pegGridCandidates = [];
  }

  _getPegCandidateIndices(ball) {
    if (!this._pegGrid || !ball || !Number.isFinite(ball.x) || !Number.isFinite(ball.y)) return null;
    const cellSize = this._pegGridCellSize;
    if (!Number.isFinite(cellSize) || cellSize <= 0) return null;

    const searchRadius = (ball.radius || getBallRadius()) + this._maxPegCollisionRadius;
    const minCellX = Math.floor((ball.x - searchRadius) / cellSize);
    const maxCellX = Math.floor((ball.x + searchRadius) / cellSize);
    const minCellY = Math.floor((ball.y - searchRadius) / cellSize);
    const maxCellY = Math.floor((ball.y + searchRadius) / cellSize);

    let stampId = (this._pegGridStampId || 0) + 1;
    if (stampId > 1e9) {
      this._pegGridStamp.fill(0);
      stampId = 1;
    }
    this._pegGridStampId = stampId;

    const out = this._pegGridCandidates;
    out.length = 0;

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const bucket = this._pegGrid.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const idx = bucket[bi];
          if (this._pegGridStamp[idx] === stampId) continue;
          this._pegGridStamp[idx] = stampId;
          out.push(idx);
        }
      }
    }

    if (out.length > 1) {
      out.sort((a, b) => a - b);
    }
    return out;
  }

  findPortalExit(entryPortal) {
    if (!entryPortal) return null;
    const targetType = entryPortal.type === 'portalBlue' ? 'portalOrange' : 'portalBlue';
    let best = null;
    let bestDistSq = Infinity;
    for (const peg of this.pegs) {
      if (!peg || peg.id === entryPortal.id || peg.type !== targetType) continue;
      const dx = peg.x - entryPortal.x;
      const dy = peg.y - entryPortal.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = peg;
      }
    }
    return best;
  }

  getPortalCrossing(ballLike, prevX, prevY, portal) {
    if (!ballLike || !portal) return null;

    const angle = portal.angle || 0;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const nx = -uy;
    const ny = ux;

    const dx0 = prevX - portal.x;
    const dy0 = prevY - portal.y;
    const dx1 = ballLike.x - portal.x;
    const dy1 = ballLike.y - portal.y;

    const x0 = dx0 * ux + dy0 * uy;
    const y0 = dx0 * nx + dy0 * ny;
    const x1 = dx1 * ux + dy1 * uy;
    const y1 = dx1 * nx + dy1 * ny;

    const radius = ballLike.radius || getBallRadius();
    const halfLen = this.getPortalHalfLength(portal);
    const xReach = halfLen + radius;

    // The swept ball center segment must overlap the portal line's x-range and y-band.
    if (Math.max(x0, x1) < -xReach || Math.min(x0, x1) > xReach) return null;
    if (Math.max(y0, y1) < -radius || Math.min(y0, y1) > radius) return null;

    const crossedCenterLine = (y0 <= 0 && y1 >= 0) || (y0 >= 0 && y1 <= 0);
    const enteredBand = (Math.abs(y0) > radius && Math.abs(y1) <= radius)
      || (Math.abs(y1) > radius && Math.abs(y0) <= radius);
    if (!crossedCenterLine && !enteredBand) return null;

    const dy = y1 - y0;
    let t = 0.5;
    if (Math.abs(dy) > 1e-6 && crossedCenterLine) {
      t = Utils.clamp(-y0 / dy, 0, 1);
    } else if (!crossedCenterLine) {
      t = Math.abs(y0) <= Math.abs(y1) ? 0 : 1;
    }

    const crossX = x0 + (x1 - x0) * t;
    if (Math.abs(crossX) > xReach) return null;

    let side = Math.sign(dy);
    if (side === 0) side = Math.sign(y1) || Math.sign(y0) || 1;

    return {
      localX: Utils.clamp(crossX, -halfLen, halfLen),
      side,
      y0,
      y1,
      worldX: prevX + (ballLike.x - prevX) * t,
      worldY: prevY + (ballLike.y - prevY) * t,
      fromPositive: (y0 > 0) || (Math.abs(y0) <= 1e-6 && y1 < 0)
    };
  }

  resolvePortalSideCollision(ballLike, portal, keepPositiveSide) {
    if (!ballLike || !portal) return;

    const angle = portal.angle || 0;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const nx = -uy;
    const ny = ux;
    const radius = ballLike.radius || getBallRadius();
    const halfLen = this.getPortalHalfLength(portal);

    const dx = ballLike.x - portal.x;
    const dy = ballLike.y - portal.y;
    const localXRaw = dx * ux + dy * uy;
    const localY = dx * nx + dy * ny;
    const localX = Utils.clamp(localXRaw, -halfLen, halfLen);
    const targetY = radius + 0.6;
    const correctedY = keepPositiveSide
      ? Math.max(localY, targetY)
      : Math.min(localY, -targetY);

    ballLike.x = portal.x + localX * ux + correctedY * nx;
    ballLike.y = portal.y + localX * uy + correctedY * ny;

    const vn = ballLike.vx * nx + ballLike.vy * ny;
    const shouldBounce = keepPositiveSide ? (vn < 0) : (vn > 0);
    if (!shouldBounce) return;

    const bounce = PHYSICS_CONFIG.bounce;
    ballLike.vx -= (1 + bounce) * vn * nx;
    ballLike.vy -= (1 + bounce) * vn * ny;
    this._clampBallLikeSpeed(ballLike);
  }

  enforceOneWayExitVelocity(ballLike, exitAngle, blockedFromPositive) {
    if (!ballLike) return;

    const ux = Math.cos(exitAngle || 0);
    const uy = Math.sin(exitAngle || 0);
    const nx = -uy;
    const ny = ux;

    const vt = ballLike.vx * ux + ballLike.vy * uy;
    let vn = ballLike.vx * nx + ballLike.vy * ny;
    // For one-way exits, always bias normal velocity toward the configured open side.
    if (blockedFromPositive) {
      if (vn > -0.2) vn = -Math.max(0.2, Math.abs(vn) * 0.5);
    } else if (vn < 0.2) {
      vn = Math.max(0.2, Math.abs(vn) * 0.5);
    }
    ballLike.vx = vt * ux + vn * nx;
    ballLike.vy = vt * uy + vn * ny;
  }

  _clampBallLikeSpeed(ballLike) {
    if (!ballLike) return;
    const speed = Utils.magnitude(ballLike.vx, ballLike.vy);
    const maxSpeed = PHYSICS_CONFIG.maxVelocity + (ballLike.speedCapBoost || 0);
    if (speed <= maxSpeed) return;
    const scale = maxSpeed / speed;
    ballLike.vx *= scale;
    ballLike.vy *= scale;
  }

  tryPortalTeleport(ballLike, prevX = ballLike?.x, prevY = ballLike?.y, options = null) {
    if (!ballLike) return false;
    if (!Number.isFinite(prevX) || !Number.isFinite(prevY)) return false;
    const portalSource = (this.portalPegs && this.portalPegs.length > 0)
      ? this.portalPegs
      : this.pegs;
    const portals = Array.isArray(portalSource)
      ? portalSource.filter(peg => this.isPortalPeg(peg))
      : [];
    if (!portals || portals.length === 0) return false;
    const previewOnly = !!(options && options.previewOnly);
    const canTeleport = (ballLike.portalCooldown || 0) <= 0;

    for (const entry of portals) {
      const crossing = this.getPortalCrossing(ballLike, prevX, prevY, entry);
      if (!crossing) continue;

      const blockedFromPositive = !entry.portalOneWayFlip;
      const blockedSide = !!entry.portalOneWay && (crossing.fromPositive === blockedFromPositive);
      if (previewOnly) {
        return {
          hit: true,
          kind: blockedSide ? 'blocked' : 'teleport',
          x: crossing.worldX,
          y: crossing.worldY
        };
      }

      if (blockedSide) {
        this.resolvePortalSideCollision(ballLike, entry, blockedFromPositive);
        return true;
      }

      if (!canTeleport) {
        // During portal cooldown, keep one-way portals physically one-sided.
        if (entry.portalOneWay) {
          this.resolvePortalSideCollision(ballLike, entry, !blockedFromPositive);
          return true;
        }
        continue;
      }

      const exit = this.findPortalExit(entry);
      if (!exit) continue;

      const entryAngle = entry.angle || 0;
      const exitAngle = exit.angle || 0;
      const cIn = Math.cos(entryAngle);
      const sIn = Math.sin(entryAngle);
      const cOut = Math.cos(exitAngle);
      const sOut = Math.sin(exitAngle);

      // Keep the entry offset along the portal line; place the ball just outside
      // the exit line on the traversed side so portals behave as thin line triggers.
      const localX = crossing.localX;
      const baseOffset = (ballLike.radius || getBallRadius()) + 1.2;
      // One-way portals always eject from their configured open side,
      // never from their blocked gray side.
      const exitBlockedFromPositive = !exit.portalOneWayFlip;
      const exitOpenSign = exitBlockedFromPositive ? -1 : 1;
      const localY = exit.portalOneWay ? exitOpenSign * baseOffset : crossing.side * baseOffset;
      ballLike.x = exit.x + (localX * cOut - localY * sOut);
      ballLike.y = exit.y + (localX * sOut + localY * cOut);

      // Decompose incoming velocity in the entry portal's local frame.
      // Tangent (along the portal line) is preserved on exit; normal (across the line)
      // is mapped to the exit so the ball comes out at the same angle relative to the
      // exit's surface — symmetric in both directions.
      const vt = ballLike.vx * cIn + ballLike.vy * sIn;
      const vn = ballLike.vx * (-sIn) + ballLike.vy * cIn;

      // Detect oscillation: ball repeatedly bouncing between the same pair of portals.
      const teleportNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
      const lastTp = ballLike._lastPortalTeleport;
      const oscillating = !!(
        lastTp
        && teleportNow - lastTp.atMs < 380
        && lastTp.exitId === entry.id
      );
      if (oscillating) {
        ballLike._portalOscillationCount = (ballLike._portalOscillationCount || 0) + 1;
      } else {
        ballLike._portalOscillationCount = 0;
      }

      let outVt = vt;
      let outVn;
      if (exit.portalOneWay) {
        // Force exit through the open side, preserving |vn| so the angle relative
        // to the portal surface is mirrored on the way out.
        outVn = exitOpenSign * Math.abs(vn);
      } else {
        // Two-way portal: pass straight through (normal direction preserved).
        outVn = vn;
      }

      if (oscillating) {
        const osc = ballLike._portalOscillationCount;
        // Small tangent perturbation to break perfect ping-pong symmetry.
        // Grows slowly with repeats; never large enough to feel like a kick.
        const jitterMag = 0.3 + osc * 0.18;
        outVt += (Math.random() - 0.5) * 2 * jitterMag;
        // Only enforce a normal floor for genuinely slow exits, and only after
        // we've actually been bouncing repeatedly. Don't accelerate fast balls.
        if (osc >= 2) {
          const minNormalSpeed = 1.0 + (osc - 2) * 0.4;
          if (Math.abs(outVn) < minNormalSpeed) {
            const sign = outVn >= 0 ? 1 : -1;
            outVn = sign * minNormalSpeed;
          }
        }
      }

      ballLike.vx = outVt * cOut + outVn * (-sOut);
      ballLike.vy = outVt * sOut + outVn * cOut;

      ballLike._lastPortalTeleport = { entryId: entry.id, exitId: exit.id, atMs: teleportNow };

      ballLike.portalCooldown = 6;
      this._clampBallLikeSpeed(ballLike);
      return { entry, exit };
    }

    return previewOnly ? null : false;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.ballLossY = height + 50;
    this.bucket.y = height - 25;
  }

  update(dtSeconds = 1 / 60) {
    if (!this.balls || this.balls.length === 0) {
      return { hitEvents: [], contactEvents: [], ballsRemaining: 0, bucketCatchCount: 0 };
    }

    const hitEvents = [];
    const contactEvents = [];
    const contactKeys = new Set();
    this._buildPegGrid();

    // Maximum pixels a ball may travel per sub-step.
    // Must be smaller than the thinnest collidable object (~8 px flipper bar).
    const MAX_STEP_PX = 4;

    // Update ball physics with sub-stepping to prevent tunneling
    for (const ball of this.balls) {
      if (!ball.active || ball.ultraAimStuck) continue;

      // Phase 1 — velocity (gravity, friction, clamp). No position change yet.
      ball.updateVelocity();

      // Determine sub-step count based on the faster of:
      // (a) how far the ball travels this frame, or
      // (b) how far the flipper tip sweeps this frame (if flippers are active).
      // This prevents the flipper from sweeping through the ball in one step.
      const frameSpeed = ball.getFrameSpeed();
      let maxMovePx = frameSpeed;
      if (this.flippers && this.flippers.enabled) {
        const f = this.flippers;
        const prevT = f._prevT ?? (f._flipperT || 0);
        const curT = f._flipperT || 0;
        const tDelta = Math.abs(curT - prevT);
        if (tDelta > 0.001) {
          const sc = Number.isFinite(f.scale) ? f.scale : FLIPPER_DEFAULTS.scale;
          const len = (Number.isFinite(f.length) ? f.length : FLIPPER_DEFAULTS.length) * sc;
          const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : FLIPPER_DEFAULTS.restAngle) * Math.PI / 180;
          const flipRad = (Number.isFinite(f.flipAngle) ? f.flipAngle : FLIPPER_DEFAULTS.flipAngle) * Math.PI / 180;
          const angleRange = restRad + flipRad;
          // Tip sweep distance = length * angular change (in radians)
          const tipSweep = len * tDelta * angleRange;
          maxMovePx = Math.max(maxMovePx, tipSweep);

          // Reserve extra sub-steps for the post-contact speed a moving flipper can inject.
          const tipSpeed = len * tDelta * angleRange;
          const flipperBounce = f.bounce ?? PHYSICS_CONFIG.bounce;
          const projected = frameSpeed + tipSpeed * (0.8 + flipperBounce * 0.6);
          maxMovePx = Math.max(maxMovePx, projected);
        }
      }
      const numSteps = Math.max(1, Math.ceil(maxMovePx / MAX_STEP_PX));
      const frac = 1 / numSteps;

      for (let step = 0; step < numSteps; step++) {
        // Phase 2 — advance position by one sub-step
        const prevX = ball.x;
        const prevY = ball.y;
        ball.stepPosition(frac);

        this.handleWallCollisions(ball);
        // Pass sub-step progress so flipper angle is interpolated between
        // its previous and current frame positions (prevents sweep-through).
        this.checkFlipperCollisions(ball, (step + 1) / numSteps, frac);
        const portalResult = this.tryPortalTeleport(ball, prevX, prevY);
        if (portalResult && portalResult.entry) {
          hitEvents.push({ peg: portalResult.entry, ball, ballSide: ball.side || null, portalHit: true, portalExit: portalResult.exit || null });
          if (portalResult.exit) {
            hitEvents.push({ peg: portalResult.exit, ball, ballSide: ball.side || null, portalHit: true });
          }
        }

        // Peg collisions - portals are line triggers and do not collide.
        const candidates = this._getPegCandidateIndices(ball);
        const pegSource = candidates ? null : this.pegs;
        if (candidates) {
          for (let ci = 0; ci < candidates.length; ci++) {
            const peg = this.pegs[candidates[ci]];
            if (!peg) continue;
            const collisionResult = this._detectPegCollision(ball, peg);
            const collision = collisionResult?.collision || null;

            if (collision) {
              this._snapPegToCollisionPose(peg, collisionResult.pose);
              const impact = this.buildPegImpact(ball, collision);
              this.resolveCollision(ball, collision, peg);
              const contactKey = `${ball.id}:${peg.id}`;
              if (!contactKeys.has(contactKey)) {
                contactKeys.add(contactKey);
                contactEvents.push({ peg, ball, ballSide: ball.side || null, impact });
              }

              const isBumper = peg.type === 'bumper';

              if (isBumper) {
                hitEvents.push({ peg, ball, ballSide: ball.side || null, impact, isBumper: true, bumperAnimOnly: true });
              } else if (peg.type === 'obstacle') {
                hitEvents.push({ peg, ball, ballSide: ball.side || null, impact, obstacleHit: true });
              }

              const isPermanentBumper = isBumper && !peg.bumperDisappear && !peg.bumperOrange;
              if (peg.type !== 'obstacle' && !isPermanentBumper && !this.hitPegs.has(peg.id)) {
                this.hitPegs.add(peg.id);
                hitEvents.push({ peg, ball, ballSide: ball.side || null, impact });
              }
            }
          }
        } else if (pegSource && pegSource.length > 0) {
          for (const peg of pegSource) {
            if (this.isPortalPeg(peg)) continue;
            const collisionResult = this._detectPegCollision(ball, peg);
            const collision = collisionResult?.collision || null;

            if (collision) {
              this._snapPegToCollisionPose(peg, collisionResult.pose);
              const impact = this.buildPegImpact(ball, collision);
              this.resolveCollision(ball, collision, peg);
              const contactKey = `${ball.id}:${peg.id}`;
              if (!contactKeys.has(contactKey)) {
                contactKeys.add(contactKey);
                contactEvents.push({ peg, ball, ballSide: ball.side || null, impact });
              }

              const isBumper = peg.type === 'bumper';

              if (isBumper) {
                hitEvents.push({ peg, ball, ballSide: ball.side || null, impact, isBumper: true, bumperAnimOnly: true });
              } else if (peg.type === 'obstacle') {
                hitEvents.push({ peg, ball, ballSide: ball.side || null, impact, obstacleHit: true });
              }

              const isPermanentBumper = isBumper && !peg.bumperDisappear && !peg.bumperOrange;
              if (peg.type !== 'obstacle' && !isPermanentBumper && !this.hitPegs.has(peg.id)) {
                this.hitPegs.add(peg.id);
                hitEvents.push({ peg, ball, ballSide: ball.side || null, impact });
              }
            }
          }
        }
      }
    }

    // Ball-ball collisions
    this.handleBallCollisions();

    // Update bucket position
    this.updateBucket(dtSeconds);

    // Check for bucket catches and ball losses
    let bucketCatchCount = 0;
    let activeRemaining = 0;
    const remaining = [];
    for (const ball of this.balls) {
      if (!ball.active) {
        remaining.push(ball);
        continue;
      }
      if (ball.ultraAimStuck) {
        remaining.push(ball);
        activeRemaining++;
        continue;
      }
      if (this.checkBucketCatch(ball)) {
        bucketCatchCount++;
        continue;
      }
      const lossYMin = Number.isFinite(ball.lossYMin) ? ball.lossYMin : -Infinity;
      const lossYMax = Number.isFinite(ball.lossYMax) ? ball.lossYMax : this.ballLossY;
      const ballLost = ball.y < lossYMin || ball.y > lossYMax || ball.stuck;
      if (!ballLost) {
        remaining.push(ball);
        activeRemaining++;
      }
    }
    // Preserve array reference
    this.balls.length = 0;
    for (const ball of remaining) {
      this.balls.push(ball);
    }

    return {
      hitEvents,
      contactEvents,
      ballsRemaining: activeRemaining,
      bucketCatchCount
    };
  }

  buildPegImpact(ball, collision) {
    if (!ball || !collision) return null;
    return {
      vx: ball.vx,
      vy: ball.vy,
      speed: Utils.magnitude(ball.vx, ball.vy),
      normalX: -collision.normal.x,
      normalY: -collision.normal.y
    };
  }

  handleWallCollisions(ball) {
    const bounce = PHYSICS_CONFIG.bounce;
    
    // Left wall
    if (ball.x - ball.radius < 0) {
      ball.x = ball.radius;
      ball.vx = Math.abs(ball.vx) * bounce;
    }
    
    // Right wall
    if (ball.x + ball.radius > this.width) {
      ball.x = this.width - ball.radius;
      ball.vx = -Math.abs(ball.vx) * bounce;
    }
    
    // Top wall. Survival knockback can reveal negative world-space above the
    // original board top, so the boundary is allowed to follow that viewport.
    const topY = Number.isFinite(this.ballTopY) ? this.ballTopY : 0;
    if (!Number.isFinite(ball.lossYMin) && ball.y - ball.radius < topY) {
      ball.y = topY + ball.radius;
      ball.vy = Math.abs(ball.vy) * bounce;
    }
  }

  resolveCollision(ball, collision, peg = null) {
    const { normal, depth, relativeVelocityNormal } = collision;
    const surfaceSlide = this.getDestructionSurfaceSlide(ball, normal, peg);
    const impactSpeed = Math.max(0, -relativeVelocityNormal);
    const ballSpeed = Utils.magnitude(ball.vx, ball.vy);
    const dynamicDestructionPeg = !!(peg && (peg._destructionAwake || peg._destructionFalling));
    const gentleSurfaceSlide = !!surfaceSlide
      && !dynamicDestructionPeg
      && impactSpeed < 0.85
      && ballSpeed < 4.2;
    // Use bumper's custom bounce if available
    const rawBounce = (peg && peg.type === 'bumper' && peg.bumperBounce != null)
      ? peg.bumperBounce
      : dynamicDestructionPeg && Number.isFinite(this.destructionContactSettings?.dynamicPegBallBounce)
      ? this.destructionContactSettings.dynamicPegBallBounce
      : PHYSICS_CONFIG.bounce;
    const bounce = gentleSurfaceSlide
      ? Math.min(rawBounce, 0.2 + (1 - surfaceSlide.support) * 0.18)
      : rawBounce;

    // Separate ball from peg
    ball.x += normal.x * (depth + 0.5);
    ball.y += normal.y * (depth + 0.5);

    // Reflect velocity
    ball.vx -= (1 + bounce) * relativeVelocityNormal * normal.x;
    ball.vy -= (1 + bounce) * relativeVelocityNormal * normal.y;

    // Add slight randomness to prevent perfect loops
    const jitter = gentleSurfaceSlide ? 0.035 : 0.3;
    ball.vx += (Math.random() - 0.5) * jitter;
    ball.vy += (Math.random() - 0.5) * jitter;
    if (surfaceSlide) {
      this.applyDestructionSurfaceSlide(ball, surfaceSlide);
    }
    this.clampBallSpeed(ball);
  }

  getDestructionSurfaceSlide(ball, normal, peg = null) {
    if (!this.destructionContactSettings || !ball || !normal) return null;
    if (peg && this.isPortalPeg(peg)) return null;
    const gx = getGravityX(ball);
    const gy = getGravityY(ball);
    const gravityMag = Math.hypot(gx, gy);
    if (gravityMag <= 0.0001) return null;
    const gnx = gx / gravityMag;
    const gny = gy / gravityMag;
    const gDotN = gnx * normal.x + gny * normal.y;
    const support = -gDotN;
    if (support <= 0.35) return null;
    const tangentX = gnx - normal.x * gDotN;
    const tangentY = gny - normal.y * gDotN;
    const tangentMag = Math.hypot(tangentX, tangentY);
    if (tangentMag <= 0.0001) return null;
    return {
      tx: tangentX / tangentMag,
      ty: tangentY / tangentMag,
      tangentMag,
      gravityMag,
      support,
      grip: this.destructionContactSettings.surfaceGrip
    };
  }

  applyDestructionSurfaceSlide(ball, slide) {
    const slideFactor = 0.18 + (1 - slide.grip) * 0.92;
    const accel = slide.gravityMag * slide.tangentMag * slide.support * slideFactor;
    const tangentSpeed = ball.vx * slide.tx + ball.vy * slide.ty;
    const maxTangentSpeed = PHYSICS_CONFIG.maxVelocity * 0.72;
    if (tangentSpeed < maxTangentSpeed) {
      ball.vx += slide.tx * accel;
      ball.vy += slide.ty * accel;
    }
    if (Math.abs(tangentSpeed) < 0.28 && slide.tangentMag > 0.08) {
      ball.stuckFrames = Math.max(0, (ball.stuckFrames || 0) - 6);
      ball.stuck = false;
    }
  }

  clampBallSpeed(ball, maxSpeedOverride = null) {
    if (!ball) return;
    const speed = Utils.magnitude(ball.vx, ball.vy);
    const boost = ball.speedCapBoost || 0;
    const maxSpeed = maxSpeedOverride ?? (PHYSICS_CONFIG.maxVelocity + boost);
    if (speed <= maxSpeed) return;
    const scale = maxSpeed / speed;
    ball.vx *= scale;
    ball.vy *= scale;
  }

  handleBallCollisions() {
    if (!this.balls || this.balls.length < 2) return;

    for (let i = 0; i < this.balls.length; i++) {
      const a = this.balls[i];
      if (!a.active || a.ultraAimStuck) continue;
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j];
        if (!b.active || b.ultraAimStuck) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.radius + b.radius;
        if (dist === 0 || dist >= minDist) continue;

        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;

        // Separate balls
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;

        // Relative velocity along normal
        const dvx = b.vx - a.vx;
        const dvy = b.vy - a.vy;
        const relVel = dvx * nx + dvy * ny;
        if (relVel > 0) continue;

        const restitution = PHYSICS_CONFIG.bounce;
        const impulse = -(1 + restitution) * relVel * 0.5; // equal mass

        const ix = impulse * nx;
        const iy = impulse * ny;

        a.vx -= ix;
        a.vy -= iy;
        b.vx += ix;
        b.vy += iy;

        // Small jitter to avoid sticking. PVP can opt out so replay keyframes
        // are sourced from a cleaner simulator state.
        if (!a.disableCollisionJitter && !b.disableCollisionJitter) {
          a.vx += (Math.random() - 0.5) * 0.1;
          a.vy += (Math.random() - 0.5) * 0.1;
          b.vx += (Math.random() - 0.5) * 0.1;
          b.vy += (Math.random() - 0.5) * 0.1;
        }
        this.clampBallSpeed(a);
        this.clampBallSpeed(b);
      }
    }
  }

  updateBucket(dtSeconds = 1 / 60) {
    if (!this.bucketEnabled) return;
    const timeScale = PHYSICS_CONFIG.timeScale;
    const b = this.bucket;
    const halfW = b.width / 2;
    // Advance phase — speed maps to angular velocity
    // Full cycle = left edge → right edge → left edge
    // Range of motion: halfW to (this.width - halfW)
    const range = this.width - b.width;
    const baseStep = 1 / 60;
    const dt = Number.isFinite(dtSeconds) ? dtSeconds : baseStep;
    const stepScale = dt / baseStep;
    // Angular speed: speed * timeScale mapped so the visual speed feels similar
    b._phase += ((b.speed * timeScale * Math.PI) / (range || 1)) * stepScale;
    // x oscillates with sine easing (smooth at edges)
    b.x = halfW + range * (0.5 + 0.5 * Math.sin(b._phase));
  }

  checkBucketCatch(ball) {
    if (!this.bucketEnabled) return false;
    if (!ball || !ball.active) return false;
    const bucket = this.bucket;

    const inXRange = ball.x > bucket.x - bucket.width / 2 && 
                     ball.x < bucket.x + bucket.width / 2;
    const inYRange = ball.y + ball.radius > bucket.y - bucket.height / 2 &&
                     ball.y < bucket.y + bucket.height / 2;

    return inXRange && inYRange;
  }

  updateFlippers(dt) {
    if (!this.flippers || !this.flippers.enabled) return;
    const f = this.flippers;

    // Store previous T so the physics sub-step loop can interpolate between
    // the old and new flipper angles (prevents the flipper from "teleporting"
    // through the ball in a single frame).
    f._prevT = f._flipperT || 0;

    // Animate flip position: activated → quickly move toward 1, else decay toward 0
    const speed = f._flipperActivated ? 14 : 6;
    const target = f._flipperActivated ? 1 : 0;
    f._flipperT = f._flipperT || 0;
    const prevT = f._flipperT;
    f._flipperT += (target - f._flipperT) * Math.min(1, speed * dt);
    if (Math.abs(f._flipperT - target) < 0.01) f._flipperT = target;
    f._angularDelta = f._flipperT - prevT;
  }

  checkFlipperCollisions(ball, subStepFrac, subStepSize = 1) {
    if (!this.flippers || !this.flippers.enabled) return;
    const f = this.flippers;
    const centerX = this.width / 2;
    const prevT = f._prevT ?? (f._flipperT || 0);
    const curT = f._flipperT || 0;
    const safeStepSize = Math.max(0, Math.min(1, subStepSize));
    const sampleFrac = Utils.clamp((subStepFrac ?? 1) - safeStepSize * 0.5, 0, 1);
    // Interpolate flipper angle to match this sub-step's progress through the frame.
    // This way, if the flipper sweeps from angle A to B in one frame, each sub-step
    // checks the flipper at an intermediate angle — preventing sweep-through tunneling.
    const t = prevT + (curT - prevT) * sampleFrac;
    const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : FLIPPER_DEFAULTS.restAngle) * Math.PI / 180;
    const flipRad = (Number.isFinite(f.flipAngle) ? f.flipAngle : FLIPPER_DEFAULTS.flipAngle) * Math.PI / 180;
    const angleRange = restRad + flipRad;
    const sc = Number.isFinite(f.scale) ? f.scale : FLIPPER_DEFAULTS.scale;
    const length = (Number.isFinite(f.length) ? f.length : FLIPPER_DEFAULTS.length) * sc;
    const w = (Number.isFinite(f.width) ? f.width : FLIPPER_DEFAULTS.width) * sc;
    const xOffset = Number.isFinite(f.xOffset) ? f.xOffset : FLIPPER_DEFAULTS.xOffset;
    const y = Number.isFinite(f.y) ? f.y : (this.height - 55);
    const subTDelta = (curT - prevT) * safeStepSize;
    const bounce = f.bounce ?? PHYSICS_CONFIG.bounce;

    // Left flipper
    const leftPivotX = centerX - xOffset;
    const leftAngle = restRad - t * angleRange;
    this._checkSingleFlipperCollision(
      ball, leftPivotX, y, leftAngle, length, w, -subTDelta * angleRange, safeStepSize, bounce
    );

    // Right flipper (mirrored)
    const rightPivotX = centerX + xOffset;
    const rightAngle = Math.PI - leftAngle;
    this._checkSingleFlipperCollision(
      ball, rightPivotX, y, rightAngle, length, w, subTDelta * angleRange, safeStepSize, bounce
    );
  }

  _checkSingleFlipperCollision(ball, pivotX, pivotY, angle, length, width, angDeltaRad, subStepSize, bounce) {
    const flipCenterX = pivotX + Math.cos(angle) * length / 2;
    const flipCenterY = pivotY + Math.sin(angle) * length / 2;

    const collision = circleRectOverlap(ball, {
      x: flipCenterX, y: flipCenterY, angle, width: length, height: width
    });

    if (!collision) return;

    // Determine the flipper's "top" surface normal — the side facing
    // upward in canvas (more negative Y). Two perpendiculars to the bar:
    //   A = (-sin(a), cos(a))     B = (sin(a), -cos(a))
    // Pick whichever has a smaller Y component (points more "up").
    const sinA = Math.sin(angle), cosA = Math.cos(angle);
    const topNx = cosA > 0 ? sinA : -sinA;   // simplified: pick by Y sign
    const topNy = cosA > 0 ? -cosA : cosA;

    // If the geometric normal points toward the underside, override it
    // with the top normal. This prevents the flipper from pushing the
    // ball downward when it sweeps up through it.
    let nx = collision.normal.x;
    let ny = collision.normal.y;
    const dot = nx * topNx + ny * topNy;
    if (dot < 0) {
      nx = topNx;
      ny = topNy;
    }

    // Separate ball from flipper along the corrected normal
    ball.x += nx * (collision.depth + 0.5);
    ball.y += ny * (collision.depth + 0.5);

    // Use rigid-body relative velocity against a moving flipper surface:
    // v_rel = v_ball - v_surface, where v_surface = w x r at the contact radius.
    const step = Math.max(subStepSize, 0.0001);
    const omega = angDeltaRad / step; // radians per frame
    const rx = ball.x - pivotX;
    const ry = ball.y - pivotY;
    const surfaceVx = -omega * ry;
    const surfaceVy = omega * rx;

    const relVx = ball.vx - surfaceVx;
    const relVy = ball.vy - surfaceVy;
    const relN = relVx * nx + relVy * ny;

    if (relN < 0) {
      const impulse = -(1 + bounce) * relN;
      ball.vx += impulse * nx;
      ball.vy += impulse * ny;
    }

    // Mild tangential grip so spin direction depends on hit location and flipper motion.
    const tx = -ny;
    const ty = nx;
    const relT = relVx * tx + relVy * ty;
    const grip = 0.08;
    ball.vx -= relT * tx * grip;
    ball.vy -= relT * ty * grip;

    const surfaceSpeed = Math.sqrt(surfaceVx * surfaceVx + surfaceVy * surfaceVy);
    const extraCap = Math.min(PHYSICS_CONFIG.maxVelocity * 1.1, surfaceSpeed * (0.5 + bounce * 0.25));
    ball.speedCapBoost = Math.max(ball.speedCapBoost || 0, extraCap);
    this.clampBallSpeed(ball);
  }

  _getFlipperRectsAtT(tOverride = null) {
    if (!this.flippers || !this.flippers.enabled) return [];
    const f = this.flippers;
    const centerX = this.width / 2;
    const t = Number.isFinite(tOverride) ? tOverride : (f._flipperT || 0);
    const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : FLIPPER_DEFAULTS.restAngle) * Math.PI / 180;
    const flipRad = (Number.isFinite(f.flipAngle) ? f.flipAngle : FLIPPER_DEFAULTS.flipAngle) * Math.PI / 180;
    const sc = Number.isFinite(f.scale) ? f.scale : FLIPPER_DEFAULTS.scale;
    const length = (Number.isFinite(f.length) ? f.length : FLIPPER_DEFAULTS.length) * sc;
    const w = (Number.isFinite(f.width) ? f.width : FLIPPER_DEFAULTS.width) * sc;
    const xOffset = Number.isFinite(f.xOffset) ? f.xOffset : FLIPPER_DEFAULTS.xOffset;
    const y = Number.isFinite(f.y) ? f.y : (this.height - 55);

    const leftPivotX = centerX - xOffset;
    const leftAngle = restRad - t * (restRad + flipRad);
    const rightPivotX = centerX + xOffset;
    const rightAngle = Math.PI - leftAngle;

    return [
      { id: 'left', x: leftPivotX + Math.cos(leftAngle) * length / 2, y: y + Math.sin(leftAngle) * length / 2, angle: leftAngle, width: length, height: w },
      { id: 'right', x: rightPivotX + Math.cos(rightAngle) * length / 2, y: y + Math.sin(rightAngle) * length / 2, angle: rightAngle, width: length, height: w }
    ];
  }

  getFlipperRects() {
    return this._getFlipperRectsAtT();
  }

  getFlipperKinematicRects() {
    if (!this.flippers || !this.flippers.enabled) return [];
    const f = this.flippers;
    const prevT = f._prevT ?? (f._flipperT || 0);
    const curT = f._flipperT || 0;
    const prev = this._getFlipperRectsAtT(prevT);
    const current = this._getFlipperRectsAtT(curT);
    return current.map((rect, index) => {
      const prevRect = prev[index] || rect;
      return {
        ...rect,
        vx: rect.x - prevRect.x,
        vy: rect.y - prevRect.y
      };
    });
  }

  getHitPegIds() {
    return Array.from(this.hitPegs);
  }

  clearHitPegs() {
    this.hitPegs.clear();
  }

  // Trajectory prediction — uses current peg positions (already animated by the game loop).
  // Recalculated every frame during aiming, so it naturally tracks animated pegs.
  predictTrajectory(startX, startY, angle, power, maxSteps = 500, stopAtFirstHit = true, options = null) {
    const points = [];
    const simulatedHits = [];
    const timeScale = PHYSICS_CONFIG.timeScale;
    const frictionScale = Math.pow(PHYSICS_CONFIG.friction, timeScale);
    const flipperBounce = (this.flippers && this.flippers.bounce != null)
      ? this.flippers.bounce : PHYSICS_CONFIG.bounce;
    const MAX_STEP_PX = 4; // match actual physics sub-step size
    const stopAtWallHit = options?.stopAtWallHit === true;

    // Create simulated ball
    const simBall = {
      x: startX,
      y: startY,
      vx: Math.cos(angle) * power,
      vy: Math.sin(angle) * power,
      radius: getBallRadius(),
      portalCooldown: 0,
      speedCapBoost: 0,
      gravityVector: options?.gravityVector || null,
      lossYMin: Number.isFinite(options?.lossYMin) ? options.lossYMin : null
    };

    this._buildPegGrid();

    for (let i = 0; i < maxSteps; i++) {
      points.push({ x: simBall.x, y: simBall.y });

      // Phase 1: update velocity (gravity + friction + speed clamp) — matching Ball.updateVelocity()
      simBall.vx += getGravityX(simBall) * timeScale;
      simBall.vy += getGravityY(simBall) * timeScale;
      simBall.vx *= frictionScale;
      simBall.vy *= frictionScale;

      // Speed clamp — matches Ball.updateVelocity() maxSpeed check
      const speed = Math.sqrt(simBall.vx * simBall.vx + simBall.vy * simBall.vy);
      const maxSpeed = PHYSICS_CONFIG.maxVelocity + (simBall.speedCapBoost || 0);
      if (speed > maxSpeed) {
        const sc = maxSpeed / speed;
        simBall.vx *= sc;
        simBall.vy *= sc;
      }
      // Decay speedCapBoost like actual physics
      if (simBall.speedCapBoost > 0) {
        simBall.speedCapBoost *= 0.9;
        if (simBall.speedCapBoost < 0.05) simBall.speedCapBoost = 0;
      }
      if (simBall.portalCooldown > 0) simBall.portalCooldown--;

      // Phase 2: sub-stepped position advancement — matching actual physics
      const frameSpeed = Math.sqrt(simBall.vx * simBall.vx + simBall.vy * simBall.vy) * timeScale;
      const numSteps = Math.max(1, Math.ceil(frameSpeed / MAX_STEP_PX));
      const frac = 1 / numSteps;

      let stopped = false;
      for (let step = 0; step < numSteps; step++) {
        const prevX = simBall.x;
        const prevY = simBall.y;
        simBall.x += simBall.vx * timeScale * frac;
        simBall.y += simBall.vy * timeScale * frac;

        // Wall collisions
        if (simBall.x - simBall.radius < 0) {
          simBall.x = simBall.radius;
          if (stopAtWallHit) {
            points.push({ x: simBall.x, y: simBall.y });
            return { points, hits: simulatedHits };
          }
          simBall.vx = Math.abs(simBall.vx) * PHYSICS_CONFIG.bounce;
        }
        if (simBall.x + simBall.radius > this.width) {
          simBall.x = this.width - simBall.radius;
          if (stopAtWallHit) {
            points.push({ x: simBall.x, y: simBall.y });
            return { points, hits: simulatedHits };
          }
          simBall.vx = -Math.abs(simBall.vx) * PHYSICS_CONFIG.bounce;
        }
        const topY = Number.isFinite(this.ballTopY) ? this.ballTopY : 0;
        if (!Number.isFinite(simBall.lossYMin) && simBall.y - simBall.radius < topY) {
          simBall.y = topY + simBall.radius;
          if (stopAtWallHit) {
            points.push({ x: simBall.x, y: simBall.y });
            return { points, hits: simulatedHits };
          }
          simBall.vy = Math.abs(simBall.vy) * PHYSICS_CONFIG.bounce;
        }

        // Portal check
        const portalHit = this.tryPortalTeleport(simBall, prevX, prevY, { previewOnly: true });
        if (portalHit && portalHit.hit) {
          points.push({ x: portalHit.x, y: portalHit.y });
          stopped = true;
          break;
        }

        // Flipper collisions
        const flipperRects = this.getFlipperRects();
        for (const rect of flipperRects) {
          const collision = circleRectOverlap(simBall, rect);
          if (collision) {
            simBall.x += collision.normal.x * (collision.depth + 0.5);
            simBall.y += collision.normal.y * (collision.depth + 0.5);
            const dvn = simBall.vx * collision.normal.x + simBall.vy * collision.normal.y;
            if (dvn < 0) {
              simBall.vx -= (1 + flipperBounce) * dvn * collision.normal.x;
              simBall.vy -= (1 + flipperBounce) * dvn * collision.normal.y;
            }
            this.clampBallSpeed(simBall);
            break;
          }
        }

        // Peg collisions
        const candidates = this._getPegCandidateIndices(simBall);
        if (candidates) {
          for (let ci = 0; ci < candidates.length; ci++) {
            const peg = this.pegs[candidates[ci]];
            if (!peg || this.isPortalPeg(peg)) continue;
            const collision = this._detectPegCollision(simBall, peg)?.collision || null;

            if (collision) {
              simBall.x += collision.normal.x * (collision.depth + 0.5);
              simBall.y += collision.normal.y * (collision.depth + 0.5);

              const bounce = (peg.type === 'bumper' && peg.bumperBounce != null)
                ? peg.bumperBounce : PHYSICS_CONFIG.bounce;
              simBall.vx -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.x;
              simBall.vy -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.y;
              this.clampBallSpeed(simBall);

              simulatedHits.push({ x: simBall.x, y: simBall.y, pegId: peg.id });

              if (stopAtFirstHit) {
                points.push({ x: simBall.x, y: simBall.y });
                return { points, hits: simulatedHits };
              }
              break;
            }
          }
        } else {
          for (const peg of this.pegs) {
            if (this.isPortalPeg(peg)) continue;
            const collision = this._detectPegCollision(simBall, peg)?.collision || null;

            if (collision) {
              simBall.x += collision.normal.x * (collision.depth + 0.5);
              simBall.y += collision.normal.y * (collision.depth + 0.5);

              const bounce = (peg.type === 'bumper' && peg.bumperBounce != null)
                ? peg.bumperBounce : PHYSICS_CONFIG.bounce;
              simBall.vx -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.x;
              simBall.vy -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.y;
              this.clampBallSpeed(simBall);

              simulatedHits.push({ x: simBall.x, y: simBall.y, pegId: peg.id });

              if (stopAtFirstHit) {
                points.push({ x: simBall.x, y: simBall.y });
                return { points, hits: simulatedHits };
              }
              break;
            }
          }
        }
      } // end sub-step loop

      if (stopped) break;

      // Ball fell below active loss threshold (camera-aware in survival mode)
      if (simBall.y > this.ballLossY || (Number.isFinite(simBall.lossYMin) && simBall.y < simBall.lossYMin)) {
        break;
      }
    }

    return { points, hits: simulatedHits };
  }
}
