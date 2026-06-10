import {
  IMMUTABLE_IMAGE_CACHE_CONTROL,
  contentTypeForAssetKey,
  normalizeAssetKey
} from './asset-utils.js';
import {
  downloadDriveFile,
  ensureDriveFolderPath,
  findDriveFileInFolder,
  isDriveMirrorEnabled,
  writeDriveBlobFile
} from '../api/drive-store.js';

const DEFAULT_DRIVE_ASSETS_FOLDER = 'assets';

function splitAssetKey(key) {
  const normalized = normalizeAssetKey(key);
  const parts = normalized.split('/');
  return {
    normalized,
    folders: parts.slice(0, -1),
    filename: parts[parts.length - 1]
  };
}

export function getDriveAssetConfigStatus() {
  return {
    enabled: isDriveMirrorEnabled(),
    folderName: String(process.env.GOOGLE_DRIVE_ASSETS_FOLDER_NAME || DEFAULT_DRIVE_ASSETS_FOLDER).trim()
      || DEFAULT_DRIVE_ASSETS_FOLDER
  };
}

async function getDriveAssetFolder(key) {
  const status = getDriveAssetConfigStatus();
  if (!status.enabled) return null;
  const { folders } = splitAssetKey(key);
  return await ensureDriveFolderPath([status.folderName, ...folders]);
}

export async function putDriveAsset(key, buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Drive asset body is empty');
  const status = getDriveAssetConfigStatus();
  if (!status.enabled) {
    return { ok: false, skipped: true, status: 0, error: 'Google Drive asset fallback is not configured' };
  }

  const { normalized, filename } = splitAssetKey(key);
  try {
    const folder = await getDriveAssetFolder(normalized);
    const existing = await findDriveFileInFolder(filename, folder.id);
    const file = await writeDriveBlobFile({
      name: filename,
      parentId: folder.id,
      mimeType: contentType || contentTypeForAssetKey(normalized),
      body: buffer,
      existingFileId: existing?.id || null
    });
    return {
      ok: true,
      skipped: false,
      key: normalized,
      fileId: file?.id || existing?.id || null,
      fileName: file?.name || filename
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      error: error?.message || String(error)
    };
  }
}

export async function getDriveAsset(key) {
  const status = getDriveAssetConfigStatus();
  if (!status.enabled) {
    return { ok: false, skipped: true, status: 0, error: 'Google Drive asset fallback is not configured' };
  }

  const { normalized, filename } = splitAssetKey(key);
  try {
    const folder = await getDriveAssetFolder(normalized);
    const file = await findDriveFileInFolder(filename, folder.id);
    if (!file) return { ok: false, skipped: false, status: 404, error: 'Drive asset not found' };
    const data = await downloadDriveFile(file.id);
    if (!data?.buffer?.length) return { ok: false, skipped: false, status: 404, error: 'Drive asset is empty' };
    return {
      ok: true,
      skipped: false,
      status: 200,
      key: normalized,
      buffer: data.buffer,
      contentType: data.contentType || contentTypeForAssetKey(normalized),
      cacheControl: IMMUTABLE_IMAGE_CACHE_CONTROL,
      etag: data.etag
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      error: error?.message || String(error)
    };
  }
}
