// Shared capture-session primitives. This module is loaded only by research
// tooling and is intentionally absent from the normal gameplay bundle path.

import { bytesToHex, cloneResearchValue, stableStringify } from './research-format.js';

export const CAPTURE_SESSION_FORMAT = 'peggle-capture-session';
export const CAPTURE_SESSION_VERSION = 1;
export const DEFAULT_VISUAL_FPS = 15;
export const DEFAULT_MAX_BROWSER_FRAMES = 18000;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function safePart(value) {
  return String(value || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
}

export function readBrowserCaptureOptions(locationLike = globalThis.location) {
  let params = null;
  try {
    params = new URL(locationLike?.href || String(locationLike || ''), 'http://localhost').searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const visualValue = String(params.get('researchVisual') ?? '1').toLowerCase();
  return {
    visual: !['0', 'false', 'off', 'no'].includes(visualValue),
    visualFps: clampInteger(params.get('researchFps'), 1, 60, DEFAULT_VISUAL_FPS),
    maxFrames: clampInteger(params.get('researchMaxFrames'), 1, 65000, DEFAULT_MAX_BROWSER_FRAMES),
    imageType: params.get('researchImage') === 'png' ? 'image/png' : 'image/webp',
    imageQuality: 0.92
  };
}

// Produces at most one capture request per rendered frame. If game time jumps
// over several visual intervals, the request is aligned to the newest due
// interval and reports every skipped slot rather than duplicating one image.
export class GameTimeFrameScheduler {
  constructor(fps = DEFAULT_VISUAL_FPS) {
    this.fps = clampInteger(fps, 1, 240, DEFAULT_VISUAL_FPS);
    this.intervalMs = 1000 / this.fps;
    this.nextGameTimeMs = null;
    this.totalDue = 0;
    this.totalMissed = 0;
  }

  consume(gameTimeMs) {
    const now = finite(Number(gameTimeMs), 0);
    if (this.nextGameTimeMs === null) this.nextGameTimeMs = now;
    if (now + 1e-7 < this.nextGameTimeMs) return null;
    const passed = Math.max(0, Math.floor((now - this.nextGameTimeMs) / this.intervalMs + 1e-9));
    const scheduledGameTimeMs = this.nextGameTimeMs + passed * this.intervalMs;
    this.nextGameTimeMs += (passed + 1) * this.intervalMs;
    this.totalDue += passed + 1;
    this.totalMissed += passed;
    return { scheduledGameTimeMs, missedIntervals: passed };
  }
}

async function sha256Blob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
  }
  if (typeof process !== 'undefined' && process?.versions?.node) {
    const nodeCryptoModule = 'node:' + 'crypto';
    const { createHash } = await import(nodeCryptoModule);
    return createHash('sha256').update(bytes).digest('hex');
  }
  throw new Error('SHA-256 is unavailable for visual capture.');
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas?.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  if (typeof canvas?.toBlob !== 'function') return Promise.reject(new Error('Canvas Blob capture is unavailable.'));
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas encoding returned an empty Blob.')), type, quality);
  });
}

class BrowserFrameStore {
  constructor(sessionId) {
    this.sessionId = safePart(sessionId);
    this.memory = new Map();
    this.opfsDirectory = null;
    this.backend = 'memory';
    this.ready = this.initialize();
  }

  async initialize() {
    try {
      if (!globalThis.navigator?.storage?.getDirectory) return;
      const root = await globalThis.navigator.storage.getDirectory();
      const research = await root.getDirectoryHandle('peggle-research', { create: true });
      this.opfsDirectory = await research.getDirectoryHandle(this.sessionId, { create: true });
      await this.opfsDirectory.getDirectoryHandle('frames', { create: true });
      this.backend = 'opfs';
    } catch {
      this.opfsDirectory = null;
      this.backend = 'memory';
    }
  }

