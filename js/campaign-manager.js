// Campaign Manager - CRUD for level chains (campaigns)
// Campaigns are ordered sequences of baked levels that players progress through sequentially.
// Admin creates/bakes levels individually, then organizes them into campaigns.
// Export produces a self-contained JSON for hosting; player loads via ?campaign=name.

import { Utils } from './utils.js';
import { api } from './api.js';

const STORAGE_KEY = 'peggle_campaigns';

export class CampaignManager {
  constructor() {
    this.campaigns = [];
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
  }

  async syncFromRemote() {
    try {
      const remoteList = await api.listCampaigns();
      if (!remoteList || remoteList.length === 0) return;

      let changed = false;
      for (const { name: safeName } of remoteList) {
        const remoteCampaign = await api.getCampaign(safeName);
        if (!remoteCampaign || !remoteCampaign.levelNames) continue;

        // Find local campaign matching this safe name
        const localMatch = this.campaigns.find(c => this._safeName(c) === safeName);

        if (localMatch) {
          // Merge: remote wins if it has a newer modified timestamp
          const remoteMod = remoteCampaign.modified || '';
          const localMod = localMatch.modified || '';
          if (remoteMod > localMod) {
            Object.assign(localMatch, remoteCampaign);
            changed = true;
          }
        } else {
          // Campaign exists in Redis but not locally — add it
          if (!remoteCampaign.id) remoteCampaign.id = Utils.generateId();
          this.campaigns.push(remoteCampaign);
          changed = true;
        }
      }

      if (changed) {
        this.save();
        console.log('[campaign] Synced from remote');
        if (this.onSync) this.onSync();
      }
    } catch (e) {
      console.warn('[campaign] Remote sync failed:', e);
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

  _syncCampaign(campaign) {
    api.saveCampaign(this._safeName(campaign), campaign).then(ok => {
      if (ok) console.log('[campaign] Synced:', campaign.name);
      else console.warn('[campaign] Remote sync failed:', campaign.name);
    });
  }

  _syncDelete(campaign) {
    api.deleteCampaign(this._safeName(campaign)).then(ok => {
      if (ok) console.log('[campaign] Deleted remote:', campaign.name);
    });
  }

  create(name = 'Untitled Campaign') {
    const campaign = {
      id: Utils.generateId(),
      name,
      levelNames: [],
      created: new Date().toISOString(),
      modified: new Date().toISOString()
    };
    this.campaigns.push(campaign);
    this.save();
    this._syncCampaign(campaign);
    return campaign;
  }

  getAll() {
    return this.campaigns;
  }

  getById(id) {
    return this.campaigns.find(c => c.id === id) || null;
  }

  update(id, updates) {
    const campaign = this.getById(id);
    if (!campaign) return null;
    Object.assign(campaign, updates);
    campaign.modified = new Date().toISOString();
    this.save();
    this._syncCampaign(campaign);
    return campaign;
  }

  delete(id) {
    const campaign = this.getById(id);
    this.campaigns = this.campaigns.filter(c => c.id !== id);
    this.save();
    if (campaign) this._syncDelete(campaign);
  }

  addLevel(campaignId, levelName) {
    const campaign = this.getById(campaignId);
    if (!campaign) return;
    campaign.levelNames.push(levelName);
    campaign.modified = new Date().toISOString();
    this.save();
    this._syncCampaign(campaign);
  }

  removeLevel(campaignId, index) {
    const campaign = this.getById(campaignId);
    if (!campaign || index < 0 || index >= campaign.levelNames.length) return;
    campaign.levelNames.splice(index, 1);
    campaign.modified = new Date().toISOString();
    this.save();
    this._syncCampaign(campaign);
  }

  moveLevel(campaignId, fromIndex, toIndex) {
    const campaign = this.getById(campaignId);
    if (!campaign) return;
    const arr = campaign.levelNames;
    if (fromIndex < 0 || fromIndex >= arr.length || toIndex < 0 || toIndex >= arr.length) return;
    const [item] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, item);
    campaign.modified = new Date().toISOString();
    this.save();
    this._syncCampaign(campaign);
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
    try { return JSON.parse(raw); } catch { return null; }
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

  // Export campaign as self-contained JSON (for hosting at /campaigns/<name>.json)
  exportCampaign(campaignId) {
    const campaign = this.getById(campaignId);
    if (!campaign) return null;
    return {
      name: campaign.name,
      levels: this.resolveLevels(campaignId)
    };
  }

  // Store resolved campaign in localStorage for local player testing
  publishLocal(campaignId) {
    const data = this.exportCampaign(campaignId);
    if (!data || data.levels.length === 0) return null;
    const safeName = (data.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
    localStorage.setItem('campaign:' + safeName, JSON.stringify(data));
    return safeName;
  }
}
