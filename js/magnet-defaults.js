export const BOMB_MAGNET_TYPE = 'bombMagnet';

export const MAGNET_DEFAULTS = Object.freeze({
  radius: 96,
  strength: 0.32,
  mode: 'attract',
  explosionPower: 1.15,
  // Blast is an opt-in option, OFF by default: the magnet is a pure force field
  // until the author explicitly turns the detonation on.
  blast: false
});

export const MAGNET_MODES = Object.freeze(['attract', 'repel']);

export function isBombMagnetType(type) {
  return type === BOMB_MAGNET_TYPE;
}

export function isBombMagnetPeg(peg) {
  return !!peg && isBombMagnetType(peg.type);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeMagnetMode(mode) {
  return MAGNET_MODES.includes(mode) ? mode : MAGNET_DEFAULTS.mode;
}

export function normalizeMagnetPegProperties(peg) {
  if (!peg || typeof peg !== 'object') return peg;
  peg.shape = 'circle';
  peg.magnetRadius = clampNumber(peg.magnetRadius, 24, 280, MAGNET_DEFAULTS.radius);
  peg.magnetStrength = clampNumber(peg.magnetStrength, 0, 2.5, MAGNET_DEFAULTS.strength);
  peg.magnetMode = normalizeMagnetMode(peg.magnetMode);
  peg.magnetExplosionPower = clampNumber(peg.magnetExplosionPower, 0.3, 4, MAGNET_DEFAULTS.explosionPower);
  peg.magnetBlast = peg.magnetBlast === true;
  if (!Object.prototype.hasOwnProperty.call(peg, 'destructionStatic')) {
    peg.destructionStatic = true;
  }
  delete peg.width;
  delete peg.height;
  delete peg.curveSlices;
  delete peg.brickBaseRadius;
  return peg;
}

export function getMagnetRadius(peg) {
  return clampNumber(peg?.magnetRadius, 24, 280, MAGNET_DEFAULTS.radius);
}

export function getMagnetStrength(peg) {
  return clampNumber(peg?.magnetStrength, 0, 2.5, MAGNET_DEFAULTS.strength);
}

export function getMagnetExplosionPower(peg) {
  return clampNumber(peg?.magnetExplosionPower, 0.3, 4, MAGNET_DEFAULTS.explosionPower);
}

export function isMagnetBlastEnabled(peg) {
  return peg?.magnetBlast === true;
}
