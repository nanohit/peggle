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

// Inverse motion: negate the vector. With mirror-wrap, (-dx, -dy) goes in
// the exact opposite direction and reflects off the opposite wall.
function resolveInverseMotion(baseDx, baseDy) {
  return { dx: -normalizeNumber(baseDx), dy: -normalizeNumber(baseDy) };
}

// Resolve animation motion vector.
// Inverse simply negates the direction (mirror-wrap handles the rest).
export function resolveWrappedMotion(requestedDx, requestedDy, width, height, inverse = false) {
  const baseDx = normalizeNumber(requestedDx);
  const baseDy = normalizeNumber(requestedDy);
  if (!inverse) return { dx: baseDx, dy: baseDy };
  return resolveInverseMotion(baseDx, baseDy);
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
    const r = PHYSICS_CONFIG.pegRadius;
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

export class PegAnimator {
  constructor() {
    this.originalPositions = new Map(); // pegId → {x, y, angle, curveSlices?}
    this.animations = [];               // compiled animation entries
    this.animatedPegIds = new Set();    // pegs affected by active animations
    this.elapsed = 0;
  }

  loadFromLevel(pegs, groups = []) {
    this.originalPositions.clear();
    this.animations = [];
    this.animatedPegIds.clear();
    this.elapsed = 0;

    // Build peg lookup
    const pegMap = new Map();
    for (const p of pegs) {
      pegMap.set(p.id, p);
      p._animWrapShiftX = 0;
      p._animWrapShiftY = 0;
      p._wrapPartner = null;
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

      this.animations.push({
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
        easingFn: anim.cycle ? linear : (EASING_FNS[anim.easing] || linear)
      });
      for (const pegId of memberIds) this.animatedPegIds.add(pegId);
    }

    // Process individual peg animations
    for (const p of pegs) {
      if (groupAnimatedIds.has(p.id)) continue;
      if (!p.animation) continue;
      const anim = p.animation;
      const ex = estimatePegExtents(p, p.x, p.y, p.angle || 0, p.curveSlices);

      this.animations.push({
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
        easingFn: anim.cycle ? linear : (EASING_FNS[anim.easing] || linear)
      });
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

    for (const anim of this.animations) {
      const duration = Math.max(anim.duration || 0, 0.001);

      let tx, ty, rot;

      if (anim.cycle && anim.wrap && (canWrapX || canWrapY)) {
        // Cycle: forward to destination, then retrace back to origin.
        // With mirror-wrap, the return path is the reverse of the forward reflected path,
        // so both legs are equal length. Each leg takes half the duration.
        const fwd = resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, anim.inverse);
        const phase = (this.elapsed % duration) / duration; // 0→1 sawtooth

        // Rotation: constant speed, same direction, never reverses.
        rot = anim.rotation * (this.elapsed / duration);

        if (phase < 0.5) {
          // Forward leg: origin → destination
          const localT = phase / 0.5;
          tx = fwd.dx * localT;
          ty = fwd.dy * localT;
        } else {
          // Return leg: destination → origin (retrace)
          const localT = (phase - 0.5) / 0.5;
          tx = fwd.dx * (1 - localT);
          ty = fwd.dy * (1 - localT);
        }
      } else {
        // Normal ping-pong (or cycle without wrap, treated as ping-pong)
        const fullCycle = duration * 2;
        const phase = (this.elapsed % fullCycle) / duration;
        const rawT = phase <= 1 ? phase : 2 - phase;
        const t = anim.easingFn(rawT);

        const motion = (anim.wrap && (canWrapX || canWrapY))
          ? resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, anim.inverse)
          : { dx: anim.dx, dy: anim.dy };
        tx = motion.dx * t;
        ty = motion.dy * t;
        rot = anim.rotation * t;
      }

      // Mirror-wrap: trace path with wall reflections
      const traced = (anim.wrap && (canWrapX || canWrapY))
        ? mirrorWrapTrace(anim.centerX, anim.centerY, tx, ty, worldWidth || 0, worldHeight || 0)
        : { x: anim.centerX + tx, y: anim.centerY + ty, mirrorX: false, mirrorY: false };

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      for (const pegId of anim.pegIds) {
        const peg = pegMap.get(pegId);
        if (!peg) continue;
        const orig = this.originalPositions.get(pegId);
        if (!orig) continue;

        const finalAngle = orig.angle + rot;
        if (anim.type === 'group') {
          let localX = orig.x - anim.centerX;
          let localY = orig.y - anim.centerY;
          // Rotate around group center
          let rx = localX * cosR - localY * sinR;
          let ry = localX * sinR + localY * cosR;
          // Mirror local offsets if the center reflected off a wall
          if (traced.mirrorX) rx = -rx;
          if (traced.mirrorY) ry = -ry;
          peg.x = traced.x + rx;
          peg.y = traced.y + ry;
        } else {
          peg.x = traced.x;
          peg.y = traced.y;
        }
        peg.angle = finalAngle;
        peg._animWrapShiftX = 0;
        peg._animWrapShiftY = 0;

        // Compute wrap partner for smooth edge transition
        peg._wrapPartner = null;
        if (anim.wrap && (canWrapX || canWrapY)) {
          const W = worldWidth || 0;
          const H = worldHeight || 0;
          const r = PHYSICS_CONFIG.pegRadius;
          // Distance to nearest wall on each side
          const distL = peg.x;
          const distR = W > 0 ? W - peg.x : Infinity;
          const distT = peg.y;
          const distB = H > 0 ? H - peg.y : Infinity;
          const minDist = Math.min(distL, distR, distT, distB);
          // Activate partner when peg center is within 2x radius of wall
          const threshold = r * 2;
          if (minDist < threshold) {
            const motionResolved = resolveWrappedMotion(anim.dx, anim.dy, W, H, anim.inverse);
            const mLen = Math.sqrt(motionResolved.dx ** 2 + motionResolved.dy ** 2);
            if (mLen > 0) {
              const ndx = motionResolved.dx / mLen;
              const ndy = motionResolved.dy / mLen;
              for (const sign of [1, -1]) {
                const dvx = ndx * sign;
                const dvy = ndy * sign;
                const wallDist = wallHitAlpha(peg.x, peg.y, dvx, dvy, W, H);
                if (wallDist < threshold) {
                  // Push just past the wall to find partner position
                  const push = wallDist + 0.1;
                  const partner = mirrorWrapTrace(peg.x, peg.y, dvx * push, dvy * push, W, H);
                  // Alpha: 1 when at wall (minDist=0), 0 when at threshold
                  const partnerAlpha = 1 - (minDist / threshold);
                  peg._wrapPartner = {
                    x: partner.x - dvx * 0.1,
                    y: partner.y - dvy * 0.1,
                    alpha: Math.max(0, Math.min(1, partnerAlpha))
                  };
                  break;
                }
              }
            }
          }
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
      peg._wrapPartner = null;
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

  hasAnimations() {
    return this.animations.length > 0;
  }

  getAnimatedPegIds() {
    return this.animatedPegIds;
  }
}
