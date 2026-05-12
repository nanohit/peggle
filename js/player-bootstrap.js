// Baked level player — full visual frame + HUD + gamble, no editor/menus/theme panel.
// Supports: single level (hash), level names (?level=), campaigns (?campaign=).
// On defeat: level mirrors horizontally and replays. Second defeat restores original.

import { Game } from './game.js';
import { PvpRuntime } from './pvp-runtime.js';
import { isMuted, setMuted } from './haptics.js';
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import { normalizeLevelData } from './levels.js';
import { ensureLevelPvp } from './pvp-mode.js';
import { DialogueController } from './dialogue-controller.js';
import { GambleSystem } from './gamble-system.js';
import { loadCharacterRegistry, normalizeCharacterRegistry, saveCharacterRegistry, CHARACTER_REGISTRY_STORAGE_KEY } from './character-config.js';
import { PortraitReactionController } from './portrait-reactions.js';
import { getStoredLanguage, getPauseCopy, normalizeLanguage, setStoredLanguage } from './localization.js';
import { topoOrder, buildNodeMap, buildParentMap, buildLevelIndexMap, graphFromLevels } from './graph/core.js';
import { validateGraph } from './graph/validate.js';
import { resolveWin, findNextNode, migrateProgress, isUnlocked } from './graph/progression.js';
import { api } from './api.js';
import { decodeBakedLevelJsonFromText } from './baked-level-codec.js';

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
  if (!location.hash) return null;
  try {
    const json = await decodeBakedLevelJsonFromText(location.hash);
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

function staticJson(path) {
  return fetch(path, { credentials: 'same-origin' })
    .then(res => res.ok ? res.json() : null)
    .catch(() => null);
}

function staticNamePath(name) {
  return encodeURIComponent(name);
}

// Fetch a level from the shared backend first; static files remain a deploy
// seed/offline fallback.
async function fetchLevel(name) {
  const remote = await api.getLevel(name);
  const data = remote
    || await staticJson('/data/player/levels/' + staticNamePath(name) + '.json')
    || await staticJson('/levels/' + staticNamePath(name) + '.json');
  if (data) return normalizeLevelData(data);
  return null;
}

// Load campaign by name: shared backend → static file → local cache fallback.
const inflightCampaignLoads = new Map();
function hasCampaignLevels(data) {
  return !!(data && Array.isArray(data.levels) && data.levels.length > 0);
}

async function loadCampaign(name) {
  if (inflightCampaignLoads.has(name)) return inflightCampaignLoads.get(name);
  const task = (async () => {
    const cacheKey = 'campaign:' + name;
    const cacheTimeKey = 'campaign_ts:' + name;
    const stored = localStorage.getItem(cacheKey);

    const remote = await api.getResolvedCampaign(name);
    if (hasCampaignLevels(remote)) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(remote));
        localStorage.setItem(cacheTimeKey, String(Date.now()));
      } catch { /* storage full, no big deal */ }
      return remote;
    }

    const data = await staticJson('/data/player/campaigns/' + staticNamePath(name) + '.json')
      || await staticJson('/campaigns/' + staticNamePath(name) + '.json');
    if (hasCampaignLevels(data)) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(data));
        localStorage.setItem(cacheTimeKey, String(Date.now()));
      } catch { /* storage full, no big deal */ }
      return data;
    }

    const partial = await staticJson('/data/player/campaigns/' + staticNamePath(name) + '.initial.json');
    if (hasCampaignLevels(partial)) {
      try {
        localStorage.setItem('config:primaryCampaign', partial.name || name);
        localStorage.setItem('config_ts:primaryCampaign', String(Date.now()));
      } catch { /* storage full */ }
      return partial;
    }

    // Local cache is deliberately last so old browser-local campaigns do not
    // shadow the shared campaign after another device edits it.
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (hasCampaignLevels(data)) return data;
      } catch { /* fall through */ }
    }
    return null;
  })();
  inflightCampaignLoads.set(name, task);
  try {
    return await task;
  } finally {
    inflightCampaignLoads.delete(name);
  }
}

async function loadPrimaryCampaignName() {
  const remote = await api.getConfig('primaryCampaign');
  if (typeof remote === 'string' && remote) return remote;
  try {
    const config = await staticJson('/data/player/config.json');
    const value = config?.primaryCampaign || config?.primary;
    if (typeof value === 'string' && value) return value;
  } catch { /* fall through */ }
  return null;
}

async function loadPrimaryInitialCampaign() {
  const remote = await api.getPrimaryCampaign({ initial: true });
  if (hasCampaignLevels(remote)) return remote;
  const data = await staticJson('/data/player/primary.initial.json');
  if (hasCampaignLevels(data)) return data;
  return null;
}

