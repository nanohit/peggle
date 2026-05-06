export const PVP_DEFAULTS = Object.freeze({
  enabled: false,
  symmetryEnabled: true,
  aimTimerMs: 5000,
  cpuEnabled: true,
  cpuDifficulty: 'normal'
});

const CPU_DIFFICULTIES = new Set(['easy', 'normal', 'hard']);

export function normalizePvpSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const aimTimer = Number(source.aimTimerMs);
  return {
    enabled: !!source.enabled,
    symmetryEnabled: source.symmetryEnabled !== false,
    aimTimerMs: Number.isFinite(aimTimer)
      ? Math.max(1000, Math.min(30000, Math.round(aimTimer)))
      : PVP_DEFAULTS.aimTimerMs,
    cpuEnabled: source.cpuEnabled !== false,
    cpuDifficulty: CPU_DIFFICULTIES.has(source.cpuDifficulty)
      ? source.cpuDifficulty
      : PVP_DEFAULTS.cpuDifficulty
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
  return !peg.pvpMirrored;
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
  mirrored.pvpMirrored = true;
  mirrored.pvpMirrorOf = peg.id || null;
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
  const pegs = Array.isArray(level?.pegs) ? level.pegs : [];
  if (!isPvpSymmetryEnabled(level)) return pegs;
  const authored = filterPvpAuthoredPegs(pegs, canvasHeight);
  const mirrored = authored
    .filter(peg => Math.abs(Number(peg.y || 0) - getPvpMidline(canvasHeight)) > 0.5)
    .map(peg => mirrorPvpPeg(peg, canvasHeight))
    .filter(Boolean);
  return [...authored, ...mirrored];
}

export function normalizePvpAuthoredPegs(level, canvasHeight = 600) {
  if (!level || !Array.isArray(level.pegs)) return false;
  const authored = level.pegs.filter(peg => !peg?.pvpMirrored);
  if (authored.length === level.pegs.length) return false;
  level.pegs = authored;
  return true;
}
