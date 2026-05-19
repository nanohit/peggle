import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const DEFAULT_ENV_FILE = '.env';
const DEFAULT_API_BASE = 'https://peggle.vercel.app/api';
const DEFAULT_ROOT_FOLDER = 'Alea_Data';
const SNAPSHOT_FOLDER_NAME = 'snapshots';
const MIRROR_FOLDER_NAME = 'mirror';

function parseArgs(argv) {
  const args = {
    envFile: process.env.GOOGLE_OAUTH_ENV_FILE || DEFAULT_ENV_FILE,
    apiBase: process.env.ALEA_BACKUP_API_BASE || DEFAULT_API_BASE
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--env-file' && next) args.envFile = next, i++;
    else if (arg === '--api-base' && next) args.apiBase = next.replace(/\/$/, ''), i++;
  }
  return args;
}

async function readEnvFile(filePath) {
  const values = {};
  const raw = await fs.readFile(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    try {
      values[match[1]] = JSON.parse(match[2]);
    } catch {
      values[match[1]] = match[2];
    }
  }
  return values;
}

async function getAccessToken(env) {
  const clientId = env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DRIVE_REFRESH_TOKEN are required.');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth refresh did not return an access_token.');
  return data.access_token;
}

async function driveRequest(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Drive request failed: ${res.status} ${await res.text()}`);
  return res;
}

function driveQueryLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(token, name, parentId = null) {
  const clauses = [
    `name = '${driveQueryLiteral(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false'
  ];
  if (parentId) clauses.push(`'${driveQueryLiteral(parentId)}' in parents`);
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    spaces: 'drive',
    fields: 'files(id,name,createdTime,modifiedTime,webViewLink)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await driveRequest(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  const data = await res.json();
  return data.files?.[0] || null;
}

