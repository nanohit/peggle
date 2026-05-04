import Redis from 'ioredis';
import fs from 'fs/promises';

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
      const value = await kvGet(`config:${key}`) ?? await getStaticConfigValue(key);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ key, value });
    }

    if (req.method === 'POST') {
      const { key: bodyKey, value } = req.body;
      const k = bodyKey || key;
      if (!k) return res.status(400).json({ error: 'key required' });
      await kvSet(`config:${k}`, value);
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/config]', e);
    res.status(500).json({ error: 'Internal error' });
  }
}
