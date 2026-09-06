// Canonical research-record helpers shared by the browser recorder and Node tools.
// This module is developer-only; gameplay code must not depend on it.

export const RESEARCH_FORMAT = 'peggle-research';
export const RESEARCH_FORMAT_VERSION = 1;
export const RESEARCH_TOOL_VERSION = '0.1.0';

const STRUCTURAL_PEG_KEYS = new Set([
  'id', 'type', 'shape', 'x', 'y', 'angle', 'width', 'height', 'radius',
  'groupId', 'animation', 'curveSlices'
]);

function jsonSafe(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) {
    return value.map(item => {
      const safe = jsonSafe(item, seen);
      return safe === undefined ? null : safe;
    });
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value)) {
      const safe = jsonSafe(value[key], seen);
      if (safe !== undefined) result[key] = safe;
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function cloneResearchValue(value) {
  return jsonSafe(value);
}

export function canonicalize(value) {
  const safe = jsonSafe(value);
  if (Array.isArray(safe)) return safe.map(canonicalize);
  if (safe && typeof safe === 'object') {
    const result = {};
    for (const key of Object.keys(safe).sort()) {
      result[key] = canonicalize(safe[key]);
    }
    return result;
  }
  return safe;
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(text) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  }
  if (typeof process !== 'undefined' && process?.versions?.node) {
    // Keep the Node fallback opaque to the browser bundler. A literal
    // `import('node:crypto')` makes esbuild resolve a Node builtin even though
    // this branch is unreachable in browsers.
    const nodeCryptoModule = 'node:' + 'crypto';
    const { createHash } = await import(nodeCryptoModule);
    return createHash('sha256').update(String(text)).digest('hex');
  }
  throw new Error('SHA-256 is unavailable in this runtime.');
}

export async function digestResearchValue(value) {
  return sha256Text(stableStringify(value));
}

export function researchLevelDigestPayload(levelRecord) {
  if (!levelRecord || levelRecord.recordType !== 'level' || !levelRecord.authored) {
    throw new TypeError('A canonical level record is required.');
  }
  return {
    format: RESEARCH_FORMAT,
    formatVersion: RESEARCH_FORMAT_VERSION,
    authored: cloneResearchValue(levelRecord.authored)
  };
}

export async function digestResearchLevel(levelRecord) {
  return digestResearchValue(researchLevelDigestPayload(levelRecord));
}

function slug(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'untitled';
}

function inferNativeObjectKind(peg) {
  const type = String(peg?.type || '').toLowerCase();
  if (type === 'portalblue' || type === 'portalorange') return 'portal';
  if (type === 'bumper') return 'bumper';
  if (peg?.shape === 'brick') return 'brick';
  return 'circle';
}

function inferNativeObjectRole(peg) {
  const type = String(peg?.type || '').toLowerCase();
  if (type === 'obstacle') return 'obstacle';
  if (type === 'portalblue' || type === 'portalorange') return 'trigger';
  if (type === 'bumper' && !peg?.bumperDisappear && !peg?.bumperOrange) return 'permanent';
  return 'target';
}

function nativePegProperties(peg) {
  const properties = {};
  for (const [key, value] of Object.entries(peg || {})) {
    if (STRUCTURAL_PEG_KEYS.has(key) || key.startsWith('_')) continue;
    properties[key] = cloneResearchValue(value);
  }
  return properties;
}

