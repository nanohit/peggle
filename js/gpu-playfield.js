// Playfield renderer: deferred shading lit by height-field radiance cascades.
//
// Nothing here paints a highlight or a shadow. The pipeline builds real surface
// geometry (a height field with per-pixel normals), solves visibility by
// marching rays against that height field, and lets every bright/dark region
// fall out of the solve. A peg's glint moves because the light moved; a peg's
// shadow stretches because the peg is tall and the light is low.
//
//   1. gbuffer   albedo+height / normal+roughness / emission+occluder  (MRT)
//   2. downsample  half-res emission+height, the texture rays march against
//   3. seed+jfa    jump-flooded distance to the nearest footprint boundary,
//                  used purely to skip empty space while marching
//   4. cascades    N radiance cascades, base 4, geometric intervals, merged
//                  top-down with visibility alpha
//   5. shade       gather cascade 0 into irradiance + an irradiance vector,
//                  shade the gbuffer against it, reflect the field at grazing
//                  angles
//   6. bloom       threshold + 3-level down/up chain
//   7. composite   ACES, grade, dither
//
// Rays are 2.5D: probes sit on a plane because the board is a plane, but each
// ray climbs (`uElevation`) and is occluded by `rayHeight < surfaceHeight`, so
// shadow length is a function of real object height and real light elevation.

import { PHYSICS_CONFIG, getEffectiveBrickSize } from './physics.js';
import { normalizePegType } from './peg-types.js';
import { getPortalScale, isPortalType } from './portal-defaults.js';

const INSTANCE_FLOATS = 16;
const CURVE_FLOATS = 13;

// Emission is stored in a texture that may be RGBA8 when float targets are
// unavailable, so radiance is written scaled down and read back scaled up.
const EMIT_SCALE = 12.0;
// Full-white in the height channel, in logical canvas pixels.
const HEIGHT_SCALE = 15.0;
const DEFAULT_SKY_TOP = Object.freeze([0.052, 0.128, 0.205]);
const DEFAULT_SKY_BOTTOM = Object.freeze([0.012, 0.028, 0.048]);
const QUALITY_ORDER = Object.freeze(['low', 'medium', 'high']);
const ZERO_CLEAR = new Float32Array(4);
// How many per-frame movers the distance field can carry analytically. A real
// board holds a ball or three, a bucket, two flippers and the launcher; past
// this the overflow simply goes back into the jump flood, which is correct but
// costs a rebuild.
const MAX_DYNAMIC_SOLIDS = 24;
// Analytic profiles the merge shader knows. They mirror shapeDistance() in
// OBJECT_FS, which is what the jump flood would otherwise have rasterised.
const DYN_DISC = 0;
const DYN_ANNULUS = 1;
const DYN_ROUNDBOX = 2;

const SHAPE_DOME = 0;
const SHAPE_BOX = 1;
const SHAPE_BUMPER = 2;
const SHAPE_EMITTER = 3;
const SHAPE_BALL = 4;
const SHAPE_RING = 5;
const SHAPE_CAPSULE = 6;
// An aperture rather than an object: a hole with a burning edge and a throat
// you look into. It has no surface and no height, so nothing about it behaves
// like the solid bar the portals used to be built from.
const SHAPE_PORTAL = 7;

const SHAPE_CODES = Object.freeze({
  dome: SHAPE_DOME,
  box: SHAPE_BOX,
  bumper: SHAPE_BUMPER,
  emitter: SHAPE_EMITTER,
  ball: SHAPE_BALL,
  ring: SHAPE_RING,
  capsule: SHAPE_CAPSULE,
  portal: SHAPE_PORTAL
});

const MAT_PLASTIC = 0;
const MAT_METAL = 1;
const MAT_EMISSIVE = 2;
// Lights the solve but is never drawn — the cabinet's fixtures.
const MAT_HIDDEN_EMITTER = 3;

const TYPE_CODES = Object.freeze({
  orange: 0,
  blue: 1,
  green: 2,
  purple: 3,
  multi: 4,
  gamble: 5,
  obstacle: 6,
  bomb: 7,
  billiardRed: 8,
  billiardYellow: 9,
  bumper: 10,
  portalBlue: 11,
  portalOrange: 12,
  bombMagnet: 13
});

// Linear-space albedo. These are surface colours, not pixel colours — what you
// see on screen is this times whatever light actually reaches it. Hues are kept
// far apart because peg type has to be readable at a glance before it is ever
// hit, which is a gameplay requirement, not a look.
const PALETTE = [
  [0.98, 0.20, 0.030],  // orange
  [0.040, 0.72, 0.88],  // blue
  [0.15, 0.86, 0.36],   // green
  [0.52, 0.20, 0.96],   // purple
  [0.96, 0.10, 0.44],   // multi
  [0.55, 0.94, 0.06],   // gamble
  // Machined steel. A metal reflects rather than diffuses, so a dark albedo
  // here reads as a hole in the board rather than a solid bar.
  [0.44, 0.49, 0.55],   // obstacle
  [0.97, 0.08, 0.06],   // bomb
  [0.92, 0.13, 0.10],   // billiardRed
  [0.98, 0.62, 0.04],   // billiardYellow
  [0.98, 0.24, 0.035],  // bumper
  // Juicy blue and juicy orange rather than teal and amber. Saturation here is
  // what carries the colour, because emission is kept below the tonemap knee.
  [0.05, 0.48, 1.00],   // portalBlue
  [1.00, 0.24, 0.015],  // portalOrange
  [0.50, 0.54, 0.60]    // bombMagnet — machined steel, not a coloured peg
];

const METAL_TYPES = new Set([6]); // obstacle reads as machined metal

// A bumper's steel collar is always the same; its core is what says whether it
// can be knocked out and whether you have to. The flags already drive scoring
// (`bumperOrange` counts as an orange peg, `bumperDisappear` as a blue one,
// neither means permanent), so the colour just follows them.
const BUMPER_CORE_ORANGE = [0.98, 0.24, 0.035];   // must be cleared
const BUMPER_CORE_CYAN = [0.040, 0.72, 0.88];     // clearable, optional
// Bright neutral rather than the collar's grey, so a permanent bumper reads as
// a pale core in a steel ring instead of one uniform metal blob.
const BUMPER_CORE_INERT = [0.70, 0.74, 0.78];     // cannot be cleared

function bumperCoreColor(peg) {
  if (peg.bumperOrange) return BUMPER_CORE_ORANGE;
  if (peg.bumperDisappear) return BUMPER_CORE_CYAN;
  return BUMPER_CORE_INERT;
}

// Every light in the scene lives here as data. Fixture positions are normalised
// (0..1 of the board) so they survive a resize; sizes stay in logical pixels.
// Nothing about the rig is baked — edit this and the solve follows.
export function createDefaultLighting() {
  return {
    exposure: 0.86,
    bloom: 0.02,
    bloomThreshold: 1.62,
    domeIntensity: 2.74,
    domeColor: [0.58, 0.78, 1.0],
    keyDirX: -0.21,
    keyDirY: 0.87,
    keyElevation: 0.62,
    lightElevation: 0.12,
    // The cabinet's fill lives here, in the environment, rather than in fake
    // lamp objects sitting on the board. Ambient is directionally even, so it
    // raises legibility at rest without leaving pools anywhere.
    skyIntensity: 6.2,
    vignette: 0.42,
    saturation: 1.10,
    hitBoost: 1.47,
    gloss: 3.0,
    // Lower bound on the roughness of the specular driven by the solved field.
    // 0 keeps the historical behaviour; raising it stops a four-direction probe
    // from steering a mirror lobe, which is what makes a lifted board go patchy.
    specFloor: 0.0,
    // How much of each frame's freshly solved field to accept. With the field
    // now smoothed in probe space this can stay high, so moving light reads
    // crisp instead of dragging a smear behind it.
    giBlend: 0.55,
    bounce: 0.38,
    // Board surface. 0 = mottled polymer, 1 = recessed grid, 2 = plain.
    // The grid is the cabinet's canonical playfield rather than an editor-only
    // overlay: its channels live in the height field, so they pick up the same
    // key light and cast the same tiny bevel shadows as the rest of the board.
    boardStyle: 1,
    boardColor: [0.0068, 0.0155, 0.0248],
    boardTexture: 0.34,
    boardGrid: 32,
    boardGridDepth: 0.48,
    // No fixtures by default. Static strips left bright pools on the board
    // whether or not their geometry was drawn, and that residue read as dirt.
    // The board is lit by the overhead rig and the ambient; every light that
    // moves — struck pegs, the ball, the launcher — is a real emitter already.
    // The rig stays fully available: add lights in the tuner and they solve.
    fixtures: []
  };
}

const COMMON = `
#define TAU 6.28318530718
vec2 canvasToUv(vec2 p, vec2 canvas) { return vec2(p.x / canvas.x, 1.0 - p.y / canvas.y); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p = r * p * 2.03 + 13.7; a *= 0.5; }
  return v;
}
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
`;

const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ── 1. G-buffer ─────────────────────────────────────────────────────────────

