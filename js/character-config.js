import { resolveAssetPaths } from './visual-config.js';

export const CHARACTER_REGISTRY_VERSION = 1;
export const CHARACTER_REGISTRY_STORAGE_KEY = 'peggle_character_registry_v1';
export const DEFAULT_CHARACTER_ID = 'lu';
export const DEFAULT_SATURATION_CAP = 1.5;
export const PERSONALITY_TUNING_VERSION = 2;

export const CANONICAL_EMOTION_SLOTS = [
  'idle',
  'amused',
  'enthralled',
  'disappointed',
  'happy-mocking',
  'worried',
  'anger',
  'victory'
];

const DEFAULT_CHARACTER_ASSET = resolveAssetPaths('character');

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanSlotName(value, fallback = 'idle') {
  if (typeof value !== 'string') return fallback;
  const slot = value.trim();
  return slot || fallback;
}

export function makeCharacterId(value, fallback = DEFAULT_CHARACTER_ID) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function normalizeDistribution(raw, fallback = { idle: 1 }) {
  const source = isPlainObject(raw) ? raw : fallback;
  const result = {};
  for (const [slot, weight] of Object.entries(source || {})) {
    const n = Number(weight);
    if (!slot || !Number.isFinite(n) || n <= 0) continue;
    result[cleanSlotName(slot)] = n;
  }
  return Object.keys(result).length ? result : clone(fallback);
}

function normalizeImpulseTable(raw, fallback = {}) {
  const result = {};
  const applyRows = (rows) => {
    for (const [eventType, row] of Object.entries(rows || {})) {
      if (!eventType || !isPlainObject(row)) continue;
      result[eventType] = {
        magnitude: clampNumber(row.magnitude, 0, 2, result[eventType]?.magnitude ?? 0.3),
        distribution: normalizeDistribution(row.distribution, result[eventType]?.distribution || { idle: 1 })
      };
      if (typeof row.escalationSlot === 'string' && row.escalationSlot.trim()) {
        result[eventType].escalationSlot = row.escalationSlot.trim();
      }
    }
  };
  applyRows(fallback);
  if (isPlainObject(raw)) applyRows(raw);
  return result;
}

function normalizePressure(raw = null, fallback = DEFAULT_PERSONALITY.pressure) {
  const source = isPlainObject(raw) ? raw : {};
  const defaults = fallback || {
    enabled: true,
    maxBalls: 4,
    pegRatioStart: 2.4,
    pegRatioCritical: 4.8,
    target: 0.62,
    driftRate: 0.2,
    impulseCooldownMs: 8000,
    distribution: { worried: 0.55, disappointed: 0.25, anger: 0.2 }
  };
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    maxBalls: Math.round(clampNumber(source.maxBalls, 1, 8, defaults.maxBalls)),
    pegRatioStart: clampNumber(source.pegRatioStart, 0.5, 10, defaults.pegRatioStart),
    pegRatioCritical: clampNumber(source.pegRatioCritical, 1, 20, defaults.pegRatioCritical),
    target: clampNumber(source.target, 0, 1.5, defaults.target),
    driftRate: clampNumber(source.driftRate, 0, 2, defaults.driftRate),
    impulseCooldownMs: clampNumber(source.impulseCooldownMs, 1000, 60000, defaults.impulseCooldownMs),
    distribution: normalizeDistribution(source.distribution, defaults.distribution)
  };
}