  async put(relativePath, blob) {
    await this.ready;
    if (!this.opfsDirectory) {
      this.memory.set(relativePath, blob);
      return;
    }
    const [directoryName, fileName] = relativePath.split('/');
    const directory = await this.opfsDirectory.getDirectoryHandle(directoryName, { create: true });
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async get(relativePath) {
    await this.ready;
    if (!this.opfsDirectory) return this.memory.get(relativePath) || null;
    const [directoryName, fileName] = relativePath.split('/');
    const directory = await this.opfsDirectory.getDirectoryHandle(directoryName);
    return (await directory.getFileHandle(fileName)).getFile();
  }
}

export class BrowserVisualCapture {
  constructor(game, options = {}) {
    this.game = game;
    this.sessionId = String(options.sessionId || `browser-${Date.now()}`);
    this.enabled = options.enabled !== false && typeof document !== 'undefined';
    this.fps = clampInteger(options.fps, 1, 60, DEFAULT_VISUAL_FPS);
    this.maxFrames = clampInteger(options.maxFrames, 1, 100000, DEFAULT_MAX_BROWSER_FRAMES);
    this.imageType = options.imageType === 'image/webp' ? 'image/webp' : 'image/png';
    this.imageQuality = finite(options.imageQuality, 0.92);
    this.scheduler = new GameTimeFrameScheduler(this.fps);
    this.store = new BrowserFrameStore(this.sessionId);
    this.frames = [];
    this.pending = null;
    this.pendingImmediateReasons = new Set();
    this.droppedWhileEncoding = 0;
    this.droppedAtLimit = 0;
    this.errors = [];
    this.captureCanvas = null;
    this.captureContext = null;
  }

  requestImmediate(reason = 'event') {
    if (this.enabled) this.pendingImmediateReasons.add(String(reason));
  }

  ensureCanvas() {
    const source = this.game?.canvas;
    if (!source) throw new Error('Game canvas is unavailable.');
    if (!this.captureCanvas) {
      this.captureCanvas = source.ownerDocument?.createElement?.('canvas') || document.createElement('canvas');
      this.captureContext = this.captureCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
    }
    if (this.captureCanvas.width !== source.width || this.captureCanvas.height !== source.height) {
      this.captureCanvas.width = source.width;
      this.captureCanvas.height = source.height;
    }
    return this.captureCanvas;
  }

  afterRender(sample = {}) {
    if (!this.enabled) return;
    const gameTimeMs = Math.max(0, finite(sample.gameTimeSeconds) * 1000);
    const due = this.scheduler.consume(gameTimeMs);
    const immediateReasons = [...this.pendingImmediateReasons];
    this.pendingImmediateReasons.clear();
    if (!due && immediateReasons.length === 0) return;
    const missedIntervals = due?.missedIntervals || 0;
    if (this.frames.length >= this.maxFrames) {
      this.droppedAtLimit += missedIntervals + 1;
      return;
    }
    if (this.pending) {
      this.droppedWhileEncoding += missedIntervals + 1;
      return;
    }
    const reasons = [];
    if (due) reasons.push('cadence');
    reasons.push(...immediateReasons);
    this.pending = this.capture({
      sequence: this.frames.length,
      step: Math.max(0, Math.trunc(finite(sample.step))),
      gameTimeMs,
      scheduledGameTimeMs: due?.scheduledGameTimeMs ?? gameTimeMs,
      wallTimeMs: Math.max(0, finite(sample.wallTimeSeconds) * 1000),
      missedIntervals,
      reasons: [...new Set(reasons)],
      speedMultiplier: finite(sample.speedMultiplier, 1)
    }).catch(error => {
      this.errors.push(String(error?.message || error));
    }).finally(() => {
      this.pending = null;
    });
  }