const BOARD_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv;
layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oNormal;
layout(location=2) out vec4 oEmission;
layout(location=3) out vec4 oMaterial;
uniform vec2 uCanvas;
uniform vec2 uRender;
uniform float uTime;
uniform float uBoardStyle;
uniform vec3 uBoardColor;
uniform float uBoardTexture;
uniform float uBoardGrid;
uniform float uBoardGridDepth;

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRender.y - gl_FragCoord.y) * (uCanvas / uRender);
  vec2 uv = p / uCanvas;

  // Machined polymer: coarse mottling under a fine directional grain. This is
  // a height field, not a painted shade — every bright fleck you end up seeing
  // is the grain catching whatever light is actually nearby.
  float coarse = fbm(p * 0.011);
  float grain = fbm(vec2(p.x * 0.9, p.y * 0.16)) * 0.5 + fbm(p * 0.35) * 0.5;
  float noiseAmount = uBoardStyle > 1.5 ? 0.0 : uBoardTexture;
  float h = (coarse * 1.6 + grain * 0.22) * noiseAmount;

  // Grid mode cuts real channels into the surface instead of drawing lines, so
  // each groove lights on the key side and shades on the other.
  if (uBoardStyle > 0.5 && uBoardStyle < 1.5) {
    vec2 cell = p / max(uBoardGrid, 3.0);
    vec2 edge = abs(fract(cell) - 0.5);
    vec2 soft = fwidth(cell) * 1.2 + 0.015;
    float groove = max(
      1.0 - smoothstep(0.0, soft.x, edge.x),
      1.0 - smoothstep(0.0, soft.y, edge.y)
    );
    h -= groove * uBoardGridDepth * 7.0;
  }

  // The well floor dishes upward into the side rails, so the board catches the
  // rail light along its edges the way a real recessed cabinet does.
  float edgeL = smoothstep(46.0, 4.0, p.x);
  float edgeR = smoothstep(46.0, 4.0, uCanvas.x - p.x);
  float edgeT = smoothstep(40.0, 2.0, p.y);
  float edgeB = smoothstep(52.0, 2.0, uCanvas.y - p.y);
  h += (edgeL + edgeR) * 2.4 + (edgeT + edgeB) * 1.6;

  vec3 N = normalize(vec3(-dFdx(h) * 1.9, -dFdy(h) * 1.9, 1.0));

  // Deliberately near-black. The board reads dark in the reference not because
  // it is unlit but because it is a dark surface; keeping it here is what lets
  // the pegs carry all the colour.
  vec3 mid = uBoardColor;
  vec3 deep = uBoardColor * 0.47;
  vec3 albedo = mix(deep, mid, (coarse * 0.75 + 0.25) * noiseAmount + (1.0 - noiseAmount));
  albedo *= 0.86 + 0.30 * pow(1.0 - uv.y, 1.4);
  albedo = mix(albedo, uBoardColor * 1.45, (edgeL + edgeR) * 0.5);

  float rough = 0.62 - grain * 0.13;

  // Alpha is coverage on every attachment so objects can blend over the board.
  oAlbedo = vec4(albedo, 1.0);
  oNormal = vec4(N.xy * 0.5 + 0.5, rough, 1.0);
  oEmission = vec4(0.0, 0.0, 0.0, 1.0);
  oMaterial = vec4(0.0, 0.0, 0.0, 1.0);
}`;

const OBJECT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aUnit;
layout(location=1) in vec2 aCenter;
layout(location=2) in vec2 aHalf;
layout(location=3) in vec4 aParams;  // angle, shape, hit, matId
layout(location=4) in vec4 aTint;    // rgb albedo, a emissive strength
layout(location=5) in vec4 aExtra;   // heightScale, emergence, energy, spare
out vec2 vLocal;
out vec2 vHalf;
out vec2 vWorld;
out vec4 vTint;
out float vHit;
flat out float vShape;
flat out float vMat;
flat out float vHidden;
flat out float vRise;
flat out float vEmerge;
flat out float vEnergy;
flat out float vCharge;
uniform vec2 uCanvas;
uniform float uMargin;

void main() {
  float angle = aParams.x;
  float c = cos(angle), s = sin(angle);
  mat2 rot = mat2(c, s, -s, c);
  // A torus stores (outer radius, tube radius), so its quad has to be square at
  // the outer radius or the ring gets clipped to two stubs.
  bool ring = aParams.y > 4.5 && aParams.y < 5.5;
  vec2 extent = ring ? vec2(aHalf.x) : aHalf;
  vec2 pad = extent + uMargin;
  vLocal = aUnit * pad;
  vec2 world = aCenter + rot * vLocal;
  vWorld = world;
  vHalf = aHalf;
  vTint = aTint;
  vHit = aParams.z;
  vShape = aParams.y;
  // Material id 3 marks a fixture that lights the scene without being drawn.
  vMat = aParams.w > 2.5 ? 2.0 : aParams.w;
  vHidden = aParams.w > 2.5 ? 1.0 : 0.0;
  vRise = max(aExtra.x, 0.0);
  vEmerge = clamp(aExtra.y, 0.0, 1.0);
  vEnergy = clamp(aExtra.z, 0.0, 1.0);
  vCharge = clamp(aExtra.w, 0.0, 1.0);
  vec2 clip = world / uCanvas * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const OBJECT_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vLocal;
in vec2 vHalf;
in vec2 vWorld;
in vec4 vTint;
in float vHit;
flat in float vShape;
flat in float vMat;
flat in float vHidden;
flat in float vRise;
flat in float vEmerge;
flat in float vEnergy;
flat in float vCharge;
layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oNormal;
layout(location=2) out vec4 oEmission;
layout(location=3) out vec4 oMaterial;
uniform float uHeightScale;
uniform float uEmitScale;
uniform float uHitBoost;
uniform float uGloss;
uniform float uTime;

float shapeDistance(vec2 p) {
  // dome / bumper / ball are discs; ring is an annulus; the rest are rounded
  // boxes differing only in how generous the corner radius is.
  if (vShape < 0.5 || (vShape > 1.5 && vShape < 2.5) || (vShape > 3.5 && vShape < 4.5)) {
    return length(p) - vHalf.x;
  }
  if (vShape > 4.5 && vShape < 5.5) {
    return abs(length(p) - (vHalf.x - vHalf.y)) - vHalf.y;
  }
  if (vShape > 6.5) {
    // A stadium: straight through the middle, fully rounded at the ends. This
    // is the thick stylised line the portal is drawn as.
    return sdRoundBox(p, vHalf, min(vHalf.x, vHalf.y));
  }
  float r = vShape > 2.5 ? min(vHalf.x, vHalf.y) : min(3.4, vHalf.y * 0.62);
  return sdRoundBox(p, vHalf, r);
}

void main() {
  float d = shapeDistance(vLocal);
  float aa = max(fwidth(d), 0.55);
  float coverage = 1.0 - smoothstep(-aa, aa, d);
  if (coverage < 0.004) discard;

  bool isBox     = vShape > 0.5 && vShape < 1.5;
  bool isBumper  = vShape > 1.5 && vShape < 2.5;
  bool isEmit    = vShape > 2.5 && vShape < 3.5;
  bool isBall    = vShape > 3.5 && vShape < 4.5;
  bool isRing    = vShape > 4.5 && vShape < 5.5;
  bool isCapsule = vShape > 5.5 && vShape < 6.5;
  bool isPortal  = vShape > 6.5;

  vec3 N;
  float height;
  float rough;
  vec3 albedo = vTint.rgb;
  // Lets a shape promote part of itself to metal (the bumper's steel collar).
  float metalMix = 0.0;
  // Shapes that generate their own radiance per-fragment set this instead of
  // taking the instance's flat emissive strength.
  vec3 emitOverride = vec3(-1.0);

  if (isPortal) {
    // A rod of contained energy standing off the board — a thick stylised
    // line, lit from within along its whole length. Nothing here is hollow and
    // nothing is dark: a dark middle is what made it read as a hole rather
    // than as an object sitting in the scene.
    float rr = max(min(vHalf.x, vHalf.y), 0.001);
    float t = clamp(-d / rr, 0.0, 1.0);            // 0 at the outline, 1 on the axis
    float along = vLocal.x / max(vHalf.x, 0.001);  // -1..1 lengthwise

    // Round cross-section. This is what puts it in space: the same profile a
    // tube has, so the crown is full, the sides roll away, and the height it
    // writes below makes it occlude and cast like any other solid.
    float dome = sqrt(max(1e-3, 1.0 - (1.0 - t) * (1.0 - t)));

    // Energy running along it. Two bands drifting against each other, so it
    // never reads as one texture scrolling past.
    float flowA = fbm(vec2(along * 3.0 - uTime * 0.42, t * 1.7));
    float flowB = fbm(vec2(along * 6.1 + uTime * 0.27 + 11.0, t * 2.4));
    float flow = 0.70 + flowA * 0.42 + flowB * 0.26;

    // Body, containment edge, core. The body is the volume; the edge is a thin
    // line right at the silhouette that gives the rod its definition; the core
    // is the white-hot axis seen through it. The edge is kept narrow and the
    // body falls off hard, because lighting both extremes evenly is what
    // flattens a tube back into a painted stripe.
    float body = pow(dome, 2.2) * flow;
    float edge = (1.0 - smoothstep(0.0, 0.20, t)) * 0.55;
    float core = pow(t, 3.2) * (0.85 + flowA * 0.5);

    // A one-way portal only accepts from one face. vHit carries which one, and
    // that face simply burns harder — the direction comes from the portal being
    // brighter on the side it opens to, not from a marker painted next to it.
    float open = vHit;
    float across = vLocal.y / max(vHalf.y, 0.001);
    float lean = abs(open) < 0.5 ? 1.0 : mix(0.34, 1.0, smoothstep(-0.6, 0.4, across * open));

    // vTint.a is the instance's brightness (idle level plus any pulse). Kept
    // saturated: only the core goes white, so the hue survives the tonemap.
    emitOverride = vTint.rgb * vTint.a * lean * (body * 2.5 + edge * 1.5);
    emitOverride += vec3(1.0) * vTint.a * lean * core * 0.60;

    // It is a solid in the scene, so it gets a real normal and real height and
    // is lit and occludes accordingly.
    float e = 0.6;
    float dx = shapeDistance(vLocal + vec2(e, 0.0)) - shapeDistance(vLocal - vec2(e, 0.0));
    float dy = shapeDistance(vLocal + vec2(0.0, e)) - shapeDistance(vLocal - vec2(0.0, e));
    vec2 grad = normalize(vec2(dx, dy) + vec2(1e-5));
    N = normalize(vec3(grad * (1.0 - t) * 1.15, dome));
    N.y = -N.y;
    height = dome * 0.72;
    // Glossy enough that the overhead rig lays a specular streak down one side
    // of it. That streak is what actually reads as roundness — emission alone
    // has no direction in it, so a purely self-lit rod always looks flat.
    rough = 0.16;
    albedo = vTint.rgb * 0.30;
  } else if (isRing) {
    // Torus: the cross-section is a circle, so the highlight travels around the
    // ring instead of sitting at one point on it.
    float radial = length(vLocal);
    float ringR = max(vHalf.x - vHalf.y, 0.001);
    float u = clamp((radial - ringR) / max(vHalf.y, 0.001), -1.0, 1.0);
    float z = sqrt(max(1e-3, 1.0 - u * u));
    vec2 outward = radial > 1e-4 ? vLocal / radial : vec2(0.0, 1.0);
    N = normalize(vec3(outward * u, z));
    N.y = -N.y;
    height = z * 0.85;
    rough = 0.10;
  } else if (isCapsule) {
    float rr = max(min(vHalf.x, vHalf.y), 0.001);
    float t = clamp(-d / rr, 0.0, 1.0);
    float z = sqrt(max(1e-3, 1.0 - (1.0 - t) * (1.0 - t)));
    float e = 0.6;
    float dx = shapeDistance(vLocal + vec2(e, 0.0)) - shapeDistance(vLocal - vec2(e, 0.0));
    float dy = shapeDistance(vLocal + vec2(0.0, e)) - shapeDistance(vLocal - vec2(0.0, e));
    vec2 grad = normalize(vec2(dx, dy) + vec2(1e-5));
    N = normalize(vec3(grad * (1.0 - t) * 1.2, z));
    N.y = -N.y;
    height = z * 0.9;
    rough = 0.13;
  } else if (isBox) {
    // Chamfered slab: flat top, fast roll into a visible wall. The bevel width
    // is a fraction of the short side so thin bricks stay readable.
    float bevel = min(2.6, vHalf.y * 0.55);
    float e = 0.6;
    float dx = shapeDistance(vLocal + vec2(e, 0.0)) - shapeDistance(vLocal - vec2(e, 0.0));
    float dy = shapeDistance(vLocal + vec2(0.0, e)) - shapeDistance(vLocal - vec2(0.0, e));
    vec2 grad = normalize(vec2(dx, dy) + vec2(1e-5));
    float roll = 1.0 - smoothstep(0.0, bevel, -d);
    N = normalize(vec3(grad * roll * 1.25, 0.42 + (1.0 - roll) * 1.35));
    N.y = -N.y;
    // Thin bricks are thin: tying height to the short side stops a 12px bar
    // from casting the shadow of a 15px block.
    height = mix(1.0, 0.30, roll) * clamp(vHalf.y / 8.0, 0.34, 1.0);
    rough = 0.20;
  } else if (isEmit) {
    // Light strips sit flush in their housing, so they carry almost no height:
    // they light the board without standing proud of it.
    N = vec3(0.0, 0.0, 1.0);
    height = 0.05;
    rough = 0.30;
  } else {
    // Cabochon: a sphere is too round for a top-down peg — the shoulder needs
    // to stay full so the crown reads flat and the rim rolls away hard.
    float R = vHalf.x;
    float r = clamp(length(vLocal) / R, 0.0, 1.0);
    // A bumper is a taller casting than a peg, so its crown is rounder.
    float P = isBall ? 2.0 : (isBumper ? 1.42 : 1.62);
    float rp = pow(r, P);
    float z = sqrt(max(1e-3, 1.0 - rp));
    vec2 dir = r > 1e-4 ? vLocal / (r * R) : vec2(0.0);
    N = normalize(vec3(dir * pow(r, P * 0.5) * (isBall ? 1.0 : 1.12), z));
    N.y = -N.y;
    height = z * (isBall ? 1.0 : 0.94);
    rough = isBall ? 0.07 : 0.105;

    // Coming up through the board. The board plane cuts the solid at height
    // 1 - vEmerge, so what shows is the cap above it: a small disc that widens
    // into the full dome, with the normals and the height it writes both taken
    // from the real surface. The shadow it throws grows out of that height,
    // so nothing about the emergence is faked with a scale or a fade.
    if (vEmerge < 0.999) {
      float cut = 1.0 - vEmerge;
      float above = z - cut;
      // The waterline is a hard edge on the surface, so antialias it against
      // its own screen-space gradient rather than the silhouette's.
      coverage *= clamp(above / max(fwidth(above), 1e-4), 0.0, 1.0);
      if (coverage < 0.004) discard;
      height = above * (isBall ? 1.0 : 0.94);
    }
  }

  // Micro-relief. Real surfaces are never perfectly smooth, and a little
  // normal jitter is what stops a shaded dome from looking like a gradient.
  float micro = hash21(floor(vWorld * 2.3)) - 0.5;
  float micro2 = hash21(floor(vWorld.yx * 2.7 + 31.0)) - 0.5;
  if (!isPortal) N = normalize(N + vec3(micro, micro2, 0.0) * (isBall ? 0.012 : 0.030));

  float metalBase = !isPortal && max(vMat > 0.5 && vMat < 1.5 ? 1.0 : 0.0, metalMix) > 0.5 ? 1.0 : 0.0;
  if (isPortal) {
    // No surface treatment of any kind — the aperture is not made of anything.
  } else if (metalBase > 0.5) {
    // Gloss is a clearcoat control for the plastic pegs. Running metal through
    // it drove roughness to ~0.03, which is a mirror — that is why these read
    // as glass rods rather than machined parts. Metal keeps its own roughness.
    float grain = fbm(vWorld * 0.42);
    float pitting = fbm(vWorld * 1.7 + 11.0);
    rough = clamp(0.30 + grain * 0.26 + micro * 0.07, 0.16, 0.72);
    // Oxide mottling: patches of duller, warmer surface over the base metal.
    float rust = smoothstep(0.52, 0.86, fbm(vWorld * 0.21 + 5.0));
    albedo = mix(albedo, vec3(0.24, 0.105, 0.052), rust * 0.72);
    albedo *= 0.82 + pitting * 0.36;
    rough = clamp(rough + rust * 0.24, 0.16, 0.86);
    N = normalize(N + vec3(micro, micro2, 0.0) * (0.06 + rust * 0.10));
  } else {
    rough = clamp((rough + micro * 0.05) / max(uGloss, 0.05), 0.03, 0.95);
  }

  if (isBumper) {
    // Chrome collar around a coloured core. Its width is in board pixels, not
    // in fractions of the radius: a bumper scaled up is a bigger casting with
    // the same hardware on it, and sizing the collar off the radius instead is
    // exactly what made a large one look like a small one zoomed in.
    float radialPx = length(vLocal);
    float rimPx = vHalf.x;
    float collarPx = clamp(rimPx * 0.34, 3.4, 6.5);
    float collar = smoothstep(rimPx - collarPx, rimPx - collarPx * 0.62, radialPx);
    // Brushed steel, not white plastic: a bright diffuse collar blows out under
    // the overhead rig and swallows the peg it is wrapped around.
    albedo = mix(albedo, vec3(0.46, 0.52, 0.57), collar);
    rough = mix(rough, 0.13, collar);
    metalMix = max(metalMix, collar);
    // The groove is a machined cut, so it stays the same width at any size.
    float grooveAt = rimPx - collarPx * 0.82;
    float groove = 1.0 - smoothstep(0.35, 1.5, abs(radialPx - grooveAt));
    height -= groove * 0.22;
    N = normalize(N + vec3(normalize(vLocal + 1e-5) * groove * 0.55 * sign(radialPx - grooveAt), 0.0));
  }

  float metal = isPortal ? 0.0 : max(vMat > 0.5 && vMat < 1.5 ? 1.0 : 0.0, metalMix);
  vec3 emission = isPortal ? max(emitOverride, vec3(0.0)) : vTint.rgb * vTint.a;

  // A struck magnet charges rather than flashing. Running it through the
  // generic hit path just multiplied its own steel-grey tint, which is why it
  // blew out to white and stopped reading as a magnet at all.
  if (vCharge > 0.001) {
    float rr = clamp(length(vLocal) / max(vHalf.x, 0.001), 0.0, 1.0);
    // The core is an orb, so it is hottest slightly off centre — up and to the
    // left, with the rest of the rig. Dead-centre reads as a flat disc.
    float coreR = clamp(length(vLocal - vec2(-0.20, -0.24) * vHalf.x) / max(vHalf.x, 0.001), 0.0, 1.0);
    float core = pow(1.0 - coreR, 2.4);
    // Deep blue at the edge of the plasma, white only at its very centre.
    vec3 coreColor = mix(vec3(0.10, 0.42, 1.0), vec3(1.0), pow(core, 2.2));
    // Warm containment ring around the rim, held inside the silhouette.
    float ring = smoothstep(0.58, 0.84, rr) * (1.0 - smoothstep(0.90, 1.0, rr));
    emission += (coreColor * core * 3.2 + vec3(1.0, 0.40, 0.06) * ring * 2.4)
      * vCharge * uHitBoost;
    // The steel darkens as it charges so the glow sits in it instead of on it.
    albedo = mix(albedo, vec3(0.05, 0.09, 0.20), vCharge * 0.72);
    rough = mix(rough, 0.30, vCharge * 0.6);
  }
  // A portal's vHit carries which face it opens to, not a strike flash, and its
  // brightness is already folded into the aperture's own radiance.
  if (!isPortal && vHit > 0.001) {
    // A struck peg becomes a light. Everything that follows from that — the
    // wash on the board, the neighbours picking up its colour, its own shadow
    // vanishing — is solved, not drawn.
    float core = isBox ? smoothstep(0.0, 3.0, -d) : pow(max(N.z, 0.0), 1.6);
    emission += vTint.rgb * vHit * (1.4 + core * 2.6) * uHitBoost;
    albedo = mix(albedo, min(albedo * 2.2 + 0.15, vec3(1.0)), vHit * 0.55);
  }

  // An invisible fixture still feeds the solve but leaves no mark of its own:
  // it writes emission (which the rays read) and a "hidden" flag, and its
  // zero-alpha albedo/normal writes leave the board underneath untouched.
  if (vHidden > 0.5) {
    oAlbedo = vec4(0.0);
    oNormal = vec4(0.0);
    oEmission = vec4(emission / uEmitScale, 1.0) * coverage;
    oMaterial = vec4(0.0, 0.0, 1.0, 1.0) * coverage;
    return;
  }

  // How far the object actually stands off the board. A shape's profile is
  // normalised, so without this every solid tops out at the same height and a
  // bumper three times the width of a peg is no taller than one.
  height = clamp(height * vRise, 0.0, 1.0);

  // Alpha carries coverage on every attachment, and colour is premultiplied by
  // it, so the blend below is a correct composite over the board.
  oAlbedo = vec4(albedo, 1.0) * coverage;
  oNormal = vec4(N.xy * 0.5 + 0.5, rough, 1.0) * coverage;
  oEmission = vec4(emission / uEmitScale, 1.0) * coverage;
  oMaterial = vec4(height, metal, 0.0, 1.0) * coverage;
}`;

