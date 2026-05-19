// Shared browser-side image compression for editor uploads and level snapshots.

const DEFAULT_MAX_SIZE = 512;
const DEFAULT_QUALITY = 0.8;
const DEFAULT_TYPE = 'image/webp';
const DEFAULT_FALLBACK_TYPE = 'image/png';

export function isDataImageUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

export function estimateDataUrlBytes(value) {
  if (!isDataImageUrl(value)) return 0;
  const comma = value.indexOf(',');
  if (comma === -1) return value.length;
  const meta = value.slice(0, comma).toLowerCase();
  const body = value.slice(comma + 1);
  if (meta.includes(';base64')) {
    const padding = body.endsWith('==') ? 2 : (body.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
  }
  try {
    return decodeURIComponent(body).length;
  } catch {
    return body.length;
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function positiveInt(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeCompressionOptions(options = {}) {
  const maxSize = positiveInt(options.maxSize, DEFAULT_MAX_SIZE);
  return {
    maxWidth: positiveInt(options.maxWidth, maxSize),
    maxHeight: positiveInt(options.maxHeight, maxSize),
    quality: clampNumber(options.quality, 0.1, 1, DEFAULT_QUALITY),
    type: typeof options.type === 'string' ? options.type : DEFAULT_TYPE,
    fallbackType: typeof options.fallbackType === 'string' ? options.fallbackType : DEFAULT_FALLBACK_TYPE,
    maxDataUrlBytes: options.maxDataUrlBytes == null
      ? null
      : positiveInt(options.maxDataUrlBytes, null)
  };
}

function canUseCanvasCompression() {
  return typeof Image !== 'undefined'
    && typeof document !== 'undefined'
    && typeof document.createElement === 'function';
}

function readFileAsDataUrl(file) {
  return new Promise(resolve => {
    if (!file || typeof FileReader === 'undefined') {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = event => resolve(typeof event.target?.result === 'string' ? event.target.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fitWithin(width, height, maxWidth, maxHeight) {
  const safeWidth = Math.max(1, width || 1);
  const safeHeight = Math.max(1, height || 1);
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    scale
  };
}

function canvasToDataUrl(canvas, options) {
  const preferred = canvas.toDataURL(options.type, options.quality);
  if (preferred.startsWith(`data:${options.type}`)) return preferred;
  return canvas.toDataURL(options.fallbackType, options.quality);
}

export async function compressDataImageUrl(dataUrl, options = {}) {
  if (!isDataImageUrl(dataUrl) || !canUseCanvasCompression()) return dataUrl || null;

  const normalized = normalizeCompressionOptions(options);
  const img = await loadImage(dataUrl);
  if (!img) return dataUrl;

  const fitted = fitWithin(img.width, img.height, normalized.maxWidth, normalized.maxHeight);
  const originalBytes = estimateDataUrlBytes(dataUrl);
  if (
    fitted.scale >= 1
    && normalized.maxDataUrlBytes != null
    && originalBytes <= normalized.maxDataUrlBytes
  ) {
    return dataUrl;
  }

  const canvas = document.createElement('canvas');
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, fitted.width, fitted.height);

  try {
    const compressed = canvasToDataUrl(canvas, normalized);
    return compressed.length < dataUrl.length ? compressed : dataUrl;
  } catch {
    return dataUrl;
  }
}

export async function compressImageFile(file, options = {}) {
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return null;
  return compressDataImageUrl(dataUrl, options);
}

function queueCompression(tasks, target, key, options) {
  const value = target?.[key];
  if (!isDataImageUrl(value)) return;
  tasks.push(
    compressDataImageUrl(value, options).then(compressed => {
      if (compressed) target[key] = compressed;
    })
  );
}

export async function compressLevelBackgroundImages(level, options = {}) {
  if (!level || typeof level !== 'object') return level;

  const viewportWidth = positiveInt(options.viewportWidth, 400);
  const viewportHeight = positiveInt(options.viewportHeight, 600);
  const backgroundOptions = {
    maxWidth: Math.max(800, viewportWidth * 2),
    maxHeight: Math.max(800, viewportHeight * 2),
    quality: 0.8,
    fallbackType: 'image/jpeg',
    maxDataUrlBytes: 420 * 1024
  };
  const survivalWorldHeight = positiveInt(level.survival?.worldHeight, viewportHeight * 3);
  const survivalOptions = {
    maxWidth: Math.max(800, viewportWidth * 2),
    maxHeight: Math.max(800, Math.min(2400, survivalWorldHeight)),
    quality: 0.8,
    fallbackType: 'image/jpeg',
    maxDataUrlBytes: 520 * 1024
  };
  const slotOptions = {
    maxWidth: 512,
    maxHeight: 512,
    quality: 0.8,
    fallbackType: 'image/png',
    maxDataUrlBytes: 220 * 1024
  };

  const tasks = [];
  const background = level.visuals?.background;
  if (background && typeof background === 'object') {
    queueCompression(tasks, background, 'image', backgroundOptions);
    queueCompression(tasks, background, 'progressionImage', backgroundOptions);
  }

  const survivalBackground = level.survival?.background;
  if (survivalBackground && typeof survivalBackground === 'object') {
    queueCompression(tasks, survivalBackground, 'image', survivalOptions);
  }

  const slots = level.visuals?.slots;
  if (slots && typeof slots === 'object') {
    for (const slot of Object.values(slots)) {
      if (slot && typeof slot === 'object') {
        queueCompression(tasks, slot, 'customSrc', slotOptions);
      }
    }
  }

  if (tasks.length > 0) await Promise.all(tasks);
  return level;
}
