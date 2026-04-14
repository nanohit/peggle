// ─── Haptic feedback (iOS Safari 18+) ───────────────────────────
// Persistent hidden <input type="checkbox" switch> + <label htmlFor>.
// MUST be called synchronously inside a user gesture (touchend, click).

let hapticLabel = null;

function ensureElements() {
  if (hapticLabel || typeof document === 'undefined' || !document.body) return hapticLabel;
  try {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = '__haptic_switch';
    input.setAttribute('switch', '');
    input.setAttribute('aria-hidden', 'true');
    input.tabIndex = -1;
    input.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

    const label = document.createElement('label');
    label.htmlFor = '__haptic_switch';
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

    document.body.appendChild(input);
    document.body.appendChild(label);
    hapticLabel = label;
  } catch { /* no-op */ }
  return hapticLabel;
}

export function lightTap() {
  const label = ensureElements();
  if (label) {
    try { label.click(); } catch { /* no-op */ }
  }
}

// ─── Sound mute control ────────────────────────────────────────
const MUTE_KEY = 'peggle_soundMuted';
let muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* no-op */ }
}

// ─── Peg hit sounds (Peggle-style ascending scale) ──────────────
// C major diatonic scale, ~3 octaves. Each hit during a shot plays
// the next note. Synth via Web Audio — no sample files needed.

let audioCtx = null;

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch { /* no-op */ }
  return audioCtx;
}

export function initAudio() {
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

// C major scale from C4 up ~3 octaves (22 notes)
const C4 = 261.63;
const SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const SCALE_NOTES = [];
for (let octave = 0; octave < 3; octave++) {
  for (const step of SCALE_STEPS) {
    SCALE_NOTES.push(C4 * Math.pow(2, octave + step / 12));
  }
}
SCALE_NOTES.push(C4 * 8); // C7 cap

let hitIndex = 0;

export function resetHitCounter() {
  hitIndex = 0;
}

const HIT_MIN_INTERVAL_MS = 20;
let lastHitAt = 0;

export function pegHitSound() {
  if (muted) { hitIndex = Math.min(hitIndex + 1, SCALE_NOTES.length - 1); return; }
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }
  if (ctx.state !== 'running') return;

  const now = performance.now();
  if (now - lastHitAt < HIT_MIN_INTERVAL_MS) {
    hitIndex = Math.min(hitIndex + 1, SCALE_NOTES.length - 1);
    return;
  }
  lastHitAt = now;

  const freq = SCALE_NOTES[Math.min(hitIndex, SCALE_NOTES.length - 1)];
  hitIndex++;

  const t = ctx.currentTime;
  const dur = 0.25;
  const vol = 0.08;

  // ── Tone 1: sine fundamental ──
  const osc1 = ctx.createOscillator();
  const g1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.value = freq;
  g1.gain.setValueAtTime(0.001, t);
  g1.gain.linearRampToValueAtTime(vol, t + 0.006);
  g1.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc1.connect(g1);
  g1.connect(ctx.destination);
  osc1.start(t);
  osc1.stop(t + dur);

  // ── Tone 2: slight detune (+3Hz) for chorus shimmer ──
  const osc2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.value = freq + 3;
  g2.gain.setValueAtTime(0.001, t);
  g2.gain.linearRampToValueAtTime(vol * 0.5, t + 0.006);
  g2.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc2.connect(g2);
  g2.connect(ctx.destination);
  osc2.start(t);
  osc2.stop(t + dur);
}
