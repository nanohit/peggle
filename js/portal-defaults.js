export const PORTAL_DEFAULT_SCALE = 3.0;
export const PORTAL_MIN_SCALE = 0.5;
export const PORTAL_MAX_SCALE = 10.0;

export function isPortalType(type) {
  return type === 'portalBlue' || type === 'portalOrange';
}

export function normalizePortalScale(scale, { upgradeLegacyDefault = false } = {}) {
  const numeric = Number(scale);
  if (!Number.isFinite(numeric)) return PORTAL_DEFAULT_SCALE;
  if (upgradeLegacyDefault && Math.abs(numeric - 1.0) < 0.0001) return PORTAL_DEFAULT_SCALE;
  return Math.max(PORTAL_MIN_SCALE, Math.min(PORTAL_MAX_SCALE, numeric));
}

export function getPortalScale(peg) {
  return normalizePortalScale(peg?.portalScale);
}

export function normalizePortalPegProperties(peg, options = {}) {
  if (!peg || !isPortalType(peg.type)) return peg;
  peg.portalScale = normalizePortalScale(peg.portalScale, options);
  if (peg.portalOneWay == null) peg.portalOneWay = true;
  if (peg.portalOneWayFlip == null) peg.portalOneWayFlip = true;
  peg.shape = 'circle';
  return peg;
}
