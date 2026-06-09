// Peg Animation System - cyclic peg/group animations during gameplay

import { PHYSICS_CONFIG, getEffectiveBrickSize } from './physics.js';
import { getPortalScale, isPortalType } from './portal-defaults.js';

function linear(t) { return t; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); }

const EASING_FNS = { linear, easeInOut };
export const MIN_VISIBLE_RATIO = 0.3; // Keep at least 30% of a peg/brick visible before wrap
export const ANIMATION_WRAP_VISIBLE_RATIO = 0.5; // Animation wrap has no extra visibility margin

function positiveModulo(value, size) {
  return ((value % size) + size) % size;
}

export function wrapCoordinate(value, size) {
  if (!Number.isFinite(size) || size <= 0) return value;
  return positiveModulo(value, size);
}

function normalizeNumber(n) {
  return Number.isFinite(n) ? n : 0;
}

function wrapAxisToroidal(rawValue, size) {
  const safeRaw = normalizeNumber(rawValue);
  if (!Number.isFinite(size) || size <= 0) {
    return { value: safeRaw, shift: 0 };
  }
  const value = wrapCoordinate(safeRaw, size);
  return { value, shift: value - safeRaw };
}

// Mirror-wrap trace: trace a path from (startX, startY) along (dx, dy),
// reflecting at walls. When hitting a vertical wall (left/right), X teleports
// to the opposite wall and Y mirrors around the STARTING Y position (not H/2).
// Horizontal wall: Y teleports, X mirrors around starting X. The velocity
// direction is PRESERVED (no flip) so the remaining path heads back toward
// the origin area. This guarantees exactly 1 wall teleport for any angle.
// Find nearest wall hit alpha for a ray from (cx,cy) in direction (vx,vy)
function wallHitAlpha(cx, cy, vx, vy, W, H) {
  const eps = 1e-6;
  let alpha = Infinity;
  if (Math.abs(vx) > eps) {
    const a = (vx > 0 ? W - cx : -cx) / vx;
    if (a > eps) alpha = Math.min(alpha, a);
  }
  if (Math.abs(vy) > eps) {
    const a = (vy > 0 ? H - cy : -cy) / vy;
    if (a > eps) alpha = Math.min(alpha, a);
  }
  return alpha;
}

// Red-dot wrap: when the forward path crosses a wall, find where the
// REVERSE ray from the current position first hits a wall (the "red dot"),
// jump there, and continue with the remaining velocity at the same angle.
export function mirrorWrapTrace(startX, startY, dx, dy, W, H) {
  const eps = 1e-6;
  const hasW = Number.isFinite(W) && W > 0;
  const hasH = Number.isFinite(H) && H > 0;

  if (!hasW && !hasH) {
    return { x: startX + dx, y: startY + dy, mirrorX: false, mirrorY: false };
  }

  let cx = startX, cy = startY;
  let vx = dx, vy = dy;
  let guard = 0;

  while ((Math.abs(vx) > eps || Math.abs(vy) > eps) && guard < 10) {
    guard++;

    // How far forward until we hit a wall?
    const alphaFwd = wallHitAlpha(cx, cy, vx, vy, W, H);

    if (alphaFwd >= 1) {
      // No wall hit — reach destination directly
      cx += vx;
      cy += vy;
      break;
    }

    // Forward path hits a wall. Remaining velocity after the hit:
    const remainVx = vx * (1 - alphaFwd);
    const remainVy = vy * (1 - alphaFwd);

    // Find the "red dot": trace BACKWARDS from (cx, cy) until hitting a wall
    const alphaRev = wallHitAlpha(cx, cy, -vx, -vy, W, H);
    const redX = cx - vx * alphaRev;
    const redY = cy - vy * alphaRev;

    // Jump to red dot, continue with remaining velocity (same direction)
    cx = redX;
    cy = redY;
    vx = remainVx;
    vy = remainVy;
  }

  return { x: cx, y: cy, mirrorX: false, mirrorY: false };
}

// Compute inverse displacement: same destination, opposite path.
// If normal goes direct, inverse wraps. If normal wraps, inverse goes direct.
// Formula: k = alphaBack + alphaFwd - (D - C) / d, then inverse = -k * d.
function resolveInverseMotion(dx, dy, cx, cy, W, H) {
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return { dx: 0, dy: 0 };
  const hasW = W > 0, hasH = H > 0;
  if (!hasW && !hasH) return { dx: -dx, dy: -dy };

  // Destination via normal path
  const dest = mirrorWrapTrace(cx, cy, dx, dy, W, H);

  // Check if normal path crosses a wall
  const alphaFwd = wallHitAlpha(cx, cy, dx, dy, W, H);
  const normalWraps = alphaFwd < 1 - 1e-6;

  if (normalWraps) {
    // Normal wraps → inverse is the direct path to destination
    return { dx: dest.x - cx, dy: dest.y - cy };
  }

  // Normal is direct → inverse wraps through the wall behind
  const alphaBack = wallHitAlpha(cx, cy, -dx, -dy, W, H);

  // k from the axis with larger displacement (numerical stability)
  let k;
  if (Math.abs(dx) > Math.abs(dy)) {
    k = alphaBack + alphaFwd - (dest.x - cx) / dx;
  } else {
    k = alphaBack + alphaFwd - (dest.y - cy) / dy;
  }

  if (k <= 0.01) return { dx: dest.x - cx, dy: dest.y - cy }; // fallback to direct
  return { dx: -k * dx, dy: -k * dy };
}

