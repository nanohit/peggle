// Baked level player — full visual frame + HUD + gamble, no editor/menus/theme panel.
// Supports: single level (hash), level names (?level=), campaigns (?campaign=).
// On defeat: level mirrors horizontally and replays. Second defeat restores original.

import { Game } from './game.js';
import { isMuted, setMuted } from './haptics.js';
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import { normalizeLevelData } from './levels.js';
import { DialogueController } from './dialogue-controller.js';
import { GambleSystem } from './gamble-system.js';
import { loadCharacterRegistry, normalizeCharacterRegistry, saveCharacterRegistry, CHARACTER_REGISTRY_STORAGE_KEY } from './character-config.js';
import { PortraitReactionController } from './portrait-reactions.js';
import { getStoredLanguage, getPauseCopy, normalizeLanguage, setStoredLanguage } from './localization.js';
import { topoOrder, buildNodeMap, buildParentMap, buildLevelIndexMap, graphFromLevels } from './graph/core.js';
import { validateGraph } from './graph/validate.js';
import { resolveWin, findNextNode, migrateProgress, isUnlocked } from './graph/progression.js';

const ASPECT_RATIO = 3 / 4.5;
const FRAME_RATIO = 9 / 17;
const WORLD_W = 400;
const WORLD_H = Math.round(WORLD_W / ASPECT_RATIO); // 600
let levelMapModulePromise = null;
let levelMapCtorPromise = null;
let levelMapCssPromise = null;
function ensureLevelMapCss() {
  if (!levelMapCssPromise) {
    levelMapCssPromise = new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'css/level-map.css';
      link.onload = () => resolve();
      link.onerror = () => {
        // Clear cache so next call retries; remove failed <link> so we don't accumulate stale nodes
        levelMapCssPromise = null;
        if (link.parentNode) link.parentNode.removeChild(link);
        resolve(); // Don't block the JS module — map can render unstyled rather than not at all
      };
      document.head.appendChild(link);
    });
  }
  return levelMapCssPromise;
}
function getLevelMapModule() {
  if (!levelMapModulePromise) {
    levelMapModulePromise = Promise.all([
      import('./level-map.js'),
      ensureLevelMapCss()
    ]).then(([mod]) => mod).catch(err => {
      // Allow retry on next call (network/CDN may have recovered)
      levelMapModulePromise = null;
      levelMapCtorPromise = null;
      throw err;
    });
  }
  return levelMapModulePromise;
}
function getLevelMapCtor() {
  if (!levelMapCtorPromise) {
    levelMapCtorPromise = getLevelMapModule().then(mod => mod.LevelMap).catch(err => {
      levelMapCtorPromise = null;
      throw err;
    });
  }
  return levelMapCtorPromise;
}
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
    return normalizeLevelData(JSON.parse(json));
  } catch (e) { console.error('[player] hash decode failed:', e); return null; }
}

// Load single baked level by name
function loadBakedLevel(name) {
  const stored = localStorage.getItem('baked:' + name);
  if (stored) {
    try { return normalizeLevelData(JSON.parse(stored)); } catch { /* fall through */ }
  }
  return null;
}

// Fetch from server (API first, then static file fallback)
async function fetchLevel(name) {
  try {
    const res = await fetch('/api/levels?name=' + encodeURIComponent(name));
    if (res.ok) return normalizeLevelData(await res.json());
  } catch { /* fall through */ }
  try {
    const res = await fetch('/levels/' + encodeURIComponent(name) + '.json');
    if (res.ok) return normalizeLevelData(await res.json());
  } catch { /* fall through */ }
  return null;
}

// Load campaign by name: localStorage cache (if fresh) → API → static file
// Cache TTL: 60 seconds. After that, re-fetch from API to pick up editor changes.
const CAMPAIGN_CACHE_TTL = 60 * 1000; // 60 seconds
const inflightCampaignLoads = new Map();
function hasCampaignLevels(data) {
  return !!(data && Array.isArray(data.levels) && data.levels.length > 0);
}

async function loadCampaign(name) {
  if (inflightCampaignLoads.has(name)) return inflightCampaignLoads.get(name);
  const task = (async () => {
    const cacheKey = 'campaign:' + name;
    const cacheTimeKey = 'campaign_ts:' + name;

    // Try localStorage cache first (if fresh enough)
    const stored = localStorage.getItem(cacheKey);
    const cachedAt = parseInt(localStorage.getItem(cacheTimeKey) || '0', 10);
    if (stored && (Date.now() - cachedAt) < CAMPAIGN_CACHE_TTL) {
      try {
        const data = JSON.parse(stored);
        if (hasCampaignLevels(data)) return data;
      } catch { /* fall through */ }
    }

    // Fetch from API (resolves campaign + all level data from Redis)
    try {
      const res = await fetch('/api/campaigns?name=' + encodeURIComponent(name) + '&resolve=true');
      if (res.ok) {
        const data = await res.json();
        if (hasCampaignLevels(data)) {
          // Cache for next visit
          try {
            localStorage.setItem(cacheKey, JSON.stringify(data));
            localStorage.setItem(cacheTimeKey, String(Date.now()));
          } catch { /* storage full, no big deal */ }
          return data;
        }
      }
    } catch { /* fall through */ }

    // Stale localStorage cache (better than nothing)
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (hasCampaignLevels(data)) return data;
      } catch { /* fall through */ }
    }

    // Fallback: static file
    try {
      const res = await fetch('/campaigns/' + encodeURIComponent(name) + '.json');
      if (res.ok) {
        const data = await res.json();
        if (hasCampaignLevels(data)) return data;
      }
    } catch { /* fall through */ }
    return null;
  })();
  inflightCampaignLoads.set(name, task);
  try {
    return await task;
  } finally {
    inflightCampaignLoads.delete(name);
  }
}

