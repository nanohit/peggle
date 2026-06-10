import fs from 'node:fs/promises';
import path from 'node:path';
import {
  keyForAsset,
  parseDataImageUrl
} from '../server/asset-utils.js';

const DEFAULT_API_BASE = 'https://alea.sh/api';
const DEFAULT_KEY_PREFIX = 'level-assets';
const DEFAULT_COLLECTIONS = ['levels', 'characters', 'campaigns'];

function parseArgs(argv) {
  const args = {
    apiBase: process.env.ALEA_MIGRATION_API_BASE || DEFAULT_API_BASE,
    backupDir: '',
    collections: [...DEFAULT_COLLECTIONS],
    write: false,
    limit: 0,
    keyPrefix: process.env.ASSET_KEY_PREFIX || DEFAULT_KEY_PREFIX,
    cdnBaseUrl: process.env.BUNNY_CDN_BASE_URL || 'https://alea-assets.b-cdn.net'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const value = inlineValue ?? next;
    const consumedNext = inlineValue == null;
    if (flag === '--api-base' && value) args.apiBase = value.replace(/\/$/, ''), i += consumedNext ? 1 : 0;
    else if (flag === '--backup-dir' && value) args.backupDir = value, i += consumedNext ? 1 : 0;
    else if (flag === '--collections' && value) args.collections = value.split(',').map(v => v.trim()).filter(Boolean), i += consumedNext ? 1 : 0;
    else if (flag === '--limit' && value) args.limit = Math.max(0, Math.round(Number(value) || 0)), i += consumedNext ? 1 : 0;
    else if (flag === '--key-prefix' && value) args.keyPrefix = value, i += consumedNext ? 1 : 0;
    else if (flag === '--cdn-base-url' && value) args.cdnBaseUrl = value.replace(/\/$/, ''), i += consumedNext ? 1 : 0;
    else if (arg === '--write') args.write = true;
    else if (arg === '--dry-run') args.write = false;
  }
  if (!args.backupDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.backupDir = path.join('backups', `asset-migration-${stamp}`);
  }
  return args;
}

function safeFileName(name) {
  return encodeURIComponent(String(name || 'unnamed')).replace(/%/g, '_');
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${options.method || 'GET'} ${url} returned non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function getPath(target, parts) {
  let cursor = target;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(target, parts, value) {
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cursor?.[part] || typeof cursor[part] !== 'object') return false;
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return true;
}

function assetRefForDataUrl(dataUrl, role, args) {
  const { buffer, contentType } = parseDataImageUrl(dataUrl);
  const { hash, key } = keyForAsset({
    buffer,
    contentType,
    role,
    keyPrefix: args.keyPrefix
  });
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const primaryUrl = args.cdnBaseUrl ? `${args.cdnBaseUrl}/${encodedKey}` : '';
  const fallbackUrl = `/api/assets?${new URLSearchParams({ key }).toString()}`;
  return {
    kind: 'asset',
    storageVersion: 1,
    key,
    hash,
    bytes: buffer.length,
    contentType,
    ...(primaryUrl ? { url: primaryUrl, primaryUrl } : {}),
    fallbackUrl
  };
}

async function uploadDataUrl(dataUrl, role, context, state) {
  const cached = state.cache.get(dataUrl);
  if (cached) {
    state.summary.reused += 1;
    return cached;
  }

  const upload = await fetchJson(`${state.args.apiBase}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, role, keyPrefix: state.args.keyPrefix })
  });
  if (!upload?.ok || !upload.asset) {
    throw new Error(`asset upload failed for ${context}: ${JSON.stringify(upload).slice(0, 300)}`);
  }
  state.cache.set(dataUrl, upload.asset);
  state.summary.uploaded += 1;
  return upload.asset;
}

async function migrateDataUrl(dataUrl, role, context, state) {
  if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) return dataUrl;

  const preview = assetRefForDataUrl(dataUrl, role, state.args);
  const asset = state.args.write
    ? await uploadDataUrl(dataUrl, role, context, state)
    : preview;

  state.summary.refs += 1;
  state.summary.bytes += preview.bytes || 0;
  state.summary.uniqueKeys.add(preview.key);
  state.changes.push({
    collection: state.collection,
    name: state.name,
    path: context,
    role,
    key: preview.key,
    bytes: preview.bytes,
    uploaded: state.args.write
  });
  return asset;
}

async function migrateField(target, parts, role, state) {
  const current = getPath(target, parts);
  const next = await migrateDataUrl(current, role, parts.join('.'), state);
  if (next !== current) setPath(target, parts, next);
}

async function migrateLevel(level, state) {
  await migrateField(level, ['visuals', 'background', 'image'], 'backgrounds', state);
  await migrateField(level, ['visuals', 'background', 'progressionImage'], 'backgrounds', state);
  await migrateField(level, ['survival', 'background', 'image'], 'survival-backgrounds', state);

  const slots = level.visuals?.slots;
  if (slots && typeof slots === 'object') {
    for (const [slotId, slot] of Object.entries(slots)) {
      if (!slot || typeof slot !== 'object') continue;
      await migrateField(level, ['visuals', 'slots', slotId, 'customSrc'], 'level-slots', state);
    }
  }
}

async function migrateSlotValue(value, role, context, state) {
  if (Array.isArray(value)) {
    const next = [];
    let changed = false;
    for (let i = 0; i < value.length; i++) {
      const migrated = await migrateDataUrl(value[i], role, `${context}[${i}]`, state);
      next.push(migrated);
      changed = changed || migrated !== value[i];
    }
    return changed ? next : value;
  }
  return await migrateDataUrl(value, role, context, state);
}

async function migrateCharacters(registry, state) {
  const characters = registry.characters && typeof registry.characters === 'object' ? registry.characters : {};
  for (const [characterId, character] of Object.entries(characters)) {
    if (!character || typeof character !== 'object') continue;
    const slots = character.slots && typeof character.slots === 'object' ? character.slots : {};
    for (const [slotName, value] of Object.entries(slots)) {
      const next = await migrateSlotValue(value, 'characters', `characters.${characterId}.slots.${slotName}`, state);
      if (next !== value) slots[slotName] = next;
    }
    const portraits = character.pvpPortraits && typeof character.pvpPortraits === 'object' ? character.pvpPortraits : {};
    for (const [slotName, value] of Object.entries(portraits)) {
      const next = await migrateSlotValue(value, 'pvp-portraits', `characters.${characterId}.pvpPortraits.${slotName}`, state);
      if (next !== value) portraits[slotName] = next;
    }
  }
}

async function migrateAnyDataImages(value, role, context, state) {
  if (typeof value === 'string') {
    return await migrateDataUrl(value, role, context, state);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = [];
    for (let i = 0; i < value.length; i++) {
      const migrated = await migrateAnyDataImages(value[i], role, `${context}[${i}]`, state);
      next.push(migrated);
      changed = changed || migrated !== value[i];
    }
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const migrated = await migrateAnyDataImages(child, role, context ? `${context}.${key}` : key, state);
      if (migrated !== child) value[key] = migrated;
    }
  }
  return value;
}

function createState(args, collection, name, summary, changes, cache) {
  return {
    args,
    collection,
    name,
    summary,
    changes,
    cache
  };
}

async function migrateLevelCollection(args, summary, changes, cache) {
  const index = await fetchJson(`${args.apiBase}/levels`);
  const names = (Array.isArray(index.names) ? index.names : []).slice(0, args.limit || undefined);
  const migrated = [];
  for (const name of names) {
    const original = await fetchJson(`${args.apiBase}/levels?${new URLSearchParams({ name }).toString()}`);
    const next = cloneJson(original);
    const before = changes.length;
    await migrateLevel(next, createState(args, 'levels', name, summary, changes, cache));
    await writeJson(path.join(args.backupDir, 'originals', 'levels', `${safeFileName(name)}.json`), original);
    if (changes.length > before) {
      migrated.push(name);
      await writeJson(path.join(args.backupDir, 'migrated', 'levels', `${safeFileName(name)}.json`), next);
      if (args.write) {
        await fetchJson(`${args.apiBase}/levels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, data: next })
        });
        summary.writes += 1;
      }
    }
  }
  return { scanned: names.length, migrated };
}

