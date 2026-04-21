const DEFAULT_COLOR = '#f8f9fa';
const MAX_TRAIL_SAMPLES = 72;
const ALPHA_BUCKETS = 128;
const MIN_VISIBLE_ALPHA = 0.5 / ALPHA_BUCKETS;
const PASS_COST_WEIGHTS = [1.5, 1.2, 1.0]; // outer, middle, core
const PROFILE_LIMITS = Object.freeze({
  full: Object.freeze({ strokeBudget: 520, segmentScale: 1, maxPasses: 3 }),
  balanced: Object.freeze({ strokeBudget: 360, segmentScale: 0.85, maxPasses: 3 }),
  lite: Object.freeze({ strokeBudget: 180, segmentScale: 0.55, maxPasses: 2 })
});
const ALPHA_SUFFIXES = (() => {
  const suffixes = new Array(ALPHA_BUCKETS + 1);
  for (let i = 0; i <= ALPHA_BUCKETS; i++) {
    suffixes[i] = (i / ALPHA_BUCKETS).toFixed(3) + ')';
  }
  return suffixes;
})();

export const DEFAULT_BALL_TRAIL_PROGRESSION = Object.freeze({
  enabled: false,
  color: DEFAULT_COLOR,
  length: 0.31,
  width: 0.7,
  glow: 0,
  opacity: 0.32,
  turbulence: 0,
  smoothing: 1
});

