import { Utils } from './utils.js';

const MIN_SPEED_CURVE_Y = 0.05;
const MAX_SPEED_CURVE_Y = 3;
const SPEED_CURVE_SAMPLES = 64;
const MIN_KNOCKBACK_DISTANCE = 0;
const MAX_KNOCKBACK_DISTANCE = 900;
const MIN_KNOCKBACK_SMOOTH_MS = 60;
const MAX_KNOCKBACK_SMOOTH_MS = 800;

export const SURVIVAL_GAMBLE_BALL_COUNT_DEFAULT = 2;
export const SURVIVAL_GAMBLE_BALL_COUNT_MIN = 0;
export const SURVIVAL_GAMBLE_BALL_COUNT_MAX = 20;
export const SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_DEFAULT = 160;
export const SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MIN = MIN_KNOCKBACK_DISTANCE;
export const SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX = MAX_KNOCKBACK_DISTANCE;
export const SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS = 180;
export const SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MIN_MS = MIN_KNOCKBACK_SMOOTH_MS;
export const SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MAX_MS = MAX_KNOCKBACK_SMOOTH_MS;

export const SURVIVAL_SPEED_CURVE_PRESETS = Object.freeze({
  linear: Object.freeze({
    preset: 'linear',
    x1: 0.25,
    y0: 1,
    y1: 1,
    x2: 0.75,
    y2: 1,
    y3: 1
  }),
  escalate: Object.freeze({
    preset: 'escalate',
    x1: 0.28,
    y0: 0.45,
    y1: 0.6,
    x2: 0.78,
    y2: 1.55,
    y3: 2.08
  }),
  softStart: Object.freeze({
    preset: 'softStart',
    x1: 0.18,
    y0: 0.22,
    y1: 0.18,
    x2: 0.64,
    y2: 1.62,
    y3: 1.62
  })
});

const SURVIVAL_SPEED_CURVE_PRESET_IDS = new Set(Object.keys(SURVIVAL_SPEED_CURVE_PRESETS));

function cubicBezier(a, b, c, d, t) {
  const inv = 1 - t;
  return (inv * inv * inv * a)
    + (3 * inv * inv * t * b)
    + (3 * inv * t * t * c)
    + (t * t * t * d);
}

function sampleSpeedCurveYAtProgress(curve, progress) {
  const targetX = Utils.clamp(progress, 0, 1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5;
    const x = cubicBezier(0, curve.x1, curve.x2, 1, mid);
    if (x < targetX) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) * 0.5;
  return cubicBezier(curve.y0, curve.y1, curve.y2, curve.y3, t);
}

function estimateSpeedCurveNormalization(curve) {
  let inverseArea = 0;
  let lastX = 0;
  let lastY = curve.y0;
  for (let i = 1; i <= SPEED_CURVE_SAMPLES; i++) {
    const t = i / SPEED_CURVE_SAMPLES;
    const x = cubicBezier(0, curve.x1, curve.x2, 1, t);
    const y = cubicBezier(curve.y0, curve.y1, curve.y2, curve.y3, t);
    const dx = Math.max(0, x - lastX);
    const midY = Math.max(MIN_SPEED_CURVE_Y, (lastY + y) * 0.5);
    inverseArea += dx / midY;
    lastX = x;
    lastY = y;
  }
  return Utils.clamp(inverseArea, 1 / MAX_SPEED_CURVE_Y, 1 / MIN_SPEED_CURVE_Y);
}

export function normalizeSurvivalSpeedCurve(rawCurve = null) {
  const raw = rawCurve && typeof rawCurve === 'object' && !Array.isArray(rawCurve)
    ? rawCurve
    : {};
  const requestedPreset = typeof raw.preset === 'string' ? raw.preset : 'linear';
  const preset = SURVIVAL_SPEED_CURVE_PRESET_IDS.has(requestedPreset)
    ? requestedPreset
    : (requestedPreset === 'custom' ? 'custom' : 'linear');
  const fallback = SURVIVAL_SPEED_CURVE_PRESET_IDS.has(preset)
    ? SURVIVAL_SPEED_CURVE_PRESETS[preset]
    : SURVIVAL_SPEED_CURVE_PRESETS.linear;
  const x1 = Utils.clamp(toFiniteNumber(raw.x1, fallback.x1), 0, 1);
  const x2 = Utils.clamp(toFiniteNumber(raw.x2, fallback.x2), x1, 1);
  const curve = {
    preset,
    x1,
    y0: Utils.clamp(toFiniteNumber(raw.y0, fallback.y0), MIN_SPEED_CURVE_Y, MAX_SPEED_CURVE_Y),
    y1: Utils.clamp(toFiniteNumber(raw.y1, fallback.y1), MIN_SPEED_CURVE_Y, MAX_SPEED_CURVE_Y),
    x2,
    y2: Utils.clamp(toFiniteNumber(raw.y2, fallback.y2), MIN_SPEED_CURVE_Y, MAX_SPEED_CURVE_Y),
    y3: Utils.clamp(toFiniteNumber(raw.y3, fallback.y3), MIN_SPEED_CURVE_Y, MAX_SPEED_CURVE_Y)
  };
  curve.normalization = estimateSpeedCurveNormalization(curve);
  return curve;
}