function getPathValue(source, path) {
  let cursor = source;
  for (const part of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPathValue(target, path, value) {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[path[path.length - 1]] = value;
}

function replaceLegacyNumber(source, path, legacyValue, nextValue) {
  const current = Number(getPathValue(source, path));
  if (!Number.isFinite(current) || Math.abs(current - legacyValue) > 0.0001) return;
  setPathValue(source, path, nextValue);
}

function replaceLegacyDistribution(source, path, legacyDistribution, nextDistribution) {
  const current = getPathValue(source, path);
  if (!isPlainObject(current)) return;
  const currentKeys = Object.keys(current).sort();
  const legacyKeys = Object.keys(legacyDistribution).sort();
  if (currentKeys.length !== legacyKeys.length || currentKeys.some((key, index) => key !== legacyKeys[index])) return;
  for (const key of legacyKeys) {
    if (Math.abs(Number(current[key]) - legacyDistribution[key]) > 0.0001) return;
  }
  setPathValue(source, path, clone(nextDistribution));
}

function upgradeLegacyPersonalitySource(raw) {
  if (!isPlainObject(raw) || Number(raw.tuningVersion) >= PERSONALITY_TUNING_VERSION) return raw;
  const source = clone(raw);
  const legacyDecay = {
    idle: 0.2,
    amused: 0.46,
    enthralled: 0.54,
    disappointed: 0.28,
    'happy-mocking': 0.34,
    anger: 0.16
  };
  const nextDecay = DEFAULT_PERSONALITY.decayRates;
  for (const [slot, legacyValue] of Object.entries(legacyDecay)) {
    replaceLegacyNumber(source, ['decayRates', slot], legacyValue, nextDecay[slot]);
  }
  replaceLegacyNumber(source, ['baseline', 'rate'], 0.18, DEFAULT_PERSONALITY.baseline.rate);
  replaceLegacyNumber(source, ['baseline', 'target'], 0.4, DEFAULT_PERSONALITY.baseline.target);
  replaceLegacyNumber(source, ['boredom', 'afterMs'], 5000, DEFAULT_PERSONALITY.boredom.afterMs);
  replaceLegacyNumber(source, ['boredom', 'magnitudePerSecond'], 0.18, DEFAULT_PERSONALITY.boredom.magnitudePerSecond);
  replaceLegacyNumber(source, ['refractoryMs'], 900, DEFAULT_PERSONALITY.refractoryMs);
  replaceLegacyNumber(source, ['refractoryScale'], 0.5, DEFAULT_PERSONALITY.refractoryScale);
  replaceLegacyNumber(source, ['preemptThreshold'], 0.8, DEFAULT_PERSONALITY.preemptThreshold);
  replaceLegacyNumber(source, ['saturationCap'], 1.5, DEFAULT_PERSONALITY.saturationCap);
  replaceLegacyNumber(source, ['dwellMs'], 600, DEFAULT_PERSONALITY.dwellMs);
  replaceLegacyNumber(source, ['leadMargin'], 0.1, DEFAULT_PERSONALITY.leadMargin);
  replaceLegacyNumber(source, ['crossfadeMs'], 320, DEFAULT_PERSONALITY.crossfadeMs);
  replaceLegacyNumber(source, ['fastCrossfadeMs'], 150, DEFAULT_PERSONALITY.fastCrossfadeMs);
  replaceLegacyNumber(source, ['ambient', 'idleAfterMs'], 10000, DEFAULT_PERSONALITY.ambient.idleAfterMs);
  replaceLegacyDistribution(
    source,
    ['impulseTable', 'level_clear', 'distribution'],
    { enthralled: 0.52, amused: 0.24, 'happy-mocking': 0.24 },
    DEFAULT_PERSONALITY.impulseTable.level_clear.distribution
  );
  replaceLegacyDistribution(
    source,
    ['impulseTable', 'ball_lost_after_streak', 'distribution'],
    { disappointed: 0.56, 'happy-mocking': 0.25, anger: 0.19 },
    DEFAULT_PERSONALITY.impulseTable.ball_lost_after_streak.distribution
  );
  source.tuningVersion = PERSONALITY_TUNING_VERSION;
  return source;
}

function normalizePressurePatch(raw = null) {
  if (!isPlainObject(raw)) return null;
  const patch = {};
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled;
  for (const [key, max] of Object.entries({
    maxBalls: 8,
    pegRatioStart: 10,
    pegRatioCritical: 20,
    target: 1.5,
    driftRate: 2,
    impulseCooldownMs: 60000
  })) {
    if (Number.isFinite(Number(raw[key]))) {
      const min = key === 'impulseCooldownMs' ? 1000 : (key === 'maxBalls' ? 1 : 0);
      patch[key] = clampNumber(raw[key], min, max, DEFAULT_PERSONALITY.pressure[key]);
      if (key === 'maxBalls') patch[key] = Math.round(patch[key]);
    }
  }
  if (isPlainObject(raw.distribution)) {
    patch.distribution = normalizeDistribution(raw.distribution, {});
  }
  return Object.keys(patch).length ? patch : null;
}

function normalizeStreakThresholds(raw, fallback = [3, 6, 10]) {
  const source = Array.isArray(raw) ? raw : fallback;
  const values = source
    .map(value => Math.round(Number(value)))
    .filter(value => Number.isFinite(value) && value > 0 && value <= 100);
  const unique = Array.from(new Set(values)).sort((a, b) => a - b);
  return unique.length ? unique : [...fallback];
}

export const DEFAULT_PERSONALITY = {
  tuningVersion: PERSONALITY_TUNING_VERSION,
  decayRates: {
    idle: 0.14,
    amused: 0.28,
    enthralled: 0.24,
    disappointed: 0.18,
    'happy-mocking': 0.2,
    worried: 0.16,
    anger: 0.1,
    victory: 0.12
  },
  baseline: {
    slot: 'idle',
    rate: 0.1,
    target: 0.32
  },
  boredom: {
    afterMs: 7000,
    slot: 'disappointed',
    magnitudePerSecond: 0.08
  },
  refractoryMs: 1200,
  refractoryScale: 0.65,
  preemptThreshold: 0.85,
  streakThresholds: [3, 6, 10],
  saturationCap: 1.6,
  dwellMs: 1100,
  returnToBaselineDelayMs: 2400,
  leadMargin: 0.18,
  crossfadeMs: 650,
  fastCrossfadeMs: 340,
  ambient: {
    idleAfterMs: 11000,
    samplerMinMs: 5000,
    samplerMaxMs: 8000,
    distribution: {
      idle: 0.6,
      amused: 0.2,
      'happy-mocking': 0.1,
      disappointed: 0.1
    }
  },
  pressure: {
    enabled: true,
    maxBalls: 4,
    pegRatioStart: 2.4,
    pegRatioCritical: 4.8,
    target: 0.62,
    driftRate: 0.2,
    impulseCooldownMs: 8000,
    distribution: { worried: 0.55, disappointed: 0.25, anger: 0.2 }
  },
  escalation: {
    idle: 'amused',
    amused: 'enthralled',
    enthralled: 'happy-mocking',
    disappointed: 'worried',
    'happy-mocking': 'enthralled',
    worried: 'anger',
    anger: 'anger',
    victory: 'enthralled'
  },
  impulseTable: {
    peg_hit: {
      magnitude: 0.26,
      distribution: { amused: 0.52, idle: 0.22, enthralled: 0.16, 'happy-mocking': 0.1 }
    },
    peg_streak_N: {
      magnitude: 0.58,
      distribution: { enthralled: 0.58, amused: 0.24, 'happy-mocking': 0.18 }
    },
    spin_triggered: {
      magnitude: 0.34,
      distribution: { amused: 0.42, idle: 0.28, enthralled: 0.2, disappointed: 0.1 }
    },
    spin_win_small: {
      magnitude: 0.72,
      distribution: { amused: 0.42, enthralled: 0.34, 'happy-mocking': 0.24 }
    },
    spin_win_big: {
      magnitude: 1.05,
      distribution: { enthralled: 0.52, 'happy-mocking': 0.3, amused: 0.18 }
    },
    spin_lose: {
      magnitude: 0.52,
      distribution: { disappointed: 0.62, idle: 0.22, 'happy-mocking': 0.16 }
    },
    jackpot: {
      magnitude: 1.4,
      distribution: { enthralled: 0.62, 'happy-mocking': 0.28, amused: 0.1 }
    },
    ball_lost_clean: {
      magnitude: 0.46,
      distribution: { disappointed: 0.46, idle: 0.24, worried: 0.18, 'happy-mocking': 0.12 }
    },
    ball_lost_after_streak: {
      magnitude: 0.9,
      distribution: { disappointed: 0.38, worried: 0.3, anger: 0.2, 'happy-mocking': 0.12 }
    },
    level_clear: {
      magnitude: 1.22,
      distribution: { victory: 0.62, enthralled: 0.24, amused: 0.14 }
    },
    aim_held_too_long: {
      magnitude: 0.5,
      distribution: { disappointed: 0.42, 'happy-mocking': 0.36, idle: 0.22 }
    },
    safe_play_pattern: {
      magnitude: 0.58,
      distribution: { 'happy-mocking': 0.48, disappointed: 0.34, amused: 0.18 }
    },
    pressure_low_balls: {
      magnitude: 0.48,
      distribution: { worried: 0.55, disappointed: 0.26, anger: 0.12, 'happy-mocking': 0.07 }
    },
    dialogue_impulse: {
      magnitude: 0.55,
      distribution: { idle: 1 }
    }
  }
};

export function normalizePersonality(raw = null) {
  const source = upgradeLegacyPersonalitySource(isPlainObject(raw) ? raw : {});
  const defaults = DEFAULT_PERSONALITY;
  const decayRates = { ...defaults.decayRates };
  if (isPlainObject(source.decayRates)) {
    for (const [slot, rate] of Object.entries(source.decayRates)) {
      decayRates[cleanSlotName(slot)] = clampNumber(rate, 0, 5, decayRates[slot] ?? 0.3);
    }
  }

  const baselineSource = isPlainObject(source.baseline) ? source.baseline : source.baselineDrift;
  const baseline = {
    slot: cleanSlotName(baselineSource?.slot, defaults.baseline.slot),
    rate: clampNumber(baselineSource?.rate, 0, 2, defaults.baseline.rate),
    target: clampNumber(baselineSource?.target, 0, 1.5, defaults.baseline.target)
  };

  const boredomSource = isPlainObject(source.boredom) ? source.boredom : {};
  const boredom = {
    afterMs: clampNumber(boredomSource.afterMs, 1000, 60000, defaults.boredom.afterMs),
    slot: cleanSlotName(boredomSource.slot, baseline.slot),
    magnitudePerSecond: clampNumber(
      boredomSource.magnitudePerSecond,
      0,
      0.5,
      defaults.boredom.magnitudePerSecond
    )
  };

  const ambientSource = isPlainObject(source.ambient) ? source.ambient : {};
  const ambient = {
    idleAfterMs: clampNumber(ambientSource.idleAfterMs, 2000, 60000, defaults.ambient.idleAfterMs),
    samplerMinMs: clampNumber(ambientSource.samplerMinMs, 1000, 30000, defaults.ambient.samplerMinMs),
    samplerMaxMs: clampNumber(ambientSource.samplerMaxMs, 1000, 45000, defaults.ambient.samplerMaxMs),
    distribution: normalizeDistribution(ambientSource.distribution, defaults.ambient.distribution)
  };
  if (ambient.samplerMaxMs < ambient.samplerMinMs) {
    ambient.samplerMaxMs = ambient.samplerMinMs;
  }

  const escalation = { ...defaults.escalation };
  if (isPlainObject(source.escalation)) {
    for (const [from, to] of Object.entries(source.escalation)) {
      if (typeof to === 'string' && to.trim()) escalation[cleanSlotName(from)] = to.trim();
    }
  }

  return {
    tuningVersion: PERSONALITY_TUNING_VERSION,
    decayRates,
    baseline,
    boredom,
    refractoryMs: clampNumber(source.refractoryMs, 0, 10000, defaults.refractoryMs),
    refractoryScale: clampNumber(source.refractoryScale, 0, 1, defaults.refractoryScale),
    preemptThreshold: clampNumber(source.preemptThreshold, 0, 2, defaults.preemptThreshold),
    streakThresholds: normalizeStreakThresholds(source.streakThresholds, defaults.streakThresholds),
    saturationCap: clampNumber(source.saturationCap, 0.5, 3, defaults.saturationCap),
    dwellMs: clampNumber(source.dwellMs, 0, 3000, defaults.dwellMs),
    returnToBaselineDelayMs: clampNumber(
      source.returnToBaselineDelayMs,
      0,
      10000,
      defaults.returnToBaselineDelayMs
    ),
    leadMargin: clampNumber(source.leadMargin, 0, 1, defaults.leadMargin),
    crossfadeMs: clampNumber(source.crossfadeMs, 0, 2000, defaults.crossfadeMs),
    fastCrossfadeMs: clampNumber(source.fastCrossfadeMs, 0, 1000, defaults.fastCrossfadeMs),
    ambient,
    pressure: normalizePressure(source.pressure, defaults.pressure),
    escalation,
    impulseTable: normalizeImpulseTable(source.impulseTable || source.impulses, defaults.impulseTable)
  };
}

function normalizeSlotValue(value) {
  if (Array.isArray(value)) {
    const cleaned = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) cleaned.push(trimmed);
      }
    }
    if (cleaned.length === 0) return null;
    if (cleaned.length === 1) return cleaned[0];
    return cleaned;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function normalizeSlots(rawSlots = null) {
  const result = {};
  if (isPlainObject(rawSlots)) {
    for (const [slot, src] of Object.entries(rawSlots)) {
      if (typeof slot !== 'string' || !slot.trim()) continue;
      result[cleanSlotName(slot)] = normalizeSlotValue(src);
    }
  }
  for (const slot of CANONICAL_EMOTION_SLOTS) {
    if (!Object.prototype.hasOwnProperty.call(result, slot)) result[slot] = null;
  }
  if (!result.idle) result.idle = DEFAULT_CHARACTER_ASSET.webp;
  return result;
}

export function createDefaultCharacter(overrides = null) {
  return normalizeCharacter({
    id: DEFAULT_CHARACTER_ID,
    name: 'Lu',
    slots: {
      idle: DEFAULT_CHARACTER_ASSET.webp,
      amused: null,
      enthralled: null,
      disappointed: null,
      'happy-mocking': null,
      worried: null,
      anger: null,
      victory: null
    },
    personality: DEFAULT_PERSONALITY,
    ...(isPlainObject(overrides) ? overrides : {})
  });
}

export function normalizeCharacter(raw = null) {
  const source = isPlainObject(raw) ? raw : {};
  const id = makeCharacterId(source.id || source.characterId || DEFAULT_CHARACTER_ID);
  const slots = normalizeSlots(source.slots || source.emotions);
  return {
    id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : id,
    slots,
    personality: normalizePersonality(source.personality)
  };
}

export function normalizeCharacterRegistry(raw = null) {
  const source = isPlainObject(raw) ? raw : {};
  const characters = {};
  const rawCharacters = isPlainObject(source.characters) ? source.characters : {};
  for (const [id, character] of Object.entries(rawCharacters)) {
    const normalized = normalizeCharacter({ id, ...character });
    characters[normalized.id] = normalized;
  }
  if (!characters[DEFAULT_CHARACTER_ID]) {
    characters[DEFAULT_CHARACTER_ID] = createDefaultCharacter();
  }
  const selectedId = makeCharacterId(source.selectedId || DEFAULT_CHARACTER_ID);
  return {
    version: CHARACTER_REGISTRY_VERSION,
    selectedId: characters[selectedId] ? selectedId : DEFAULT_CHARACTER_ID,
    characters
  };
}

export function loadCharacterRegistry() {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
      return normalizeCharacterRegistry(null);
    }
    const raw = localStorage.getItem(CHARACTER_REGISTRY_STORAGE_KEY);
    return normalizeCharacterRegistry(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.warn('[characters] Failed to load registry:', error);
    return normalizeCharacterRegistry(null);
  }
}

