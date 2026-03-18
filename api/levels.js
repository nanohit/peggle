import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const INDEX_KEY = 'level:__index';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function checkAdmin(req) {
  if (!ADMIN_TOKEN) return true; // no token configured = open access
  const auth = req.headers.authorization;
  return auth === `Bearer ${ADMIN_TOKEN}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { name } = req.query;
      if (!name) {
        // List all level names
        const names = (await kv.get(INDEX_KEY)) || [];
        return res.json({ names });
      }
      // Get single level
      const data = await kv.get(`level:${name}`);
      if (!data) return res.status(404).json({ error: 'Not found' });
      return res.json(data);
    }

    if (req.method === 'POST') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { name, data } = req.body;
      if (!name || !data) return res.status(400).json({ error: 'name and data required' });

      await kv.set(`level:${name}`, data);

      // Update index
      const names = (await kv.get(INDEX_KEY)) || [];
      if (!names.includes(name)) {
        names.push(name);
        names.sort();
        await kv.set(INDEX_KEY, names);
      }

      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { name } = req.query;
      if (!name) return res.status(400).json({ error: 'name required' });

      await kv.del(`level:${name}`);

      // Update index
      const names = (await kv.get(INDEX_KEY)) || [];
      const filtered = names.filter(n => n !== name);
      await kv.set(INDEX_KEY, filtered);

      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/levels]', e);
    res.status(500).json({ error: 'Internal error' });
  }
}
