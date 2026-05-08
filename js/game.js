// Peggle Game - Game loop and mechanics

import { Ball, PhysicsEngine, PHYSICS_CONFIG, getBallRadius } from './physics.js';
import { Renderer } from './renderer.js';
import { Utils } from './utils.js';
import { PegAnimator } from './animation.js';
import { SurvivalRuntime } from './survival-runtime.js';
import { FLIPPER_DEFAULTS, createDefaultFlipperConfig, normalizeFlipperConfig } from './flipper-defaults.js';
import { YoyoThreadSystem, normalizeYoyoSettings } from './yoyo-thread.js';
import { buildBombShockwave } from './perk-bomb.js';
import { DeepFreezeSystem } from './perk-deep-freeze.js';
import {
  MULTIBALL_DEFAULT_SPAWN_COUNT,
  normalizeMultiballSpawnCount
} from './multiball-settings.js';
import {
  countSurvivalTargets,
  ensureLevelSurvival,
  getPegVerticalExtent,
  isPegRemovableInSurvival,
  normalizeSurvivalGamblePegProperties
} from './survival-mode.js';
import {
  normalizeHitPegClearDelayMs,
  normalizeLevelHitPegClearSettings
} from './hit-peg-clear-settings.js';
import { isPortalType, normalizePortalPegProperties } from './portal-defaults.js';
import { lightTap, initAudio, pegHitSound, resetHitCounter } from './haptics.js';
import { normalizeEndSequenceConfig } from './visual-config.js';

// Score values
const SCORE = {
  orange: 100,
  blue: 10,
  green: 50,
  purple: 500,
  multi: 50,
  gamble: 50,
  multiplier: {
    25: 1,
    20: 2,
    15: 3,
    10: 5,
    5: 10,
    0: 100
  }
};