async function ensureFolder(token, name, parentId = null) {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) body.parents = [parentId];
  const res = await driveRequest(token, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,createdTime,modifiedTime,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function findFile(token, name, parentId) {
  const params = new URLSearchParams({
    q: [
      `name = '${driveQueryLiteral(name)}'`,
      'trashed = false',
      `'${driveQueryLiteral(parentId)}' in parents`
    ].join(' and '),
    spaces: 'drive',
    fields: 'files(id,name,createdTime,modifiedTime,webViewLink)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await driveRequest(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  const data = await res.json();
  return data.files?.[0] || null;
}

async function uploadJson(token, parentId, name, value, { updateExisting = false } = {}) {
  const content = JSON.stringify(value, null, 2);
  const boundary = `alea_${crypto.randomBytes(12).toString('hex')}`;
  const metadata = { name, mimeType: 'application/json', parents: [parentId] };
  let method = 'POST';
  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,createdTime,modifiedTime,webViewLink';
  if (updateExisting) {
    const existing = await findFile(token, name, parentId);
    if (existing) {
      method = 'PATCH';
      delete metadata.parents;
      url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,createdTime,modifiedTime,webViewLink`;
    }
  }
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const res = await driveRequest(token, url, {
    method,
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  return await res.json();
}

function fileNameForRecord(name) {
  return `${encodeURIComponent(name)}.json`;
}

function createMirrorEnvelope({ key, collection, name, value, updatedAt, revision }) {
  return {
    schemaVersion: 1,
    key,
    collection,
    name,
    value,
    deleted: false,
    source: 'backup-seed',
    updatedAt,
    revision
  };
}

async function uploadMirrorRecord(token, collectionFolders, { collection, name, key, value, updatedAt, revision }) {
  const folder = collectionFolders.get(collection);
  if (!folder) throw new Error(`Missing Drive mirror collection folder: ${collection}`);
  return await uploadJson(
    token,
    folder.id,
    fileNameForRecord(name),
    createMirrorEnvelope({ key, collection, name, value, updatedAt, revision }),
    { updateExisting: true }
  );
}

async function uploadMirrorTree(token, rootFolder, snapshot) {
  const mirror = await ensureFolder(token, MIRROR_FOLDER_NAME, rootFolder.id);
  const collections = ['levels', 'campaigns', 'config', 'characters', 'pvp-duel'];
  const collectionFolders = new Map();
  for (const collection of collections) {
    collectionFolders.set(collection, await ensureFolder(token, collection, mirror.id));
  }

  const updatedAt = snapshot.finishedAt;
  const revision = `backup-${updatedAt}`;
  let count = 0;
  const levelNames = snapshot.collections.levels.map(item => item.name);
  await uploadMirrorRecord(token, collectionFolders, {
    collection: 'levels',
    name: '__index',
    key: 'level:__index',
    value: levelNames,
    updatedAt,
    revision
  });
  count++;
  for (const item of snapshot.collections.levels) {
    await uploadMirrorRecord(token, collectionFolders, {
      collection: 'levels',
      name: item.name,
      key: `level:${item.name}`,
      value: item.data,
      updatedAt,
      revision
    });
    count++;
  }

  const campaignNames = snapshot.collections.campaigns.map(item => item.name);
  await uploadMirrorRecord(token, collectionFolders, {
    collection: 'campaigns',
    name: '__index',
    key: 'campaign:__index',
    value: campaignNames,
    updatedAt,
    revision
  });
  count++;
  for (const item of snapshot.collections.campaigns) {
    await uploadMirrorRecord(token, collectionFolders, {
      collection: 'campaigns',
      name: item.name,
      key: `campaign:${item.name}`,
      value: item.data,
      updatedAt,
      revision
    });
    count++;
  }

  await uploadMirrorRecord(token, collectionFolders, {
    collection: 'config',
    name: 'primaryCampaign',
    key: 'config:primaryCampaign',
    value: snapshot.collections.config.primaryCampaign,
    updatedAt,
    revision
  });
  count++;
  await uploadMirrorRecord(token, collectionFolders, {
    collection: 'characters',
    name: '__registry',
    key: 'character:__registry',
    value: snapshot.collections.characters,
    updatedAt,
    revision
  });
  count++;
  await uploadMirrorRecord(token, collectionFolders, {
    collection: 'pvp-duel',
    name: 'levels',
    key: 'pvp:duel:levels',
    value: snapshot.collections.pvpDuelLevels,
    updatedAt,
    revision
  });
  count++;

  return { mirrorFolder: mirror, count };
}

async function getJson(apiBase, path) {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function collectSnapshot(apiBase) {
  const startedAt = new Date().toISOString();
  const levelList = await getJson(apiBase, '/levels');
  const levelNames = Array.isArray(levelList.names) ? levelList.names : [];
  const levels = [];
  for (const name of levelNames) {
    levels.push({ name, data: await getJson(apiBase, `/levels?name=${encodeURIComponent(name)}`) });
  }

  const campaignList = await getJson(apiBase, '/campaigns');
  const campaignNames = Array.isArray(campaignList.campaigns)
    ? campaignList.campaigns.map(item => item?.name).filter(Boolean)
    : [];
  const campaigns = [];
  for (const name of campaignNames) {
    campaigns.push({ name, data: await getJson(apiBase, `/campaigns?name=${encodeURIComponent(name)}`) });
  }

  const [characters, primaryCampaign, pvpDuelLevels] = await Promise.all([
    getJson(apiBase, '/characters').catch(error => ({ error: error.message })),
    getJson(apiBase, '/config?key=primaryCampaign').catch(error => ({ key: 'primaryCampaign', error: error.message })),
    getJson(apiBase, '/pvp-duel?levels=true').catch(error => ({ error: error.message }))
  ]);

  const snapshot = {
    schemaVersion: 1,
    kind: 'alea-public-api-snapshot',
    source: apiBase,
    startedAt,
    finishedAt: new Date().toISOString(),
    collections: {
      levels,
      campaigns,
      config: { primaryCampaign: primaryCampaign?.value ?? null },
      characters,
      pvpDuelLevels: Array.isArray(pvpDuelLevels?.names) ? pvpDuelLevels.names : []
    },
    stats: {
      levelCount: levels.length,
      campaignCount: campaigns.length,
      characterBytes: JSON.stringify(characters).length,
      totalBytes: 0
    }
  };
  snapshot.stats.totalBytes = JSON.stringify(snapshot).length;
  return snapshot;
}

const args = parseArgs(process.argv.slice(2));
const env = await readEnvFile(args.envFile);
const token = await getAccessToken(env);
const rootName = env.GOOGLE_DRIVE_ROOT_FOLDER_NAME || DEFAULT_ROOT_FOLDER;
const root = await ensureFolder(token, rootName);
const snapshots = await ensureFolder(token, SNAPSHOT_FOLDER_NAME, root.id);
const snapshot = await collectSnapshot(args.apiBase);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const timestampFile = await uploadJson(token, snapshots.id, `redis-public-snapshot-${stamp}.json`, snapshot);
const latestFile = await uploadJson(token, snapshots.id, 'redis-public-snapshot-latest.json', snapshot, { updateExisting: true });
const mirror = await uploadMirrorTree(token, root, snapshot);

console.log(JSON.stringify({
  rootFolder: { id: root.id, name: root.name, webViewLink: root.webViewLink },
  snapshotFolder: { id: snapshots.id, name: snapshots.name, webViewLink: snapshots.webViewLink },
  mirrorFolder: { id: mirror.mirrorFolder.id, name: mirror.mirrorFolder.name, webViewLink: mirror.mirrorFolder.webViewLink },
  mirrorRecordCount: mirror.count,
  timestampFile,
  latestFile,
  stats: snapshot.stats
}, null, 2));
