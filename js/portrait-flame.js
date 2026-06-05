// Portrait ignite flame — a white "solidified fire" that ENVELOPS the portrait
// circle and licks UPWARD like a bonfire, building up DURING a shot as pegs are
// cleared (driven by a live `setHeat(0..1)`), then fading. Self-contained
// Canvas-2D: the canvas is a square box centred on the portrait circle (by
// visual-layout), so the fire is always anchored to the circle. Flames root on
// the circle's perimeter and rise up — tallest over the top, licking up the
// sides, near-nothing at the bottom (fire rises) — so it reads as a campfire
// engulfing the portrait, NOT a radial star. Renders only while lit (RAF stops
// at rest → no idle cost).
//
// Intensity drives "coolness": flame height, brightness and turbulence all scale
// with it, so a near-full clear roars while a modest one just smoulders.

const TAU = Math.PI * 2;

// Tunables ---------------------------------------------------------------------
export const FLAME_BOX_EXTENT = 2.4; // canvas box size as a multiple of circle diameter (headroom for the upward plume)
const FLAME_TONGUES = 32;            // upward-licking flames around the circle
const LEN_FALLOFF = 1.15;            // how fast flame height falls from top→bottom (higher = sides hug tighter)
const FLAME_HEIGHT = 0.68;           // peak flame length as a multiple of circle radius (lower = shorter/contained)
const RAMP_UP = 7;                   // ease speed toward a higher target
const RAMP_DOWN = 2.6;               // ease speed toward a lower target (slow fade)
const DPR_CAP = 2;

function rand(a, b) { return a + Math.random() * (b - a); }

