const REMOTE_API_ORIGIN = 'https://peggle.vercel.app';

// Some ISPs (notably consumer providers in Russia) blackhole the Bunny CDN
// hostname: connections hang without an error, so <img> fallback chains stall
// for the browser's full connect timeout on every asset. A cheap reachability
// probe flips candidate ordering to the same-origin /api/assets fallback for
// the whole session instead.
const CDN_HEALTH_STORAGE_KEY = 'peggle_cdn_health_v1';
const CDN_PROBE_TIMEOUT_MS = 4000;
const CDN_HEALTH_TTL_MS = 5 * 60 * 1000;
const IMAGE_CANDIDATE_TIMEOUT_MS = 10000;

const cdnHealth = { origin: '', status: 'unknown', checkedAt: 0, probing: false };

function loadPersistedCdnHealth() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CDN_HEALTH_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data.origin !== 'string') return;
    if (data.status !== 'ok' && data.status !== 'down') return;
    cdnHealth.origin = data.origin;
    cdnHealth.status = data.status;
    cdnHealth.checkedAt = Number(data.checkedAt) || 0;
  } catch { /* storage unavailable */ }
}

loadPersistedCdnHealth();

function persistCdnHealth() {
  try {
    localStorage.setItem(CDN_HEALTH_STORAGE_KEY, JSON.stringify({
      origin: cdnHealth.origin,
      status: cdnHealth.status,
      checkedAt: cdnHealth.checkedAt
    }));
  } catch { /* storage unavailable */ }
}

function urlOrigin(url) {
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://alea.sh/';
    return new URL(url, base).origin;
  } catch {
    return '';
  }
}

function isLocalAssetUrl(url) {
  if (typeof url !== 'string' || !url) return true;
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (typeof location === 'undefined') return true;
  const origin = urlOrigin(url);
  return !origin || origin === 'null' || origin === location.origin;
}

function noteCdnReachability(origin, reachable) {
  if (!origin) return;
  cdnHealth.origin = origin;
  cdnHealth.status = reachable ? 'ok' : 'down';
  cdnHealth.checkedAt = Date.now();
  persistCdnHealth();
}

function ensureCdnProbe(origin) {
  if (!origin || cdnHealth.probing) return;
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') return;
  const fresh = cdnHealth.origin === origin
    && cdnHealth.status !== 'unknown'
    && (Date.now() - cdnHealth.checkedAt) < CDN_HEALTH_TTL_MS;
  if (fresh) return;
  cdnHealth.probing = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_PROBE_TIMEOUT_MS);
  // no-cors: an opaque response (even a 404) still proves the host answers;
  // a blackholed connection aborts on the timer instead.
  fetch(`${origin}/`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
    .then(() => noteCdnReachability(origin, true))
    .catch(() => noteCdnReachability(origin, false))
    .finally(() => {
      clearTimeout(timer);
      cdnHealth.probing = false;
    });
}

export function getCdnHealthStatus() {
  return { origin: cdnHealth.origin, status: cdnHealth.status, checkedAt: cdnHealth.checkedAt };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLocalHost(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function resolveApiPath(path) {
  const value = String(path || '').trim();
  if (!value.startsWith('/api/')) return value;
  if (typeof window !== 'undefined' && typeof window.__PEGGLE_API_BASE__ === 'string') {
    return `${window.__PEGGLE_API_BASE__.replace(/\/$/, '')}${value.slice(4)}`;
  }
  if (typeof location !== 'undefined' && (location.protocol === 'file:' || isLocalHost(location.hostname))) {
    return `${REMOTE_API_ORIGIN}${value}`;
  }
  return value;
}

function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  return resolveApiPath(value.trim());
}

function cleanAssetKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function fallbackUrlForKey(key, source = '') {
  const normalized = cleanAssetKey(key);
  if (!normalized) return '';
  const params = new URLSearchParams({ key: normalized });
  if (source) params.set('source', source);
  return resolveApiPath(`/api/assets?${params.toString()}`);
}

export function isAssetReference(value) {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'asset') return true;
  return !!(
    value.storageVersion
    || value.key
    || value.primaryUrl
    || value.fallbackUrl
    || value.url
  );
}