// Resolve animation motion vector.
// When inverse is true, computes the opposite-path displacement to reach the same destination.
// centerX/centerY are needed for inverse computation (the animation origin point).
export function resolveWrappedMotion(requestedDx, requestedDy, width, height, inverse = false, centerX = 0, centerY = 0) {
  const baseDx = normalizeNumber(requestedDx);
  const baseDy = normalizeNumber(requestedDy);
  if (!inverse) return { dx: baseDx, dy: baseDy };
  return resolveInverseMotion(baseDx, baseDy, centerX, centerY, width, height);
}

function getVisibilityMargin(extent, minVisibleRatio = MIN_VISIBLE_RATIO) {
  const safeExtent = Math.max(0, normalizeNumber(extent));
  const safeRatio = Math.max(0, Math.min(0.5, minVisibleRatio));
  return safeExtent * (1 - 2 * safeRatio);
}

export function wrapWithVisibility(rawValue, size, extent, minVisibleRatio = MIN_VISIBLE_RATIO) {
  if (!Number.isFinite(size) || size <= 0) {
    return { value: rawValue, shift: 0 };
  }

  const margin = getVisibilityMargin(extent, minVisibleRatio);
  const minAllowed = -margin;
  const maxAllowed = size + margin;

  let value = normalizeNumber(rawValue);
  let shift = 0;
  while (value < minAllowed) {
    value += size;
    shift += size;
  }
  while (value > maxAllowed) {
    value -= size;
    shift -= size;
  }

  return { value, shift };
}

// Wrap a 2D point independently on each axis, keeping it within the visible
// area defined by [−margin, size+margin].
export function wrapPointWithVisibility(
  rawX, rawY, width, height,
  extentX, extentY,
  minVisibleRatio = MIN_VISIBLE_RATIO
) {
  const hasX = Number.isFinite(width) && width > 0;
  const hasY = Number.isFinite(height) && height > 0;
  const safeRawX = normalizeNumber(rawX);
  const safeRawY = normalizeNumber(rawY);
  if (!hasX && !hasY) {
    return { x: safeRawX, y: safeRawY, shiftX: 0, shiftY: 0 };
  }

  const marginX = getVisibilityMargin(extentX, minVisibleRatio);
  const marginY = getVisibilityMargin(extentY, minVisibleRatio);
  const minX = -marginX;
  const maxX = (hasX ? width : safeRawX) + marginX;
  const minY = -marginY;
  const maxY = (hasY ? height : safeRawY) + marginY;

  let x = safeRawX, y = safeRawY;
  let shiftX = 0, shiftY = 0;
  let guard = 0;
  while (hasX && x < minX && guard < 80)  { x += width;  shiftX += width;  guard++; }
  while (hasX && x > maxX && guard < 160) { x -= width;  shiftX -= width;  guard++; }
  while (hasY && y < minY && guard < 240) { y += height; shiftY += height; guard++; }
  while (hasY && y > maxY && guard < 320) { y -= height; shiftY -= height; guard++; }

  return { x, y, shiftX, shiftY };
}

export function estimatePegExtents(peg, centerX, centerY, angle = 0, slices = null) {
  if (!peg || peg.shape !== 'brick') {
    let r = PHYSICS_CONFIG.pegRadius;
    if (peg && peg.type === 'bumper') {
      r *= (peg.bumperScale || 1);
    } else if (peg && isPortalType(peg.type)) {
      const halfLen = r * getPortalScale(peg);
      const halfThick = Math.max(2, PHYSICS_CONFIG.pegRadius * 0.25);
      const c = Math.abs(Math.cos(angle || peg.angle || 0));
      const s = Math.abs(Math.sin(angle || peg.angle || 0));
      return {
        x: c * halfLen + s * halfThick,
        y: s * halfLen + c * halfThick
      };
    }
    return { x: r, y: r };
  }

  const effBrick = getEffectiveBrickSize(peg);
  const halfH = effBrick.height / 2;
  if (slices && slices.length >= 2) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const s of slices) {
      const x1 = s.x + s.nx * halfH;
      const x2 = s.x - s.nx * halfH;
      const y1 = s.y + s.ny * halfH;
      const y2 = s.y - s.ny * halfH;
      minX = Math.min(minX, x1, x2);
      maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
    return {
      x: Math.max(maxX - centerX, centerX - minX, PHYSICS_CONFIG.pegRadius),
      y: Math.max(maxY - centerY, centerY - minY, PHYSICS_CONFIG.pegRadius)
    };
  }

  const halfW = effBrick.width / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: Math.abs(cos) * halfW + Math.abs(sin) * halfH,
    y: Math.abs(sin) * halfW + Math.abs(cos) * halfH
  };
}

