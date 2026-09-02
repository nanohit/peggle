// Peggle Renderer - Canvas rendering for game and editor

import { PHYSICS_CONFIG, getBallRadius, getEffectiveBrickSize } from './physics.js';
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
import { FLIPPER_DEFAULTS } from './flipper-defaults.js';
import { getMagnetRadius, getMagnetStrength, isMagnetForceActive, normalizeMagnetMode } from './magnet-defaults.js';
import { normalizePegType } from './peg-types.js';
import { paintGlassOrb, PEG_SURFACE_STYLES as GLASS_PEG_STYLES } from './peg-surface.js';
import { GpuPlayfieldRenderer } from './gpu-playfield.js';
import {
  drawMachineAtmosphere,
  drawMachineBackdrop,
  drawMachineBall,
  drawMachineBumper,
  drawMachineCatcher,
  drawMachineFlipper,
  drawMachineLauncher,
  drawPegContactShadow
} from './neon-machine.js';
import {
  assetCacheKey,
  isAssetImageSource,
  loadImageFromCandidates
} from './asset-ref.js';

const FLIPPER_ASSET_SRC = 'visuals/assets_webtp/flipper.webp';
const FLIPPER_ASSET_PIVOT_X_RATIO = 26.5 / 267;
const FLIPPER_ASSET_OPAQUE_TOP_RATIO = 1 / 53;
const FLIPPER_ASSET_OPAQUE_BOTTOM_RATIO = 51 / 53;
const MAGNET_FIELD_PROFILE_LIMITS = Object.freeze({ full: 6, balanced: 4, lite: 2 });

// Late background-image fade-in: if a CDN-hosted background takes longer than
// the grace period to arrive, the level renders on black and the image fades
// in instead of popping over the placeholder. Cached/instant loads (< grace)
// keep the old immediate appearance.
const BG_IMAGE_LATE_GRACE_MS = 150;
const BG_IMAGE_FADE_IN_MS = 450;

// Magnet-field visualization mode. The persistent GL distortion pass costs
// ~1ms/frame of GPU+pipeline time the whole time a magnet is on screen, and
// the cost is fixed pipeline overhead (full-canvas texture upload + sync) —
// measured: half-res/bbox internal rendering does NOT meaningfully help.
// The 2D fallback is kept behind `?magnetfx=2d` for on-device A/B, but the
// default stays GL so authored magnet distortion remains visible everywhere.
// Blast shockwaves stay GL everywhere (transient), and while one is active the
// field rings ride that GL pass for free, exactly like the lite profile does.
function getMagnetFieldModeOverride() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = (new URL(window.location.href).searchParams.get('magnetfx') || '').toLowerCase();
    if (raw === 'gl' || raw === '2d') return raw;
  } catch (error) {
    // ignore malformed URLs
  }
  return null;
}

