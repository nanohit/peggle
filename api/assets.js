import {
  IMMUTABLE_IMAGE_CDN_CACHE_CONTROL,
  IMMUTABLE_IMAGE_CACHE_CONTROL,
  contentTypeForAssetKey,
  normalizeAssetKey
} from '../server/asset-utils.js';
import {
  getAssetStoreStatus,
  readAsset,
  uploadAsset
} from '../server/asset-store.js';

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendAsset(req, res, asset) {
  const contentType = asset.contentType || contentTypeForAssetKey(asset.key);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', asset.cacheControl || IMMUTABLE_IMAGE_CACHE_CONTROL);
  res.setHeader('CDN-Cache-Control', IMMUTABLE_IMAGE_CDN_CACHE_CONTROL);
  res.setHeader('Vercel-CDN-Cache-Control', IMMUTABLE_IMAGE_CDN_CACHE_CONTROL);
  res.setHeader('X-Asset-Source', asset.source || 'unknown');
  if (asset.etag) res.setHeader('ETag', asset.etag);
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(asset.buffer);
}

export default async function handler(req, res) {
  try {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (firstQueryValue(req.query.status) === '1') {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(getAssetStoreStatus());
      }

      const key = normalizeAssetKey(firstQueryValue(req.query.key));
      const source = firstQueryValue(req.query.source);
      const asset = await readAsset(key, { source });
      if (!asset.ok) {
        const status = asset.status && asset.status >= 400 ? asset.status : 404;
        return res.status(status).json({ error: asset.error || 'Asset not found' });
      }
      return sendAsset(req, res, asset);
    }

    if (req.method === 'POST') {
      const input = parseBody(req);
      const result = await uploadAsset(input);
      const status = result.ok ? 200 : 503;
      return res.status(status).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = /required|invalid|unsafe|unsupported|must be/i.test(error?.message || '') ? 400 : 500;
    console.error('[api/assets]', error);
    return res.status(status).json({ error: error?.message || 'Internal error' });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' }
  }
};
