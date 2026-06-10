import { api } from './api.js';
import { isDataImageUrl } from './image-compression.js';
import { isAssetImageSource } from './asset-ref.js';

function makeReport() {
  return {
    changed: false,
    uploaded: 0,
    reused: 0,
    failed: 0,
    skipped: 0,
    errors: []
  };
}

function mergeReport(target, source) {
  target.changed = target.changed || source.changed;
  target.uploaded += source.uploaded || 0;
  target.reused += source.reused || 0;
  target.failed += source.failed || 0;
  target.skipped += source.skipped || 0;
  if (Array.isArray(source.errors)) target.errors.push(...source.errors);
  return target;
}

function getPath(target, path) {
  let cursor = target;
  for (const part of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(target, path, value) {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (!cursor?.[part] || typeof cursor[part] !== 'object') return false;
    cursor = cursor[part];
  }
  cursor[path[path.length - 1]] = value;
  return true;
}

async function uploadDataUrl(dataUrl, role, context, options) {
  const cache = options.cache || (options.cache = new Map());
  const cached = cache.get(dataUrl);
  if (cached) {
    return { asset: cached, reused: true };
  }

  const result = await (options.uploadAsset || api.uploadAsset)(dataUrl, { role });
  if (!result?.ok || !result.asset) {
    throw new Error(`Asset upload failed for ${context}`);
  }
  cache.set(dataUrl, result.asset);
  return { asset: result.asset, reused: false };
}

async function externalizeDataUrlValue(value, role, context, report, options) {
  if (isDataImageUrl(value)) {
    try {
      const { asset, reused } = await uploadDataUrl(value, role, context, options);
      report.changed = true;
      if (reused) report.reused += 1;
      else report.uploaded += 1;
      return asset;
    } catch (error) {
      report.failed += 1;
      report.errors.push({ context, error: error?.message || String(error) });
      return value;
    }
  }
  if (isAssetImageSource(value)) {
    report.skipped += 1;
  }
  return value;
}

async function externalizePath(target, path, role, report, options) {
  const value = getPath(target, path);
  if (value == null) return;
  const next = await externalizeDataUrlValue(value, role, path.join('.'), report, options);
  if (next !== value) setPath(target, path, next);
}

async function externalizeSlotValue(value, role, context, report, options) {
  if (Array.isArray(value)) {
    const next = [];
    let changed = false;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const replacement = await externalizeDataUrlValue(item, role, `${context}[${i}]`, report, options);
      next.push(replacement);
      changed = changed || replacement !== item;
    }
    return changed ? next : value;
  }
  return await externalizeDataUrlValue(value, role, context, report, options);
}

export async function externalizeLevelImages(level, options = {}) {
  const report = makeReport();
  if (!level || typeof level !== 'object') return { data: level, report };

  await externalizePath(level, ['visuals', 'background', 'image'], 'backgrounds', report, options);
  await externalizePath(level, ['visuals', 'background', 'progressionImage'], 'backgrounds', report, options);
  await externalizePath(level, ['survival', 'background', 'image'], 'survival-backgrounds', report, options);

  const slots = level.visuals?.slots;
  if (slots && typeof slots === 'object') {
    for (const [slotId, slot] of Object.entries(slots)) {
      if (!slot || typeof slot !== 'object') continue;
      const next = await externalizeSlotValue(slot.customSrc, 'level-slots', `visuals.slots.${slotId}.customSrc`, report, options);
      if (next !== slot.customSrc) slot.customSrc = next;
    }
  }

  return { data: level, report };
}

export async function externalizeCharacterRegistryImages(registry, options = {}) {
  const report = makeReport();
  if (!registry || typeof registry !== 'object') return { data: registry, report };
  const characters = registry.characters && typeof registry.characters === 'object' ? registry.characters : {};

  for (const [characterId, character] of Object.entries(characters)) {
    if (!character || typeof character !== 'object') continue;
    const slots = character.slots && typeof character.slots === 'object' ? character.slots : {};
    for (const [slotName, value] of Object.entries(slots)) {
      const next = await externalizeSlotValue(value, 'characters', `characters.${characterId}.slots.${slotName}`, report, options);
      if (next !== value) slots[slotName] = next;
    }

    const portraits = character.pvpPortraits && typeof character.pvpPortraits === 'object' ? character.pvpPortraits : {};
    for (const [slotName, value] of Object.entries(portraits)) {
      const next = await externalizeSlotValue(value, 'pvp-portraits', `characters.${characterId}.pvpPortraits.${slotName}`, report, options);
      if (next !== value) portraits[slotName] = next;
    }
  }

  return { data: registry, report };
}

export function combineExternalizeReports(...reports) {
  return reports.filter(Boolean).reduce((acc, report) => mergeReport(acc, report), makeReport());
}
