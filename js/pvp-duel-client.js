import { api } from './api.js';

const CLIENT_STORAGE_KEY = 'alea_pvp_duel_client_id';
const DUEL_PROD_ORIGIN = 'https://al3a.vercel.app';

export function getPvpDuelRoomCodeFromLocation(locationObj = window.location) {
  const params = new URLSearchParams(locationObj.search || '');
  const queryRoom = params.get('room');
  if (/^\d{4}$/.test(queryRoom || '')) return queryRoom;
  const match = String(locationObj.pathname || '').match(/^\/(\d{4})\/?$/);
  return match ? match[1] : null;
}

export function getOrCreatePvpDuelClientId() {
  const storage = (() => {
    try {
      sessionStorage.setItem('__pvp_duel_probe__', '1');
      sessionStorage.removeItem('__pvp_duel_probe__');
      return sessionStorage;
    } catch {
      return null;
    }
  })();
  try {
    const existing = storage?.getItem(CLIENT_STORAGE_KEY);
    if (existing) return existing;
    const random = crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = random.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    storage?.setItem(CLIENT_STORAGE_KEY, id);
    return id;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, '');
  }
}

export function createPvpDuelRoomUrl(roomCode = null) {
  const code = roomCode || String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  if (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(location.hostname)) {
    return `${location.origin}${location.pathname.replace(/[^/]*$/, 'player.html')}?room=${code}`;
  }
  return `${DUEL_PROD_ORIGIN}/${code}`;
}

export class PvpDuelRoomController {
  constructor({ roomCode, clientId, runtime, onState, onError }) {
    this.roomCode = roomCode;
    this.clientId = clientId;
    this.runtime = runtime;
    this.onState = typeof onState === 'function' ? onState : null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.room = null;
    this.pollTimer = null;
    this.polling = false;
    this.stopped = false;
    this.pollMs = 700;
    this.fastPollMs = 220;
    this.launchGraceMs = 1800;
    this._submittedRounds = new Set();
    this._publishedRounds = new Set();
    this._launchedRounds = new Set();
    this._launchTimer = null;
    this._launchTimerRound = null;
    this.pegStateVersion = 0;
  }

  async join() {
    const room = await api.joinPvpDuelRoom(this.roomCode, this.clientId);
    if (!room) throw new Error('Could not join PvP Duel room');
    this.handleRoomState(room);
    return room;
  }

  start() {
    if (this.pollTimer) return;
    this.stopped = false;
    this.schedulePoll(0);
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this._launchTimer) window.clearTimeout(this._launchTimer);
    this._launchTimer = null;
    this._launchTimerRound = null;
  }

  getPollDelay() {
    const room = this.room;
    if (!room) return this.pollMs;
    if (room.status === 'aiming' && this._submittedRounds.has(String(room.round))) {
      return this.fastPollMs;
    }
    if (room.status === 'playing' && Number(room.launchDelayMs) > 0) {
      return this.fastPollMs;
    }
    return this.pollMs;
  }

  schedulePoll(delay = null) {
    if (this.stopped) return;
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    const ms = Number.isFinite(delay) ? Math.max(0, delay) : this.getPollDelay();
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, ms);
  }

  async poll() {
    if (this.polling || this.stopped) {
      this.schedulePoll();
      return;
    }
    this.polling = true;
    try {
      const room = await api.getPvpDuelRoom(this.roomCode, this.clientId, this.pegStateVersion);
      if (room) this.handleRoomState(room);
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.polling = false;
      if (!this.stopped) this.schedulePoll();
    }
  }

  async submitAim({ round, angle, shot }) {
    const key = String(round);
    if (this._submittedRounds.has(key)) return;
    this._submittedRounds.add(key);
    const room = await api.submitPvpDuelAim(this.roomCode, this.clientId, round, angle, shot, this.pegStateVersion);
    if (room) this.handleRoomState(room);
    if (!room && !this.stopped) this.schedulePoll(this.fastPollMs);
  }

  async publishRoundResult(result) {
    if (!this.room?.isHost) return;
    const round = Number(result?.round);
    if (!Number.isFinite(round)) return;
    const key = String(round);
    if (this._publishedRounds.has(key)) return;
    this._publishedRounds.add(key);
    const room = await api.publishPvpDuelRoundResult(this.roomCode, this.clientId, round, result, this.pegStateVersion);
    if (room) this.handleRoomState(room);
  }

  handleRoomState(room) {
    this.room = room;
    this.onState?.(room);
    if (!this.runtime || !room) return;

    if (room.side === 'cpu' || room.side === 'human') {
      this.runtime.setLocalSide?.(room.side);
    }

    if (room.hp || room.remainingPegIds) {
      this.runtime.applyCanonicalDuelState?.({
        hp: room.hp,
        remainingPegIds: room.remainingPegIds,
        removedPegIds: room.removedPegIds,
        removedPegIdsDelta: room.removedPegIdsDelta
      });
    }
    if (Number.isFinite(room.pegStateVersion)) {
      this.pegStateVersion = Math.max(0, Math.floor(room.pegStateVersion));
    }

    if (room.status === 'waiting') {
      this.clearPendingLaunch();
      this.runtime.holdForNetworkRoom?.();
      return;
    }

    if (room.status === 'aiming') {
      this.clearPendingLaunch();
      this.runtime.startNetworkAimRound?.(room.round, room.deadlineAt, room.aimRemainingMs);
      return;
    }

    if (room.status === 'playing' && room.launch) {
      const launchRound = Number(room.launch.round);
      if (!Number.isFinite(launchRound)) return;
      if (this.runtime.round !== launchRound) {
        this.runtime.startNetworkAimRound?.(launchRound, room.deadlineAt, room.aimRemainingMs);
      }
      this.scheduleResolvedLaunch(room);
      return;
    }

    if (room.status === 'finished') {
      this.clearPendingLaunch();
      const result = this.runtime.getLocalMatchResult?.();
      if (result) this.runtime.finishMatch?.(result);
    }
  }

  clearPendingLaunch() {
    if (this._launchTimer) window.clearTimeout(this._launchTimer);
    this._launchTimer = null;
    this._launchTimerRound = null;
  }

  scheduleResolvedLaunch(room) {
    const launchRound = Number(room?.launch?.round);
    if (!Number.isFinite(launchRound)) return;
    const key = String(launchRound);
    if (this._launchedRounds.has(key)) return;

    const delayMs = Math.max(0, Number(room.launchDelayMs) || 0);
    const lateMs = Math.max(0, Number(room.launchLateMs) || 0);
    if (delayMs <= 0 && lateMs > this.launchGraceMs) {
      this.clearPendingLaunch();
      this.runtime.holdForNetworkRoom?.();
      this.onState?.(room, { waitingForRoundResult: true });
      return;
    }

    if (delayMs > 0) {
      if (this._launchTimer && this._launchTimerRound === key) return;
      this.clearPendingLaunch();
      this._launchTimerRound = key;
      this._launchTimer = window.setTimeout(() => {
        this._launchTimer = null;
        this._launchTimerRound = null;
        if (this.stopped) return;
        if (this.room?.status !== 'playing' || Number(this.room?.launch?.round) !== launchRound) return;
        this.launchNow(this.room);
      }, delayMs);
      return;
    }

    this.launchNow(room);
  }

  launchNow(room) {
    const launchRound = Number(room?.launch?.round);
    if (!Number.isFinite(launchRound)) return;
    const key = String(launchRound);
    if (this._launchedRounds.has(key)) return;
    this._launchedRounds.add(key);
    this.runtime.launchResolvedRound?.({
      human: room.launch.human,
      cpu: room.launch.cpu
    });
  }
}
