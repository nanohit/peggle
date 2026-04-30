import Redis from 'ioredis';
import { topoOrder, buildNodeMap, resolveNodeLevelName, syncLevelNames } from '../js/graph/core.js';
import { validateGraph } from '../js/graph/validate.js';

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

async function kvMGet(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const rawValues = await getRedis().mget(keys);
  return rawValues.map((raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  });
}

async function kvSet(key, value) {
  await getRedis().set(key, JSON.stringify(value));
}

async function kvDel(key) {
  await getRedis().del(key);
}

const INDEX_KEY = 'campaign:__index';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function sanitizeLevelForPlayer(level) {
  const next = cloneJson(level);
  const snapshot = next?.character?.snapshot;
  if (snapshot && typeof snapshot === 'object') {
    // Runtime normalizes old full snapshots into reference snapshots anyway.
    // Strip duplicated base64 emotion images before they cross the network.
    delete snapshot.slots;
    delete snapshot.emotions;
  }
  return next;
}

function sendCacheableCampaign(res, payload) {
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  return res.json(payload);
}

function checkAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${ADMIN_TOKEN}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { resolve, primary, initial } = req.query;
      let { name } = req.query;
      const initialOnly = resolve === 'initial' || initial === 'true';

      if (!name && primary === 'true') {
        const primaryName = await kvGet('config:primaryCampaign');
        if (typeof primaryName === 'string' && primaryName) {
          name = primaryName;
        } else {
          return res.status(404).json({ error: 'Primary campaign not configured' });
        }
      }

      if (!name) {
        const names = (await kvGet(INDEX_KEY)) || [];
        if (names.length === 0) return sendCacheableCampaign(res, { campaigns: [] });
        const rawCampaigns = await kvMGet(names.map(n => `campaign:${n}`));
        const campaigns = [];
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const c = rawCampaigns[i];
          if (c) {
            const levelCount = Array.isArray(c.levelNames)
              ? c.levelNames.length
              : (Array.isArray(c.graph?.nodes) ? c.graph.nodes.length : 0);
            campaigns.push({ name: n, levelCount });
          }
        }
        return sendCacheableCampaign(res, { campaigns });
      }

      const campaign = await kvGet(`campaign:${name}`);
      if (!campaign) return res.status(404).json({ error: 'Not found' });

      if (resolve === 'true' || initialOnly) {
        const levelNames = Array.isArray(campaign.levelNames) ? campaign.levelNames : [];
        const graph = campaign.graph;

        // Resolve using graph order so graph/levels stay index-aligned in player.
        if (graph && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
          validateGraph(graph);
          const resolvedLevelNames = syncLevelNames(graph, levelNames);
          const order = topoOrder(graph);
          const nodeMap = buildNodeMap(graph);
          const orderedNodeLevels = [];
          for (const nid of order) {
            const node = nodeMap.get(nid);
            const ln = resolveNodeLevelName(node, resolvedLevelNames);
            if (!ln) continue;
            orderedNodeLevels.push({ nodeId: nid, levelName: ln });
          }

          if (initialOnly) {
            for (const item of orderedNodeLevels) {
              const levelData = await kvGet(`level:${item.levelName}`);
              if (!levelData) continue;
              const node = nodeMap.get(item.nodeId);
              return sendCacheableCampaign(res, {
                name: campaign.name || name,
                partial: true,
                initialNodeId: item.nodeId,
                levels: [sanitizeLevelForPlayer(levelData)],
                graph: {
                  nodes: [{
                    id: item.nodeId,
                    levelIndex: 0,
                    children: [],
                    type: node?.type || 'normal'
                  }]
                }
              });
            }
            return res.status(404).json({ error: 'No playable levels found' });
          }

          const uniqueLevelNames = [...new Set(orderedNodeLevels.map(item => item.levelName))];
          const resolvedLevels = await kvMGet(uniqueLevelNames.map(ln => `level:${ln}`));
          const levelCache = new Map();
          for (let i = 0; i < uniqueLevelNames.length; i++) {
            levelCache.set(uniqueLevelNames[i], resolvedLevels[i] || null);
          }

          const levels = [];
          const nodeToIndex = new Map();
          const levelNameToIndex = new Map();

          for (const item of orderedNodeLevels) {
            const levelData = levelCache.get(item.levelName);
            if (!levelData) continue;
            if (!levelNameToIndex.has(item.levelName)) {
              levelNameToIndex.set(item.levelName, levels.length);
              levels.push(sanitizeLevelForPlayer(levelData));
            }
            nodeToIndex.set(item.nodeId, levelNameToIndex.get(item.levelName));
          }

          const exportedNodes = graph.nodes
            .filter(n => nodeToIndex.has(n.id))
            .map(n => ({
              id: n.id,
              levelIndex: nodeToIndex.get(n.id),
              children: (n.children || []).filter(c => nodeToIndex.has(c)),
              type: n.type || 'normal'
            }));

          return sendCacheableCampaign(res, {
            name: campaign.name || name,
            levels,
            graph: { nodes: exportedNodes }
          });
        }

        // Fallback for legacy campaigns without graph.
        const uniqueLevelNames = [...new Set(levelNames)];
        if (initialOnly) {
          for (const ln of uniqueLevelNames) {
            const levelData = await kvGet(`level:${ln}`);
            if (levelData) {
              return sendCacheableCampaign(res, {
                name: campaign.name || name,
                partial: true,
                initialNodeId: 0,
                levels: [sanitizeLevelForPlayer(levelData)],
                graph: { nodes: [{ id: 0, levelIndex: 0, children: [], type: 'normal' }] }
              });
            }
          }
          return res.status(404).json({ error: 'No playable levels found' });
        }
        const resolvedLevels = await kvMGet(uniqueLevelNames.map(ln => `level:${ln}`));
        const levelCache = new Map();
        for (let i = 0; i < uniqueLevelNames.length; i++) {
          levelCache.set(uniqueLevelNames[i], resolvedLevels[i] || null);
        }
        const levels = [];
        for (const ln of levelNames) {
          const levelData = levelCache.get(ln);
          if (levelData) levels.push(sanitizeLevelForPlayer(levelData));
        }
        return sendCacheableCampaign(res, { name: campaign.name || name, levels });
      }

      return sendCacheableCampaign(res, campaign);
    }

    if (req.method === 'POST') {
      if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const { name, data } = req.body;
      if (!name || !data) return res.status(400).json({ error: 'name and data required' });

      if (Object.prototype.hasOwnProperty.call(data, 'graph')) {
        if (!data.graph || typeof data.graph !== 'object') data.graph = { nodes: [] };
        const warnings = validateGraph(data.graph);
        if (warnings.length) {
          console.warn('[api/campaigns] POST graph normalized:', warnings);
        }

        const prevLevelNames = Array.isArray(data.levelNames) ? data.levelNames : [];
        const syncedLevelNames = syncLevelNames(data.graph, prevLevelNames);
        if (syncedLevelNames.length > 0 || prevLevelNames.length === 0) {
          data.levelNames = syncedLevelNames;
        } else {
          data.levelNames = prevLevelNames;
        }
      }

      if (!Array.isArray(data.levelNames)) data.levelNames = [];

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