async function loadPrimaryFullCampaign() {
  const remote = await api.getPrimaryCampaign({ initial: false });
  if (hasCampaignLevels(remote)) return remote;
  const data = await staticJson('/data/player/primary.json');
  if (hasCampaignLevels(data)) return data;
  const name = await loadPrimaryCampaignName();
  if (!name) return null;
  return await loadCampaign(name);
}

async function loadStaticCharacterRegistry() {
  const remote = await staticJson('/data/player/characters.json')
    || await staticJson('/characters/registry.json');
  if (!remote || typeof remote !== 'object') return null;
  return normalizeCharacterRegistry(remote);
}

// Load primary campaign (for player domains with no URL params).
// The shared backend wins; localStorage is only a last-resort fallback.
async function loadPrimaryCampaign() {
  const cacheKey = 'config:primaryCampaign';
  const cacheTimeKey = 'config_ts:primaryCampaign';
  const cached = localStorage.getItem(cacheKey);

  const storeResolvedPrimary = (data) => {
    if (!data?.name) return;
    try {
      localStorage.setItem(cacheKey, data.name);
      localStorage.setItem(cacheTimeKey, String(Date.now()));
      if (!data.partial && hasCampaignLevels(data)) {
        localStorage.setItem('campaign:' + data.name, JSON.stringify(data));
        localStorage.setItem('campaign_ts:' + data.name, String(Date.now()));
      }
    } catch { /* storage full */ }
  };

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

  const initial = await loadPrimaryInitialCampaign();
  if (initial) {
    storeResolvedPrimary(initial);
    return initial;
  }

  const full = await loadPrimaryFullCampaign();
  if (full) {
    storeResolvedPrimary(full);
    return full;
  }

  const primaryName = await loadPrimaryCampaignName() || cached;
  if (!primaryName) return null;
  try {
    localStorage.setItem(cacheKey, primaryName);
    localStorage.setItem(cacheTimeKey, String(Date.now()));
  } catch { /* storage full */ }
  return await loadCampaign(primaryName);
}

async function fetchCharacterRegistryWithFallback() {
  const localFallback = () => loadCharacterRegistry();
  const remote = await api.getCharacterRegistry();
  const registry = remote ? normalizeCharacterRegistry(remote) : await loadStaticCharacterRegistry();
  if (!registry) return localFallback();
  try {
    saveCharacterRegistry(registry);
  } catch (e) {
    console.warn('[player] character registry cache write failed', e);
  }
  return registry;
}

/*
 * Player data uses the same shared API as the editor, with static JSON as a
 * seed/fallback. That keeps peggle.vercel.app editing and al3a.vercel.app play
 * pointed at one campaign source instead of each browser's local cache.
 */

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

