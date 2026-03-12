// Peg Animation System - cyclic peg/group animations during gameplay

import { PHYSICS_CONFIG } from './physics.js';

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
    } else if (peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange')) {
      const halfLen = r * (peg.portalScale || 1);
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

  const halfH = (peg.height || PHYSICS_CONFIG.pegRadius * 1.2) / 2;
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

  const halfW = (peg.width || PHYSICS_CONFIG.pegRadius * 4) / 2;
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

export class PegAnimator {
  constructor() {
    this.originalPositions = new Map(); // pegId → {x, y, angle, curveSlices?}
    this.animations = [];               // compiled animation entries
    this.animatedPegIds = new Set();    // pegs affected by active animations
    this.elapsed = 0;
    this._hitTriggerState = new Map();  // animIndex → { active, elapsed, forward }
  }

  loadFromLevel(pegs, groups = []) {
    this.originalPositions.clear();
    this.animations = [];
    this.animatedPegIds.clear();
    this.elapsed = 0;
    this._hitTriggerState = new Map();

    // Build peg lookup
    const pegMap = new Map();
    for (const p of pegs) {
      pegMap.set(p.id, p);
      p._animWrapShiftX = 0;
      p._animWrapShiftY = 0;
      p._wrapCopies = null;
      p._wrapHideMain = false;
      // Snapshot original positions (deep copy curveSlices)
      const snap = { x: p.x, y: p.y, angle: p.angle || 0 };
      if (p.curveSlices) {
        snap.curveSlices = p.curveSlices.map(s => ({ x: s.x, y: s.y, nx: s.nx, ny: s.ny }));
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
      };
      this.animations.push(entry);
      if (entry.hitTrigger) {
        this._hitTriggerState.set(this.animations.length - 1, { active: false, elapsed: 0, forward: true, step: 0, _prevStep: 0 });
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
      };
      this.animations.push(entry);
      if (entry.hitTrigger) {
        this._hitTriggerState.set(this.animations.length - 1, { active: false, elapsed: 0, forward: true, step: 0, _prevStep: 0 });
      }
      this.animatedPegIds.add(p.id);
    }
  }

  tick(pegs, dtSeconds, bounds = null) {
    if (this.animations.length === 0) return;
    this.elapsed += dtSeconds;

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

      // Circular path: object follows a circular arc defined by the displacement vector
      if (anim.circularPath) {
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
      const doWrap = anim.wrap && (canWrapX || canWrapY) && !anim.circularPath;
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

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      for (const pegId of anim.pegIds) {
        const peg = pegMap.get(pegId);
        if (!peg) continue;
        const orig = this.originalPositions.get(pegId);
        if (!orig) continue;

        const finalAngle = orig.angle + rot;
        // Compute local offset for group members (rotation, mirroring)
        let localRx = 0, localRy = 0;
        if (anim.type === 'group') {
          let localX = orig.x - anim.centerX;
          let localY = orig.y - anim.centerY;
          localRx = localX * cosR - localY * sinR;
          localRy = localX * sinR + localY * cosR;
          if (traced.mirrorX) localRx = -localRx;
          if (traced.mirrorY) localRy = -localRy;
          peg.x = traced.x + localRx;
          peg.y = traced.y + localRy;
        } else {
          peg.x = traced.x;
          peg.y = traced.y;
        }
        peg.angle = finalAngle;
        peg._animWrapShiftX = 0;
        peg._animWrapShiftY = 0;

        // Smooth wall transition using raw (un-wrapped) positions.
        // Instead of drawing the peg at the traced position (which JUMPS at wall
        // crossings), we draw TWO copies at continuous positions:
        //   1. Raw position (peg smoothly moves off-canvas through the wall)
        //   2. Raw + crossOffset (peg smoothly appears on the other side)
        // Canvas clipping naturally creates the portal effect.
        // The main peg at traced position is hidden (_wrapHideMain) to avoid
        // the visual teleportation jump.
        peg._wrapCopies = null;
        peg._wrapHideMain = false;
        if (hasCrossOffset) {
          const rawX = rawCenterX + localRx;
          const rawY = rawCenterY + localRy;
          peg._wrapHideMain = true;
          peg._wrapCopies = [
            { x: rawX, y: rawY },
            { x: rawX + crossOffX, y: rawY + crossOffY }
          ];
        }

        if (orig.curveSlices && peg.curveSlices) {
          for (let i = 0; i < orig.curveSlices.length; i++) {
            const os = orig.curveSlices[i];
            let sx, sy;
            if (anim.type === 'group') {
              sx = os.x - anim.centerX;
              sy = os.y - anim.centerY;
            } else {
              sx = os.x - orig.x;
              sy = os.y - orig.y;
            }
            let rsx = sx * cosR - sy * sinR;
            let rsy = sx * sinR + sy * cosR;
            if (traced.mirrorX) rsx = -rsx;
            if (traced.mirrorY) rsy = -rsy;
            let rnx = os.nx * cosR - os.ny * sinR;
            let rny = os.nx * sinR + os.ny * cosR;
            if (traced.mirrorX) rnx = -rnx;
            if (traced.mirrorY) rny = -rny;
            peg.curveSlices[i].x = (anim.type === 'group' ? traced.x : peg.x) + rsx;
            peg.curveSlices[i].y = (anim.type === 'group' ? traced.y : peg.y) + rsy;
            peg.curveSlices[i].nx = rnx;
            peg.curveSlices[i].ny = rny;
          }
        }
      }
    }
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

  getAnimatedPegIds() {
    return this.animatedPegIds;
  }
}
