export const BOMB_MAGNET_TYPE = 'bombMagnet';

export const MAGNET_DEFAULTS = Object.freeze({
  radius: 96,
  strength: 0.32,
  mode: 'attract',
  explosionPower: 1.15,
  // Blast is an opt-in option, OFF by default: the magnet is a pure force field
  // until the author explicitly turns the detonation on.
  blast: false,
  // Hittable ON by default: the ball activates/detonates it. OFF ⇒ the ball treats it
  // like a grey obstacle peg (bounces, no score, no blast); the force field still works.
  hittable: true,
  // Two independent disappearance triggers, both OFF by default (the magnet persists as a
  // force field). `knockout` = vanish when the ball hits the magnet directly. `vanishAfter
  // Blast` = vanish once its blast fires (direct hit OR an attached group reaching it).
  // Both are independent of Blast firing per se: a non-vanishing magnet can blast again
  // after a short cooldown. Its force field briefly pauses after each blast, then resumes.
  // `vanishAfterBlast` only does anything when Blast is enabled.
  knockout: false,
  vanishAfterBlast: false
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
  peg.magnetHittable = peg.magnetHittable !== false;
  peg.magnetKnockout = peg.magnetKnockout === true;
  peg.magnetVanishAfterBlast = peg.magnetVanishAfterBlast === true;
  delete peg._magnetDetonated;
  delete peg._magnetBlastSpent;
  delete peg._magnetBlastCooldownUntilMs;
  delete peg._magnetFieldDisabled;
  delete peg._magnetForcePaused;
  delete peg._magnetForceResumeAtMs;
  delete peg._magnetVanishPending;
  delete peg._magnetPulse;
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

export function isMagnetHittable(peg) {
  return peg?.magnetHittable !== false;
}

export function isMagnetKnockoutEnabled(peg) {
  return peg?.magnetKnockout === true;
}

export function isMagnetVanishAfterBlast(peg) {
  return peg?.magnetVanishAfterBlast === true;
}

export function isMagnetForceActive(peg) {
  return isBombMagnetPeg(peg)
    && peg._magnetFieldDisabled !== true
    && peg._magnetForcePaused !== true;
}
