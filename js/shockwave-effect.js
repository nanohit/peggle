const TAU = Math.PI * 2;
const MAX_ACTIVE_WAVES = 28;
const MAX_SHADER_WAVES = 16;
// Persistent magnet force-field rings rendered in the same pass as transient waves.
const MAX_SHADER_FIELDS = 6;
const TRIGGER_KINDS = new Set(['bombSplash', 'bombTargetSplash', 'victorySplash']);

const PROFILE_LIMITS = Object.freeze({
  full: Object.freeze({ maxWaves: 16, maxFields: 6 }),
  balanced: Object.freeze({ maxWaves: 8, maxFields: 4 }),
  lite: Object.freeze({ maxWaves: 4, maxFields: 2 })
});

const SHOCKWAVE_VERTEX_SHADER = `
attribute vec2 aPosition;
attribute vec2 aUv;
varying vec2 vUv;

void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

function createShockwaveFragmentShader(maxWaves) {
  return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

#define MAX_WAVES ${maxWaves}
#define MAX_FIELDS ${MAX_SHADER_FIELDS}

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform int uWaveCount;
uniform vec4 uWaveA[MAX_WAVES];
uniform vec4 uWaveB[MAX_WAVES];
uniform vec4 uWaveC[MAX_WAVES];
uniform int uFieldCount;
uniform vec4 uFieldA[MAX_FIELDS];
uniform vec4 uFieldB[MAX_FIELDS];

varying vec2 vUv;

const float PI = 3.141592653589793;

float fieldHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float fieldNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fieldHash(i);
  float b = fieldHash(i + vec2(1.0, 0.0));
  float c = fieldHash(i + vec2(0.0, 1.0));
  float d = fieldHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 pixel = vec2(vUv.x * uResolution.x, (1.0 - vUv.y) * uResolution.y);
  vec2 displacement = vec2(0.0);
  vec3 highlight = vec3(0.0);
  float energy = 0.0;

  // Persistent magnet force fields: a noisy refracting band rides the radius boundary AND
  // a gentle animated swirl fills the disk inside it, so the warp reads as a field VOLUME,
  // not just an edge line. PURE distortion — no colour/glow/haze — and independent of
  // magnet strength (visible at any/zero force). Cheap: the interior reuses the same two
  // noise samples; only the disk up to the band's outer edge is touched.
  for (int i = 0; i < MAX_FIELDS; i++) {
    if (i < uFieldCount) {
      vec4 fa = uFieldA[i];   // x, y, radius, (unused)
      vec4 fb = uFieldB[i];   // modeSign, time, band, intensity
      vec2 fd = pixel - fa.xy;
      float fdist = length(fd);
      float fradius = fa.z;
      float band = max(2.0, fb.z);
      float outer = fradius + band * 2.6;
      if (fdist > 0.001 && fdist < outer) {
        vec2 dir = fd / fdist;
        vec2 perp = vec2(-dir.y, dir.x);
        float ang = atan(fd.y, fd.x);
        vec2 ncoord = vec2(cos(ang), sin(ang)) * 2.7;
        float tt = fb.y;
        float n1 = fieldNoise(ncoord * 1.6 + vec2(tt * 0.7, -tt * 0.5));
        float n2 = fieldNoise(ncoord * 3.3 - vec2(tt * 0.45, tt * 0.6));
        float intensity = fb.w;
        float sign = fb.x;

        // Boundary band — the noisy refracting ring on the radius.
        float wob = (n1 - 0.5) * band * 1.1 + (n2 - 0.5) * band * 0.5;
        float ringR = fradius + wob;
        float sb = (fdist - ringR) / band;
        float ringProf = 1.0 - smoothstep(0.0, 1.0, abs(sb));
        ringProf = ringProf * ringProf * (3.0 - 2.0 * ringProf);
        float ringAmp = (2.6 + fradius * 0.022) * intensity * ringProf;
        displacement += dir * ringAmp * sign * (0.55 + 0.45 * n1);

        // Interior haze — a light rotating swirl across the disk, fading near the centre
        // and at the rim, animated by time so the whole field shimmers gently.
        float rN = fdist / max(1.0, fradius);                         // 0 centre .. 1 rim
        float interior = smoothstep(0.04, 0.34, rN) * (1.0 - smoothstep(0.9, 1.08, rN));
        float swirl = sin(ang * 3.0 + tt * 1.7 + (n1 - 0.5) * 6.2832);
        float hazeAmp = (1.2 + fradius * 0.013) * intensity * interior * 0.5;
        displacement += (perp * swirl + dir * (n2 - 0.5)) * hazeAmp * sign;
      }
    }
  }

  for (int i = 0; i < MAX_WAVES; i++) {
    if (i < uWaveCount) {
      vec4 waveA = uWaveA[i];
      vec4 waveB = uWaveB[i];
      vec4 waveC = uWaveC[i];
      vec2 delta = pixel - waveA.xy;
      float width = max(1.0, waveA.w);
      float outer = waveA.z + width;
      float inner = max(0.0, waveA.z - width);
      float distSq = dot(delta, delta);
      if (distSq <= outer * outer && distSq >= inner * inner) {
        float dist = sqrt(distSq);
        float signedBand = (dist - waveA.z) / width;
        float band = 1.0 - smoothstep(0.0, 1.0, abs(signedBand));
        band = band * band * (3.0 - 2.0 * band);
        if (band > 0.0001) {
          vec2 dir = dist > 0.001 ? delta / dist : vec2(0.0, -1.0);
          float phase = signedBand * PI * waveB.z;
          float pulse = cos(phase);
          float weight = max(0.05, waveB.w);
          displacement += dir * (waveB.x * band * pulse * weight);
          energy += abs(waveB.x) * band * weight;

          float crest = 1.0 - smoothstep(0.0, 0.42, abs(signedBand));
          float shoulder = 1.0 - smoothstep(0.35, 1.0, abs(signedBand));
          highlight += waveC.rgb * waveB.y * weight * (crest * 0.24 + shoulder * 0.07);
        }
      }
    }
  }

  float displacementLength = length(displacement);
  float displacementCap = 18.0 + 12.0 * smoothstep(0.0, 36.0, energy);
  if (displacementLength > displacementCap) {
    displacement *= displacementCap / max(0.001, displacementLength);
  }
  displacement /= 1.0 + max(0.0, energy - 18.0) * 0.022;

  vec2 samplePixel = pixel - displacement;
  vec2 sampleUv = vec2(samplePixel.x / uResolution.x, 1.0 - samplePixel.y / uResolution.y);
  vec4 color = texture2D(uTexture, clamp(sampleUv, vec2(0.0), vec2(1.0)));
  vec3 glow = min(vec3(0.42), 1.0 - exp(-max(vec3(0.0), highlight)));
  color.rgb = 1.0 - (1.0 - color.rgb) * (1.0 - glow);
  gl_FragColor = color;
}
`;
}

