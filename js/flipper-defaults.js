export const FLIPPER_DEFAULTS = Object.freeze({
  yOffset: 100,
  xOffset: 197,
  length: 83,
  width: 7,
  restAngle: 16,
  flipAngle: 37,
  bounce: 0.40,
  scale: 1.7
});

const LEGACY_FLIPPER_DEFAULTS = Object.freeze([
  Object.freeze({
    xOffset: 198,
    length: 70,
    width: 7,
    restAngle: 18,
    flipAngle: 30,
    bounce: 0.50,
    scale: 1.8
  }),
  Object.freeze({
    xOffset: 196,
    length: 60,
    width: 8,
    restAngle: 23,
    flipAngle: 30,
    bounce: 0.65,
    scale: 1.8
  })
]);

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function isCloseNumber(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.0001;
}

function isLegacyDefaultFlipperConfig(flippers) {
  if (!flippers || typeof flippers !== 'object') return false;
  return LEGACY_FLIPPER_DEFAULTS.some(legacy => (
    isCloseNumber(Number(flippers.xOffset), legacy.xOffset)
    && isCloseNumber(Number(flippers.length), legacy.length)
    && isCloseNumber(Number(flippers.width), legacy.width)
    && isCloseNumber(Number(flippers.restAngle), legacy.restAngle)
    && isCloseNumber(Number(flippers.flipAngle), legacy.flipAngle)
    && isCloseNumber(Number(flippers.bounce), legacy.bounce)
    && isCloseNumber(Number(flippers.scale), legacy.scale)
  ));
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
  bounce = FLIPPER_DEFAULTS.bounce
} = {}) {
  if (!flippers || typeof flippers !== 'object') return null;
  const defaults = createDefaultFlipperConfig({ canvasHeight, cameraY, bounce, enabled: flippers.enabled !== false });
  const source = isLegacyDefaultFlipperConfig(flippers)
    ? {
      ...flippers,
      xOffset: defaults.xOffset,
      length: defaults.length,
      width: defaults.width,
      restAngle: defaults.restAngle,
      flipAngle: defaults.flipAngle,
      bounce: defaults.bounce,
      scale: defaults.scale
    }
    : flippers;
  return {
    enabled: source.enabled !== false,
    y: Number.isFinite(source.y) ? source.y : defaults.y,
    xOffset: clampNumber(source.xOffset, 10, 250, defaults.xOffset),
    length: clampNumber(source.length, 20, 150, defaults.length),
    width: clampNumber(source.width, 4, 40, defaults.width),
    restAngle: clampNumber(source.restAngle, 5, 60, defaults.restAngle),
    flipAngle: clampNumber(source.flipAngle, 0, 70, defaults.flipAngle),
    bounce: clampNumber(source.bounce, 0.3, 5.0, defaults.bounce),
    scale: clampNumber(source.scale, 0.5, 3.0, defaults.scale)
  };
}
