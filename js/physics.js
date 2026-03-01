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
  }

  launch(angle, power = PHYSICS_CONFIG.launchPower) {
    this.vx = Math.cos(angle) * power;
    this.vy = Math.sin(angle) * power;
    this.active = true;
    this.stuck = false;
    this.stuckFrames = 0;
    this.speedCapBoost = 0;
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
    this.balls = [];
    this.pegs = [];
    this.hitPegs = new Set(); // Track which pegs were hit (for scoring only)
    this.flippers = null;
    this.bucket = {
      x: width / 2,
      y: height - 25,
      width: 70,
      height: 16,
      direction: 1,
      speed: 1.5
    };
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
  }

  setFlippers(flippers) {
    this.flippers = flippers;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.bucket.y = height - 25;
  }

  update() {
    if (!this.balls || this.balls.length === 0) {
      return { hitEvents: [], ballsRemaining: 0, bucketCatchCount: 0 };
    }

    const hitEvents = [];

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
          const sc = f.scale || 1;
          const len = (f.length || 40) * sc;
          const restRad = (f.restAngle || 25) * Math.PI / 180;
          const flipRad = (f.flipAngle ?? 30) * Math.PI / 180;
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
        ball.stepPosition(frac);

        this.handleWallCollisions(ball);
        // Pass sub-step progress so flipper angle is interpolated between
        // its previous and current frame positions (prevents sweep-through).
        this.checkFlipperCollisions(ball, (step + 1) / numSteps, frac);

        // Peg collisions - ALL pegs are still physically collidable
        for (const peg of this.pegs) {
          let collision;

          if (peg.shape === 'brick') {
            collision = circleRectCollision(ball, peg);
          } else {
            const pegRadius = peg.type === 'bumper'
              ? PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1)
              : PHYSICS_CONFIG.pegRadius;
            collision = Utils.circleCollision(ball, {
              x: peg.x,
              y: peg.y,
              radius: pegRadius
            });
          }

          if (collision) {
            this.resolveCollision(ball, collision, peg);

            const isBumper = peg.type === 'bumper';

            if (isBumper) {
              hitEvents.push({ peg, ball, isBumper: true, bumperAnimOnly: true });
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

    // Ball-ball collisions
    this.handleBallCollisions();

    // Update bucket position
    this.updateBucket();

    // Check for bucket catches and ball losses
    let bucketCatchCount = 0;
    const remaining = [];
    for (const ball of this.balls) {
      if (!ball.active) continue;
      if (this.checkBucketCatch(ball)) {
        bucketCatchCount++;
        continue;
      }
      const ballLost = ball.y > this.height + 50 || ball.stuck;
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

  updateBucket() {
    const timeScale = PHYSICS_CONFIG.timeScale;
    this.bucket.x += this.bucket.direction * this.bucket.speed * timeScale;
    
    if (this.bucket.x + this.bucket.width / 2 > this.width) {
      this.bucket.direction = -1;
    } else if (this.bucket.x - this.bucket.width / 2 < 0) {
      this.bucket.direction = 1;
    }
  }

  checkBucketCatch(ball) {
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
    const restRad = (f.restAngle || 25) * Math.PI / 180;
    const flipRad = (f.flipAngle ?? 30) * Math.PI / 180;
    const angleRange = restRad + flipRad;
    const sc = f.scale || 1;
    const length = (f.length || 40) * sc;
    const w = (f.width || 8) * sc;
    const subTDelta = (curT - prevT) * safeStepSize;
    const bounce = f.bounce ?? PHYSICS_CONFIG.bounce;

    // Left flipper
    const leftPivotX = centerX - f.xOffset;
    const leftAngle = restRad - t * angleRange;
    this._checkSingleFlipperCollision(
      ball, leftPivotX, f.y, leftAngle, length, w, -subTDelta * angleRange, safeStepSize, bounce
    );

    // Right flipper (mirrored)
    const rightPivotX = centerX + f.xOffset;
    const rightAngle = Math.PI - leftAngle;
    this._checkSingleFlipperCollision(
      ball, rightPivotX, f.y, rightAngle, length, w, subTDelta * angleRange, safeStepSize, bounce
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
    const restRad = (f.restAngle || 25) * Math.PI / 180;
    const flipRad = (f.flipAngle ?? 30) * Math.PI / 180;
    const sc = f.scale || 1;
    const length = (f.length || 40) * sc;
    const w = (f.width || 8) * sc;

    const leftPivotX = centerX - f.xOffset;
    const leftAngle = restRad - t * (restRad + flipRad);
    const rightPivotX = centerX + f.xOffset;
    const rightAngle = Math.PI - leftAngle;

    return [
      { x: leftPivotX + Math.cos(leftAngle) * length / 2, y: f.y + Math.sin(leftAngle) * length / 2, angle: leftAngle, width: length, height: w },
      { x: rightPivotX + Math.cos(rightAngle) * length / 2, y: f.y + Math.sin(rightAngle) * length / 2, angle: rightAngle, width: length, height: w }
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
    let x = startX;
    let y = startY;
    let vx = Math.cos(angle) * power;
    let vy = Math.sin(angle) * power;
    const radius = getBallRadius();

    for (let i = 0; i < maxSteps; i++) {
      points.push({ x, y });

      // Apply physics
      vy += PHYSICS_CONFIG.gravity;
      vx *= PHYSICS_CONFIG.friction;
      vy *= PHYSICS_CONFIG.friction;

      x += vx;
      y += vy;

      // Wall collisions
      if (x - radius < 0) {
        x = radius;
        vx = Math.abs(vx) * PHYSICS_CONFIG.bounce;
      }
      if (x + radius > this.width) {
        x = this.width - radius;
        vx = -Math.abs(vx) * PHYSICS_CONFIG.bounce;
      }
      if (y - radius < 0) {
        y = radius;
        vy = Math.abs(vy) * PHYSICS_CONFIG.bounce;
      }

      // Check peg collisions
      for (const peg of this.pegs) {
        let collision;

        if (peg.shape === 'brick') {
          collision = circleRectCollision({ x, y, vx, vy, radius }, peg);
        } else {
          const pegRadius = peg.type === 'bumper'
            ? PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1)
            : PHYSICS_CONFIG.pegRadius;
          collision = Utils.circleCollision({ x, y, vx, vy, radius }, {
            x: peg.x,
            y: peg.y,
            radius: pegRadius
          });
        }

        if (collision) {
          // Resolve collision for continued simulation
          x += collision.normal.x * (collision.depth + 0.5);
          y += collision.normal.y * (collision.depth + 0.5);

          const bounce = PHYSICS_CONFIG.bounce;
          vx -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.x;
          vy -= (1 + bounce) * collision.relativeVelocityNormal * collision.normal.y;

          simulatedHits.push({ x, y, pegId: peg.id });

          if (stopAtFirstHit) {
            points.push({ x, y });
            return { points, hits: simulatedHits };
          }
          break;
        }
      }

      // Stop trajectory at flippers — user controls them so prediction beyond is meaningless
      const flipperRects = this.getFlipperRects();
      let hitFlipper = false;
      for (const rect of flipperRects) {
        const collision = circleRectOverlap({ x, y, radius }, rect);
        if (collision) {
          points.push({ x, y });
          hitFlipper = true;
          break;
        }
      }
      if (hitFlipper) break;

      // Ball fell below screen
      if (y > this.height + 50) {
        break;
      }
    }

    return { points, hits: simulatedHits };
  }
}
