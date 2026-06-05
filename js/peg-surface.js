// Procedural glass-orb peg surface renderer.
// All paint operations are canvas2d primitives — no assets, no shaders.
//
// The recipe paints a layered sphere that reads as glass/crystal:
//   L0  shadow disc      — outer contact shadow
//   L1  inner volume     — dark interior (the "glass body")
//   L2  lambert wash     — lit upper-left hemisphere in material color
//   L3  candle           — soft internal glow (inner light, sells gem vibe)
//   L4  AO band          — equatorial darken (multiply) for weight
//   L5  top fresnel arc  — sharp grazing-light edge
//   L6  bottom rim arc   — AMBIENT-TINTED grazing edge (env reflection)
//   L7  bottom halo      — AMBIENT-TINTED soft underside glow
//   L8  main spec        — sharp glint (the "wet glass" cue)
//   L9  micro spec       — secondary tiny glint
//   L10 hit flash        — additive pulse on hit
//
// The function paints to whatever ctx is passed. In the renderer this is
// used to fill cached offscreen sprites; in the lab it paints to the live
// viewport so a designer can iterate the recipe in real time.

export const PEG_SURFACE_STYLES = {
  orange:        { bright:'#ffd7a0', light:'#ff9230', main:'#ff6b35', deep:'#7a2611', shadow:'#290a04',
                   hitBright:'#fff1bc', hitLight:'#ffbd4c', hitMain:'#ff8b24' },
  billiardRed:   { bright:'#ffe1df', light:'#ff8b82', main:'#e84d4d', deep:'#6e1316', shadow:'#2a0508',
                   hitBright:'#ffffff', hitLight:'#ffc1bc', hitMain:'#ff746c' },
  bomb:          { bright:'#ffd0b0', light:'#ff6b4a', main:'#ff1f2d', deep:'#74050c', shadow:'#260103',
                   hitBright:'#ffffff', hitLight:'#ffb38f', hitMain:'#ff5a3c' },
  billiardYellow:{ bright:'#fff7bd', light:'#ffe16a', main:'#ffd447', deep:'#85590a', shadow:'#2e1903',
                   hitBright:'#ffffff', hitLight:'#fff1a8', hitMain:'#ffe16a' },
  blue:          { bright:'#d7fffb', light:'#7df4ed', main:'#4ecdc4', deep:'#0f5a55', shadow:'#03222a',
                   hitBright:'#ffffff', hitLight:'#a5fff8', hitMain:'#6ee2db' },
  green:         { bright:'#f0fff4', light:'#c3f7d7', main:'#95d5b2', deep:'#357050', shadow:'#0e2818',
                   hitBright:'#ffffff', hitLight:'#d9ffe5', hitMain:'#afe6c3' },
  purple:        { bright:'#f6e6ff', light:'#dfadff', main:'#c77dff', deep:'#5c2487', shadow:'#1e0a34',
                   hitBright:'#ffffff', hitLight:'#eecaff', hitMain:'#d99aff' },
  multi:         { bright:'#ffe0f0', light:'#ff8cc5', main:'#ff4d9d', deep:'#8a1454', shadow:'#33051f',
                   hitBright:'#ffffff', hitLight:'#ffadd2', hitMain:'#ff70b3' },
  gamble:        { bright:'#f6ffd6', light:'#cfff5c', main:'#8cff00', deep:'#3a7000', shadow:'#0e2700',
                   hitBright:'#ffffff', hitLight:'#e5ff99', hitMain:'#b5ff3c' },
  obstacle:      { bright:'#e8edf5', light:'#aab3c2', main:'#6b7280', deep:'#2c333d', shadow:'#0d1018',
                   hitBright:'#f4f7fb', hitLight:'#c5ccd8', hitMain:'#8b94a3' }
};

