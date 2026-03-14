// Baked level player — full visual frame + HUD + gamble, no editor/menus/theme panel.

import { Game } from './game.js';
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import { GambleSystem } from './gamble-system.js';

const ASPECT_RATIO = 3 / 4.5;
const FRAME_RATIO = 9 / 17;
const WORLD_W = 400;
const WORLD_H = Math.round(WORLD_W / ASPECT_RATIO); // 600

// --- Data loading (3 sources, priority order) ---

// 1) Decompress level data from URL hash (deflate + base64url)
async function loadFromHash() {
  const hash = location.hash.slice(1);
  console.log(`[player] hash length: ${hash.length}`);
  if (!hash) return null;
  try {
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const binary = atob(pad);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const decompressed = await new Response(ds.readable).arrayBuffer();
    const json = new TextDecoder().decode(decompressed);
    return JSON.parse(json);
  } catch (e) { console.error('[player] hash decode failed:', e); return null; }
}

// 2) Load by name from localStorage
function loadFromStorage(name) {
  const stored = localStorage.getItem('baked:' + name);
  if (stored) {
    try { return JSON.parse(stored); } catch { /* fall through */ }
  }
  return null;
}

// 3) Fetch from /levels/ (future hosting)
async function loadFromFetch(name) {
  try {
    const res = await fetch('/levels/' + encodeURIComponent(name) + '.json');
    if (res.ok) return await res.json();
  } catch { /* fall through */ }
  return null;
}

function getRequestedNames() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('level') || params.get('levels');
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function showError(msg) {
  document.body.style.cssText = 'display:flex;justify-content:center;align-items:center;color:#fff;font:18px sans-serif;text-align:center;padding:20px;';
  document.body.textContent = msg;
}

// --- Main ---

resolve();

async function resolve() {
  // Priority 1: hash contains full compressed level data
  const hashLevel = await loadFromHash();
  if (hashLevel) {
    bootWithLevels([hashLevel]);
    return;
  }

  // Priority 2+3: ?level=name → localStorage → fetch
  const names = getRequestedNames();
  if (names.length === 0) {
    showError('No level specified.\nUse ?level=name or paste a baked URL.');
    return;
  }

  const levels = [];
  for (const name of names) {
    const data = loadFromStorage(name) || await loadFromFetch(name);
    if (!data) { showError('Level not found: ' + name); return; }
    levels.push(data);
  }
  bootWithLevels(levels);
}

async function bootWithLevels(levels) {

  const canvas = document.getElementById('gameCanvas');
  canvas.getContext('2d', { alpha: false });

  // Mount visual layout (frame + slots + HUD)
  const visualLayout = new VisualLayout();
  visualLayout.mount();
  visualLayout.setPanelVisible(false);
  visualLayout.setEditMode(false);

  function resize() {
    const viewport = document.getElementById('visualViewport');
    const frame = document.getElementById('visualFrame');
    if (!viewport || !frame) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Fit 9:17 frame in viewport
    let fw = vw;
    let fh = fw / FRAME_RATIO;
    if (fh > vh) { fh = vh; fw = fh * FRAME_RATIO; }
    fw = Math.floor(fw);
    fh = Math.floor(fh);

    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
    frame.style.setProperty('--frame-scale', String(Math.min(1, fw / 444)));

    // Canvas display: 90% of frame width, game aspect ratio
    let displayW = Math.round(fw * 0.9);
    let displayH = Math.round(displayW / ASPECT_RATIO);
    if (displayH > fh) { displayH = fh; displayW = Math.round(displayH * ASPECT_RATIO); }

    canvas.width = WORLD_W;
    canvas.height = WORLD_H;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';

    if (game) game.resize(WORLD_W, WORLD_H);
    visualLayout.resize(fw, fh);
  }

  let currentIndex = 0;
  let game = null;
  let gambleSystem = null;
  let unsubUiState = null;

  resize();
  window.addEventListener('resize', resize);

  function mountGamble() {
    if (!game) return;
    gambleSystem = new GambleSystem({
      game,
      levelManager: null,
      statusBar: null,
      pegCountEl: null,
      selectionCountEl: null,
      host: visualLayout.frame,
      visualLayout,
      onLayoutChange: resize
    });
    gambleSystem.mount();
  }

  function teardownGamble() {
    if (gambleSystem) { gambleSystem.dispose(); gambleSystem = null; }
  }

  function startLevel(index) {
    const levelData = levels[index];

    // Cleanup previous
    teardownGamble();
    if (unsubUiState) { unsubUiState(); unsubUiState = null; }
    if (game) { game.stop(); }

    game = new Game(canvas);

    // Apply visuals (background + frame + slots)
    const visuals = normalizeVisuals(levelData.visuals);
    visualLayout.setConfig(visuals);
    game.renderer.setBackground(visuals.background);

    game.loadLevel(levelData);
    if (typeof levelData.aimLength === 'number') {
      game.setAimLength(levelData.aimLength);
    }

    // Subscribe to UI state for ball counter + health bar
    unsubUiState = game.subscribeUiState((snapshot) => {
      if (Number.isFinite(snapshot.ballsLeft)) {
        visualLayout.updateBallCounter(snapshot.ballsLeft, snapshot.initialBallCount);
      }
      if (Number.isFinite(snapshot.orangePegsLeft)) {
        visualLayout.updateHealthBar(snapshot.orangePegsLeft, snapshot.totalOrangePegs);
      }
    });

    game.onGameEnd = (result, score) => {
      setTimeout(() => {
        if (result === 'won' && currentIndex < levels.length - 1) {
          const advance = () => { currentIndex++; startLevel(currentIndex); };
          canvas.addEventListener('click', advance, { once: true });
          canvas.addEventListener('touchstart', advance, { once: true });
        } else {
          const restart = () => startLevel(currentIndex);
          canvas.addEventListener('click', restart, { once: true });
          canvas.addEventListener('touchstart', restart, { once: true });
        }
      }, 1000);
    };

    resize();
    game.start();
    mountGamble();
  }

  startLevel(0);
}