export function normalizeAssetReference(value) {
  if (!isAssetReference(value)) return null;
  const key = cleanAssetKey(value.key);
  const primaryUrl = cleanUrl(value.primaryUrl || value.url);
  const fallbackUrl = cleanUrl(value.fallbackUrl) || fallbackUrlForKey(key);
  const url = cleanUrl(value.url || primaryUrl) || primaryUrl || fallbackUrl;
  if (!url && !primaryUrl && !fallbackUrl && !key) return null;
  return {
    kind: 'asset',
    storageVersion: Number.isFinite(value.storageVersion) ? value.storageVersion : 1,
    ...(key ? { key } : {}),
    ...(typeof value.hash === 'string' && value.hash ? { hash: value.hash } : {}),
    ...(Number.isFinite(value.bytes) ? { bytes: value.bytes } : {}),
    ...(typeof value.contentType === 'string' && value.contentType ? { contentType: value.contentType } : {}),
    ...(url ? { url } : {}),
    ...(primaryUrl ? { primaryUrl } : {}),
    ...(fallbackUrl ? { fallbackUrl } : {})
  };
}

export function normalizeAssetImageValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return normalizeAssetReference(value);
}

export function isAssetImageSource(value) {
  return !!normalizeAssetImageValue(value);
}

export function assetUrlCandidates(value) {
  if (typeof value === 'string') {
    const url = cleanUrl(value);
    return url ? [url] : [];
  }
  const asset = normalizeAssetReference(value);
  if (!asset) return [];
  const candidates = [...new Set([
    asset.primaryUrl,
    asset.url,
    asset.fallbackUrl,
    asset.key ? fallbackUrlForKey(asset.key) : ''
  ].map(cleanUrl).filter(Boolean))];
  const remote = candidates.filter(url => !isLocalAssetUrl(url));
  if (!remote.length) return candidates;
  ensureCdnProbe(urlOrigin(remote[0]));
  if (cdnHealth.status === 'down') {
    const local = candidates.filter(isLocalAssetUrl);
    if (local.length) return [...local, ...remote];
  }
  return candidates;
}

export function assetPrimaryUrl(value) {
  return assetUrlCandidates(value)[0] || '';
}

export function assetCacheKey(value) {
  if (typeof value === 'string') return cleanUrl(value);
  const asset = normalizeAssetReference(value);
  if (!asset) return '';
  return asset.key || asset.primaryUrl || asset.url || asset.fallbackUrl || JSON.stringify(asset);
}

function loadOneImage(url, crossOrigin, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok ? img : null);
    };
    // The timeout is what makes fallback usable on blackholing ISPs: a hung
    // candidate would otherwise stall the chain for the browser's own
    // multi-minute connect timeout.
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

const imageResultCache = new Map();

// Walks assetUrlCandidates(value) in order and resolves with the first image
// that loads: { img, url } or null. Successes are cached per asset+crossOrigin;
// failures are not, so a later call retries (possibly with reordered candidates
// once the CDN probe has settled).
export function loadImageFromCandidates(value, options = {}) {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  const crossOrigin = options.crossOrigin || '';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : IMAGE_CANDIDATE_TIMEOUT_MS;
  const cacheKey = `${crossOrigin}|${assetCacheKey(value)}`;
  const cached = imageResultCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    for (const url of assetUrlCandidates(value)) {
      const img = await loadOneImage(url, crossOrigin, timeoutMs);
      if (img) return { img, url };
    }
    return null;
  })();
  imageResultCache.set(cacheKey, promise);
  promise.then(result => {
    if (!result) imageResultCache.delete(cacheKey);
  }, () => imageResultCache.delete(cacheKey));
  return promise;
}

export function assetCssUrl(value) {
  const url = assetPrimaryUrl(value);
  return url ? `url("${url.replace(/"/g, '\\"')}")` : '';
}

export function assetDisplayUrl(value) {
  return assetPrimaryUrl(value);
}