const ULTRA_AIM_V2_ROTATION_SECONDS = 2.8;
const ULTRA_AIM_V2_MAX_ROTATIONS = 4;
const ULTRA_AIM_V2_START_ANGLE = -Math.PI / 2;
const PERFORMANCE_CAP30_WINDOW_MS = 2800;
const PERFORMANCE_CAP30_MIN_WINDOW_MS = 1800;
const PERFORMANCE_CAP30_MIN_SAMPLE_COUNT = 45;
const PERFORMANCE_CAP30_FRAME_MIN_MS = 31;
const PERFORMANCE_CAP30_FRAME_MAX_MS = 36.8;
const PERFORMANCE_CAP30_STABILITY_SPAN_MS = 4.5;
const PERFORMANCE_CAP30_MAX_WORK_MS = 18;
const PERFORMANCE_CAP30_MAX_WORK_RATIO = 0.68;
const SURVIVAL_GAMBLE_BALLS_PER_PEG = 2;
const LAST_PEG_SLOWMO_DROP_MS = 110;
const LAST_PEG_SLOWMO_HOLD_MS = 90;
const LAST_PEG_SLOWMO_RECOVER_MS = 760;
const LAST_PEG_SLOWMO_MIN_SCALE = 0.18;
const LAST_PEG_SLOWMO_TOTAL_MS = LAST_PEG_SLOWMO_DROP_MS + LAST_PEG_SLOWMO_HOLD_MS + LAST_PEG_SLOWMO_RECOVER_MS;

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function percentileFromSorted(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const clamped = Math.max(0, Math.min(1, percentile));
  const index = (values.length - 1) * clamped;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  const t = index - lower;
  return values[lower] + (values[upper] - values[lower]) * t;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function easeInCubic(t) {
  const k = clamp01(t);
  return k * k * k;
}

function easeOutCubic(t) {
  const k = 1 - clamp01(t);
  return 1 - k * k * k;
}

function getSimHzOverride() {
  if (typeof window === 'undefined') return null;
  let raw = null;
  try {
    const url = new URL(window.location.href);
    raw = url.searchParams.get('simHz');
  } catch (error) {
    raw = null;
  }
  if (raw == null && typeof window.SIM_HZ !== 'undefined') {
    raw = window.SIM_HZ;
  }
  const hz = parseFloat(raw);
  return Number.isFinite(hz) && hz > 0 ? hz : null;
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.physics = new PhysicsEngine(canvas.width, canvas.height);
    
    // Game state
    this.state = 'idle'; // idle, aiming, confirmAim, playing, won, lost
    this.confirmShoot = false; // When true, release locks aim; second tap fires
    this.pegs = [];
    this.groups = [];
    this.balls = [];
    this.score = 0;
    this.ballsLeft = 10;
    this.hitPegIds = [];
    this.turnHitPegIds = [];
    this.shotsFired = 0;
    this._turnBucketCatchCount = 0;
    this.totalSurvivalTargets = 0;
    this.initialBallCount = 10;
    this.gambleBalls = 0;
    this.initialGambleBallCount = 0;
    this.survivalAntiCooldownMs = 0;
    this.survivalShotCooldownRemainingMs = 0;
    this.survivalGambleOverlayOpen = false;
    this.survivalEscapedPegIds = new Set();
    this.hitPegTimedClearEnabled = false;
    this.hitPegClearDelayMs = normalizeHitPegClearDelayMs(undefined);
    this.pendingHitPegClears = new Map();
    this.levelElapsedMs = 0;
    this.initialOrangePegs = 0;
    this.removedOrangePegs = 0;
    this.bucketCatchLight = 0;
    this.levelFxId = 0;
    this.backgroundEvents = [];
    this.renderTimeSeconds = 0;
    this.renderDeltaSeconds = 0;
    this.rawFrameDeltaSeconds = 0;
    this._currentTimeScale = 1;
    this._lastPegSlowmoElapsedMs = -1;
    this._pendingEndResult = null;
    this._gameEndEmitted = false;
    this._levelClearEmitted = false;
    this._stopped = false;
    this._frozenSurvivalTrackerState = null;
    this.endSequenceConfig = normalizeEndSequenceConfig(null);

    // Flippers
    this.flippers = null;
    this.baseFlipperConfig = null;
    this.temporaryFlipperTurns = 0;
    this.temporaryFlipperActive = false;

    // Stuck ball detection
    this.ballPositionHistory = [];
    this.ballPositionHistories = new Map();
    this.ballContactPegIds = new Map();

    // Peg animation
    this.animator = new PegAnimator();

    // Launch state
    this.launchX = canvas.width / 2;
    this.launchY = 40;
    this.aimAngle = Math.PI / 2;

    // Survival mode runtime (camera + scrolling)
    this.survivalRuntime = new SurvivalRuntime(canvas.height, { autoScroll: true });
    this.yoyoThread = new YoyoThreadSystem(canvas.width, canvas.height);
    this.dynamicYoyoAnchors = new Map();
    this.baseYoyoSettings = normalizeYoyoSettings(null);
    this.yoyoPerkUsesRemaining = 0;
    this.deepFreezeSystem = new DeepFreezeSystem();
    this.queuedDeepFreezeShots = 0;
    this.deepFreezeShotActive = false;
    this.debugDrag = {
      enabled: false,
      dragging: false
    };
    this.inputSuppressedUntil = 0;
    
    // Performance overlay (editor only)
    this.showPerfOverlay = false;
    this._portalFxDecayPerSecond = 2.8;

    // Trajectory preview
    this.trajectory = null;
    this.showFullTrajectory = false;
    this.aimLength = 300;
    this.ultraAimCharges = 0; // Legacy Ultra Aim 1.0 reference only.
    this.ultraAimV2Charges = 0;
    this.ultraAimShotActive = false;
    this.ultraAimQte = this.createUltraAimQteState();
    this.queuedBombPerkCharges = 0;
    this.armedBombPerk = false;
    
    // Animation
    this.animationId = null;
    this.lastTime = 0;
    this.accumulatorMs = 0;
    this.fixedStepMs = 1000 / 120;
    this.maxFrameSteps = 8;
    this.maxFrameDeltaMs = 250;
    this._rafSamples = [];
    this._rafSampleSize = 20;
    this._bestRafMs = this.fixedStepMs;
    this._simOverrideHz = getSimHzOverride();
    if (this._simOverrideHz) {
      this.fixedStepMs = 1000 / this._simOverrideHz;
      this._bestRafMs = this.fixedStepMs;
    }
    this.maxFrameSteps = this._deriveMaxFrameSteps(this.fixedStepMs);
    
    // Callbacks
    this.onGameEnd = null;
    this.onScoreChange = null;
    this.onPegHit = null;
    this.uiStateListeners = new Set();
    this.performanceEventListeners = new Set();
    this.gameplayEventListeners = new Set();
    this.lastUiStateSignature = '';
    this._performanceCap30Samples = [];
    this._performanceCap30Emitted = false;
    
    // Listener cleanup
    this.abortController = new AbortController();

    // Input handling
    this.setupInput();
  }

  setupInput() {
    const canvas = this.canvas;
    const sig = { signal: this.abortController.signal };

    // --- Touch input (standard + confirm-shoot with tap vs drag detection) ---
    let touchDragged = false;

    canvas.addEventListener('touchstart', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.isEndSequenceActive()) return;
      initAudio();
      if (this.handleUltraAimQteInput(e)) return;
      if (this._handleDebugDragStart(e)) return;
      touchDragged = false;
      if (this.state === 'confirmAim') {
        // Second touch starts — will check on touchend if it was a tap or drag
        e.preventDefault();
        return;
      }
      if (this.state !== 'idle') return;
      e.preventDefault();
      this.state = 'aiming';
      this.updateAim(e);
    }, { passive: false, ...sig });

    canvas.addEventListener('touchmove', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this._handleDebugDragMove(e)) return;
      touchDragged = true;
      if (this.state === 'confirmAim') {
        // Dragging in confirmAim → re-aim
        e.preventDefault();
        this.state = 'aiming';
        this.updateAim(e);
        return;
      }
      if (this.state !== 'aiming') return;
      e.preventDefault();
      this.updateAim(e);
    }, { passive: false, ...sig });

    canvas.addEventListener('touchend', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this._handleDebugDragEnd(e)) return;
      if (this.state === 'confirmAim' && !touchDragged) {
        // Second touch was a tap → fire
        e.preventDefault();
        this.launch();
        return;
      }
      if (this.state !== 'aiming') return;
      e.preventDefault();
      if (this.confirmShoot) {
        this.state = 'confirmAim';
      } else {
        this.launch();
      }
    }, { passive: false, ...sig });

    // --- Mouse input (confirm-shoot: aim follows cursor freely, click = fire) ---
    canvas.addEventListener('mousedown', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.isEndSequenceActive()) return;
      initAudio();
      if (this.handleUltraAimQteInput(e)) return;
      if (this._handleDebugDragStart(e)) return;
      if (this.confirmShoot) {
        // In confirm mode, click fires (from any aiming state)
        if (this.isAimingState()) {
          e.preventDefault();
          this.launch();
          return;
        }
        // Start free-aim on first click if idle
        if (this.state === 'idle') {
          e.preventDefault();
          this.state = 'aiming';
          this.updateAim(e);
        }
        return;
      }
      // Normal mode: mousedown starts aiming
      if (this.state !== 'idle') return;
      e.preventDefault();
      this.state = 'aiming';
      this.updateAim(e);
    }, sig);

    canvas.addEventListener('mousemove', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.debugDrag.dragging) { this._handleDebugDragMove(e); return; }
      if (this.confirmShoot) {
        // In confirm mode, aim always follows mouse when idle or aiming
        if (this.state === 'idle') {
          this.state = 'aiming';
        }
        if (this.state === 'aiming' || this.state === 'confirmAim') {
          this.state = 'aiming';
          this.updateAim(e);
        }
        return;
      }
      // Normal mode
      if (this.state === 'aiming') this.updateAim(e);
    }, sig);

    canvas.addEventListener('mouseup', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this._handleDebugDragEnd(e)) return;
      if (this.confirmShoot) return; // Handled in mousedown
      if (this.state !== 'aiming') return;
      e.preventDefault();
      this.launch();
    }, sig);

    // Flipper activation — spacebar anytime, click/tap during playing
    const handleFlip = () => {
      if (this.debugDrag.enabled) return;
      if (!this.flippers) return;
      if (this.isEndSequenceActive()) return;
      this.flippers._flipperActivated = true;
    };
    const handleFlipEnd = () => {
      if (this.debugDrag.enabled) return;
      if (!this.flippers) return;
      this.flippers._flipperActivated = false;
    };

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      if (this.isUltraAimQteActive()) {
        e.preventDefault();
        if (!e.repeat) this.fireUltraAimQte();
        return;
      }
      e.preventDefault();
      handleFlip();
    }, sig);
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      if (this.isUltraAimQteActive()) return;
      handleFlipEnd();
    }, sig);

    canvas.addEventListener('mousedown', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.debugDrag.enabled) return;
      if (this.isUltraAimQteActive()) return;
      if (this.state === 'playing') handleFlip();
    }, sig);
    canvas.addEventListener('mouseup', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.debugDrag.enabled) return;
      if (this.state === 'playing') handleFlipEnd();
    }, sig);
    canvas.addEventListener('touchstart', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.debugDrag.enabled) return;
      if (this.isUltraAimQteActive()) return;
      if (this.state === 'playing') { e.preventDefault(); handleFlip(); }
    }, { passive: false, ...sig });
    canvas.addEventListener('touchend', (e) => {
      if (this._isInputSuppressed(e)) return;
      if (this.debugDrag.enabled) return;
      if (this.state === 'playing') handleFlipEnd();
    }, sig);
  }

  suppressInputFor(ms = 450) {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    this.inputSuppressedUntil = Math.max(this.inputSuppressedUntil || 0, now + Math.max(0, ms));
  }

  _isInputSuppressed(event = null) {
    const until = this.inputSuppressedUntil || 0;
    if (until <= 0) return false;
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    if (now >= until) return false;
    if (event?.cancelable) event.preventDefault();
    if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    return true;
  }

  getUiStateSnapshot() {
    const survivalMode = this.isSurvivalMode();
    // Orange pegs left across the whole level: initial minus removed minus currently-hit-this-turn
    const currentTurnOrangeHits = survivalMode ? 0
      : this.turnHitPegIds.filter(id => this.pegs.find(p => p.id === id && this.isOrangePeg(p))).length;
    const orangeLeft = survivalMode
      ? this.getSurvivalTargetsLeft(true)
      : Math.max(0, this.initialOrangePegs - this.removedOrangePegs - currentTurnOrangeHits);
    const waitingForSurvivalSpinBalls = survivalMode && this.gambleBalls <= 0;
    const displayBallsLeft = survivalMode
      ? (waitingForSurvivalSpinBalls ? Number.POSITIVE_INFINITY : this.gambleBalls)
      : this.ballsLeft;
    const displayInitialBalls = survivalMode
      ? (waitingForSurvivalSpinBalls ? 0 : Math.max(this.initialGambleBallCount, this.gambleBalls, 0))
      : this.initialBallCount;
    const state = this._pendingEndResult?.result || this.state;
    return {
      state,
      ballsLeft: displayBallsLeft,
      initialBallCount: displayInitialBalls,
      gambleBalls: this.gambleBalls,
      showFullTrajectory: !!this.showFullTrajectory,
      orangePegsLeft: orangeLeft,
      totalOrangePegs: survivalMode ? this.totalSurvivalTargets : this.initialOrangePegs,
    };
  }

  getUiStateSignature() {
    const snapshot = this.getUiStateSnapshot();
    return `${snapshot.state}|${snapshot.ballsLeft}|${snapshot.initialBallCount}|${snapshot.showFullTrajectory ? 1 : 0}|${snapshot.orangePegsLeft}`;
  }

  subscribeUiState(listener) {
    if (typeof listener !== 'function') return () => {};
    this.uiStateListeners.add(listener);
    listener(this.getUiStateSnapshot(), 'subscribe');
    return () => {
      this.uiStateListeners.delete(listener);
    };
  }

  subscribePerformanceEvents(listener) {
    if (typeof listener !== 'function') return () => {};
    this.performanceEventListeners.add(listener);
    return () => {
      this.performanceEventListeners.delete(listener);
    };
  }

  subscribeGameplayEvents(listener) {
    if (typeof listener !== 'function') return () => {};
    this.gameplayEventListeners.add(listener);
    return () => {
      this.gameplayEventListeners.delete(listener);
    };
  }

  emitUiStateIfChanged(force = false, reason = 'tick') {
    const signature = this.getUiStateSignature();
    if (!force && signature === this.lastUiStateSignature) return;
    this.lastUiStateSignature = signature;
    if (this.uiStateListeners.size === 0) return;

    const snapshot = this.getUiStateSnapshot();
    for (const listener of this.uiStateListeners) {
      try {
        listener(snapshot, reason);
      } catch (error) {
        // Listener errors must not break the game loop.
      }
    }
  }

  emitPerformanceEvent(type, payload = {}) {
    if (!type || this.performanceEventListeners.size === 0) return;
    for (const listener of this.performanceEventListeners) {
      try {
        listener(type, payload);
      } catch (error) {
        // Listener errors must not break the game loop.
      }
    }
  }

  emitGameplayEvent(type, payload = {}) {
    if (!type || this.gameplayEventListeners.size === 0) return;
    for (const listener of this.gameplayEventListeners) {
      try {
        listener(type, payload);
      } catch (error) {
        // Listener errors must not break the game loop.
      }
    }
  }

  isEndSequenceActive() {
    return !!this._pendingEndResult || this.state === 'won' || this.state === 'lost';
  }

  _getFinalPegSlowmoStrength() {
    const value = this.endSequenceConfig?.finalPegSlowmoStrength;
    return clamp01(Number.isFinite(value) ? value : 1);
  }

  _startLastPegSlowmo() {
    if (this._getFinalPegSlowmoStrength() <= 0.001) {
      this._lastPegSlowmoElapsedMs = -1;
      return false;
    }
    if (this._lastPegSlowmoElapsedMs >= 0) return false;
    this._lastPegSlowmoElapsedMs = 0;
    return true;
  }

  _isLastPegSlowmoActive() {
    return this._lastPegSlowmoElapsedMs >= 0 && this._lastPegSlowmoElapsedMs < LAST_PEG_SLOWMO_TOTAL_MS;
  }

  _resolveTimeScale(frameDeltaMs) {
    if (this._lastPegSlowmoElapsedMs < 0) {
      this._currentTimeScale = 1;
      return 1;
    }

    const strength = this._getFinalPegSlowmoStrength();
    if (strength <= 0.001) {
      this._lastPegSlowmoElapsedMs = -1;
      this._currentTimeScale = 1;
      return 1;
    }

    this._lastPegSlowmoElapsedMs += Math.max(0, frameDeltaMs);
    const elapsed = this._lastPegSlowmoElapsedMs;
    if (elapsed >= LAST_PEG_SLOWMO_TOTAL_MS) {
      this._lastPegSlowmoElapsedMs = -1;
      this._currentTimeScale = 1;
      return 1;
    }

    const minScale = 1 - (1 - LAST_PEG_SLOWMO_MIN_SCALE) * strength;
    let scale = 1;
    if (elapsed < LAST_PEG_SLOWMO_DROP_MS) {
      const t = elapsed / LAST_PEG_SLOWMO_DROP_MS;
      scale = 1 - easeOutCubic(t) * (1 - minScale);
    } else if (elapsed < LAST_PEG_SLOWMO_DROP_MS + LAST_PEG_SLOWMO_HOLD_MS) {
      scale = minScale;
    } else {
      const recoverElapsed = elapsed - LAST_PEG_SLOWMO_DROP_MS - LAST_PEG_SLOWMO_HOLD_MS;
      const t = recoverElapsed / LAST_PEG_SLOWMO_RECOVER_MS;
      scale = minScale + easeInCubic(t) * (1 - minScale);
    }

    this._currentTimeScale = scale;
    return scale;
  }

  _queuePendingEndResult(result, options = null) {
    if (!result) return null;
    if (this.state === result) return { result, readyToResolve: true };

    const readyToResolve = options?.readyToResolve !== false;
    if (!this._pendingEndResult || this._pendingEndResult.result !== result) {
      this._pendingEndResult = { result, readyToResolve };
    } else if (readyToResolve) {
      this._pendingEndResult.readyToResolve = true;
    }

    if (result === 'won') {
      this.finishDeepFreezeShot();
      this.resetUltraAimRuntime();
    }
    return this._pendingEndResult;
  }

  _finalizeEndState(result) {
    if (!result) return false;
    this._pendingEndResult = null;
    this.state = result;
    this.finishDeepFreezeShot();
    this.resetUltraAimRuntime();
    const isWin = result === 'won';
    if (!isWin || !this._levelClearEmitted) {
      this.emitGameplayEvent(isWin ? 'level_clear' : 'level_failed', {
        result,
        score: this.score,
        shotsFired: this.shotsFired
      });
      if (isWin) this._levelClearEmitted = true;
    }
    if (!this._gameEndEmitted && this.onGameEnd) {
      this._gameEndEmitted = true;
      this.onGameEnd(result, this.score);
    }
    return true;
  }

  _maybeFinalizePendingEndResult() {
    if (!this._pendingEndResult?.readyToResolve) return false;
    if (this._isLastPegSlowmoActive()) return false;
    return this._finalizeEndState(this._pendingEndResult.result);
  }

  isAimingState() {
    return this.state === 'aiming' || this.state === 'confirmAim';
  }

  createUltraAimQteState() {
    return {
      active: false,
      pegId: null,
      ballId: null,
      anchorX: 0,
      anchorY: 0,
      angle: ULTRA_AIM_V2_START_ANGLE,
      elapsed: 0,
      trajectory: null,
      skipMultiballOnRelease: false
    };
  }

  clearDynamicYoyoAnchors() {
    this.dynamicYoyoAnchors.clear();
  }

  removeDynamicYoyoAnchor(ballId) {
    if (!ballId) return;
    this.dynamicYoyoAnchors.delete(ballId);
  }

  bindDynamicYoyoAnchor(ballId, pegId, anchorX, anchorY) {
    if (!ballId || !pegId) return;
    this.dynamicYoyoAnchors.set(ballId, {
      pegId,
      anchorX: Number.isFinite(anchorX) ? anchorX : 0,
      anchorY: Number.isFinite(anchorY) ? anchorY : 0
    });
  }

  syncDynamicYoyoAnchors() {
    if (this.dynamicYoyoAnchors.size === 0) return;

    for (const [ballId, binding] of this.dynamicYoyoAnchors) {
      const ball = this.balls.find(item => item && item.id === ballId);
      if (!ball || !ball.active || ball.yoyoEligible === false) {
        this.dynamicYoyoAnchors.delete(ballId);
        continue;
      }

      const peg = this.pegs.find(item => item && item.id === binding.pegId);
      if (!peg) {
        this.dynamicYoyoAnchors.delete(ballId);
        continue;
      }

      const anchor = this.resolveUltraAimAnchorPosition(peg, binding.anchorX, binding.anchorY);
      binding.anchorX = anchor.x;
      binding.anchorY = anchor.y;
      this.yoyoThread.setBallAnchor(ballId, anchor.x, anchor.y, {
        moveOriginalAnchor: true,
        anchorPegId: binding.pegId
      });
    }
  }

  getUltraAimWorldHeight() {
    return this.isSurvivalMode() ? this.survivalRuntime.getWorldHeight() : this.canvas.height;
  }

  getUltraAimLaunchPower(anchorY) {
    const worldHeight = Math.max(1, this.getUltraAimWorldHeight());
    const halfwayY = worldHeight * 0.5;
    if (!Number.isFinite(anchorY) || anchorY <= halfwayY) {
      return PHYSICS_CONFIG.launchPower;
    }

    const t = Utils.clamp((anchorY - halfwayY) / Math.max(1, worldHeight - halfwayY), 0, 1);
    return PHYSICS_CONFIG.launchPower * (1 + t * 1.5);
  }

  rayCircleIntersectionDistance(originX, originY, dirX, dirY, cx, cy, radius) {
    const ox = originX - cx;
    const oy = originY - cy;
    const b = ox * dirX + oy * dirY;
    const c = ox * ox + oy * oy - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;

    const root = Math.sqrt(disc);
    const near = -b - root;
    if (near > 0.001) return near;
    const far = -b + root;
    return far > 0.001 ? far : null;
  }

  rayExpandedBrickIntersectionDistance(originX, originY, dirX, dirY, peg, pose, padding) {
    const pegX = Number.isFinite(pose?.x) ? pose.x : peg.x;
    const pegY = Number.isFinite(pose?.y) ? pose.y : peg.y;
    const angle = peg.angle || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const localOriginX = (originX - pegX) * cos + (originY - pegY) * sin;
    const localOriginY = -(originX - pegX) * sin + (originY - pegY) * cos;
    const localDirX = dirX * cos + dirY * sin;
    const localDirY = -dirX * sin + dirY * cos;
    const baseHalfW = (Number.isFinite(peg.width) ? peg.width : PHYSICS_CONFIG.brickWidth) * 0.5;
    const baseHalfH = (Number.isFinite(peg.height) ? peg.height : PHYSICS_CONFIG.brickHeight) * 0.5;
    const halfW = baseHalfW + padding;
    const halfH = baseHalfH + padding;

    // Slab test against the inflated rectangle.
    let tMin = -Infinity;
    let tMax = Infinity;
    if (Math.abs(localDirX) < 1e-6) {
      if (localOriginX < -halfW || localOriginX > halfW) return null;
    } else {
      let t1 = (-halfW - localOriginX) / localDirX;
      let t2 = (halfW - localOriginX) / localDirX;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
    if (Math.abs(localDirY) < 1e-6) {
      if (localOriginY < -halfH || localOriginY > halfH) return null;
    } else {
      let t1 = (-halfH - localOriginY) / localDirY;
      let t2 = (halfH - localOriginY) / localDirY;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
    if (tMax <= 0.001) return null;
    const tEnter = tMin > 0.001 ? tMin : tMax;

    // The inflated rectangle over-detects at corners (square instead of rounded
    // by ballRadius). If the entry lands in a corner region, refine with a
    // ray-vs-circle test against the corresponding corner — matching the proper
    // Minkowski hitbox the real ball physics uses.
    const px = localOriginX + localDirX * tEnter;
    const py = localOriginY + localDirY * tEnter;
    if (Math.abs(px) <= baseHalfW || Math.abs(py) <= baseHalfH) {
      return tEnter;
    }

    // Corner region: ray vs quarter-circle of radius `padding` at the brick corner.
    const cx = (px > 0 ? baseHalfW : -baseHalfW);
    const cy = (py > 0 ? baseHalfH : -baseHalfH);
    const ex = localOriginX - cx;
    const ey = localOriginY - cy;
    const b = ex * localDirX + ey * localDirY;
    const c = ex * ex + ey * ey - padding * padding;
    const disc = b * b - c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const near = -b - root;
    if (near > 0.001) return near;
    const far = -b + root;
    return far > 0.001 ? far : null;
  }

  getUltraAimBoundaryDistance(originX, originY, dirX, dirY) {
    const ballRadius = getBallRadius();
    const minX = ballRadius;
    const maxX = Math.max(minX, this.canvas.width - ballRadius);
    const minY = ballRadius;
    const maxY = Math.max(minY, this.getUltraAimWorldHeight() - ballRadius);
    const candidates = [];

    if (dirX > 1e-6) candidates.push((maxX - originX) / dirX);
    else if (dirX < -1e-6) candidates.push((minX - originX) / dirX);

    if (dirY > 1e-6) candidates.push((maxY - originY) / dirY);
    else if (dirY < -1e-6) candidates.push((minY - originY) / dirY);

    const positive = candidates.filter(value => Number.isFinite(value) && value > 0.001);
    if (positive.length === 0) {
      return Math.max(this.canvas.width, this.getUltraAimWorldHeight());
    }
    return Math.min(...positive);
  }

  buildUltraAimStraightPreview(sourcePeg, anchorX, anchorY, angle) {
    const origin = this.getUltraAimLaunchOrigin(sourcePeg, anchorX, anchorY, angle);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const ballRadius = getBallRadius();
    let bestDistance = this.getUltraAimBoundaryDistance(origin.x, origin.y, dirX, dirY);
    let hit = null;
    let hitPeg = null;
    let hitPose = null;

    for (const peg of this.pegs) {
      if (!peg || peg.id === sourcePeg?.id || this.isPortalPeg(peg)) continue;
      const poses = this.physics._getPegCollisionPoses(peg);
      for (const pose of poses) {
        const distance = peg.shape === 'brick'
          ? this.rayExpandedBrickIntersectionDistance(origin.x, origin.y, dirX, dirY, peg, pose, ballRadius)
          : this.rayCircleIntersectionDistance(
            origin.x,
            origin.y,
            dirX,
            dirY,
            Number.isFinite(pose?.x) ? pose.x : peg.x,
            Number.isFinite(pose?.y) ? pose.y : peg.y,
            this.physics.getPegCollisionRadius(peg) + ballRadius
          );
        if (!Number.isFinite(distance) || distance >= bestDistance - 0.001) continue;
        bestDistance = distance;
        hit = {
          x: origin.x + dirX * distance,
          y: origin.y + dirY * distance,
          pegId: peg.id
        };
        hitPeg = peg;
        hitPose = pose;
      }
    }

    // The collision math gives ball-center-at-collision, which sits a ball-radius
    // away from the peg surface — drawing the line there leaves a visible gap.
    // Extend the endpoint along the ray (not toward peg center, which would push
    // it off-axis and make the line wobble) by up to ballRadius, capped at the
    // ray's closest approach to the peg so we never overshoot. For head-on hits
    // this lands on the peg surface; for grazing hits it gracefully shortens.
    let endX = origin.x + dirX * bestDistance;
    let endY = origin.y + dirY * bestDistance;
    if (hitPeg) {
      const pegX = Number.isFinite(hitPose?.x) ? hitPose.x : hitPeg.x;
      const pegY = Number.isFinite(hitPose?.y) ? hitPose.y : hitPeg.y;
      const alongRayToPeg = (pegX - origin.x) * dirX + (pegY - origin.y) * dirY;
      const chordHalf = alongRayToPeg - bestDistance;
      const extension = Math.min(ballRadius, Math.max(0, chordHalf));
      endX = origin.x + dirX * (bestDistance + extension);
      endY = origin.y + dirY * (bestDistance + extension);
    }

    return {
      points: [
        { x: origin.x, y: origin.y },
        { x: endX, y: endY }
      ],
      hits: hit ? [hit] : []
    };
  }

  isUltraAimQteActive() {
    return !!this.ultraAimQte?.active;
  }

  getUltraAimQteBall() {
    if (!this.isUltraAimQteActive()) return null;
    return this.balls.find(ball => ball && ball.id === this.ultraAimQte.ballId) || null;
  }

  getUltraAimQtePeg() {
    if (!this.isUltraAimQteActive()) return null;
    return this.pegs.find(peg => peg && peg.id === this.ultraAimQte.pegId) || null;
  }

  resolveUltraAimAnchorPosition(peg, baseX, baseY) {
    if (!peg) {
      return {
        x: Number.isFinite(baseX) ? baseX : 0,
        y: Number.isFinite(baseY) ? baseY : 0
      };
    }

    const wrapCopies = Array.isArray(peg._wrapCopies) ? peg._wrapCopies : [];
    const candidates = [];
    if (!peg._wrapHideMain || wrapCopies.length === 0) {
      candidates.push({ x: peg.x, y: peg.y });
    }
    for (const copy of wrapCopies) {
      if (!copy || !Number.isFinite(copy.x) || !Number.isFinite(copy.y)) continue;
      candidates.push({ x: copy.x, y: copy.y });
    }
    if (candidates.length === 0) {
      candidates.push({ x: peg.x, y: peg.y });
    }

    let best = candidates[0];
    let bestDistSq = (best.x - baseX) * (best.x - baseX) + (best.y - baseY) * (best.y - baseY);
    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[i];
      const distSq = (candidate.x - baseX) * (candidate.x - baseX) + (candidate.y - baseY) * (candidate.y - baseY);
      if (distSq < bestDistSq) {
        best = candidate;
        bestDistSq = distSq;
      }
    }

    return best;
  }

  handleUltraAimQteInput(e) {
    if (!this.isUltraAimQteActive()) return false;
    if (e?.preventDefault) e.preventDefault();
    if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
    this.fireUltraAimQte();
    return true;
  }

  getInputWorldPosition(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;

    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY + this.getCameraY()
    };
  }

  _handleDebugDragStart(e) {
    if (!this.debugDrag.enabled) return false;
    if (this.isEndSequenceActive()) return false;

    e.preventDefault();
    this.state = 'playing';
    const pos = this.getInputWorldPosition(e);
    const ball = this.ensureDebugDragBall();
    this.debugDrag.dragging = true;
    this.moveDebugDragBall(ball, pos.x, pos.y, true);
    this.trajectory = null;
    return true;
  }

  _handleDebugDragMove(e) {
    if (!this.debugDrag.enabled || !this.debugDrag.dragging) return false;
    e.preventDefault();
    const pos = this.getInputWorldPosition(e);
    const ball = this.ensureDebugDragBall();
    this.moveDebugDragBall(ball, pos.x, pos.y, false);
    return true;
  }

  _handleDebugDragEnd(e) {
    if (!this.debugDrag.enabled || !this.debugDrag.dragging) return false;
    e.preventDefault();
    this.debugDrag.dragging = false;
    const ball = this.ensureDebugDragBall();
    ball.vx = 0;
    ball.vy = 0;
    return true;
  }

  ensureDebugDragBall() {
    let ball = this.balls.find(b => b && b.isDebugDragBall);
    if (ball) {
      this.configureBallYoyoState(ball);
      return ball;
    }

    this.updateLaunchPosition();
    ball = this.balls[0] || new Ball(this.launchX, this.launchY);
    ball.x = this.launchX;
    ball.y = this.launchY;
    ball.vx = 0;
    ball.vy = 0;
    ball.active = true;
    ball.stuck = false;
    ball.stuckFrames = 0;
    ball.isDebugDragBall = true;
    this.configureBallYoyoState(ball);

    this.balls = [ball];
    this.physics.setBalls(this.balls);
    this.balls = this.physics.balls;

    this.yoyoThread.clear();
    this.clearDynamicYoyoAnchors();
    this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
    if (ball.yoyoEligible !== false) {
      this.yoyoThread.registerBallLaunch(ball, this.launchX, this.launchY);
    }
    return ball;
  }

  moveDebugDragBall(ball, targetX, targetY, resetVelocity = false) {
    if (!ball) return;
    const radius = ball.radius || PHYSICS_CONFIG.pegRadius;
    const minX = radius;
    const maxX = this.canvas.width - radius;
    const minY = radius;
    const maxY = Math.max(minY, this.physics.ballLossY - radius - 6);
    const nextX = Utils.clamp(targetX, minX, maxX);
    const nextY = Utils.clamp(targetY, minY, maxY);

    if (resetVelocity) {
      ball.vx = 0;
      ball.vy = 0;
    } else {
      const dx = nextX - ball.x;
      const dy = nextY - ball.y;
      const maxVel = PHYSICS_CONFIG.maxVelocity;
      ball.vx = Utils.clamp(dx * 0.55, -maxVel, maxVel);
      ball.vy = Utils.clamp(dy * 0.55, -maxVel, maxVel);
    }

    ball.x = nextX;
    ball.y = nextY;
    ball.active = true;
    ball.stuck = false;
    ball.stuckFrames = 0;
  }

  updateAim(e) {
    const pos = this.getInputWorldPosition(e);
    const tx = pos.x;
    const ty = pos.y;

    const dx = tx - this.launchX;
    const dy = ty - this.launchY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 5) {
      this.aimAngle = Math.PI / 2;
    } else {
      // Find launch angle so the trajectory passes through cursor (tx,ty).
      // Simulate at a candidate angle, see where the ball is at distance `dist`,
      // measure the miss, correct the target. Two passes converge well.
      const g = PHYSICS_CONFIG.gravity;
      const v = PHYSICS_CONFIG.launchPower;
      const f = PHYSICS_CONFIG.friction;
      let cx = tx, cy = ty; // corrected target
      for (let pass = 0; pass < 2; pass++) {
        const angle = Math.atan2(cy - this.launchY, cx - this.launchX);
        let bx = 0, by = 0, bvx = Math.cos(angle) * v, bvy = Math.sin(angle) * v;
        for (let t = 0; t < 500; t++) {
          bvy += g;
          bvx *= f;
          bvy *= f;
          bx += bvx;
          by += bvy;
          if (bx * bx + by * by >= dist * dist) break;
        }
        // Miss = where ball ended up vs where cursor is (relative to launch)
        cx += (tx - this.launchX) - bx;
        cy += (ty - this.launchY) - by;
      }
      this.aimAngle = Math.atan2(cy - this.launchY, cx - this.launchX);
    }

    this.updateTrajectory();
  }

  updateTrajectory() {
    const showFull = this.shouldShowFullTrajectory();
    const aimSteps = Math.max(0, Math.round(this.aimLength || 0));
    const steps = showFull ? 1000 : (aimSteps > 0 ? Math.max(2, aimSteps) : 0);
    const stopAtHit = !showFull;
    this.trajectory = this.physics.predictTrajectory(
      this.launchX,
      this.launchY,
      this.aimAngle,
      PHYSICS_CONFIG.launchPower,
      steps,
      stopAtHit
    );
  }

  shouldShowFullTrajectory() {
    return this.showFullTrajectory;
  }

  isSurvivalMode() {
    return this.survivalRuntime.isEnabled();
  }

  getCameraY() {
    return this.survivalRuntime.getCameraY();
  }

  syncPhysicsViewportBounds(height = this.canvas.height) {
    const viewportHeight = Math.max(0, Number(height) || this.canvas.height || 0);
    const cameraY = this.isSurvivalMode() ? this.getCameraY() : 0;
    this.physics.setBallTopY?.(Math.min(0, cameraY));
    this.physics.setBallLossY(cameraY + viewportHeight + 50);
  }

  updateLaunchPosition() {
    this.launchX = this.canvas.width / 2;
    this.launchY = 40 + this.getCameraY();
  }

  refreshYoyoThreadRuntimeConfig() {
    const base = this.baseYoyoSettings || normalizeYoyoSettings(null);
    const enabledByPerk = this.yoyoPerkUsesRemaining > 0;
    const enabledByLiveBall = Array.isArray(this.balls)
      && this.balls.some(ball => ball && ball.yoyoEligible === true);
    this.yoyoThread.configure({
      ...base,
      enabled: !!base.enabled || enabledByPerk || enabledByLiveBall
    });
  }

  configureBallYoyoState(ball, options = null) {
    if (!ball) return;
    const suppressPerkBinding = !!(options && options.suppressPerkBinding);
    ball.yoyoPerkConsumed = false;
    if (this.baseYoyoSettings && this.baseYoyoSettings.enabled) {
      ball.yoyoEligible = true;
      ball.yoyoPerkBound = false;
      return;
    }
    if (!suppressPerkBinding && this.yoyoPerkUsesRemaining > 0) {
      ball.yoyoEligible = true;
      ball.yoyoPerkBound = true;
      return;
    }
    ball.yoyoEligible = false;
    ball.yoyoPerkBound = false;
  }

  consumeYoyoPerkUseOnBind(ball) {
    if (!ball || !ball.yoyoPerkBound || ball.yoyoPerkConsumed) return false;
    if (this.baseYoyoSettings && this.baseYoyoSettings.enabled) return false;
    if (this.yoyoPerkUsesRemaining <= 0) return false;

    this.yoyoPerkUsesRemaining = Math.max(0, this.yoyoPerkUsesRemaining - 1);
    ball.yoyoPerkConsumed = true;
    this.refreshYoyoThreadRuntimeConfig();
    this.emitUiStateIfChanged(true, 'yoyo-perk-consumed');
    return true;
  }

  disablePerkYoyoAcrossBalls() {
    for (const ball of this.balls) {
      if (!ball || !ball.yoyoPerkBound) continue;
      ball.yoyoEligible = false;
      ball.yoyoPerkBound = false;
    }
  }

  applyYoyoReleaseEvents(releaseEvents) {
    if (!Array.isArray(releaseEvents) || releaseEvents.length === 0) return;
    for (const ballId of releaseEvents) {
      this.removeDynamicYoyoAnchor(ballId);
    }
    if (this.baseYoyoSettings && this.baseYoyoSettings.enabled) return;

    let needsRefresh = false;
    for (const ballId of releaseEvents) {
      const ball = this.balls.find(item => item && item.id === ballId);
      if (!ball || !ball.yoyoPerkBound) continue;

      if (!ball.yoyoPerkConsumed && this.yoyoPerkUsesRemaining > 0) {
        this.yoyoPerkUsesRemaining = Math.max(0, this.yoyoPerkUsesRemaining - 1);
        ball.yoyoPerkConsumed = true;
      }
      ball.yoyoEligible = false;
      ball.yoyoPerkBound = false;
      ball.yoyoPerkConsumed = false;
      needsRefresh = true;
    }

    if (needsRefresh) {
      this.refreshYoyoThreadRuntimeConfig();
    }
  }

  getBombPerkChargeCount() {
    return this.queuedBombPerkCharges + (this.armedBombPerk ? 1 : 0);
  }

  armBombPerkForLaunch() {
    if (this.armedBombPerk) return false;
    if (this.queuedBombPerkCharges <= 0) return false;
    this.queuedBombPerkCharges = Math.max(0, this.queuedBombPerkCharges - 1);
    this.armedBombPerk = true;
    this.emitUiStateIfChanged(true, 'bomb-perk-armed');
    return true;
  }

  armDeepFreezeForLaunch() {
    if (this.queuedDeepFreezeShots <= 0) {
      this.deepFreezeShotActive = false;
      return false;
    }

    this.queuedDeepFreezeShots = Math.max(0, this.queuedDeepFreezeShots - 1);
    this.deepFreezeShotActive = true;
    this.deepFreezeSystem.startShot(this.pegs);
    return true;
  }

  finishDeepFreezeShot() {
    const wasActive = this.deepFreezeShotActive || this.deepFreezeSystem.isActive();
    const moved = wasActive ? this.deepFreezeSystem.finishShot(this.pegs) : false;
    this.deepFreezeShotActive = false;
    return moved;
  }

  armUltraAimForLaunch() {
    if (this.ultraAimV2Charges <= 0) return false;
    if (this.ultraAimShotActive || this.isUltraAimQteActive()) return false;
    this.ultraAimV2Charges = Math.max(0, this.ultraAimV2Charges - 1);
    this.ultraAimShotActive = true;
    return true;
  }

  resetUltraAimRuntime() {
    const qteBall = this.getUltraAimQteBall();
    if (qteBall) {
      qteBall.ultraAimStuck = false;
      qteBall.ultraAimQteBall = false;
    }
    this.ultraAimShotActive = false;
    this.ultraAimQte = this.createUltraAimQteState();
  }

  isUltraAimStickyEligiblePeg(peg) {
    if (!peg || this.isPortalPeg(peg)) return false;
    if (peg.type === 'bumper') return false;
    return true;
  }

  syncUltraAimQteBall() {
    if (!this.isUltraAimQteActive()) return false;
    const qteBall = this.getUltraAimQteBall();
    const qtePeg = this.getUltraAimQtePeg();
    if (!qteBall || !qtePeg) {
      this.resetUltraAimRuntime();
      return false;
    }

    const anchor = this.resolveUltraAimAnchorPosition(qtePeg, this.ultraAimQte.anchorX, this.ultraAimQte.anchorY);
    this.ultraAimQte.anchorX = anchor.x;
    this.ultraAimQte.anchorY = anchor.y;
    qteBall.x = anchor.x;
    qteBall.y = anchor.y;
    qteBall.vx = 0;
    qteBall.vy = 0;
    qteBall.active = true;
    qteBall.stuck = false;
    qteBall.stuckFrames = 0;
    qteBall.ultraAimStuck = true;
    qteBall.ultraAimQteBall = true;
    return true;
  }

  getUltraAimLaunchOrigin(peg, baseX, baseY, angle) {
    const anchorX = Number.isFinite(baseX) ? baseX : (Number.isFinite(peg?.x) ? peg.x : 0);
    const anchorY = Number.isFinite(baseY) ? baseY : (Number.isFinite(peg?.y) ? peg.y : 0);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const ballRadius = getBallRadius();

    let sourceExtent = this.physics.getPegCollisionRadius(peg);
    if (peg?.shape === 'brick') {
      const width = Number.isFinite(peg.width) ? peg.width : PHYSICS_CONFIG.brickWidth;
      const height = Number.isFinite(peg.height) ? peg.height : PHYSICS_CONFIG.brickHeight;
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      const pegAngle = peg.angle || 0;
      const ux = Math.cos(pegAngle);
      const uy = Math.sin(pegAngle);
      const vx = -uy;
      const vy = ux;
      sourceExtent =
        halfWidth * Math.abs(dirX * ux + dirY * uy) +
        halfHeight * Math.abs(dirX * vx + dirY * vy);
    }

    const separation = sourceExtent + ballRadius + 1;
    return {
      x: anchorX + dirX * separation,
      y: anchorY + dirY * separation
    };
  }

  updateUltraAimQte(dt) {
    if (!this.isUltraAimQteActive()) return;
    if (!this.syncUltraAimQteBall()) return;

    const qte = this.ultraAimQte;
    const peg = this.getUltraAimQtePeg();
    qte.elapsed += dt;
    qte.angle = ULTRA_AIM_V2_START_ANGLE + (qte.elapsed * Math.PI * 2) / ULTRA_AIM_V2_ROTATION_SECONDS;
    qte.trajectory = this.buildUltraAimStraightPreview(peg, qte.anchorX, qte.anchorY, qte.angle);

    if (qte.elapsed >= ULTRA_AIM_V2_ROTATION_SECONDS * ULTRA_AIM_V2_MAX_ROTATIONS) {
      this.releaseUltraAimQteWithoutShot();
    }
  }

  engageUltraAimQte(event) {
    if (!this.ultraAimShotActive || this.isUltraAimQteActive()) return false;
    const peg = event?.peg;
    const ball = event?.ball;
    if (!ball || !ball.active || ball.ultraAimStuck) return false;
    if (!this.isUltraAimStickyEligiblePeg(peg)) return false;

    this.ultraAimShotActive = false;
    this.yoyoThread.removeBall(ball.id);
    this.removeDynamicYoyoAnchor(ball.id);
    ball.yoyoEligible = false;
    ball.yoyoPerkBound = false;

    const qte = this.createUltraAimQteState();
    qte.active = true;
    qte.pegId = peg.id;
    qte.ballId = ball.id;
    qte.anchorX = peg.x;
    qte.anchorY = peg.y;
    qte.skipMultiballOnRelease = peg.type === 'multi';
    this.ultraAimQte = qte;

    if (this.physics?.hitPegs && typeof this.physics.hitPegs.add === 'function') {
      this.physics.hitPegs.add(peg.id);
    }

    if (peg.type === 'multi') {
      const spawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
      this.spawnMultiballs(
        {
          x: peg.x,
          y: peg.y,
          vx: event?.impact?.vx ?? ball.vx,
          vy: event?.impact?.vy ?? ball.vy
        },
        spawnCount
      );
    }

    this.syncUltraAimQteBall();
    this.updateUltraAimQte(0);
    return true;
  }

  activateUltraAimHeldPeg(ball, options = null) {
    if (!this.isUltraAimQteActive()) return false;
    const peg = this.getUltraAimQtePeg();
    if (!peg) return false;

    if (peg.type === 'obstacle') {
      this.animator.notifyHit(peg.id);
      return false;
    }

    const allowMultiball = options?.allowMultiball !== false && !this.ultraAimQte.skipMultiballOnRelease;
    const activated = this.activatePeg(peg, ball, { allowMultiball });
    this.animator.notifyHit(peg.id);
    return activated;
  }

  prepareUltraAimFollowUpBall(ball, anchorX, anchorY, anchorPeg = null) {
    if (!ball) return;
    this.armBombPerkForLaunch();
    this.armDeepFreezeForLaunch();
    this.yoyoThread.removeBall(ball.id);
    this.removeDynamicYoyoAnchor(ball.id);
    this.yoyoThread.setLaunchAnchor(anchorX, anchorY);
    this.configureBallYoyoState(ball);
    if (ball.yoyoEligible !== false) {
      this.yoyoThread.registerBallLaunch(ball, anchorX, anchorY, { anchorPegId: anchorPeg?.id || null });
      this.consumeYoyoPerkUseOnBind(ball);
      if (anchorPeg?.id) {
        this.bindDynamicYoyoAnchor(ball.id, anchorPeg.id, anchorX, anchorY);
      }
    }
  }

  fireUltraAimQte() {
    if (!this.isUltraAimQteActive()) return false;

    const qte = this.ultraAimQte;
    const ball = this.getUltraAimQteBall();
    const peg = this.getUltraAimQtePeg();
    if (!ball) {
      this.resetUltraAimRuntime();
      return false;
    }

    const anchorX = qte.anchorX;
    const anchorY = qte.anchorY;
    const angle = qte.angle;
    const launchOrigin = this.getUltraAimLaunchOrigin(peg, anchorX, anchorY, angle);
    const launchPower = this.getUltraAimLaunchPower(anchorY);

    this.activateUltraAimHeldPeg(ball, { allowMultiball: !qte.skipMultiballOnRelease });

    ball.ultraAimStuck = false;
    ball.ultraAimQteBall = false;
    ball.x = launchOrigin.x;
    ball.y = launchOrigin.y;
    ball.launch(angle, launchPower);
    this.prepareUltraAimFollowUpBall(ball, anchorX, anchorY, peg);
    this.ultraAimQte = this.createUltraAimQteState();
    return true;
  }

  releaseUltraAimQteWithoutShot() {
    if (!this.isUltraAimQteActive()) return false;

    const qte = this.ultraAimQte;
    const ball = this.getUltraAimQteBall();
    if (!ball) {
      this.resetUltraAimRuntime();
      return false;
    }

    this.activateUltraAimHeldPeg(ball, { allowMultiball: !qte.skipMultiballOnRelease });

    ball.ultraAimStuck = false;
    ball.ultraAimQteBall = false;
    ball.yoyoEligible = false;
    ball.yoyoPerkBound = false;
    ball.x = qte.anchorX;
    ball.y = qte.anchorY;
    ball.vx = 0;
    ball.vy = Math.max(ball.vy, 0.2);
    ball.active = true;
    ball.stuck = false;
    ball.stuckFrames = 0;
    this.yoyoThread.removeBall(ball.id);
    this.removeDynamicYoyoAnchor(ball.id);
    this.ultraAimQte = this.createUltraAimQteState();
    return true;
  }

  consumeBombPerkOnFirstContact(contactEvents) {
    if (!this.armedBombPerk) return null;
    if (!Array.isArray(contactEvents) || contactEvents.length === 0) return null;
    const firstContact = contactEvents.find(event => event && event.ball && event.peg);
    if (!firstContact) return null;

    this.armedBombPerk = false;
    this.emitUiStateIfChanged(true, 'bomb-perk-triggered');
    return firstContact;
  }

  detonateBombShockwave(sourceBall, sourcePeg) {
    const shockwave = buildBombShockwave(this.pegs, sourceBall, sourcePeg);
    this.queueBackgroundEvent({
      kind: 'bombSplash',
      x: Number.isFinite(shockwave.centerX) ? shockwave.centerX : (sourcePeg?.x ?? sourceBall?.x ?? this.canvas.width / 2),
      y: Number.isFinite(shockwave.centerY) ? shockwave.centerY : (sourcePeg?.y ?? sourceBall?.y ?? this.canvas.height / 2),
      radius: Math.max(84, Number.isFinite(shockwave.radius) ? shockwave.radius * 0.95 : 120),
      strength: 2.8,
      burst: 2.3,
      swirl: 1.15,
      spread: 3.2
    });
    if (!Array.isArray(shockwave.targets) || shockwave.targets.length === 0) return 0;

    let activatedCount = 0;
    for (const peg of shockwave.targets) {
      if (this.activatePeg(peg, sourceBall, { allowMultiball: true })) {
        this.queueBombTargetShockwave(peg, sourceBall);
        activatedCount++;
      }
    }
    if (this.deepFreezeSystem.isActive()) {
      this.deepFreezeSystem.applyShockwaveTargets(
        shockwave.targets,
        shockwave.centerX,
        shockwave.centerY,
        shockwave.radius,
        sourceBall
      );
      for (const peg of shockwave.targets) {
        if (!peg || this.isPortalPeg(peg)) continue;
        this.animator.suspendPeg(peg.id);
      }
    }
    return activatedCount;
  }

  createRuntimeFlipper(config) {
    const cameraY = this.isSurvivalMode() ? this.getCameraY() : 0;
    const defaultScreenY = Math.max(30, this.canvas.height - FLIPPER_DEFAULTS.yOffset);
    const rawScreenY = Number.isFinite(config?._screenY)
      ? config._screenY
      : (Number.isFinite(config?.screenY)
        ? config.screenY
        : (Number.isFinite(config?.y) ? config.y - cameraY : defaultScreenY));
    const screenY = this.isSurvivalMode()
      ? Utils.clamp(rawScreenY, 30, Math.max(30, this.canvas.height - 35))
      : rawScreenY;
    return {
      ...config,
      enabled: true,
      y: this.isSurvivalMode() ? cameraY + screenY : config.y,
      _screenY: screenY,
      _flipperT: 0,
      _flipperActivated: false,
      _angularDelta: 0
    };
  }

  syncSurvivalFlipperAnchor() {
    if (!this.isSurvivalMode() || !this.flippers || !this.flippers.enabled) return;
    const defaultScreenY = Math.max(30, this.canvas.height - FLIPPER_DEFAULTS.yOffset);
    const rawScreenY = Number.isFinite(this.flippers._screenY)
      ? this.flippers._screenY
      : (Number.isFinite(this.flippers.y) ? this.flippers.y - this.getCameraY() : defaultScreenY);
    const screenY = Utils.clamp(rawScreenY, 30, Math.max(30, this.canvas.height - 35));
    this.flippers._screenY = screenY;
    this.flippers.y = this.getCameraY() + screenY;
  }

  triggerPortalPulse(peg) {
    if (!peg || !isPortalType(peg.type)) return;
    peg._portalPulse = 1;
  }

  updatePortalPulses(dt) {
    const decay = Math.max(0, dt) * this._portalFxDecayPerSecond;
    if (decay <= 0 || !Array.isArray(this.pegs)) return;
    for (const peg of this.pegs) {
      if (!peg || !isPortalType(peg.type) || !Number.isFinite(peg._portalPulse)) continue;
      peg._portalPulse = Math.max(0, peg._portalPulse - decay);
    }
  }

  createTemporaryFlipperConfig() {
    return createDefaultFlipperConfig({
      canvasHeight: this.canvas.height,
      cameraY: this.getCameraY(),
      bounce: PHYSICS_CONFIG.bounce,
      enabled: true
    });
  }

  refreshFlipperState() {
    let flipperConfig = null;
    if (this.baseFlipperConfig && this.baseFlipperConfig.enabled) {
      flipperConfig = this.baseFlipperConfig;
    } else if (this.temporaryFlipperActive) {
      flipperConfig = this.createTemporaryFlipperConfig();
    }

    if (flipperConfig) {
      this.flippers = this.createRuntimeFlipper(flipperConfig);
      this.syncSurvivalFlipperAnchor();
      this.physics.setFlippers(this.flippers);
    } else {
      this.flippers = null;
      this.physics.setFlippers(null);
    }
  }

  getActiveHitPegIdSet() {
    return new Set([...this.hitPegIds, ...this.turnHitPegIds]);
  }

  getSurvivalTargetExclusionSet(includePendingHits = true) {
    const excluded = new Set(this.survivalEscapedPegIds || []);
    if (includePendingHits) {
      for (const id of this.hitPegIds) excluded.add(id);
      for (const id of this.turnHitPegIds) excluded.add(id);
    }
    return excluded;
  }

  syncPhysicsHitPegState() {
    if (!this.physics?.hitPegs) return;
    this.physics.hitPegs.clear();
    for (const id of this.hitPegIds) this.physics.hitPegs.add(id);
    for (const id of this.turnHitPegIds) this.physics.hitPegs.add(id);
    if (this.survivalEscapedPegIds) {
      for (const id of this.survivalEscapedPegIds) this.physics.hitPegs.add(id);
    }
  }

  getSurvivalTargetsLeft(includePendingHits = true) {
    if (!this.isSurvivalMode()) return this.getOrangePegsLeft();
    const excluded = this.getSurvivalTargetExclusionSet(includePendingHits);
    return countSurvivalTargets(this.pegs, excluded);
  }

  checkSurvivalEndConditions() {
    if (!this.isSurvivalMode()) return false;
    if (this.state === 'won' || this.state === 'lost') return true;
    if (this._pendingEndResult?.result === 'won') {
      return this._maybeFinalizePendingEndResult();
    }

    const hitSet = this.getActiveHitPegIdSet();
    let escapedChanged = false;
    for (const peg of this.pegs) {
      if (hitSet.has(peg.id)) continue;
      if (this.survivalEscapedPegIds.has(peg.id)) continue;
      if (this.survivalRuntime.isPegBeyondLoseLine(peg, PHYSICS_CONFIG.pegRadius)) {
        if (!this.isOrangePeg(peg)) {
          if (isPegRemovableInSurvival(peg)) {
            this.survivalEscapedPegIds.add(peg.id);
            this.physics?.hitPegs?.add?.(peg.id);
            escapedChanged = true;
          }
          continue;
        }
        this._finalizeEndState('lost');
        return true;
      }
    }
    if (escapedChanged) {
      this.emitUiStateIfChanged(true, 'survival-pegs-escaped');
    }
    this.pruneEscapedSurvivalPegs();

    if (this.getSurvivalTargetsLeft(true) === 0) {
      this._queuePendingEndResult('won', { readyToResolve: true });
      return this._maybeFinalizePendingEndResult();
    }

    return false;
  }

  pruneEscapedSurvivalPegs() {
    if (!this.isSurvivalMode() || !this.survivalEscapedPegIds || this.survivalEscapedPegIds.size === 0) return false;
    const before = this.pegs.length;
    this.pegs = this.pegs.filter(peg => {
      if (!this.survivalEscapedPegIds.has(peg.id)) return true;
      const extent = getPegVerticalExtent(peg, PHYSICS_CONFIG.pegRadius);
      const screenY = this.survivalRuntime.worldToScreenY(peg.y);
      return screenY + extent > -24;
    });
    if (this.pegs.length === before) return false;

    const liveIds = new Set(this.pegs.map(peg => peg.id));
    for (const id of [...this.survivalEscapedPegIds]) {
      if (!liveIds.has(id)) {
        this.survivalEscapedPegIds.delete(id);
        this.pendingHitPegClears.delete(id);
      }
    }
    this.physics.setPegs(this.pegs);
    this.syncPhysicsHitPegState();
    return true;
  }

  applyYoyoSettings(rawSettings, options = null) {
    this.baseYoyoSettings = normalizeYoyoSettings(rawSettings);
    this.refreshYoyoThreadRuntimeConfig();
    this.setDebugDragEnabled(!!this.baseYoyoSettings.debugDrag, options);
  }

  setDebugDragEnabled(enabled, options = null) {
    const next = !!enabled;
    if (this.debugDrag.enabled === next) return;
    const skipReset = !!(options && options.skipReset);

    this.debugDrag.enabled = next;
    this.debugDrag.dragging = false;
    if (skipReset) return;

    if (next) {
      this.state = 'idle';
      this.yoyoThread.clear();
      this.clearDynamicYoyoAnchors();
      this.updateLaunchPosition();
      this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
      this.resetBall();
      return;
    }

    // Leave debug mode with a clean regular turn state.
    this.state = 'idle';
    this.yoyoThread.clear();
    this.clearDynamicYoyoAnchors();
    this.resetBall();
  }

  loadLevel(levelData) {
    this.levelFxId++;
    this.backgroundEvents = [];
    if (
      levelData?.visuals
      && typeof levelData.visuals === 'object'
      && Object.prototype.hasOwnProperty.call(levelData.visuals, 'endSequence')
    ) {
      this.setEndSequenceConfig(levelData.visuals.endSequence);
    }
    const survivalSettings = ensureLevelSurvival(levelData, this.canvas.height);
    const yoyoSettings = normalizeYoyoSettings(levelData.yoyo);
    this.survivalRuntime.resize(this.canvas.height);
    this.survivalRuntime.configure(survivalSettings);
    this.survivalRuntime.resetCamera(true);
    this.yoyoPerkUsesRemaining = 0;
    this.finishDeepFreezeShot();
    this.resetUltraAimRuntime();
    this.ultraAimV2Charges = 0;
    this.queuedDeepFreezeShots = 0;
    this.queuedBombPerkCharges = 0;
    this.armedBombPerk = false;
    this.applyYoyoSettings(yoyoSettings, { skipReset: true });

    this.groups = Array.isArray(levelData.groups)
      ? levelData.groups.map(group => ({
        ...group,
        animation: group.animation ? { ...group.animation } : group.animation
      }))
      : [];
    this.pegs = levelData.pegs.map(p => {
      const copy = { ...p };
      if (copy.type === 'multi') {
        copy.multiballSpawnCount = normalizeMultiballSpawnCount(copy.multiballSpawnCount);
      }
      if (copy.type === 'gamble') {
        Object.assign(copy, normalizeSurvivalGamblePegProperties(copy, survivalSettings.gamblePeg));
      }
      if (isPortalType(copy.type)) {
        normalizePortalPegProperties(copy, { upgradeLegacyDefault: true });
      }
      if (p.curveSlices) copy.curveSlices = p.curveSlices.map(s => ({ ...s }));
      if (p.animation) copy.animation = { ...p.animation };
      return copy;
    });
    this.physics.setPegs(this.pegs);
    this.animator.loadFromLevel(this.pegs, this.groups);

    // Load flippers
    const normalizedFlippers = normalizeFlipperConfig(levelData.flippers, {
      canvasHeight: this.canvas.height,
      bounce: PHYSICS_CONFIG.bounce
    });
    this.baseFlipperConfig = (normalizedFlippers && normalizedFlippers.enabled)
      ? { ...normalizedFlippers, enabled: true }
      : null;
    this.temporaryFlipperTurns = 0;
    this.temporaryFlipperActive = false;
    this.refreshFlipperState();

    this.physics.setBucketEnabled(!this.isSurvivalMode());
    this.syncPhysicsViewportBounds();

    this.score = 0;
    this.survivalAntiCooldownMs = this.isSurvivalMode() ? (survivalSettings.antiCooldownMs || 0) : 0;
    this.survivalShotCooldownRemainingMs = 0;
    this.survivalGambleOverlayOpen = false;
    this.survivalEscapedPegIds = new Set();
    const hitPegClearSettings = normalizeLevelHitPegClearSettings(levelData);
    this.hitPegTimedClearEnabled = hitPegClearSettings.enabled;
    this.hitPegClearDelayMs = hitPegClearSettings.delayMs;
    this.pendingHitPegClears = new Map();
    this.levelElapsedMs = 0;
    this.gambleBalls = 0;
    this.initialGambleBallCount = 0;
    this.ballsLeft = this.isSurvivalMode() ? Number.POSITIVE_INFINITY : 10;
    this.initialBallCount = Number.isFinite(this.ballsLeft) ? this.ballsLeft : 10;
    this.hitPegIds = [];
    this.turnHitPegIds = [];
    this.shotsFired = 0;
    this.initialOrangePegs = this.getTotalOrangePegs();
    this.removedOrangePegs = 0;
    this.bucketCatchLight = 0;
    this.totalSurvivalTargets = this.isSurvivalMode() ? countSurvivalTargets(this.pegs) : 0;
    this.state = 'idle';
    this.trajectory = null;
    this.aimLength = typeof levelData.aimLength === 'number' ? levelData.aimLength : 300;
    this.ultraAimCharges = 0;
    this.ultraAimV2Charges = 0;
    this.ultraAimShotActive = false;
    this.ultraAimQte = this.createUltraAimQteState();
    this.queuedDeepFreezeShots = 0;
    this.deepFreezeShotActive = false;
    this.queuedBombPerkCharges = 0;
    this.armedBombPerk = false;
    this.lastUiStateSignature = '';
    this._resetPerformanceCap30Detection();
    this.renderTimeSeconds = 0;
    this.renderDeltaSeconds = 0;
    this.rawFrameDeltaSeconds = 0;
    this._currentTimeScale = 1;
    this._lastPegSlowmoElapsedMs = -1;
    this._pendingEndResult = null;
    this._gameEndEmitted = false;
    this._levelClearEmitted = false;
    this._frozenSurvivalTrackerState = null;
    this.renderer.clearPegExitAnimations?.();

    this.updateLaunchPosition();
    this.clearDynamicYoyoAnchors();
    this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
    this.resetBall();
  }

  hasActiveBalls() {
    return Array.isArray(this.balls) && this.balls.some(ball => ball && ball.active);
  }

  getLauncherBall() {
    if (!Array.isArray(this.balls)) return null;
    return this.balls.find(ball => ball && !ball.active && ball.isLauncherBall) || null;
  }

  ensureSurvivalLauncherBall() {
    this.updateLaunchPosition();
    let launcher = this.getLauncherBall();
    if (!launcher) {
      launcher = this.balls.find(ball => ball && !ball.active) || new Ball(this.launchX, this.launchY);
    }

    launcher.reset(this.launchX, this.launchY);
    launcher.isLauncherBall = true;
    launcher.launcherSpawnAnim = 0;
    launcher.isDebugDragBall = false;
    launcher.ultraAimStuck = false;
    launcher.ultraAimQteBall = false;
    launcher.yoyoEligible = undefined;
    launcher.yoyoPerkBound = undefined;

    const nextBalls = [];
    const seen = new Set();
    for (const ball of this.balls) {
      if (!ball || ball === launcher || !ball.active) continue;
      if (seen.has(ball.id)) continue;
      seen.add(ball.id);
      nextBalls.push(ball);
    }
    nextBalls.push(launcher);
    this.balls = nextBalls;
    this.physics.setBalls(this.balls);
    this.balls = this.physics.balls;
    return launcher;
  }

  resetBall() {
    this.updateLaunchPosition();
    this.survivalShotCooldownRemainingMs = 0;
    this.resetUltraAimRuntime();
    this.yoyoThread.clear();
    this.clearDynamicYoyoAnchors();
    this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
    const launcher = new Ball(this.launchX, this.launchY);
    launcher.isLauncherBall = true;
    launcher.launcherSpawnAnim = 0;
    this.balls = [launcher];
    this.physics.setBalls(this.balls);
    this.balls = this.physics.balls;
    this.turnHitPegIds = [];
    this.physics.clearHitPegs();
    this.syncPhysicsHitPegState();
    this.resetStuckBallTracking();
  }

  queueBackgroundEvent(event) {
    if (!event || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
    this.backgroundEvents.push(event);
  }

  queueVictoryShockwave(peg, sourceBall = null) {
    if (!peg || !Number.isFinite(peg.x) || !Number.isFinite(peg.y)) return;
    this.queueBackgroundEvent({
      kind: 'victorySplash',
      x: peg.x,
      y: peg.y,
      radius: Math.max(132, PHYSICS_CONFIG.pegRadius * 13.5),
      strength: 3.4,
      burst: 2.8,
      swirl: 1.35,
      spread: 3.6,
      speed: Number.isFinite(sourceBall?.vx) || Number.isFinite(sourceBall?.vy)
        ? Utils.magnitude(sourceBall?.vx || 0, sourceBall?.vy || 0)
        : 0,
      normalX: 0,
      normalY: -1
    });
  }

  queueBombTargetShockwave(peg, sourceBall = null) {
    if (!peg || !Number.isFinite(peg.x) || !Number.isFinite(peg.y)) return;
    let radius = PHYSICS_CONFIG.pegRadius * 5.2;
    if (peg.shape === 'brick') {
      const width = Number.isFinite(peg.width) ? peg.width : PHYSICS_CONFIG.brickWidth;
      const height = Number.isFinite(peg.height) ? peg.height : PHYSICS_CONFIG.brickHeight;
      radius = Math.max(radius, Math.hypot(width, height) * 0.62);
    } else if (peg.type === 'bumper') {
      radius = Math.max(radius, PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1) * 5);
    }
    this.queueBackgroundEvent({
      kind: 'bombTargetSplash',
      x: peg.x,
      y: peg.y,
      radius,
      speed: Number.isFinite(sourceBall?.vx) || Number.isFinite(sourceBall?.vy)
        ? Utils.magnitude(sourceBall?.vx || 0, sourceBall?.vy || 0)
        : 0
    });
  }

  queueLiquidPegSplash(peg, impact) {
    if (!peg || !impact) return;
    if (peg.type === 'obstacle' || this.isPortalPeg(peg) || this.isPermanentBumper(peg)) return;

    const isOrange = this.isOrangePeg(peg);
    const isBumper = peg.type === 'bumper';
    const speed = Number.isFinite(impact.speed) ? impact.speed : Utils.magnitude(impact.vx || 0, impact.vy || 0);

    this.queueBackgroundEvent({
      kind: 'pegSplash',
      x: peg.x,
      y: peg.y,
      radius: isOrange ? 72 : (isBumper ? 42 : 56),
      strength: isOrange ? 1.06 : (isBumper ? 0.48 : 0.76),
      burst: isOrange ? 1.42 : (isBumper ? 0.76 : 1.04),
      swirl: isOrange ? 0.76 : (isBumper ? 0.24 : 0.42),
      spread: isOrange ? 1.65 : (isBumper ? 0.92 : 1.18),
      speed,
      normalX: Number.isFinite(impact.normalX) ? impact.normalX : 0,
      normalY: Number.isFinite(impact.normalY) ? impact.normalY : -1
    });
  }

  launch() {
    if (this.isEndSequenceActive()) return;
    if (this.state !== 'aiming' && this.state !== 'confirmAim') return;
    if (Number.isFinite(this.ballsLeft) && this.ballsLeft <= 0) return;
    const survivalMode = this.isSurvivalMode();
    const hadActiveSurvivalBalls = survivalMode && this.hasActiveBalls();
    const launchBalls = survivalMode
      ? [this.ensureSurvivalLauncherBall()].filter(Boolean)
      : this.balls;
    if (launchBalls.length === 0) return;

    const ultraAimLaunch = this.armUltraAimForLaunch();
    if (!this.baseFlipperConfig && !this.temporaryFlipperActive && this.temporaryFlipperTurns > 0) {
      this.temporaryFlipperTurns--;
      this.temporaryFlipperActive = true;
      this.refreshFlipperState();
    }
    if (!ultraAimLaunch) {
      this.armBombPerkForLaunch();
      this.armDeepFreezeForLaunch();
    }

    this.state = 'playing';
    initAudio();
    resetHitCounter();
    lightTap();
    for (const ball of launchBalls) {
      ball.launch(this.aimAngle);
      ball.isLauncherBall = false;
      ball.ultraAimStuck = false;
      ball.ultraAimQteBall = false;
      this.configureBallYoyoState(ball, { suppressPerkBinding: ultraAimLaunch });
      if (ball.yoyoEligible !== false) {
        this.yoyoThread.registerBallLaunch(ball, this.launchX, this.launchY);
        this.consumeYoyoPerkUseOnBind(ball);
      }
    }
    if (!hadActiveSurvivalBalls) {
      this.turnHitPegIds = [];
      this.resetStuckBallTracking();
      this._turnBucketCatchCount = 0;
    }
    this.shotsFired += 1;
    this.survivalShotCooldownRemainingMs = survivalMode ? this.survivalAntiCooldownMs : 0;

    if (Number.isFinite(this.ballsLeft)) {
      this.ballsLeft--;
      this.emitUiStateIfChanged(true, 'launch');
    } else if (survivalMode) {
      this.emitUiStateIfChanged(true, 'survival-launch');
    }
    this.trajectory = null;
    this.emitGameplayEvent('shot_launched', {
      shotsFired: this.shotsFired,
      ballsLeft: this.ballsLeft,
      survivalMode
    });
  }

  isOrangePeg(p) {
    return p.type === 'orange' || (p.type === 'bumper' && p.bumperOrange);
  }

  isPortalPeg(p) {
    return !!p && isPortalType(p.type);
  }

  getOrangePegsLeft() {
    const allHitIds = [...this.hitPegIds, ...this.turnHitPegIds];
    const hitSet = new Set(allHitIds);
    return this.pegs.filter(p => this.isOrangePeg(p) && !hitSet.has(p.id)).length;
  }

  getTotalOrangePegs() {
    return this.pegs.filter(p => this.isOrangePeg(p)).length;
  }

  calculateScore(peg) {
    if (peg.type === 'obstacle' || this.isPortalPeg(peg)) return 0;
    // Permanent bumpers don't score; orange bumpers score as orange; disappear bumpers as blue
    if (peg.type === 'bumper') {
      if (peg.bumperOrange) return SCORE.orange;
      if (peg.bumperDisappear) return SCORE.blue;
      return 0;
    }
    
    const baseScore = SCORE[peg.type] || SCORE.blue;
    
    // Multiplier based on orange pegs remaining
    const orangeLeft = this.isSurvivalMode()
      ? this.getSurvivalTargetsLeft(true)
      : this.getOrangePegsLeft();
    let multiplier = 1;
    for (const [threshold, mult] of Object.entries(SCORE.multiplier)) {
      if (orangeLeft <= parseInt(threshold)) {
        multiplier = mult;
      }
    }

    return baseScore * multiplier;
  }

  isPermanentBumper(peg) {
    return !!(peg && peg.type === 'bumper' && !peg.bumperDisappear && !peg.bumperOrange);
  }

  hasPegBeenActivated(pegId) {
    if (!pegId) return false;
    return this.turnHitPegIds.includes(pegId) || this.hitPegIds.includes(pegId);
  }

  scheduleHitPegClear(peg) {
    if (!this.hitPegTimedClearEnabled) return;
    if (!peg || !peg.id) return;
    if (peg.type === 'obstacle' || this.isPermanentBumper(peg) || this.isPortalPeg(peg)) return;
    const delay = Math.max(0, this.hitPegClearDelayMs || 0);
    this.pendingHitPegClears.set(peg.id, this.levelElapsedMs + delay);
  }

  isPegTimedClearEligible(peg) {
    if (!peg) return false;
    if (peg.type === 'obstacle' || this.isPortalPeg(peg)) return false;
    if (this.isPermanentBumper(peg)) return false;
    return this.hasPegBeenActivated(peg.id);
  }

  processTimedHitPegClears() {
    if (!this.hitPegTimedClearEnabled) return false;
    if (!this.pendingHitPegClears || this.pendingHitPegClears.size === 0) return false;

    const dueIds = new Set();
    for (const [pegId, clearAtMs] of this.pendingHitPegClears) {
      if (clearAtMs <= this.levelElapsedMs) dueIds.add(pegId);
    }
    if (dueIds.size === 0) return false;

    let removed = false;
    const removedPegs = [];
    this.pegs = this.pegs.filter(peg => {
      if (!dueIds.has(peg.id)) return true;
      this.pendingHitPegClears.delete(peg.id);
      if (!this.isPegTimedClearEligible(peg)) return true;
      if (this.isOrangePeg(peg)) {
        this.removedOrangePegs++;
      }
      removedPegs.push(peg);
      removed = true;
      return false;
    });

    for (const id of dueIds) {
      this.pendingHitPegClears.delete(id);
    }
    if (!removed) return false;

    this.renderer.queuePegExitAnimations?.(removedPegs);
    this.physics.setPegs(this.pegs);
    this.syncPhysicsHitPegState();
    this.emitUiStateIfChanged(true, 'timed-hit-peg-clear');
    return true;
  }

  activatePeg(peg, sourceBall = null, options = null) {
    if (!peg || this.isPortalPeg(peg)) return false;
    if (peg.type === 'bumper') {
      peg._bumperHitScale = 1.3;
    }

    if (peg.type === 'obstacle' || this.isPermanentBumper(peg)) {
      return false;
    }
    if (this.hasPegBeenActivated(peg.id)) {
      return false;
    }

    const points = this.calculateScore(peg);
    this.score += points;
    this.turnHitPegIds.push(peg.id);
    this.noteBallPegContact(sourceBall, peg);
    if (this.physics?.hitPegs && typeof this.physics.hitPegs.add === 'function') {
      this.physics.hitPegs.add(peg.id);
    }
    this.scheduleHitPegClear(peg);
    if (this.isOrangePeg(peg)) {
      const targetsLeft = this.isSurvivalMode()
        ? this.getSurvivalTargetsLeft(true)
        : this.getOrangePegsLeft();
      if (targetsLeft === 0) {
        this.queueVictoryShockwave(peg, sourceBall);
        this._startLastPegSlowmo();
        this._queuePendingEndResult('won', { readyToResolve: this.isSurvivalMode() });
        if (!this._levelClearEmitted) {
          this._levelClearEmitted = true;
          this.emitGameplayEvent('level_clear', {
            result: 'won',
            score: this.score,
            shotsFired: this.shotsFired,
            atLastPeg: true
          });
        }
      }
    }

    pegHitSound();

    if (this.onPegHit) this.onPegHit(peg, points);
    this.emitGameplayEvent('peg_hit', {
      pegId: peg.id,
      pegType: peg.type,
      points,
      turnHitCount: this.turnHitPegIds.length,
      orangePegsLeft: this.isSurvivalMode()
        ? this.getSurvivalTargetsLeft(true)
        : this.getOrangePegsLeft()
    });
    if (this.onScoreChange) this.onScoreChange(this.score);

    const allowMultiball = options?.allowMultiball !== false;
    if (allowMultiball && peg.type === 'multi' && sourceBall) {
      const spawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
      this.spawnMultiballs(sourceBall, spawnCount);
    }
    if (this.isSurvivalMode() && peg.type === 'gamble') {
      const gamblePeg = normalizeSurvivalGamblePegProperties(peg, this.survivalRuntime.getGamblePegSettings());
      this.grantSurvivalGambleBalls(gamblePeg.gambleBallCount);
      if (gamblePeg.gambleKnockbackEnabled) {
        this.survivalRuntime.applyGambleKnockback(
          gamblePeg.gambleKnockbackDistance,
          gamblePeg.gambleKnockbackSmoothMs
        );
      }
    }

    return true;
  }

  triggerPegViaDeepFreeze(peg, sourceBall = null) {
    if (!peg || this.isPortalPeg(peg)) return;
    this.animator.suspendPeg(peg.id);

    if (peg.type === 'bumper') {
      peg._bumperHitScale = 1.3;
    }

    if (peg.type === 'obstacle') {
      this.animator.notifyHit(peg.id);
      return;
    }

    this.activatePeg(peg, sourceBall, { allowMultiball: true });
    this.animator.notifyHit(peg.id);
  }

  endTurn() {
    if (this._pendingEndResult?.result === 'won' && this._pendingEndResult.readyToResolve) {
      this._maybeFinalizePendingEndResult();
      if (this.state === 'won') return;
    }

    const endedTurnHitCount = this.turnHitPegIds.length;
    const endedTurnBucketCatchCount = this._turnBucketCatchCount || 0;
    const emitBallLostReaction = () => {
      if (endedTurnBucketCatchCount > 0) return;
      const eventType = endedTurnHitCount >= 4 ? 'ball_lost_after_streak' : 'ball_lost_clean';
      this.emitGameplayEvent(eventType, {
        turnHitCount: endedTurnHitCount,
        ballsLeft: this.ballsLeft,
        shotsFired: this.shotsFired
      });
    };

    this.yoyoThread.clear();
    this.clearDynamicYoyoAnchors();
    this.finishDeepFreezeShot();
    this.resetUltraAimRuntime();

    if (!this.baseFlipperConfig && this.temporaryFlipperActive) {
      this.temporaryFlipperActive = false;
      this.refreshFlipperState();
    }

    // Add turn hit pegs to total hit pegs (they disappear now)
    this.hitPegIds = [...this.hitPegIds, ...this.turnHitPegIds];
    for (const id of this.turnHitPegIds) {
      this.pendingHitPegClears.delete(id);
    }

    // Count orange pegs about to be removed (for health bar tracking)
    const hitSet = new Set(this.hitPegIds);
    for (const p of this.pegs) {
      if (hitSet.has(p.id) && this.isOrangePeg(p)) {
        this.removedOrangePegs++;
      }
    }

    // Remove hit pegs from pegs array (they're gone)
    // Obstacles and permanent bumpers stay
    const removedPegs = [];
    this.pegs = this.pegs.filter(p => {
      if (p.type === 'obstacle') return true;
      if (this.isPortalPeg(p)) return true;
      if (p.type === 'bumper' && !p.bumperDisappear && !p.bumperOrange) return true;
      if (!hitSet.has(p.id)) return true;
      removedPegs.push(p);
      return false;
    });
    this.renderer.queuePegExitAnimations?.(removedPegs);
    this.physics.setPegs(this.pegs);
    this.syncPhysicsHitPegState();

    if (this.isSurvivalMode()) {
      if (this.getSurvivalTargetsLeft(true) === 0) {
        this._queuePendingEndResult('won', { readyToResolve: true });
        if (this._maybeFinalizePendingEndResult()) return;
      }

      emitBallLostReaction();
      const preserveAim = this.isAimingState() && !!this.getLauncherBall();
      this.hitPegIds = [];
      this.turnHitPegIds = [];
      this.resetStuckBallTracking();
      this.survivalShotCooldownRemainingMs = 0;
      if (preserveAim) {
        this.state = 'aiming';
        this.ensureSurvivalLauncherBall();
        this.updateTrajectory();
        this.emitUiStateIfChanged(true, 'survival-turn-ended');
      } else {
        this.state = 'idle';
        this.resetBall();
      }
      return;
    }
    
    // Check win condition
    if (this.getOrangePegsLeft() === 0) {
      this._queuePendingEndResult('won', { readyToResolve: true });
      if (this._maybeFinalizePendingEndResult()) return;
      return;
    }

    emitBallLostReaction();

    // Check lose condition (bucket catches already credited in onPhysicsUpdate)
    if (this.ballsLeft <= 0) {
      this._finalizeEndState('lost');
      return;
    }

    // Reset for next turn
    this.state = 'idle';
    this.hitPegIds = []; // Clear since they're removed
    this.resetBall();
  }

  spawnMultiballs(sourceBall, count = MULTIBALL_DEFAULT_SPAWN_COUNT) {
    if (!sourceBall) return;
    const spawnCount = normalizeMultiballSpawnCount(count);

    const speed = Math.max(Utils.magnitude(sourceBall.vx, sourceBall.vy), PHYSICS_CONFIG.launchPower * 0.8);
    const baseAngle = Math.atan2(sourceBall.vy, sourceBall.vx);
    const spread = Math.PI / 2; // 90 degrees

    for (let i = 0; i < spawnCount; i++) {
      const t = spawnCount === 1 ? 0.5 : i / (spawnCount - 1);
      const angle = baseAngle - spread / 2 + t * spread;
      const newBall = new Ball(sourceBall.x, sourceBall.y);
      newBall.x += Math.cos(angle) * newBall.radius * 0.4;
      newBall.y += Math.sin(angle) * newBall.radius * 0.4;
      newBall.launch(angle, speed);
      newBall.yoyoEligible = false;
      newBall.yoyoPerkBound = false;
      this.physics.addBall(newBall);
    }
    this.balls = this.physics.balls;
  }

  updateSurvivalShotCooldown(dt) {
    if (!this.isSurvivalMode()) return;
    if (this.state !== 'playing') return;
    if (this.survivalAntiCooldownMs <= 0) return;
    if (!this.hasActiveBalls()) return;

    this.survivalShotCooldownRemainingMs = Math.max(
      0,
      this.survivalShotCooldownRemainingMs - dt * 1000
    );
    if (this.survivalShotCooldownRemainingMs > 0) return;

    this.state = 'idle';
    this.ensureSurvivalLauncherBall();
    this.emitUiStateIfChanged(true, 'survival-shot-ready');
  }

  updateLauncherBallAnimations(dt) {
    if (!Array.isArray(this.balls)) return;
    const step = Math.max(0, dt) / 0.22;
    for (const ball of this.balls) {
      if (!ball || ball.active || !ball.isLauncherBall) continue;
      const current = Number.isFinite(ball.launcherSpawnAnim) ? ball.launcherSpawnAnim : 1;
      ball.launcherSpawnAnim = Math.min(1, current + step);
    }
  }

  getLauncherBallScale() {
    const launcher = this.getLauncherBall();
    if (!launcher) return 1;
    const t = Math.max(0, Math.min(1, Number.isFinite(launcher.launcherSpawnAnim) ? launcher.launcherSpawnAnim : 1));
    const eased = 1 - Math.pow(1 - t, 3);
    return 0.22 + eased * 0.78;
  }

  update(deltaTime) {
    // Animate pegs continuously (idle, aiming, playing) so the level feels alive
    const dt = Math.min((deltaTime || 16.67) / 1000, 0.1);
    this.levelElapsedMs += dt * 1000;
    if (this.bucketCatchLight > 0) {
      this.bucketCatchLight = Math.max(0, this.bucketCatchLight - dt * 2.6);
    }
    this.updatePortalPulses(dt);
    const worldHeight = this.isSurvivalMode() ? this.survivalRuntime.getWorldHeight() : this.canvas.height;
    this.animator.tick(this.pegs, dt, { width: this.canvas.width, height: worldHeight });
    if (this.deepFreezeSystem.isActive()) {
      this.deepFreezeSystem.syncPegPositions(this.pegs, this.animator.getAnimatedPegIds());
    }
    this.physics.markPegGridDirty();
    this.updateUltraAimQte(dt);

    if (this.isSurvivalMode()) {
      this.survivalRuntime.update(this.survivalGambleOverlayOpen ? dt / 5 : dt);
    }
    this.updateLaunchPosition();
    this.syncPhysicsViewportBounds();
    this.syncSurvivalFlipperAnchor();
    this.updateSurvivalShotCooldown(dt);
    this.updateLauncherBallAnimations(dt);
    const retractStartY = this.physics.bucketEnabled && this.physics.bucket
      ? this.physics.bucket.y - this.physics.bucket.height / 2 - getBallRadius() - 24
      : this.physics.ballLossY - Math.max(60, this.canvas.height * 0.12);

    if (this.debugDrag.enabled) {
      // Debug mode: manual ball drag, no gravity/integration step.
      this.physics.updateBucket(dt);
      this.physics.updateFlippers(dt);
      const debugBall = this.ensureDebugDragBall();
      if (!this.debugDrag.dragging) {
        debugBall.vx = 0;
        debugBall.vy = 0;
      }
      this.syncDynamicYoyoAnchors();
      const yoyoReleaseEvents = this.yoyoThread.step(this.balls, this.pegs, dt, { retractStartY });
      this.applyYoyoReleaseEvents(yoyoReleaseEvents);
      return;
    }

    const runsPhysics = this.state === 'playing' || (this.isSurvivalMode() && this.hasActiveBalls());
    if (!runsPhysics) {
      this.yoyoThread.clear();
      this.clearDynamicYoyoAnchors();
      const launcherBall = this.getLauncherBall();
      if (launcherBall) {
        launcherBall.x = this.launchX;
        launcherBall.y = this.launchY;
      } else if (this.balls.length === 1 && !this.balls[0].active) {
        this.balls[0].x = this.launchX;
        this.balls[0].y = this.launchY;
      }
      // Keep bucket moving even while idle/aiming
      this.physics.updateBucket(dt);
      // Keep flippers at rest position when not playing
      this.physics.updateFlippers(dt);
      // Recalculate trajectory every frame during aiming so it reflects
      // animated peg positions in real-time (not just on mouse move)
      if (this.isAimingState()) {
        this.updateTrajectory();
      }
      this.processTimedHitPegClears();
      this.checkSurvivalEndConditions();
      return;
    }

    // Update flippers before physics so collision uses current position
    this.physics.updateFlippers(dt);

    const result = this.physics.update(dt);
    this.balls = this.physics.balls;
    if (this.deepFreezeSystem.isActive()) {
      for (const contact of result.contactEvents) {
        if (this.deepFreezeSystem.applyBallImpact(contact.peg, contact.ball, contact.impact)) {
          this.animator.suspendPeg(contact.peg?.id);
        }
      }
    }
    const bombContact = this.consumeBombPerkOnFirstContact(result.contactEvents);
    let capturedUltraAimBallId = null;
    let capturedUltraAimPegId = null;
    if (this.ultraAimShotActive && !this.isUltraAimQteActive()) {
      const captureEvent = result.hitEvents.find(event => {
        if (!event || event.portalHit || event.bumperAnimOnly) return false;
        return this.isUltraAimStickyEligiblePeg(event.peg);
      });
      if (captureEvent && this.engageUltraAimQte(captureEvent)) {
        capturedUltraAimBallId = captureEvent.ball?.id || null;
        capturedUltraAimPegId = captureEvent.peg?.id || null;
      }
    }

    // Handle newly hit pegs
    for (const event of result.hitEvents) {
      const peg = event.peg;
      if (!peg) continue;
      const isCapturedUltraAimHit = capturedUltraAimBallId
        && capturedUltraAimPegId
        && event.ball?.id === capturedUltraAimBallId
        && peg.id === capturedUltraAimPegId;
      if (isCapturedUltraAimHit) {
        continue;
      }
      if (this.isUltraAimQteActive() && peg.id === this.ultraAimQte.pegId) {
        continue;
      }
      this.yoyoThread.notePegContact(event.ball, peg);

      // Portal teleport: notify animator and yoyo thread, no peg activation
      if (event.portalHit) {
        this.triggerPortalPulse(event.peg);
        if (event.portalExit) {
          this.triggerPortalPulse(event.portalExit);
          this.yoyoThread.notePortalTeleport(event.ball, event.peg, event.portalExit);
        }
        this.animator.notifyHit(peg.id);
        continue;
      }
      // Bumper collision: trigger scale-pulse animation (fires every hit)
      if (event.bumperAnimOnly) {
        peg._bumperHitScale = 1.3;
        this.animator.notifyHit(peg.id);
        continue;
      }
      // Obstacle (grey peg): permanent, just notify animator
      if (event.obstacleHit) {
        this.animator.notifyHit(peg.id);
        continue;
      }
      const activated = this.activatePeg(peg, event.ball, { allowMultiball: true });
      if (activated) {
        this.queueLiquidPegSplash(peg, event.impact);
      }
      // Notify animator for hit-triggered animations
      this.animator.notifyHit(peg.id);
    }
    for (const contact of result.contactEvents || []) {
      this.noteBallPegContact(contact.ball, contact.peg);
    }
    if (bombContact) {
      this.detonateBombShockwave(bombContact.ball, bombContact.peg);
    }
    if (this.deepFreezeSystem.isActive()) {
      const chainEvents = this.deepFreezeSystem.step(this.pegs, dt, {
        width: this.canvas.width,
        height: worldHeight
      });
      for (const event of chainEvents) {
        if (event.suspendSource) {
          this.animator.suspendPeg(event.sourcePeg?.id);
        }
        this.triggerPegViaDeepFreeze(event.targetPeg, event.sourceBall);
      }
    }
    this.syncDynamicYoyoAnchors();
    const yoyoReleaseEvents = this.yoyoThread.step(this.balls, this.pegs, dt, { retractStartY });
    this.applyYoyoReleaseEvents(yoyoReleaseEvents);

    // Animate bumper hit scale decay
    for (const peg of this.pegs) {
      if (peg._bumperHitScale && peg._bumperHitScale > 1.001) {
        peg._bumperHitScale = 1 + (peg._bumperHitScale - 1) * 0.85;
        if (peg._bumperHitScale < 1.005) peg._bumperHitScale = 1;
      }
    }

    // Check for stuck balls trapped inside structures
    this.checkStuckBalls();
    this.processTimedHitPegClears();

    if (this.checkSurvivalEndConditions()) {
      return;
    }

    // Credit bucket catches immediately so the ball counter updates in real time
    if (result.bucketCatchCount > 0) {
      this.ballsLeft += result.bucketCatchCount;
      this._turnBucketCatchCount += result.bucketCatchCount;
      this.bucketCatchLight = Math.min(1, this.bucketCatchLight + 0.72 + Math.max(0, result.bucketCatchCount - 1) * 0.18);
      this.emitUiStateIfChanged(true, 'bucket-catch');
      this.emitGameplayEvent('bucket_catch', {
        count: result.bucketCatchCount,
        ballsLeft: this.ballsLeft
      });
    }

    // End turn when all balls are gone
    if (result.ballsRemaining === 0) {
      this.endTurn();
    }

    this.checkSurvivalEndConditions();
  }

  checkStuckBalls() {
    if (this.isUltraAimQteActive()) return;
    if (this.balls.length === 0 || this.turnHitPegIds.length === 0) return;
    const activeBalls = this.balls.filter(ball => ball && ball.active);
    if (activeBalls.length === 0) return;
    this.ensureStuckBallTrackingStores();

    const now = performance.now();
    const activeBallIds = new Set();
    for (const ball of activeBalls) {
      if (ball.id) activeBallIds.add(ball.id);
    }
    for (const ballId of [...this.ballPositionHistories.keys()]) {
      if (!activeBallIds.has(ballId)) this.ballPositionHistories.delete(ballId);
    }
    for (const ballId of [...this.ballContactPegIds.keys()]) {
      if (!activeBallIds.has(ballId)) this.ballContactPegIds.delete(ballId);
    }

    const releasedPegIds = new Set();
    for (const ball of activeBalls) {
      if (!ball.id) continue;
      let history = this.ballPositionHistories.get(ball.id);
      if (!history) {
        history = [];
        this.ballPositionHistories.set(ball.id, history);
      }

      // Sample every ~150ms per ball
      const lastT = history.length > 0 ? history[history.length - 1].t : 0;
      if (now - lastT < 150) continue;

      history.push({ x: ball.x, y: ball.y, t: now });

      // Remove samples older than 3 seconds
      const cutoff = now - 3000;
      while (history.length > 0 && history[0].t < cutoff) {
        history.shift();
      }

      // Need at least 2.5 seconds of data
      if (history.length < 2) continue;
      if (now - history[0].t < 2500) continue;

      const bounds = this.getStuckBallHistoryBounds(history, ball);
      if (bounds && bounds.maxX - bounds.minX < 180 && bounds.maxY - bounds.minY < 180) {
        const releasedPeg = this.releaseStuckBall(ball, history, releasedPegIds);
        if (releasedPeg) releasedPegIds.add(releasedPeg.id);
      }
    }
  }

  ensureStuckBallTrackingStores() {
    if (!(this.ballPositionHistories instanceof Map)) this.ballPositionHistories = new Map();
    if (!(this.ballContactPegIds instanceof Map)) this.ballContactPegIds = new Map();
    if (!Array.isArray(this.ballPositionHistory)) this.ballPositionHistory = [];
  }

  resetStuckBallTracking() {
    this.ballPositionHistory = [];
    this.ballPositionHistories = new Map();
    this.ballContactPegIds = new Map();
  }

  noteBallPegContact(ball, peg) {
    if (!ball?.id || !peg?.id) return;
    if (!this.turnHitPegIds.includes(peg.id)) return;
    this.ensureStuckBallTrackingStores();
    let pegIds = this.ballContactPegIds.get(ball.id);
    if (!pegIds) {
      pegIds = new Set();
      this.ballContactPegIds.set(ball.id, pegIds);
    }
    pegIds.add(peg.id);
  }

  getStuckBallHistoryBounds(history, ball = null) {
    if (!Array.isArray(history) || history.length === 0) {
      if (!ball || !Number.isFinite(ball.x) || !Number.isFinite(ball.y)) return null;
      return {
        minX: ball.x,
        maxX: ball.x,
        minY: ball.y,
        maxY: ball.y,
        centerX: ball.x,
        centerY: ball.y
      };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pos of history) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    return {
      minX,
      maxX,
      minY,
      maxY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2
    };
  }

  isPegNearStuckBallHistory(peg, bounds) {
    if (!peg || !bounds) return false;
    const marginX = 90;
    const marginAbove = 90;
    const marginBelow = 240;
    return peg.x >= bounds.minX - marginX
      && peg.x <= bounds.maxX + marginX
      && peg.y >= bounds.minY - marginAbove
      && peg.y <= bounds.maxY + marginBelow;
  }

  getStuckReleaseCandidates(ball = null, history = null, excludedPegIds = null) {
    const hitSet = new Set(this.turnHitPegIds);
    const excluded = excludedPegIds instanceof Set ? excludedPegIds : new Set();
    const isEligible = peg => {
      if (!peg || excluded.has(peg.id)) return false;
      if (!hitSet.has(peg.id)) return false;
      if (peg.type === 'obstacle' || this.isPortalPeg(peg) || this.isPermanentBumper(peg)) return false;
      return true;
    };

    const ballId = ball?.id || null;
    const touchedPegIds = ballId ? this.ballContactPegIds.get(ballId) : null;
    const touchedGroupIds = new Set();
    const touchedBezierGroupIds = new Set();
    if (touchedPegIds && touchedPegIds.size > 0) {
      for (const peg of this.pegs) {
        if (!touchedPegIds.has(peg.id)) continue;
        if (peg.groupId != null) touchedGroupIds.add(peg.groupId);
        if (peg.bezierGroupId != null) touchedBezierGroupIds.add(peg.bezierGroupId);
      }
    }

    let candidates = [];
    if (touchedPegIds && touchedPegIds.size > 0) {
      candidates = this.pegs.filter(peg => {
        if (!isEligible(peg)) return false;
        if (touchedPegIds.has(peg.id)) return true;
        if (peg.groupId != null && touchedGroupIds.has(peg.groupId)) return true;
        if (peg.bezierGroupId != null && touchedBezierGroupIds.has(peg.bezierGroupId)) return true;
        return false;
      });
    }

    const bounds = this.getStuckBallHistoryBounds(history, ball);
    if (candidates.length === 0 && bounds) {
      candidates = this.pegs.filter(peg => isEligible(peg) && this.isPegNearStuckBallHistory(peg, bounds));
    }

    if (candidates.length === 0) {
      candidates = this.pegs.filter(isEligible);
    }
    return candidates;
  }

  releaseStuckBall(ball = null, history = null, excludedPegIds = null) {
    // Find the lowest (highest canvas y) hit peg for this stuck ball to create an exit
    const candidates = this.getStuckReleaseCandidates(ball, history, excludedPegIds);
    let lowestPeg = null;
    let lowestY = -Infinity;

    for (const peg of candidates) {
      if (peg.y > lowestY) {
        lowestY = peg.y;
        lowestPeg = peg;
      }
    }

    if (!lowestPeg) return null;

    // Track orange peg removal for health bar
    if (this.isOrangePeg(lowestPeg)) this.removedOrangePegs++;

    // Remove the peg from play immediately so the ball can escape
    this.renderer.queuePegExitAnimations?.([lowestPeg]);
    this.pegs = this.pegs.filter(p => p.id !== lowestPeg.id);
    this.physics.setPegs(this.pegs);
    this.syncPhysicsHitPegState();

    // Reset this ball's history — if still stuck, detection re-triggers after another 2.5s
    if (ball?.id) {
      this.ballPositionHistories.delete(ball.id);
      this.ballContactPegIds.delete(ball.id);
    } else {
      this.resetStuckBallTracking();
    }
    this.ballPositionHistory = [];
    return lowestPeg;
  }

  render() {
    const allHitIds = [...this.hitPegIds, ...this.turnHitPegIds];
    const ultraAimQteActive = this.isUltraAimQteActive();
    const qteTrajectory = ultraAimQteActive ? this.ultraAimQte.trajectory : null;
    const snapshot = this.getUiStateSnapshot();
    const survivalMode = this.isSurvivalMode();
    const worldHeight = survivalMode ? this.survivalRuntime.getWorldHeight() : this.canvas.height;
    const totalTargets = snapshot.totalOrangePegs;
    const targetsLeft = snapshot.orangePegsLeft;
    const pegProgress = totalTargets > 0
      ? Math.max(0, Math.min(1, (totalTargets - targetsLeft) / totalTargets))
      : 0;
    let trackerState = survivalMode ? this.survivalRuntime.getTrackerState() : null;
    const endStateActive = survivalMode
      && (!!this._pendingEndResult || this.state === 'won' || this.state === 'lost');
    if (endStateActive) {
      if (!this._frozenSurvivalTrackerState && trackerState) {
        this._frozenSurvivalTrackerState = { ...trackerState };
      }
      trackerState = this._frozenSurvivalTrackerState || trackerState;
    } else {
      this._frozenSurvivalTrackerState = null;
    }
    const boardProgress = survivalMode ? (trackerState?.progressRatio ?? 0) : pegProgress;
    const centerLabel = survivalMode
      ? `PEGS ${Math.max(0, totalTargets - targetsLeft)}/${totalTargets}`
      : null;
    const cameraY = this.getCameraY();
    this.syncSurvivalFlipperAnchor();

    this.renderer.renderGame({
      pegs: this.pegs,
      hitPegIds: allHitIds,
      wrapCopyPegIds: this.animator.getAnimatedPegIds(),
      balls: this.balls,
      bucket: survivalMode ? null : this.physics.bucket,
      flippers: this.flippers,
      cameraY,
      showLauncher: this.state === 'idle' || this.isAimingState(),
      launchX: this.launchX,
      launchY: this.launchY,
      launcherBallScale: this.getLauncherBallScale(),
      aimAngle: this.aimAngle,
      showAim: this.isAimingState(),
      showQteAim: ultraAimQteActive,
      qteAimX: ultraAimQteActive ? this.ultraAimQte.anchorX : 0,
      qteAimY: ultraAimQteActive ? this.ultraAimQte.anchorY : 0,
      qteAimAngle: ultraAimQteActive ? this.ultraAimQte.angle : ULTRA_AIM_V2_START_ANGLE,
      trajectoryStyle: ultraAimQteActive ? 'qte' : 'default',
      trajectory: qteTrajectory || (this.isAimingState() ? this.trajectory : null),
      showFullTrajectory: ultraAimQteActive ? false : this.shouldShowFullTrajectory(),
      aimLength: this.aimLength,
      yoyoThreads: this.yoyoThread.getRenderThreads(),
      score: this.score,
      ballsLeft: this.ballsLeft,
      bucketFlash: this.bucketCatchLight,
      orangePegsLeft: targetsLeft,
      totalOrangePegs: totalTargets,
      levelProgress: boardProgress,
      pegProgress,
      liquidWorldOffset: survivalMode ? (cameraY / Math.max(1, this.canvas.height)) : 0,
      worldHeight,
      survivalBackground: survivalMode ? this.survivalRuntime.getBackground() : null,
      backgroundFxId: this.levelFxId,
      backgroundEvents: this.backgroundEvents,
      playState: this.state,
      renderTimeSeconds: this.renderTimeSeconds,
      renderDeltaSeconds: this.renderDeltaSeconds,
      frameDeltaSeconds: this.rawFrameDeltaSeconds,
      centerLabel,
      survivalLoseLineY: survivalMode ? this.survivalRuntime.getLoseLineY() : null,
      verticalProgress: trackerState,
      message: this.state === 'won' ? 'Уровень пройден' : (this.state === 'lost' ? 'Игра окончена' : null),
      subMessage: this.state === 'won' ? 'Продолжить' : (this.state === 'lost' ? 'Продолжить' : null)
    });
    this.backgroundEvents = [];

    // Draw FPS overlay only when enabled (editor play mode)
    if (this.showPerfOverlay) this._drawPerfOverlay();
  }

  _drawPerfOverlay() {
    const ctx = this.renderer?.ctx;
    if (!ctx) return;
    const updateMs = this._perfUpdateMs || 0;
    const renderMs = this._perfRenderMs || 0;
    const frameMs = this._perfFrameMs || 16.67;
    const fps = (1000 / frameMs).toFixed(0);
    const steps = this._perfPhysicsSteps || 0;

    ctx.save();
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, this.canvas.height - 42, 180, 42);
    ctx.fillStyle = '#0f0';
    ctx.fillText(`FPS: ${fps}  delta: ${frameMs.toFixed(1)}ms`, 4, this.canvas.height - 40);
    ctx.fillText(`update: ${updateMs.toFixed(2)}ms  render: ${renderMs.toFixed(2)}ms`, 4, this.canvas.height - 28);
    ctx.fillText(`steps: ${steps}  pegs: ${this.pegs.length}  state: ${this.state}`, 4, this.canvas.height - 16);
    ctx.restore();
  }

  _deriveMaxFrameSteps(stepMs = this.fixedStepMs) {
    const target = Math.round(100 / Math.max(1, stepMs));
    return Math.max(8, Math.min(12, target));
  }

  _sampleRaf(deltaMs) {
    if (this._simOverrideHz) return;
    if (!Number.isFinite(deltaMs)) return;
    if (deltaMs < 5 || deltaMs > 50) return;

    this._rafSamples.push(deltaMs);
    if (this._rafSamples.length > this._rafSampleSize) {
      this._rafSamples.shift();
    }
    // Collect samples for diagnostics only — do NOT mutate fixedStepMs.
    // Physics always runs at 120 steps/sec; the accumulator handles variable frame rates.
  }

  _resetPerformanceCap30Detection(options = {}) {
    this._performanceCap30Samples = [];
    if (!options.preserveEmitted) {
      this._performanceCap30Emitted = false;
    }
  }

  _isPerformanceCap30Eligible() {
    if (this.isEndSequenceActive()) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  _trackPerformanceCap30(now, frameMs, workMs) {
    if (this._performanceCap30Emitted) return;
    if (!this._isPerformanceCap30Eligible()) {
      this._resetPerformanceCap30Detection({ preserveEmitted: true });
      return;
    }
    if (!Number.isFinite(now) || !Number.isFinite(frameMs) || !Number.isFinite(workMs) || frameMs < 20 || frameMs > 45) {
      this._resetPerformanceCap30Detection({ preserveEmitted: true });
      return;
    }

    this._performanceCap30Samples.push({ now, frameMs, workMs });
    const cutoff = now - PERFORMANCE_CAP30_WINDOW_MS;
    while (this._performanceCap30Samples.length > 0 && this._performanceCap30Samples[0].now < cutoff) {
      this._performanceCap30Samples.shift();
    }

    if (this._performanceCap30Samples.length < PERFORMANCE_CAP30_MIN_SAMPLE_COUNT) return;

    const firstSample = this._performanceCap30Samples[0];
    const lastSample = this._performanceCap30Samples[this._performanceCap30Samples.length - 1];
    const windowMs = lastSample.now - firstSample.now;
    if (windowMs < PERFORMANCE_CAP30_MIN_WINDOW_MS) return;

    const frameValues = this._performanceCap30Samples
      .map(sample => sample.frameMs)
      .sort((a, b) => a - b);
    const workValues = this._performanceCap30Samples
      .map(sample => sample.workMs)
      .sort((a, b) => a - b);
    const medianFrameMs = percentileFromSorted(frameValues, 0.5);
    const frameSpanMs = percentileFromSorted(frameValues, 0.9) - percentileFromSorted(frameValues, 0.1);
    const medianWorkMs = percentileFromSorted(workValues, 0.5);

    if (medianFrameMs < PERFORMANCE_CAP30_FRAME_MIN_MS || medianFrameMs > PERFORMANCE_CAP30_FRAME_MAX_MS) return;
    if (frameSpanMs > PERFORMANCE_CAP30_STABILITY_SPAN_MS) return;
    if (medianWorkMs > Math.min(PERFORMANCE_CAP30_MAX_WORK_MS, medianFrameMs * PERFORMANCE_CAP30_MAX_WORK_RATIO)) return;

    this._performanceCap30Emitted = true;
    this.renderer?.setPerformanceProfile?.('lite');
    this.emitPerformanceEvent('performanceCap30', {
      detected: true,
      performanceProfile: 'lite',
      averageFps: average(frameValues) > 0 ? 1000 / average(frameValues) : 0,
      medianFrameMs,
      frameSpanMs,
      medianWorkMs,
      sampleCount: this._performanceCap30Samples.length,
      windowMs
    });
  }

  gameLoop(currentTime) {
    if (this._stopped || this.abortController.signal.aborted) return;
    const now = Number.isFinite(currentTime) ? currentTime : performance.now();
    const hadLastTime = Number.isFinite(this.lastTime) && this.lastTime !== 0;
    let deltaMs = this.fixedStepMs;
    if (hadLastTime) {
      deltaMs = now - this.lastTime;
    }
    this.lastTime = now;

    if (hadLastTime) {
      this._sampleRaf(deltaMs);
    }

    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      deltaMs = this.fixedStepMs;
    }
    if (this.maxFrameDeltaMs && deltaMs > this.maxFrameDeltaMs) {
      deltaMs = this.maxFrameDeltaMs;
    }
    const timeScale = this._resolveTimeScale(deltaMs);
    const scaledDeltaMs = deltaMs * timeScale;
    this.rawFrameDeltaSeconds = deltaMs / 1000;
    this.renderDeltaSeconds = scaledDeltaMs / 1000;
    this.renderTimeSeconds += this.renderDeltaSeconds;
    this._maybeFinalizePendingEndResult();

    const _t0 = performance.now();

    const useFixedStep = this.state === 'playing';
    let physicsSteps = 0;
    if (useFixedStep) {
      const maxAccum = this.fixedStepMs * this.maxFrameSteps;
      this.accumulatorMs = Math.min(this.accumulatorMs + scaledDeltaMs, maxAccum);

      while (this.accumulatorMs >= this.fixedStepMs && physicsSteps < this.maxFrameSteps) {
        this.update(this.fixedStepMs);
        this.accumulatorMs -= this.fixedStepMs;
        physicsSteps++;
      }
    } else {
      this.accumulatorMs = 0;
      this.update(scaledDeltaMs);
    }

    const _t1 = performance.now();

    this.emitUiStateIfChanged();
    this.render();

    const _t2 = performance.now();

    // --- Performance diagnostics ---
    this._perfUpdateMs = _t1 - _t0;
    this._perfRenderMs = _t2 - _t1;
    this._perfFrameMs = deltaMs;
    this._perfPhysicsSteps = physicsSteps;
    this._trackPerformanceCap30(now, deltaMs, this._perfUpdateMs + this._perfRenderMs);
    if (!this._perfLog) this._perfLog = { frames: 0, nextDump: now + 2000 };
    this._perfLog.frames++;
    if (now >= this._perfLog.nextDump) {
      const elapsed = now - (this._perfLog.nextDump - 2000);
      const fps = (this._perfLog.frames / elapsed * 1000).toFixed(1);
      const ctx = this.renderer?.ctx;
      const ctxAttrs = ctx?.canvas ? `${ctx.canvas.width}x${ctx.canvas.height} css:${ctx.canvas.style.width}x${ctx.canvas.style.height}` : '?';
      console.log(
        `[PERF] fps=${fps} rafDelta=${deltaMs.toFixed(1)}ms update=${this._perfUpdateMs.toFixed(2)}ms render=${this._perfRenderMs.toFixed(2)}ms ` +
        `physSteps=${physicsSteps} pegs=${this.pegs.length} balls=${this.balls.length} state=${this.state} ` +
        `canvas=${ctxAttrs} fixedStep=${this.fixedStepMs.toFixed(2)}ms`
      );
      this._perfLog.frames = 0;
      this._perfLog.nextDump = now + 2000;
    }

    if (this._stopped || this._paused || this.abortController.signal.aborted) {
      this.animationId = null;
      return;
    }
    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  start() {
    if (this.animationId) return;
    if (this._stopped) return;
    this._paused = false;
    this.accumulatorMs = 0;
    this.lastTime = performance.now();
    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  stop() {
    this._stopped = true;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this._paused = false;
    this.accumulatorMs = 0;
    this._resetPerformanceCap30Detection({ preserveEmitted: true });
    this.uiStateListeners.clear();
    this.performanceEventListeners.clear();
    this.gameplayEventListeners.clear();
    this.abortController.abort();
    this.renderer?.dispose?.();
  }

  pause() {
    if (!this.animationId || this._paused) return;
    cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this._paused = true;
    this._resetPerformanceCap30Detection({ preserveEmitted: true });
  }

  resume() {
    if (!this._paused || this._stopped || this.abortController.signal.aborted) return;
    this._paused = false;
    this.accumulatorMs = 0;
    this._resetPerformanceCap30Detection({ preserveEmitted: true });
    this.lastTime = performance.now();
    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  isPaused() {
    return !!this._paused;
  }

  resize(width, height) {
    this.renderer.resize(width, height);
    this.physics.resize(width, height);
    this.survivalRuntime.resize(height);
    this.yoyoThread.resize(width, height);
    this.updateLaunchPosition();
    this.syncPhysicsViewportBounds(height);
    if (!this.baseFlipperConfig && this.temporaryFlipperActive) {
      this.refreshFlipperState();
    }
  }

  setShowFullTrajectory(show) {
    const next = !!show;
    if (this.showFullTrajectory === next) return;
    this.showFullTrajectory = next;
    this.emitUiStateIfChanged(true, 'show-full-trajectory');
    if (this.isAimingState()) {
      this.updateTrajectory();
    }
  }

  setAimLength(steps) {
    this.aimLength = Math.max(0, Math.min(300, Math.round(steps)));
    if (this.isAimingState()) {
      this.updateTrajectory();
    }
  }

  setHitPegClearDelay(delayMs) {
    this.hitPegClearDelayMs = normalizeHitPegClearDelayMs(delayMs);
    return this.hitPegClearDelayMs;
  }

  setHitPegTimedClearEnabled(enabled) {
    this.hitPegTimedClearEnabled = !!enabled;
    if (!this.hitPegTimedClearEnabled) {
      this.pendingHitPegClears.clear();
    }
    return this.hitPegTimedClearEnabled;
  }

  setEndSequenceConfig(config) {
    this.endSequenceConfig = normalizeEndSequenceConfig(config);
    return this.endSequenceConfig;
  }

  setGambleOverlayOpen(open) {
    this.survivalGambleOverlayOpen = !!open;
  }

  grantSurvivalGambleBalls(amount = SURVIVAL_GAMBLE_BALLS_PER_PEG) {
    const gain = Math.max(0, Math.floor(Number(amount) || 0));
    if (gain <= 0) return this.gambleBalls;
    this.gambleBalls = Math.min(999, this.gambleBalls + gain);
    this.initialGambleBallCount = Math.max(this.initialGambleBallCount, this.gambleBalls);
    this.emitUiStateIfChanged(true, 'survival-gamble-balls-granted');
    return this.gambleBalls;
  }

  getGambleAutoLuckRatio() {
    if (this.isSurvivalMode()) {
      const tracker = this.survivalRuntime.getTrackerState();
      const progress = Number(tracker?.progressRatio);
      return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    }

    const startingBalls = this.initialBallCount;
    const ballsLeft = this.ballsLeft;
    if (!Number.isFinite(startingBalls) || startingBalls <= 0) return 0;
    if (!Number.isFinite(ballsLeft)) return 0;
    const spent = Math.max(0, startingBalls - Math.max(0, ballsLeft));
    return Math.max(0, Math.min(1, spent / startingBalls));
  }

  canGamble(ballCost = 1) {
    const cost = Math.max(1, Math.floor(ballCost));
    if (!(this.state === 'idle' || this.state === 'aiming')) return false;
    if (this.isSurvivalMode()) {
      return this.gambleBalls >= cost;
    }
    if (!Number.isFinite(this.ballsLeft)) return false;
    return this.ballsLeft > cost;
  }

  hasShotInCurrentLevel() {
    return this.shotsFired > 0 || (this.isSurvivalMode() && this.gambleBalls > 0);
  }

  spendBallsForGamble(ballCost = 1) {
    if (!this.canGamble(ballCost)) return false;
    const cost = Math.max(1, Math.floor(ballCost));
    if (this.isSurvivalMode()) {
      this.gambleBalls = Math.max(0, this.gambleBalls - cost);
      this.emitUiStateIfChanged(true, 'survival-gamble-spin-spent');
      return true;
    }
    this.ballsLeft -= cost;
    this.emitUiStateIfChanged(true, 'gamble-spin-spent');
    return true;
  }

  convertRandomPegsToMultiball(targetCount = 3) {
    const count = Math.max(1, Math.floor(targetCount));
    const blocked = this.getActiveHitPegIdSet();
    const candidates = this.pegs.filter(peg => {
      if (blocked.has(peg.id)) return false;
      if (this.isOrangePeg(peg)) return false;
      if (this.isPortalPeg(peg)) return false;
      if (peg.type === 'obstacle' || peg.type === 'bumper' || peg.type === 'multi' || peg.type === 'gamble') return false;
      return true;
    });

    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const converted = Math.min(count, candidates.length);
    for (let i = 0; i < converted; i++) {
      candidates[i].type = 'multi';
      candidates[i].multiballSpawnCount = MULTIBALL_DEFAULT_SPAWN_COUNT;
    }
    if (converted > 0) {
      this.physics.setPegs(this.pegs);
    }
    return converted;
  }

  grantBombShockwaveCharges(charges = 1) {
    const gain = Math.max(1, Math.floor(charges));
    this.queuedBombPerkCharges = Math.min(99, this.queuedBombPerkCharges + gain);
    this.emitUiStateIfChanged(true, 'bomb-perk-granted');
    return this.getBombPerkChargeCount();
  }

  grantDeepFreezeShots(shots = 1) {
    const gain = Math.max(1, Math.floor(shots));
    this.queuedDeepFreezeShots = Math.min(99, this.queuedDeepFreezeShots + gain);
    return this.queuedDeepFreezeShots;
  }

  grantYoyoThreadUses(uses = 1) {
    if (this.baseYoyoSettings && this.baseYoyoSettings.enabled) return 0;
    const gain = Math.max(1, Math.floor(uses));
    this.yoyoPerkUsesRemaining = Math.min(99, this.yoyoPerkUsesRemaining + gain);
    this.refreshYoyoThreadRuntimeConfig();
    this.emitUiStateIfChanged(true, 'yoyo-perk-granted');
    return this.yoyoPerkUsesRemaining;
  }

  grantUltraAim(charges = 1) {
    const gain = Math.max(1, Math.floor(charges));
    this.ultraAimV2Charges = Math.min(99, this.ultraAimV2Charges + gain);
    return this.ultraAimV2Charges;
  }

  // Legacy Ultra Aim 1.0 kept intentionally as dead code/reference.
  shouldShowFullTrajectoryLegacy() {
    return this.showFullTrajectory || this.ultraAimCharges > 0;
  }

  consumeUltraAimLegacyChargeOnLaunch() {
    if (this.showFullTrajectory || this.ultraAimCharges <= 0) return this.ultraAimCharges;
    this.ultraAimCharges = Math.max(0, this.ultraAimCharges - 1);
    return this.ultraAimCharges;
  }

  grantUltraAimLegacy(charges = 1) {
    const gain = Math.max(1, Math.floor(charges));
    this.ultraAimCharges = Math.min(99, this.ultraAimCharges + gain);
    return this.ultraAimCharges;
  }

  grantTemporaryFlippers(turns = 1) {
    if (this.baseFlipperConfig) return 0;
    const gain = Math.max(1, Math.floor(turns));
    this.temporaryFlipperTurns = Math.min(20, this.temporaryFlipperTurns + gain);

    // If player activates perk while idle/aiming, enable immediately.
    if (!this.temporaryFlipperActive && (this.state === 'idle' || this.isAimingState())) {
      this.temporaryFlipperActive = true;
      this.temporaryFlipperTurns = Math.max(0, this.temporaryFlipperTurns - 1);
      this.refreshFlipperState();
    }

    return (this.temporaryFlipperActive ? 1 : 0) + this.temporaryFlipperTurns;
  }

  // Allow clicking to restart after game end
  handleRestart() {
    if (this.state === 'won' || this.state === 'lost') {
      return true; // Signal that restart is needed
    }
    return false;
  }

  getEndOverlayInteractDelayMs() {
    return this.renderer?.getEndOverlayInteractDelayMs?.() ?? 360;
  }

  dismissEndOverlay(onComplete) {
    const callback = typeof onComplete === 'function' ? onComplete : null;
    const dismissed = this.renderer?.dismissEndOverlay?.(callback);
    if (dismissed) {
      this.suppressInputFor(this.renderer?.getEndOverlayFadeOutMs?.() ?? 220);
      return true;
    }
    if (callback) callback();
    return false;
  }
}
