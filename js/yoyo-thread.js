// Yo-yo thread simulation for launched balls.
// The thread stores wrap pivots around pegs and retracts with a tension force.

import { PHYSICS_CONFIG } from './physics.js';
import { Utils } from './utils.js';

const YOYO_DEFAULTS = Object.freeze({
  enabled: false,
  triggerDropRatio: 0.68,
  retractSpeed: 420,
  tensionStrength: 0.26,
  tensionDamping: 0.35,
  slackPixels: 10,
  releaseRadius: 24,
  rearmDrop: 46,
  rearmDelay: 0.08,
  maxWrapDepth: 20,
  wrapPadding: 1.2,
  minWrapSpacing: 6
});

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function segmentCircleFirstT(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-8) return null;

  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const root = Math.sqrt(disc);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);

  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

function distancePointToSegmentSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) {
    const ex = px - x1;
    const ey = py - y1;
    return ex * ex + ey * ey;
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const qx = x1 + dx * t;
  const qy = y1 + dy * t;
  const ex = px - qx;
  const ey = py - qy;
  return ex * ex + ey * ey;
}

function getPegWrapRadius(peg, wrapPadding) {
  if (!peg) return PHYSICS_CONFIG.pegRadius + wrapPadding;

  if (peg.shape === 'brick') {
    const width = peg.width || PHYSICS_CONFIG.brickWidth;
    const height = peg.height || PHYSICS_CONFIG.brickHeight;
    return Math.hypot(width, height) * 0.5 + wrapPadding;
  }

  if (peg.type === 'bumper') {
    return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1) + wrapPadding;
  }

  if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
    return PHYSICS_CONFIG.pegRadius * (peg.portalScale || 1) + wrapPadding;
  }

  return PHYSICS_CONFIG.pegRadius + wrapPadding;
}

export function normalizeYoyoSettings(rawSettings = null) {
  const merged = { ...YOYO_DEFAULTS, ...(rawSettings || {}) };

  return {
    enabled: !!merged.enabled,
    triggerDropRatio: clamp(toFiniteNumber(merged.triggerDropRatio, YOYO_DEFAULTS.triggerDropRatio), 0.2, 0.95),
    retractSpeed: clamp(toFiniteNumber(merged.retractSpeed, YOYO_DEFAULTS.retractSpeed), 80, 1200),
    tensionStrength: clamp(toFiniteNumber(merged.tensionStrength, YOYO_DEFAULTS.tensionStrength), 0.05, 2.0),
    tensionDamping: clamp(toFiniteNumber(merged.tensionDamping, YOYO_DEFAULTS.tensionDamping), 0.05, 1.5),
    slackPixels: clamp(toFiniteNumber(merged.slackPixels, YOYO_DEFAULTS.slackPixels), 0, 80),
    releaseRadius: clamp(toFiniteNumber(merged.releaseRadius, YOYO_DEFAULTS.releaseRadius), 8, 120),
    rearmDrop: clamp(toFiniteNumber(merged.rearmDrop, YOYO_DEFAULTS.rearmDrop), 8, 220),
    rearmDelay: clamp(toFiniteNumber(merged.rearmDelay, YOYO_DEFAULTS.rearmDelay), 0, 1.5),
    maxWrapDepth: Math.round(clamp(toFiniteNumber(merged.maxWrapDepth, YOYO_DEFAULTS.maxWrapDepth), 1, 60)),
    wrapPadding: clamp(toFiniteNumber(merged.wrapPadding, YOYO_DEFAULTS.wrapPadding), 0, 8),
    minWrapSpacing: clamp(toFiniteNumber(merged.minWrapSpacing, YOYO_DEFAULTS.minWrapSpacing), 1, 20)
  };
}

