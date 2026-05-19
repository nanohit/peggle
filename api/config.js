import Redis from 'ioredis';
import fs from 'fs/promises';
import {
  createMirrorEnvelope,
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
    console.warn('[api/config] Redis get failed:', error?.message || error);
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

const CONFIG_COLLECTION = 'config';

async function getMirroredValue(collection, name, key) {
  const [redisValue, redisMeta, driveRecord] = await Promise.all([
    kvGet(key).catch(error => {
      console.warn('[api/config] Redis read failed:', key, error?.message || error);
      return null;
    }),
    kvGet(mirrorMetaKey(key)).catch(error => {
      console.warn('[api/config] Redis mirror meta read failed:', key, error?.message || error);
      return null;
    }),
    readDriveRecord(collection, name)
  ]);
  const selected = selectMirroredValue({ redisValue, redisMeta, driveRecord });
  return selected.found ? selected.value : null;
}

async function writeMirroredValue(collection, name, key, value) {
  const envelope = createMirrorEnvelope({ key, collection, name, value });
  let redisOk = false;
  let driveOk = false;

  try {
    await kvSet(key, value);
    await kvSet(mirrorMetaKey(key), mirrorMetaFromEnvelope(envelope));
    redisOk = true;
  } catch (error) {
    console.warn('[api/config] Redis mirror write failed:', key, error?.message || error);
  }

  driveOk = await writeDriveRecord(collection, name, envelope);
  return { ok: redisOk || driveOk, redisOk, driveOk, envelope };
}

async function readStaticJson(path) {
  try {
    const raw = await fs.readFile(new URL(path, import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getStaticConfigValue(key) {
  const config = await readStaticJson('../data/player/config.json');
  if (!config || typeof config !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(config, key)) return config[key];
  if (key === 'primaryCampaign' && typeof config.primary === 'string') return config.primary;
  return null;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
  try {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    const { key } = req.query;

    if (req.method === 'GET') {
      if (!key) return res.status(400).json({ error: 'key required' });
      const value = await getMirroredValue(CONFIG_COLLECTION, key, `config:${key}`) ?? await getStaticConfigValue(key);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ key, value });
    }

    if (req.method === 'POST') {
      const { key: bodyKey, value } = req.body;
      const k = bodyKey || key;
      if (!k) return res.status(400).json({ error: 'key required' });
      const configWrite = await writeMirroredValue(CONFIG_COLLECTION, k, `config:${k}`, value);
      if (!configWrite.ok) throw new Error(`Failed to persist config:${k} to Redis or Drive`);
      return res.json({ ok: true, storage: { redis: configWrite.redisOk, drive: configWrite.driveOk } });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/config]', e);
    res.status(500).json({ error: 'Internal error' });
  }
}
