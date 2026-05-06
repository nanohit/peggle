import { Renderer } from './renderer.js';
import { Ball, PhysicsEngine, PHYSICS_CONFIG, getBallRadius } from './physics.js';
import { Utils } from './utils.js';
import { initAudio, lightTap, pegHitSound, resetHitCounter } from './haptics.js';
import {
  ensureLevelPvp,
  getPvpMidline,
  getPvpRuntimePegs,
  normalizePvpSettings
} from './pvp-mode.js';
import { isPortalType } from './portal-defaults.js';

const MATCH_HP = 3;
const MAX_ROUND_SECONDS = 18;
const FALLBACK_TARGET_RADIUS = 56;
const AIM_ANGLE_EPSILON = 0.0015;
const ROUND_END_DELAY_MS = 550;

function hashString(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mirrorPegForLocalPhysics(peg, height) {
  const mirrored = clone(peg);
  mirrored.y = height - Number(peg.y || 0);
  mirrored.angle = -Number(peg.angle || 0);
  if (Array.isArray(mirrored.curveSlices)) {
    mirrored.curveSlices = mirrored.curveSlices.map(slice => ({
      ...slice,
      y: Number.isFinite(slice.y) ? height - slice.y : slice.y,
      ny: Number.isFinite(slice.ny) ? -slice.ny : slice.ny
    })).reverse();
  }
  if (mirrored.animation && typeof mirrored.animation === 'object') {
    if (Number.isFinite(mirrored.animation.dy)) mirrored.animation.dy = -mirrored.animation.dy;
    if (Number.isFinite(mirrored.animation.rotation)) mirrored.animation.rotation = -mirrored.animation.rotation;
  }
  return mirrored;
}

function angleDistance(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function writeCpuBallToWorld(ball, height, out) {
  if (!ball || !out) return null;
  out.id = ball.id;
  out.x = ball.x;
  out.y = height - ball.y;
  out.vx = ball.vx;
  out.vy = -ball.vy;
  out.radius = ball.radius;
  out.active = ball.active;
  out.stuck = ball.stuck;
  out.stuckFrames = ball.stuckFrames;
  out.speedCapBoost = ball.speedCapBoost;
  out.portalCooldown = ball.portalCooldown;
  out.launcherSpawnAnim = ball.launcherSpawnAnim;
  out.ultraAimStuck = ball.ultraAimStuck;
  return out;
}

function isRemovablePvpPeg(peg) {
  if (!peg || isPortalType(peg.type)) return false;
  if (peg.type === 'obstacle') return false;
  if (peg.type === 'bumper') return !!(peg.bumperDisappear || peg.bumperOrange);
  return true;
}

function resolveWorldBallCollision(humanBall, cpuBallLocal, height) {
  if (!humanBall?.active || !cpuBallLocal?.active) return;
  const rA = humanBall.radius || getBallRadius();
  const rB = cpuBallLocal.radius || getBallRadius();
  let cpuWorldX = cpuBallLocal.x;
  let cpuWorldY = height - cpuBallLocal.y;
  let cpuWorldVx = cpuBallLocal.vx;
  let cpuWorldVy = -cpuBallLocal.vy;
  let dx = humanBall.x - cpuWorldX;
  let dy = humanBall.y - cpuWorldY;
  let dist = Math.hypot(dx, dy);
  const minDist = rA + rB;
  if (dist >= minDist) return;
  if (dist < 1e-6) {
    dx = 0;
    dy = -1;
    dist = 1;
  }

  const nx = dx / dist;
  const ny = dy / dist;
  const depth = minDist - dist;
  humanBall.x += nx * depth * 0.5;
  humanBall.y += ny * depth * 0.5;
  cpuWorldX -= nx * depth * 0.5;
  cpuWorldY -= ny * depth * 0.5;

  const relVx = humanBall.vx - cpuWorldVx;
  const relVy = humanBall.vy - cpuWorldVy;
  const relN = relVx * nx + relVy * ny;
  if (relN <= 0) {
    const impulse = -(1 + PHYSICS_CONFIG.bounce) * relN / 2;
    humanBall.vx += impulse * nx;
    humanBall.vy += impulse * ny;
    cpuWorldVx -= impulse * nx;
    cpuWorldVy -= impulse * ny;
  }

  cpuBallLocal.x = cpuWorldX;
  cpuBallLocal.y = height - cpuWorldY;
  cpuBallLocal.vx = cpuWorldVx;
  cpuBallLocal.vy = -cpuWorldVy;
}

export class PvpOpponentController {
  chooseAngle() {
    return -Math.PI / 2;
  }
}

export class CpuOpponentController extends PvpOpponentController {
  constructor(runtime) {
    super();
    this.runtime = runtime;
  }

  chooseAngle() {
    return this.runtime.chooseCpuAngle();
  }
}

export class PvpRuntime {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.settings = normalizePvpSettings(options.settings);
    this.getTargetCircle = typeof options.getTargetCircle === 'function' ? options.getTargetCircle : null;
    this.onGameEnd = options.onGameEnd || null;
    this.onVisualState = typeof options.onVisualState === 'function' ? options.onVisualState : null;
    this.showPerfOverlay = false;

    this.humanPhysics = new PhysicsEngine(canvas.width, canvas.height);
    this.cpuPhysics = new PhysicsEngine(canvas.width, canvas.height);
    this.humanPhysics.setBucketEnabled(false);
    this.cpuPhysics.setBucketEnabled(false);

    this.level = null;
    this.pegs = [];
    this.pegById = new Map();
    this.pegVersion = 0;
    this.cpuLocalPegs = [];
    this.humanBall = new Ball(canvas.width / 2, 40);
    this.cpuBall = new Ball(canvas.width / 2, 40);
    this.humanPhysics.setBalls([]);
    this.cpuPhysics.setBalls([]);

    this.state = 'idle';
    this.round = 0;
    this.playerHp = MATCH_HP;
    this.cpuHp = MATCH_HP;
    this.score = 0;
    this.hitPegIds = new Set();
    this.roundHitPegIds = new Set();
    this.humanAimAngle = Math.PI / 2;
    this.cpuAimAngle = Math.PI / 2;
    this.trajectory = null;
    this._pendingAimPosition = null;
    this._aimInputDirty = false;
    this._trajectoryDirty = true;
    this._lastTrajectoryAngle = NaN;
    this._lastTrajectoryFull = null;
    this._lastTrajectoryAimLength = null;
    this._lastTrajectoryPegVersion = -1;
    this.showFullTrajectory = false;
    this.aimLength = 300;
    this.launchX = canvas.width / 2;
    this.launchY = 40;
    this.cpuLaunchX = canvas.width / 2;
    this.cpuLaunchY = 40;
    this.simTimeMs = 0;
    this.aimStartedSimMs = 0;
    this.aimDeadlineSimMs = 0;
    this.roundStartedSimMs = 0;
    this.roundEndReadySimMs = 0;
    this.matchSeed = 1;
    this.roundSeed = 1;
    this._rng = mulberry32(1);
    this.opponentController = new CpuOpponentController(this);

    this.running = false;
    this.animationId = null;
    this.lastTime = 0;
    this.accumulatorMs = 0;
    this.fixedStepMs = 1000 / 120;
    this.maxFrameSteps = 8;
    this.renderTimeSeconds = 0;
    this.renderDeltaSeconds = 0;
    this.rawFrameDeltaSeconds = 0;
    this.inputSuppressedUntil = 0;
    this._ended = false;
    this._paused = false;
    this._stopped = false;
    this._pausedAt = 0;
    this.humanBallPositionHistory = [];
    this.cpuBallPositionHistory = [];
    this._cpuWorldBall = {};
    this._cpuRenderBall = {};
    this._renderBalls = [];
    this._renderHitPegIds = [];
    this._renderSecondaryLaunchers = [];
    this._cpuLauncherState = {};
    this._emptySelectedPegIds = new Set();
    this._listeners = new Set();
    this.abortController = new AbortController();
    this.setupInput();
    this.resize(canvas.width, canvas.height);
  }

  suppressInputFor(ms = 0) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.inputSuppressedUntil = performance.now() + ms;
  }

  _isInputSuppressed() {
    return Number.isFinite(this.inputSuppressedUntil) && performance.now() < this.inputSuppressedUntil;
  }

  setupInput() {
    const sig = { signal: this.abortController.signal };
    let touchDragged = false;

    this.canvas.addEventListener('touchstart', (event) => {
      if (this._isInputSuppressed()) return;
      if (this.state !== 'idle' && this.state !== 'aiming') return;
      initAudio();
      touchDragged = false;
      event.preventDefault();
      this.state = 'aiming';
      this.updateAim(event);
    }, { passive: false, ...sig });

    this.canvas.addEventListener('touchmove', (event) => {
      if (this._isInputSuppressed()) return;
      if (this.state !== 'aiming') return;
      touchDragged = true;
      event.preventDefault();
      this.updateAim(event);
    }, { passive: false, ...sig });

    this.canvas.addEventListener('touchend', (event) => {
      if (this._isInputSuppressed()) return;
      if (this.state !== 'aiming') return;
      event.preventDefault();
      if (!touchDragged) this.updateAim(event);
      this.launchRound({ humanShot: true });
    }, { passive: false, ...sig });

    this.canvas.addEventListener('mousedown', (event) => {
      if (this._isInputSuppressed()) return;
      if (this.state !== 'idle' && this.state !== 'aiming') return;
      initAudio();
      event.preventDefault();
      this.state = 'aiming';
      this.updateAim(event);
    }, sig);

    this.canvas.addEventListener('mousemove', (event) => {
      if (this._isInputSuppressed()) return;
      if (this.state !== 'aiming') return;
      this.updateAim(event);
    }, sig);

    this.canvas.addEventListener('mouseup', (event) => {
      if (this._isInputSuppressed()) return;
      if (this.state !== 'aiming') return;
      event.preventDefault();
      this.launchRound({ humanShot: true });
    }, sig);
  }

  setShowFullTrajectory(show) {
    const next = !!show;
    if (this.showFullTrajectory === next) return;
    this.showFullTrajectory = next;
    this.invalidateTrajectory();
  }

  setAimLength(value) {
    if (Number.isFinite(value)) {
      const next = Math.max(0, Math.min(300, Math.round(value)));
      if (this.aimLength === next) return;
      this.aimLength = next;
      this.invalidateTrajectory();
    }
  }

  invalidateTrajectory() {
    this._trajectoryDirty = true;
  }

  resize(width, height) {
    this.renderer.resize(width, height);
    this.humanPhysics.resize(width, height);
    this.cpuPhysics.resize(width, height);
    this.launchX = width / 2;
    this.launchY = 40;
    this.cpuLaunchX = width / 2;
    this.cpuLaunchY = 40;
    this.syncTargetLossBounds();
    this.resetBallPositions();
    this.syncPhysicsPegs();
  }

  syncTargetLossBounds() {
    const target = this.getTargetCircles().opponent;
    const extra = Math.max(FALLBACK_TARGET_RADIUS, target.radius || FALLBACK_TARGET_RADIUS) + 50;
    this.humanPhysics.setBallLossY(this.canvas.height + extra);
    this.cpuPhysics.setBallLossY(this.canvas.height + extra);
    this.humanPhysics.setBallTopY(-extra);
    this.cpuPhysics.setBallTopY(-extra);
  }

  loadLevel(level) {
    this.level = clone(level || {});
    this.settings = ensureLevelPvp(this.level);
    this.pegs = clone(getPvpRuntimePegs(this.level, this.canvas.height));
    this.matchSeed = hashString(JSON.stringify({
      id: this.level.id || '',
      pegs: this.pegs.map(peg => [peg.id, peg.type, peg.shape, Math.round(peg.x), Math.round(peg.y)])
    })) || 1;
    this.syncPhysicsPegs();
    this.resetMatch();
  }

  syncPhysicsPegs() {
    this.pegById.clear();
    for (const peg of this.pegs) {
      if (peg?.id != null) this.pegById.set(peg.id, peg);
    }
    this.pegVersion += 1;
    this.cpuLocalPegs = this.pegs.map(peg => mirrorPegForLocalPhysics(peg, this.canvas.height));
    this.humanPhysics.setPegs(this.pegs);
    this.cpuPhysics.setPegs(this.cpuLocalPegs);
    this.invalidateTrajectory();
  }

  resetMatch() {
    this.playerHp = MATCH_HP;
    this.cpuHp = MATCH_HP;
    this.score = 0;
    this.round = 0;
    this.simTimeMs = 0;
    this.roundEndReadySimMs = 0;
    this.hitPegIds.clear();
    this.roundHitPegIds.clear();
    this.humanBallPositionHistory = [];
    this.cpuBallPositionHistory = [];
    this._ended = false;
    this._stopped = false;
    this.startAimRound();
    this.emitUiStateIfChanged();
  }

  resetBallPositions() {
    this.humanBall.reset(this.launchX, this.launchY);
    this.cpuBall.reset(this.cpuLaunchX, this.cpuLaunchY);
  }

  startAimRound() {
    if (this._ended) return;
    this.roundEndReadySimMs = 0;
    this.round += 1;
    this.state = 'idle';
    this.roundHitPegIds.clear();
    this.humanBallPositionHistory = [];
    this.cpuBallPositionHistory = [];
    this.humanPhysics.setBalls([]);
    this.cpuPhysics.setBalls([]);
    this.resetBallPositions();
    this.humanAimAngle = Math.PI / 2;
    this.roundSeed = hashString(`${this.matchSeed}:${this.round}`) || this.round;
    this._rng = mulberry32(this.roundSeed);
    this.cpuAimAngle = this.settings.cpuEnabled ? this.opponentController.chooseAngle() : Math.PI / 2;
    this.aimStartedSimMs = this.simTimeMs;
    this.aimDeadlineSimMs = this.simTimeMs + this.settings.aimTimerMs;
    this._pendingAimPosition = null;
    this._aimInputDirty = false;
    this.trajectory = null;
    this.invalidateTrajectory();
    this.emitUiStateIfChanged();
  }

  getInputWorldPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(1, rect.width);
    const scaleY = this.canvas.height / Math.max(1, rect.height);
    let clientX;
    let clientY;
    if (event.touches && event.touches.length > 0) {
      clientX = event.touches[0].clientX;
      clientY = event.touches[0].clientY;
    } else if (event.changedTouches && event.changedTouches.length > 0) {
      clientX = event.changedTouches[0].clientX;
      clientY = event.changedTouches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  updateAim(event) {
    this._pendingAimPosition = this.getInputWorldPosition(event);
    this._aimInputDirty = true;
  }

  flushPendingAim() {
    if (!this._aimInputDirty || !this._pendingAimPosition) return false;
    this._aimInputDirty = false;
    const nextAngle = this.solveAimAngle(this._pendingAimPosition);
    const changed = angleDistance(nextAngle, this.humanAimAngle) > 1e-9;
    this.humanAimAngle = nextAngle;
    return changed;
  }

  solveAimAngle(pos) {
    const tx = pos.x;
    const ty = pos.y;
    const dx = tx - this.launchX;
    const dy = ty - this.launchY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 5) {
      return Math.PI / 2;
    }

    const g = PHYSICS_CONFIG.gravity;
    const v = PHYSICS_CONFIG.launchPower;
    const f = PHYSICS_CONFIG.friction;
    let cx = tx;
    let cy = ty;
    for (let pass = 0; pass < 2; pass++) {
      const angle = Math.atan2(cy - this.launchY, cx - this.launchX);
      let bx = 0;
      let by = 0;
      let bvx = Math.cos(angle) * v;
      let bvy = Math.sin(angle) * v;
      for (let t = 0; t < 500; t++) {
        bvy += g;
        bvx *= f;
        bvy *= f;
        bx += bvx;
        by += bvy;
        if (bx * bx + by * by >= dist * dist) break;
      }
      cx += (tx - this.launchX) - bx;
      cy += (ty - this.launchY) - by;
    }
    return Math.atan2(cy - this.launchY, cx - this.launchX);
  }

  ensureTrajectoryFresh() {
    const steps = this.showFullTrajectory
      ? 1000
      : (this.aimLength > 0 ? Math.max(2, Math.round(this.aimLength)) : 0);
    const needsUpdate = this._trajectoryDirty
      || angleDistance(this.humanAimAngle, this._lastTrajectoryAngle) > AIM_ANGLE_EPSILON
      || this._lastTrajectoryFull !== this.showFullTrajectory
      || this._lastTrajectoryAimLength !== steps
      || this._lastTrajectoryPegVersion !== this.pegVersion;
    if (!needsUpdate) return;
    this.updateTrajectory(steps);
  }

  updateTrajectory(steps = null) {
    const maxSteps = Number.isFinite(steps)
      ? steps
      : (this.showFullTrajectory ? 1000 : (this.aimLength > 0 ? Math.max(2, Math.round(this.aimLength)) : 0));
    this.trajectory = this.humanPhysics.predictTrajectory(
      this.launchX,
      this.launchY,
      this.humanAimAngle,
      PHYSICS_CONFIG.launchPower,
      maxSteps,
      !this.showFullTrajectory
    );
    this._trajectoryDirty = false;
    this._lastTrajectoryAngle = this.humanAimAngle;
    this._lastTrajectoryFull = this.showFullTrajectory;
    this._lastTrajectoryAimLength = maxSteps;
    this._lastTrajectoryPegVersion = this.pegVersion;
  }

  chooseCpuAngle() {
    const difficulty = this.settings.cpuDifficulty || 'normal';
    const config = {
      easy: { samples: 7, steps: 160, noise: 130, angleNoise: 0.22 },
      normal: { samples: 15, steps: 220, noise: 44, angleNoise: 0.08 },
      hard: { samples: 23, steps: 260, noise: 12, angleNoise: 0.025 }
    }[difficulty] || { samples: 15, steps: 220, noise: 44, angleNoise: 0.08 };

    let bestAngle = Math.PI / 2;
    let bestScore = -Infinity;
    const spread = Math.PI * 0.78;
    for (let i = 0; i < config.samples; i++) {
      const t = config.samples === 1 ? 0.5 : i / (config.samples - 1);
      const base = Math.PI / 2 + (t - 0.5) * spread;
      const angle = base + (this._rng() - 0.5) * config.angleNoise;
      const score = this.scoreCpuAngle(angle, config.steps) + (this._rng() - 0.5) * config.noise;
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
    return bestAngle;
  }

  scoreCpuAngle(angle, steps = 220) {
    const trajectory = this.cpuPhysics.predictTrajectory(
      this.cpuLaunchX,
      this.cpuLaunchY,
      angle,
      PHYSICS_CONFIG.launchPower,
      steps,
      false
    );
    const target = this.getTargetCircles().player;
    const localTarget = {
      x: target.x,
      y: this.canvas.height - target.y,
      radius: target.radius
    };
    let bestDist = Infinity;
    for (const point of trajectory.points || []) {
      bestDist = Math.min(bestDist, Utils.distance(point.x, point.y, localTarget.x, localTarget.y));
    }
    const hitCannon = bestDist <= localTarget.radius + getBallRadius();
    const pegHits = Array.isArray(trajectory.hits) ? trajectory.hits.length : 0;
    return (hitCannon ? 1000 : 0) + Math.max(0, 220 - bestDist) * 2 + pegHits * 14;
  }

  launchRound({ humanShot }) {
    if (this.state !== 'idle' && this.state !== 'aiming') return;
    if (humanShot) this.flushPendingAim();
    this.state = 'playing';
    this.roundStartedSimMs = this.simTimeMs;
    this.roundEndReadySimMs = 0;
    this.accumulatorMs = 0;
    this.syncTargetLossBounds();
    this.humanBallPositionHistory = [];
    this.cpuBallPositionHistory = [];
    resetHitCounter();
    lightTap();
    this.resetBallPositions();

    if (humanShot) {
      this.humanBall.launch(this.humanAimAngle, PHYSICS_CONFIG.launchPower);
      this.humanPhysics.setBalls([this.humanBall]);
    } else {
      this.damagePlayer();
      this.humanPhysics.setBalls([]);
    }

    if (this.settings.cpuEnabled) {
      this.cpuBall.launch(this.cpuAimAngle, PHYSICS_CONFIG.launchPower);
      this.cpuPhysics.setBalls([this.cpuBall]);
    } else {
      this.cpuPhysics.setBalls([]);
    }

    this.trajectory = null;
    this.emitUiStateIfChanged();
    if (this.playerHp <= 0 || this.cpuHp <= 0) {
      this.finishMatch(this.cpuHp <= 0 ? 'won' : 'lost');
    }
  }

  start() {
    if (this.running) return;
    if (!this.level) this.loadLevel({ pegs: [], pvp: this.settings });
    this.running = true;
    this._stopped = false;
    this._paused = false;
    this.lastTime = 0;
    const loop = (timestamp) => {
      if (!this.running) return;
      this.tick(timestamp || performance.now());
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this._stopped = true;
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this.roundEndReadySimMs = 0;
    this.humanBall.active = false;
    this.cpuBall.active = false;
    this.humanPhysics.setBalls([]);
    this.cpuPhysics.setBalls([]);
    this.abortController.abort();
    this._listeners.clear();
    this.renderer?.dispose?.();
  }

  pause() {
    if (!this.animationId || this._paused) return;
    cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this._paused = true;
    this._pausedAt = performance.now();
  }

  resume() {
    if (!this._paused || this._stopped || !this.running || this.abortController.signal.aborted) return;
    const now = performance.now();
    this._paused = false;
    this._pausedAt = 0;
    this.accumulatorMs = 0;
    this.lastTime = now;
    const loop = (timestamp) => {
      if (!this.running || this._paused) return;
      this.tick(timestamp || performance.now());
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  isPaused() {
    return !!this._paused;
  }

  handleRestart() {
    this.stop();
    return true;
  }

  getEndOverlayInteractDelayMs() {
    return this.renderer?.getEndOverlayInteractDelayMs?.() ?? 360;
  }

  dismissEndOverlay(onComplete) {
    const callback = typeof onComplete === 'function' ? onComplete : null;
    const dismissed = this.renderer?.dismissEndOverlay?.(callback);
    if (!dismissed && callback) callback();
    return !!dismissed;
  }

  tick(timestamp) {
    if (this._paused) return;
    if (!this.lastTime) this.lastTime = timestamp;
    const rawDeltaMs = Math.max(0, Math.min(250, timestamp - this.lastTime));
    this.lastTime = timestamp;
    this.rawFrameDeltaSeconds = rawDeltaMs / 1000;
    this.renderDeltaSeconds = this.rawFrameDeltaSeconds;
    this.renderTimeSeconds = timestamp / 1000;

    if (this.state !== 'playing') {
      this.simTimeMs += rawDeltaMs;
      this.accumulatorMs = 0;
    }

    if (this.state === 'roundEnd') {
      if (this.roundEndReadySimMs > 0 && this.simTimeMs >= this.roundEndReadySimMs) {
        this.startAimRound();
      }
      this.render();
      return;
    }

    if (this.state === 'idle' || this.state === 'aiming') {
      if (this.simTimeMs >= this.aimDeadlineSimMs) {
        this.launchRound({ humanShot: false });
        this.render();
        return;
      }
      if (this.state === 'aiming') {
        this.flushPendingAim();
        this.ensureTrajectoryFresh();
      }
    }

    if (this.state === 'playing') {
      this.accumulatorMs += rawDeltaMs;
      let steps = 0;
      while (this.accumulatorMs >= this.fixedStepMs && steps < this.maxFrameSteps) {
        this.step(this.fixedStepMs / 1000);
        this.accumulatorMs -= this.fixedStepMs;
        steps++;
      }
      if (steps >= this.maxFrameSteps) this.accumulatorMs = 0;
    }
    this.render();
  }

  step(dt) {
    if (this.state !== 'playing') return;
    this.simTimeMs += dt * 1000;

    const humanResult = this.humanPhysics.update(dt);
    const cpuResult = this.cpuPhysics.update(dt);
    resolveWorldBallCollision(this.humanBall, this.cpuBall, this.canvas.height);

    this.handlePhysicsResult(humanResult);
    this.handlePhysicsResult(cpuResult);
    this.checkCannonHits();
    this.checkStuckBalls();

    if (this.playerHp <= 0 || this.cpuHp <= 0) {
      this.finishMatch(this.cpuHp <= 0 ? 'won' : 'lost');
      return;
    }

    const roundAge = (this.simTimeMs - this.roundStartedSimMs) / 1000;
    if ((humanResult.ballsRemaining === 0 && cpuResult.ballsRemaining === 0) || roundAge > MAX_ROUND_SECONDS) {
      this.finishRound();
    }
  }

  handlePhysicsResult(result) {
    for (const event of result.hitEvents || []) {
      const peg = this.pegById.get(event.peg?.id);
      if (!peg) continue;
      this.hitPegIds.add(peg.id);
      if (isRemovablePvpPeg(peg) && !this.roundHitPegIds.has(peg.id)) {
        this.roundHitPegIds.add(peg.id);
        this.score += 10;
        pegHitSound();
      }
    }
  }

  checkStuckBalls() {
    if (this.state !== 'playing' || this.roundHitPegIds.size === 0) return;
    this.checkStuckBallForSide('human', this.humanBall, this.humanBallPositionHistory);
    const cpuWorld = writeCpuBallToWorld(this.cpuBall, this.canvas.height, this._cpuWorldBall);
    this.checkStuckBallForSide('cpu', cpuWorld, this.cpuBallPositionHistory);
  }

  checkStuckBallForSide(side, ball, history) {
    if (!ball?.active) {
      history.length = 0;
      return;
    }
    const now = this.simTimeMs;
    const lastT = history.length > 0 ? history[history.length - 1].t : 0;
    if (now - lastT < 150) return;

    history.push({ x: ball.x, y: ball.y, t: now });
    const cutoff = now - 3000;
    while (history.length > 0 && history[0].t < cutoff) history.shift();
    if (history.length < 2 || now - history[0].t < 2500) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pos of history) {
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    if (maxX - minX < 180 && maxY - minY < 180) {
      this.releaseStuckPeg(side);
    }
  }

  releaseStuckPeg(side) {
    const candidates = this.pegs.filter(peg => this.roundHitPegIds.has(peg.id) && isRemovablePvpPeg(peg));
    if (candidates.length === 0) return;
    const peg = candidates.reduce((best, item) => {
      if (!best) return item;
      return side === 'cpu'
        ? (item.y < best.y ? item : best)
        : (item.y > best.y ? item : best);
    }, null);
    if (!peg) return;

    this.renderer.queuePegExitAnimations?.([peg]);
    this.pegs = this.pegs.filter(item => item.id !== peg.id);
    this.roundHitPegIds.delete(peg.id);
    this.hitPegIds.delete(peg.id);
    this.syncPhysicsPegs();
    this.humanBallPositionHistory = [];
    this.cpuBallPositionHistory = [];
  }

  getTargetCircles() {
    const raw = this.getTargetCircle?.();
    const player = raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.radius)
      ? raw
      : { x: this.canvas.width / 2, y: this.launchY, radius: FALLBACK_TARGET_RADIUS };
    return {
      player,
      opponent: {
        x: player.x,
        y: this.canvas.height - player.y,
        radius: player.radius
      }
    };
  }

  checkCannonHits() {
    const targets = this.getTargetCircles();
    if (this.humanBall.active && Utils.distance(this.humanBall.x, this.humanBall.y, targets.opponent.x, targets.opponent.y) <= targets.opponent.radius + this.humanBall.radius) {
      this.damageCpu();
      this.humanBall.active = false;
      this.humanPhysics.setBalls([]);
      this.emitUiStateIfChanged();
    }

    const cpuWorld = writeCpuBallToWorld(this.cpuBall, this.canvas.height, this._cpuWorldBall);
    if (this.cpuBall.active && Utils.distance(cpuWorld.x, cpuWorld.y, targets.player.x, targets.player.y) <= targets.player.radius + this.cpuBall.radius) {
      this.damagePlayer();
      this.cpuBall.active = false;
      this.cpuPhysics.setBalls([]);
      this.emitUiStateIfChanged();
    }
  }

  damagePlayer() {
    this.playerHp = Math.max(0, this.playerHp - 1);
  }

  damageCpu() {
    this.cpuHp = Math.max(0, this.cpuHp - 1);
  }

  finishRound() {
    if (this.state !== 'playing') return;
    this.state = 'roundEnd';
    const removeIds = new Set(this.roundHitPegIds);
    if (removeIds.size > 0) {
      const removed = this.pegs.filter(peg => removeIds.has(peg.id));
      this.renderer.queuePegExitAnimations?.(removed);
      this.pegs = this.pegs.filter(peg => !removeIds.has(peg.id));
      for (const id of removeIds) this.hitPegIds.delete(id);
      this.syncPhysicsPegs();
    }
    this.roundHitPegIds.clear();
    this.humanBallPositionHistory = [];
    this.cpuBallPositionHistory = [];
    this.humanPhysics.setBalls([]);
    this.cpuPhysics.setBalls([]);
    this.roundEndReadySimMs = this.simTimeMs + ROUND_END_DELAY_MS;
  }

  finishMatch(result) {
    if (this._ended) return;
    this._ended = true;
    this.state = result === 'won' ? 'won' : 'lost';
    this.roundEndReadySimMs = 0;
    this.humanBall.active = false;
    this.cpuBall.active = false;
    this.humanPhysics.setBalls([]);
    this.cpuPhysics.setBalls([]);
    this.emitUiStateIfChanged();
    if (typeof this.onGameEnd === 'function') {
      this.onGameEnd(this.state, this.score);
    }
  }

  subscribeUiState(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    listener(this.getUiStateSnapshot());
    return () => this._listeners.delete(listener);
  }

  emitUiStateIfChanged() {
    const snapshot = this.getUiStateSnapshot();
    for (const listener of this._listeners) listener(snapshot);
  }

  getUiStateSnapshot() {
    return {
      ballsLeft: null,
      initialBallCount: null,
      orangePegsLeft: this.playerHp,
      totalOrangePegs: MATCH_HP,
      playerHp: this.playerHp,
      cpuHp: this.cpuHp,
      maxHp: MATCH_HP
    };
  }

  getTimerRatio() {
    if (this.state !== 'idle' && this.state !== 'aiming') return null;
    return Utils.clamp((this.aimDeadlineSimMs - this.simTimeMs) / Math.max(1, this.settings.aimTimerMs), 0, 1);
  }

  getRenderState() {
    const activeBalls = this._renderBalls;
    activeBalls.length = 0;
    if (this.humanBall.active) activeBalls.push(this.humanBall);
    if (this.cpuBall.active) activeBalls.push(writeCpuBallToWorld(this.cpuBall, this.canvas.height, this._cpuRenderBall));

    const hitPegIds = this._renderHitPegIds;
    hitPegIds.length = 0;
    for (const id of this.hitPegIds) hitPegIds.push(id);

    const cpuWorldAngle = -this.cpuAimAngle;
    const showLaunchers = this.state === 'idle' || this.state === 'aiming';
    const secondaryLaunchers = this._renderSecondaryLaunchers;
    secondaryLaunchers.length = 0;
    if (showLaunchers) {
      const launcher = this._cpuLauncherState;
      launcher.x = this.cpuLaunchX;
      launcher.y = this.canvas.height - this.cpuLaunchY;
      launcher.angle = cpuWorldAngle;
      launcher.showAim = false;
      launcher.ballScale = 1;
      secondaryLaunchers.push(launcher);
    }

    return {
      pegs: this.pegs,
      hitPegIds,
      selectedPegIds: this._emptySelectedPegIds,
      balls: activeBalls,
      bucket: null,
      cameraY: 0,
      showLauncher: showLaunchers,
      launchX: this.launchX,
      launchY: this.launchY,
      launcherBallScale: 1,
      aimAngle: this.humanAimAngle,
      showAim: this.state === 'aiming',
      secondaryLaunchers,
      trajectory: this.state === 'aiming' ? this.trajectory : null,
      showFullTrajectory: this.showFullTrajectory,
      aimLength: this.aimLength,
      score: this.score,
      ballsLeft: null,
      orangePegsLeft: this.playerHp,
      totalOrangePegs: MATCH_HP,
      levelProgress: this.playerHp / MATCH_HP,
      worldHeight: this.canvas.height,
      backgroundFxId: this.level ? `pvp:${this.level.id || 'level'}` : 'pvp',
      backgroundEvents: [],
      playState: this.state,
      renderTimeSeconds: this.renderTimeSeconds,
      renderDeltaSeconds: this.renderDeltaSeconds,
      frameDeltaSeconds: this.rawFrameDeltaSeconds,
      pvpMidline: this.settings.symmetryEnabled ? getPvpMidline(this.canvas.height) : null,
      pvpTimerRatio: this.getTimerRatio(),
      message: this.state === 'won' ? 'Victory' : (this.state === 'lost' ? 'Defeat' : null),
      subMessage: this.state === 'won' || this.state === 'lost' ? 'Continue' : null
    };
  }

  render() {
    const state = this.getRenderState();
    this.renderer.renderGame(state);
    if (this.onVisualState) {
      this.onVisualState({
        cpuHp: this.cpuHp,
        playerHp: this.playerHp,
        maxHp: MATCH_HP,
        timerRatio: state.pvpTimerRatio,
        timerVisible: Number.isFinite(state.pvpTimerRatio)
      });
    }
  }
}