export class YoyoThreadSystem {
  constructor(width, height, rawSettings = null) {
    this.width = width;
    this.height = height;
    this.settings = normalizeYoyoSettings(rawSettings);
    this.launchAnchor = {
      x: width / 2,
      y: 40
    };
    this.states = new Map();
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  configure(rawSettings = null) {
    this.settings = normalizeYoyoSettings(rawSettings);
    if (!this.settings.enabled) {
      this.clear();
    }
  }

  clear() {
    this.states.clear();
  }

  setLaunchAnchor(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.launchAnchor.x = x;
    this.launchAnchor.y = y;
  }

  registerBallLaunch(ball, anchorX = this.launchAnchor.x, anchorY = this.launchAnchor.y) {
    if (!ball) return;
    const state = this._createState(ball, anchorX, anchorY);
    this.states.set(ball.id, state);
  }

  step(balls, pegs, deltaSeconds = 1 / 60) {
    if (!this.settings.enabled) {
      this.clear();
      return;
    }

    if (!Array.isArray(balls) || balls.length === 0) {
      this.clear();
      return;
    }

    const dt = clamp(toFiniteNumber(deltaSeconds, 1 / 60), 1 / 240, 0.05);
    const activeIds = new Set();

    for (const ball of balls) {
      if (!ball || !ball.active) continue;
      if (ball.yoyoEligible === false) continue;

      activeIds.add(ball.id);
      const state = this._ensureState(ball);
      this._updateState(state, ball, Array.isArray(pegs) ? pegs : [], dt);
    }

    for (const [id] of this.states) {
      if (!activeIds.has(id)) {
        this.states.delete(id);
      }
    }
  }

  getRenderThreads() {
    if (!this.settings.enabled) return [];

    const threads = [];
    for (const state of this.states.values()) {
      const ball = state.ballRef;
      if (!ball || !ball.active || !state.visible) continue;

      const points = [{ x: state.anchorX, y: state.anchorY }];
      for (const wrap of state.wraps) {
        points.push({ x: wrap.x, y: wrap.y });
      }
      points.push({ x: ball.x, y: ball.y });

      if (points.length >= 2) {
        threads.push({
          ballId: state.ballId,
          mode: state.mode,
          points
        });
      }
    }

    return threads;
  }

  _createState(ball, anchorX, anchorY) {
    const ax = Number.isFinite(anchorX) ? anchorX : this.launchAnchor.x;
    const ay = Number.isFinite(anchorY) ? anchorY : this.launchAnchor.y;
    const startLen = Utils.distance(ax, ay, ball.x, ball.y) + this.settings.slackPixels;

    return {
      ballId: ball.id,
      ballRef: ball,
      anchorX: ax,
      anchorY: ay,
      wraps: [],
      mode: 'extending',
      visible: true,
      releaseTimer: 0,
      ropeLength: Math.max(0, startLen)
    };
  }

  _ensureState(ball) {
    let state = this.states.get(ball.id);
    if (!state) {
      state = this._createState(ball, this.launchAnchor.x, this.launchAnchor.y);
      this.states.set(ball.id, state);
    }
    state.ballRef = ball;
    return state;
  }

  _updateState(state, ball, pegs, dt) {
    if (state.mode === 'released') {
      state.visible = false;
      state.releaseTimer = Math.max(0, state.releaseTimer - dt);
      const drop = ball.y - state.anchorY;
      if (state.releaseTimer <= 0 && drop >= this.settings.rearmDrop && ball.vy > 0.05) {
        state.mode = 'extending';
        state.visible = true;
        state.wraps.length = 0;
        state.ropeLength = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y) + this.settings.slackPixels;
      }
      return;
    }

    state.visible = true;
    this._refreshWraps(state, ball, pegs);

    const currentLength = this._computePathLength(state, ball);
    if (state.mode === 'extending') {
      state.ropeLength = Math.max(state.ropeLength, currentLength + this.settings.slackPixels);
      const drop = ball.y - state.anchorY;
      const triggerDrop = this.height * this.settings.triggerDropRatio;
      if (drop >= triggerDrop && ball.vy > 0.05) {
        state.mode = 'retracting';
      }
      return;
    }

    // Retracting
    state.ropeLength = Math.max(0, state.ropeLength - this.settings.retractSpeed * dt);
    this._applyRetractionForce(state, ball);
    this._pruneWraps(state, ball, pegs);

    const distToAnchor = Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY);
    const nearAnchor = distToAnchor <= this.settings.releaseRadius;
    const nearAnchorBand = ball.y <= state.anchorY + this.settings.releaseRadius * 0.85 && ball.vy < 1;
    if (nearAnchor || nearAnchorBand) {
      state.mode = 'released';
      state.visible = false;
      state.wraps.length = 0;
      state.releaseTimer = this.settings.rearmDelay;
      if (ball.vy < -2) {
        ball.vy *= 0.35;
      }
    }
  }

  _refreshWraps(state, ball, pegs) {
    this._pruneWraps(state, ball, pegs);

    const maxAdds = 8;
    for (let i = 0; i < maxAdds && state.wraps.length < this.settings.maxWrapDepth; i++) {
      const from = state.wraps.length > 0
        ? state.wraps[state.wraps.length - 1]
        : { x: state.anchorX, y: state.anchorY };

      const block = this._findNearestBlock(from.x, from.y, ball.x, ball.y, pegs, state);
      if (!block) break;

      const nx = block.hitX - block.peg.x;
      const ny = block.hitY - block.peg.y;
      const nLen = Math.sqrt(nx * nx + ny * ny) || 1;
      const px = block.peg.x + (nx / nLen) * block.radius;
      const py = block.peg.y + (ny / nLen) * block.radius;

      const last = state.wraps[state.wraps.length - 1];
      if (last && last.pegId === block.peg.id && Utils.distance(last.x, last.y, px, py) < this.settings.minWrapSpacing) {
        break;
      }

      state.wraps.push({
        pegId: block.peg.id,
        x: px,
        y: py
      });
    }
  }

  _pruneWraps(state, ball, pegs) {
    while (state.wraps.length > 0) {
      const last = state.wraps[state.wraps.length - 1];
      const prev = state.wraps.length > 1
        ? state.wraps[state.wraps.length - 2]
        : { x: state.anchorX, y: state.anchorY };

      const peg = pegs.find(p => p && p.id === last.pegId);
      if (!peg) {
        state.wraps.pop();
        continue;
      }

      const radius = getPegWrapRadius(peg, this.settings.wrapPadding);
      const distSq = distancePointToSegmentSq(peg.x, peg.y, prev.x, prev.y, ball.x, ball.y);
      const threshold = Math.max(1, radius - 0.4);
      if (distSq > threshold * threshold) {
        state.wraps.pop();
        continue;
      }

      break;
    }
  }

  _findNearestBlock(fromX, fromY, toX, toY, pegs, state) {
    let best = null;
    const lastWrap = state.wraps[state.wraps.length - 1] || null;

    for (const peg of pegs) {
      if (!this._isWrappablePeg(peg)) continue;

      const radius = getPegWrapRadius(peg, this.settings.wrapPadding);
      const t = segmentCircleFirstT(fromX, fromY, toX, toY, peg.x, peg.y, radius);
      if (t == null) continue;
      if (t <= 0.02 || t >= 0.995) continue;

      if (lastWrap && lastWrap.pegId === peg.id && t < 0.14) {
        continue;
      }

      if (!best || t < best.t) {
        best = {
          peg,
          t,
          radius,
          hitX: fromX + (toX - fromX) * t,
          hitY: fromY + (toY - fromY) * t
        };
      }
    }

    return best;
  }

  _isWrappablePeg(peg) {
    if (!peg) return false;
    if (!Number.isFinite(peg.x) || !Number.isFinite(peg.y)) return false;
    // Portals are line triggers, not solid wrap bodies.
    if (peg.type === 'portalBlue' || peg.type === 'portalOrange') return false;
    return true;
  }

  _computePathLength(state, ball) {
    let length = 0;
    let prevX = state.anchorX;
    let prevY = state.anchorY;

    for (const wrap of state.wraps) {
      length += Utils.distance(prevX, prevY, wrap.x, wrap.y);
      prevX = wrap.x;
      prevY = wrap.y;
    }

    length += Utils.distance(prevX, prevY, ball.x, ball.y);
    return length;
  }

  _computePrefixLength(state) {
    let length = 0;
    let prevX = state.anchorX;
    let prevY = state.anchorY;

    for (const wrap of state.wraps) {
      length += Utils.distance(prevX, prevY, wrap.x, wrap.y);
      prevX = wrap.x;
      prevY = wrap.y;
    }

    return length;
  }

  _getTailPivot(state) {
    if (state.wraps.length > 0) {
      return state.wraps[state.wraps.length - 1];
    }
    return { x: state.anchorX, y: state.anchorY };
  }

  _applyRetractionForce(state, ball) {
    let safety = 0;

    while (safety++ < 16) {
      const prefixLen = this._computePrefixLength(state);
      let maxTailLength = state.ropeLength - prefixLen;

      // If rope became shorter than the wrapped prefix, unwind one pivot.
      if (maxTailLength < this.settings.minWrapSpacing && state.wraps.length > 0) {
        state.wraps.pop();
        continue;
      }

      if (maxTailLength < 0) maxTailLength = 0;
      const pivot = this._getTailPivot(state);
      const dx = ball.x - pivot.x;
      const dy = ball.y - pivot.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const over = dist - maxTailLength;
      if (over <= 0) break;

      const nx = dx / dist;
      const ny = dy / dist;

      // Position correction keeps rope taut even under large frame steps.
      const correction = Math.min(over, 16) * 0.62;
      ball.x -= nx * correction;
      ball.y -= ny * correction;

      // Remove outward velocity component and add pull toward the pivot.
      const radialVel = ball.vx * nx + ball.vy * ny;
      if (radialVel > 0) {
        const damping = 0.8 + this.settings.tensionDamping * 0.25;
        ball.vx -= nx * radialVel * damping;
        ball.vy -= ny * radialVel * damping;
      }

      const pull = over * this.settings.tensionStrength;
      ball.vx -= nx * pull;
      ball.vy -= ny * pull;

      this._constrainBallToWorld(ball);
      this._clampBallSpeed(ball);
      break;
    }
  }

  _constrainBallToWorld(ball) {
    const radius = ball.radius || PHYSICS_CONFIG.pegRadius;
    const bounce = PHYSICS_CONFIG.bounce;

    if (ball.x - radius < 0) {
      ball.x = radius;
      if (ball.vx < 0) {
        ball.vx = Math.abs(ball.vx) * bounce;
      }
    }

    if (ball.x + radius > this.width) {
      ball.x = this.width - radius;
      if (ball.vx > 0) {
        ball.vx = -Math.abs(ball.vx) * bounce;
      }
    }

    if (ball.y - radius < 0) {
      ball.y = radius;
      if (ball.vy < 0) {
        ball.vy = Math.abs(ball.vy) * bounce;
      }
    }
  }

  _clampBallSpeed(ball) {
    const speed = Utils.magnitude(ball.vx, ball.vy);
    const maxSpeed = PHYSICS_CONFIG.maxVelocity + (ball.speedCapBoost || 0);
    if (speed <= maxSpeed || speed <= 1e-8) return;

    const scale = maxSpeed / speed;
    ball.vx *= scale;
    ball.vy *= scale;
  }
}
