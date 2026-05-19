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
    console.warn('[api/characters] Redis get failed:', error?.message || error);
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

const REGISTRY_KEY = 'character:__registry';
const CHARACTER_COLLECTION = 'characters';

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
    console.warn('[api/characters] Redis mirror write failed:', key, error?.message || error);
  }

  driveOk = await writeDriveRecord(collection, name, envelope);
  return { ok: redisOk || driveOk, redisOk, driveOk, envelope };
}

async function readStaticCharacterRegistry() {
  try {
    const raw = await fs.readFile(new URL('../data/player/characters.json', import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
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
      const registry = await getMirroredValue(CHARACTER_COLLECTION, '__registry', REGISTRY_KEY) || await readStaticCharacterRegistry();
      if (!registry) return res.status(404).json({ error: 'No registry stored' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(registry);
    }

    if (req.method === 'POST') {
      const { data } = req.body || {};
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'data required' });
      }
      const registryWrite = await writeMirroredValue(CHARACTER_COLLECTION, '__registry', REGISTRY_KEY, data);
      if (!registryWrite.ok) throw new Error('Failed to persist character registry to Redis or Drive');
      return res.json({ ok: true, storage: { redis: registryWrite.redisOk, drive: registryWrite.driveOk } });
    }

    if (req.method === 'DELETE') {
      const registryDelete = await writeMirroredValue(CHARACTER_COLLECTION, '__registry', REGISTRY_KEY, null, {
        deleted: true,
        source: 'api-delete'
      });
      if (!registryDelete.ok) throw new Error('Failed to delete character registry from Redis or Drive');
      return res.json({ ok: true, storage: { redis: registryDelete.redisOk, drive: registryDelete.driveOk } });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/characters]', e);
    res.status(500).json({ error: 'Internal error' });
  }
}

// Character payloads include base64 emotion image data, so the body can be
// several MB. Vercel's default JSON body parser caps at ~1 MB; bump it.
export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' }
  }
};
