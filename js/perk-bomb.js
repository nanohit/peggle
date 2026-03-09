import { PHYSICS_CONFIG, getBallRadius } from './physics.js';

const DEFAULT_SHOCKWAVE_RADIUS_MULTIPLIER = 6;

function isPortalPeg(peg) {
  return !!peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange');
}

function getPegReachRadius(peg) {
  if (!peg) return PHYSICS_CONFIG.pegRadius;

  if (peg.shape === 'brick') {
    const width = peg.width || PHYSICS_CONFIG.brickWidth;
    const height = peg.height || PHYSICS_CONFIG.brickHeight;
    return Math.hypot(width, height) * 0.5;
  }

  if (peg.type === 'bumper') {
    return PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
  }

  return PHYSICS_CONFIG.pegRadius;
}

export function buildBombShockwave(pegs, sourceBall, sourcePeg, options = null) {
  const centerX = Number.isFinite(sourcePeg?.x) ? sourcePeg.x : sourceBall?.x;
  const centerY = Number.isFinite(sourcePeg?.y) ? sourcePeg.y : sourceBall?.y;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return {
      centerX: 0,
      centerY: 0,
      radius: 0,
      targets: []
    };
  }

  const multiplier = Number.isFinite(options?.radiusMultiplier)
    ? Math.max(1, options.radiusMultiplier)
    : DEFAULT_SHOCKWAVE_RADIUS_MULTIPLIER;
  const ballRadius = Number.isFinite(sourceBall?.radius) ? sourceBall.radius : getBallRadius();
  const radius = Math.max(ballRadius, ballRadius * multiplier);
  const maxRadius = Math.max(1, radius);
  const targets = [];

  for (const peg of Array.isArray(pegs) ? pegs : []) {
    if (!peg || isPortalPeg(peg)) continue;
    if (!Number.isFinite(peg.x) || !Number.isFinite(peg.y)) continue;

    const dx = peg.x - centerX;
    const dy = peg.y - centerY;
    const reach = maxRadius + getPegReachRadius(peg);
    if ((dx * dx + dy * dy) > reach * reach) continue;
    targets.push(peg);
  }

  targets.sort((a, b) => {
    const da = (a.x - centerX) * (a.x - centerX) + (a.y - centerY) * (a.y - centerY);
    const db = (b.x - centerX) * (b.x - centerX) + (b.y - centerY) * (b.y - centerY);
    return da - db;
  });

  return {
    centerX,
    centerY,
    radius: maxRadius,
    targets
  };
}
