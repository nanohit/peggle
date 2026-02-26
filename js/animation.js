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

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function roundDebug(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function isWrapDebugEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.__PEGGLE_WRAP_DEBUG === true) return true;
    if (window.location && /(?:\?|&)wrapDebug=1(?:&|$)/.test(window.location.search || '')) return true;
    if (window.localStorage && window.localStorage.getItem('peggleWrapDebug') === '1') return true;
  } catch (_) {
    return false;
  }
  return false;
}

const WRAP_DEBUG_LAST_LOG = new Map();

function logWrapDebug(key, payload, minIntervalMs = 90) {
  if (!isWrapDebugEnabled()) return;
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
  const last = WRAP_DEBUG_LAST_LOG.get(key) || 0;
  if (now - last < minIntervalMs) return;
  WRAP_DEBUG_LAST_LOG.set(key, now);
  // eslint-disable-next-line no-console
  console.debug('[WrapDebug]', payload);
}

function resolveInverseMotionToSameDestination(
  baseDx,
  baseDy,
  width,
  height,
  anchor
) {
  const dx = normalizeNumber(baseDx);
  const dy = normalizeNumber(baseDy);
  const eps = 1e-6;
  if (Math.abs(dx) <= eps && Math.abs(dy) <= eps) return { dx: 0, dy: 0 };

  const hasWidth = Number.isFinite(width) && width > 0;
  const hasHeight = Number.isFinite(height) && height > 0;
  if (!anchor || (!hasWidth && !hasHeight)) {
    return { dx: -dx, dy: -dy };
  }

  const startX = normalizeNumber(anchor.startX);
  const startY = normalizeNumber(anchor.startY);
  const extentX = Math.max(0, normalizeNumber(anchor.extentX));
  const extentY = Math.max(0, normalizeNumber(anchor.extentY));
  const minVisibleRatio = Number.isFinite(anchor.minVisibleRatio)
    ? anchor.minVisibleRatio
    : MIN_VISIBLE_RATIO;

  const target = wrapPointWithVisibility(
    startX + dx,
    startY + dy,
    width,
    height,
    extentX,
    extentY,
    dx,
    dy,
    minVisibleRatio
  );

  const scales = new Set();
  const searchSteps = 160;
  const addScale = (scale) => {
    if (!Number.isFinite(scale) || scale >= -eps) return;
    if (Math.abs(scale) > 4000) return;
    scales.add(Math.round(scale * 1e9) / 1e9);
  };

  // Fallback candidate: strict sign-flip.
  addScale(-1);

  // X-axis constraint: s = 1 + k * (width / dx) makes dx*s wrap to same X.
  // Uses signed step so candidates are correct for both positive and negative dx.
  if (hasWidth && Math.abs(dx) > eps) {
    const stepX = width / dx;
    for (let k = -searchSteps; k <= searchSteps; k++) {
      if (k === 0) continue;
      addScale(1 + k * stepX);
    }
  }

  // Y-axis constraint: s = 1 + m * (height / dy) makes dy*s wrap to same Y.
  if (hasHeight && Math.abs(dy) > eps) {
    const stepY = height / dy;
    for (let m = -searchSteps; m <= searchSteps; m++) {
      if (m === 0) continue;
      addScale(1 + m * stepY);
    }
  }

  let best = null;
  let bestErr = Infinity;
  let bestExact = null;
  const exactEps = 1e-4;
  for (const scale of scales) {
    const candDx = dx * scale;
    const candDy = dy * scale;
    const candidate = wrapPointWithVisibility(
      startX + candDx,
      startY + candDy,
      width,
      height,
      extentX,
      extentY,
      candDx,
      candDy,
      minVisibleRatio,
      target.x,
      target.y
    );
    const err = Math.hypot(candidate.x - target.x, candidate.y - target.y);
    if (err <= exactEps) {
      if (!bestExact || Math.abs(scale) < Math.abs(bestExact.scale)) {
        bestExact = { scale, dx: candDx, dy: candDy };
      }
      continue;
    }
    if (
      err < bestErr - 1e-6 ||
      (Math.abs(err - bestErr) <= 1e-6 && Math.abs(scale) < Math.abs(best?.scale ?? Infinity))
    ) {
      bestErr = err;
      best = { scale, dx: candDx, dy: candDy };
    }
  }

  if (bestExact) return { dx: bestExact.dx, dy: bestExact.dy };
  if (!best) return { dx: -dx, dy: -dy };
  return { dx: best.dx, dy: best.dy };
}

