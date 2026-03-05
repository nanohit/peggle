import {
  clampCameraY,
  getMaxCameraY,
  getProgressRatio,
  getRemainingFieldRatio,
  isPegBeyondLoseLine,
  normalizeSurvivalSettings,
  screenToWorldY,
  worldToScreenY
} from './survival-mode.js';

export class SurvivalRuntime {
  constructor(viewportHeight, options = {}) {
    this.viewportHeight = Math.max(120, Math.round(Number(viewportHeight) || 600));
    this.autoScroll = !!options.autoScroll;
    this.settings = normalizeSurvivalSettings(null, this.viewportHeight);
    this.cameraY = 0;
  }

  configure(settings) {
    this.settings = normalizeSurvivalSettings(settings, this.viewportHeight);
    this.cameraY = clampCameraY(this.cameraY, this.settings.worldHeight, this.viewportHeight);
    return this.settings;
  }

  resize(viewportHeight) {
    this.viewportHeight = Math.max(120, Math.round(Number(viewportHeight) || this.viewportHeight));
    this.settings = normalizeSurvivalSettings(this.settings, this.viewportHeight);
    this.cameraY = clampCameraY(this.cameraY, this.settings.worldHeight, this.viewportHeight);
  }

  setAutoScroll(autoScroll) {
    this.autoScroll = !!autoScroll;
  }

  isEnabled() {
    return !!this.settings.enabled;
  }

  resetCamera(toTop = true) {
    this.cameraY = toTop ? 0 : this.getMaxCameraY();
  }

  update(deltaSeconds) {
    if (!this.isEnabled() || !this.autoScroll) return this.cameraY;
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    if (dt <= 0) return this.cameraY;

    this.cameraY = clampCameraY(
      this.cameraY + this.settings.scrollSpeed * dt,
      this.settings.worldHeight,
      this.viewportHeight
    );
    return this.cameraY;
  }

  setCameraY(cameraY) {
    this.cameraY = clampCameraY(cameraY, this.settings.worldHeight, this.viewportHeight);
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
    return this.settings.worldHeight;
  }

  getLoseLineY() {
    return this.settings.loseLineY;
  }

  getMaxCameraY() {
    return getMaxCameraY(this.settings.worldHeight, this.viewportHeight);
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
    const maxCameraY = this.getMaxCameraY();
    return {
      remainingRatio: getRemainingFieldRatio(this.cameraY, maxCameraY),
      progressRatio: getProgressRatio(this.cameraY, maxCameraY)
    };
  }
}
