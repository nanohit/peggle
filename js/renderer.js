// Peggle Renderer - Canvas rendering for game and editor

import { PHYSICS_CONFIG, getBallRadius } from './physics.js';
import { LiquidBackground } from './liquid-background.js';
import {
  BallTrailRenderer,
  normalizeBallTrailConfig,
  normalizeTrailPerformanceProfile
} from './ball-trail.js';
import {
  ShockwaveEffectRenderer,
  normalizeShockwaveConfig
} from './shockwave-effect.js';
import { getPortalScale, isPortalType } from './portal-defaults.js';

// Color palette
const COLORS = {
  background: '#1a1a2e',
  backgroundGradientTop: '#16213e',
  backgroundGradientBottom: '#1a1a2e',
  
  // Peg colors
  orange: '#ff6b35',
  orangeHit: '#ffb347',
  orangeGlow: 'rgba(255, 107, 53, 0.5)',

  billiardRed: '#e84d4d',
  billiardRedHit: '#ff9a94',
  billiardRedGlow: 'rgba(232, 77, 77, 0.42)',

  billiardYellow: '#ffd447',
  billiardYellowHit: '#fff0a1',
  billiardYellowGlow: 'rgba(255, 212, 71, 0.42)',
  
  blue: '#4ecdc4',
  blueHit: '#7ee8e2',
  blueGlow: 'rgba(78, 205, 196, 0.4)',
  
  green: '#95d5b2',
  greenHit: '#b7e4c7',
  greenGlow: 'rgba(149, 213, 178, 0.4)',
  
  purple: '#c77dff',
  purpleHit: '#e0aaff',
  purpleGlow: 'rgba(199, 125, 255, 0.4)',

  // Multiball
  multi: '#ff4d9d',
  multiHit: '#ff7ab8',
  multiGlow: 'rgba(255, 77, 157, 0.5)',

  // Survival spin currency
  gamble: '#8cff00',
  gambleHit: '#dfff8a',
  gambleGlow: 'rgba(140, 255, 0, 0.55)',
  
  // Obstacle
  obstacle: '#6b7280',
  obstacleGlow: 'rgba(107, 114, 128, 0.3)',

  // Bumper
  bumper: '#e0e0e0',
  bumperHit: '#ffffff',
  bumperGlow: 'rgba(224, 224, 224, 0.5)',
  bumperRing: '#a0a0a0',

  // Portals
  portalBlue: '#4ecdc4',
  portalBlueGlow: 'rgba(78, 205, 196, 0.5)',
  portalOrange: '#ff8b3d',
  portalOrangeGlow: 'rgba(255, 139, 61, 0.5)',
  
  // Ball
  ball: '#f8f9fa',
  ballGlow: 'rgba(248, 249, 250, 0.6)',
  
  // UI
  launcher: '#adb5bd',
  launcherAim: 'rgba(255, 255, 255, 0.4)',
  trajectoryLine: 'rgba(255, 255, 255, 0.3)',
  trajectoryDot: 'rgba(255, 255, 255, 0.5)',
  yoyoThreadGlow: 'rgba(255, 255, 255, 0.22)',
  yoyoThreadCore: 'rgba(248, 250, 255, 0.96)',
  bucket: '#6c757d',
  bucketInner: '#495057',
  
  // Flippers
  flipper: '#c0c0c0',
  flipperPivot: '#555555',

  // Grid
  gridLine: 'rgba(255, 255, 255, 0.08)',
  gridLineStrong: 'rgba(255, 255, 255, 0.15)',
  
  // Selection
  selection: '#ffd60a',
  selectionFill: 'rgba(255, 214, 10, 0.15)',
  
  // Text
  text: '#f8f9fa',
  textDim: '#adb5bd',
  
  // Walls
  wall: 'rgba(255, 255, 255, 0.1)'
};

const PEG_COLORS = {
  orange: { main: COLORS.orange, hit: COLORS.orangeHit, glow: COLORS.orangeGlow },
  billiardRed: { main: COLORS.billiardRed, hit: COLORS.billiardRedHit, glow: COLORS.billiardRedGlow },
  billiardYellow: { main: COLORS.billiardYellow, hit: COLORS.billiardYellowHit, glow: COLORS.billiardYellowGlow },
  blue: { main: COLORS.blue, hit: COLORS.blueHit, glow: COLORS.blueGlow },
  green: { main: COLORS.green, hit: COLORS.greenHit, glow: COLORS.greenGlow },
  purple: { main: COLORS.purple, hit: COLORS.purpleHit, glow: COLORS.purpleGlow },
  multi: { main: COLORS.multi, hit: COLORS.multiHit, glow: COLORS.multiGlow },
  gamble: { main: COLORS.gamble, hit: COLORS.gambleHit, glow: COLORS.gambleGlow },
  obstacle: { main: COLORS.obstacle, hit: COLORS.obstacle, glow: COLORS.obstacleGlow },
  bumper: { main: COLORS.bumper, hit: COLORS.bumperHit, glow: COLORS.bumperGlow },
  portalBlue: { main: COLORS.portalBlue, hit: COLORS.portalBlue, glow: COLORS.portalBlueGlow },
  portalOrange: { main: COLORS.portalOrange, hit: COLORS.portalOrange, glow: COLORS.portalOrangeGlow }
};

const PEG_SURFACE_STYLES = {
  orange: {
    bright: '#ffd7a0',
    light: '#ff9230',
    main: '#ff6b35',
    deep: '#b83712',
    shadow: '#571607',
    rimLight: 'rgba(255, 147, 48, 0.96)',
    line: 'rgba(255, 184, 84, 0.48)',
    core: 'rgba(255, 111, 36, 0.5)',
    glow: 'rgba(255, 91, 15, 0.32)',
    hitBright: '#fff1bc',
    hitLight: '#ffbd4c',
    hitMain: '#ff8b24'
  },
  billiardRed: {
    bright: '#ffe1df',
    light: '#ff8b82',
    main: '#e84d4d',
    deep: '#9a151b',
    shadow: '#42070b',
    rimLight: 'rgba(255, 159, 151, 0.94)',
    line: 'rgba(255, 210, 205, 0.44)',
    core: 'rgba(244, 82, 76, 0.44)',
    glow: 'rgba(232, 77, 77, 0.26)',
    hitBright: '#ffffff',
    hitLight: '#ffc1bc',
    hitMain: '#ff746c'
  },
  billiardYellow: {
    bright: '#fff7bd',
    light: '#ffe16a',
    main: '#ffd447',
    deep: '#b57b0d',
    shadow: '#4c2b04',
    rimLight: 'rgba(255, 244, 151, 0.94)',
    line: 'rgba(255, 252, 210, 0.44)',
    core: 'rgba(255, 213, 75, 0.44)',
    glow: 'rgba(255, 212, 71, 0.24)',
    hitBright: '#ffffff',
    hitLight: '#fff1a8',
    hitMain: '#ffe16a'
  },
  blue: {
    bright: '#d7fffb',
    light: '#7df4ed',
    main: '#4ecdc4',
    deep: '#168178',
    shadow: '#07323b',
    rimLight: 'rgba(142, 255, 247, 0.9)',
    line: 'rgba(202, 255, 250, 0.42)',
    core: 'rgba(95, 230, 222, 0.45)',
    glow: 'rgba(78, 205, 196, 0.3)',
    hitBright: '#ffffff',
    hitLight: '#a5fff8',
    hitMain: '#6ee2db'
  },
  green: {
    bright: '#f0fff4',
    light: '#c3f7d7',
    main: '#95d5b2',
    deep: '#4b9a6d',
    shadow: '#163927',
    rimLight: 'rgba(209, 255, 222, 0.88)',
    line: 'rgba(237, 255, 232, 0.4)',
    core: 'rgba(178, 235, 198, 0.43)',
    glow: 'rgba(149, 213, 178, 0.27)',
    hitBright: '#ffffff',
    hitLight: '#d9ffe5',
    hitMain: '#afe6c3'
  },
  purple: {
    bright: '#f6e6ff',
    light: '#dfadff',
    main: '#c77dff',
    deep: '#8037bd',
    shadow: '#32114f',
    rimLight: 'rgba(229, 186, 255, 0.9)',
    line: 'rgba(247, 224, 255, 0.4)',
    core: 'rgba(203, 130, 255, 0.42)',
    glow: 'rgba(199, 125, 255, 0.28)',
    hitBright: '#ffffff',
    hitLight: '#eecaff',
    hitMain: '#d99aff'
  },
  multi: {
    bright: '#ffe0f0',
    light: '#ff8cc5',
    main: '#ff4d9d',
    deep: '#b91f6d',
    shadow: '#4e0a2c',
    rimLight: 'rgba(255, 165, 207, 0.92)',
    line: 'rgba(255, 224, 240, 0.42)',
    core: 'rgba(255, 93, 168, 0.44)',
    glow: 'rgba(255, 77, 157, 0.3)',
    hitBright: '#ffffff',
    hitLight: '#ffadd2',
    hitMain: '#ff70b3'
  },
  gamble: {
    bright: '#f6ffd6',
    light: '#cfff5c',
    main: '#8cff00',
    deep: '#4d9a00',
    shadow: '#173900',
    rimLight: 'rgba(219, 255, 114, 0.9)',
    line: 'rgba(245, 255, 198, 0.42)',
    core: 'rgba(162, 255, 36, 0.45)',
    glow: 'rgba(140, 255, 0, 0.28)',
    hitBright: '#ffffff',
    hitLight: '#e5ff99',
    hitMain: '#b5ff3c'
  },
  obstacle: {
    bright: '#e8edf5',
    light: '#aab3c2',
    main: '#6b7280',
    deep: '#3e4654',
    shadow: '#171b23',
    rimLight: 'rgba(220, 226, 236, 0.72)',
    line: 'rgba(236, 241, 248, 0.28)',
    core: 'rgba(160, 170, 186, 0.25)',
    glow: 'rgba(107, 114, 128, 0.18)',
    hitBright: '#f4f7fb',
    hitLight: '#c5ccd8',
    hitMain: '#8b94a3'
  }
};

