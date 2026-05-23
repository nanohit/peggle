import { PHYSICS_CONFIG } from './physics.js';
import { Utils } from './utils.js';
import { getPortalScale, isPortalType } from './portal-defaults.js';

const DEFAULTS = Object.freeze({
  enabled: false,
  gravityX: 0,
  gravityY: 0.115,
  damping: 0.994,
  restitution: 0.34,
  friction: 0.72,
  surfaceGrip: 0.18,
  dynamicPegBallBounce: 0.45,
  maxSpeed: 14,
  sleepSpeed: 0.055,
  sleepFrames: 18,
  bombImpulse: 12,
  stuckPileClearDelayMs: 220
});

const BASE_STEP_SECONDS = 1 / 120;
const MAX_SUBSTEP_PX = 3.25;
const MAX_DESTRUCTION_SUBSTEPS = 6;
const WAKE_QUEUE_COMPACT_THRESHOLD = 64;
const GRID_CELL_SIZE = 54;
const GRID_COORD_OFFSET = 32768;
const GRID_KEY_STRIDE = 65536;
const FALL_MARGIN = 70;
const WAKE_IMPULSE_MIN = 0.45;
const HIT_IMPULSE_SCALE = 0.84;
const HIT_IMPULSE_MIN = 1.35;
const ANGULAR_IMPULSE_SCALE = 0.0017;
const MAX_ANGULAR_SPEED = 0.13;
const MAX_BODIES_WOKEN_PER_STEP = 24;
const SUPPORT_MEMORY_FRAMES = 8;
const SUPPORT_SLEEP_MULTIPLIER = 4.5;
const ANGULAR_SLEEP_FLOOR = 0.0075;
const BUCKET_MOVE_EPSILON = 0.01;
const BUCKET_RIM_THICKNESS = 5.5;
const GROUP_FRACTURE_IMPULSE = 4.6;
const GROUP_FRACTURE_MIN_PEGS = 2;
const PORTAL_BODY_COOLDOWN_STEPS = 8;
const PORTAL_BODY_EXIT_PADDING = 1.2;
const TAU = Math.PI * 2;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeDestructionSettings(rawSettings = null) {
  const raw = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
    ? rawSettings
    : {};
  return {
    enabled: !!raw.enabled,
    gravityX: clampNumber(raw.gravityX, -0.8, 0.8, DEFAULTS.gravityX),
    gravityY: clampNumber(raw.gravityY, -0.2, 1.2, DEFAULTS.gravityY),
    damping: clampNumber(raw.damping, 0.9, 1, DEFAULTS.damping),
    restitution: clampNumber(raw.restitution, 0, 1.25, DEFAULTS.restitution),
    friction: clampNumber(raw.friction, 0, 1, DEFAULTS.friction),
    surfaceGrip: clampNumber(raw.surfaceGrip, 0, 1, DEFAULTS.surfaceGrip),
    dynamicPegBallBounce: clampNumber(raw.dynamicPegBallBounce, 0, 1.25, DEFAULTS.dynamicPegBallBounce),
    maxSpeed: clampNumber(raw.maxSpeed, 4, 32, DEFAULTS.maxSpeed),
    sleepSpeed: clampNumber(raw.sleepSpeed, 0.01, 0.8, DEFAULTS.sleepSpeed),
    sleepFrames: Math.round(clampNumber(raw.sleepFrames, 4, 80, DEFAULTS.sleepFrames)),
    bombImpulse: clampNumber(raw.bombImpulse, 0, 32, DEFAULTS.bombImpulse),
    stuckPileClearDelayMs: Math.round(clampNumber(raw.stuckPileClearDelayMs, 0, 2000, DEFAULTS.stuckPileClearDelayMs))
  };
}

export function ensureLevelDestruction(level) {
  if (!level || typeof level !== 'object') return normalizeDestructionSettings(null);
  level.destruction = normalizeDestructionSettings(level.destruction);
  return level.destruction;
}

export function getDefaultDestructionStatic(peg) {
  if (!peg) return false;
  return peg.type === 'obstacle' || peg.type === 'bumper' || isPortalType(peg.type);
}

export function isDestructionStaticPeg(peg) {
  if (!peg) return false;
  if (typeof peg.destructionStatic === 'boolean') return peg.destructionStatic;
  return getDefaultDestructionStatic(peg);
}

export function normalizeDestructionPegProperties(peg) {
  if (!peg || typeof peg !== 'object') return peg;
  coerceDestructionPegFlags(peg);
  delete peg._destructionBodyId;
  delete peg._destructionFalling;
  delete peg._destructionAwake;
  delete peg._destructionAabbDirty;
  delete peg._destructionAabbCache;
  return peg;
}

function coerceDestructionPegFlags(peg) {
  if (!peg || typeof peg !== 'object') return peg;
  if (Object.prototype.hasOwnProperty.call(peg, 'destructionStatic')) {
    peg.destructionStatic = !!peg.destructionStatic;
  }
  if (Object.prototype.hasOwnProperty.call(peg, 'destructionPhysicsOnHit')) {
    peg.destructionPhysicsOnHit = !!peg.destructionPhysicsOnHit;
  }
  if (Object.prototype.hasOwnProperty.call(peg, 'destructionPhysicsOnHitBallOnly')) {
    peg.destructionPhysicsOnHitBallOnly = !!peg.destructionPhysicsOnHitBallOnly;
  }
  return peg;
}

function isPortalPeg(peg) {
  return !!peg && isPortalType(peg.type);
}

function getPegRadius(peg) {
  if (!peg) return PHYSICS_CONFIG.pegRadius;
  if (peg.type === 'bumper') return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
  return PHYSICS_CONFIG.pegRadius;
}

function getBrickSize(peg) {
  return {
    width: Number.isFinite(peg?.width) ? peg.width : PHYSICS_CONFIG.brickWidth,
    height: Number.isFinite(peg?.height) ? peg.height : PHYSICS_CONFIG.brickHeight
  };
}

function hasCurveSlices(peg) {
  return !!(peg?.shape === 'brick' && Array.isArray(peg.curveSlices) && peg.curveSlices.length >= 2);
}

function getCurveRibbonLength(peg) {
  if (!hasCurveSlices(peg)) return 0;
  let length = 0;
  for (let i = 1; i < peg.curveSlices.length; i++) {
    const a = peg.curveSlices[i - 1];
    const b = peg.curveSlices[i];
    if (!a || !b) continue;
    length += Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
  }
  return length;
}

function getPegMass(peg) {
  if (!peg) return 1;
  if (peg.shape === 'brick') {
    const { width, height } = getBrickSize(peg);
    const effectiveWidth = hasCurveSlices(peg) ? Math.max(width, getCurveRibbonLength(peg)) : width;
    return Math.max(0.75, (effectiveWidth * height) / Math.max(1, PHYSICS_CONFIG.brickWidth * PHYSICS_CONFIG.brickHeight));
  }
  const radius = getPegRadius(peg);
  return Math.max(0.7, (radius * radius) / Math.max(1, PHYSICS_CONFIG.pegRadius * PHYSICS_CONFIG.pegRadius));
}

function writePegAabb(peg, out) {
  if (!peg || !Number.isFinite(peg.x) || !Number.isFinite(peg.y)) return null;
  if (hasCurveSlices(peg)) {
    const { height } = getBrickSize(peg);
    const halfHeight = height * 0.5;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const slice of peg.curveSlices) {
      if (!slice || !Number.isFinite(slice.x) || !Number.isFinite(slice.y)) continue;
      const nx = Number.isFinite(slice.nx) ? slice.nx : 0;
      const ny = Number.isFinite(slice.ny) ? slice.ny : 1;
      const x1 = slice.x + nx * halfHeight;
      const x2 = slice.x - nx * halfHeight;
      const y1 = slice.y + ny * halfHeight;
      const y2 = slice.y - ny * halfHeight;
      minX = Math.min(minX, x1, x2);
      maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
    if (!Number.isFinite(minX)) return null;
    out.minX = minX;
    out.maxX = maxX;
    out.minY = minY;
    out.maxY = maxY;
    return out;
  }
  if (peg.shape === 'brick') {
    const { width, height } = getBrickSize(peg);
    const hw = width * 0.5;
    const hh = height * 0.5;
    const angle = peg.angle || 0;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const extX = Math.abs(c) * hw + Math.abs(s) * hh;
    const extY = Math.abs(s) * hw + Math.abs(c) * hh;
    out.minX = peg.x - extX;
    out.maxX = peg.x + extX;
    out.minY = peg.y - extY;
    out.maxY = peg.y + extY;
    return out;
  }
  const r = getPegRadius(peg);
  out.minX = peg.x - r;
  out.maxX = peg.x + r;
  out.minY = peg.y - r;
  out.maxY = peg.y + r;
  return out;
}

