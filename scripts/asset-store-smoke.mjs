import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getAssetStoreStatus,
  readAsset,
  uploadAsset
} from '../server/asset-store.js';

const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function loadDotEnv() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function publicStatus(status) {
  return {
    deliveryMode: status.deliveryMode,
    bunny: {
      enabled: status.bunny.enabled,
      storageReadable: status.bunny.storageReadable,
      missing: status.bunny.missing,
      hasCdnBaseUrl: status.bunny.hasCdnBaseUrl,
      storageZone: status.bunny.storageZone || ''
    },
    drive: status.drive
  };
}

loadDotEnv();

console.log('Asset store status:');
console.log(JSON.stringify(publicStatus(getAssetStoreStatus()), null, 2));

const uploaded = await uploadAsset({
  dataUrl: TINY_PNG_DATA_URL,
  role: 'smoke'
});

console.log('Upload result:');
console.log(JSON.stringify({
  ok: uploaded.ok,
  key: uploaded.key,
  bytes: uploaded.bytes,
  contentType: uploaded.contentType,
  stores: {
    bunny: {
      ok: uploaded.stores.bunny.ok,
      skipped: uploaded.stores.bunny.skipped,
      status: uploaded.stores.bunny.status || null,
      hasUrl: !!uploaded.stores.bunny.url,
      error: uploaded.stores.bunny.error || null
    },
    drive: {
      ok: uploaded.stores.drive.ok,
      skipped: uploaded.stores.drive.skipped,
      status: uploaded.stores.drive.status || null,
      fileId: uploaded.stores.drive.fileId ? '<present>' : null,
      error: uploaded.stores.drive.error || null
    }
  }
}, null, 2));

if (!uploaded.ok) process.exit(1);

const automatic = await readAsset(uploaded.key);
const drive = await readAsset(uploaded.key, { source: 'drive' });

console.log('Read checks:');
console.log(JSON.stringify({
  automatic: {
    ok: automatic.ok,
    source: automatic.source || null,
    bytes: automatic.buffer?.length || 0,
    contentType: automatic.contentType || null
  },
  drive: {
    ok: drive.ok,
    bytes: drive.buffer?.length || 0,
    contentType: drive.contentType || null
  }
}, null, 2));

if (!automatic.ok || !drive.ok) process.exit(1);
