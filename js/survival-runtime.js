import {
  clampCameraY,
  evaluateSurvivalSpeedCurve,
  getMaxCameraY,
  getProgressRatio,
  getRemainingFieldRatio,
  isPegBeyondLoseLine,
  normalizeSurvivalSettings,
  SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX,
  SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS,
  SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MAX_MS,
  SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MIN_MS,
  screenToWorldY,
  worldToScreenY
} from './survival-mode.js';

const KNOCKBACK_OVERSCROLL_MAX = SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX;
const DEFAULT_KNOCKBACK_SMOOTH_SECONDS = SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS / 1000;

function easeOutCubic(t) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return 1 - Math.pow(1 - clamped, 3);
}

export class SurvivalRuntime {
  constructor(viewportHeight, options = {}) {
    this.viewportHeight = Math.max(120, Math.round(Number(viewportHeight) || 600));
    this.autoScroll = !!options.autoScroll;
    this.settings = normalizeSurvivalSettings(null, this.viewportHeight);
    this.cameraY = 0;
    this.originY = 0;
    this.elapsedSeconds = 0;
    this.distanceHighWater = 0;
    this.knockbackDistance = 0;
    this.knockbackAppliedDistance = 0;
    this.knockbackElapsed = 0;
    this.knockbackDurationSeconds = DEFAULT_KNOCKBACK_SMOOTH_SECONDS;
  }

  _clampCameraYOverscroll(cameraY) {
    const maxCameraY = this.getMaxCameraY();
    const minCameraY = cameraY < 0 || this.cameraY < 0 ? -KNOCKBACK_OVERSCROLL_MAX : 0;
    return Math.max(minCameraY, Math.min(maxCameraY, Number.isFinite(cameraY) ? cameraY : 0));
  }

  configure(settings) {
    this.settings = normalizeSurvivalSettings(settings, this.viewportHeight);
    this.cameraY = this.isEndless() ? this._clampCameraYOverscroll(this.cameraY) : clampCameraY(this.cameraY, this.settings.worldHeight, this.viewportHeight);
    this.clearKnockback();
    return this.settings;
  }

  resize(viewportHeight) {
    this.viewportHeight = Math.max(120, Math.round(Number(viewportHeight) || this.viewportHeight));
    this.settings = normalizeSurvivalSettings(this.settings, this.viewportHeight);
    this.cameraY = this.isEndless() ? this._clampCameraYOverscroll(this.cameraY) : clampCameraY(this.cameraY, this.settings.worldHeight, this.viewportHeight);
    this.clearKnockback();
  }

  setAutoScroll(autoScroll) {
    this.autoScroll = !!autoScroll;
  }

  isEnabled() {
    return !!this.settings.enabled;
  }

  resetCamera(toTop = true) {
    this.cameraY = toTop || this.isEndless() ? 0 : this.getMaxCameraY();
    this.originY = 0;
    this.elapsedSeconds = 0;
    this.distanceHighWater = 0;
    this.clearKnockback();
  }

  update(deltaSeconds) {
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    if (dt <= 0) return this.cameraY;

    const maxCameraY = this.getMaxCameraY();
    let deltaY = 0;
    const knockbackActive = this.knockbackDistance > 0;
    if (this.isEnabled() && this.autoScroll && !knockbackActive) {
      const progressRatio = getProgressRatio(this.cameraY, maxCameraY);
      const speedScale = evaluateSurvivalSpeedCurve(this.settings.speedCurve, progressRatio);
      deltaY += this.getScrollSpeed() * (this.isEndless() ? 1 : speedScale) * dt;
    }
    if (this.isEnabled() && this.autoScroll) this.elapsedSeconds += dt;

    if (knockbackActive) {
      const duration = Math.max(0.001, this.knockbackDurationSeconds || DEFAULT_KNOCKBACK_SMOOTH_SECONDS);
      this.knockbackElapsed = Math.min(duration, this.knockbackElapsed + dt);
      const eased = easeOutCubic(this.knockbackElapsed / duration);
      const targetApplied = this.knockbackDistance * eased;
      const step = Math.max(0, targetApplied - this.knockbackAppliedDistance);
      this.knockbackAppliedDistance = targetApplied;
      deltaY -= step;

      if (
        this.knockbackElapsed >= duration ||
        this.knockbackDistance - this.knockbackAppliedDistance <= 0.001
      ) {
        this.clearKnockback();
      }
    }

    if (deltaY === 0) return this.cameraY;
    const unclampedY = this.cameraY + deltaY;
    this.cameraY = this._clampCameraYOverscroll(unclampedY);
    this.distanceHighWater = Math.max(this.distanceHighWater, this.originY + this.cameraY);
    return this.cameraY;
  }