// Resolve animation motion vector.
// Inverse keeps the same wrapped destination as non-inverse, but travels in the opposite direction.
export function resolveWrappedMotion(
  requestedDx,
  requestedDy,
  width,
  height,
  inverse = false,
  anchor = null
) {
  const baseDx = normalizeNumber(requestedDx);
  const baseDy = normalizeNumber(requestedDy);
  if (!inverse) return { dx: baseDx, dy: baseDy };
  return resolveInverseMotionToSameDestination(baseDx, baseDy, width, height, anchor);
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

// Wrap a 2D point while preserving trajectory angle:
// crossing X also advances Y by slope (dy/dx), crossing Y also advances X by slope (dx/dy).
export function wrapPointWithVisibility(
  rawX,
  rawY,
  width,
  height,
  extentX,
  extentY,
  motionDx,
  motionDy,
  minVisibleRatio = MIN_VISIBLE_RATIO,
  preferX = null,
  preferY = null
) {
  const hasX = Number.isFinite(width) && width > 0;
  const hasY = Number.isFinite(height) && height > 0;
  const safeRawX = normalizeNumber(rawX);
  const safeRawY = normalizeNumber(rawY);
  if (!hasX && !hasY) {
    return {
      x: safeRawX,
      y: safeRawY,
      shiftX: 0,
      shiftY: 0,
      primaryShiftX: 0,
      primaryShiftY: 0
    };
  }

  const marginX = getVisibilityMargin(extentX, minVisibleRatio);
  const marginY = getVisibilityMargin(extentY, minVisibleRatio);
  const minX = -marginX;
  const maxX = (hasX ? width : safeRawX) + marginX;
  const minY = -marginY;
  const maxY = (hasY ? height : safeRawY) + marginY;

  const eps = 1e-9;
  const dx = normalizeNumber(motionDx);
  const dy = normalizeNumber(motionDy);
  const canShiftYFromX = hasY && Math.abs(dx) > eps;
  const canShiftXFromY = hasX && Math.abs(dy) > eps;
  const slopeYOverX = canShiftYFromX ? dy / dx : 0;
  const slopeXOverY = canShiftXFromY ? dx / dy : 0;

  let x = safeRawX;
  let y = safeRawY;
  let primaryShiftX = 0;
  let primaryShiftY = 0;
  let hasPrimaryShift = false;
  let guard = 0;
  while (guard < 80) {
    guard++;
    let changed = false;

    if (hasX && x < minX - eps) {
      const deltaX = width;
      const deltaY = canShiftYFromX ? width * slopeYOverX : 0;
      x += deltaX;
      y += deltaY;
      if (!hasPrimaryShift && (Math.abs(deltaX) > eps || Math.abs(deltaY) > eps)) {
        primaryShiftX = deltaX;
        primaryShiftY = deltaY;
        hasPrimaryShift = true;
      }
      changed = true;
    } else if (hasX && x > maxX + eps) {
      const deltaX = -width;
      const deltaY = canShiftYFromX ? -width * slopeYOverX : 0;
      x += deltaX;
      y += deltaY;
      if (!hasPrimaryShift && (Math.abs(deltaX) > eps || Math.abs(deltaY) > eps)) {
        primaryShiftX = deltaX;
        primaryShiftY = deltaY;
        hasPrimaryShift = true;
      }
      changed = true;
    }

    if (hasY && y < minY - eps) {
      const deltaY = height;
      const deltaX = canShiftXFromY ? height * slopeXOverY : 0;
      x += deltaX;
      y += deltaY;
      if (!hasPrimaryShift && (Math.abs(deltaX) > eps || Math.abs(deltaY) > eps)) {
        primaryShiftX = deltaX;
        primaryShiftY = deltaY;
        hasPrimaryShift = true;
      }
      changed = true;
    } else if (hasY && y > maxY + eps) {
      const deltaY = -height;
      const deltaX = canShiftXFromY ? -height * slopeXOverY : 0;
      x += deltaX;
      y += deltaY;
      if (!hasPrimaryShift && (Math.abs(deltaX) > eps || Math.abs(deltaY) > eps)) {
        primaryShiftX = deltaX;
        primaryShiftY = deltaY;
        hasPrimaryShift = true;
      }
      changed = true;
    }

    if (!changed) break;
  }

  // Guard fallback: keep coordinates bounded even for pathological inputs.
  if (guard >= 80) {
    if (hasX) {
      while (x < minX) x += width;
      while (x > maxX) x -= width;
    }
    if (hasY) {
      while (y < minY) y += height;
      while (y > maxY) y -= height;
    }
  }

  // If the visible interval allows multiple equivalent wrapped representatives,
  // choose the one closest to the preferred reference point to keep endpoint
  // representation stable across inverse/non-inverse paths.
  const prefX = Number.isFinite(preferX) ? preferX : null;
  const prefY = Number.isFinite(preferY) ? preferY : null;
  if (hasX && prefX !== null) {
    while (x + width <= maxX + eps && Math.abs((x + width) - prefX) + eps < Math.abs(x - prefX)) {
      x += width;
    }
    while (x - width >= minX - eps && Math.abs((x - width) - prefX) + eps < Math.abs(x - prefX)) {
      x -= width;
    }
  }
  if (hasY && prefY !== null) {
    while (y + height <= maxY + eps && Math.abs((y + height) - prefY) + eps < Math.abs(y - prefY)) {
      y += height;
    }
    while (y - height >= minY - eps && Math.abs((y - height) - prefY) + eps < Math.abs(y - prefY)) {
      y -= height;
    }
  }

  return {
    x,
    y,
    shiftX: x - safeRawX,
    shiftY: y - safeRawY,
    primaryShiftX,
    primaryShiftY
  };
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
      p._animWrapDrawShiftX = 0;
      p._animWrapDrawShiftY = 0;
      p._animMotionDx = 0;
      p._animMotionDy = 0;
      p._animPreWrapShiftX = 0;
      p._animPreWrapShiftY = 0;
      p._animPreWrapAlpha = 0;
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
        ? resolveWrappedMotion(anim.dx, anim.dy, worldWidth, worldHeight, anim.inverse, {
            startX: anim.centerX,
            startY: anim.centerY,
            extentX: 0,
            extentY: 0,
            minVisibleRatio: ANIMATION_WRAP_VISIBLE_RATIO
          })
        : { dx: anim.dx, dy: anim.dy };
      const motionDx = motion.dx;
      const motionDy = motion.dy;
      const tx = motionDx * t;
      const ty = motionDy * t;
      const rawCenterX = anim.centerX + tx;
      const rawCenterY = anim.centerY + ty;
      const wrappedCenter = (anim.wrap && (canWrapX || canWrapY))
        ? wrapPointWithVisibility(
            rawCenterX,
            rawCenterY,
            worldWidth,
            worldHeight,
            0,
            0,
            motionDx,
            motionDy,
            ANIMATION_WRAP_VISIBLE_RATIO
          )
        : { x: rawCenterX, y: rawCenterY, shiftX: 0, shiftY: 0 };
      const centerShiftX = wrappedCenter.shiftX;
      const centerShiftY = wrappedCenter.shiftY;
      const eps = 1e-6;
      const primaryShiftX = Number.isFinite(wrappedCenter.primaryShiftX) ? wrappedCenter.primaryShiftX : 0;
      const primaryShiftY = Number.isFinite(wrappedCenter.primaryShiftY) ? wrappedCenter.primaryShiftY : 0;
      const wrapDrawShiftX = (Math.abs(primaryShiftX) > eps || Math.abs(primaryShiftY) > eps)
        ? primaryShiftX
        : centerShiftX;
      const wrapDrawShiftY = (Math.abs(primaryShiftX) > eps || Math.abs(primaryShiftY) > eps)
        ? primaryShiftY
        : centerShiftY;
      let preWrapShiftX = 0;
      let preWrapShiftY = 0;
      let preWrapAlpha = 0;
      let preWrapDebug = null;
      if (
        anim.wrap &&
        (canWrapX || canWrapY) &&
        Math.abs(centerShiftX) < eps &&
        Math.abs(centerShiftY) < eps &&
        (Math.abs(motionDx) > eps || Math.abs(motionDy) > eps)
      ) {
        let tx = Infinity;
        let ty = Infinity;
        if (canWrapX) {
          if (motionDx > eps) tx = (worldWidth - wrappedCenter.x) / motionDx;
          else if (motionDx < -eps) tx = (0 - wrappedCenter.x) / motionDx;
          if (tx <= eps) tx = Infinity;
        }
        if (canWrapY) {
          if (motionDy > eps) ty = (worldHeight - wrappedCenter.y) / motionDy;
          else if (motionDy < -eps) ty = (0 - wrappedCenter.y) / motionDy;
          if (ty <= eps) ty = Infinity;
        }

        const tCross = Math.min(tx, ty);
        if (Number.isFinite(tCross)) {
          const hitXFirst = tx < ty - 1e-5;
          const hitYFirst = ty < tx - 1e-5;
          const nearCorner = !hitXFirst && !hitYFirst;

          // Build pre-wrap shift from the first boundary hit only.
          // Using a wrapped probe point can include a second wrap immediately
          // after the first and causes corner ghosts/flicker.
          if (hitXFirst && canWrapX && Math.abs(motionDx) > eps) {
            preWrapShiftX = motionDx > 0 ? -worldWidth : worldWidth;
            preWrapShiftY = preWrapShiftX * (motionDy / motionDx);
          } else if (hitYFirst && canWrapY && Math.abs(motionDy) > eps) {
            preWrapShiftY = motionDy > 0 ? -worldHeight : worldHeight;
            preWrapShiftX = preWrapShiftY * (motionDx / motionDy);
          } else {
            preWrapShiftX = 0;
            preWrapShiftY = 0;
          }

          const distX = Number.isFinite(tx)
            ? (motionDx > 0 ? worldWidth - wrappedCenter.x : wrappedCenter.x)
            : Infinity;
          const distY = Number.isFinite(ty)
            ? (motionDy > 0 ? worldHeight - wrappedCenter.y : wrappedCenter.y)
            : Infinity;
          const dist = nearCorner ? Math.min(distX, distY) : (hitXFirst ? distX : distY);
          const ramp = Math.max(
            12,
            nearCorner
              ? Math.max(anim.extentX, anim.extentY) * 2
              : (hitXFirst ? anim.extentX : anim.extentY) * 2
          );
          preWrapAlpha = clamp01(1 - dist / ramp);
          if (Math.abs(preWrapShiftX) < eps && Math.abs(preWrapShiftY) < eps) {
            preWrapAlpha = 0;
          }

          // Corner crossings need 2-edge topology; a single pre-wrap ghost copy
          // creates trailing/forked artifacts there. Keep pre-wrap only for
          // clear single-edge transitions.
          let cornerCross = false;
          if (Number.isFinite(tx) && Number.isFinite(ty)) {
            const fastRatio = Math.max(tx, ty) / Math.max(1e-6, Math.min(tx, ty));
            cornerCross = Math.abs(tx - ty) <= 0.035 || fastRatio <= 1.25;
          }
          const cornerThreshold = Math.min(
            180,
            Math.max(90, Math.max(anim.extentX, anim.extentY) * 2.5)
          );
          const nearCornerByDistance =
            Number.isFinite(distX) &&
            Number.isFinite(distY) &&
            distX <= cornerThreshold &&
            distY <= cornerThreshold;
          let cornerSoonAfterFirstHit = false;
          if (Number.isFinite(tx) && Number.isFinite(ty)) {
            if (hitXFirst) {
              const yAtXHit = wrappedCenter.y + motionDy * tx;
              const remY = motionDy > 0 ? worldHeight - yAtXHit : yAtXHit;
              cornerSoonAfterFirstHit = Number.isFinite(remY) && remY <= cornerThreshold;
            } else if (hitYFirst) {
              const xAtYHit = wrappedCenter.x + motionDx * ty;
              const remX = motionDx > 0 ? worldWidth - xAtYHit : xAtYHit;
              cornerSoonAfterFirstHit = Number.isFinite(remX) && remX <= cornerThreshold;
            }
          }
          let suppressedByCorner = false;
          if (cornerCross || nearCornerByDistance || cornerSoonAfterFirstHit) {
            preWrapShiftX = 0;
            preWrapShiftY = 0;
            preWrapAlpha = 0;
            suppressedByCorner = true;
          }
          // Avoid one-frame low-alpha flashes right before edge contact.
          let suppressedByAlphaFloor = false;
          if (preWrapAlpha < 0.06) {
            if (preWrapAlpha > 0) suppressedByAlphaFloor = true;
            preWrapAlpha = 0;
          }
          preWrapDebug = {
            tx: roundDebug(tx),
            ty: roundDebug(ty),
            tCross: roundDebug(tCross),
            hitXFirst,
            hitYFirst,
            nearCorner,
            distX: roundDebug(distX, 2),
            distY: roundDebug(distY, 2),
            cornerThreshold: roundDebug(cornerThreshold, 2),
            cornerCross,
            nearCornerByDistance,
            cornerSoonAfterFirstHit,
            suppressedByCorner,
            suppressedByAlphaFloor
          };
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
        peg._animWrapDrawShiftX = wrapDrawShiftX;
        peg._animWrapDrawShiftY = wrapDrawShiftY;
        peg._animMotionDx = motionDx;
        peg._animMotionDy = motionDy;
        peg._animPreWrapShiftX = preWrapShiftX;
        peg._animPreWrapShiftY = preWrapShiftY;
        peg._animPreWrapAlpha = preWrapAlpha;

        const hasWrapCopy = Math.abs(centerShiftX) > eps || Math.abs(centerShiftY) > eps;
        const hasPreWrapCopy = preWrapAlpha > eps &&
          (Math.abs(preWrapShiftX) > eps || Math.abs(preWrapShiftY) > eps);
        if (hasWrapCopy || hasPreWrapCopy) {
          logWrapDebug(`anim:${pegId}:${hasPreWrapCopy ? 'pre' : 'wrap'}`, {
            pegId,
            animType: anim.type,
            inverse: !!anim.inverse,
            phaseT: roundDebug(t, 4),
            motionDx: roundDebug(motionDx, 4),
            motionDy: roundDebug(motionDy, 4),
            centerRawX: roundDebug(rawCenterX, 2),
            centerRawY: roundDebug(rawCenterY, 2),
            centerWrappedX: roundDebug(wrappedCenter.x, 2),
            centerWrappedY: roundDebug(wrappedCenter.y, 2),
            centerShiftX: roundDebug(centerShiftX, 3),
            centerShiftY: roundDebug(centerShiftY, 3),
            wrapDrawShiftX: roundDebug(wrapDrawShiftX, 3),
            wrapDrawShiftY: roundDebug(wrapDrawShiftY, 3),
            pegMainX: roundDebug(peg.x, 2),
            pegMainY: roundDebug(peg.y, 2),
            wrapCopyX: roundDebug(peg.x - centerShiftX, 2),
            wrapCopyY: roundDebug(peg.y - centerShiftY, 2),
            wrapDrawCopyX: roundDebug(peg.x - wrapDrawShiftX, 2),
            wrapDrawCopyY: roundDebug(peg.y - wrapDrawShiftY, 2),
            preWrapShiftX: roundDebug(preWrapShiftX, 3),
            preWrapShiftY: roundDebug(preWrapShiftY, 3),
            preWrapAlpha: roundDebug(preWrapAlpha, 4),
            preWrapDrawX: roundDebug(peg.x + preWrapShiftX, 2),
            preWrapDrawY: roundDebug(peg.y + preWrapShiftY, 2),
            preWrapDebug
          });
        }

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
      peg._animWrapDrawShiftX = 0;
      peg._animWrapDrawShiftY = 0;
      peg._animMotionDx = 0;
      peg._animMotionDy = 0;
      peg._animPreWrapShiftX = 0;
      peg._animPreWrapShiftY = 0;
      peg._animPreWrapAlpha = 0;
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
