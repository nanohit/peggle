import { normalizeLevelCharacterAssignment } from './character-config.js';

export const PVP_DEFAULT_AIM_LENGTH = 27;
export const PVP_DEFAULT_HITS_TO_WIN = 3;
export const PVP_MIN_HITS_TO_WIN = 2;
export const PVP_MAX_HITS_TO_WIN = 6;

export const PVP_DEFAULTS = Object.freeze({
  enabled: false,
  symmetryEnabled: true,
  aimTimerMs: 5000,
  aimLength: PVP_DEFAULT_AIM_LENGTH,
  hitsToWin: PVP_DEFAULT_HITS_TO_WIN,
  cpuEnabled: true,
  cpuDifficulty: 'normal'
});

const CPU_DIFFICULTIES = new Set(['easy', 'normal', 'hard']);

export function normalizePvpSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const aimTimer = Number(source.aimTimerMs);
  const aimLength = Number(source.aimLength);
  const hitsToWin = Number(source.hitsToWin);
  return {
    enabled: !!source.enabled,
    symmetryEnabled: source.symmetryEnabled !== false,
    aimTimerMs: Number.isFinite(aimTimer)
      ? Math.max(1000, Math.min(30000, Math.round(aimTimer)))
      : PVP_DEFAULTS.aimTimerMs,
    aimLength: Number.isFinite(aimLength)
      ? Math.max(0, Math.min(300, Math.round(aimLength)))
      : PVP_DEFAULTS.aimLength,
    hitsToWin: Number.isFinite(hitsToWin)
      ? Math.max(PVP_MIN_HITS_TO_WIN, Math.min(PVP_MAX_HITS_TO_WIN, Math.round(hitsToWin)))
      : PVP_DEFAULTS.hitsToWin,
    cpuEnabled: source.cpuEnabled !== false,
    cpuDifficulty: CPU_DIFFICULTIES.has(source.cpuDifficulty)
      ? source.cpuDifficulty
      : PVP_DEFAULTS.cpuDifficulty,
    enemyCharacter: normalizeLevelCharacterAssignment(source.enemyCharacter)
  };
}

export function ensureLevelPvp(level) {
  if (!level || typeof level !== 'object') return normalizePvpSettings(null);
  level.pvp = normalizePvpSettings(level.pvp);
  return level.pvp;
}

export function isPvpEnabled(level) {
  return !!normalizePvpSettings(level?.pvp).enabled;
}

export function isPvpSymmetryEnabled(level) {
  const pvp = normalizePvpSettings(level?.pvp);
  return pvp.enabled && pvp.symmetryEnabled;
}

export function getPvpMidline(canvasHeight = 600) {
  const height = Number.isFinite(canvasHeight) ? canvasHeight : 600;
  return height / 2;
}

export function clampPvpAuthoredY(y, canvasHeight = 600, margin = 0) {
  const midline = getPvpMidline(canvasHeight);
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  return Math.max(safeMargin, Math.min(midline - safeMargin, y));
}

export function isPvpAuthoredPeg(peg, canvasHeight = 600) {
  if (!peg || typeof peg !== 'object') return false;
  return true;
}

export function filterPvpAuthoredPegs(pegs, canvasHeight = 600) {
  return Array.isArray(pegs) ? pegs.filter(peg => isPvpAuthoredPeg(peg, canvasHeight)) : [];
}

export function mirrorPvpPeg(peg, canvasHeight = 600) {
  if (!peg || typeof peg !== 'object') return null;
  const mirrored = JSON.parse(JSON.stringify(peg));
  mirrored.id = `${peg.id || 'peg'}__pvp_mirror`;
  mirrored.y = canvasHeight - Number(peg.y || 0);
  mirrored.angle = -Number(peg.angle || 0);
  mirrored.groupId = null;
  mirrored.bezierGroupId = null;

  if (mirrored.animation && typeof mirrored.animation === 'object') {
    if (Number.isFinite(mirrored.animation.dy)) mirrored.animation.dy = -mirrored.animation.dy;
    if (Number.isFinite(mirrored.animation.rotation)) mirrored.animation.rotation = -mirrored.animation.rotation;
  }

  if (Array.isArray(mirrored.curveSlices)) {
    mirrored.curveSlices = mirrored.curveSlices.map(slice => {
      const copy = { ...slice };
      if (Number.isFinite(copy.y)) copy.y = canvasHeight - copy.y;
      if (Number.isFinite(copy.ny)) copy.ny = -copy.ny;
      return copy;
    }).reverse();
  }

  return mirrored;
}

export function getPvpRuntimePegs(level, canvasHeight = 600) {
  return Array.isArray(level?.pegs) ? level.pegs : [];
}

export function normalizePvpAuthoredPegs(level, canvasHeight = 600) {
  if (!level || !Array.isArray(level.pegs)) return false;
  let changed = false;
  for (const peg of level.pegs) {
    if (!peg || typeof peg !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(peg, 'pvpMirrored')) {
      delete peg.pvpMirrored;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(peg, 'pvpMirrorOf')) {
      delete peg.pvpMirrorOf;
      changed = true;
    }
  }
  return changed;
}