const FULLSCREEN_QUAD = new Float32Array([
  -1, -1, 0, 0,
   1, -1, 1, 0,
  -1,  1, 0, 1,
  -1,  1, 0, 1,
   1, -1, 1, 0,
   1,  1, 1, 1
]);

const DEFAULT_SHOCKWAVE_COLOR = '#ffffff';
export const DEFAULT_SHOCKWAVE_VICTORY_SETTINGS = Object.freeze({
  color: '#6EFCD7',
  radius: 1.2,
  strength: 2.8,
  width: 2.4,
  duration: 0.86,
  ripple: 0,
  opacity: 0.22
});

export const DEFAULT_SHOCKWAVE_MAGNET_FIELD = Object.freeze({
  enabled: true,
  intensity: 1
});

export const DEFAULT_SHOCKWAVE_EFFECT = Object.freeze({
  enabled: true,
  bomb: true,
  bombTargets: false,
  victory: true,
  color: DEFAULT_SHOCKWAVE_COLOR,
  radius: 1,
  strength: 1.09,
  width: 2.4,
  duration: 0.4,
  ripple: 0.59,
  opacity: 0,
  victorySeparate: true,
  victorySettings: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS,
  magnetField: DEFAULT_SHOCKWAVE_MAGNET_FIELD
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeShockwaveStyle(source, fallback = DEFAULT_SHOCKWAVE_VICTORY_SETTINGS) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    color: isColor(raw.color) ? raw.color : fallback.color,
    radius: clamp(raw.radius, 0.35, 2.6, fallback.radius),
    strength: clamp(raw.strength, 0, 2.8, fallback.strength),
    width: clamp(raw.width, 0.25, 2.4, fallback.width),
    duration: clamp(raw.duration, 0.22, 1.8, fallback.duration),
    ripple: clamp(raw.ripple, 0, 2.4, fallback.ripple),
    opacity: clamp(raw.opacity, 0, 1.2, fallback.opacity)
  };
}