// Load primary campaign (for player domains with no URL params)
// Caches the primary campaign name locally to avoid extra API call on repeat visits.
async function loadPrimaryCampaign() {
  const cacheKey = 'config:primaryCampaign';
  const cacheTimeKey = 'config_ts:primaryCampaign';
  const cachedAt = parseInt(localStorage.getItem(cacheTimeKey) || '0', 10);
  const cached = localStorage.getItem(cacheKey);
  const cacheFresh = !!(cached && (Date.now() - cachedAt) < CAMPAIGN_CACHE_TTL);

  const storeResolvedPrimary = (data) => {
    if (!data?.name) return;
    try {
      localStorage.setItem(cacheKey, data.name);
      localStorage.setItem(cacheTimeKey, String(Date.now()));
      localStorage.setItem('campaign:' + data.name, JSON.stringify(data));
      localStorage.setItem('campaign_ts:' + data.name, String(Date.now()));
    } catch { /* storage full */ }
  };

  // Single-request fast path: server resolves configured primary campaign directly.
  if (!cacheFresh) {
    const preloaded = typeof window !== 'undefined' ? window.__PEGGLE_PRIMARY_CAMPAIGN_PRELOAD__ : null;
    if (preloaded && typeof preloaded.then === 'function') {
      try {
        const data = await preloaded;
        if (hasCampaignLevels(data)) {
          storeResolvedPrimary(data);
          return data;
        }
      } catch { /* fall through */ }
    }

    try {
      const res = await fetch('/api/campaigns?primary=true&resolve=true');
      if (res.ok) {
        const data = await res.json();
        if (hasCampaignLevels(data)) {
          storeResolvedPrimary(data);
          return data;
        }
      }
    } catch { /* fall through */ }
  }

  let primaryName = cacheFresh ? cached : null;
  if (!primaryName) {
    try {
      const res = await fetch('/api/config?key=primaryCampaign');
      if (res.ok) {
        const { value } = await res.json();
        primaryName = value || null;
        if (primaryName) {
          localStorage.setItem(cacheKey, primaryName);
          localStorage.setItem(cacheTimeKey, String(Date.now()));
        }
      }
    } catch { /* fall through */ }
    if (!primaryName && cached) primaryName = cached;
  }

  if (!primaryName) return null;
  return await loadCampaign(primaryName);
}

function getQueryParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

async function fetchCharacterRegistryWithFallback(timeoutMs = 2000) {
  const localFallback = () => loadCharacterRegistry();
  if (typeof fetch !== 'function') return localFallback();
  try {
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    const res = await fetch('/api/characters', ctrl ? { signal: ctrl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return localFallback();
    const remote = await res.json();
    if (!remote || typeof remote !== 'object') return localFallback();
    const normalized = normalizeCharacterRegistry(remote);
    try {
      saveCharacterRegistry(normalized);
    } catch (e) {
      console.warn('[player] character registry cache write failed', e);
    }
    return normalized;
  } catch (e) {
    return localFallback();
  }
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

function cloneLevelData(levelData) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(levelData);
    } catch { /* fall back to JSON clone for legacy payloads */ }
  }
  return JSON.parse(JSON.stringify(levelData));
}

function mirrorLevel(levelData, canvasWidth = WORLD_W) {
  const m = cloneLevelData(levelData);

  for (const peg of m.pegs) {
    peg.x = canvasWidth - peg.x;

    if (peg.shape === 'brick') {
      peg.angle = -peg.angle;
    } else if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
      peg.angle = -(peg.angle || 0);
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

  // Mirror background
  if (m.visuals && m.visuals.background) {
    m.visuals.background.mirrored = true;
  }

  return m;
}

// --- Pause menu ---

function createPauseOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'pause-overlay';
  overlay.id = 'pauseOverlay';

  const BASE = 'visuals/pause_menu/webp/';

  overlay.innerHTML = `
    <div class="pause-panel">
      <img class="pause-bg" data-src="${BASE}pause_modal_background.webp" alt="" draggable="false">
      <div class="pause-content">
        <div class="pause-title" id="pauseTitleText">Пауза</div>
        <button class="pause-img-btn" id="pauseResumeBtn">
          <img class="pause-img-btn__normal" data-src="${BASE}continue.webp" alt="Продолжить" draggable="false">
          <img class="pause-img-btn__pressed" data-src="${BASE}continue_pressed1.webp" alt="" draggable="false">
        </button>
        <button class="pause-img-btn" id="pauseRestartBtn">
          <img class="pause-img-btn__normal" data-src="${BASE}again.webp" alt="Заново" draggable="false">
          <img class="pause-img-btn__pressed" data-src="${BASE}again_pressed.webp" alt="" draggable="false">
        </button>
        <div class="pause-hint">
          <span class="pause-hint__text" id="pauseHintText">Второе нажатие<br>для выстрела</span>
          <label class="pause-check" id="pauseConfirmCheck">
            <input type="checkbox" id="pauseConfirmInput">
            <img class="pause-check__off" data-src="${BASE}check.webp" alt="" draggable="false">
            <img class="pause-check__on" data-src="${BASE}check_checked.webp" alt="" draggable="false">
          </label>
        </div>
        <div class="pause-lang">
          <span class="pause-lang__label" id="pauseLanguageLabel">Язык</span>
          <div class="pause-lang__switch">
            <button type="button" class="pause-lang__btn" data-lang="ru">RU</button>
            <button type="button" class="pause-lang__btn" data-lang="en">EN</button>
          </div>
        </div>
        <button class="pause-img-btn" id="pauseLevelBtn">
          <img class="pause-img-btn__normal" data-src="${BASE}level.webp" alt="Уровни" draggable="false">
          <img class="pause-img-btn__pressed" data-src="${BASE}level_pressed.webp" alt="" draggable="false">
        </button>
      </div>
      <button class="pause-sound-btn" id="pauseSoundBtn">
        <img class="pause-sound-btn__on" data-src="visuals/pause_menu/sound_on.webp" alt="Звук вкл" draggable="false">
        <img class="pause-sound-btn__off" data-src="visuals/pause_menu/sound_off.webp" alt="Звук выкл" draggable="false">
      </button>
    </div>
  `;
  return overlay;
}

