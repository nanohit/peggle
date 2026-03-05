import { Utils } from './utils.js';

export const SURVIVAL_DEFAULTS = Object.freeze({
  enabled: false,
  worldHeight: 1800,
  scrollSpeed: 20,
  loseLineY: 90
});

const MIN_VIEWPORT_HEIGHT = 120;
const MIN_WORLD_HEIGHT = 200;
const MAX_WORLD_HEIGHT = 24000;
const MIN_SCROLL_SPEED = 2;
const MAX_SCROLL_SPEED = 400;
const LOSE_LINE_MARGIN = 8;

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    loseLineY
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