  async capture(metadata) {
    const canvas = this.ensureCanvas();
    const context = this.captureContext;
    const composed = this.game?.renderer?.drawCompositeTo?.(context);
    if (!composed) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(this.game.canvas, 0, 0);
    }
    const blob = await canvasToBlob(canvas, this.imageType, this.imageQuality);
    const actualType = blob.type === 'image/webp' ? 'image/webp' : 'image/png';
    const extension = actualType === 'image/webp' ? 'webp' : 'png';
    const path = `frames/frame-${String(metadata.sequence).padStart(6, '0')}.${extension}`;
    const sha256 = await sha256Blob(blob);
    await this.store.put(path, blob);
    this.frames.push({
      ...metadata,
      path,
      sha256,
      mediaType: actualType,
      width: canvas.width,
      height: canvas.height,
      byteLength: blob.size
    });
  }

  async flush() {
    if (this.pending) await this.pending;
    await this.store.ready;
  }

  async bundleFiles() {
    await this.flush();
    const files = [];
    for (const frame of this.frames) {
      const blob = await this.store.get(frame.path);
      if (blob) files.push({ path: frame.path, data: blob });
    }
    return files;
  }

  summary() {
    return {
      enabled: this.enabled,
      targetGameFps: this.fps,
      clock: 'simulation-step-time',
      accelerationInvariant: true,
      storageBackend: this.store.backend,
      imageType: this.imageType,
      frameCount: this.frames.length,
      scheduledFrameCount: this.scheduler.totalDue,
      missedScheduleIntervals: this.scheduler.totalMissed,
      droppedWhileEncoding: this.droppedWhileEncoding,
      droppedAtLimit: this.droppedAtLimit,
      maxFrames: this.maxFrames,
      errors: [...new Set(this.errors)]
    };
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

async function fileBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data));
}

// Minimal standards-compliant ZIP writer using the "store" method. Images are
// already compressed, so deflate would add CPU cost with negligible savings.
export async function createResearchZip(files, options = {}) {
  if (files.length > 0xffff) {
    throw new Error('Research bundle exceeds the ZIP32 file-count limit; lower researchMaxFrames.');
  }
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = zipDateTime(options.at ? new Date(options.at) : new Date());
  for (const file of files) {
    const name = new TextEncoder().encode(String(file.path).replaceAll('\\', '/'));
    const data = await fileBytes(file.data);
    if (name.length > 0xffff || data.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error('Research bundle exceeds ZIP32 limits; lower researchFps or researchMaxFrames.');
    }
    const crc = crc32(data);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, stamp.time, true);
    local.view.setUint16(12, stamp.date, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    localParts.push(local.bytes, name, data);

    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint16(12, stamp.time, true);
    central.view.setUint16(14, stamp.date, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    centralParts.push(central.bytes, name);
    offset += local.bytes.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (centralSize > 0xffffffff || offset > 0xffffffff) {
    throw new Error('Research bundle exceeds the 4 GiB ZIP32 limit; lower researchFps or researchMaxFrames.');
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  const parts = [...localParts, ...centralParts, end.bytes];
  if (typeof Blob !== 'undefined') return new Blob(parts, { type: 'application/zip' });
  const nodeBufferModule = 'node:' + 'buffer';
  const { Blob: NodeBlob } = await import(nodeBufferModule);
  return new NodeBlob(parts, { type: 'application/zip' });
}

export function makeCaptureSessionManifest(options = {}) {
  return {
    format: CAPTURE_SESSION_FORMAT,
    version: CAPTURE_SESSION_VERSION,
    sessionId: String(options.sessionId || 'unknown'),
    status: String(options.status || 'complete'),
    runtime: cloneResearchValue(options.runtime || {}),
    startedAt: String(options.startedAt || new Date().toISOString()),
    endedAt: options.endedAt == null ? null : String(options.endedAt),
    clock: cloneResearchValue(options.clock || {
      canonical: 'gameTimeMs',
      wall: 'monotonicMs',
      accelerationInvariant: true
    }),
    capturePolicy: cloneResearchValue(options.capturePolicy || {}),
    streams: cloneResearchValue(options.streams || {}),
    summary: cloneResearchValue(options.summary || {}),
    warnings: cloneResearchValue(options.warnings || [])
  };
}

export function jsonLines(values) {
  return values.map(value => stableStringify(value)).join('\n') + (values.length ? '\n' : '');
}
