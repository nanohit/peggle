import Redis from 'ioredis';

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

async function kvGet(key) {
  const raw = await getRedis().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function kvSet(key, value) {
  await getRedis().set(key, JSON.stringify(value));
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function checkAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${ADMIN_TOKEN}`;
}

export default async function handler(req, res) {
  try {
    const { key } = req.query;

    if (req.method === 'GET') {
      if (!key) return res.status(400).json({ error: 'key required' });
      const value = await kvGet(`config:${key}`);
      return res.json({ key, value });
    }

    if (req.method === 'POST') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
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