// Compute displacement along a circular arc.
// The vector (dx, dy) defines the diameter: start→end.
// t is 0→1 progress along the arc.
// arcSpan: Math.PI for semicircle, 2*Math.PI for full circle.
// Returns { tx, ty } displacement from the start position.
function circularDisplacement(dx, dy, t, arcSpan) {
  const D = Math.sqrt(dx * dx + dy * dy);
  if (D < 0.001) return { tx: 0, ty: 0 };
  const R = D / 2;
  const theta = Math.atan2(dy, dx);
  const startAngle = theta + Math.PI;
  const angle = startAngle + t * arcSpan;
  return {
    tx: dx / 2 + R * Math.cos(angle),
    ty: dy / 2 + R * Math.sin(angle)
  };
}

// ── Freeform trajectory paths (poly-cubic-bezier) ──
// A path is { anchors: [{ x, y, hIn:{x,y}, hOut:{x,y} }], closed }, with all
// coordinates expressed as OFFSETS from the animation's natural center and
// anchors[0] = {0,0}. The element follows this curve by arc length.

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u, uuu = uu * u;
  const tt = t * t, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
  };
}

// Largest poly-bezier the LUT will materialize. Authoring is capped well below
// this (see editor MAX_ANIM_PATH_ANCHORS); the guard only matters for corrupt
// or hand-crafted level payloads, keeping load-time cost/memory bounded.
const MAX_PATH_ANCHORS = 256;
const PATH_LUT_SAMPLE_BUDGET = 1200;

// Build an arc-length lookup table for a path. Returns { pts, cum, total } or null.
export function buildPathLUT(path, segPerCurve = 18) {
  let anchors = path?.anchors;
  if (!Array.isArray(anchors) || anchors.length < 2) return null;
  if (anchors.length > MAX_PATH_ANCHORS) anchors = anchors.slice(0, MAX_PATH_ANCHORS);
  const pts = [];
  const cum = [];
  let total = 0;
  const pushPoint = (x, y) => {
    if (pts.length > 0) {
      const last = pts[pts.length - 1];
      total += Math.hypot(x - last.x, y - last.y);
    }
    pts.push({ x, y });
    cum.push(total);
  };
  pushPoint(anchors[0].x, anchors[0].y);
  const segCount = path.closed ? anchors.length : anchors.length - 1;
  // Bound total samples so a long path can't blow up load-time cost.
  const seg = Math.max(4, Math.min(segPerCurve, Math.floor(PATH_LUT_SAMPLE_BUDGET / Math.max(1, segCount))));
  for (let i = 0; i < segCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const p0 = { x: a.x, y: a.y };
    const p1 = a.hOut ? { x: a.hOut.x, y: a.hOut.y } : { x: a.x, y: a.y };
    const p2 = b.hIn ? { x: b.hIn.x, y: b.hIn.y } : { x: b.x, y: b.y };
    const p3 = { x: b.x, y: b.y };
    for (let s = 1; s <= seg; s++) {
      const pt = cubicPoint(p0, p1, p2, p3, s / seg);
      pushPoint(pt.x, pt.y);
    }
  }
  if (total < 1e-6) return null;
  return { pts, cum, total };
}

// Sample the path displacement (relative to anchor[0]) at parameter u in [0,1].
export function samplePathLUT(lut, u) {
  if (!lut || lut.pts.length === 0) return { tx: 0, ty: 0 };
  const clamped = u <= 0 ? 0 : (u >= 1 ? 1 : u);
  const target = clamped * lut.total;
  const { pts, cum } = lut;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1; else hi = mid;
  }
  const i = lo;
  const prev = i > 0 ? i - 1 : 0;
  const segLen = cum[i] - cum[prev];
  const f = segLen > 1e-9 ? (target - cum[prev]) / segLen : 0;
  const x = pts[prev].x + (pts[i].x - pts[prev].x) * f;
  const y = pts[prev].y + (pts[i].y - pts[prev].y) * f;
  return { tx: x - pts[0].x, ty: y - pts[0].y };
}

export class PegAnimator {
  constructor() {
    this.originalPositions = new Map(); // pegId → {x, y, angle, curveSlices?}
    this.animations = [];               // compiled animation entries
    this.animatedPegIds = new Set();    // pegs affected by active animations
    this.suspendedPegIds = new Set();   // pegs detached from their authored animation
    this.elapsed = 0;
    this._hitTriggerState = new Map();  // animIndex → { active, elapsed, forward }
  }

