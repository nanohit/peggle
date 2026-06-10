import { createHash } from 'crypto';

export const DEFAULT_ASSET_KEY_PREFIX = 'level-assets';
export const DEFAULT_ASSET_ROLE = 'backgrounds';
export const IMMUTABLE_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const IMMUTABLE_IMAGE_CDN_CACHE_CONTROL = 'public, s-maxage=31536000, immutable';

const MIME_EXTENSIONS = new Map([
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/svg+xml', 'svg'],
  ['image/webp', 'webp']
]);

const EXTENSION_MIME_TYPES = new Map([
  ['avif', 'image/avif'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp']
]);

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeAssetKeyPrefix(prefix = DEFAULT_ASSET_KEY_PREFIX) {
  const raw = String(prefix || DEFAULT_ASSET_KEY_PREFIX)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const segments = raw
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-'))
    .filter(Boolean);
  return segments.length ? segments.join('/') : DEFAULT_ASSET_KEY_PREFIX;
}

export function normalizeAssetRole(role = DEFAULT_ASSET_ROLE) {
  const normalized = String(role || DEFAULT_ASSET_ROLE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_ASSET_ROLE;
}

export function normalizeAssetKey(key) {
  const normalized = String(key || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();

  if (!normalized) throw new Error('asset key is required');
  if (normalized.length > 512) throw new Error('asset key is too long');
  if (/[\x00-\x1f\x7f]/.test(normalized)) throw new Error('asset key contains control characters');

  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('asset key contains unsafe path segments');
  }
  return normalized;
}

export function encodeAssetKeyPath(key) {
  return normalizeAssetKey(key).split('/').map(encodeURIComponent).join('/');
}

export function extensionForContentType(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS.get(normalized) || 'bin';
}

export function contentTypeForAssetKey(key, fallback = 'application/octet-stream') {
  const match = /\.([a-z0-9]+)$/i.exec(String(key || ''));
  if (!match) return fallback;
  return EXTENSION_MIME_TYPES.get(match[1].toLowerCase()) || fallback;
}

export function parseDataImageUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('dataUrl must be a string');
  const match = /^data:(image\/[a-zA-Z0-9.+-]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(dataUrl);
  if (!match) throw new Error('dataUrl must be a base64 image data URL');

  const contentType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('dataUrl contains no image bytes');
  return { buffer, contentType };
}

export function parseBase64Asset({ base64, contentType }) {
  if (typeof base64 !== 'string') throw new Error('base64 must be a string');
  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!MIME_EXTENSIONS.has(normalizedContentType)) {
    throw new Error('contentType must be a supported image MIME type');
  }
  const buffer = Buffer.from(base64.replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('base64 contains no image bytes');
  return { buffer, contentType: normalizedContentType };
}

export function keyForAsset({ buffer, contentType, role, keyPrefix } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('asset buffer is required');
  const hash = sha256Hex(buffer);
  const prefix = normalizeAssetKeyPrefix(keyPrefix);
  const safeRole = normalizeAssetRole(role);
  const ext = extensionForContentType(contentType);
  return {
    hash,
    key: normalizeAssetKey(`${prefix}/${safeRole}/${hash}.${ext}`)
  };
}
