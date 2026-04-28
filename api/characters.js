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

async function kvDel(key) {
  await getRedis().del(key);
}

const REGISTRY_KEY = 'character:__registry';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function checkAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${ADMIN_TOKEN}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const registry = await kvGet(REGISTRY_KEY);
      if (!registry) return res.status(404).json({ error: 'No registry stored' });
      return res.json(registry);
    }

    if (req.method === 'POST') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { data } = req.body || {};
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'data required' });
      }
      await kvSet(REGISTRY_KEY, data);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      await kvDel(REGISTRY_KEY);
      return res.json({ ok: true });
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
