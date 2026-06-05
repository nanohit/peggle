// Yo-yo thread simulation for launched balls.
// Uses a rope-chain (Verlet) solver with obstacle constraints for smooth curved wrapping.

import { PHYSICS_CONFIG } from './physics.js';
import { Utils } from './utils.js';
import { getPortalScale, isPortalType } from './portal-defaults.js';

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

const YOYO_MAX_SOLVER_ITERATIONS = 22;
const YOYO_MAX_SUBSTEPS = 3;
const YOYO_LENGTH_BOOST_DIVISOR = 16;

// Obstacle broadphase grid: pack signed cell coords into one numeric Map key.
// Board cells are tiny (board px / ~28), so the offset/stride leave huge headroom.
const YOYO_GRID_KEY_OFFSET = 1024;
const YOYO_GRID_KEY_STRIDE = 8192;

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Ascending in-place sort for the tiny integer candidate lists from a grid query.
// Insertion sort beats native Array.sort here because it avoids the per-compare
// comparator call (the lists are short and nearly sorted), and is identical in
// result to `arr.sort((a, b) => a - b)`.
function insertionSortAsc(arr) {
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > v) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = v;
  }
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

  if (isPortalType(peg.type)) {
    return PHYSICS_CONFIG.pegRadius * getPortalScale(peg) + wrapPadding;
  }

  return PHYSICS_CONFIG.pegRadius + wrapPadding;
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
    solverIterations: Math.round(clamp(toFiniteNumber(merged.solverIterations, YOYO_DEFAULTS.solverIterations), 4, YOYO_MAX_SOLVER_ITERATIONS)),
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

  removeBall(ballId) {
    if (!ballId) return;
    this.states.delete(ballId);
  }

  setLaunchAnchor(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.launchAnchor.x = x;
    this.launchAnchor.y = y;
  }

  registerBallLaunch(ball, anchorX = this.launchAnchor.x, anchorY = this.launchAnchor.y, options = null) {
    if (!ball) return;
    const state = this._createState(ball, anchorX, anchorY, options);
    this.states.set(ball.id, state);
  }

  setBallAnchor(ballId, x, y, options = null) {
    if (!ballId || !Number.isFinite(x) || !Number.isFinite(y)) return;

    const state = this.states.get(ballId);
    if (!state) return;

    const prevX = Number.isFinite(state.anchorX) ? state.anchorX : x;
    const prevY = Number.isFinite(state.anchorY) ? state.anchorY : y;
    const dx = x - prevX;
    const dy = y - prevY;
    const hasAnchorPegOption = options && Object.prototype.hasOwnProperty.call(options, 'anchorPegId');
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
      if (hasAnchorPegOption) {
        state.anchorPegId = options.anchorPegId || null;
      }
      return;
    }

    state.anchorX = x;
    state.anchorY = y;
    if (hasAnchorPegOption) {
      state.anchorPegId = options.anchorPegId || null;
    }

    if (options?.moveOriginalAnchor !== false) {
      const originalX = Number.isFinite(state.originalAnchorX) ? state.originalAnchorX : prevX;
      const originalY = Number.isFinite(state.originalAnchorY) ? state.originalAnchorY : prevY;
      state.originalAnchorX = originalX + dx;
      state.originalAnchorY = originalY + dy;
    }

    if (options?.shiftNodes !== false) {
      this._shiftNodesFromAnchor(state.nodes, dx, dy);
    }

    if (Array.isArray(state.portalSegments) && state.portalSegments.length > 0) {
      for (const seg of state.portalSegments) {
        if (!seg) continue;
        if (Math.abs((seg.anchorX ?? prevX) - prevX) > 0.001 || Math.abs((seg.anchorY ?? prevY) - prevY) > 0.001) {
          continue;
        }
        seg.anchorX = (seg.anchorX ?? prevX) + dx;
        seg.anchorY = (seg.anchorY ?? prevY) + dy;
        if (options?.shiftNodes !== false) {
          this._shiftNodesFromAnchor(seg.nodes, dx, dy);
        }
      }
    }
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

  notePortalTeleport(ball, entryPeg, exitPeg) {
    if (!this.settings.enabled || !ball || !entryPeg || !exitPeg) return;

    const state = this.states.get(ball.id);
    if (!state || state.mode === 'released') return;
    if (!state.portalSegments) state.portalSegments = [];

    // --- Unwinding: exit is near the entry of the last frozen segment ---
    // This means the ball went backwards through the portal pair (O→B after B→O).
    if (state.portalSegments.length > 0) {
      const last = state.portalSegments[state.portalSegments.length - 1];
      if (Utils.distance(exitPeg.x, exitPeg.y, last.entryX, last.entryY) < 40) {
        const popped = state.portalSegments.pop();
        state.anchorX = popped.anchorX;
        state.anchorY = popped.anchorY;
        this._rebuildActiveNodes(state, ball);
        return;
      }
    }

    // --- Duplicate detection: re-entering the same portal we already have ---
    // When ball bounces B→O→B→O, the second B entry matches the first B entry.
    // Trim the stack back to that point so we replace instead of accumulating.
    for (let i = state.portalSegments.length - 1; i >= 0; i--) {
      const seg = state.portalSegments[i];
      if (Utils.distance(entryPeg.x, entryPeg.y, seg.entryX, seg.entryY) < 40) {
        // Re-entering the same portal. Restore anchor from this segment
        // and trim everything from this index onward.
        state.anchorX = seg.anchorX;
        state.anchorY = seg.anchorY;
        state.portalSegments.length = i;
        break;
      }
    }

    // --- Forward portal traversal: save current rope as live Verlet segment ---

    // Offset rope endpoints to the portal SURFACE so the rope treats portals
    // as solid obstacles. Without this, the anchor sits inside the portal's
    // obstacle brick and nodes fight the collision solver → shaking/spinning.
    const surfaceOffset = PHYSICS_CONFIG.pegRadius * 0.35 + this.settings.collisionMargin + 2;

    // Entry portal: pin the frozen segment's endpoint on the approach side
    const entryAngle = entryPeg.angle || 0;
    const entryNx = -Math.sin(entryAngle);
    const entryNy = Math.cos(entryAngle);
    const toAnchorDx = state.anchorX - entryPeg.x;
    const toAnchorDy = state.anchorY - entryPeg.y;
    const entrySide = (toAnchorDx * entryNx + toAnchorDy * entryNy) >= 0 ? 1 : -1;
    const entryPinX = entryPeg.x + entryNx * entrySide * surfaceOffset;
    const entryPinY = entryPeg.y + entryNy * entrySide * surfaceOffset;

    let segNodes;
    if (state.nodes && state.nodes.length >= 2) {
      // Clone current nodes as live Verlet nodes (preserving px/py for momentum).
      // Replace last node with entry portal surface so rope reaches the portal edge.
      segNodes = state.nodes.map(n => makeNode(n.x, n.y));
      const lastNode = segNodes[segNodes.length - 1];
      lastNode.x = entryPinX;
      lastNode.y = entryPinY;
      lastNode.px = entryPinX;
      lastNode.py = entryPinY;
    } else {
      segNodes = this._buildLinearNodes(
        state.anchorX, state.anchorY, entryPinX, entryPinY,
        Math.max(4, this.settings.minNodes)
      );
    }
    // Pin first node to segment anchor
    segNodes[0].x = state.anchorX;
    segNodes[0].y = state.anchorY;
    segNodes[0].px = state.anchorX;
    segNodes[0].py = state.anchorY;

    const segRopeLen = this._computeNodePathLength(segNodes);

    state.portalSegments.push({
      nodes: segNodes,
      ropeLength: segRopeLen,
      anchorX: state.anchorX,
      anchorY: state.anchorY,
      entryX: entryPeg.x,
      entryY: entryPeg.y,
      exitX: exitPeg.x,
      exitY: exitPeg.y,
      entryPinX,
      entryPinY
    });

    // Exit portal: place active anchor on the ball's side of the portal surface
    const exitAngle = exitPeg.angle || 0;
    const exitNx = -Math.sin(exitAngle);
    const exitNy = Math.cos(exitAngle);
    const toBallDx = ball.x - exitPeg.x;
    const toBallDy = ball.y - exitPeg.y;
    const exitSide = (toBallDx * exitNx + toBallDy * exitNy) >= 0 ? 1 : -1;
    state.anchorX = exitPeg.x + exitNx * exitSide * surfaceOffset;
    state.anchorY = exitPeg.y + exitNy * exitSide * surfaceOffset;
    this._rebuildActiveNodes(state, ball);

    // If total rope across segments already exceeds the budget, start retracting
    // immediately so the ball doesn't keep extending from the exit side.
    const totalBudget = this._portalRopeBudget(state);
    const usedInSegments = this._portalSegmentsLength(state);
    if (usedInSegments + state.ropeLength >= totalBudget && state.mode === 'extending') {
      state.mode = 'retracting';
      state.retractStartDist = Math.max(1, Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y));
      state.retractNodeCount = Math.max(8, state.nodes.length || this.settings.minNodes);
    }
  }

  _rebuildActiveNodes(state, ball) {
    const dist = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y);
    state.ropeLength = Math.max(dist + this.settings.extendSlackPixels, this.settings.ropeSegmentLength * 2);
    state.nodes = this._buildLinearNodes(state.anchorX, state.anchorY, ball.x, ball.y,
      Math.max(this.settings.minNodes, Math.ceil(dist / this.settings.ropeSegmentLength) + 1));
    state.prevBallX = ball.x;
    state.prevBallY = ball.y;
  }

  _portalSegmentsLength(state) {
    if (!state.portalSegments || state.portalSegments.length === 0) return 0;
    let total = 0;
    for (const seg of state.portalSegments) {
      total += seg.ropeLength || 0;
    }
    return total;
  }

  _portalRopeBudget(state) {
    // Total allowed rope across all segments + active.
    // Based on canvas height and trigger ratio with some headroom.
    const originalDist = Utils.distance(
      state.originalAnchorX || this.launchAnchor.x,
      state.originalAnchorY || this.launchAnchor.y,
      state.anchorX, state.anchorY
    );
    // Budget = height-based trigger distance + original anchor-to-current-anchor distance.
    // This allows enough rope for the original drop plus the portal jump, but no more.
    return this.height * this.settings.triggerDropRatio + originalDist * 0.5;
  }

  _simulatePortalSegment(seg, obstacles) {
    const nodes = seg.nodes;
    if (!nodes || nodes.length < 2) return;

    const lastIndex = nodes.length - 1;
    const segRest = Math.max(0.0001, seg.ropeLength / lastIndex);
    const ropeRadius = this.settings.ropeThickness * 0.5 + this.settings.collisionMargin;

    // Broadphase the (already filtered) obstacles so each interior node only
    // tests nearby pegs across the 8 iterations, same as the main rope solver.
    this._buildObstacleGrid(obstacles);
    const useGrid = this._gridUsableFor(obstacles);

    // Pin at surface positions when available, so rope endpoints stay outside
    // the portal obstacle brick instead of inside it.
    const pinAX = seg.anchorX;
    const pinAY = seg.anchorY;
    const pinBX = seg.entryPinX != null ? seg.entryPinX : seg.entryX;
    const pinBY = seg.entryPinY != null ? seg.entryPinY : seg.entryY;

    // Pin both endpoints every iteration
    const pinEndpoints = () => {
      nodes[0].x = pinAX;
      nodes[0].y = pinAY;
      nodes[0].px = pinAX;
      nodes[0].py = pinAY;
      nodes[lastIndex].x = pinBX;
      nodes[lastIndex].y = pinBY;
      nodes[lastIndex].px = pinBX;
      nodes[lastIndex].py = pinBY;
    };

    // Light inertial update (damped, both endpoints pinned so this just settles interior)
    for (let i = 1; i < lastIndex; i++) {
      const node = nodes[i];
      const vx = (node.x - node.px) * 0.85;
      const vy = (node.y - node.py) * 0.85;
      node.px = node.x;
      node.py = node.y;
      node.x += vx;
      node.y += vy;
    }

    // Solver iterations (fewer than main rope — these are pinned on both ends)
    const iterations = 8;
    for (let iter = 0; iter < iterations; iter++) {
      pinEndpoints();

      // Distance constraints
      for (let i = 0; i < lastIndex; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const diff = clamp((dist - segRest) / dist, -0.22, 0.35);
        const halfDiff = diff * 0.5;
        if (i > 0) {
          a.x += dx * halfDiff;
          a.y += dy * halfDiff;
        }
        if (i + 1 < lastIndex) {
          b.x -= dx * halfDiff;
          b.y -= dy * halfDiff;
        }
      }

      // Obstacle collisions for interior nodes
      for (let i = 1; i < lastIndex; i++) {
        const node = nodes[i];
        if (useGrid) {
          const bucket = this._gridBucketAt(node.x, node.y);
          if (bucket) {
            for (let k = 0; k < bucket.length; k++) {
              const obs = obstacles[bucket[k]];
              if (obs.kind === 'circle') this._resolveNodeCircle(node, obs, ropeRadius, false);
              else this._resolveNodeBrick(node, obs, ropeRadius, false);
            }
          }
        } else {
          for (const obs of obstacles) {
            if (obs.kind === 'circle') {
              this._resolveNodeCircle(node, obs, ropeRadius, false);
            } else {
              this._resolveNodeBrick(node, obs, ropeRadius, false);
            }
          }
        }
      }
    }

    pinEndpoints();
  }

  _simulateAllPortalSegments(state, obstacles) {
    if (!state.portalSegments || state.portalSegments.length === 0) return;
    const out = this._portalActiveObstacles || (this._portalActiveObstacles = []);
    for (const seg of state.portalSegments) {
      this._simulatePortalSegment(seg, this._filterObstaclesForNodes(seg.nodes, obstacles, null, null, null, out));
    }
  }

  getRenderThreads() {
    if (!this.settings.enabled) return [];

    const threads = [];
    for (const state of this.states.values()) {
      const ball = state.ballRef;
      if (!ball || !ball.active || !state.visible) continue;

      // Live portal segments (rope sections that went through portals)
      if (state.portalSegments) {
        for (const seg of state.portalSegments) {
          if (!seg.nodes || seg.nodes.length < 2) continue;
          const pts = this._buildRenderPoints(seg.nodes, seg);
          if (pts && pts.pointCount >= 2) {
            threads.push({
              ballId: state.ballId,
              mode: state.mode,
              points: pts.points,
              pointCount: pts.pointCount,
              flatPoints: true
            });
          }
        }
      }

      // Active segment (from current anchor to ball)
      if (!Array.isArray(state.nodes) || state.nodes.length < 2) continue;
      const points = this._buildRenderPoints(state.nodes, state);
      if (!points || points.pointCount < 2) continue;

      threads.push({
        ballId: state.ballId,
        mode: state.mode,
        points: points.points,
        pointCount: points.pointCount,
        flatPoints: true
      });
    }

    return threads;
  }

  _createState(ball, anchorX, anchorY, options = null) {
    const ax = Number.isFinite(anchorX) ? anchorX : this.launchAnchor.x;
    const ay = Number.isFinite(anchorY) ? anchorY : this.launchAnchor.y;
    const startLen = Utils.distance(ax, ay, ball.x, ball.y) + this.settings.extendSlackPixels;

    return {
      ballId: ball.id,
      ballRef: ball,
      anchorX: ax,
      anchorY: ay,
      originalAnchorX: ax,
      originalAnchorY: ay,
      mode: 'extending',
      visible: true,
      releaseTimer: 0,
      ropeLength: Math.max(0, startLen),
      nodes: [],
      retractStartDist: 0,
      prevBallX: ball.x,
      prevBallY: ball.y,
      retractNodeCount: 0,
      portalSegments: [],
      anchorPegId: options?.anchorPegId || null
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

  _shiftNodesFromAnchor(nodes, dx, dy) {
    if (!Array.isArray(nodes) || nodes.length < 2) return;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;

    const lastIndex = nodes.length - 1;
    for (let i = 0; i <= lastIndex; i++) {
      const node = nodes[i];
      if (!node) continue;
      const weight = 1 - (i / lastIndex);
      if (weight <= 0) continue;
      const sx = dx * weight;
      const sy = dy * weight;
      node.x += sx;
      node.y += sy;
      node.px += sx;
      node.py += sy;
    }
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
        state.portalSegments = [];
        state.anchorX = state.originalAnchorX || this.launchAnchor.x;
        state.anchorY = state.originalAnchorY || this.launchAnchor.y;
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
    const activeObstacles = this._filterObstaclesForState(state, ball, obstacles);
    this._buildObstacleGrid(activeObstacles);

    if (state.mode === 'extending') {
      this._simulateRope(state, ball, activeObstacles, dt, prevBallX, prevBallY);
      const direct = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y) + this.settings.extendSlackPixels;
      // Allow rope to grow when wrapping adds path length around obstacles.
      // The actual node path after collision solving may be longer than direct.
      const nodePathLen = this._computeNodePathLength(state.nodes);
      // Keep rope at least as long as direct, but preserve wrap-induced extra length.
      // Cap at 2.5x direct to prevent unbounded growth from solver jitter.
      // When portal segments exist, tighten the cap based on remaining rope budget.
      const hasPortalSegs = state.portalSegments && state.portalSegments.length > 0;
      let maxWrapLen;
      if (hasPortalSegs) {
        const usedInSegments = this._portalSegmentsLength(state);
        const budget = this._portalRopeBudget(state);
        const remaining = Math.max(direct, budget - usedInSegments);
        maxWrapLen = remaining;
      } else {
        maxWrapLen = direct + Math.min(direct * 0.85, this.height * 0.55);
      }
      state.ropeLength = Math.max(direct, Math.min(nodePathLen, maxWrapLen));

      const fallbackTriggerY = state.anchorY + this.height * this.settings.triggerDropRatio;
      const triggerY = Number.isFinite(retractStartY) ? retractStartY : fallbackTriggerY;
      let shouldRetract = ball.y >= triggerY && ball.vy > -0.2;
      // With portal segments, also retract when total rope hits the budget.
      if (!shouldRetract && hasPortalSegs) {
        const totalLen = this._portalSegmentsLength(state) + state.ropeLength;
        const budget = this._portalRopeBudget(state);
        if (totalLen >= budget && ball.vy > -0.2) {
          shouldRetract = true;
        }
      }
      if (shouldRetract) {
        state.mode = 'retracting';
        state.retractStartDist = Math.max(1, Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY));
        state.retractNodeCount = Math.max(8, state.nodes.length || this.settings.minNodes);
      }
      this._constrainBallToWorld(ball);
      this._pinEndpoints(state, ball);
      this._simulateAllPortalSegments(state, obstacles);
      state.prevBallX = ball.x;
      state.prevBallY = ball.y;
      return;
    }

    if (this._tryFinishRetractionAtAnchor(state, ball, releaseEvents)) {
      return;
    }

    const retractScale = this._getRetractSpeedScale(state, ball);
    const currentPathLen = this._computeNodePathLength(state.nodes);
    const shorten = this.settings.retractSpeed * retractScale * dt;
    const maxOver = this.settings.ropeSegmentLength * 2.25;
    const minByPath = Math.max(0, currentPathLen - maxOver);
    const grown = Math.max(minByPath, state.ropeLength - shorten);
    // Retraction must not let a jittery / dynamically-wrapped zig-zag path inflate
    // ropeLength (it can climb into the thousands, pinning node count + iteration
    // cost at max). Bound per-step growth and clamp to a hard ceiling. The extend
    // side already caps growth; this is the missing guard on the retract side.
    const maxGrowPerStep = this.settings.ropeSegmentLength * 2;
    const ropeCeiling = this.settings.maxNodes * this.settings.ropeSegmentLength * 1.5;
    state.ropeLength = Math.min(grown, state.ropeLength + maxGrowPerStep, ropeCeiling);
    this._simulateRope(state, ball, activeObstacles, dt, prevBallX, prevBallY);
    const prePullX = ball.x;
    const prePullY = ball.y;
    this._applyRetractionForce(state, ball, retractScale);
    this._simulateRope(state, ball, activeObstacles, dt, prePullX, prePullY);
    this._constrainBallToWorld(ball);
    this._pinEndpoints(state, ball);

    if (this._tryFinishRetractionAtAnchor(state, ball, releaseEvents)) {
      return;
    }

    this._simulateAllPortalSegments(state, obstacles);
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

  _isNearAnchorForRelease(state, ball) {
    const ballRadius = Number.isFinite(ball?.radius) ? ball.radius : PHYSICS_CONFIG.pegRadius;
    const releaseRadius = Math.max(
      this.settings.releaseRadius,
      ballRadius * 2 + this.settings.ropeSegmentLength * 0.65
    );
    const distToAnchor = Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY);
    if (distToAnchor <= releaseRadius) return true;

    return ball.y <= state.anchorY + releaseRadius * 0.9
      && Math.abs(ball.x - state.anchorX) <= releaseRadius * 1.6
      && ball.vy < 1.1;
  }

  _tryFinishRetractionAtAnchor(state, ball, releaseEvents = null) {
    if (!this._isNearAnchorForRelease(state, ball)) return false;

    // If there are portal segments, unwind through the portal instead of releasing.
    // The ball is near the current anchor (exit portal), so move it to the entry
    // surface of the previous segment and keep retracting toward the launcher.
    if (state.portalSegments && state.portalSegments.length > 0) {
      const popped = state.portalSegments.pop();

      ball.x = popped.entryPinX != null ? popped.entryPinX : popped.entryX;
      ball.y = popped.entryPinY != null ? popped.entryPinY : popped.entryY;
      ball.vx = 0;
      ball.vy = 0;

      state.anchorX = popped.anchorX;
      state.anchorY = popped.anchorY;

      if (popped.nodes && popped.nodes.length >= 2) {
        state.nodes = popped.nodes;
        const last = state.nodes[state.nodes.length - 1];
        last.x = ball.x;
        last.y = ball.y;
        last.px = ball.x;
        last.py = ball.y;
        const settledLen = this._computeNodePathLength(state.nodes);
        state.ropeLength = Math.min(popped.ropeLength, settledLen + this.settings.extendSlackPixels);
      } else {
        const dist = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y);
        state.ropeLength = Math.max(dist + this.settings.extendSlackPixels, this.settings.ropeSegmentLength * 2);
        state.nodes = this._buildLinearNodes(state.anchorX, state.anchorY, ball.x, ball.y,
          Math.max(this.settings.minNodes, Math.ceil(dist / this.settings.ropeSegmentLength) + 1));
      }

      state.retractStartDist = Math.max(1, Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y));
      state.prevBallX = ball.x;
      state.prevBallY = ball.y;
      return true;
    }

    state.mode = 'released';
    state.visible = false;
    state.releaseTimer = this.settings.rearmDelay;
    state.nodes.length = 0;
    state.retractStartDist = 0;
    state.portalSegments = [];
    state.anchorX = state.originalAnchorX || this.launchAnchor.x;
    state.anchorY = state.originalAnchorY || this.launchAnchor.y;
    state.anchorPegId = null;
    state.prevBallX = ball.x;
    state.prevBallY = ball.y;
    state.retractNodeCount = 0;
    if (ball.vy < -2) {
      ball.vy *= 0.35;
    }
    if (Array.isArray(releaseEvents)) {
      releaseEvents.push(state.ballId);
    }
    return true;
  }

  _getNodeBounds(nodes, margin = 0) {
    if (!Array.isArray(nodes) || nodes.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }

    if (!Number.isFinite(minX)) return null;
    return {
      minX: minX - margin,
      minY: minY - margin,
      maxX: maxX + margin,
      maxY: maxY + margin
    };
  }

  _boundsOverlap(a, b) {
    if (!a || !b) return true;
    return a.minX <= b.maxX && a.maxX >= b.minX
      && a.minY <= b.maxY && a.maxY >= b.minY;
  }

  _obstacleContainsPoint(obs, x, y, padding = 0) {
    if (!obs || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (obs.kind === 'circle') {
      const dx = x - obs.x;
      const dy = y - obs.y;
      const radius = obs.radius + padding;
      return dx * dx + dy * dy <= radius * radius;
    }

    const dx = x - obs.x;
    const dy = y - obs.y;
    const lx = dx * obs.cos + dy * obs.sin;
    const ly = -dx * obs.sin + dy * obs.cos;
    return Math.abs(lx) <= obs.halfW + padding
      && Math.abs(ly) <= obs.halfH + padding;
  }

  // `out`, when supplied, is reused (cleared + refilled) to avoid allocating a
  // fresh filtered array every step. The bounds-less fallback returns the full
  // obstacle list directly; callers always use the return value, so either is safe.
  _filterObstaclesForNodes(nodes, obstacles, skipPegId = null, anchorX = null, anchorY = null, out = null) {
    if (out) out.length = 0;
    if (!Array.isArray(obstacles) || obstacles.length === 0) return out || [];

    const ropeRadius = this.settings.ropeThickness * 0.5 + this.settings.collisionMargin;
    const margin = Math.max(this.settings.ropeSegmentLength * 4, ropeRadius + 24);
    const bounds = this._getNodeBounds(nodes, margin);
    if (!bounds) return obstacles;

    if (out) {
      for (let i = 0; i < obstacles.length; i++) {
        const obs = obstacles[i];
        if (!obs) continue;
        if (skipPegId && obs.pegId === skipPegId) continue;
        if (this._obstacleContainsPoint(obs, anchorX, anchorY, ropeRadius + 0.5)) continue;
        if (this._boundsOverlap(bounds, obs)) out.push(obs);
      }
      return out;
    }

    return obstacles.filter(obs => {
      if (!obs) return false;
      if (skipPegId && obs.pegId === skipPegId) return false;
      if (this._obstacleContainsPoint(obs, anchorX, anchorY, ropeRadius + 0.5)) return false;
      return this._boundsOverlap(bounds, obs);
    });
  }

  _filterObstaclesForState(state, ball, obstacles) {
    if (!Array.isArray(obstacles) || obstacles.length === 0) return [];

    let nodes = state.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) {
      nodes = [
        { x: state.anchorX, y: state.anchorY },
        { x: ball.x, y: ball.y }
      ];
    }

    return this._filterObstaclesForNodes(
      nodes,
      obstacles,
      state.anchorPegId,
      state.anchorX,
      state.anchorY,
      (this._activeObstacles || (this._activeObstacles = []))
    );
  }

  // ── Spatial broadphase for rope obstacles ──
  // The solver does nodes × obstacles × iterations × substeps collision checks.
  // Once a rope wraps wide, the rope-AABB candidate set is most of the board, so
  // every node was tested against every obstacle. A uniform grid lets each node/
  // segment test only obstacles in nearby cells. We grid the SAME filtered
  // candidate set and resolve in ascending index order, so far obstacles (which
  // only ever early-returned) are skipped while near-obstacle results are
  // identical — wrapping behaviour is preserved, not just approximated.
  _buildObstacleGrid(obstacles) {
    this._obsGridArray = obstacles;
    this._obsGridReady = false;
    const n = Array.isArray(obstacles) ? obstacles.length : 0;
    if (n === 0) return;

    let grid = this._obsGrid;
    if (!grid) grid = this._obsGrid = new Map();
    // Recycle bucket arrays across builds instead of letting clear() drop them.
    const freeBuckets = this._obsGridFreeBuckets || (this._obsGridFreeBuckets = []);
    if (grid.size > 0) {
      for (const bucket of grid.values()) { bucket.length = 0; freeBuckets.push(bucket); }
      grid.clear();
    }

    const baseRopeRadius = this.settings.ropeThickness * 0.5 + this.settings.collisionMargin;
    // Inflate insertion so a single-cell point query finds any obstacle within
    // collision reach (+ retract extra ~1.1 + a little move slack). NOTE: this is
    // a broadphase ACCELERATION, not a re-derivation of the full-loop — under fast
    // motion a node/segment can be pushed past this slack into an obstacle that
    // wasn't in its pre-query, so the solve can take a different (still stable,
    // endpoint-pinned) convergence path than scanning every obstacle would. A
    // margin wide enough to remove that costs most of the speedup, so we keep it
    // tight and accept settled-rope fidelity with fast-frame approximation.
    const inflate = baseRopeRadius + 1.1 + 5;
    const cell = Math.max(this.settings.ropeSegmentLength * 2, 28);
    this._obsGridCell = cell;
    this._obsGridInflate = inflate;

    for (let idx = 0; idx < n; idx++) {
      const o = obstacles[idx];
      if (!o) continue;
      const minCX = Math.floor((o.minX - inflate) / cell);
      const maxCX = Math.floor((o.maxX + inflate) / cell);
      const minCY = Math.floor((o.minY - inflate) / cell);
      const maxCY = Math.floor((o.maxY + inflate) / cell);
      for (let cx = minCX; cx <= maxCX; cx++) {
        for (let cy = minCY; cy <= maxCY; cy++) {
          const key = (cx + YOYO_GRID_KEY_OFFSET) * YOYO_GRID_KEY_STRIDE + (cy + YOYO_GRID_KEY_OFFSET);
          let bucket = grid.get(key);
          if (!bucket) { bucket = freeBuckets.pop() || []; grid.set(key, bucket); }
          bucket.push(idx);
        }
      }
    }

    if (!this._obsGridStamp || this._obsGridStamp.length < n) {
      this._obsGridStamp = new Int32Array(Math.max(n, 64));
    }
    this._obsGridReady = true;
  }

  _gridUsableFor(obstacles) {
    return this._obsGridReady && this._obsGridArray === obstacles;
  }

  // Obstacle-index bucket for the cell containing (x, y). Obstacles are inserted
  // with inflation >= collision reach, so one cell lookup is sufficient. The
  // bucket is already in ascending index order (built in index order).
  _gridBucketAt(x, y) {
    const cell = this._obsGridCell;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const key = (cx + YOYO_GRID_KEY_OFFSET) * YOYO_GRID_KEY_STRIDE + (cy + YOYO_GRID_KEY_OFFSET);
    return this._obsGrid.get(key) || null;
  }

  // Deduped, index-sorted obstacle indices overlapping a segment's inflated AABB.
  _gridQuerySegment(ax, ay, bx, by, out) {
    out.length = 0;
    const cell = this._obsGridCell;
    const inflate = this._obsGridInflate;
    const grid = this._obsGrid;
    const stamp = this._obsGridStamp;
    let stampId = (this._obsGridStampId || 0) + 1;
    if (stampId >= 2147483647) { stamp.fill(0); stampId = 1; }
    this._obsGridStampId = stampId;

    const minCX = Math.floor((Math.min(ax, bx) - inflate) / cell);
    const maxCX = Math.floor((Math.max(ax, bx) + inflate) / cell);
    const minCY = Math.floor((Math.min(ay, by) - inflate) / cell);
    const maxCY = Math.floor((Math.max(ay, by) + inflate) / cell);
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const bucket = grid.get((cx + YOYO_GRID_KEY_OFFSET) * YOYO_GRID_KEY_STRIDE + (cy + YOYO_GRID_KEY_OFFSET));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const idx = bucket[k];
          if (stamp[idx] === stampId) continue;
          stamp[idx] = stampId;
          out.push(idx);
        }
      }
    }
    if (out.length > 1) insertionSortAsc(out);
    return out;
  }

  _bendBlockedByObstacle(obs, x, y, ropeRadius) {
    if (obs.kind === 'circle') {
      const dx = x - obs.x;
      const dy = y - obs.y;
      const r = obs.radius + ropeRadius;
      return dx * dx + dy * dy < r * r;
    }
    if (obs.kind === 'brick') {
      const dx = x - obs.x;
      const dy = y - obs.y;
      const lx = dx * obs.cos + dy * obs.sin;
      const ly = -dx * obs.sin + dy * obs.cos;
      return Math.abs(lx) < obs.halfW + ropeRadius && Math.abs(ly) < obs.halfH + ropeRadius;
    }
    return false;
  }

  _ensureNodes(state, ball) {
    const direct = Utils.distance(state.anchorX, state.anchorY, ball.x, ball.y);
    const refLen = Math.max(state.ropeLength, direct + this.settings.extendSlackPixels);
    const extending = state.mode === 'extending';
    const retracting = state.mode === 'retracting';
    const finalRetract = retracting
      && !(state.portalSegments && state.portalSegments.length > 0)
      && direct <= this.settings.releaseRadius * 2.5;
    const minNodes = extending
      ? Math.max(6, Math.min(this.settings.minNodes, 10))
      : (finalRetract ? 4 : Math.max(4, this.settings.minNodes));
    const maxNodes = Math.max(minNodes + 1, this.settings.maxNodes);
    const segmentLen = extending
      ? this.settings.ropeSegmentLength * 1.14
      : this.settings.ropeSegmentLength;
    let targetCount = Math.round(clamp(Math.ceil(refLen / segmentLen) + 1, minNodes, maxNodes));
    if (!finalRetract && retracting && Number.isFinite(state.retractNodeCount) && state.retractNodeCount >= 8) {
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
    const substeps = Math.round(clamp(Math.ceil(moveDist / maxStep), 1, YOYO_MAX_SUBSTEPS));
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
    const lengthBoost = Math.round(clamp((nodes.length - 20) / YOYO_LENGTH_BOOST_DIVISOR, 0, 10));
    const baseIterations = Math.min(this.settings.solverIterations, YOYO_MAX_SOLVER_ITERATIONS);
    const iterations = Math.round(clamp(
      baseIterations + speedBoost + retractBoost + lengthBoost,
      baseIterations,
      YOYO_MAX_SOLVER_ITERATIONS
    ));

    for (let iter = 0; iter < iterations; iter++) {
      this._pinEndpoints(state, ball);
      this._solveDistanceConstraints(state, allowCompression);
      this._solveNodeObstacleConstraints(state, obstacles, ropeRadius, retracting);
      this._solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting);
      this._solveWorldBoundsConstraints(state, ropeRadius, retracting);
      this._solveBendConstraints(state, bendStiffness, obstacles, ropeRadius);
      this._clampSegmentLengths(state);
    }

    this._pinEndpoints(state, ball);
    this._solveNodeObstacleConstraints(state, obstacles, ropeRadius, retracting);
    this._solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting);
    this._solveWorldBoundsConstraints(state, ropeRadius, retracting);
    this._clampSegmentLengths(state);
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

  // Hard inextensibility cap: the soft distance constraint only corrects a
  // fraction per iteration, so a fast-moving peg (e.g. an aggressively rotating
  // ring) can fling adjacent nodes far apart faster than it can pull them back,
  // leaving the rope as long stretched strands that never retract. This pass
  // FULLY snaps any over-long segment back to a hard max, so the rope can never
  // visually stretch beyond `maxFactor`× its rest length per segment — under a
  // path it can't fit, it pulls taut and yanks the ball home instead.
  _clampSegmentLengths(state, maxFactor = 1.35) {
    const nodes = state.nodes;
    if (!nodes || nodes.length < 2) return;
    const lastIndex = nodes.length - 1;
    const segmentRest = Math.max(0.0001, state.ropeLength / lastIndex);
    const maxLen = segmentRest * maxFactor;
    for (let i = 0; i < lastIndex; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= maxLen || dist < 1e-6) continue;
      const corr = (dist - maxLen) / dist;
      if (i === 0) {
        b.x -= dx * corr;
        b.y -= dy * corr;
      } else if (i + 1 === lastIndex) {
        a.x += dx * corr;
        a.y += dy * corr;
      } else {
        const offX = dx * corr * 0.5;
        const offY = dy * corr * 0.5;
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
    const useGrid = hasObstacles && this._gridUsableFor(obstacles);

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
        if (useGrid) {
          const bucket = this._gridBucketAt(targetX, targetY);
          if (bucket) {
            for (let bk = 0; bk < bucket.length; bk++) {
              if (this._bendBlockedByObstacle(obstacles[bucket[bk]], targetX, targetY, ropeRadius)) {
                blocked = true;
                break;
              }
            }
          }
        } else {
          for (const obs of obstacles) {
            if (this._bendBlockedByObstacle(obs, targetX, targetY, ropeRadius)) {
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
    const useGrid = this._gridUsableFor(obstacles);

    for (let i = 1; i < lastIndex; i++) {
      const node = nodes[i];
      if (useGrid) {
        const bucket = this._gridBucketAt(node.x, node.y);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const obs = obstacles[bucket[k]];
          if (obs.kind === 'circle') this._resolveNodeCircle(node, obs, ropeRadius, retracting);
          else if (obs.kind === 'brick') this._resolveNodeBrick(node, obs, ropeRadius, retracting);
        }
      } else {
        for (const obs of obstacles) {
          if (obs.kind === 'circle') {
            this._resolveNodeCircle(node, obs, ropeRadius, retracting);
          } else if (obs.kind === 'brick') {
            this._resolveNodeBrick(node, obs, ropeRadius, retracting);
          }
        }
      }
    }
  }

  _solveSegmentObstacleConstraints(state, obstacles, ropeRadius, retracting = false) {
    if (!Array.isArray(obstacles) || obstacles.length === 0) return;

    const nodes = state.nodes;
    const lastIndex = nodes.length - 1;
    const useGrid = this._gridUsableFor(obstacles);
    const out = useGrid ? (this._obsQuery || (this._obsQuery = [])) : null;

    for (let i = 0; i < lastIndex; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];

      if (useGrid) {
        const cand = this._gridQuerySegment(a.x, a.y, b.x, b.y, out);
        for (let k = 0; k < cand.length; k++) {
          const obs = obstacles[cand[k]];
          if (obs.kind === 'circle') this._resolveSegmentCircle(a, b, obs, ropeRadius, i, lastIndex, retracting);
          else if (obs.kind === 'brick') this._resolveSegmentBrick(a, b, obs, ropeRadius, i, lastIndex, retracting);
        }
      } else {
        for (const obs of obstacles) {
          if (obs.kind === 'circle') {
            this._resolveSegmentCircle(a, b, obs, ropeRadius, i, lastIndex, retracting);
          } else if (obs.kind === 'brick') {
            this._resolveSegmentBrick(a, b, obs, ropeRadius, i, lastIndex, retracting);
          }
        }
      }
    }
  }

  _solveWorldBoundsConstraints(state, ropeRadius = 0, retracting = false) {
    const nodes = state.nodes;
    if (!Array.isArray(nodes) || nodes.length < 3) return;
    const margin = Math.max(0, ropeRadius);
    const minX = margin;
    const maxX = Math.max(minX, this.width - margin);
    const minY = margin;
    const lastIndex = nodes.length - 1;

    for (let i = 1; i < lastIndex; i++) {
      const node = nodes[i];
      if (!node) continue;
      if (node.x < minX) {
        node.x = minX;
        this._dampNodeAgainstNormal(node, 1, 0, retracting);
      } else if (node.x > maxX) {
        node.x = maxX;
        this._dampNodeAgainstNormal(node, -1, 0, retracting);
      }
      if (node.y < minY) {
        node.y = minY;
        this._dampNodeAgainstNormal(node, 0, 1, retracting);
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

    const distToAnchor = Utils.distance(ball.x, ball.y, state.anchorX, state.anchorY);
    const finalApproachRadius = Math.max(this.settings.releaseRadius * 2.4, this.settings.ropeSegmentLength * 5);
    const pivot = distToAnchor <= finalApproachRadius
      ? { x: state.anchorX, y: state.anchorY }
      : (this._getTailGuidePoint(nodes) || { x: state.anchorX, y: state.anchorY });
    const dx = ball.x - pivot.x;
    const dy = ball.y - pivot.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;

    const nx = dx / dist;
    const ny = dy / dist;

    const forceScale = clamp(retractScale * 0.85 + 0.15, 0.15, 1);
    const nearAnchorScale = clamp(distToAnchor / finalApproachRadius, 0.28, 1);
    const correction = Math.min(over, 18) * 0.54 * forceScale * nearAnchorScale;
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

    const pull = over * this.settings.tensionStrength * forceScale * nearAnchorScale;
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
    // Reuse pooled records + the output array across steps to avoid allocating a
    // fresh object per peg every frame (GC pressure while the solver is hottest).
    const out = this._obstacleList || (this._obstacleList = []);
    out.length = 0;
    if (!Array.isArray(pegs) || pegs.length === 0) return out;

    const pool = this._obstaclePool || (this._obstaclePool = []);
    let used = 0;
    const take = () => {
      let rec = pool[used];
      if (!rec) rec = pool[used] = {};
      used++;
      return rec;
    };

    for (const peg of pegs) {
      if (!this._isWrappablePeg(peg)) continue;

      // Wrap padding: inflate obstacle boundaries so the rope sees a slightly larger
      // obstacle. For small circle pegs (radius ~10px) this is critical — without it
      // there's too little surface for stable node-based wrapping.
      const wrapPad = 3.5;

      // Portals are line triggers — treat as thin bricks so rope wraps around them.
      if (isPortalType(peg.type)) {
        const halfLen = PHYSICS_CONFIG.pegRadius * getPortalScale(peg);
        const angle = peg.angle || 0;
        const halfW = halfLen + wrapPad;
        const halfH = PHYSICS_CONFIG.pegRadius * 0.35 + wrapPad;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const extX = Math.abs(cos) * halfW + Math.abs(sin) * halfH;
        const extY = Math.abs(sin) * halfW + Math.abs(cos) * halfH;
        const o = take();
        o.kind = 'brick'; o.pegId = peg.id; o.x = peg.x; o.y = peg.y;
        o.halfW = halfW; o.halfH = halfH; o.cos = cos; o.sin = sin;
        o.minX = peg.x - extX; o.maxX = peg.x + extX;
        o.minY = peg.y - extY; o.maxY = peg.y + extY;
        out.push(o);
        continue;
      }

      if (peg.shape === 'brick') {
        const width = peg.width || PHYSICS_CONFIG.brickWidth;
        const height = peg.height || PHYSICS_CONFIG.brickHeight;
        const angle = peg.angle || 0;
        const halfW = width * 0.5 + wrapPad;
        const halfH = height * 0.5 + wrapPad;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const extX = Math.abs(cos) * halfW + Math.abs(sin) * halfH;
        const extY = Math.abs(sin) * halfW + Math.abs(cos) * halfH;
        const o = take();
        o.kind = 'brick'; o.pegId = peg.id; o.x = peg.x; o.y = peg.y;
        o.halfW = halfW; o.halfH = halfH; o.cos = cos; o.sin = sin;
        o.minX = peg.x - extX; o.maxX = peg.x + extX;
        o.minY = peg.y - extY; o.maxY = peg.y + extY;
        out.push(o);
        continue;
      }

      const radius = getPegWrapRadius(peg, wrapPad);
      const o = take();
      o.kind = 'circle'; o.pegId = peg.id; o.x = peg.x; o.y = peg.y;
      o.radius = radius;
      o.minX = peg.x - radius; o.maxX = peg.x + radius;
      o.minY = peg.y - radius; o.maxY = peg.y + radius;
      out.push(o);
    }

    return out;
  }

  _growRenderCapacity(required) {
    let capacity = 16;
    while (capacity < required) {
      capacity *= 2;
    }
    return capacity;
  }

  _getRenderScratch(owner, nodeCount, pointCount) {
    const target = owner || this;
    let scratch = target._yoyoRenderScratch;
    if (!scratch) {
      scratch = {
        source: null,
        smooth: null,
        points: null,
        result: {
          points: null,
          pointCount: 0
        }
      };
      target._yoyoRenderScratch = scratch;
    }

    const nodeCoordCount = Math.max(4, nodeCount * 2);
    if (!scratch.source || scratch.source.length < nodeCoordCount) {
      const capacity = this._growRenderCapacity(nodeCoordCount);
      scratch.source = new Float32Array(capacity);
      scratch.smooth = new Float32Array(capacity);
    }

    const pointCoordCount = Math.max(4, pointCount * 2);
    if (!scratch.points || scratch.points.length < pointCoordCount) {
      scratch.points = new Float32Array(this._growRenderCapacity(pointCoordCount));
      scratch.result.points = scratch.points;
    }

    return scratch;
  }

  _buildRenderPoints(nodes, owner = null) {
    if (!Array.isArray(nodes) || nodes.length < 2) return null;

    const nodeCount = nodes.length;
    const samples = this.settings.curveSamples;
    const direct = nodeCount === 2 || samples <= 1;
    const maxPointCount = direct ? nodeCount : 1 + (nodeCount - 1) * samples;
    const scratch = this._getRenderScratch(owner, nodeCount, maxPointCount);
    const out = scratch.points;
    let count = 0;

    if (direct) {
      for (let i = 0; i < nodeCount; i++) {
        const writeIndex = count * 2;
        out[writeIndex] = nodes[i].x;
        out[writeIndex + 1] = nodes[i].y;
        count++;
      }
      scratch.result.pointCount = count;
      return scratch.result;
    }

    let src = scratch.source;
    let smoothed = scratch.smooth;
    for (let i = 0; i < nodeCount; i++) {
      const writeIndex = i * 2;
      src[writeIndex] = nodes[i].x;
      src[writeIndex + 1] = nodes[i].y;
    }

    // Render-time low-pass to remove tiny solver jitter without changing physics.
    for (let pass = 0; pass < 2; pass++) {
      smoothed[0] = src[0];
      smoothed[1] = src[1];
      const lastCoord = (nodeCount - 1) * 2;
      smoothed[lastCoord] = src[lastCoord];
      smoothed[lastCoord + 1] = src[lastCoord + 1];

      for (let i = 1; i < nodeCount - 1; i++) {
        const curr = i * 2;
        const prev = curr - 2;
        const next = curr + 2;
        smoothed[curr] = src[prev] * 0.22 + src[curr] * 0.56 + src[next] * 0.22;
        smoothed[curr + 1] = src[prev + 1] * 0.22 + src[curr + 1] * 0.56 + src[next + 1] * 0.22;
      }

      const tmp = src;
      src = smoothed;
      smoothed = tmp;
    }

    out[0] = nodes[0].x;
    out[1] = nodes[0].y;
    count = 1;

    for (let i = 0; i < nodeCount - 1; i++) {
      const p1Index = i * 2;
      const p2Index = p1Index + 2;
      const p1x = src[p1Index];
      const p1y = src[p1Index + 1];
      const p2x = src[p2Index];
      const p2y = src[p2Index + 1];
      const nearEndpoint = i < 2 || i > nodeCount - 4;

      if (nearEndpoint) {
        // Keep endpoint segments linear to prevent Catmull overshoot loops.
        for (let s = 1; s <= samples; s++) {
          const t = s / samples;
          const writeIndex = count * 2;
          out[writeIndex] = p1x + (p2x - p1x) * t;
          out[writeIndex + 1] = p1y + (p2y - p1y) * t;
          count++;
        }
        continue;
      }

      const p0Index = p1Index - 2;
      const p3Index = p2Index + 2;
      const p0x = src[p0Index];
      const p0y = src[p0Index + 1];
      const p3x = src[p3Index];
      const p3y = src[p3Index + 1];
      for (let s = 1; s <= samples; s++) {
        const t = s / samples;
        const t2 = t * t;
        const t3 = t2 * t;
        const writeIndex = count * 2;
        out[writeIndex] = 0.5 * (
          (2 * p1x) +
          (-p0x + p2x) * t +
          (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 +
          (-p0x + 3 * p1x - 3 * p2x + p3x) * t3
        );
        out[writeIndex + 1] = 0.5 * (
          (2 * p1y) +
          (-p0y + p2y) * t +
          (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
          (-p0y + 3 * p1y - 3 * p2y + p3y) * t3
        );
        count++;
      }
    }

    scratch.result.pointCount = count;
    return scratch.result;
  }

  _isWrappablePeg(peg) {
    if (!peg) return false;
    if (!Number.isFinite(peg.x) || !Number.isFinite(peg.y)) return false;
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