export const DEFAULT_RECIPE = Object.freeze({
  // L1 — inner volume
  volumeMidStop:     0.42,
  volumeEdgeAlpha:   1.0,
  // L2 — lambert wash
  lambertOffsetX:   -0.42,
  lambertOffsetY:   -0.48,
  lambertOuterR:     1.15,
  lambertAlpha0:     0.92,
  lambertAlpha1:     0.55,
  lambertEnd:        0.72,
  // L3 — candle
  candleR:           0.46,
  candleAlpha:       0.26,
  candleX:           0.0,
  candleY:           0.06,
  // L4 — AO band
  aoBandY:           0.58,
  aoBandRX:          0.92,
  aoBandRY:          0.16,
  aoBandAlpha:       0.45,
  // L5 — top fresnel arc
  topRimR:           0.94,
  topRimStart:       Math.PI * 0.10,
  topRimEnd:         Math.PI * 0.56,
  topRimWidth:       1.25,    // device px scaled by r/12
  topRimAlpha:       0.95,
  // L6 — bottom fresnel arc (ambient)
  botRimR:           0.94,
  botRimStart:       Math.PI * 1.05,
  botRimEnd:         Math.PI * 1.94,
  botRimWidth:       1.35,
  botRimAlpha:       0.92,
  // L7 — bottom halo (ambient)
  botHaloRInner:     0.74,
  botHaloROuter:     1.00,
  botHaloAlpha:      0.50,
  // L8 — main spec
  specMainX:        -0.30,
  specMainY:        -0.42,
  specMainRX:        0.18,
  specMainRY:        0.10,
  specMainAlpha:     1.0,
  specMainRotate:   -0.55,
  // L9 — micro spec
  specMicroX:        0.18,
  specMicroY:       -0.16,
  specMicroR:        0.055,
  specMicroAlpha:    0.55,
  // L10 — hit pulse
  hitFlashAlpha:     0.65,
  hitCandleBoost:    1.7,
});

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function _hex(c) {
  if (Array.isArray(c)) return [c[0]|0, c[1]|0, c[2]|0];
  if (typeof c !== 'string') return [255, 255, 255];
  const m = c.trim();
  if (m.startsWith('rgb')) {
    const p = m.match(/(\d+(\.\d+)?)/g);
    if (!p) return [255, 255, 255];
    return [Math.round(+p[0]), Math.round(+p[1]), Math.round(+p[2])];
  }
  const mt = m.match(HEX_RE);
  if (!mt) return [255, 255, 255];
  const h = mt[1];
  if (h.length === 3) {
    return [parseInt(h[0]+h[0], 16), parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16)];
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function _rgba(c, a = 1) {
  const [r, g, b] = _hex(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function _lerpColor(a, b, t) {
  const A = _hex(a), B = _hex(b);
  return [
    Math.round(A[0] + (B[0] - A[0]) * t),
    Math.round(A[1] + (B[1] - A[1]) * t),
    Math.round(A[2] + (B[2] - A[2]) * t)
  ];
}

const LAYER_NAMES = ['disc','volume','lambert','candle','ao','topRim','botRim','botHalo','spec','micro','hit'];

export function getLayerNames() { return LAYER_NAMES.slice(); }

/**
 * Paint one glass-orb peg.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{
 *   cx:number, cy:number, r:number,
 *   style:object,                 // PEG_SURFACE_STYLES entry
 *   ambient?:[number,number,number],  // 0..255 env color for bottom rim
 *   hitMix?:number,               // 0..1
 *   recipe?:object,               // partial override of DEFAULT_RECIPE
 *   layerMask?:Set<string>        // debug: only paint these layers
 * }} opts
 */
export function paintGlassOrb(ctx, opts) {
  const { cx, cy, r, style } = opts;
  const ambient = opts.ambient || [120, 120, 140];
  const hitMix = Math.max(0, Math.min(1, opts.hitMix || 0));
  const recipe = opts.recipe ? { ...DEFAULT_RECIPE, ...opts.recipe } : DEFAULT_RECIPE;
  const mask = opts.layerMask;
  const want = name => !mask || mask.has(name);
  const tau = Math.PI * 2;

  const bright = hitMix > 0 ? _lerpColor(style.bright, style.hitBright || style.bright, hitMix) : style.bright;
  const light  = hitMix > 0 ? _lerpColor(style.light,  style.hitLight  || style.light,  hitMix) : style.light;
  const main   = hitMix > 0 ? _lerpColor(style.main,   style.hitMain   || style.main,   hitMix) : style.main;
  const deep   = style.deep;
  const shadow = style.shadow;

  // L0 — outer shadow disc
  if (want('disc')) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.fillStyle = _rgba(shadow, 1);
    ctx.fill();
  }

  // L1 — inner volume: dark interior
  if (want('volume')) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, _rgba(deep, 1));
    g.addColorStop(recipe.volumeMidStop, _rgba(deep, 1));
    g.addColorStop(1, _rgba(shadow, recipe.volumeEdgeAlpha));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.fillStyle = g;
    ctx.fill();
  }

  // L2 — lambert wash: lit upper-left in material color
  if (want('lambert')) {
    const lx = cx + recipe.lambertOffsetX * r;
    const ly = cy + recipe.lambertOffsetY * r;
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, recipe.lambertOuterR * r);
    g.addColorStop(0, _rgba(main, recipe.lambertAlpha0));
    g.addColorStop(0.34, _rgba(main, recipe.lambertAlpha1));
    g.addColorStop(recipe.lambertEnd, _rgba(main, 0));
    g.addColorStop(1, _rgba(main, 0));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  // L3 — candle: inner soft glow
  if (want('candle')) {
    const cR = recipe.candleR * r;
    const cX = cx + recipe.candleX * r;
    const cY = cy + recipe.candleY * r;
    const a = recipe.candleAlpha * (1 + (recipe.hitCandleBoost - 1) * hitMix);
    const g = ctx.createRadialGradient(cX, cY, 0, cX, cY, cR);
    g.addColorStop(0, _rgba(bright, a));
    g.addColorStop(0.55, _rgba(bright, a * 0.42));
    g.addColorStop(1, _rgba(bright, 0));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  // L4 — equatorial AO band: multiply darken near the bottom equator
  if (want('ao')) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    const ay = cy + recipe.aoBandY * r;
    const arx = recipe.aoBandRX * r;
    const ary = recipe.aoBandRY * r;
    ctx.translate(cx, ay);
    ctx.scale(1, ary / arx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, arx);
    const d = 1 - recipe.aoBandAlpha;
    const dv = Math.round(d * 255);
    g.addColorStop(0, `rgba(${dv},${dv},${dv},1)`);
    g.addColorStop(0.85, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = g;
    ctx.fillRect(-arx, -arx, arx * 2, arx * 2);
    ctx.restore();
  }

  // L5 — top fresnel arc (light-side rim)
  if (want('topRim')) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * recipe.topRimR, recipe.topRimStart, recipe.topRimEnd);
    ctx.strokeStyle = _rgba(light, recipe.topRimAlpha);
    ctx.lineWidth = recipe.topRimWidth * (r / 12);
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // L6 — bottom fresnel arc (ambient-tinted)
  if (want('botRim')) {
    const [ar, ag, ab] = ambient;
    ctx.beginPath();
    ctx.arc(cx, cy, r * recipe.botRimR, recipe.botRimStart, recipe.botRimEnd);
    ctx.strokeStyle = `rgba(${ar},${ag},${ab},${recipe.botRimAlpha})`;
    ctx.lineWidth = recipe.botRimWidth * (r / 12);
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // L7 — bottom halo (soft ambient under-glow)
  if (want('botHalo')) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.clip();
    // restrict to lower hemisphere
    ctx.beginPath();
    ctx.rect(cx - r, cy - r * 0.05, r * 2, r * 1.05);
    ctx.clip();
    const [ar, ag, ab] = ambient;
    const g = ctx.createRadialGradient(cx, cy, recipe.botHaloRInner * r, cx, cy, recipe.botHaloROuter * r);
    g.addColorStop(0, `rgba(${ar},${ag},${ab},0)`);
    g.addColorStop(0.62, `rgba(${ar},${ag},${ab},${recipe.botHaloAlpha * 0.55})`);
    g.addColorStop(1, `rgba(${ar},${ag},${ab},${recipe.botHaloAlpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  // L8 — main specular dot (the glass glint)
  if (want('spec')) {
    ctx.save();
    ctx.translate(cx + recipe.specMainX * r, cy + recipe.specMainY * r);
    ctx.rotate(recipe.specMainRotate);
    ctx.beginPath();
    ctx.ellipse(0, 0, recipe.specMainRX * r, recipe.specMainRY * r, 0, 0, tau);
    ctx.fillStyle = `rgba(255,255,255,${recipe.specMainAlpha})`;
    ctx.fill();
    ctx.restore();
  }

  // L9 — micro spec
  if (want('micro')) {
    ctx.beginPath();
    ctx.arc(cx + recipe.specMicroX * r, cy + recipe.specMicroY * r, recipe.specMicroR * r, 0, tau);
    ctx.fillStyle = `rgba(255,255,255,${recipe.specMicroAlpha})`;
    ctx.fill();
  }

  // L10 — hit flash overlay (additive)
  if (want('hit') && hitMix > 0.01) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, tau);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const a = recipe.hitFlashAlpha * hitMix;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, _rgba(bright, a));
    g.addColorStop(0.55, _rgba(light, a * 0.45));
    g.addColorStop(1, _rgba(light, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }
}

/**
 * Legacy recipe — what the current renderer produces.
 * Kept here so the lab page can render "old vs new" side-by-side
 * without depending on the live renderer.
 */
export function paintLegacyOrb(ctx, opts) {
  const { cx, cy, r, style } = opts;
  const hitMix = Math.max(0, Math.min(1, opts.hitMix || 0));
  const tau = Math.PI * 2;

  const bright = hitMix > 0 ? _lerpColor(style.bright, style.hitBright || style.bright, hitMix) : style.bright;
  const light  = hitMix > 0 ? _lerpColor(style.light,  style.hitLight  || style.light,  hitMix) : style.light;
  const main   = hitMix > 0 ? _lerpColor(style.main,   style.hitMain   || style.main,   hitMix) : style.main;
  const deep   = style.deep;
  const shadow = style.shadow;

  // shadow disc
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, tau);
  ctx.fillStyle = _rgba(shadow, 1);
  ctx.fill();

  // body radial gradient (the original recipe: light at top-left → deep at edge)
  const body = ctx.createRadialGradient(
    cx - r * 0.33, cy - r * 0.36, r * 0.08,
    cx + r * 0.08, cy + r * 0.10, r
  );
  body.addColorStop(0, _rgba(bright, 1));
  body.addColorStop(0.18, _rgba(light, 1));
  body.addColorStop(0.5, _rgba(main, 1));
  body.addColorStop(0.76, _rgba(deep, 1));
  body.addColorStop(1, _rgba(deep, 1));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, tau);
  ctx.fillStyle = body;
  ctx.fill();

  // soft elliptical "shine smudge"
  ctx.save();
  ctx.translate(cx - r * 0.34, cy - r * 0.36);
  ctx.rotate(-0.5);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.27, r * 0.12, 0, 0, tau);
  ctx.fillStyle = hitMix > 0.5 ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,245,0.72)';
  ctx.fill();
  ctx.restore();

  // rim arcs (top + bottom)
  ctx.beginPath();
  ctx.arc(cx, cy, r - 0.45, 0, tau);
  ctx.strokeStyle = _rgba(light, 0.86);
  ctx.lineWidth = Math.max(0.75, r * 0.085);
  ctx.stroke();
}
