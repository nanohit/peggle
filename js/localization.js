export const LANGUAGE_STORAGE_KEY = 'peggle_language';
export const SUPPORTED_LANGUAGES = ['ru', 'en'];

export const PAUSE_COPY = {
  ru: {
    pauseTitle: 'Пауза',
    confirmShootHint: 'Второе нажатие\nдля выстрела',
    languageLabel: 'Язык'
  },
  en: {
    pauseTitle: 'Pause',
    confirmShootHint: 'Second tap\nto shoot',
    languageLabel: 'Language'
  }
};

export function normalizeLanguage(value) {
  return value === 'en' ? 'en' : 'ru';
}

export function getStoredLanguage() {
  try {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return 'ru';
  }
}

export function setStoredLanguage(language) {
  const normalized = normalizeLanguage(language);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures.
  }
  return normalized;
}

export function getPauseCopy(language) {
  return PAUSE_COPY[normalizeLanguage(language)] || PAUSE_COPY.ru;
}
