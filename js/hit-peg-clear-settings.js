export const HIT_PEG_CLEAR_DELAY_DEFAULT_MS = 1200;
export const HIT_PEG_CLEAR_DELAY_MIN_MS = 0;
export const HIT_PEG_CLEAR_DELAY_MAX_MS = 8000;
export const HIT_PEG_TIMED_CLEAR_DEFAULT_ENABLED = false;

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeHitPegClearDelayMs(value, fallback = HIT_PEG_CLEAR_DELAY_DEFAULT_MS) {
  return Math.max(
    HIT_PEG_CLEAR_DELAY_MIN_MS,
    Math.min(
      HIT_PEG_CLEAR_DELAY_MAX_MS,
      Math.round(toFiniteNumber(value, fallback) / 100) * 100
    )
  );
}

export function normalizeLevelHitPegClearDelay(level) {
  if (!level || typeof level !== 'object') return HIT_PEG_CLEAR_DELAY_DEFAULT_MS;
  const fallbackSeconds = Number.isFinite(Number(level.hitPegClearDelaySeconds))
    ? Number(level.hitPegClearDelaySeconds) * 1000
    : HIT_PEG_CLEAR_DELAY_DEFAULT_MS;
  level.hitPegClearDelayMs = normalizeHitPegClearDelayMs(level.hitPegClearDelayMs, fallbackSeconds);
  delete level.hitPegClearDelaySeconds;
  return level.hitPegClearDelayMs;
}

export function normalizeLevelHitPegClearSettings(level) {
  if (!level || typeof level !== 'object') {
    return {
      enabled: HIT_PEG_TIMED_CLEAR_DEFAULT_ENABLED,
      delayMs: HIT_PEG_CLEAR_DELAY_DEFAULT_MS
    };
  }

  const delayMs = normalizeLevelHitPegClearDelay(level);
  level.hitPegTimedClearEnabled = Object.prototype.hasOwnProperty.call(level, 'hitPegTimedClearEnabled')
    ? !!level.hitPegTimedClearEnabled
    : HIT_PEG_TIMED_CLEAR_DEFAULT_ENABLED;

  return {
    enabled: level.hitPegTimedClearEnabled,
    delayMs
  };
}
