import Redis from 'ioredis';
import fs from 'fs/promises';
import { topoOrder, buildNodeMap, resolveNodeLevelName, syncLevelNames } from '../js/graph/core.js';
import { validateGraph } from '../js/graph/validate.js';

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
    console.warn('[api/campaigns] Redis get failed:', error?.message || error);
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

const INDEX_KEY = 'campaign:__index';

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
  res.setHeader('Cache-Control', 'no-store');
  return res.json(payload);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
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

async function getStaticPrimaryName() {
  const config = await readStaticJson('../data/player/config.json');
  const value = config?.primaryCampaign || config?.primary;
  return typeof value === 'string' && value ? value : null;
}

function editableCampaignFromResolved(raw, name) {
  if (!raw || typeof raw !== 'object') return null;
  const campaignName = raw.name || name;
  const levels = Array.isArray(raw.levels) ? raw.levels : [];
  const levelNamesByIndex = levels.map((level, index) => level?.name || String(index + 1));
  let graph = null;

  if (raw.graph && Array.isArray(raw.graph.nodes)) {
    graph = {
      nodes: raw.graph.nodes.map(node => ({
        ...node,
        levelName: node.levelName || levelNamesByIndex[node.levelIndex] || null,
        children: Array.isArray(node.children) ? [...node.children] : [],
        type: node.type || 'normal'
      }))
    };
  } else if (levelNamesByIndex.length > 0) {
    graph = {
      nodes: levelNamesByIndex.map((levelName, index) => ({
        id: index,
        levelName,
        children: index < levelNamesByIndex.length - 1 ? [index + 1] : [],
        type: 'normal'
      }))
    };
  }

  const levelNames = graph?.nodes?.length
    ? syncLevelNames(graph, levelNamesByIndex)
    : levelNamesByIndex;

  return {
    id: `seed-${safeName(campaignName)}`,
    name: campaignName,
    levelNames,
    graph,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    _remoteKey: safeName(campaignName)
  };
}

async function getStaticCampaign(name) {
  const data = await readStaticJson(`../data/player/campaigns/${staticNamePath(name)}.json`)
    || ((await getStaticPrimaryName()) === name ? await readStaticJson('../data/player/primary.json') : null);
  return editableCampaignFromResolved(data, name);
}

async function getStaticCampaignNames() {
  try {
    const entries = await fs.readdir(new URL('../data/player/campaigns/', import.meta.url), { withFileTypes: true });
    const names = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.initial.json'))
      .map(entry => decodeURIComponent(entry.name.replace(/\.json$/, '')));
    const primaryName = await getStaticPrimaryName();
    if (primaryName && !names.includes(primaryName)) names.push(primaryName);
    return names;
  } catch {
    const primaryName = await getStaticPrimaryName();
    return primaryName ? [primaryName] : [];
  }
}

async function getCampaignData(name) {
  return await kvGet(`campaign:${name}`) || await getStaticCampaign(name);
}

async function getLevelData(name) {
  const data = await kvGet(`level:${name}`);
  if (data) return data;
  const exact = await readStaticJson(`../data/player/levels/${staticNamePath(name)}.json`);
  if (exact) return exact;
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

export default async function handler(req, res) {
  try {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET') {
      const { resolve, primary, initial } = req.query;
      let { name } = req.query;
      const initialOnly = resolve === 'initial' || initial === 'true';

      if (!name && primary === 'true') {
        const primaryName = await kvGet('config:primaryCampaign') || await getStaticPrimaryName();
        if (typeof primaryName === 'string' && primaryName) {
          name = primaryName;
        } else {
          return res.status(404).json({ error: 'Primary campaign not configured' });
        }
      }

      if (!name) {
        const names = [...new Set([...((await kvGet(INDEX_KEY)) || []), ...(await getStaticCampaignNames())])].sort();
        if (names.length === 0) return sendCacheableCampaign(res, { campaigns: [] });
        const rawCampaigns = await Promise.all(names.map(n => getCampaignData(n)));
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

      const campaign = await getCampaignData(name);
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
              const levelData = await getLevelData(item.levelName);
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
          const resolvedLevels = await Promise.all(uniqueLevelNames.map(ln => getLevelData(ln)));
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
            const levelData = await getLevelData(ln);
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
        const resolvedLevels = await Promise.all(uniqueLevelNames.map(ln => getLevelData(ln)));
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

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' }
  }
};