  loadFromLevel(pegs, groups = [], options = {}) {
    // When a group loses members mid-play (destruction knocks pegs off), reloading must
    // NOT re-derive the rotation center from the *remaining* pegs — that drifts the origin
    // (and any explicit Set Origin pivot, which is an offset from it) toward the new local
    // centroid. preserveGroupOrigins keeps each group anchored to its prior center.
    // A mid-play structure refresh (a peg knocked off a group) reuses this method only to
    // rebuild group membership — it must NOT restart the in-progress animations. So when
    // preserving, keep the global clock, the authored rest snapshots, the suspended
    // (physics-owned) set, and each animation's hit-trigger progress. Resetting `elapsed`
    // snapped every continuous A↔B / cycle animation back to its start (point A) on ANY
    // removal, and re-snapshotting originalPositions against the current animated pose
    // doubled the displacement.
    const preserveGroupOrigins = options.preserveGroupOrigins === true;
    const preserveTimeline = preserveGroupOrigins;
    const animKey = (a) => (a.type === 'group' ? `g:${a.groupId}` : `p:${a.pegIds[0]}`);
    const prevGroupCenters = preserveGroupOrigins ? new Map() : null;
    const prevHitStates = preserveTimeline ? new Map() : null;
    if (prevGroupCenters || prevHitStates) {
      for (let ai = 0; ai < this.animations.length; ai++) {
        const a = this.animations[ai];
        if (prevGroupCenters && a.type === 'group' && a.groupId != null) {
          prevGroupCenters.set(a.groupId, { centerX: a.centerX, centerY: a.centerY });
        }
        if (prevHitStates && a.hitTrigger) {
          const ht = this._hitTriggerState.get(ai);
          if (ht) prevHitStates.set(animKey(a), ht);
        }
      }
    }
    const prevOriginalPositions = preserveTimeline ? this.originalPositions : null;
    this.originalPositions = new Map();
    this.animations = [];
    this.animatedPegIds.clear();
    if (!preserveTimeline) {
      this.suspendedPegIds.clear();
      this.elapsed = 0;
    }
    this._hitTriggerState = new Map();

    // Build peg lookup
    const pegMap = new Map();
    for (const p of pegs) {
      pegMap.set(p.id, p);
      p._animWrapShiftX = 0;
      p._animWrapShiftY = 0;
      p._wrapCopies = null;
      p._wrapHideMain = false;
      // Reuse the existing authored snapshot on a preserving refresh (so the rest layout —
      // the animation's baseline — stays the original A pose, not the current animated one);
      // otherwise snapshot the current position (deep-copying curveSlices).
      let snap = prevOriginalPositions ? prevOriginalPositions.get(p.id) : null;
      if (!snap) {
        snap = { x: p.x, y: p.y, angle: p.angle || 0 };
        if (p.curveSlices) {
          snap.curveSlices = p.curveSlices.map(s => ({ x: s.x, y: s.y, nx: s.nx, ny: s.ny }));
        }
      }
      this.originalPositions.set(p.id, snap);
    }

    // Track pegs already handled by group animations
    const groupAnimatedIds = new Set();

    // Process group animations
    for (const group of groups) {
      if (!group.animation) continue;
      const anim = group.animation;
      const memberIds = [];
      let cx = 0, cy = 0, count = 0;

      for (const p of pegs) {
        if (p.groupId === group.id) {
          memberIds.push(p.id);
          const orig = this.originalPositions.get(p.id);
          cx += orig.x;
          cy += orig.y;
          count++;
          groupAnimatedIds.add(p.id);
        }
      }
      if (count === 0) continue;
      cx /= count;
      cy /= count;
      // Keep the original anchor when preserving (so the spin axis / Set Origin doesn't
      // slide toward the remaining pegs); extents below still reflect the current members.
      const preservedCenter = prevGroupCenters?.get(group.id);
      if (preservedCenter) {
        cx = preservedCenter.centerX;
        cy = preservedCenter.centerY;
      }
      let extentX = PHYSICS_CONFIG.pegRadius;
      let extentY = PHYSICS_CONFIG.pegRadius;
      for (const pegId of memberIds) {
        const peg = pegMap.get(pegId);
        const orig = this.originalPositions.get(pegId);
        if (!peg || !orig) continue;
        const ex = estimatePegExtents(peg, orig.x, orig.y, orig.angle || 0, orig.curveSlices);
        extentX = Math.max(extentX, Math.abs(orig.x - cx) + ex.x);
        extentY = Math.max(extentY, Math.abs(orig.y - cy) + ex.y);
      }

      const entry = {
        type: 'group',
        groupId: group.id,
        pegIds: memberIds,
        centerX: cx,
        centerY: cy,
        extentX,
        extentY,
        dx: anim.dx || 0,
        dy: anim.dy || 0,
        rotation: anim.rotation || 0,
        duration: anim.duration || 2,
        wrap: anim.wrap !== false,
        inverse: !!anim.inverse,
        cycle: !!anim.cycle,
        easingFn: anim.cycle ? linear : (EASING_FNS[anim.easing] || linear),
        hitTrigger: !!anim.hitTrigger,
        hitMode: anim.hitMode || 'cycle',
        hitSteps: Math.max(1, Math.round(anim.hitSteps || 1)),
        circularPath: !!anim.circularPath,
        circularFull: !!anim.circularFull,
        pivot: anim.pivot ? { dx: anim.pivot.dx || 0, dy: anim.pivot.dy || 0 } : null,
        path: anim.path || null,
        _pathLUT: anim.path ? buildPathLUT(anim.path) : null,
      };
      this.animations.push(entry);
      if (entry.hitTrigger) {
        const restored = prevHitStates ? prevHitStates.get(animKey(entry)) : null;
        this._hitTriggerState.set(this.animations.length - 1, restored || { active: false, elapsed: 0, forward: true, step: 0, _prevStep: 0 });
      }
      for (const pegId of memberIds) this.animatedPegIds.add(pegId);
    }

    // Process individual peg animations
    for (const p of pegs) {
      if (groupAnimatedIds.has(p.id)) continue;
      if (!p.animation) continue;
      const anim = p.animation;
      const ex = estimatePegExtents(p, p.x, p.y, p.angle || 0, p.curveSlices);

      const entry = {
        type: 'individual',
        pegIds: [p.id],
        centerX: p.x,
        centerY: p.y,
        extentX: ex.x,
        extentY: ex.y,
        dx: anim.dx || 0,
        dy: anim.dy || 0,
        rotation: anim.rotation || 0,
        duration: anim.duration || 2,
        wrap: anim.wrap !== false,
        inverse: !!anim.inverse,
        cycle: !!anim.cycle,
        easingFn: anim.cycle ? linear : (EASING_FNS[anim.easing] || linear),
        hitTrigger: !!anim.hitTrigger,
        hitMode: anim.hitMode || 'cycle',
        hitSteps: Math.max(1, Math.round(anim.hitSteps || 1)),
        circularPath: !!anim.circularPath,
        circularFull: !!anim.circularFull,
        pivot: anim.pivot ? { dx: anim.pivot.dx || 0, dy: anim.pivot.dy || 0 } : null,
        path: anim.path || null,
        _pathLUT: anim.path ? buildPathLUT(anim.path) : null,
      };
      this.animations.push(entry);
      if (entry.hitTrigger) {
        const restored = prevHitStates ? prevHitStates.get(animKey(entry)) : null;
        this._hitTriggerState.set(this.animations.length - 1, restored || { active: false, elapsed: 0, forward: true, step: 0, _prevStep: 0 });
      }
      this.animatedPegIds.add(p.id);
    }
  }