export function getSurvivalSpeedCurvePreset(preset = 'linear') {
  return normalizeSurvivalSpeedCurve(SURVIVAL_SPEED_CURVE_PRESETS[preset] || SURVIVAL_SPEED_CURVE_PRESETS.linear);
}

export function evaluateSurvivalSpeedCurve(rawCurve, progressRatio = 0) {
  const looksNormalized = rawCurve
    && typeof rawCurve === 'object'
    && Number.isFinite(rawCurve.x1)
    && Number.isFinite(rawCurve.x2)
    && Number.isFinite(rawCurve.y0)
    && Number.isFinite(rawCurve.y1)
    && Number.isFinite(rawCurve.y2)
    && Number.isFinite(rawCurve.y3);
  const curve = looksNormalized
    ? rawCurve
    : getSurvivalSpeedCurvePreset('linear');
  const rawSpeed = sampleSpeedCurveYAtProgress(curve, progressRatio);
  const normalization = Number.isFinite(curve.normalization) && curve.normalization > 0
    ? curve.normalization
    : estimateSpeedCurveNormalization(normalizeSurvivalSpeedCurve(curve));
  return Utils.clamp(rawSpeed * normalization, 0.05, 4);
}

export function normalizeSurvivalGamblePegSettings(rawSettings = null) {
  const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const rawGamble = raw.gamblePeg && typeof raw.gamblePeg === 'object' && !Array.isArray(raw.gamblePeg)
    ? raw.gamblePeg
    : raw;
  const knockbackDistance = Utils.clamp(
    Math.round(toFiniteNumber(
      rawGamble.knockbackDistance
        ?? rawGamble.knockbackStrength
        ?? raw.gambleKnockbackDistance
        ?? raw.gambleKnockbackStrength,
      SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_DEFAULT
    )),
    MIN_KNOCKBACK_DISTANCE,
    MAX_KNOCKBACK_DISTANCE
  );
  const knockbackSmoothMs = Utils.clamp(
    Math.round(toFiniteNumber(
      rawGamble.knockbackSmoothMs
        ?? rawGamble.knockbackSmooth
        ?? raw.gambleKnockbackSmoothMs
        ?? raw.gambleKnockbackSmooth,
      SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS
    )),
    MIN_KNOCKBACK_SMOOTH_MS,
    MAX_KNOCKBACK_SMOOTH_MS
  );
  return {
    knockbackEnabled: !!(rawGamble.knockbackEnabled ?? raw.gambleKnockbackEnabled),
    knockbackDistance,
    knockbackSmoothMs,
    // Legacy alias: kept so old baked/editor data does not lose meaning during one normalization pass.
    knockbackStrength: knockbackDistance
  };
}

export function normalizeSurvivalGamblePegProperties(rawPeg = null, fallbackSettings = null) {
  const raw = rawPeg && typeof rawPeg === 'object' && !Array.isArray(rawPeg) ? rawPeg : {};
  const fallback = fallbackSettings && typeof fallbackSettings === 'object' && !Array.isArray(fallbackSettings)
    ? fallbackSettings
    : {};
  const ballCount = Utils.clamp(
    Math.round(toFiniteNumber(
      raw.gambleBallCount ?? raw.gambleBalls ?? raw.gambleBallsAward,
      SURVIVAL_GAMBLE_BALL_COUNT_DEFAULT
    )),
    SURVIVAL_GAMBLE_BALL_COUNT_MIN,
    SURVIVAL_GAMBLE_BALL_COUNT_MAX
  );
  const fallbackDistance = fallback.knockbackDistance
    ?? fallback.knockbackStrength
    ?? SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_DEFAULT;
  const fallbackSmoothMs = fallback.knockbackSmoothMs
    ?? fallback.knockbackSmooth
    ?? SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS;
  const knockbackDistance = Utils.clamp(
    Math.round(toFiniteNumber(
      raw.gambleKnockbackDistance
        ?? raw.gambleKnockbackStrength
        ?? raw.knockbackDistance
        ?? raw.knockbackStrength,
      fallbackDistance
    )),
    MIN_KNOCKBACK_DISTANCE,
    MAX_KNOCKBACK_DISTANCE
  );
  const knockbackSmoothMs = Utils.clamp(
    Math.round(toFiniteNumber(
      raw.gambleKnockbackSmoothMs
        ?? raw.gambleKnockbackSmooth
        ?? raw.knockbackSmoothMs
        ?? raw.knockbackSmooth,
      fallbackSmoothMs
    )),
    MIN_KNOCKBACK_SMOOTH_MS,
    MAX_KNOCKBACK_SMOOTH_MS
  );
  return {
    gambleBallCount: ballCount,
    gambleKnockbackEnabled: !!(
      raw.gambleKnockbackEnabled
        ?? raw.knockbackEnabled
        ?? fallback.knockbackEnabled
        ?? false
    ),
    gambleKnockbackDistance: knockbackDistance,
    gambleKnockbackSmoothMs: knockbackSmoothMs
  };
}