export function saveCharacterRegistry(registry) {
  const normalized = normalizeCharacterRegistry(registry);
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(CHARACTER_REGISTRY_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch (error) {
    console.error('[characters] Failed to save registry:', error);
  }
  return normalized;
}

export function normalizePersonalityPatch(raw = null) {
  if (!isPlainObject(raw)) return {};
  const patch = {};
  if (isPlainObject(raw.decayRates)) {
    patch.decayRates = {};
    for (const [slot, rate] of Object.entries(raw.decayRates)) {
      const n = Number(rate);
      if (Number.isFinite(n)) patch.decayRates[cleanSlotName(slot)] = clampNumber(n, 0, 5, 0.3);
    }
  }
  const baselineSource = isPlainObject(raw.baseline) ? raw.baseline : raw.baselineDrift;
  if (isPlainObject(baselineSource)) {
    patch.baseline = {};
    if (typeof baselineSource.slot === 'string' && baselineSource.slot.trim()) {
      patch.baseline.slot = baselineSource.slot.trim();
    }
    if (Number.isFinite(Number(baselineSource.rate))) {
      patch.baseline.rate = clampNumber(baselineSource.rate, 0, 2, DEFAULT_PERSONALITY.baseline.rate);
    }
    if (Number.isFinite(Number(baselineSource.target))) {
      patch.baseline.target = clampNumber(baselineSource.target, 0, 1.5, DEFAULT_PERSONALITY.baseline.target);
    }
  }
  if (isPlainObject(raw.boredom)) {
    patch.boredom = {};
    if (typeof raw.boredom.slot === 'string' && raw.boredom.slot.trim()) {
      patch.boredom.slot = raw.boredom.slot.trim();
    }
    if (Number.isFinite(Number(raw.boredom.afterMs))) {
      patch.boredom.afterMs = clampNumber(raw.boredom.afterMs, 1000, 60000, DEFAULT_PERSONALITY.boredom.afterMs);
    }
    if (Number.isFinite(Number(raw.boredom.magnitudePerSecond))) {
      patch.boredom.magnitudePerSecond = clampNumber(
        raw.boredom.magnitudePerSecond,
        0,
        0.5,
        DEFAULT_PERSONALITY.boredom.magnitudePerSecond
      );
    }
    if (Object.keys(patch.boredom).length === 0) delete patch.boredom;
  }
  if (isPlainObject(raw.ambient)) {
    patch.ambient = {};
    for (const key of ['idleAfterMs', 'samplerMinMs', 'samplerMaxMs']) {
      if (Number.isFinite(Number(raw.ambient[key]))) {
        patch.ambient[key] = clampNumber(raw.ambient[key], 1000, 60000, DEFAULT_PERSONALITY.ambient[key]);
      }
    }
    if (isPlainObject(raw.ambient.distribution)) {
      patch.ambient.distribution = normalizeDistribution(raw.ambient.distribution, {});
    }
    if (Object.keys(patch.ambient).length === 0) delete patch.ambient;
  }
  const pressurePatch = normalizePressurePatch(raw.pressure);
  if (pressurePatch) patch.pressure = pressurePatch;
  if (isPlainObject(raw.impulseTable) || isPlainObject(raw.impulses)) {
    patch.impulseTable = {};
    const source = raw.impulseTable || raw.impulses;
    for (const [eventType, row] of Object.entries(source || {})) {
      if (!eventType || !isPlainObject(row)) continue;
      const next = {};
      if (Number.isFinite(Number(row.magnitude))) {
        next.magnitude = clampNumber(row.magnitude, 0, 2, 0.3);
      }
      if (isPlainObject(row.distribution)) {
        next.distribution = normalizeDistribution(row.distribution, {});
      }
      if (typeof row.escalationSlot === 'string' && row.escalationSlot.trim()) {
        next.escalationSlot = row.escalationSlot.trim();
      }
      if (Object.keys(next).length > 0) patch.impulseTable[eventType] = next;
    }
  }
  for (const key of ['refractoryMs', 'refractoryScale', 'preemptThreshold', 'saturationCap', 'dwellMs', 'returnToBaselineDelayMs', 'leadMargin', 'crossfadeMs', 'fastCrossfadeMs']) {
    if (Number.isFinite(Number(raw[key]))) patch[key] = Number(raw[key]);
  }
  if (Array.isArray(raw.streakThresholds)) {
    patch.streakThresholds = normalizeStreakThresholds(raw.streakThresholds, DEFAULT_PERSONALITY.streakThresholds);
  }
  return patch;
}

export function normalizeLevelCharacterAssignment(raw = null) {
  const source = isPlainObject(raw) ? raw : {};
  const characterId = makeCharacterId(source.characterId || source.id || DEFAULT_CHARACTER_ID);
  const assignment = {
    characterId,
    personalityPatch: normalizePersonalityPatch(source.personalityPatch || source.patch)
  };
  if (isPlainObject(source.snapshot)) {
    assignment.snapshot = normalizeCharacter(source.snapshot);
  }
  return assignment;
}

function mergeImpulseTables(base, patch) {
  const result = clone(base) || {};
  for (const [eventType, row] of Object.entries(patch || {})) {
    const previous = result[eventType] || {};
    result[eventType] = {
      ...previous,
      ...row,
      distribution: row.distribution
        ? normalizeDistribution(row.distribution, previous.distribution || { idle: 1 })
        : normalizeDistribution(previous.distribution || { idle: 1 })
    };
  }
  return result;
}

export function mergePersonalityPatch(personality, patch) {
  const base = normalizePersonality(personality);
  const normalizedPatch = normalizePersonalityPatch(patch);
  const merged = clone(base);
  if (normalizedPatch.decayRates) {
    merged.decayRates = { ...merged.decayRates, ...normalizedPatch.decayRates };
  }
  if (normalizedPatch.baseline) {
    merged.baseline = { ...merged.baseline, ...normalizedPatch.baseline };
  }
  if (normalizedPatch.boredom) {
    merged.boredom = { ...merged.boredom, ...normalizedPatch.boredom };
  }
  if (normalizedPatch.ambient) {
    merged.ambient = {
      ...merged.ambient,
      ...normalizedPatch.ambient,
      distribution: normalizedPatch.ambient.distribution
        ? normalizeDistribution(normalizedPatch.ambient.distribution, merged.ambient.distribution)
        : normalizeDistribution(merged.ambient.distribution)
    };
  }
  if (normalizedPatch.pressure) {
    merged.pressure = {
      ...merged.pressure,
      ...normalizedPatch.pressure,
      distribution: normalizedPatch.pressure.distribution
        ? normalizeDistribution(normalizedPatch.pressure.distribution, merged.pressure.distribution)
        : normalizeDistribution(merged.pressure.distribution)
    };
  }
  if (normalizedPatch.impulseTable) {
    merged.impulseTable = mergeImpulseTables(merged.impulseTable, normalizedPatch.impulseTable);
  }
  for (const key of ['refractoryMs', 'refractoryScale', 'preemptThreshold', 'saturationCap', 'dwellMs', 'returnToBaselineDelayMs', 'leadMargin', 'crossfadeMs', 'fastCrossfadeMs']) {
    if (Number.isFinite(normalizedPatch[key])) merged[key] = normalizedPatch[key];
  }
  if (Array.isArray(normalizedPatch.streakThresholds)) {
    merged.streakThresholds = normalizeStreakThresholds(normalizedPatch.streakThresholds, base.streakThresholds);
  }
  return normalizePersonality(merged);
}

export function createCharacterSnapshot(character) {
  return normalizeCharacter(character);
}

export function attachCharacterSnapshotToLevel(level, registry = loadCharacterRegistry()) {
  if (!level || typeof level !== 'object') return level;
  const assignment = normalizeLevelCharacterAssignment(level.character);
  const normalizedRegistry = normalizeCharacterRegistry(registry);
  const existingSnapshot = isPlainObject(level.character?.snapshot)
    ? normalizeCharacter(level.character.snapshot)
    : null;
  let character = normalizedRegistry.characters[assignment.characterId]
    || existingSnapshot
    || normalizedRegistry.characters[DEFAULT_CHARACTER_ID];
  const legacySrc = level?.visuals?.slots?.character?.customSrc;
  if (
    typeof legacySrc === 'string'
    && legacySrc.trim()
    && !existingSnapshot
    && assignment.characterId === DEFAULT_CHARACTER_ID
  ) {
    character = normalizeCharacter(character);
    character.slots.idle = legacySrc.trim();
  }
  level.character = {
    ...assignment,
    snapshot: createCharacterSnapshot(character)
  };
  return level;
}

export function resolveCharacterForLevel(level, registry = loadCharacterRegistry()) {
  const normalizedRegistry = normalizeCharacterRegistry(registry);
  const assignment = normalizeLevelCharacterAssignment(level?.character);
  const snapshot = isPlainObject(level?.character?.snapshot)
    ? normalizeCharacter(level.character.snapshot)
    : null;
  const registryCharacter = normalizedRegistry.characters[assignment.characterId] || null;
  let character = registryCharacter || snapshot || normalizedRegistry.characters[DEFAULT_CHARACTER_ID];
  character = normalizeCharacter(character);

  const legacySrc = level?.visuals?.slots?.character?.customSrc;
  if (
    typeof legacySrc === 'string'
    && legacySrc.trim()
    && !registryCharacter
    && !snapshot
    && assignment.characterId === DEFAULT_CHARACTER_ID
  ) {
    character.slots.idle = legacySrc.trim();
  }
  character.personality = mergePersonalityPatch(character.personality, assignment.personalityPatch);
  return character;
}

function pickFromSlotValue(value) {
  if (Array.isArray(value)) {
    const cleaned = value.filter(v => typeof v === 'string' && v.trim());
    if (cleaned.length === 0) return '';
    return cleaned[Math.floor(Math.random() * cleaned.length)];
  }
  if (typeof value === 'string' && value.trim()) return value;
  return '';
}

export function getCharacterSlotSources(character, slotName = 'idle') {
  const normalized = normalizeCharacter(character);
  const slot = cleanSlotName(slotName);
  const value = normalized.slots[slot];
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v.trim());
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

export function getCharacterSlotSource(character, slotName = 'idle') {
  const normalized = normalizeCharacter(character);
  const slot = cleanSlotName(slotName);
  return pickFromSlotValue(normalized.slots[slot])
    || pickFromSlotValue(normalized.slots.idle)
    || DEFAULT_CHARACTER_ASSET.webp;
}

export function getCharacterSlotSourceAt(character, slotName, index) {
  const sources = getCharacterSlotSources(character, slotName);
  if (sources.length === 0) return '';
  const safeIndex = ((Number(index) || 0) % sources.length + sources.length) % sources.length;
  return sources[safeIndex];
}

export function getLevelCharacterPortraitSources(level, registry = loadCharacterRegistry(), preferredSlot = 'idle') {
  const character = resolveCharacterForLevel(level, registry);
  const preferred = getCharacterSlotSource(character, preferredSlot);
  const idle = getCharacterSlotSource(character, 'idle');
  const sources = [];
  if (preferred) sources.push(preferred);
  if (idle && idle !== preferred) sources.push(idle);
  sources.push(DEFAULT_CHARACTER_ASSET.webp, DEFAULT_CHARACTER_ASSET.png);
  return sources;
}

export function readCharacterImageFile(file, maxSize = 512) {
  return new Promise(resolve => {
    if (!file) {
      resolve(null);
      return;
    }
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      const reader = new FileReader();
      reader.onload = event => resolve(event.target.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > maxSize || height > maxSize) {
        const scale = maxSize / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      try {
        resolve(canvas.toDataURL('image/webp', 0.82));
      } catch {
        resolve(canvas.toDataURL('image/png'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      const reader = new FileReader();
      reader.onload = event => resolve(event.target.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    img.src = objectUrl;
  });
}