async function migrateCharacterCollection(args, summary, changes, cache) {
  const original = await fetchJson(`${args.apiBase}/characters`);
  const next = cloneJson(original);
  const before = changes.length;
  await migrateCharacters(next, createState(args, 'characters', '__registry', summary, changes, cache));
  await writeJson(path.join(args.backupDir, 'originals', 'characters', '__registry.json'), original);
  const changed = changes.length > before;
  if (changed) {
    await writeJson(path.join(args.backupDir, 'migrated', 'characters', '__registry.json'), next);
    if (args.write) {
      await fetchJson(`${args.apiBase}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: next })
      });
      summary.writes += 1;
    }
  }
  return { scanned: 1, migrated: changed ? ['__registry'] : [] };
}

async function migrateCampaignCollection(args, summary, changes, cache) {
  const index = await fetchJson(`${args.apiBase}/campaigns`);
  const names = (Array.isArray(index.campaigns) ? index.campaigns : [])
    .map(item => typeof item === 'string' ? item : item?.name)
    .filter(Boolean)
    .slice(0, args.limit || undefined);
  const migrated = [];
  for (const name of names) {
    const original = await fetchJson(`${args.apiBase}/campaigns?${new URLSearchParams({ name }).toString()}`);
    const next = cloneJson(original);
    const before = changes.length;
    await migrateAnyDataImages(next, 'campaign-assets', '', createState(args, 'campaigns', name, summary, changes, cache));
    await writeJson(path.join(args.backupDir, 'originals', 'campaigns', `${safeFileName(name)}.json`), original);
    if (changes.length > before) {
      migrated.push(name);
      await writeJson(path.join(args.backupDir, 'migrated', 'campaigns', `${safeFileName(name)}.json`), next);
      if (args.write) {
        await fetchJson(`${args.apiBase}/campaigns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, data: next })
        });
        summary.writes += 1;
      }
    }
  }
  return { scanned: names.length, migrated };
}

const args = parseArgs(process.argv.slice(2));
const summary = {
  mode: args.write ? 'write' : 'dry-run',
  apiBase: args.apiBase,
  backupDir: args.backupDir,
  refs: 0,
  bytes: 0,
  uploaded: 0,
  reused: 0,
  writes: 0,
  uniqueKeys: new Set()
};
const changes = [];
const cache = new Map();
const collections = {};

if (args.collections.includes('levels')) {
  collections.levels = await migrateLevelCollection(args, summary, changes, cache);
}
if (args.collections.includes('characters')) {
  collections.characters = await migrateCharacterCollection(args, summary, changes, cache);
}
if (args.collections.includes('campaigns')) {
  collections.campaigns = await migrateCampaignCollection(args, summary, changes, cache);
}

const report = {
  mode: summary.mode,
  apiBase: summary.apiBase,
  backupDir: summary.backupDir,
  collections,
  totals: {
    refs: summary.refs,
    uniqueAssets: summary.uniqueKeys.size,
    dataUrlBytes: summary.bytes,
    uploaded: summary.uploaded,
    reused: summary.reused,
    writes: summary.writes
  },
  changes
};
await writeJson(path.join(args.backupDir, 'report.json'), report);
console.log(JSON.stringify(report, null, 2));
