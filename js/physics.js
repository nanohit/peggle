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
  }

  launch(angle, power = PHYSICS_CONFIG.launchPower) {
    this.vx = Math.cos(angle) * power;
    this.vy = Math.sin(angle) * power;
    this.active = true;
    this.stuck = false;
    this.stuckFrames = 0;
    this.radius = getBallRadius();
  }

  update() {
    if (!this.active) return;

    const timeScale = PHYSICS_CONFIG.timeScale;

    // Apply gravity (scaled)
    this.vy += PHYSICS_CONFIG.gravity * timeScale;

    // Apply friction
    const frictionScale = Math.pow(PHYSICS_CONFIG.friction, timeScale);
    this.vx *= frictionScale;
    this.vy *= frictionScale;

    // Clamp velocity
    const speed = Utils.magnitude(this.vx, this.vy);
    if (speed > PHYSICS_CONFIG.maxVelocity) {
      const scale = PHYSICS_CONFIG.maxVelocity / speed;
      this.vx *= scale;
      this.vy *= scale;
    }

    // Update position (scaled)
    this.x += this.vx * timeScale;
    this.y += this.vy * timeScale;

    // Detect if ball is stuck (very slow movement)
    if (speed < 0.3 && Math.abs(this.vy) < 0.5) {
      this.stuckFrames++;
      if (this.stuckFrames > 180) { // 3 seconds at 60fps
        this.stuck = true;
      }
    } else {
      this.stuckFrames = 0;
    }
  }

  reset(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.active = false;
    this.stuck = false;
    this.stuckFrames = 0;
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

export class PhysicsEngine {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.balls = [];
    this.pegs = [];
    this.hitPegs = new Set(); // Track which pegs were hit (for scoring only)
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

    // Update ball physics
    for (const ball of this.balls) {
      if (!ball.active) continue;
      ball.update();
      this.handleWallCollisions(ball);

      // Peg collisions - ALL pegs are still physically collidable!
      // Hit pegs just don't score again
      for (const peg of this.pegs) {
        let collision;
        
        if (peg.shape === 'brick') {
          collision = circleRectCollision(ball, peg);
        } else {
          // Circle peg
          collision = Utils.circleCollision(ball, {
            x: peg.x,
            y: peg.y,
            radius: PHYSICS_CONFIG.pegRadius
          });
        }

        if (collision) {
          this.resolveCollision(ball, collision);
          
          // Only mark as newly hit if not already hit (for scoring)
          // Obstacles are never "hit" for removal purposes
          if (peg.type !== 'obstacle' && !this.hitPegs.has(peg.id)) {
            this.hitPegs.add(peg.id);
            hitEvents.push({ peg, ball });
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

  resolveCollision(ball, collision) {
    const { normal, depth, relativeVelocityNormal } = collision;
    const bounce = PHYSICS_CONFIG.bounce;

    // Separate ball from peg
    ball.x += normal.x * (depth + 0.5);
    ball.y += normal.y * (depth + 0.5);

    // Reflect velocity
    ball.vx -= (1 + bounce) * relativeVelocityNormal * normal.x;
    ball.vy -= (1 + bounce) * relativeVelocityNormal * normal.y;

    // Add slight randomness to prevent perfect loops
    ball.vx += (Math.random() - 0.5) * 0.3;
    ball.vy += (Math.random() - 0.5) * 0.3;
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

  getHitPegIds() {
    return Array.from(this.hitPegs);
  }

  clearHitPegs() {
    this.hitPegs.clear();
  }

  // Trajectory prediction
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
          collision = Utils.circleCollision({ x, y, vx, vy, radius }, {
            x: peg.x,
            y: peg.y,
            radius: PHYSICS_CONFIG.pegRadius
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
      
      // Ball fell below screen
      if (y > this.height + 50) {
        break;
      }
    }
    
    return { points, hits: simulatedHits };
  }
}