const GLOW_CACHE_LIMIT = 128;
const END_MESSAGE_DELAY_MS = 160;
const END_MESSAGE_FADE_IN_MS = 260;
const END_MESSAGE_FADE_OUT_MS = 190;
const END_MESSAGE_LIFT_PX = 18;
const PEG_EXIT_SHRINK_MS = 180;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.baseCtx = this.ctx;
    this.width = canvas.width;
    this.height = canvas.height;

    // Editor state
    this.showGrid = false;
    this.gridSize = 20;
    this.selectedPegIds = new Set();

    // Aim state
    this.aimAngle = Math.PI / 2;
    this.showAim = false;
    this.launchX = 0;
    this.launchY = 40;

    // Configurable background (set via setBackground)
    this.backgroundConfig = null;
    this._bgBaseCanvas = null;
    this._bgBaseDirty = true;
    this._bgBaseKey = '';
    this._bgOverlayCanvas = null;
    this._bgOverlayDirty = true;
    this._bgOverlayKey = '';
    this._bgVignetteCanvas = null;
    this._bgVignetteDirty = true;
    this._bgVignetteKey = '';
    this._bgImage = null;
    this._bgImageSrc = '';
    this._bgProgressImage = null;
    this._bgProgressImageSrc = '';
    this._bgBlendTarget = 0;
    this._bgBlendDisplayed = 0;
    this._liquidBackground = new LiquidBackground();
    this._ballTrail = new BallTrailRenderer();
    this.ballTrailConfig = normalizeBallTrailConfig(null);
    this._shockwaveEffect = new ShockwaveEffectRenderer();
    this.shockwaveConfig = normalizeShockwaveConfig(null);
    this._shockwaveLayerCanvas = null;
    this._foregroundCanvas = null;
    this._foregroundCtx = null;
    this._renderLayerHost = null;
    this._renderLayerHostReady = false;
    this._layerLayoutState = new WeakMap();
    this._layerVisibility = new WeakMap();
    this._displaySizeScratch = { width: '', height: '' };
    this._shockwaveLayerVisible = false;
    this._disposed = false;
    this._shockwavePrewarmKey = '';
    this._shockwavePrewarmHandle = null;
    this._shockwavePrewarmHandleType = '';
    this.performanceProfile = 'balanced';
    this._survivalBgImage = null;
    this._survivalBgImageSrc = '';
    this._pegExitAnimations = new Map();
    this.onVerticalProgress = null;
    this._endMessage = {
      key: '',
      text: '',
      subtext: '',
      phase: 'hidden',
      elapsedMs: 0,
      alpha: 0,
      fadeOutStartAlpha: 1,
      dismissCallbacks: [],
      dismissedKey: ''
    };

    // Glow sprite cache: pre-rendered blur effects stamped via drawImage()
    // instead of per-frame ctx.shadowBlur (which is software-rasterized on
    // Chrome/Safari and extremely slow).
    this._glowCache = new Map();

    // Bucket image asset
    this._bucketImg = null;
    const bucketImg = new Image();
    bucketImg.onload = () => { this._bucketImg = bucketImg; };
    bucketImg.src = 'visuals/bucket.webp';

    this._billiardCannonImages = {
      top: null,
      circle: null
    };
    const billiardTopImg = new Image();
    billiardTopImg.onload = () => { this._billiardCannonImages.top = billiardTopImg; };
    billiardTopImg.src = 'visuals/assets_webtp/top.webp';
    const billiardCircleImg = new Image();
    billiardCircleImg.onload = () => { this._billiardCannonImages.circle = billiardCircleImg; };
    billiardCircleImg.src = 'visuals/assets_webtp/character_circle.webp';
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.launchX = width / 2;
    this._bgBaseDirty = true;
    this._bgOverlayDirty = true;
    this._bgVignetteDirty = true;
    this._shockwavePrewarmKey = '';
    this._syncRenderLayers();
  }

  getEndOverlayInteractDelayMs() {
    return END_MESSAGE_DELAY_MS + Math.round(END_MESSAGE_FADE_IN_MS * 0.72);
  }

  getEndOverlayFadeOutMs() {
    return END_MESSAGE_FADE_OUT_MS;
  }

  dismissEndOverlay(onComplete) {
    const message = this._endMessage;
    if (!message.key || message.phase === 'hidden') {
      if (typeof onComplete === 'function') onComplete();
      return false;
    }
    if (typeof onComplete === 'function') {
      message.dismissCallbacks.push(onComplete);
    }
    if (message.phase !== 'fadeOut') {
      message.phase = 'fadeOut';
      message.elapsedMs = 0;
      message.fadeOutStartAlpha = Math.max(0, Math.min(1, message.alpha));
    }
    return true;
  }

  // --- Glow sprite cache ---
  // Returns { img, half } for circle glows.
  // The img is an offscreen canvas with the blur pre-rendered once.
  _touchGlowCache(key) {
    const entry = this._glowCache.get(key);
    if (!entry) return null;
    this._glowCache.delete(key);
    this._glowCache.set(key, entry);
    return entry;
  }

  _storeGlowCache(key, entry) {
    if (this._glowCache.has(key)) {
      this._glowCache.delete(key);
    }
    this._glowCache.set(key, entry);
    while (this._glowCache.size > GLOW_CACHE_LIMIT) {
      const oldestKey = this._glowCache.keys().next().value;
      if (oldestKey === undefined) break;
      this._glowCache.delete(oldestKey);
    }
    return entry;
  }

  _circleGlow(color, radius, blur, keyStep = 0) {
    const drawRadius = keyStep > 0 ? Math.round(radius / keyStep) * keyStep : radius;
    const key = `c|${color}|${drawRadius}|${blur}|${keyStep}`;
    let e = this._touchGlowCache(key);
    if (e) return e;
    const margin = Math.ceil(blur * 1.5) + 2;
    const size = Math.ceil((drawRadius + margin) * 2);
    const oc = document.createElement('canvas');
    oc.width = size; oc.height = size;
    const g = oc.getContext('2d');
    const c = size / 2;
    g.shadowColor = color;
    g.shadowBlur = blur;
    g.fillStyle = color;
    g.beginPath();
    g.arc(c, c, drawRadius, 0, Math.PI * 2);
    g.fill();
    e = { img: oc, half: c };
    return this._storeGlowCache(key, e);
  }

  // Returns { img, hw, hh } for rect glows.
  _rectGlow(color, w, h, blur, cr) {
    const rw = Math.round(w);
    const rh = Math.round(h);
    const key = `r|${color}|${rw}|${rh}|${blur}|${cr || 0}`;
    let e = this._touchGlowCache(key);
    if (e) return e;
    const margin = Math.ceil(blur * 1.5) + 2;
    const cw = rw + margin * 2;
    const ch = rh + margin * 2;
    const oc = document.createElement('canvas');
    oc.width = cw; oc.height = ch;
    const g = oc.getContext('2d');
    g.shadowColor = color;
    g.shadowBlur = blur;
    g.fillStyle = color;
    g.beginPath();
    g.roundRect((cw - rw) / 2, (ch - rh) / 2, rw, rh, cr || 0);
    g.fill();
    e = { img: oc, hw: cw / 2, hh: ch / 2 };
    return this._storeGlowCache(key, e);
  }

  // Line glow for portals: thick blurred stroke cached as sprite.
  _lineGlow(color, halfLen, lineWidth, blur) {
    const hl = Math.round(halfLen);
    const lw = Math.round(lineWidth * 10) / 10;
    const key = `l|${color}|${hl}|${lw}|${blur}`;
    let e = this._touchGlowCache(key);
    if (e) return e;
    const margin = Math.ceil(blur * 1.5) + 2;
    const cw = Math.ceil(hl * 2 + margin * 2);
    const ch = Math.ceil(lw + margin * 2);
    const oc = document.createElement('canvas');
    oc.width = cw; oc.height = ch;
    const g = oc.getContext('2d');
    g.shadowColor = color;
    g.shadowBlur = blur;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(margin, ch / 2);
    g.lineTo(cw - margin, ch / 2);
    g.stroke();
    e = { img: oc, hw: cw / 2, hh: ch / 2 };
    return this._storeGlowCache(key, e);
  }

  // Cached bumper body: ring + radial gradient + specular glare.
  _bumperBodySprite(r, ringColor, bodyColorOuter, bodyColorMid) {
    const rr = Math.round(r * 10) / 10;
    const key = `b|${rr}|${ringColor}|${bodyColorOuter}|${bodyColorMid}`;
    let e = this._touchGlowCache(key);
    if (e) return e;
    const pad = 2;
    const size = Math.ceil((rr + pad) * 2);
    const oc = document.createElement('canvas');
    oc.width = size; oc.height = size;
    const g = oc.getContext('2d');
    const c = size / 2;
    // Outer ring
    g.beginPath();
    g.arc(c, c, rr, 0, Math.PI * 2);
    g.fillStyle = ringColor;
    g.fill();
    // Inner gradient body
    const innerR = rr * 0.7;
    const grad = g.createRadialGradient(c, c, 0, c, c, innerR);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.4, bodyColorMid);
    grad.addColorStop(1, bodyColorOuter);
    g.beginPath();
    g.arc(c, c, innerR, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    // Specular glare
    g.beginPath();
    g.arc(c, c, innerR * 0.3, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.45)';
    g.fill();
    e = { img: oc, half: c };
    return this._storeGlowCache(key, e);
  }

  _getPegSurfaceStyle(type) {
    return PEG_SURFACE_STYLES[type] || null;
  }

  _pegSurfaceColors(style, isHit = false) {
    return {
      bright: isHit ? (style.hitBright || style.bright) : style.bright,
      light: isHit ? (style.hitLight || style.light) : style.light,
      main: isHit ? (style.hitMain || style.main) : style.main,
      deep: style.deep,
      shadow: style.shadow,
      rimLight: style.rimLight,
      line: style.line,
      core: isHit ? (style.hitCore || style.core) : style.core,
      glow: isHit ? (style.hitGlow || style.glow) : style.glow
    };
  }

  _pegBodySprite(type, r, isHit = false) {
    const style = this._getPegSurfaceStyle(type);
    if (!style) return null;

    const rr = Math.round(r * 10) / 10;
    const key = `pbody|${type}|${rr}|${isHit ? 1 : 0}`;
    let e = this._touchGlowCache(key);
    if (e) return e;

    const colors = this._pegSurfaceColors(style, isHit);
    const pad = 2;
    const size = Math.ceil((rr + pad) * 2);
    const oc = document.createElement('canvas');
    oc.width = size;
    oc.height = size;
    const g = oc.getContext('2d');
    const c = size / 2;
    const tau = Math.PI * 2;

    g.beginPath();
    g.arc(c, c, rr, 0, tau);
    g.fillStyle = colors.shadow;
    g.fill();

    const body = g.createRadialGradient(
      c - rr * 0.33,
      c - rr * 0.36,
      rr * 0.08,
      c + rr * 0.08,
      c + rr * 0.1,
      rr
    );
    body.addColorStop(0, colors.bright);
    body.addColorStop(0.18, colors.light);
    body.addColorStop(0.5, colors.main);
    body.addColorStop(0.76, colors.deep);
    body.addColorStop(1, colors.deep);
    g.beginPath();
    g.arc(c, c, rr, 0, tau);
    g.fillStyle = body;
    g.fill();

    const core = g.createRadialGradient(c + rr * 0.08, c + rr * 0.03, 0, c + rr * 0.05, c + rr * 0.06, rr * 0.74);
    core.addColorStop(0, colors.core);
    core.addColorStop(0.34, colors.core);
    core.addColorStop(1, 'rgba(255, 112, 8, 0)');
    g.beginPath();
    g.arc(c, c, rr * 0.74, 0, tau);
    g.fillStyle = core;
    g.fill();

    g.save();
    g.beginPath();
    g.arc(c, c, rr * 0.79, 0, tau);
    g.clip();
    g.beginPath();
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const a = -0.65 + t * Math.PI * 5.45;
      const sr = rr * (0.07 + t * 0.55);
      const x = c + Math.cos(a) * sr * 1.06;
      const y = c + Math.sin(a) * sr * 0.86;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = colors.line;
    g.lineWidth = Math.max(0.55, rr * 0.055);
    g.lineCap = 'round';
    g.stroke();
    g.restore();

    g.beginPath();
    g.arc(c, c, rr * 0.68, 0.2, Math.PI * 1.86);
    g.strokeStyle = colors.line;
    g.lineWidth = Math.max(0.65, rr * 0.07);
    g.stroke();

    const rimWidth = Math.max(1.05, rr * 0.16);
    g.beginPath();
    g.arc(c, c, rr - rimWidth * 0.5, Math.PI * 0.12, Math.PI * 0.95);
    g.strokeStyle = colors.shadow;
    g.lineWidth = rimWidth;
    g.stroke();

    g.beginPath();
    g.arc(c, c, rr - rimWidth * 0.5, Math.PI * 1.12, Math.PI * 1.78);
    g.strokeStyle = colors.rimLight;
    g.lineWidth = Math.max(0.95, rr * 0.13);
    g.stroke();

    g.save();
    g.translate(c - rr * 0.34, c - rr * 0.36);
    g.rotate(-0.5);
    g.beginPath();
    g.ellipse(0, 0, rr * 0.27, rr * 0.12, 0, 0, tau);
    g.fillStyle = isHit ? 'rgba(255, 255, 255, 0.92)' : 'rgba(255, 255, 245, 0.72)';
    g.fill();
    g.beginPath();
    g.ellipse(rr * 0.14, rr * 0.18, rr * 0.13, rr * 0.055, 0, 0, tau);
    g.fillStyle = 'rgba(255, 255, 255, 0.45)';
    g.fill();
    g.restore();

    g.beginPath();
    g.arc(c, c, rr - 0.45, 0, tau);
    g.strokeStyle = colors.rimLight;
    g.lineWidth = Math.max(0.75, rr * 0.085);
    g.stroke();

    e = { img: oc, half: c };
    return this._storeGlowCache(key, e);
  }

  _brickPegBodySprite(type, w, h, isHit = false) {
    const style = this._getPegSurfaceStyle(type);
    if (!style) return null;

    const ww = Math.round(w * 10) / 10;
    const hh = Math.round(h * 10) / 10;
    const key = `bbody|${type}|${ww}|${hh}|${isHit ? 1 : 0}`;
    let e = this._touchGlowCache(key);
    if (e) return e;

    const colors = this._pegSurfaceColors(style, isHit);
    const cr = Math.max(2, Math.min(5, hh * 0.42));
    const pad = 2;
    const cw = Math.ceil(ww + pad * 2);
    const ch = Math.ceil(hh + pad * 2);
    const oc = document.createElement('canvas');
    oc.width = cw;
    oc.height = ch;
    const g = oc.getContext('2d');
    const x = pad;
    const y = pad;

    g.beginPath();
    g.roundRect(x, y, ww, hh, cr);
    g.fillStyle = colors.shadow;
    g.fill();

    const inset = Math.max(1.15, hh * 0.15);
    const ix = x + inset;
    const iy = y + inset;
    const iw = Math.max(1, ww - inset * 2);
    const ih = Math.max(1, hh - inset * 2);
    g.beginPath();
    g.roundRect(ix, iy, iw, ih, Math.max(1, cr - inset));
    g.fillStyle = colors.main;
    g.fill();

    g.save();
    g.beginPath();
    g.roundRect(ix, iy, iw, ih, Math.max(1, cr - inset));
    g.clip();

    g.beginPath();
    g.moveTo(ix + iw * 0.12, iy + ih * 0.28);
    g.lineTo(ix + iw * 0.76, iy + ih * 0.22);
    g.strokeStyle = colors.line;
    g.lineWidth = Math.max(0.8, hh * 0.12);
    g.lineCap = 'round';
    g.stroke();

    g.beginPath();
    g.moveTo(ix + iw * 0.18, iy + ih * 0.24);
    g.lineTo(ix + iw * 0.36, iy + ih * 0.22);
    g.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    g.lineWidth = Math.max(0.55, hh * 0.07);
    g.lineCap = 'round';
    g.stroke();
    g.restore();

    g.beginPath();
    g.roundRect(x + 0.5, y + 0.5, ww - 1, hh - 1, cr);
    g.strokeStyle = colors.rimLight;
    g.lineWidth = Math.max(0.75, hh * 0.1);
    g.stroke();

    g.beginPath();
    g.moveTo(ix + iw * 0.12, iy + ih * 0.82);
    g.lineTo(ix + iw * 0.88, iy + ih * 0.82);
    g.strokeStyle = colors.deep;
    g.lineWidth = Math.max(0.7, hh * 0.12);
    g.stroke();

    e = { img: oc, hw: cw / 2, hh: ch / 2 };
    return this._storeGlowCache(key, e);
  }

  setBackground(config) {
    this.backgroundConfig = config || null;
    this._bgBaseDirty = true;
    this._bgOverlayDirty = true;
    this._bgVignetteDirty = true;
    this._bgBlendTarget = 0;
    this._bgBlendDisplayed = 0;
    this._loadBackgroundAsset(config?.type === 'image' ? config.image : null, '_bgImage', '_bgImageSrc', '_bgBaseDirty');
    this._loadBackgroundAsset(this._hasProgressionBackground(config) ? config.progressionImage : null, '_bgProgressImage', '_bgProgressImageSrc', '_bgOverlayDirty');
    if (config?.type !== 'liquid') {
      this._liquidBackground.reset();
    }
  }

  setBallTrail(config) {
    this.ballTrailConfig = normalizeBallTrailConfig(config);
    if (!this.ballTrailConfig.enabled) {
      this._ballTrail.reset();
    }
  }

  setShockwave(config) {
    this.shockwaveConfig = normalizeShockwaveConfig(config);
    this._shockwaveEffect.setConfig(this.shockwaveConfig);
    this._shockwavePrewarmKey = '';
    if (!this.shockwaveConfig.enabled) {
      this._detachShockwaveLayer();
    }
  }

  setPerformanceProfile(profile) {
    const nextProfile = normalizeTrailPerformanceProfile(profile);
    if (nextProfile !== this.performanceProfile) {
      this.performanceProfile = nextProfile;
      this._shockwavePrewarmKey = '';
    }
  }

  _loadBackgroundAsset(src, imageProp, srcProp, dirtyProp) {
    if (!src) {
      this[srcProp] = '';
      this[imageProp] = null;
      this[dirtyProp] = true;
      return;
    }
    if (this[srcProp] === src) return;

    this[srcProp] = src;
    this[imageProp] = null;
    this[dirtyProp] = true;

    const img = new Image();
    img.onload = () => {
      if (this[srcProp] !== src) return;
      this[imageProp] = img;
      this[dirtyProp] = true;
    };
    img.onerror = () => {
      if (this[srcProp] !== src) return;
      this[imageProp] = null;
      this[dirtyProp] = true;
    };
    img.src = src;
  }

  _hasProgressionBackground(bg = this.backgroundConfig) {
    return !!(bg && bg.type === 'image' && typeof bg.progressionImage === 'string' && bg.progressionImage);
  }

  _hasLiquidProgression(bg = this.backgroundConfig) {
    if (!bg || bg.type !== 'liquid') return false;
    const progression = bg.liquid?.progression;
    if (!progression || typeof progression !== 'object') return false;
    return Object.values(progression).some(value => value !== null && value !== undefined && value !== '');
  }

  _hasBallTrailProgression() {
    return !!(this.ballTrailConfig?.enabled && this.ballTrailConfig.progression?.enabled);
  }

  _ensureBackgroundCanvas(prop) {
    if (!this[prop] || this[prop].width !== this.width || this[prop].height !== this.height) {
      this[prop] = document.createElement('canvas');
      this[prop].width = this.width;
      this[prop].height = this.height;
    }
    return this[prop];
  }

  _ensureLayerHost() {
    if (typeof document === 'undefined') return null;
    const host = this.canvas.parentElement;
    if (!host) return null;

    if (this._renderLayerHost !== host) {
      this._renderLayerHost = host;
      this._renderLayerHostReady = false;
    }

    if (!this._renderLayerHostReady) {
      if (typeof getComputedStyle === 'function' && getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
      }
      if (!this.canvas.style.position) this.canvas.style.position = 'relative';
      if (this.canvas.style.zIndex !== '1') this.canvas.style.zIndex = '1';
      this._renderLayerHostReady = true;
    }

    return host;
  }

  _ensureRenderLayers() {
    const host = this._ensureLayerHost();
    if (!host) return false;

    if (!this._foregroundCanvas) {
      this._foregroundCanvas = document.createElement('canvas');
      this._foregroundCanvas.className = 'game-foreground-layer';
      this._foregroundCanvas.setAttribute('aria-hidden', 'true');
      this._foregroundCtx = this._foregroundCanvas.getContext('2d');
    }
    if (this._foregroundCanvas.parentElement !== host) {
      host.appendChild(this._foregroundCanvas);
    }

    this._applyLayerLayout(this._foregroundCanvas, 3);
    this._applyLayerVisibility(this._foregroundCanvas, true);
    return !!this._foregroundCtx;
  }

  _ensureShockwaveLayer() {
    if (this.shockwaveConfig?.enabled === false) return false;
    const host = this._ensureLayerHost();
    if (!host) return false;

    const shockwaveCanvas = this._shockwaveEffect.getCanvas();
    if (!shockwaveCanvas) return false;

    if (this._shockwaveLayerCanvas !== shockwaveCanvas) {
      this._shockwaveLayerCanvas = shockwaveCanvas;
      this._layerLayoutState.delete(shockwaveCanvas);
      this._layerVisibility.delete(shockwaveCanvas);
    }
    if (shockwaveCanvas.parentElement !== host) {
      host.appendChild(shockwaveCanvas);
      this._layerLayoutState.delete(shockwaveCanvas);
    }

    this._applyLayerLayout(shockwaveCanvas, 2);
    return true;
  }

  _detachShockwaveLayer() {
    const canvas = this._shockwaveLayerCanvas;
    this._shockwaveLayerVisible = false;
    if (!canvas) return;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    this._layerLayoutState.delete(canvas);
    this._layerVisibility.delete(canvas);
    this._shockwaveLayerCanvas = null;
  }

  _displayCanvasSize() {
    const size = this._displaySizeScratch;
    // Keep the render path layout-read free. The app writes explicit CSS sizes
    // during resize; the canvas backing size is the safe fallback for tests/SSR.
    size.width = this.canvas.style.width || `${Math.max(1, Math.round(this.canvas.width || this.width))}px`;
    size.height = this.canvas.style.height || `${Math.max(1, Math.round(this.canvas.height || this.height))}px`;
    return size;
  }

  _applyLayerLayout(canvas, zIndex) {
    if (!canvas) return;
    const display = this._displayCanvasSize();
    const displayWidth = display.width;
    const displayHeight = display.height;
    const baseTransform = this.canvas.style.transform || '';
    const transform = `translate(-50%, -50%)${baseTransform ? ` ${baseTransform}` : ''}`;
    const transformOrigin = this.canvas.style.transformOrigin || 'center center';
    const transition = this.canvas.style.transition || '';
    const borderRadius = this.canvas.style.borderRadius || '4px';
    const prev = this._layerLayoutState.get(canvas);

    if (
      prev
      && canvas.width === this.width
      && canvas.height === this.height
      && prev.width === this.width
      && prev.height === this.height
      && prev.displayWidth === displayWidth
      && prev.displayHeight === displayHeight
      && prev.transform === transform
      && prev.transformOrigin === transformOrigin
      && prev.transition === transition
      && prev.borderRadius === borderRadius
      && prev.zIndex === zIndex
    ) {
      return;
    }

    const next = prev || {};
    next.width = this.width;
    next.height = this.height;
    next.displayWidth = displayWidth;
    next.displayHeight = displayHeight;
    next.transform = transform;
    next.transformOrigin = transformOrigin;
    next.transition = transition;
    next.borderRadius = borderRadius;
    next.zIndex = zIndex;
    if (!prev) this._layerLayoutState.set(canvas, next);

    if (canvas.width !== this.width) canvas.width = this.width;
    if (canvas.height !== this.height) canvas.height = this.height;

    const style = canvas.style;
    style.position = 'absolute';
    style.left = '50%';
    style.top = '50%';
    style.width = displayWidth;
    style.height = displayHeight;
    style.transform = transform;
    style.transformOrigin = transformOrigin;
    style.transition = transition;
    style.pointerEvents = 'none';
    style.touchAction = 'none';
    style.borderRadius = borderRadius;
    style.boxShadow = 'none';
    style.zIndex = String(zIndex);
    style.display = 'block';
  }

  _applyLayerVisibility(canvas, visible) {
    if (!canvas) return;
    const next = visible ? 'visible' : 'hidden';
    if (this._layerVisibility.get(canvas) === next && canvas.style.visibility === next) return;
    this._layerVisibility.set(canvas, next);
    canvas.style.visibility = next;
  }

  _syncRenderLayers() {
    if (this._shockwaveLayerCanvas) {
      this._applyLayerLayout(this._shockwaveLayerCanvas, 2);
      this._applyLayerVisibility(this._shockwaveLayerCanvas, this._shockwaveLayerVisible);
    }
    if (this._foregroundCanvas) {
      this._applyLayerLayout(this._foregroundCanvas, 3);
      this._applyLayerVisibility(this._foregroundCanvas, true);
    }
  }

  _setShockwaveLayerVisible(visible) {
    const nextVisible = !!visible && this.shockwaveConfig?.enabled !== false;
    this._shockwaveLayerVisible = nextVisible;
    if (nextVisible) {
      if (!this._ensureShockwaveLayer()) return;
      this._applyLayerVisibility(this._shockwaveLayerCanvas, true);
    } else if (this._shockwaveLayerCanvas) {
      this._applyLayerVisibility(this._shockwaveLayerCanvas, false);
    }
  }

  _prepareForegroundLayer() {
    if (!this._ensureRenderLayers() || !this._foregroundCtx) return null;
    this._foregroundCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._foregroundCtx.clearRect(0, 0, this.width, this.height);
    return this._foregroundCtx;
  }

  _scheduleShockwavePrewarm() {
    if (this._disposed || this.shockwaveConfig?.enabled === false) return;
    const key = `${this.width}|${this.height}|${this.performanceProfile}`;
    if (this._shockwavePrewarmKey === key || this._shockwavePrewarmHandle) return;

    const run = () => {
      this._shockwavePrewarmHandle = null;
      this._shockwavePrewarmHandleType = '';
      if (this._disposed || this._shockwavePrewarmKey === key) return;
      const ok = this._shockwaveEffect.prewarm(this.canvas, {
        width: this.width,
        height: this.height,
        profile: this.performanceProfile
      });
      if (ok) this._shockwavePrewarmKey = key;
    };

    if (typeof requestIdleCallback === 'function') {
      this._shockwavePrewarmHandleType = 'idle';
      this._shockwavePrewarmHandle = requestIdleCallback(run, { timeout: 2200 });
    } else {
      this._shockwavePrewarmHandleType = 'timeout';
      this._shockwavePrewarmHandle = setTimeout(run, 900);
    }
  }

  dispose() {
    this._disposed = true;
    if (this._shockwavePrewarmHandle) {
      if (this._shockwavePrewarmHandleType === 'idle' && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(this._shockwavePrewarmHandle);
      } else {
        clearTimeout(this._shockwavePrewarmHandle);
      }
      this._shockwavePrewarmHandle = null;
      this._shockwavePrewarmHandleType = '';
    }
    if (this._foregroundCanvas?.parentNode) {
      this._foregroundCanvas.parentNode.removeChild(this._foregroundCanvas);
    }
    this._foregroundCanvas = null;
    this._foregroundCtx = null;
    this._shockwaveEffect.dispose();
    this._shockwaveLayerCanvas = null;
    this.ctx = this.baseCtx;
  }

  drawCompositeTo(targetCtx) {
    if (!targetCtx) return false;
    targetCtx.clearRect(0, 0, this.width, this.height);
    targetCtx.drawImage(this.canvas, 0, 0);
    // Keep this capture CPU-only; the WebGL shockwave layer is intentionally
    // skipped so level transitions never force a GPU -> 2D readback.
    if (this._foregroundCanvas) {
      targetCtx.drawImage(this._foregroundCanvas, 0, 0);
    }
    return true;
  }

  _drawBackgroundLayer(ctx, bg, image) {
    ctx.clearRect(0, 0, this.width, this.height);

    if (bg?.type === 'image' && image) {
      if (bg.mirrored) {
        ctx.save();
        ctx.translate(this.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(image, 0, 0, this.width, this.height);
        ctx.restore();
      } else {
        ctx.drawImage(image, 0, 0, this.width, this.height);
      }
    } else if (bg?.type === 'solid') {
      ctx.fillStyle = bg.colorTop || COLORS.backgroundGradientTop;
      ctx.fillRect(0, 0, this.width, this.height);
    } else {
      const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
      gradient.addColorStop(0, bg?.colorTop || COLORS.backgroundGradientTop);
      gradient.addColorStop(1, bg?.colorBottom || COLORS.backgroundGradientBottom);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  _backgroundDarkenAmount(background, fallback = 0.5) {
    const value = background && Number.isFinite(background.darken)
      ? background.darken
      : fallback;
    return this._clamp01(value);
  }

  _drawBackgroundDarken(ctx, darken, width = this.width, height = this.height, x = 0, y = 0) {
    const alpha = this._clamp01(darken);
    if (alpha <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, width, height);
    ctx.restore();
  }

  _ensureBgBaseCache() {
    const bg = this.backgroundConfig;
    const key = `${this.width}|${this.height}|${bg?.type}|${bg?.colorTop}|${bg?.colorBottom}|${bg?.image || ''}|${bg?.mirrored ? 1 : 0}`;
    if (!this._bgBaseDirty && this._bgBaseKey === key && this._bgBaseCanvas) return;

    const canvas = this._ensureBackgroundCanvas('_bgBaseCanvas');
    const ctx = canvas.getContext('2d');
    this._drawBackgroundLayer(ctx, bg, this._bgImage);
    this._bgBaseKey = key;
    this._bgBaseDirty = false;
  }

  _ensureBgOverlayCache() {
    const bg = this.backgroundConfig;
    const hasProgression = this._hasProgressionBackground(bg);
    const key = `${this.width}|${this.height}|${hasProgression ? (bg.progressionImage || '') : ''}|${bg?.mirrored ? 1 : 0}`;
    if (!this._bgOverlayDirty && this._bgOverlayKey === key && this._bgOverlayCanvas) return;

    const canvas = this._ensureBackgroundCanvas('_bgOverlayCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);
    if (hasProgression && this._bgProgressImage) {
      if (bg.mirrored) {
        ctx.save();
        ctx.translate(this.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this._bgProgressImage, 0, 0, this.width, this.height);
        ctx.restore();
      } else {
        ctx.drawImage(this._bgProgressImage, 0, 0, this.width, this.height);
      }
    }
    this._bgOverlayKey = key;
    this._bgOverlayDirty = false;
  }

  _ensureBgVignetteCache() {
    const key = `${this.width}|${this.height}`;
    if (!this._bgVignetteDirty && this._bgVignetteKey === key && this._bgVignetteCanvas) return;

    const canvas = this._ensureBackgroundCanvas('_bgVignetteCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);

    // Strong edge vignette — dark fade from frame into game area
    const edgeV = 68;
    const edgeH = 30;
    const edgeAlpha = 0.84;

    const topFade = ctx.createLinearGradient(0, 0, 0, edgeV);
    topFade.addColorStop(0, `rgba(0,0,0,${edgeAlpha})`);
    topFade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = topFade;
    ctx.fillRect(0, 0, this.width, edgeV);

    const botFade = ctx.createLinearGradient(0, this.height - edgeV, 0, this.height);
    botFade.addColorStop(0, 'rgba(0,0,0,0)');
    botFade.addColorStop(1, `rgba(0,0,0,${edgeAlpha})`);
    ctx.fillStyle = botFade;
    ctx.fillRect(0, this.height - edgeV, this.width, edgeV);

    const leftFade = ctx.createLinearGradient(0, 0, edgeH, 0);
    leftFade.addColorStop(0, `rgba(0,0,0,${edgeAlpha})`);
    leftFade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = leftFade;
    ctx.fillRect(0, 0, edgeH, this.height);

    const rightFade = ctx.createLinearGradient(this.width - edgeH, 0, this.width, 0);
    rightFade.addColorStop(0, 'rgba(0,0,0,0)');
    rightFade.addColorStop(1, `rgba(0,0,0,${edgeAlpha})`);
    ctx.fillStyle = rightFade;
    ctx.fillRect(this.width - edgeH, 0, edgeH, this.height);

    this._bgVignetteKey = key;
    this._bgVignetteDirty = false;
  }

  _clamp01(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }

  _smoothstep01(value) {
    const t = this._clamp01(value);
    return t * t * (3 - 2 * t);
  }

  _updateBackgroundBlend(progressRatio) {
    const hasProgression = this._hasProgressionBackground()
      || this._hasLiquidProgression()
      || this._hasBallTrailProgression();
    this._bgBlendTarget = hasProgression ? this._smoothstep01(progressRatio) : 0;
    const delta = this._bgBlendTarget - this._bgBlendDisplayed;
    if (Math.abs(delta) < 0.001) {
      this._bgBlendDisplayed = this._bgBlendTarget;
      return this._bgBlendDisplayed;
    }
    this._bgBlendDisplayed += delta * 0.12;
    return this._bgBlendDisplayed;
  }

  clear(progressRatio = 0, reactiveState = null) {
    this._ensureBgVignetteCache();
    const progressionBlend = this._updateBackgroundBlend(progressRatio);
    const bgDarken = this._backgroundDarkenAmount(this.backgroundConfig);

    if (this.backgroundConfig?.type === 'liquid') {
      this._liquidBackground.render(this.ctx, this.backgroundConfig, reactiveState, progressionBlend);
      this._drawBackgroundDarken(this.ctx, bgDarken);
      if (this._bgVignetteCanvas) {
        this.ctx.drawImage(this._bgVignetteCanvas, 0, 0);
      }
      return;
    }

    this._ensureBgBaseCache();
    this._ensureBgOverlayCache();

    this.ctx.drawImage(this._bgBaseCanvas, 0, 0);

    const overlayAlpha = progressionBlend;
    if (overlayAlpha > 0.001 && this._bgOverlayCanvas) {
      this.ctx.save();
      this.ctx.globalAlpha = overlayAlpha;
      this.ctx.drawImage(this._bgOverlayCanvas, 0, 0);
      this.ctx.restore();
    }

    this._drawBackgroundDarken(this.ctx, bgDarken);

    if (this._bgVignetteCanvas) {
      this.ctx.drawImage(this._bgVignetteCanvas, 0, 0);
    }
  }

  _getSurvivalBackgroundImage(src) {
    if (!src || typeof src !== 'string') return null;
    if (this._survivalBgImageSrc === src && this._survivalBgImage) {
      return this._survivalBgImage;
    }

    const img = new Image();
    this._survivalBgImageSrc = src;
    this._survivalBgImage = img;
    img.onerror = () => {
      if (this._survivalBgImageSrc !== src) return;
      this._survivalBgImage = null;
      this._survivalBgImageSrc = '';
    };
    img.src = src;
    return img;
  }

  drawSurvivalBackground(background, cameraY = 0, worldHeight = this.height) {
    if (!background || background.type !== 'image' || !background.image) return false;
    const image = this._getSurvivalBackgroundImage(background.image);
    if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return false;

    const ctx = this.ctx;
    const destW = this.width;
    const destH = Math.max(this.height, Math.round(Number(worldHeight) || this.height));
    const fit = background.fit === 'contain' || background.fit === 'stretch'
      ? background.fit
      : 'cover';

    ctx.save();
    ctx.translate(0, -cameraY);
    if (fit === 'stretch') {
      ctx.drawImage(image, 0, 0, destW, destH);
      this._drawBackgroundDarken(ctx, this._backgroundDarkenAmount(background), destW, destH, 0, 0);
      ctx.restore();
      return true;
    }

    const scale = fit === 'contain'
      ? Math.min(destW / image.naturalWidth, destH / image.naturalHeight)
      : Math.max(destW / image.naturalWidth, destH / image.naturalHeight);
    const drawW = image.naturalWidth * scale;
    const drawH = image.naturalHeight * scale;
    const drawX = (destW - drawW) / 2;
    const drawY = (destH - drawH) / 2;
    ctx.drawImage(image, drawX, drawY, drawW, drawH);
    this._drawBackgroundDarken(ctx, this._backgroundDarkenAmount(background), drawW, drawH, drawX, drawY);
    ctx.restore();
    return true;
  }

  drawGrid(cameraY = 0) {
    if (!this.showGrid) return;
    
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    const majorStep = this.gridSize * 5;

    // Vertical lines
    for (let x = 0; x <= this.width; x += this.gridSize) {
      ctx.strokeStyle = x % (this.gridSize * 5) === 0 ? COLORS.gridLineStrong : COLORS.gridLine;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, this.height);
      ctx.stroke();
    }

    // Horizontal lines (camera-aware so world-space major lines stay aligned)
    const startY = -(((cameraY % this.gridSize) + this.gridSize) % this.gridSize);
    for (let y = startY; y <= this.height; y += this.gridSize) {
      const worldY = y + cameraY;
      const mod = ((Math.round(worldY) % majorStep) + majorStep) % majorStep;
      ctx.strokeStyle = mod === 0 ? COLORS.gridLineStrong : COLORS.gridLine;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(this.width, y + 0.5);
      ctx.stroke();
    }
  }

  // Trace a closed curved-ribbon path defined by slice boundary points.
  // Each slice has {x, y, nx, ny} (position on curve + surface normal).
  // topH/botH = offsets along the normal for the two edges of the ribbon.
  drawCurvedBrickPath(ctx, slices, topH, botH) {
    ctx.beginPath();
    // Top edge left→right
    ctx.moveTo(slices[0].x + slices[0].nx * topH, slices[0].y + slices[0].ny * topH);
    for (let i = 1; i < slices.length; i++) {
      ctx.lineTo(slices[i].x + slices[i].nx * topH, slices[i].y + slices[i].ny * topH);
    }
    // Bottom edge right→left
    for (let i = slices.length - 1; i >= 0; i--) {
      ctx.lineTo(slices[i].x + slices[i].nx * botH, slices[i].y + slices[i].ny * botH);
    }
    ctx.closePath();
  }

  strokeCurvedBrickEdge(ctx, slices, offset) {
    if (!slices || slices.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(slices[0].x + slices[0].nx * offset, slices[0].y + slices[0].ny * offset);
    for (let i = 1; i < slices.length; i++) {
      ctx.lineTo(slices[i].x + slices[i].nx * offset, slices[i].y + slices[i].ny * offset);
    }
    ctx.stroke();
  }

  drawStyledCurvedBrick(ctx, slices, halfH, style, isHit = false) {
    if (!style || !slices || slices.length < 2) return false;
    const colors = this._pegSurfaceColors(style, isHit);

    this.drawCurvedBrickPath(ctx, slices, halfH, -halfH);
    ctx.fillStyle = colors.shadow;
    ctx.fill();

    const insetH = Math.max(1, halfH * 0.72);
    this.drawCurvedBrickPath(ctx, slices, insetH, -insetH);
    ctx.fillStyle = colors.main;
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = colors.line;
    ctx.lineWidth = Math.max(0.8, halfH * 0.24);
    this.strokeCurvedBrickEdge(ctx, slices, halfH * 0.42);

    ctx.save();
    ctx.globalAlpha *= 0.55;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
    ctx.lineWidth = Math.max(0.55, halfH * 0.12);
    this.strokeCurvedBrickEdge(ctx, slices, halfH * 0.56);
    ctx.restore();

    ctx.strokeStyle = colors.rimLight;
    ctx.lineWidth = Math.max(0.75, halfH * 0.16);
    this.strokeCurvedBrickEdge(ctx, slices, halfH * 0.86);

    ctx.strokeStyle = colors.shadow;
    ctx.lineWidth = Math.max(0.85, halfH * 0.2);
    this.strokeCurvedBrickEdge(ctx, slices, -halfH * 0.9);

    ctx.strokeStyle = colors.deep;
    ctx.lineWidth = Math.max(0.8, halfH * 0.16);
    this.strokeCurvedBrickEdge(ctx, slices, -halfH * 0.45);
    return true;
  }

  drawPeg(peg, isHit = false, isSelected = false) {
    const ctx = this.ctx;
    const colors = PEG_COLORS[peg.type] || PEG_COLORS.blue;
    const radius = PHYSICS_CONFIG.pegRadius;

    // ── Bumper: metallic circle with ring ──
    if (peg.type === 'bumper') {
      const scale = peg.bumperScale || 1;
      const hitScale = peg._bumperHitScale || 1;
      const r = radius * scale * hitScale;

      // Determine color based on bumper mode
      let ringColor = COLORS.bumperRing;
      let bodyColorOuter = '#909090';
      let bodyColorMid = '#d0d0d0';
      let glowColor = COLORS.bumperGlow;
      if (peg.bumperDisappear) {
        // Blue tint (like normal pegs)
        ringColor = '#3a9e97';
        bodyColorOuter = '#2a7a74';
        bodyColorMid = '#4ecdc4';
        glowColor = COLORS.blueGlow;
      }
      if (peg.bumperOrange) {
        // Orange tint (must-hit)
        ringColor = '#cc5528';
        bodyColorOuter = '#a0401a';
        bodyColorMid = '#ff6b35';
        glowColor = COLORS.orangeGlow;
      }

      ctx.save();
      ctx.translate(peg.x, peg.y);

      // Cached bumper body sprite (ring + gradient + glare)
      const bumperSprite = this._bumperBodySprite(r, ringColor, bodyColorOuter, bodyColorMid);
      ctx.drawImage(bumperSprite.img, -bumperSprite.half, -bumperSprite.half);

      // Hit glow for disappearing bumpers (drawn under the pulse)
      if (isHit && (peg.bumperDisappear || peg.bumperOrange)) {
        ctx.globalAlpha = 0.5;
        const hitColor = peg.bumperOrange ? COLORS.orangeHit : COLORS.blueHit;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = hitColor;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Hit flash pulse (always on top)
      if (peg._bumperHitScale && peg._bumperHitScale > 1.01) {
        const pulseAlpha = Math.min(1, (peg._bumperHitScale - 1) * 5);
        ctx.globalAlpha = pulseAlpha;
        const flashGlow = this._circleGlow('#ffffff', r, 30, 0.5);
        ctx.drawImage(flashGlow.img, -flashGlow.half, -flashGlow.half);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Selection indicator
      if (isSelected) {
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
      return;
    }

    // ── Portal: oriented line trigger ──
    if (isPortalType(peg.type)) {
      const isBluePortal = peg.type === 'portalBlue';
      const halfLen = radius * getPortalScale(peg);
      const lineWidth = Math.max(6, radius * 0.82);
      const palette = isBluePortal
        ? {
          bright: '#d7fffb',
          light: '#7df4ed',
          main: COLORS.portalBlue,
          deep: '#126c78',
          shadow: 'rgba(4, 15, 21, 0.92)',
          aura: 'rgba(78, 205, 196, 0.34)'
        }
        : {
          bright: '#ffe3c4',
          light: '#ffa15f',
          main: COLORS.portalOrange,
          deep: '#a83b12',
          shadow: 'rgba(26, 8, 3, 0.92)',
          aura: 'rgba(255, 115, 38, 0.34)'
        };
      const pulse = Math.max(0, Math.min(1, peg._portalPulse || (isHit ? 0.45 : 0)));
      const time = this._renderTimeSeconds || 0;
      const blockedSign = peg.portalOneWayFlip ? -1 : 1;
      const openSign = -blockedSign;

      ctx.save();
      ctx.translate(peg.x, peg.y);
      ctx.rotate(peg.angle || 0);

      const glow = this._lineGlow(palette.aura, halfLen + lineWidth * 0.3, lineWidth * 1.22, 10);
      ctx.save();
      ctx.globalAlpha = isHit ? 0.34 : (0.5 + pulse * 0.45);
      ctx.drawImage(glow.img, -glow.hw, -glow.hh);
      ctx.restore();

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.strokeStyle = palette.shadow;
      ctx.lineWidth = lineWidth + 4.5;
      ctx.beginPath();
      ctx.moveTo(-halfLen, 0);
      ctx.lineTo(halfLen, 0);
      ctx.stroke();

      const body = ctx.createLinearGradient(-halfLen, 0, halfLen, 0);
      body.addColorStop(0, palette.deep);
      body.addColorStop(0.18, palette.main);
      body.addColorStop(0.5, palette.light);
      body.addColorStop(0.82, palette.main);
      body.addColorStop(1, palette.deep);
      ctx.strokeStyle = body;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(-halfLen, 0);
      ctx.lineTo(halfLen, 0);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.46)';
      ctx.lineWidth = Math.max(1, lineWidth * 0.16);
      ctx.beginPath();
      ctx.moveTo(-halfLen * 0.74, -lineWidth * 0.18);
      ctx.lineTo(halfLen * 0.74, -lineWidth * 0.18);
      ctx.stroke();

      ctx.strokeStyle = palette.deep;
      ctx.lineWidth = Math.max(1.15, lineWidth * 0.22);
      ctx.beginPath();
      ctx.moveTo(-halfLen * 0.86, lineWidth * 0.28);
      ctx.lineTo(halfLen * 0.86, lineWidth * 0.28);
      ctx.stroke();

      const blockedY = blockedSign * (lineWidth * 1.05 + 2);
      ctx.strokeStyle = 'rgba(7, 9, 13, 0.88)';
      ctx.lineWidth = Math.max(4.2, lineWidth * 0.58);
      ctx.beginPath();
      ctx.moveTo(-halfLen * 1.02, blockedY);
      ctx.lineTo(halfLen * 1.02, blockedY);
      ctx.stroke();

      ctx.strokeStyle = isBluePortal ? 'rgba(149, 245, 238, 0.24)' : 'rgba(255, 161, 95, 0.24)';
      ctx.lineWidth = Math.max(1.2, lineWidth * 0.16);
      ctx.beginPath();
      ctx.moveTo(-halfLen * 0.88, blockedY - blockedSign * 1.7);
      ctx.lineTo(halfLen * 0.88, blockedY - blockedSign * 1.7);
      ctx.stroke();

      const notchCount = Math.max(4, Math.min(9, Math.floor((halfLen * 2) / 13)));
      ctx.fillStyle = 'rgba(3, 5, 8, 0.82)';
      for (let i = 0; i < notchCount; i++) {
        const x = -halfLen * 0.78 + (halfLen * 1.56) * (i / Math.max(1, notchCount - 1));
        ctx.beginPath();
        ctx.moveTo(x - 2.8, blockedY - blockedSign * 1.8);
        ctx.lineTo(x + 2.8, blockedY - blockedSign * 1.8);
        ctx.lineTo(x, blockedY + blockedSign * 3.2);
        ctx.closePath();
        ctx.fill();
      }

      const travel = lineWidth * (1.7 + pulse * 0.45);
      const particleCount = pulse > 0.01 ? 16 : 10;
      const streamHalfWidth = halfLen * 0.8;
      const particleColor = isBluePortal ? 'rgba(125, 244, 237, 1)' : 'rgba(255, 142, 64, 1)';
      const speed = isBluePortal ? 0.34 : 0.3;
      const yStart = openSign * (lineWidth * 0.5 + travel);
      const yEnd = openSign * (lineWidth * 0.12);
      const hash01 = (a, b) => {
        const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
        return v - Math.floor(v);
      };
      for (let particleIndex = 0; particleIndex < particleCount; particleIndex++) {
        const phaseBase = time * speed + particleIndex * 0.173;
        const cycle = Math.floor(phaseBase);
        const phase = phaseBase - cycle;
        const flow = isBluePortal ? phase : (1 - phase);
        const spawnRand = hash01(particleIndex + 1, cycle + 1);
        const spawnX = (spawnRand - 0.5) * streamHalfWidth * 2;
        const jitterX = (hash01(particleIndex + 7, cycle + 19) - 0.5) * Math.max(1.1, lineWidth * 0.16);
        const jitterY = (hash01(particleIndex + 13, cycle + 23) - 0.5) * Math.max(0.7, lineWidth * 0.1);
        const y = yStart + (yEnd - yStart) * flow + jitterY;
        const fade = Math.sin(Math.PI * phase);
        const baseAlpha = 0.18 + fade * 0.2;
        const rDot = (isBluePortal ? 1.3 : 1.2) + (particleIndex % 3) * 0.18 + pulse * 0.7;
        ctx.globalAlpha = Math.min(0.72, baseAlpha + pulse * 0.22);
        ctx.fillStyle = particleColor;
        ctx.beginPath();
        ctx.arc(spawnX + jitterX, y, rDot, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (isSelected) {
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(
          -halfLen - 8,
          -lineWidth * 1.5 - 8,
          halfLen * 2 + 16,
          lineWidth * 3 + 16
        );
      }

      ctx.restore();
      return;
    }

    // ── Curved brick: render as a warped ribbon in world space ──
    if (peg.shape === 'brick' && peg.curveSlices && peg.curveSlices.length >= 2) {
      const halfH = (peg.height || PHYSICS_CONFIG.pegRadius * 1.2) / 2;
      const sl = peg.curveSlices;
      const surfaceStyle = !peg.color ? this._getPegSurfaceStyle(peg.type) : null;
      ctx.save();

      // Main fill
      if (!this.drawStyledCurvedBrick(ctx, sl, halfH, surfaceStyle, isHit)) {
        this.drawCurvedBrickPath(ctx, sl, halfH, -halfH);
        ctx.fillStyle = isHit ? colors.hit : (peg.color || colors.main);
        ctx.fill();
      }

      // Selection ring
      if (isSelected) {
        this.drawCurvedBrickPath(ctx, sl, halfH + 4, -halfH - 4);
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Hit glow: tight stroke on the brick edge
      if (isHit && peg.type !== 'obstacle') {
        ctx.globalAlpha = 0.5;
        this.drawCurvedBrickPath(ctx, sl, halfH, -halfH);
        ctx.strokeStyle = colors.hit;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.restore();
      return;
    }

    // ── Flat brick / circle: existing local-space rendering ──
    ctx.save();
    ctx.translate(peg.x, peg.y);
    ctx.rotate(peg.angle || 0);
    const surfaceStyle = !peg.color ? this._getPegSurfaceStyle(peg.type) : null;

    if (peg.shape === 'brick') {
      const w = peg.width || PHYSICS_CONFIG.pegRadius * 4;
      const h = peg.height || PHYSICS_CONFIG.pegRadius * 1.2;
      const brickSprite = surfaceStyle ? this._brickPegBodySprite(peg.type, w, h, isHit) : null;

      if (brickSprite) {
        ctx.drawImage(brickSprite.img, -brickSprite.hw, -brickSprite.hh);
      } else {
        ctx.beginPath();
        ctx.roundRect(-w/2, -h/2, w, h, 2);
        ctx.fillStyle = isHit ? colors.hit : (peg.color || colors.main);
        ctx.fill();
      }
    } else {
      // Draw circle peg
      const pegSprite = surfaceStyle ? this._pegBodySprite(peg.type, radius, isHit) : null;
      if (pegSprite) {
        const angle = peg.angle || 0;
        if (angle) ctx.rotate(-angle);
        ctx.drawImage(pegSprite.img, -pegSprite.half, -pegSprite.half);
        if (angle) ctx.rotate(angle);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        if (peg.type === 'gamble' && !isHit) {
          const edgeColor = peg.color || colors.main;
          const gradient = ctx.createRadialGradient(
            -radius * 0.25,
            -radius * 0.28,
            radius * 0.08,
            0,
            0,
            radius
          );
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(0.36, '#fbfff4');
          gradient.addColorStop(0.72, edgeColor);
          gradient.addColorStop(1, edgeColor);
          ctx.fillStyle = gradient;
        } else {
          ctx.fillStyle = isHit ? colors.hit : (peg.color || colors.main);
        }
        ctx.fill();
      }

      if (peg.type === 'gamble' && peg.gambleKnockbackEnabled && !isHit) {
        const arrowWidth = Math.max(2.8, radius * 0.34);
        const shaftTop = -radius * 0.66;
        const tipY = radius * 0.67;
        const shoulderY = radius * 0.17;
        const shoulderX = radius * 0.5;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(0, shaftTop);
        ctx.lineTo(0, tipY);
        ctx.lineTo(-shoulderX, shoulderY);
        ctx.moveTo(0, tipY);
        ctx.lineTo(shoulderX, shoulderY);
        ctx.strokeStyle = 'rgba(20, 57, 0, 0.82)';
        ctx.lineWidth = arrowWidth * 2.1;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, shaftTop);
        ctx.lineTo(0, tipY);
        ctx.lineTo(-shoulderX, shoulderY);
        ctx.moveTo(0, tipY);
        ctx.lineTo(shoulderX, shoulderY);
        ctx.strokeStyle = '#f6ffd6';
        ctx.lineWidth = arrowWidth;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(-arrowWidth * 0.34, shaftTop + radius * 0.08);
        ctx.lineTo(-arrowWidth * 0.34, tipY - radius * 0.22);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
        ctx.lineWidth = Math.max(0.7, arrowWidth * 0.22);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Selection indicator
    if (isSelected) {
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;

      if (peg.shape === 'brick') {
        const w = peg.width || PHYSICS_CONFIG.brickWidth;
        const h = peg.height || PHYSICS_CONFIG.brickHeight;
        ctx.strokeRect(-w/2 - 4, -h/2 - 4, w + 8, h + 8);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Hit state - tight glow matching brick/circle shape
    if (isHit && peg.type !== 'obstacle') {
      ctx.globalAlpha = 0.45;

      if (peg.shape === 'brick') {
        const w = peg.width || PHYSICS_CONFIG.brickWidth;
        const h = peg.height || PHYSICS_CONFIG.brickHeight;
        const rg = this._rectGlow(colors.hit, w, h, 6, 2);
        ctx.drawImage(rg.img, -rg.hw, -rg.hh);
      } else {
        const cg = this._circleGlow(colors.hit, radius, 6);
        ctx.drawImage(cg.img, -cg.half, -cg.half);
      }
    }

    ctx.restore();
  }

  _clonePegForExitAnimation(peg) {
    const snapshot = { ...peg };
    if (peg.curveSlices) {
      snapshot.curveSlices = peg.curveSlices.map(slice => ({ ...slice }));
    }
    snapshot._wrapCopies = null;
    snapshot._wrapHideMain = false;
    return snapshot;
  }

  queuePegExitAnimations(pegs) {
    const list = Array.isArray(pegs) ? pegs : [pegs];
    if (!list.length) return;
    const nowMs = typeof performance !== 'undefined'
      ? performance.now()
      : (this._renderTimeSeconds || 0) * 1000;

    for (const peg of list) {
      if (!peg || !peg.id) continue;
      this._pegExitAnimations.set(peg.id, {
        peg: this._clonePegForExitAnimation(peg),
        startMs: nowMs
      });
    }
  }

  clearPegExitAnimations() {
    this._pegExitAnimations.clear();
  }

  drawPegScaled(peg, isHit = false, isSelected = false, scale = 1, alpha = 1) {
    if (!peg || scale <= 0.001 || alpha <= 0.001) return;
    if (Math.abs(scale - 1) < 0.001 && alpha >= 0.999) {
      this.drawPeg(peg, isHit, isSelected);
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(peg.x, peg.y);
    ctx.scale(scale, scale);
    ctx.translate(-peg.x, -peg.y);
    this.drawPeg(peg, isHit, isSelected);
    ctx.restore();
  }

  drawPegExitAnimations() {
    if (!this._pegExitAnimations || this._pegExitAnimations.size === 0) return;
    const nowMs = typeof performance !== 'undefined'
      ? performance.now()
      : (this._renderTimeSeconds || 0) * 1000;

    for (const [pegId, anim] of this._pegExitAnimations) {
      const elapsed = Math.max(0, nowMs - anim.startMs);
      const t = Math.max(0, Math.min(1, elapsed / PEG_EXIT_SHRINK_MS));
      if (t >= 1) {
        this._pegExitAnimations.delete(pegId);
        continue;
      }

      const shrink = Math.pow(1 - t, 2.25);
      const pop = t < 0.16 ? 1 + Math.sin((t / 0.16) * Math.PI) * 0.045 : 1;
      const scale = shrink * pop;
      const alpha = t < 0.68 ? 1 : Math.max(0, (1 - t) / 0.32);
      this.drawPegScaled(anim.peg, true, false, scale, alpha);
    }
  }

  getWrapCopyOffsets(peg) {
    // Proximity-based: show copies when the peg is near any screen edge
    // so that wrapping looks smooth instead of jumping.
    const buffer = PHYSICS_CONFIG.pegRadius * 2;
    const copies = [];
    const nearL = peg.x < buffer;
    const nearR = peg.x > this.width - buffer;
    const nearT = peg.y < buffer;
    const nearB = peg.y > this.height - buffer;

    if (nearR) copies.push({ x: -this.width, y: 0 });
    if (nearL) copies.push({ x:  this.width, y: 0 });
    if (nearB) copies.push({ x: 0, y: -this.height });
    if (nearT) copies.push({ x: 0, y:  this.height });

    // Corner copies
    if (nearR && nearB) copies.push({ x: -this.width, y: -this.height });
    if (nearR && nearT) copies.push({ x: -this.width, y:  this.height });
    if (nearL && nearB) copies.push({ x:  this.width, y: -this.height });
    if (nearL && nearT) copies.push({ x:  this.width, y:  this.height });

    return copies;
  }

  drawPegWithOffset(peg, offsetX, offsetY, isHit = false, isSelected = false, alpha = 1) {
    if (alpha <= 0.001) return;
    if (Math.abs(offsetX) < 0.001 && Math.abs(offsetY) < 0.001 && alpha >= 0.999) {
      this.drawPeg(peg, isHit, isSelected);
      return;
    }

    this.ctx.save();
    this.ctx.globalAlpha *= alpha;
    const shifted = { ...peg, x: peg.x + offsetX, y: peg.y + offsetY };
    if (peg.curveSlices) {
      shifted.curveSlices = peg.curveSlices.map(s => ({
        ...s,
        x: s.x + offsetX,
        y: s.y + offsetY
      }));
    }
    this.drawPeg(shifted, isHit, isSelected);
    this.ctx.restore();
  }

  drawPegs(pegs, hitPegIds = [], selectedIds = new Set(), wrapCopyPegIds = null) {
    const hitSet = new Set(hitPegIds);
    const wrapSet = wrapCopyPegIds instanceof Set ? wrapCopyPegIds : null;
    
    for (const peg of pegs) {
      const isHit = hitSet.has(peg.id);
      const isSelected = selectedIds.has(peg.id);

      // When wrapping through walls, hide the main peg (which teleports)
      // and draw only the raw-position copies (which move continuously).
      if (!peg._wrapHideMain) {
        this.drawPeg(peg, isHit, isSelected);
      }

      if (peg._wrapCopies) {
        for (const copy of peg._wrapCopies) {
          this.drawPegWithOffset(peg, copy.x - peg.x, copy.y - peg.y, isHit, isSelected, 1);
        }
      }
    }

    this.drawPegExitAnimations();
  }

  drawBall(ball) {
    if (!ball) return;

    const ctx = this.ctx;
    const spawnT = ball.active ? 1 : Math.max(0, Math.min(1, Number.isFinite(ball.launcherSpawnAnim) ? ball.launcherSpawnAnim : 1));
    const spawnScale = ball.active ? 1 : (0.22 + (1 - Math.pow(1 - spawnT, 3)) * 0.78);
    const radius = ball.radius * spawnScale;

    // Ball glow (cached sprite)
    const bg = this._circleGlow(COLORS.ballGlow, radius, 15);
    ctx.drawImage(bg.img, ball.x - bg.half, ball.y - bg.half);

    // Ball body
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.ball;
    ctx.fill();

    if (ball.side === 'cpu') {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 24, 48, 0.9)';
      ctx.shadowBlur = Math.max(8, radius * 0.75);
      ctx.strokeStyle = 'rgba(255, 36, 58, 0.96)';
      ctx.lineWidth = Math.max(3, radius * 0.26);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius + ctx.lineWidth * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Highlight
    ctx.beginPath();
    ctx.arc(ball.x - radius * 0.25, ball.y - radius * 0.25, radius * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fill();
  }

  drawLauncher(x, y, angle, showAim = true, ballScale = 1, options = null) {
    if (options?.assetLauncher) {
      this.drawBilliardAssetLauncher(x, y, angle, showAim, ballScale, options);
      return;
    }

    const ctx = this.ctx;
    const previewRadius = getBallRadius() * Math.max(0.2, Math.min(1, Number.isFinite(ballScale) ? ballScale : 1));
    const isCpu = options?.side === 'cpu' || options?.enemy === true;
    const active = !!options?.active;
    
    // Launcher base
    ctx.fillStyle = COLORS.launcher;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fill();

    // Ball preview in launcher
    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(x, y, previewRadius, 0, Math.PI * 2);
    ctx.fill();

    if (active) {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 255, 255, 0.7)';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, previewRadius + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (isCpu) {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 24, 48, 0.9)';
      ctx.shadowBlur = Math.max(8, previewRadius * 0.75);
      ctx.strokeStyle = 'rgba(255, 36, 58, 0.96)';
      ctx.lineWidth = Math.max(3, previewRadius * 0.26);
      ctx.beginPath();
      ctx.arc(x, y, previewRadius + ctx.lineWidth * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Direction indicator
    if (showAim) {
      const indicatorLen = 25;
      ctx.strokeStyle = COLORS.launcherAim;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * indicatorLen, y + Math.sin(angle) * indicatorLen);
      ctx.stroke();
    }
  }

  drawBilliardAssetLauncher(x, y, angle, showAim = true, ballScale = 1, options = null) {
    const ctx = this.ctx;
    const previewRadius = getBallRadius() * Math.max(0.2, Math.min(1, Number.isFinite(ballScale) ? ballScale : 1));
    const circleImg = this._billiardCannonImages?.circle;
    const topImg = this._billiardCannonImages?.top;
    const active = !!options?.active;
    const renderAngle = Number.isFinite(angle) ? angle : (options?.defaultAngle || Math.PI / 2);
    const bodyAngle = Number.isFinite(options?.defaultAngle) ? options.defaultAngle : renderAngle;

    ctx.save();
    ctx.translate(x, y);
    // In asset space, the top ornament points toward +Y, matching the original top cannon.
    ctx.rotate(bodyAngle - Math.PI / 2);

    if (topImg) {
      const topW = 118;
      const topH = topW * (topImg.naturalHeight || topImg.height || 188) / Math.max(1, topImg.naturalWidth || topImg.width || 389);
      ctx.save();
      ctx.globalAlpha = active ? 0.98 : 0.78;
      ctx.drawImage(topImg, -topW / 2, -topH - 8, topW, topH);
      ctx.restore();
    }

    if (circleImg) {
      const size = active ? 66 : 58;
      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.86;
      ctx.drawImage(circleImg, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
      ctx.beginPath();
      ctx.arc(0, 0, active ? 30 : 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (active) {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 255, 255, 0.65)';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(0, 0, previewRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-previewRadius * 0.25, -previewRadius * 0.25, previewRadius * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fill();

    if (showAim) {
      const indicatorLen = 32;
      ctx.save();
      ctx.rotate(renderAngle - bodyAngle);
      ctx.strokeStyle = COLORS.launcherAim;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, previewRadius + 3);
      ctx.lineTo(0, indicatorLen);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  drawAimReticle(x, y, angle) {
    const ctx = this.ctx;
    const outerRadius = getBallRadius() + 8;
    const innerRadius = getBallRadius() + 2;
    const ringStart = angle - Math.PI * 0.22;
    const ringEnd = angle + Math.PI * 0.22;

    ctx.save();

    ctx.beginPath();
    ctx.arc(x, y, outerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, outerRadius, ringStart, ringEnd);
    ctx.strokeStyle = COLORS.launcherAim;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();
  }

  drawTrajectory(trajectory, fullPath = false, aimLength = 300) {
    if (!trajectory || !trajectory.points || trajectory.points.length < 2) return;

    const ctx = this.ctx;
    const points = trajectory.points;

    if (fullPath) {
      // Draw full trajectory path
      ctx.strokeStyle = COLORS.trajectoryLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw dots at intervals
      ctx.fillStyle = COLORS.trajectoryDot;
      for (let i = 0; i < points.length; i += 10) {
        ctx.beginPath();
        ctx.arc(points[i].x, points[i].y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Mark hit points
      ctx.fillStyle = COLORS.orange;
      for (const hit of trajectory.hits) {
        ctx.beginPath();
        ctx.arc(hit.x, hit.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Draw trajectory to first hit only (dotted line)
      ctx.strokeStyle = COLORS.trajectoryLine;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw the endpoint marker for both default and editor-shortened aim.
      if (points.length > 1) {
        const endPoint = points[points.length - 1];
        ctx.fillStyle = COLORS.trajectoryDot;
        ctx.beginPath();
        ctx.arc(endPoint.x, endPoint.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawQteTrajectory(trajectory) {
    if (!trajectory || !trajectory.points || trajectory.points.length < 2) return;

    const ctx = this.ctx;
    const start = trajectory.points[0];
    const end = trajectory.points[trajectory.points.length - 1];

    ctx.save();
    ctx.strokeStyle = COLORS.launcherAim;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fill();
    ctx.restore();
  }

  drawYoyoThreads(threads) {
    if (!Array.isArray(threads) || threads.length === 0) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const traceObjects = (points) => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    };

    const traceFlat = (points, pointCount) => {
      ctx.beginPath();
      ctx.moveTo(points[0], points[1]);
      for (let i = 1; i < pointCount; i++) {
        const index = i * 2;
        ctx.lineTo(points[index], points[index + 1]);
      }
    };

    for (const thread of threads) {
      const points = thread ? thread.points : null;
      const flatPoints = !!thread?.flatPoints || ArrayBuffer.isView(points);
      const pointCount = flatPoints
        ? Math.floor(Number.isFinite(thread?.pointCount) ? thread.pointCount : ((points?.length || 0) / 2))
        : (Array.isArray(points) ? points.length : 0);
      if (!points || pointCount < 2) continue;

      ctx.strokeStyle = COLORS.yoyoThreadGlow;
      ctx.lineWidth = 6;
      if (flatPoints) traceFlat(points, pointCount);
      else traceObjects(points);
      ctx.stroke();

      ctx.strokeStyle = COLORS.yoyoThreadCore;
      ctx.lineWidth = 3.2;
      if (flatPoints) traceFlat(points, pointCount);
      else traceObjects(points);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawBalls(balls) {
    if (!balls || balls.length === 0) return;
    for (const ball of balls) {
      this.drawBall(ball);
    }
  }

  drawBucket(bucket, flash = 0) {
    const ctx = this.ctx;
    const { x, y, width, height } = bucket;
    const intensity = Math.max(0, Math.min(1, flash || 0));
    const hasBucketAsset = Boolean(this._bucketImg);
    let drawX = x - width / 2;
    let drawY = y - height / 2;
    let drawW = width;
    let drawH = height;

    if (hasBucketAsset) {
      const imgAspect = this._bucketImg.width / this._bucketImg.height;
      drawW = width;
      drawH = drawW / imgAspect;
      drawX = x - drawW / 2;
      drawY = y + height / 2 - drawH;
    }

    const mouthY = hasBucketAsset ? (drawY + drawH * 0.72) : (y - height / 2 + 5);
    const mouthHalfW = hasBucketAsset ? (drawW * 0.43) : (width * 0.3);
    const flareHeight = hasBucketAsset
      ? (drawH * (0.44 + intensity * 0.62))
      : (height * (0.92 + intensity * 1.08));
    const flareTopY = mouthY - flareHeight;
    const flareTopHalfW = hasBucketAsset
      ? (drawW * (0.5 + intensity * 0.05))
      : (mouthHalfW * (1.18 + intensity * 0.12));
    const bowlGlowRadiusX = hasBucketAsset ? (drawW * 0.44) : (width * 0.34);
    const bowlGlowRadiusY = hasBucketAsset ? (drawH * 0.24) : (height * 0.18);
    const rimRadiusX = hasBucketAsset ? (drawW * 0.42) : (width * 0.28);
    const rimRadiusY = hasBucketAsset ? (drawH * 0.12) : (height * 0.1);

    if (intensity > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      const beamGradient = ctx.createLinearGradient(x, flareTopY, x, mouthY + drawH * 0.08);
      beamGradient.addColorStop(0, 'rgba(255,255,255,0)');
      beamGradient.addColorStop(0.42, `rgba(255,255,255,${0.05 + intensity * 0.08})`);
      beamGradient.addColorStop(0.82, `rgba(255,255,255,${0.12 + intensity * 0.13})`);
      beamGradient.addColorStop(1, `rgba(255,255,255,${0.18 + intensity * 0.16})`);
      ctx.fillStyle = beamGradient;
      ctx.beginPath();
      ctx.moveTo(x - mouthHalfW, mouthY + 0.5);
      ctx.quadraticCurveTo(
        x - mouthHalfW * 0.98,
        mouthY - flareHeight * 0.28,
        x - flareTopHalfW,
        flareTopY
      );
      ctx.lineTo(x + flareTopHalfW, flareTopY);
      ctx.quadraticCurveTo(
        x + mouthHalfW * 0.98,
        mouthY - flareHeight * 0.28,
        x + mouthHalfW,
        mouthY + 0.5
      );
      ctx.closePath();
      ctx.fill();

      const bowlGlowY = mouthY + (hasBucketAsset ? drawH * 0.14 : 1);
      const bowlGlow = ctx.createRadialGradient(x, bowlGlowY, 1, x, bowlGlowY, bowlGlowRadiusX);
      bowlGlow.addColorStop(0, `rgba(255,255,255,${0.18 + intensity * 0.16})`);
      bowlGlow.addColorStop(0.58, `rgba(255,255,255,${0.06 + intensity * 0.06})`);
      bowlGlow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bowlGlow;
      ctx.beginPath();
      ctx.ellipse(x, bowlGlowY, bowlGlowRadiusX, bowlGlowRadiusY, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (hasBucketAsset) {
      // Draw the bucket.webp asset, scaled to fit the bucket bounds
      // Image is wider than tall — use width as primary, derive height from aspect ratio
      ctx.drawImage(this._bucketImg, drawX, drawY, drawW, drawH);
    } else {
      // Fallback: original trapezoid shape
      ctx.fillStyle = COLORS.bucket;
      ctx.beginPath();
      ctx.moveTo(x - width / 2, y - height / 2);
      ctx.lineTo(x - width / 2 + 8, y + height / 2);
      ctx.lineTo(x + width / 2 - 8, y + height / 2);
      ctx.lineTo(x + width / 2, y - height / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = COLORS.bucketInner;
      ctx.beginPath();
      ctx.moveTo(x - width / 2 + 4, y - height / 2 + 4);
      ctx.lineTo(x - width / 2 + 10, y + height / 2 - 2);
      ctx.lineTo(x + width / 2 - 10, y + height / 2 - 2);
      ctx.lineTo(x + width / 2 - 4, y - height / 2 + 4);
      ctx.closePath();
      ctx.fill();
    }

    if (intensity > 0.001 && !hasBucketAsset) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.strokeStyle = `rgba(255,255,255,${0.18 + intensity * 0.32})`;
      ctx.lineWidth = hasBucketAsset ? (0.85 + intensity * 1.1) : (1.25 + intensity * 1.75);
      ctx.beginPath();
      ctx.ellipse(x, mouthY + 0.8, rimRadiusX, rimRadiusY, 0, Math.PI, 0, true);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawFlippers(flippers, canvasWidth, selected) {
    if (!flippers || !flippers.enabled) return;
    const ctx = this.ctx;
    const centerX = canvasWidth / 2;
    const t = flippers._flipperT || 0;
    const restRad = (Number.isFinite(flippers.restAngle) ? flippers.restAngle : 23) * Math.PI / 180;
    const flipRad = (Number.isFinite(flippers.flipAngle) ? flippers.flipAngle : 30) * Math.PI / 180;

    const sc = Number.isFinite(flippers.scale) ? flippers.scale : 1.8;
    const len = (Number.isFinite(flippers.length) ? flippers.length : 60) * sc;
    const w = (Number.isFinite(flippers.width) ? flippers.width : 8) * sc;
    const xOffset = Number.isFinite(flippers.xOffset) ? flippers.xOffset : 196;
    const y = Number.isFinite(flippers.y) ? flippers.y : (this.height - 55);

    // Left flipper: rest points down-right, flip points up-right
    const leftPivotX = centerX - xOffset;
    const leftAngle = restRad - t * (restRad + flipRad);
    this.drawSingleFlipper(leftPivotX, y, leftAngle, len, w, t, selected);

    // Right flipper: mirrored
    const rightPivotX = centerX + xOffset;
    const rightAngle = Math.PI - leftAngle;
    this.drawSingleFlipper(rightPivotX, y, rightAngle, len, w, t, selected);
  }

  drawSingleFlipper(pivotX, pivotY, angle, length, width, t, selected) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);

    const r = width / 2;

    // Rounded bar shape: pivot end (semicircle) → straight → tip (semicircle)
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, true);  // pivot semicircle (left side)
    ctx.lineTo(length - r, r);
    ctx.arc(length - r, 0, r, Math.PI / 2, -Math.PI / 2, true); // tip semicircle
    ctx.lineTo(0, -r);
    ctx.closePath();

    // Metallic gradient
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, t > 0.5 ? '#f0f0f0' : '#d0d0d0');
    grad.addColorStop(0.5, t > 0.5 ? '#e0e0e0' : '#b0b0b0');
    grad.addColorStop(1, t > 0.5 ? '#c0c0c0' : '#909090');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Selection highlight
    if (selected) {
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Pivot dot
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.flipperPivot;
    ctx.fill();

    ctx.restore();
  }

  drawScore(score, ballsLeft, orangePegsLeft, totalOrangePegs, centerLabel = null) {
    const ctx = this.ctx;
    
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${score.toLocaleString()}`, 10, 20);

    const ballsLabel = Number.isFinite(ballsLeft) ? ballsLeft : '\u221E';
    ctx.textAlign = 'right';
    ctx.fillText(`⚪ ${ballsLabel}`, this.width - 10, 20);

    // Center tracker label
    ctx.fillStyle = centerLabel ? COLORS.textDim : COLORS.orange;
    ctx.textAlign = 'center';
    const pegsText = centerLabel || `🟠 ${totalOrangePegs - orangePegsLeft}/${totalOrangePegs}`;
    ctx.fillText(pegsText, this.width / 2, 20);
  }

  _consumeEndMessageCallbacks() {
    const callbacks = this._endMessage.dismissCallbacks.splice(0);
    for (const callback of callbacks) {
      try {
        callback();
      } catch (_) {}
    }
  }

  _updateEndMessageState(state) {
    const message = this._endMessage;
    const dtMs = Math.max(
      0,
      Math.min(100, (Number.isFinite(state?.frameDeltaSeconds) ? state.frameDeltaSeconds : (1 / 60)) * 1000)
    );
    const desiredKey = state?.message ? `${state.message}|${state.subMessage || ''}` : '';

    if (!desiredKey && message.dismissedKey) {
      message.dismissedKey = '';
    } else if (desiredKey && message.dismissedKey && desiredKey !== message.dismissedKey) {
      message.dismissedKey = '';
    }

    if (desiredKey) {
      if (!message.key && desiredKey === message.dismissedKey) {
        return null;
      }
      if (message.key !== desiredKey) {
        message.key = desiredKey;
        message.text = state.message;
        message.subtext = state.subMessage || '';
        message.phase = 'delay';
        message.elapsedMs = 0;
        message.alpha = 0;
        message.fadeOutStartAlpha = 1;
        message.dismissCallbacks.length = 0;
      }
    } else if (message.key && message.phase !== 'fadeOut') {
      message.phase = 'fadeOut';
      message.elapsedMs = 0;
      message.fadeOutStartAlpha = Math.max(0, Math.min(1, message.alpha));
    }

    if (!message.key) return null;

    if (message.phase === 'delay') {
      message.elapsedMs += dtMs;
      message.alpha = 0;
      if (message.elapsedMs >= END_MESSAGE_DELAY_MS) {
        message.phase = 'fadeIn';
        message.elapsedMs -= END_MESSAGE_DELAY_MS;
      }
    }

    if (message.phase === 'fadeIn') {
      message.elapsedMs += dtMs;
      const t = Math.max(0, Math.min(1, message.elapsedMs / END_MESSAGE_FADE_IN_MS));
      message.alpha = 1 - Math.pow(1 - t, 3);
      if (t >= 1) {
        message.phase = 'visible';
        message.alpha = 1;
      }
    } else if (message.phase === 'visible') {
      message.alpha = 1;
    } else if (message.phase === 'fadeOut') {
      message.elapsedMs += dtMs;
      const t = Math.max(0, Math.min(1, message.elapsedMs / END_MESSAGE_FADE_OUT_MS));
      message.alpha = message.fadeOutStartAlpha * (1 - t * t * t);
      if (t >= 1) {
        message.dismissedKey = desiredKey || message.key || message.dismissedKey;
        message.key = '';
        message.text = '';
        message.subtext = '';
        message.phase = 'hidden';
        message.elapsedMs = 0;
        message.alpha = 0;
        message.fadeOutStartAlpha = 1;
        this._consumeEndMessageCallbacks();
        return null;
      }
    }

    return message.alpha > 0.001 ? message : null;
  }

  drawMessage(text, subtext = '', alpha = 1) {
    const ctx = this.ctx;
    const t = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
    if (t <= 0.001) return;
    const lift = (1 - t) * END_MESSAGE_LIFT_PX;
    const scale = 0.97 + t * 0.03;
    
    ctx.save();
    ctx.globalAlpha = 0.75 * t;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();

    // Main text
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2 - lift);
    ctx.scale(scale, scale);
    ctx.globalAlpha = t;
    ctx.fillStyle = COLORS.text;
    ctx.font = "bold 28px 'Noto Serif', Georgia, serif";
    ctx.textAlign = 'center';
    ctx.fillText(text, 0, -15);

    // Subtext
    if (subtext) {
      ctx.fillStyle = COLORS.textDim;
      ctx.font = "14px 'Noto Serif', Georgia, serif";
      ctx.fillText(subtext, 0, 15);
    }
    ctx.restore();
  }

  drawSurvivalLoseLine(lineY, timeSeconds = 0) {
    if (!Number.isFinite(lineY)) return;
    const ctx = this.ctx;
    const baseY = Math.round(Math.max(0, Math.min(this.height, lineY))) + 0.5;
    const t = Number.isFinite(timeSeconds) ? timeSeconds : 0;
    const dash = 16;
    const gap = 10;
    const step = dash + gap;
    const offset = (t * 8) % step;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(34, 4, 5, 0.94)';
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    for (let x = -step - offset; x < this.width + step; x += step) {
      const x1 = Math.max(0, x);
      const x2 = Math.min(this.width, x + dash);
      if (x2 <= 0 || x1 >= this.width) continue;
      const y1 = baseY + Math.sin((x1 * 0.036) + t * 0.7) * 1.2;
      const y2 = baseY + Math.sin((x2 * 0.036) + t * 0.7) * 1.2;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(117, 16, 18, 0.7)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let x = -step - offset; x < this.width + step; x += step) {
      const x1 = Math.max(0, x + 1);
      const x2 = Math.min(this.width, x + dash - 1);
      if (x2 <= 0 || x1 >= this.width) continue;
      const y1 = baseY + Math.sin((x1 * 0.036) + t * 0.7) * 1.2;
      const y2 = baseY + Math.sin((x2 * 0.036) + t * 0.7) * 1.2;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    ctx.restore();
  }

  drawVerticalProgressTracker(progressState) {
    if (!progressState) return;
    const remainingRatio = Math.max(0, Math.min(1, progressState.remainingRatio ?? 0));
    const progressRatio = Math.max(0, Math.min(1, progressState.progressRatio ?? 0));

    const ctx = this.ctx;
    const x = 6;
    const y = 36;
    const width = 4;
    const height = Math.max(30, this.height - 72);
    const fillHeight = height * remainingRatio;
    const markerY = y + height * progressRatio;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x, y, width, fillHeight);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
    ctx.fillRect(x - 1, markerY - 1, width + 2, 2);
    ctx.restore();
  }

  // Faint line showing the raw drawn path
  drawSplinePath(rawPoints) {
    if (!rawPoints || rawPoints.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(rawPoints[0].x, rawPoints[0].y);
    for (let i = 1; i < rawPoints.length; i++) {
      ctx.lineTo(rawPoints[i].x, rawPoints[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Semi-transparent preview of where bricks/circles will be placed
  drawGhostBricks(ghostBricks, brickW, brickH, pegType, pegShape) {
    if (!ghostBricks || ghostBricks.length === 0) return;
    const ctx = this.ctx;
    const colors = PEG_COLORS[pegType] || PEG_COLORS.blue;
    const surfaceStyle = this._getPegSurfaceStyle(pegType);
    const radius = PHYSICS_CONFIG.pegRadius;
    const halfH = brickH / 2;
    ctx.save();
    ctx.globalAlpha = 0.6;
    for (const gb of ghostBricks) {
      if (pegShape === 'brick' && gb.slices && gb.slices.length >= 2) {
        // Curved ghost brick — warped ribbon
        if (!this.drawStyledCurvedBrick(ctx, gb.slices, halfH, surfaceStyle, false)) {
          this.drawCurvedBrickPath(ctx, gb.slices, halfH, -halfH);
          ctx.fillStyle = colors.main;
          ctx.fill();
        }
      } else if (pegShape === 'brick') {
        // Flat ghost brick fallback
        ctx.save();
        ctx.translate(gb.x, gb.y);
        ctx.rotate(gb.angle || 0);
        const brickSprite = surfaceStyle ? this._brickPegBodySprite(pegType, brickW, brickH, false) : null;
        if (brickSprite) {
          ctx.drawImage(brickSprite.img, -brickSprite.hw, -brickSprite.hh);
        } else {
          ctx.beginPath();
          ctx.roundRect(-brickW / 2, -brickH / 2, brickW, brickH, 2);
          ctx.fillStyle = colors.main;
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-brickW / 2, -brickH / 2, brickW, brickH, 2);
        ctx.stroke();
        ctx.restore();
      } else {
        // Circle ghost
        ctx.save();
        ctx.translate(gb.x, gb.y);
        const pegSprite = surfaceStyle ? this._pegBodySprite(pegType, radius, false) : null;
        if (pegSprite) {
          ctx.drawImage(pegSprite.img, -pegSprite.half, -pegSprite.half);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, radius, 0, Math.PI * 2);
          ctx.fillStyle = colors.main;
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawWrappedMotionLine(start, motion) {
    if (!start || !motion) return;
    const eps = 1e-6;
    const W = this.width, H = this.height;
    let cx = start.x, cy = start.y;
    let vx = motion.dx || 0, vy = motion.dy || 0;
    let guard = 0;

    const hitAlpha = (px, py, dvx, dvy) => {
      let a = Infinity;
      if (Math.abs(dvx) > eps) {
        const t = (dvx > 0 ? W - px : -px) / dvx;
        if (t > eps) a = Math.min(a, t);
      }
      if (Math.abs(dvy) > eps) {
        const t = (dvy > 0 ? H - py : -py) / dvy;
        if (t > eps) a = Math.min(a, t);
      }
      return a;
    };

    while ((Math.abs(vx) > eps || Math.abs(vy) > eps) && guard < 10) {
      guard++;

      const alphaFwd = hitAlpha(cx, cy, vx, vy);

      if (alphaFwd >= 1) {
        // No wall hit — draw to destination
        this.ctx.beginPath();
        this.ctx.moveTo(cx, cy);
        this.ctx.lineTo(cx + vx, cy + vy);
        this.ctx.stroke();
        break;
      }

      // Draw segment to wall hit
      const wallX = cx + vx * alphaFwd;
      const wallY = cy + vy * alphaFwd;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, cy);
      this.ctx.lineTo(wallX, wallY);
      this.ctx.stroke();

      // Remaining velocity
      const remainVx = vx * (1 - alphaFwd);
      const remainVy = vy * (1 - alphaFwd);

      // Red dot: trace backwards from current pos to wall
      const alphaRev = hitAlpha(cx, cy, -vx, -vy);
      cx = cx - vx * alphaRev;
      cy = cy - vy * alphaRev;
      vx = remainVx;
      vy = remainVy;
    }
  }

  drawAnimationGhosts(ghosts, center, ghostCenter, offset, motion, _inverse = false, circularPath = false, circularFull = false) {
    if (!ghosts || ghosts.length === 0 || !center) return;
    const ctx = this.ctx;
    const radius = PHYSICS_CONFIG.pegRadius;

    const fallbackCenter = offset
      ? { x: center.x + offset.dx, y: center.y + offset.dy }
      : null;
    const targetCenter = ghostCenter || fallbackCenter;

    // Guide line: center → ghost (forward), and center → wall (backward) + fat dot
    ctx.save();
    const dx = (motion && motion.dx) || (targetCenter ? targetCenter.x - center.x : 0);
    const dy = (motion && motion.dy) || (targetCenter ? targetCenter.y - center.y : 0);
    const hasDelta = Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001;

    if (hasDelta) {
      if (circularPath) {
        // Draw circular arc preview
        const D = Math.sqrt(dx * dx + dy * dy);
        const R = D / 2;
        const arcCenterX = center.x + dx / 2;
        const arcCenterY = center.y + dy / 2;
        const theta = Math.atan2(dy, dx);
        const startAngle = theta + Math.PI;

        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        if (circularFull) {
          // Full circle
          ctx.arc(arcCenterX, arcCenterY, R, 0, Math.PI * 2);
        } else {
          // Semicircle: draw the arc from start to end (counterclockwise)
          ctx.arc(arcCenterX, arcCenterY, R, startAngle, startAngle + Math.PI);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw the other half dimmer (for semicircle, shows the unused half)
        if (!circularFull) {
          ctx.strokeStyle = 'rgba(255, 214, 10, 0.25)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 6]);
          ctx.beginPath();
          ctx.arc(arcCenterX, arcCenterY, R, startAngle + Math.PI, startAngle + Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Small dot at the arc center
        ctx.fillStyle = 'rgba(255, 214, 10, 0.6)';
        ctx.beginPath();
        ctx.arc(arcCenterX, arcCenterY, 3, 0, Math.PI * 2);
        ctx.fill();

      } else {
        const W = this.width, H = this.height;

        // Forward line: center → ghost destination (traces through walls)
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        this.drawWrappedMotionLine(center, { dx, dy });
        ctx.setLineDash([]);

        // Reverse line: trace from center in OPPOSITE direction until hitting a wall
        const rdx = -dx, rdy = -dy;
        let wallAlpha = Infinity;

        if (Math.abs(rdx) > 1e-6) {
          const a = (rdx > 0 ? W - center.x : -center.x) / rdx;
          if (a > 1e-6) wallAlpha = Math.min(wallAlpha, a);
        }
        if (Math.abs(rdy) > 1e-6) {
          const a = (rdy > 0 ? H - center.y : -center.y) / rdy;
          if (a > 1e-6) wallAlpha = Math.min(wallAlpha, a);
        }

        if (Number.isFinite(wallAlpha)) {
          const wallX = center.x + rdx * wallAlpha;
          const wallY = center.y + rdy * wallAlpha;

          // Draw reverse dashed line (same color, slightly dimmer)
          ctx.strokeStyle = 'rgba(255, 214, 10, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(center.x, center.y);
          ctx.lineTo(wallX, wallY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Fat dot at wall intersection
          ctx.fillStyle = '#ff3b30';
          ctx.beginPath();
          ctx.arc(wallX, wallY, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Draw ghost pegs at offset position
    ctx.globalAlpha = 0.35;
    for (const ghost of ghosts) {
      this.drawPeg(ghost, false, false);
    }
    ctx.globalAlpha = 1;

    // Yellow outline around each ghost peg to indicate draggable
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 1.5;
    for (const ghost of ghosts) {
      if (ghost.shape === 'brick' && ghost.curveSlices && ghost.curveSlices.length >= 2) {
        const halfH = (ghost.height || radius * 1.2) / 2;
        this.drawCurvedBrickPath(ctx, ghost.curveSlices, halfH + 3, -halfH - 3);
        ctx.stroke();
      } else if (ghost.shape === 'brick') {
        ctx.save();
        ctx.translate(ghost.x, ghost.y);
        ctx.rotate(ghost.angle || 0);
        const w = ghost.width || radius * 4;
        const h = ghost.height || radius * 1.2;
        ctx.strokeRect(-w/2 - 3, -h/2 - 3, w + 6, h + 6);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(ghost.x, ghost.y, radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  drawAnimationIndicators(pegs, groups) {
    if (!pegs) return;
    const ctx = this.ctx;
    const groupAnimIds = new Set();

    // Mark group-animated pegs
    if (groups) {
      for (const g of groups) {
        if (g.animation) {
          for (const p of pegs) {
            if (p.groupId === g.id) groupAnimIds.add(p.id);
          }
        }
      }
    }

    ctx.save();
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd60a';

    for (const peg of pegs) {
      const hasAnim = peg.animation || groupAnimIds.has(peg.id);
      if (hasAnim) {
        const radius = peg.shape === 'brick'
          ? Math.max(peg.width || 40, peg.height || 12) / 2
          : PHYSICS_CONFIG.pegRadius;
        ctx.fillText('\u2194', peg.x, peg.y - radius - 5);
      }
    }
    ctx.restore();
  }

  drawEditorHUD(pegCount, selectedCount, drawMode = false, drawShapeMode = 'free') {
    const ctx = this.ctx;

    ctx.fillStyle = COLORS.textDim;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Pegs: ${pegCount}`, 10, this.height - 15);

    if (selectedCount > 0) {
      ctx.fillText(`Selected: ${selectedCount}`, 80, this.height - 15);
    }

    if (drawMode) {
      ctx.fillStyle = COLORS.orange;
      ctx.textAlign = 'right';
      let hint;
      if (drawShapeMode === 'circle') {
        hint = 'DRAW: Circle (C) | W=sine B=bezier D=free';
      } else if (drawShapeMode === 'sine') {
        hint = 'DRAW: Sine (W) | C=circle B=bezier D=free';
      } else if (drawShapeMode === 'bezier') {
        hint = 'DRAW: Bezier (B) | SHIFT=45° handles | Enter=pegglify';
      } else {
        hint = 'DRAW: Freehand | SHIFT=snap | C=circle W=sine B=bezier';
      }
      ctx.fillText(hint, this.width - 10, this.height - 15);
    }
  }

  drawBezierDraftGuides(draft) {
    if (!draft) return;
    const ctx = this.ctx;

    const drawHandlePoint = (x, y) => {
      const r = 6;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };

    const drawAnchor = (x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    ctx.save();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(draft.start.x, draft.start.y);
    ctx.lineTo(draft.end.x, draft.end.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(66, 167, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(draft.start.x, draft.start.y);
    ctx.lineTo(draft.h1.x, draft.h1.y);
    ctx.moveTo(draft.end.x, draft.end.y);
    ctx.lineTo(draft.h2.x, draft.h2.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(draft.start.x, draft.start.y);
    ctx.bezierCurveTo(
      draft.h1.x, draft.h1.y,
      draft.h2.x, draft.h2.y,
      draft.end.x, draft.end.y
    );
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#42a7ff';
    ctx.lineWidth = 1.5;
    drawAnchor(draft.start.x, draft.start.y);
    drawAnchor(draft.end.x, draft.end.y);

    ctx.fillStyle = '#42a7ff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.25;
    drawHandlePoint(draft.h1.x, draft.h1.y);
    drawHandlePoint(draft.h2.x, draft.h2.y);

    ctx.fillStyle = '#42a7ff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(draft.bend.x, draft.bend.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  drawShapeCenter(x, y) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    const size = 8;
    ctx.beginPath();
    ctx.moveTo(x - size, y);
    ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size);
    ctx.lineTo(x, y + size);
    ctx.stroke();
    ctx.restore();
  }

  drawSelectionBox(startX, startY, endX, endY) {
    const ctx = this.ctx;
    
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);

    ctx.fillStyle = COLORS.selectionFill;
    ctx.fillRect(x, y, w, h);
    
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  drawRotationHandle(handle, bounds, isBumperScale = false) {
    if (!handle || !bounds) return;

    const ctx = this.ctx;

    // Draw selection bounds outline
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      bounds.minX - 4,
      bounds.minY - 4,
      bounds.maxX - bounds.minX + 8,
      bounds.maxY - bounds.minY + 8
    );
    ctx.setLineDash([]);

    // Draw line from top of bounds to handle
    const centerX = (bounds.minX + bounds.maxX) / 2;
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, bounds.minY - 4);
    ctx.lineTo(handle.x, handle.y);
    ctx.stroke();

    // Draw handle circle
    ctx.fillStyle = COLORS.selection;
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, 8, 0, Math.PI * 2);
    ctx.fill();

    if (isBumperScale) {
      // Draw scale arrows icon (↔) instead of rotation dot
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⇔', handle.x, handle.y);
    } else {
      // Inner circle (rotation)
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawPvpMidline(y) {
    if (!Number.isFinite(y)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawPvpCannons(cannons = []) {
    const ctx = this.ctx;
    for (const cannon of cannons) {
      const radius = cannon.radius || 26;
      const hp = Math.max(0, Math.min(cannon.maxHp || 3, cannon.hp ?? 3));
      const maxHp = Math.max(1, cannon.maxHp || 3);
      const ratio = hp / maxHp;
      const x = cannon.x;
      const y = cannon.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      ctx.save();
      ctx.translate(x, y);

      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(17, 24, 39, 0.86)';
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      ctx.fillStyle = cannon.side === 'cpu' ? 'rgba(255, 95, 115, 0.78)' : 'rgba(94, 210, 255, 0.78)';
      ctx.fillRect(-radius, radius - radius * 2 * ratio, radius * 2, radius * 2 * ratio);
      ctx.restore();

      const grad = ctx.createRadialGradient(-radius * 0.35, -radius * 0.45, radius * 0.2, 0, 0, radius);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
      grad.addColorStop(0.62, 'rgba(255, 255, 255, 0.04)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = cannon.side === 'cpu' ? 'rgba(255, 149, 165, 0.92)' : 'rgba(132, 226, 255, 0.92)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 2, 0, Math.PI * 2);
      ctx.stroke();

      if (Number.isFinite(cannon.timerRatio)) {
        const timerRatio = Math.max(0, Math.min(1, cannon.timerRatio));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * timerRatio);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 7, 0, Math.PI * 2);
      ctx.stroke();

      if (Number.isFinite(cannon.aimAngle)) {
        ctx.rotate(cannon.aimAngle);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(radius * 0.55, 0);
        ctx.lineTo(radius * 1.35, 0);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  // Render full game frame
  renderGame(state) {
    const baseCtx = this.baseCtx || this.canvas.getContext('2d', { alpha: false });
    this.ctx = baseCtx;
    this._renderTimeSeconds = Number.isFinite(state.renderTimeSeconds)
      ? state.renderTimeSeconds
      : (typeof performance !== 'undefined' ? performance.now() / 1000 : 0);

    const shockwaveActive = this._shockwaveEffect.syncEvents(state.backgroundEvents, {
      preview: !!state.shockwavePreview,
      timeSeconds: state.renderTimeSeconds,
      width: this.width,
      height: this.height
    });
    this.clear(state.levelProgress, state);
    
    const cameraY = Number.isFinite(state.cameraY) ? state.cameraY : 0;
    const drewSurvivalBackground = this.drawSurvivalBackground(state.survivalBackground, cameraY, state.worldHeight);
    if (drewSurvivalBackground && this._bgVignetteCanvas) {
      this.ctx.drawImage(this._bgVignetteCanvas, 0, 0);
    }

    if (state.showGrid) {
      this.showGrid = true;
      this.drawGrid(cameraY);
    }

    const useCamera = Math.abs(cameraY) > 0.001;
    if (useCamera) {
      this.ctx.save();
      this.ctx.translate(0, -cameraY);
    }

    if (Number.isFinite(state.pvpMidline)) {
      this.drawPvpMidline(state.pvpMidline);
    }

    this.drawPegs(
      state.pegs,
      state.hitPegIds,
      state.selectedPegIds || new Set(),
      state.wrapCopyPegIds || null
    );

    // Draw ghost preview during draw mode
    if (state.ghostBricks && state.ghostBricks.length > 0) {
      this.drawSplinePath(state.drawPath);
      this.drawGhostBricks(state.ghostBricks, state.brickWidth, state.brickHeight, state.pegType, state.pegShape);
    }

    // Draw trajectory before ball
    if (state.trajectory) {
      if (state.trajectoryStyle === 'qte') {
        this.drawQteTrajectory(state.trajectory);
      } else {
        this.drawTrajectory(state.trajectory, state.showFullTrajectory, state.aimLength);
      }
    }

    if (state.yoyoThreads) {
      this.drawYoyoThreads(state.yoyoThreads);
    }

    if (state.pvpCannons) {
      this.drawPvpCannons(state.pvpCannons);
    }

    if (useCamera) {
      this.ctx.restore();
    }

    if (shockwaveActive) {
      const waveCanvas = this._shockwaveEffect.renderToCanvas(this.canvas, {
        cameraY,
        width: this.width,
        height: this.height,
        profile: this.performanceProfile,
        preview: !!state.shockwavePreview,
        timeSeconds: state.renderTimeSeconds,
        skipPrune: true
      });
      this._setShockwaveLayerVisible(!!waveCanvas);
    } else {
      this._setShockwaveLayerVisible(false);
      this._scheduleShockwavePrewarm();
    }

    const sceneCtx = this.ctx;
    const foregroundCtx = this._prepareForegroundLayer();
    this.ctx = foregroundCtx || sceneCtx;
    if (!foregroundCtx) {
      this._setShockwaveLayerVisible(false);
    }

    if (useCamera) {
      this.ctx.save();
      this.ctx.translate(0, -cameraY);
    }

    const ballTrailPreviewBall = this._ballTrail.render(
      this.ctx,
      this.ballTrailConfig,
      state,
      this._bgBlendDisplayed,
      this.width,
      this.height,
      getBallRadius(),
      this.performanceProfile
    );
    
    if (state.balls) {
      this.drawBalls(state.balls);
    } else if (state.ball) {
      this.drawBall(state.ball);
    }

    if (ballTrailPreviewBall) {
      this.drawBall(ballTrailPreviewBall);
    }

    if (state.showQteAim) {
      this.drawAimReticle(state.qteAimX, state.qteAimY, state.qteAimAngle);
    }

    if (state.bucket) {
      this.drawBucket(state.bucket, state.bucketFlash);
    }

    if (state.flippers) {
      this.drawFlippers(state.flippers, this.canvas.width, state.flipperSelected);
    }

    if (state.showLauncher) {
      this.drawLauncher(state.launchX, state.launchY, state.aimAngle, state.showAim, state.launcherBallScale, state.launcherOptions || null);
    }

    if (Array.isArray(state.secondaryLaunchers)) {
      for (const launcher of state.secondaryLaunchers) {
        this.drawLauncher(
          launcher.x,
          launcher.y,
          launcher.angle || Math.PI / 2,
          !!launcher.showAim,
          launcher.ballScale,
          launcher
        );
      }
    }

    if (state.selectionBox) {
      this.drawSelectionBox(
        state.selectionBox.startX,
        state.selectionBox.startY,
        state.selectionBox.endX,
        state.selectionBox.endY
      );
    }

    // Draw rotation/scale handle for selected elements
    if (state.rotationHandle && state.selectionBounds) {
      this.drawRotationHandle(state.rotationHandle, state.selectionBounds, state.isBumperSelection);
    }

    // Animation ghosts (editor animation mode)
    if (state.animationMode && state.animationGhosts) {
      this.drawAnimationGhosts(
        state.animationGhosts,
        state.animationCenter,
        state.animationGhostCenter,
        state.animationGhostOffset,
        state.animationMotion,
        state.animationInverse,
        state.animationCircularPath,
        state.animationCircularFull
      );
    }

    if (state.drawCenter) {
      this.drawShapeCenter(state.drawCenter.x, state.drawCenter.y);
    }

    if (state.drawBezier) {
      this.drawBezierDraftGuides(state.drawBezier);
    }

    if (state.isEditor && !state.animationMode) {
      this.drawAnimationIndicators(state.pegs, state.groups);
    }

    if (useCamera) {
      this.ctx.restore();
    }

    if (state.survivalLoseLineY != null) {
      this.drawSurvivalLoseLine(state.survivalLoseLineY, state.renderTimeSeconds);
    }

    if (typeof this.onVerticalProgress === 'function') {
      this.onVerticalProgress(state.verticalProgress || null);
    }

    // Legacy HUD hidden — score/balls/orange pegs now shown via visual layout slots
    // (drawScore method retained for logic compatibility)
    // if (state.score !== undefined) {
    //   this.drawScore(state.score, state.ballsLeft, state.orangePegsLeft, state.totalOrangePegs, state.centerLabel || null);
    // }

    const endMessage = this._updateEndMessageState(state);
    if (endMessage) {
      this.drawMessage(endMessage.text, endMessage.subtext, endMessage.alpha);
    }

    if (state.isEditor) {
      this.drawEditorHUD(state.pegs.length, state.selectedPegIds?.size || 0, state.drawMode, state.drawShapeMode);
    }

    this.ctx = sceneCtx;
  }
}