export const SURVIVAL_DEFAULTS = Object.freeze({
  enabled: false,
  worldHeight: 1800,
  scrollSpeed: 20,
  loseLineY: 90,
  antiCooldownMs: 0,
  speedCurve: Object.freeze({ ...SURVIVAL_SPEED_CURVE_PRESETS.linear, normalization: 1 }),
  gamblePeg: Object.freeze({
    knockbackEnabled: false,
    knockbackDistance: SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_DEFAULT,
    knockbackSmoothMs: SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS,
    knockbackStrength: SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_DEFAULT
  }),
  background: Object.freeze({
    type: 'none',
    image: null,
    fit: 'cover',
    darken: 0.5,
    liquid: null
  })
});

const MIN_VIEWPORT_HEIGHT = 120;
const MIN_WORLD_HEIGHT = 200;
const MAX_WORLD_HEIGHT = 24000;
const MIN_SCROLL_SPEED = 2;
const MAX_SCROLL_SPEED = 400;
const MAX_ANTI_COOLDOWN_MS = 10000;
const LOSE_LINE_MARGIN = 8;
const SURVIVAL_BACKGROUND_TYPES = new Set(['none', 'image', 'liquid']);
const SURVIVAL_BACKGROUND_FITS = new Set(['cover', 'contain', 'stretch']);

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAntiCooldownMs(raw) {
  const secondsValue = toFiniteNumber(raw.antiCooldownSeconds, NaN);
  const fallback = Number.isFinite(secondsValue)
    ? secondsValue * 1000
    : SURVIVAL_DEFAULTS.antiCooldownMs;
  return Utils.clamp(
    Math.round(toFiniteNumber(raw.antiCooldownMs, fallback)),
    0,
    MAX_ANTI_COOLDOWN_MS
  );
}

export function normalizeSurvivalBackground(rawSettings = null) {
  const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const rawBackground = raw.background && typeof raw.background === 'object' && !Array.isArray(raw.background)
    ? raw.background
    : {};
  const legacyImage = typeof raw.backgroundImage === 'string' ? raw.backgroundImage : null;
  const image = typeof rawBackground.image === 'string'
    ? rawBackground.image
    : legacyImage;
  const requestedType = typeof rawBackground.type === 'string'
    ? rawBackground.type
    : (image ? 'image' : SURVIVAL_DEFAULTS.background.type);
  const type = SURVIVAL_BACKGROUND_TYPES.has(requestedType)
    ? requestedType
    : (image ? 'image' : SURVIVAL_DEFAULTS.background.type);
  const fit = SURVIVAL_BACKGROUND_FITS.has(rawBackground.fit)
    ? rawBackground.fit
    : SURVIVAL_DEFAULTS.background.fit;
  const darken = Utils.clamp(
    toFiniteNumber(rawBackground.darken, SURVIVAL_DEFAULTS.background.darken),
    0,
    1
  );
  const liquid = rawBackground.liquid && typeof rawBackground.liquid === 'object' && !Array.isArray(rawBackground.liquid)
    ? { ...rawBackground.liquid }
    : null;

  if (type === 'image' && image) {
    return { type, image, fit, darken, liquid };
  }
  if (type === 'liquid') {
    return { type, image: image || null, fit, darken, liquid };
  }
  return {
    type: 'none',
    image: null,
    fit,
    darken,
    liquid
  };
}