function parseColorInto(target, value) {
  const hex = isColor(value) ? value : DEFAULT_SHOCKWAVE_COLOR;
  if (target.hex === hex) return target;
  target.hex = hex;
  target.r = parseInt(hex.slice(1, 3), 16) / 255;
  target.g = parseInt(hex.slice(3, 5), 16) / 255;
  target.b = parseInt(hex.slice(5, 7), 16) / 255;
  return target;
}

function normalizeProfile(profile) {
  return Object.prototype.hasOwnProperty.call(PROFILE_LIMITS, profile) ? profile : 'balanced';
}

function normalizeMagnetFieldConfig(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    enabled: raw.enabled !== false,
    intensity: clamp(raw.intensity, 0, 2.5, DEFAULT_SHOCKWAVE_MAGNET_FIELD.intensity)
  };
}

function easeOutCubic(t) {
  const k = 1 - Math.max(0, Math.min(1, t));
  return 1 - k * k * k;
}

function screenWaveRadius(event, config, width, height) {
  const base = Number.isFinite(event.radius)
    ? Math.max(40, event.radius)
    : Math.min(width, height) * 0.24;
  const kindScale = event.kind === 'victorySplash'
    ? 1.72
    : (event.kind === 'bombTargetSplash' ? 0.82 : 1.34);
  return Math.max(48, base * kindScale * config.radius);
}

export function normalizeShockwaveConfig(raw = null) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = normalizeShockwaveStyle(source, DEFAULT_SHOCKWAVE_EFFECT);
  const rawVictorySettings = source.victorySettings && typeof source.victorySettings === 'object' && !Array.isArray(source.victorySettings)
    ? source.victorySettings
    : null;
  return {
    enabled: source.enabled !== false,
    bomb: source.bomb !== false,
    bombTargets: source.bombTargets === true,
    victory: source.victory !== false,
    ...base,
    victorySeparate: source.victorySeparate !== false,
    victorySettings: normalizeShockwaveStyle(
      rawVictorySettings,
      rawVictorySettings ? base : DEFAULT_SHOCKWAVE_VICTORY_SETTINGS
    ),
    magnetField: normalizeMagnetFieldConfig(source.magnetField)
  };
}

export class ShockwaveEffectRenderer {
  constructor() {
    this.config = normalizeShockwaveConfig(null);
    this.waves = [];
    this._nextId = 1;
    this._glCanvas = null;
    this._gl = null;
    this._glPrograms = new Map();
    this._glBuffer = null;
    this._glTexture = null;
    this._glTextureWidth = 0;
    this._glTextureHeight = 0;
    this._glViewportWidth = 0;
    this._glViewportHeight = 0;
    this._glUnavailable = false;
    this._glEventsBound = false;
    this._waveA = new Float32Array(MAX_SHADER_WAVES * 4);
    this._waveB = new Float32Array(MAX_SHADER_WAVES * 4);
    this._waveC = new Float32Array(MAX_SHADER_WAVES * 4);
    this._waveUniformViews = new Map();
    this._fieldRings = [];
    this._fieldA = new Float32Array(MAX_SHADER_FIELDS * 4);
    this._fieldB = new Float32Array(MAX_SHADER_FIELDS * 4);
    this._fieldUniformCount = 0;
    this._baseColor = { hex: '', r: 1, g: 1, b: 1 };
    this._victoryColor = { hex: '', r: 1, g: 1, b: 1 };
    this._warnedWebGlFailures = new Set();
    this._previewWave = {
      kind: 'victorySplash',
      x: 0,
      y: 0,
      radius: 0,
      born: 0,
      strengthScale: 1.18,
      durationScale: 1.18,
      weightScale: 1
    };
    this._warnedDeprecatedRender = false;
  }

  setConfig(config) {
    this.config = normalizeShockwaveConfig(config);
    if (!this.config.enabled) this.reset();
  }