function loadDeferredImages(root) {
  if (!root?.querySelectorAll) return;
  for (const img of root.querySelectorAll('img[data-src]')) {
    const src = img.dataset.src;
    if (!src) continue;
    img.decoding = 'async';
    img.src = src;
    delete img.dataset.src;
  }
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
    bootWithLevels(campaign.levels, campaign.name, campaign);
    return;
  }

  // Priority 3: ?level=name1,name2 → individual baked levels
  const names = getRequestedNames();
  if (names.length === 0) {
    // Priority 4: no params → load configured primary campaign
    const primaryCampaign = await loadPrimaryCampaign();
    if (primaryCampaign) {
      bootWithLevels(primaryCampaign.levels, primaryCampaign.name, primaryCampaign);
      return;
    }
    showError('No level specified.\nUse ?level=name, ?campaign=name, or paste a baked URL.');
    return;
  }

  const fetched = await Promise.all(names.map(async (name) => {
    const baked = loadBakedLevel(name);
    const data = baked || await fetchLevel(name);
    return { name, data };
  }));
  for (const entry of fetched) {
    if (!entry.data) { showError('Level not found: ' + entry.name); return; }
  }
  const levels = fetched.map(entry => entry.data);
  bootWithLevels(levels);
}

async function bootWithLevels(levels, campaignName, campaignData) {

  const canvas = document.getElementById('gameCanvas');
  canvas.getContext('2d', { alpha: false });

  // Mount visual layout (frame + slots + HUD)
  const visualLayout = new VisualLayout({
    includePanel: false,
    enableEditorInteractions: false
  });
  visualLayout.mount();
  visualLayout.setEditMode(false);
  const dialogueController = new DialogueController({ visualLayout, persistSeen: true });
  // Pull the latest character registry from the server (best-effort, bounded
  // 2s timeout). Falls back to whatever's in localStorage on failure. Per-
  // level snapshots no longer carry slot images, so the registry is the only
  // source of emotion assets at runtime.
  const characterRegistry = await fetchCharacterRegistryWithFallback();
  const portraitReactionController = new PortraitReactionController({ visualLayout });
  dialogueController.setPortraitReactionController(portraitReactionController);
  dialogueController.mount();
  let currentLanguage = getStoredLanguage();
  dialogueController.setLanguage(currentLanguage);

  // Create and attach pause overlay (inside the visual frame so it covers the game area)
  const pauseOverlay = createPauseOverlay();
  visualLayout.frame.appendChild(pauseOverlay);
  let pauseAssetsWarmHandle = null;
  let pauseAssetsLoaded = false;
  function ensurePauseAssetsLoaded() {
    if (pauseAssetsLoaded) return;
    pauseAssetsLoaded = true;
    loadDeferredImages(pauseOverlay);
  }
  function schedulePauseAssetsWarmup() {
    if (pauseAssetsLoaded || pauseAssetsWarmHandle !== null) return;
    const run = () => {
      pauseAssetsWarmHandle = null;
      ensurePauseAssetsLoaded();
    };
    if (typeof window.requestIdleCallback === 'function') {
      pauseAssetsWarmHandle = window.requestIdleCallback(run, { timeout: 4200 });
    } else {
      pauseAssetsWarmHandle = window.setTimeout(run, 2600);
    }
  }

  function applyLanguage(nextLanguage) {
    currentLanguage = normalizeLanguage(nextLanguage);
    document.documentElement.lang = currentLanguage;
    const copy = getPauseCopy(currentLanguage);
    const titleEl = pauseOverlay.querySelector('#pauseTitleText');
    const hintEl = pauseOverlay.querySelector('#pauseHintText');
    const labelEl = pauseOverlay.querySelector('#pauseLanguageLabel');
    if (titleEl) titleEl.textContent = copy.pauseTitle;
    if (hintEl) hintEl.innerHTML = copy.confirmShootHint.replace(/\n/g, '<br>');
    if (labelEl) labelEl.textContent = copy.languageLabel;
    for (const button of pauseOverlay.querySelectorAll('.pause-lang__btn')) {
      button.classList.toggle('active', button.dataset.lang === currentLanguage);
    }
    dialogueController.setLanguage(currentLanguage);
  }

  for (const button of pauseOverlay.querySelectorAll('.pause-lang__btn')) {
    button.addEventListener('click', () => {
      applyLanguage(setStoredLanguage(button.dataset.lang));
    });
  }
  applyLanguage(currentLanguage);

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
    dialogueController.refreshLayout();
  }

  // --- Graph setup ---
  const campaignGraph = (typeof campaignData?.graph === 'object' && campaignData.graph.nodes)
    ? campaignData.graph
    : graphFromLevels(levels);

  validateGraph(campaignGraph);
  const nodeMap = buildNodeMap(campaignGraph);
  const graphParentMap = buildParentMap(campaignGraph);
  const nodeIdToLevelIndex = buildLevelIndexMap(campaignGraph, levels);
  const playOrder = topoOrder(campaignGraph, true);
  const playableOrder = playOrder.filter(nid => nodeIdToLevelIndex.has(nid));

  if (playableOrder.length === 0) {
    showError('Campaign graph is empty or malformed — no playable levels found.');
    return;
  }

  // --- Progress ---
  const progressKey = campaignName ? 'peggle_progress:' + campaignName : null;
  let completedNodes, achievedNodes, currentNodeId;
  {
    let saved = null;
    if (progressKey) {
      try { saved = JSON.parse(localStorage.getItem(progressKey)); } catch { /* ignore */ }
    }
    const migrated = migrateProgress(saved, playableOrder, nodeMap);
    completedNodes = new Set([...migrated.completedNodes].filter(nid => nodeMap.has(nid)));
    achievedNodes = new Set(
      (Array.isArray(saved?.achievedNodeIds) ? saved.achievedNodeIds : [])
        .filter(nid => nodeMap.has(nid))
    );
    for (const nid of completedNodes) achievedNodes.add(nid);
    currentNodeId = migrated.currentNodeId
      ?? findNextNode(playableOrder, graphParentMap, completedNodes)
      ?? playableOrder[0];
    if (!nodeIdToLevelIndex.has(currentNodeId)) {
      currentNodeId = findNextNode(playableOrder, graphParentMap, completedNodes) ?? playableOrder[0];
    }
  }

  let game = null;
  let gambleSystem = null;
  let unsubUiState = null;
  let mirrorState = false; // alternates on defeat
  // Keep the campaign payload pristine; clone only the level that is about to run.
  const originalLevels = levels;

  function saveProgress() {
    if (!progressKey) return;
    localStorage.setItem(progressKey, JSON.stringify({
      completedNodeIds: [...completedNodes],
      achievedNodeIds: [...achievedNodes],
      currentNodeId
    }));
  }

  function mapCompletedNodes() {
    return new Set([...completedNodes, ...achievedNodes]);
  }

  resize();
  window.addEventListener('resize', resize);

  let levelMapPrewarmHandle = null;
  let levelMapPrewarmHandleType = '';
  let levelMapShellPrewarmStarted = false;
  let levelMapFullPrewarmStarted = false;
  function cancelScheduledLevelMapPrewarm() {
    if (levelMapPrewarmHandle === null) return;
    if (levelMapPrewarmHandleType === 'idle' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(levelMapPrewarmHandle);
    } else {
      window.clearTimeout(levelMapPrewarmHandle);
    }
    levelMapPrewarmHandle = null;
    levelMapPrewarmHandleType = '';
  }

  function runLevelMapPrewarm(options = {}) {
    const includePortraits = options.includePortraits === true;
    cancelScheduledLevelMapPrewarm();
    if (includePortraits ? levelMapFullPrewarmStarted : levelMapShellPrewarmStarted) return;
    levelMapShellPrewarmStarted = true;
    if (includePortraits) levelMapFullPrewarmStarted = true;
    getLevelMapModule()
      .then(mod => mod.prewarmLevelMapAssets?.(levels, campaignGraph, { includePortraits }))
      .catch(error => {
        if (includePortraits) levelMapFullPrewarmStarted = false;
        if (!levelMapFullPrewarmStarted) levelMapShellPrewarmStarted = false;
        console.warn('[player] Level map prewarm failed', error);
      });
  }

  function scheduleLevelMapPrewarm(options = {}) {
    const includePortraits = options.includePortraits === true;
    if (includePortraits ? levelMapFullPrewarmStarted : levelMapShellPrewarmStarted) return;
    if (options.immediate) {
      runLevelMapPrewarm({ includePortraits });
      return;
    }
    if (levelMapPrewarmHandle !== null) return;
    const run = () => runLevelMapPrewarm({ includePortraits });
    if (typeof window.requestIdleCallback === 'function') {
      levelMapPrewarmHandleType = 'idle';
      levelMapPrewarmHandle = window.requestIdleCallback(run, { timeout: 3600 });
    } else {
      levelMapPrewarmHandleType = 'timer';
      levelMapPrewarmHandle = window.setTimeout(run, 2200);
    }
  }
  scheduleLevelMapPrewarm({ includePortraits: false });

  // --- Pause logic ---

  let paused = false;

  function showPause() {
    if (paused || !game) return;
    if (game.isEndSequenceActive?.() || game.state === 'won' || game.state === 'lost') return;
    ensurePauseAssetsLoaded();
    paused = true;
    game.pause();
    portraitReactionController.setPaused(true);
    pauseOverlay.classList.remove('pause-overlay--map-mode');
    pauseOverlay.classList.remove('pause-overlay--instant');
    pauseOverlay.classList.add('visible');
    visualLayout.frame.classList.add('visual-frame--paused');
    requestAnimationFrame(() => {
      scheduleLevelMapPrewarm({ immediate: true, includePortraits: true });
    });
  }

  function hidePause(options = {}) {
    const fromMap = !!options.fromMap;
    if (!paused) return;
    paused = false;
    if (fromMap) pauseOverlay.classList.add('pause-overlay--instant');
    pauseOverlay.classList.remove('visible');
    pauseOverlay.classList.remove('pause-overlay--map-mode');
    if (!fromMap) pauseOverlay.classList.remove('pause-overlay--instant');
    visualLayout.frame.classList.remove('visual-frame--paused');
    portraitReactionController.setPaused(false);
    if (fromMap) {
      requestAnimationFrame(() => {
        pauseOverlay.classList.remove('pause-overlay--instant');
      });
    }
    if (game) game.resume();
  }

  function restartFromPause() {
    hidePause();
    startLevel(currentNodeId);
  }

  function goToMenu() {
    const campaignParam = new URLSearchParams(location.search).get('campaign');
    if (campaignParam) {
      location.href = location.pathname + '?campaign=' + encodeURIComponent(campaignParam) + '&select=1';
    } else {
      location.href = location.pathname;
    }
  }

  pauseOverlay.querySelector('#pauseResumeBtn').addEventListener('click', hidePause);
  pauseOverlay.querySelector('#pauseRestartBtn').addEventListener('click', restartFromPause);

  // Sound toggle
  const soundBtn = pauseOverlay.querySelector('#pauseSoundBtn');
  function updateSoundBtn() {
    soundBtn.classList.toggle('muted', isMuted());
  }
  updateSoundBtn();
  soundBtn.addEventListener('click', () => {
    setMuted(!isMuted());
    updateSoundBtn();
  });

  // Level list button — show level map overlay
  let activeLevelMap = null;
  let activeLevelMapAllowClose = false;
  let levelMapOpening = false;
  const LEVEL_MAP_EXIT_ICON = 'visuals/assets_webtp/left_circle_cross.webp';

  function setHudLockedByMap(locked) {
    if (gambleSystem?.ui?.root) {
      gambleSystem.ui.root.style.pointerEvents = locked ? 'none' : '';
      gambleSystem.ui.root.style.opacity = locked ? '0' : '';
    }
  }

  function setLevelMapMode(active) {
    if (visualLayout?.frame) {
      visualLayout.frame.classList.toggle('visual-frame--level-map-open', !!active);
    }
  }

  function setLevelMapExitVisual(active) {
    const leftCircleEl = visualLayout.slotElements?.leftCircle;
    if (!leftCircleEl) return;
    if (active) {
      leftCircleEl.dataset.levelMapExit = '1';
      leftCircleEl.style.backgroundImage = `url('${LEVEL_MAP_EXIT_ICON}')`;
      return;
    }
    if (!leftCircleEl.dataset.levelMapExit) return;
    delete leftCircleEl.dataset.levelMapExit;
    const restoreUrl = visualLayout.getSlotAssetUrl('leftCircle');
    leftCircleEl.style.backgroundImage = restoreUrl ? `url('${restoreUrl}')` : '';
  }

  function getLevelMapBoundsRect() {
    const frame = visualLayout?.frame;
    if (!frame) return null;
    const frameRect = frame.getBoundingClientRect();

    const leftCol = visualLayout?.slotElements?.columnLeft;
    const rightCol = visualLayout?.slotElements?.columnRight;
    if (leftCol && rightCol) {
      const leftRect = leftCol.getBoundingClientRect();
      const rightRect = rightCol.getBoundingClientRect();
      const inset = 2;
      const left = Math.max(0, Math.round(leftRect.right - frameRect.left) + inset);
      const right = Math.min(Math.round(frameRect.width), Math.round(rightRect.left - frameRect.left) - inset);
      const width = Math.max(0, right - left);
      if (width > 0) {
        return { left, top: 0, width, height: Math.round(frameRect.height) };
      }
    }

    // Fallback: match canvas width but fill full frame height.
    const canvasRect = canvas.getBoundingClientRect();
    const left = Math.max(0, Math.round(canvasRect.left - frameRect.left));
    const width = Math.min(Math.round(frameRect.width), Math.round(canvasRect.width));
    return { left, top: 0, width, height: Math.round(frameRect.height) };
  }

  function getLevelMapContentInsetTop(boundsRect) {
    const frame = visualLayout?.frame;
    const topEl = visualLayout?.slotElements?.top;
    if (!frame || !topEl) return 0;
    const frameRect = frame.getBoundingClientRect();
    const topRect = topEl.getBoundingClientRect();
    const overlayTop = Math.round(boundsRect?.top || 0);
    const topBottom = Math.round(topRect.bottom - frameRect.top);
    const inset = topBottom - overlayTop + 8;
    return Math.max(0, Math.min(220, inset));
  }

  function showPauseOverlayInstant() {
    pauseOverlay.classList.add('pause-overlay--instant');
    pauseOverlay.classList.remove('pause-overlay--map-mode');
    pauseOverlay.classList.add('visible');
    visualLayout.frame.classList.add('visual-frame--paused');
    requestAnimationFrame(() => {
      pauseOverlay.classList.remove('pause-overlay--instant');
    });
  }

  function closeLevelMapToPause() {
    if (!activeLevelMap || !activeLevelMapAllowClose) return;
    // Return straight to pause menu with no intermediate dark fade.
    showPauseOverlayInstant();
    activeLevelMap.hide();
    activeLevelMap = null;
    activeLevelMapAllowClose = false;
    setLevelMapMode(false);
    setLevelMapExitVisual(false);
    setHudLockedByMap(false);
  }

  async function showLevelMap(onSelectOverride, options = {}) {
    if (activeLevelMap || levelMapOpening) return;
    scheduleLevelMapPrewarm({ immediate: true, includePortraits: true });
    levelMapOpening = true;
    try {
      await openLevelMap(onSelectOverride, options);
    } finally {
      levelMapOpening = false;
    }
  }

  async function openLevelMap(onSelectOverride, options = {}) {
    const allowClose = options.allowClose !== false;
    const fallbackNodeId = options.fallbackNodeId;
    if (activeLevelMap) return;
    activeLevelMapAllowClose = allowClose;
    // Map is shown over gameplay area (not over pause panel).
    pauseOverlay.classList.remove('pause-overlay--map-mode');
    if (allowClose) {
      // Keep pause overlay mounted but visually transparent during map mode:
      // this avoids re-animating/repainting pause panel on return.
      pauseOverlay.classList.add('pause-overlay--instant');
      pauseOverlay.classList.add('visible');
      pauseOverlay.classList.add('pause-overlay--map-mode');
      requestAnimationFrame(() => {
        pauseOverlay.classList.remove('pause-overlay--instant');
      });
    } else {
      pauseOverlay.classList.remove('visible');
    }
    visualLayout.frame.classList.remove('visual-frame--paused');
    setLevelMapMode(true);
    setHudLockedByMap(true);
    setLevelMapExitVisual(allowClose);

    let LevelMapCtor = null;
    try {
      LevelMapCtor = await getLevelMapCtor();
    } catch (error) {
      console.error('[player] Failed to load level map module', error);
      activeLevelMapAllowClose = false;
      setLevelMapMode(false);
      setLevelMapExitVisual(false);
      setHudLockedByMap(false);
      if (allowClose) {
        pauseOverlay.classList.remove('pause-overlay--map-mode');
        pauseOverlay.classList.add('visible');
        visualLayout.frame.classList.add('visual-frame--paused');
      } else if (typeof fallbackNodeId === 'number' && typeof onSelectOverride === 'function') {
        await Promise.resolve(onSelectOverride(fallbackNodeId));
      }
      return;
    }
    if (activeLevelMap) return;

    const boundsRect = getLevelMapBoundsRect();
    const mapInstance = new LevelMapCtor({
      levels,
      graph: campaignGraph,
      completedNodes: mapCompletedNodes(),
      currentNodeId,
      boundsRect,
      contentInsetTop: getLevelMapContentInsetTop(boundsRect),
      closable: allowClose,
      onSelect: onSelectOverride || (async (nodeId) => {
        if (!nodeIdToLevelIndex.has(nodeId)) return;
        const isCurrent = String(nodeId) === String(currentNodeId);
        if (isCurrent && allowClose) {
          // Resume current run without restart.
          // Hide pause instantly first, then fade map out as a visual bridge.
          const closingMap = activeLevelMap;
          if (!closingMap) return;
          pauseOverlay.classList.add('pause-overlay--instant');
          pauseOverlay.classList.remove('visible');
          pauseOverlay.classList.remove('pause-overlay--map-mode');
          visualLayout.frame.classList.remove('visual-frame--paused');
          paused = false;
          portraitReactionController.setPaused(false);
          if (game) game.resume();
          await closingMap.hide({ fadeMs: 120 });
          activeLevelMap = null;
          activeLevelMapAllowClose = false;
          setLevelMapMode(false);
          setLevelMapExitVisual(false);
          setHudLockedByMap(false);
          requestAnimationFrame(() => {
            pauseOverlay.classList.remove('pause-overlay--instant');
          });
          return;
        }
        const closingMap = activeLevelMap;
        if (!closingMap) return;
        await closingMap.hide();
        activeLevelMap = null;
        activeLevelMapAllowClose = false;
        setLevelMapMode(false);
        setLevelMapExitVisual(false);
        setHudLockedByMap(false);
        paused = false;
        if (nodeId !== currentNodeId) {
          currentNodeId = nodeId;
          mirrorState = false;
          saveProgress();
        }
        startLevel(currentNodeId);
      }),
      onClose: () => {
        if (!allowClose) return;
        closeLevelMapToPause();
      }
    });
    activeLevelMap = mapInstance;

    const mapHost = visualLayout.frame || canvas.parentElement;
    try {
      await mapInstance.show(mapHost);
    } catch (error) {
      console.error('[player] Level map render failed', error);
      if (activeLevelMap === mapInstance) {
        activeLevelMap = null;
        activeLevelMapAllowClose = false;
        setLevelMapMode(false);
        setLevelMapExitVisual(false);
        setHudLockedByMap(false);
        pauseOverlay.classList.remove('pause-overlay--map-mode');
        if (allowClose) {
          pauseOverlay.classList.add('visible');
          visualLayout.frame.classList.add('visual-frame--paused');
        } else if (typeof fallbackNodeId === 'number' && typeof onSelectOverride === 'function') {
          await Promise.resolve(onSelectOverride(fallbackNodeId));
        }
      }
      return;
    }
    // If map was closed while assets were loading, avoid stale locked state.
    if (activeLevelMap !== mapInstance || !mapInstance.visible) {
      if (activeLevelMap === mapInstance) {
        activeLevelMap = null;
        activeLevelMapAllowClose = false;
        setLevelMapMode(false);
        setLevelMapExitVisual(false);
        setHudLockedByMap(false);
        if (allowClose) {
          pauseOverlay.classList.remove('pause-overlay--map-mode');
          pauseOverlay.classList.add('visible');
          visualLayout.frame.classList.add('visual-frame--paused');
        }
      }
    }
  }

  const pauseLevelBtn = pauseOverlay.querySelector('#pauseLevelBtn');
  pauseLevelBtn.addEventListener('pointerenter', () => scheduleLevelMapPrewarm({ immediate: true, includePortraits: true }));
  pauseLevelBtn.addEventListener('touchstart', () => scheduleLevelMapPrewarm({ immediate: true, includePortraits: true }), { passive: true });
  pauseLevelBtn.addEventListener('click', () => showLevelMap());
  // Confirm-shoot checkbox (second tap to fire)
  const confirmInput = pauseOverlay.querySelector('#pauseConfirmInput');
  confirmInput.checked = !!localStorage.getItem('peggle_confirmShoot');
  confirmInput.addEventListener('change', () => {
    if (confirmInput.checked) {
      localStorage.setItem('peggle_confirmShoot', '1');
    } else {
      localStorage.removeItem('peggle_confirmShoot');
    }
    if (game) {
      game.confirmShoot = confirmInput.checked;
      // Reset aiming state so the mode switch applies cleanly
      if (game.isAimingState()) {
        game.state = 'idle';
        game.trajectory = null;
      }
    }
  });
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
        if (activeLevelMap) {
          closeLevelMapToPause();
          return;
        }
        showPause();
      });
      el.addEventListener('touchend', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (activeLevelMap) {
          closeLevelMapToPause();
          return;
        }
        showPause();
      });
    }

    const topRight = visualLayout.slotElements.topRight;
    if (topRight) {
      topRight.classList.add('visual-slot--pause-trigger');
      const onMenu = (e) => {
        if (activeLevelMap) return;
        e.stopPropagation();
        e.preventDefault();
        goToMenu();
      };
      topRight.addEventListener('click', onMenu);
      topRight.addEventListener('touchend', onMenu);
    }
  }
  setupPauseTriggers();

  // --- Gamble system ---
  function ensureGambleSystem() {
    if (gambleSystem) return gambleSystem;
    gambleSystem = new GambleSystem({
      game: null,
      levelManager: null,
      statusBar: null,
      pegCountEl: null,
      selectionCountEl: null,
      host: visualLayout.frame,
      visualLayout,
      onLayoutChange: resize,
      allowSettings: false
    });
    gambleSystem.mount();
    dialogueController.setGambleSystem(gambleSystem);
    return gambleSystem;
  }

  function bindGambleSystem(nextGame, options = {}) {
    const system = ensureGambleSystem();
    system.setGame(nextGame, {
      reloadSettings: true,
      resetRuntime: true,
      collapsePanel: true,
      ...options
    });
    dialogueController.setGambleSystem(system);
    portraitReactionController.setGambleSystem(system);
    return system;
  }

  // --- Transition animation (level complete -> next level) ---
  const LEVEL_SCROLL_MS = 760;
  const PORTRAIT_SCROLL_SLOTS = ['character', 'characterCircle', 'healthCharCircle'];
  let transitionOverlay = null;
  let transitionTimer = null;

  function clearPortraitScrollFx() {
    if (!visualLayout) return;
    for (const slotId of PORTRAIT_SCROLL_SLOTS) {
      visualLayout.clearSlotRuntimeFx(slotId);
    }
  }

  function setPortraitScrollFx(offsetY) {
    if (!visualLayout) return;
    for (const slotId of PORTRAIT_SCROLL_SLOTS) {
      if (!visualLayout.slotElements?.[slotId]) continue;
      visualLayout.setSlotRuntimeFx(slotId, { translateY: offsetY });
    }
  }

  function clearLevelTransitionArtifacts() {
    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    if (transitionOverlay?.parentNode) {
      transitionOverlay.parentNode.removeChild(transitionOverlay);
    }
    transitionOverlay = null;
    canvas.style.transition = '';
    canvas.style.transform = '';
    clearPortraitScrollFx();
  }

  function transitionToLevel(nodeId) {
    const frame = visualLayout.frame;
    if (!frame) {
      startLevel(nodeId, { suppressInputMs: 650 });
      return;
    }

    clearLevelTransitionArtifacts();

    const frameRect = frame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    let outgoingCanvas = null;
    try {
      outgoingCanvas = document.createElement('canvas');
      outgoingCanvas.width = canvas.width;
      outgoingCanvas.height = canvas.height;
      const outCtx = outgoingCanvas.getContext('2d');
      const copied = game?.renderer?.drawCompositeTo?.(outCtx);
      if (!copied) outCtx?.drawImage(canvas, 0, 0);
    } catch {
      outgoingCanvas = null;
    }

    if (!outgoingCanvas || canvasRect.width <= 0 || canvasRect.height <= 0) {
      startLevel(nodeId, { suppressInputMs: 650 });
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.left = (canvasRect.left - frameRect.left) + 'px';
    overlay.style.top = (canvasRect.top - frameRect.top) + 'px';
    overlay.style.width = canvasRect.width + 'px';
    overlay.style.height = canvasRect.height + 'px';
    overlay.style.overflow = 'hidden';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '1';

    outgoingCanvas.style.width = '100%';
    outgoingCanvas.style.height = '100%';
    outgoingCanvas.style.transform = 'translateY(0)';
    outgoingCanvas.style.transition = `transform ${LEVEL_SCROLL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    overlay.appendChild(outgoingCanvas);

    frame.appendChild(overlay);
    transitionOverlay = overlay;

    canvas.style.transition = 'none';
    canvas.style.transform = 'translateY(100%)';
    setPortraitScrollFx(canvasRect.height);

    const started = startLevel(nodeId, { clearTransition: false, suppressInputMs: LEVEL_SCROLL_MS + 220 });
    if (!started) {
      clearLevelTransitionArtifacts();
      return;
    }

    requestAnimationFrame(() => {
      canvas.style.transition = `transform ${LEVEL_SCROLL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      canvas.style.transform = 'translateY(0)';
      outgoingCanvas.style.transform = 'translateY(-100%)';
      setPortraitScrollFx(0);
    });

    transitionTimer = setTimeout(() => {
      clearLevelTransitionArtifacts();
    }, LEVEL_SCROLL_MS + 90);
  }

  // --- Level lifecycle ---

  function startLevel(nodeId, options = {}) {
    const clearTransition = options.clearTransition !== false;
    if (clearTransition) clearLevelTransitionArtifacts();
    const levelIndex = nodeIdToLevelIndex.get(nodeId);
    if (levelIndex == null) return false;
    const original = originalLevels[levelIndex];
    if (!original) return false;
    currentNodeId = nodeId;
    const levelData = mirrorState ? mirrorLevel(original) : cloneLevelData(original);

    // Cleanup previous
    if (unsubUiState) { unsubUiState(); unsubUiState = null; }
    if (game) { game.stop(); }
    paused = false;
    activeLevelMapAllowClose = false;
    setLevelMapMode(false);
    setLevelMapExitVisual(false);
    pauseOverlay.classList.remove('pause-overlay--map-mode');
    pauseOverlay.classList.remove('pause-overlay--instant');
    pauseOverlay.classList.remove('visible');
    visualLayout.frame.classList.remove('visual-frame--paused');

    game = new Game(canvas);
    if (Number.isFinite(options.suppressInputMs) && options.suppressInputMs > 0) {
      game.suppressInputFor(options.suppressInputMs);
    }
    game.confirmShoot = !!localStorage.getItem('peggle_confirmShoot');

    // Apply visuals (background + frame + slots)
    const visuals = normalizeVisuals(levelData.visuals);
    visualLayout.setConfig(visuals);
    game.renderer.setBackground(visuals.background);
    game.renderer.setBallTrail(visuals.ballTrail);
    game.renderer.setShockwave(visuals.shockwave);
    game.renderer.onVerticalProgress = (progress) => {
      visualLayout.updateSurvivalProgressIndicator(progress);
    };
    game.setEndSequenceConfig(visuals.endSequence);

    game.loadLevel(levelData);
    bindGambleSystem(game);
    portraitReactionController.setContext({
      level: levelData,
      registry: characterRegistry,
      game,
      gambleSystem,
      scopeKey: campaignName ? `campaign:${campaignName}` : 'single',
      paused: false
    });
    if (typeof levelData.aimLength === 'number') {
      game.setAimLength(levelData.aimLength);
    }
    dialogueController.setContext({
      level: levelData,
      scopeKey: campaignName ? `campaign:${campaignName}` : 'single',
      game,
      gambleSystem,
      persistSeen: true,
      live: true
    });
    dialogueController.setLanguage(currentLanguage);

    // Subscribe to UI state for ball counter + health bar
    unsubUiState = game.subscribeUiState((snapshot) => {
      if (snapshot.ballsLeft != null) {
        visualLayout.updateBallCounter(snapshot.ballsLeft, snapshot.initialBallCount);
      }
      if (Number.isFinite(snapshot.orangePegsLeft)) {
        visualLayout.updateHealthBar(snapshot.orangePegsLeft, snapshot.totalOrangePegs);
      }
    });

    game.onGameEnd = (result, score) => {
      const endedGame = game;
      const bindDelayMs = endedGame?.getEndOverlayInteractDelayMs?.() ?? 1000;
      setTimeout(() => {
        if (!endedGame || game !== endedGame) return;
        // Guard: only fire once (touchstart + click can both trigger on mobile)
        let fired = false;
        const onceAction = (action) => {
          const guarded = (event) => {
            if (fired) return;
            fired = true;
            if (event?.cancelable) event.preventDefault();
            if (typeof event?.stopPropagation === 'function') event.stopPropagation();
            canvas.removeEventListener('click', guarded);
            canvas.removeEventListener('touchstart', guarded);
            if (endedGame?.dismissEndOverlay) {
              endedGame.dismissEndOverlay(action);
            } else {
              action();
            }
          };
          canvas.addEventListener('click', guarded, { once: true });
          canvas.addEventListener('touchstart', guarded, { once: true, passive: false });
        };

        if (result === 'won') {
          mirrorState = false;
          completedNodes.add(currentNodeId);
          achievedNodes.add(currentNodeId);

          const currentNode = nodeMap.get(currentNodeId);
          const directPlayableChildren = (currentNode?.children || []).filter(cid =>
            nodeMap.has(cid) && nodeIdToLevelIndex.has(cid)
          );
          let directChoices = directPlayableChildren.filter(cid =>
            isUnlocked(cid, graphParentMap, completedNodes)
          );
          // If a structural inconsistency makes only one child "unlocked" at a multi-child
          // branch point, still present branch choice to avoid sticky linear runs.
          if (directChoices.length <= 1 && directPlayableChildren.length > 1) {
            directChoices = directPlayableChildren;
          }

          const outcome = directChoices.length > 1
            ? { action: 'choose', choices: directChoices }
            : resolveWin(
            campaignGraph, currentNodeId, completedNodes,
            nodeMap, graphParentMap, nodeIdToLevelIndex, playableOrder
          );

          if (outcome.action === 'advance') {
            onceAction(() => {
              currentNodeId = outcome.nodeId;
              saveProgress();
              transitionToLevel(currentNodeId);
            });
          } else if (outcome.action === 'choose') {
            const allowed = new Set(outcome.choices);
            onceAction(() => {
              saveProgress();
              paused = true;
              showLevelMap((nodeId) => {
                if (!allowed.has(nodeId) || !nodeIdToLevelIndex.has(nodeId)) return;
                const closingMap = activeLevelMap;
                if (closingMap) closingMap.hide();
                activeLevelMap = null;
                activeLevelMapAllowClose = false;
                setLevelMapMode(false);
                setLevelMapExitVisual(false);
                setHudLockedByMap(false);
                paused = false;
                currentNodeId = nodeId;
                mirrorState = false;
                saveProgress();
                transitionToLevel(currentNodeId);
              }, { allowClose: false, fallbackNodeId: outcome.choices[0] });
            });
          } else {
            // Campaign complete — tap to replay
            onceAction(() => {
              completedNodes.clear();
              mirrorState = false;
              currentNodeId = playableOrder[0];
              saveProgress();
              transitionToLevel(currentNodeId);
            });
          }
        } else {
          // Defeat — toggle mirror and restart same level
          mirrorState = !mirrorState;
          onceAction(() => startLevel(currentNodeId, { suppressInputMs: 650 }));
        }
      }, bindDelayMs);
    };

    resize();
    game.start();
    return true;
  }

  ensureGambleSystem();
  startLevel(currentNodeId);
  requestAnimationFrame(() => schedulePauseAssetsWarmup());
}