export const DEFAULT_BALL_TRAIL = Object.freeze({
  enabled: true,
  color: DEFAULT_COLOR,
  length: 0.31,
  width: 0.7,
  glow: 0,
  opacity: 0.32,
  turbulence: 0,
  smoothing: 1,
  progression: DEFAULT_BALL_TRAIL_PROGRESSION
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function parseColor(value, fallback = DEFAULT_COLOR) {
  const hex = isColor(value) ? value : fallback;
  return {
    hex,
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

function colorKey(r, g, b) {
  return (((r & 255) >> 2) << 12) | (((g & 255) >> 2) << 6) | ((b & 255) >> 2);
}

function parseColorInto(target, value, fallback = DEFAULT_COLOR) {
  const hex = isColor(value) ? value : fallback;
  if (target.hex === hex) return target;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  target.hex = hex;
  target.r = r;
  target.g = g;
  target.b = b;
  target.key = colorKey(r, g, b);
  return target;
}

function toHexChannel(value) {
  return Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');
}

function mixColor(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b, ca.hex);
  const k = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return `#${toHexChannel(ca.r + (cb.r - ca.r) * k)}${toHexChannel(ca.g + (cb.g - ca.g) * k)}${toHexChannel(ca.b + (cb.b - ca.b) * k)}`;
}

export function normalizeTrailPerformanceProfile(profile) {
  return Object.prototype.hasOwnProperty.call(PROFILE_LIMITS, profile) ? profile : 'balanced';
}

function desiredPassCount(glow) {
  if (glow < 0.15) return 1;
  if (glow < 0.6) return 2;
  return 3;
}

function resolveDrawPlanInto(out, config, activeBallCount, profile, desiredSegments) {
  const limits = PROFILE_LIMITS[normalizeTrailPerformanceProfile(profile)];
  const passCount = Math.min(desiredPassCount(config.glow), limits.maxPasses);
  let passCostUnits = 0;
  for (let i = PASS_COST_WEIGHTS.length - passCount; i < PASS_COST_WEIGHTS.length; i++) {
    passCostUnits += PASS_COST_WEIGHTS[i];
  }

  const activeBalls = Math.max(1, activeBallCount | 0);
  const desired = Math.max(1, Math.round(desiredSegments * limits.segmentScale));
  const budgeted = Math.floor(limits.strokeBudget / (activeBalls * passCostUnits));
  out.passCount = passCount;
  out.maxSegments = Math.max(8, Math.min(desired, budgeted, MAX_TRAIL_SAMPLES - 1));
  out.outerGlowScale = 2.9 + config.glow * 1.7;
  out.outerAlphaScale = 0.075 + config.glow * 0.065;
  out.middleGlowScale = 1.55 + config.glow * 0.75;
  out.middleAlphaScale = 0.12 + config.glow * 0.07;
  out.coreGlowScale = 0.72;
  out.coreAlphaScale = 0.48;
  return out;
}

function normalizeProgression(raw, base) {
  const progression = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: !!progression.enabled,
    color: isColor(progression.color) ? progression.color : base.color,
    length: clamp(progression.length, 0.2, 2.6, base.length),
    width: clamp(progression.width, 0.35, 2.6, base.width),
    glow: clamp(progression.glow, 0, 2.4, base.glow),
    opacity: clamp(progression.opacity, 0, 1.5, base.opacity),
    turbulence: clamp(progression.turbulence, 0, 1.8, base.turbulence),
    smoothing: clamp(progression.smoothing, 0, 1, base.smoothing)
  };
}

export function normalizeBallTrailConfig(raw = null) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = {
    enabled: source.enabled !== false,
    color: isColor(source.color) ? source.color : DEFAULT_BALL_TRAIL.color,
    length: clamp(source.length, 0.2, 2.6, DEFAULT_BALL_TRAIL.length),
    width: clamp(source.width, 0.35, 2.6, DEFAULT_BALL_TRAIL.width),
    glow: clamp(source.glow, 0, 2.4, DEFAULT_BALL_TRAIL.glow),
    opacity: clamp(source.opacity, 0, 1.5, DEFAULT_BALL_TRAIL.opacity),
    turbulence: clamp(source.turbulence, 0, 1.8, DEFAULT_BALL_TRAIL.turbulence),
    smoothing: clamp(source.smoothing, 0, 1, DEFAULT_BALL_TRAIL.smoothing)
  };
  return {
    ...base,
    progression: normalizeProgression(source.progression, base)
  };
}

export function hasBallTrailProgression(rawConfig) {
  const config = normalizeBallTrailConfig(rawConfig);
  return !!(config.enabled && config.progression?.enabled);
}

export function resolveBallTrailConfig(rawConfig, progressRatio = 0) {
  const config = rawConfig && typeof rawConfig === 'object' && rawConfig.progression
    ? rawConfig
    : normalizeBallTrailConfig(rawConfig);
  const progression = config.progression || DEFAULT_BALL_TRAIL_PROGRESSION;
  if (!config.enabled || !progression.enabled) return config;
  const t = Math.max(0, Math.min(1, Number.isFinite(progressRatio) ? progressRatio : 0));
  return {
    enabled: config.enabled,
    color: mixColor(config.color, progression.color, t),
    length: config.length + (progression.length - config.length) * t,
    width: config.width + (progression.width - config.width) * t,
    glow: config.glow + (progression.glow - config.glow) * t,
    opacity: config.opacity + (progression.opacity - config.opacity) * t,
    turbulence: config.turbulence + (progression.turbulence - config.turbulence) * t,
    smoothing: config.smoothing + (progression.smoothing - config.smoothing) * t,
    progression
  };
}

function hashId(id) {
  const s = String(id ?? 'ball');
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

class TrailBuffer {
  constructor(id) {
    this.id = id;
    this.hash = hashId(id);
    this.x = new Float32Array(MAX_TRAIL_SAMPLES);
    this.y = new Float32Array(MAX_TRAIL_SAMPLES);
    this.t = new Float32Array(MAX_TRAIL_SAMPLES);
    this.head = 0;
    this.count = 0;
    this.lastX = NaN;
    this.lastY = NaN;
    this.lastTime = 0;
    this.lastSeen = 0;
    this.active = true;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.lastX = NaN;
    this.lastY = NaN;
    this.lastTime = 0;
  }

  push(rawX, rawY, time, smoothing = 0.6) {
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time)) return;

    if (Number.isFinite(this.lastX) && Number.isFinite(this.lastY)) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const distSq = dx * dx + dy * dy;
      if (distSq > 220 * 220) this.clear();
      if (distSq < 2.4 * 2.4 && time - this.lastTime < 0.026) {
        this.lastSeen = time;
        return;
      }
    }

    const smooth = Math.max(0, Math.min(0.82, smoothing * 0.72));
    const sx = Number.isFinite(this.lastX) ? this.lastX * smooth + x * (1 - smooth) : x;
    const sy = Number.isFinite(this.lastY) ? this.lastY * smooth + y * (1 - smooth) : y;

    this.x[this.head] = sx;
    this.y[this.head] = sy;
    this.t[this.head] = time;
    this.head = (this.head + 1) % MAX_TRAIL_SAMPLES;
    this.count = Math.min(MAX_TRAIL_SAMPLES, this.count + 1);
    this.lastX = sx;
    this.lastY = sy;
    this.lastTime = time;
    this.lastSeen = time;
  }

  indexFromNewest(offset) {
    return (this.head - 1 - offset + MAX_TRAIL_SAMPLES) % MAX_TRAIL_SAMPLES;
  }
}