  getCanvas() {
    if (!this._glCanvas && typeof document !== 'undefined') {
      this._glCanvas = document.createElement('canvas');
      this._glCanvas.className = 'game-shockwave-layer';
      this._glCanvas.setAttribute('aria-hidden', 'true');
      this._bindWebGlContextEvents();
    }
    return this._glCanvas;
  }

  reset() {
    this.waves.length = 0;
  }

  _timeSeconds() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now() / 1000;
    }
    return Date.now() / 1000;
  }

  _warnWebGlFailure(reason, detail = '') {
    if (this._warnedWebGlFailures.has(reason)) return;
    this._warnedWebGlFailures.add(reason);
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[shockwave] WebGL unavailable: ${reason}`, detail || '');
    }
  }

  _shouldAcceptEvent(event) {
    if (!this.config.enabled || !event || !TRIGGER_KINDS.has(event.kind)) return false;
    if ((event.kind === 'bombSplash' || event.kind === 'bombTargetSplash') && !this.config.bomb) return false;
    if (event.kind === 'bombTargetSplash' && !this.config.bombTargets) return false;
    if (event.kind === 'victorySplash' && !this.config.victory) return false;
    return Number.isFinite(event.x) && Number.isFinite(event.y);
  }

  _enqueue(event, now) {
    const kind = event.kind === 'victorySplash'
      ? 'victorySplash'
      : (event.kind === 'bombTargetSplash' ? 'bombTargetSplash' : 'bombSplash');
    const strengthScale = kind === 'victorySplash'
      ? 1.48
      : (kind === 'bombTargetSplash' ? 0.56 : 1);
    const durationScale = kind === 'victorySplash'
      ? 1.45
      : (kind === 'bombTargetSplash' ? 0.84 : 1);
    const weightScale = kind === 'bombTargetSplash' ? 0.72 : 1;
    this.waves.push({
      id: this._nextId++,
      kind,
      x: event.x,
      y: event.y,
      radius: Number.isFinite(event.radius) ? event.radius : 90,
      born: now,
      strengthScale,
      durationScale,
      weightScale
    });
    while (this.waves.length > MAX_ACTIVE_WAVES) {
      this.waves.shift();
    }
  }

  syncEvents(events, options = null) {
    const now = Number.isFinite(options?.timeSeconds) ? options.timeSeconds : this._timeSeconds();
    if (Array.isArray(events)) {
      for (const event of events) {
        if (this._shouldAcceptEvent(event)) this._enqueue(event, now);
      }
    }
    this._prune(now);
    return this.config.enabled && (!!options?.preview || this.waves.length > 0);
  }

  // Persistent magnet force-field rings. `rings` = [{ x, y(world), radius, strength, mode }].
  // Stored each frame by the renderer; rendered in the same WebGL pass as the waves.
  syncFieldRings(rings) {
    this._fieldRings = Array.isArray(rings) ? rings : [];
    return this.hasFieldRings();
  }

  hasFieldRings() {
    return this.config.enabled
      && this.config.magnetField?.enabled !== false
      && this.config.magnetField?.intensity > 0
      && this._fieldRings.length > 0;
  }

  _prune(now = this._timeSeconds()) {
    let write = 0;
    for (let read = 0; read < this.waves.length; read++) {
      const wave = this.waves[read];
      const duration = this._durationForWave(wave);
      if (now - wave.born <= duration + 0.04) {
        this.waves[write++] = wave;
      }
    }
    this.waves.length = write;
  }

  isActive(now = this._timeSeconds(), preview = false) {
    if (!this.config.enabled) return false;
    if (preview) return true;
    this._prune(now);
    return this.waves.length > 0;
  }

  _compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[shockwave] WebGL shader compile failed:', gl.getShaderInfoLog(shader) || 'unknown error');
      }
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(gl, maxWaves) {
    const vertex = this._compileShader(gl, gl.VERTEX_SHADER, SHOCKWAVE_VERTEX_SHADER);
    const fragment = this._compileShader(gl, gl.FRAGMENT_SHADER, createShockwaveFragmentShader(maxWaves));
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return null;
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[shockwave] WebGL program link failed:', gl.getProgramInfoLog(program) || 'unknown error');
      }
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  _resetWebGlResources() {
    this._gl = null;
    this._glPrograms.clear();
    this._glBuffer = null;
    this._glTexture = null;
    this._glTextureWidth = 0;
    this._glTextureHeight = 0;
    this._glViewportWidth = 0;
    this._glViewportHeight = 0;
  }

  dispose() {
    const gl = this._gl;
    if (gl && !(typeof gl.isContextLost === 'function' && gl.isContextLost())) {
      for (const bundle of this._glPrograms.values()) {
        if (bundle?.program) gl.deleteProgram(bundle.program);
      }
      if (this._glBuffer) gl.deleteBuffer(this._glBuffer);
      if (this._glTexture) gl.deleteTexture(this._glTexture);
    }
    if (this._glCanvas?.parentNode) {
      this._glCanvas.parentNode.removeChild(this._glCanvas);
    }
    this._resetWebGlResources();
    this._glCanvas = null;
    this._glEventsBound = false;
    this._glUnavailable = false;
    this._warnedWebGlFailures.clear();
    this.waves.length = 0;
  }

  _bindWebGlContextEvents() {
    if (!this._glCanvas || this._glEventsBound) return;
    this._glEventsBound = true;
    this._glCanvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this._resetWebGlResources();
      this._glUnavailable = false;
    });
    this._glCanvas.addEventListener('webglcontextrestored', () => {
      this._resetWebGlResources();
      this._glUnavailable = false;
    });
  }

  _getProgramBundle(gl, maxWaves) {
    const key = Math.max(1, Math.min(MAX_SHADER_WAVES, maxWaves | 0));
    const cached = this._glPrograms.get(key);
    if (cached) return cached;

    const program = this._createProgram(gl, key);
    if (!program) return null;
    const bundle = {
      maxWaves: key,
      program,
      locations: {
        position: gl.getAttribLocation(program, 'aPosition'),
        uv: gl.getAttribLocation(program, 'aUv'),
        texture: gl.getUniformLocation(program, 'uTexture'),
        resolution: gl.getUniformLocation(program, 'uResolution'),
        waveCount: gl.getUniformLocation(program, 'uWaveCount'),
        waveA: gl.getUniformLocation(program, 'uWaveA[0]'),
        waveB: gl.getUniformLocation(program, 'uWaveB[0]'),
        waveC: gl.getUniformLocation(program, 'uWaveC[0]'),
        fieldCount: gl.getUniformLocation(program, 'uFieldCount'),
        fieldA: gl.getUniformLocation(program, 'uFieldA[0]'),
        fieldB: gl.getUniformLocation(program, 'uFieldB[0]')
      }
    };
    this._glPrograms.set(key, bundle);
    return bundle;
  }

  _getWaveUniformViews(waveCount) {
    const key = Math.max(1, Math.min(MAX_SHADER_WAVES, waveCount | 0));
    const cached = this._waveUniformViews.get(key);
    if (cached) return cached;
    const length = key * 4;
    const views = {
      a: this._waveA.subarray(0, length),
      b: this._waveB.subarray(0, length),
      c: this._waveC.subarray(0, length)
    };
    this._waveUniformViews.set(key, views);
    return views;
  }

  _ensureWebGl(width, height) {
    if (this._glUnavailable || typeof document === 'undefined') return null;
    this.getCanvas();
    if (!this._glCanvas) return null;
    if (this._glCanvas.width !== width || this._glCanvas.height !== height) {
      this._glCanvas.width = width;
      this._glCanvas.height = height;
      this._glViewportWidth = 0;
      this._glViewportHeight = 0;
    }
    if (this._gl) return this._gl;

    const attrs = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      // This WebGL canvas is displayed directly as a DOM overlay. With a frame
      // cap, skipped rAF ticks can leave the compositor showing a cleared back
      // buffer on some browsers unless the last drawn shockwave frame is kept.
      preserveDrawingBuffer: true
    };
    const gl = this._glCanvas.getContext('webgl', attrs) || this._glCanvas.getContext('experimental-webgl', attrs);
    if (!gl) {
      this._glUnavailable = true;
      this._warnWebGlFailure('context creation failed');
      return null;
    }

    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!buffer || !texture) {
      if (buffer) gl.deleteBuffer(buffer);
      if (texture) gl.deleteTexture(texture);
      this._glUnavailable = true;
      this._warnWebGlFailure('buffer or texture creation failed');
      return null;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_QUAD, gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    this._gl = gl;
    this._glBuffer = buffer;
    this._glTexture = texture;
    return gl;
  }

  _styleForWave(kind) {
    if (kind === 'victorySplash' && this.config.victorySeparate && this.config.victorySettings) {
      return this.config.victorySettings;
    }
    return this.config;
  }

  _colorForWave(kind, style) {
    const target = kind === 'victorySplash' ? this._victoryColor : this._baseColor;
    return parseColorInto(target, style?.color || DEFAULT_SHOCKWAVE_COLOR);
  }

  _durationForWave(wave) {
    const style = this._styleForWave(wave.kind);
    return Math.max(0.001, style.duration * wave.durationScale);
  }

  _writeWaveUniform(wave, now, cameraY, width, height, outIndex) {
    const style = this._styleForWave(wave.kind);
    const duration = this._durationForWave(wave);
    const age = Math.max(0, now - wave.born);
    const t = Math.max(0, Math.min(1, age / duration));
    if (t >= 1) return false;

    const front = easeOutCubic(t);
    const fade = (1 - t) * (1 - t * 0.24);
    const centerX = wave.x;
    const centerY = wave.y - cameraY;
    const maxRadius = screenWaveRadius(wave, style, width, height);
    const radius = Math.max(8, maxRadius * front);
    const bandWidth = Math.max(12, (18 + maxRadius * 0.12) * style.width);
    const outer = radius + bandWidth;
    if (centerX + outer < 0 || centerX - outer > width || centerY + outer < 0 || centerY - outer > height) return false;

    const amp = (5.5 + maxRadius * 0.026) * style.strength * wave.strengthScale * fade;
    const ringAlpha = style.opacity * fade;
    if (amp <= 0.04 && ringAlpha <= 0.004) return false;

    const offset = outIndex * 4;
    const color = this._colorForWave(wave.kind, style);
    this._waveA[offset] = centerX;
    this._waveA[offset + 1] = centerY;
    this._waveA[offset + 2] = radius;
    this._waveA[offset + 3] = bandWidth;
    this._waveB[offset] = amp;
    this._waveB[offset + 1] = ringAlpha;
    this._waveB[offset + 2] = 1.05 + style.ripple * 1.55;
    this._waveB[offset + 3] = Number.isFinite(wave.weightScale) ? wave.weightScale : 1;
    this._waveC[offset] = color.r;
    this._waveC[offset + 1] = color.g;
    this._waveC[offset + 2] = color.b;
    this._waveC[offset + 3] = 1;
    return true;
  }

  _prepareWaveUniforms(now, cameraY, width, height, limits, preview) {
    const maxCount = Math.max(1, Math.min(MAX_SHADER_WAVES, limits.maxWaves));
    let count = 0;
    const start = Math.max(0, this.waves.length - maxCount);
    for (let i = start; i < this.waves.length && count < maxCount; i++) {
      if (this._writeWaveUniform(this.waves[i], now, cameraY, width, height, count)) {
        count++;
      }
    }

    if (preview && count < maxCount) {
      const previewStyle = this._styleForWave('victorySplash');
      const duration = Math.max(0.001, previewStyle.duration * 1.18);
      const loop = now % duration;
      const previewWave = this._previewWave;
      previewWave.x = width * 0.5;
      previewWave.y = height * 0.52;
      previewWave.radius = Math.min(width, height) * 0.22;
      previewWave.born = now - loop;
      if (this._writeWaveUniform(previewWave, now, 0, width, height, count)) {
        count++;
      }
    }

    return count;
  }

  _prepareFieldUniforms(now, cameraY, width, height, limits) {
    if (!this.hasFieldRings()) return 0;
    const intensity = clamp(this.config.magnetField?.intensity, 0, 2.5, 1);
    if (intensity <= 0) return 0;
    const maxCount = Math.max(0, Math.min(MAX_SHADER_FIELDS, limits.maxFields || MAX_SHADER_FIELDS));
    let count = 0;
    for (let i = 0; i < this._fieldRings.length && count < maxCount; i++) {
      const ring = this._fieldRings[i];
      const radius = Number(ring?.radius);
      if (!Number.isFinite(radius) || radius <= 0) continue;
      const cx = Number(ring?.x);
      const cy = Number(ring?.y) - cameraY;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const band = Math.max(4, radius * 0.06 + 7);
      const margin = band * 2.6;
      if (cx + radius + margin < 0 || cx - radius - margin > width
        || cy + radius + margin < 0 || cy - radius - margin > height) continue;
      const modeSign = ring?.mode === 'repel' ? -1 : 1;
      const offset = count * 4;
      this._fieldA[offset] = cx;
      this._fieldA[offset + 1] = cy;
      this._fieldA[offset + 2] = radius;
      this._fieldA[offset + 3] = 1; // amplitude no longer scales with magnet strength
      this._fieldB[offset] = modeSign;
      this._fieldB[offset + 1] = now;
      this._fieldB[offset + 2] = band;
      this._fieldB[offset + 3] = intensity;
      count++;
    }
    this._fieldUniformCount = count;
    return count;
  }

  _renderWithShader(sourceCanvas, width, height, waveCount, fieldCount, limits) {
    const gl = this._ensureWebGl(width, height);
    if (!gl) return false;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return false;

    const bundle = this._getProgramBundle(gl, limits.maxWaves);
    if (!bundle) {
      this._glUnavailable = true;
      this._warnWebGlFailure('shader program creation failed');
      return false;
    }
    const loc = bundle.locations;
    try {
      if (this._glViewportWidth !== width || this._glViewportHeight !== height) {
        gl.viewport(0, 0, width, height);
        this._glViewportWidth = width;
        this._glViewportHeight = height;
      }
      gl.useProgram(bundle.program);

      gl.bindBuffer(gl.ARRAY_BUFFER, this._glBuffer);
      const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
      if (loc.position >= 0) {
        gl.enableVertexAttribArray(loc.position);
        gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, stride, 0);
      }
      if (loc.uv >= 0) {
        gl.enableVertexAttribArray(loc.uv);
        gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._glTexture);
      if (this._glTextureWidth === width && this._glTextureHeight === height) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        this._glTextureWidth = width;
        this._glTextureHeight = height;
      }

      gl.uniform1i(loc.texture, 0);
      gl.uniform2f(loc.resolution, width, height);
      gl.uniform1i(loc.waveCount, waveCount);
      const uniformViews = this._getWaveUniformViews(Math.min(Math.max(1, waveCount), bundle.maxWaves));
      gl.uniform4fv(loc.waveA, uniformViews.a);
      gl.uniform4fv(loc.waveB, uniformViews.b);
      gl.uniform4fv(loc.waveC, uniformViews.c);
      if (loc.fieldCount) gl.uniform1i(loc.fieldCount, fieldCount);
      if (fieldCount > 0 && loc.fieldA) {
        const fieldLen = Math.min(fieldCount, MAX_SHADER_FIELDS) * 4;
        gl.uniform4fv(loc.fieldA, this._fieldA.subarray(0, fieldLen));
        gl.uniform4fv(loc.fieldB, this._fieldB.subarray(0, fieldLen));
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    } catch (error) {
      this._glUnavailable = true;
      this._glTextureWidth = 0;
      this._glTextureHeight = 0;
      this._warnWebGlFailure('render pass failed', error?.message || String(error || 'unknown error'));
      return false;
    }
  }

  prewarm(sourceCanvas, options = null) {
    if (!sourceCanvas || !this.config.enabled) return false;
    const width = Number.isFinite(options?.width) ? options.width : sourceCanvas.width;
    const height = Number.isFinite(options?.height) ? options.height : sourceCanvas.height;
    const profile = normalizeProfile(options?.profile);
    const limits = PROFILE_LIMITS[profile];
    const gl = this._ensureWebGl(width, height);
    if (!gl) return false;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return false;

    const bundle = this._getProgramBundle(gl, limits.maxWaves);
    if (!bundle) {
      this._glUnavailable = true;
      this._warnWebGlFailure('prewarm shader program creation failed');
      return false;
    }

    const loc = bundle.locations;
    try {
      if (this._glViewportWidth !== width || this._glViewportHeight !== height) {
        gl.viewport(0, 0, width, height);
        this._glViewportWidth = width;
        this._glViewportHeight = height;
      }
      gl.useProgram(bundle.program);

      gl.bindBuffer(gl.ARRAY_BUFFER, this._glBuffer);
      const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
      if (loc.position >= 0) {
        gl.enableVertexAttribArray(loc.position);
        gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, stride, 0);
      }
      if (loc.uv >= 0) {
        gl.enableVertexAttribArray(loc.uv);
        gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._glTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      this._glTextureWidth = width;
      this._glTextureHeight = height;

      gl.uniform1i(loc.texture, 0);
      gl.uniform2f(loc.resolution, width, height);
      gl.uniform1i(loc.waveCount, 0);
      if (loc.fieldCount) gl.uniform1i(loc.fieldCount, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    } catch (error) {
      this._glUnavailable = true;
      this._glTextureWidth = 0;
      this._glTextureHeight = 0;
      this._warnWebGlFailure('prewarm render pass failed', error?.message || String(error || 'unknown error'));
      return false;
    }
  }

  _renderFallbackGlow(ctx, sourceCanvas, waveCount) {
    ctx.drawImage(sourceCanvas, 0, 0);
    for (let i = 0; i < waveCount; i++) {
      const offset = i * 4;
      const x = this._waveA[offset];
      const y = this._waveA[offset + 1];
      const radius = this._waveA[offset + 2];
      const bandWidth = this._waveA[offset + 3];
      const alpha = this._waveB[offset + 1];
      if (alpha <= 0.004) continue;
      const r = Math.round(Math.max(0, Math.min(1, this._waveC[offset] || 1)) * 255);
      const g = Math.round(Math.max(0, Math.min(1, this._waveC[offset + 1] || 1)) * 255);
      const b = Math.round(Math.max(0, Math.min(1, this._waveC[offset + 2] || 1)) * 255);
      const inner = Math.max(0, radius - bandWidth);
      const outer = radius + bandWidth;
      const gradient = ctx.createRadialGradient(x, y, inner, x, y, outer);
      gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
      gradient.addColorStop(0.5, `rgba(${r},${g},${b},${Math.min(0.28, alpha * 0.22)})`);
      gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, outer, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    return waveCount > 0;
  }

  renderToCanvas(sourceCanvas, options = null) {
    if (!sourceCanvas) return null;
    const width = Number.isFinite(options?.width) ? options.width : sourceCanvas.width;
    const height = Number.isFinite(options?.height) ? options.height : sourceCanvas.height;
    const now = Number.isFinite(options?.timeSeconds) ? options.timeSeconds : this._timeSeconds();
    const preview = !!options?.preview;
    if (!options?.skipPrune) this._prune(now);
    const hasFields = this.hasFieldRings();
    if (!this.config.enabled || (!preview && this.waves.length === 0 && !hasFields)) return null;

    const cameraY = Number.isFinite(options?.cameraY) ? options.cameraY : 0;
    const profile = normalizeProfile(options?.profile);
    const limits = PROFILE_LIMITS[profile];
    const waveCount = this._prepareWaveUniforms(now, cameraY, width, height, limits, preview);
    const fieldCount = this._prepareFieldUniforms(now, cameraY, width, height, limits);
    if (waveCount <= 0 && fieldCount <= 0) return null;
    return this._renderWithShader(sourceCanvas, width, height, waveCount, fieldCount, limits) ? this._glCanvas : null;
  }

  render(ctx, sourceCanvas, options = null) {
    if (!ctx || !sourceCanvas) return false;
    if (!this._warnedDeprecatedRender) {
      this._warnedDeprecatedRender = true;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('ShockwaveEffectRenderer.render() is deprecated; use renderToCanvas() with a DOM overlay layer to avoid WebGL -> 2D readback.');
      }
    }
    const width = Number.isFinite(options?.width) ? options.width : sourceCanvas.width;
    const height = Number.isFinite(options?.height) ? options.height : sourceCanvas.height;
    const now = Number.isFinite(options?.timeSeconds) ? options.timeSeconds : this._timeSeconds();
    const preview = !!options?.preview;
    if (!options?.skipPrune) this._prune(now);
    if (!this.config.enabled || (!preview && this.waves.length === 0)) return false;

    const cameraY = Number.isFinite(options?.cameraY) ? options.cameraY : 0;
    const profile = normalizeProfile(options?.profile);
    const limits = PROFILE_LIMITS[profile];
    const waveCount = this._prepareWaveUniforms(now, cameraY, width, height, limits, preview);
    if (waveCount <= 0) return false;

    // Compatibility path for any non-layered caller. The main renderer now uses
    // renderToCanvas() so WebGL never has to be read back into a 2D context.
    return this._renderFallbackGlow(ctx, sourceCanvas, waveCount);
  }
}