const MAGNET_FIELD_MODE = getMagnetFieldModeOverride() || 'gl';

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

  // Bomb peg — hotter/brighter red than billiardRed, explodes on hit
  bomb: '#ff1f2d',
  bombHit: '#ff7a5c',
  bombGlow: 'rgba(255, 31, 45, 0.6)',

  magnet: '#22d3ee',
  magnetHit: '#ff6b4a',
  magnetGlow: 'rgba(34, 211, 238, 0.58)',
  magnetRepelGlow: 'rgba(255, 82, 68, 0.5)',

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
  bomb: { main: COLORS.bomb, hit: COLORS.bombHit, glow: COLORS.bombGlow },
  bombMagnet: { main: COLORS.magnet, hit: COLORS.magnetHit, glow: COLORS.magnetGlow },
  billiardYellow: { main: COLORS.billiardYellow, hit: COLORS.billiardYellowHit, glow: COLORS.billiardYellowGlow },
  blue: { main: COLORS.blue, hit: COLORS.blueHit, glow: COLORS.blueGlow },
  green: { main: COLORS.green, hit: COLORS.greenHit, glow: COLORS.greenGlow },
  lime: { main: COLORS.green, hit: COLORS.greenHit, glow: COLORS.greenGlow },
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
  bomb: {
    bright: '#ffd0b0',
    light: '#ff6b4a',
    main: '#ff1f2d',
    deep: '#9c0410',
    shadow: '#3d0205',
    rimLight: 'rgba(255, 138, 92, 0.98)',
    line: 'rgba(255, 196, 150, 0.5)',
    core: 'rgba(255, 60, 50, 0.5)',
    glow: 'rgba(255, 31, 45, 0.38)',
    hitBright: '#ffffff',
    hitLight: '#ffb38f',
    hitMain: '#ff5a3c'
  },
  bombMagnet: {
    bright: '#d7fcff',
    light: '#22d3ee',
    main: '#2166d8',
    deep: '#ff4b35',
    shadow: '#47040a',
    rimLight: 'rgba(115, 245, 255, 0.94)',
    line: 'rgba(255, 177, 120, 0.46)',
    core: 'rgba(34, 211, 238, 0.42)',
    glow: 'rgba(34, 211, 238, 0.3)',
    hitBright: '#ffffff',
    hitLight: '#ffb081',
    hitMain: '#ff5a3c'
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
// How long a knocked-out peg keeps lighting the board after its body is gone.
// A light that switches off in the same frame the peg stops existing reads as a
// pop; a short tail reads as the peg being extinguished.
const PEG_EXIT_GLOW_MS = 420;

// When a render layer's inputs are unchanged its redraw is skipped; a forced
// redraw every N frames bounds worst-case staleness if a dirty signal is
// ever missed (self-heal within ~0.5s at 60fps).
const LAYER_SKIP_HEARTBEAT_FRAMES = 30;
const PEG_ENTRY_SWEEP_BEZIER = Object.freeze({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
const PEG_ENTRY_SCALE_BEZIER = Object.freeze({ x1: 0.4, y1: 0, x2: 0.2, y2: 1 });

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function cubicBezierCoordinate(t, p1, p2) {
  const inv = 1 - t;
  return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
}

function cubicBezierEase(x, curve = PEG_ENTRY_SCALE_BEZIER) {
  const target = clamp01(x);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5;
    if (cubicBezierCoordinate(mid, curve.x1, curve.x2) < target) lo = mid;
    else hi = mid;
  }
  return cubicBezierCoordinate((lo + hi) * 0.5, curve.y1, curve.y2);
}

function cubicBezierTimeForProgress(progress, curve = PEG_ENTRY_SWEEP_BEZIER) {
  const target = clamp01(progress);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5;
    if (cubicBezierCoordinate(mid, curve.y1, curve.y2) < target) lo = mid;
    else hi = mid;
  }
  return cubicBezierCoordinate((lo + hi) * 0.5, curve.x1, curve.x2);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
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
    this._bgConfigSetAtMs = 0;
    this._bgImageFadePending = false;
    this._bgFadeStartMs = 0;
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
    this._gpuPlayfield = new GpuPlayfieldRenderer();
    this._gpuSceneActive = false;
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
    this._pegEntryAnimations = new Map();
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

    // Layer frame-skip: when a layer's inputs are provably unchanged the whole
    // redraw (and the compositor texture re-upload it forces) is skipped.
    // Runtimes opt in by passing baseSceneDynamic:false / fgSceneDynamic:false;
    // absent flags mean "always dynamic" (editor keeps full per-frame redraw).
    this._frameSkip = {
      epoch: 0,          // bumped whenever the backing stores get cleared (resize)
      baseSig: null,
      baseScratch: [],
      baseSkipStreak: 0,
      fgSig: null,
      fgScratch: [],
      fgSkipStreak: 0,
      // diagnostics (read by the ?perf=1 log)
      frames: 0,
      baseDraws: 0,
      fgDraws: 0
    };

    // Glow sprite cache: pre-rendered blur effects stamped via drawImage()
    // instead of per-frame ctx.shadowBlur (which is software-rasterized on
    // Chrome/Safari and extremely slow).
    this._glowCache = new Map();

    // Asset-free gameplay materials. Keeping these fields null preserves the
    // existing renderer contract while forcing the procedural fallbacks.
    this._bucketImg = null;
    this._flipperImg = null;

    // Bucket catch particle system
    this._bucketParticles = [];
    this._prevBucketFlash = 0;

    this._billiardCannonImages = {
      top: null,
      circle: null
    };
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    // Assigning canvas.width always clears the backing store (even with the
    // same value), so any skipped-frame content is gone — force full redraws.
    this._frameSkip.epoch++;
    this._frameSkip.baseSig = null;
    this._frameSkip.fgSig = null;
    this.canvas.width = width;
    this.canvas.height = height;
    this.launchX = width / 2;
    this._bgBaseDirty = true;
    this._bgOverlayDirty = true;
    this._bgVignetteDirty = true;
    this._shockwavePrewarmKey = '';
    this._syncRenderLayers();
    this._gpuPlayfield?.resize(width, height);
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
    return PEG_SURFACE_STYLES[normalizePegType(type)] || null;
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

    paintGlassOrb(g, {
      cx: c,
      cy: c,
      r: rr,
      style: GLASS_PEG_STYLES[normalizePegType(type)] || GLASS_PEG_STYLES.blue,
      ambient: [66, 222, 246],
      hitMix: isHit ? 1 : 0,
      recipe: {
        candleAlpha: isHit ? 0.5 : 0.3,
        botHaloAlpha: isHit ? 0.78 : 0.54,
        specMainAlpha: 1,
        microSpecAlpha: 0.72
      }
    });

    e = { img: oc, half: c };
    return this._storeGlowCache(key, e);

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
    this._bgConfigSetAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._bgImageFadePending = false;
    this._bgFadeStartMs = 0;
    // Authored backgrounds remain in the level data for compatibility, but the
    // player skin is now one coherent procedural machine well. Avoid fetching
    // large CDN images that are intentionally no longer shown.
    this._bgImage = null;
    this._bgImageSrc = '';
    this._bgProgressImage = null;
    this._bgProgressImageSrc = '';
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
      // The lighting solve is fragment-bound: fewer cascades and a coarser
      // probe grid are what keep it inside frame budget on weak hardware.
      this._gpuPlayfield?.setQuality(nextProfile === 'lite' ? 'low' : 'high');
    }
  }

  _loadBackgroundAsset(src, imageProp, srcProp, dirtyProp) {
    if (!isAssetImageSource(src)) {
      this[srcProp] = '';
      this[imageProp] = null;
      this[dirtyProp] = true;
      return;
    }
    const key = assetCacheKey(src);
    if (this[srcProp] === key) return;

    this[srcProp] = key;
    this[imageProp] = null;
    this[dirtyProp] = true;

    // This image is drawn onto the game canvas. Without crossOrigin a
    // CDN-hosted asset taints the canvas, and every later texImage2D from
    // it (shockwave/magnet WebGL pass) throws SecurityError — killing all
    // WebGL effects for the rest of the session. Failed/hung candidates
    // fall through to the same-origin /api/assets fallback.
    loadImageFromCandidates(src, { crossOrigin: 'anonymous' }).then(result => {
      if (this[srcProp] !== key) return;
      this[imageProp] = result ? result.img : null;
      this[dirtyProp] = true;
    });
  }

  _hasProgressionBackground(bg = this.backgroundConfig) {
    return !!(bg && bg.type === 'image' && isAssetImageSource(bg.progressionImage));
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
      this._applySceneLayerOrder();
      this._renderLayerHostReady = true;
    }

    return host;
  }

  // The shockwave pass composites an opaque distorted copy of whichever layer
  // holds the scene, so it has to sit directly above that layer — the GPU
  // playfield when it is active, the 2D canvas when it is not.
  _sceneLayerZ() {
    return this._gpuSceneActive
      ? { main: 2, shockwave: 1, foreground: 3 }
      : { main: 1, shockwave: 2, foreground: 3 };
  }

  _applySceneLayerOrder() {
    const z = this._sceneLayerZ();
    const main = String(z.main);
    if (this.canvas && this.canvas.style.zIndex !== main) this.canvas.style.zIndex = main;
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

    this._applyLayerLayout(this._foregroundCanvas, this._sceneLayerZ().foreground);
    this._applyLayerVisibility(this._foregroundCanvas, true);
    return !!this._foregroundCtx;
  }

  _ensureGpuPlayfield() {
    const host = this._ensureLayerHost();
    if (!host || !this._gpuPlayfield?.attach(host)) return false;
    this._applyLayerLayout(this._gpuPlayfield.canvas, 0);
    this._applyLayerVisibility(this._gpuPlayfield.canvas, true);
    this._installPlayfieldTuner();
    return true;
  }

  // Loaded as its own chunk so the tuner never sits in the hot path. It applies
  // any saved lighting preset on load and binds Ctrl+Shift+L; it only shows the
  // panel when asked (?tune=1 or the shortcut).
  _installPlayfieldTuner() {
    if (this._tunerRequested || typeof window === 'undefined') return;
    this._tunerRequested = true;
    import('./playfield-tuner.js')
      .then(module => module.installPlayfieldTuner(this._gpuPlayfield, {
        getHostCanvas: () => this._gpuPlayfield?.canvas,
        // Lighting edits change the base scene, which is otherwise only
        // redrawn when gameplay state changes.
        onChange: () => { this._frameSkip.epoch++; }
      }))
      .catch(error => console.warn('[playfield-tuner] unavailable:', error));
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

    // Between the GPU playfield it distorts and the 2D layer above it.
    this._applyLayerLayout(shockwaveCanvas, this._sceneLayerZ().shockwave);
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
    const ownsBackingStore = canvas.dataset.ownsBackingStore === '1';

    if (
      prev
      && (ownsBackingStore || (canvas.width === this.width && canvas.height === this.height))
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

    // The GPU playfield sizes its own backing store: it supersamples above the
    // logical resolution, so forcing width/height here would undo that.
    if (canvas.dataset.ownsBackingStore !== '1') {
      if (canvas.width !== this.width) canvas.width = this.width;
      if (canvas.height !== this.height) canvas.height = this.height;
    }

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
    if (this._gpuPlayfield?.canvas) {
      this._applyLayerLayout(this._gpuPlayfield.canvas, 0);
      this._applyLayerVisibility(this._gpuPlayfield.canvas, this._gpuSceneActive);
    }
    if (this._shockwaveLayerCanvas) {
      this._applyLayerLayout(this._shockwaveLayerCanvas, this._sceneLayerZ().shockwave);
      this._applyLayerVisibility(this._shockwaveLayerCanvas, this._shockwaveLayerVisible);
    }
    if (this._foregroundCanvas) {
      this._applyLayerLayout(this._foregroundCanvas, this._sceneLayerZ().foreground);
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
    this._gpuPlayfield?.dispose();
    this._gpuSceneActive = false;
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

    drawMachineBackdrop(ctx, this.width, this.height);
    return;

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
    } else if (bg?.type === 'image') {
      // Image background still loading (CDN): hold black instead of the
      // default gradient; clear() fades the image in when it arrives.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.width, this.height);
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
    const key = `${this.width}|${this.height}|neon-machine-v1`;
    if (!this._bgBaseDirty && this._bgBaseKey === key && this._bgBaseCanvas) return;

    const canvas = this._ensureBackgroundCanvas('_bgBaseCanvas');
    const ctx = canvas.getContext('2d');
    this._drawBackgroundLayer(ctx, bg, this._bgImage);
    this._bgBaseKey = key;
    this._bgBaseDirty = false;
  }

  _ensureBgOverlayCache() {
    const bg = this.backgroundConfig;
    const hasProgression = false;
    const key = `${this.width}|${this.height}|neon-machine-overlay`;
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

    // Restrained edge vignette: the generated well already contains its own
    // recess, so this only adds depth instead of swallowing the playfield.
    const edgeV = 68;
    const edgeH = 30;
    const edgeAlpha = 0.38;

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
    if (this._gpuSceneActive) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      return;
    }
    this._ensureBgBaseCache();
    this._ensureBgVignetteCache();
    this.ctx.drawImage(this._bgBaseCanvas, 0, 0);
    drawMachineAtmosphere(
      this.ctx,
      this.width,
      this.height,
      (this._renderTimeSeconds || 0) * 1000,
      progressRatio
    );
    if (this._bgVignetteCanvas) this.ctx.drawImage(this._bgVignetteCanvas, 0, 0);
    return;

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

    // Late image-background fade-in (see BG_IMAGE_LATE_GRACE_MS). While the
    // image is missing the base cache holds black; when it arrives late we
    // ramp its alpha over black instead of swapping abruptly.
    let baseAlpha = 1;
    const bgConf = this.backgroundConfig;
    if (bgConf?.type === 'image') {
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!this._bgImage) {
        if (nowMs - this._bgConfigSetAtMs > BG_IMAGE_LATE_GRACE_MS) {
          this._bgImageFadePending = true;
        }
      } else if (this._bgImageFadePending) {
        this._bgImageFadePending = false;
        this._bgFadeStartMs = nowMs;
      }
      if (this._bgFadeStartMs > 0) {
        const t = (nowMs - this._bgFadeStartMs) / BG_IMAGE_FADE_IN_MS;
        if (t >= 1) {
          this._bgFadeStartMs = 0;
        } else {
          baseAlpha = this._smoothstep01(t);
        }
      }
    } else {
      this._bgImageFadePending = false;
      this._bgFadeStartMs = 0;
    }

    if (baseAlpha < 1) {
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.ctx.save();
      this.ctx.globalAlpha = baseAlpha;
      this.ctx.drawImage(this._bgBaseCanvas, 0, 0);
      this.ctx.restore();
    } else {
      this.ctx.drawImage(this._bgBaseCanvas, 0, 0);
    }

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
    if (!isAssetImageSource(src)) return null;
    const key = assetCacheKey(src);
    if (this._survivalBgImageSrc === key) {
      // Either loaded, or still loading (null) — don't restart the load.
      return this._survivalBgImage;
    }

    this._survivalBgImageSrc = key;
    this._survivalBgImage = null;
    // Drawn onto the game canvas — must not taint it (see _loadBackgroundAsset).
    loadImageFromCandidates(src, { crossOrigin: 'anonymous' }).then(result => {
      if (this._survivalBgImageSrc !== key) return;
      if (result) {
        this._survivalBgImage = result.img;
      } else {
        this._survivalBgImage = null;
        this._survivalBgImageSrc = '';
      }
    });
    return this._survivalBgImage;
  }

  drawSurvivalBackground(background, cameraY = 0, worldHeight = this.height) {
    // Survival levels share the same scalable procedural well; their camera and
    // physics still operate normally, only the legacy image layer is skipped.
    return false;

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

  // Gather active magnet rings (world coords) for the WebGL force-field shimmer.
  // Capped at the shader's field budget; nearest-to-top order is not important.
  _collectMagnetFieldRings(pegs = [], cameraY = 0) {
    if (!Array.isArray(pegs) || pegs.length === 0) return this._emptyFieldRings || (this._emptyFieldRings = []);
    const rings = [];
    const profile = normalizeTrailPerformanceProfile(this.performanceProfile);
    const maxRings = MAGNET_FIELD_PROFILE_LIMITS[profile] || MAGNET_FIELD_PROFILE_LIMITS.balanced;
    const top = Number.isFinite(cameraY) ? cameraY : 0;
    const bottom = top + this.height;
    for (const peg of pegs) {
      if (!isMagnetForceActive(peg)) continue;
      const radius = getMagnetRadius(peg);
      if (!Number.isFinite(radius) || radius <= 0) continue;
      const x = Number.isFinite(peg.x) ? peg.x : 0;
      const y = Number.isFinite(peg.y) ? peg.y : 0;
      const margin = Math.max(12, radius * 0.1 + 10);
      if (x + radius + margin < 0 || x - radius - margin > this.width
        || y + radius + margin < top || y - radius - margin > bottom) {
        continue;
      }
      rings.push({
        x,
        y,
        radius,
        strength: getMagnetStrength(peg),
        mode: normalizeMagnetMode(peg.magnetMode)
      });
      if (rings.length >= maxRings) break;
    }
    return rings.length > 0 ? rings : (this._emptyFieldRings || (this._emptyFieldRings = []));
  }

  drawMagnetRadii(pegs = [], cameraY = 0) {
    if (!Array.isArray(pegs) || pegs.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 6]);
    for (const peg of pegs) {
      if (!isMagnetForceActive(peg)) continue;
      const radius = getMagnetRadius(peg);
      if (!Number.isFinite(radius) || radius <= 0) continue;
      const mode = normalizeMagnetMode(peg.magnetMode);
      const x = Number.isFinite(peg.x) ? peg.x : 0;
      const y = (Number.isFinite(peg.y) ? peg.y : 0) - cameraY;
      if (x + radius < 0 || x - radius > this.width || y + radius < 0 || y - radius > this.height) continue;

      const color = mode === 'repel' ? COLORS.magnetRepelGlow : COLORS.magnetGlow;
      ctx.strokeStyle = color;
      ctx.fillStyle = mode === 'repel' ? 'rgba(255, 82, 68, 0.055)' : 'rgba(34, 211, 238, 0.05)';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.strokeStyle = mode === 'repel' ? 'rgba(255, 170, 120, 0.82)' : 'rgba(180, 252, 255, 0.82)';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(4, PHYSICS_CONFIG.pegRadius + 4), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([5, 6]);
    }
    ctx.restore();
  }

  drawLiteMagnetFields(rings = [], cameraY = 0, timeSeconds = 0) {
    if (!Array.isArray(rings) || rings.length === 0) return;
    const ctx = this.ctx;
    const phase = (Number.isFinite(timeSeconds) ? timeSeconds : 0) * 2.4;
    ctx.save();
    ctx.lineWidth = 1.35;
    for (const ring of rings) {
      const radius = Number(ring?.radius);
      if (!Number.isFinite(radius) || radius <= 0) continue;
      const x = Number.isFinite(ring.x) ? ring.x : 0;
      const y = (Number.isFinite(ring.y) ? ring.y : 0) - cameraY;
      const mode = normalizeMagnetMode(ring.mode);
      const pulse = 0.5 + 0.5 * Math.sin(phase + radius * 0.013 + x * 0.01);
      // The reach indicator is a gameplay hint, not scenery: keep it faint
      // enough that it does not compete with the lit board.
      ctx.strokeStyle = mode === 'repel'
        ? `rgba(255, 82, 68, ${0.06 + pulse * 0.035})`
        : `rgba(34, 211, 238, ${0.06 + pulse * 0.035})`;
      ctx.setLineDash([7, 9]);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // No outline ring around the ball itself — the magnet is lit geometry in
      // the GPU pass, and a painted circle on top of it just flattens it.
    }
    ctx.restore();
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
    const pegType = normalizePegType(peg.type);
    const colors = PEG_COLORS[pegType] || PEG_COLORS.blue;
    const radius = PHYSICS_CONFIG.pegRadius;

    if (!peg.curveSlices && !isPortalType(peg.type)) {
      const size = peg.shape === 'brick' ? getEffectiveBrickSize(peg) : null;
      const shadowRadius = peg.type === 'bumper'
        ? radius * (peg.bumperScale || 1) * (peg._bumperHitScale || 1)
        : radius;
      drawPegContactShadow(
        ctx,
        peg.x,
        peg.y,
        shadowRadius,
        peg.shape,
        size?.width || 0,
        size?.height || 0,
        peg.angle || 0
      );
    }

    if (peg.type === 'bumper') {
      const bumperRadius = radius * (peg.bumperScale || 1) * (peg._bumperHitScale || 1);
      drawMachineBumper(ctx, peg, bumperRadius, isHit);
      return;
    }

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
      const halfH = getEffectiveBrickSize(peg).height / 2;
      const sl = peg.curveSlices;
      const surfaceStyle = !peg.color ? this._getPegSurfaceStyle(pegType) : null;
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
    const surfaceStyle = !peg.color ? this._getPegSurfaceStyle(pegType) : null;

    if (peg.shape === 'brick') {
      const { width: w, height: h } = getEffectiveBrickSize(peg);
      const brickSprite = surfaceStyle ? this._brickPegBodySprite(pegType, w, h, isHit) : null;

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
      const pegSprite = surfaceStyle ? this._pegBodySprite(pegType, radius, isHit) : null;
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
        const { width: w, height: h } = getEffectiveBrickSize(peg);
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
        const { width: w, height: h } = getEffectiveBrickSize(peg);
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

  queuePegEntryAnimations(pegs, options = {}) {
    const list = (Array.isArray(pegs) ? pegs : [pegs]).filter(peg => peg && peg.id);
    if (!list.length) return 0;
    const nowMs = typeof performance !== 'undefined'
      ? performance.now()
      : (this._renderTimeSeconds || 0) * 1000;
    const baseDelayMs = Math.max(0, Number(options.delayMs) || 0);
    const staggerMs = Math.max(0, Number(options.staggerMs) || 16);
    const durationMs = Math.max(120, Number(options.durationMs) || PEG_EXIT_SHRINK_MS);
    const maxSpreadMs = Math.max(0, Number(options.maxSpreadMs) || 560);
    const centerOut = options.order === 'center-out-y' || Number.isFinite(options.originY);
    const originY = Number.isFinite(options.originY) ? options.originY : this.height / 2;
    const maxDistanceFromOrigin = centerOut
      ? Math.max(1, ...list.map(peg => Math.abs((Number.isFinite(peg.y) ? peg.y : originY) - originY)))
      : 1;
    const ordered = [...list].sort((a, b) => {
      const ay = Number.isFinite(a.y) ? a.y : 0;
      const by = Number.isFinite(b.y) ? b.y : 0;
      if (centerOut) {
        const ad = Math.abs(ay - originY);
        const bd = Math.abs(by - originY);
        if (Math.abs(ad - bd) > 0.001) return ad - bd;
        return ay - by;
      }
      return by - ay;
    });
    const spreadMs = Math.min(maxSpreadMs, Math.max(0, ordered.length - 1) * staggerMs);

    this._pegEntryAnimations.clear();
    for (let i = 0; i < ordered.length; i++) {
      const peg = ordered[i];
      const rank = centerOut
        ? Math.abs((Number.isFinite(peg.y) ? peg.y : originY) - originY) / maxDistanceFromOrigin
        : (ordered.length > 1 ? i / (ordered.length - 1) : 0);
      const delayMs = baseDelayMs + cubicBezierTimeForProgress(rank) * spreadMs;
      this._pegEntryAnimations.set(peg.id, {
        peg: this._clonePegForExitAnimation(peg),
        startMs: nowMs + delayMs,
        durationMs
      });
    }
    return baseDelayMs + spreadMs + durationMs;
  }

  clearPegEntryAnimations() {
    this._pegEntryAnimations.clear();
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
      // Anything the GPU pass can draw is sinking through the board there, lit
      // by the same solve as everything else. Drawing a flat 2D copy over it
      // would both double it up and swap its material mid-animation.
      if (this._gpuSceneActive && this._gpuPlayfield?.isSupported(anim.peg)) continue;
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

  // The GPU path can't use the 2D entry animation, because scaling a canvas
  // draw has nothing to do with how a solid comes up through the board. It
  // takes the raw progress instead and rises the real geometry: the board
  // plane cuts each peg, so the cap you see widens and its height — and the
  // shadow the solve throws from it — grow together.
  //
  // Expiring finished entries here is also what keeps the base scene from
  // redrawing forever, since GPU-drawn pegs never reach drawPegEntryAnimation.
  // Entering and exiting pegs share one channel, because they are the same
  // motion: a solid moving through the board plane, one way or the other.
  _collectPegLifecycle() {
    const map = this._pegEmergence || (this._pegEmergence = new Map());
    map.clear();
    this._fillPegEmergence(map);
    const exits = this._collectPegExits(map);
    return { emergence: map.size > 0 ? map : null, exits };
  }

  _fillPegEmergence(map) {
    const animations = this._pegEntryAnimations;
    if (!animations || animations.size === 0) return;
    const nowMs = typeof performance !== 'undefined'
      ? performance.now()
      : (this._renderTimeSeconds || 0) * 1000;

    for (const [pegId, anim] of animations) {
      const elapsed = nowMs - anim.startMs;
      if (elapsed < 0) { map.set(pegId, 0); continue; }
      const durationMs = Math.max(1, anim.durationMs || PEG_EXIT_SHRINK_MS);
      const t = Math.min(1, elapsed / durationMs);
      if (t >= 1) { animations.delete(pegId); continue; }
      map.set(pegId, cubicBezierEase(t));
    }
  }

  // A knocked-out peg leaves the game's peg list immediately, so without this
  // the GPU scene loses it — and its shadow and its glow — in one frame, while
  // a flat 2D sprite shrinks on top. Instead it stays in the scene and sinks
  // back through the board (the level intro's rise, run backwards), so the cap
  // narrows, the height drops and the cast shadow retreats together. Its light
  // then outlives the body by a short tail.
  //
  // Returns the exiting pegs and writes their sink progress into `emergence`,
  // which is the same channel the intro uses.
  _collectPegExits(emergence) {
    const animations = this._pegExitAnimations;
    if (!animations || animations.size === 0) return null;
    const nowMs = typeof performance !== 'undefined'
      ? performance.now()
      : (this._renderTimeSeconds || 0) * 1000;

    const list = this._pegExitList || (this._pegExitList = []);
    list.length = 0;
    for (const [pegId, anim] of animations) {
      const elapsed = Math.max(0, nowMs - anim.startMs);
      if (elapsed >= PEG_EXIT_GLOW_MS) { animations.delete(pegId); continue; }
      if (!this._gpuPlayfield?.isSupported(anim.peg)) continue;
      const sink = 1 - Math.min(1, elapsed / PEG_EXIT_SHRINK_MS);
      // Squared, so the glow holds through the sink and then falls away.
      const fade = 1 - elapsed / PEG_EXIT_GLOW_MS;
      list.push({ peg: anim.peg, sink, glow: fade * fade });
      if (sink > 0) emergence?.set(pegId, sink);
    }
    return list.length > 0 ? list : null;
  }

  drawPegEntryAnimation(peg, isHit = false, isSelected = false) {
    const anim = this._pegEntryAnimations?.get(peg?.id);
    if (!anim) return false;
    const nowMs = typeof performance !== 'undefined'
      ? performance.now()
      : (this._renderTimeSeconds || 0) * 1000;
    const elapsed = nowMs - anim.startMs;
    if (elapsed < 0) return true;

    const durationMs = Math.max(1, anim.durationMs || PEG_EXIT_SHRINK_MS);
    const t = Math.max(0, Math.min(1, elapsed / durationMs));
    if (t >= 1) {
      this._pegEntryAnimations.delete(peg.id);
      return false;
    }

    const eased = cubicBezierEase(t);
    const scaleBase = Math.pow(eased, 2.25);
    const pop = eased > 0.84 ? 1 + Math.sin(((1 - eased) / 0.16) * Math.PI) * 0.045 : 1;
    const scale = scaleBase * pop;
    const alpha = eased > 0.32 ? 1 : Math.max(0, eased / 0.32);
    this.drawPegScaled(peg, isHit, isSelected, scale, alpha);
    return true;
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

    if (this._gpuSceneActive) {
      for (const peg of pegs) {
        if (this._gpuPlayfield.isSupported(peg)) continue;
        const isHit = hitSet.has(peg.id);
        const isSelected = selectedIds.has(peg.id);
        if (this.drawPegEntryAnimation(peg, isHit, isSelected)) continue;
        if (!peg._wrapHideMain) this.drawPeg(peg, isHit, isSelected);
        if (peg._wrapCopies) {
          for (const copy of peg._wrapCopies) {
            this.drawPegWithOffset(peg, copy.x - peg.x, copy.y - peg.y, isHit, isSelected, 1);
          }
        }
      }
      // The gamble peg's body is lit by the GPU pass, but its knockback arrow
      // is a glyph rather than geometry, so it stays a 2D overlay on top.
      for (const peg of pegs) {
        if (peg.type !== 'gamble' || !peg.gambleKnockbackEnabled) continue;
        if (hitSet.has(peg.id) || peg._wrapHideMain) continue;
        this.drawGambleKnockbackArrow(peg);
      }
      this.drawPegExitAnimations();
      return;
    }
    
    for (const peg of pegs) {
      const isHit = hitSet.has(peg.id);
      const isSelected = selectedIds.has(peg.id);
      if (this.drawPegEntryAnimation(peg, isHit, isSelected)) continue;

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

  // The downward arrow that marks a knockback gamble peg. Extracted so the GPU
  // path can overlay it without redrawing the peg body underneath.
  drawGambleKnockbackArrow(peg) {
    const ctx = this.ctx;
    const radius = PHYSICS_CONFIG.pegRadius;
    const arrowWidth = Math.max(2.8, radius * 0.34);
    const shaftTop = -radius * 0.66;
    const tipY = radius * 0.67;
    const shoulderY = radius * 0.17;
    const shoulderX = radius * 0.5;

    ctx.save();
    ctx.translate(peg.x, peg.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(0, shaftTop);
    ctx.lineTo(0, tipY);
    ctx.lineTo(-shoulderX, shoulderY);
    ctx.moveTo(0, tipY);
    ctx.lineTo(shoulderX, shoulderY);
    ctx.strokeStyle = 'rgba(20, 57, 0, 0.82)';
    ctx.lineWidth = arrowWidth;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(244, 255, 226, 0.92)';
    ctx.lineWidth = Math.max(1.1, arrowWidth * 0.44);
    ctx.stroke();
    ctx.restore();
  }

  drawBall(ball) {
    if (!ball) return;

    const ctx = this.ctx;
    const spawnT = ball.active ? 1 : Math.max(0, Math.min(1, Number.isFinite(ball.launcherSpawnAnim) ? ball.launcherSpawnAnim : 1));
    const spawnScale = ball.active ? 1 : (0.22 + (1 - Math.pow(1 - spawnT, 3)) * 0.78);
    const radius = ball.radius * spawnScale;

    // The GPU playfield renders the ball as lit geometry; painting it here too
    // would double it and flatten it.
    if (this._gpuSceneActive) return;
    drawMachineBall(ctx, ball, radius);
    return;

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
    {
      // Hardware comes from the GPU playfield when it is live; only the aim
      // beam stays on the 2D layer, because it is UI rather than a machine part.
      if (!this._gpuSceneActive) {
        const previewRadius = getBallRadius() * Math.max(0.2, Math.min(1, Number.isFinite(ballScale) ? ballScale : 1));
        drawMachineLauncher(this.ctx, x, y, angle, previewRadius, options);
      }
      if (showAim) {
        const beamLength = 34;
        const x2 = x + Math.cos(angle) * beamLength;
        const y2 = y + Math.sin(angle) * beamLength;
        this.ctx.save();
        const beam = this.ctx.createLinearGradient(x, y, x2, y2);
        beam.addColorStop(0, 'rgba(150, 248, 255, 0.2)');
        beam.addColorStop(1, 'rgba(97, 235, 255, 0.92)');
        this.ctx.strokeStyle = beam;
        this.ctx.lineWidth = 1.6;
        this.ctx.lineCap = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(x, y);
        this.ctx.lineTo(x2, y2);
        this.ctx.stroke();
        this.ctx.restore();
      }
    }
    return;

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
      ctx.strokeStyle = 'rgba(102, 235, 255, 0.42)';
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.setLineDash([2, 7]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw dots at intervals
      ctx.fillStyle = 'rgba(178, 250, 255, 0.82)';
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
      ctx.strokeStyle = 'rgba(98, 237, 255, 0.5)';
      ctx.lineWidth = 1.7;
      ctx.lineCap = 'round';
      ctx.setLineDash([2, 8]);
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
        ctx.fillStyle = 'rgba(205, 252, 255, 0.92)';
        ctx.beginPath();
        ctx.arc(endPoint.x, endPoint.y, 3.2, 0, Math.PI * 2);
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
    // Rendered as lit geometry by the GPU playfield when it is active.
    if (this._gpuSceneActive) return;

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

  _bucketMouthGeometry(bucket) {
    const { x, y, width, height } = bucket;
    const img = this._bucketImg;
    const hasBucketAsset = Boolean(img && img.width > 0 && img.height > 0);
    let mouthX = x, mouthY, mouthHalfW;
    if (hasBucketAsset) {
      const imgAspect = img.width / img.height;
      const drawW = width;
      const drawH = drawW / imgAspect;
      const drawY = y + height / 2 - drawH;
      mouthY = drawY + drawH * 0.72 - 12;
      mouthHalfW = drawW * 0.43;
    } else {
      mouthY = y - height / 2 + 5 - 12;
      mouthHalfW = width * 0.3;
    }
    // Guard against degenerate geometry
    if (!Number.isFinite(mouthY)) mouthY = y - 20;
    if (!Number.isFinite(mouthHalfW) || mouthHalfW <= 0) mouthHalfW = width * 0.3;
    return { mouthX, mouthY, mouthHalfW };
  }

  _spawnBucketCatchParticles(bucket) {
    const { mouthX, mouthY, mouthHalfW } = this._bucketMouthGeometry(bucket);

    // Upward sparks
    for (let i = 0; i < 11; i++) {
      const spread = Math.PI * 0.8;
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const speed = 45 + Math.random() * 85;
      this._bucketParticles.push({
        type: 'spark',
        x: mouthX + (Math.random() - 0.5) * mouthHalfW * 1.2,
        y: mouthY + (Math.random() - 0.5) * 3,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        maxLife: 0.4 + Math.random() * 0.4,
        size: 0.6 + Math.random() * 0.11,
        gravity: 200,
      });
    }

    // Expanding mouth rings
    for (let i = 0; i < 2; i++) {
      this._bucketParticles.push({
        type: 'ring',
        x: mouthX,
        y: mouthY,
        life: 1,
        maxLife: 0.3 + i * 0.08,
        mouthHalfW,
      });
    }

    // Soft ambient glow bloom at the mouth — один мягкий засвет
    this._bucketParticles.push({
      type: 'glow',
      x: mouthX,
      y: mouthY - 6,
      life: 1,
      maxLife: 0.5,
      radius: mouthHalfW * 4.8,
    });
  }

  _updateBucketParticles(dt) {
    for (let i = this._bucketParticles.length - 1; i >= 0; i--) {
      const p = this._bucketParticles[i];
      p.life -= dt / p.maxLife;
      if (p.life <= 0) { this._bucketParticles.splice(i, 1); continue; }
      if (p.type !== 'ring') {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.gravity) p.vy += p.gravity * dt;
      }
    }
  }

  _drawBucketParticles(bucket = null) {
    if (!this._bucketParticles.length) return;
    const ctx = this.ctx;
    ctx.save();
    // source-over keeps white purely white regardless of background color
    ctx.globalCompositeOperation = 'source-over';

    for (const p of this._bucketParticles) {
      const t = Math.max(0, p.life);
      if (t <= 0) continue;

      if (p.type === 'spark') {
        // Solid dot only — no per-particle gradient (perf + no milky bleed)
        const alpha = t * (t < 0.2 ? t / 0.2 : 1.0) * 0.65;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.3 + t * 0.7), 0, Math.PI * 2);
        ctx.fill();

      } else if (p.type === 'ring') {
        const cx = bucket ? bucket.x : p.x;
        const progress = 1 - t;
        const rx = p.mouthHalfW * (0.1 + progress * 0.9);
        const ry = rx * 0.18;
        if (!Number.isFinite(rx) || rx <= 0) continue;
        const alpha = (progress < 0.15 ? progress / 0.15 : t) * 0.38;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(0.2, 1.4 - progress * 1.2);
        ctx.beginPath();
        ctx.ellipse(cx, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();

      } else if (p.type === 'glow') {
        const cx = bucket ? bucket.x : p.x;
        const progress = 1 - t;
        const r = p.radius * (0.25 + progress * 0.75);
        if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(p.y) || !Number.isFinite(cx)) continue;
        const alpha = t * (1 - Math.pow(1 - t, 2)) * 0.28;
        const grd = ctx.createRadialGradient(cx, p.y, 0, cx, p.y, r);
        grd.addColorStop(0,    `rgba(255,255,255,${alpha})`);
        grd.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.5})`);
        grd.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(cx, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawBucket(bucket, flash = 0) {
    if (this._gpuSceneActive) return;
    drawMachineCatcher(this.ctx, bucket, flash);
    return;

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
    const restRad = (Number.isFinite(flippers.restAngle) ? flippers.restAngle : FLIPPER_DEFAULTS.restAngle) * Math.PI / 180;
    const flipRad = (Number.isFinite(flippers.flipAngle) ? flippers.flipAngle : FLIPPER_DEFAULTS.flipAngle) * Math.PI / 180;

    const sc = Number.isFinite(flippers.scale) ? flippers.scale : FLIPPER_DEFAULTS.scale;
    const len = (Number.isFinite(flippers.length) ? flippers.length : FLIPPER_DEFAULTS.length) * sc;
    const w = (Number.isFinite(flippers.width) ? flippers.width : FLIPPER_DEFAULTS.width) * sc;
    const xOffset = Number.isFinite(flippers.xOffset) ? flippers.xOffset : FLIPPER_DEFAULTS.xOffset;
    const y = Number.isFinite(flippers.y) ? flippers.y : (this.height - 55);

    // Left flipper: rest points down-right, flip points up-right
    const leftPivotX = centerX - xOffset;
    const leftAngle = restRad - t * (restRad + flipRad);
    this.drawSingleFlipper(leftPivotX, y, leftAngle, len, w, t, selected, false);

    // Right flipper: mirrored
    const rightPivotX = centerX + xOffset;
    const rightAngle = Math.PI - leftAngle;
    this.drawSingleFlipper(rightPivotX, y, rightAngle, len, w, t, selected, true);
  }

  drawSingleFlipper(pivotX, pivotY, angle, length, width, t, selected, flipAssetY = false) {
    if (this._gpuSceneActive) return;
    drawMachineFlipper(this.ctx, pivotX, pivotY, angle, length, width, t, selected);
    return;

    if (this._drawFlipperAsset(pivotX, pivotY, angle, length, width, t, selected, flipAssetY)) {
      return;
    }

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

  _drawFlipperAsset(pivotX, pivotY, angle, length, width, t, selected, flipAssetY) {
    const img = this._flipperImg;
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return false;

    const ctx = this.ctx;
    const pivotSrcX = img.naturalWidth * FLIPPER_ASSET_PIVOT_X_RATIO;
    const sourceTopLength = Math.max(1, img.naturalWidth - pivotSrcX);
    const drawScale = Math.max(0.01, length / sourceTopLength);
    const drawW = img.naturalWidth * drawScale;
    const drawH = img.naturalHeight * drawScale;
    const drawX = -pivotSrcX * drawScale;
    const opaqueTopY = img.naturalHeight * FLIPPER_ASSET_OPAQUE_TOP_RATIO * drawScale;
    const bottomSurfaceY = width * 0.5;
    // Align the screen-facing contact edge: left uses the image top, right uses it after Y-flip.
    const drawY = -bottomSurfaceY - opaqueTopY;

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);
    if (flipAssetY) ctx.scale(1, -1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.94 + Math.min(0.06, Math.max(0, t) * 0.06);
    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    if (selected) {
      const r = width * 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, true);
      ctx.lineTo(length - r, r);
      ctx.arc(length - r, 0, r, Math.PI / 2, -Math.PI / 2, true);
      ctx.lineTo(0, -r);
      ctx.closePath();
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.restore();
    return true;
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

  drawCountdownOverlay(text, alpha = 1) {
    const ctx = this.ctx;
    const value = String(text || '').trim();
    const t = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
    if (!value || t <= 0.001) return;
    const scale = 0.9 + t * 0.1;

    ctx.save();
    ctx.globalAlpha = t;
    const glowRadius = Math.max(72, Math.min(this.width, this.height) * 0.22);
    const glow = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      glowRadius * 0.08,
      this.width / 2,
      this.height / 2,
      glowRadius
    );
    glow.addColorStop(0, 'rgba(0, 0, 0, 0.46)');
    glow.addColorStop(0.55, 'rgba(0, 0, 0, 0.24)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(this.width / 2, this.height / 2, glowRadius * 1.15, glowRadius * 0.74, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(scale, scale);
    ctx.globalAlpha = t;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.58)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 3;
    ctx.font = "78px 'Kelmscott Roman NF', 'Noto Serif', Georgia, serif";
    ctx.fillText(value, 0, 2);
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
    const normalizedPegType = normalizePegType(pegType);
    const colors = PEG_COLORS[normalizedPegType] || PEG_COLORS.blue;
    const surfaceStyle = this._getPegSurfaceStyle(normalizedPegType);
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
        const brickSprite = surfaceStyle ? this._brickPegBodySprite(normalizedPegType, brickW, brickH, false) : null;
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
        const pegSprite = surfaceStyle ? this._pegBodySprite(normalizedPegType, radius, false) : null;
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
        const halfH = getEffectiveBrickSize(ghost).height / 2;
        this.drawCurvedBrickPath(ctx, ghost.curveSlices, halfH + 3, -halfH - 3);
        ctx.stroke();
      } else if (ghost.shape === 'brick') {
        ctx.save();
        ctx.translate(ghost.x, ghost.y);
        ctx.rotate(ghost.angle || 0);
        const { width: w, height: h } = getEffectiveBrickSize(ghost);
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

  // Rotation origin (pivot) crosshair. Bright + ringed while editing, faded
  // when a custom pivot merely exists.
  drawAnimationPivot(pivot, editing) {
    if (!pivot) return;
    const ctx = this.ctx;
    const isCustom = !!pivot.custom;
    if (!editing && !isCustom) return; // default pivot = center: no marker needed
    ctx.save();
    const main = editing ? '#ff8c1a' : 'rgba(255, 140, 26, 0.7)';
    const r = editing ? 11 : 8;
    ctx.strokeStyle = main;
    ctx.fillStyle = main;
    ctx.lineWidth = editing ? 2 : 1.5;
    // ring
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, r, 0, Math.PI * 2);
    ctx.stroke();
    // crosshair
    const c = r + 6;
    ctx.beginPath();
    ctx.moveTo(pivot.x - c, pivot.y);
    ctx.lineTo(pivot.x + c, pivot.y);
    ctx.moveTo(pivot.x, pivot.y - c);
    ctx.lineTo(pivot.x, pivot.y + c);
    ctx.stroke();
    // center dot
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Freeform trajectory path: dashed curve through sampled points, plus
  // anchor/handle controls while editing (generalized poly-bezier).
  drawAnimationPath(samples, controls) {
    if (!samples || samples.length < 2) return;
    const ctx = this.ctx;
    ctx.save();

    // Curve
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 1.75;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(samples[0].x, samples[0].y);
    for (let i = 1; i < samples.length; i++) ctx.lineTo(samples[i].x, samples[i].y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Start marker (where the element begins)
    ctx.fillStyle = '#ffd60a';
    ctx.beginPath();
    ctx.arc(samples[0].x, samples[0].y, 4, 0, Math.PI * 2);
    ctx.fill();

    if (!controls || !Array.isArray(controls.anchors)) {
      ctx.restore();
      return;
    }

    const anchors = controls.anchors;
    const n = anchors.length;
    const handleActive = (i, which) => {
      if (which === 'hOut') return controls.closed || i < n - 1;
      if (which === 'hIn') return controls.closed || i > 0;
      return false;
    };

    // Handle stems
    ctx.strokeStyle = 'rgba(66, 167, 255, 0.9)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = anchors[i];
      if (handleActive(i, 'hOut') && a.hOut) { ctx.moveTo(a.x, a.y); ctx.lineTo(a.hOut.x, a.hOut.y); }
      if (handleActive(i, 'hIn') && a.hIn) { ctx.moveTo(a.x, a.y); ctx.lineTo(a.hIn.x, a.hIn.y); }
    }
    ctx.stroke();

    // Handle points (diamonds)
    const drawDiamond = (x, y) => {
      const rr = 5;
      ctx.beginPath();
      ctx.moveTo(x, y - rr); ctx.lineTo(x + rr, y);
      ctx.lineTo(x, y + rr); ctx.lineTo(x - rr, y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    };
    ctx.fillStyle = '#42a7ff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.25;
    for (let i = 0; i < n; i++) {
      const a = anchors[i];
      if (handleActive(i, 'hOut') && a.hOut) drawDiamond(a.hOut.x, a.hOut.y);
      if (handleActive(i, 'hIn') && a.hIn) drawDiamond(a.hIn.x, a.hIn.y);
    }

    // Anchor points (joints)
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#42a7ff';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(anchors[i].x, anchors[i].y, 6, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
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
        let radius = PHYSICS_CONFIG.pegRadius;
        if (peg.shape === 'brick') {
          const { width, height } = getEffectiveBrickSize(peg);
          radius = Math.max(width, height) / 2;
        }
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
  _sigMatches(prevSig, nextSig) {
    if (!prevSig || prevSig.length !== nextSig.length) return false;
    for (let i = 0; i < nextSig.length; i++) {
      const a = prevSig[i];
      const b = nextSig[i];
      if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return false;
    }
    return true;
  }

  // A layer is redrawn when (a) anything time-animated could be on it, or
  // (b) the discrete inputs differ from the previous frame's signature.
  // A slow heartbeat bounds worst-case staleness if a signal is ever missed.
  _adoptSigOrSkip(sig, sigProp, scratchProp, streakProp) {
    const fs = this._frameSkip;
    if (this._sigMatches(fs[sigProp], sig)) {
      if (++fs[streakProp] < LAYER_SKIP_HEARTBEAT_FRAMES) return false;
      fs[streakProp] = 0;
      return true;
    }
    fs[scratchProp] = fs[sigProp] || [];
    fs[sigProp] = sig;
    fs[streakProp] = 0;
    return true;
  }

  // The machine's hardware is handed to the GPU playfield as geometry so the
  // same solve lights it. Anything left painted on a 2D layer above would read
  // as a sticker on top of a lit board.
  // `loaded` controls only whether a ball sits in the barrel. The cannon itself
  // is permanent hardware — it does not vanish because the shot left it.
  _pushLauncherProps(props, x, y, angle, ballScale, options, loaded = true) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const active = !!options?.active;
    const enemy = options?.side === 'cpu' || options?.enemy === true;
    const accent = enemy ? [1.0, 0.16, 0.30] : [0.30, 0.88, 1.0];
    const outer = active ? 30 : 27;
    const aim = Number.isFinite(angle) ? angle : Math.PI * 0.5;

    props.push({ shape: 'ring', x, y, halfW: outer, halfH: 5.5, metal: true,
      color: [0.60, 0.68, 0.74] });
    props.push({ shape: 'ring', x, y, halfW: outer - 8.5, halfH: 1.3,
      color: accent, emissive: active ? 1.5 : (loaded ? 0.85 : 0.4) });
    props.push({
      shape: 'capsule',
      x: x + Math.cos(aim) * 26.5,
      y: y + Math.sin(aim) * 26.5,
      halfW: 14.5, halfH: 6.5, angle: aim, metal: true,
      color: [0.52, 0.60, 0.66]
    });

    if (!loaded) return;
    const previewRadius = getBallRadius()
      * Math.max(0.2, Math.min(1, Number.isFinite(ballScale) ? ballScale : 1));
    props.push({ shape: 'ball', x, y, radius: previewRadius,
      color: enemy ? [0.98, 0.42, 0.48] : [0.96, 0.98, 1.0], emissive: 0.55 });
  }

  // The yo-yo line is physical rope, so it goes through the solve as a chain of
  // short capsules rather than a flat stroke: it catches the key light and casts
  // along its length like the pegs do.
  _pushYoyoProps(props, threads) {
    if (!Array.isArray(threads)) return;
    for (const thread of threads) {
      const points = thread?.points;
      if (!points) continue;
      const flat = !!thread.flatPoints || ArrayBuffer.isView(points);
      const count = flat
        ? Math.floor(Number.isFinite(thread.pointCount) ? thread.pointCount : points.length / 2)
        : (Array.isArray(points) ? points.length : 0);
      if (count < 2) continue;
      const at = i => (flat
        ? { x: points[i * 2], y: points[i * 2 + 1] }
        : points[i]);

      // Sparse sampling: one capsule per few points is enough at this scale and
      // keeps a long rope from flooding the instance buffer.
      const stride = count > 48 ? 3 : (count > 24 ? 2 : 1);
      let previous = at(0);
      for (let i = stride; i < count; i += stride) {
        const next = at(i);
        if (!next) break;
        const dx = next.x - previous.x;
        const dy = next.y - previous.y;
        const length = Math.hypot(dx, dy);
        if (length > 0.5) {
          props.push({
            shape: 'capsule',
            x: (previous.x + next.x) * 0.5,
            y: (previous.y + next.y) * 0.5,
            halfW: length * 0.5 + 1.1,
            halfH: 2.4,
            angle: Math.atan2(dy, dx),
            // Braided steel rather than a glowing line. It has to be
            // non-emissive to cast: emitting surfaces are excluded from the
            // shadow march, which is why the old rope threw none.
            metal: true,
            color: [0.62, 0.68, 0.74],
            emissive: 0
          });
        }
        previous = next;
      }
    }
  }

  _collectPlayfieldProps(state) {
    const props = this._playfieldProps || (this._playfieldProps = []);
    props.length = 0;
    this._pushYoyoProps(props, state.yoyoThreads);

    if (state.balls) {
      for (const ball of state.balls) {
        if (!ball) continue;
        const spawn = ball.launcherSpawnAnim ?? 1;
        const scale = ball.active ? 1 : (0.22 + (1 - Math.pow(1 - spawn, 3)) * 0.78);
        const enemy = ball.side === 'cpu';
        props.push({
          shape: 'ball',
          x: ball.x,
          y: ball.y,
          radius: (ball.radius || getBallRadius()) * scale,
          // White and self-lit, but still a lit sphere: the emissive term is
          // low enough that the rig's highlight and rim survive on top of it.
          color: enemy ? [0.99, 0.40, 0.46] : [0.97, 0.99, 1.0],
          emissive: 0.85
        });
      }
    }

    const bucket = state.bucket;
    if (bucket) {
      const flash = Math.max(0, Math.min(1, state.bucketFlash || 0));
      const visualWidth = Math.max((bucket.width || 24) * 1.38, 78);
      const visualHeight = Math.max((bucket.height || 12) * 2.35, 30);
      const half = visualWidth * 0.5;
      // Two machined cheeks flanking a lit slot, rather than one blank pill —
      // the mouth has to read as an opening the ball can drop into.
      for (const side of [-1, 1]) {
        props.push({
          shape: 'capsule',
          x: bucket.x + side * half * 0.72,
          y: bucket.y,
          halfW: half * 0.30,
          halfH: visualHeight * 0.46,
          angle: side * 0.10,
          metal: true,
          color: [0.34, 0.42, 0.48]
        });
      }
      props.push({
        shape: 'box',
        x: bucket.x,
        y: bucket.y + visualHeight * 0.30,
        halfW: half * 0.62,
        halfH: visualHeight * 0.16,
        metal: true,
        color: [0.24, 0.30, 0.35]
      });
      props.push({
        shape: 'emitter',
        x: bucket.x,
        y: bucket.y - visualHeight * 0.34,
        halfW: half * 0.52,
        halfH: 2.6,
        color: [0.45, 0.92, 1.0],
        emissive: 0.85 + flash * 3.0
      });
    }

    const flippers = state.flippers;
    if (flippers && flippers.enabled) {
      const centerX = this.width / 2;
      const t = flippers._flipperT || 0;
      const toRad = Math.PI / 180;
      const restRad = (Number.isFinite(flippers.restAngle) ? flippers.restAngle : FLIPPER_DEFAULTS.restAngle) * toRad;
      const flipRad = (Number.isFinite(flippers.flipAngle) ? flippers.flipAngle : FLIPPER_DEFAULTS.flipAngle) * toRad;
      const sc = Number.isFinite(flippers.scale) ? flippers.scale : FLIPPER_DEFAULTS.scale;
      const len = (Number.isFinite(flippers.length) ? flippers.length : FLIPPER_DEFAULTS.length) * sc;
      const w = (Number.isFinite(flippers.width) ? flippers.width : FLIPPER_DEFAULTS.width) * sc;
      const xOffset = Number.isFinite(flippers.xOffset) ? flippers.xOffset : FLIPPER_DEFAULTS.xOffset;
      const y = Number.isFinite(flippers.y) ? flippers.y : (this.height - 55);
      const leftAngle = restRad - t * (restRad + flipRad);
      for (const [pivotX, pivotAngle] of [
        [centerX - xOffset, leftAngle],
        [centerX + xOffset, Math.PI - leftAngle]
      ]) {
        props.push({
          shape: 'capsule',
          x: pivotX + Math.cos(pivotAngle) * len * 0.5,
          y: y + Math.sin(pivotAngle) * len * 0.5,
          halfW: len * 0.5,
          halfH: w * 0.5,
          angle: pivotAngle,
          metal: true,
          color: [0.50, 0.60, 0.66]
        });
        props.push({ shape: 'ring', x: pivotX, y, halfW: w * 0.44, halfH: w * 0.14,
          color: [0.30, 0.88, 1.0], emissive: t > 0.5 ? 1.6 : 0.7 });
      }
    }

    // Draw the cannon whenever a position is known, loaded or not. `lastLaunch`
    // remembers where it sits through the shot, when showLauncher goes false.
    if (state.showLauncher && Number.isFinite(state.launchX)) {
      this._lastLaunch = {
        x: state.launchX,
        y: state.launchY,
        angle: state.aimAngle,
        options: state.launcherOptions || null
      };
    }
    const launcher = state.showLauncher && Number.isFinite(state.launchX)
      ? { x: state.launchX, y: state.launchY, angle: state.aimAngle,
          options: state.launcherOptions || null, loaded: true }
      : (this._lastLaunch ? { ...this._lastLaunch, loaded: false } : null);
    if (launcher) {
      this._pushLauncherProps(props, launcher.x, launcher.y, launcher.angle,
        state.launcherBallScale, launcher.options, launcher.loaded);
    }
    if (Array.isArray(state.secondaryLaunchers)) {
      for (const secondary of state.secondaryLaunchers) {
        this._pushLauncherProps(props, secondary.x, secondary.y,
          secondary.angle ?? Math.PI / 2, secondary.ballScale, secondary, true);
      }
    }
    return props;
  }

  _shouldRedrawBaseScene(state, cameraY, liteFieldFallback, magnetFieldRings) {
    const fs = this._frameSkip;
    const bg = this.backgroundConfig;
    const dynamic =
      !this._foregroundCtx
      || state.baseSceneDynamic !== false
      || state.isEditor
      || state.showGrid
      || state.shockwavePreview
      || state.playState === 'playing'
      || (bg && bg.type === 'liquid')
      || this._bgBaseDirty || this._bgOverlayDirty || this._bgVignetteDirty
      || this._bgBlendTarget !== this._bgBlendDisplayed
      || this._bgImageFadePending || this._bgFadeStartMs > 0
      || (bg && bg.type === 'image' && !this._bgImage)
      || this._pegExitAnimations.size > 0
      || this._pegEntryAnimations.size > 0
      || (liteFieldFallback && magnetFieldRings.length > 0)
      || this._waveActive
      // A moving light leaves the solved field settling for a few frames, so
      // keep drawing until the temporal blend has caught up.
      || (this._gpuSceneActive && this._gpuPlayfield?.pendingFlashCount() > 0)
      || (this._gpuSceneActive && this._gpuPlayfield?.hasAnimatedContent())
      || (state.ghostBricks && state.ghostBricks.length > 0)
      || (state.yoyoThreads && state.yoyoThreads.length > 0)
      || state.survivalBackground != null;
    if (dynamic) {
      fs.baseSig = null;
      fs.baseSkipStreak = 0;
      return true;
    }

    const sig = fs.baseScratch;
    sig.length = 0;
    sig.push(
      fs.epoch, this.width, this.height, cameraY,
      state.playState,
      state.pegs, state.pegs ? state.pegs.length : 0
    );
    const hits = state.hitPegIds;
    const hitCount = hits ? hits.length : 0;
    sig.push(hitCount, hitCount ? hits[0] : null, hitCount ? hits[hitCount - 1] : null);
    sig.push(state.wrapCopyPegIds ? state.wrapCopyPegIds.size : -1);
    sig.push(state.selectedPegIds ? state.selectedPegIds.size : -1);
    sig.push(state.trajectory || null, state.trajectoryStyle || '', !!state.showFullTrajectory, state.aimLength || 0);
    sig.push(Number.isFinite(state.pvpMidline) ? state.pvpMidline : null);
    if (this._gpuSceneActive) {
      // The GPU playfield draws the machine hardware and the flash decay of
      // struck pegs, so the base layer has to follow all of it.
      const balls = state.balls;
      sig.push(balls ? balls.length : -1);
      if (balls) {
        for (const b of balls) sig.push(b.x, b.y, b.radius, !!b.active, b.launcherSpawnAnim ?? 1, b.side || '');
      }
      const bucket = state.bucket;
      sig.push(bucket ? bucket.x : null, bucket ? bucket.y : null, state.bucketFlash || 0);
      const fl = state.flippers;
      sig.push(fl && fl.enabled ? (fl._flipperT || 0) : null, fl ? fl.y : null);
      sig.push(!!state.showLauncher, state.launchX, state.launchY, state.aimAngle, state.launcherBallScale ?? 1);
      sig.push(state.launcherOptions ? !!state.launcherOptions.active : null);
      sig.push(this._gpuPlayfield ? this._gpuPlayfield.pendingFlashCount() : 0);
    }
    sig.push(
      state.levelProgress || 0,
      this._bgImage, this._bgProgressImage,
      this._bgBlendDisplayed, this._bgBaseKey, this._bgOverlayKey
    );
    return this._adoptSigOrSkip(sig, 'baseSig', 'baseScratch', 'baseSkipStreak');
  }

  _shouldRedrawForeground(state, cameraY, endMessage) {
    const fs = this._frameSkip;
    const msg = this._endMessage;
    const dynamic =
      !this._foregroundCtx
      || state.fgSceneDynamic !== false
      || state.isEditor
      || state.playState === 'playing'
      || state.ballTrailPreview
      || this._bucketParticles.length > 0
      || this._ballTrail.trails.size > 0
      || state.survivalLoseLineY != null
      || (endMessage != null && msg.phase !== 'visible')
      || !!state.countdownText;
    if (dynamic) {
      fs.fgSig = null;
      fs.fgSkipStreak = 0;
      return true;
    }

    const sig = fs.fgScratch;
    sig.length = 0;
    sig.push(fs.epoch, this.width, this.height, cameraY);
    const balls = state.balls;
    sig.push(balls ? balls.length : -1);
    if (balls) {
      for (const b of balls) {
        sig.push(b.x, b.y, b.radius, !!b.active, b.launcherSpawnAnim ?? 1, b.side || '');
      }
    }
    const bucket = state.bucket;
    if (bucket) sig.push(bucket.x, bucket.y, bucket.width, bucket.height, state.bucketFlash || 0);
    else sig.push(null);
    const fl = state.flippers;
    if (fl && fl.enabled) {
      sig.push(
        fl._flipperT || 0, fl.y, fl.xOffset, fl.length, fl.width,
        fl.scale, fl.restAngle, fl.flipAngle, !!state.flipperSelected
      );
    } else {
      sig.push(null);
    }
    sig.push(!!state.showLauncher, state.launchX, state.launchY, state.aimAngle, !!state.showAim, state.launcherBallScale ?? 1);
    const lo = state.launcherOptions;
    if (lo) {
      sig.push(
        !!lo.active, lo.side || '', !!lo.assetLauncher, lo.defaultAngle ?? null,
        !!lo.showAim, lo.ballScale ?? 1, lo.x ?? null, lo.y ?? null, lo.angle ?? null
      );
    } else {
      sig.push(null);
    }
    const secondary = state.secondaryLaunchers;
    sig.push(Array.isArray(secondary) ? secondary.length : -1);
    if (Array.isArray(secondary)) {
      for (const l of secondary) {
        sig.push(
          l.x, l.y, l.angle ?? null, !!l.showAim, l.ballScale ?? 1,
          !!l.active, l.side || '', !!l.assetLauncher, l.defaultAngle ?? null
        );
      }
    }
    sig.push(!!state.showQteAim, state.qteAimX || 0, state.qteAimY || 0, state.qteAimAngle || 0);
    sig.push(endMessage ? `${msg.key}|${msg.alpha.toFixed(3)}` : null);
    return this._adoptSigOrSkip(sig, 'fgSig', 'fgScratch', 'fgSkipStreak');
  }

  renderGame(state) {
    const baseCtx = this.baseCtx || this.canvas.getContext('2d', { alpha: true });
    this.ctx = baseCtx;
    this._renderTimeSeconds = Number.isFinite(state.renderTimeSeconds)
      ? state.renderTimeSeconds
      : (typeof performance !== 'undefined' ? performance.now() / 1000 : 0);

    const cameraY = Number.isFinite(state.cameraY) ? state.cameraY : 0;
    const shockwaveTimeSeconds = this._renderTimeSeconds;
    const shockwaveActive = this._shockwaveEffect.syncEvents(state.backgroundEvents, {
      preview: !!state.shockwavePreview,
      timeSeconds: shockwaveTimeSeconds,
      width: this.width,
      height: this.height
    });
    const magnetFieldRings = this._collectMagnetFieldRings(state.pegs, cameraY);
    const liteFieldFallback = MAGNET_FIELD_MODE === '2d' && !shockwaveActive;
    let magnetFieldActive = false;
    if (liteFieldFallback) {
      this._shockwaveEffect.syncFieldRings(this._emptyFieldRings || (this._emptyFieldRings = []));
    } else {
      magnetFieldActive = this._shockwaveEffect.syncFieldRings(magnetFieldRings);
    }
    const useCamera = Math.abs(cameraY) > 0.001;
    this._gpuSceneActive = !state.isEditor && !state.showGrid && this._ensureGpuPlayfield();
    if (!this._gpuSceneActive && this._gpuPlayfield?.canvas) {
      this._applyLayerVisibility(this._gpuPlayfield.canvas, false);
    }
    // Which layer holds the scene decides the stacking, and that can flip at
    // runtime (editor, grid view, or a GPU init failure).
    this._applySceneLayerOrder();
    // The GPU composite applies the waves, so the base scene has to keep
    // redrawing for as long as one is alive.
    this._waveActive = shockwaveActive || magnetFieldActive;
    this._frameSkip.frames++;
    const baseRedrawn = this._shouldRedrawBaseScene(state, cameraY, liteFieldFallback, magnetFieldRings);
    if (baseRedrawn) {
      this._frameSkip.baseDraws++;
      if (this._gpuSceneActive) {
        this._gpuSceneActive = this._gpuPlayfield.render(state.pegs, state.hitPegIds, {
          width: this.width,
          height: this.height,
          cameraY,
          timeSeconds: this._renderTimeSeconds,
          frameDeltaSeconds: state.frameDeltaSeconds,
          progress: state.levelProgress,
          props: this._collectPlayfieldProps(state),
          ...this._collectPegLifecycle(),
          // Applied inside the composite at full resolution, so a shockwave no
          // longer swaps the whole board for a downscaled copy of itself.
          waves: shockwaveActive
            ? this._shockwaveEffect.collectWaveState({
              timeSeconds: shockwaveTimeSeconds,
              cameraY,
              width: this.width,
              height: this.height,
              maxWaves: 4
            })
            : null
        });
        this._applyLayerVisibility(this._gpuPlayfield.canvas, this._gpuSceneActive);
      }
      this.clear(state.levelProgress, state);

      const drewSurvivalBackground = this.drawSurvivalBackground(state.survivalBackground, cameraY, state.worldHeight);
      if (drewSurvivalBackground && this._bgVignetteCanvas) {
        this.ctx.drawImage(this._bgVignetteCanvas, 0, 0);
      }

      if (state.showGrid) {
        this.showGrid = true;
        this.drawGrid(cameraY);
        this.drawMagnetRadii(state.pegs, cameraY);
      }
      if (liteFieldFallback && !state.showGrid) {
        this.drawLiteMagnetFields(magnetFieldRings, cameraY, this._renderTimeSeconds);
      }

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
    }

    // With the GPU playfield active the shockwave is already applied inside its
    // composite at full resolution. Running the legacy layer as well would
    // re-composite a downscaled copy of the board over the top, which is what
    // flattened the scene for the duration of every effect.
    const legacyDistortion = !this._gpuSceneActive && (shockwaveActive || magnetFieldActive);
    if (legacyDistortion) {
      const distortionSource = this.canvas;
      const waveCanvas = this._shockwaveEffect.renderToCanvas(distortionSource, {
        cameraY,
        width: this.width,
        height: this.height,
        profile: this.performanceProfile,
        preview: !!state.shockwavePreview,
        timeSeconds: shockwaveTimeSeconds,
        skipPrune: true,
        // Unchanged base canvas → the GL pass can reuse its cached texture
        // instead of re-uploading the whole frame.
        sourceDirty: baseRedrawn
      });
      if (!waveCanvas) {
        if (shockwaveActive) {
          this._shockwaveEffect.render(this.ctx, distortionSource, {
            cameraY,
            width: this.width,
            height: this.height,
            profile: this.performanceProfile,
            preview: !!state.shockwavePreview,
            timeSeconds: shockwaveTimeSeconds,
            skipPrune: true
          });
        }
        if (magnetFieldActive && !state.showGrid) {
          this.drawLiteMagnetFields(magnetFieldRings, cameraY, shockwaveTimeSeconds);
        }
      }
      this._setShockwaveLayerVisible(!!waveCanvas);
    } else {
      this._setShockwaveLayerVisible(false);
      // Magnet field rings still want their 2D pass when the GPU composite is
      // handling the waves; only the full-screen distortion copy is dropped.
      if (magnetFieldActive && this._gpuSceneActive && !state.showGrid) {
        this.drawLiteMagnetFields(magnetFieldRings, cameraY, shockwaveTimeSeconds);
      }
      if (!shockwaveActive && !magnetFieldActive) this._scheduleShockwavePrewarm();
    }

    // End-message fades must advance every frame even when drawing is skipped.
    const endMessage = this._updateEndMessageState(state);

    const sceneCtx = this.ctx;
    if (!this._shouldRedrawForeground(state, cameraY, endMessage)) {
      if (typeof this.onVerticalProgress === 'function') {
        this.onVerticalProgress(state.verticalProgress || null);
      }
      this.ctx = sceneCtx;
      return;
    }
    this._frameSkip.fgDraws++;
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

    {
      const dt = state.frameDeltaSeconds || 1 / 60;
      if (state.bucket) {
        const flash = state.bucketFlash || 0;
        if (flash > this._prevBucketFlash + 0.08) {
          this._spawnBucketCatchParticles(state.bucket);
        }
        this._prevBucketFlash = flash;
        this._updateBucketParticles(dt);
        this.drawBucket(state.bucket, state.bucketFlash);
        this._drawBucketParticles(state.bucket);
      } else {
        this._prevBucketFlash = 0;
        if (this._bucketParticles.length > 0) {
          this._updateBucketParticles(dt);
          this._drawBucketParticles(null);
        }
      }
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

    // Trajectory path overlay (editor animation mode)
    if (state.animationMode && state.animationPathSamples) {
      this.drawAnimationPath(state.animationPathSamples, state.animationPathControls);
    }

    // Rotation origin (pivot) marker
    if (state.animationMode && state.animationPivot) {
      this.drawAnimationPivot(state.animationPivot, state.animationPivotEditing);
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

    if (state.countdownText) {
      this.drawCountdownOverlay(state.countdownText, state.countdownAlpha);
    }
    if (endMessage) {
      this.drawMessage(endMessage.text, endMessage.subtext, endMessage.alpha);
    }

    if (state.isEditor) {
      this.drawEditorHUD(state.pegs.length, state.selectedPegIds?.size || 0, state.drawMode, state.drawShapeMode);
    }

    this.ctx = sceneCtx;
  }
}
