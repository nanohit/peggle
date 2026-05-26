function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp01(value) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function clampFinite(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function rectFromBounds(minX, minY, maxX, maxY) {
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function rectWidth(rect) {
  return rect ? (rect.maxX - rect.minX + 1) : 0;
}

function rectHeight(rect) {
  return rect ? (rect.maxY - rect.minY + 1) : 0;
}

function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

function expandRect(rect, pad, width, height) {
  if (!rect) return null;
  return {
    minX: Math.max(0, rect.minX - pad),
    minY: Math.max(0, rect.minY - pad),
    maxX: Math.min(width - 1, rect.maxX + pad),
    maxY: Math.min(height - 1, rect.maxY + pad)
  };
}

const COLOR_CACHE = new Map();
const GL_FLOW_MAX = 4;
const GL_ENERGY_MAX = 2.1;
const GL_DRIFT_SCALE = 1.15;
const GL_MICRO_SCALE = 0.7;
const FLOW_ACTIVE_EPS = 0.0035;
const ENERGY_ACTIVE_EPS = 0.006;
const FIELD_TILE_SIZE = 8;
const BALL_TRAIL_MIN_GRID_DIST = 0.03;
const BALL_TRAIL_MIN_SPEED = 0.12;

const FULLSCREEN_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

function buildFbmShaderFunction(name, octaves) {
  return `
float ${name}(vec2 p) {
  float total = 0.0;
  float amplitude = 0.58;
  float frequency = 1.0;
  float persistence = mix(0.4, 0.68, u_roughness);
  float lacunarity = u_lacunarity;
  for (int i = 0; i < ${octaves}; i++) {
    total += noise2(p * frequency) * amplitude;
    frequency *= lacunarity;
    amplitude *= persistence;
  }
  return total;
}
`;
}

function buildLiquidFragmentShader({ patternOctaves = 4, driftOctaves = 2 } = {}) {
  return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_uv;

uniform sampler2D u_field;
uniform vec2 u_resolution;
uniform vec2 u_fieldSize;
uniform vec2 u_flowDecode;
uniform float u_time;
uniform float u_scale;
uniform float u_roughness;
uniform float u_distortion;
uniform float u_lacunarity;
uniform float u_motion;
uniform float u_reactionCurve;
uniform float u_worldOffset;
uniform vec3 u_colorBase;
uniform vec3 u_colorMid;
uniform vec3 u_colorAccent;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float n00 = hash12(i + vec2(0.0, 0.0));
  float n10 = hash12(i + vec2(1.0, 0.0));
  float n01 = hash12(i + vec2(0.0, 1.0));
  float n11 = hash12(i + vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

${buildFbmShaderFunction('fbmPattern', patternOctaves)}

${buildFbmShaderFunction('fbmDrift', driftOctaves)}

float liquidPattern(vec2 coord, vec2 drift) {
  float distortion = clamp(u_distortion, 0.0, 2.0);
  float warpStrength = 0.42 + distortion * 0.58;
  float stripeStrength = 0.46 + distortion * 0.36;
  float warpA = fbmPattern(coord * vec2(2.35, 2.1) + vec2(1.3, -2.7) + drift * 0.55);
  float warpB = fbmPattern(coord * vec2(2.9, 2.7) + vec2(-3.8, 4.2) - drift.yx * 0.62);
  float px = coord.x * 8.8 + warpA * 2.6 * warpStrength + sin(coord.y * 7.4 + drift.x * 2.6) * 0.82 * stripeStrength;
  float py = coord.y * 10.6 + warpB * 3.0 * warpStrength + cos(coord.x * 6.2 + drift.y * 2.4) * 0.74 * stripeStrength;

  float marble = sin(px * 1.52 + py * 0.98 + warpB * 2.85);
  marble += 0.44 * sin(px * 0.84 - py * 1.78 + warpA * 3.1);
  marble += 0.21 * sin((px + py) * 1.63);
  return clamp(0.18 + (0.5 + marble * 0.26) * 0.86, 0.0, 1.0);
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 fieldRaw = texture2D(u_field, uv);
  vec2 flow = (fieldRaw.rg * 2.0 - 1.0) * u_flowDecode.x;
  float energy = fieldRaw.b * u_flowDecode.y;

  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  float reactAmp = 2.8 + u_reactionCurve * 5.2;
  float reactHigh = smoothstep(1.0, 4.0, u_reactionCurve);
  float lacunaT = clamp((u_lacunarity - 1.6) / 1.5, 0.0, 1.0);
  float distortion = clamp(u_distortion, 0.0, 2.0);
  vec2 flowUv = vec2(flow.x / max(u_fieldSize.x, 1.0), flow.y / max(u_fieldSize.y, 1.0)) * reactAmp;

  vec2 centered = uv - 0.5;
  centered.x *= aspect;
  centered.y += u_worldOffset;

  float driftPhaseA = fbmDrift(centered * 3.15 + vec2(5.6, -1.9));
  float driftPhaseB = fbmDrift(centered * 3.6 + vec2(-3.3, 4.5));
  vec2 driftUv = vec2(
    sin(u_time * 1.05 + driftPhaseA * 6.2831) * (0.006 + u_motion * 0.017) +
    cos(u_time * 0.62 + driftPhaseB * 5.7) * (0.003 + u_motion * 0.007),
    cos(u_time * 0.84 + driftPhaseA * 5.3) * (0.004 + u_motion * 0.013) +
    sin(u_time * 0.54 + driftPhaseB * 4.9) * (0.002 + u_motion * 0.005)
  ) * ${GL_DRIFT_SCALE.toFixed(2)};

  vec2 coordBase = centered / max(u_scale, 0.0001);
  vec2 flowStretch = vec2(flowUv.x * aspect, flowUv.y);
  vec2 driftStretch = vec2(driftUv.x * aspect, driftUv.y);
  vec2 coordWarped = coordBase +
    (flowStretch + driftStretch) * (8.8 + distortion * 5.8);

  float sample = liquidPattern(coordWarped, driftUv * (5.8 + distortion * 1.4));

  float detailScale = 1.02 + u_roughness * 1.45 + lacunaT * 0.4;
  vec2 detailCoord = coordBase * detailScale +
    flowStretch * (4.0 + u_roughness * 5.4 + distortion * 2.4) +
    driftStretch * (3.4 + u_roughness * 4.1 + distortion * 1.8);
  float detail = liquidPattern(detailCoord, driftUv * (8.4 + distortion * 1.8));
  float microCoordScale = (18.0 + u_roughness * 24.0 + lacunaT * 10.0) * ${GL_MICRO_SCALE.toFixed(2)};
  float microDriftScale = (18.0 + distortion * 5.0) * ${GL_MICRO_SCALE.toFixed(2)};
  float micro = noise2(coordBase * microCoordScale + driftUv * microDriftScale);

  float softBody = clamp(
    0.5 +
    (sample - 0.5) * (1.04 + u_motion * 0.26 + energy * 0.32) +
    energy * 0.05,
    0.0,
    1.0
  );
  float scalar = clamp(
    0.5 +
    (sample - 0.5) * (1.1 + u_motion * 0.34 + energy * 0.42) +
    energy * 0.06,
    0.0,
    1.0
  );
  scalar = mix(scalar, detail, 0.07 + u_roughness * 0.16 + lacunaT * 0.06);
  float softVolume = mix(softBody, detail, 0.15 + u_roughness * 0.1);
  softVolume = mix(softVolume, sample, 0.16 + distortion * 0.04);
  scalar = mix(scalar, micro, 0.018 + u_roughness * 0.038 + lacunaT * 0.01);
  scalar = mix(scalar, softVolume, 0.1 + reactHigh * 0.16);
  scalar = clamp(0.5 + (scalar - 0.5) * (0.95 + u_roughness * 0.25 - reactHigh * 0.09), 0.0, 1.0);

  float edgeSoft = 0.055 + u_roughness * 0.05 + reactHigh * 0.085;
  float volumeScalar = mix(scalar, softVolume, 0.45 + reactHigh * 0.12);
  float midT = smoothstep(0.07 - edgeSoft * 0.2, 0.74 + edgeSoft, volumeScalar);
  float accentT = smoothstep(0.38 - edgeSoft * 0.32, 0.9 + edgeSoft * 0.5, scalar);
  float voidT = 1.0 - smoothstep(0.15 - edgeSoft * 0.35, 0.5 + edgeSoft * 0.8, volumeScalar);
  vec3 deepBase = mix(u_colorBase, u_colorMid, 0.12 + midT * 0.2);
  vec3 bodyColor = mix(deepBase, u_colorMid, midT * 0.9 + 0.05);
  vec3 accentColor = mix(u_colorMid, u_colorAccent, 0.68 + u_roughness * 0.16);
  vec3 color = mix(bodyColor, accentColor, accentT * (0.9 - voidT * 0.18));
  color = mix(color, deepBase, voidT * (0.18 + (1.0 - accentT) * 0.12));

  float accentLuma = dot(u_colorAccent, vec3(0.2126, 0.7152, 0.0722));
  float highlight = smoothstep(0.81 - edgeSoft * 0.2, 0.992, scalar) * (0.12 + energy * 0.18) * (0.12 + accentLuma * 0.88) * (1.0 - voidT * 0.28);
  color.r = min(1.0, color.r + (1.0 - color.r) * highlight * 0.74);
  color.g = min(1.0, color.g + (0.9725 - color.g) * highlight * 0.64);
  color.b = min(1.0, color.b + (1.0 - color.b) * highlight);

  color *= 0.91 + energy * 0.08;
  float dither = (hash12(gl_FragCoord.xy + vec2(17.0, 53.0)) - 0.5) * (0.0035 + u_roughness * 0.0045);
  color += vec3(dither);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
}

function hexToRgb(hex, fallback) {
  const key = typeof hex === 'string' ? hex.toLowerCase() : '';
  if (COLOR_CACHE.has(key)) return COLOR_CACHE.get(key);

  const source = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(key) ? key : fallback;
  let value = source.slice(1);
  if (value.length === 3) {
    value = value.split('').map(char => char + char).join('');
  }
  const rgb = {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
  COLOR_CACHE.set(key, rgb);
  return rgb;
}

export class LiquidBackground {
  constructor() {
    this.viewWidth = 0;
    this.viewHeight = 0;
    this.gridWidth = 0;
    this.gridHeight = 0;
    this._glOutputWidth = 0;
    this._glOutputHeight = 0;

    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.pixels = null;

    this.basePattern = null;
    this.passiveAngle = null;
    this.passiveWeight = null;
    this.progressBasePattern = null;
    this.progressPassiveAngle = null;
    this.progressPassiveWeight = null;
    this.flowX = null;
    this.flowY = null;
    this.energy = null;
    this.nextFlowX = null;
    this.nextFlowY = null;
    this.nextEnergy = null;

    this._configKey = '';
    this._sceneKey = '';
    this._playState = '';
    this._ballPrev = new Map();
    this._pegPrev = new Map();
    this._pendingEvents = [];
    this._seenHitIds = new Set();
    this._simTime = 0;
    this._visualTime = 0;
    this._stepAccumulator = 0;
    this._lastFrameTime = 0;
    this._dirty = true;
    this._progressBlend = 0;
    this._worldOffset = 0;
    this._cpuPatternDirty = true;
    this._stampedThisStep = false;
    this._tileCols = 0;
    this._tileRows = 0;
    this._activeTiles = [];
    this._activeTileMask = null;
    this._nextActiveTiles = [];
    this._nextActiveTileMask = null;
    this._sourceTiles = [];
    this._sourceTileMask = null;
    this._glDirtyTiles = [];
    this._glDirtyTileMask = null;

    this._colorBase = hexToRgb('#05020f', '#05020f');
    this._colorMid = hexToRgb('#24104f', '#24104f');
    this._colorAccent = hexToRgb('#8d63ff', '#8d63ff');
    this._progressColorBase = null;
    this._progressColorMid = null;
    this._progressColorAccent = null;
    this._scale = 1;
    this._roughness = 0.58;
    this._distortion = 1;
    this._lacunarity = 2.25;
    this._trail = 1;
    this._motion = 0.44;
    this._reaction = 0.82;
    this._progressScale = null;
    this._progressRoughness = null;
    this._progressDistortion = null;
    this._progressLacunarity = null;
    this._progressTrail = null;
    this._progressMotion = null;
    this._progressReaction = null;
    this._progressPatternActive = false;

    this._effectiveColorBase = this._colorBase;
    this._effectiveColorMid = this._colorMid;
    this._effectiveColorAccent = this._colorAccent;
    this._effectiveScale = this._scale;
    this._effectiveRoughness = this._roughness;
    this._effectiveDistortion = this._distortion;
    this._effectiveLacunarity = this._lacunarity;
    this._effectiveTrail = this._trail;
    this._effectiveMotion = this._motion;
    this._effectiveReaction = this._reaction;

    this._glUnavailable = false;
    this._glCanvas = null;
    this._gl = null;
    this._glProgram = null;
    this._glBuffer = null;
    this._glFieldTexture = null;
    this._glUploadScratch = null;
    this._glUniforms = null;
    this._glFieldTexWidth = 0;
    this._glFieldTexHeight = 0;
    this._useGlOutput = false;
    this._glTier = null;
    this._glFieldDirty = true;
    this._glContextLost = false;

    this._handleGlContextLost = this._onGlContextLost.bind(this);
    this._handleGlContextRestored = this._onGlContextRestored.bind(this);
  }

  render(targetCtx, backgroundConfig, reactiveState = null, progressBlend = 0) {
    if (!targetCtx || !backgroundConfig || backgroundConfig.type !== 'liquid') return false;

    this._ensureBuffers(targetCtx.canvas.width, targetCtx.canvas.height);
    this._applyConfig(backgroundConfig.liquid || null);
    this._progressBlend = clampFinite(progressBlend, 0, 1, 0);
    this._updateEffectiveParams();
    this._syncScene(reactiveState);
    this._tick(reactiveState);

    const source = this._useGlOutput && this._glCanvas ? this._glCanvas : this.canvas;
    if (!source) return false;

    targetCtx.save();
    targetCtx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in targetCtx) {
      targetCtx.imageSmoothingQuality = 'high';
    }
    targetCtx.drawImage(source, 0, 0, this.viewWidth, this.viewHeight);
    targetCtx.restore();
    return true;
  }

  reset() {
    this._resetDynamics();
    this._sceneKey = '';
    this._playState = '';
  }

  _ensureBuffers(viewWidth, viewHeight) {
    const nextViewWidth = Math.max(1, Math.round(viewWidth));
    const nextViewHeight = Math.max(1, Math.round(viewHeight));
    const nextGridWidth = Math.max(128, Math.round(nextViewWidth / 3));
    const nextGridHeight = Math.max(192, Math.round(nextViewHeight / 3));
    const nextGlOutputWidth = Math.max(1, Math.ceil(nextViewWidth / 2));
    const nextGlOutputHeight = Math.max(1, Math.ceil(nextViewHeight / 2));

    if (
      this.viewWidth === nextViewWidth &&
      this.viewHeight === nextViewHeight &&
      this.gridWidth === nextGridWidth &&
      this.gridHeight === nextGridHeight &&
      this._glOutputWidth === nextGlOutputWidth &&
      this._glOutputHeight === nextGlOutputHeight &&
      this.flowX
    ) {
      return;
    }

    this.viewWidth = nextViewWidth;
    this.viewHeight = nextViewHeight;
    this.gridWidth = nextGridWidth;
    this.gridHeight = nextGridHeight;
    this._glOutputWidth = nextGlOutputWidth;
    this._glOutputHeight = nextGlOutputHeight;

    const size = this.gridWidth * this.gridHeight;
    this.flowX = new Float32Array(size);
    this.flowY = new Float32Array(size);
    this.energy = new Float32Array(size);
    this.nextFlowX = new Float32Array(size);
    this.nextFlowY = new Float32Array(size);
    this.nextEnergy = new Float32Array(size);

    this._tileCols = Math.max(1, Math.ceil(this.gridWidth / FIELD_TILE_SIZE));
    this._tileRows = Math.max(1, Math.ceil(this.gridHeight / FIELD_TILE_SIZE));
    const tileCount = this._tileCols * this._tileRows;
    this._activeTileMask = new Uint8Array(tileCount);
    this._nextActiveTileMask = new Uint8Array(tileCount);
    this._sourceTileMask = new Uint8Array(tileCount);
    this._glDirtyTileMask = new Uint8Array(tileCount);
    this._activeTiles = [];
    this._nextActiveTiles = [];
    this._sourceTiles = [];
    this._glDirtyTiles = [];

    this._invalidateCpuBuffers();
    this._cpuPatternDirty = true;
    this._glUploadScratch = null;
    this._glFieldTexWidth = 0;
    this._glFieldTexHeight = 0;
    this._resetDynamics();
  }

  _applyConfig(config) {
    const progression = config?.progression && typeof config.progression === 'object' ? config.progression : null;
    const scale = clampFinite(config?.scale, 0.5, 2, 1);
    const roughness = clampFinite(config?.roughness, 0, 1, 0.58);
    const distortion = clampFinite(config?.distortion, 0, 2, 1);
    const lacunarity = clampFinite(config?.lacunarity, 1.6, 3.1, 2.25);
    const trail = clampFinite(config?.trail, 0, 2, 1);
    const motion = clampFinite(config?.motion, 0, 1, 0.44);
    const reaction = clampFinite(config?.reaction, 0, 2, 0.82);
    const colorBase = config?.colorBase || '#05020f';
    const colorMid = config?.colorMid || '#24104f';
    const colorAccent = config?.colorAccent || '#8d63ff';
    const progressColorBase = typeof progression?.colorBase === 'string' ? progression.colorBase : '';
    const progressColorMid = typeof progression?.colorMid === 'string' ? progression.colorMid : '';
    const progressColorAccent = typeof progression?.colorAccent === 'string' ? progression.colorAccent : '';
    const progressScale = Number.isFinite(progression?.scale) ? clampFinite(progression.scale, 0.5, 2, scale) : null;
    const progressRoughness = Number.isFinite(progression?.roughness) ? clampFinite(progression.roughness, 0, 1, roughness) : null;
    const progressDistortion = Number.isFinite(progression?.distortion) ? clampFinite(progression.distortion, 0, 2, distortion) : null;
    const progressLacunarity = Number.isFinite(progression?.lacunarity) ? clampFinite(progression.lacunarity, 1.6, 3.1, lacunarity) : null;
    const progressTrail = Number.isFinite(progression?.trail) ? clampFinite(progression.trail, 0, 2, trail) : null;
    const progressMotion = Number.isFinite(progression?.motion) ? clampFinite(progression.motion, 0, 1, motion) : null;
    const progressReaction = Number.isFinite(progression?.reaction) ? clampFinite(progression.reaction, 0, 2, reaction) : null;
    const nextKey = [
      colorBase,
      colorMid,
      colorAccent,
      scale.toFixed(3),
      roughness.toFixed(3),
      distortion.toFixed(3),
      lacunarity.toFixed(3),
      trail.toFixed(3),
      motion.toFixed(3),
      reaction.toFixed(3),
      progressColorBase,
      progressColorMid,
      progressColorAccent,
      progressScale === null ? '' : progressScale.toFixed(3),
      progressRoughness === null ? '' : progressRoughness.toFixed(3),
      progressDistortion === null ? '' : progressDistortion.toFixed(3),
      progressLacunarity === null ? '' : progressLacunarity.toFixed(3),
      progressTrail === null ? '' : progressTrail.toFixed(3),
      progressMotion === null ? '' : progressMotion.toFixed(3),
      progressReaction === null ? '' : progressReaction.toFixed(3)
    ].join('|');
    if (this._configKey === nextKey) return;

    this._configKey = nextKey;
    this._scale = scale;
    this._roughness = roughness;
    this._distortion = distortion;
    this._lacunarity = lacunarity;
    this._trail = trail;
    this._motion = motion;
    this._reaction = reaction;
    this._colorBase = hexToRgb(colorBase, '#05020f');
    this._colorMid = hexToRgb(colorMid, '#24104f');
    this._colorAccent = hexToRgb(colorAccent, '#8d63ff');
    this._progressColorBase = progressColorBase ? hexToRgb(progressColorBase, colorBase) : null;
    this._progressColorMid = progressColorMid ? hexToRgb(progressColorMid, colorMid) : null;
    this._progressColorAccent = progressColorAccent ? hexToRgb(progressColorAccent, colorAccent) : null;
    this._progressScale = progressScale;
    this._progressRoughness = progressRoughness;
    this._progressDistortion = progressDistortion;
    this._progressLacunarity = progressLacunarity;
    this._progressTrail = progressTrail;
    this._progressMotion = progressMotion;
    this._progressReaction = progressReaction;
    this._progressPatternActive = (
      progressScale !== null ||
      progressRoughness !== null ||
      progressDistortion !== null ||
      progressLacunarity !== null
    );
    this._cpuPatternDirty = true;
    this._updateEffectiveParams();
    this._dirty = true;
  }

  _syncScene(reactiveState) {
    const nextSceneKey = reactiveState?.backgroundFxId ? String(reactiveState.backgroundFxId) : 'default';
    if (nextSceneKey !== this._sceneKey) {
      this._sceneKey = nextSceneKey;
      this._resetDynamics();
    }
    if (Array.isArray(reactiveState?.backgroundEvents) && reactiveState.backgroundEvents.length > 0) {
      for (const event of reactiveState.backgroundEvents) {
        if (!event || !Number.isFinite(event.x) || !Number.isFinite(event.y)) continue;
        this._pendingEvents.push({
          ...event,
          _cameraY: Number.isFinite(reactiveState?.cameraY) ? reactiveState.cameraY : 0
        });
      }
    }
    this._playState = reactiveState?.playState ? String(reactiveState.playState) : '';
    const nextWorldOffset = clampFinite(reactiveState?.liquidWorldOffset, -64, 64, 0);
    if (Math.abs(nextWorldOffset - this._worldOffset) > 0.0001) {
      this._worldOffset = nextWorldOffset;
      this._dirty = true;
    }
  }

  _resetDynamics() {
    this.flowX?.fill(0);
    this.flowY?.fill(0);
    this.energy?.fill(0);
    this.nextFlowX?.fill(0);
    this.nextFlowY?.fill(0);
    this.nextEnergy?.fill(0);
    this._ballPrev.clear();
    this._pegPrev.clear();
    this._pendingEvents = [];
    this._seenHitIds.clear();
    this._stepAccumulator = 0;
    this._lastFrameTime = 0;
    this._simTime = 0;
    this._visualTime = 0;
    this._activeTileMask?.fill(0);
    this._nextActiveTileMask?.fill(0);
    this._sourceTileMask?.fill(0);
    this._glDirtyTileMask?.fill(0);
    this._activeTiles.length = 0;
    this._nextActiveTiles.length = 0;
    this._sourceTiles.length = 0;
    this._glDirtyTiles.length = 0;
    this._stampedThisStep = false;
    this._dirty = true;
    this._markGlDirtyFull();
  }

  _invalidateCpuBuffers() {
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.pixels = null;
    this.basePattern = null;
    this.passiveAngle = null;
    this.passiveWeight = null;
    this.progressBasePattern = null;
    this.progressPassiveAngle = null;
    this.progressPassiveWeight = null;
  }

  _ensureCpuSurface() {
    if (this.canvas && this.ctx && this.imageData && this.pixels) return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.gridWidth;
    this.canvas.height = this.gridHeight;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.imageData = this.ctx.createImageData(this.gridWidth, this.gridHeight);
    this.pixels = this.imageData.data;
  }

  _ensureCpuPatternBuffers() {
    const size = this.gridWidth * this.gridHeight;
    if (this.basePattern && this.basePattern.length === size) return;
    this.basePattern = new Float32Array(size);
    this.passiveAngle = new Float32Array(size);
    this.passiveWeight = new Float32Array(size);
    this.progressBasePattern = new Float32Array(size);
    this.progressPassiveAngle = new Float32Array(size);
    this.progressPassiveWeight = new Float32Array(size);
    this._cpuPatternDirty = true;
  }

  _ensureCpuPatterns() {
    this._ensureCpuPatternBuffers();
    if (!this._cpuPatternDirty) return;
    this._generateBasePattern();
    this._cpuPatternDirty = false;
  }

  _blendValue(baseValue, progressValue) {
    return progressValue === null || progressValue === undefined
      ? baseValue
      : lerp(baseValue, progressValue, this._progressBlend);
  }

  _blendColor(baseColor, progressColor) {
    if (!progressColor) return baseColor;
    return {
      r: lerp(baseColor.r, progressColor.r, this._progressBlend),
      g: lerp(baseColor.g, progressColor.g, this._progressBlend),
      b: lerp(baseColor.b, progressColor.b, this._progressBlend),
    };
  }

  _updateEffectiveParams() {
    this._effectiveColorBase = this._blendColor(this._colorBase, this._progressColorBase);
    this._effectiveColorMid = this._blendColor(this._colorMid, this._progressColorMid);
    this._effectiveColorAccent = this._blendColor(this._colorAccent, this._progressColorAccent);
    this._effectiveScale = this._blendValue(this._scale, this._progressScale);
    this._effectiveRoughness = this._blendValue(this._roughness, this._progressRoughness);
    this._effectiveDistortion = this._blendValue(this._distortion, this._progressDistortion);
    this._effectiveLacunarity = this._blendValue(this._lacunarity, this._progressLacunarity);
    this._effectiveTrail = this._blendValue(this._trail, this._progressTrail);
    this._effectiveMotion = this._blendValue(this._motion, this._progressMotion);
    this._effectiveReaction = this._blendValue(this._reaction, this._progressReaction);
  }

  _hash2(x, y) {
    const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return value - Math.floor(value);
  }

  _valueNoise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);

    const n00 = this._hash2(x0, y0);
    const n10 = this._hash2(x0 + 1, y0);
    const n01 = this._hash2(x0, y0 + 1);
    const n11 = this._hash2(x0 + 1, y0 + 1);

    return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
  }

  _fbm(x, y, roughness = this._roughness, lacunarity = this._lacunarity) {
    let total = 0;
    let amplitude = 0.58;
    let frequency = 1;
    const persistence = lerp(0.4, 0.68, roughness);
    for (let i = 0; i < 4; i++) {
      total += this._valueNoise(x * frequency, y * frequency) * amplitude;
      frequency *= lacunarity;
      amplitude *= persistence;
    }
    return total;
  }

  _getReactionCurve(reaction = this._effectiveReaction) {
    const r = Math.max(0, reaction);
    if (r <= 1) return r;
    return 1 + Math.pow(r - 1, 0.72) * 2.55;
  }

  _generatePatternSet(targetPattern, targetPassiveAngle, targetPassiveWeight, scaleValue, roughnessValue, distortionValue, lacunarityValue) {
    if (!targetPattern || !targetPassiveAngle || !targetPassiveWeight) return;
    const width = this.gridWidth;
    const height = this.gridHeight;
    const invW = 1 / Math.max(1, width);
    const invH = 1 / Math.max(1, height);
    const scale = Math.max(0.5, scaleValue || 1);
    const roughness = clampFinite(roughnessValue, 0, 1, 0.58);
    const distortion = clampFinite(distortionValue, 0, 2, 1);
    const lacunarity = clampFinite(lacunarityValue, 1.6, 3.1, 2.25);
    const warpStrength = 0.42 + distortion * 0.58;
    const stripeStrength = 0.46 + distortion * 0.36;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const nx = (x * invW - 0.5) / scale;
        const ny = (y * invH - 0.5) / scale;

        const warpA = this._fbm(nx * 2.35 + 1.3, ny * 2.1 - 2.7, roughness, lacunarity);
        const warpB = this._fbm(nx * 2.9 - 3.8, ny * 2.7 + 4.2, roughness, lacunarity);
        const px = nx * 8.8 + warpA * 2.6 * warpStrength + Math.sin(ny * 7.4) * 0.82 * stripeStrength;
        const py = ny * 10.6 + warpB * 3.0 * warpStrength + Math.cos(nx * 6.2) * 0.74 * stripeStrength;

        let marble = Math.sin(px * 1.52 + py * 0.98 + warpB * 2.85);
        marble += 0.44 * Math.sin(px * 0.84 - py * 1.78 + warpA * 3.1);
        marble += 0.21 * Math.sin((px + py) * 1.63);

        targetPattern[idx] = clamp01(0.18 + (0.5 + marble * 0.26) * 0.86);

        const flowNoise = this._fbm(nx * (2.8 + distortion * 0.35) + 5.6, ny * (2.65 + distortion * 0.35) - 1.9, roughness, lacunarity);
        targetPassiveAngle[idx] = flowNoise * Math.PI * 2;
        targetPassiveWeight[idx] = clamp01(0.36 + Math.abs(warpA - warpB) * (0.7 + distortion * 0.18));
      }
    }
  }

  _sampleProceduralPattern(gridX, gridY, scaleValue, roughnessValue, distortionValue, lacunarityValue) {
    const width = Math.max(1, this.gridWidth);
    const height = Math.max(1, this.gridHeight);
    const scale = Math.max(0.5, scaleValue || 1);
    const roughness = clampFinite(roughnessValue, 0, 1, 0.58);
    const distortion = clampFinite(distortionValue, 0, 2, 1);
    const lacunarity = clampFinite(lacunarityValue, 1.6, 3.1, 2.25);
    const warpStrength = 0.42 + distortion * 0.58;
    const stripeStrength = 0.46 + distortion * 0.36;
    const nx = (gridX / width - 0.5) / scale;
    const ny = (gridY / height - 0.5) / scale;

    const warpA = this._fbm(nx * 2.35 + 1.3, ny * 2.1 - 2.7, roughness, lacunarity);
    const warpB = this._fbm(nx * 2.9 - 3.8, ny * 2.7 + 4.2, roughness, lacunarity);
    const px = nx * 8.8 + warpA * 2.6 * warpStrength + Math.sin(ny * 7.4) * 0.82 * stripeStrength;
    const py = ny * 10.6 + warpB * 3.0 * warpStrength + Math.cos(nx * 6.2) * 0.74 * stripeStrength;

    let marble = Math.sin(px * 1.52 + py * 0.98 + warpB * 2.85);
    marble += 0.44 * Math.sin(px * 0.84 - py * 1.78 + warpA * 3.1);
    marble += 0.21 * Math.sin((px + py) * 1.63);
    return clamp01(0.18 + (0.5 + marble * 0.26) * 0.86);
  }

  _sampleBaseContinuous(x, y) {
    const primary = this._sampleProceduralPattern(
      x,
      y,
      this._scale,
      this._roughness,
      this._distortion,
      this._lacunarity
    );
    if (!this._progressPatternActive || this._progressBlend <= 0.001) {
      return primary;
    }
    const secondary = this._sampleProceduralPattern(
      x,
      y,
      this._progressScale ?? this._scale,
      this._progressRoughness ?? this._roughness,
      this._progressDistortion ?? this._distortion,
      this._progressLacunarity ?? this._lacunarity
    );
    return lerp(primary, secondary, this._progressBlend);
  }

  _generateBasePattern() {
    this._generatePatternSet(
      this.basePattern,
      this.passiveAngle,
      this.passiveWeight,
      this._scale,
      this._roughness,
      this._distortion,
      this._lacunarity
    );

    if (!this._progressPatternActive) return;

    this._generatePatternSet(
      this.progressBasePattern,
      this.progressPassiveAngle,
      this.progressPassiveWeight,
      this._progressScale ?? this._scale,
      this._progressRoughness ?? this._roughness,
      this._progressDistortion ?? this._distortion,
      this._progressLacunarity ?? this._lacunarity
    );
  }

  _tick(reactiveState) {
    const now = Number.isFinite(reactiveState?.renderTimeSeconds)
      ? reactiveState.renderTimeSeconds * 1000
      : performance.now();
    if (!this._lastFrameTime) {
      this._lastFrameTime = now;
      this._dirty = true;
    }

    const frozen = this._playState === 'won';
    let deltaSec = (now - this._lastFrameTime) / 1000;
    this._lastFrameTime = now;
    deltaSec = clamp(deltaSec, 1 / 120, 0.05);
    const timeScale = 0.7 + this._effectiveMotion * 1.25;
    if (!frozen) {
      this._visualTime += deltaSec * timeScale;
    }

    let stepped = false;
    if (!frozen) {
      this._stepAccumulator += deltaSec;
      const stepSec = 1 / 30;
      while (this._stepAccumulator >= stepSec) {
        this._updateSimulation(stepSec, reactiveState);
        this._stepAccumulator -= stepSec;
        stepped = true;
      }
      if (!stepped && this._pendingEvents.length > 0) {
        this._updateSimulation(stepSec * 0.8, reactiveState);
        stepped = true;
      }
    }

    if (!frozen) {
      if (this._ensureWebGL()) {
        if (this._rasterizeGL()) {
          this._dirty = false;
          return;
        }
      }
    }

    if (!frozen) {
      if (!stepped && !this._dirty) return;
    } else if (!this._dirty) {
      return;
    }

    this._rasterizeCanvas();
    this._dirty = false;
  }

  _updateSimulation(stepSec, reactiveState) {
    this._simTime += stepSec * (0.7 + this._effectiveMotion * 1.25);
    this._stampedThisStep = false;
    this._injectBallTrails(reactiveState);
    this._injectPegMotion(reactiveState);
    this._injectReactiveEvents(reactiveState);
    this._injectFlipperWake(reactiveState);
    const fieldChanged = this._advectField();
    this._dirty = this._dirty || this._stampedThisStep || fieldChanged;
  }

  _getViewToGridScale() {
    return Math.min(
      this.gridWidth / Math.max(1, this.viewWidth),
      this.gridHeight / Math.max(1, this.viewHeight)
    );
  }

  _toGridX(x) {
    return (x / Math.max(1, this.viewWidth)) * this.gridWidth;
  }

  _toGridY(y, cameraY = 0) {
    return ((y - cameraY) / Math.max(1, this.viewHeight)) * this.gridHeight;
  }

  _toGridRadius(radius) {
    return Math.max(1.6, radius * this._getViewToGridScale());
  }

  _shouldStampBallTrail(ball, prev, sx, sy) {
    if (!ball || ball.active === false) return false;
    if (!prev) return false;

    const dx = sx - prev.x;
    const dy = sy - prev.y;
    const dist = Math.hypot(dx, dy);
    const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
    return dist > BALL_TRAIL_MIN_GRID_DIST || speed > BALL_TRAIL_MIN_SPEED;
  }

  _injectBallTrails(reactiveState) {
    const balls = Array.isArray(reactiveState?.balls)
      ? reactiveState.balls
      : (reactiveState?.ball ? [reactiveState.ball] : []);
    const cameraY = Number.isFinite(reactiveState?.cameraY) ? reactiveState.cameraY : 0;
    const aliveIds = new Set();
    const reactionCurve = this._getReactionCurve(this._effectiveReaction);
    const reactionBoost = 0.62 + reactionCurve * 0.58;
    const trailLift = Math.max(0, this._effectiveTrail - 1);
    const trailFade = Math.max(0, 1 - this._effectiveTrail);
    const trailForceScale = 0.82 + this._effectiveTrail * 0.46;
    const trailRadiusScale = 0.88 + this._effectiveTrail * 0.28;
    const trailEnergyScale = 0.72 + this._effectiveTrail * 0.88;

    for (const ball of balls) {
      if (!ball?.id) continue;
      const sx = this._toGridX(ball.x);
      const sy = this._toGridY(ball.y, cameraY);
      if (sy < -18 || sy > this.gridHeight + 18) continue;

      aliveIds.add(ball.id);
      const prev = this._ballPrev.get(ball.id) || null;
      if (!this._shouldStampBallTrail(ball, prev, sx, sy)) {
        this._ballPrev.set(ball.id, { x: sx, y: sy });
        continue;
      }

      const dx = sx - prev.x;
      const dy = sy - prev.y;
      const dist = Math.hypot(dx, dy);
      const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
      const speedNorm = Math.min(1.9, speed / 9);
      const force = (0.22 + speedNorm * 0.42) * reactionBoost * trailForceScale;
      const radius = (4.8 + force * 2.45) * trailRadiusScale;
      const steps = Math.max(2, Math.min(14, Math.ceil(dist / 0.9)));

      for (let step = 0; step < steps; step++) {
        const t = (step + 1) / steps;
        const px = lerp(prev.x, sx, t);
        const py = lerp(prev.y, sy, t);
        const vx = dx / Math.max(1, steps);
        const vy = dy / Math.max(1, steps);

        this._stampImpulse(
          px,
          py,
          vx,
          vy,
          radius,
          force * 0.28,
          0.11 + this._effectiveMotion * 0.16,
          0.08 + reactionCurve * 0.08 + trailLift * 0.04,
          0.14 * trailEnergyScale
        );
        this._stampImpulse(
          px,
          py,
          vx * 0.32,
          vy * 0.32,
          radius + 2.9,
          force * 0.12,
          0.02,
          0.04 + reactionCurve * 0.03 + trailLift * 0.03,
          0.08 * trailEnergyScale
        );
        this._stampImpulse(
          px,
          py,
          vx * 0.08,
          vy * 0.08,
          radius * (1.18 + this._effectiveTrail * 0.22),
          force * (0.048 + trailFade * 0.012),
          0.01,
          0.01 + trailLift * 0.015,
          0.06 * trailEnergyScale
        );
      }

      this._ballPrev.set(ball.id, { x: sx, y: sy });
    }

    for (const key of this._ballPrev.keys()) {
      if (!aliveIds.has(key)) this._ballPrev.delete(key);
    }
  }

  _injectPegMotion(reactiveState) {
    const pegs = Array.isArray(reactiveState?.pegs) ? reactiveState.pegs : [];
    if (pegs.length === 0) return;

    const cameraY = Number.isFinite(reactiveState?.cameraY) ? reactiveState.cameraY : 0;
    const aliveIds = new Set();
    const reactionCurve = this._getReactionCurve(this._effectiveReaction);
    const maxTeleport = Math.max(this.viewWidth, this.viewHeight) * 0.25;

    for (const peg of pegs) {
      if (!peg?.id || !Number.isFinite(peg.x) || !Number.isFinite(peg.y)) continue;
      aliveIds.add(peg.id);

      const prev = this._pegPrev.get(peg.id);
      this._pegPrev.set(peg.id, { x: peg.x, y: peg.y });
      if (!prev) continue;

      const worldDx = peg.x - prev.x;
      const worldDy = peg.y - prev.y;
      const worldDist = Math.hypot(worldDx, worldDy);
      if (worldDist <= 0.04) continue;
      if (worldDist > maxTeleport) continue;

      const startX = this._toGridX(prev.x);
      const startY = this._toGridY(prev.y, cameraY);
      const endX = this._toGridX(peg.x);
      const endY = this._toGridY(peg.y, cameraY);
      if ((startY < -24 && endY < -24) || (startY > this.gridHeight + 24 && endY > this.gridHeight + 24)) continue;

      const dx = endX - startX;
      const dy = endY - startY;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0.02) continue;

      const steps = Math.max(2, Math.min(10, Math.ceil(dist / 0.8)));
      const typeForce = peg.type === 'bumper'
        ? 0.72
        : (peg.shape === 'brick' ? 1.18 : 0.88);
      const speedNorm = Math.min(3.4, worldDist / 2.4);
      const force = (0.045 + speedNorm * 0.11) * typeForce * (0.72 + reactionCurve * 0.34);
      const visibleEdgeRadius = peg.shape === 'brick' ? 22 : 18;
      const radius = this._toGridRadius(visibleEdgeRadius + speedNorm * 3.6);

      for (let step = 0; step < steps; step++) {
        const t = (step + 1) / steps;
        const px = lerp(startX, endX, t);
        const py = lerp(startY, endY, t);
        const vx = dx / Math.max(1, steps);
        const vy = dy / Math.max(1, steps);

        this._stampImpulse(
          px,
          py,
          vx * 0.72,
          vy * 0.72,
          radius,
          force,
          0.08 + typeForce * 0.08,
          0.04 + speedNorm * 0.05,
          0.06
        );
        this._stampImpulse(
          px,
          py,
          vx * 0.18,
          vy * 0.18,
          radius * 1.42,
          force * 0.28,
          0.035,
          0.035,
          0.035
        );
        this._stampImpulse(
          px,
          py,
          vx * 0.06,
          vy * 0.06,
          radius * 1.86,
          force * 0.105,
          0.012,
          0.018,
          0.025
        );
      }
    }

    for (const key of this._pegPrev.keys()) {
      if (!aliveIds.has(key)) this._pegPrev.delete(key);
    }
  }

  _injectReactiveEvents(reactiveState) {
    if (this._pendingEvents.length > 0) {
      for (const event of this._pendingEvents) {
        this._applyReactiveEvent(event, Number.isFinite(event._cameraY) ? event._cameraY : 0);
      }
      this._pendingEvents = [];
      return;
    }
    this._injectFallbackHits(reactiveState);
  }

  _injectFallbackHits(reactiveState) {
    const hitIds = Array.isArray(reactiveState?.hitPegIds) ? reactiveState.hitPegIds : [];
    if (hitIds.length === 0 || !Array.isArray(reactiveState?.pegs)) return;

    const cameraY = Number.isFinite(reactiveState?.cameraY) ? reactiveState.cameraY : 0;
    for (const hitId of hitIds) {
      if (!hitId || this._seenHitIds.has(hitId)) continue;
      const peg = reactiveState.pegs.find(item => item.id === hitId);
      this._seenHitIds.add(hitId);
      if (!peg) continue;

      const sx = this._toGridX(peg.x);
      const sy = this._toGridY(peg.y, cameraY);
      this._stampSplash(sx, sy, 0, -0.22, 8.2, 0.82, 0.42, 0.9);
    }
  }

  _applyReactiveEvent(event, cameraY) {
    if (!event || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
    if (event.kind === 'bombTargetSplash') return;

    const sx = this._toGridX(event.x);
    const sy = this._toGridY(event.y, cameraY);
    if (sy < -40 || sy > this.gridHeight + 40) return;

    const gridScale = this._getViewToGridScale();
    const speed = Number.isFinite(event.speed) ? event.speed : 0;
    const dirMagnitude = (speed * gridScale) * 0.06;
    const dirX = (Number.isFinite(event.normalX) ? event.normalX : 0) * dirMagnitude;
    const dirY = (Number.isFinite(event.normalY) ? event.normalY : -1) * dirMagnitude;
    const radius = this._toGridRadius(Number.isFinite(event.radius) ? event.radius : 46);
    const reactionCurve = this._getReactionCurve(this._effectiveReaction);
    const strength = (Number.isFinite(event.strength) ? event.strength : 1) * (0.78 + reactionCurve * 0.36);
    const swirl = Number.isFinite(event.swirl) ? event.swirl : 0.55;
    const burst = Number.isFinite(event.burst) ? event.burst : 1;
    const spread = Number.isFinite(event.spread) ? event.spread : 1;

    if (event.kind === 'bombSplash') {
      this._stampDistributedSplash(sx, sy, dirX, dirY, radius * 1.18, strength * 0.9, swirl * 0.88, burst * 0.95, spread * 2.1);
      this._stampImpulse(sx, sy, 0, 0, radius * 1.68, strength * 0.34, swirl * 0.2, burst * 0.72, 0.24);
      return;
    }

    this._stampDistributedSplash(sx, sy, dirX, dirY, radius, strength, swirl, burst, spread);
  }

  _injectFlipperWake(reactiveState) {
    const flippers = reactiveState?.flippers;
    if (!flippers || !flippers.enabled) return;

    const delta = Number.isFinite(flippers._angularDelta) ? flippers._angularDelta : 0;
    if (Math.abs(delta) < 0.0025) return;

    const centerX = this.viewWidth / 2;
    const t = flippers._flipperT || 0;
    const restRad = (Number.isFinite(flippers.restAngle) ? flippers.restAngle : 23) * Math.PI / 180;
    const flipRad = (Number.isFinite(flippers.flipAngle) ? flippers.flipAngle : 30) * Math.PI / 180;
    const sc = Number.isFinite(flippers.scale) ? flippers.scale : 1.8;
    const len = (Number.isFinite(flippers.length) ? flippers.length : 60) * sc;
    const width = (Number.isFinite(flippers.width) ? flippers.width : 8) * sc;
    const xOffset = Number.isFinite(flippers.xOffset) ? flippers.xOffset : 196;
    const y = Number.isFinite(flippers.y) ? flippers.y : (this.viewHeight - 55);

    const leftAngle = restRad - t * (restRad + flipRad);
    const rightAngle = Math.PI - leftAngle;
    const reactionCurve = this._getReactionCurve(this._effectiveReaction);
    const strength = (0.38 + reactionCurve * 0.36) * Math.min(3, Math.abs(delta) * 20);
    const sign = Math.sign(delta) || 1;

    this._stampFlipperSweep(centerX - xOffset, y, leftAngle, len, width, -sign, strength);
    this._stampFlipperSweep(centerX + xOffset, y, rightAngle, len, width, sign, strength);
  }

  _stampFlipperSweep(pivotX, pivotY, angle, length, width, sweepSign, strength) {
    const gridScale = this._getViewToGridScale();
    const sweepX = -Math.sin(angle) * sweepSign * strength * 6.4 * gridScale;
    const sweepY = Math.cos(angle) * sweepSign * strength * 6.4 * gridScale;
    const samples = 7;

    for (let i = 0; i < samples; i++) {
      const t = 0.16 + (i / (samples - 1)) * 0.82;
      const px = pivotX + Math.cos(angle) * length * t;
      const py = pivotY + Math.sin(angle) * length * t;
      const weight = 0.55 + t * 0.95;
      this._stampImpulse(
        this._toGridX(px),
        this._toGridY(py, 0),
        sweepX * weight,
        sweepY * weight,
        this._toGridRadius(width * (0.9 + t * 0.55)),
        0.24 + strength * 0.34 * weight,
        0.22 + strength * 0.34,
        0.14 + strength * 0.22,
        0.1
      );
    }
  }

  _stampSplash(cx, cy, dx, dy, radius, force, swirl, burst) {
    this._stampImpulse(cx, cy, dx * 0.32, dy * 0.32, radius * 0.34, force * 0.56, swirl * 0.82, burst * 0.28, 0.16);
    this._stampImpulse(cx, cy, dx * 0.2, dy * 0.2, radius * 0.82, force * 0.28, swirl * 0.2, burst * 0.52, 0.08);
  }

  _stampDistributedSplash(cx, cy, dx, dy, radius, force, swirl, burst, spread = 1) {
    const dirAngle = Math.atan2(dy || -0.0001, dx || 0.0001);
    const scatterCount = Math.max(4, Math.min(9, Math.round(4 + spread * 2.2)));
    const scatterReach = radius * (0.86 + spread * 0.58);

    this._stampSplash(cx, cy, dx, dy, radius * 0.28, force * 0.42, swirl * 0.55, burst * 0.2);
    this._stampImpulse(cx, cy, 0, 0, radius * 1.35, force * 0.12, swirl * 0.1, burst * 0.22, 0.05);

    for (let i = 0; i < scatterCount; i++) {
      const frac = scatterCount === 1 ? 0.5 : i / (scatterCount - 1);
      const arc = (frac - 0.5) * Math.PI * lerp(1.4, 2.1, Math.min(1, spread * 0.5));
      const angle = dirAngle + arc;
      const distance = scatterReach * lerp(0.38, 1, frac);
      const px = cx + Math.cos(angle) * distance;
      const py = cy + Math.sin(angle) * distance;
      const localDx = dx * 0.14 + Math.cos(angle) * force * 0.12;
      const localDy = dy * 0.14 + Math.sin(angle) * force * 0.12;
      const localRadius = radius * lerp(0.12, 0.22, 1 - Math.abs(frac - 0.5) * 1.1);
      const localForce = force * lerp(0.16, 0.27, 1 - frac * 0.65);

      this._stampImpulse(
        px,
        py,
        localDx,
        localDy,
        localRadius,
        localForce,
        swirl * 0.22,
        burst * 0.34,
        0.05
      );
    }
  }

  _clearTileList(mask, list) {
    if (!mask || !list || list.length === 0) {
      if (list) list.length = 0;
      return;
    }
    for (const tileIndex of list) {
      mask[tileIndex] = 0;
    }
    list.length = 0;
  }

  _markTileIndex(mask, list, tileIndex) {
    if (!mask || !list || tileIndex < 0 || tileIndex >= mask.length || mask[tileIndex]) return;
    mask[tileIndex] = 1;
    list.push(tileIndex);
  }

  _markTileBounds(mask, list, minX, minY, maxX, maxY) {
    if (!mask || !list || !this._tileCols || !this._tileRows) return;
    if (maxX < minX || maxY < minY) return;
    const minTx = Math.max(0, Math.floor(minX / FIELD_TILE_SIZE));
    const minTy = Math.max(0, Math.floor(minY / FIELD_TILE_SIZE));
    const maxTx = Math.min(this._tileCols - 1, Math.floor(maxX / FIELD_TILE_SIZE));
    const maxTy = Math.min(this._tileRows - 1, Math.floor(maxY / FIELD_TILE_SIZE));
    for (let ty = minTy; ty <= maxTy; ty++) {
      const rowBase = ty * this._tileCols;
      for (let tx = minTx; tx <= maxTx; tx++) {
        this._markTileIndex(mask, list, rowBase + tx);
      }
    }
  }

  _markActiveTiles(minX, minY, maxX, maxY) {
    this._markTileBounds(this._activeTileMask, this._activeTiles, minX, minY, maxX, maxY);
  }

  _markGlDirtyTile(tileIndex) {
    this._markTileIndex(this._glDirtyTileMask, this._glDirtyTiles, tileIndex);
    this._glFieldDirty = true;
  }

  _markGlDirtyTiles(minX, minY, maxX, maxY) {
    this._markTileBounds(this._glDirtyTileMask, this._glDirtyTiles, minX, minY, maxX, maxY);
    this._glFieldDirty = this._glDirtyTiles.length > 0;
  }

  _collectSourceTiles() {
    this._clearTileList(this._sourceTileMask, this._sourceTiles);
    if (!this._activeTiles || this._activeTiles.length === 0) return;

    for (const tileIndex of this._activeTiles) {
      const tx = tileIndex % this._tileCols;
      const ty = (tileIndex / this._tileCols) | 0;
      for (let oy = -1; oy <= 1; oy++) {
        const nextTy = ty + oy;
        if (nextTy < 0 || nextTy >= this._tileRows) continue;
        const rowBase = nextTy * this._tileCols;
        for (let ox = -1; ox <= 1; ox++) {
          const nextTx = tx + ox;
          if (nextTx < 0 || nextTx >= this._tileCols) continue;
          this._markTileIndex(this._sourceTileMask, this._sourceTiles, rowBase + nextTx);
        }
      }
    }
  }

  _buildGlUploadRects() {
    if (!this._glDirtyTileMask || this._glDirtyTiles.length === 0) {
      return [rectFromBounds(0, 0, this.gridWidth - 1, this.gridHeight - 1)];
    }

    const tileRects = [];
    let previousRuns = new Map();
    for (let ty = 0; ty < this._tileRows; ty++) {
      const rowBase = ty * this._tileCols;
      const currentRuns = new Map();
      for (let tx = 0; tx < this._tileCols; tx++) {
        if (!this._glDirtyTileMask[rowBase + tx]) continue;

        const startTx = tx;
        while (tx + 1 < this._tileCols && this._glDirtyTileMask[rowBase + tx + 1]) {
          tx++;
        }
        const endTx = tx;
        const key = `${startTx}:${endTx}`;
        const previous = previousRuns.get(key);
        if (previous) {
          previous.maxTy = ty;
          currentRuns.set(key, previous);
          continue;
        }

        const rect = { minTx: startTx, maxTx: endTx, minTy: ty, maxTy: ty };
        tileRects.push(rect);
        currentRuns.set(key, rect);
      }
      previousRuns = currentRuns;
    }

    return tileRects.map(rect => rectFromBounds(
      rect.minTx * FIELD_TILE_SIZE,
      rect.minTy * FIELD_TILE_SIZE,
      Math.min(this.gridWidth - 1, ((rect.maxTx + 1) * FIELD_TILE_SIZE) - 1),
      Math.min(this.gridHeight - 1, ((rect.maxTy + 1) * FIELD_TILE_SIZE) - 1)
    )).filter(Boolean);
  }

  _markGlDirtyFull() {
    if (!this.gridWidth || !this.gridHeight) return;
    this._markGlDirtyTiles(0, 0, this.gridWidth - 1, this.gridHeight - 1);
  }

  _stampImpulse(cx, cy, dx, dy, radius, force, swirl = 0, burst = 0, energyBoost = 0.2) {
    const width = this.gridWidth;
    const height = this.gridHeight;
    const minX = Math.max(0, Math.floor(cx - radius - 1));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius + 1));
    const minY = Math.max(0, Math.floor(cy - radius - 1));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius + 1));
    const radiusSq = radius * radius;

    this._stampedThisStep = true;
    this._markActiveTiles(minX, minY, maxX, maxY);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const offX = x + 0.5 - cx;
        const offY = y + 0.5 - cy;
        const distSq = offX * offX + offY * offY;
        if (distSq > radiusSq) continue;

        const idx = y * width + x;
        const dist = Math.sqrt(distSq);
        const falloff = Math.pow(1 - distSq / radiusSq, 2);
        const invDist = dist > 0.0001 ? (1 / dist) : 0;
        const radialX = offX * invDist;
        const radialY = offY * invDist;
        const tangentialX = -offY;
        const tangentialY = offX;

        this.flowX[idx] = clamp(
          this.flowX[idx] + (
            dx * 0.88 +
            tangentialX * swirl * 0.042 +
            radialX * burst * -0.48
          ) * falloff * force,
          -3.6,
          3.6
        );
        this.flowY[idx] = clamp(
          this.flowY[idx] + (
            dy * 0.88 +
            tangentialY * swirl * 0.042 +
            radialY * burst * -0.48
          ) * falloff * force,
          -3.6,
          3.6
        );
        this.energy[idx] = clamp(this.energy[idx] + falloff * force * energyBoost, 0, 2.1);
      }
    }
  }

  _advectField() {
    const width = this.gridWidth;
    const height = this.gridHeight;
    if ((!this._activeTiles || this._activeTiles.length === 0) && !this._stampedThisStep) return false;
    if (!this.flowX) return false;

    const reactionCurve = this._getReactionCurve(this._effectiveReaction);
    const roughness = this._effectiveRoughness;
    const trailLift = Math.max(0, this._effectiveTrail - 1);
    const damping = 0.78 + Math.min(0.1, reactionCurve * 0.03) + Math.min(0.035, trailLift * 0.03);
    const energyDamping = 0.89 + Math.min(0.08, this._effectiveReaction * 0.04) + Math.min(0.05, trailLift * 0.05);
    const neighborMix = lerp(0.34, 0.17, roughness);
    const selfMix = 1 - neighborMix;

    this._collectSourceTiles();
    if (this._sourceTiles.length === 0) return false;

    this._clearTileList(this._nextActiveTileMask, this._nextActiveTiles);

    for (const tileIndex of this._sourceTiles) {
      const tx = tileIndex % this._tileCols;
      const ty = (tileIndex / this._tileCols) | 0;
      const minX = tx * FIELD_TILE_SIZE;
      const minY = ty * FIELD_TILE_SIZE;
      const maxX = Math.min(width - 1, minX + FIELD_TILE_SIZE - 1);
      const maxY = Math.min(height - 1, minY + FIELD_TILE_SIZE - 1);
      let tileActive = false;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const idx = y * width + x;
          const left = y * width + Math.max(0, x - 1);
          const right = y * width + Math.min(width - 1, x + 1);
          const up = Math.max(0, y - 1) * width + x;
          const down = Math.min(height - 1, y + 1) * width + x;

          const nextFlowX = ((this.flowX[idx] * selfMix) + ((this.flowX[left] + this.flowX[right] + this.flowX[up] + this.flowX[down]) * 0.25) * neighborMix) * damping;
          const nextFlowY = ((this.flowY[idx] * selfMix) + ((this.flowY[left] + this.flowY[right] + this.flowY[up] + this.flowY[down]) * 0.25) * neighborMix) * damping;
          const nextEnergy = ((this.energy[idx] * 0.8) + ((this.energy[left] + this.energy[right] + this.energy[up] + this.energy[down]) * 0.25) * 0.2) * energyDamping;

          const flowX = Math.abs(nextFlowX) < FLOW_ACTIVE_EPS ? 0 : clamp(nextFlowX, -3.2, 3.2);
          const flowY = Math.abs(nextFlowY) < FLOW_ACTIVE_EPS ? 0 : clamp(nextFlowY, -3.2, 3.2);
          const energy = nextEnergy < ENERGY_ACTIVE_EPS ? 0 : clamp(nextEnergy, 0, 1.95);

          this.nextFlowX[idx] = flowX;
          this.nextFlowY[idx] = flowY;
          this.nextEnergy[idx] = energy;
          tileActive ||= (flowX !== 0 || flowY !== 0 || energy !== 0);
        }
      }

      if (tileActive) {
        this._markTileIndex(this._nextActiveTileMask, this._nextActiveTiles, tileIndex);
      }
      this._markGlDirtyTile(tileIndex);
    }

    [this.flowX, this.nextFlowX] = [this.nextFlowX, this.flowX];
    [this.flowY, this.nextFlowY] = [this.nextFlowY, this.flowY];
    [this.energy, this.nextEnergy] = [this.nextEnergy, this.energy];
    [this._activeTiles, this._nextActiveTiles] = [this._nextActiveTiles, this._activeTiles];
    [this._activeTileMask, this._nextActiveTileMask] = [this._nextActiveTileMask, this._activeTileMask];
    this._clearTileList(this._nextActiveTileMask, this._nextActiveTiles);
    this._clearTileList(this._sourceTileMask, this._sourceTiles);
    return true;
  }

  _samplePattern(pattern, x, y) {
    const width = this.gridWidth;
    const height = this.gridHeight;
    const wrappedX = ((x % width) + width) % width;
    const wrappedY = ((y % height) + height) % height;

    const x0 = Math.floor(wrappedX);
    const y0 = Math.floor(wrappedY);
    const x1 = (x0 + 1) % width;
    const y1 = (y0 + 1) % height;
    const tx = wrappedX - x0;
    const ty = wrappedY - y0;

    const idx00 = y0 * width + x0;
    const idx10 = y0 * width + x1;
    const idx01 = y1 * width + x0;
    const idx11 = y1 * width + x1;

    return lerp(
      lerp(pattern[idx00], pattern[idx10], tx),
      lerp(pattern[idx01], pattern[idx11], tx),
      ty
    );
  }

  _sampleBase(x, y) {
    if (!this._progressPatternActive || this._progressBlend <= 0.001) {
      return this._samplePattern(this.basePattern, x, y);
    }
    const primary = this._samplePattern(this.basePattern, x, y);
    const secondary = this._samplePattern(this.progressBasePattern, x, y);
    return lerp(primary, secondary, this._progressBlend);
  }

  _attachGlCanvas(canvas) {
    canvas.addEventListener('webglcontextlost', this._handleGlContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._handleGlContextRestored, false);
  }

  _detachGlCanvas(canvas) {
    if (!canvas) return;
    canvas.removeEventListener('webglcontextlost', this._handleGlContextLost, false);
    canvas.removeEventListener('webglcontextrestored', this._handleGlContextRestored, false);
  }

  _createGlCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = this._glOutputWidth;
    canvas.height = this._glOutputHeight;
    this._attachGlCanvas(canvas);
    this._glCanvas = canvas;
    return canvas;
  }

  _getOrCreateGlContext() {
    const canvas = this._glCanvas || this._createGlCanvas();
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    }) || canvas.getContext('experimental-webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    });
    this._gl = gl;
    return gl;
  }

  _resizeGlCanvas() {
    if (!this._glCanvas) return;
    if (this._glCanvas.width !== this._glOutputWidth || this._glCanvas.height !== this._glOutputHeight) {
      this._glCanvas.width = this._glOutputWidth;
      this._glCanvas.height = this._glOutputHeight;
    }
  }

  _clearGlResourceHandles() {
    this._glProgram = null;
    this._glBuffer = null;
    this._glFieldTexture = null;
    this._glUniforms = null;
    this._glFieldTexWidth = 0;
    this._glFieldTexHeight = 0;
  }

  _onGlContextLost(event) {
    event.preventDefault();
    this._glContextLost = true;
    this._clearGlResourceHandles();
    this._useGlOutput = false;
    this._dirty = true;
  }

  _onGlContextRestored() {
    this._glContextLost = false;
    this._glUnavailable = false;
    this._gl = this._getOrCreateGlContext();
    this._clearGlResourceHandles();
    this._markGlDirtyFull();
    this._dirty = true;
  }

  _ensureWebGL() {
    if (this._glUnavailable || this._glContextLost) return false;
    if (typeof document === 'undefined') {
      this._glUnavailable = true;
      return false;
    }

    this._resizeGlCanvas();
    const gl = this._gl || this._getOrCreateGlContext();
    if (!gl) {
      this._glUnavailable = true;
      return false;
    }
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      this._glContextLost = true;
      this._dirty = true;
      return false;
    }

    if (!this._glProgram || !this._glBuffer || !this._glFieldTexture || !this._glUniforms) {
      const program = this._createGlProgram(gl, FULLSCREEN_VERTEX_SHADER, buildLiquidFragmentShader(this._getWebGlTier()));
      if (!program) {
        this._glUnavailable = true;
        return false;
      }

      const buffer = gl.createBuffer();
      const fieldTexture = gl.createTexture();
      if (!buffer || !fieldTexture) {
        this._glUnavailable = true;
        return false;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
         1,  1
      ]), gl.STATIC_DRAW);

      gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      this._glProgram = program;
      this._glBuffer = buffer;
      this._glFieldTexture = fieldTexture;
      this._glUniforms = {
        position: gl.getAttribLocation(program, 'a_position'),
        field: gl.getUniformLocation(program, 'u_field'),
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        fieldSize: gl.getUniformLocation(program, 'u_fieldSize'),
        flowDecode: gl.getUniformLocation(program, 'u_flowDecode'),
        time: gl.getUniformLocation(program, 'u_time'),
        scale: gl.getUniformLocation(program, 'u_scale'),
        roughness: gl.getUniformLocation(program, 'u_roughness'),
        distortion: gl.getUniformLocation(program, 'u_distortion'),
        lacunarity: gl.getUniformLocation(program, 'u_lacunarity'),
        motion: gl.getUniformLocation(program, 'u_motion'),
        reactionCurve: gl.getUniformLocation(program, 'u_reactionCurve'),
        worldOffset: gl.getUniformLocation(program, 'u_worldOffset'),
        colorBase: gl.getUniformLocation(program, 'u_colorBase'),
        colorMid: gl.getUniformLocation(program, 'u_colorMid'),
        colorAccent: gl.getUniformLocation(program, 'u_colorAccent'),
      };
      this._markGlDirtyFull();
    }

    this._ensureGlFieldTexture();
    return !!(this._glProgram && this._glBuffer && this._glFieldTexture && this._glUniforms);
  }

  _getWebGlTier() {
    if (this._glTier) return this._glTier;

    let mobileLike = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
        mobileLike = navigator.userAgentData.mobile;
      } else if (typeof navigator !== 'undefined') {
        mobileLike = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent || '');
      }
      if (!mobileLike && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        mobileLike = window.matchMedia('(pointer: coarse)').matches && ((navigator?.maxTouchPoints || 0) > 0);
      }
    } catch (_) {}

    this._glTier = mobileLike
      ? { key: 'mobile', patternOctaves: 3, driftOctaves: 2 }
      : { key: 'desktop', patternOctaves: 4, driftOctaves: 2 };
    return this._glTier;
  }

  _ensureGlFieldTexture() {
    if (!this._gl || !this._glFieldTexture) return;
    if (this._glFieldTexWidth === this.gridWidth && this._glFieldTexHeight === this.gridHeight) {
      return;
    }
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this._glFieldTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.gridWidth,
      this.gridHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    this._glFieldTexWidth = this.gridWidth;
    this._glFieldTexHeight = this.gridHeight;
    this._markGlDirtyFull();
  }

  _createGlShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      return shader;
    }
    if (!gl.isContextLost || !gl.isContextLost()) {
      console.warn('[liquid] WebGL shader compile failed', gl.getShaderInfoLog(shader));
    }
    gl.deleteShader(shader);
    return null;
  }

  _createGlProgram(gl, vertexSource, fragmentSource) {
    const vertexShader = this._createGlShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this._createGlShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return program;
    }
    if (!gl.isContextLost || !gl.isContextLost()) {
      console.warn('[liquid] WebGL program link failed', gl.getProgramInfoLog(program));
    }
    gl.deleteProgram(program);
    return null;
  }

  _uploadGlField() {
    if (!this._gl || !this._glFieldTexture) return false;
    if (!this._glFieldDirty) return true;
    const rects = this._buildGlUploadRects();
    if (!rects || rects.length === 0) {
      this._glFieldDirty = false;
      return true;
    }

    const flowMax = GL_FLOW_MAX;
    const energyMax = GL_ENERGY_MAX;
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this._glFieldTexture);
    for (const rect of rects) {
      const rectW = rectWidth(rect);
      const rectH = rectHeight(rect);
      const required = rectW * rectH * 4;
      if (!this._glUploadScratch || this._glUploadScratch.length < required) {
        this._glUploadScratch = new Uint8Array(required);
      }

      const pixels = this._glUploadScratch;
      let p = 0;
      for (let y = rect.minY; y <= rect.maxY; y++) {
        let idx = y * this.gridWidth + rect.minX;
        for (let x = rect.minX; x <= rect.maxX; x++, idx++) {
          pixels[p] = Math.round(clamp((this.flowX[idx] / flowMax) * 127.5 + 127.5, 0, 255));
          pixels[p + 1] = Math.round(clamp((this.flowY[idx] / flowMax) * 127.5 + 127.5, 0, 255));
          pixels[p + 2] = Math.round(clamp((this.energy[idx] / energyMax) * 255, 0, 255));
          pixels[p + 3] = 255;
          p += 4;
        }
      }

      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        rect.minX,
        rect.minY,
        rectW,
        rectH,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels.subarray(0, required)
      );
    }

    this._glFieldDirty = false;
    this._clearTileList(this._glDirtyTileMask, this._glDirtyTiles);
    return true;
  }

  _rasterizeGL() {
    if (!this._ensureWebGL()) return false;
    if (!this._uploadGlField()) return false;

    const gl = this._gl;
    const uniforms = this._glUniforms;
    const reactionCurve = this._getReactionCurve(this._effectiveReaction);

    gl.useProgram(this._glProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._glBuffer);
    gl.enableVertexAttribArray(uniforms.position);
    gl.vertexAttribPointer(uniforms.position, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._glFieldTexture);
    gl.uniform1i(uniforms.field, 0);
    gl.uniform2f(uniforms.resolution, this._glOutputWidth, this._glOutputHeight);
    gl.uniform2f(uniforms.fieldSize, this.gridWidth, this.gridHeight);
    gl.uniform2f(uniforms.flowDecode, GL_FLOW_MAX, GL_ENERGY_MAX);
    gl.uniform1f(uniforms.time, this._visualTime);
    gl.uniform1f(uniforms.scale, this._effectiveScale);
    gl.uniform1f(uniforms.roughness, this._effectiveRoughness);
    gl.uniform1f(uniforms.distortion, this._effectiveDistortion);
    gl.uniform1f(uniforms.lacunarity, this._effectiveLacunarity);
    gl.uniform1f(uniforms.motion, this._effectiveMotion);
    gl.uniform1f(uniforms.reactionCurve, reactionCurve);
    gl.uniform1f(uniforms.worldOffset, this._worldOffset);
    gl.uniform3f(uniforms.colorBase, this._effectiveColorBase.r / 255, this._effectiveColorBase.g / 255, this._effectiveColorBase.b / 255);
    gl.uniform3f(uniforms.colorMid, this._effectiveColorMid.r / 255, this._effectiveColorMid.g / 255, this._effectiveColorMid.b / 255);
    gl.uniform3f(uniforms.colorAccent, this._effectiveColorAccent.r / 255, this._effectiveColorAccent.g / 255, this._effectiveColorAccent.b / 255);

    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this._glOutputWidth, this._glOutputHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._useGlOutput = true;
    return true;
  }

  _rasterizeCanvas() {
    this._ensureCpuSurface();
    this._ensureCpuPatterns();

    this._useGlOutput = false;
    const width = this.gridWidth;
    const height = this.gridHeight;
    const pixels = this.pixels;
    const motionAmp = 1.18 + this._effectiveMotion * 3.4;
    const reactionCurve = this._getReactionCurve(this._effectiveReaction);
    const reactHigh = smoothstep(1, 4, reactionCurve);
    const roughness = this._effectiveRoughness;
    const distortion = clampFinite(this._effectiveDistortion, 0, 2, 1);
    const lacunaT = clamp01((this._effectiveLacunarity - 1.6) / 1.5);
    const reactAmp = 2.8 + reactionCurve * 5.2;
    const base = this._effectiveColorBase;
    const mid = this._effectiveColorMid;
    const accent = this._effectiveColorAccent;
    const accentLuma = ((accent.r / 255) * 0.2126) + ((accent.g / 255) * 0.7152) + ((accent.b / 255) * 0.0722);
    const worldOffsetGrid = this._worldOffset * height;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const pixelIdx = idx * 4;
        const worldY = y + worldOffsetGrid;
        const phase = this.passiveAngle[idx];
        const phase2 = phase * 1.7 + this.passiveWeight[idx] * 2.4;
        const driftX =
          Math.sin(this._visualTime * 1.05 + phase) * motionAmp +
          Math.cos(this._visualTime * 0.62 + phase2) * motionAmp * 0.38;
        const driftY =
          Math.cos(this._visualTime * 0.84 + phase * 1.15) * motionAmp * 0.72 +
          Math.sin(this._visualTime * 0.54 + phase2 * 0.9) * motionAmp * 0.28;
        const warpStrength = 0.42 + distortion * 0.58;

        const sample = this._sampleBaseContinuous(
          x + (this.flowX[idx] * reactAmp + driftX) * warpStrength,
          worldY + (this.flowY[idx] * reactAmp + driftY) * warpStrength
        );
        const detailScale = 1.02 + roughness * 1.45 + lacunaT * 0.4;
        const centeredX = x - width * 0.5;
        const centeredY = worldY - height * 0.5;
        const detailSample = this._sampleBaseContinuous(
          width * 0.5 + centeredX * detailScale + this.flowX[idx] * reactAmp * (0.22 + roughness * 0.24 + distortion * 0.1) + driftX * (0.24 + roughness * 0.2 + distortion * 0.08),
          height * 0.5 + centeredY * detailScale + this.flowY[idx] * reactAmp * (0.22 + roughness * 0.24 + distortion * 0.1) + driftY * (0.24 + roughness * 0.2 + distortion * 0.08)
        );
        const micro = this._valueNoise(
          centeredX * (0.15 + roughness * 0.05 + lacunaT * 0.02) + driftX * (0.15 + distortion * 0.05),
          centeredY * (0.15 + roughness * 0.05 + lacunaT * 0.02) + driftY * (0.15 + distortion * 0.05)
        );
        const energy = clamp01(this.energy[idx] * 0.62);
        const softBody = clamp01(
          0.5 +
          (sample - 0.5) * (1.04 + this._effectiveMotion * 0.26 + energy * 0.32) +
          energy * 0.05
        );
        let scalar = clamp01(
          0.5 +
          (sample - 0.5) * (1.1 + this._effectiveMotion * 0.34 + energy * 0.42) +
          energy * 0.06
        );
        scalar = lerp(scalar, detailSample, 0.07 + roughness * 0.16 + lacunaT * 0.06);
        let softVolume = lerp(softBody, detailSample, 0.15 + roughness * 0.1);
        softVolume = lerp(softVolume, sample, 0.16 + distortion * 0.04);
        scalar = lerp(scalar, micro, 0.018 + roughness * 0.038 + lacunaT * 0.01);
        scalar = lerp(scalar, softVolume, 0.1 + reactHigh * 0.16);
        scalar = clamp01(0.5 + (scalar - 0.5) * (0.95 + roughness * 0.25 - reactHigh * 0.09));

        const edgeSoft = 0.055 + roughness * 0.05 + reactHigh * 0.085;
        const volumeScalar = lerp(scalar, softVolume, 0.45 + reactHigh * 0.12);
        const midT = smoothstep(0.07 - edgeSoft * 0.2, 0.74 + edgeSoft, volumeScalar);
        const accentT = smoothstep(0.38 - edgeSoft * 0.32, 0.9 + edgeSoft * 0.5, scalar);
        const voidT = 1 - smoothstep(0.15 - edgeSoft * 0.35, 0.5 + edgeSoft * 0.8, volumeScalar);
        const deepBaseR = lerp(base.r, mid.r, 0.12 + midT * 0.2);
        const deepBaseG = lerp(base.g, mid.g, 0.12 + midT * 0.2);
        const deepBaseB = lerp(base.b, mid.b, 0.12 + midT * 0.2);
        let r = lerp(deepBaseR, mid.r, midT * 0.9 + 0.05);
        let g = lerp(deepBaseG, mid.g, midT * 0.9 + 0.05);
        let b = lerp(deepBaseB, mid.b, midT * 0.9 + 0.05);
        const accentBlend = 0.68 + roughness * 0.16;
        const accentTargetR = lerp(mid.r, accent.r, accentBlend);
        const accentTargetG = lerp(mid.g, accent.g, accentBlend);
        const accentTargetB = lerp(mid.b, accent.b, accentBlend);
        r = lerp(r, accentTargetR, accentT * (0.9 - voidT * 0.18));
        g = lerp(g, accentTargetG, accentT * (0.9 - voidT * 0.18));
        b = lerp(b, accentTargetB, accentT * (0.9 - voidT * 0.18));
        r = lerp(r, deepBaseR, voidT * (0.18 + (1 - accentT) * 0.12));
        g = lerp(g, deepBaseG, voidT * (0.18 + (1 - accentT) * 0.12));
        b = lerp(b, deepBaseB, voidT * (0.18 + (1 - accentT) * 0.12));

        const highlight = smoothstep(0.81 - edgeSoft * 0.2, 0.992, scalar) * (0.12 + energy * 0.18) * (0.12 + accentLuma * 0.88) * (1 - voidT * 0.28);
        r = Math.min(255, r + (255 - r) * highlight * 0.74);
        g = Math.min(255, g + (248 - g) * highlight * 0.64);
        b = Math.min(255, b + (255 - b) * highlight);

        const shadow = 0.91 + energy * 0.08;
        const dither = ((this._hash2(x + 17.21, y + 53.73) - 0.5) * (0.003 + roughness * 0.004 + lacunaT * 0.0015)) * 255;
        pixels[pixelIdx] = Math.round(clamp(r * shadow + dither, 0, 255));
        pixels[pixelIdx + 1] = Math.round(clamp(g * shadow + dither, 0, 255));
        pixels[pixelIdx + 2] = Math.round(clamp(b * shadow + dither, 0, 255));
        pixels[pixelIdx + 3] = 255;
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }
}
