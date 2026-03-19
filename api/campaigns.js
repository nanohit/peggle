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

const INDEX_KEY = 'campaign:__index';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function checkAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${ADMIN_TOKEN}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { name, resolve } = req.query;

      if (!name) {
        const names = (await kvGet(INDEX_KEY)) || [];
        const campaigns = [];
        for (const n of names) {
          const c = await kvGet(`campaign:${n}`);
          if (c) campaigns.push({ name: n, levelCount: (c.levelNames || []).length });
        }
        return res.json({ campaigns });
      }

      const campaign = await kvGet(`campaign:${name}`);
      if (!campaign) return res.status(404).json({ error: 'Not found' });

      if (resolve === 'true') {
        const levelNames = campaign.levelNames || [];
        const levels = [];
        for (const ln of levelNames) {
          const levelData = await kvGet(`level:${ln}`);
          if (levelData) levels.push(levelData);
        }
        return res.json({ name: campaign.name || name, levels });
      }

      return res.json(campaign);
    }

    if (req.method === 'POST') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { name, data } = req.body;
      if (!name || !data) return res.status(400).json({ error: 'name and data required' });

      await kvSet(`campaign:${name}`, data);

      const names = (await kvGet(INDEX_KEY)) || [];
      if (!names.includes(name)) {
        names.push(name);
        names.sort();
        await kvSet(INDEX_KEY, names);
      }

      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { name } = req.query;
      if (!name) return res.status(400).json({ error: 'name required' });

      await kvDel(`campaign:${name}`);

      const names = (await kvGet(INDEX_KEY)) || [];
      const filtered = names.filter(n => n !== name);
      await kvSet(INDEX_KEY, filtered);

      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/campaigns]', e);
    res.status(500).json({ error: 'Internal error' });
  }
}
