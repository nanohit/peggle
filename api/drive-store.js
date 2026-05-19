const DEFAULT_ROOT_FOLDER = 'Alea_Data';
const MIRROR_FOLDER = 'mirror';
const DRIVE_CACHE_TTL_MS = 15000;

let tokenCache = { value: null, expiresAt: 0 };
const folderCache = new Map();
const fileCache = new Map();
const recordCache = new Map();

export function isDriveMirrorEnabled() {
  return process.env.GOOGLE_DRIVE_MIRROR_ENABLED === '1'
    && !!process.env.GOOGLE_DRIVE_CLIENT_ID
    && !!process.env.GOOGLE_DRIVE_CLIENT_SECRET
    && !!process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
}

export function mirrorMetaKey(key) {
  return `drive:meta:${key}`;
}

export function createMirrorEnvelope({ key, collection, name, value, deleted = false, source = 'api-write' }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    key,
    collection,
    name,
    value: deleted ? null : value,
    deleted: deleted === true,
    source,
    updatedAt: now,
    revision: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  };
}

export function mirrorMetaFromEnvelope(envelope) {
  if (!envelope) return null;
  return {
    schemaVersion: envelope.schemaVersion || 1,
    key: envelope.key,
    collection: envelope.collection,
    name: envelope.name,
    deleted: envelope.deleted === true,
    source: envelope.source || 'api-write',
    updatedAt: envelope.updatedAt,
    revision: envelope.revision
  };
}

function compareMirrorVersions(a, b) {
  const at = Date.parse(a?.updatedAt || '') || 0;
  const bt = Date.parse(b?.updatedAt || '') || 0;
  if (at !== bt) return at - bt;
  return String(a?.revision || '').localeCompare(String(b?.revision || ''));
}

function driveWinsOverLegacy(record) {
  if (record?.source === 'api-write' || record?.source === 'api-delete') return true;
  return process.env.GOOGLE_DRIVE_RESTORE_MODE === '1';
}

export function selectMirroredValue({ redisValue, redisMeta, driveRecord }) {
  const hasRedis = redisValue != null;
  const hasDrive = !!driveRecord;

  if (!hasRedis && !hasDrive) return { found: false, value: null, deleted: false, source: 'none' };
  if (!hasRedis) {
    return driveRecord.deleted
      ? { found: false, value: null, deleted: true, source: 'drive' }
      : { found: true, value: driveRecord.value, deleted: false, source: 'drive' };
  }
  if (!hasDrive) return { found: true, value: redisValue, deleted: false, source: 'redis' };

  if (redisMeta) {
    const winner = compareMirrorVersions(redisMeta, driveRecord) >= 0 ? 'redis' : 'drive';
    if (winner === 'redis') {
      return redisMeta.deleted
        ? { found: false, value: null, deleted: true, source: 'redis-meta' }
        : { found: true, value: redisValue, deleted: false, source: 'redis-meta' };
    }
    return driveRecord.deleted
      ? { found: false, value: null, deleted: true, source: 'drive' }
      : { found: true, value: driveRecord.value, deleted: false, source: 'drive' };
  }

  if (driveWinsOverLegacy(driveRecord)) {
    return driveRecord.deleted
      ? { found: false, value: null, deleted: true, source: 'drive-over-legacy' }
      : { found: true, value: driveRecord.value, deleted: false, source: 'drive-over-legacy' };
  }

  return { found: true, value: redisValue, deleted: false, source: 'redis-legacy' };
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 60000) return tokenCache.value;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Drive OAuth refresh failed: ${res.status}`);
  const data = await res.json();
  tokenCache = {
    value: data.access_token,
    expiresAt: now + Math.max(1, Number(data.expires_in) || 3600) * 1000
  };
  return tokenCache.value;
}

async function driveRequest(url, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Drive request failed: ${res.status}`);
  return res;
}

function driveQueryLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(name, parentId = null) {
  const clauses = [
    `name = '${driveQueryLiteral(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false'
  ];
  if (parentId) clauses.push(`'${driveQueryLiteral(parentId)}' in parents`);
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    spaces: 'drive',
    fields: 'files(id,name)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`);
  const data = await res.json();
  return data.files?.[0] || null;
}

async function ensureFolder(name, parentId = null) {
  const cacheKey = `${parentId || 'root'}:${name}`;
  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);
  const existing = await findFolder(name, parentId);
  if (existing) {
    folderCache.set(cacheKey, existing);
    return existing;
  }
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) body.parents = [parentId];
  const res = await driveRequest('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const folder = await res.json();
  folderCache.set(cacheKey, folder);
  return folder;
}

async function getCollectionFolder(collection) {
  const rootName = process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME || DEFAULT_ROOT_FOLDER;
  const root = await ensureFolder(rootName);
  const mirror = await ensureFolder(MIRROR_FOLDER, root.id);
  return await ensureFolder(collection, mirror.id);
}

function fileNameForRecord(name) {
  return `${encodeURIComponent(name)}.json`;
}

async function findFile(name, parentId) {
  const cacheKey = `${parentId}:${name}`;
  if (fileCache.has(cacheKey)) return fileCache.get(cacheKey);
  const params = new URLSearchParams({
    q: [
      `name = '${driveQueryLiteral(name)}'`,
      'trashed = false',
      `'${driveQueryLiteral(parentId)}' in parents`
    ].join(' and '),
    spaces: 'drive',
    fields: 'files(id,name)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`);
  const data = await res.json();
  const file = data.files?.[0] || null;
  if (file) fileCache.set(cacheKey, file);
  return file;
}

export async function readDriveRecord(collection, name) {
  if (!isDriveMirrorEnabled()) return null;
  const cacheKey = `${collection}:${name}`;
  const cached = recordCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const folder = await getCollectionFolder(collection);
    const file = await findFile(fileNameForRecord(name), folder.id);
    if (!file) {
      recordCache.set(cacheKey, { value: null, expiresAt: Date.now() + DRIVE_CACHE_TTL_MS });
      return null;
    }
    const res = await driveRequest(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`);
    const record = await res.json();
    recordCache.set(cacheKey, { value: record, expiresAt: Date.now() + DRIVE_CACHE_TTL_MS });
    return record;
  } catch (error) {
    console.warn('[drive-store] read failed:', collection, name, error?.message || error);
    return null;
  }
}

export async function writeDriveRecord(collection, name, envelope) {
  if (!isDriveMirrorEnabled()) return false;
  try {
    const folder = await getCollectionFolder(collection);
    const filename = fileNameForRecord(name);
    const existing = await findFile(filename, folder.id);
    const boundary = `alea_${Math.random().toString(36).slice(2)}`;
    const metadata = { name: filename, mimeType: 'application/json', parents: [folder.id] };
    let method = 'POST';
    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name';
    if (existing) {
      method = 'PATCH';
      delete metadata.parents;
      url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id,name`;
    }
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(envelope),
      `--${boundary}--`,
      ''
    ].join('\r\n');
    const res = await driveRequest(url, {
      method,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const file = await res.json();
    fileCache.set(`${folder.id}:${filename}`, file);
    recordCache.set(`${collection}:${name}`, {
      value: envelope,
      expiresAt: Date.now() + DRIVE_CACHE_TTL_MS
    });
    return true;
  } catch (error) {
    console.warn('[drive-store] write failed:', collection, name, error?.message || error);
    return false;
  }
}
