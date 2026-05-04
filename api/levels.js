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
      res.setHeader('Cache-Control', 'no-store');
      const { name } = req.query;
      if (!name) {
        const remoteNames = (await kvGet(INDEX_KEY)) || [];
        const names = [...new Set([...remoteNames, ...(await getStaticLevelNames())])].sort();
        return res.json({ names });
      }
      const data = await kvGet(`level:${name}`) || await getStaticLevel(name);
      if (!data) return res.status(404).json({ error: 'Not found' });
      return res.json(sanitizeLevelForPlayer(data));
    }

    if (req.method === 'POST') {
      const { name, data } = req.body;
      if (!name || !data) return res.status(400).json({ error: 'name and data required' });

      await kvSet(`level:${name}`, sanitizeLevelForPlayer(data));

      const names = (await kvGet(INDEX_KEY)) || [];
      if (!names.includes(name)) {
        names.push(name);
        names.sort();
        await kvSet(INDEX_KEY, names);
      }

      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { name } = req.query;
      if (!name) return res.status(400).json({ error: 'name required' });

      await kvDel(`level:${name}`);

      const names = (await kvGet(INDEX_KEY)) || [];
      const filtered = names.filter(n => n !== name);
      await kvSet(INDEX_KEY, filtered);

      return res.json({ ok: true });
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
