const REMOTE_API_ORIGIN = 'https://peggle.vercel.app';

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
  const candidates = [
    asset.primaryUrl,
    asset.url,
    asset.fallbackUrl,
    asset.key ? fallbackUrlForKey(asset.key) : ''
  ].map(cleanUrl).filter(Boolean);
  return [...new Set(candidates)];
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

export function assetCssUrl(value) {
  const url = assetPrimaryUrl(value);
  return url ? `url("${url.replace(/"/g, '\\"')}")` : '';
}

export function assetDisplayUrl(value) {
  return assetPrimaryUrl(value);
}
