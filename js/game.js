// Peggle Game - Game loop and mechanics

import { Ball, PhysicsEngine, PHYSICS_CONFIG, getBallRadius } from './physics.js';
import { Renderer } from './renderer.js';
import { Utils } from './utils.js';
import { PegAnimator } from './animation.js';
import { SurvivalRuntime } from './survival-runtime.js';
import { createDefaultFlipperConfig, normalizeFlipperConfig } from './flipper-defaults.js';
import { YoyoThreadSystem, normalizeYoyoSettings } from './yoyo-thread.js';
import { buildBombShockwave } from './perk-bomb.js';
import {
  MULTIBALL_DEFAULT_SPAWN_COUNT,
  normalizeMultiballSpawnCount
} from './multiball-settings.js';
import {
  countSurvivalTargets,
  ensureLevelSurvival
} from './survival-mode.js';

// Score values
const SCORE = {
  orange: 100,
  blue: 10,
  green: 50,
  purple: 500,
  multi: 50,
  multiplier: {
    25: 1,
    20: 2,
    15: 3,
    10: 5,
    5: 10,
    0: 100
  }
};

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.physics = new PhysicsEngine(canvas.width, canvas.height);
    
    // Game state
    this.state = 'idle'; // idle, aiming, playing, won, lost
    this.pegs = [];
    this.balls = [];
    this.score = 0;
    this.ballsLeft = 10;
    this.hitPegIds = [];
    this.turnHitPegIds = [];
    this.totalSurvivalTargets = 0;
    this.initialBallCount = 10;

    // Flippers
    this.flippers = null;
    this.baseFlipperConfig = null;
    this.temporaryFlipperTurns = 0;
    this.temporaryFlipperActive = false;

    // Stuck ball detection
    this.ballPositionHistory = [];

    // Peg animation
    this.animator = new PegAnimator();

    // Launch state
    this.launchX = canvas.width / 2;
    this.launchY = 40;
    this.aimAngle = Math.PI / 2;

    // Survival mode runtime (camera + scrolling)
    this.survivalRuntime = new SurvivalRuntime(canvas.height, { autoScroll: true });
    this.yoyoThread = new YoyoThreadSystem(canvas.width, canvas.height);
    this.baseYoyoSettings = normalizeYoyoSettings(null);
    this.yoyoPerkUsesRemaining = 0;
    this.debugDrag = {
      enabled: false,
      dragging: false
    };
    
    // Trajectory preview
    this.trajectory = null;
    this.showFullTrajectory = false;
    this.ultraAimCharges = 0;
    this.queuedBombPerkCharges = 0;
    this.armedBombPerk = false;
    
    // Animation
    this.animationId = null;
    this.lastTime = 0;
    
    // Callbacks
    this.onGameEnd = null;
    this.onScoreChange = null;
    this.onPegHit = null;
    this.uiStateListeners = new Set();
    this.lastUiStateSignature = '';
    
    // Listener cleanup
    this.abortController = new AbortController();

    // Input handling
    this.setupInput();
  }

  setupInput() {
    const canvas = this.canvas;
    const sig = { signal: this.abortController.signal };

    // Touch/Mouse handling for aiming
    const handleStart = (e) => {
      if (this._handleDebugDragStart(e)) return;
      if (this.state === 'won' || this.state === 'lost') {
        // Restart handling
        return;
      }
      if (this.state !== 'idle') return;
      e.preventDefault();
      this.state = 'aiming';
      this.updateAim(e);
    };

    const handleMove = (e) => {
      if (this._handleDebugDragMove(e)) return;
      if (!this.isAimingState()) return;
      e.preventDefault();
      this.updateAim(e);
    };

    const handleEnd = (e) => {
      if (this._handleDebugDragEnd(e)) return;
      if (!this.isAimingState()) return;
      e.preventDefault();
      this.launch();
    };

    // Touch events
    canvas.addEventListener('touchstart', handleStart, { passive: false, ...sig });
    canvas.addEventListener('touchmove', handleMove, { passive: false, ...sig });
    canvas.addEventListener('touchend', handleEnd, { passive: false, ...sig });

    // Mouse events
    canvas.addEventListener('mousedown', handleStart, sig);
    canvas.addEventListener('mousemove', (e) => {
      if (this.isAimingState() || this.debugDrag.dragging) handleMove(e);
    }, sig);
    canvas.addEventListener('mouseup', handleEnd, sig);

    // Flipper activation — spacebar anytime, click/tap during playing
    const handleFlip = () => {
      if (this.debugDrag.enabled) return;
      if (!this.flippers) return;
      if (this.state === 'won' || this.state === 'lost') return;
      this.flippers._flipperActivated = true;
    };
    const handleFlipEnd = () => {
      if (this.debugDrag.enabled) return;
      if (!this.flippers) return;
      this.flippers._flipperActivated = false;
    };

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); handleFlip(); }
    }, sig);
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') handleFlipEnd();
    }, sig);

    canvas.addEventListener('mousedown', (e) => {
      if (this.debugDrag.enabled) return;
      if (this.state === 'playing') handleFlip();
    }, sig);
    canvas.addEventListener('mouseup', (e) => {
      if (this.debugDrag.enabled) return;
      if (this.state === 'playing') handleFlipEnd();
    }, sig);
    canvas.addEventListener('touchstart', (e) => {
      if (this.debugDrag.enabled) return;
      if (this.state === 'playing') { e.preventDefault(); handleFlip(); }
    }, { passive: false, ...sig });
    canvas.addEventListener('touchend', (e) => {
      if (this.debugDrag.enabled) return;
      if (this.state === 'playing') handleFlipEnd();
    }, sig);
  }

  getUiStateSnapshot() {
    return {
      state: this.state,
      ballsLeft: this.ballsLeft,
      initialBallCount: this.initialBallCount,
      showFullTrajectory: !!this.showFullTrajectory
    };
  }

  getUiStateSignature() {
    const snapshot = this.getUiStateSnapshot();
    return `${snapshot.state}|${snapshot.ballsLeft}|${snapshot.initialBallCount}|${snapshot.showFullTrajectory ? 1 : 0}`;
  }

  subscribeUiState(listener) {
    if (typeof listener !== 'function') return () => {};
    this.uiStateListeners.add(listener);
    listener(this.getUiStateSnapshot(), 'subscribe');
    return () => {
      this.uiStateListeners.delete(listener);
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

  isAimingState() {
    return this.state === 'aiming';
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
    if (this.state === 'won' || this.state === 'lost') return false;

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
    const x = pos.x;
    const y = pos.y;

    // Calculate angle from launcher to touch point
    this.aimAngle = Utils.angleBetween(this.launchX, this.launchY, x, y);
    
    // Clamp to downward angles only
    if (this.aimAngle < 0) {
      this.aimAngle = Math.max(this.aimAngle, -Math.PI + 0.15);
    } else {
      this.aimAngle = Math.min(this.aimAngle, Math.PI - 0.15);
    }
    
    // Update trajectory prediction
    this.updateTrajectory();
  }

  updateTrajectory() {
    const showFull = this.shouldShowFullTrajectory();
    this.trajectory = this.physics.predictTrajectory(
      this.launchX,
      this.launchY,
      this.aimAngle,
      PHYSICS_CONFIG.launchPower,
      showFull ? 1000 : 300,
      !showFull
    );
  }

  shouldShowFullTrajectory() {
    return this.showFullTrajectory || this.ultraAimCharges > 0;
  }

  isSurvivalMode() {
    return this.survivalRuntime.isEnabled();
  }

  getCameraY() {
    return this.survivalRuntime.getCameraY();
  }

  updateLaunchPosition() {
    this.launchX = this.canvas.width / 2;
    this.launchY = 40 + this.getCameraY();
  }

  refreshYoyoThreadRuntimeConfig() {
    const base = this.baseYoyoSettings || normalizeYoyoSettings(null);
    const enabledByPerk = this.yoyoPerkUsesRemaining > 0;
    this.yoyoThread.configure({
      ...base,
      enabled: !!base.enabled || enabledByPerk
    });
  }

  configureBallYoyoState(ball) {
    if (!ball) return;
    if (this.baseYoyoSettings && this.baseYoyoSettings.enabled) {
      ball.yoyoEligible = true;
      ball.yoyoPerkBound = false;
      return;
    }
    if (this.yoyoPerkUsesRemaining > 0) {
      ball.yoyoEligible = true;
      ball.yoyoPerkBound = true;
      return;
    }
    ball.yoyoEligible = false;
    ball.yoyoPerkBound = false;
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
    if (this.baseYoyoSettings && this.baseYoyoSettings.enabled) return;

    let consumed = 0;
    for (const ballId of releaseEvents) {
      if (this.yoyoPerkUsesRemaining <= 0) break;
      const ball = this.balls.find(item => item && item.id === ballId);
      if (!ball || !ball.yoyoPerkBound) continue;

      this.yoyoPerkUsesRemaining = Math.max(0, this.yoyoPerkUsesRemaining - 1);
      consumed++;
      if (this.yoyoPerkUsesRemaining <= 0) {
        this.disablePerkYoyoAcrossBalls();
        break;
      }
    }

    if (consumed > 0) {
      this.refreshYoyoThreadRuntimeConfig();
      this.emitUiStateIfChanged(true, 'yoyo-perk-consumed');
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
    if (!Array.isArray(shockwave.targets) || shockwave.targets.length === 0) return 0;

    let activatedCount = 0;
    for (const peg of shockwave.targets) {
      if (this.activatePeg(peg, sourceBall, { allowMultiball: true })) {
        activatedCount++;
      }
    }
    return activatedCount;
  }

  createRuntimeFlipper(config) {
    return {
      ...config,
      enabled: true,
      _flipperT: 0,
      _flipperActivated: false,
      _angularDelta: 0
    };
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
      this.physics.setFlippers(this.flippers);
    } else {
      this.flippers = null;
      this.physics.setFlippers(null);
    }
  }

  getActiveHitPegIdSet() {
    return new Set([...this.hitPegIds, ...this.turnHitPegIds]);
  }

  getSurvivalTargetsLeft(includePendingHits = true) {
    if (!this.isSurvivalMode()) return this.getOrangePegsLeft();
    const excluded = includePendingHits ? this.getActiveHitPegIdSet() : null;
    return countSurvivalTargets(this.pegs, excluded);
  }

  checkSurvivalEndConditions() {
    if (!this.isSurvivalMode()) return false;
    if (this.state === 'won' || this.state === 'lost') return true;

    const hitSet = this.getActiveHitPegIdSet();
    for (const peg of this.pegs) {
      if (hitSet.has(peg.id)) continue;
      if (this.survivalRuntime.isPegBeyondLoseLine(peg, PHYSICS_CONFIG.pegRadius)) {
        this.state = 'lost';
        if (this.onGameEnd) this.onGameEnd('lost', this.score);
        return true;
      }
    }

    if (this.getSurvivalTargetsLeft(true) === 0) {
      this.state = 'won';
      if (this.onGameEnd) this.onGameEnd('won', this.score);
      return true;
    }

    return false;
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
      this.updateLaunchPosition();
      this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
      this.resetBall();
      return;
    }

    // Leave debug mode with a clean regular turn state.
    this.state = 'idle';
    this.yoyoThread.clear();
    this.resetBall();
  }

  loadLevel(levelData) {
    const survivalSettings = ensureLevelSurvival(levelData, this.canvas.height);
    const yoyoSettings = normalizeYoyoSettings(levelData.yoyo);
    this.survivalRuntime.resize(this.canvas.height);
    this.survivalRuntime.configure(survivalSettings);
    this.survivalRuntime.resetCamera(true);
    this.yoyoPerkUsesRemaining = 0;
    this.queuedBombPerkCharges = 0;
    this.armedBombPerk = false;
    this.applyYoyoSettings(yoyoSettings, { skipReset: true });

    this.pegs = levelData.pegs.map(p => {
      const copy = { ...p };
      if (copy.type === 'multi') {
        copy.multiballSpawnCount = normalizeMultiballSpawnCount(copy.multiballSpawnCount);
      }
      if (p.curveSlices) copy.curveSlices = p.curveSlices.map(s => ({ ...s }));
      if (p.animation) copy.animation = { ...p.animation };
      return copy;
    });
    this.physics.setPegs(this.pegs);
    this.animator.loadFromLevel(this.pegs, levelData.groups || []);

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
    this.physics.setBallLossY(this.getCameraY() + this.canvas.height + 50);

    this.score = 0;
    this.ballsLeft = this.isSurvivalMode() ? Number.POSITIVE_INFINITY : 10;
    this.initialBallCount = Number.isFinite(this.ballsLeft) ? this.ballsLeft : 10;
    this.hitPegIds = [];
    this.turnHitPegIds = [];
    this.totalSurvivalTargets = this.isSurvivalMode() ? countSurvivalTargets(this.pegs) : 0;
    this.state = 'idle';
    this.trajectory = null;
    this.ultraAimCharges = 0;
    this.queuedBombPerkCharges = 0;
    this.armedBombPerk = false;
    this.lastUiStateSignature = '';

    this.updateLaunchPosition();
    this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
    this.resetBall();
  }

  resetBall() {
    this.updateLaunchPosition();
    this.yoyoThread.clear();
    this.yoyoThread.setLaunchAnchor(this.launchX, this.launchY);
    this.balls = [new Ball(this.launchX, this.launchY)];
    this.physics.setBalls(this.balls);
    this.balls = this.physics.balls;
    this.turnHitPegIds = [];
    this.physics.clearHitPegs();
    
    // Re-add previously hit pegs to physics tracking
    for (const id of this.hitPegIds) {
      this.physics.hitPegs.add(id);
    }
  }

  launch() {
    if (!this.isAimingState()) return;
    if (Number.isFinite(this.ballsLeft) && this.ballsLeft <= 0) return;

    if (!this.showFullTrajectory && this.ultraAimCharges > 0) {
      this.ultraAimCharges--;
    }
    if (!this.baseFlipperConfig && !this.temporaryFlipperActive && this.temporaryFlipperTurns > 0) {
      this.temporaryFlipperTurns--;
      this.temporaryFlipperActive = true;
      this.refreshFlipperState();
    }
    this.armBombPerkForLaunch();

    this.state = 'playing';
    for (const ball of this.balls) {
      ball.launch(this.aimAngle);
      this.configureBallYoyoState(ball);
      if (ball.yoyoEligible !== false) {
        this.yoyoThread.registerBallLaunch(ball, this.launchX, this.launchY);
      }
    }
    this.turnHitPegIds = [];
    this.ballPositionHistory = [];

    if (Number.isFinite(this.ballsLeft)) {
      this.ballsLeft--;
      this.emitUiStateIfChanged(true, 'launch');
    }
    this.trajectory = null;
  }

  isOrangePeg(p) {
    return p.type === 'orange' || (p.type === 'bumper' && p.bumperOrange);
  }

  isPortalPeg(p) {
    return p.type === 'portalBlue' || p.type === 'portalOrange';
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
    if (this.physics?.hitPegs && typeof this.physics.hitPegs.add === 'function') {
      this.physics.hitPegs.add(peg.id);
    }

    if (this.onPegHit) this.onPegHit(peg, points);
    if (this.onScoreChange) this.onScoreChange(this.score);

    const allowMultiball = options?.allowMultiball !== false;
    if (allowMultiball && peg.type === 'multi' && sourceBall) {
      const spawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
      this.spawnMultiballs(sourceBall, spawnCount);
    }

    return true;
  }

  endTurn() {
    this.yoyoThread.clear();

    if (!this.baseFlipperConfig && this.temporaryFlipperActive) {
      this.temporaryFlipperActive = false;
      this.refreshFlipperState();
    }

    // Add turn hit pegs to total hit pegs (they disappear now)
    this.hitPegIds = [...this.hitPegIds, ...this.turnHitPegIds];
    
    // Remove hit pegs from pegs array (they're gone)
    // Obstacles and permanent bumpers stay
    const hitSet = new Set(this.hitPegIds);
    this.pegs = this.pegs.filter(p => {
      if (p.type === 'obstacle') return true;
      if (this.isPortalPeg(p)) return true;
      if (p.type === 'bumper' && !p.bumperDisappear && !p.bumperOrange) return true;
      return !hitSet.has(p.id);
    });
    this.physics.setPegs(this.pegs);

    if (this.isSurvivalMode()) {
      if (this.getSurvivalTargetsLeft(true) === 0) {
        this.state = 'won';
        if (this.onGameEnd) this.onGameEnd('won', this.score);
        return;
      }

      this.state = 'idle';
      this.hitPegIds = [];
      this.resetBall();
      return;
    }
    
    // Check win condition
    if (this.getOrangePegsLeft() === 0) {
      this.state = 'won';
      if (this.onGameEnd) this.onGameEnd('won', this.score);
      return;
    }

    // Check lose condition (bucket catches already credited in onPhysicsUpdate)
    if (this.ballsLeft <= 0) {
      this.state = 'lost';
      if (this.onGameEnd) this.onGameEnd('lost', this.score);
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

  update(deltaTime) {
    // Animate pegs continuously (idle, aiming, playing) so the level feels alive
    const dt = Math.min((deltaTime || 16.67) / 1000, 0.1);
    const worldHeight = this.isSurvivalMode() ? this.survivalRuntime.getWorldHeight() : this.canvas.height;
    this.animator.tick(this.pegs, dt, { width: this.canvas.width, height: worldHeight });

    if (this.isSurvivalMode()) {
      this.survivalRuntime.update(dt);
    }
    this.updateLaunchPosition();
    this.physics.setBallLossY(this.getCameraY() + this.canvas.height + 50);
    const retractStartY = this.physics.bucketEnabled && this.physics.bucket
      ? this.physics.bucket.y - this.physics.bucket.height / 2 - getBallRadius() - 24
      : this.physics.ballLossY - Math.max(60, this.canvas.height * 0.12);

    if (this.debugDrag.enabled) {
      // Debug mode: manual ball drag, no gravity/integration step.
      this.physics.updateBucket();
      this.physics.updateFlippers(dt);
      const debugBall = this.ensureDebugDragBall();
      if (!this.debugDrag.dragging) {
        debugBall.vx = 0;
        debugBall.vy = 0;
      }
      const yoyoReleaseEvents = this.yoyoThread.step(this.balls, this.pegs, dt, { retractStartY });
      this.applyYoyoReleaseEvents(yoyoReleaseEvents);
      return;
    }

    const runsPhysics = this.state === 'playing';
    if (!runsPhysics) {
      this.yoyoThread.clear();
      if (this.balls.length === 1 && !this.balls[0].active) {
        this.balls[0].x = this.launchX;
        this.balls[0].y = this.launchY;
      }
      // Keep bucket moving even while idle/aiming
      this.physics.updateBucket();
      // Keep flippers at rest position when not playing
      this.physics.updateFlippers(dt);
      // Recalculate trajectory every frame during aiming so it reflects
      // animated peg positions in real-time (not just on mouse move)
      if (this.isAimingState()) {
        this.updateTrajectory();
      }
      this.checkSurvivalEndConditions();
      return;
    }

    // Update flippers before physics so collision uses current position
    this.physics.updateFlippers(dt);

    const result = this.physics.update();
    this.balls = this.physics.balls;
    const bombContact = this.consumeBombPerkOnFirstContact(result.contactEvents);

    // Handle newly hit pegs
    for (const event of result.hitEvents) {
      const peg = event.peg;
      this.yoyoThread.notePegContact(event.ball, peg);

      // Bumper collision: trigger scale-pulse animation (fires every hit)
      if (event.bumperAnimOnly) {
        peg._bumperHitScale = 1.3;
        continue;
      }
      this.activatePeg(peg, event.ball, { allowMultiball: true });
    }
    if (bombContact) {
      this.detonateBombShockwave(bombContact.ball, bombContact.peg);
    }
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

    if (this.checkSurvivalEndConditions()) {
      return;
    }

    // Credit bucket catches immediately so the ball counter updates in real time
    if (result.bucketCatchCount > 0) {
      this.ballsLeft += result.bucketCatchCount;
      this.emitUiStateIfChanged(true, 'bucket-catch');
    }

    // End turn when all balls are gone
    if (result.ballsRemaining === 0) {
      this.endTurn();
    }

    this.checkSurvivalEndConditions();
  }

  checkStuckBalls() {
    if (this.balls.length === 0 || this.turnHitPegIds.length === 0) return;

    const now = performance.now();

    // Sample every ~150ms
    const lastT = this.ballPositionHistory.length > 0
      ? this.ballPositionHistory[this.ballPositionHistory.length - 1].t
      : 0;
    if (now - lastT < 150) return;

    // Average position of all active balls
    let avgX = 0, avgY = 0;
    for (const ball of this.balls) {
      avgX += ball.x;
      avgY += ball.y;
    }
    avgX /= this.balls.length;
    avgY /= this.balls.length;

    this.ballPositionHistory.push({ x: avgX, y: avgY, t: now });

    // Remove samples older than 3 seconds
    const cutoff = now - 3000;
    while (this.ballPositionHistory.length > 0 && this.ballPositionHistory[0].t < cutoff) {
      this.ballPositionHistory.shift();
    }

    // Need at least 2.5 seconds of data
    if (this.ballPositionHistory.length < 2) return;
    if (now - this.ballPositionHistory[0].t < 2500) return;

    // Check if balls are confined to a small area
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pos of this.ballPositionHistory) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    if (maxX - minX < 180 && maxY - minY < 180) {
      this.releaseStuckBall();
    }
  }

  releaseStuckBall() {
    // Find the lowest (highest canvas y) hit peg to create an exit
    const hitSet = new Set(this.turnHitPegIds);
    let lowestPeg = null;
    let lowestY = -Infinity;

    for (const peg of this.pegs) {
      if (hitSet.has(peg.id) && peg.type !== 'obstacle') {
        if (peg.y > lowestY) {
          lowestY = peg.y;
          lowestPeg = peg;
        }
      }
    }

    if (!lowestPeg) return;

    // Remove the peg from play immediately so the ball can escape
    this.pegs = this.pegs.filter(p => p.id !== lowestPeg.id);
    this.physics.setPegs(this.pegs);

    // Reset history — if still stuck, detection re-triggers after another 2.5s
    this.ballPositionHistory = [];
  }

  render() {
    const allHitIds = [...this.hitPegIds, ...this.turnHitPegIds];
    const survivalMode = this.isSurvivalMode();
    const survivalTargetsLeft = this.getSurvivalTargetsLeft(true);
    const totalTargets = survivalMode ? this.totalSurvivalTargets : this.getTotalOrangePegs();
    const trackerState = survivalMode ? this.survivalRuntime.getTrackerState() : null;
    const centerLabel = survivalMode
      ? `PEGS ${Math.max(0, totalTargets - survivalTargetsLeft)}/${totalTargets}`
      : null;

    this.renderer.renderGame({
      pegs: this.pegs,
      hitPegIds: allHitIds,
      wrapCopyPegIds: this.animator.getAnimatedPegIds(),
      balls: this.balls,
      bucket: survivalMode ? null : this.physics.bucket,
      flippers: this.flippers,
      cameraY: this.getCameraY(),
      showLauncher: this.state === 'idle' || this.isAimingState(),
      launchX: this.launchX,
      launchY: this.launchY,
      aimAngle: this.aimAngle,
      showAim: this.isAimingState(),
      trajectory: this.isAimingState() ? this.trajectory : null,
      showFullTrajectory: this.shouldShowFullTrajectory(),
      yoyoThreads: this.yoyoThread.getRenderThreads(),
      score: this.score,
      ballsLeft: this.ballsLeft,
      orangePegsLeft: survivalMode ? survivalTargetsLeft : this.getOrangePegsLeft(),
      totalOrangePegs: totalTargets,
      centerLabel,
      survivalLoseLineY: survivalMode ? this.survivalRuntime.getLoseLineY() : null,
      verticalProgress: trackerState,
      message: this.state === 'won' ? 'YOU WIN!' : (this.state === 'lost' ? 'GAME OVER' : null),
      subMessage: this.state === 'won' || this.state === 'lost' ? 'Tap to continue' : null
    });
  }

  gameLoop(currentTime) {
    const deltaTime = currentTime - this.lastTime;
    this.lastTime = currentTime;

    this.update(deltaTime);
    this.emitUiStateIfChanged();
    this.render();

    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  start() {
    if (this.animationId) return;
    this.lastTime = performance.now();
    this.animationId = requestAnimationFrame((t) => this.gameLoop(t));
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.abortController.abort();
  }

  resize(width, height) {
    this.renderer.resize(width, height);
    this.physics.resize(width, height);
    this.survivalRuntime.resize(height);
    this.yoyoThread.resize(width, height);
    this.updateLaunchPosition();
    this.physics.setBallLossY(this.getCameraY() + height + 50);
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

  canGamble(ballCost = 1) {
    if (!Number.isFinite(this.ballsLeft)) return false;
    const cost = Math.max(1, Math.floor(ballCost));
    if (!(this.state === 'idle' || this.state === 'aiming')) return false;
    return this.ballsLeft > cost;
  }

  spendBallsForGamble(ballCost = 1) {
    if (!this.canGamble(ballCost)) return false;
    const cost = Math.max(1, Math.floor(ballCost));
    this.ballsLeft -= cost;
    return true;
  }

  convertRandomPegsToMultiball(targetCount = 3) {
    const count = Math.max(1, Math.floor(targetCount));
    const blocked = this.getActiveHitPegIdSet();
    const candidates = this.pegs.filter(peg => {
      if (blocked.has(peg.id)) return false;
      if (this.isOrangePeg(peg)) return false;
      if (this.isPortalPeg(peg)) return false;
      if (peg.type === 'obstacle' || peg.type === 'bumper' || peg.type === 'multi') return false;
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
    this.ultraAimCharges = Math.min(99, this.ultraAimCharges + gain);
    if (this.isAimingState()) {
      this.updateTrajectory();
    }
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
}
