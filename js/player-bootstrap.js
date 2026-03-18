// Baked level player — full visual frame + HUD + gamble, no editor/menus/theme panel.
// Supports: single level (hash), level names (?level=), campaigns (?campaign=).
// On defeat: level mirrors horizontally and replays. Second defeat restores original.

import { Game } from './game.js';
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import { GambleSystem } from './gamble-system.js';

const ASPECT_RATIO = 3 / 4.5;
const FRAME_RATIO = 9 / 17;
const WORLD_W = 400;
const WORLD_H = Math.round(WORLD_W / ASPECT_RATIO); // 600

// --- Data loading (multiple sources, priority order) ---

// Decompress level data from URL hash (deflate + base64url)
async function loadFromHash() {
  const hash = location.hash.slice(1);
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

// Load single baked level by name
function loadBakedLevel(name) {
  const stored = localStorage.getItem('baked:' + name);
  if (stored) {
    try { return JSON.parse(stored); } catch { /* fall through */ }
  }
  return null;
}

// Fetch from server (API first, then static file fallback)
async function fetchLevel(name) {
  try {
    const res = await fetch('/api/levels?name=' + encodeURIComponent(name));
    if (res.ok) return await res.json();
  } catch { /* fall through */ }
  try {
    const res = await fetch('/levels/' + encodeURIComponent(name) + '.json');
    if (res.ok) return await res.json();
  } catch { /* fall through */ }
  return null;
}

// Load campaign by name: localStorage → API (resolved) → static file
async function loadCampaign(name) {
  // Try localStorage first
  const stored = localStorage.getItem('campaign:' + name);
  if (stored) {
    try {
      const data = JSON.parse(stored);
      if (data && Array.isArray(data.levels) && data.levels.length > 0) return data;
    } catch { /* fall through */ }
  }
  // Try API (resolves campaign + fetches all level data)
  try {
    const res = await fetch('/api/campaigns?name=' + encodeURIComponent(name) + '&resolve=true');
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.levels) && data.levels.length > 0) return data;
    }
  } catch { /* fall through */ }
  // Fallback: static file
  try {
    const res = await fetch('/campaigns/' + encodeURIComponent(name) + '.json');
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.levels) && data.levels.length > 0) return data;
    }
  } catch { /* fall through */ }
  return null;
}

function getQueryParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

function getRequestedNames() {
  const raw = getQueryParam('level') || getQueryParam('levels');
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function showError(msg) {
  document.body.style.cssText = 'display:flex;justify-content:center;align-items:center;color:#fff;font:18px sans-serif;text-align:center;padding:20px;';
  document.body.textContent = msg;
}

// --- Mirror level data horizontally ---

function mirrorLevel(levelData, canvasWidth = WORLD_W) {
  const m = JSON.parse(JSON.stringify(levelData));

  for (const peg of m.pegs) {
    peg.x = canvasWidth - peg.x;

    if (peg.shape === 'brick') {
      peg.angle = -peg.angle;
    }

    if (peg.curveSlices && peg.curveSlices.length > 0) {
      for (const s of peg.curveSlices) {
        s.x = canvasWidth - s.x;
        s.nx = -s.nx;
      }
      peg.curveSlices.reverse();
    }

    if (peg.animation) {
      if (peg.animation.dx) peg.animation.dx = -peg.animation.dx;
      if (peg.animation.rotation) peg.animation.rotation = -peg.animation.rotation;
    }
  }

  // Mirror group animations
  if (Array.isArray(m.groups)) {
    for (const group of m.groups) {
      if (group.animation) {
        if (group.animation.dx) group.animation.dx = -group.animation.dx;
        if (group.animation.rotation) group.animation.rotation = -group.animation.rotation;
      }
    }
  }

  // Bezier control points (if any)
  if (m.bezierCurves && typeof m.bezierCurves === 'object') {
    for (const key of Object.keys(m.bezierCurves)) {
      const curve = m.bezierCurves[key];
      if (Array.isArray(curve.points)) {
        for (const pt of curve.points) {
          if (typeof pt.x === 'number') pt.x = canvasWidth - pt.x;
        }
      }
    }
  }

  return m;
}

// --- Pause menu ---

function createPauseOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'pause-overlay';
  overlay.id = 'pauseOverlay';
  overlay.innerHTML = `
    <div class="pause-panel">
      <div class="pause-title">Paused</div>
      <button class="pause-btn" id="pauseResumeBtn">Resume</button>
      <button class="pause-btn" id="pauseRestartBtn">Restart Level</button>
    </div>
  `;
  return overlay;
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

  // Priority 2: ?campaign=name → load full campaign
  const campaignName = getQueryParam('campaign');
  if (campaignName) {
    const campaign = await loadCampaign(campaignName);
    if (!campaign) { showError('Campaign not found: ' + campaignName); return; }
    bootWithLevels(campaign.levels, campaign.name);
    return;
  }

  // Priority 3: ?level=name1,name2 → individual baked levels
  const names = getRequestedNames();
  if (names.length === 0) {
    showError('No level specified.\nUse ?level=name, ?campaign=name, or paste a baked URL.');
    return;
  }

  const levels = [];
  for (const name of names) {
    const data = loadBakedLevel(name) || await fetchLevel(name);
    if (!data) { showError('Level not found: ' + name); return; }
    levels.push(data);
  }
  bootWithLevels(levels);
}