function getCachedPegAabb(peg) {
  if (!peg) return null;
  let cache = peg._destructionAabbCache;
  if (!cache) {
    cache = {
      x: NaN,
      y: NaN,
      angle: NaN,
      width: NaN,
      height: NaN,
      radius: NaN,
      shape: null,
      valid: false,
      aabb: { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    };
    peg._destructionAabbCache = cache;
  }

  const shape = peg.shape === 'brick' ? 'brick' : 'circle';
  const { width, height } = shape === 'brick' ? getBrickSize(peg) : { width: 0, height: 0 };
  const radius = shape === 'brick' ? 0 : getPegRadius(peg);
  const angle = shape === 'brick' ? (peg.angle || 0) : 0;
  if (hasCurveSlices(peg)) {
    peg._destructionAabbDirty = false;
    cache.x = peg.x;
    cache.y = peg.y;
    cache.angle = angle;
    cache.width = width;
    cache.height = height;
    cache.radius = radius;
    cache.shape = shape;
    cache.valid = !!writePegAabb(peg, cache.aabb);
    return cache.valid ? cache.aabb : null;
  }
  if (
    peg._destructionAabbDirty
    || cache.x !== peg.x
    || cache.y !== peg.y
    || cache.angle !== angle
    || cache.width !== width
    || cache.height !== height
    || cache.radius !== radius
    || cache.shape !== shape
  ) {
    cache.x = peg.x;
    cache.y = peg.y;
    cache.angle = angle;
    cache.width = width;
    cache.height = height;
    cache.radius = radius;
    cache.shape = shape;
    peg._destructionAabbDirty = false;
    cache.valid = !!writePegAabb(peg, cache.aabb);
  }
  return cache.valid ? cache.aabb : null;
}

function markPegAabbDirty(peg) {
  if (peg) peg._destructionAabbDirty = true;
}

function createBodyOffsetForPeg(peg, body) {
  const offset = {
    x: peg.x - body.x,
    y: peg.y - body.y,
    angle: peg.angle || 0,
    curveSlices: null
  };
  if (hasCurveSlices(peg)) {
    offset.curveSlices = peg.curveSlices.map(slice => ({
      x: slice.x - body.x,
      y: slice.y - body.y,
      nx: Number.isFinite(slice.nx) ? slice.nx : 0,
      ny: Number.isFinite(slice.ny) ? slice.ny : 1
    }));
  }
  return offset;
}

function curveOffsetNeedsRefresh(offset, peg) {
  const hasOffsetSlices = Array.isArray(offset?.curveSlices);
  if (!hasCurveSlices(peg)) return hasOffsetSlices;
  return !hasOffsetSlices || offset.curveSlices.length !== peg.curveSlices.length;
}

function getPortalHalfLength(portal) {
  if (!portal) return PHYSICS_CONFIG.pegRadius;
  return PHYSICS_CONFIG.pegRadius * getPortalScale(portal);
}

function copyAabb(from, to) {
  to.minX = from.minX;
  to.maxX = from.maxX;
  to.minY = from.minY;
  to.maxY = from.maxY;
  return to;
}

function normalizeVector(x, y, fallbackX = 1, fallbackY = 0) {
  const mag = Math.hypot(x, y);
  if (mag <= 0.0001) return { x: fallbackX, y: fallbackY, speed: 0 };
  return { x: x / mag, y: y / mag, speed: mag };
}

function wrapAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

function linearBodySpeed(body) {
  if (!body) return 0;
  return Math.hypot(body.vx || 0, body.vy || 0);
}

function bodyMotionEstimate(body) {
  if (!body) return 0;
  return linearBodySpeed(body) + Math.abs(body.av || 0) * 18;
}

function angularSleepLimit(settings, hasSupport) {
  const base = Math.max(ANGULAR_SLEEP_FLOOR, (settings?.sleepSpeed || DEFAULTS.sleepSpeed) * 0.14);
  return hasSupport ? base * SUPPORT_SLEEP_MULTIPLIER : base;
}

function surfaceGripValue(settings) {
  return Utils.clamp(Number.isFinite(settings?.surfaceGrip) ? settings.surfaceGrip : DEFAULTS.surfaceGrip, 0, 1);
}

function slopeSleepSupportDot(settings) {
  const grip = surfaceGripValue(settings);
  return 0.996 - grip * 0.06;
}

function hasStaticSlopeSlideDemand(body, settings) {
  if (!body || body.static || body.wakeOnHit) return false;
  if ((body.staticSupportMemory || 0) <= 0) return false;
  const supportDot = Number.isFinite(body.staticSupportDot) ? body.staticSupportDot : 0;
  if (supportDot <= 0 || supportDot >= slopeSleepSupportDot(settings)) return false;
  const grip = surfaceGripValue(settings);
  const tangent = Math.sqrt(Math.max(0, 1 - supportDot * supportDot));
  const gravityMag = Math.hypot(settings?.gravityX || 0, settings?.gravityY || 0);
  return gravityMag * tangent * (1 - grip) > (settings?.sleepSpeed || DEFAULTS.sleepSpeed) * 0.08;
}

function canSupportMotionWakeBody(body) {
  if (!body || body.static) return false;
  return !body.wakeOnHit || body.wakeOnHitConsumed;
}

function isBodySlowEnoughForSleep(body, settings, hasSupport) {
  if (hasStaticSlopeSlideDemand(body, settings)) return false;
  if (hasSupport) {
    const supportDot = Number.isFinite(body?.supportDot) ? body.supportDot : 0;
    const sleepSupportDot = slopeSleepSupportDot(settings);
    if (supportDot < sleepSupportDot) return false;
  }
  const linearLimit = (settings?.sleepSpeed || DEFAULTS.sleepSpeed) * (hasSupport ? SUPPORT_SLEEP_MULTIPLIER : 1);
  return linearBodySpeed(body) <= linearLimit && Math.abs(body.av || 0) <= angularSleepLimit(settings, hasSupport);
}

function getGroupBodyIds(groups = []) {
  const ids = new Set();
  if (!Array.isArray(groups)) return ids;
  for (const group of groups) {
    if (!group || group.destructionBody !== true) continue;
    ids.add(group.id);
  }
  return ids;
}

function createColliderRecord() {
  return {
    kind: 'peg',
    peg: null,
    body: null,
    _bodyRef: null,
    curveSegmentIndex: -1,
    shape: 'circle',
    x: 0,
    y: 0,
    radius: 0,
    width: 0,
    height: 0,
    halfWidth: 0,
    halfHeight: 0,
    angle: 0,
    cos: 1,
    sin: 0,
    aabb: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    verticesX: [0, 0, 0, 0],
    verticesY: [0, 0, 0, 0],
    axesX: [1, 0],
    axesY: [0, 1]
  };
}

function clearColliderRecord(collider) {
  if (!collider) return;
  collider.kind = 'peg';
  collider.peg = null;
  collider.body = null;
  collider._bodyRef = null;
  collider.curveSegmentIndex = -1;
  collider.shape = 'circle';
  collider.x = 0;
  collider.y = 0;
  collider.radius = 0;
  collider.width = 0;
  collider.height = 0;
  collider.halfWidth = 0;
  collider.halfHeight = 0;
  collider.angle = 0;
  collider.cos = 1;
  collider.sin = 0;
  collider.aabb.minX = Infinity;
  collider.aabb.maxX = -Infinity;
  collider.aabb.minY = Infinity;
  collider.aabb.maxY = -Infinity;
}

function writeColliderAabbFromVertices(collider) {
  const xs = collider.verticesX;
  const ys = collider.verticesY;
  let minX = xs[0];
  let maxX = xs[0];
  let minY = ys[0];
  let maxY = ys[0];
  for (let i = 1; i < 4; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  collider.aabb.minX = minX;
  collider.aabb.maxX = maxX;
  collider.aabb.minY = minY;
  collider.aabb.maxY = maxY;
}

function fillBrickColliderFields(collider, x, y, width, height, angle) {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  collider.shape = 'brick';
  collider.x = x;
  collider.y = y;
  collider.width = width;
  collider.height = height;
  collider.halfWidth = halfWidth;
  collider.halfHeight = halfHeight;
  collider.angle = angle;
  collider.cos = cos;
  collider.sin = sin;
  collider.radius = 0;

  const xs = collider.verticesX;
  const ys = collider.verticesY;
  xs[0] = x - halfWidth * cos + halfHeight * sin;
  ys[0] = y - halfWidth * sin - halfHeight * cos;
  xs[1] = x + halfWidth * cos + halfHeight * sin;
  ys[1] = y + halfWidth * sin - halfHeight * cos;
  xs[2] = x + halfWidth * cos - halfHeight * sin;
  ys[2] = y + halfWidth * sin + halfHeight * cos;
  xs[3] = x - halfWidth * cos - halfHeight * sin;
  ys[3] = y - halfWidth * sin + halfHeight * cos;

  collider.axesX[0] = cos;
  collider.axesY[0] = sin;
  collider.axesX[1] = -sin;
  collider.axesY[1] = cos;
}

function fillBrickCollider(collider, peg) {
  const { width, height } = getBrickSize(peg);
  fillBrickColliderFields(collider, peg.x, peg.y, width, height, peg.angle || 0);
}

function fillCircleCollider(collider, peg) {
  collider.shape = 'circle';
  collider.x = peg.x;
  collider.y = peg.y;
  collider.radius = getPegRadius(peg);
  collider.width = 0;
  collider.height = 0;
  collider.halfWidth = 0;
  collider.halfHeight = 0;
  collider.angle = 0;
  collider.cos = 1;
  collider.sin = 0;
}

function fillColliderFromPeg(collider, peg, body) {
  collider.kind = 'peg';
  collider.peg = peg;
  collider.body = body;
  collider._bodyRef = body;
  collider.curveSegmentIndex = -1;
  collider.x = peg.x;
  collider.y = peg.y;
  if (peg.shape === 'brick') fillBrickCollider(collider, peg);
  else fillCircleCollider(collider, peg);
  const aabb = getCachedPegAabb(peg);
  if (!aabb) return null;
  copyAabb(aabb, collider.aabb);
  return collider;
}

function fillColliderFromCurveSegment(collider, peg, body, segmentIndex) {
  if (!hasCurveSlices(peg)) return null;
  const a = peg.curveSlices[segmentIndex];
  const b = peg.curveSlices[segmentIndex + 1];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const width = Math.hypot(dx, dy);
  if (!Number.isFinite(width) || width <= 0.001) return null;
  const { height } = getBrickSize(peg);
  collider.kind = 'peg';
  collider.peg = peg;
  collider.body = body;
  collider._bodyRef = body;
  collider.curveSegmentIndex = segmentIndex;
  fillBrickColliderFields(
    collider,
    (a.x + b.x) * 0.5,
    (a.y + b.y) * 0.5,
    width,
    height,
    Math.atan2(dy, dx)
  );
  writeColliderAabbFromVertices(collider);
  return collider;
}

function fillBucketEdgeCollider(collider, bucket, bucketBody, bucketPeg, vx, side) {
  const halfW = (Number.isFinite(bucket.width) ? bucket.width : 70) * 0.5;
  const bucketH = Number.isFinite(bucket.height) ? bucket.height : 16;
  const rimThickness = Math.max(3.5, Math.min(BUCKET_RIM_THICKNESS, PHYSICS_CONFIG.pegRadius * 0.72));
  const rimHeight = Math.max(PHYSICS_CONFIG.pegRadius * 1.4, bucketH * 1.55);
  bucketPeg.x = bucket.x + side * (halfW - rimThickness * 0.5);
  bucketPeg.y = bucket.y - bucketH * 0.08;
  bucketPeg.width = rimThickness;
  bucketPeg.height = rimHeight;
  bucketBody.vx = vx;

  collider.kind = 'bucket';
  collider.peg = bucketPeg;
  collider.body = bucketBody;
  collider._bodyRef = bucketBody;
  collider.curveSegmentIndex = -1;
  collider.x = bucketPeg.x;
  collider.y = bucketPeg.y;
  fillBrickCollider(collider, bucketPeg);
  writeColliderAabbFromVertices(collider);
  return collider;
}

function fillKinematicRectCollider(collider, rect, body, peg, kind) {
  peg.x = Number.isFinite(rect.x) ? rect.x : 0;
  peg.y = Number.isFinite(rect.y) ? rect.y : 0;
  peg.angle = Number.isFinite(rect.angle) ? rect.angle : 0;
  peg.width = Math.max(1, Number.isFinite(rect.width) ? rect.width : PHYSICS_CONFIG.brickWidth);
  peg.height = Math.max(1, Number.isFinite(rect.height) ? rect.height : PHYSICS_CONFIG.brickHeight);
  body.vx = Number.isFinite(rect.vx) ? rect.vx : 0;
  body.vy = Number.isFinite(rect.vy) ? rect.vy : 0;

  collider.kind = kind;
  collider.peg = peg;
  collider.body = body;
  collider._bodyRef = body;
  collider.curveSegmentIndex = -1;
  collider.x = peg.x;
  collider.y = peg.y;
  fillBrickCollider(collider, peg);
  writeColliderAabbFromVertices(collider);
  return collider;
}

function circleCircleOverlap(a, b, out) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const minDist = a.radius + b.radius;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return null;
  const dist = Math.sqrt(distSq);
  if (dist <= 0.0001) {
    out.nx = 1;
    out.ny = 0;
    out.depth = minDist;
    return out;
  }
  out.nx = dx / dist;
  out.ny = dy / dist;
  out.depth = minDist - dist;
  return out;
}

function circleRectOverlap(circle, rect, out) {
  const dx = circle.x - rect.x;
  const dy = circle.y - rect.y;
  const localX = dx * rect.cos + dy * rect.sin;
  const localY = -dx * rect.sin + dy * rect.cos;
  const closestX = Utils.clamp(localX, -rect.halfWidth, rect.halfWidth);
  const closestY = Utils.clamp(localY, -rect.halfHeight, rect.halfHeight);
  const distX = localX - closestX;
  const distY = localY - closestY;
  const distSq = distX * distX + distY * distY;
  if (distSq >= circle.radius * circle.radius) return null;

  let normalLocalX;
  let normalLocalY;
  let depth;
  const dist = Math.sqrt(distSq);
  if (dist <= 0.0001) {
    const overlapX = rect.halfWidth - Math.abs(localX);
    const overlapY = rect.halfHeight - Math.abs(localY);
    if (overlapX < overlapY) {
      normalLocalX = localX >= 0 ? 1 : -1;
      normalLocalY = 0;
      depth = circle.radius + overlapX;
    } else {
      normalLocalX = 0;
      normalLocalY = localY >= 0 ? 1 : -1;
      depth = circle.radius + overlapY;
    }
  } else {
    normalLocalX = distX / dist;
    normalLocalY = distY / dist;
    depth = circle.radius - dist;
  }

  const rectToCircleX = normalLocalX * rect.cos - normalLocalY * rect.sin;
  const rectToCircleY = normalLocalX * rect.sin + normalLocalY * rect.cos;
  out.nx = -rectToCircleX;
  out.ny = -rectToCircleY;
  out.depth = depth;
  return out;
}

function projectRectOnAxis(rect, axisX, axisY, out) {
  const xs = rect.verticesX;
  const ys = rect.verticesY;
  let min = xs[0] * axisX + ys[0] * axisY;
  let max = min;
  for (let i = 1; i < 4; i++) {
    const value = xs[i] * axisX + ys[i] * axisY;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  out.min = min;
  out.max = max;
}

function rectRectOverlap(a, b, out, projectionA, projectionB) {
  let bestAxisX = 0;
  let bestAxisY = 0;
  let bestDepth = Infinity;

  for (let source = 0; source < 2; source++) {
    const rect = source === 0 ? a : b;
    for (let axisIndex = 0; axisIndex < 2; axisIndex++) {
      const axisX = rect.axesX[axisIndex];
      const axisY = rect.axesY[axisIndex];
      projectRectOnAxis(a, axisX, axisY, projectionA);
      projectRectOnAxis(b, axisX, axisY, projectionB);
      const overlap = Math.min(projectionA.max, projectionB.max) - Math.max(projectionA.min, projectionB.min);
      if (overlap <= 0) return null;
      if (overlap < bestDepth) {
        bestDepth = overlap;
        bestAxisX = axisX;
        bestAxisY = axisY;
      }
    }
  }

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * bestAxisX + dy * bestAxisY < 0) {
    bestAxisX = -bestAxisX;
    bestAxisY = -bestAxisY;
  }
  out.nx = bestAxisX;
  out.ny = bestAxisY;
  out.depth = bestDepth;
  return out;
}

function colliderOverlap(a, b, out, projectionA, projectionB) {
  if (!a || !b || !a.peg || !b.peg || isPortalPeg(a.peg) || isPortalPeg(b.peg)) return null;
  if (a.shape === 'brick' && b.shape === 'brick') return rectRectOverlap(a, b, out, projectionA, projectionB);
  if (a.shape === 'brick') {
    const overlap = circleRectOverlap(b, a, out);
    if (!overlap) return null;
    overlap.nx = -overlap.nx;
    overlap.ny = -overlap.ny;
    return overlap;
  }
  if (b.shape === 'brick') return circleRectOverlap(a, b, out);
  return circleCircleOverlap(a, b, out);
}

function gridKey(gx, gy) {
  return (gx + GRID_COORD_OFFSET) * GRID_KEY_STRIDE + (gy + GRID_COORD_OFFSET);
}

export class DestructionPegSystem {
  constructor(settings = null) {
    this.bodies = new Map();
    this.pegToBody = new Map();
    this._pegById = new Map();
    this._pairKeys = new Set();
    this._grid = new Map();
    this._gridBucketPool = [];
    this._colliders = [];
    this._colliderCount = 0;
    this._bucketEdgePegs = [-1, 1].map(side => ({
      id: side < 0 ? '__destruction_bucket_left' : '__destruction_bucket_right',
      x: 0,
      y: 0,
      angle: 0,
      shape: 'brick',
      width: BUCKET_RIM_THICKNESS,
      height: 24,
      type: 'obstacle'
    }));
    this._bucketBody = {
      id: '__destruction_bucket',
      static: true,
      sleeping: true,
      invMass: 0,
      vx: 0,
      vy: 0,
      av: 0
    };
    this._flipperPegs = ['left', 'right'].map(side => ({
      id: `__destruction_flipper_${side}`,
      x: 0,
      y: 0,
      angle: 0,
      shape: 'brick',
      width: PHYSICS_CONFIG.brickWidth,
      height: PHYSICS_CONFIG.brickHeight,
      type: 'obstacle'
    }));
    this._flipperBodies = ['left', 'right'].map(side => ({
      id: `__destruction_flipper_${side}`,
      static: true,
      sleeping: true,
      invMass: 0,
      vx: 0,
      vy: 0,
      av: 0
    }));
    this._lastBucketX = null;
    this._stepBucketVx = 0;
    this._structureDirty = true;
    this._hasSynced = false;
    this._lastPegsRef = null;
    this._lastGroupsRef = null;
    this._lastPegCount = 0;
    this._lastGroupCount = 0;
    this._dirtyBodies = new Set();
    this._pendingWakeQueue = [];
    this._wakeHead = 0;
    this._pendingWakeIds = new Set();
    this._bumperHitEvents = [];
    this._bumperHitKeys = new Set();
    this._portalHitEvents = [];
    this._runtimeBodyOverrides = new Map();
    this._fractureQueue = [];
    this._splitCounter = 0;
    this._pendingFallenCheck = false;
    this._runtimeCountersDirty = true;
    this._awakeBodyCount = 0;
    this._slopedSleeperCount = 0;
    this._unstableSupportSleeperCount = 0;
    this._kinematicBodyCount = 0;
    this._kinematicMotionCount = 0;
    this._gravityNormX = 0;
    this._gravityNormY = 1;
    this._overlap = { nx: 0, ny: 0, depth: 0 };
    this._projectionA = { min: 0, max: 0 };
    this._projectionB = { min: 0, max: 0 };
    this.debugStats = {
      colliderBuilds: 0,
      skippedSteps: 0,
      cappedSubsteps: 0,
      queuedWakeFrames: 0,
      maxWakeQueue: 0,
      runtimeCounterRebuilds: 0
    };
    this.configure(settings);
  }

  configure(settings = null) {
    this.settings = normalizeDestructionSettings(settings);
    this.updateGravityNormal();
    this.markStructureDirty();
    return this.settings;
  }

  isEnabled() {
    return !!this.settings?.enabled;
  }

  markStructureDirty() {
    this._structureDirty = true;
    this._pendingFallenCheck = true;
    this.markRuntimeCountersDirty();
  }

  markRuntimeCountersDirty() {
    this._runtimeCountersDirty = true;
  }

  refreshRuntimeCounters() {
    if (!this._runtimeCountersDirty) return;
    let awake = 0;
    let slopedSleepers = 0;
    let unstableSupportSleepers = 0;
    for (const body of this.bodies.values()) {
      if (!body || body.static) continue;
      if (!body.sleeping) {
        awake++;
        continue;
      }
      if (hasStaticSlopeSlideDemand(body, this.settings)) slopedSleepers++;
      if (this.hasUnstableDynamicSupport(body)) unstableSupportSleepers++;
    }
    this._awakeBodyCount = awake;
    this._slopedSleeperCount = slopedSleepers;
    this._unstableSupportSleeperCount = unstableSupportSleepers;
    this._runtimeCountersDirty = false;
    this.debugStats.runtimeCounterRebuilds++;
  }

  hasAwakeBodies() {
    this.refreshRuntimeCounters();
    return this._awakeBodyCount > 0;
  }

  hasSlopedSleepers() {
    this.refreshRuntimeCounters();
    return this._slopedSleeperCount > 0;
  }

  hasUnstableSupportSleepers() {
    this.refreshRuntimeCounters();
    return this._unstableSupportSleeperCount > 0;
  }

  needsFixedStep() {
    if (!this.isEnabled()) return false;
    if (
      this._structureDirty
      || this.getPendingWakeCount() > 0
      || this._fractureQueue.length > 0
      || this._pendingFallenCheck
      || this._kinematicMotionCount > 0
    ) {
      return true;
    }
    this.refreshRuntimeCounters();
    return this._slopedSleeperCount > 0
      || this._unstableSupportSleeperCount > 0
      || this._awakeBodyCount > 0;
  }

  reset(pegs = [], groups = []) {
    this.bodies.clear();
    this.pegToBody.clear();
    this._pegById.clear();
    this._pairKeys.clear();
    this.releaseGridBuckets();
    for (const collider of this._colliders) clearColliderRecord(collider);
    this._colliders.length = 0;
    this._colliderCount = 0;
    this._lastBucketX = null;
    this._stepBucketVx = 0;
    this._dirtyBodies.clear();
    this._pendingWakeQueue.length = 0;
    this._wakeHead = 0;
    this._pendingWakeIds.clear();
    this._bumperHitEvents.length = 0;
    this._bumperHitKeys.clear();
    this._portalHitEvents.length = 0;
    this._runtimeBodyOverrides.clear();
    this._fractureQueue.length = 0;
    this._splitCounter = 0;
    this._structureDirty = true;
    this._hasSynced = false;
    this._lastPegsRef = null;
    this._lastGroupsRef = null;
    this._lastPegCount = 0;
    this._lastGroupCount = 0;
    this._pendingFallenCheck = true;
    this._awakeBodyCount = 0;
    this._slopedSleeperCount = 0;
    this._unstableSupportSleeperCount = 0;
    this._kinematicBodyCount = 0;
    this._kinematicMotionCount = 0;
    this.markRuntimeCountersDirty();
    if (this.isEnabled() && Array.isArray(pegs) && pegs.length > 0) {
      this.syncBodies(pegs, groups, { forceRebuild: true });
    }
  }

  getBodyIdForPeg(peg, groupBodyIds) {
    if (!peg || isPortalPeg(peg)) return null;
    const runtimeBodyId = this._runtimeBodyOverrides.get(peg.id);
    if (runtimeBodyId) return runtimeBodyId;
    if (peg.groupId != null && groupBodyIds.has(peg.groupId)) return `group:${peg.groupId}`;
    return `peg:${peg.id}`;
  }

  syncBodies(pegs = [], groups = [], options = null) {
    if (!this.isEnabled()) return;
    const forceRebuild = options?.forceRebuild === true;
    const groupCount = Array.isArray(groups) ? groups.length : 0;
    const groupsStable = groupCount === 0
      ? this._lastGroupCount === 0
      : this._lastGroupsRef === groups && this._lastGroupCount === groupCount;
    const sameStructure = !forceRebuild
      && !this._structureDirty
      && this._hasSynced
      && this._lastPegsRef === pegs
      && groupsStable
      && this._lastPegCount === pegs.length
      && this._lastGroupCount === groupCount;
    if (sameStructure) return;

    this._pegById.clear();
    for (const peg of pegs) {
      if (peg?.id) this._pegById.set(peg.id, peg);
    }
    for (const pegId of this._runtimeBodyOverrides.keys()) {
      if (!this._pegById.has(pegId)) this._runtimeBodyOverrides.delete(pegId);
    }

    const groupBodyIds = getGroupBodyIds(groups);
    const buckets = new Map();
    this.pegToBody.clear();

    for (const peg of pegs) {
      if (!peg || !peg.id || isPortalPeg(peg)) continue;
      coerceDestructionPegFlags(peg);
      const bodyId = this.getBodyIdForPeg(peg, groupBodyIds);
      if (!bodyId) continue;
      let bucket = buckets.get(bodyId);
      if (!bucket) {
        bucket = [];
        buckets.set(bodyId, bucket);
      }
      bucket.push(peg);
      this.pegToBody.set(peg.id, bodyId);
      peg._destructionBodyId = bodyId;
    }

    for (const bodyId of this.bodies.keys()) {
      if (!buckets.has(bodyId)) {
        this.bodies.delete(bodyId);
      }
    }

    for (const [bodyId, members] of buckets.entries()) {
      let body = this.bodies.get(bodyId);
      const isNew = !body || forceRebuild;
      if (isNew) {
        body = this.createBody(bodyId, members);
        this.bodies.set(bodyId, body);
      } else {
        this.refreshBody(body, members);
      }
      this.applyBodyToPegs(body, true);
    }

    this._lastPegsRef = pegs;
    this._lastGroupsRef = groups;
    this._lastPegCount = pegs.length;
    this._lastGroupCount = groupCount;
    this._structureDirty = false;
    this._hasSynced = true;
    this._pendingFallenCheck = true;
    this.markRuntimeCountersDirty();
  }

  createBody(id, members) {
    let cx = 0;
    let cy = 0;
    for (const peg of members) {
      cx += peg.x;
      cy += peg.y;
    }
    cx /= Math.max(1, members.length);
    cy /= Math.max(1, members.length);

    const body = {
      id,
      x: cx,
      y: cy,
      angle: 0,
      vx: 0,
      vy: 0,
      av: 0,
      mass: 1,
      invMass: 1,
      static: false,
      wakeOnHit: false,
      wakeOnHitBallOnly: false,
      wakeOnHitConsumed: false,
      animationDetached: false,
      kinematic: false,
      portalCooldown: 0,
      _lastPortalTeleport: null,
      _portalOscillationCount: 0,
      sleeping: false,
      sleepFrames: 0,
      supported: false,
      supportMemory: 0,
      supportDot: 0,
      staticSupportMemory: 0,
      staticSupportDot: 0,
      dynamicSupportMemory: 0,
      dynamicSupportBodyId: null,
      fractureCooldown: 0,
      pegIds: [],
      pegIdSet: new Set(),
      offsets: new Map(),
      _colliderIndices: [],
      transformDirty: false,
      aabb: { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    };
    this.refreshBody(body, members, { resetOffsets: true });
    body.sleeping = body.static || body.wakeOnHit;
    body.animationDetached = !body.static && !body.wakeOnHit;
    return body;
  }

  refreshBody(body, members, options = null) {
    const resetOffsets = options?.resetOffsets === true;
    body.pegIds.length = 0;
    body.pegIdSet.clear();
    let mass = 0;
    let allStatic = members.length > 0;
    let allWakeOnHit = members.length > 0;
    let allWakeOnHitBallOnly = members.length > 0;
    for (const peg of members) {
      body.pegIds.push(peg.id);
      body.pegIdSet.add(peg.id);
      const pegStatic = isDestructionStaticPeg(peg);
      const wakeOnHit = peg.destructionPhysicsOnHit === true;
      const wakeOnHitBallOnly = wakeOnHit && peg.destructionPhysicsOnHitBallOnly === true;
      allStatic = allStatic && pegStatic;
      allWakeOnHit = allWakeOnHit && wakeOnHit;
      allWakeOnHitBallOnly = allWakeOnHitBallOnly && wakeOnHitBallOnly;
      mass += getPegMass(peg);

      const existingOffset = body.offsets.get(peg.id);
      if (resetOffsets || !existingOffset || curveOffsetNeedsRefresh(existingOffset, peg)) {
        body.offsets.set(peg.id, createBodyOffsetForPeg(peg, body));
      }
    }

    for (const pegId of body.offsets.keys()) {
      if (!body.pegIdSet.has(pegId)) body.offsets.delete(pegId);
    }

    const wasStatic = body.static;
    const wasWakeOnHit = body.wakeOnHit;
    body.mass = Math.max(0.5, mass);
    body.invMass = 1 / body.mass;
    body.static = allStatic;
    body.wakeOnHit = !body.static && allWakeOnHit;
    body.wakeOnHitBallOnly = body.wakeOnHit && allWakeOnHitBallOnly;
    if (body.static) {
      body.vx = 0;
      body.vy = 0;
      body.av = 0;
      body.kinematic = false;
      body.animationDetached = false;
      body.sleeping = true;
      body.sleepFrames = 0;
      body.wakeOnHitConsumed = false;
    } else if (!body.wakeOnHit) {
      body.wakeOnHitConsumed = false;
      body.animationDetached = true;
      body.kinematic = false;
      if (wasStatic || wasWakeOnHit) {
        body.sleeping = false;
        body.sleepFrames = 0;
      }
    } else if (!body.wakeOnHitConsumed) {
      body.vx = 0;
      body.vy = 0;
      body.av = 0;
      body.kinematic = false;
      body.animationDetached = false;
      body.sleeping = true;
      body.sleepFrames = 0;
    } else {
      body.animationDetached = true;
      body.kinematic = false;
    }
  }

  getPhysicsOwnedPegIds() {
    const ids = [];
    for (const body of this.bodies.values()) {
      if (!body || body.static) continue;
      if (!body.animationDetached && body.sleeping && !body.wakeOnHitConsumed) continue;
      for (const pegId of body.pegIds) ids.push(pegId);
    }
    return ids;
  }

  isBodyAnimationOwned(body, animatedPegIds) {
    if (!body || body.animationDetached || this.isActiveDynamic(body)) return false;
    if (!(animatedPegIds instanceof Set) || animatedPegIds.size === 0) return false;
    if (!Array.isArray(body.pegIds) || body.pegIds.length === 0) return false;
    for (const pegId of body.pegIds) {
      if (!animatedPegIds.has(pegId)) return false;
    }
    return true;
  }

  getBodyPoseFromCurrentPegs(body) {
    if (!body || !Array.isArray(body.pegIds) || body.pegIds.length === 0) return null;
    let cx = 0;
    let cy = 0;
    let count = 0;
    for (const pegId of body.pegIds) {
      const peg = this._pegById.get(pegId);
      if (!peg || !Number.isFinite(peg.x) || !Number.isFinite(peg.y)) continue;
      cx += peg.x;
      cy += peg.y;
      count++;
    }
    if (count === 0) return null;
    cx /= count;
    cy /= count;

    let dot = 0;
    let cross = 0;
    let angleSin = 0;
    let angleCos = 0;
    let angleCount = 0;
    for (const pegId of body.pegIds) {
      const peg = this._pegById.get(pegId);
      const offset = body.offsets.get(pegId);
      if (!peg || !offset) continue;
      const ox = offset.x || 0;
      const oy = offset.y || 0;
      const rx = (peg.x || 0) - cx;
      const ry = (peg.y || 0) - cy;
      if (ox * ox + oy * oy > 1 && rx * rx + ry * ry > 1) {
        dot += ox * rx + oy * ry;
        cross += ox * ry - oy * rx;
      }
      if (peg.shape === 'brick') {
        const angle = wrapAngle((peg.angle || 0) - (offset.angle || 0));
        angleSin += Math.sin(angle);
        angleCos += Math.cos(angle);
        angleCount++;
      }
    }

    let angle = body.angle || 0;
    if (Math.abs(dot) + Math.abs(cross) > 0.0001) {
      angle = Math.atan2(cross, dot);
    } else if (angleCount > 0 && Math.abs(angleSin) + Math.abs(angleCos) > 0.0001) {
      angle = Math.atan2(angleSin, angleCos);
    }

    return { x: cx, y: cy, angle: wrapAngle(angle) };
  }

  syncAnimatedBodies(animatedPegIds = null, dtSeconds = BASE_STEP_SECONDS) {
    const animatedSet = animatedPegIds instanceof Set
      ? animatedPegIds
      : new Set(Array.isArray(animatedPegIds) ? animatedPegIds : []);
    const timeScale = Number.isFinite(PHYSICS_CONFIG.timeScale) ? PHYSICS_CONFIG.timeScale : 1;
    const safeDt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : BASE_STEP_SECONDS;
    const stepScale = Math.max(0.1, (safeDt / BASE_STEP_SECONDS) * timeScale);
    let moved = false;
    let kinematicCount = 0;
    let kinematicMotionCount = 0;

    for (const body of this.bodies.values()) {
      if (!body) continue;
      const animationOwned = this.isBodyAnimationOwned(body, animatedSet);
      if (!animationOwned) {
        if (body.kinematic) {
          body.kinematic = false;
          if (body.static || body.sleeping) {
            body.vx = 0;
            body.vy = 0;
            body.av = 0;
          }
        }
        continue;
      }

      const pose = this.getBodyPoseFromCurrentPegs(body);
      if (!pose) continue;
      const oldX = body.x || 0;
      const oldY = body.y || 0;
      const oldAngle = body.angle || 0;
      body.x = pose.x;
      body.y = pose.y;
      body.angle = pose.angle;
      body.vx = (body.x - oldX) / stepScale;
      body.vy = (body.y - oldY) / stepScale;
      body.av = wrapAngle(body.angle - oldAngle) / stepScale;
      body.kinematic = true;
      body.transformDirty = false;
      this._dirtyBodies.delete(body);

      const motion = bodyMotionEstimate(body);
      if (motion > BUCKET_MOVE_EPSILON) {
        moved = true;
        kinematicMotionCount++;
      }
      kinematicCount++;
    }

    this._kinematicBodyCount = kinematicCount;
    this._kinematicMotionCount = kinematicMotionCount;
    return moved;
  }

  getBodyForPeg(peg) {
    if (!peg?.id) return null;
    const bodyId = this.pegToBody.get(peg.id) || peg._destructionBodyId;
    return bodyId ? this.bodies.get(bodyId) || null : null;
  }

  markBodyTransformDirty(body) {
    if (!body) return;
    body.transformDirty = true;
    this._dirtyBodies.add(body);
  }

  applyBodyToPegs(body, force = false) {
    if (!body || (!force && !body.transformDirty)) return;
    const cos = Math.cos(body.angle || 0);
    const sin = Math.sin(body.angle || 0);
    for (const pegId of body.pegIds) {
      const peg = this._pegById.get(pegId);
      const offset = body.offsets.get(pegId);
      if (!peg || !offset) continue;
      peg.x = body.x + offset.x * cos - offset.y * sin;
      peg.y = body.y + offset.x * sin + offset.y * cos;
      if (peg.shape === 'brick') peg.angle = wrapAngle((offset.angle || 0) + (body.angle || 0));
      if (offset.curveSlices && hasCurveSlices(peg)) {
        for (let i = 0; i < offset.curveSlices.length && i < peg.curveSlices.length; i++) {
          const sliceOffset = offset.curveSlices[i];
          peg.curveSlices[i].x = body.x + sliceOffset.x * cos - sliceOffset.y * sin;
          peg.curveSlices[i].y = body.y + sliceOffset.x * sin + sliceOffset.y * cos;
          peg.curveSlices[i].nx = sliceOffset.nx * cos - sliceOffset.ny * sin;
          peg.curveSlices[i].ny = sliceOffset.nx * sin + sliceOffset.ny * cos;
        }
      }
      peg._destructionAwake = !body.static && !body.sleeping;
      markPegAabbDirty(peg);
    }
    body.transformDirty = false;
    this._dirtyBodies.delete(body);
  }

  flushDirtyBodies() {
    if (this._dirtyBodies.size === 0) return;
    for (const body of this._dirtyBodies) {
      this.applyBodyToPegs(body);
    }
    this._dirtyBodies.clear();
  }

  canWakeBody(body, source = 'generic') {
    if (!body || body.static) return false;
    if (body.wakeOnHitBallOnly && body.sleeping && source !== 'ball') return false;
    return true;
  }

  wakeBody(body, impulseX = 0, impulseY = 0, contactPeg = null, sourceX = null, sourceY = null, source = 'generic') {
    if (!body || body.static) return false;
    if (!this.canWakeBody(body, source)) return false;
    const ix = Number.isFinite(impulseX) ? impulseX : 0;
    const iy = Number.isFinite(impulseY) ? impulseY : 0;
    body.sleeping = false;
    body.sleepFrames = 0;
    body.animationDetached = true;
    body.kinematic = false;
    body.supported = false;
    body.supportMemory = 0;
    body.staticSupportMemory = 0;
    body.staticSupportDot = 0;
    body.dynamicSupportMemory = 0;
    body.dynamicSupportBodyId = null;
    if (body.wakeOnHit) body.wakeOnHitConsumed = true;
    if (ix !== 0 || iy !== 0) {
      body.vx += ix * body.invMass;
      body.vy += iy * body.invMass;
      const px = Number.isFinite(contactPeg?.x) ? contactPeg.x : body.x;
      const py = Number.isFinite(contactPeg?.y) ? contactPeg.y : body.y;
      const sx = Number.isFinite(sourceX) ? sourceX : body.x;
      const sy = Number.isFinite(sourceY) ? sourceY : body.y;
      const rx = px - body.x;
      const ry = py - body.y;
      const torque = rx * iy - ry * ix;
      const sourceBias = Math.sign((px - sx) * iy - (py - sy) * ix) || 1;
      body.av += (torque || sourceBias * Math.hypot(ix, iy)) * ANGULAR_IMPULSE_SCALE / Math.max(0.65, body.mass);
      body.av = Utils.clamp(body.av, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);
    }
    this.clampBodySpeed(body);
    this._pendingFallenCheck = true;
    this.markRuntimeCountersDirty();
    return true;
  }

  applyBallImpact(peg, ball, impact = null) {
    if (!this.isEnabled() || !peg || isPortalPeg(peg)) return false;
    const body = this.getBodyForPeg(peg);
    if (!body || body.static) return false;

    const impactVx = Number.isFinite(impact?.vx) ? impact.vx : (ball?.vx || 0);
    const impactVy = Number.isFinite(impact?.vy) ? impact.vy : (ball?.vy || 0);
    const speed = Number.isFinite(impact?.speed) ? impact.speed : Math.hypot(impactVx, impactVy);
    if (speed <= 0.0001) return false;

    let dir = normalizeVector(impactVx, impactVy);
    if (Number.isFinite(impact?.normalX) && Number.isFinite(impact?.normalY)) {
      const normal = normalizeVector(impact.normalX, impact.normalY, dir.x, dir.y);
      const tangentX = -normal.y;
      const tangentY = normal.x;
      const tangentSpeed = impactVx * tangentX + impactVy * tangentY;
      const normalSpeed = Math.max(speed * 0.35, impactVx * normal.x + impactVy * normal.y);
      dir = normalizeVector(
        normal.x * normalSpeed + tangentX * tangentSpeed * 0.18,
        normal.y * normalSpeed + tangentY * tangentSpeed * 0.18,
        normal.x,
        normal.y
      );
    }

    const impulse = Utils.clamp(speed * HIT_IMPULSE_SCALE, HIT_IMPULSE_MIN, this.settings.maxSpeed);
    const woke = this.wakeBody(
      body,
      dir.x * impulse,
      dir.y * impulse,
      peg,
      Number.isFinite(ball?.x) ? ball.x : null,
      Number.isFinite(ball?.y) ? ball.y : null,
      'ball'
    );
    if (woke && Math.abs(impulse) >= GROUP_FRACTURE_IMPULSE * 1.15) {
      this.queueBodyFracture(body, peg.x, peg.y, impulse, dir.x, dir.y);
    }
    return woke;
  }

  applyShockwaveTargets(targets = [], centerX = 0, centerY = 0, radius = 1, sourceBall = null, strength = null) {
    if (!this.isEnabled() || !Array.isArray(targets) || targets.length === 0) return 0;
    this.compactWakeQueue();
    const force = Number.isFinite(strength) ? strength : this.settings.bombImpulse;
    const seen = new Set();
    const candidates = [];
    for (const peg of targets) {
      if (!peg || isPortalPeg(peg)) continue;
      const body = this.getBodyForPeg(peg);
      if (!body || body.static || seen.has(body.id)) continue;
      seen.add(body.id);
      const dx = (Number.isFinite(peg.x) ? peg.x : body.x) - centerX;
      const dy = (Number.isFinite(peg.y) ? peg.y : body.y) - centerY;
      const dir = normalizeVector(dx, dy, 0, -1);
      const distRatio = radius > 0 ? Utils.clamp(1 - (dir.speed / Math.max(1, radius)), 0.18, 1) : 1;
      const impulse = force * distRatio;
      candidates.push({
        body,
        bodyId: body.id,
        pegId: peg.id,
        impulseX: dir.x * impulse,
        impulseY: dir.y * impulse,
        dirX: dir.x,
        dirY: dir.y,
        impulse,
        sourceX: centerX,
        sourceY: centerY,
        distance: dir.speed
      });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    let count = 0;
    for (const candidate of candidates) {
      if (count < MAX_BODIES_WOKEN_PER_STEP) {
        const peg = this._pegById.get(candidate.pegId) || null;
        if (this.wakeBody(candidate.body, candidate.impulseX, candidate.impulseY, peg, centerX, centerY, 'shockwave')) {
          this.queueBodyFracture(
            candidate.body,
            peg?.x ?? candidate.body.x,
            peg?.y ?? candidate.body.y,
            candidate.impulse,
            candidate.dirX,
            candidate.dirY
          );
          count++;
        }
      } else if (!this._pendingWakeIds.has(candidate.bodyId)) {
        this._pendingWakeIds.add(candidate.bodyId);
        this._pendingWakeQueue.push(candidate);
      }
    }
    const pendingCount = this.getPendingWakeCount();
    if (pendingCount > 0) {
      this.debugStats.queuedWakeFrames++;
      this.debugStats.maxWakeQueue = Math.max(this.debugStats.maxWakeQueue, pendingCount);
    }
    return count;
  }

  getPendingWakeCount() {
    return Math.max(0, this._pendingWakeQueue.length - this._wakeHead);
  }

  compactWakeQueue(force = false) {
    if (this._wakeHead <= 0) return;
    if (this._wakeHead >= this._pendingWakeQueue.length) {
      this._pendingWakeQueue.length = 0;
      this._wakeHead = 0;
      return;
    }
    if (force || this._wakeHead > WAKE_QUEUE_COMPACT_THRESHOLD) {
      this._pendingWakeQueue.splice(0, this._wakeHead);
      this._wakeHead = 0;
    }
  }

  drainWakeQueue(limit = MAX_BODIES_WOKEN_PER_STEP) {
    if (this.getPendingWakeCount() === 0 || limit <= 0) return 0;
    let count = 0;
    while (this._wakeHead < this._pendingWakeQueue.length && count < limit) {
      const candidate = this._pendingWakeQueue[this._wakeHead++];
      if (!candidate) continue;
      this._pendingWakeIds.delete(candidate.bodyId);
      const body = this.bodies.get(candidate.bodyId);
      if (!body || body.static) continue;
      const peg = this._pegById.get(candidate.pegId) || null;
      if (this.wakeBody(body, candidate.impulseX, candidate.impulseY, peg, candidate.sourceX, candidate.sourceY, 'shockwave')) {
        this.queueBodyFracture(
          body,
          peg?.x ?? body.x,
          peg?.y ?? body.y,
          candidate.impulse,
          candidate.dirX,
          candidate.dirY
        );
        count++;
      }
    }
    this.compactWakeQueue();
    return count;
  }

  isBreakableBody(body) {
    if (!body || body.static) return false;
    if (!Array.isArray(body.pegIds) || body.pegIds.length < GROUP_FRACTURE_MIN_PEGS) return false;
    return body.id?.startsWith('group:') || body.id?.startsWith('split:') || body.pegIds.length > 1;
  }

  queueBodyFracture(body, contactX = null, contactY = null, strength = 0, dirX = 0, dirY = 0) {
    if (!this.isBreakableBody(body)) return false;
    if ((body.fractureCooldown || 0) > 0) return false;
    const impactStrength = Number.isFinite(strength) ? Math.abs(strength) : 0;
    if (impactStrength < GROUP_FRACTURE_IMPULSE) return false;
    for (const queued of this._fractureQueue) {
      if (queued?.bodyId === body.id) return false;
    }
    const dir = normalizeVector(dirX, dirY, 1, 0);
    this._fractureQueue.push({
      bodyId: body.id,
      contactX: Number.isFinite(contactX) ? contactX : body.x,
      contactY: Number.isFinite(contactY) ? contactY : body.y,
      strength: impactStrength,
      dirX: dir.x,
      dirY: dir.y
    });
    return true;
  }

  getFractureMemberForPeg(peg) {
    if (!peg) return null;
    const aabb = getCachedPegAabb(peg);
    let radius = getPegRadius(peg);
    if (aabb) {
      radius = Math.max(
        radius,
        Math.hypot(aabb.maxX - aabb.minX, aabb.maxY - aabb.minY) * 0.32
      );
    } else if (peg.shape === 'brick') {
      const { width, height } = getBrickSize(peg);
      radius = Math.hypot(width, height) * 0.5;
    }
    return {
      id: peg.id,
      peg,
      x: Number.isFinite(peg.x) ? peg.x : 0,
      y: Number.isFinite(peg.y) ? peg.y : 0,
      radius,
      aabb
    };
  }

  areFractureMembersConnected(a, b) {
    if (!a || !b) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const centerDist = Math.hypot(dx, dy);
    if (centerDist <= a.radius + b.radius + 10) return true;
    if (!a.aabb || !b.aabb) return false;
    const gapX = Math.max(0, Math.max(a.aabb.minX - b.aabb.maxX, b.aabb.minX - a.aabb.maxX));
    const gapY = Math.max(0, Math.max(a.aabb.minY - b.aabb.maxY, b.aabb.minY - a.aabb.maxY));
    return Math.hypot(gapX, gapY) <= 10;
  }

  connectedFracturePieces(members, removedEdges) {
    const pieces = [];
    const visited = new Set();
    const byIndex = index => members[index];
    for (let start = 0; start < members.length; start++) {
      if (visited.has(start)) continue;
      const stack = [start];
      const piece = [];
      visited.add(start);
      while (stack.length > 0) {
        const current = stack.pop();
        piece.push(byIndex(current).id);
        for (let next = 0; next < members.length; next++) {
          if (next === current || visited.has(next)) continue;
          const key = current < next ? `${current}:${next}` : `${next}:${current}`;
          if (removedEdges.has(key)) continue;
          if (!this.areFractureMembersConnected(byIndex(current), byIndex(next))) continue;
          visited.add(next);
          stack.push(next);
        }
      }
      if (piece.length > 0) pieces.push(piece);
    }
    return pieces;
  }

  splitBodyMembers(body, contactX, contactY, dirX, dirY, strength = GROUP_FRACTURE_IMPULSE) {
    const members = body.pegIds
      .map(pegId => this.getFractureMemberForPeg(this._pegById.get(pegId)))
      .filter(Boolean);
    if (members.length < GROUP_FRACTURE_MIN_PEGS) return null;

    const edges = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (!this.areFractureMembersConnected(members[i], members[j])) continue;
        const midX = (members[i].x + members[j].x) * 0.5;
        const midY = (members[i].y + members[j].y) * 0.5;
        edges.push({
          i,
          j,
          key: `${i}:${j}`,
          dist: Math.hypot(midX - contactX, midY - contactY)
        });
      }
    }

    const naturalPieces = this.connectedFracturePieces(members, new Set());
    if (naturalPieces.length > 1) return naturalPieces;

    if (edges.length > 0) {
      edges.sort((a, b) => a.dist - b.dist);
      const removed = new Set();
      const fractureRadius = Utils.clamp(14 + strength * 4, 18, 78);
      const minCuts = Math.min(edges.length, 1 + Math.floor(Math.max(0, strength - GROUP_FRACTURE_IMPULSE) / 4));
      for (const edge of edges) {
        if (removed.size < minCuts || edge.dist <= fractureRadius) {
          removed.add(edge.key);
        }
      }
      const pieces = this.connectedFracturePieces(members, removed)
        .filter(piece => piece.length > 0);
      if (pieces.length > 1) return pieces;
    }

    const axis = normalizeVector(-dirY, dirX, 1, 0);
    const projected = members
      .map(member => ({
        id: member.id,
        value: (member.x - contactX) * axis.x + (member.y - contactY) * axis.y
      }))
      .sort((a, b) => a.value - b.value);
    const splitAt = Math.max(1, Math.min(projected.length - 1, Math.floor(projected.length / 2)));
    return [
      projected.slice(0, splitAt).map(item => item.id),
      projected.slice(splitAt).map(item => item.id)
    ].filter(piece => piece.length > 0);
  }

  captureBodyRuntimeState(body) {
    if (!body) return null;
    return {
      vx: body.vx || 0,
      vy: body.vy || 0,
      av: body.av || 0,
      sleeping: !!body.sleeping,
      wakeOnHitConsumed: !!body.wakeOnHitConsumed,
      animationDetached: !!body.animationDetached,
      portalCooldown: body.portalCooldown || 0,
      sleepFrames: body.sleepFrames || 0,
      supported: !!body.supported,
      supportMemory: body.supportMemory || 0,
      supportDot: body.supportDot || 0,
      staticSupportMemory: body.staticSupportMemory || 0,
      staticSupportDot: body.staticSupportDot || 0,
      dynamicSupportMemory: body.dynamicSupportMemory || 0,
      dynamicSupportBodyId: body.dynamicSupportBodyId || null,
      fractureCooldown: body.fractureCooldown || 0
    };
  }

  restoreBodyRuntimeState(body, state) {
    if (!body || !state || body.static) return false;
    body.vx = state.vx;
    body.vy = state.vy;
    body.av = state.av;
    body.sleeping = !!state.sleeping;
    body.animationDetached = !!state.animationDetached;
    body.kinematic = false;
    body.portalCooldown = state.portalCooldown || 0;
    body.sleepFrames = state.sleepFrames;
    body.supported = !!state.supported;
    body.supportMemory = state.supportMemory;
    body.supportDot = state.supportDot;
    body.staticSupportMemory = state.staticSupportMemory;
    body.staticSupportDot = state.staticSupportDot;
    body.dynamicSupportMemory = state.dynamicSupportMemory;
    body.dynamicSupportBodyId = state.dynamicSupportBodyId;
    body.fractureCooldown = state.fractureCooldown;
    body.wakeOnHitConsumed = !!state.wakeOnHitConsumed || (body.wakeOnHit && !state.sleeping);
    this.clampBodySpeed(body);
    this.applyBodyToPegs(body, true);
    this.markRuntimeCountersDirty();
    return true;
  }

  applyQueuedFractures(pegs = [], groups = []) {
    if (this._fractureQueue.length === 0) return false;
    const queue = this._fractureQueue.splice(0, this._fractureQueue.length);
    const pieceStates = [];
    const processed = new Set();

    for (const event of queue) {
      if (!event || processed.has(event.bodyId)) continue;
      const body = this.bodies.get(event.bodyId);
      if (!this.isBreakableBody(body)) continue;
      if ((body.fractureCooldown || 0) > 0) continue;
      const pieces = this.splitBodyMembers(
        body,
        event.contactX,
        event.contactY,
        event.dirX,
        event.dirY,
        event.strength
      );
      if (!pieces || pieces.length < 2) continue;

      processed.add(body.id);
      const splitBaseId = `split:${++this._splitCounter}`;
      for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
        const piecePegIds = pieces[pieceIndex];
        const pieceBodyId = `${splitBaseId}:${pieceIndex}`;
        for (const pegId of piecePegIds) {
          this._runtimeBodyOverrides.set(pegId, pieceBodyId);
        }
        pieceStates.push({
          bodyId: pieceBodyId,
          oldVx: body.vx || 0,
          oldVy: body.vy || 0,
          oldAv: body.av || 0,
          contactX: event.contactX,
          contactY: event.contactY,
          dirX: event.dirX,
          dirY: event.dirY,
          strength: event.strength,
          pieceIndex,
          pieceCount: pieces.length
        });
      }
    }

    if (pieceStates.length === 0) return false;
    const preservedStates = new Map();
    for (const [bodyId, body] of this.bodies.entries()) {
      if (processed.has(bodyId)) continue;
      const state = this.captureBodyRuntimeState(body);
      if (state) preservedStates.set(bodyId, state);
    }

    this.markStructureDirty();
    this.syncBodies(pegs, groups, { forceRebuild: true });

    for (const [bodyId, state] of preservedStates.entries()) {
      this.restoreBodyRuntimeState(this.bodies.get(bodyId), state);
    }

    for (const state of pieceStates) {
      const body = this.bodies.get(state.bodyId);
      if (!body || body.static) continue;
      const away = normalizeVector(body.x - state.contactX, body.y - state.contactY, state.dirX, state.dirY);
      const kick = Utils.clamp(state.strength * 0.085, 0.35, 3.2);
      body.vx = state.oldVx + away.x * kick + state.dirX * kick * 0.22;
      body.vy = state.oldVy + away.y * kick + state.dirY * kick * 0.22;
      const spinSign = state.pieceIndex - (state.pieceCount - 1) * 0.5;
      body.av = Utils.clamp(state.oldAv + spinSign * 0.012, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);
      body.sleeping = false;
      body.sleepFrames = 0;
      body.animationDetached = true;
      body.kinematic = false;
      body.supported = false;
      body.supportMemory = 0;
      body.supportDot = 0;
      body.staticSupportMemory = 0;
      body.staticSupportDot = 0;
      body.dynamicSupportMemory = 0;
      body.dynamicSupportBodyId = null;
      body.fractureCooldown = 24;
      if (body.wakeOnHit) body.wakeOnHitConsumed = true;
      this.clampBodySpeed(body);
      this.applyBodyToPegs(body, true);
    }
    this._pendingFallenCheck = true;
    this.markRuntimeCountersDirty();
    return true;
  }

  wakeDeepFreezeShiftedPegs(pegs = []) {
    if (!this.isEnabled() || !Array.isArray(pegs)) return 0;
    const applied = new Set();
    let count = 0;
    for (const peg of pegs) {
      const motion = peg?._deepFreezeMotion;
      if (!motion) continue;
      const moved = Math.hypot(motion.offsetX || 0, motion.offsetY || 0);
      const speed = Math.hypot(motion.vx || 0, motion.vy || 0);
      if (moved < 0.35 && speed < 0.04) continue;
      const body = this.getBodyForPeg(peg);
      if (!body || body.static || applied.has(body.id)) continue;
      const impulseX = (motion.vx || 0) + (motion.offsetX || 0) * 0.045;
      const impulseY = (motion.vy || 0) + (motion.offsetY || 0) * 0.045;
      if (this.wakeBody(body, impulseX, impulseY, peg, null, null, 'deepFreeze')) {
        this.queueBodyFracture(body, peg.x, peg.y, Math.hypot(impulseX, impulseY), impulseX, impulseY);
        applied.add(body.id);
        count++;
      }
    }
    return count;
  }

  clampBodySpeed(body) {
    if (!body) return;
    const speed = linearBodySpeed(body);
    const maxSpeed = this.settings.maxSpeed;
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      body.vx *= scale;
      body.vy *= scale;
    }
    body.av = Utils.clamp(body.av || 0, -MAX_ANGULAR_SPEED, MAX_ANGULAR_SPEED);
  }

  isActiveDynamic(body) {
    return !!body && !body.static && !body.sleeping;
  }

  wakeDynamicBodies() {
    let count = 0;
    for (const body of this.bodies.values()) {
      if (!body || body.static || body.wakeOnHit) continue;
      if (body.sleeping) count++;
      body.sleeping = false;
      body.sleepFrames = 0;
      body.animationDetached = true;
      body.kinematic = false;
      body.supported = false;
      body.supportMemory = 0;
      body.supportDot = 0;
      body.staticSupportMemory = 0;
      body.staticSupportDot = 0;
      body.dynamicSupportMemory = 0;
      body.dynamicSupportBodyId = null;
      this.applyBodyToPegs(body, true);
    }
    if (count > 0) {
      this._pendingFallenCheck = true;
      this.markRuntimeCountersDirty();
    }
    return count;
  }

  wakeSlopedSleepers() {
    let count = 0;
    for (const body of this.bodies.values()) {
      if (!body?.sleeping || !hasStaticSlopeSlideDemand(body, this.settings)) continue;
      body.sleeping = false;
      body.sleepFrames = 0;
      body.animationDetached = true;
      body.kinematic = false;
      body.supported = false;
      body.supportMemory = 0;
      body.supportDot = 0;
      body.dynamicSupportMemory = 0;
      body.dynamicSupportBodyId = null;
      this.applyBodyToPegs(body, true);
      count++;
    }
    if (count > 0) {
      this._pendingFallenCheck = true;
      this.markRuntimeCountersDirty();
    }
    return count;
  }

  hasUnstableDynamicSupport(body) {
    if (!body?.sleeping || !canSupportMotionWakeBody(body)) return false;
    if ((body.dynamicSupportMemory || 0) <= 0 || !body.dynamicSupportBodyId) return false;
    const supportBody = this.bodies.get(body.dynamicSupportBodyId);
    return !supportBody || this.isActiveDynamic(supportBody);
  }

  wakeSleepersWithUnstableSupports() {
    let count = 0;
    for (const body of this.bodies.values()) {
      if (!this.hasUnstableDynamicSupport(body)) continue;
      body.sleeping = false;
      body.sleepFrames = 0;
      body.animationDetached = true;
      body.kinematic = false;
      body.supported = false;
      body.supportMemory = 0;
      body.supportDot = 0;
      body.dynamicSupportMemory = 0;
      body.dynamicSupportBodyId = null;
      this.applyBodyToPegs(body, true);
      count++;
    }
    if (count > 0) {
      this._pendingFallenCheck = true;
      this.markRuntimeCountersDirty();
    }
    return count;
  }

  markBodySupported(body, normalX, normalY, supportDot, subScale = 1, supportBody = null) {
    if (!body) return;
    body.supported = true;
    body.supportMemory = SUPPORT_MEMORY_FRAMES;
    body.supportDot = Math.max(body.supportDot || 0, supportDot || 0);
    if (supportBody?.static) {
      body.staticSupportMemory = SUPPORT_MEMORY_FRAMES;
      body.staticSupportDot = Math.max(body.staticSupportDot || 0, supportDot || 0);
    } else if (supportBody?.id && supportBody !== body) {
      body.dynamicSupportMemory = SUPPORT_MEMORY_FRAMES;
      body.dynamicSupportBodyId = supportBody.id;
    }

    const grip = surfaceGripValue(this.settings);
    const slide = 1 - grip;
    if (slide <= 0.001 || supportDot > 0.995) return;
    const tangentX = this._gravityNormX - normalX * supportDot;
    const tangentY = this._gravityNormY - normalY * supportDot;
    const tangentMag = Math.hypot(tangentX, tangentY);
    if (tangentMag <= 0.0001) return;
    const gravityMag = Math.hypot(this.settings.gravityX || 0, this.settings.gravityY || 0);
    const accel = gravityMag * slide * 0.74 * subScale;
    body.vx += (tangentX / tangentMag) * accel;
    body.vy += (tangentY / tangentMag) * accel;
  }

  updateGravityNormal() {
    const mag = Math.hypot(this.settings?.gravityX || 0, this.settings?.gravityY || 0);
    if (mag <= 0.0001) {
      this._gravityNormX = 0;
      this._gravityNormY = 1;
    } else {
      this._gravityNormX = this.settings.gravityX / mag;
      this._gravityNormY = this.settings.gravityY / mag;
    }
  }

  updateBucketVelocity(bounds = null) {
    const bucket = bounds?.bucket || null;
    if (!bucket || bounds?.bucketEnabled === false || !Number.isFinite(bucket.x)) {
      this._lastBucketX = null;
      this._stepBucketVx = 0;
      this._bucketBody.vx = 0;
      return 0;
    }
    const vx = Number.isFinite(this._lastBucketX) ? bucket.x - this._lastBucketX : 0;
    this._lastBucketX = bucket.x;
    this._stepBucketVx = vx;
    this._bucketBody.vx = vx;
    return vx;
  }

  getBodyPortalRadius(body) {
    if (!body) return PHYSICS_CONFIG.pegRadius;
    let radius = PHYSICS_CONFIG.pegRadius;
    for (const pegId of body.pegIds) {
      const peg = this._pegById.get(pegId);
      const offset = body.offsets.get(pegId);
      if (!peg || !offset) continue;
      let pegRadius = getPegRadius(peg);
      if (peg.shape === 'brick') {
        const { width, height } = getBrickSize(peg);
        pegRadius = Math.hypot(width, height) * 0.5;
      }
      radius = Math.max(radius, Math.hypot(offset.x || 0, offset.y || 0) + pegRadius);
    }
    return radius;
  }

  getPortalCrossing(body, prevX, prevY, portal) {
    if (!body || !portal || !Number.isFinite(prevX) || !Number.isFinite(prevY)) return null;
    const angle = portal.angle || 0;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const nx = -uy;
    const ny = ux;
    const dx0 = prevX - portal.x;
    const dy0 = prevY - portal.y;
    const dx1 = body.x - portal.x;
    const dy1 = body.y - portal.y;
    const x0 = dx0 * ux + dy0 * uy;
    const y0 = dx0 * nx + dy0 * ny;
    const x1 = dx1 * ux + dy1 * uy;
    const y1 = dx1 * nx + dy1 * ny;
    const radius = this.getBodyPortalRadius(body);
    const halfLen = getPortalHalfLength(portal);
    const xReach = halfLen + radius;
    if (Math.max(x0, x1) < -xReach || Math.min(x0, x1) > xReach) return null;
    if (Math.max(y0, y1) < -radius || Math.min(y0, y1) > radius) return null;
    const crossedCenterLine = (y0 <= 0 && y1 >= 0) || (y0 >= 0 && y1 <= 0);
    const enteredBand = (Math.abs(y0) > radius && Math.abs(y1) <= radius)
      || (Math.abs(y1) > radius && Math.abs(y0) <= radius);
    if (!crossedCenterLine && !enteredBand) return null;
    const dy = y1 - y0;
    let t = 0.5;
    if (Math.abs(dy) > 1e-6 && crossedCenterLine) {
      t = Utils.clamp(-y0 / dy, 0, 1);
    } else if (!crossedCenterLine) {
      t = Math.abs(y0) <= Math.abs(y1) ? 0 : 1;
    }
    const crossX = x0 + (x1 - x0) * t;
    if (Math.abs(crossX) > xReach) return null;
    let side = Math.sign(dy);
    if (side === 0) side = Math.sign(y1) || Math.sign(y0) || 1;
    return {
      localX: Utils.clamp(crossX, -halfLen, halfLen),
      side,
      fromPositive: (y0 > 0) || (Math.abs(y0) <= 1e-6 && y1 < 0)
    };
  }

  findPortalExit(entryPortal, pegs = []) {
    if (!entryPortal || !Array.isArray(pegs)) return null;
    const targetType = entryPortal.type === 'portalBlue' ? 'portalOrange' : 'portalBlue';
    let best = null;
    let bestDistSq = Infinity;
    for (const peg of pegs) {
      if (!peg || peg.id === entryPortal.id || peg.type !== targetType) continue;
      const dx = peg.x - entryPortal.x;
      const dy = peg.y - entryPortal.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = peg;
      }
    }
    return best;
  }

  resolvePortalSideCollision(body, portal, keepPositiveSide) {
    if (!body || !portal) return false;
    const angle = portal.angle || 0;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const nx = -uy;
    const ny = ux;
    const radius = this.getBodyPortalRadius(body);
    const halfLen = getPortalHalfLength(portal);
    const dx = body.x - portal.x;
    const dy = body.y - portal.y;
    const localXRaw = dx * ux + dy * uy;
    const localY = dx * nx + dy * ny;
    const localX = Utils.clamp(localXRaw, -halfLen, halfLen);
    const targetY = radius + 0.6;
    const correctedY = keepPositiveSide
      ? Math.max(localY, targetY)
      : Math.min(localY, -targetY);
    body.x = portal.x + localX * ux + correctedY * nx;
    body.y = portal.y + localX * uy + correctedY * ny;
    const vn = body.vx * nx + body.vy * ny;
    const shouldBounce = keepPositiveSide ? (vn < 0) : (vn > 0);
    if (shouldBounce) {
      body.vx -= (1 + this.settings.restitution) * vn * nx;
      body.vy -= (1 + this.settings.restitution) * vn * ny;
      body.av *= 0.82;
      this.clampBodySpeed(body);
    }
    return true;
  }

  applyPortalTeleport(body, prevX, prevY, pegs = []) {
    if (!this.isActiveDynamic(body) || !Array.isArray(pegs)) return false;
    const portals = pegs.filter(peg => isPortalPeg(peg));
    if (portals.length === 0) return false;
    const canTeleport = (body.portalCooldown || 0) <= 0;

    for (const entry of portals) {
      const crossing = this.getPortalCrossing(body, prevX, prevY, entry);
      if (!crossing) continue;
      const blockedFromPositive = !entry.portalOneWayFlip;
      const blockedSide = !!entry.portalOneWay && (crossing.fromPositive === blockedFromPositive);
      if (blockedSide) {
        if (this.resolvePortalSideCollision(body, entry, blockedFromPositive)) {
          this._portalHitEvents.push({ entry, exit: null, bodyId: body.id });
          return true;
        }
        return false;
      }
      if (!canTeleport) {
        if (entry.portalOneWay) {
          this.resolvePortalSideCollision(body, entry, !blockedFromPositive);
          return true;
        }
        continue;
      }
      const exit = this.findPortalExit(entry, pegs);
      if (!exit) continue;

      const entryAngle = entry.angle || 0;
      const exitAngle = exit.angle || 0;
      const cIn = Math.cos(entryAngle);
      const sIn = Math.sin(entryAngle);
      const cOut = Math.cos(exitAngle);
      const sOut = Math.sin(exitAngle);
      const radius = this.getBodyPortalRadius(body);
      const localX = crossing.localX;
      const exitBlockedFromPositive = !exit.portalOneWayFlip;
      const exitOpenSign = exitBlockedFromPositive ? -1 : 1;
      const localY = exit.portalOneWay
        ? exitOpenSign * (radius + PORTAL_BODY_EXIT_PADDING)
        : crossing.side * (radius + PORTAL_BODY_EXIT_PADDING);
      const vt = body.vx * cIn + body.vy * sIn;
      const vn = body.vx * (-sIn) + body.vy * cIn;
      const outVn = exit.portalOneWay ? exitOpenSign * Math.abs(vn) : vn;

      body.x = exit.x + (localX * cOut - localY * sOut);
      body.y = exit.y + (localX * sOut + localY * cOut);
      body.vx = vt * cOut + outVn * (-sOut);
      body.vy = vt * sOut + outVn * cOut;
      body.angle = wrapAngle((body.angle || 0) + wrapAngle(exitAngle - entryAngle));
      body.portalCooldown = PORTAL_BODY_COOLDOWN_STEPS;
      body._lastPortalTeleport = { entryId: entry.id, exitId: exit.id };
      this.clampBodySpeed(body);
      this._portalHitEvents.push({ entry, exit, bodyId: body.id });
      this._pendingFallenCheck = true;
      return true;
    }

    return false;
  }

  step(pegs = [], groups = [], dtSeconds = BASE_STEP_SECONDS, bounds = null) {
    this._bumperHitEvents.length = 0;
    this._bumperHitKeys.clear();
    this._portalHitEvents.length = 0;
    if (!this.isEnabled() || !Array.isArray(pegs) || pegs.length === 0) {
      return { moved: false, fallenPegs: [], bumperHits: [], portalHits: [] };
    }

    this.syncBodies(pegs, groups);
    this.updateGravityNormal();
    this.updateBucketVelocity(bounds);
    this.drainWakeQueue(MAX_BODIES_WOKEN_PER_STEP);
    this.applyQueuedFractures(pegs, groups);
    this.wakeSlopedSleepers();
    this.wakeSleepersWithUnstableSupports();

    const hasAwake = this.hasAwakeBodies();
    const hasKinematicMotion = this._kinematicMotionCount > 0
      || Math.abs(this._stepBucketVx || 0) > BUCKET_MOVE_EPSILON
      || (Array.isArray(bounds?.flipperRects) && bounds.flipperRects.some(rect => (
        Math.hypot(rect?.vx || 0, rect?.vy || 0) > BUCKET_MOVE_EPSILON
      )));
    if (!hasAwake && !hasKinematicMotion) {
      const fallenPegs = this._pendingFallenCheck ? this.collectFallenPegs(pegs, bounds) : [];
      this._pendingFallenCheck = false;
      this.debugStats.skippedSteps++;
      return { moved: fallenPegs.length > 0, fallenPegs, bumperHits: [], portalHits: [] };
    }

    const timeScale = Number.isFinite(PHYSICS_CONFIG.timeScale) ? PHYSICS_CONFIG.timeScale : 1;
    const safeDt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : BASE_STEP_SECONDS;
    const stepScale = Math.max(0.1, (safeDt / BASE_STEP_SECONDS) * timeScale);
    const linearDamping = Math.pow(this.settings.damping, stepScale);
    const angularDamping = Math.pow(0.985, stepScale);
    let maxMove = 0;

    for (const body of this.bodies.values()) {
      if ((body.fractureCooldown || 0) > 0) {
        body.fractureCooldown = Math.max(0, body.fractureCooldown - 1);
      }
      if ((body.portalCooldown || 0) > 0) {
        body.portalCooldown = Math.max(0, body.portalCooldown - 1);
      }
      if (body.static || body.sleeping) continue;
      body.vx += this.settings.gravityX * stepScale;
      body.vy += this.settings.gravityY * stepScale;
      body.vx *= linearDamping;
      body.vy *= linearDamping;
      body.av *= angularDamping;
      this.clampBodySpeed(body);
      maxMove = Math.max(maxMove, bodyMotionEstimate(body) * stepScale);
      body.supported = false;
      body.supportDot = 0;
      body.supportMemory = Math.max(0, (body.supportMemory || 0) - 1);
      body.staticSupportDot = 0;
      body.staticSupportMemory = Math.max(0, (body.staticSupportMemory || 0) - 1);
      body.dynamicSupportMemory = Math.max(0, (body.dynamicSupportMemory || 0) - 1);
      if (body.dynamicSupportMemory <= 0) body.dynamicSupportBodyId = null;
    }

    const rawSubSteps = Math.max(1, Math.ceil(maxMove / MAX_SUBSTEP_PX));
    const subSteps = Math.min(MAX_DESTRUCTION_SUBSTEPS, rawSubSteps);
    if (rawSubSteps > subSteps) this.debugStats.cappedSubsteps++;
    const subScale = stepScale / subSteps;
    let moved = true;
    this.buildColliders(pegs, bounds);

    for (let step = 0; step < subSteps; step++) {
      for (const body of this.bodies.values()) {
        if (!this.isActiveDynamic(body)) continue;
        const prevX = body.x;
        const prevY = body.y;
        body.x += body.vx * subScale;
        body.y += body.vy * subScale;
        body.angle = wrapAngle((body.angle || 0) + (body.av || 0) * subScale);
        this.applyPortalTeleport(body, prevX, prevY, pegs);
        this.markBodyTransformDirty(body);
      }
      this.flushDirtyBodies();

      for (const body of this.bodies.values()) {
        if (this.applyWallBounds(body, bounds)) this.markBodyTransformDirty(body);
      }
      this.flushDirtyBodies();

      this.refreshActiveDynamicColliders();
      this.resolveCollisions(subScale);
      if (this.applyQueuedFractures(pegs, groups)) {
        this.buildColliders(pegs, bounds);
      }
    }

    for (const body of this.bodies.values()) {
      if (!body || body.static || body.sleeping) continue;
      const hasSupport = body.supported || (body.supportMemory || 0) > 0;
      if (hasSupport && isBodySlowEnoughForSleep(body, this.settings, true)) {
        body.sleepFrames++;
        if (body.sleepFrames >= this.settings.sleepFrames) {
          body.vx = 0;
          body.vy = 0;
          body.av = 0;
          body.sleeping = true;
          body.sleepFrames = 0;
          if ((body.staticSupportMemory || 0) > 0) {
            body.dynamicSupportMemory = 0;
            body.dynamicSupportBodyId = null;
          }
          this.applyBodyToPegs(body, true);
          this.markRuntimeCountersDirty();
        }
      } else {
        body.sleepFrames = 0;
      }
    }

    const fallenPegs = this.collectFallenPegs(pegs, bounds);
    this._pendingFallenCheck = false;
    if (fallenPegs.length > 0) moved = true;
    return {
      moved,
      fallenPegs,
      bumperHits: this._bumperHitEvents.slice(),
      portalHits: this._portalHitEvents.slice()
    };
  }

  applyWallBounds(body, bounds = null) {
    if (!this.isActiveDynamic(body)) return false;
    const width = Number.isFinite(bounds?.width) ? bounds.width : null;
    const topY = Number.isFinite(bounds?.topY) ? bounds.topY : 0;
    if (!Number.isFinite(width)) return false;

    const aabb = this.getBodyAabb(body);
    if (!aabb) return false;
    let dx = 0;
    let dy = 0;
    if (aabb.minX < 0) dx = -aabb.minX;
    else if (aabb.maxX > width) dx = width - aabb.maxX;
    if (aabb.minY < topY) dy = topY - aabb.minY;

    if (dx !== 0) {
      body.x += dx;
      body.vx = dx > 0 ? Math.abs(body.vx) * this.settings.restitution : -Math.abs(body.vx) * this.settings.restitution;
      body.av *= 0.72;
    }
    if (dy !== 0) {
      body.y += dy;
      body.vy = Math.abs(body.vy) * this.settings.restitution;
      body.av *= 0.72;
    }
    return dx !== 0 || dy !== 0;
  }

  getBodyAabb(body) {
    if (!body) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pegId of body.pegIds) {
      const peg = this._pegById.get(pegId);
      const aabb = getCachedPegAabb(peg);
      if (!aabb) continue;
      if (aabb.minX < minX) minX = aabb.minX;
      if (aabb.maxX > maxX) maxX = aabb.maxX;
      if (aabb.minY < minY) minY = aabb.minY;
      if (aabb.maxY > maxY) maxY = aabb.maxY;
    }
    if (!Number.isFinite(minX)) return null;
    body.aabb.minX = minX;
    body.aabb.maxX = maxX;
    body.aabb.minY = minY;
    body.aabb.maxY = maxY;
    return body.aabb;
  }

  acquireCollider() {
    let collider = this._colliders[this._colliderCount];
    if (!collider) {
      collider = createColliderRecord();
      this._colliders[this._colliderCount] = collider;
    }
    this._colliderCount++;
    return collider;
  }

  releaseLastCollider(collider) {
    if (this._colliderCount > 0) this._colliderCount--;
    clearColliderRecord(collider);
  }

  buildColliders(pegs, bounds = null) {
    const previousCount = this._colliderCount;
    this._colliderCount = 0;
    this.debugStats.colliderBuilds++;
    for (const body of this.bodies.values()) {
      if (body?._colliderIndices) body._colliderIndices.length = 0;
    }
    for (const peg of pegs) {
      if (!peg || isPortalPeg(peg)) continue;
      const body = this.getBodyForPeg(peg);
      if (!body) continue;
      if (hasCurveSlices(peg)) {
        for (let segmentIndex = 0; segmentIndex < peg.curveSlices.length - 1; segmentIndex++) {
          const collider = this.acquireCollider();
          if (fillColliderFromCurveSegment(collider, peg, body, segmentIndex)) {
            body._colliderIndices.push(this._colliderCount - 1);
          } else {
            this.releaseLastCollider(collider);
          }
        }
      } else {
        const collider = this.acquireCollider();
        if (fillColliderFromPeg(collider, peg, body)) {
          body._colliderIndices.push(this._colliderCount - 1);
        } else {
          this.releaseLastCollider(collider);
        }
      }
    }

    const bucket = bounds?.bucket || null;
    if (bucket && bounds?.bucketEnabled !== false) {
      const left = this.acquireCollider();
      fillBucketEdgeCollider(left, bucket, this._bucketBody, this._bucketEdgePegs[0], this._stepBucketVx, -1);
      const right = this.acquireCollider();
      fillBucketEdgeCollider(right, bucket, this._bucketBody, this._bucketEdgePegs[1], this._stepBucketVx, 1);
    }

    const flipperRects = Array.isArray(bounds?.flipperRects) ? bounds.flipperRects : [];
    for (let i = 0; i < flipperRects.length && i < this._flipperPegs.length; i++) {
      const rect = flipperRects[i];
      if (!rect) continue;
      const collider = this.acquireCollider();
      fillKinematicRectCollider(
        collider,
        rect,
        this._flipperBodies[i],
        this._flipperPegs[i],
        'flipper'
      );
    }

    for (let i = this._colliderCount; i < previousCount; i++) {
      clearColliderRecord(this._colliders[i]);
    }
    return this._colliders;
  }

  refreshColliderForBody(body) {
    if (!body?._colliderIndices || body._colliderIndices.length === 0) return;
    for (const idx of body._colliderIndices) {
      const collider = this._colliders[idx];
      if (!collider || collider._bodyRef !== body || collider.kind !== 'peg') continue;
      const refreshed = collider.curveSegmentIndex >= 0
        ? fillColliderFromCurveSegment(collider, collider.peg, body, collider.curveSegmentIndex)
        : fillColliderFromPeg(collider, collider.peg, body);
      if (!refreshed) {
        collider.peg = null;
        collider.aabb.minX = Infinity;
        collider.aabb.maxX = -Infinity;
        collider.aabb.minY = Infinity;
        collider.aabb.maxY = -Infinity;
      }
    }
  }

  refreshActiveDynamicColliders() {
    for (const body of this.bodies.values()) {
      if (this.isActiveDynamic(body)) this.refreshColliderForBody(body);
    }
  }

  releaseGridBuckets() {
    if (this._grid.size === 0) return;
    for (const bucket of this._grid.values()) {
      bucket.length = 0;
      this._gridBucketPool.push(bucket);
    }
    this._grid.clear();
  }

  acquireGridBucket() {
    const bucket = this._gridBucketPool.pop();
    if (bucket) return bucket;
    return [];
  }

  buildGrid(colliders, count) {
    this.releaseGridBuckets();
    for (let i = 0; i < count; i++) {
      const { aabb } = colliders[i];
      const minX = Math.floor(aabb.minX / GRID_CELL_SIZE);
      const maxX = Math.floor(aabb.maxX / GRID_CELL_SIZE);
      const minY = Math.floor(aabb.minY / GRID_CELL_SIZE);
      const maxY = Math.floor(aabb.maxY / GRID_CELL_SIZE);
      for (let gx = minX; gx <= maxX; gx++) {
        for (let gy = minY; gy <= maxY; gy++) {
          const key = gridKey(gx, gy);
          let bucket = this._grid.get(key);
          if (!bucket) {
            bucket = this.acquireGridBucket();
            this._grid.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
  }

  resolveCollisions(subScale) {
    const colliders = this._colliders;
    const colliderCount = this._colliderCount;
    if (colliderCount < 2) return;
    this.buildGrid(colliders, colliderCount);
    this._pairKeys.clear();
    const collisionAngularDamping = Math.pow(0.92, subScale);

    for (const bucket of this._grid.values()) {
      for (let aIndex = 0; aIndex < bucket.length; aIndex++) {
        const i = bucket[aIndex];
        const a = colliders[i];
        if (!a) continue;
        for (let bIndex = aIndex + 1; bIndex < bucket.length; bIndex++) {
          const j = bucket[bIndex];
          const b = colliders[j];
          if (!b) continue;
          if (a.body.id === b.body.id) continue;
          const pairKey = i < j ? i * colliderCount + j : j * colliderCount + i;
          if (this._pairKeys.has(pairKey)) continue;
          this._pairKeys.add(pairKey);

          const aActive = this.isActiveDynamic(a.body);
          const bActive = this.isActiveDynamic(b.body);
          const aKinematic = this.isKinematicCollider(a);
          const bKinematic = this.isKinematicCollider(b);
          if (!aActive && !bActive && !aKinematic && !bKinematic) continue;
          if (!this.aabbOverlap(a.aabb, b.aabb)) continue;

          const overlap = colliderOverlap(a, b, this._overlap, this._projectionA, this._projectionB);
          if (!overlap || overlap.depth <= 0) continue;
          this.resolveBodyCollision(a, b, overlap, collisionAngularDamping, subScale);
        }
      }
    }
  }

  aabbOverlap(a, b) {
    return !!a && !!b && a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
  }

  isKinematicCollider(collider) {
    if (!collider) return false;
    if (collider.body?.kinematic) {
      return Math.hypot(collider.body?.vx || 0, collider.body?.vy || 0) > BUCKET_MOVE_EPSILON;
    }
    if (collider.kind !== 'bucket' && collider.kind !== 'flipper') return false;
    return Math.hypot(collider.body?.vx || 0, collider.body?.vy || 0) > BUCKET_MOVE_EPSILON;
  }

  getColliderBumperPeg(collider) {
    return collider?.kind === 'peg' && collider.peg?.type === 'bumper' ? collider.peg : null;
  }

  getCollisionRestitution(a, b) {
    let restitution = this.settings.restitution;
    const bumper = this.getColliderBumperPeg(a) || this.getColliderBumperPeg(b);
    if (bumper && Number.isFinite(bumper.bumperBounce)) {
      restitution = Math.max(restitution, Utils.clamp(bumper.bumperBounce, 0, 3));
    }
    return restitution;
  }

  queueBumperHitEvent(bumperCollider, sourceCollider, strength, nx, ny) {
    const bumper = this.getColliderBumperPeg(bumperCollider);
    const sourceBody = sourceCollider?.body || null;
    if (!bumper?.id || !sourceBody?.id) return false;
    const key = `${bumper.id}:${sourceBody.id}`;
    if (this._bumperHitKeys.has(key)) return false;
    this._bumperHitKeys.add(key);
    this._bumperHitEvents.push({
      peg: bumper,
      sourcePeg: sourceCollider.peg || null,
      bodyId: sourceBody.id,
      impact: {
        vx: sourceBody.vx || 0,
        vy: sourceBody.vy || 0,
        speed: Math.max(0, strength || 0),
        normalX: nx,
        normalY: ny
      }
    });
    return true;
  }

  maybeQueueBumperHit(a, b, activeA, activeB, strength, nx, ny) {
    const bumperA = this.getColliderBumperPeg(a);
    const bumperB = this.getColliderBumperPeg(b);
    if (bumperA && (activeA || activeB)) {
      this.queueBumperHitEvent(a, activeB ? b : a, strength, nx, ny);
    }
    if (bumperB && (activeA || activeB)) {
      this.queueBumperHitEvent(b, activeA ? a : b, strength, -nx, -ny);
    }
  }

  wakeSleepingBodyFromKinematic(body, collider, contactPeg) {
    if (!body || body.static || !body.sleeping || !this.isKinematicCollider(collider)) return false;
    if (!this.canWakeBody(body, 'collision')) return false;
    const sourceScale = collider.kind === 'flipper' ? 0.82 : 0.55;
    const impulseX = (collider.body.vx || 0) * Math.max(1, body.mass) * sourceScale;
    const impulseY = (collider.body.vy || 0) * Math.max(1, body.mass) * sourceScale;
    return this.wakeBody(body, impulseX, impulseY, contactPeg, null, null, 'collision');
  }

  resolveBodyCollision(a, b, overlap, collisionAngularDamping = 1, subScale = 1) {
    const bodyA = a.body;
    const bodyB = b.body;
    let activeA = this.isActiveDynamic(bodyA);
    let activeB = this.isActiveDynamic(bodyB);
    if (!activeA && this.wakeSleepingBodyFromKinematic(bodyA, b, a.peg)) activeA = true;
    if (!activeB && this.wakeSleepingBodyFromKinematic(bodyB, a, b.peg)) activeB = true;
    const invA = activeA ? bodyA.invMass : 0;
    const invB = activeB ? bodyB.invMass : 0;
    const invTotal = invA + invB;
    if (invTotal <= 0) return;

    const nx = overlap.nx;
    const ny = overlap.ny;
    const depth = Math.min(overlap.depth + 0.12, 18);

    if (activeA) {
      bodyA.x -= nx * depth * (invA / invTotal);
      bodyA.y -= ny * depth * (invA / invTotal);
      this.markBodyTransformDirty(bodyA);
      this.applyBodyToPegs(bodyA);
      this.refreshColliderForBody(bodyA);
    }
    if (activeB) {
      bodyB.x += nx * depth * (invB / invTotal);
      bodyB.y += ny * depth * (invB / invTotal);
      this.markBodyTransformDirty(bodyB);
      this.applyBodyToPegs(bodyB);
      this.refreshColliderForBody(bodyB);
    }

    const rvx = (bodyB.vx || 0) - (bodyA.vx || 0);
    const rvy = (bodyB.vy || 0) - (bodyA.vy || 0);
    const relN = rvx * nx + rvy * ny;

    if (relN < 0) {
      const impulse = -(1 + this.getCollisionRestitution(a, b)) * relN / invTotal;
      if (activeA) {
        bodyA.vx -= impulse * invA * nx;
        bodyA.vy -= impulse * invA * ny;
      }
      if (activeB) {
        bodyB.vx += impulse * invB * nx;
        bodyB.vy += impulse * invB * ny;
      }
    }

    const tx = -ny;
    const ty = nx;
    const relT = rvx * tx + rvy * ty;
    const frictionImpulse = -relT * this.settings.friction / Math.max(1, invTotal);
    if (activeA) {
      bodyA.vx -= frictionImpulse * invA * tx;
      bodyA.vy -= frictionImpulse * invA * ty;
      bodyA.av *= collisionAngularDamping;
    }
    if (activeB) {
      bodyB.vx += frictionImpulse * invB * tx;
      bodyB.vy += frictionImpulse * invB * ty;
      bodyB.av *= collisionAngularDamping;
    }

    const supportDot = nx * this._gravityNormX + ny * this._gravityNormY;
    if (activeA && supportDot > 0.45) {
      this.markBodySupported(bodyA, nx, ny, supportDot, subScale, bodyB);
    }
    if (activeB && supportDot < -0.45) {
      this.markBodySupported(bodyB, -nx, -ny, -supportDot, subScale, bodyA);
    }

    this.maybeWakeSleepingCollisionBody(bodyA, bodyB, relN);
    this.maybeWakeSleepingCollisionBody(bodyB, bodyA, -relN);
    if (activeA) this.clampBodySpeed(bodyA);
    if (activeB) this.clampBodySpeed(bodyB);
    const collisionStrength = Math.abs(relN) + depth * 0.22;
    this.maybeQueueBumperHit(a, b, activeA, activeB, collisionStrength, nx, ny);
    if (collisionStrength >= GROUP_FRACTURE_IMPULSE) {
      const contactX = ((a.x || bodyA.x || 0) + (b.x || bodyB.x || 0)) * 0.5;
      const contactY = ((a.y || bodyA.y || 0) + (b.y || bodyB.y || 0)) * 0.5;
      this.queueBodyFracture(bodyA, contactX, contactY, collisionStrength, -nx, -ny);
      this.queueBodyFracture(bodyB, contactX, contactY, collisionStrength, nx, ny);
    }
  }

  maybeWakeSleepingCollisionBody(body, otherBody, relN) {
    if (!body || body.static || !body.sleeping) return false;
    if (!this.canWakeBody(body, 'collision')) return false;
    if (!otherBody || otherBody.static) return false;
    const otherSpeed = bodyMotionEstimate(otherBody);
    if (otherSpeed < WAKE_IMPULSE_MIN || Math.abs(relN) < WAKE_IMPULSE_MIN) return false;
    body.sleeping = false;
    body.sleepFrames = 0;
    body.animationDetached = true;
    body.kinematic = false;
    body.supported = false;
    body.supportMemory = 0;
    body.staticSupportMemory = 0;
    body.staticSupportDot = 0;
    body.dynamicSupportMemory = 0;
    body.dynamicSupportBodyId = null;
    if (body.wakeOnHit) body.wakeOnHitConsumed = true;
    body.vx += (otherBody.vx || 0) * 0.12;
    body.vy += (otherBody.vy || 0) * 0.12;
    body.av += (otherBody.av || 0) * 0.12;
    this.clampBodySpeed(body);
    this._pendingFallenCheck = true;
    this.markRuntimeCountersDirty();
    return true;
  }

  collectFallenPegs(pegs, bounds = null) {
    const lossY = Number.isFinite(bounds?.lossY) ? bounds.lossY : ((Number.isFinite(bounds?.height) ? bounds.height : 600) + FALL_MARGIN);
    const fallen = [];
    for (const peg of pegs) {
      if (!peg || peg._destructionFalling || isPortalPeg(peg)) continue;
      const body = this.getBodyForPeg(peg);
      if (!body || body.static) continue;
      const aabb = getCachedPegAabb(peg);
      if (!aabb || aabb.minY <= lossY) continue;
      peg._destructionFalling = true;
      fallen.push({ peg, bodyId: body.id });
    }
    return fallen;
  }
}