export class BallTrailRenderer {
  constructor() {
    this.trails = new Map();
    this._seenIds = new Set();
    this._baseColor = { hex: '', r: 248, g: 249, b: 250, key: colorKey(248, 249, 250) };
    this._progressColor = { hex: '', r: 248, g: 249, b: 250, key: colorKey(248, 249, 250) };
    this._resolvedColor = { hex: '', r: 248, g: 249, b: 250, key: colorKey(248, 249, 250) };
    this._alphaStyles = new Array(ALPHA_BUCKETS + 1);
    this._alphaStyleColorKey = -1;
    this._segX0 = new Float32Array(MAX_TRAIL_SAMPLES);
    this._segY0 = new Float32Array(MAX_TRAIL_SAMPLES);
    this._segX1 = new Float32Array(MAX_TRAIL_SAMPLES);
    this._segY1 = new Float32Array(MAX_TRAIL_SAMPLES);
    this._segWidth = new Float32Array(MAX_TRAIL_SAMPLES);
    this._segAlpha = new Float32Array(MAX_TRAIL_SAMPLES);
    this._pointX = new Float32Array(MAX_TRAIL_SAMPLES);
    this._pointY = new Float32Array(MAX_TRAIL_SAMPLES);
    this._segmentMaxAlpha = 0;
    this._drawPlan = {
      passCount: 1,
      maxSegments: 8,
      outerGlowScale: 1,
      outerAlphaScale: 1,
      middleGlowScale: 1,
      middleAlphaScale: 1,
      coreGlowScale: 0.72,
      coreAlphaScale: 0.48
    };
    this._resolvedConfig = {
      enabled: DEFAULT_BALL_TRAIL.enabled,
      color: DEFAULT_COLOR,
      colorRgb: this._resolvedColor,
      length: DEFAULT_BALL_TRAIL.length,
      width: DEFAULT_BALL_TRAIL.width,
      glow: DEFAULT_BALL_TRAIL.glow,
      opacity: DEFAULT_BALL_TRAIL.opacity,
      turbulence: DEFAULT_BALL_TRAIL.turbulence,
      smoothing: DEFAULT_BALL_TRAIL.smoothing,
      progression: DEFAULT_BALL_TRAIL_PROGRESSION
    };
  }

  reset() {
    this.trails.clear();
    this._seenIds.clear();
  }

