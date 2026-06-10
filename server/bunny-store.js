import {
  IMMUTABLE_IMAGE_CACHE_CONTROL,
  encodeAssetKeyPath,
  normalizeAssetKey,
  sha256Hex
} from './asset-utils.js';

const DEFAULT_STORAGE_ENDPOINT = 'https://storage.bunnycdn.com';

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getBunnyStorageEndpoint() {
  const endpoint = stripTrailingSlash(process.env.BUNNY_STORAGE_ENDPOINT || DEFAULT_STORAGE_ENDPOINT);
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `https://${endpoint}`;
}

function getBunnyCdnBaseUrl() {
  return stripTrailingSlash(process.env.BUNNY_CDN_BASE_URL || process.env.BUNNY_PULL_ZONE_URL || '');
}

export function getBunnyConfigStatus() {
  const storageZone = String(process.env.BUNNY_STORAGE_ZONE || '').trim();
  const accessKey = String(process.env.BUNNY_STORAGE_ACCESS_KEY || '').trim();
  const cdnBaseUrl = getBunnyCdnBaseUrl();
  const missing = [];
  if (!storageZone) missing.push('BUNNY_STORAGE_ZONE');
  if (!accessKey) missing.push('BUNNY_STORAGE_ACCESS_KEY');
  if (!cdnBaseUrl) missing.push('BUNNY_CDN_BASE_URL');
  return {
    enabled: missing.length === 0,
    storageReadable: !!storageZone && !!accessKey,
    missing,
    storageZone,
    storageEndpoint: getBunnyStorageEndpoint(),
    hasCdnBaseUrl: !!cdnBaseUrl
  };
}

function getBunnyConfig() {
  const storageZone = String(process.env.BUNNY_STORAGE_ZONE || '').trim();
  const accessKey = String(process.env.BUNNY_STORAGE_ACCESS_KEY || '').trim();
  const cdnBaseUrl = getBunnyCdnBaseUrl();
  if (!storageZone || !accessKey) return null;
  return {
    storageZone,
    accessKey,
    cdnBaseUrl,
    storageEndpoint: getBunnyStorageEndpoint()
  };
}

function bunnyStorageUrl(config, key) {
  return new URL(`/${encodeURIComponent(config.storageZone)}/${encodeAssetKeyPath(key)}`, `${config.storageEndpoint}/`);
}

export function bunnyCdnUrlForKey(key) {
  const config = getBunnyConfig();
  if (!config?.cdnBaseUrl) return null;
  return `${config.cdnBaseUrl}/${encodeAssetKeyPath(key)}`;
}

export async function putBunnyObject(key, buffer, contentType, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Bunny object body is empty');
  const config = getBunnyConfig();
  if (!config) {
    return { ok: false, skipped: true, status: 0, error: 'Bunny Storage is not configured' };
  }

  const normalizedKey = normalizeAssetKey(key);
  const res = await fetch(bunnyStorageUrl(config, normalizedKey), {
    method: 'PUT',
    headers: {
      AccessKey: config.accessKey,
      Checksum: sha256Hex(buffer).toUpperCase(),
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': options.cacheControl || IMMUTABLE_IMAGE_CACHE_CONTROL
    },
    body: buffer
  });
  if (!res.ok) {
    return {
      ok: false,
      skipped: false,
      status: res.status,
      error: await res.text().catch(() => `Bunny PUT failed with ${res.status}`)
    };
  }
  return {
    ok: true,
    skipped: false,
    status: res.status,
    key: normalizedKey,
    url: bunnyCdnUrlForKey(normalizedKey)
  };
}

export async function getBunnyObject(key) {
  const config = getBunnyConfig();
  if (!config) {
    return { ok: false, skipped: true, status: 0, error: 'Bunny Storage is not configured' };
  }

  const normalizedKey = normalizeAssetKey(key);
  const res = await fetch(bunnyStorageUrl(config, normalizedKey), {
    method: 'GET',
    headers: { AccessKey: config.accessKey }
  });
  if (!res.ok) {
    return {
      ok: false,
      skipped: false,
      status: res.status,
      error: await res.text().catch(() => `Bunny GET failed with ${res.status}`)
    };
  }
  return {
    ok: true,
    skipped: false,
    status: res.status,
    key: normalizedKey,
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    cacheControl: res.headers.get('cache-control') || IMMUTABLE_IMAGE_CACHE_CONTROL,
    etag: res.headers.get('etag') || null
  };
}