// Ribbon geometry for curved brick runs.
const CURVE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCenter;
layout(location=1) in vec2 aNormal;
layout(location=2) in vec2 aData;   // side, halfWidth
layout(location=3) in vec4 aTint;
layout(location=4) in vec3 aExtra;  // hit, matId, emergence
out vec2 vWorld;
out vec2 vCurveN;
out float vEdge;
out vec4 vTint;
out float vHit;
flat out float vMat;
flat out float vEmerge;
uniform vec2 uCanvas;
void main() {
  float side = aData.x;
  float halfWidth = max(0.01, aData.y);
  vec2 world = aCenter + aNormal * side;
  vWorld = world;
  vCurveN = aNormal;
  vEdge = side / halfWidth;
  vTint = aTint;
  vHit = aExtra.x;
  vMat = aExtra.y;
  vEmerge = clamp(aExtra.z, 0.0, 1.0);
  vec2 clip = world / uCanvas * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const CURVE_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vWorld;
in vec2 vCurveN;
in float vEdge;
in vec4 vTint;
in float vHit;
flat in float vMat;
flat in float vEmerge;
layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oNormal;
layout(location=2) out vec4 oEmission;
layout(location=3) out vec4 oMaterial;
uniform float uEmitScale;
uniform float uHitBoost;
uniform float uGloss;

void main() {
  float e = clamp(vEdge, -1.0, 1.0);
  float aa = max(fwidth(vEdge), 0.02);
  float coverage = 1.0 - smoothstep(1.0 - aa, 1.0, abs(vEdge));
  if (coverage < 0.004) discard;

  // Same cabochon profile as a round peg. The old e^4 curve was far flatter
  // across the ribbon, so it presented a wide face-on surface to the overhead
  // rig and read much brighter than a dome of the same colour.
  float z = sqrt(max(1e-3, 1.0 - pow(abs(e), 1.62)));
  vec3 N = normalize(vec3(vCurveN * pow(abs(e), 0.81) * sign(e) * 1.12, z));
  N.y = -N.y;
  float micro = hash21(floor(vWorld * 2.3)) - 0.5;
  N = normalize(N + vec3(micro * 0.03, micro * 0.026, 0.0));

  vec3 albedo = vTint.rgb;
  vec3 emission = vTint.rgb * vTint.a;
  if (vHit > 0.001) {
    emission += vTint.rgb * vHit * (1.4 + z * 2.2) * uHitBoost;
    albedo = mix(albedo, min(albedo * 2.2 + 0.15, vec3(1.0)), vHit * 0.55);
  }
  float metal = vMat > 0.5 && vMat < 1.5 ? 1.0 : 0.0;

  // Roughness has to go through uGloss exactly like the dome path does. Without
  // it a gloss of 3 left ribbons at 0.19 while domes sat at 0.035, which is the
  // main reason horizontal pegs looked lit differently from round ones.
  float rough = clamp((0.105 + micro * 0.05) / max(uGloss, 0.05), 0.03, 0.95);

  // Coming up through the board, exactly as the round pegs do: the board plane
  // cuts the ribbon at height 1 - vEmerge and only the crest above it shows, so
  // a curved brick run surfaces along its length instead of fading in.
  float height = z * 0.94;
  if (vEmerge < 0.999) {
    float above = z - (1.0 - vEmerge);
    coverage *= clamp(above / max(fwidth(above), 1e-4), 0.0, 1.0);
    if (coverage < 0.004) discard;
    height = above * 0.94;
  }

  oAlbedo = vec4(albedo, 1.0) * coverage;
  oNormal = vec4(N.xy * 0.5 + 0.5, rough, 1.0) * coverage;
  oEmission = vec4(emission / uEmitScale, 1.0) * coverage;
  oMaterial = vec4(height, metal, 0.0, 1.0) * coverage;
}`;

// ── 2. Half-res scene: what rays actually march against ─────────────────────

const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uEmission;
uniform sampler2D uMaterial;
uniform sampler2D uBounce;      // previous frame's lit result
uniform vec2 uSourceTexel;
uniform float uBounceStrength;
uniform float uEmitScale;
void main() {
  vec3 emit = vec3(0.0);
  vec3 bounce = vec3(0.0);
  float height = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) - 0.5) * uSourceTexel;
      emit += texture(uEmission, vUv + o).rgb;
      bounce += texture(uBounce, vUv + o).rgb;
      // Max, not mean: a footprint that survives downsampling keeps its full
      // height, so thin geometry still casts.
      height = max(height, texture(uMaterial, vUv + o).r);
    }
  }
  // Second bounce. Objects re-emit a fraction of what reached them last frame,
  // which is what fills an enclosed ring of pegs instead of leaving it black.
  float solid = step(0.06, height);
  vec3 total = emit * 0.25 + bounce * 0.25 * uBounceStrength * solid / uEmitScale;
  outColor = vec4(total, height);
}`;

// ── 3. Jump-flooded distance to the nearest footprint boundary ──────────────

const SEED_FS = `#version 300 es
precision highp float;
#define ENCODE_SEEDS __ENCODE_SEEDS__
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform vec2 uTexel;
void main() {
  float c = texture(uScene, vUv).a;
  bool solid = c > 0.06;
  // Seed the boundary rather than the interior: the resulting field is valid
  // on both sides, so a ray crossing an object can still stride through it.
  bool boundary = false;
  for (int i = 0; i < 4; i++) {
    vec2 o = i == 0 ? vec2(1, 0) : (i == 1 ? vec2(-1, 0) : (i == 2 ? vec2(0, 1) : vec2(0, -1)));
    bool n = texture(uScene, vUv + o * uTexel).a > 0.06;
    if (n != solid) boundary = true;
  }
  // RGBA8 fallback targets cannot store the usual -1 invalid sentinel. Pack
  // valid UVs into 0.5..1 there and reserve zero for invalid; float targets
  // retain the original representation and precision.
  vec2 validSeed = ENCODE_SEEDS ? vUv * 0.5 + 0.5 : vUv;
  vec2 invalidSeed = ENCODE_SEEDS ? vec2(0.0) : vec2(-1.0);
  outColor = boundary ? vec4(validSeed, 0.0, 1.0) : vec4(invalidSeed, 0.0, 1.0);
}`;

const JFA_FS = `#version 300 es
precision highp float;
#define ENCODE_SEEDS __ENCODE_SEEDS__
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSeed;
uniform vec2 uTexel;
uniform float uStep;
uniform vec2 uCanvas;
uniform float uDistanceScale;
uniform float uOutputDistance;

vec2 unpackSeed(vec2 stored) {
  if (!ENCODE_SEEDS) return stored;
  return stored.x < 0.25 ? vec2(-1.0) : (stored - 0.5) * 2.0;
}

vec2 packSeed(vec2 seed) {
  if (!ENCODE_SEEDS) return seed;
  return seed.x < 0.0 ? vec2(0.0) : seed * 0.5 + 0.5;
}

void main() {
  vec2 best = vec2(-1.0);
  float bestDist = 1e9;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 sampleUv = vUv + vec2(float(x), float(y)) * uStep * uTexel;
      vec2 seed = unpackSeed(texture(uSeed, sampleUv).rg);
      if (seed.x < 0.0) continue;
      float dist = distance(seed, vUv);
      if (dist < bestDist) { bestDist = dist; best = seed; }
    }
  }
  if (uOutputDistance > 0.5) {
    // The final jump-flood pass has already found the nearest seed. Store its
    // scalar pixel distance once; every cascade ray can then consume one value
    // instead of rebuilding this length thousands of times per frame.
    float pixelDistance = best.x < 0.0
      ? uDistanceScale
      : length((best - vUv) * uCanvas);
    outColor = vec4(clamp(pixelDistance / uDistanceScale, 0.0, 1.0), 0.0, 0.0, 1.0);
  } else {
    outColor = vec4(packSeed(best), 0.0, 1.0);
  }
}`;

// Folds the board's moving hardware into the flooded field.
//
// The jump flood is O(log n) full-screen passes over the whole board, and it was
// being rerun every frame for the sake of a ball three pixels further down. The
// solids the game moves are few and are exactly the primitives the object shader
// already draws, so their distance is available in closed form. The flood then
// only has to cover the level's own geometry, which changes when a peg is knocked
// out and not otherwise.
//
// The field is an unsigned distance to the nearest boundary — valid inside a
// solid as well as outside, which is what lets a ray stride through one — so each
// profile contributes abs(signed distance). Taking a min can only shorten a ray's
// stride, never lengthen it, so an entry here can never cause a march to step
// over something: the merge is safe by construction even when it is redundant.
const SDF_MERGE_FS = `#version 300 es
precision highp float;
${COMMON}
#define MAX_DYNAMIC __MAX_DYNAMIC__
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uStatic;
uniform vec2 uCanvas;
uniform float uDistanceScale;
uniform int uSolidCount;
uniform vec4 uSolidA[MAX_DYNAMIC];   // x, y, halfW, halfH
uniform vec4 uSolidB[MAX_DYNAMIC];   // cos, sin, profile, corner radius

void main() {
  float best = texture(uStatic, vUv).r * uDistanceScale;
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uCanvas;
  for (int i = 0; i < MAX_DYNAMIC; i++) {
    if (i >= uSolidCount) break;
    vec4 a = uSolidA[i];
    vec4 b = uSolidB[i];
    // Back into the instance's local frame. The object vertex shader maps local
    // to world with mat2(c, s, -s, c); this is its transpose.
    vec2 q = p - a.xy;
    q = vec2(q.x * b.x + q.y * b.y, q.y * b.x - q.x * b.y);
    float d;
    if (b.z < 0.5) d = length(q) - a.z;
    else if (b.z < 1.5) d = abs(length(q) - (a.z - a.w)) - a.w;
    else d = sdRoundBox(q, a.zw, b.w);
    best = min(best, abs(d));
  }
  outColor = vec4(clamp(best / uDistanceScale, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// ── 4. Radiance cascades ────────────────────────────────────────────────────

const CASCADE_FS = `#version 300 es
precision highp float;
${COMMON}
out vec4 outColor;
uniform sampler2D uSdf;      // nearest boundary uv
uniform sampler2D uScene;    // rgb emission, a height
uniform sampler2D uUpper;    // cascade i+1
uniform vec2 uCanvas;
uniform vec2 uCascadeSize;
uniform float uBlock;        // 2^(i+1)
uniform float uSpacing;      // probe spacing, canvas px
uniform float uIntervalStart;
uniform float uIntervalEnd;
uniform float uIsTop;
uniform float uSteps;
uniform float uHeightScale;
uniform float uEmitScale;
uniform float uElevation;
uniform float uMinStep;
uniform float uDistanceScale;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;

vec3 skyRadiance(vec2 dir) {
  float up = clamp(-dir.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(uSkyBottom, uSkyTop, up * up);
}

vec4 marchRay(vec2 origin, vec2 dir, float t0, float t1) {
  float t = t0;
  int steps = int(uSteps);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec2 p = origin + dir * t;
    if (p.x < -8.0 || p.y < -8.0 || p.x > uCanvas.x + 8.0 || p.y > uCanvas.y + 8.0) {
      return vec4(skyRadiance(dir), 0.0);
    }
    vec2 uv = canvasToUv(p, uCanvas);
    float d = texture(uSdf, uv).r * uDistanceScale;
    vec4 scene = texture(uScene, uv);
    float surfaceH = scene.a * uHeightScale;
    // Emission is collected independently of height, so a fixture can light the
    // board while being flush with it — and invisible.
    vec3 emit = scene.rgb * uEmitScale;
    if (luma(emit) > 0.004) return vec4(emit, 0.0);
    // Solids only block while the ray is still below them.
    if (surfaceH > 0.4 && t * uElevation < surfaceH - 0.5) {
      return vec4(0.0, 0.0, 0.0, 0.0);
    }
    // The floor scales with the interval this cascade is responsible for. A
    // fixed 1.7px floor let the far cascades exhaust their step budget without
    // crossing their interval; those rays returned "unresolved", which the top
    // cascade turns into full sky while a neighbouring probe that did finish
    // returns black. That difference is what showed up as blotches.
    t += max(d, uMinStep);
    if (t > t1) break;
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 mergeUpper(vec2 probeIdx, float dirIndex) {
  float parentBlock = uBlock * 2.0;
  vec2 parentCounts = floor(uCascadeSize / parentBlock);
  // Bilinear across the four parent probes surrounding this probe's position.
  vec2 parentCoord = (probeIdx + 0.5) * 0.5 - 0.5;
  vec2 sampleCoord = clamp(parentCoord, vec2(0.0), parentCounts - 1.0);
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float childDir = dirIndex * 4.0 + float(k);
    vec2 childXY = vec2(mod(childDir, parentBlock), floor(childDir / parentBlock));
    // Directions occupy tiles and probes are contiguous inside each tile.
    // LINEAR filtering therefore performs the same four-corner interpolation
    // as the old inner loop in one fetch instead of four.
    vec2 uv = (childXY * parentCounts + sampleCoord + 0.5) / uCascadeSize;
    acc += texture(uUpper, uv);
  }
  return acc * 0.25;
}

void main() {
  vec2 texel = floor(gl_FragCoord.xy);
  vec2 probeCounts = floor(uCascadeSize / uBlock);
  vec2 dirXY = floor(texel / probeCounts);
  vec2 probeIdx = texel - dirXY * probeCounts;
  float dirCount = uBlock * uBlock;
  float dirIndex = dirXY.x + dirXY.y * uBlock;
  float angle = (dirIndex + 0.5) / dirCount * TAU;
  vec2 dir = vec2(cos(angle), sin(angle));

  vec2 origin = vec2((probeIdx.x + 0.5) * uSpacing,
                     uCanvas.y - (probeIdx.y + 0.5) * uSpacing);

  vec4 near = marchRay(origin, dir, uIntervalStart, uIntervalEnd);
  vec4 far = uIsTop > 0.5 ? vec4(skyRadiance(dir), 0.0) : mergeUpper(probeIdx, dirIndex);
  outColor = vec4(near.rgb + near.a * far.rgb, near.a * far.a);
}`;

// Probes sit on a 4px grid, so a light crossing between them makes the solved
// radiance jump. Blending against the previous frame's field removes that
// stepping; the blend is uniform because the board never moves, so there is
// nothing to reproject. A large per-texel jump (a peg lighting up) bypasses the
// history so flashes stay instant.
const CASCADE_BLEND_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform float uBlend;
uniform vec2 uCascadeSize;
uniform float uBlock;

// Average the same direction across neighbouring probes. Cascade 0 carries only
// four directions on a coarse grid, so a bright emitter lands very differently
// on adjacent probes and bilinear upsampling turns that into blobs. Smoothing
// in probe space fixes it spatially, which is what lets the temporal blend stay
// light instead of having to hide the artifact by smearing it over time.
vec4 probeSmoothed() {
  vec2 texelCoord = floor(gl_FragCoord.xy);
  vec2 probeCounts = floor(uCascadeSize / uBlock);
  vec2 dirXY = floor(texelCoord / probeCounts);
  vec2 probeIdx = texelCoord - dirXY * probeCounts;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
      vec2 p = clamp(probeIdx + vec2(float(x), float(y)), vec2(0.0), probeCounts - 1.0);
      vec2 uv = (dirXY * probeCounts + p + 0.5) / uCascadeSize;
      sum += texture(uCurrent, uv) * w;
      total += w;
    }
  }
  return sum / total;
}

void main() {
  vec4 current = probeSmoothed();
  vec4 history = texture(uHistory, vUv);
  float change = abs(luma(current.rgb) - luma(history.rgb));
  float responsive = smoothstep(0.05, 0.45, change);
  float alpha = mix(uBlend, 1.0, responsive);
  outColor = mix(history, current, clamp(alpha, 0.0, 1.0));
}`;

// ── 5. Deferred shading ─────────────────────────────────────────────────────

const SHADE_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uEmission;
uniform sampler2D uMaterial;
uniform sampler2D uCascade0;
uniform sampler2D uSdf;
uniform sampler2D uScene;
uniform sampler2D uBounce;   // last frame's lit result, for surface bounce
uniform vec2 uCanvas;
uniform vec2 uRender;
uniform vec2 uCascadeSize;
uniform float uSpacing;
uniform float uEmitScale;
uniform float uHeightScale;
uniform float uExposure;
uniform vec3 uDomeColor;
uniform float uDomeIntensity;
uniform vec2 uKeyDir;
uniform float uKeyElevation;
uniform float uSkyRef;
uniform float uSpecFloor;
uniform float uDistanceScale;

struct Field {
  vec3 irradiance;   // mean radiance over the probe's directions
  vec2 vector;       // dominant direction, length = how directional it is
  vec4 buckets[4];   // per-direction radiance, for reflections
};

Field sampleField(vec2 p) {
  vec2 pc = vec2(p.x / uSpacing, (uCanvas.y - p.y) / uSpacing) - 0.5;
  vec2 counts = floor(uCascadeSize / 2.0);
  vec2 sampleCoord = clamp(pc, vec2(0.0), counts - 1.0);

  vec3 radiance[4];
  for (int d = 0; d < 4; d++) {
    vec2 dirXY = vec2(float(d & 1), float((d >> 1) & 1));
    vec2 uv = (dirXY * counts + sampleCoord + 0.5) / uCascadeSize;
    radiance[d] = texture(uCascade0, uv).rgb;
  }

  Field field;
  field.irradiance = vec3(0.0);
  field.vector = vec2(0.0);
  float total = 0.0;
  for (int d = 0; d < 4; d++) {
    float angle = (float(d) + 0.5) / 4.0 * TAU;
    vec2 dir = vec2(cos(angle), sin(angle));
    float l = luma(radiance[d]);
    field.irradiance += radiance[d];
    field.vector += dir * l;
    total += l;
    field.buckets[d] = vec4(radiance[d], 0.0);
  }
  field.irradiance *= 0.25;
  field.vector /= max(total, 1e-4);
  return field;
}

// Radiance arriving from one direction, reconstructed from the four buckets.
vec3 fieldAlong(Field field, vec2 dir) {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int d = 0; d < 4; d++) {
    float angle = (float(d) + 0.5) / 4.0 * TAU;
    vec2 bdir = vec2(cos(angle), sin(angle));
    float w = pow(max(dot(bdir, dir), 0.0), 2.0) + 0.04;
    sum += field.buckets[d].rgb * w;
    wsum += w;
  }
  return sum / max(wsum, 1e-4);
}

// March the height field toward the key light. This is the cast shadow: its
// length comes from how tall the occluder is and how low the light sits, and it
// lands wherever the geometry actually puts it.
float keyShadow(vec2 p, float startHeight, vec3 K) {
  float shadow = 1.0;
  float s = 2.0;
  for (int i = 0; i < 12; i++) {
    vec2 sp = p + K.xy * s;
    vec4 scene = texture(uScene, canvasToUv(sp, uCanvas));
    float h = scene.a * uHeightScale;
    float rayH = startHeight + K.z * s;
    // The overhead rig is an area source, so the further the occluder the
    // softer its edge. A fixed threshold gives hard black slabs instead.
    float penumbra = 1.4 + s * 0.42;
    float blocked = smoothstep(-penumbra, penumbra * 2.1, rayH - h);
    // Something that is itself emitting does not cast a dark bar: a recessed
    // light strip is flush with its wall, and a peg stops shadowing while it
    // flashes.
    float emitting = clamp(luma(scene.rgb) * uEmitScale * 1.6, 0.0, 1.0);
    shadow = min(shadow, mix(blocked, 1.0, emitting));
    s += 2.4;
  }
  return shadow;
}

float ggx(vec3 N, vec3 H, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float nh = max(dot(N, H), 0.0);
  float den = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * den * den, 1e-4);
}
float smithG(float nv, float rough) {
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  return nv / max(nv * (1.0 - k) + k, 1e-4);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRender.y - gl_FragCoord.y) * (uCanvas / uRender);
  vec4 albedoTex = texture(uAlbedo, vUv);
  vec4 normalTex = texture(uNormal, vUv);
  vec4 materialTex = texture(uMaterial, vUv);
  vec3 emission = texture(uEmission, vUv).rgb * uEmitScale;

  vec3 albedo = albedoTex.rgb;
  float height = materialTex.r;
  // Fixtures marked hidden light the board but contribute no visible glow.
  // The mask is coverage-weighted, so it has to be thresholded rather than
  // multiplied — a partial edge would otherwise leave a bright outline.
  if (materialTex.b > 0.002) emission = vec3(0.0);
  vec2 nxy = normalTex.rg * 2.0 - 1.0;
  float rough = clamp(normalTex.b, 0.05, 1.0);
  vec3 N = normalize(vec3(nxy, sqrt(max(1e-3, 1.0 - dot(nxy, nxy)))));
  vec3 V = vec3(0.0, 0.0, 1.0);

  // Sample the light field slightly along the surface normal so a peg's crown
  // reads the field above its own footprint, not the shadow it is casting.
  Field field = sampleField(p + N.xy * height * uHeightScale * 0.55);

  float aniso = length(field.vector);
  // Grazing when the field is directional (a nearby emitter in the plane),
  // overhead when it is even (the cabinet's ambient).
  vec3 L = normalize(vec3(field.vector, mix(1.5, 0.34, aniso)));
  vec3 H = normalize(L + V);
  float nv = max(dot(N, V), 1e-3);
  float nl = max(dot(N, L), 0.0);

  bool metal = materialTex.g > 0.5;
  vec3 f0 = mix(vec3(0.045), albedo, metal ? 0.92 : 0.05);

  // Contact occlusion from the real distance field: how much of the immediate
  // neighbourhood is blocked, biased toward the incoming light.
  vec2 sdfUv = canvasToUv(p, uCanvas);
  float edgeDist = texture(uSdf, sdfUv).r * uDistanceScale;
  float sceneH = texture(uScene, sdfUv).a * uHeightScale;
  float contact = 1.0;
  if (height * uHeightScale < 1.5) {
    vec2 probe = canvasToUv(p - field.vector * 5.0, uCanvas);
    float nearH = texture(uScene, probe).a * uHeightScale;
    float occl = max(sceneH, nearH);
    contact = mix(1.0, smoothstep(0.0, 11.0, edgeDist), clamp(occl / uHeightScale, 0.0, 1.0) * 0.85);
  }

  // How much of the world this point can see, read straight off the solved
  // field: a peg boxed in by neighbours gets less of everything, including the
  // overhead rig below. This is the only "shadow" term and it is measured.
  float openness = clamp(luma(field.irradiance) / max(uSkyRef, 1e-4), 0.0, 1.0);
  openness = mix(0.30, 1.0, openness) * contact;

  // The cabinet's box light. In-plane rays cannot carry light from above the
  // board, so the overhead rig is an explicit hemisphere term — without it an
  // untouched peg is a silhouette instead of its own colour.
  vec3 keyDir = normalize(vec3(uKeyDir, uKeyElevation));
  float keyNl = max(dot(N, keyDir), 0.0);
  vec3 keyH = normalize(keyDir + V);
  // A finite overhead fixture, not an infinite sky: it falls off toward the
  // ends of the cabinet, which is where the reference gets its depth.
  vec2 domeUv = p / uCanvas;
  float domeFalloff = 1.0 - 0.42 * smoothstep(0.12, 0.98,
    length((domeUv - vec2(0.5, 0.44)) * vec2(1.0, 0.78)) * 1.6);
  vec3 dome = uDomeColor * uDomeIntensity * domeFalloff;
  float diffuseMask = metal ? 0.12 : 1.0;
  // Start the shadow ray just above this surface so a peg does not shade itself.
  float shadow = keyShadow(p, height * uHeightScale + 0.8, keyDir);
  // A shadow is the absence of the key, not the absence of all light: the rig
  // is broad enough that a shadowed surface still catches a good part of it.
  float keyLit = keyNl * mix(0.18, 1.0, shadow);

  vec3 domeDiffuse = albedo * diffuseMask * dome * (0.15 + 0.85 * keyLit) * openness;
  // A broad source: the crown gloss stays soft so the crisp, moving glints can
  // come from the field instead.
  float domeRough = clamp(rough + 0.20, 0.14, 1.0);
  vec3 domeF = f0 + (1.0 - f0) * pow(1.0 - max(dot(keyH, V), 0.0), 5.0);
  vec3 domeSpec = ggx(N, keyH, domeRough)
    * smithG(nv, domeRough) * smithG(max(keyNl, 1e-3), domeRough) * domeF
    / max(4.0 * nv * max(keyNl, 1e-3), 1e-3) * dome * keyLit * openness;

  // Metals live almost entirely off what they reflect, so give them the dome as
  // a broad mirror term or a machined brick reads as a hole in the board.
  if (metal) {
    float mirror = pow(max(N.z, 0.0), 2.4);
    domeSpec += f0 * dome * mirror * 0.55 * openness * mix(0.35, 1.0, shadow);
  }

  vec3 ambient = field.irradiance * contact;
  // The in-plane key is shadowed by the same march, so a peg's spill respects
  // the geometry between it and the surface it lands on.
  vec3 direct = field.irradiance * aniso * 2.4 * mix(0.35, 1.0, shadow);

  vec3 diffuse = albedo * diffuseMask
    * (ambient * (0.62 + 0.38 * N.z) + direct * nl);

  vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  // A reflection cannot be sharper than the field it reflects. Cascade 0 keeps
  // four directions, so its dominant vector is only known to about a quadrant;
  // driving a near-mirror GGX lobe with it means a tiny per-probe wobble in
  // that direction swings the lobe across its own width. On the open board,
  // where N and V both point straight up and the half-vector therefore sits
  // right on the normal — the peak of the lobe — that is a very large swing,
  // and it is what turns a smooth solved field into patches on the surface.
  // Flooring the roughness of the field-driven specular ties the lobe's width
  // to the field's angular resolution, which is what it should always have
  // been. uSpecFloor 0 keeps the old behaviour exactly.
  float fieldRough = max(rough, uSpecFloor);
  float D = ggx(N, H, fieldRough);
  float G = smithG(nv, fieldRough) * smithG(max(nl, 1e-3), fieldRough);
  vec3 spec = D * G * F / max(4.0 * nv * max(nl, 1e-3), 1e-3) * direct * nl;

  // Grazing reflection of the field itself. This is what makes a glassy peg
  // pick up the rail beside it instead of wearing a painted rim.
  vec3 R = reflect(-V, N);
  float fres = pow(1.0 - nv, 4.0);
  vec2 envDir = length(R.xy) > 1e-3 ? normalize(R.xy) : field.vector;
  vec3 env = fieldAlong(field, envDir) * (fres * (metal ? 1.5 : 0.85) + 0.03);
  env *= mix(1.0, 0.35, rough);

  // Thin-material transmission: light entering the dome and scattering out the
  // far side, which is most of what sells a translucent peg.
  float wrap = clamp(dot(N, -L) * 0.5 + 0.5, 0.0, 1.0);
  vec3 sss = albedo * field.irradiance * aniso * pow(wrap, 2.2)
    * (metal ? 0.0 : 1.15) * smoothstep(0.02, 0.35, height);

  // Surface bounce: light off the board immediately outside this point, read
  // back onto its rim. This is the bright lower crescent on a real peg — it
  // tracks whatever is actually lit nearby rather than sitting at a fixed spot.
  vec3 rimBounce = vec3(0.0);
  float rim = 1.0 - clamp(N.z, 0.0, 1.0);
  if (rim > 0.02 && height > 0.02) {
    vec2 outward = length(N.xy) > 1e-3 ? normalize(N.xy) : vec2(0.0, 1.0);
    vec3 nearby = texture(uBounce, canvasToUv(p + outward * 9.0, uCanvas)).rgb;
    rimBounce = albedo * nearby * rim * rim * 1.35;
  }

  vec3 color = domeDiffuse + domeSpec + diffuse + spec + env + sss + rimBounce + emission;
  outColor = vec4(color * uExposure, 1.0);
}`;

// ── 6. Bloom ────────────────────────────────────────────────────────────────

const BLOOM_PREFILTER_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture(uSource, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contribution = max(soft, br - uThreshold) / max(br, 1e-4);
  outColor = vec4(c * contribution, 1.0);
}`;

