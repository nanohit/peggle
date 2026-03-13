// Peggle Physics Engine - Custom lightweight physics

import { Utils } from './utils.js';

// Default physics config - can be modified at runtime
export const PHYSICS_CONFIG = {
  gravity: 0.12,
  friction: 0.998,
  bounce: 0.65,
  pegRadius: 10,
  maxVelocity: 15,
  launchPower: 8,
  timeScale: 1.0,  // Speed multiplier
  
  // Brick dimensions (when shape is 'brick')
  brickWidth: 40,
  brickHeight: 12
};

// Get ball radius (always same as peg radius)
export function getBallRadius() {
  return PHYSICS_CONFIG.pegRadius;
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
  }

  launch(angle, power = PHYSICS_CONFIG.launchPower) {
    this.vx = Math.cos(angle) * power;
    this.vy = Math.sin(angle) * power;
    this.active = true;
    this.stuck = false;
    this.stuckFrames = 0;
    this.speedCapBoost = 0;
    this.portalCooldown = 0;
    this.radius = getBallRadius();
  }

  // Phase 1: update velocity (gravity, friction, clamp). No position change.
  updateVelocity() {
    if (!this.active) return;

    const timeScale = PHYSICS_CONFIG.timeScale;

    this.vy += PHYSICS_CONFIG.gravity * timeScale;

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
    this.radius = getBallRadius();
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

  isPortalPeg(peg) {
    return peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange');
  }

  getPegCollisionRadius(peg) {
    if (!peg) return PHYSICS_CONFIG.pegRadius;
    if (peg.type === 'bumper') return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
    if (this.isPortalPeg(peg)) return PHYSICS_CONFIG.pegRadius * (peg.portalScale || 1);
    return PHYSICS_CONFIG.pegRadius;
  }

  getPortalHalfLength(portal) {
    if (!portal) return PHYSICS_CONFIG.pegRadius;
    return PHYSICS_CONFIG.pegRadius * (portal.portalScale || 1);
  }

  _getPegGridCellSize() {
    const pegSize = PHYSICS_CONFIG.pegRadius * 4;
    const brickW = PHYSICS_CONFIG.brickWidth || 0;
    const brickH = PHYSICS_CONFIG.brickHeight || 0;
    return Math.max(24, pegSize, brickW, brickH);
  }

  _getPegBounds(peg) {
    if (!peg) return null;
    if (peg.shape === 'brick') {
      const w = Number.isFinite(peg.width) ? peg.width : PHYSICS_CONFIG.brickWidth;
      const h = Number.isFinite(peg.height) ? peg.height : PHYSICS_CONFIG.brickHeight;
      const hw = w / 2;
      const hh = h / 2;
      const angle = peg.angle || 0;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const extX = Math.abs(c) * hw + Math.abs(s) * hh;
      const extY = Math.abs(s) * hw + Math.abs(c) * hh;
      const radius = Math.hypot(extX, extY);
      return {
        minX: peg.x - extX,
        maxX: peg.x + extX,
        minY: peg.y - extY,
        maxY: peg.y + extY,
        radius
      };
    }

    const r = this.getPegCollisionRadius(peg);
    return {
      minX: peg.x - r,
      maxX: peg.x + r,
      minY: peg.y - r,
      maxY: peg.y + r,
      radius: r
    };
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
      if (this.isPortalPeg(peg)) continue;
      const bounds = this._getPegBounds(peg);
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
    const portals = (this.portalPegs && this.portalPegs.length > 0) ? this.portalPegs : this.pegs;
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
      const cOut = Math.cos(exitAngle);
      const sOut = Math.sin(exitAngle);

      // Keep the entry offset along the portal line; place the ball just outside
      // the exit line on the traversed side so portals behave as thin line triggers.
      const localX = crossing.localX;
      const baseOffset = (ballLike.radius || getBallRadius()) + 1.2;
      // One-way portals always eject from their configured open side,
      // never from their blocked gray side.
      const exitBlockedFromPositive = !exit.portalOneWayFlip;
      const openSign = exitBlockedFromPositive ? -1 : 1;
      const localY = exit.portalOneWay ? openSign * baseOffset : crossing.side * baseOffset;
      ballLike.x = exit.x + (localX * cOut - localY * sOut);
      ballLike.y = exit.y + (localX * sOut + localY * cOut);

      // Preserve incoming angle relative to portal orientation.
      const delta = exitAngle - entryAngle;
      const cDelta = Math.cos(delta);
      const sDelta = Math.sin(delta);
      const vx = ballLike.vx;
      const vy = ballLike.vy;
      ballLike.vx = vx * cDelta - vy * sDelta;
      ballLike.vy = vx * sDelta + vy * cDelta;

      if (exit.portalOneWay) {
        this.enforceOneWayExitVelocity(ballLike, exitAngle, exitBlockedFromPositive);
      }

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
      if (!ball.active) continue;

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
          const sc = Number.isFinite(f.scale) ? f.scale : 1.8;
          const len = (Number.isFinite(f.length) ? f.length : 60) * sc;
          const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : 23) * Math.PI / 180;
          const flipRad = (Number.isFinite(f.flipAngle) ? f.flipAngle : 30) * Math.PI / 180;
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
          hitEvents.push({ peg: portalResult.entry, ball, portalHit: true });
          if (portalResult.exit) {
            hitEvents.push({ peg: portalResult.exit, ball, portalHit: true });
          }
        }

        // Peg collisions - portals are line triggers and do not collide.
        const candidates = this._getPegCandidateIndices(ball);
        const pegSource = candidates ? null : this.pegs;
        if (candidates) {
          for (let ci = 0; ci < candidates.length; ci++) {
            const peg = this.pegs[candidates[ci]];
            if (!peg) continue;
            let collision;

            if (peg.shape === 'brick') {
              collision = circleRectCollision(ball, peg);
            } else {
              collision = Utils.circleCollision(ball, {
                x: peg.x,
                y: peg.y,
                radius: this.getPegCollisionRadius(peg)
              });
            }

            if (collision) {
              this.resolveCollision(ball, collision, peg);
              const contactKey = `${ball.id}:${peg.id}`;
              if (!contactKeys.has(contactKey)) {
                contactKeys.add(contactKey);
                contactEvents.push({ peg, ball });
              }

              const isBumper = peg.type === 'bumper';

              if (isBumper) {
                hitEvents.push({ peg, ball, isBumper: true, bumperAnimOnly: true });
              } else if (peg.type === 'obstacle') {
                hitEvents.push({ peg, ball, obstacleHit: true });
              }

              const isPermanentBumper = isBumper && !peg.bumperDisappear && !peg.bumperOrange;
              if (peg.type !== 'obstacle' && !isPermanentBumper && !this.hitPegs.has(peg.id)) {
                this.hitPegs.add(peg.id);
                hitEvents.push({ peg, ball });
              }
            }
          }
        } else if (pegSource && pegSource.length > 0) {
          for (const peg of pegSource) {
            if (this.isPortalPeg(peg)) continue;
            let collision;

            if (peg.shape === 'brick') {
              collision = circleRectCollision(ball, peg);
            } else {
              collision = Utils.circleCollision(ball, {
                x: peg.x,
                y: peg.y,
                radius: this.getPegCollisionRadius(peg)
              });
            }

            if (collision) {
              this.resolveCollision(ball, collision, peg);
              const contactKey = `${ball.id}:${peg.id}`;
              if (!contactKeys.has(contactKey)) {
                contactKeys.add(contactKey);
                contactEvents.push({ peg, ball });
              }

              const isBumper = peg.type === 'bumper';

              if (isBumper) {
                hitEvents.push({ peg, ball, isBumper: true, bumperAnimOnly: true });
              } else if (peg.type === 'obstacle') {
                hitEvents.push({ peg, ball, obstacleHit: true });
              }

              const isPermanentBumper = isBumper && !peg.bumperDisappear && !peg.bumperOrange;
              if (peg.type !== 'obstacle' && !isPermanentBumper && !this.hitPegs.has(peg.id)) {
                this.hitPegs.add(peg.id);
                hitEvents.push({ peg, ball });
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
    const remaining = [];
    for (const ball of this.balls) {
      if (!ball.active) continue;
      if (this.checkBucketCatch(ball)) {
        bucketCatchCount++;
        continue;
      }
      const ballLost = ball.y > this.ballLossY || ball.stuck;
      if (!ballLost) {
        remaining.push(ball);
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
      ballsRemaining: this.balls.length,
      bucketCatchCount
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
    
    // Top wall
    if (ball.y - ball.radius < 0) {
      ball.y = ball.radius;
      ball.vy = Math.abs(ball.vy) * bounce;
    }
  }

  resolveCollision(ball, collision, peg = null) {
    const { normal, depth, relativeVelocityNormal } = collision;
    // Use bumper's custom bounce if available
    const bounce = (peg && peg.type === 'bumper' && peg.bumperBounce != null)
      ? peg.bumperBounce : PHYSICS_CONFIG.bounce;

    // Separate ball from peg
    ball.x += normal.x * (depth + 0.5);
    ball.y += normal.y * (depth + 0.5);

    // Reflect velocity
    ball.vx -= (1 + bounce) * relativeVelocityNormal * normal.x;
    ball.vy -= (1 + bounce) * relativeVelocityNormal * normal.y;

    // Add slight randomness to prevent perfect loops
    ball.vx += (Math.random() - 0.5) * 0.3;
    ball.vy += (Math.random() - 0.5) * 0.3;
    this.clampBallSpeed(ball);
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
      if (!a.active) continue;
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j];
        if (!b.active) continue;

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

        // Small jitter to avoid sticking
        a.vx += (Math.random() - 0.5) * 0.1;
        a.vy += (Math.random() - 0.5) * 0.1;
        b.vx += (Math.random() - 0.5) * 0.1;
        b.vy += (Math.random() - 0.5) * 0.1;
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
    const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : 23) * Math.PI / 180;
    const flipRad = (Number.isFinite(f.flipAngle) ? f.flipAngle : 30) * Math.PI / 180;
    const angleRange = restRad + flipRad;
    const sc = Number.isFinite(f.scale) ? f.scale : 1.8;
    const length = (Number.isFinite(f.length) ? f.length : 60) * sc;
    const w = (Number.isFinite(f.width) ? f.width : 8) * sc;
    const xOffset = Number.isFinite(f.xOffset) ? f.xOffset : 196;
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

  getFlipperRects() {
    if (!this.flippers || !this.flippers.enabled) return [];
    const f = this.flippers;
    const centerX = this.width / 2;
    const t = f._flipperT || 0;
    const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : 23) * Math.PI / 180;
    const flipRad = (Number.isFinite(f.flipAngle) ? f.flipAngle : 30) * Math.PI / 180;
    const sc = Number.isFinite(f.scale) ? f.scale : 1.8;
    const length = (Number.isFinite(f.length) ? f.length : 60) * sc;
    const w = (Number.isFinite(f.width) ? f.width : 8) * sc;
    const xOffset = Number.isFinite(f.xOffset) ? f.xOffset : 196;
    const y = Number.isFinite(f.y) ? f.y : (this.height - 55);

    const leftPivotX = centerX - xOffset;
    const leftAngle = restRad - t * (restRad + flipRad);
    const rightPivotX = centerX + xOffset;
    const rightAngle = Math.PI - leftAngle;

    return [
      { x: leftPivotX + Math.cos(leftAngle) * length / 2, y: y + Math.sin(leftAngle) * length / 2, angle: leftAngle, width: length, height: w },
      { x: rightPivotX + Math.cos(rightAngle) * length / 2, y: y + Math.sin(rightAngle) * length / 2, angle: rightAngle, width: length, height: w }
    ];
  }

  getHitPegIds() {
    return Array.from(this.hitPegs);
  }

  clearHitPegs() {
    this.hitPegs.clear();
  }

  // Trajectory prediction — uses current peg positions (already animated by the game loop).
  // Recalculated every frame during aiming, so it naturally tracks animated pegs.
  predictTrajectory(startX, startY, angle, power, maxSteps = 500, stopAtFirstHit = true) {
    const points = [];
    const simulatedHits = [];

    // Create simulated ball
    const simBall = {
      x: startX,
      y: startY,
      vx: Math.cos(angle) * power,
      vy: Math.sin(angle) * power,
      radius: getBallRadius(),
      portalCooldown: 0,
      speedCapBoost: 0
    };

    for (let i = 0; i < maxSteps; i++) {
      points.push({ x: simBall.x, y: simBall.y });

      // Apply physics
      simBall.vy += PHYSICS_CONFIG.gravity;
      simBall.vx *= PHYSICS_CONFIG.friction;
      simBall.vy *= PHYSICS_CONFIG.friction;
      if (simBall.portalCooldown > 0) simBall.portalCooldown--;

      const prevX = simBall.x;
      const prevY = simBall.y;
      simBall.x += simBall.vx;
      simBall.y += simBall.vy;

      // Wall collisions
      if (simBall.x - simBall.radius < 0) {
        simBall.x = simBall.radius;
        simBall.vx = Math.abs(simBall.vx) * PHYSICS_CONFIG.bounce;
      }
      if (simBall.x + simBall.radius > this.width) {
        simBall.x = this.width - simBall.radius;
        simBall.vx = -Math.abs(simBall.vx) * PHYSICS_CONFIG.bounce;
      }
      if (simBall.y - simBall.radius < 0) {
        simBall.y = simBall.radius;
        simBall.vy = Math.abs(simBall.vy) * PHYSICS_CONFIG.bounce;
      }

      const portalHit = this.tryPortalTeleport(simBall, prevX, prevY, { previewOnly: true });
      if (portalHit && portalHit.hit) {
        points.push({ x: portalHit.x, y: portalHit.y });
        break;
      }

      // Check peg collisions (using spatial grid when available)
      this._buildPegGrid();
      const candidates = this._getPegCandidateIndices(simBall);
      let hitPeg = false;
      if (candidates) {
        for (let ci = 0; ci < candidates.length; ci++) {
          const peg = this.pegs[candidates[ci]];
          if (!peg) continue;
          let collision;

          if (peg.shape === 'brick') {
            collision = circleRectCollision(simBall, peg);
          } else {
            collision = Utils.circleCollision(simBall, {
              x: peg.x,
              y: peg.y,
              radius: this.getPegCollisionRadius(peg)
            });
          }

          if (collision) {
            simBall.x += collision.normal.x * (collision.depth + 0.5);
            simBall.y += collision.normal.y * (collision.depth + 0.5);

            const bounce = PHYSICS_CONFIG.bounce;
            simBall.vx -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.x;
            simBall.vy -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.y;

            simulatedHits.push({ x: simBall.x, y: simBall.y, pegId: peg.id });

            if (stopAtFirstHit) {
              points.push({ x: simBall.x, y: simBall.y });
              return { points, hits: simulatedHits };
            }
            hitPeg = true;
            break;
          }
        }
      } else {
        for (const peg of this.pegs) {
          if (this.isPortalPeg(peg)) continue;
          let collision;

          if (peg.shape === 'brick') {
            collision = circleRectCollision(simBall, peg);
          } else {
            collision = Utils.circleCollision(simBall, {
              x: peg.x,
              y: peg.y,
              radius: this.getPegCollisionRadius(peg)
            });
          }

          if (collision) {
            simBall.x += collision.normal.x * (collision.depth + 0.5);
            simBall.y += collision.normal.y * (collision.depth + 0.5);

            const bounce = PHYSICS_CONFIG.bounce;
            simBall.vx -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.x;
            simBall.vy -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.y;

            simulatedHits.push({ x: simBall.x, y: simBall.y, pegId: peg.id });

            if (stopAtFirstHit) {
              points.push({ x: simBall.x, y: simBall.y });
              return { points, hits: simulatedHits };
            }
            hitPeg = true;
            break;
          }
        }
      }

      // Stop trajectory at flippers — user controls them so prediction beyond is meaningless
      const flipperRects = this.getFlipperRects();
      let hitFlipper = false;
      for (const rect of flipperRects) {
        const collision = circleRectOverlap(simBall, rect);
        if (collision) {
          points.push({ x: simBall.x, y: simBall.y });
          hitFlipper = true;
          break;
        }
      }
      if (hitFlipper) break;

      // Ball fell below active loss threshold (camera-aware in survival mode)
      if (simBall.y > this.ballLossY) {
        break;
      }
    }

    return { points, hits: simulatedHits };
  }
}