function markPlayerReady() {
  document.documentElement.classList.add('player-ready');
  const startedAt = window.__PEGGLE_BOOT_STARTED_AT__;
  if (Number.isFinite(startedAt)) {
    console.log(`[BOOT] player-ready ${(performance.now() - startedAt).toFixed(1)}ms`);
  }
  const cover = document.getElementById('bootCover');
  if (!cover || cover.dataset.removing === '1') return;
  cover.dataset.removing = '1';
  window.setTimeout(() => {
    if (cover.parentNode) cover.parentNode.removeChild(cover);
  }, 260);
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
  const portraitReactionController = new PortraitReactionController({ visualLayout });
  dialogueController.setPortraitReactionController(portraitReactionController);
  dialogueController.mount();
  let currentLanguage = getStoredLanguage();
  dialogueController.setLanguage(currentLanguage);
  let game = null;
  let gambleSystem = null;
  let activeLevelData = null;
  let characterRegistry = loadCharacterRegistry();

  function refreshPortraitRegistry(nextRegistry) {
    if (!nextRegistry) return;
    characterRegistry = nextRegistry;
    if (!game || !activeLevelData) return;
    portraitReactionController.setContext({
      level: activeLevelData,
      registry: characterRegistry,
      game,
      gambleSystem,
      scopeKey: campaignName ? `campaign:${campaignName}` : 'single',
      paused
    });
  }

  let characterRegistryWarmupPromise = null;
  function startCharacterRegistryWarmup() {
    if (characterRegistryWarmupPromise) return characterRegistryWarmupPromise;
    // Pull character images after the first frame. This used to block first play
    // for up to the network timeout, which is especially painful on a clean device.
    characterRegistryWarmupPromise = fetchCharacterRegistryWithFallback()
      .then(refreshPortraitRegistry)
      .catch(() => null);
    return characterRegistryWarmupPromise;
  }

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
    if (titleEl) titleEl.textContent = copy.pauseTitle;
    if (hintEl) hintEl.innerHTML = copy.confirmShootHint.replace(/\n/g, '<br>');
    dialogueController.setLanguage(currentLanguage);
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
  let campaignGraph = null;
  let nodeMap = new Map();
  let graphParentMap = new Map();
  let nodeIdToLevelIndex = new Map();
  let playOrder = [];
  let playableOrder = [];

  function applyCampaignGraphState(nextLevels, nextCampaignData) {
    const nextGraph = (typeof nextCampaignData?.graph === 'object' && nextCampaignData.graph.nodes)
      ? nextCampaignData.graph
      : graphFromLevels(nextLevels);

    validateGraph(nextGraph);
    const nextNodeMap = buildNodeMap(nextGraph);
    const nextParentMap = buildParentMap(nextGraph);
    const nextLevelIndexMap = buildLevelIndexMap(nextGraph, nextLevels);
    const nextPlayOrder = topoOrder(nextGraph, true);
    const nextPlayableOrder = nextPlayOrder.filter(nid => nextLevelIndexMap.has(nid));

    if (nextPlayableOrder.length === 0) return false;
    levels = nextLevels;
    originalLevels = nextLevels;
    campaignData = nextCampaignData;
    campaignGraph = nextGraph;
    nodeMap = nextNodeMap;
    graphParentMap = nextParentMap;
    nodeIdToLevelIndex = nextLevelIndexMap;
    playOrder = nextPlayOrder;
    playableOrder = nextPlayableOrder;
    return true;
  }

  // Keep the campaign payload pristine; clone only the level that is about to run.
  let originalLevels = levels;

  if (!applyCampaignGraphState(levels, campaignData)) {
    showError('Campaign graph is empty or malformed — no playable levels found.');
    return;
  }

  // --- Progress ---
  const progressKey = campaignName ? 'peggle_progress:' + campaignName : null;
  let savedProgress = null;
  let completedNodes, achievedNodes, currentNodeId;
  function readSavedProgress() {
    if (!progressKey) return null;
    if (progressKey) {
      try { return JSON.parse(localStorage.getItem(progressKey)); } catch { /* ignore */ }
    }
    return null;
  }

  function savedProgressReferencesMissingNodes(saved) {
    if (!saved || typeof saved !== 'object') return false;
    if (typeof saved.levelIndex === 'number' && saved.levelIndex >= playableOrder.length) return true;
    const ids = [
      ...(Array.isArray(saved.completedNodeIds) ? saved.completedNodeIds : []),
      ...(Array.isArray(saved.achievedNodeIds) ? saved.achievedNodeIds : []),
      saved.currentNodeId
    ].filter(id => id != null);
    return ids.some(id => !nodeMap.has(id));
  }

  function applySavedProgress(saved) {
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
    if (currentNodeId != null && completedNodes.has(currentNodeId)) {
      currentNodeId = findNextNode(playableOrder, graphParentMap, completedNodes) ?? playableOrder[0];
    }
    if (!nodeIdToLevelIndex.has(currentNodeId)) {
      currentNodeId = findNextNode(playableOrder, graphParentMap, completedNodes) ?? playableOrder[0];
    }
  }
  savedProgress = readSavedProgress();
  applySavedProgress(savedProgress);

  let unsubUiState = null;
  let mirrorState = false; // alternates on defeat

  function saveProgress() {
    if (!progressKey) return;
    const nextProgress = {
      completedNodeIds: [...completedNodes],
      achievedNodeIds: [...achievedNodes],
      currentNodeId
    };
    savedProgress = nextProgress;
    try {
      localStorage.setItem(progressKey, JSON.stringify(nextProgress));
    } catch (error) {
      console.warn('[player] progress save failed', error);
    }
  }

  function mapCompletedNodes() {
    return new Set([...completedNodes, ...achievedNodes]);
  }

  let campaignHydrationPromise = null;
  function startCampaignHydration() {
    if (!campaignData?.partial || !campaignName) return Promise.resolve(campaignData || null);
    if (campaignHydrationPromise) return campaignHydrationPromise;
    campaignHydrationPromise = loadCampaign(campaignName)
      .then(fullCampaign => {
        if (!fullCampaign || fullCampaign.partial || !hasCampaignLevels(fullCampaign)) return null;
        const previousCurrentNodeId = currentNodeId;
        if (!applyCampaignGraphState(fullCampaign.levels, fullCampaign)) return null;
        if (savedProgress) {
          applySavedProgress(savedProgress);
        } else {
          completedNodes = new Set([...completedNodes].filter(nid => nodeMap.has(nid)));
          achievedNodes = new Set([...achievedNodes].filter(nid => nodeMap.has(nid)));
          for (const nid of completedNodes) achievedNodes.add(nid);
          currentNodeId = nodeIdToLevelIndex.has(previousCurrentNodeId)
            ? previousCurrentNodeId
            : (findNextNode(playableOrder, graphParentMap, completedNodes) ?? playableOrder[0]);
        }
        saveProgress();
        return fullCampaign;
      })
      .catch(error => {
        console.warn('[player] Full campaign hydration failed', error);
        return null;
      });
    return campaignHydrationPromise;
  }

  async function ensureFullCampaignReady() {
    if (!campaignData?.partial) return campaignData || null;
    return await startCampaignHydration();
  }

  if (campaignData?.partial && savedProgressReferencesMissingNodes(savedProgress)) {
    await ensureFullCampaignReady();
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
    levelMapOpening = true;
    try {
      await ensureFullCampaignReady();
      scheduleLevelMapPrewarm({ immediate: true, includePortraits: true });
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
    const blockFrameInput = (event) => {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    for (const slotId of ['top', 'topRight']) {
      const el = visualLayout.slotElements[slotId];
      if (!el) continue;
      el.classList.remove('visual-slot--pause-trigger');
      el.classList.add('visual-slot--input-shield');
      for (const type of ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend']) {
        el.addEventListener(type, blockFrameInput, { passive: false });
      }
    }
    const rightCircle = visualLayout.slotElements.rightCircle;
    if (rightCircle) {
      rightCircle.classList.remove('visual-slot--pause-trigger', 'visual-slot--input-shield');
      rightCircle.classList.add('visual-slot--decorative-inert');
    }

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
    activeLevelData = levelData;

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
    visualLayout.setPvpOpponentTarget?.(null);

    const pvp = ensureLevelPvp(levelData);
    visualLayout.setPvpMode?.(pvp.enabled);
    game = pvp.enabled
      ? new PvpRuntime(canvas, {
        settings: pvp,
        getTargetCircle: () => visualLayout.getCanvasSlotCircle?.('characterCircle', canvas),
        onVisualState: (state) => {
          if (!state) return;
          visualLayout.setPvpOpponentTarget?.({
            visible: true,
            hp: state.cpuHp,
            maxHp: state.maxHp || 3
          });
          visualLayout.setPvpAimTimer?.(
            state.timerVisible
              ? { visible: true, ratio: state.timerRatio }
              : null
          );
        }
      })
      : new Game(canvas);
    if (Number.isFinite(options.suppressInputMs) && options.suppressInputMs > 0) {
      game.suppressInputFor?.(options.suppressInputMs);
    }
    if (!pvp.enabled) {
      game.confirmShoot = !!localStorage.getItem('peggle_confirmShoot');
    }

    // Apply visuals (background + frame + slots)
    const visuals = normalizeVisuals(levelData.visuals);
    visualLayout.setConfig(visuals);
    game.renderer.setBackground(visuals.background);
    game.renderer.setBallTrail(visuals.ballTrail);
    game.renderer.setShockwave(visuals.shockwave);
    game.renderer.onVerticalProgress = (progress) => {
      visualLayout.updateSurvivalProgressIndicator(progress);
    };
    game.setEndSequenceConfig?.(visuals.endSequence);

    game.loadLevel(levelData);
    if (pvp.enabled) {
      if (gambleSystem) {
        gambleSystem.dispose?.();
        gambleSystem = null;
      }
      dialogueController.setGambleSystem(null);
      portraitReactionController.setGambleSystem(null);
    } else {
      bindGambleSystem(game);
    }
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
      if (!pvp.enabled) {
        visualLayout.setPvpOpponentTarget?.(null);
      }
    });

    game.onGameEnd = (result, score) => {
      const endedGame = game;
      const bindDelayMs = endedGame?.getEndOverlayInteractDelayMs?.() ?? 1000;
      setTimeout(async () => {
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
          await ensureFullCampaignReady();
          if (!endedGame || game !== endedGame) return;
          if (campaignData?.partial) {
            console.warn('[player] Full campaign still unavailable after win; replaying current level.');
            onceAction(() => startLevel(currentNodeId, { suppressInputMs: 650 }));
            return;
          }
          mirrorState = false;
          completedNodes.add(currentNodeId);
          achievedNodes.add(currentNodeId);
          saveProgress();

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
        } else if (pvp.enabled) {
          onceAction(() => startLevel(currentNodeId, { suppressInputMs: 650 }));
        } else {
          // Defeat — toggle mirror and restart same level
          mirrorState = !mirrorState;
          onceAction(() => startLevel(currentNodeId, { suppressInputMs: 650 }));
        }
      }, bindDelayMs);
    };

    resize();
    game.start();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      markPlayerReady();
      startCharacterRegistryWarmup();
      startCampaignHydration();
    }));
    return true;
  }

  ensureGambleSystem();
  startLevel(currentNodeId);
  requestAnimationFrame(() => schedulePauseAssetsWarmup());
}
