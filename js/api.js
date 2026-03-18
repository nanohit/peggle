// API client for Vercel KV backend
// All methods return null on failure — callers fall back to localStorage.

const API_BASE = '/api';

function getAdminToken() {
  return localStorage.getItem('peggle_admin_token') || '';
}

function adminHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const token = getAdminToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
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
        headers: adminHeaders(),
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
        headers: adminHeaders()
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

  async saveCampaign(name, data) {
    try {
      const res = await fetch(`${API_BASE}/campaigns`, {
        method: 'POST',
        headers: adminHeaders(),
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
        headers: adminHeaders()
      });
      return res.ok;
    } catch (e) {
      console.warn('[api] deleteCampaign failed:', e);
      return false;
    }
  }
};