function nativePegToObject(peg, index, pegRadius) {
  const kind = inferNativeObjectKind(peg);
  const width = Number.isFinite(peg?.width) ? peg.width : 34;
  const height = Number.isFinite(peg?.height) ? peg.height : pegRadius * 1.2;
  let geometry;
  if (kind === 'brick') {
    geometry = {
      shape: 'rotated-rectangle',
      width,
      height,
      curveSlices: cloneResearchValue(peg?.curveSlices || [])
    };
  } else if (kind === 'portal') {
    geometry = {
      shape: 'segment-trigger',
      halfLength: Number.isFinite(peg?.portalHalfLength) ? peg.portalHalfLength : 25,
      radius: Number.isFinite(peg?.radius) ? peg.radius : pegRadius
    };
  } else {
    geometry = {
      shape: 'circle',
      radius: Number.isFinite(peg?.radius) ? peg.radius : pegRadius
    };
  }

  const object = {
    id: String(peg?.id ?? `peg-${index}`),
    kind,
    role: inferNativeObjectRole(peg),
    targetType: peg?.type == null ? null : String(peg.type),
    transform: {
      x: Number.isFinite(peg?.x) ? peg.x : 0,
      y: Number.isFinite(peg?.y) ? peg.y : 0,
      rotation: Number.isFinite(peg?.angle) ? peg.angle : 0,
      scaleX: 1,
      scaleY: 1
    },
    geometry,
    groupIds: peg?.groupId == null ? [] : [String(peg.groupId)],
    properties: nativePegProperties(peg),
    source: {
      system: 'nanohit-peggle-level-json',
      index,
      raw: cloneResearchValue(peg)
    }
  };

  if (peg?.animation) object.animation = cloneResearchValue(peg.animation);
  if (kind === 'portal') {
    object.portal = {
      channel: String(peg.type).toLowerCase() === 'portalblue' ? 'blue' : 'orange',
      destinationId: peg.portalDestinationId ?? peg.destinationId ?? null,
      pairing: peg.portalDestinationId || peg.destinationId ? 'explicit' : 'opposite-channel-first',
      scale: Number.isFinite(peg.portalScale) ? peg.portalScale : null,
      oneWay: !!peg.portalOneWay,
      oneWayFlip: peg.portalOneWayFlip !== false
    };
  }

  const destruction = {};
  for (const [key, value] of Object.entries(peg || {})) {
    if (key.startsWith('destruction')) destruction[key] = cloneResearchValue(value);
  }
  if (Object.keys(destruction).length > 0) object.destruction = destruction;
  return object;
}

function nativeGroups(level) {
  const members = new Map();
  for (const peg of level?.pegs || []) {
    if (peg?.groupId == null) continue;
    const id = String(peg.groupId);
    if (!members.has(id)) members.set(id, []);
    members.get(id).push(String(peg.id));
  }
  return (Array.isArray(level?.groups) ? level.groups : []).map((group, index) => {
    const id = String(group?.id ?? `group-${index}`);
    const converted = {
      id,
      name: String(group?.name ?? id),
      objectIds: members.get(id) || [],
      source: {
        system: 'nanohit-peggle-level-json',
        index,
        raw: cloneResearchValue(group)
      }
    };
    if (group?.animation) converted.animation = cloneResearchValue(group.animation);
    const destruction = {};
    for (const [key, value] of Object.entries(group || {})) {
      if (key.startsWith('destruction')) destruction[key] = cloneResearchValue(value);
    }
    if (Object.keys(destruction).length > 0) converted.destruction = destruction;
    return converted;
  });
}

function nativeMechanics(level, viewport) {
  return {
    mode: level?.destruction?.enabled
      ? 'destruction'
      : (level?.billiard?.enabled ? 'billiard' : (level?.survival?.enabled ? 'survival' : (level?.pvp?.enabled ? 'pvp' : 'standard'))),
    pegRadius: Number.isFinite(level?.pegRadius) ? level.pegRadius : 8.5,
    aimLength: Number.isFinite(level?.aimLength) ? level.aimLength : 300,
    launcher: {
      x: viewport.width / 2,
      y: 40,
      coordinateSpace: 'world'
    },
    bucket: {
      enabled: !(level?.survival?.enabled || level?.billiard?.enabled),
      width: 70,
      height: 16
    },
    flippers: cloneResearchValue(level?.flippers ?? null),
    survival: cloneResearchValue(level?.survival ?? null),
    destruction: cloneResearchValue(level?.destruction ?? null),
    billiard: cloneResearchValue(level?.billiard ?? null),
    pvp: cloneResearchValue(level?.pvp ?? null),
    yoyo: cloneResearchValue(level?.yoyo ?? null),
    hitPegClear: {
      enabled: !!level?.hitPegTimedClearEnabled,
      delayMs: Number.isFinite(level?.hitPegClearDelayMs) ? level.hitPegClearDelayMs : null
    }
  };
}