  _timeSeconds() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now() / 1000;
    }
    return Date.now() / 1000;
  }

  _resolveColorInto(baseConfig, progression, t) {
    parseColorInto(this._baseColor, baseConfig.color, DEFAULT_COLOR);
    parseColorInto(this._progressColor, progression?.color, this._baseColor.hex);
    if (!progression?.enabled || t <= 0.0001) {
      return this._baseColor;
    }
    if (t >= 0.9999) {
      return this._progressColor;
    }

    const r = Math.round(this._baseColor.r + (this._progressColor.r - this._baseColor.r) * t);
    const g = Math.round(this._baseColor.g + (this._progressColor.g - this._baseColor.g) * t);
    const b = Math.round(this._baseColor.b + (this._progressColor.b - this._baseColor.b) * t);
    const out = this._resolvedColor;
    out.hex = '';
    out.r = r;
    out.g = g;
    out.b = b;
    out.key = colorKey(r, g, b);
    return out;
  }

  _ensureAlphaStyles(color) {
    if (this._alphaStyleColorKey === color.key) return this._alphaStyles;
    this._alphaStyleColorKey = color.key;
    const prefix = `rgba(${color.r},${color.g},${color.b},`;
    for (let i = 0; i <= ALPHA_BUCKETS; i++) {
      this._alphaStyles[i] = prefix + ALPHA_SUFFIXES[i];
    }
    return this._alphaStyles;
  }

  _styleForAlpha(styles, alpha) {
    const index = alpha >= 1
      ? ALPHA_BUCKETS
      : (alpha <= 0 ? 0 : Math.round(alpha * ALPHA_BUCKETS));
    return styles[index];
  }

  _updateFromBalls(balls, config, time) {
    const seen = this._seenIds;
    seen.clear();
    if (!Array.isArray(balls)) return seen;
    for (const ball of balls) {
      if (!ball || !ball.active || ball.isLauncherBall || ball.isDebugDragBall) continue;
      const id = ball.id || `anon-${seen.size}`;
      seen.add(id);
      let trail = this.trails.get(id);
      if (!trail) {
        trail = new TrailBuffer(id);
        this.trails.set(id, trail);
      }
      trail.active = true;
      trail.push(ball.x, ball.y, time, config.smoothing);
    }
    return seen;
  }

  _pruneTrails(seen, time, maxAge) {
    for (const [id, trail] of this.trails) {
      trail.active = seen.has(id);
      if (!trail.active && time - trail.lastSeen > maxAge + 0.12) {
        this.trails.delete(id);
      }
    }
  }

  _drawPreparedPass(ctx, segmentCount, styles, glowScale, alphaScale, maxSegmentAlpha) {
    if (maxSegmentAlpha * alphaScale <= MIN_VISIBLE_ALPHA) return;

    const x0s = this._segX0;
    const y0s = this._segY0;
    const x1s = this._segX1;
    const y1s = this._segY1;
    const widths = this._segWidth;
    const alphas = this._segAlpha;
    let previousStyle = '';
    let previousWidth = -1;

    for (let i = 0; i < segmentCount; i++) {
      const alpha = alphas[i] * alphaScale;
      if (alpha <= MIN_VISIBLE_ALPHA) continue;

      const style = this._styleForAlpha(styles, alpha);
      if (style !== previousStyle) {
        ctx.strokeStyle = style;
        previousStyle = style;
      }

      const lineWidth = widths[i] * glowScale;
      if (Math.abs(lineWidth - previousWidth) > 0.01) {
        ctx.lineWidth = lineWidth;
        previousWidth = lineWidth;
      }

      ctx.beginPath();
      ctx.moveTo(x0s[i], y0s[i]);
      ctx.lineTo(x1s[i], y1s[i]);
      ctx.stroke();
    }
  }

  _drawPreparedSegments(ctx, segmentCount, color, plan, maxSegmentAlpha) {
    if (segmentCount <= 0) return;

    let maxAlphaScale = plan.coreAlphaScale;
    if (plan.passCount >= 2 && plan.middleAlphaScale > maxAlphaScale) maxAlphaScale = plan.middleAlphaScale;
    if (plan.passCount >= 3 && plan.outerAlphaScale > maxAlphaScale) maxAlphaScale = plan.outerAlphaScale;
    if (maxSegmentAlpha * maxAlphaScale <= MIN_VISIBLE_ALPHA) return;

    const styles = this._ensureAlphaStyles(color);

    if (plan.passCount >= 3) {
      this._drawPreparedPass(ctx, segmentCount, styles, plan.outerGlowScale, plan.outerAlphaScale, maxSegmentAlpha);
    }
    if (plan.passCount >= 2) {
      this._drawPreparedPass(ctx, segmentCount, styles, plan.middleGlowScale, plan.middleAlphaScale, maxSegmentAlpha);
    }
    this._drawPreparedPass(ctx, segmentCount, styles, plan.coreGlowScale, plan.coreAlphaScale, maxSegmentAlpha);
  }

  _prepareTrailSegments(trail, config, time, radius, plan, maxAge) {
    this._segmentMaxAlpha = 0;
    if (!trail || trail.count < 2) return 0;
    const maxSegments = plan.maxSegments;
    const newestIndex = trail.indexFromNewest(0);
    const newestAge = Math.max(0, time - trail.t[newestIndex]);
    const activeFade = trail.active ? 1 : Math.max(0, 1 - newestAge / Math.max(0.08, maxAge));
    if (activeFade <= MIN_VISIBLE_ALPHA) return 0;

    const baseWidth = radius * (1.05 + config.width * 1.45);
    const turbulence = config.turbulence * baseWidth * 0.42;
    const phase = trail.hash * Math.PI * 2 + time * (3.2 + config.turbulence * 2.4);
    const highest = Math.min(trail.count - 2, maxSegments - 1);
    const pointCount = highest + 2;
    let count = 0;
    let maxAlpha = 0;
    const pointXs = this._pointX;
    const pointYs = this._pointY;
    const lastPointOffset = trail.count - 1;

    for (let k = 0; k < pointCount; k++) {
      const index = trail.indexFromNewest(k);
      const prevIndex = trail.indexFromNewest(Math.min(lastPointOffset, k + 1));
      const nextIndex = trail.indexFromNewest(Math.max(0, k - 1));
      const dx = trail.x[nextIndex] - trail.x[prevIndex];
      const dy = trail.y[nextIndex] - trail.y[prevIndex];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const pointAge = Math.max(0, time - trail.t[index]);
      const pointT = Math.max(0, Math.min(1, Math.max(k / maxSegments, pointAge / maxAge)));
      const wobble = Math.sin(phase + k * 0.72 + pointT * 2.8) * turbulence * pointT;
      pointXs[k] = trail.x[index] + (-dy / len) * wobble;
      pointYs[k] = trail.y[index] + (dx / len) * wobble;
    }

    for (let n = highest; n >= 0; n--) {
      const olderIndex = trail.indexFromNewest(n + 1);
      const age = Math.max(0, time - trail.t[olderIndex]);
      if (age > maxAge) continue;
      const tailT = Math.max(n / maxSegments, age / maxAge);
      const fade = Math.pow(1 - Math.max(0, Math.min(1, tailT)), 1.62);

      this._segX0[count] = pointXs[n + 1];
      this._segY0[count] = pointYs[n + 1];
      this._segX1[count] = pointXs[n];
      this._segY1[count] = pointYs[n];
      this._segWidth[count] = baseWidth * (0.12 + fade * 0.88);
      const alpha = config.opacity * activeFade * fade;
      this._segAlpha[count] = alpha;
      if (alpha > maxAlpha) maxAlpha = alpha;
      count++;
    }

    this._segmentMaxAlpha = maxAlpha;
    return count;
  }

  _drawTrail(ctx, trail, config, time, radius, plan, maxAge) {
    const segmentCount = this._prepareTrailSegments(trail, config, time, radius, plan, maxAge);
    this._drawPreparedSegments(ctx, segmentCount, config.colorRgb, plan, this._segmentMaxAlpha);
  }

  _preparePreviewSegments(config, time, width, height, cameraY, plan) {
    this._segmentMaxAlpha = 0;
    const radius = 8.5;
    const cx = width * 0.5;
    const cy = cameraY + height * 0.5;
    const angle = Math.PI * 0.58;
    const speed = 7.5;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const normalX = -vy / speed;
    const normalY = vx / speed;
    const baseWidth = radius * (1.05 + config.width * 1.45);
    const maxSegments = plan.maxSegments;
    const spacing = 5.4 + config.length * 1.7;
    const turbulence = config.turbulence * baseWidth * 0.46;
    const phase = time * (3.6 + config.turbulence * 2.2);
    let count = 0;
    let maxAlpha = 0;
    const pointXs = this._pointX;
    const pointYs = this._pointY;

    for (let k = 0; k <= maxSegments; k++) {
      const tailT = k / maxSegments;
      const wobble = Math.sin(phase + k * 0.56) * turbulence * tailT;
      pointXs[k] = cx - vx * spacing * k + normalX * wobble;
      pointYs[k] = cy - vy * spacing * k + normalY * wobble;
    }

    for (let n = maxSegments - 1; n >= 0; n--) {
      const tailT0 = (n + 1) / maxSegments;
      const fade = Math.pow(1 - tailT0, 1.55);
      this._segX0[count] = pointXs[n + 1];
      this._segY0[count] = pointYs[n + 1];
      this._segX1[count] = pointXs[n];
      this._segY1[count] = pointYs[n];
      this._segWidth[count] = baseWidth * (0.12 + fade * 0.9);
      const alpha = config.opacity * fade;
      this._segAlpha[count] = alpha;
      if (alpha > maxAlpha) maxAlpha = alpha;
      count++;
    }

    this._segmentMaxAlpha = maxAlpha;
    return count;
  }

  _drawPreview(ctx, config, time, width, height, cameraY, plan) {
    const segmentCount = this._preparePreviewSegments(config, time, width, height, cameraY, plan);
    this._drawPreparedSegments(ctx, segmentCount, config.colorRgb, plan, this._segmentMaxAlpha);
    return null;
  }

  _resolveConfig(baseConfig, progressBlend) {
    const progression = baseConfig.progression || DEFAULT_BALL_TRAIL_PROGRESSION;
    const hasProgression = !!(baseConfig.enabled && progression.enabled);
    const t = hasProgression ? Math.max(0, Math.min(1, Number.isFinite(progressBlend) ? progressBlend : 0)) : 0;
    const out = this._resolvedConfig;
    out.enabled = baseConfig.enabled;
    out.color = baseConfig.color;
    out.colorRgb = this._resolveColorInto(baseConfig, progression, t);
    out.length = hasProgression ? baseConfig.length + (progression.length - baseConfig.length) * t : baseConfig.length;
    out.width = hasProgression ? baseConfig.width + (progression.width - baseConfig.width) * t : baseConfig.width;
    out.glow = hasProgression ? baseConfig.glow + (progression.glow - baseConfig.glow) * t : baseConfig.glow;
    out.opacity = hasProgression ? baseConfig.opacity + (progression.opacity - baseConfig.opacity) * t : baseConfig.opacity;
    out.turbulence = hasProgression ? baseConfig.turbulence + (progression.turbulence - baseConfig.turbulence) * t : baseConfig.turbulence;
    out.smoothing = hasProgression ? baseConfig.smoothing + (progression.smoothing - baseConfig.smoothing) * t : baseConfig.smoothing;
    out.progression = progression;
    return out;
  }

  render(ctx, rawConfig, state, progressBlend = 0, viewportWidth = 400, viewportHeight = 600, ballRadius = 8.5, performanceProfile = 'balanced') {
    const baseConfig = rawConfig && typeof rawConfig === 'object' && rawConfig.progression
      ? rawConfig
      : normalizeBallTrailConfig(rawConfig);
    if (!baseConfig.enabled) {
      this.reset();
      return null;
    }

    const config = this._resolveConfig(baseConfig, progressBlend);
    const time = this._timeSeconds();
    const maxAge = 0.14 + config.length * 0.34;
    const radius = Number.isFinite(ballRadius) ? ballRadius : 8.5;

    if (state?.ballTrailPreview) {
      const plan = resolveDrawPlanInto(this._drawPlan, config, 1, performanceProfile, 16 + config.length * 26);
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'lighter';
      const previewBall = this._drawPreview(
        ctx,
        config,
        time,
        Number.isFinite(viewportWidth) ? viewportWidth : 400,
        Number.isFinite(viewportHeight) ? viewportHeight : 600,
        Number.isFinite(state?.cameraY) ? state.cameraY : 0,
        plan
      );
      ctx.restore();
      return previewBall;
    }

    const seen = this._updateFromBalls(state?.balls, config, time);
    this._pruneTrails(seen, time, maxAge);
    const plan = resolveDrawPlanInto(this._drawPlan, config, Math.max(1, this.trails.size), performanceProfile, 12 + config.length * 24);
    if (this.trails.size === 0) return null;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    for (const trail of this.trails.values()) {
      this._drawTrail(ctx, trail, config, time, radius, plan, maxAge);
    }
    ctx.restore();
    return null;
  }
}