  // Returns true if any animation actually applied a transform this frame, so
  // callers can avoid re-dirtying the physics peg grid when nothing moved
  // (e.g. static levels, or hit-trigger animations that haven't fired yet).
  tick(pegs, dtSeconds, bounds = null) {
    if (this.animations.length === 0) return false;
    this.elapsed += dtSeconds;
    let movedAny = false;

    // Build peg lookup for fast access
    const pegMap = new Map();
    for (const p of pegs) pegMap.set(p.id, p);

    const worldWidth = bounds?.width;
    const worldHeight = bounds?.height;
    const canWrapX = Number.isFinite(worldWidth) && worldWidth > 0;
    const canWrapY = Number.isFinite(worldHeight) && worldHeight > 0;

    for (let ai = 0; ai < this.animations.length; ai++) {
      const anim = this.animations[ai];
      const duration = Math.max(anim.duration || 0, 0.001);

      // Hit-triggered animations: use their own elapsed time
      let animElapsed = this.elapsed;
      if (anim.hitTrigger) {
        const ht = this._hitTriggerState.get(ai);
        if (!ht) continue;
        if (!ht.active) {
          // Not yet triggered — pegs stay at origin
          continue;
        }
        ht.elapsed += dtSeconds;

        if (anim.hitMode === 'single' || anim.hitMode === 'spin') {
          const steps = anim.hitSteps || 1;
          // Duration per step (full duration divided by steps)
          const stepDur = duration / steps;
          const rawT = Math.min(ht.elapsed / stepDur, 1);
          const eased = anim.easingFn(rawT);

          if (anim.hitMode === 'spin') {
            // Spin: step increments forever, _singleT is unbounded
            const increment = 1 / steps;
            const prevVal = (ht._prevStep != null ? ht._prevStep : ht.step) * increment;
            const targetVal = ht.step * increment;
            ht._singleT = prevVal + (targetVal - prevVal) * eased;
          } else if (steps > 1) {
            // Multi-step single: animate between previous and current step fraction (0→1)
            const targetFrac = ht.step / steps;
            const prevFrac = (ht._prevStep != null ? ht._prevStep : ht.step) / steps;
            ht._singleT = prevFrac + (targetFrac - prevFrac) * eased;
          } else {
            // Single step (original behavior): 0→1 or 1→0
            ht._singleT = ht.forward ? eased : (1 - eased);
          }

          if (rawT >= 1) {
            ht.active = false;
            ht.elapsed = 0;
            if (anim.hitMode === 'single' && steps <= 1) {
              // Ping-pong: flip direction
              ht.forward = !ht.forward;
            }
          }
        } else {
          // Cycle mode: loop continuously from moment of hit
          animElapsed = ht.elapsed;
        }
      }

      let tx, ty, rot;
      // wrapRefDx/Dy = the FORWARD displacement used for crossOffset computation.
      // Always points in the forward direction (never negated for return legs),
      // because the return leg crosses the same wall as the forward leg.
      let wrapRefDx = 0, wrapRefDy = 0;

      // Freeform trajectory: follow a poly-bezier curve by arc length.
      // Overrides dx/dy + circularPath. Self-contained ⇒ no toroidal wrap.
      if (anim._pathLUT) {
        const hitSingleSpin = anim.hitTrigger && (anim.hitMode === 'single' || anim.hitMode === 'spin');
        let baseU;
        if (hitSingleSpin) {
          const ht = this._hitTriggerState.get(ai);
          baseU = ht ? ht._singleT || 0 : 0;
        } else if (anim.cycle) {
          baseU = (animElapsed % duration) / duration; // loop 0→1
        } else {
          const fullCycle = duration * 2;
          const phase = (animElapsed % fullCycle) / duration;
          const rawT = phase <= 1 ? phase : 2 - phase;
          baseU = anim.easingFn(rawT); // ping-pong
        }
        const u = anim.inverse ? 1 - baseU : baseU;
        const disp = samplePathLUT(anim._pathLUT, u);
        tx = disp.tx;
        ty = disp.ty;
        // Rotation stays independent of the path (continuous in cycle, ping-pong otherwise).
        const rotPhase = (anim.cycle && !hitSingleSpin) ? (animElapsed / duration) : baseU;
        rot = anim.rotation * rotPhase;
        wrapRefDx = 0;
        wrapRefDy = 0;

      // Circular path: object follows a circular arc defined by the displacement vector
      } else if (anim.circularPath) {
        const arcSpan = anim.circularFull ? Math.PI * 2 : Math.PI;

        if (anim.hitTrigger && (anim.hitMode === 'single' || anim.hitMode === 'spin')) {
          const ht = this._hitTriggerState.get(ai);
          const t = ht ? ht._singleT || 0 : 0;
          const circ = circularDisplacement(anim.dx, anim.dy, t, arcSpan);
          tx = circ.tx;
          ty = circ.ty;
          rot = anim.rotation * t;
        } else if (anim.circularFull) {
          // Full circle: continuous sawtooth phase
          const phase = (animElapsed % duration) / duration;
          const circ = circularDisplacement(anim.dx, anim.dy, phase, arcSpan);
          tx = circ.tx;
          ty = circ.ty;
          rot = anim.rotation * (animElapsed / duration);
        } else {
          // Half circle: ping-pong along semicircular arc
          const fullCycle = duration * 2;
          const phase = (animElapsed % fullCycle) / duration;
          const rawT = phase <= 1 ? phase : 2 - phase;
          const t = anim.easingFn(rawT);
          const circ = circularDisplacement(anim.dx, anim.dy, t, arcSpan);
          tx = circ.tx;
          ty = circ.ty;
          rot = anim.rotation * t;
        }
        wrapRefDx = anim.dx;
        wrapRefDy = anim.dy;

      // Single/spin hit trigger: compute tx/ty directly from _singleT and skip normal phase
      } else if (anim.hitTrigger && (anim.hitMode === 'single' || anim.hitMode === 'spin')) {
        const ht = this._hitTriggerState.get(ai);
        const t = ht ? ht._singleT || 0 : 0;
        const motion = (anim.wrap && (canWrapX || canWrapY))
          ? resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, anim.inverse, anim.centerX, anim.centerY)
          : { dx: anim.dx, dy: anim.dy };
        tx = motion.dx * t;
        ty = motion.dy * t;
        rot = anim.rotation * t;
        wrapRefDx = motion.dx;
        wrapRefDy = motion.dy;
      } else if (anim.cycle && anim.wrap && (canWrapX || canWrapY)) {
        const cx = anim.centerX, cy = anim.centerY;
        const phase = (animElapsed % duration) / duration; // 0→1 sawtooth
        rot = anim.rotation * (animElapsed / duration);

        if (anim.inverse) {
          // Two-path cycle: forward via inverse path, return via normal path
          const fwdDisp = resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, true, cx, cy);
          const retDisp = resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, false, cx, cy);

          // Split duration proportional to path lengths for constant speed
          const fwdLen = Math.sqrt(fwdDisp.dx ** 2 + fwdDisp.dy ** 2);
          const retLen = Math.sqrt(retDisp.dx ** 2 + retDisp.dy ** 2);
          const totalLen = fwdLen + retLen || 1;
          const fwdFrac = fwdLen / totalLen;

          if (phase < fwdFrac) {
            const localT = phase / fwdFrac;
            tx = fwdDisp.dx * localT;
            ty = fwdDisp.dy * localT;
            wrapRefDx = fwdDisp.dx;
            wrapRefDy = fwdDisp.dy;
          } else {
            const localT = (phase - fwdFrac) / (1 - fwdFrac);
            tx = retDisp.dx * (1 - localT);
            ty = retDisp.dy * (1 - localT);
            // Use the forward displacement for crossOffset (same wall crossing)
            wrapRefDx = retDisp.dx;
            wrapRefDy = retDisp.dy;
          }
        } else {
          // Non-inverse cycle: retrace same path
          const fwd = resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, false, cx, cy);
          if (phase < 0.5) {
            const localT = phase / 0.5;
            tx = fwd.dx * localT;
            ty = fwd.dy * localT;
          } else {
            const localT = (phase - 0.5) / 0.5;
            tx = fwd.dx * (1 - localT);
            ty = fwd.dy * (1 - localT);
          }
          // Same displacement for both legs (same wall crossing)
          wrapRefDx = fwd.dx;
          wrapRefDy = fwd.dy;
        }
      } else {
        // Normal ping-pong (or cycle without wrap, treated as ping-pong)
        const fullCycle = duration * 2;
        const phase = (animElapsed % fullCycle) / duration;
        const rawT = phase <= 1 ? phase : 2 - phase;
        const t = anim.easingFn(rawT);

        const motion = (anim.wrap && (canWrapX || canWrapY))
          ? resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, anim.inverse, anim.centerX, anim.centerY)
          : { dx: anim.dx, dy: anim.dy };
        tx = motion.dx * t;
        ty = motion.dy * t;
        rot = anim.rotation * t;
        // Always use the forward displacement (same wall for both legs)
        wrapRefDx = motion.dx;
        wrapRefDy = motion.dy;
      }

      // Mirror-wrap: trace path with wall reflections (skip for circular paths)
      const W = worldWidth || 0;
      const H = worldHeight || 0;
      const doWrap = anim.wrap && (canWrapX || canWrapY) && !anim.circularPath && !anim._pathLUT;
      const traced = doWrap
        ? mirrorWrapTrace(anim.centerX, anim.centerY, tx, ty, W, H)
        : { x: anim.centerX + tx, y: anim.centerY + ty, mirrorX: false, mirrorY: false };

      // Compute cross offset from the forward displacement.
      // crossOffset = traced(full) - raw(full) — the teleportation jump vector.
      let crossOffX = 0, crossOffY = 0;
      if (doWrap && (Math.abs(wrapRefDx) > 0.1 || Math.abs(wrapRefDy) > 0.1)) {
        const refTraced = mirrorWrapTrace(anim.centerX, anim.centerY, wrapRefDx, wrapRefDy, W, H);
        crossOffX = refTraced.x - (anim.centerX + wrapRefDx);
        crossOffY = refTraced.y - (anim.centerY + wrapRefDy);
      }
      const hasCrossOffset = Math.abs(crossOffX) > 1 || Math.abs(crossOffY) > 1;

      // Raw center position (un-wrapped, moves linearly — can go off-canvas)
      const rawCenterX = anim.centerX + tx;
      const rawCenterY = anim.centerY + ty;

      // Reaching here means this animation is live (inactive hit-triggers
      // `continue` above), so it moves at least one peg this frame.
      movedAny = true;

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      // Rotation pivot (custom origin offset from the natural center, default = center).
      const pivotX = anim.centerX + (anim.pivot ? anim.pivot.dx || 0 : 0);
      const pivotY = anim.centerY + (anim.pivot ? anim.pivot.dy || 0 : 0);

      for (const pegId of anim.pegIds) {
        const peg = pegMap.get(pegId);
        if (!peg) continue;
        if (this.suspendedPegIds.has(pegId)) continue;
        const orig = this.originalPositions.get(pegId);
        if (!orig) continue;

        const finalAngle = orig.angle + rot;
        // Rotate the original position about the pivot, expressed relative to the
        // natural center, then translate. Unified for group & individual: with the
        // default pivot (= center) an individual peg spins in place while a group
        // orbits its centroid; a custom pivot makes either orbit the pivot point.
        let localRx = (pivotX + (orig.x - pivotX) * cosR - (orig.y - pivotY) * sinR) - anim.centerX;
        let localRy = (pivotY + (orig.x - pivotX) * sinR + (orig.y - pivotY) * cosR) - anim.centerY;
        if (traced.mirrorX) localRx = -localRx;
        if (traced.mirrorY) localRy = -localRy;
        peg.x = traced.x + localRx;
        peg.y = traced.y + localRy;
        peg.angle = finalAngle;
        peg._animWrapShiftX = 0;
        peg._animWrapShiftY = 0;

        // Smooth wall transition using raw (un-wrapped) positions.
        // Instead of drawing the peg at the traced position (which JUMPS at wall
        // crossings), we draw TWO copies at continuous positions:
        //   1. Raw position (peg smoothly moves off-canvas through the wall)
        //   2. Raw + crossOffset (peg smoothly appears on the other side)
        // Canvas clipping naturally creates the portal effect.
        // Keep the traced pose as the primary/main instance so gameplay systems
        // can follow the current wrapped peg, and render the alternate raw pose
        // as an extra copy for the edge transition.
        peg._wrapCopies = null;
        peg._wrapHideMain = false;
        if (hasCrossOffset) {
          const rawX = rawCenterX + localRx;
          const rawY = rawCenterY + localRy;
          const candidates = [
            { x: rawX, y: rawY },
            { x: rawX + crossOffX, y: rawY + crossOffY }
          ];
          const extras = [];
          for (const candidate of candidates) {
            const dx = candidate.x - peg.x;
            const dy = candidate.y - peg.y;
            if (dx * dx + dy * dy <= 0.25) continue;
            extras.push(candidate);
          }
          peg._wrapCopies = extras.length > 0 ? extras : null;
        }

        if (orig.curveSlices && peg.curveSlices) {
          for (let i = 0; i < orig.curveSlices.length; i++) {
            const os = orig.curveSlices[i];
            // Rotate each slice point about the same pivot, relative to center.
            let lsx = (pivotX + (os.x - pivotX) * cosR - (os.y - pivotY) * sinR) - anim.centerX;
            let lsy = (pivotY + (os.x - pivotX) * sinR + (os.y - pivotY) * cosR) - anim.centerY;
            if (traced.mirrorX) lsx = -lsx;
            if (traced.mirrorY) lsy = -lsy;
            let rnx = os.nx * cosR - os.ny * sinR;
            let rny = os.nx * sinR + os.ny * cosR;
            if (traced.mirrorX) rnx = -rnx;
            if (traced.mirrorY) rny = -rny;
            peg.curveSlices[i].x = traced.x + lsx;
            peg.curveSlices[i].y = traced.y + lsy;
            peg.curveSlices[i].nx = rnx;
            peg.curveSlices[i].ny = rny;
          }
        }
      }
    }
    return movedAny;
  }

  reset(pegs) {
    const pegMap = new Map();
    for (const p of pegs) pegMap.set(p.id, p);

    for (const [pegId, orig] of this.originalPositions) {
      const peg = pegMap.get(pegId);
      if (!peg) continue;
      peg.x = orig.x;
      peg.y = orig.y;
      peg.angle = orig.angle;
      peg._animWrapShiftX = 0;
      peg._animWrapShiftY = 0;
      peg._wrapCopies = null;
      peg._wrapHideMain = false;
      if (orig.curveSlices && peg.curveSlices) {
        for (let i = 0; i < orig.curveSlices.length; i++) {
          const os = orig.curveSlices[i];
          peg.curveSlices[i].x = os.x;
          peg.curveSlices[i].y = os.y;
          peg.curveSlices[i].nx = os.nx;
          peg.curveSlices[i].ny = os.ny;
        }
      }
    }
  }

  notifyHit(pegId) {
    for (let ai = 0; ai < this.animations.length; ai++) {
      const anim = this.animations[ai];
      if (!anim.hitTrigger) continue;
      if (!anim.pegIds.includes(pegId)) continue;
      const ht = this._hitTriggerState.get(ai);
      if (!ht || ht.active) continue; // Already running
      ht.active = true;
      ht.elapsed = 0;

      if (anim.hitMode === 'spin') {
        // Spin: each hit increments step forever (constant forward)
        ht._prevStep = ht.step;
        ht.step++;
      } else if (anim.hitMode === 'single' && anim.hitSteps > 1) {
        // Single with steps: ping-pong between 0 and hitSteps
        ht._prevStep = ht.step;
        if (ht.forward) {
          ht.step = Math.min(ht.step + 1, anim.hitSteps);
        } else {
          ht.step = Math.max(ht.step - 1, 0);
        }
        if (ht.step >= anim.hitSteps) ht.forward = false;
        else if (ht.step <= 0) ht.forward = true;
      }
    }
  }

  hasAnimations() {
    return this.animations.length > 0;
  }

  suspendPeg(pegId) {
    if (!pegId) return;
    this.suspendedPegIds.add(pegId);
  }

  resumePeg(pegId) {
    if (!pegId) return;
    this.suspendedPegIds.delete(pegId);
  }

  isPegSuspended(pegId) {
    return !!pegId && this.suspendedPegIds.has(pegId);
  }

  getAnimatedPegIds() {
    const active = new Set();
    for (const pegId of this.animatedPegIds) {
      if (this.suspendedPegIds.has(pegId)) continue;
      active.add(pegId);
    }
    return active;
  }
}