  setCameraY(cameraY) {
    this.clearKnockback();
    this.cameraY = this.isEndless() ? this._clampCameraYOverscroll(cameraY) : clampCameraY(cameraY, this.settings.worldHeight, this.viewportHeight);
    return this.cameraY;
  }

  scrollBy(deltaY) {
    const amount = Number(deltaY);
    if (!Number.isFinite(amount)) return this.cameraY;
    return this.setCameraY(this.cameraY + amount);
  }

  getCameraY() {
    return this.cameraY;
  }

  getWorldHeight() {
    return this.isEndless() ? Math.max(this.viewportHeight * 3, this.cameraY + this.viewportHeight * 3) : this.settings.worldHeight;
  }

  isEndless() { return this.isEnabled() && this.settings.endless === true; }

  getScrollSpeed() {
    return this.settings.scrollSpeed * (this.isEndless() ? 1 + 0.65 * (1 - Math.exp(-this.distanceHighWater / 6000)) : 1);
  }

  rebase(distance) {
    this.cameraY -= distance;
    this.originY += distance;
  }

  getLoseLineY() {
    return this.settings.loseLineY;
  }

  getAntiCooldownMs() {
    return this.settings.antiCooldownMs || 0;
  }

  getBackground() {
    return this.settings.background || null;
  }

  getGamblePegSettings() {
    return this.settings.gamblePeg || null;
  }

  clearKnockback() {
    this.knockbackDistance = 0;
    this.knockbackAppliedDistance = 0;
    this.knockbackElapsed = 0;
    this.knockbackDurationSeconds = DEFAULT_KNOCKBACK_SMOOTH_SECONDS;
  }

  applyGambleKnockback(distancePx = null, smoothMs = null) {
    if (!this.isEnabled()) return this.cameraY;
    const requestedDistance = Math.max(
      0,
      Math.min(SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX, Number(distancePx) || 0)
    );
    if (requestedDistance <= 0) return this.cameraY;
    const requestedSmoothMs = Math.max(
      SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MIN_MS,
      Math.min(
        SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MAX_MS,
        Number.isFinite(Number(smoothMs)) ? Number(smoothMs) : SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_DEFAULT_MS
      )
    );

    const remainingDistance = Math.max(0, this.knockbackDistance - this.knockbackAppliedDistance);
    this.knockbackDistance = Math.min(
      SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX,
      remainingDistance + requestedDistance
    );
    this.knockbackAppliedDistance = 0;
    this.knockbackElapsed = 0;
    this.knockbackDurationSeconds = requestedSmoothMs / 1000;
    return this.cameraY;
  }

  getMaxCameraY() {
    return this.isEndless() ? Number.POSITIVE_INFINITY : getMaxCameraY(this.settings.worldHeight, this.viewportHeight);
  }

  getSettings() {
    return this.settings;
  }

  worldToScreenY(worldY) {
    return worldToScreenY(worldY, this.cameraY);
  }

  screenToWorldY(screenY) {
    return screenToWorldY(screenY, this.cameraY);
  }

  isPegBeyondLoseLine(peg, pegRadius = 10) {
    if (!this.isEnabled()) return false;
    return isPegBeyondLoseLine(peg, this.cameraY, this.settings.loseLineY, pegRadius);
  }

  getTrackerState() {
    if (!this.isEnabled()) return null;
    if (this.isEndless()) return {
      endless: true, distance: Math.max(0, this.originY + this.cameraY),
      elapsedSeconds: this.elapsedSeconds, speed: this.getScrollSpeed(),
      remainingRatio: 1, progressRatio: 1 - Math.exp(-this.distanceHighWater / 9500)
    };
    const maxCameraY = this.getMaxCameraY();
    return {
      remainingRatio: getRemainingFieldRatio(this.cameraY, maxCameraY),
      progressRatio: getProgressRatio(this.cameraY, maxCameraY)
    };
  }
}
