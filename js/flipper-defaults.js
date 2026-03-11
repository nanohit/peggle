export const FLIPPER_DEFAULTS = Object.freeze({
  yOffset: 100,
  xOffset: 198,
  length: 70,
  width: 7,
  restAngle: 18,
  flipAngle: 30,
  bounce: 0.50,
  scale: 1.8
});

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

export function createDefaultFlipperConfig({
  canvasHeight = 600,
  cameraY = 0,
  bounce = FLIPPER_DEFAULTS.bounce,
  enabled = true
} = {}) {
  const y = cameraY + canvasHeight - FLIPPER_DEFAULTS.yOffset;
  return {
    enabled: !!enabled,
    y,
    xOffset: FLIPPER_DEFAULTS.xOffset,
    length: FLIPPER_DEFAULTS.length,
    width: FLIPPER_DEFAULTS.width,
    restAngle: FLIPPER_DEFAULTS.restAngle,
    flipAngle: FLIPPER_DEFAULTS.flipAngle,
    bounce,
    scale: FLIPPER_DEFAULTS.scale
  };
}

export function normalizeFlipperConfig(flippers, {
  canvasHeight = 600,
  cameraY = 0,
  bounce = 0.65
} = {}) {
  if (!flippers || typeof flippers !== 'object') return null;
  const defaults = createDefaultFlipperConfig({ canvasHeight, cameraY, bounce, enabled: flippers.enabled !== false });
  return {
    enabled: flippers.enabled !== false,
    y: Number.isFinite(flippers.y) ? flippers.y : defaults.y,
    xOffset: clampNumber(flippers.xOffset, 10, 250, defaults.xOffset),
    length: clampNumber(flippers.length, 20, 150, defaults.length),
    width: clampNumber(flippers.width, 4, 40, defaults.width),
    restAngle: clampNumber(flippers.restAngle, 5, 60, defaults.restAngle),
    flipAngle: clampNumber(flippers.flipAngle, 0, 70, defaults.flipAngle),
    bounce: clampNumber(flippers.bounce, 0.3, 5.0, defaults.bounce),
    scale: clampNumber(flippers.scale, 0.5, 3.0, defaults.scale)
  };
}