async function bootWithLevels(levels, campaignName) {

  const canvas = document.getElementById('gameCanvas');
  canvas.getContext('2d', { alpha: false });

  // Mount visual layout (frame + slots + HUD)
  const visualLayout = new VisualLayout();
  visualLayout.mount();
  visualLayout.setPanelVisible(false);
  visualLayout.setEditMode(false);

  // Create and attach pause overlay
  const pauseOverlay = createPauseOverlay();
  document.body.appendChild(pauseOverlay);

  function resize() {
    const viewport = document.getElementById('visualViewport');
    const frame = document.getElementById('visualFrame');
    if (!viewport || !frame) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Fit 9:17 frame in viewport (mobile: keep full width, compress height if needed)
    let fw = vw;
    let fh = fw / FRAME_RATIO;
    const isNarrow = vw <= 520;
    let compact = false;
    if (fh > vh) {
      if (isNarrow) {
        fh = vh;
        compact = true;
      } else {
        fh = vh;
        fw = fh * FRAME_RATIO;
      }
    }
    fw = Math.floor(fw);
    fh = Math.floor(fh);
    const squeeze = compact ? Math.min(1, fh / (fw / FRAME_RATIO)) : 1;

    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
    frame.style.setProperty('--frame-scale', String(Math.min(1, fw / 444)));
    frame.style.setProperty('--frame-squeeze', squeeze.toFixed(4));
    frame.classList.toggle('visual-frame--compact', compact);

    // Canvas display: 90% of frame width, game aspect ratio
    let displayW = Math.round(fw * 0.9);
    let displayH = Math.round(displayW / ASPECT_RATIO);
    if (displayH > fh) { displayH = fh; displayW = Math.round(displayH * ASPECT_RATIO); }

    // In compact mode: nudge canvas up so bucket clears the gamble dock
    if (compact) {
      const frameScale = Math.min(1, fw / 444);
      const hudSqueeze = Math.max(0.82, squeeze);
      const dockH = Math.ceil(96 * frameScale * hudSqueeze);
      const dockTop = fh - dockH;
      const centeredTop = (fh - displayH) / 2;
      const bucketY = centeredTop + displayH * (585 / WORLD_H);
      let nudge = Math.max(0, Math.ceil(bucketY - dockTop));
      const maxNudge = Math.max(0, Math.floor(centeredTop - 2));
      if (nudge > maxNudge) {
        const availH = dockTop - 2;
        displayH = Math.floor(availH / (585 / WORLD_H));
        displayW = Math.round(displayH * ASPECT_RATIO);
        nudge = 0;
      }
      frame.style.setProperty('--compact-canvas-nudge', nudge + 'px');
    } else {
      frame.style.removeProperty('--compact-canvas-nudge');
    }

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
  let mirrorState = false; // alternates on defeat
  // Deep-clone originals so mirror can always reference pristine data
  const originalLevels = levels.map(l => JSON.parse(JSON.stringify(l)));

  resize();
  window.addEventListener('resize', resize);

  // --- Pause logic ---

  let paused = false;

  function showPause() {
    if (paused || !game) return;
    if (game.state === 'won' || game.state === 'lost') return;
    paused = true;
    game.pause();
    pauseOverlay.classList.add('visible');
  }

  function hidePause() {
    if (!paused) return;
    paused = false;
    pauseOverlay.classList.remove('visible');
    if (game) game.resume();
  }

  function restartFromPause() {
    hidePause();
    startLevel(currentIndex);
  }

  pauseOverlay.querySelector('#pauseResumeBtn').addEventListener('click', hidePause);
  pauseOverlay.querySelector('#pauseRestartBtn').addEventListener('click', restartFromPause);
  // Click on backdrop (outside panel) also resumes
  pauseOverlay.addEventListener('click', (e) => {
    if (e.target === pauseOverlay) hidePause();
  });

  // Make topLeft and leftCircle slots trigger pause in play mode
  function setupPauseTriggers() {
    for (const slotId of ['topLeft', 'leftCircle']) {
      const el = visualLayout.slotElements[slotId];
      if (!el) continue;
      el.classList.add('visual-slot--pause-trigger');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showPause();
      });
      el.addEventListener('touchend', (e) => {
        e.stopPropagation();
        e.preventDefault();
        showPause();
      });
    }
  }
  setupPauseTriggers();

  // --- Gamble system ---

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

  // --- Level lifecycle ---

  function startLevel(index) {
    // Resolve level data (mirror if needed)
    const original = originalLevels[index];
    const levelData = mirrorState ? mirrorLevel(original) : JSON.parse(JSON.stringify(original));

    // Cleanup previous
    teardownGamble();
    if (unsubUiState) { unsubUiState(); unsubUiState = null; }
    if (game) { game.stop(); }
    paused = false;
    pauseOverlay.classList.remove('visible');

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
        if (result === 'won') {
          // Reset mirror for next level
          mirrorState = false;
          if (currentIndex < levels.length - 1) {
            const advance = () => { currentIndex++; startLevel(currentIndex); };
            canvas.addEventListener('click', advance, { once: true });
            canvas.addEventListener('touchstart', advance, { once: true });
          } else {
            // All levels completed — tap to replay from start
            const replay = () => { currentIndex = 0; mirrorState = false; startLevel(0); };
            canvas.addEventListener('click', replay, { once: true });
            canvas.addEventListener('touchstart', replay, { once: true });
          }
        } else {
          // Defeat — toggle mirror and restart same level
          mirrorState = !mirrorState;
          const retry = () => startLevel(currentIndex);
          canvas.addEventListener('click', retry, { once: true });
          canvas.addEventListener('touchstart', retry, { once: true });
        }
      }, 1000);
    };

    resize();
    game.start();
    mountGamble();
  }

  startLevel(0);
}
