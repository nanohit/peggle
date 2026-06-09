import Redis from 'ioredis';
import fs from 'fs/promises';
import {
  createMirrorEnvelope,
  isDriveRestoreMode,
  mirrorMetaFromEnvelope,
  mirrorMetaKey,
  readDriveRecord,
  selectMirroredValue,
  writeDriveRecord
} from './drive-store.js';
import { setPlayerAwareCache } from './player-cache.js';

let redis;
function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

async function kvGet(key) {
  const client = getRedis();
  if (!client) return null;
  let raw;
  try {
    raw = await client.get(key);
  } catch (error) {
    console.warn('[api/levels] Redis get failed:', error?.message || error);
    return null;
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function kvSet(key, value) {
  const client = getRedis();
  if (!client) throw new Error('REDIS_URL is not configured');
  await client.set(key, JSON.stringify(value));
}

async function kvDel(key) {
  const client = getRedis();
  if (!client) throw new Error('REDIS_URL is not configured');
  await client.del(key);
}

const INDEX_KEY = 'level:__index';
const LEVEL_COLLECTION = 'levels';

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function sanitizeLevelForPlayer(level) {
  const next = cloneJson(level);
  const snapshot = next?.character?.snapshot;
  if (snapshot && typeof snapshot === 'object') {
    delete snapshot.slots;
    delete snapshot.emotions;
  }
  return next;
}

async function getMirroredValue(collection, name, key) {
  const redisValue = await kvGet(key);
  if (redisValue != null && !isDriveRestoreMode()) return redisValue;

  const redisMeta = await kvGet(mirrorMetaKey(key));
  if (redisValue == null && redisMeta?.deleted === true && !isDriveRestoreMode()) return null;

  const driveRecord = await readDriveRecord(collection, name);
  const selected = selectMirroredValue({ redisValue, redisMeta, driveRecord });
  return selected.found ? selected.value : null;
}

async function writeMirroredValue(collection, name, key, value, { deleted = false, source = 'api-write' } = {}) {
  const envelope = createMirrorEnvelope({ key, collection, name, value, deleted, source });
  let redisOk = false;
  let driveOk = false;

  try {
    if (deleted) {
      await kvDel(key);
    } else {
      await kvSet(key, value);
    }
    await kvSet(mirrorMetaKey(key), mirrorMetaFromEnvelope(envelope));
    redisOk = true;
  } catch (error) {
    console.warn('[api/levels] Redis mirror write failed:', key, error?.message || error);
  }

  driveOk = await writeDriveRecord(collection, name, envelope);
  return { ok: redisOk || driveOk, redisOk, driveOk, envelope };
}

function staticNamePath(name) {
  return encodeURIComponent(name);
}

function safeName(name) {
  return (name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function readStaticJson(path) {
  try {
    const raw = await fs.readFile(new URL(path, import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getStaticLevel(name) {
  const data = await readStaticJson(`../data/player/levels/${staticNamePath(name)}.json`);
  if (data) return data;
  try {
    const entries = await fs.readdir(new URL('../data/player/levels/', import.meta.url), { withFileTypes: true });
    const match = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => decodeURIComponent(entry.name.replace(/\.json$/, '')))
      .find(levelName => safeName(levelName) === name);
    if (match) return await readStaticJson(`../data/player/levels/${staticNamePath(match)}.json`);
  } catch { /* static level directory unavailable */ }
  return null;
}

async function getStaticLevelNames() {
  try {
    const entries = await fs.readdir(new URL('../data/player/levels/', import.meta.url), { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => decodeURIComponent(entry.name.replace(/\.json$/, '')));
  } catch {
    const primary = await readStaticJson('../data/player/primary.json');
    if (!Array.isArray(primary?.levels)) return [];
    return primary.levels
      .map((level, index) => level?.name || String(index + 1))
      .filter(Boolean);
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
  try {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET') {
      setPlayerAwareCache(req, res);
      const { name } = req.query;
      if (!name) {
        const remoteNames = (await getMirroredValue(LEVEL_COLLECTION, '__index', INDEX_KEY)) || [];
        const names = [...new Set([...remoteNames, ...(await getStaticLevelNames())])].sort();
        return res.json({ names });
      }
      const data = await getMirroredValue(LEVEL_COLLECTION, name, `level:${name}`) || await getStaticLevel(name);
      if (!data) return res.status(404).json({ error: 'Not found' });
      return res.json(sanitizeLevelForPlayer(data));
    }

    if (req.method === 'POST') {
      const { name, data } = req.body;
      if (!name || !data) return res.status(400).json({ error: 'name and data required' });

      const stored = sanitizeLevelForPlayer(data);
      const itemWrite = await writeMirroredValue(LEVEL_COLLECTION, name, `level:${name}`, stored);
      if (!itemWrite.ok) throw new Error(`Failed to persist level:${name} to Redis or Drive`);

      const names = (await getMirroredValue(LEVEL_COLLECTION, '__index', INDEX_KEY)) || [];
      if (!names.includes(name)) {
        names.push(name);
        names.sort();
        const indexWrite = await writeMirroredValue(LEVEL_COLLECTION, '__index', INDEX_KEY, names);
        if (!indexWrite.ok) console.warn('[api/levels] Failed to update mirrored index after saving:', name);
      }

      return res.json({ ok: true, storage: { redis: itemWrite.redisOk, drive: itemWrite.driveOk } });
    }

    if (req.method === 'DELETE') {
      const { name } = req.query;
      if (!name) return res.status(400).json({ error: 'name required' });

      const itemDelete = await writeMirroredValue(LEVEL_COLLECTION, name, `level:${name}`, null, {
        deleted: true,
        source: 'api-delete'
      });
      if (!itemDelete.ok) throw new Error(`Failed to delete level:${name} from Redis or Drive`);

      const names = (await getMirroredValue(LEVEL_COLLECTION, '__index', INDEX_KEY)) || [];
      const filtered = names.filter(n => n !== name);
      const indexWrite = await writeMirroredValue(LEVEL_COLLECTION, '__index', INDEX_KEY, filtered, {
        source: 'api-delete'
      });
      if (!indexWrite.ok) console.warn('[api/levels] Failed to update mirrored index after deleting:', name);

      return res.json({ ok: true, storage: { redis: itemDelete.redisOk, drive: itemDelete.driveOk } });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/levels]', e);
    res.status(500).json({ error: 'Internal error' });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' }
  }
};