export class PortraitFlame {
  constructor(parent, options = {}) {
    this.color = options.color || '255, 255, 255';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portrait-flame-canvas';
    this.ctx = this.canvas.getContext('2d');
    if (parent) {
      if (parent.firstChild) parent.insertBefore(this.canvas, parent.firstChild);
      else parent.appendChild(this.canvas);
    }

    this._cssW = 0; this._cssH = 0; this._dpr = 1;
    this._intensity = 0;   // current eased intensity actually drawn
    this._live = 0;        // gameplay heat target (persists until changed)
    this._preview = null;  // editor hold (null = off)
    this._t = 0;           // animation clock (seconds)
    this._raf = null;
    this._lastTs = 0;

    this._tongues = [];
    for (let i = 0; i < FLAME_TONGUES; i++) {
      this._tongues.push({
        phase: rand(0, TAU),
        speed: rand(1.5, 2.9),
        wob: rand(0.78, 1.3),
        hJ: rand(0.72, 1.32),   // per-flame height jitter
        aJit: rand(-0.05, 0.05) // base-angle jitter (breaks the even ring)
      });
    }
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    if (w === this._cssW && h === this._cssH && dpr === this._dpr) return;
    this._cssW = w; this._cssH = h; this._dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  // Live gameplay heat 0..1 — the fire eases toward this and holds until changed.
  setHeat(v) {
    this._live = Math.max(0, Math.min(1, v || 0));
    if (this._live > 0.004) this._ensureRunning();
  }

  // One-shot flare to a level (used rarely; gameplay drives via setHeat).
  ignite(v) { this.setHeat(Math.max(this._live, Math.max(0, Math.min(1, v || 0)))); }

  // Hold a fixed stage for live preview (0..1), or null to release.
  setPreview(stage) {
    this._preview = (stage == null) ? null : Math.max(0, Math.min(1, stage));
    if (this._preview != null) this._ensureRunning();
  }

  _ensureRunning() {
    if (this._raf != null || !this.ctx) return;
    this._lastTs = 0;
    const loop = (ts) => {
      this._raf = null;
      const dt = this._lastTs ? Math.min(0.05, (ts - this._lastTs) / 1000) : 1 / 60;
      this._lastTs = ts;
      if (this._step(dt)) this._raf = requestAnimationFrame(loop);
      else { this._lastTs = 0; this._clearAll(); }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _step(dt) {
    this._t += dt;
    this.resize();
    const target = this._preview != null ? this._preview : this._live;
    const k = target > this._intensity ? RAMP_UP : RAMP_DOWN;
    this._intensity += (target - this._intensity) * Math.min(1, k * dt);
    if (this._intensity < 0.005 && target <= 0) { this._intensity = 0; return false; }
    this._render();
    return true;
  }

  _clearAll() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _render() {
    const ctx = this.ctx;
    if (!ctx || this._cssW <= 0) return;
    const W = this._cssW, H = this._cssH, dpr = this._dpr;
    const I = this._intensity;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (I <= 0) return;

    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) / (2 * FLAME_BOX_EXTENT); // portrait-circle radius
    const col = this.color;
    const T = this._t;

    // Overlapping licks add up to a solid white blaze; soft at the edges.
    ctx.globalCompositeOperation = 'lighter';

    // Faint rounding halo hugging the circle — kept very dim now (just softens the
    // silhouette; no longer a prominent oval). Scales with intensity → fades out.
    const haloR = r * (1.02 + I * 0.32);
    const halo = ctx.createRadialGradient(cx, cy - r * 0.04, r * 0.78, cx, cy - r * 0.04, haloR);
    halo.addColorStop(0, `rgba(${col}, ${0.05 * I})`);
    halo.addColorStop(0.65, `rgba(${col}, ${0.032 * I})`);
    halo.addColorStop(1, `rgba(${col}, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.04, haloR, 0, TAU);
    ctx.fill();

    // Top burning glow — pooled OVER and just above the circle (where most of the
    // fire is) to reinforce the "burning from above" read. No bottom pool.
    const topR = r * (0.72 + I * 0.4);
    const topGlow = ctx.createRadialGradient(cx, cy - r * 0.85, r * 0.12, cx, cy - r * 0.85, topR);
    topGlow.addColorStop(0, `rgba(${col}, ${0.2 * I})`);
    topGlow.addColorStop(0.55, `rgba(${col}, ${0.11 * I})`);
    topGlow.addColorStop(1, `rgba(${col}, 0)`);
    ctx.fillStyle = topGlow;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.85, topR, 0, TAU);
    ctx.fill();

    // Bonfire tongues: root on the circle's perimeter and lick UPWARD. Height
    // peaks over the top, stays tall up the sides, fades to nothing at the
    // bottom (fire rises). Each tongue is a curved, tapering lick — never a
    // straight spike — with live flicker. Length AND alpha scale with intensity
    // so the whole blaze shrinks smoothly to zero on fade-out.
    const maxLen = r * FLAME_HEIGHT * (0.08 + I);
    const baseR = r * 1.02;
    const flameAlpha = Math.min(0.92, I * 1.25);
    for (let i = 0; i < FLAME_TONGUES; i++) {
      const tg = this._tongues[i];
      const a = (i / FLAME_TONGUES) * TAU - Math.PI / 2 + tg.aJit; // start at top
      const up01 = (-Math.sin(a) + 1) / 2;       // 1 at top, 0 at bottom
      const lenProfile = Math.pow(up01, LEN_FALLOFF);
      if (lenProfile < 0.03) continue;            // skip the very bottom

      const tph = T * tg.speed + tg.phase;
      const flick = Math.sin(tph) * 0.5 + Math.sin(tph * 2.7 + 1.3) * 0.28 + Math.sin(tph * 0.6) * 0.22;
      const wave = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tph * 1.6 + 0.5));
      const len = maxLen * lenProfile * tg.hJ * wave;
      if (len < r * 0.04) continue;

      const ca = Math.cos(a), sa = Math.sin(a);
      const bx = cx + ca * baseR, by = cy + sa * baseR;
      const perpX = -sa, perpY = ca; // tangent → flame width direction
      const halfW = r * 0.13 * (0.65 + 0.5 * lenProfile) * tg.wob;

      // Tip rises UP (screen -y) with a lateral, time-varying bend (the lick).
      const bend = flick * len * 0.24;
      const tipX = bx + bend + ca * len * 0.1;  // mostly up, a touch outward + sideways flick
      const tipY = by - len;
      // Curl control point: lifted halfway, pushed sideways → a curved tongue.
      const midX = bx + bend * 0.45 + ca * len * 0.05;
      const midY = by - len * 0.5;

      const g = ctx.createLinearGradient(bx, by, tipX, tipY);
      g.addColorStop(0, `rgba(${col}, ${0.9 * flameAlpha})`);
      g.addColorStop(0.45, `rgba(${col}, ${0.6 * flameAlpha})`);
      g.addColorStop(0.82, `rgba(${col}, ${0.2 * flameAlpha})`);
      g.addColorStop(1, `rgba(${col}, 0)`);
      ctx.fillStyle = g;

      ctx.beginPath();
      ctx.moveTo(bx + perpX * halfW, by + perpY * halfW);
      ctx.quadraticCurveTo(midX + perpX * halfW * 0.55, midY + perpY * halfW * 0.55, tipX, tipY);
      ctx.quadraticCurveTo(midX - perpX * halfW * 0.55, midY - perpY * halfW * 0.55, bx - perpX * halfW, by - perpY * halfW);
      ctx.quadraticCurveTo(cx + ca * (baseR - halfW * 0.4), cy + sa * (baseR - halfW * 0.4), bx + perpX * halfW, by + perpY * halfW);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  dispose() {
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }
}
