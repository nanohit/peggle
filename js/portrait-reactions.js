import {
  CANONICAL_EMOTION_SLOTS,
  DEFAULT_CHARACTER_ID,
  getCharacterSlotSource,
  loadCharacterRegistry,
  resolveCharacterForLevel
} from './character-config.js';
import { isAssetImageSource } from './asset-ref.js';

const FAILURE_EVENTS = new Set([
  'spin_lose',
  'ball_lost_clean',
  'ball_lost_after_streak',
  'level_failed'
]);
const TRACE_MAX_ROWS = 5000;
const TRACE_TICK_SAMPLE_MS = 1000;

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function csvCell(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeDistribution(distribution, slots, displayedSlot = null, heldLong = false) {
  const result = {};
  const slotSet = new Set(slots || []);
  for (const [slot, weight] of Object.entries(distribution || {})) {
    if (!slotSet.has(slot)) continue;
    let n = Number(weight);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (heldLong && displayedSlot && slot === displayedSlot) n *= 0.5;
    result[slot] = (result[slot] || 0) + n;
  }
  if (Object.keys(result).length === 0) {
    result.idle = 1;
  }
  return result;
}

function rollDistribution(distribution) {
  const entries = Object.entries(distribution || {}).filter(([, weight]) => Number(weight) > 0);
  if (entries.length === 0) return 'idle';
  const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
  let r = Math.random() * total;
  for (const [slot, weight] of entries) {
    r -= Number(weight);
    if (r <= 0) return slot;
  }
  return entries[entries.length - 1][0];
}

function collectCharacterSlots(character) {
  const slots = new Set(CANONICAL_EMOTION_SLOTS);
  for (const slot of Object.keys(character?.slots || {})) slots.add(slot);
  for (const slot of Object.keys(character?.personality?.decayRates || {})) slots.add(slot);
  const personality = character?.personality || {};
  if (personality.baseline?.slot) slots.add(personality.baseline.slot);
  if (personality.boredom?.slot) slots.add(personality.boredom.slot);
  for (const row of Object.values(personality.impulseTable || {})) {
    for (const slot of Object.keys(row?.distribution || {})) slots.add(slot);
    if (row?.escalationSlot) slots.add(row.escalationSlot);
  }
  for (const slot of Object.keys(personality.ambient?.distribution || {})) slots.add(slot);
  for (const slot of Object.keys(personality.pressure?.distribution || {})) slots.add(slot);
  return [...slots];
}

class EmotionTraceLogger {
  constructor({ maxRows = TRACE_MAX_ROWS } = {}) {
    this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.rows = [];
    this.maxRows = maxRows;
    this.droppedRows = 0;
    this._warnedPersistFailure = false;
  }

  log(row) {
    this.rows.push(row);
    if (this.rows.length > this.maxRows) {
      const dropCount = this.rows.length - this.maxRows;
      this.rows.splice(0, dropCount);
      this.droppedRows += dropCount;
    }
  }

  toCsv() {
    const headers = [
      'session_id',
      't_ms',
      'level',
      'character_id',
      'priority',
      'event',
      'rolled_slot',
      'displayed_slot',
      'vector'
    ];
    const lines = [headers.join(',')];
    if (this.droppedRows > 0) {
      lines.push(headers.map(key => csvCell({
        session_id: this.sessionId,
        t_ms: '',
        level: '',
        character_id: '',
        priority: 'trace',
        event: `dropped_rows:${this.droppedRows}`,
        rolled_slot: '',
        displayed_slot: '',
        vector: '{}'
      }[key])).join(','));
    }
    for (const row of this.rows) {
      lines.push(headers.map(key => csvCell(row[key])).join(','));
    }
    return lines.join('\n');
  }

  persist() {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem('peggle_emotion_trace_last_csv', this.toCsv());
      }
    } catch (error) {
      if (!this._warnedPersistFailure) {
        console.warn('[portrait-trace] Failed to persist emotion trace:', error);
        this._warnedPersistFailure = true;
      }
    }
  }

  download(filename = null) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
    const blob = new Blob([this.toCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `emotion-trace-${this.sessionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }
}

export class PortraitReactionController {
  constructor({ visualLayout = null } = {}) {
    this.visualLayout = visualLayout;
    this.level = null;
    this.character = null;
    this.registry = null;
    this.game = null;
    this.gambleSystem = null;
    this.scopeKey = 'single';

    this.vector = {};
    this.slots = [...CANONICAL_EMOTION_SLOTS];
    this.displayedSlot = null;
    this.displayedSinceMs = 0;
    this.lastImpulseMs = 0;
    this.lastGameplayActivityMs = 0;
    this.refractoryUntilMs = 0;
    this.paused = false;
    this.dialogueOverride = null;
    this.bigEventPreempt = null;
    this.ambientSlot = null;
    this.nextAmbientRollMs = 0;
    this._lastTickMs = 0;
    this._pollTimer = null;
    this._unsubGameEvents = null;
    this._unsubUiState = null;
    this._unsubGambleEvents = null;
    this._eventRolls = new Map();
    this._firedStreakThresholds = new Set();
    this._aimStartedMs = null;
    this._aimHeldEmitted = false;
    this._cleanLossStreak = 0;
    this._latestUiState = null;
    this._pressureLevel = 0;
    this._pressureSlot = null;
    this._lastPressureImpulseMs = 0;
    this.trace = new EmotionTraceLogger();
    this._traceHasGameplay = false;
    this._lastGameplayTraceCsv = '';
    this._lastTickTraceMs = 0;

    this._installWindowTraceHandle();
  }

  setContext({ level = null, registry = loadCharacterRegistry(), game = null, gambleSystem = null, scopeKey = 'single', paused = false } = {}) {
    this._archiveCurrentTrace();
    this._detach();
    this.level = level || null;
    this.registry = registry || loadCharacterRegistry();
    this.character = resolveCharacterForLevel(level, this.registry);
    this.scopeKey = scopeKey || 'single';
    this.game = game || null;
    this.gambleSystem = gambleSystem || null;
    this.paused = !!paused;
    this.slots = collectCharacterSlots(this.character);
    this._resetVector();
    this.dialogueOverride = null;
    this.bigEventPreempt = null;
    this.ambientSlot = null;
    this._eventRolls.clear();
    this._firedStreakThresholds.clear();
    this._cleanLossStreak = 0;
    this._latestUiState = null;
    this._pressureLevel = 0;
    this._pressureSlot = null;
    this._lastPressureImpulseMs = 0;
    this._aimStartedMs = null;
    this._aimHeldEmitted = false;
    this.lastImpulseMs = nowMs();
    this.lastGameplayActivityMs = this.lastImpulseMs;
    this.displayedSlot = null;
    this.displayedSinceMs = 0;
    this.trace = new EmotionTraceLogger();
    this._traceHasGameplay = !!game;
    this._lastTickTraceMs = 0;
    this._installWindowTraceHandle();

    this._attachGame(this.game);
    this._attachGambleSystem(this.gambleSystem);
    this._startPolling();
    const baselineSlot = this.character?.personality?.baseline?.slot || 'idle';
    this._swapDisplayedSlot(this._resolveVisibleSlot(baselineSlot), { priority: 'ambient', fadeMs: 0, force: true, eventType: 'context' });
  }

  dispose() {
    this._archiveCurrentTrace();
    this._detach();
    this._stopPolling();
    this.visualLayout?.clearCharacterPortraitRuntime?.();
    this.trace?.persist?.();
  }

  setPaused(paused) {
    this.paused = !!paused;
    this.lastGameplayActivityMs = nowMs();
    if (!this.paused) {
      this.ambientSlot = null;
      this.nextAmbientRollMs = 0;
    }
  }

  setGambleSystem(gambleSystem) {
    if (this._unsubGambleEvents) {
      this._unsubGambleEvents();
      this._unsubGambleEvents = null;
    }
    this.gambleSystem = gambleSystem || null;
    this._attachGambleSystem(this.gambleSystem);
  }

  fireDialogueImpulse(slot, options = {}) {
    if (!slot) return;
    const payload = {
      ...options,
      forcedSlot: this._resolveVisibleSlot(slot)
    };
    if (!Number.isFinite(payload.magnitude)) delete payload.magnitude;
    this._applyImpulse('dialogue_impulse', payload);
  }

  setDialogueOverride(slot, options = {}) {
    if (!slot) return null;
    const visibleSlot = this._resolveVisibleSlot(slot);
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.dialogueOverride = {
      token,
      slot: visibleSlot,
      untilMs: Number.isFinite(options.durationMs) && options.durationMs > 0
        ? nowMs() + options.durationMs
        : 0
    };
    this._render({ force: true, eventType: 'dialogue_override' });
    return token;
  }

  clearDialogueOverride(token = null) {
    if (!this.dialogueOverride) return;
    if (token && this.dialogueOverride.token !== token) return;
    this.dialogueOverride = null;
    this._render({ force: true, eventType: 'dialogue_clear' });
  }

  fireEvent(eventType, payload = {}) {
    this._applyImpulse(eventType, payload);
  }

  exportTraceCsv() {
    if (!this._traceHasGameplay && this._lastGameplayTraceCsv) return this._lastGameplayTraceCsv;
    return this.trace?.toCsv?.() || this._lastGameplayTraceCsv || '';
  }

  downloadTraceCsv() {
    const csv = this.exportTraceCsv();
    if (!csv || typeof document === 'undefined' || typeof URL === 'undefined') return false;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `emotion-trace-${Date.now().toString(36)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }

  _archiveCurrentTrace() {
    if (!this.trace) return;
    const csv = this.trace.toCsv();
    if (this._traceHasGameplay && this.trace.rows.length > 0) {
      this._lastGameplayTraceCsv = csv;
    }
    this.trace.persist();
  }

  _installWindowTraceHandle() {
    if (typeof window === 'undefined') return;
    window.peggleEmotionTrace = {
      exportCsv: () => this.exportTraceCsv(),
      downloadCsv: () => this.downloadTraceCsv(),
      controller: this
    };
  }

  _startPolling() {
    this._stopPolling();
    this._lastTickMs = nowMs();
    this._pollTimer = setInterval(() => this._tick(), 100);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _detach() {
    if (this._unsubGameEvents) {
      this._unsubGameEvents();
      this._unsubGameEvents = null;
    }
    if (this._unsubUiState) {
      this._unsubUiState();
      this._unsubUiState = null;
    }
    if (this._unsubGambleEvents) {
      this._unsubGambleEvents();
      this._unsubGambleEvents = null;
    }
  }

  _hasAuthoredSlot(slot) {
    if (!slot) return false;
    const value = this.character?.slots?.[slot];
    if (Array.isArray(value)) {
      return value.some(isAssetImageSource);
    }
    return isAssetImageSource(value);
  }

  _visibleSlots() {
    const visible = this.slots.filter(slot => this._hasAuthoredSlot(slot));
    if (visible.length > 0) return visible;
    const fallback = this.character?.personality?.baseline?.slot || 'idle';
    return [fallback];
  }

  _resolveVisibleSlot(slot) {
    if (this._hasAuthoredSlot(slot)) return slot;
    const baselineSlot = this.character?.personality?.baseline?.slot || 'idle';
    if (this._hasAuthoredSlot(baselineSlot)) return baselineSlot;
    if (this._hasAuthoredSlot('idle')) return 'idle';
    return this._visibleSlots()[0] || 'idle';
  }

  _attachGame(game) {
    if (!game) return;
    if (typeof game.subscribeGameplayEvents === 'function') {
      this._unsubGameEvents = game.subscribeGameplayEvents((type, payload) => {
        this._handleGameplayEvent(type, payload || {});
      });
    }
    if (typeof game.subscribeUiState === 'function') {
      this._unsubUiState = game.subscribeUiState((snapshot) => this._handleUiState(snapshot));
    }
  }

  _attachGambleSystem(gambleSystem) {
    if (typeof gambleSystem?.subscribeEvents !== 'function') return;
    this._unsubGambleEvents = gambleSystem.subscribeEvents((type, payload = {}) => {
      if (type === 'spin-start') {
        this.fireEvent('spin_triggered', payload);
        return;
      }
      if (type !== 'spin-resolved') return;
      const rewardIds = Array.isArray(payload.rewardIds) ? payload.rewardIds : [];
      if (payload.jackpot) {
        this.fireEvent('jackpot', payload);
      } else if (rewardIds.length >= 2 || (Array.isArray(payload.wins) && payload.wins.length >= 2)) {
        this.fireEvent('spin_win_big', payload);
      } else if (rewardIds.length > 0) {
        this.fireEvent('spin_win_small', payload);
      } else {
        this.fireEvent('spin_lose', payload);
      }
    });
  }

  _handleGameplayEvent(type, payload = {}) {
    this.lastGameplayActivityMs = nowMs();
    if (type === 'shot_launched') {
      this._firedStreakThresholds.clear();
      this.fireEvent(type, payload);
      return;
    }
    if (type === 'peg_hit') {
      this.fireEvent('peg_hit', payload);
      const streak = Number(payload.turnHitCount || 0);
      const thresholds = Array.isArray(this.character?.personality?.streakThresholds)
        ? this.character.personality.streakThresholds
        : [3, 6, 10];
      for (const threshold of thresholds) {
        if (streak < threshold || this._firedStreakThresholds.has(threshold)) continue;
        this._firedStreakThresholds.add(threshold);
        this.fireEvent(`peg_streak_${threshold}`, {
          ...payload,
          streakCount: streak,
          streakThreshold: threshold
        });
      }
      return;
    }
    if (type === 'ball_lost_clean') {
      this._cleanLossStreak++;
      this.fireEvent(type, payload);
      if (this._cleanLossStreak >= 3) {
        this._cleanLossStreak = 0;
        this.fireEvent('safe_play_pattern', payload);
      }
      return;
    }
    if (!FAILURE_EVENTS.has(type)) this._cleanLossStreak = 0;
    if (FAILURE_EVENTS.has(type) || type === 'level_clear') {
      this._firedStreakThresholds.clear();
    }
    this.fireEvent(type, payload);
  }

  _handleUiState(snapshot) {
    this._latestUiState = snapshot || null;
    const state = snapshot?.state;
    const now = nowMs();
    if (state === 'aiming' || state === 'confirmAim') {
      if (this._aimStartedMs == null) {
        this._aimStartedMs = now;
        this._aimHeldEmitted = false;
      } else if (!this._aimHeldEmitted && now - this._aimStartedMs >= 6000) {
        this._aimHeldEmitted = true;
        this.fireEvent('aim_held_too_long', { state });
      }
    } else {
      this._aimStartedMs = null;
      this._aimHeldEmitted = false;
    }

    if (state === 'playing') {
      this.lastGameplayActivityMs = now;
    }

    const previousPressure = this._pressureLevel || 0;
    const pressureLevel = this._calculatePressureLevel(snapshot);
    this._pressureLevel = pressureLevel;
    if (pressureLevel <= 0) {
      this._pressureSlot = null;
      return;
    }
    if (!this._pressureSlot || pressureLevel - previousPressure > 0.25) {
      this._pressureSlot = this._rollPressureSlot();
    }
    const pressure = this.character?.personality?.pressure || {};
    const cooldownMs = Number.isFinite(pressure.impulseCooldownMs) ? pressure.impulseCooldownMs : 8000;
    if (
      pressureLevel >= 0.35
      && (previousPressure < 0.2 || now - this._lastPressureImpulseMs >= cooldownMs)
    ) {
      this._lastPressureImpulseMs = now;
      this.fireEvent('pressure_low_balls', {
        pressureLevel,
        ballsLeft: snapshot?.ballsLeft,
        orangePegsLeft: snapshot?.orangePegsLeft,
        totalOrangePegs: snapshot?.totalOrangePegs
      });
    }
  }

  _calculatePressureLevel(snapshot) {
    const pressure = this.character?.personality?.pressure || {};
    if (pressure.enabled === false) return 0;
    const state = snapshot?.state;
    if (state === 'won' || state === 'lost' || state === 'level_clear' || state === 'level_failed') return 0;
    const ballsLeft = Number(snapshot?.ballsLeft);
    const targetsLeft = Number(snapshot?.orangePegsLeft);
    if (!Number.isFinite(ballsLeft) || !Number.isFinite(targetsLeft)) return 0;
    if (ballsLeft <= 0 || targetsLeft <= 0) return 0;
    const maxBalls = Number.isFinite(pressure.maxBalls) ? pressure.maxBalls : 4;
    if (ballsLeft > maxBalls) return 0;
    const ratio = targetsLeft / Math.max(1, ballsLeft);
    const ratioStart = Number.isFinite(pressure.pegRatioStart) ? pressure.pegRatioStart : 2.4;
    const ratioCritical = Math.max(ratioStart + 0.1, Number.isFinite(pressure.pegRatioCritical) ? pressure.pegRatioCritical : 4.8);
    if (ratio < ratioStart) return 0;
    const ratioPressure = clamp((ratio - ratioStart) / (ratioCritical - ratioStart), 0, 1);
    const scarcityPressure = clamp((maxBalls + 1 - ballsLeft) / maxBalls, 0, 1);
    return clamp(ratioPressure * 0.65 + scarcityPressure * 0.35, 0, 1);
  }

  _resetVector() {
    this.vector = {};
    for (const slot of this.slots) this.vector[slot] = 0;
    const baseline = this.character?.personality?.baseline || {};
    const baselineSlot = baseline.slot || 'idle';
    if (!Object.prototype.hasOwnProperty.call(this.vector, baselineSlot)) {
      this.vector[baselineSlot] = 0;
      this.slots.push(baselineSlot);
    }
    this.vector[baselineSlot] = Number.isFinite(baseline.target) ? baseline.target : 0.45;
  }

  _tick() {
    const now = nowMs();
    const dt = Math.max(0, Math.min(0.35, (now - this._lastTickMs) / 1000));
    this._lastTickMs = now;

    if (this.dialogueOverride?.untilMs && now >= this.dialogueOverride.untilMs) {
      this.dialogueOverride = null;
    }

    if (!this._isAmbientActive(now)) {
      this._applyDecay(dt, now);
    } else {
      this._tickAmbientSampler(now);
    }
    this._render({ eventType: '' });
    this._logTrace({ priority: this._currentPriority(now), event: '', sample: true });
  }

  _applyDecay(dt, now) {
    const personality = this.character?.personality || {};
    const baseline = personality.baseline || { slot: 'idle', rate: 0.18, target: 0.45 };
    const cap = personality.saturationCap || 1.5;
    for (const slot of this.slots) {
      const current = Number(this.vector[slot] || 0);
      const isBaseline = slot === baseline.slot;
      const target = isBaseline ? (Number.isFinite(baseline.target) ? baseline.target : 0.45) : 0;
      const slotDecay = personality.decayRates?.[slot] ?? 0.32;
      const rate = isBaseline ? (baseline.rate || 0) : slotDecay;
      this.vector[slot] = current + (target - current) * Math.min(1, rate * dt);
    }

    const boredom = personality.boredom || {};
    if (now - this.lastImpulseMs >= (boredom.afterMs || 5000)) {
      const slot = boredom.slot || baseline.slot || 'idle';
      this._ensureSlot(slot);
      this.vector[slot] = Math.min(cap, (this.vector[slot] || 0) + (boredom.magnitudePerSecond || 0.05) * dt);
    }

    this._applyPressureDrift(dt, cap);

    this._capVector();
  }

  _rollPressureSlot() {
    const pressure = this.character?.personality?.pressure || {};
    const visible = new Set(this._visibleSlots());
    const distribution = {};
    for (const [slot, weight] of Object.entries(pressure.distribution || {})) {
      const resolved = this._resolveVisibleSlot(slot);
      if (!visible.has(resolved)) continue;
      if (resolved === (this.character?.personality?.baseline?.slot || 'idle')) continue;
      const n = Number(weight);
      if (!Number.isFinite(n) || n <= 0) continue;
      distribution[resolved] = (distribution[resolved] || 0) + n;
    }
    if (Object.keys(distribution).length === 0) return null;
    return rollDistribution(distribution);
  }

  _applyPressureDrift(dt, cap) {
    const pressureLevel = this._pressureLevel || 0;
    if (pressureLevel <= 0) return;
    const pressure = this.character?.personality?.pressure || {};
    if (pressure.enabled === false) return;
    const slot = this._pressureSlot || this._rollPressureSlot();
    if (!slot) return;
    this._pressureSlot = slot;
    this._ensureSlot(slot);
    const target = (Number.isFinite(pressure.target) ? pressure.target : 0.62) * pressureLevel;
    const rate = Number.isFinite(pressure.driftRate) ? pressure.driftRate : 0.2;
    const current = Number(this.vector[slot] || 0);
    if (current < target) {
      this.vector[slot] = Math.min(cap, current + (target - current) * Math.min(1, rate * dt));
    }
  }

  _applyImpulse(eventType, payload = {}) {
    const row = this._getImpulseRow(eventType);
    if (!row && !payload.forcedSlot) return;

    const now = nowMs();
    let magnitude = Number.isFinite(payload.magnitude) ? payload.magnitude : (row?.magnitude || 0);
    const originalMagnitude = magnitude;
    const personality = this.character?.personality || {};
    const refractoryScale = Number.isFinite(personality.refractoryScale) ? personality.refractoryScale : 0.5;
    const preemptThreshold = Number.isFinite(personality.preemptThreshold) ? personality.preemptThreshold : 0.8;
    if (now < this.refractoryUntilMs) magnitude *= refractoryScale;

    const slot = payload.forcedSlot
      ? this._resolveVisibleSlot(payload.forcedSlot)
      : this._rollImpulseSlot(eventType, row);
    this._ensureSlot(slot);
    const cap = this.character?.personality?.saturationCap || 1.5;
    this.vector[slot] = Math.min(cap, (this.vector[slot] || 0) + magnitude);
    this.lastImpulseMs = now;
    this.lastGameplayActivityMs = now;

    if (originalMagnitude >= preemptThreshold) {
      const refractoryMs = personality.refractoryMs || 0;
      this.refractoryUntilMs = now + refractoryMs;
      this.bigEventPreempt = {
        slot,
        untilMs: now + Math.max(450, refractoryMs),
        fadeMs: personality.fastCrossfadeMs ?? 150
      };
    }

    if (FAILURE_EVENTS.has(eventType)) {
      this._eventRolls.clear();
    }

    this._capVector();
    this._render({
      force: originalMagnitude >= preemptThreshold,
      eventType,
      rolledSlot: slot,
      magnitude: originalMagnitude
    });
    this._logTrace({ priority: this._currentPriority(now), event: eventType, rolled_slot: slot });
  }

  _getImpulseRow(eventType) {
    const table = this.character?.personality?.impulseTable || {};
    if (table[eventType]) return table[eventType];
    if (/^peg_streak_\d+$/.test(eventType) && table.peg_streak_N) return table.peg_streak_N;
    return null;
  }

  _rollImpulseSlot(eventType, row) {
    const now = nowMs();
    const heldLong = !!(this.displayedSlot && now - this.displayedSinceMs > 4000);
    let distribution = normalizeDistribution(row?.distribution, this._visibleSlots(), this.displayedSlot, heldLong);
    const rollKey = this._rollMemoryKey(eventType);
    const rolls = this._eventRolls.get(rollKey) || [];
    if (rolls.length >= 3 && rolls[0] === rolls[1] && rolls[1] === rolls[2]) {
      const repeatedSlot = rolls[0];
      const escalationSlot = this._resolveVisibleSlot(row?.escalationSlot
        || this.character?.personality?.escalation?.[repeatedSlot]
        || repeatedSlot);
      this._ensureSlot(escalationSlot);
      distribution[repeatedSlot] = (distribution[repeatedSlot] || 0) * 0.45;
      distribution[escalationSlot] = (distribution[escalationSlot] || 0) + 0.55;
      this._eventRolls.set(rollKey, []);
    }
    const slot = rollDistribution(distribution);
    const nextRolls = [...(this._eventRolls.get(rollKey) || []), slot].slice(-3);
    this._eventRolls.set(rollKey, nextRolls);
    return slot;
  }

  _rollMemoryKey(eventType) {
    if (/^peg_streak_\d+$/.test(eventType)) return 'peg_streak_N';
    return eventType || '';
  }

  _ensureSlot(slot) {
    if (!slot) return;
    if (!Object.prototype.hasOwnProperty.call(this.vector, slot)) {
      this.vector[slot] = 0;
      if (!this.slots.includes(slot)) this.slots.push(slot);
    }
  }

  _capVector() {
    const cap = this.character?.personality?.saturationCap || 1.5;
    for (const slot of Object.keys(this.vector)) {
      this.vector[slot] = clamp(this.vector[slot], 0, cap);
    }
  }

  _isAmbientActive(now = nowMs()) {
    const idleAfterMs = this.character?.personality?.ambient?.idleAfterMs || 8000;
    return this.paused || (now - this.lastGameplayActivityMs >= idleAfterMs);
  }

  _tickAmbientSampler(now) {
    if (this.ambientSlot && now < this.nextAmbientRollMs) return;
    const ambient = this.character?.personality?.ambient || {};
    const heldLong = !!(this.displayedSlot && now - this.displayedSinceMs > 4000);
    const distribution = normalizeDistribution(ambient.distribution, this._visibleSlots(), this.displayedSlot, heldLong);
    this.ambientSlot = rollDistribution(distribution);
    const minMs = ambient.samplerMinMs || 4000;
    const maxMs = Math.max(minMs, ambient.samplerMaxMs || 7000);
    this.nextAmbientRollMs = now + minMs + Math.random() * (maxMs - minMs);
  }

  _currentPriority(now = nowMs()) {
    if (this.dialogueOverride) return 'dialogue_override';
    if (this.bigEventPreempt && now < this.bigEventPreempt.untilMs) return 'big_event_preempt';
    if (this._isAmbientActive(now)) return 'ambient';
    return 'blend_dominant';
  }

  _render(options = {}) {
    if (!this.character) return;
    const now = nowMs();
    let targetSlot = this.displayedSlot || this.character?.personality?.baseline?.slot || 'idle';
    let priority = this._currentPriority(now);
    let fadeMs = this.character?.personality?.crossfadeMs ?? 320;
    let force = !!options.force;

    if (priority === 'dialogue_override') {
      targetSlot = this.dialogueOverride.slot;
      force = true;
    } else if (priority === 'big_event_preempt') {
      targetSlot = this.bigEventPreempt.slot;
      fadeMs = this.bigEventPreempt.fadeMs;
      force = true;
    } else if (priority === 'ambient') {
      this._tickAmbientSampler(now);
      targetSlot = this.ambientSlot || targetSlot;
    } else {
      targetSlot = this._dominantSlot();
      const baselineSlot = this._resolveVisibleSlot(this.character?.personality?.baseline?.slot || 'idle');
      const returnDelayMs = this.character?.personality?.returnToBaselineDelayMs ?? 2400;
      if (
        targetSlot === baselineSlot
        && this.displayedSlot
        && this.displayedSlot !== baselineSlot
        && now - this.lastImpulseMs < returnDelayMs
        && !force
      ) {
        targetSlot = this.displayedSlot;
      }
      const currentValue = this.vector[this.displayedSlot] || 0;
      const targetValue = this.vector[targetSlot] || 0;
      const leadMargin = this.character?.personality?.leadMargin ?? 0.15;
      if (targetSlot !== this.displayedSlot && targetValue < currentValue * (1 + leadMargin) && !force) {
        targetSlot = this.displayedSlot;
      }
    }

    targetSlot = this._resolveVisibleSlot(targetSlot);
    if (!targetSlot || targetSlot === this.displayedSlot) return;
    const dwellMs = this.character?.personality?.dwellMs ?? 600;
    if (!force && this.displayedSinceMs && now - this.displayedSinceMs < dwellMs) return;
    this._swapDisplayedSlot(targetSlot, {
      priority,
      fadeMs,
      force,
      eventType: options.eventType || '',
      rolledSlot: options.rolledSlot || ''
    });
  }

  _dominantSlot() {
    let bestSlot = this._resolveVisibleSlot(this.character?.personality?.baseline?.slot || 'idle');
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const slot of this._visibleSlots()) {
      const value = Number(this.vector[slot] || 0);
      if (value > bestValue) {
        bestValue = value;
        bestSlot = slot;
      }
    }
    return bestSlot;
  }

  _swapDisplayedSlot(slot, { priority = 'blend_dominant', fadeMs = 320, eventType = '', rolledSlot = '' } = {}) {
    slot = this._resolveVisibleSlot(slot);
    this._ensureSlot(slot);
    this.displayedSlot = slot;
    this.displayedSinceMs = nowMs();
    const src = getCharacterSlotSource(this.character, slot);
    this.visualLayout?.setCharacterPortraitSource?.(src, {
      fadeMs,
      slotName: slot
    });
    this._logTrace({ priority, event: eventType, rolled_slot: rolledSlot });
  }

  _normalizedVector() {
    const sum = Object.values(this.vector).reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
    const result = {};
    for (const slot of this.slots) {
      const raw = Math.max(0, Number(this.vector[slot] || 0));
      result[slot] = sum > 0 ? Number((raw / sum).toFixed(4)) : 0;
    }
    return result;
  }

  _logTrace({ priority = '', event = '', rolled_slot = '', sample = false } = {}) {
    if (!this.trace) return;
    const now = nowMs();
    if (sample) {
      if (now - this._lastTickTraceMs < TRACE_TICK_SAMPLE_MS) return;
      this._lastTickTraceMs = now;
    }
    this.trace.log({
      session_id: this.trace.sessionId,
      t_ms: Math.round(now),
      level: this.level?.name || this.scopeKey || 'level',
      character_id: this.character?.id || DEFAULT_CHARACTER_ID,
      priority,
      event,
      rolled_slot,
      displayed_slot: this.displayedSlot || '',
      vector: JSON.stringify(this._normalizedVector())
    });
  }
}
