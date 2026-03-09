export const MULTIBALL_MIN_SPAWN_COUNT = 1;
export const MULTIBALL_MAX_SPAWN_COUNT = 10;
export const MULTIBALL_DEFAULT_SPAWN_COUNT = 1;

export function normalizeMultiballSpawnCount(rawValue) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return MULTIBALL_DEFAULT_SPAWN_COUNT;
  }
  const rounded = Math.round(numeric);
  return Math.max(MULTIBALL_MIN_SPAWN_COUNT, Math.min(MULTIBALL_MAX_SPAWN_COUNT, rounded));
}
