import {
  DEFAULT_ASSET_KEY_PREFIX,
  IMMUTABLE_IMAGE_CACHE_CONTROL,
  contentTypeForAssetKey,
  keyForAsset,
  normalizeAssetKey,
  parseBase64Asset,
  parseDataImageUrl
} from './asset-utils.js';
import {
  getDriveAsset,
  getDriveAssetConfigStatus,
  putDriveAsset
} from './drive-asset-store.js';
import {
  bunnyCdnUrlForKey,
  getBunnyConfigStatus,
  getBunnyObject,
  putBunnyObject
} from './bunny-store.js';

function apiAssetUrlForKey(key, params = {}) {
  const search = new URLSearchParams({ key });
  for (const [name, value] of Object.entries(params)) {
    if (value != null && value !== '') search.set(name, value);
  }
  return `/api/assets?${search.toString()}`;
}

export function getAssetStoreStatus() {
  const bunny = getBunnyConfigStatus();
  return {
    deliveryMode: 'bunny-cdn',
    bunny: {
      enabled: bunny.enabled,
      storageReadable: bunny.storageReadable,
      missing: bunny.missing,
      hasCdnBaseUrl: bunny.hasCdnBaseUrl,
      storageZone: bunny.storageZone
    },
    drive: getDriveAssetConfigStatus()
  };
}

function assetPayloadFromRequest(input = {}) {
  if (input.dataUrl) return parseDataImageUrl(input.dataUrl);
  if (input.base64) return parseBase64Asset(input);
  throw new Error('dataUrl or base64 is required');
}

function publicAssetReference({ key, hash, bytes, contentType, bunnyResult, driveResult }) {
  const primaryUrl = bunnyResult?.url || bunnyCdnUrlForKey(key) || apiAssetUrlForKey(key);
  const fallbackUrl = driveResult?.ok ? apiAssetUrlForKey(key, { source: 'drive' }) : apiAssetUrlForKey(key);
  return {
    kind: 'asset',
    storageVersion: 1,
    key,
    hash,
    bytes,
    contentType,
    url: primaryUrl,
    primaryUrl,
    fallbackUrl
  };
}

export async function uploadAsset(input = {}) {
  const { buffer, contentType } = assetPayloadFromRequest(input);
  const keyInfo = input.key
    ? { key: normalizeAssetKey(input.key), hash: null }
    : keyForAsset({
        buffer,
        contentType,
        role: input.role,
        keyPrefix: input.keyPrefix || process.env.ASSET_KEY_PREFIX || DEFAULT_ASSET_KEY_PREFIX
      });
  const cacheControl = input.cacheControl || IMMUTABLE_IMAGE_CACHE_CONTROL;

  const [bunnyResult, driveResult] = await Promise.all([
    putBunnyObject(keyInfo.key, buffer, contentType, { cacheControl }).catch(error => ({
      ok: false,
      skipped: false,
      status: 0,
      error: error?.message || String(error)
    })),
    putDriveAsset(keyInfo.key, buffer, contentType).catch(error => ({
      ok: false,
      skipped: false,
      status: 0,
      error: error?.message || String(error)
    }))
  ]);

  const ok = bunnyResult.ok || driveResult.ok;
  return {
    ok,
    key: keyInfo.key,
    hash: keyInfo.hash,
    bytes: buffer.length,
    contentType,
    asset: publicAssetReference({
      key: keyInfo.key,
      hash: keyInfo.hash,
      bytes: buffer.length,
      contentType,
      bunnyResult,
      driveResult
    }),
    stores: {
      bunny: bunnyResult,
      drive: driveResult
    }
  };
}

export async function readAsset(key, options = {}) {
  const normalizedKey = normalizeAssetKey(key);
  const source = String(options.source || '').toLowerCase();
  if (source === 'drive') return await getDriveAsset(normalizedKey);
  if (source === 'bunny' || source === 'primary') return await getBunnyObject(normalizedKey);

  const bunny = await getBunnyObject(normalizedKey);
  if (bunny.ok) return { ...bunny, source: 'bunny' };
  const drive = await getDriveAsset(normalizedKey);
  if (drive.ok) return { ...drive, source: 'drive' };

  return {
    ok: false,
    status: bunny.status || drive.status || 404,
    error: bunny.error || drive.error || 'Asset not found',
    attempts: { bunny, drive },
    contentType: contentTypeForAssetKey(normalizedKey)
  };
}
