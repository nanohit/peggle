import { Utils } from './utils.js';

export const DIALOGUE_VERSION = 1;
export const DIALOGUE_DEFAULT_TIMEOUT_MS = 15000;
export const DIALOGUE_TRIGGER_TYPES = ['levelStart', 'spinReward', 'pegProgress', 'performanceCap30'];
export const DIALOGUE_DEFAULT_SEGMENT_COLOR = '#ffffff';
export const DIALOGUE_DEFAULT_TEXT_SCALE = 0.65;
export const DIALOGUE_EMOTION_MODES = ['override', 'impulse'];
export const DIALOGUE_DEFAULT_IMPULSE_MAGNITUDE = 0.55;

function clampRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeSegment(raw) {
  if (typeof raw === 'string') {
    return {
      id: Utils.generateId(),
      text: raw,
      color: DIALOGUE_DEFAULT_SEGMENT_COLOR
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const color = typeof raw.color === 'string' && raw.color.trim()
    ? raw.color.trim()
    : DIALOGUE_DEFAULT_SEGMENT_COLOR;
  if (!text && color === DIALOGUE_DEFAULT_SEGMENT_COLOR && !(typeof raw.id === 'string' && raw.id)) {
    return null;
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : Utils.generateId(),
    text,
    color
  };
}

function normalizeLocale(raw) {
  const segments = [];
  if (Array.isArray(raw?.segments)) {
    for (const segment of raw.segments) {
      const normalized = normalizeSegment(segment);
      if (normalized) segments.push(normalized);
    }
  } else if (Array.isArray(raw)) {
    for (const segment of raw) {
      const normalized = normalizeSegment(segment);
      if (normalized) segments.push(normalized);
    }
  } else if (typeof raw === 'string') {
    const normalized = normalizeSegment(raw);
    if (normalized) segments.push(normalized);
  }
  return { segments };
}

function normalizeTrigger(raw) {
  const type = DIALOGUE_TRIGGER_TYPES.includes(raw?.type) ? raw.type : 'levelStart';
  const progressPercent = Number.isFinite(raw?.progressPercent)
    ? Math.max(0, Math.min(100, raw.progressPercent))
    : 50;
  const perkIds = Array.isArray(raw?.perkIds)
    ? Array.from(new Set(raw.perkIds.filter(id => typeof id === 'string' && id)))
    : [];
  return { type, progressPercent, perkIds };
}

function normalizeDismissOn(raw) {
  return {
    shot: raw?.shot !== false,
    spin: raw?.spin !== false
  };
}

function normalizePlacement(raw) {
  return {
    anchor: 'portraitTop',
    offsetY: Number.isFinite(raw?.offsetY) ? raw.offsetY : 0,
    textScale: clampRange(raw?.textScale, 0.5, 1.8, DIALOGUE_DEFAULT_TEXT_SCALE)
  };
}

export function clampDialogueTimeoutMs(value) {
  if (!Number.isFinite(value)) return DIALOGUE_DEFAULT_TIMEOUT_MS;
  return Math.max(0, Math.min(120000, Math.round(value)));
}

export function clampDialogueEmotionMagnitude(value) {
  if (!Number.isFinite(value)) return DIALOGUE_DEFAULT_IMPULSE_MAGNITUDE;
  return Math.max(0, Math.min(2, Number(value)));
}

export function createDialogueEntry(overrides = null) {
  const trigger = normalizeTrigger(overrides?.trigger);
  const emotion = typeof overrides?.emotion === 'string' && overrides.emotion.trim()
    ? overrides.emotion.trim()
    : '';
  const mode = DIALOGUE_EMOTION_MODES.includes(overrides?.mode)
    ? overrides.mode
    : (emotion ? 'override' : '');
  return {
    id: typeof overrides?.id === 'string' && overrides.id ? overrides.id : Utils.generateId(),
    title: typeof overrides?.title === 'string' && overrides.title.trim()
      ? overrides.title.trim()
      : 'Dialogue',
    enabled: overrides?.enabled !== false,
    once: overrides?.once !== false,
    timeoutMs: clampDialogueTimeoutMs(
      Number.isFinite(overrides?.timeoutMs) ? overrides.timeoutMs : DIALOGUE_DEFAULT_TIMEOUT_MS
    ),
    dismissOn: normalizeDismissOn(overrides?.dismissOn),
    trigger,
    emotion,
    mode,
    emotionMagnitude: clampDialogueEmotionMagnitude(
      Number.isFinite(overrides?.emotionMagnitude) ? overrides.emotionMagnitude : DIALOGUE_DEFAULT_IMPULSE_MAGNITUDE
    ),
    placement: normalizePlacement(overrides?.placement),
    content: {
      ru: normalizeLocale(overrides?.content?.ru),
      en: normalizeLocale(overrides?.content?.en)
    }
  };
}

export function normalizeDialogueEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createDialogueEntry();
  }
  return createDialogueEntry(raw);
}

export function normalizeDialogueConfig(raw) {
  const entries = Array.isArray(raw?.entries)
    ? raw.entries.map(entry => normalizeDialogueEntry(entry)).filter(Boolean)
    : [];
  return {
    version: DIALOGUE_VERSION,
    entries
  };
}

export function getDialogueContentForLanguage(entry, preferredLanguage = 'ru') {
  const preferred = preferredLanguage === 'en' ? 'en' : 'ru';
  const preferredLocale = entry?.content?.[preferred];
  if (preferredLocale?.segments?.length) {
    return { language: preferred, locale: preferredLocale };
  }
  const fallbackLanguage = preferred === 'en' ? 'ru' : 'en';
  const fallbackLocale = entry?.content?.[fallbackLanguage];
  if (fallbackLocale?.segments?.length) {
    return { language: fallbackLanguage, locale: fallbackLocale };
  }
  return { language: preferred, locale: { segments: [] } };
}

export function hasDialogueLocaleContent(locale) {
  return !!(locale && Array.isArray(locale.segments) && locale.segments.some(segment => segment.text));
}