const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uTexel;
void main() {
  vec3 a = texture(uSource, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 b = texture(uSource, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 c = texture(uSource, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 d = texture(uSource, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 e = texture(uSource, vUv).rgb;
  outColor = vec4((a + b + c + d) * 0.125 + e * 0.5, 1.0);
}`;

const BLOOM_UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uTexel;
void main() {
  vec3 sum = vec3(0.0);
  sum += texture(uSource, vUv + vec2(-1.0, -1.0) * uTexel).rgb * 0.0625;
  sum += texture(uSource, vUv + vec2( 0.0, -1.0) * uTexel).rgb * 0.125;
  sum += texture(uSource, vUv + vec2( 1.0, -1.0) * uTexel).rgb * 0.0625;
  sum += texture(uSource, vUv + vec2(-1.0,  0.0) * uTexel).rgb * 0.125;
  sum += texture(uSource, vUv).rgb * 0.25;
  sum += texture(uSource, vUv + vec2( 1.0,  0.0) * uTexel).rgb * 0.125;
  sum += texture(uSource, vUv + vec2(-1.0,  1.0) * uTexel).rgb * 0.0625;
  sum += texture(uSource, vUv + vec2( 0.0,  1.0) * uTexel).rgb * 0.125;
  sum += texture(uSource, vUv + vec2( 1.0,  1.0) * uTexel).rgb * 0.0625;
  outColor = vec4(sum, 1.0);
}`;

// ── 7. Composite ────────────────────────────────────────────────────────────

const COMPOSITE_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform sampler2D uBloom3;
uniform vec2 uCanvas;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uSaturation;
// Shockwaves are applied here, at full resolution, instead of by a second
// renderer compositing a downscaled copy of the scene over the top.
#define MAX_WAVES 4
uniform int uWaveCount;
uniform vec4 uWaveA[MAX_WAVES];   // x, y, radius, band
uniform vec4 uWaveB[MAX_WAVES];   // amp, ringAlpha, ripple, weight
uniform vec3 uWaveC[MAX_WAVES];   // ring colour

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec3 ringLight = vec3(0.0);

  if (uWaveCount > 0) {
    vec2 pixel = vec2(vUv.x, 1.0 - vUv.y) * uCanvas;
    vec2 displacement = vec2(0.0);
    for (int i = 0; i < MAX_WAVES; i++) {
      if (i >= uWaveCount) break;
      vec4 a = uWaveA[i];
      vec4 b = uWaveB[i];
      vec2 delta = pixel - a.xy;
      float width = max(1.0, a.w);
      float dist = length(delta);
      float signedBand = (dist - a.z) / width;
      if (abs(signedBand) > 1.0) continue;
      float band = 1.0 - smoothstep(0.0, 1.0, abs(signedBand));
      band = band * band * (3.0 - 2.0 * band);
      if (band <= 0.0001) continue;
      vec2 dir = dist > 0.001 ? delta / dist : vec2(0.0, -1.0);
      float weight = max(0.05, b.w);
      displacement += dir * (b.x * band * cos(signedBand * 3.14159265 * b.z) * weight);
      float crest = 1.0 - smoothstep(0.0, 0.42, abs(signedBand));
      float shoulder = 1.0 - smoothstep(0.35, 1.0, abs(signedBand));
      ringLight += uWaveC[i] * b.y * weight * (crest * 0.24 + shoulder * 0.07);
    }
    // Displacement is in canvas pixels; convert to uv with the y flip.
    uv += vec2(displacement.x, -displacement.y) / uCanvas;
    uv = clamp(uv, vec2(0.0005), vec2(0.9995));
  }

  vec3 color = texture(uScene, uv).rgb;
  vec3 bloom = texture(uBloom1, uv).rgb * 0.5
             + texture(uBloom2, uv).rgb * 0.32
             + texture(uBloom3, uv).rgb * 0.18;
  color += bloom * uBloomStrength;
  color += ringLight;

  vec2 c = (vUv - 0.5) * vec2(1.0, 1.12);
  color *= 1.0 - smoothstep(0.30, 0.80, length(c)) * uVignette;

  color = aces(color);
  float l = luma(color);
  color = clamp(mix(vec3(l), color, uSaturation), 0.0, 1.0);
  color = pow(color, vec3(1.0 / 2.2));
  // Dither before the 8-bit write or the wide dark gradients will band.
  color += (hash21(vUv * uCanvas + 0.5) - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}`;

// Drivers compile and link on background threads, but asking for COMPILE_STATUS
// or LINK_STATUS blocks until that particular shader is finished. Querying right
// after each call therefore serialises all thirteen programs, and the wait shows
// up as a long boot screen because the first frame can't start until it's done.
// So issuing the work and reading the results are kept separate: every program is
// submitted first, then verified, which lets the driver run them in parallel.
function submitShader(gl, type, source, cache) {
  const cached = cache.get(source);
  if (cached) return cached;
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  cache.set(source, shader);
  return shader;
}

class Program {
  constructor(gl, vertexSource, fragmentSource, cache) {
    // The same fullscreen vertex shader backs ten of these; compiling it once
    // and sharing the object drops nine redundant compiles.
    const shaders = cache || new Map();
    const vs = submitShader(gl, gl.VERTEX_SHADER, vertexSource, shaders);
    const fs = submitShader(gl, gl.FRAGMENT_SHADER, fragmentSource, shaders);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    this.gl = gl;
    this.handle = program;
    this._stages = [vs, fs];
    this._locations = new Map();
  }

  /** Blocks on this program's status. Call only after every program in the
   *  batch has been submitted, so the stalls overlap instead of stacking. */
  verify(name) {
    const gl = this.gl;
    if (!gl.getProgramParameter(this.handle, gl.LINK_STATUS)) {
      // Link failure is usually a shader failure; report that instead, since
      // the link log is often empty when a stage never compiled.
      for (const stage of this._stages) {
        if (!gl.getShaderParameter(stage, gl.COMPILE_STATUS)) {
          throw new Error(`${name}: ${gl.getShaderInfoLog(stage) || 'shader compilation failed'}`);
        }
      }
      throw new Error(`${name}: ${gl.getProgramInfoLog(this.handle) || 'shader link failed'}`);
    }
    return this;
  }

  use() {
    this.gl.useProgram(this.handle);
    return this;
  }

  loc(name) {
    let location = this._locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.handle, name);
      this._locations.set(name, location);
    }
    return location;
  }

  f(name, value) { this.gl.uniform1f(this.loc(name), value); return this; }
  v2(name, x, y) { this.gl.uniform2f(this.loc(name), x, y); return this; }
  v3(name, x, y, z) { this.gl.uniform3f(this.loc(name), x, y, z); return this; }
  tex(name, unit, texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

function createTexture(gl, width, height, internalFormat, format, type, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Every target has one fixed-size mip level for its whole lifetime. Immutable
  // storage lets the driver allocate it once and skip the redefinition checks
  // texImage2D would otherwise carry into framebuffer validation.
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Round up so every cascade level divides the texture exactly. */
function roundUpTo(value, multiple) {
  return Math.ceil(value / multiple) * multiple;
}

function fract(value) {
  return value - Math.floor(value);
}

const PEG_COLOR_CACHE = new Map();

/** Authored peg colours arrive as CSS strings; the solve needs linear rgb. */
function parsePegColor(value) {
  if (typeof value !== 'string' || !value) return null;
  if (PEG_COLOR_CACHE.has(value)) return PEG_COLOR_CACHE.get(value);
  let rgb = null;
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    rgb = [0, 1, 2].map(i => parseInt(hex[i] + hex[i], 16) / 255);
  } else if (/^[0-9a-f]{6}$/i.test(hex)) {
    rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  } else {
    const parts = value.match(/[\d.]+/g);
    if (parts && parts.length >= 3) rgb = parts.slice(0, 3).map(v => Number(v) / 255);
  }
  const linear = rgb
    ? rgb.map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    : null;
  PEG_COLOR_CACHE.set(value, linear);
  return linear;
}

export class GpuPlayfieldRenderer {
  constructor(options = {}) {
    this.canvas = null;
    this.gl = null;
    this.ready = false;
    this.failed = false;
    this.width = 0;
    this.height = 0;
    this.ownsBackingStore = true;

    this.quality = options.quality || 'high';
    this.adaptiveQuality = options.adaptiveQuality !== false;
    this.forceLdr = options.forceLdr === true;
    this._gpuTimer = null;
    this._gpuTimingQuery = null;
    this._gpuTimingActive = false;
    this._gpuTimingFrame = 0;
    this._gpuSlowSamples = 0;
    this._gpuTimingCooldown = 0;
    this._lastGpuMs = null;
    this._cadenceEmaMs = 0;
    this._cadenceSamples = 0;
    // Kept as an option so the benchmark can A/B both storage layouts through
    // identical shaders and driver state. Production uses the compact path.
    this.compactTargets = options.compactTargets !== false;
    this.reuseDistanceField = options.reuseDistanceField !== false;
    // Declaring each render target's previous contents dead before overwriting
    // it. Free on a tiler, which then skips loading the tile; measurable on some
    // immediate-mode desktop drivers, which appear to treat it as a barrier.
    this.discardTargets = options.discardTargets === true;
    this._ratio = 1;
    this._renderWidth = 0;
    this._renderHeight = 0;

    // Scene geometry is assembled straight into the arrays that get uploaded.
    // Building it in plain JS arrays cost a per-element conversion on every
    // frame, because TypedArray.set over an untyped source cannot memcpy.
    this.instances = new Float32Array(INSTANCE_FLOATS * 256);
    this.curveVertices = new Float32Array(CURVE_FLOATS * 1536);
    this.instanceLength = 0;
    this.curveLength = 0;
    this._instanceCount = 0;
    this._curveCount = 0;
    this._instanceCapacity = 0;
    this._curveCapacity = 0;
    // The expensive jump-flood solve depends only on solid silhouettes and
    // height, not on light, colour, hit flashes, or portal flow. Keep an exact
    // (collision-free) snapshot of that geometry so emission-only frames can
    // reuse the existing distance field.
    this._sdfGeometry = new Float32Array(0);
    this._sdfGeometryScratch = new Float32Array(0);
    this._sdfGeometryLength = 0;
    this._sdfReady = false;
    this._sdfBuilds = 0;
    this._sdfReuses = 0;
    // Solids the game moves every frame (ball, bucket, flippers, launcher).
    // They are kept out of the jump flood and folded into the distance field
    // analytically instead — see _renderDistanceField.
    this._dynamicA = new Float32Array(MAX_DYNAMIC_SOLIDS * 4);
    this._dynamicB = new Float32Array(MAX_DYNAMIC_SOLIDS * 4);
    this._dynamicCount = 0;
    this._dynamicOverflow = false;
    this._staticInstanceLength = 0;
    // The moving set already folded into the merged field, so an idle board
    // does not redo even that one pass. Length -1 never matches a real frame.
    this._dynamicSnapshot = new Float32Array(MAX_DYNAMIC_SOLIDS * 8);
    this._dynamicSnapshotLength = -1;
    this._sdfMerged = false;
    // Radiance history is deliberately temporal, but a scene that becomes
    // static still needs a few final frames to converge. Without this tail the
    // frame-skipper freezes the first partially blended result and replaces it
    // only on its half-second heartbeat — perceived as a shadow that lingers
    // and then vanishes in one step.
    this._temporalSettleFrames = 0;

    this._programs = {};
    this._targets = null;
    // One framebuffer per render target, keyed by texture — see _bindTarget.
    this._fbos = new Map();
    this._attachOne = null;
    this._attachAll = null;
    this._flashes = new Map();
    // Per-portal animation clocks, keyed by peg id, and the frame counter used
    // to retire the ones whose pegs are gone.
    this._portalStates = new Map();
    this._buildTick = 0;
    // Level-intro emergence, supplied per frame by the caller.
    this._emergence = null;
    // Ray-march overrides for the cascade pass, null = the per-cascade
    // defaults. Only the lab sets these, to sweep them against an artifact.
    this.marchSteps = null;
    this.marchMinStep = null;
    this._lastTime = 0;
    this._scaledSkyTop = [0, 0, 0];
    this._scaledSkyBottom = [0, 0, 0];
    this._resolvedKeyDir = [0, 0];
    this._waveA = new Float32Array(16);
    this._waveB = new Float32Array(16);
    this._waveC = new Float32Array(12);
    this.config = createDefaultLighting();
  }

  /** Live-tunable lighting. Merges a partial over the current rig. */
  setLighting(partial) {
    if (!partial) return this.config;
    const next = { ...this.config, ...partial };
    if (partial.fixtures) next.fixtures = partial.fixtures.map(f => ({ ...f }));
    this.config = next;
    return this.config;
  }

  getLighting() {
    return { ...this.config, fixtures: this.config.fixtures.map(f => ({ ...f })) };
  }

  resetLighting() {
    this.config = createDefaultLighting();
    return this.config;
  }

  /** Switching quality changes the probe grid and cascade count, so the render
   *  targets have to be rebuilt at the next resize. */
  setQuality(quality) {
    this._applyQuality(QUALITY_ORDER.includes(quality) ? quality : 'high');
  }

  _applyQuality(quality) {
    if (quality === this.quality) return;
    this.quality = quality;
    if (this.gl && this._targets) {
      const { width, height } = this;
      this._releaseTargets();
      this.width = 0;
      this.height = 0;
      this.resize(width, height);
    }
  }

  /** Struck pegs decay their emitted light over several frames, so the caller
   *  has to keep redrawing while any flash is still fading. */
  pendingFlashCount() {
    return this._flashes.size;
  }

  /** Frames the caller must continue drawing after the last moving/emissive
   *  input disappears, so the radiance history reaches the static solution. */
  needsTemporalSettling() {
    return this._temporalSettleFrames > 0;
  }

  /** True when the scene holds something that animates on its own (portal
   *  sparks), so the caller must keep redrawing even while the game is idle. */
  hasAnimatedContent() {
    return this._animated === true;
  }

  isSupported(peg) {
    if (!peg) return false;
    return Object.prototype.hasOwnProperty.call(TYPE_CODES, normalizePegType(peg.type));
  }

  attach(host) {
    if (this.failed || typeof document === 'undefined' || !host) return false;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'gpu-playfield-layer';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.canvas.dataset.ownsBackingStore = '1';
      this.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        this.ready = false;
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this._targets = null;
        this._programs = {};
        this.ready = false;
        this._initialize();
      });
    }
    if (this.canvas.parentElement !== host) host.insertBefore(this.canvas, host.firstChild || null);
    if (!this.ready) this._initialize();
    return this.ready;
  }

  _initialize() {
    try {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl;
      this._gpuTimer = this.adaptiveQuality
        ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
        : null;
      this._gpuTimingQuery = null;
      this._gpuTimingActive = false;
      this._gpuTimingFrame = 0;
      this._gpuSlowSamples = 0;
      this._gpuTimingCooldown = 0;

      // Half-float targets keep radiance linear and unclamped. Without them the
      // pipeline still runs, with emission scaled into an 8-bit range.
      const floatColor = gl.getExtension('EXT_color_buffer_float')
        || gl.getExtension('EXT_color_buffer_half_float');
      this._hdr = !this.forceLdr && !!floatColor;
      this._colorInternal = this._hdr ? gl.RGBA16F : gl.RGBA8;
      this._colorType = this._hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      // Allocated once: drawBuffers and invalidateFramebuffer both take lists,
      // and rebuilding them per pass would allocate ~25 arrays a frame.
      this._attachOne = [gl.COLOR_ATTACHMENT0];
      this._attachAll = [
        gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1,
        gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3
      ];

      // Tells the driver it may compile and link off the main thread. Batching
      // the submissions below is what actually lets it, but several drivers only
      // take the parallel path when the extension has been asked for.
      gl.getExtension('KHR_parallel_shader_compile');

      // Submit every program before reading any status — see Program.verify.
      const shaderCache = new Map();
      const encodeSeeds = this._hdr ? 'false' : 'true';
      const seedFragment = SEED_FS.replace('__ENCODE_SEEDS__', encodeSeeds);
      const jfaFragment = JFA_FS.replace('__ENCODE_SEEDS__', encodeSeeds);
      const programs = {
        board: new Program(gl, FULLSCREEN_VS, BOARD_FS, shaderCache),
        object: new Program(gl, OBJECT_VS, OBJECT_FS, shaderCache),
        curve: new Program(gl, CURVE_VS, CURVE_FS, shaderCache),
        downsample: new Program(gl, FULLSCREEN_VS, DOWNSAMPLE_FS, shaderCache),
        seed: new Program(gl, FULLSCREEN_VS, seedFragment, shaderCache),
        jfa: new Program(gl, FULLSCREEN_VS, jfaFragment, shaderCache),
        sdfMerge: new Program(gl, FULLSCREEN_VS,
          SDF_MERGE_FS.replace('__MAX_DYNAMIC__', String(MAX_DYNAMIC_SOLIDS)), shaderCache),
        cascade: new Program(gl, FULLSCREEN_VS, CASCADE_FS, shaderCache),
        cascadeBlend: new Program(gl, FULLSCREEN_VS, CASCADE_BLEND_FS, shaderCache),
        shade: new Program(gl, FULLSCREEN_VS, SHADE_FS, shaderCache),
        prefilter: new Program(gl, FULLSCREEN_VS, BLOOM_PREFILTER_FS, shaderCache),
        down: new Program(gl, FULLSCREEN_VS, BLOOM_DOWN_FS, shaderCache),
        up: new Program(gl, FULLSCREEN_VS, BLOOM_UP_FS, shaderCache),
        composite: new Program(gl, FULLSCREEN_VS, COMPOSITE_FS, shaderCache)
      };
      for (const [name, program] of Object.entries(programs)) program.verify(name);
      for (const shader of shaderCache.values()) gl.deleteShader(shader);
      this._programs = programs;

      this._emptyVao = gl.createVertexArray();

      this._objectVao = gl.createVertexArray();
      gl.bindVertexArray(this._objectVao);
      this._quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this._instanceBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
      const stride = INSTANCE_FLOATS * 4;
      const instanceAttribs = [[1, 2, 0], [2, 2, 8], [3, 4, 16], [4, 4, 32], [5, 4, 48]];
      for (const [index, size, offset] of instanceAttribs) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(index, 1);
      }

      this._curveVao = gl.createVertexArray();
      gl.bindVertexArray(this._curveVao);
      this._curveBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._curveBuffer);
      const curveStride = CURVE_FLOATS * 4;
      const curveAttribs = [[0, 2, 0], [1, 2, 8], [2, 2, 16], [3, 4, 24], [4, 3, 40]];
      for (const [index, size, offset] of curveAttribs) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, size, gl.FLOAT, false, curveStride, offset);
      }
      gl.bindVertexArray(null);

      this.ready = true;
    } catch (error) {
      console.warn('[gpu-playfield] falling back to Canvas2D:', error);
      this.failed = true;
      this.ready = false;
    }
  }

  // minRatio supersamples even on a 1x display, because the logical playfield is
  // small and usually scaled up. maxRatio caps it so a 3x phone on the weakest
  // preset does not quietly allocate a 3x render target.
  _qualitySettings() {
    if (this.quality === 'low') return { spacing: 8, cascades: 4, sdfDivisor: 4, minRatio: 1, maxRatio: 1 };
    if (this.quality === 'medium') return { spacing: 6, cascades: 5, sdfDivisor: 2, minRatio: 1.25, maxRatio: 1.5 };
    return { spacing: 4, cascades: 5, sdfDivisor: 2, minRatio: 1.5, maxRatio: 2 };
  }

  _lowerQuality() {
    const index = QUALITY_ORDER.indexOf(this.quality);
    if (index <= 0) return false;
    this._applyQuality(QUALITY_ORDER[index - 1]);
    this._gpuSlowSamples = 0;
    this._gpuTimingCooldown = 2;
    this._cadenceEmaMs = 0;
    this._cadenceSamples = 0;
    return true;
  }

  _observeGpuTime(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 100) return;
    this._lastGpuMs = milliseconds;
    if (this._gpuTimingCooldown > 0) {
      this._gpuTimingCooldown--;
      return;
    }
    const threshold = this.quality === 'high' ? 10.5 : (this.quality === 'medium' ? 13.5 : Infinity);
    this._gpuSlowSamples = milliseconds > threshold
      ? this._gpuSlowSamples + 1
      : Math.max(0, this._gpuSlowSamples - 1);
    if (this._gpuSlowSamples >= 2) this._lowerQuality();
  }

  _pollGpuTimer() {
    const gl = this.gl;
    const timer = this._gpuTimer;
    const query = this._gpuTimingQuery;
    if (!gl || !timer || !query) return;
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
    gl.deleteQuery(query);
    this._gpuTimingQuery = null;
    if (!disjoint) this._observeGpuTime(nanoseconds / 1e6);
  }

  _beginGpuTimer() {
    const gl = this.gl;
    const timer = this._gpuTimer;
    if (!gl || !timer || this._gpuTimingQuery || this._gpuTimingActive) return;
    if (++this._gpuTimingFrame % 30 !== 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const query = gl.createQuery();
    if (!query) return;
    this._gpuTimingQuery = query;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    this._gpuTimingActive = true;
  }

  _endGpuTimer() {
    if (!this._gpuTimingActive || !this.gl || !this._gpuTimer) return;
    this.gl.endQuery(this._gpuTimer.TIME_ELAPSED_EXT);
    this._gpuTimingActive = false;
  }

  // Safari does not currently expose timer queries consistently. In that case
  // use sustained delivered cadence, never a device-name guess, as the fallback
  // signal. It is deliberately slower to react than the direct GPU timer.
  _observeFrameCadence(frameDeltaSeconds) {
    if (this._gpuTimer || this.quality === 'low') return;
    const milliseconds = Number(frameDeltaSeconds) * 1000;
    if (!Number.isFinite(milliseconds) || milliseconds < 8 || milliseconds > 80) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this._cadenceEmaMs = this._cadenceSamples === 0
      ? milliseconds
      : this._cadenceEmaMs * 0.94 + milliseconds * 0.06;
    this._cadenceSamples++;
    if (this._cadenceSamples >= 90 && this._cadenceEmaMs > 20.0) this._lowerQuality();
  }

  resize(width, height) {
    if (!this.canvas || !this.gl) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const settings = this._qualitySettings();
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const ratio = Math.min(settings.maxRatio, Math.max(settings.minRatio, dpr));
    if (this.width === w && this.height === h && this._ratio === ratio && this._targets) return;

    this.width = w;
    this.height = h;
    this._ratio = ratio;
    this._renderWidth = Math.max(1, Math.round(w * ratio));
    this._renderHeight = Math.max(1, Math.round(h * ratio));
    if (this.canvas.width !== this._renderWidth) this.canvas.width = this._renderWidth;
    if (this.canvas.height !== this._renderHeight) this.canvas.height = this._renderHeight;
    this._allocate(settings);
  }

  _allocate(settings) {
    const gl = this.gl;
    this._releaseTargets();

    const rw = this._renderWidth;
    const rh = this._renderHeight;
    const cascadeCount = settings.cascades;
    const spacing = settings.spacing;

    // Every cascade halves the probe grid, so the level-0 probe count has to be
    // divisible by 2^(cascades-1) for the shared texture to divide exactly.
    const align = 1 << (cascadeCount - 1);
    const probesX = roundUpTo(Math.ceil(this.width / spacing), align);
    const probesY = roundUpTo(Math.ceil(this.height / spacing), align);
    const cascadeWidth = probesX * 2;
    const cascadeHeight = probesY * 2;

    const sdfWidth = Math.max(8, Math.ceil(rw / settings.sdfDivisor));
    const sdfHeight = Math.max(8, Math.ceil(rh / settings.sdfDivisor));

    // Jump-flood seeds contain two coordinates, so RG16F carries the exact same
    // half-float values as RGBA16F without reading or writing two dead channels.
    // Keep every visible G-buffer attachment at the original precision.
    const color = (w, h) => createTexture(
      gl, w, h, this._colorInternal, gl.RGBA, this._colorType, gl.LINEAR
    );
    // The jump-flood field stores coordinates, not colour; nearest sampling
    // keeps seed positions exact through the flood.
    const coords = (w, h) => this._hdr && this.compactTargets
      ? createTexture(gl, w, h, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.NEAREST)
      : createTexture(gl, w, h, this._colorInternal, gl.RGBA, this._colorType, gl.NEAREST);
    const distance = (w, h) => createTexture(
      gl, w, h,
      this._hdr ? gl.R16F : gl.R8, gl.RED,
      this._hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, gl.NEAREST
    );

    const targets = {
      cascadeCount,
      spacing,
      cascadeWidth,
      cascadeHeight,
      sdfWidth,
      sdfHeight,
      albedo: color(rw, rh),
      normal: color(rw, rh),
      emission: color(rw, rh),
      material: color(rw, rh),
      scene: color(sdfWidth, sdfHeight),
      seedA: coords(sdfWidth, sdfHeight),
      seedB: coords(sdfWidth, sdfHeight),
      // The flooded field for geometry that only changes when the level does,
      // and the merged field the rest of the pipeline reads.
      sdfStatic: distance(sdfWidth, sdfHeight),
      sdfDistance: distance(sdfWidth, sdfHeight),
      lit: color(rw, rh),
      litPrev: color(rw, rh),
      fieldA: color(cascadeWidth, cascadeHeight),
      fieldB: color(cascadeWidth, cascadeHeight),
      fieldPrimed: false,
      cascades: [],
      bloom: [],
      gbufferFbo: gl.createFramebuffer()
    };

    for (let i = 0; i < cascadeCount; i++) targets.cascades.push(color(cascadeWidth, cascadeHeight));
    let bw = Math.max(1, rw >> 1);
    let bh = Math.max(1, rh >> 1);
    for (let i = 0; i < 4; i++) {
      targets.bloom.push({ texture: color(bw, bh), width: bw, height: bh });
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.gbufferFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targets.albedo, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, targets.normal, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, targets.emission, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, targets.material, 0);
    gl.drawBuffers(this._attachAll);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw new Error('G-buffer framebuffer incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._targets = targets;

    // Texture storage is intentionally uninitialised by WebGL, and half-float
    // garbage can decode to NaN. Two passes read a target before anything has
    // written it this frame: the bounce reads last frame's lighting, and the
    // composite reads bloom levels that are skipped when bloom is off — and
    // NaN * 0 is NaN, not nothing. Seed them once here instead.
    const seeded = [
      { texture: targets.litPrev, width: rw, height: rh },
      { texture: targets.lit, width: rw, height: rh },
      targets.bloom[1], targets.bloom[2], targets.bloom[3]
    ];
    for (const level of seeded) {
      this._bindTarget(level.texture, level.width, level.height);
      gl.clearBufferfv(gl.COLOR, 0, ZERO_CLEAR);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._sdfReady = false;
  }

  _releaseTargets() {
    const gl = this.gl;
    const t = this._targets;
    if (!gl || !t) return;
    const owned = ['albedo', 'normal', 'emission', 'material', 'scene',
      'seedA', 'seedB', 'sdfStatic', 'sdfDistance', 'lit', 'litPrev', 'fieldA', 'fieldB'];
    for (const key of owned) {
      if (t[key]) gl.deleteTexture(t[key]);
    }
    for (const texture of t.cascades) gl.deleteTexture(texture);
    for (const level of t.bloom) gl.deleteTexture(level.texture);
    for (const fbo of this._fbos.values()) gl.deleteFramebuffer(fbo);
    this._fbos.clear();
    if (t.gbufferFbo) gl.deleteFramebuffer(t.gbufferFbo);
    this._targets = null;
    this._sdfReady = false;
    this._sdfMerged = false;
  }

  /** Binds a single-attachment target for a pass that overwrites all of it.
   *
   *  One framebuffer per texture rather than one shared framebuffer whose
   *  attachment is swapped: re-attaching forces the driver to re-validate the
   *  framebuffer on each of the ~25 passes in a frame, and some mobile drivers
   *  make that expensive.
   *
   *  The invalidate is the part that matters on a tiler. Every pass that comes
   *  through here writes every texel of its target, so loading the previous
   *  contents into tile memory first is pure wasted bandwidth — several
   *  megabytes a frame across the pass chain. Saying so up front lets the
   *  driver skip the load. It cannot change what is rendered, because nothing
   *  reads what was there. */
  _bindTarget(texture, width, height) {
    const gl = this.gl;
    let fbo = this._fbos.get(texture);
    if (fbo === undefined) {
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.drawBuffers(this._attachOne);
      this._fbos.set(texture, fbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    }
    gl.viewport(0, 0, width, height);
    if (this.discardTargets) gl.invalidateFramebuffer(gl.FRAMEBUFFER, this._attachOne);
  }

  _blit() {
    const gl = this.gl;
    gl.bindVertexArray(this._emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ── scene assembly ────────────────────────────────────────────────────────

  /** `extra` is [heightScale, emergence, energy, spare]:
   *  - heightScale multiplies how far the object stands off the board, so a
   *    big bumper is genuinely taller instead of being a zoomed small one.
   *  - emergence is 0..1 for a peg rising out of the board; below 1 the shape
   *    is cut by the board plane, so what you see is the cap of a solid coming
   *    up through it (and its shadow grows with it).
   *  - energy drives self-animated shapes (a portal's flow rate). */
  _pushInstance(x, y, halfW, halfH, angle, shape, hit, mat, color, emissive, extra) {
    let data = this.instances;
    const at = this.instanceLength;
    if (at + INSTANCE_FLOATS > data.length) {
      data = new Float32Array(data.length * 2);
      data.set(this.instances);
      this.instances = data;
    }
    data[at] = x; data[at + 1] = y; data[at + 2] = halfW; data[at + 3] = halfH;
    data[at + 4] = angle; data[at + 5] = shape; data[at + 6] = hit; data[at + 7] = mat;
    data[at + 8] = color[0]; data[at + 9] = color[1]; data[at + 10] = color[2];
    data[at + 11] = emissive;
    data[at + 12] = extra ? extra[0] : 1;
    data[at + 13] = extra ? extra[1] : 1;
    data[at + 14] = extra ? extra[2] : 0;
    data[at + 15] = extra ? extra[3] : 0;
    this.instanceLength = at + INSTANCE_FLOATS;
  }

  /** Records one solid the game moves every frame, so the distance field can
   *  account for it without re-flooding. Returns false once the budget is full,
   *  which puts the caller's geometry back under the jump flood. */
  _pushDynamicSolid(x, y, halfW, halfH, angle, kind, corner) {
    if (this._dynamicCount >= MAX_DYNAMIC_SOLIDS) {
      this._dynamicOverflow = true;
      return false;
    }
    const at = this._dynamicCount * 4;
    const a = this._dynamicA;
    const b = this._dynamicB;
    a[at] = x; a[at + 1] = y; a[at + 2] = halfW; a[at + 3] = halfH;
    b[at] = Math.cos(angle); b[at + 1] = Math.sin(angle); b[at + 2] = kind; b[at + 3] = corner;
    this._dynamicCount++;
    return true;
  }

  _pushCurve(peg, hit, color, mat, cameraY, offsetX, offsetY) {
    const slices = peg.curveSlices;
    const halfWidth = getEffectiveBrickSize(peg).height * 0.54;
    // Most bricks in a real level are curved runs, so this path has to rise
    // during the level intro too — otherwise the round pegs build from the
    // board and the long bars just appear.
    const emerge = this._emergenceFor(peg);
    if (emerge <= 0.001) return;
    const add = (slice, side, fallbackNx, fallbackNy) => {
      const nx = Number.isFinite(slice.nx) ? slice.nx : fallbackNx;
      const ny = Number.isFinite(slice.ny) ? slice.ny : fallbackNy;
      let data = this.curveVertices;
      const at = this.curveLength;
      if (at + CURVE_FLOATS > data.length) {
        data = new Float32Array(data.length * 2);
        data.set(this.curveVertices);
        this.curveVertices = data;
      }
      // Unit normal plus a signed offset: the vertex shader multiplies them.
      data[at] = slice.x + offsetX;
      data[at + 1] = slice.y + offsetY - cameraY;
      data[at + 2] = nx; data[at + 3] = ny;
      data[at + 4] = side; data[at + 5] = halfWidth;
      data[at + 6] = color[0]; data[at + 7] = color[1]; data[at + 8] = color[2];
      data[at + 9] = 0;
      data[at + 10] = hit; data[at + 11] = mat; data[at + 12] = emerge;
      this.curveLength = at + CURVE_FLOATS;
    };
    for (let i = 1; i < slices.length; i++) {
      const a = slices[i - 1];
      const b = slices[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.1) continue;
      const nx = -dy / length;
      const ny = dx / length;
      add(a, halfWidth, nx, ny);
      add(a, -halfWidth, nx, ny);
      add(b, halfWidth, nx, ny);
      add(b, halfWidth, nx, ny);
      add(a, -halfWidth, nx, ny);
      add(b, -halfWidth, nx, ny);
    }
  }

  _appendPeg(peg, hit, cameraY, offsetX = 0, offsetY = 0) {
    const typeCode = TYPE_CODES[normalizePegType(peg.type)];
    // An authored per-peg colour wins over the type palette.
    const color = parsePegColor(peg.color) || PALETTE[typeCode] || PALETTE[1];
    const mat = METAL_TYPES.has(typeCode) ? MAT_METAL : MAT_PLASTIC;

    if (peg.shape === 'brick' && Array.isArray(peg.curveSlices) && peg.curveSlices.length >= 2) {
      this._pushCurve(peg, hit, color, mat, cameraY, offsetX, offsetY);
      return;
    }

    const px = (Number(peg.x) || 0) + offsetX;
    const py = (Number(peg.y) || 0) + offsetY - cameraY;

    // A portal is a rod of contained energy standing off the board — a thick
    // stylised line, lit along its whole length, that lights the board back.
    if (isPortalType(peg.type)) {
      this._animated = true;
      const halfLen = PHYSICS_CONFIG.pegRadius * getPortalScale(peg);
      const halfThick = Math.max(3.4, PHYSICS_CONFIG.pegRadius * 0.44);
      const angle = Number(peg.angle) || 0;
      const seedPhase = (Number(peg.x) || 0) * 0.021 + (Number(peg.y) || 0) * 0.013;
      // Energy is a smoothed version of the game's pulse, so a ball going
      // through ramps the whole effect up and lets it settle back rather than
      // snapping. `_portalClock` integrates it, which is what keeps the motes
      // from jumping when the rate changes.
      const state = this._portalState(peg);
      const energy = state.energy;
      // A rod cannot be cut by the board plane the way a dome can, so during
      // the level intro it thickens and brightens up out of it instead.
      const emerge = this._emergenceFor(peg);
      if (emerge <= 0.001) return;
      // Breathing. A light that sits at a constant level stops being looked at;
      // a slow swell is what makes the eye keep coming back to it. Two primes
      // beat against each other so it never lands on an obvious loop.
      const time = this._time || 0;
      const breath = 0.5
        + 0.34 * Math.sin(time * 1.7 + seedPhase)
        + 0.16 * Math.sin(time * 2.9 + seedPhase * 1.7);
      // Bright at rest. These are lights in the scene, and the level has to
      // read by them when nothing has been struck yet.
      const glow = (1.45 + breath * 0.55 + energy * 1.5 + (hit ? 0.7 : 0)) * emerge;

      // A one-way portal only accepts from one face. Which one is passed to the
      // rod itself, where it makes that side burn harder — the direction is
      // read off the portal, not off a marker beside it.
      const blocked = peg.portalOneWayFlip ? -1 : 1;
      const open = peg.portalOneWay === false ? 0 : -blocked;

      // No halo geometry. The G-buffer composites, it does not add, so a large
      // faint emitter is just a large opaque plate — the portal's pool of light
      // has to come from the solve spreading its emission, which it does.
      this._pushInstance(px, py, halfLen, halfThick * (0.3 + emerge * 0.7), angle,
        SHAPE_PORTAL, open, MAT_EMISSIVE, color, glow, [emerge, 1, energy, 0]);

      // Motes shed off the rod. At rest they barely drift; when something goes
      // through, the clock and the reach both open up for as long as the pulse
      // lasts, so the burst is an acceleration rather than a swarm appearing.
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const nx = -sin;
      const ny = cos;
      const clock = state.clock;
      const seed = px * 0.137 + py * 0.071;
      const sides = open === 0 ? [-1, 1] : [open];
      // At rest they only just clear the rod; a pulse throws them much further.
      const reach = 9.0 + energy * 24.0;
      const rand = (k, salt) => fract(Math.sin(seed + k * 12.9898 + salt) * 43758.5453);
      for (const side of sides) {
        // Thrown clear of the rod. These say the portal is live.
        for (let i = 0; i < 10; i++) {
          const k = i + (side > 0 ? 0 : 53);
          const r1 = rand(k, 0);
          const r2 = rand(k, 1.7);
          const r3 = rand(k, 4.1);
          const phase = fract(clock * (0.8 + r2 * 0.4) + r1);
          // Away fast, then coasting, then gone.
          const travel = Math.sqrt(phase);
          const fade = (1 - phase) * (1 - phase);
          if (fade < 0.04) continue;
          const along = (r1 * 2 - 1) * halfLen * 0.88;
          const curl = (r3 - 0.5) * travel * travel * halfLen * 0.55;
          // Launched from the rod's surface, not its centreline, so they never
          // sit on top of it looking like beads threaded along it.
          const out = halfThick * 1.15 + travel * reach;
          // Big enough to survive the pixel grid — sub-pixel motes strobe as
          // they move, which is what made the old ones look jittery — but small
          // enough to read as sparks rather than blobs.
          const size = 1.15 + r2 * 0.8;
          this._pushInstance(
            px + cos * (along + curl) + nx * side * out,
            py + sin * (along + curl) + ny * side * out,
            size, size, 0,
            SHAPE_EMITTER, 0, MAT_EMISSIVE, color,
            (1.5 + energy * 3.6) * fade * emerge
          );
        }

        // Drawn in. Motes fall toward the rod out of the surrounding air and
        // are swallowed at its surface — the thing that makes a portal read as
        // somewhere to aim rather than as an obstacle that happens to glow.
        // Only on the open face, so a one-way portal invites from one side.
        for (let i = 0; i < 7; i++) {
          const k = i + (side > 0 ? 100 : 151);
          const r1 = rand(k, 2.3);
          const r2 = rand(k, 5.9);
          const r3 = rand(k, 8.4);
          // Runs backwards, and eases into the rod rather than arriving at a
          // constant rate, so the last stretch looks like capture.
          const phase = 1 - fract(clock * (0.55 + r2 * 0.3) + r1);
          const approach = phase * phase;
          // Brightest as it lands, dark where it comes from.
          const fade = (1 - phase) * (1 - phase * 0.4);
          if (fade < 0.04) continue;
          const along = (r1 * 2 - 1) * halfLen * 1.05;
          // Swept sideways on the way in, so the paths curve into the rod
          // instead of dropping onto it straight down.
          const swirl = (r3 - 0.5) * approach * halfLen * 1.5;
          const out = halfThick * 1.05 + approach * (16.0 + r2 * 14.0);
          const size = 1.0 + r2 * 0.7;
          this._pushInstance(
            px + cos * (along + swirl) + nx * side * out,
            py + sin * (along + swirl) + ny * side * out,
            size, size, 0,
            SHAPE_EMITTER, 0, MAT_EMISSIVE, color,
            (1.25 + energy * 2.2) * fade * emerge
          );
        }
      }
      return;
    }

    // A magnet is a polished steel ball. Nothing else — a lit gap across the
    // middle just cuts it in half and kills the metal read at this size.
    if (normalizePegType(peg.type) === 'bombMagnet') {
      // The flash goes in as `charge`, not as `hit`: a magnet lights up from
      // the inside rather than flaring its own surface colour.
      this._pushInstance(px, py, PHYSICS_CONFIG.pegRadius, PHYSICS_CONFIG.pegRadius, 0,
        SHAPE_BALL, 0, MAT_METAL, [0.80, 0.84, 0.90], 0,
        [1, this._emergenceFor(peg), 0, hit]);
      return;
    }

    if (peg.shape === 'brick') {
      const size = getEffectiveBrickSize(peg);
      // A slab has a flat top, so the board plane cutting it would pop the
      // whole face into view at once. It rises as a slab instead: the footprint
      // opens out and the height comes up with it.
      const emerge = this._emergenceFor(peg);
      const grow = 0.22 + emerge * 0.78;
      if (emerge <= 0.001) return;
      this._pushInstance(px, py, size.width * 0.5 * grow, size.height * 0.5 * grow,
        Number(peg.angle) || 0, SHAPE_BOX, hit, mat, color, 0, [emerge, 1, 0, 0]);
      return;
    }

    const isBumper = peg.type === 'bumper';
    // Authored colour still wins, as it does for every other peg type.
    const coreColor = isBumper && !parsePegColor(peg.color) ? bumperCoreColor(peg) : color;
    // The hit pulse used to widen the bumper by 30%, which scaled its collar,
    // its groove and its highlight along with it — a zoom, not a hit. Most of
    // the pulse now goes into height instead, so it punches up off the board
    // and its hardware stays the size it was.
    const pulse = isBumper ? Math.max(0, (Number(peg._bumperHitScale) || 1) - 1) : 0;
    const scale = isBumper ? (Number(peg.bumperScale) || 1) * (1 + pulse * 0.34) : 1;
    // Match the physics radius exactly. The old 1.24 inflation made every peg
    // read a quarter larger than its hitbox, which is why dense layouts looked
    // like the pegs were stuck together.
    const radius = PHYSICS_CONFIG.pegRadius * scale;
    const shape = isBumper ? SHAPE_BUMPER : SHAPE_DOME;
    // A bumper is a casting that stands off the board, and a bigger one stands
    // higher. Square-rooted so a wide bumper gets genuinely taller without
    // turning into a ball. Pegs keep the board's single reference height.
    const rise = isBumper
      ? Math.min(2.1, 1.30 * Math.sqrt(scale)) * (1 + pulse * 0.85)
      : 1;
    this._pushInstance(px, py, radius, radius, 0, shape, hit, mat, coreColor, 0,
      [rise, this._emergenceFor(peg), 0, 0]);
  }

  /** Portals carry their own animation, so each one keeps a clock that the
   *  pulse accelerates. Integrating the rate (rather than reading the pulse
   *  directly into a phase) is what lets the motes speed up and slow down
   *  smoothly instead of jumping whenever the rate changes. */
  _portalState(peg) {
    let state = this._portalStates.get(peg.id);
    if (!state) {
      state = { clock: fract(Math.abs(Number(peg.x) || 0) * 0.0137 + 0.31), energy: 0, seen: 0 };
      this._portalStates.set(peg.id, state);
    }
    state.seen = this._buildTick;
    return state;
  }

  /** Advances every live portal's clock once per frame, before the scene is
   *  assembled, and drops the ones whose pegs are gone. */
  _updatePortals(pegs, dt) {
    const tick = this._buildTick;
    for (const peg of pegs || []) {
      if (!peg || !isPortalType(peg.type)) continue;
      const state = this._portalState(peg);
      const target = Math.max(0, Math.min(1, Number(peg._portalPulse) || 0));
      // Rises fast so a ball going through is felt at once, falls away slowly
      // so it reads as settling rather than switching off.
      const rate = target > state.energy ? 9.0 : 1.6;
      state.energy += (target - state.energy) * Math.min(1, dt * rate);
      if (state.energy < 0.002) state.energy = 0;
      // Idle is a slow drift; a pulse briefly runs it an order faster.
      state.clock = fract(state.clock + dt * (0.11 + state.energy * 1.5));
    }
    for (const [id, state] of this._portalStates) {
      if (state.seen !== tick) this._portalStates.delete(id);
    }
  }

  /** 0 while a peg is still below the board, 1 once it is fully up. */
  _emergenceFor(peg) {
    if (!this._emergence) return 1;
    const value = this._emergence.get(peg.id);
    return value === undefined ? 1 : Math.max(0, Math.min(1, value));
  }

  /** Hits arrive as a boolean set; decay them into a continuous flash so the
   *  light a struck peg emits actually falls off instead of snapping. */
  _updateFlashes(pegs, hitPegIds, dt) {
    const hitSet = hitPegIds instanceof Set ? hitPegIds : new Set(hitPegIds || []);
    const flashes = this._flashes;
    for (const id of hitSet) flashes.set(id, 1);
    for (const [id, value] of flashes) {
      if (hitSet.has(id)) continue;
      const next = value - dt * 1.9;
      if (next <= 0.01) flashes.delete(id);
      else flashes.set(id, next);
    }
    return flashes;
  }

  _buildScene(pegs, hitPegIds, options, dt) {
    const width = this.width;
    const height = this.height;
    const cameraY = Number(options.cameraY) || 0;
    this.instanceLength = 0;
    this.curveLength = 0;
    this._dynamicCount = 0;
    this._dynamicOverflow = false;
    this._animated = false;
    this._buildTick++;
    // A Map of peg id -> 0..1, or null when nothing is rising.
    this._emergence = options.emergence instanceof Map && options.emergence.size > 0
      ? options.emergence
      : null;

    const flashes = this._updateFlashes(pegs, hitPegIds, dt);
    this._updatePortals(pegs, dt);

    // Fixtures go in first. There is no depth test, so anything appended later
    // composites over what came before — pegs must win against the cabinet's
    // own light housings.
    for (const fixture of this.config.fixtures || []) {
      if (fixture.enabled === false) continue;
      this._pushInstance(
        fixture.x * width,
        fixture.y * height,
        Number(fixture.halfW) || 3.2,
        Number(fixture.halfH) || 15,
        Number(fixture.angle) || 0,
        SHAPE_CODES[fixture.shape] ?? SHAPE_EMITTER,
        0,
        fixture.visible ? MAT_EMISSIVE : MAT_HIDDEN_EMITTER,
        fixture.color || [0.16, 0.74, 1.0],
        Number.isFinite(fixture.intensity) ? fixture.intensity : 1.35
      );
    }

    for (const peg of pegs || []) {
      if (!this.isSupported(peg)) continue;
      const flash = flashes.get(peg.id) || 0;
      if (!peg._wrapHideMain) this._appendPeg(peg, flash, cameraY);
      if (Array.isArray(peg._wrapCopies)) {
        for (const copy of peg._wrapCopies) {
          this._appendPeg(peg, flash, cameraY, copy.x - peg.x, copy.y - peg.y);
        }
      }
    }

    // Pegs on the way out. The game drops them from its list the moment they
    // are knocked out, so without this the scene loses the peg, its shadow and
    // its glow in a single frame. They sink back through the board instead,
    // and once the body is under it a sourceless emitter carries the remaining
    // light down to nothing — the peg being extinguished rather than switched
    // off. The emitter is justified here precisely because something *was*
    // there: it is an afterglow, not a light with no origin.
    for (const exit of options.exits || []) {
      const peg = exit?.peg;
      if (!peg || !this.isSupported(peg)) continue;
      const glow = Math.max(0, Math.min(1, Number(exit.glow) || 0));
      if (exit.sink > 0.001) {
        this._appendPeg(peg, glow, cameraY);
      } else if (glow > 0.01) {
        const color = parsePegColor(peg.color) || PALETTE[TYPE_CODES[normalizePegType(peg.type)]] || PALETTE[1];
        const radius = PHYSICS_CONFIG.pegRadius;
        this._pushInstance(
          (Number(peg.x) || 0), (Number(peg.y) || 0) - cameraY,
          radius, radius, 0,
          SHAPE_DOME, 0, MAT_HIDDEN_EMITTER, color, glow * 2.2
        );
      }
    }

    // Everything appended from here on is machine hardware the game moves every
    // frame. It is recorded separately so the distance field can fold it in
    // analytically instead of re-flooding the whole board because a ball fell
    // three pixels.
    this._staticInstanceLength = this.instanceLength;

    // Machine hardware — ball, launcher, catcher, flippers — enters as ordinary
    // geometry so it is lit by the same solve as everything else instead of
    // being painted on top of it.
    for (const prop of options.props || []) {
      const shape = SHAPE_CODES[prop.shape] ?? SHAPE_EMITTER;
      const halfW = Number.isFinite(prop.halfW) ? prop.halfW : (Number(prop.radius) || 6);
      const halfH = Number.isFinite(prop.halfH) ? prop.halfH : halfW;
      const emissive = Number.isFinite(prop.emissive) ? prop.emissive : 0;
      const mat = prop.metal ? MAT_METAL : (emissive > 0.01 ? MAT_EMISSIVE : MAT_PLASTIC);
      const angle = Number(prop.angle) || 0;
      const x = Number(prop.x) || 0;
      const y = (Number(prop.y) || 0) - (prop.screenSpace ? 0 : cameraY);
      this._pushInstance(
        x, y,
        halfW, halfH,
        angle,
        shape,
        Number(prop.hit) || 0,
        mat,
        prop.color || [0.7, 0.95, 1.0],
        emissive
      );
      this._registerDynamicSolid(x, y, halfW, halfH, angle, shape, mat);
    }
  }

  /** Mirrors what the seed pass would have found for one moving prop: its
   *  profile, and whether it writes enough height to count as solid at all. */
  _registerDynamicSolid(x, y, halfW, halfH, angle, shape, mat) {
    // A light strip writes a height of 0.05 and a hidden fixture writes zero;
    // both sit under the seed shader's 0.06 threshold, so neither is a boundary.
    if (shape === SHAPE_EMITTER || mat === MAT_HIDDEN_EMITTER) return;
    if (shape === SHAPE_DOME || shape === SHAPE_BUMPER || shape === SHAPE_BALL) {
      this._pushDynamicSolid(x, y, halfW, halfH, angle, DYN_DISC, 0);
    } else if (shape === SHAPE_RING) {
      this._pushDynamicSolid(x, y, halfW, halfH, angle, DYN_ANNULUS, 0);
    } else if (shape === SHAPE_PORTAL || shape === SHAPE_CAPSULE) {
      this._pushDynamicSolid(x, y, halfW, halfH, angle, DYN_ROUNDBOX, Math.min(halfW, halfH));
    } else {
      this._pushDynamicSolid(x, y, halfW, halfH, angle, DYN_ROUNDBOX, Math.min(3.4, halfH * 0.62));
    }
  }

  _uploadBuffers() {
    const gl = this.gl;
    this._instanceCount = Math.floor(this.instanceLength / INSTANCE_FLOATS);
    this._curveCount = Math.floor(this.curveLength / CURVE_FLOATS);

    // The scene arrays are already the upload format, so these are straight
    // memcpys out of them — no staging copy and no per-element conversion.
    if (this._instanceCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
      if (this.instances.length > this._instanceCapacity) {
        gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW);
        this._instanceCapacity = this.instances.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instances, 0, this.instanceLength);
    }
    if (this._curveCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._curveBuffer);
      if (this.curveVertices.length > this._curveCapacity) {
        gl.bufferData(gl.ARRAY_BUFFER, this.curveVertices.byteLength, gl.DYNAMIC_DRAW);
        this._curveCapacity = this.curveVertices.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.curveVertices, 0, this.curveLength);
    }
  }

  /**
   * Returns true only when data that can change the SDF has changed. This is an
   * exact value comparison rather than a hash: a false reuse would corrupt
   * lighting, while a few thousand scalar comparisons are cheap and allocate
   * nothing once the arrays have reached their high-water mark.
   */
  _distanceGeometryChanged() {
    // Props that the merge pass will carry analytically are excluded, so an
    // otherwise still board no longer re-floods because the ball moved. If more
    // movers arrived than the analytic budget holds, every one of them goes
    // back under the flood, which is slower but stays correct.
    const instanceEnd = this._dynamicOverflow ? this.instanceLength : this._staticInstanceLength;
    const upperBound = 2 + (instanceEnd / INSTANCE_FLOATS) * 8 + (this.curveLength / CURVE_FLOATS) * 7;
    if (this._sdfGeometryScratch.length < upperBound) {
      this._sdfGeometryScratch = new Float32Array(Math.ceil(upperBound * 1.5));
    }
    const next = this._sdfGeometryScratch;
    let n = 0;

    const instances = this.instances;
    let solidInstances = 0;
    const countSlot = n++; // patched with the count after emitters are skipped
    for (let i = 0; i < instanceEnd; i += INSTANCE_FLOATS) {
      const shape = instances[i + 5];
      const material = instances[i + 7];
      // Light strips write a fixed height of 0.05 and hidden emitters write
      // zero. Both sit below the seed shader's 0.06 solid threshold.
      if (shape === SHAPE_EMITTER || material === MAT_HIDDEN_EMITTER) continue;
      solidInstances++;
      next[n] = instances[i];          // centre
      next[n + 1] = instances[i + 1];
      next[n + 2] = instances[i + 2];  // extent
      next[n + 3] = instances[i + 3];
      next[n + 4] = instances[i + 4];  // orientation
      next[n + 5] = shape;             // profile
      next[n + 6] = instances[i + 12]; // height scale
      next[n + 7] = instances[i + 13]; // emergence
      n += 8;
    }
    next[countSlot] = solidInstances;

    const curves = this.curveVertices;
    next[n++] = this.curveLength / CURVE_FLOATS;
    for (let i = 0; i < this.curveLength; i += CURVE_FLOATS) {
      next[n] = curves[i];             // centreline position
      next[n + 1] = curves[i + 1];
      next[n + 2] = curves[i + 2];     // normal
      next[n + 3] = curves[i + 3];
      next[n + 4] = curves[i + 4];     // side
      next[n + 5] = curves[i + 5];     // half width
      next[n + 6] = curves[i + 12];    // emergence
      n += 7;
    }

    const previous = this._sdfGeometry;
    let changed = n !== this._sdfGeometryLength;
    if (!changed) {
      for (let i = 0; i < n; i++) {
        if (next[i] !== previous[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this._sdfGeometry = next;
      this._sdfGeometryScratch = previous;
      this._sdfGeometryLength = n;
    }
    return changed;
  }

  // ── passes ────────────────────────────────────────────────────────────────

  _renderGBuffer() {
    const gl = this.gl;
    const t = this._targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.gbufferFbo);
    gl.viewport(0, 0, this._renderWidth, this._renderHeight);
    // The board pass below writes all four attachments over every texel with
    // blending off, so last frame's G-buffer never needs loading back in.
    if (this.discardTargets) gl.invalidateFramebuffer(gl.FRAMEBUFFER, this._attachAll);
    gl.disable(gl.BLEND);

    const board = this.config;
    this._programs.board.use()
      .v2('uCanvas', this.width, this.height)
      .v2('uRender', this._renderWidth, this._renderHeight)
      .f('uTime', this._time)
      .f('uBoardStyle', board.boardStyle)
      .v3('uBoardColor', board.boardColor[0], board.boardColor[1], board.boardColor[2])
      .f('uBoardTexture', board.boardTexture)
      .f('uBoardGrid', board.boardGrid)
      .f('uBoardGridDepth', board.boardGridDepth);
    this._blit();

    // Coverage-weighted blending is the antialiasing: an edge fragment mixes
    // its own material with the board underneath in the right proportion.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (this._curveCount > 0) {
      gl.bindVertexArray(this._curveVao);
      this._programs.curve.use()
        .v2('uCanvas', this.width, this.height)
        .f('uHitBoost', this._hitBoost)
        .f('uGloss', this._gloss)
        .f('uEmitScale', EMIT_SCALE);
      gl.drawArrays(gl.TRIANGLES, 0, this._curveCount);
    }
    if (this._instanceCount > 0) {
      gl.bindVertexArray(this._objectVao);
      this._programs.object.use()
        .v2('uCanvas', this.width, this.height)
        .f('uMargin', 1.5)
        .f('uHeightScale', HEIGHT_SCALE)
        .f('uEmitScale', EMIT_SCALE)
        .f('uHitBoost', this._hitBoost)
        .f('uGloss', this._gloss)
        .f('uTime', this._time);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._instanceCount);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  _renderDistanceField(rebuild) {
    const gl = this.gl;
    const t = this._targets;

    this._bindTarget(t.scene, t.sdfWidth, t.sdfHeight);
    this._programs.downsample.use()
      .tex('uEmission', 0, t.emission)
      .tex('uMaterial', 1, t.material)
      .tex('uBounce', 2, t.litPrev)
      .v2('uSourceTexel', 1 / this._renderWidth, 1 / this._renderHeight)
      .f('uBounceStrength', this._bounce)
      .f('uEmitScale', EMIT_SCALE);
    this._blit();

    // Scene radiance above changes with every portal shimmer and hit flash, but
    // the distance texture does not. Avoid seed + O(log maxDimension) flood
    // passes when the exact solid geometry snapshot is unchanged.
    if (!rebuild && this._sdfReady) {
      this._sdfReuses++;
      this._mergeDynamicSolids(false);
      return;
    }
    this._sdfBuilds++;

    this._bindTarget(t.seedA, t.sdfWidth, t.sdfHeight);
    this._programs.seed.use()
      .tex('uScene', 0, t.scene)
      .v2('uTexel', 1 / t.sdfWidth, 1 / t.sdfHeight);
    this._blit();

    let source = t.seedA;
    let destination = t.seedB;
    const passes = Math.ceil(Math.log2(Math.max(t.sdfWidth, t.sdfHeight)));
    const jfa = this._programs.jfa;
    const distanceScale = Math.max(this.width, this.height);
    jfa.use()
      .v2('uCanvas', this.width, this.height)
      .f('uDistanceScale', distanceScale)
      .f('uOutputDistance', 0);
    for (let i = 0; i < passes; i++) {
      const step = Math.pow(2, passes - 1 - i);
      this._bindTarget(destination, t.sdfWidth, t.sdfHeight);
      jfa.use()
        .tex('uSeed', 0, source)
        .v2('uTexel', 1 / t.sdfWidth, 1 / t.sdfHeight)
        .f('uStep', step);
      this._blit();
      const swap = source; source = destination; destination = swap;
    }
    // One final unit step cleans up the classic jump-flood corner artifacts.
    this._bindTarget(t.sdfStatic, t.sdfWidth, t.sdfHeight);
    jfa.use()
      .tex('uSeed', 0, source)
      .f('uStep', 1)
      .f('uOutputDistance', 1);
    this._blit();
    this._sdfReady = true;
    this._mergeDynamicSolids(true);
  }

  /** True when the moving set differs from the one already merged, updating the
   *  snapshot as a side effect. Same exact-comparison approach as the static
   *  geometry: a wrong "unchanged" would strand a stale field. */
  _dynamicSolidsChanged() {
    const floats = this._dynamicCount * 4;
    const previous = this._dynamicSnapshot;
    let changed = floats !== this._dynamicSnapshotLength;
    if (!changed) {
      for (let i = 0; i < floats; i++) {
        if (previous[i] !== this._dynamicA[i] || previous[floats + i] !== this._dynamicB[i]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      previous.set(this._dynamicA.subarray(0, floats), 0);
      previous.set(this._dynamicB.subarray(0, floats), floats);
      this._dynamicSnapshotLength = floats;
    }
    return changed;
  }

  /** Folds this frame's moving hardware into the flooded field. One pass over a
   *  half-resolution target with a handful of closed-form profiles, in place of
   *  the seed plus ten flood passes the movement would otherwise have cost. */
  _mergeDynamicSolids(rebuilt) {
    const t = this._targets;
    const count = this._dynamicCount;
    if (count === 0) {
      t.sdf = t.sdfStatic;
      this._sdfMerged = false;
      this._dynamicSnapshotLength = -1;
      return;
    }
    // An aiming player moves nothing at all. Neither half of the field has
    // changed then, so the merged texture from last frame still stands.
    const moved = this._dynamicSolidsChanged();
    if (!rebuilt && !moved && this._sdfMerged) {
      t.sdf = t.sdfDistance;
      return;
    }
    const program = this._programs.sdfMerge;
    this._bindTarget(t.sdfDistance, t.sdfWidth, t.sdfHeight);
    program.use()
      .tex('uStatic', 0, t.sdfStatic)
      .v2('uCanvas', this.width, this.height)
      .f('uDistanceScale', Math.max(this.width, this.height));
    const gl = this.gl;
    gl.uniform1i(program.loc('uSolidCount'), count);
    gl.uniform4fv(program.loc('uSolidA[0]'), this._dynamicA, 0, count * 4);
    gl.uniform4fv(program.loc('uSolidB[0]'), this._dynamicB, 0, count * 4);
    this._blit();
    t.sdf = t.sdfDistance;
    this._sdfMerged = true;
  }

  _renderCascades(bypassHistory = false) {
    const gl = this.gl;
    const t = this._targets;
    const program = this._programs.cascade;
    const baseInterval = t.spacing;

    program.use()
      .v2('uCanvas', this.width, this.height)
      .v2('uCascadeSize', t.cascadeWidth, t.cascadeHeight)
      .f('uHeightScale', HEIGHT_SCALE)
      .f('uEmitScale', EMIT_SCALE)
      .f('uElevation', this._elevation)
      .f('uDistanceScale', Math.max(this.width, this.height))
      .v3('uSkyTop', this._skyTop[0], this._skyTop[1], this._skyTop[2])
      .v3('uSkyBottom', this._skyBottom[0], this._skyBottom[1], this._skyBottom[2])
      .tex('uSdf', 0, t.sdf)
      .tex('uScene', 1, t.scene);

    // Top-down: each level resolves what the level below could not reach.
    for (let i = t.cascadeCount - 1; i >= 0; i--) {
      const block = Math.pow(2, i + 1);
      const spacing = t.spacing * Math.pow(2, i);
      const start = baseInterval * (Math.pow(4, i) - 1) / 3;
      const end = start + baseInterval * Math.pow(4, i);
      const isTop = i === t.cascadeCount - 1;

      this._bindTarget(t.cascades[i], t.cascadeWidth, t.cascadeHeight);
      program.use()
        .f('uBlock', block)
        .f('uSpacing', spacing)
        .f('uIntervalStart', start)
        .f('uIntervalEnd', end)
        .f('uIsTop', isTop ? 1 : 0)
        // Budget and step floor both scale with the interval, so every cascade
        // can actually cross the range it owns.
        .f('uSteps', this.marchSteps ?? Math.min(48, 14 + i * 9))
        .f('uMinStep', this.marchMinStep ?? Math.max(1.5, (end - start) * 0.022))
        // The top cascade has nothing above it, and uIsTop stops the shader
        // reading this sampler at all — but it still has to point somewhere
        // other than the target being drawn into. Binding the target to itself
        // is a feedback loop, which WebGL answers by dropping the whole draw,
        // so the top cascade was never actually solved.
        .tex('uUpper', 2, isTop ? t.scene : t.cascades[i + 1]);
      this._blit();
    }

    // Temporally stabilise cascade 0, which is what shading reads.
    this._bindTarget(t.fieldA, t.cascadeWidth, t.cascadeHeight);
    this._programs.cascadeBlend.use()
      .tex('uCurrent', 0, t.cascades[0])
      .tex('uHistory', 1, t.fieldPrimed ? t.fieldB : t.cascades[0])
      .v2('uCascadeSize', t.cascadeWidth, t.cascadeHeight)
      .f('uBlock', 2)
      .f('uBlend', t.fieldPrimed && !bypassHistory ? this._giBlend : 1.0);
    this._blit();
    const previousField = t.fieldB;
    t.fieldB = t.fieldA;
    t.fieldA = previousField;
    t.fieldPrimed = true;
  }

  _renderShading() {
    const t = this._targets;
    this._bindTarget(t.lit, this._renderWidth, this._renderHeight);
    this._programs.shade.use()
      .tex('uAlbedo', 0, t.albedo)
      .tex('uNormal', 1, t.normal)
      .tex('uEmission', 2, t.emission)
      .tex('uCascade0', 3, t.fieldB)
      .tex('uSdf', 4, t.sdf)
      .tex('uScene', 5, t.scene)
      .tex('uMaterial', 6, t.material)
      .tex('uBounce', 7, t.litPrev)
      .v2('uCanvas', this.width, this.height)
      .v2('uRender', this._renderWidth, this._renderHeight)
      .v2('uCascadeSize', t.cascadeWidth, t.cascadeHeight)
      .f('uSpacing', t.spacing)
      .f('uEmitScale', EMIT_SCALE)
      .f('uHeightScale', HEIGHT_SCALE)
      .f('uExposure', this._exposure)
      .v3('uDomeColor', this._domeColor[0], this._domeColor[1], this._domeColor[2])
      .f('uDomeIntensity', this._domeIntensity)
      .v2('uKeyDir', this._keyDir[0], this._keyDir[1])
      .f('uKeyElevation', this._keyElevation)
      .f('uSkyRef', this._skyRef)
      .f('uSpecFloor', this._specFloor);
    this._programs.shade.f('uDistanceScale', Math.max(this.width, this.height));
    this._blit();
  }

  _renderBloom() {
    const t = this._targets;
    const levels = t.bloom;
    // The composite multiplies the whole chain by this. At zero the seven
    // passes below produce something that is then scaled to nothing, and the
    // targets were cleared at allocation so what it reads instead is black.
    if (!(this._bloomStrength > 0)) return;

    this._bindTarget(levels[0].texture, levels[0].width, levels[0].height);
    this._programs.prefilter.use()
      .tex('uSource', 0, t.lit)
      .f('uThreshold', this._bloomThreshold)
      .f('uKnee', 0.35);
    this._blit();

    for (let i = 1; i < levels.length; i++) {
      this._bindTarget(levels[i].texture, levels[i].width, levels[i].height);
      this._programs.down.use()
        .tex('uSource', 0, levels[i - 1].texture)
        .v2('uTexel', 1 / levels[i - 1].width, 1 / levels[i - 1].height);
      this._blit();
    }
    for (let i = levels.length - 2; i >= 1; i--) {
      this._bindTarget(levels[i].texture, levels[i].width, levels[i].height);
      this._programs.up.use()
        .tex('uSource', 0, levels[i + 1].texture)
        .v2('uTexel', 1 / levels[i + 1].width, 1 / levels[i + 1].height);
      this._blit();
    }
  }

  _renderComposite(sourceTexture = this._targets?.lit) {
    const gl = this.gl;
    const t = this._targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._renderWidth, this._renderHeight);
    this._programs.composite.use()
      .tex('uScene', 0, sourceTexture)
      .tex('uBloom1', 1, t.bloom[1].texture)
      .tex('uBloom2', 2, t.bloom[2].texture)
      .tex('uBloom3', 3, t.bloom[3].texture)
      .v2('uCanvas', this.width, this.height)
      .f('uBloomStrength', this._bloomStrength)
      .f('uVignette', this._vignette)
      .f('uSaturation', this._saturation);

    const waves = this._waves || [];
    const count = Math.min(4, waves.length);
    const program = this._programs.composite;
    gl.uniform1i(program.loc('uWaveCount'), count);
    if (count > 0) {
      const a = this._waveA;
      const b = this._waveB;
      const c = this._waveC;
      for (let i = 0; i < count; i++) {
        const w = waves[i];
        const i4 = i * 4;
        const i3 = i * 3;
        a[i4] = w.x; a[i4 + 1] = w.y; a[i4 + 2] = w.radius; a[i4 + 3] = w.band;
        b[i4] = w.amp; b[i4 + 1] = w.ringAlpha; b[i4 + 2] = w.ripple; b[i4 + 3] = w.weight;
        c[i3] = w.color[0]; c[i3 + 1] = w.color[1]; c[i3 + 2] = w.color[2];
      }
      gl.uniform4fv(program.loc('uWaveA[0]'), a);
      gl.uniform4fv(program.loc('uWaveB[0]'), b);
      gl.uniform3fv(program.loc('uWaveC[0]'), c);
    }
    this._blit();
  }

  /** Re-present the most recently completed frame and copy it into a 2D
   *  context. The WebGL context does not preserve its drawing buffer, so a
   *  plain drawImage at an arbitrary later time can capture an empty board.
   *  Re-compositing the retained lit texture makes transition captures exact
   *  while costing only one fullscreen blit at the rare level boundary. */
  drawTo2D(targetCtx, x = 0, y = 0, width = this.width, height = this.height) {
    if (!targetCtx || !this.ready || !this.gl || !this._targets) return false;
    // render() swaps lit/litPrev after presentation; litPrev is therefore the
    // latest completed lighting result between frames.
    this._renderComposite(this._targets.litPrev);
    this.gl.flush();
    targetCtx.drawImage(this.canvas, x, y, width, height);
    return true;
  }

  render(pegs, hitPegIds, options = {}) {
    if (!this.ready || !this.gl) return false;
    this._pollGpuTimer();
    this._observeFrameCadence(options.frameDeltaSeconds);
    const width = Math.max(1, Number(options.width) || this.width || 400);
    const height = Math.max(1, Number(options.height) || this.height || 600);
    this.resize(width, height);
    if (!this._targets) return false;

    const time = Number(options.timeSeconds) || 0;
    const dt = Math.min(0.05, Math.max(0, time - this._lastTime)) || 0.016;
    this._lastTime = time;
    this._time = time;

    // Per-call options win over the stored rig, so gameplay can still push a
    // one-off override without mutating what the tuner is editing.
    const cfg = this.config;
    const pick = (key, fallback) => (Number.isFinite(options[key]) ? options[key] : fallback);
    this._exposure = pick('exposure', cfg.exposure);
    this._bloomStrength = pick('bloom', cfg.bloom);
    this._bloomThreshold = pick('bloomThreshold', cfg.bloomThreshold);
    this._bounce = pick('bounce', cfg.bounce);
    this._elevation = pick('lightElevation', cfg.lightElevation);
    this._vignette = pick('vignette', cfg.vignette);
    this._saturation = pick('saturation', cfg.saturation);
    this._hitBoost = pick('hitBoost', cfg.hitBoost);
    this._gloss = pick('gloss', cfg.gloss);
    this._specFloor = pick('specFloor', cfg.specFloor ?? 0);
    this._giBlend = pick('giBlend', cfg.giBlend);
    this._waves = Array.isArray(options.waves) ? options.waves : null;
    const skyScale = pick('skyIntensity', cfg.skyIntensity);
    const skyTop = options.skyTop || DEFAULT_SKY_TOP;
    const skyBottom = options.skyBottom || DEFAULT_SKY_BOTTOM;
    for (let i = 0; i < 3; i++) {
      this._scaledSkyTop[i] = skyTop[i] * skyScale;
      this._scaledSkyBottom[i] = skyBottom[i] * skyScale;
    }
    this._skyTop = this._scaledSkyTop;
    this._skyBottom = this._scaledSkyBottom;
    this._domeColor = options.domeColor || cfg.domeColor;
    this._domeIntensity = pick('domeIntensity', cfg.domeIntensity);
    const keyDir = options.keyDir;
    this._resolvedKeyDir[0] = keyDir ? keyDir[0] : cfg.keyDirX;
    this._resolvedKeyDir[1] = keyDir ? keyDir[1] : cfg.keyDirY;
    this._keyDir = this._resolvedKeyDir;
    this._keyElevation = pick('keyElevation', cfg.keyElevation);
    // Reference level for "fully open to the sky", used to normalise openness.
    const sky = this._skyTop;
    this._skyRef = Math.max(1e-4, 0.2126 * sky[0] + 0.7152 * sky[1] + 0.0722 * sky[2]) * 0.75;

    const flashWasActive = this._flashes.size > 0;
    this._buildScene(pegs, hitPegIds, options, dt);
    const sdfGeometryChanged = this._distanceGeometryChanged();
    const lifecycleActive = options.bypassTemporalHistory === true;
    if (sdfGeometryChanged || flashWasActive || this._flashes.size > 0 || lifecycleActive) {
      // Seven .55 blends leave under 0.4% of the old field; eight gives the
      // frame skipper a conservative final frame without a visible snap.
      this._temporalSettleFrames = 8;
    }
    this._uploadBuffers();

    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this._beginGpuTimer();
    this._renderGBuffer();
    this._renderDistanceField(!this.reuseDistanceField || sdfGeometryChanged);
    // Pegs moving through the board must take their shadow with them in the
    // same frame. Temporal probe smoothing is useful for free-moving lights,
    // but it is visually wrong for a disappearing solid, so lifecycle frames
    // use the current field directly.
    this._renderCascades(lifecycleActive);
    this._renderShading();
    this._renderBloom();
    this._renderComposite();
    this._endGpuTimer();

    // This frame's lit result becomes next frame's bounce source.
    const t = this._targets;
    const previous = t.litPrev;
    t.litPrev = t.lit;
    t.lit = previous;

    if (this._temporalSettleFrames > 0) this._temporalSettleFrames--;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  dispose() {
    if (this.gl && this._gpuTimingQuery) this.gl.deleteQuery(this._gpuTimingQuery);
    this._gpuTimingQuery = null;
    this._gpuTimingActive = false;
    this._releaseTargets();
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    this.gl = null;
    this.ready = false;
    this._temporalSettleFrames = 0;
  }
}
