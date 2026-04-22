// Campaign Manager - CRUD for level chains (campaigns)
// Campaigns are ordered sequences of baked levels that players progress through sequentially.
// Admin creates/bakes levels individually, then organizes them into campaigns.
// Export produces a self-contained JSON for hosting; player loads via ?campaign=name.

import { Utils } from './utils.js';
import { api } from './api.js';
import { normalizeLevelData } from './levels.js';
import { topoOrder, wouldCycle, nextNodeId, graphFromLinear, syncLevelNames, buildNodeMap, resolveNodeLevelName } from './graph/core.js';
import { validateGraph } from './graph/validate.js';

const STORAGE_KEY = 'peggle_campaigns';

export class CampaignManager {
  constructor() {
    this.campaigns = [];
    this.beforeSyncCampaign = null;
    this._remoteSyncQueue = new Map();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.campaigns = JSON.parse(raw);
    } catch (e) {
      console.error('[campaign] load failed:', e);
    }
    if (!Array.isArray(this.campaigns)) this.campaigns = [];
    this._canonicalizeLocalCampaigns();
  }

  async syncFromRemote() {
    try {
      let changed = this._canonicalizeLocalCampaigns();
      const remoteList = await api.listCampaigns();
      if (!remoteList || remoteList.length === 0) {
        if (changed) {
          this.save();
          if (this.onSync) this.onSync();
        }
        return true;
      }

      const fetched = [];
      const BATCH_SIZE = 8;
      for (let i = 0; i < remoteList.length; i += BATCH_SIZE) {
        const batch = remoteList.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async ({ name: safeName }) => {
          const remoteCampaign = await api.getCampaign(safeName);
          const normalized = this._normalizeCampaignLike(remoteCampaign, safeName);
          if (!normalized) return null;
          return { safeName, campaign: normalized };
        }));
        fetched.push(...results.filter(Boolean));
      }

      // Deduplicate remote shadows produced by historical rename flows.
      const remoteDeleteKeys = new Set();
      const byId = new Map();
      const idless = [];
      for (const rec of fetched) {
        const rid = rec.campaign.id;
        if (!rid) {
          idless.push(rec);
          continue;
        }
        const prev = byId.get(rid);
        if (!prev) {
          byId.set(rid, rec);
          continue;
        }
        const keep = this._pickCanonical(prev.campaign, rec.campaign) === prev.campaign ? prev : rec;
        const drop = keep === prev ? rec : prev;
        byId.set(rid, keep);
        remoteDeleteKeys.add(drop.safeName);
      }

      const dedupedBySafe = new Map();
      for (const rec of [...byId.values(), ...idless]) {
        const prev = dedupedBySafe.get(rec.safeName);
        if (!prev) {
          dedupedBySafe.set(rec.safeName, rec);
          continue;
        }
        const keep = this._pickCanonical(prev.campaign, rec.campaign) === prev.campaign ? prev : rec;
        const drop = keep === prev ? rec : prev;
        dedupedBySafe.set(rec.safeName, keep);
        remoteDeleteKeys.add(drop.safeName);
      }

      const remoteRecords = [...dedupedBySafe.values()];
      const localById = new Map(this.campaigns.map(c => [c.id, c]));
      const localByRemoteKey = new Map(this.campaigns.map(c => [c._remoteKey || this._safeName(c), c]));
      const localBySafeName = new Map(this.campaigns.map(c => [this._safeName(c), c]));

      for (const rec of remoteRecords) {
        const incoming = rec.campaign;
        const safeName = rec.safeName;
        const localMatch = (incoming.id && localById.get(incoming.id))
          || localByRemoteKey.get(safeName)
          || localBySafeName.get(safeName);

        if (!localMatch) {
          this.campaigns.push(incoming);
          changed = true;
          continue;
        }

        const remoteIsNewer = this._pickCanonical(localMatch, incoming) === incoming;
        if (remoteIsNewer) {
          Object.assign(localMatch, incoming);
          changed = true;
        }
        if (localMatch._remoteKey !== safeName) {
          localMatch._remoteKey = safeName;
          changed = true;
        }
      }

      if (this._canonicalizeLocalCampaigns()) changed = true;

      // Best-effort cleanup of stale remote keys (rename shadows).
      for (const staleSafe of remoteDeleteKeys) {
        if (!staleSafe) continue;
        if (remoteRecords.some(r => r.safeName === staleSafe)) continue;
        api.deleteCampaign(staleSafe).then(ok => {
          if (ok) console.log('[campaign] Removed stale remote alias:', staleSafe);
        });
      }

      if (changed) {
        this.save();
        console.log('[campaign] Synced from remote');
        if (this.onSync) this.onSync();
      }
      return true;
    } catch (e) {
      console.warn('[campaign] Remote sync failed:', e);
      return false;
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.campaigns));
    } catch (e) {
      console.error('[campaign] save failed:', e);
    }
  }

  _safeName(campaign) {
    return (campaign.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  _safeFromName(name) {
    return (name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  _uniqueName(base, excludeId = null) {
    const root = (typeof base === 'string' && base.trim()) ? base.trim() : 'Untitled Campaign';
    const used = new Set(
      this.campaigns
        .filter(c => c && c.id !== excludeId)
        .map(c => this._safeName(c))
    );
    let candidate = root;
    let safe = this._safeFromName(candidate);
    let i = 2;
    while (used.has(safe)) {
      candidate = `${root} ${i}`;
      safe = this._safeFromName(candidate);
      i++;
    }
    return candidate;
  }

  _timestamp(v) {
    const t = Date.parse(v || '');
    return Number.isFinite(t) ? t : 0;
  }

  _pickCanonical(a, b) {
    const aGraph = Array.isArray(a?.graph?.nodes) ? a.graph.nodes.length : 0;
    const bGraph = Array.isArray(b?.graph?.nodes) ? b.graph.nodes.length : 0;
    if (bGraph !== aGraph) return bGraph > aGraph ? b : a;

    const aLevels = Array.isArray(a?.levelNames) ? a.levelNames.length : 0;
    const bLevels = Array.isArray(b?.levelNames) ? b.levelNames.length : 0;
    if (bLevels !== aLevels) return bLevels > aLevels ? b : a;

    const am = this._timestamp(a?.modified) || this._timestamp(a?.created);
    const bm = this._timestamp(b?.modified) || this._timestamp(b?.created);
    if (bm !== am) return bm > am ? b : a;

    return a;
  }

  _normalizeCampaignLike(raw, remoteKey = null, clone = true) {
    if (!raw || typeof raw !== 'object') return null;
    const c = clone ? { ...raw } : raw;
    if (!c.id) c.id = Utils.generateId();
    if (typeof c.name !== 'string' || !c.name.trim()) c.name = remoteKey || 'Untitled Campaign';
    if (!Array.isArray(c.levelNames)) c.levelNames = [];
    if (!c.created) c.created = new Date().toISOString();
    if (!c.modified) c.modified = c.created;
    c._remoteKey = remoteKey || c._remoteKey || this._safeName(c);
    return c;
  }

  _canonicalizeLocalCampaigns() {
    if (!Array.isArray(this.campaigns)) {
      this.campaigns = [];
      return true;
    }

    let changed = false;
    const normalized = [];
    for (const raw of this.campaigns) {
      const c = this._normalizeCampaignLike(raw, null, false);
      if (!c) {
        changed = true;
        continue;
      }
      normalized.push(c);
    }

    // 1) Deduplicate by id.
    const byId = new Map();
    for (const c of normalized) {
      const prev = byId.get(c.id);
      if (!prev) {
        byId.set(c.id, c);
        continue;
      }
      const keep = this._pickCanonical(prev, c);
      if (keep !== prev) changed = true;
      byId.set(c.id, keep);
    }

    // 2) Deduplicate by safe name.
    const bySafe = new Map();
    for (const c of byId.values()) {
      const safe = this._safeName(c);
      const prev = bySafe.get(safe);
      if (!prev) {
        bySafe.set(safe, c);
        continue;
      }
      const keep = this._pickCanonical(prev, c);
      if (keep !== prev) changed = true;
      bySafe.set(safe, keep);
    }

    const next = [...bySafe.values()].sort((a, b) => {
      return (a.name || '').localeCompare((b.name || ''), undefined, { sensitivity: 'base' });
    });

    if (next.length !== this.campaigns.length || next.some((c, i) => c !== this.campaigns[i])) {
      changed = true;
    }
    this.campaigns = next;
    return changed;
  }

  compactLocal() {
    const changed = this._canonicalizeLocalCampaigns();
    if (changed) this.save();
    return changed;
  }

  _normalizeGraph(campaign, reason = 'graph normalized') {
    if (!campaign?.graph || !Array.isArray(campaign.graph.nodes)) return [];
    const warnings = validateGraph(campaign.graph);
    if (warnings.length) {
      console.warn(`[campaign] ${reason}:`, warnings);
    }
    this._syncGraphToLevelNames(campaign);
    return warnings;
  }

  _commitGraphChange(campaign, reason = 'graph updated') {
    if (!campaign) return;
    this._normalizeGraph(campaign, reason);
    campaign.modified = new Date().toISOString();
    this.save();
    this._syncCampaign(campaign);
  }

  _queueRemoteSync(campaignId, task) {
    const previous = this._remoteSyncQueue.get(campaignId) || Promise.resolve();
    const next = previous
      .catch(() => false)
      .then(task);
    const settled = next.finally(() => {
      if (this._remoteSyncQueue.get(campaignId) === settled) {
        this._remoteSyncQueue.delete(campaignId);
      }
    });
    this._remoteSyncQueue.set(campaignId, settled);
    return settled;
  }

  _cloneCampaignSnapshot(campaign) {
    return JSON.parse(JSON.stringify(campaign));
  }

  _syncCampaign(campaign) {
    if (!campaign?.id) return Promise.resolve(false);

    const snapshot = this._cloneCampaignSnapshot(campaign);
    const safe = this._safeName(snapshot);
    campaign._remoteKey = safe;
    snapshot._remoteKey = safe;

    return this._queueRemoteSync(campaign.id, async () => {
      if (typeof this.beforeSyncCampaign === 'function') {
        const prep = await this.beforeSyncCampaign(snapshot);
        if (prep === false || prep?.ok === false) {
          console.warn('[campaign] Remote sync skipped:', snapshot.name, prep?.message || 'campaign dependencies are not ready');
          return false;
        }
      }

      const ok = await api.saveCampaign(safe, snapshot);
      if (ok) console.log('[campaign] Synced:', snapshot.name);
      else console.warn('[campaign] Remote sync failed:', snapshot.name);
      return ok;
    });
  }

  _syncDelete(campaign) {
    const keys = new Set([campaign?._remoteKey, this._safeName(campaign)].filter(Boolean));
    const deleteTask = async () => {
      for (const key of keys) {
        const ok = await api.deleteCampaign(key);
        if (ok) console.log('[campaign] Deleted remote:', key);
      }
      return true;
    };

    if (!campaign?.id) return deleteTask();
    return this._queueRemoteSync(campaign.id, deleteTask);
  }

  create(name = 'Untitled Campaign') {
    const unique = this._uniqueName(name);
    const campaign = {
      id: Utils.generateId(),
      name: unique,
      levelNames: [],
      created: new Date().toISOString(),
      modified: new Date().toISOString()
    };
    campaign._remoteKey = this._safeName(campaign);
    this.campaigns.push(campaign);
    this._canonicalizeLocalCampaigns();
    this.save();
    this._syncCampaign(campaign);
    return campaign;
  }

  getAll() {
    this._canonicalizeLocalCampaigns();
    return this.campaigns;
  }

  getById(id) {
    return this.campaigns.find(c => c.id === id) || null;
  }

  update(id, updates) {
    const campaign = this.getById(id);
    if (!campaign) return null;
    const prevRemoteKey = campaign._remoteKey || this._safeName(campaign);
    if (updates && Object.prototype.hasOwnProperty.call(updates, 'name')) {
      updates = { ...updates, name: this._uniqueName(updates.name, id) };
    }
    Object.assign(campaign, updates);
    campaign.modified = new Date().toISOString();
    campaign._remoteKey = this._safeName(campaign);
    this._canonicalizeLocalCampaigns();
    this.save();
    const syncPromise = this._syncCampaign(campaign);
    if (prevRemoteKey && prevRemoteKey !== campaign._remoteKey) {
      const nextRemoteKey = campaign._remoteKey;
      this._queueRemoteSync(campaign.id, async () => {
        const synced = await syncPromise;
        if (!synced) return false;
        const primaryName = await api.getConfig('primaryCampaign');
        if (primaryName === prevRemoteKey) {
          const primaryUpdated = await api.setConfig('primaryCampaign', nextRemoteKey);
          if (!primaryUpdated) {
            console.warn('[campaign] Failed to update primary campaign pointer:', prevRemoteKey, '->', nextRemoteKey);
            return false;
          }
          console.log('[campaign] Updated primary campaign pointer:', nextRemoteKey);
        }
        const ok = await api.deleteCampaign(prevRemoteKey);
        if (ok) console.log('[campaign] Removed old remote name:', prevRemoteKey);
        return ok;
      });
    }
    return campaign;
  }

  delete(id) {
    const campaign = this.getById(id);
    this.campaigns = this.campaigns.filter(c => c.id !== id);
    this._canonicalizeLocalCampaigns();
    this.save();
    if (campaign) this._syncDelete(campaign);
  }

  // Legacy levelNames mutators — delegate to graph to keep data in sync.
  addLevel(campaignId, levelName) {
    this.addGraphNode(campaignId, levelName);
  }

  removeLevel(campaignId, index) {
    const campaign = this.getById(campaignId);
    if (!campaign) return;
    this.ensureGraph(campaignId);
    const order = topoOrder(campaign.graph, false);
    if (index >= 0 && index < order.length) {
      this.removeGraphNode(campaignId, order[index]);
    }
  }

  moveLevel(campaignId, fromIndex, toIndex) {
    // Graph model does not support arbitrary reordering — no-op.
    // Use graph editing (add/remove/branch) instead.
    console.warn('[campaign] moveLevel is deprecated; use graph editing instead');
  }

  // Get all baked level names from localStorage
  getBakedLevelNames() {
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('baked:')) {
        names.push(key.slice(6));
      }
    }
    return names.sort();
  }

  // Resolve a single baked level by name
  resolveBakedLevel(name) {
    const raw = localStorage.getItem('baked:' + name);
    if (!raw) return null;
    try {
      const level = normalizeLevelData(JSON.parse(raw));
      if (!level) return null;
      const normalizedRaw = JSON.stringify(level);
      if (normalizedRaw !== raw) {
        localStorage.setItem('baked:' + name, normalizedRaw);
      }
      return level;
    } catch {
      return null;
    }
  }

  // Resolve campaign to full level data array
  resolveLevels(campaignId) {
    const campaign = this.getById(campaignId);
    if (!campaign) return [];
    const levels = [];
    for (const name of campaign.levelNames) {
      const data = this.resolveBakedLevel(name);
      if (data) levels.push(data);
    }
    return levels;
  }

  // Store resolved campaign in localStorage for local player testing
  publishLocal(campaignId) {
    const data = this.exportCampaign(campaignId);
    if (!data || data.levels.length === 0) return null;
    const safeName = (data.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
    localStorage.setItem('campaign:' + safeName, JSON.stringify(data));
    // Set cache timestamp so player treats this as fresh (not immediately stale)
    localStorage.setItem('campaign_ts:' + safeName, String(Date.now()));
    return safeName;
  }

  // ─── Graph model ─────────────────────────────────────────

  // Ensure campaign has a graph; create linear chain from levelNames if missing
  ensureGraph(campaignId) {
    const campaign = this.getById(campaignId);
    if (!campaign) return null;
    if (campaign.graph && Array.isArray(campaign.graph.nodes) && campaign.graph.nodes.length > 0) {
      const prevLevelNames = Array.isArray(campaign.levelNames) ? [...campaign.levelNames] : [];
      const warnings = validateGraph(campaign.graph);
      this._syncGraphToLevelNames(campaign);
      const namesChanged = prevLevelNames.length !== campaign.levelNames.length ||
        prevLevelNames.some((n, i) => n !== campaign.levelNames[i]);
      if (warnings.length) {
        console.warn('[campaign] graph normalized:', warnings);
      }
      if (warnings.length || namesChanged) {
        this.save();
        this._syncCampaign(campaign);
      }
      return campaign.graph;
    }
    campaign.graph = graphFromLinear(campaign.levelNames);
    this._syncGraphToLevelNames(campaign);
    this.save();
    return campaign.graph;
  }

  static graphFromLinear(levelNames) { return graphFromLinear(levelNames); }
  static _nextNodeId(graph) { return nextNodeId(graph); }

  // Add a node as child of parentNodeId. If parent already has children,
  // the new node is inserted between parent and its existing children.
  addGraphNode(campaignId, levelName, parentNodeId) {
    const campaign = this.getById(campaignId);
    if (!campaign) return null;
    this.ensureGraph(campaignId);
    const graph = campaign.graph;

    const newId = CampaignManager._nextNodeId(graph);
    const newNode = { id: newId, levelName, children: [], type: 'normal' };

    if (parentNodeId !== undefined && parentNodeId !== null) {
      const parent = graph.nodes.find(n => n.id === parentNodeId);
      if (parent) {
        if (parent.children.length <= 1) {
          // Linear: insert between parent and its single child
          newNode.children = [...parent.children];
          parent.children = [newId];
        } else {
          // Branch point: add as another branch child
          parent.children.push(newId);
        }
      }
    } else if (graph.nodes.length > 0) {
      // Find last leaf (no children, deepest) and append there
      const leaves = graph.nodes.filter(n => n.children.length === 0);
      if (leaves.length > 0) leaves[leaves.length - 1].children.push(newId);
    }

    graph.nodes.push(newNode);
    this._commitGraphChange(campaign, 'graph node added');
    return newNode;
  }

  // Add a second (branch) child to a node that already has one child
  addGraphBranch(campaignId, parentNodeId, levelName) {
    const campaign = this.getById(campaignId);
    if (!campaign) return null;
    this.ensureGraph(campaignId);
    const graph = campaign.graph;

    const parent = graph.nodes.find(n => n.id === parentNodeId);
    if (!parent) return null;

    const newId = CampaignManager._nextNodeId(graph);
    const newNode = { id: newId, levelName, children: [], type: 'normal' };
    parent.children.push(newId);
    graph.nodes.push(newNode);

    this._commitGraphChange(campaign, 'graph branch added');
    return newNode;
  }

  // Remove a node from graph; reconnect its parents to its children
  removeGraphNode(campaignId, nodeId) {
    const campaign = this.getById(campaignId);
    if (!campaign || !campaign.graph) return;
    const graph = campaign.graph;

    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Reconnect parents
    for (const n of graph.nodes) {
      if (!Array.isArray(n.children) || n.children.length === 0) continue;
      const nextChildren = [];
      let replaced = false;
      for (const childId of n.children) {
        if (childId === nodeId) {
          nextChildren.push(...node.children);
          replaced = true;
        } else {
          nextChildren.push(childId);
        }
      }
      if (replaced) n.children = nextChildren;
    }

    graph.nodes = graph.nodes.filter(n => n.id !== nodeId);
    this._commitGraphChange(campaign, 'graph node removed');
  }

  // Set merge target: connect a branch endpoint to an existing downstream node
  // Returns false if the edge would create a cycle.
  setMergeTarget(campaignId, fromNodeId, toNodeId) {
    const campaign = this.getById(campaignId);
    if (!campaign || !campaign.graph) return false;

    const from = campaign.graph.nodes.find(n => n.id === fromNodeId);
    if (!from) return false;
    if (!campaign.graph.nodes.some(n => n.id === toNodeId)) return false;
    if (from.children.includes(toNodeId)) return true; // already connected

    // Cycle check: would toNodeId → ... → fromNodeId exist after adding this edge?
    if (wouldCycle(campaign.graph, fromNodeId, toNodeId)) return false;

    from.children.push(toNodeId);

    this._commitGraphChange(campaign, 'graph merge added');
    return true;
  }

  // Toggle node type between normal and secret
  setGraphNodeType(campaignId, nodeId, type) {
    const campaign = this.getById(campaignId);
    if (!campaign || !campaign.graph) return;

    const node = campaign.graph.nodes.find(n => n.id === nodeId);
    if (node) node.type = type;

    this._commitGraphChange(campaign, 'graph node type updated');
  }

  static graphPlayOrder(graph) { return topoOrder(graph, true); }

  _syncGraphToLevelNames(campaign) {
    if (!campaign.graph || !campaign.graph.nodes) return;
    campaign.levelNames = syncLevelNames(campaign.graph, campaign.levelNames || []);
  }

  // Override exportCampaign to include graph with levelIndex references
  exportCampaign(campaignId) {
    const campaign = this.getById(campaignId);
    if (!campaign) return null;

    // Ensure graph exists
    this.ensureGraph(campaignId);
    const graph = campaign.graph;
    const playOrder = topoOrder(graph, true);
    const nMap = buildNodeMap(graph);

    // Resolve levels in play order
    const levels = [];
    const nodeToIndex = new Map();
    const levelNameToIndex = new Map();
    for (let i = 0; i < playOrder.length; i++) {
      const node = nMap.get(playOrder[i]);
      if (!node) continue;
      const ln = resolveNodeLevelName(node, campaign.levelNames);
      if (!ln) continue;
      if (!levelNameToIndex.has(ln)) {
        const data = this.resolveBakedLevel(ln);
        if (!data) continue;
        levelNameToIndex.set(ln, levels.length);
        levels.push(data);
      }
      nodeToIndex.set(node.id, levelNameToIndex.get(ln));
    }

    // Build exported graph with levelIndex
    const exportedNodes = graph.nodes
      .filter(n => nodeToIndex.has(n.id))
      .map(n => ({
        id: n.id,
        levelIndex: nodeToIndex.get(n.id),
        children: n.children.filter(c => nodeToIndex.has(c)),
        type: n.type || 'normal'
      }));

    return {
      name: campaign.name,
      levels,
      graph: { nodes: exportedNodes }
    };
  }
}
