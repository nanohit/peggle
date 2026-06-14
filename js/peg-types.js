const PEG_TYPE_ALIASES = Object.freeze({
  lime: 'green'
});

export function normalizePegType(type, fallback = 'blue') {
  const value = typeof type === 'string' ? type.trim() : '';
  if (!value) return fallback;
  return PEG_TYPE_ALIASES[value] || value;
}
