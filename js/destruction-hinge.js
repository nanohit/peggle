import { getEffectiveBrickSize } from './physics.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const number = (x, fallback) => Number.isFinite(Number(x)) ? Number(x) : fallback;

// A native revolute joint: the beam is free to rotate, its pin stays in the world.
// Angles are in radians in screen coordinates, positive clockwise.
export function normalizeDestructionHinge(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const minAngle = clamp(number(raw.minAngle, -0.65), -1.35, 1.3);
  return {
    pivotFraction: clamp(number(raw.pivotFraction, 0.5), 0.15, 0.85),
    minAngle,
    maxAngle: clamp(number(raw.maxAngle, 0.65), minAngle + 0.03, 1.35),
    damping: clamp(number(raw.damping, 0.999), 0.9, 1),
    stopBounce: clamp(number(raw.stopBounce, 0.04), 0, 0.5),
    breakImpulse: clamp(number(raw.breakImpulse, 0), 0, 30)
  };
}

export function getSeesawPivot(peg) {
  const joint = normalizeDestructionHinge(peg?.destructionHinge);
  if (!joint) return null;
  const offset = (joint.pivotFraction - 0.5) * getEffectiveBrickSize(peg).width;
  return { x: peg.x + Math.cos(peg.angle || 0) * offset,
    y: peg.y + Math.sin(peg.angle || 0) * offset };
}

export function mirrorDestructionHinge(raw) {
  const joint = normalizeDestructionHinge(raw);
  if (!joint) return null;
  return { ...joint, pivotFraction: 1 - joint.pivotFraction,
    minAngle: -joint.maxAngle, maxAngle: -joint.minAngle };
}

export function createBodyHinge(body, peg) {
  const config = normalizeDestructionHinge(peg?.destructionHinge);
  if (!config || peg.shape !== 'brick') return null;
  const anchor = getSeesawPivot(peg);
  const c = Math.cos(body.angle || 0), s = Math.sin(body.angle || 0);
  const dx = anchor.x - body.x, dy = anchor.y - body.y;
  return { ...config, anchorX: anchor.x, anchorY: anchor.y,
    localX: dx * c + dy * s, localY: -dx * s + dy * c,
    referenceAngle: (peg.angle || 0) - (body.angle || 0), pegId: peg.id };
}

// Project the pin position, then solve the 2×2 effective-mass matrix for its
// velocity. The angular impulse comes from the actual lever arm, including
// gravity on an off-centre beam and loads arriving at either end.
export function solveHingeConstraint(body, stepScale = 1, damp = false) {
  const j = body?.hinge;
  if (!j || body.static) return false;
  const low = j.minAngle - j.referenceAngle, high = j.maxAngle - j.referenceAngle;
  if (body.angle < low) { body.angle = low; if (body.av < 0) body.av *= -j.stopBounce; }
  if (body.angle > high) { body.angle = high; if (body.av > 0) body.av *= -j.stopBounce; }
  const c = Math.cos(body.angle || 0), s = Math.sin(body.angle || 0);
  const rx = j.localX * c - j.localY * s, ry = j.localX * s + j.localY * c;
  body.x = j.anchorX - rx;
  body.y = j.anchorY - ry;
  const m = body.invMass, i = body.invInertia;
  const k11 = m + i * ry * ry, k22 = m + i * rx * rx, k12 = -i * rx * ry;
  const det = k11 * k22 - k12 * k12;
  if (det > 1e-12) {
    const vx = (body.vx || 0) - (body.av || 0) * ry;
    const vy = (body.vy || 0) + (body.av || 0) * rx;
    const px = (-k22 * vx + k12 * vy) / det;
    const py = (k12 * vx - k11 * vy) / det;
    body.vx += m * px; body.vy += m * py;
    body.av += i * (rx * py - ry * px);
  }
  if (damp) body.av *= Math.pow(j.damping, stepScale);
  // The bearing is a support even when the beam has no other contacts.
  body.supported = true; body.supportDot = 1; body.supportMemory = 8;
  body.staticSupportMemory = 8; body.staticSupportDot = 1;
  return true;
}

export function createSeesaw({ id = 'seesaw', x = 200, y = 260, width = 122,
  angle = 0, pivotFraction = 0.5, minAngle = -0.65, maxAngle = 0.65 } = {}) {
  const hinge = normalizeDestructionHinge({ pivotFraction, minAngle, maxAngle });
  const beam = { id: id + ':beam', groupId: id, type: 'obstacle', shape: 'brick',
    x, y, angle, width: clamp(width, 55, 200), height: 10.2, brickBaseRadius: 8.5,
    destructionStatic: false, destructionPhysicsOnHit: false,
    destructionHinge: hinge, constructionPart: 'beam' };
  const pin = getSeesawPivot(beam);
  const base = { id: id + ':base', groupId: id, type: 'obstacle', shape: 'brick',
    x: pin.x, y: pin.y + 22, angle: 0, width: 14, height: 20,
    brickBaseRadius: 8.5, destructionStatic: true, constructionPart: 'bearing' };
  return { pegs: [beam, base], groups: [{ id, name: 'Качели', pattern: 'construction',
    construction: { type: 'seesaw' }, destructionBody: false }] };
}
