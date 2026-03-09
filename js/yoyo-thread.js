// Yo-yo thread simulation for launched balls.
// Uses a rope-chain (Verlet) solver with obstacle constraints for smooth curved wrapping.

import { PHYSICS_CONFIG } from './physics.js';
import { Utils } from './utils.js';

const YOYO_DEFAULTS = Object.freeze({
  enabled: false,
  debugDrag: false,
  triggerDropRatio: 0.68,
  retractSpeed: 420,
  retractFarSpeedScale: 0.34,
  tensionStrength: 0.26,
  tensionDamping: 0.35,
  slackPixels: 10,
  extendSlackPixels: 1.2,
  extendStraighten: 0.085,
  releaseRadius: 24,
  rearmDrop: 46,
  rearmDelay: 0.08,
  ropeSegmentLength: 9,
  minNodes: 14,
  maxNodes: 120,
  solverIterations: 18,
  bendStiffnessExtend: 0.22,
  bendStiffnessRetract: 0.11,
  ropeThickness: 3.2,
  collisionMargin: 1.2,
  curveSamples: 4
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

function segmentAabbInterval(ax, ay, bx, by, halfW, halfH) {
  const dx = bx - ax;
  const dy = by - ay;
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-8) {
    if (ax < -halfW || ax > halfW) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (-halfW - ax) * inv;
    let t2 = (halfW - ax) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (Math.abs(dy) < 1e-8) {
    if (ay < -halfH || ay > halfH) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (-halfH - ay) * inv;
    let t2 = (halfH - ay) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return { tEnter: tMin, tExit: tMax };
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

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (
      (2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    ),
    y: 0.5 * (
      (2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    )
  };
}

function makeNode(x, y) {
  return { x, y, px: x, py: y };
}

export function normalizeYoyoSettings(rawSettings = null) {
  const merged = { ...YOYO_DEFAULTS, ...(rawSettings || {}) };

  return {
    enabled: !!merged.enabled,
    debugDrag: !!merged.debugDrag,
    triggerDropRatio: clamp(toFiniteNumber(merged.triggerDropRatio, YOYO_DEFAULTS.triggerDropRatio), 0.2, 0.95),
    retractSpeed: clamp(toFiniteNumber(merged.retractSpeed, YOYO_DEFAULTS.retractSpeed), 80, 1400),
    retractFarSpeedScale: clamp(toFiniteNumber(merged.retractFarSpeedScale, YOYO_DEFAULTS.retractFarSpeedScale), 0.05, 1),
    tensionStrength: clamp(toFiniteNumber(merged.tensionStrength, YOYO_DEFAULTS.tensionStrength), 0.05, 2.4),
    tensionDamping: clamp(toFiniteNumber(merged.tensionDamping, YOYO_DEFAULTS.tensionDamping), 0.05, 1.8),
    slackPixels: clamp(toFiniteNumber(merged.slackPixels, YOYO_DEFAULTS.slackPixels), 0, 100),
    extendSlackPixels: clamp(toFiniteNumber(merged.extendSlackPixels, YOYO_DEFAULTS.extendSlackPixels), 0, 24),
    extendStraighten: clamp(toFiniteNumber(merged.extendStraighten, YOYO_DEFAULTS.extendStraighten), 0, 0.2),
    releaseRadius: clamp(toFiniteNumber(merged.releaseRadius, YOYO_DEFAULTS.releaseRadius), 8, 140),
    rearmDrop: clamp(toFiniteNumber(merged.rearmDrop, YOYO_DEFAULTS.rearmDrop), 8, 260),
    rearmDelay: clamp(toFiniteNumber(merged.rearmDelay, YOYO_DEFAULTS.rearmDelay), 0, 1.5),
    ropeSegmentLength: clamp(toFiniteNumber(merged.ropeSegmentLength, YOYO_DEFAULTS.ropeSegmentLength), 5, 20),
    minNodes: Math.round(clamp(toFiniteNumber(merged.minNodes, YOYO_DEFAULTS.minNodes), 6, 80)),
    maxNodes: Math.round(clamp(toFiniteNumber(merged.maxNodes, YOYO_DEFAULTS.maxNodes), 20, 240)),
    solverIterations: Math.round(clamp(toFiniteNumber(merged.solverIterations, YOYO_DEFAULTS.solverIterations), 4, 40)),
    bendStiffnessExtend: clamp(toFiniteNumber(merged.bendStiffnessExtend, YOYO_DEFAULTS.bendStiffnessExtend), 0, 0.7),
    bendStiffnessRetract: clamp(toFiniteNumber(merged.bendStiffnessRetract, YOYO_DEFAULTS.bendStiffnessRetract), 0, 0.7),
    ropeThickness: clamp(toFiniteNumber(merged.ropeThickness, YOYO_DEFAULTS.ropeThickness), 1.5, 8),
    collisionMargin: clamp(toFiniteNumber(merged.collisionMargin, YOYO_DEFAULTS.collisionMargin), 0, 8),
    curveSamples: Math.round(clamp(toFiniteNumber(merged.curveSamples, YOYO_DEFAULTS.curveSamples), 1, 8))
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

  step(balls, pegs, deltaSeconds = 1 / 60, options = null) {
    const releaseEvents = [];
    if (!this.settings.enabled) {
      this.clear();
      return releaseEvents;
    }

    if (!Array.isArray(balls) || balls.length === 0) {
      this.clear();
      return releaseEvents;
    }

    const dt = clamp(toFiniteNumber(deltaSeconds, 1 / 60), 1 / 240, 0.05);
    const retractStartY = options && Number.isFinite(options.retractStartY)
      ? options.retractStartY
      : null;
    const obstacles = this._collectObstacles(Array.isArray(pegs) ? pegs : []);
    const activeIds = new Set();

    for (const ball of balls) {
      if (!ball || !ball.active) continue;
      if (ball.yoyoEligible === false) continue;

      activeIds.add(ball.id);
      const state = this._ensureState(ball);
      this._updateState(state, ball, dt, retractStartY, obstacles, releaseEvents);
    }

    for (const [id] of this.states) {
      if (!activeIds.has(id)) {
        this.states.delete(id);
      }
    }

    return releaseEvents;
  }

  notePegContact(ball, peg) {
    // Kept for compatibility. Current rope solver is fully geometric each frame.
  }

  getRenderThreads() {
    if (!this.settings.enabled) return [];

    const threads = [];
    for (const state of this.states.values()) {
      const ball = state.ballRef;
      if (!ball || !ball.active || !state.visible || !Array.isArray(state.nodes) || state.nodes.length < 2) continue;

      const points = this._buildRenderPoints(state.nodes);
      if (!points || points.length < 2) continue;

      threads.push({
        ballId: state.ballId,
        mode: state.mode,
        points
      });
    }

    return threads;
  }

  _createState(ball, anchorX, anchorY) {
    const ax = Number.isFinite(anchorX) ? anchorX : this.launchAnchor.x;
    const ay = Number.isFinite(anchorY) ? anchorY : this.launchAnchor.y;
    const startLen = Utils.distance(ax, ay, ball.x, ball.y) + this.settings.extendSlackPixels;

    return {
      ballId: ball.id,
      ballRef: ball,
      anchorX: ax,
      anchorY: ay,
      mode: 'extending',
      visible: true,
      releaseTimer: 0,
      ropeLength: Math.max(0, startLen),
      nodes: [],
      retractStartDist: 0,
      prevBallX: ball.x,
      prevBallY: ball.y,
      retractNodeCount: 0
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

  _updateState(state, ball, dt, retractStartY, obstacles, releaseEvents = null) {
    const prevBallX = Number.isFinite(state.prevBallX) ? state.prevBallX : ball.x;
    const prevBallY = Number.isFinite(state.prevBallY) ? state.prevBallY : ball.y;

    if (state.mode === 'released') {
      state.visible = false;
      state.releaseTimer = Math.max(0, state.releaseTimer - dt);
      const drop = ball.y - state.anchorY;
      if (state.releaseTimer <= 0 && drop >= this.settings.rearmDrop && ball.vy > 0.05) {
        state.mode = 'extending';
        state.visible = true;
        state.ropeLength = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y) + this.settings.extendSlackPixels;
        state.nodes.length = 0;
        state.retractStartDist = 0;
        state.prevBallX = ball.x;
        state.prevBallY = ball.y;
        state.retractNodeCount = 0;
      }
      return;
    }

    state.visible = true;
    this._ensureNodes(state, ball);

    if (state.mode === 'extending') {
      this._simulateRope(state, ball, obstacles, dt, prevBallX, prevBallY);
      const direct = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y) + this.settings.extendSlackPixels;
      // Allow rope to grow when wrapping adds path length around obstacles.
      // The actual node path after collision solving may be longer than direct.
      const nodePathLen = this._computeNodePathLength(state.nodes);
      // Keep rope at least as long as direct, but preserve wrap-induced extra length.
      // Cap at 2.5x direct to prevent unbounded growth from solver jitter.
      const maxWrapLen = direct * 2.5;
      state.ropeLength = Math.max(direct, Math.min(nodePathLen, maxWrapLen));

      const fallbackTriggerY = state.anchorY + this.height * this.settings.triggerDropRatio;
      const triggerY = Number.isFinite(retractStartY) ? retractStartY : fallbackTriggerY;
      if (ball.y >= triggerY && ball.vy > -0.2) {
        state.mode = 'retracting';
        state.retractStartDist = Math.max(1, Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY));
        state.retractNodeCount = Math.max(8, state.nodes.length || this.settings.minNodes);
      }
      state.prevBallX = ball.x;
      state.prevBallY = ball.y;
      return;
    }

    const retractScale = this._getRetractSpeedScale(state, ball);
    const currentPathLen = this._computeNodePathLength(state.nodes);
    const shorten = this.settings.retractSpeed * retractScale * dt;
    const maxOver = this.settings.ropeSegmentLength * 2.25;
    const minByPath = Math.max(0, currentPathLen - maxOver);
    state.ropeLength = Math.max(minByPath, state.ropeLength - shorten);
    this._simulateRope(state, ball, obstacles, dt, prevBallX, prevBallY);
    const prePullX = ball.x;
    const prePullY = ball.y;
    this._applyRetractionForce(state, ball, retractScale);
    this._simulateRope(state, ball, obstacles, dt, prePullX, prePullY);

    const distToAnchor = Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY);
    const nearAnchor = distToAnchor <= this.settings.releaseRadius;
    const nearAnchorBand = ball.y <= state.anchorY + this.settings.releaseRadius * 0.85
      && Math.abs(ball.x - state.anchorX) <= this.settings.releaseRadius * 1.5
      && ball.vy < 1;
    if (nearAnchor || nearAnchorBand) {
      state.mode = 'released';
      state.visible = false;
      state.releaseTimer = this.settings.rearmDelay;
      state.nodes.length = 0;
      state.retractStartDist = 0;
      state.prevBallX = ball.x;
      state.prevBallY = ball.y;
      state.retractNodeCount = 0;
      if (ball.vy < -2) {
        ball.vy *= 0.35;
      }
      if (Array.isArray(releaseEvents)) {
        releaseEvents.push(state.ballId);
      }
      return;
    }

    state.prevBallX = ball.x;
    state.prevBallY = ball.y;
  }

  _smoothstep01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  _getRetractSpeedScale(state, ball) {
    const startDist = Number.isFinite(state.retractStartDist) ? state.retractStartDist : 0;
    if (startDist <= 1) return 1;

    const currentDist = Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY);
    const progress = this._smoothstep01(1 - currentDist / startDist);
    const minScale = this.settings.retractFarSpeedScale;
    return minScale + (1 - minScale) * progress;
  }

  _ensureNodes(state, ball) {
    const direct = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y);
    const refLen = Math.max(state.ropeLength, direct + this.settings.extendSlackPixels);
    const extending = state.mode === 'extending';
    const retracting = state.mode === 'retracting';
    const minNodes = extending
      ? Math.max(6, Math.min(this.settings.minNodes, 10))
      : Math.max(4, this.settings.minNodes);
    const maxNodes = Math.max(minNodes + 1, this.settings.maxNodes);
    const segmentLen = extending
      ? this.settings.ropeSegmentLength * 1.14
      : this.settings.ropeSegmentLength;
    let targetCount = Math.round(clamp(Math.ceil(refLen / segmentLen) + 1, minNodes, maxNodes));
    if (retracting && Number.isFinite(state.retractNodeCount) && state.retractNodeCount >= 8) {
      targetCount = Math.round(clamp(state.retractNodeCount, minNodes, maxNodes));
    }

    if (!Array.isArray(state.nodes) || state.nodes.length < 2) {
      state.nodes = this._buildLinearNodes(state.anchorX, state.anchorY, ball.x, ball.y, targetCount);
      return;
    }

    if (Math.abs(state.nodes.length - targetCount) >= 2) {
      state.nodes = this._resampleNodes(state.nodes, targetCount, state.anchorX, state.anchorY, ball.x, ball.y);
    }

    const first = state.nodes[0];
    first.x = state.anchorX;
    first.y = state.anchorY;
    first.px = first.x;
    first.py = first.y;

    const last = state.nodes[state.nodes.length - 1];
    last.x = ball.x;
    last.y = ball.y;
    last.px = last.x;
    last.py = last.y;
  }

  _buildLinearNodes(ax, ay, bx, by, count) {
    const nodes = [];
    const safeCount = Math.max(2, count);
    for (let i = 0; i < safeCount; i++) {
      const t = safeCount === 1 ? 0 : i / (safeCount - 1);
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      nodes.push(makeNode(x, y));
    }
    return nodes;
  }

  _resampleNodes(nodes, targetCount, ax, ay, bx, by) {
    const source = nodes.map((n, i) => {
      if (i === 0) return { x: ax, y: ay };
      if (i === nodes.length - 1) return { x: bx, y: by };
      return { x: n.x, y: n.y };
    });

    const cumulative = [0];
    for (let i = 1; i < source.length; i++) {
      const prev = source[i - 1];
      const curr = source[i];
      cumulative.push(cumulative[i - 1] + Utils.distance(prev.x, prev.y, curr.x, curr.y));
    }

    const total = cumulative[cumulative.length - 1] || Utils.distance(ax, ay, bx, by);
    if (total < 1e-6) {
      return this._buildLinearNodes(ax, ay, bx, by, targetCount);
    }

    const out = [];
    for (let i = 0; i < targetCount; i++) {
      const d = total * (i / (targetCount - 1));
      let seg = 0;
      while (seg < cumulative.length - 2 && cumulative[seg + 1] < d) {
        seg++;
      }
      const d0 = cumulative[seg];
      const d1 = cumulative[seg + 1];
      const p0 = source[seg];
      const p1 = source[seg + 1];
      const t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
      const x = p0.x + (p1.x - p0.x) * t;
      const y = p0.y + (p1.y - p0.y) * t;
      out.push(makeNode(x, y));
    }

    out[0].x = ax;
    out[0].y = ay;
    out[out.length - 1].x = bx;
    out[out.length - 1].y = by;
    return out;
  }

  _simulateRope(state, ball, obstacles, dt, prevBallX = ball.x, prevBallY = ball.y) {
    const moveDist = Utils.distance(prevBallX, prevBallY, ball.x, ball.y);
    const maxStep = Math.max(2, this.settings.ropeSegmentLength * 0.65);
    const substeps = Math.round(clamp(Math.ceil(moveDist / maxStep), 1, 6));
    if (substeps <= 1) {
      this._simulateRopeOnce(state, ball, obstacles, dt);
      return;
    }

    const fromX = prevBallX;
    const fromY = prevBallY;
    const toX = ball.x;
    const toY = ball.y;
    const subBall = { x: toX, y: toY, vx: ball.vx, vy: ball.vy };
    for (let s = 1; s <= substeps; s++) {
      const t = s / substeps;
      subBall.x = fromX + (toX - fromX) * t;
      subBall.y = fromY + (toY - fromY) * t;
      this._simulateRopeOnce(state, subBall, obstacles, dt / substeps);
    }

    this._pinEndpoints(state, ball);
  }

  _simulateRopeOnce(state, ball, obstacles, dt) {
    const nodes = state.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) return;

    const lastIndex = nodes.length - 1;
    const extending = state.mode === 'extending';
    const bendStiffness = extending
      ? this.settings.bendStiffnessExtend
      : this.settings.bendStiffnessRetract;
    const allowCompression = extending;

    const baseDamping = extending ? 0.72 : 0.966;
    const minDamping = extending ? 0.56 : 0.88;
    const velocityDamping = clamp(baseDamping - this.settings.tensionDamping * 0.05, minDamping, 0.995);
    const inertialScale = clamp(dt * 60, 0.3, 1.6);

    for (let i = 1; i < lastIndex; i++) {
      const node = nodes[i];
      const extendDamp = extending ? 0.35 : 1; // Reduce but don't kill momentum while extending
      const vx = (node.x - node.px) * velocityDamping * extendDamp;
      const vy = (node.y - node.py) * velocityDamping * extendDamp;
      node.px = node.x;
      node.py = node.y;
      node.x += vx * inertialScale;
      node.y += vy * inertialScale;
    }

    // Keep slight pressure while extending so thread doesn't look overly loose.
    // But skip nodes near obstacles — straightening fights wrapping.
    if (extending && this.settings.extendStraighten > 0) {
      const k = this.settings.extendStraighten;
      const ax = state.anchorX;
      const ay = state.anchorY;
      const bx = ball.x;
      const by = ball.y;
      for (let i = 1; i < lastIndex; i++) {
        const t = i / lastIndex;
        const targetX = ax + (bx - ax) * t;
        const targetY = ay + (by - ay) * t;
        // Measure how far the node is from the straight line — if it's been
        // pushed significantly outward (by obstacle collision), skip straightening.
        const offX = nodes[i].x - targetX;
        const offY = nodes[i].y - targetY;
        const offDist = Math.sqrt(offX * offX + offY * offY);
        const wrapThreshold = this.settings.ropeSegmentLength * 1.5;
        if (offDist > wrapThreshold) continue; // node is wrapping around something
        const blend = 1 - clamp(offDist / wrapThreshold, 0, 1);
        nodes[i].x += (targetX - nodes[i].x) * k * blend;
        nodes[i].y += (targetY - nodes[i].y) * k * blend;
      }
    }

    const speed = Utils.magnitude(ball.vx || 0, ball.vy || 0);
    const retracting = state.mode === 'retracting';
    const extraRadius = retracting ? clamp(speed / 700, 0, 1.1) : 0;
    const ropeRadius = this.settings.ropeThickness * 0.5 + this.settings.collisionMargin + extraRadius;
    const speedBoost = Math.round(clamp(speed / 220, 0, 8));
    const retractBoost = retracting ? 2 : 0;
    // Longer ropes need more iterations for corrections to propagate end-to-end.
    // Verlet propagates ~1 node/iteration, so scale with node count.
    const lengthBoost = Math.round(clamp((nodes.length - 20) / 8, 0, 10));
    const iterations = Math.round(clamp(this.settings.solverIterations + speedBoost + retractBoost + lengthBoost, this.settings.solverIterations, 50));

    for (let iter = 0; iter < iterations; iter++) {
      this._pinEndpoints(state, ball);
      this._solveDistanceConstraints(state, allowCompression);
      // Collision after EVERY distance pass — critical for wrapping stability.
      // Without this, distance pulls nodes through pegs 2x per iteration
      // while collision only pushes them back 1x. For long ropes where mid-chain
      // nodes have no endpoint authority, distance overwhelms collision.
      this._solveNodeObstacleConstraints(state, obstacles, ropeRadius, retracting);
      this._solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting);
      this._solveBendConstraints(state, bendStiffness, obstacles, ropeRadius);
      this._solveDistanceConstraints(state, allowCompression);
      this._solveNodeObstacleConstraints(state, obstacles, ropeRadius, retracting);
      this._solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting);
    }

    this._pinEndpoints(state, ball);
    this._solveNodeObstacleConstraints(state, obstacles, ropeRadius, retracting);
    this._solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting);
    this._pinEndpoints(state, ball);
  }

  _pinEndpoints(state, ball) {
    const nodes = state.nodes;
    if (!nodes || nodes.length < 2) return;

    const first = nodes[0];
    first.x = state.anchorX;
    first.y = state.anchorY;
    first.px = first.x;
    first.py = first.y;

    const last = nodes[nodes.length - 1];
    last.x = ball.x;
    last.y = ball.y;
    last.px = last.x;
    last.py = last.y;
  }

  _solveDistanceConstraints(state, allowCompression = true) {
    const nodes = state.nodes;
    if (!nodes || nodes.length < 2) return;

    const lastIndex = nodes.length - 1;
    const segmentRest = Math.max(0.0001, state.ropeLength / lastIndex);

    for (let i = 0; i < lastIndex; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      let diff = (dist - segmentRest) / dist;
      if (diff < 0 && !allowCompression) {
        // During retract, avoid strong expansive corrections that make rope pop off pegs.
        diff *= 0.12;
      }
      diff = clamp(diff, -0.22, 0.35);

      if (i === 0) {
        b.x -= dx * diff;
        b.y -= dy * diff;
      } else if (i + 1 === lastIndex) {
        a.x += dx * diff;
        a.y += dy * diff;
      } else {
        const offX = dx * diff * 0.5;
        const offY = dy * diff * 0.5;
        a.x += offX;
        a.y += offY;
        b.x -= offX;
        b.y -= offY;
      }
    }
  }

  _solveBendConstraints(state, stiffness, obstacles, ropeRadius) {
    if (!Number.isFinite(stiffness) || stiffness <= 0) return;

    const nodes = state.nodes;
    if (!nodes || nodes.length < 3) return;

    const lastIndex = nodes.length - 1;
    const k = clamp(stiffness, 0, 0.7);
    const hasObstacles = Array.isArray(obstacles) && obstacles.length > 0;

    for (let i = 1; i < lastIndex; i++) {
      const prev = nodes[i - 1];
      const curr = nodes[i];
      const next = nodes[i + 1];

      const targetX = (prev.x + next.x) * 0.5;
      const targetY = (prev.y + next.y) * 0.5;

      // Skip bend correction if the target (midpoint of neighbors) is inside an
      // obstacle — applying it would drag the node through the peg, destroying wrapping.
      if (hasObstacles) {
        let blocked = false;
        for (const obs of obstacles) {
          if (obs.kind === 'circle') {
            const dx = targetX - obs.x;
            const dy = targetY - obs.y;
            const r = obs.radius + ropeRadius;
            if (dx * dx + dy * dy < r * r) {
              blocked = true;
              break;
            }
          } else if (obs.kind === 'brick') {
            const dx = targetX - obs.x;
            const dy = targetY - obs.y;
            const lx = dx * obs.cos + dy * obs.sin;
            const ly = -dx * obs.sin + dy * obs.cos;
            if (Math.abs(lx) < obs.halfW + ropeRadius && Math.abs(ly) < obs.halfH + ropeRadius) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;
      }

      curr.x += (targetX - curr.x) * k;
      curr.y += (targetY - curr.y) * k;
    }
  }

  _solveNodeObstacleConstraints(state, obstacles, ropeRadius, retracting = false) {
    if (!Array.isArray(obstacles) || obstacles.length === 0) return;

    const nodes = state.nodes;
    const lastIndex = nodes.length - 1;

    for (let i = 1; i < lastIndex; i++) {
      const node = nodes[i];
      for (const obs of obstacles) {
        if (obs.kind === 'circle') {
          this._resolveNodeCircle(node, obs, ropeRadius, retracting);
        } else if (obs.kind === 'brick') {
          this._resolveNodeBrick(node, obs, ropeRadius, retracting);
        }
      }
    }
  }

  _solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting = false) {
    if (!Array.isArray(obstacles) || obstacles.length === 0) return;

    const nodes = state.nodes;
    const lastIndex = nodes.length - 1;

    for (let i = 0; i < lastIndex; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];

      for (const obs of obstacles) {
        if (obs.kind === 'circle') {
          this._resolveSegmentCircle(a, b, obs, ropeRadius, i, lastIndex, retracting);
        } else if (obs.kind === 'brick') {
          this._resolveSegmentBrick(a, b, obs, ropeRadius, i, lastIndex, retracting);
        }
      }
    }
  }

  _dampNodeAgainstNormal(node, nx, ny, retracting = false) {
    if (!node || !Number.isFinite(node.px) || !Number.isFinite(node.py)) return;
    const vx = node.x - node.px;
    const vy = node.y - node.py;
    const vn = vx * nx + vy * ny;
    const tx = -ny;
    const ty = nx;
    const vt = vx * tx + vy * ty;
    const keepTangential = retracting ? 0.35 : 0.45;
    const keepOutward = retracting ? 0.08 : 0.16;
    const outward = Math.max(0, vn) * keepOutward;
    const nextVx = tx * vt * keepTangential + nx * outward;
    const nextVy = ty * vt * keepTangential + ny * outward;
    node.px = node.x - nextVx;
    node.py = node.y - nextVy;
  }

  _applySegmentPush(a, b, i, lastIndex, nx, ny, push, retracting = false) {
    if (push <= 0) return;
    const aMovable = i > 0;
    const bMovable = i + 1 < lastIndex;

    if (aMovable && bMovable) {
      a.x += nx * push;
      a.y += ny * push;
      b.x += nx * push;
      b.y += ny * push;
      this._dampNodeAgainstNormal(a, nx, ny, retracting);
      this._dampNodeAgainstNormal(b, nx, ny, retracting);
    } else if (aMovable) {
      const full = push * 1.45;
      a.x += nx * full;
      a.y += ny * full;
      this._dampNodeAgainstNormal(a, nx, ny, retracting);
    } else if (bMovable) {
      const full = push * 1.45;
      b.x += nx * full;
      b.y += ny * full;
      this._dampNodeAgainstNormal(b, nx, ny, retracting);
    }
  }

  _resolveSegmentCircle(a, b, obs, ropeRadius, i, lastIndex, retracting = false) {
    const hitRadius = obs.radius + ropeRadius;

    for (let pass = 0; pass < 4; pass++) {
      const t = segmentCircleFirstT(a.x, a.y, b.x, b.y, obs.x, obs.y, hitRadius);
      if (t == null || t <= 0.001 || t >= 0.999) return;

      const distSq = distancePointToSegmentSq(obs.x, obs.y, a.x, a.y, b.x, b.y);
      const dist = Math.sqrt(distSq) || 0.0001;
      const penetration = hitRadius - dist;
      if (penetration <= 0) return;

      const hx = a.x + (b.x - a.x) * t;
      const hy = a.y + (b.y - a.y) * t;
      let nx = hx - obs.x;
      let ny = hy - obs.y;
      let nLen = Math.sqrt(nx * nx + ny * ny);
      if (nLen < 1e-5) {
        // Segment crossed close to center; use segment normal as stable fallback.
        const sx = b.x - a.x;
        const sy = b.y - a.y;
        nLen = Math.sqrt(sx * sx + sy * sy) || 1;
        nx = -sy / nLen;
        ny = sx / nLen;
        const side = (obs.x - hx) * nx + (obs.y - hy) * ny;
        if (side > 0) {
          nx = -nx;
          ny = -ny;
        }
      } else {
        nx /= nLen;
        ny /= nLen;
      }

      const push = penetration + 1.15;
      this._applySegmentPush(a, b, i, lastIndex, nx, ny, push, retracting);
    }
  }

  _resolveSegmentBrick(a, b, obs, ropeRadius, i, lastIndex, retracting = false) {
    const ex = obs.halfW + ropeRadius;
    const ey = obs.halfH + ropeRadius;

    for (let pass = 0; pass < 4; pass++) {
      const adx = a.x - obs.x;
      const ady = a.y - obs.y;
      const bdx = b.x - obs.x;
      const bdy = b.y - obs.y;

      const ax = adx * obs.cos + ady * obs.sin;
      const ay = -adx * obs.sin + ady * obs.cos;
      const bx = bdx * obs.cos + bdy * obs.sin;
      const by = -bdx * obs.sin + bdy * obs.cos;

      const interval = segmentAabbInterval(ax, ay, bx, by, ex, ey);
      if (!interval) return;

      const midT = clamp((interval.tEnter + interval.tExit) * 0.5, 0, 1);
      const mx = ax + (bx - ax) * midT;
      const my = ay + (by - ay) * midT;

      const penX = ex - Math.abs(mx);
      const penY = ey - Math.abs(my);
      const penetration = Math.min(penX, penY);
      if (penetration <= 0) return;

      let localNx = 0;
      let localNy = 0;
      if (penX <= penY) {
        localNx = mx >= 0 ? 1 : -1;
      } else {
        localNy = my >= 0 ? 1 : -1;
      }

      const nx = localNx * obs.cos - localNy * obs.sin;
      const ny = localNx * obs.sin + localNy * obs.cos;
      const push = penetration + 1.05;
      this._applySegmentPush(a, b, i, lastIndex, nx, ny, push, retracting);
    }
  }

  _resolveNodeCircle(node, obs, ropeRadius, retracting = false) {
    const minDist = obs.radius + ropeRadius;
    let dx = node.x - obs.x;
    let dy = node.y - obs.y;
    let dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= minDist) return;

    if (dist < 1e-6) {
      dx = 1;
      dy = 0;
      dist = 1;
    }

    const inv = 1 / dist;
    const nx = dx * inv;
    const ny = dy * inv;
    const push = minDist - dist + 0.001;
    node.x += nx * push;
    node.y += ny * push;
    this._dampNodeAgainstNormal(node, nx, ny, retracting);
  }

  _resolveNodeBrick(node, obs, ropeRadius, retracting = false) {
    const cos = obs.cos;
    const sin = obs.sin;

    const dx = node.x - obs.x;
    const dy = node.y - obs.y;

    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;

    const clampedX = clamp(lx, -obs.halfW, obs.halfW);
    const clampedY = clamp(ly, -obs.halfH, obs.halfH);

    let nx = lx - clampedX;
    let ny = ly - clampedY;
    let dist = Math.sqrt(nx * nx + ny * ny);

    if (dist >= ropeRadius) return;

    if (dist < 1e-6) {
      const penX = obs.halfW - Math.abs(lx);
      const penY = obs.halfH - Math.abs(ly);
      if (penX < penY) {
        nx = lx >= 0 ? 1 : -1;
        ny = 0;
      } else {
        nx = 0;
        ny = ly >= 0 ? 1 : -1;
      }
      dist = 1;
    }

    const inv = 1 / dist;
    const ux = nx * inv;
    const uy = ny * inv;
    const push = ropeRadius - dist + 0.001;

    const localX = lx + ux * push;
    const localY = ly + uy * push;

    node.x = obs.x + localX * cos - localY * sin;
    node.y = obs.y + localX * sin + localY * cos;

    const worldNx = ux * cos - uy * sin;
    const worldNy = ux * sin + uy * cos;
    this._dampNodeAgainstNormal(node, worldNx, worldNy, retracting);
  }

  _getTailGuidePoint(nodes) {
    const last = nodes.length - 1;
    if (last < 2) {
      return nodes[last - 1] || nodes[0];
    }

    const a = nodes[last - 1];
    const b = nodes[last - 2];
    const c = nodes[last - 3] || b;

    return {
      x: a.x * 0.62 + b.x * 0.28 + c.x * 0.10,
      y: a.y * 0.62 + b.y * 0.28 + c.y * 0.10
    };
  }

  _applyRetractionForce(state, ball, retractScale = 1) {
    const nodes = state.nodes;
    if (!nodes || nodes.length < 2) return;

    const pathLen = this._computeNodePathLength(nodes);
    const over = pathLen - state.ropeLength;
    if (over <= 0) return;

    const pivot = this._getTailGuidePoint(nodes) || { x: state.anchorX, y: state.anchorY };
    const dx = ball.x - pivot.x;
    const dy = ball.y - pivot.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;

    const nx = dx / dist;
    const ny = dy / dist;

    const forceScale = clamp(retractScale * 0.85 + 0.15, 0.15, 1);
    const correction = Math.min(over, 18) * 0.54 * forceScale;
    ball.x -= nx * correction;
    ball.y -= ny * correction;

    const radialVel = ball.vx * nx + ball.vy * ny;
    if (radialVel > 0) {
      const damping = 0.78 + this.settings.tensionDamping * 0.22;
      ball.vx -= nx * radialVel * damping;
      ball.vy -= ny * radialVel * damping;
    }

    // Damp local orbiting around tail pivot (spin/whirl artifact).
    const tx = -ny;
    const ty = nx;
    const tangentialVel = ball.vx * tx + ball.vy * ty;
    const spinDamping = clamp(0.14 + over * 0.016, 0.14, 0.42);
    ball.vx -= tx * tangentialVel * spinDamping;
    ball.vy -= ty * tangentialVel * spinDamping;

    const pull = over * this.settings.tensionStrength * forceScale;
    ball.vx -= nx * pull;
    ball.vy -= ny * pull;

    this._constrainBallToWorld(ball);
    this._clampBallSpeed(ball);
  }

  _computeNodePathLength(nodes) {
    let length = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      length += Utils.distance(a.x, a.y, b.x, b.y);
    }
    return length;
  }

  _collectObstacles(pegs) {
    if (!Array.isArray(pegs) || pegs.length === 0) return [];

    const out = [];
    for (const peg of pegs) {
      if (!this._isWrappablePeg(peg)) continue;

      // Wrap padding: inflate obstacle boundaries so the rope sees a slightly larger
      // obstacle. For small circle pegs (radius ~10px) this is critical — without it
      // there's too little surface for stable node-based wrapping.
      const wrapPad = 3.5;

      if (peg.shape === 'brick') {
        const width = peg.width || PHYSICS_CONFIG.brickWidth;
        const height = peg.height || PHYSICS_CONFIG.brickHeight;
        const angle = peg.angle || 0;
        out.push({
          kind: 'brick',
          x: peg.x,
          y: peg.y,
          halfW: width * 0.5 + wrapPad,
          halfH: height * 0.5 + wrapPad,
          cos: Math.cos(angle),
          sin: Math.sin(angle)
        });
        continue;
      }
      out.push({
        kind: 'circle',
        x: peg.x,
        y: peg.y,
        radius: getPegWrapRadius(peg, wrapPad)
      });
    }

    return out;
  }

  _buildRenderPoints(nodes) {
    if (!Array.isArray(nodes) || nodes.length < 2) return [];
    if (nodes.length === 2 || this.settings.curveSamples <= 1) {
      return nodes.map(n => ({ x: n.x, y: n.y }));
    }

    let src = nodes.map(n => ({ x: n.x, y: n.y }));
    // Render-time low-pass to remove tiny solver jitter without changing physics.
    for (let pass = 0; pass < 2; pass++) {
      const smoothed = src.map(p => ({ x: p.x, y: p.y }));
      for (let i = 1; i < src.length - 1; i++) {
        smoothed[i] = {
          x: src[i - 1].x * 0.22 + src[i].x * 0.56 + src[i + 1].x * 0.22,
          y: src[i - 1].y * 0.22 + src[i].y * 0.56 + src[i + 1].y * 0.22
        };
      }
      src = smoothed;
    }

    const points = [{ x: nodes[0].x, y: nodes[0].y }];
    const samples = this.settings.curveSamples;

    for (let i = 0; i < src.length - 1; i++) {
      const p1 = src[i];
      const p2 = src[i + 1];
      const nearEndpoint = i < 2 || i > src.length - 4;

      if (nearEndpoint) {
        // Keep endpoint segments linear to prevent Catmull overshoot loops.
        for (let s = 1; s <= samples; s++) {
          const t = s / samples;
          points.push({
            x: p1.x + (p2.x - p1.x) * t,
            y: p1.y + (p2.y - p1.y) * t
          });
        }
        continue;
      }

      const p0 = src[i - 1];
      const p3 = src[i + 2];
      for (let s = 1; s <= samples; s++) {
        const t = s / samples;
        const p = catmullRom(p0, p1, p2, p3, t);
        points.push({ x: p.x, y: p.y });
      }
    }

    return points;
  }

  _isWrappablePeg(peg) {
    if (!peg) return false;
    if (!Number.isFinite(peg.x) || !Number.isFinite(peg.y)) return false;
    if (peg.type === 'portalBlue' || peg.type === 'portalOrange') return false;
    return true;
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
