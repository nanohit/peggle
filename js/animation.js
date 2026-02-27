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

// Inverse motion: go in the opposite direction from (dx, dy) but arrive at
// the same wrapped destination.  Every vector (dx + j*W, dy + m*H) for
// integer j, m reaches the same destination on the torus.  Among those that
// go generally OPPOSITE to forward, we pick the one whose direction is
// closest to the exact 180° mirror (-dx, -dy), with a tiebreak for shorter
// path length.  This avoids the angle distortion of per-axis flipping.
function resolveInverseMotion(baseDx, baseDy, width, height) {
  const dx = normalizeNumber(baseDx);
  const dy = normalizeNumber(baseDy);
  const eps = 1e-6;
  const fwdLen = Math.hypot(dx, dy);
  if (fwdLen <= eps) return { dx: 0, dy: 0 };

  const hasWidth = Number.isFinite(width) && width > 0;
  const hasHeight = Number.isFinite(height) && height > 0;
  if (!hasWidth && !hasHeight) return { dx: -dx, dy: -dy };

  // Single-axis: trivial 180° flip
  if (!hasWidth || Math.abs(dx) <= eps) {
    const d = ((dy % height) + height) % height;
    return { dx: dx, dy: dy > 0 ? d - height : d };
  }
  if (!hasHeight || Math.abs(dy) <= eps) {
    const d = ((dx % width) + width) % width;
    return { dx: dx > 0 ? d - width : d, dy: dy };
  }

  // Unit vector of the exact mirror direction
  const mux = -dx / fwdLen;
  const muy = -dy / fwdLen;

  // Collect all candidates that go opposite to forward
  const candidates = [];
  for (let j = -5; j <= 5; j++) {
    for (let m = -5; m <= 5; m++) {
      if (j === 0 && m === 0) continue;
      const cx = dx + j * width;
      const cy = dy + m * height;
      const cLen = Math.hypot(cx, cy);
      if (cLen <= eps) continue;
      // Must go generally opposite to the forward direction
      if (cx * dx + cy * dy >= 0) continue;
      const cos = (cx * mux + cy * muy) / cLen;
      candidates.push({ dx: cx, dy: cy, cos, len: cLen });
    }
  }

  if (candidates.length === 0) return { dx: -dx, dy: -dy };

  // Sort by length (shortest first), then pick the shortest one
  // whose angle is "good enough" — within 15° of the best angle available.
  // This prevents multi-wrap paths when a single-wrap is nearly as good.
  candidates.sort((a, b) => a.len - b.len);
  const bestAngle = Math.max(...candidates.map(c => c.cos));
  // cos(15°) ≈ 0.966 — allow up to ~15° deviation from best angle
  const threshold = bestAngle - 0.07;

  for (const c of candidates) {
    if (c.cos >= threshold) {
      return { dx: c.dx, dy: c.dy };
    }
  }

  // Fallback to best angle regardless of length
  return candidates.reduce((a, b) => a.cos > b.cos ? a : b);
}

// Resolve animation motion vector.
// Inverse keeps the same wrapped destination as non-inverse, but travels in the opposite direction.
export function resolveWrappedMotion(requestedDx, requestedDy, width, height, inverse = false) {
  const baseDx = normalizeNumber(requestedDx);
  const baseDy = normalizeNumber(requestedDy);
  if (!inverse) return { dx: baseDx, dy: baseDy };
  return resolveInverseMotion(baseDx, baseDy, width, height);
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
        easingFn: EASING_FNS[anim.easing] || linear
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
        easingFn: EASING_FNS[anim.easing] || linear
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
      const cycle = duration * 2;
      const phase = (this.elapsed % cycle) / duration;
      const rawT = phase <= 1 ? phase : 2 - phase; // ping-pong 0→1→0
      const t = anim.easingFn(rawT);

      const motion = (anim.wrap && (canWrapX || canWrapY))
        ? resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, anim.inverse)
        : { dx: anim.dx, dy: anim.dy };
      const tx = motion.dx * t;
      const ty = motion.dy * t;
      const rawCenterX = anim.centerX + tx;
      const rawCenterY = anim.centerY + ty;

      // Wrap center position toroidally (independent per axis)
      let centerShiftX = 0;
      let centerShiftY = 0;
      if (anim.wrap) {
        if (canWrapX) {
          const w = wrapAxisToroidal(rawCenterX, worldWidth);
          centerShiftX = w.shift;
        }
        if (canWrapY) {
          const w = wrapAxisToroidal(rawCenterY, worldHeight);
          centerShiftY = w.shift;
        }
      }

      const rot = anim.rotation * t;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);

      for (const pegId of anim.pegIds) {
        const peg = pegMap.get(pegId);
        if (!peg) continue;
        const orig = this.originalPositions.get(pegId);
        if (!orig) continue;

        const finalAngle = orig.angle + rot;
        let rawX;
        let rawY;
        if (anim.type === 'group') {
          // Rotate peg position around group center, then translate
          const localX = orig.x - anim.centerX;
          const localY = orig.y - anim.centerY;
          rawX = anim.centerX + localX * cosR - localY * sinR + tx;
          rawY = anim.centerY + localX * sinR + localY * cosR + ty;
          peg.angle = orig.angle + rot;
        } else {
          // Individual: translate + rotate around own center
          rawX = orig.x + tx;
          rawY = orig.y + ty;
        }
        peg.angle = finalAngle;

        let rawSlices = null;
        if (orig.curveSlices && peg.curveSlices) {
          rawSlices = [];
          for (let i = 0; i < orig.curveSlices.length; i++) {
            const os = orig.curveSlices[i];
            let sliceX;
            let sliceY;
            if (anim.type === 'group') {
              const sx = os.x - anim.centerX;
              const sy = os.y - anim.centerY;
              sliceX = anim.centerX + sx * cosR - sy * sinR + tx;
              sliceY = anim.centerY + sx * sinR + sy * cosR + ty;
            } else {
              const sx = os.x - orig.x;
              const sy = os.y - orig.y;
              sliceX = rawX + sx * cosR - sy * sinR;
              sliceY = rawY + sx * sinR + sy * cosR;
            }
            rawSlices.push({
              x: sliceX,
              y: sliceY,
              nx: os.nx * cosR - os.ny * sinR,
              ny: os.nx * sinR + os.ny * cosR
            });
          }
        }

        peg.x = rawX + centerShiftX;
        peg.y = rawY + centerShiftY;
        peg._animWrapShiftX = centerShiftX;
        peg._animWrapShiftY = centerShiftY;

        // Keep group shape coherent by applying the same center wrap shift to all slices.
        if (rawSlices && peg.curveSlices) {
          for (let i = 0; i < rawSlices.length; i++) {
            peg.curveSlices[i].x = rawSlices[i].x + centerShiftX;
            peg.curveSlices[i].y = rawSlices[i].y + centerShiftY;
            peg.curveSlices[i].nx = rawSlices[i].nx;
            peg.curveSlices[i].ny = rawSlices[i].ny;
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