export function normalizeSurvivalSettings(rawSettings = null, viewportHeight = 600) {
  const safeViewport = Math.max(MIN_VIEWPORT_HEIGHT, Math.round(toFiniteNumber(viewportHeight, 600)));
  const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};

  const worldFloor = Math.max(safeViewport, MIN_WORLD_HEIGHT);
  const defaultWorldHeight = Math.max(Math.round(safeViewport * 3), SURVIVAL_DEFAULTS.worldHeight);
  const worldHeight = Utils.clamp(
    Math.round(toFiniteNumber(raw.worldHeight, defaultWorldHeight)),
    worldFloor,
    MAX_WORLD_HEIGHT
  );

  const scrollSpeed = Utils.clamp(
    toFiniteNumber(raw.scrollSpeed, SURVIVAL_DEFAULTS.scrollSpeed),
    MIN_SCROLL_SPEED,
    MAX_SCROLL_SPEED
  );

  const maxLoseLine = Math.max(LOSE_LINE_MARGIN, safeViewport - LOSE_LINE_MARGIN);
  const defaultLoseLine = Utils.clamp(SURVIVAL_DEFAULTS.loseLineY, LOSE_LINE_MARGIN, maxLoseLine);
  const loseLineY = Utils.clamp(
    Math.round(toFiniteNumber(raw.loseLineY, defaultLoseLine)),
    LOSE_LINE_MARGIN,
    maxLoseLine
  );

  return {
    enabled: !!raw.enabled,
    worldHeight,
    scrollSpeed,
    loseLineY,
    antiCooldownMs: normalizeAntiCooldownMs(raw),
    speedCurve: normalizeSurvivalSpeedCurve(raw.speedCurve),
    gamblePeg: normalizeSurvivalGamblePegSettings(raw),
    background: normalizeSurvivalBackground(raw)
  };
}

export function ensureLevelSurvival(level, viewportHeight = 600) {
  if (!level || typeof level !== 'object') return normalizeSurvivalSettings(null, viewportHeight);
  level.survival = normalizeSurvivalSettings(level.survival, viewportHeight);
  return level.survival;
}

export function getMaxCameraY(worldHeight, viewportHeight) {
  return Math.max(0, Math.round(toFiniteNumber(worldHeight, 0) - toFiniteNumber(viewportHeight, 0)));
}

export function clampCameraY(cameraY, worldHeight, viewportHeight) {
  return Utils.clamp(
    toFiniteNumber(cameraY, 0),
    0,
    getMaxCameraY(worldHeight, viewportHeight)
  );
}

export function worldToScreenY(worldY, cameraY) {
  return toFiniteNumber(worldY, 0) - toFiniteNumber(cameraY, 0);
}

export function screenToWorldY(screenY, cameraY) {
  return toFiniteNumber(screenY, 0) + toFiniteNumber(cameraY, 0);
}

export function getProgressRatio(cameraY, maxCameraY) {
  if (!Number.isFinite(maxCameraY) || maxCameraY <= 0) return 1;
  return Utils.clamp(cameraY / maxCameraY, 0, 1);
}

export function getRemainingFieldRatio(cameraY, maxCameraY) {
  return 1 - getProgressRatio(cameraY, maxCameraY);
}

export function getPegVerticalExtent(peg, pegRadius = 10) {
  const r = Math.max(1, toFiniteNumber(pegRadius, 10));
  if (!peg) return r;

  if (peg.shape === 'brick') {
    const height = toFiniteNumber(peg.height, r * 1.2);
    return Math.max(r * 0.6, height / 2);
  }

  if (peg.type === 'bumper') {
    return r * Math.max(0.2, toFiniteNumber(peg.bumperScale, 1));
  }

  if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
    return Math.max(2, r * 0.3);
  }

  return r;
}

export function isPegBeyondLoseLine(peg, cameraY, loseLineY, pegRadius = 10) {
  if (!peg) return false;
  const topY = worldToScreenY(peg.y, cameraY) - getPegVerticalExtent(peg, pegRadius);
  return topY <= toFiniteNumber(loseLineY, SURVIVAL_DEFAULTS.loseLineY);
}

export function isPegRemovableInSurvival(peg) {
  if (!peg) return false;
  if (peg.type === 'obstacle') return false;
  if (peg.type === 'portalBlue' || peg.type === 'portalOrange') return false;
  if (peg.type === 'bumper' && !peg.bumperDisappear && !peg.bumperOrange) return false;
  return true;
}

export function countSurvivalTargets(pegs, excludedIds = null) {
  if (!Array.isArray(pegs) || pegs.length === 0) return 0;
  const excluded = excludedIds instanceof Set ? excludedIds : null;

  let count = 0;
  for (const peg of pegs) {
    if (!isPegRemovableInSurvival(peg)) continue;
    if (excluded && excluded.has(peg.id)) continue;
    count++;
  }
  return count;
}