export function nativeLevelToResearchRecord(level, options = {}) {
  if (!level || !Array.isArray(level.pegs)) {
    throw new TypeError('A native level with a pegs array is required.');
  }
  const viewport = {
    width: Number.isFinite(options.width) ? options.width : 400,
    height: Number.isFinite(options.height) ? options.height : 600
  };
  const worldHeight = level?.survival?.enabled && Number.isFinite(level?.survival?.worldHeight)
    ? level.survival.worldHeight
    : viewport.height;
  const pegRadius = Number.isFinite(level.pegRadius) ? level.pegRadius : 8.5;
  const sourcePath = String(options.sourcePath || 'browser-memory');
  const sourceRevision = String(options.sourceRevision || options.gameRevision || 'unknown');
  const at = String(options.at || new Date().toISOString());
  const record = {
    format: RESEARCH_FORMAT,
    formatVersion: RESEARCH_FORMAT_VERSION,
    recordType: 'level',
    id: String(options.id || `level:nanohit-peggle:${slug(level.id || level.name)}`),
    provenance: {
      source: {
        system: 'nanohit-peggle',
        path: sourcePath,
        revision: sourceRevision,
        version: level.version ?? null
      },
      ingestion: {
        tool: String(options.tool || 'native-level-import'),
        toolVersion: String(options.toolVersion || RESEARCH_TOOL_VERSION),
        toolRevision: String(options.toolRevision || sourceRevision),
        at
      }
    },
    authored: {
      name: String(level.name || level.id || 'Untitled Level'),
      coordinateSystem: {
        units: 'game-pixel',
        origin: 'top-left',
        xAxis: 'right',
        yAxis: 'down',
        orientation: worldHeight > viewport.width ? 'portrait' : (worldHeight < viewport.width ? 'landscape' : 'square'),
        bounds: { minX: 0, minY: 0, maxX: viewport.width, maxY: worldHeight },
        viewport
      },
      objects: level.pegs.map((peg, index) => nativePegToObject(peg, index, pegRadius)),
      groups: nativeGroups(level),
      mechanics: nativeMechanics(level, viewport),
      tags: Array.isArray(level.tags) ? level.tags.map(String) : [],
      metadata: cloneResearchValue(level.metadata || {})
    },
    visual: {
      presentation: cloneResearchValue(level.visuals || {})
    },
    extensions: {
      nativeLevel: cloneResearchValue(level)
    },
    warnings: [],
    losses: []
  };
  return record;
}

export function makeResearchRunRecord(options = {}) {
  if (!options.levelRef?.id || !options.levelRef?.sha256) {
    throw new TypeError('A levelRef with id and sha256 is required.');
  }
  return {
    format: RESEARCH_FORMAT,
    formatVersion: RESEARCH_FORMAT_VERSION,
    recordType: 'run',
    id: String(options.id || `run:${Date.now()}`),
    provenance: cloneResearchValue(options.provenance || {
      source: { system: 'nanohit-peggle-runtime' },
      ingestion: {
        tool: 'browser-research-recorder',
        toolVersion: RESEARCH_TOOL_VERSION,
        at: new Date().toISOString()
      }
    }),
    levelRef: cloneResearchValue(options.levelRef),
    reproduction: cloneResearchValue(options.reproduction || {}),
    events: cloneResearchValue(options.events || []),
    checkpoints: cloneResearchValue(options.checkpoints || []),
    measurements: cloneResearchValue(options.measurements || {}),
    artifacts: cloneResearchValue(options.artifacts || []),
    extensions: cloneResearchValue(options.extensions || {}),
    warnings: cloneResearchValue(options.warnings || []),
    losses: cloneResearchValue(options.losses || [])
  };
}
