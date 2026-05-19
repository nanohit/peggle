import Redis from 'ioredis';
import fs from 'fs/promises';
import {
  createMirrorEnvelope,
  mirrorMetaFromEnvelope,
  mirrorMetaKey,
  readDriveRecord,
  selectMirroredValue,
  writeDriveRecord
} from './drive-store.js';

const ROOM_TTL_SECONDS = 60 * 60 * 3;
const LEVEL_LIST_KEY = 'pvp:duel:levels';
const LEVEL_INDEX_KEY = 'level:__index';
const PVP_DUEL_COLLECTION = 'pvp-duel';
const LEVEL_COLLECTION = 'levels';
const MATCH_HP = 3;
const LAUNCH_SYNC_DELAY_MS = 900;
const ROUND_STALE_MS = 26000;
const DISCOVERY_CACHE_TTL_MS = 60000;

let redis;
let pvpDiscoveryCache = { expiresAt: 0, names: null };
function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

async function kvGet(key) {
  const client = getRedis();
  if (!client) return null;
  let raw;
  try {
    raw = await client.get(key);
  } catch (error) {
    console.warn('[api/pvp-duel] Redis get failed:', error?.message || error);
    return null;
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function kvSet(key, value, ttlSeconds = null) {
  const client = getRedis();
  if (!client) throw new Error('REDIS_URL is not configured');
  const payload = JSON.stringify(value);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await client.set(key, payload, 'EX', Math.round(ttlSeconds));
  } else {
    await client.set(key, payload);
  }
}

async function getMirroredValue(collection, name, key) {
  const [redisValue, redisMeta, driveRecord] = await Promise.all([
    kvGet(key).catch(error => {
      console.warn('[api/pvp-duel] Redis read failed:', key, error?.message || error);
      return null;
    }),
    kvGet(mirrorMetaKey(key)).catch(error => {
      console.warn('[api/pvp-duel] Redis mirror meta read failed:', key, error?.message || error);
      return null;
    }),
    readDriveRecord(collection, name)
  ]);
  const selected = selectMirroredValue({ redisValue, redisMeta, driveRecord });
  return selected.found ? selected.value : null;
}

async function writeMirroredValue(collection, name, key, value) {
  const envelope = createMirrorEnvelope({ key, collection, name, value });
  let redisOk = false;
  let driveOk = false;

  try {
    await kvSet(key, value);
    await kvSet(mirrorMetaKey(key), mirrorMetaFromEnvelope(envelope));
    redisOk = true;
  } catch (error) {
    console.warn('[api/pvp-duel] Redis mirror write failed:', key, error?.message || error);
  }

  driveOk = await writeDriveRecord(collection, name, envelope);
  return { ok: redisOk || driveOk, redisOk, driveOk, envelope };
}

function roomKey(roomCode) {
  return `pvp:room:${roomCode}`;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeName(name) {
  return (name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function staticNamePath(name) {
  return encodeURIComponent(name);
}

async function readStaticJson(path) {
  try {
    const raw = await fs.readFile(new URL(path, import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getStaticLevel(name) {
  const data = await readStaticJson(`../data/player/levels/${staticNamePath(name)}.json`);
  if (data) return data;
  try {
    const entries = await fs.readdir(new URL('../data/player/levels/', import.meta.url), { withFileTypes: true });
    const match = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => decodeURIComponent(entry.name.replace(/\.json$/, '')))
      .find(levelName => safeName(levelName) === name);
    if (match) return await readStaticJson(`../data/player/levels/${staticNamePath(match)}.json`);
  } catch { /* static level directory unavailable */ }
  return null;
}

async function getStaticLevelNames() {
  try {
    const entries = await fs.readdir(new URL('../data/player/levels/', import.meta.url), { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => decodeURIComponent(entry.name.replace(/\.json$/, '')));
  } catch {
    return [];
  }
}

async function getLevelData(name) {
  const data = await getMirroredValue(LEVEL_COLLECTION, name, `level:${name}`);
  if (data) return data;
  return await getStaticLevel(name);
}

function isPvpLevel(level) {
  return !!(level && typeof level === 'object' && level.pvp && level.pvp.enabled === true);
}

function sanitizeLevelForPlayer(level) {
  const next = cloneJson(level);
  const snapshot = next?.character?.snapshot;
  if (snapshot && typeof snapshot === 'object') {
    delete snapshot.slots;
    delete snapshot.emotions;
  }
  return next;
}

async function discoverPvpLevelNames() {
  const configured = await getMirroredValue(PVP_DUEL_COLLECTION, 'levels', LEVEL_LIST_KEY);
  if (Array.isArray(configured)) {
    return configured.filter(name => typeof name === 'string' && name);
  }

  const now = Date.now();
  if (Array.isArray(pvpDiscoveryCache.names) && pvpDiscoveryCache.expiresAt > now) {
    return pvpDiscoveryCache.names;
  }

  const remoteNames = (await getMirroredValue(LEVEL_COLLECTION, '__index', LEVEL_INDEX_KEY)) || [];
  const names = [...new Set([...remoteNames, ...(await getStaticLevelNames())])].sort();
  const pvpNames = [];
  for (const name of names) {
    const level = await getLevelData(name);
    if (isPvpLevel(level)) pvpNames.push(name);
  }
  pvpDiscoveryCache = {
    names: pvpNames,
    expiresAt: now + DISCOVERY_CACHE_TTL_MS
  };
  return pvpNames;
}

async function pickPvpLevelName() {
  const names = await discoverPvpLevelNames();
  if (names.length === 0) return null;
  return names[Math.floor(Math.random() * names.length)];
}

function normalizeRoomCode(value) {
  const text = String(value || '').trim();
  return /^\d{4}$/.test(text) ? text : null;
}

function normalizeClientId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '');
}

function getClientSide(room, clientId) {
  const index = room.players.findIndex(player => player.id === clientId);
  if (index === 0) return 'human';
  if (index === 1) return 'cpu';
  return null;
}

function clampAngle(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const twoPi = Math.PI * 2;
  let next = numeric;
  while (next > Math.PI) next -= twoPi;
  while (next < -Math.PI) next += twoPi;
  return next;
}

function normalizeShotSubmission(side, payload = {}) {
  return {
    side,
    shot: payload.shot !== false,
    angle: clampAngle(payload.angle, side === 'cpu' ? -Math.PI / 2 : Math.PI / 2),
    submittedAt: Date.now()
  };
}

function advanceRoomAfterRound(room, now = Date.now()) {
  room.hp = room.hp || { human: MATCH_HP, cpu: MATCH_HP };
  if (room.hp.human <= 0 || room.hp.cpu <= 0) {
    room.status = 'finished';
    room.winner = room.hp.human <= 0 ? 'cpu' : 'human';
    room.deadlineAt = null;
    room.submissions = {};
    room.launch = null;
    room.launchAt = null;
    room.roundTimeoutAt = null;
    return;
  }

  room.status = 'aiming';
  room.round += 1;
  room.deadlineAt = now + Math.max(1000, Math.round(room.aimTimerMs || 5000));
  room.submissions = {};
  room.launch = null;
  room.launchAt = null;
  room.roundTimeoutAt = null;
}

function ensureRoomRound(room, now = Date.now()) {
  if (room.status === 'playing') {
    const timeoutAt = Number(room.roundTimeoutAt);
    if (Number.isFinite(timeoutAt) && timeoutAt <= now) {
      room.staleRoundCount = Math.max(0, Math.round(Number(room.staleRoundCount) || 0)) + 1;
      advanceRoomAfterRound(room, now);
    }
    return;
  }
  if (room.status !== 'aiming') return;
  if (!room.deadlineAt || room.deadlineAt <= now) {
    const human = room.submissions?.human;
    const cpu = room.submissions?.cpu;
    room.submissions = {
      human: human || normalizeShotSubmission('human', { shot: false, angle: Math.PI / 2 }),
      cpu: cpu || normalizeShotSubmission('cpu', { shot: false, angle: -Math.PI / 2 })
    };
  }
  if (room.submissions?.human && room.submissions?.cpu) {
    room.status = 'playing';
    room.launch = {
      round: room.round,
      resolvedAt: now,
      launchAt: now + LAUNCH_SYNC_DELAY_MS,
      human: room.submissions.human,
      cpu: room.submissions.cpu
    };
    room.launchAt = room.launch.launchAt;
    room.roundTimeoutAt = room.launchAt + ROUND_STALE_MS;
  }
}

async function mutateRoom(roomCode, mutator, retries = 6) {
  const client = getRedis();
  if (!client) throw new Error('REDIS_URL is not configured');
  const key = roomKey(roomCode);
  const lockKey = `${key}:lock`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const locked = await client.set(lockKey, token, 'PX', 2400, 'NX');
    if (locked !== 'OK') {
      await new Promise(resolve => setTimeout(resolve, 25 + attempt * 35));
      continue;
    }

    try {
      let room = null;
      const raw = await client.get(key);
      if (raw) room = JSON.parse(raw);

      const next = await mutator(room ? cloneJson(room) : null);
      if (!next) return null;

      next.updatedAt = Date.now();
      await client.set(key, JSON.stringify(next), 'EX', ROOM_TTL_SECONDS);
      return next;
    } finally {
      try {
        await client.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          token
        );
      } catch {
        // The lock has a short TTL; failure to release is recoverable.
      }
    }
  }

  const error = new Error('Room update conflict, retry request');
  error.statusCode = 409;
  throw error;
}

function normalizePegStateVersion(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function serializeRoomForClient(room, clientId, options = {}) {
  const serverNow = Date.now();
  const launchAt = room.launchAt || room.launch?.launchAt || null;
  const side = getClientSide(room, clientId);
  const pegStateVersion = Math.max(0, Math.round(Number(room.pegStateVersion) || 0));
  const requestedPegVersion = normalizePegStateVersion(options.pegStateVersion);
  const allRemovedPegIds = Array.isArray(room.removedPegIds) ? room.removedPegIds : [];
  let removedPegIds = allRemovedPegIds;
  let removedPegIdsDelta = null;

  if (requestedPegVersion !== null) {
    if (requestedPegVersion === pegStateVersion) {
      removedPegIds = null;
      removedPegIdsDelta = [];
    } else if (requestedPegVersion >= 0 && requestedPegVersion < pegStateVersion) {
      const deltas = Array.isArray(room.pegDeltas)
        ? room.pegDeltas.filter(delta => Number(delta?.version) > requestedPegVersion)
        : [];
      const contiguous = deltas.length > 0
        && Number(deltas[0].version) === requestedPegVersion + 1
        && Number(deltas[deltas.length - 1].version) === pegStateVersion;
      if (contiguous) {
        removedPegIds = null;
        removedPegIdsDelta = deltas.flatMap(delta => Array.isArray(delta.removedPegIds) ? delta.removedPegIds : []);
      }
    }
  }

  const sanitized = {
    room: room.room,
    status: room.status,
    levelName: room.levelName,
    round: room.round,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    deadlineAt: room.deadlineAt || null,
    serverNow,
    aimRemainingMs: room.status === 'aiming' && Number.isFinite(room.deadlineAt)
      ? Math.max(0, room.deadlineAt - serverNow)
      : null,
    launchAt,
    launchDelayMs: room.status === 'playing' && Number.isFinite(launchAt)
      ? Math.max(0, launchAt - serverNow)
      : null,
    launchLateMs: room.status === 'playing' && Number.isFinite(launchAt)
      ? Math.max(0, serverNow - launchAt)
      : null,
    side,
    isHost: side === 'human',
    players: room.players.map((player, index) => ({
      side: index === 0 ? 'human' : 'cpu',
      present: true,
      self: player.id === clientId,
      lastSeenAt: player.lastSeenAt || player.joinedAt || null
    })),
    hp: room.hp || { human: MATCH_HP, cpu: MATCH_HP },
    removedPegIds,
    removedPegIdsDelta,
    pegStateVersion,
    winner: room.winner || null,
    submissions: {
      human: !!room.submissions?.human,
      cpu: !!room.submissions?.cpu
    },
    launch: null
  };
  if (room.status === 'playing' && room.launch) {
    sanitized.launch = room.launch;
  }
  return sanitized;
}

async function joinRoom(roomCode, clientId) {
  return await mutateRoom(roomCode, async (room) => {
    const now = Date.now();
    if (!room) {
      const levelName = await pickPvpLevelName();
      if (!levelName) {
        const error = new Error('No PvP Duel levels configured');
        error.statusCode = 409;
        throw error;
      }
      const level = await getLevelData(levelName);
      if (!isPvpLevel(level)) {
        const error = new Error('Selected PvP Duel level is missing or not marked as PvP');
        error.statusCode = 409;
        throw error;
      }
      const aimTimerMs = Math.max(1000, Math.min(30000, Math.round(Number(level?.pvp?.aimTimerMs) || 5000)));
      return {
        room: roomCode,
        status: 'waiting',
        levelName,
        createdAt: now,
        updatedAt: now,
        players: [{ id: clientId, joinedAt: now, lastSeenAt: now }],
        round: 1,
        aimTimerMs,
        deadlineAt: null,
        submissions: {},
        launch: null,
        hp: { human: MATCH_HP, cpu: MATCH_HP },
        removedPegIds: [],
        pegStateVersion: 0,
        pegDeltas: [],
        staleRoundCount: 0,
        winner: null
      };
    }

    const existing = room.players.find(player => player.id === clientId);
    if (existing) {
      existing.lastSeenAt = now;
    } else if (room.players.length < 2) {
      room.players.push({ id: clientId, joinedAt: now, lastSeenAt: now });
      if (room.players.length === 2 && room.status === 'waiting') {
        room.status = 'aiming';
        room.deadlineAt = now + Math.max(1000, Math.round(room.aimTimerMs || 5000));
        room.submissions = {};
        room.launch = null;
      }
    } else {
      const error = new Error('Room is full');
      error.statusCode = 409;
      throw error;
    }
    ensureRoomRound(room, now);
    return room;
  });
}

async function touchRoom(roomCode, clientId) {
  return await mutateRoom(roomCode, (room) => {
    if (!room) return null;
    const now = Date.now();
    const existing = room.players.find(player => player.id === clientId);
    if (existing) existing.lastSeenAt = now;
    ensureRoomRound(room, now);
    return room;
  });
}

async function heartbeatRoom(roomCode, clientId) {
  return await touchRoom(roomCode, clientId);
}

async function submitAim(roomCode, clientId, body) {
  return await mutateRoom(roomCode, (room) => {
    if (!room) return null;
    const now = Date.now();
    const side = getClientSide(room, clientId);
    if (!side) {
      const error = new Error('Client is not in this room');
      error.statusCode = 403;
      throw error;
    }
    if (room.status !== 'aiming' || Number(body.round) !== room.round) {
      ensureRoomRound(room, now);
      return room;
    }
    room.submissions = room.submissions || {};
    if (!room.submissions[side]) {
      room.submissions[side] = normalizeShotSubmission(side, body);
    }
    ensureRoomRound(room, now);
    return room;
  });
}

async function publishRoundResult(roomCode, clientId, body) {
  return await mutateRoom(roomCode, (room) => {
    if (!room) return null;
    const now = Date.now();
    const side = getClientSide(room, clientId);
    if (side !== 'human') {
      const error = new Error('Only the host can publish authoritative Duel results');
      error.statusCode = 403;
      throw error;
    }
    if (room.status !== 'playing' || Number(body.round) !== room.round) {
      return room;
    }

    const hp = body.hp && typeof body.hp === 'object' ? body.hp : {};
    const prevHp = room.hp || { human: MATCH_HP, cpu: MATCH_HP };
    const humanHp = Number(hp.human);
    const cpuHp = Number(hp.cpu);
    room.hp = {
      human: Math.max(0, Math.min(MATCH_HP, Math.round(Number.isFinite(humanHp) ? humanHp : prevHp.human))),
      cpu: Math.max(0, Math.min(MATCH_HP, Math.round(Number.isFinite(cpuHp) ? cpuHp : prevHp.cpu)))
    };
    const removedSet = new Set(Array.isArray(room.removedPegIds)
      ? room.removedPegIds.filter(id => typeof id === 'string')
      : []);
    const removedPayload = Array.isArray(body.removedPegIds) ? body.removedPegIds : [];
    const newRemovedIds = [];
    for (const id of removedPayload) {
      if (typeof id !== 'string' || removedSet.has(id)) continue;
      removedSet.add(id);
      newRemovedIds.push(id);
    }
    room.removedPegIds = [...removedSet];
    if (newRemovedIds.length > 0) {
      room.pegStateVersion = Math.max(0, Math.round(Number(room.pegStateVersion) || 0)) + 1;
      room.pegDeltas = Array.isArray(room.pegDeltas) ? room.pegDeltas : [];
      room.pegDeltas.push({
        version: room.pegStateVersion,
        removedPegIds: newRemovedIds
      });
      if (room.pegDeltas.length > 80) {
        room.pegDeltas = room.pegDeltas.slice(-80);
      }
    }

    advanceRoomAfterRound(room, now);
    return room;
  });
}

export default async function handler(req, res) {
  try {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.query.levels === 'true') {
        return res.json({ names: await discoverPvpLevelNames() });
      }
      const roomCode = normalizeRoomCode(req.query.room);
      const clientId = normalizeClientId(req.query.client);
      if (!roomCode || !clientId) return res.status(400).json({ error: 'room and client required' });
      const room = await kvGet(roomKey(roomCode));
      if (!room) return res.status(404).json({ error: 'Room not found' });
      return res.json(serializeRoomForClient(room, clientId, {
        pegStateVersion: req.query.pegStateVersion
      }));
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '');

      if (action === 'setLevelList') {
        const names = Array.isArray(body.names)
          ? [...new Set(body.names.filter(name => typeof name === 'string' && name))]
          : [];
        const listWrite = await writeMirroredValue(PVP_DUEL_COLLECTION, 'levels', LEVEL_LIST_KEY, names);
        if (!listWrite.ok) throw new Error('Failed to persist PvP Duel level list to Redis or Drive');
        pvpDiscoveryCache = { expiresAt: 0, names: null };
        return res.json({ ok: true, names, storage: { redis: listWrite.redisOk, drive: listWrite.driveOk } });
      }

      const roomCode = normalizeRoomCode(body.room);
      const clientId = normalizeClientId(body.client);
      if (!roomCode || !clientId) return res.status(400).json({ error: 'room and client required' });

      let room;
      if (action === 'join') room = await joinRoom(roomCode, clientId);
      else if (action === 'heartbeat') room = await heartbeatRoom(roomCode, clientId);
      else if (action === 'submitAim') room = await submitAim(roomCode, clientId, body);
      else if (action === 'roundResult') room = await publishRoundResult(roomCode, clientId, body);
      else return res.status(400).json({ error: 'unknown action' });

      if (!room) return res.status(404).json({ error: 'Room not found' });
      return res.json(serializeRoomForClient(room, clientId, {
        pegStateVersion: body.pegStateVersion
      }));
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = error?.statusCode || 500;
    if (status >= 500) console.error('[api/pvp-duel]', error);
    res.status(status).json({ error: error?.message || 'Internal error' });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' }
  }
};
