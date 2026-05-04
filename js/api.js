// API client for the shared Vercel Redis backend.
// All methods return null/false on failure so callers can fall back to local
// caches or static player data without forking state by browser.

const REMOTE_API_ORIGIN = 'https://peggle.vercel.app';

function isLocalHost(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function resolveApiBase() {
  if (typeof window !== 'undefined' && typeof window.__PEGGLE_API_BASE__ === 'string') {
    return window.__PEGGLE_API_BASE__.replace(/\/$/, '');
  }
  if (typeof location !== 'undefined' && (location.protocol === 'file:' || isLocalHost(location.hostname))) {
    return `${REMOTE_API_ORIGIN}/api`;
  }
  return '/api';
}

const API_BASE = resolveApiBase();

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

export const api = {
  // ─── Levels ───────────────────────────────────

  async listLevels() {
    try {
      const res = await fetch(`${API_BASE}/levels`);
      if (!res.ok) return [];
      const { names } = await res.json();
      return names || [];
    } catch (e) {
      console.warn('[api] listLevels failed:', e);
      return [];
    }
  },

  async getLevel(name) {
    try {
      const res = await fetch(`${API_BASE}/levels?name=${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('[api] getLevel failed:', e);
      return null;
    }
  },

  async saveLevel(name, data) {
    try {
      const res = await fetch(`${API_BASE}/levels`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, data })
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] saveLevel failed:', e);
      return false;
    }
  },

  async deleteLevel(name) {
    try {
      const res = await fetch(`${API_BASE}/levels?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: jsonHeaders()
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] deleteLevel failed:', e);
      return false;
    }
  },

  // ─── Campaigns ────────────────────────────────

  async listCampaigns() {
    try {
      const res = await fetch(`${API_BASE}/campaigns`);
      if (!res.ok) return [];
      const { campaigns } = await res.json();
      return campaigns || [];
    } catch (e) {
      console.warn('[api] listCampaigns failed:', e);
      return [];
    }
  },

  async getCampaign(name) {
    try {
      const res = await fetch(`${API_BASE}/campaigns?name=${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('[api] getCampaign failed:', e);
      return null;
    }
  },

  /** Get campaign with all level data resolved (for player) */
  async getResolvedCampaign(name) {
    try {
      const res = await fetch(`${API_BASE}/campaigns?name=${encodeURIComponent(name)}&resolve=true`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data && Array.isArray(data.levels) && data.levels.length > 0) return data;
      return null;
    } catch (e) {
      console.warn('[api] getResolvedCampaign failed:', e);
      return null;
    }
  },

  async getPrimaryCampaign({ initial = false } = {}) {
    try {
      const params = new URLSearchParams({ primary: 'true' });
      params.set(initial ? 'initial' : 'resolve', 'true');
      const res = await fetch(`${API_BASE}/campaigns?${params.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data && Array.isArray(data.levels) && data.levels.length > 0) return data;
      return null;
    } catch (e) {
      console.warn('[api] getPrimaryCampaign failed:', e);
      return null;
    }
  },

  async saveCampaign(name, data) {
    try {
      const res = await fetch(`${API_BASE}/campaigns`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, data })
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] saveCampaign failed:', e);
      return false;
    }
  },

  async deleteCampaign(name) {
    try {
      const res = await fetch(`${API_BASE}/campaigns?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: jsonHeaders()
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] deleteCampaign failed:', e);
      return false;
    }
  },

  // ─── Config ─────────────────────────────────

  async getConfig(key) {
    try {
      const res = await fetch(`${API_BASE}/config?key=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.value;
    } catch (e) {
      console.warn('[api] getConfig failed:', e);
      return null;
    }
  },

  async setConfig(key, value) {
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ key, value })
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] setConfig failed:', e);
      return false;
    }
  },

  // ─── Characters ───────────────────────────────

  async getCharacterRegistry() {
    try {
      const res = await fetch(`${API_BASE}/characters`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('[api] getCharacterRegistry failed:', e);
      return null;
    }
  },

  async saveCharacterRegistry(data) {
    try {
      const res = await fetch(`${API_BASE}/characters`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ data })
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] saveCharacterRegistry failed:', e);
      return false;
    }
  }
};
