// Baked level player — full visual frame + HUD + gamble, no editor/menus/theme panel.
// Supports: single level (hash), level names (?level=), campaigns (?campaign=).
// On defeat: level mirrors horizontally and replays. Second defeat restores original.

import { Game } from './game.js';
import { PvpRuntime } from './pvp-runtime.js';
import { isMuted, setMuted } from './haptics.js';
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import { normalizeLevelData } from './levels.js';
import { ensureLevelPvp, PVP_DEFAULT_AIM_LENGTH } from './pvp-mode.js';
import { DialogueController } from './dialogue-controller.js';
import { GambleSystem } from './gamble-system.js';
import {
  applyCharacterHealthCircleColorToVisuals,
  CHARACTER_REGISTRY_STORAGE_KEY,
  createCharacterRefSnapshot,
  createDefaultCharacter,
  DEFAULT_CHARACTER_ID,
  getCharacterPvpPortraitSource,
  getCharacterSlotSource,
  loadCharacterRegistry,
  normalizeCharacter,
  normalizeCharacterRegistry,
  normalizeLevelCharacterAssignment,
  resolveCharacterForLevel,
  saveCharacterRegistry
} from './character-config.js';
import { PortraitReactionController } from './portrait-reactions.js';
import { getStoredLanguage, getPauseCopy, normalizeLanguage, setStoredLanguage } from './localization.js';
import { topoOrder, buildNodeMap, buildParentMap, buildLevelIndexMap, graphFromLevels } from './graph/core.js';
import { validateGraph } from './graph/validate.js';
import { resolveWin, findNextNode, migrateProgress, isUnlocked } from './graph/progression.js';
import { api } from './api.js';
import { isAssetImageSource, assetCacheKey, loadImageFromCandidates } from './asset-ref.js';
import { decodeBakedLevelJsonFromText } from './baked-level-codec.js';
import {
  createPvpDuelRoomUrl,
  getOrCreatePvpDuelClientId,
  getPvpDuelRoomCodeFromLocation,
  PvpDuelRoomController
} from './pvp-duel-client.js';

const ASPECT_RATIO = 3 / 4.5;
const FRAME_RATIO = 9 / 17;
const WORLD_W = 400;
const WORLD_H = Math.round(WORLD_W / ASPECT_RATIO); // 600
const PVP_DUEL_LEVELS_STORAGE_KEY = 'pvp:duel:levels';
const DEFAULT_CPU_DUEL_LEVEL = Object.freeze({
  version: 1,
  id: 'cpu-duel-default',
  name: 'Duel',
  difficulty: 1,
  tags: ['duel', 'cpu'],
  pegs: [
    { id: 'cpu-duel-o-01', type: 'orange', x: 72, y: 164, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-01', type: 'blue', x: 132, y: 154, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-02', type: 'orange', x: 200, y: 146, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-02', type: 'blue', x: 268, y: 154, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-03', type: 'orange', x: 328, y: 164, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-03', type: 'blue', x: 104, y: 236, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-04', type: 'orange', x: 164, y: 222, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-04', type: 'blue', x: 236, y: 222, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-05', type: 'orange', x: 296, y: 236, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-06', type: 'orange', x: 82, y: 316, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-05', type: 'blue', x: 142, y: 304, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-07', type: 'orange', x: 200, y: 292, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-06', type: 'blue', x: 258, y: 304, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-08', type: 'orange', x: 318, y: 316, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-07', type: 'blue', x: 104, y: 384, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-09', type: 'orange', x: 164, y: 398, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-08', type: 'blue', x: 236, y: 398, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-10', type: 'orange', x: 296, y: 384, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-11', type: 'orange', x: 72, y: 468, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-09', type: 'blue', x: 132, y: 478, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-12', type: 'orange', x: 200, y: 486, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-b-10', type: 'blue', x: 268, y: 478, angle: 0, shape: 'circle' },
    { id: 'cpu-duel-o-13', type: 'orange', x: 328, y: 468, angle: 0, shape: 'circle' }
  ],
  groups: [],
  bezierCurves: {},
  flippers: null,
  aimLength: 300,
  pvp: {
    enabled: true,
    symmetryEnabled: true,
    aimTimerMs: 5000,
    aimLength: PVP_DEFAULT_AIM_LENGTH,
    hitsToWin: 3,
    cpuEnabled: true,
    cpuDifficulty: 'normal'
  },
  metadata: {
    created: '2026-06-09',
    modified: '2026-06-09T00:00:00.000Z',
    playCount: 0,
    avgCompletionRate: null,
    authorNotes: 'Built-in quick CPU duel fallback.'
  }
});
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
  const remote = await api.getLevel(name, { playerCache: true });
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

    const remote = await api.getResolvedCampaign(name, { playerCache: true });
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
  const remote = await api.getPrimaryCampaign({ initial: true, playerCache: true });
  if (hasCampaignLevels(remote)) return remote;
  const data = await staticJson('/data/player/primary.initial.json');
  if (hasCampaignLevels(data)) return data;
  return null;
}

async function loadPrimaryFullCampaign() {
  const remote = await api.getPrimaryCampaign({ initial: false, playerCache: true });
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

function collectCharacterIdsFromLevels(sourceLevels) {
  const ids = new Set([DEFAULT_CHARACTER_ID]);
  for (const level of Array.isArray(sourceLevels) ? sourceLevels : []) {
    ids.add(normalizeLevelCharacterAssignment(level?.character).characterId);
    ids.add(normalizeLevelCharacterAssignment(level?.pvp?.enemyCharacter).characterId);
  }
  return [...ids].filter(Boolean).sort();
}

function normalizeCharacterIdList(ids) {
  if (!ids) return [];
  const source = typeof ids === 'string'
    ? ids.split(',')
    : (typeof ids?.[Symbol.iterator] === 'function' ? [...ids] : []);
  return [...new Set(source.map(id => normalizeLevelCharacterAssignment({ characterId: id }).characterId))].sort();
}

async function fetchCharacterRegistryWithFallback(options = {}) {
  const localFallback = () => loadCharacterRegistry();
  const characterIds = normalizeCharacterIdList(options.characterIds);
  const remote = await api.getCharacterRegistry({
    playerCache: true,
    characterIds
  });
  const remotePartial = remote?.partial === true;
  const registry = remote ? normalizeCharacterRegistry(remote) : await loadStaticCharacterRegistry();
  if (!registry) return localFallback();
  registry.partial = remotePartial;
  try {
    if (!registry.partial) saveCharacterRegistry(registry);
  } catch (e) {
    console.warn('[player] character registry cache write failed', e);
  }
  return registry;
}

function resolvePvpEnemyCharacterForLevel(level, registry = loadCharacterRegistry()) {
  const normalizedRegistry = normalizeCharacterRegistry(registry);
  const assignment = normalizeLevelCharacterAssignment(level?.pvp?.enemyCharacter);
  return normalizeCharacter(
    normalizedRegistry.characters[assignment.characterId]
    || assignment.snapshot
    || normalizedRegistry.characters[DEFAULT_CHARACTER_ID]
    || createDefaultCharacter()
  );
}

function resolvePvpPortraitCharacters(level, registry = loadCharacterRegistry(), localSide = 'human') {
  const human = resolveCharacterForLevel(level, registry);
  const cpu = resolvePvpEnemyCharacterForLevel(level, registry);
  return localSide === 'cpu'
    ? { local: cpu, remote: human }
    : { local: human, remote: cpu };
}

/*
 * Player data uses the same shared API as the editor, with static JSON as a
 * seed/fallback. That keeps peggle.vercel.app editing and alea.sh/al3a.vercel.app play
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

function isPvpCpuDuelRequested(locationObj = window.location) {
  const params = new URLSearchParams(locationObj.search || '');
  return params.get('duel') === 'cpu' || params.get('pvp') === 'cpu' || params.get('cpuDuel') === '1';
}

function createPvpCpuDuelUrl() {
  const url = new URL(window.location.href);
  if (url.protocol !== 'file:') {
    url.pathname = '/player.html';
  }
  url.search = 'duel=cpu';
  url.hash = '';
  return url.toString();
}

function normalizePvpDuelLevelNames(names) {
  if (!Array.isArray(names)) return [];
  return [...new Set(names.map(name => (typeof name === 'string' ? name.trim() : '')).filter(Boolean))];
}

function readLocalPvpDuelLevelNames() {
  try {
    return normalizePvpDuelLevelNames(JSON.parse(localStorage.getItem(PVP_DUEL_LEVELS_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function writeLocalPvpDuelLevelNames(names) {
  try {
    localStorage.setItem(PVP_DUEL_LEVELS_STORAGE_KEY, JSON.stringify(normalizePvpDuelLevelNames(names)));
  } catch { /* storage unavailable */ }
}

function shuffled(items) {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function preparePvpCpuDuelLevel(levelData) {
  if (!levelData || !Array.isArray(levelData.pegs)) return null;
  const level = normalizeLevelData(cloneLevelData(levelData));
  const pvp = ensureLevelPvp(level);
  if (!pvp.enabled) return null;
  level.pvp = { ...pvp, enabled: true, cpuEnabled: true };
  return level;
}

function pickPreparedPvpCpuDuelLevel(levels) {
  const candidates = (Array.isArray(levels) ? levels : [])
    .map(preparePvpCpuDuelLevel)
    .filter(Boolean);
  if (candidates.length === 0) return null;
  return shuffled(candidates)[0];
}

function loadBuiltInPvpCpuDuelLevel() {
  return preparePvpCpuDuelLevel(DEFAULT_CPU_DUEL_LEVEL);
}

async function loadRandomPvpCpuDuelLevel(options = {}) {
  const preferred = pickPreparedPvpCpuDuelLevel(options.preferredLevels);
  if (preferred) return preferred;

  if (options.useBuiltInDefault !== false) {
    const builtIn = loadBuiltInPvpCpuDuelLevel();
    if (builtIn) return builtIn;
  }

  if (options.allowConfiguredLevels === false) return null;

  const cachedNames = readLocalPvpDuelLevelNames();
  for (const name of shuffled(cachedNames)) {
    const level = preparePvpCpuDuelLevel(loadBakedLevel(name) || await fetchLevel(name));
    if (level) return level;
  }

  if (options.allowRemoteLevels !== false) {
    const remoteNames = normalizePvpDuelLevelNames(await api.listPvpDuelLevels());
    if (remoteNames.length > 0) writeLocalPvpDuelLevelNames(remoteNames);
    for (const name of shuffled(remoteNames)) {
      const level = preparePvpCpuDuelLevel(loadBakedLevel(name) || await fetchLevel(name));
      if (level) return level;
    }
  }

  const primary = options.skipPrimaryFallback ? null : await loadPrimaryFullCampaign();
  return pickPreparedPvpCpuDuelLevel(primary?.levels);
}

async function bootPvpCpuDuel() {
  const level = await loadRandomPvpCpuDuelLevel();
  if (!level) {
    showError('No CPU Duel level configured.');
    return;
  }
  bootWithLevels([level], null, null, { cpuDuel: true });
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

// Mirror an animation block horizontally: flip translation, rotation, the
// rotation-origin offset, and every trajectory-path anchor/handle x.
function mirrorAnimationData(anim) {
  if (!anim) return;
  if (anim.dx) anim.dx = -anim.dx;
  if (anim.rotation) anim.rotation = -anim.rotation;
  if (anim.pivot && anim.pivot.dx) anim.pivot.dx = -anim.pivot.dx;
  if (anim.path && Array.isArray(anim.path.anchors)) {
    for (const a of anim.path.anchors) {
      a.x = -a.x;
      if (a.hIn) a.hIn.x = -a.hIn.x;
      if (a.hOut) a.hOut.x = -a.hOut.x;
    }
  }
}

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
      mirrorAnimationData(peg.animation);
    }
  }

  // Mirror group animations
  if (Array.isArray(m.groups)) {
    for (const group of m.groups) {
      if (group.animation) {
        mirrorAnimationData(group.animation);
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
    <div class="pause-character-nav" id="pauseCharacterNav">
      <button class="pause-character-arrow pause-character-arrow--prev" id="pauseCharacterPrevBtn" type="button" aria-label="Previous character">‹</button>
      <button class="pause-character-arrow pause-character-arrow--next" id="pauseCharacterNextBtn" type="button" aria-label="Next character">›</button>
    </div>
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
        <button class="pause-img-btn" id="pausePvpDuelBtn">
          <img class="pause-img-btn__normal" data-src="${BASE}pvp_button.webp" alt="Дуэль" draggable="false">
          <img class="pause-img-btn__pressed" data-src="${BASE}pvp_button_pressed.webp" alt="" draggable="false">
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
    if (isPvpCpuDuelRequested()) {
      bootPvpCpuDuel();
      return;
    }
    const duelRoomCode = getPvpDuelRoomCodeFromLocation();
    if (duelRoomCode) {
      bootPvpDuelRoom(duelRoomCode);
      return;
    }
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

async function bootPvpDuelRoom(roomCode) {
  const canvas = document.getElementById('gameCanvas');
  canvas.getContext('2d', { alpha: false });

  const visualLayout = new VisualLayout({
    includePanel: false,
    enableEditorInteractions: false
  });
  visualLayout.mount();
  visualLayout.setEditMode(false);
  visualLayout.setPvpMode?.(true);

  const roomOverlay = document.createElement('div');
  roomOverlay.className = 'pvp-room-overlay visible';
  roomOverlay.innerHTML = `
    <div class="pvp-room-card">
      <div class="pvp-room-title">PvP Duel</div>
      <div class="pvp-room-code">${roomCode}</div>
      <div class="pvp-room-status">Joining room...</div>
      <button type="button" class="pvp-room-copy">Copy Link</button>
    </div>
  `;
  visualLayout.frame.appendChild(roomOverlay);
  const roomStatusEl = roomOverlay.querySelector('.pvp-room-status');
  roomOverlay.querySelector('.pvp-room-copy')?.addEventListener('click', async () => {
    const url = createPvpDuelRoomUrl(roomCode);
    try {
      await navigator.clipboard?.writeText?.(url);
      roomStatusEl.textContent = 'Link copied. Waiting for opponent...';
    } catch {
      roomStatusEl.textContent = url;
    }
  });

  const pauseOverlay = createPauseOverlay();
  visualLayout.frame.appendChild(pauseOverlay);
  loadDeferredImages(pauseOverlay);
  pauseOverlay.querySelector('#pauseCharacterNav')?.classList.add('is-hidden');
  pauseOverlay.querySelector('#pauseLevelBtn')?.remove();
  pauseOverlay.querySelector('#pausePvpDuelBtn')?.addEventListener('click', () => {
    window.location.href = createPvpCpuDuelUrl();
  });
  const confirmInput = pauseOverlay.querySelector('#pauseConfirmInput');
  if (confirmInput) {
    confirmInput.checked = !!localStorage.getItem('peggle_confirmShoot');
  }

  let game = null;
  let controller = null;
  let unsubUiState = null;
  let paused = false;

  function resize() {
    const viewport = document.getElementById('visualViewport');
    const frame = document.getElementById('visualFrame');
    if (!viewport || !frame) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
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

  function showPause() {
    if (paused || !game) return;
    paused = true;
    game.pause();
    pauseOverlay.classList.add('visible');
    visualLayout.frame.classList.add('visual-frame--paused');
  }

  function hidePause() {
    if (!paused) return;
    paused = false;
    pauseOverlay.classList.remove('visible');
    visualLayout.frame.classList.remove('visual-frame--paused');
    game?.resume?.();
  }

  pauseOverlay.querySelector('#pauseResumeBtn')?.addEventListener('click', hidePause);
  pauseOverlay.querySelector('#pauseRestartBtn')?.addEventListener('click', () => {
    window.location.reload();
  });
  pauseOverlay.addEventListener('click', (event) => {
    if (event.target === pauseOverlay) hidePause();
  });
  confirmInput?.addEventListener('change', () => {
    if (confirmInput.checked) localStorage.setItem('peggle_confirmShoot', '1');
    else localStorage.removeItem('peggle_confirmShoot');
    if (game) game.confirmShoot = confirmInput.checked;
  });

  function setupPauseTriggers() {
    for (const slotId of ['topLeft', 'leftCircle']) {
      const el = visualLayout.slotElements?.[slotId];
      if (!el) continue;
      el.classList.add('visual-slot--pause-trigger');
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        showPause();
      });
      el.addEventListener('touchend', (event) => {
        event.stopPropagation();
        event.preventDefault();
        showPause();
      });
    }
  }
  setupPauseTriggers();

  function updateRoomOverlay(room, meta = {}) {
    if (!room) return;
    if (meta.waitingForRoundResult) {
      roomOverlay.classList.add('visible');
      roomStatusEl.textContent = 'Round already in progress. Waiting for the next aim phase...';
      return;
    }
    if (room.status === 'waiting') {
      roomOverlay.classList.add('visible');
      roomStatusEl.textContent = 'Waiting for opponent. Share this room code.';
      return;
    }
    if (room.status === 'aiming') {
      roomOverlay.classList.remove('visible');
      return;
    }
    if (room.status === 'playing') {
      roomOverlay.classList.remove('visible');
      return;
    }
    if (room.status === 'finished') {
      roomOverlay.classList.add('visible');
      const won = room.winner && room.side && room.winner === room.side;
      roomStatusEl.textContent = won ? 'Victory. Tap the board to play again.' : 'Defeat. Tap the board to play again.';
    }
  }

  try {
    const clientId = getOrCreatePvpDuelClientId();
    const initialRoom = await api.joinPvpDuelRoom(roomCode, clientId);
    if (!initialRoom) throw new Error('Could not join PvP Duel room.');
    const levelData = await api.getLevel(initialRoom.levelName, { playerCache: true });
    if (!levelData || !Array.isArray(levelData.pegs)) {
      throw new Error(`PvP Duel level not found: ${initialRoom.levelName || 'unknown'}`);
    }

    const level = normalizeLevelData(levelData);
    const pvp = ensureLevelPvp(level);
    if (!pvp.enabled) throw new Error('The selected room level is not marked as PvP.');
    let roomCharacterRegistry = loadCharacterRegistry();
    fetchCharacterRegistryWithFallback()
      .then((registry) => {
        roomCharacterRegistry = registry;
        game?.render?.();
      })
      .catch(() => null);

    const adapter = {
      submitAim: (payload) => controller?.submitAim(payload),
      publishRoundResult: (result) => controller?.publishRoundResult(result)
    };

    game = new PvpRuntime(canvas, {
      settings: pvp,
      localSide: initialRoom.side,
      networkAdapter: adapter,
      getTargetCircle: () => visualLayout.getCanvasSlotCircle?.('characterCircle', canvas),
      onVisualState: (state) => {
        if (!state) return;
        const maxHp = state.maxHp || 3;
        const portraits = resolvePvpPortraitCharacters(level, roomCharacterRegistry, initialRoom.side);
        const localSrc = getCharacterPvpPortraitSource(portraits.local, { hp: state.playerHp, maxHp });
        const remoteSrc = getCharacterPvpPortraitSource(portraits.remote, { hp: state.cpuHp, maxHp });
        if (localSrc) {
          visualLayout.setCharacterPortraitSource(localSrc, {
            fadeMs: 160,
            slotName: `pvp:${initialRoom.side}:${state.playerHp}`
          });
        }
        visualLayout.setPvpOpponentTarget?.({
          visible: true,
          hp: state.cpuHp,
          maxHp,
          portraitSrc: remoteSrc
        });
        visualLayout.setPvpAimTimer?.(
          state.timerVisible
            ? { visible: true, ratio: state.timerRatio }
            : null
        );
      },
      onGameEnd: () => {
        const endedGame = game;
        const bindDelayMs = endedGame?.getEndOverlayInteractDelayMs?.() ?? 650;
        setTimeout(() => {
          if (!endedGame || game !== endedGame) return;
          let fired = false;
          const restart = (event) => {
            if (fired) return;
            fired = true;
            if (event?.cancelable) event.preventDefault();
            canvas.removeEventListener('click', restart);
            canvas.removeEventListener('touchstart', restart);
            window.location.href = createPvpDuelRoomUrl();
          };
          canvas.addEventListener('click', restart, { once: true });
          canvas.addEventListener('touchstart', restart, { once: true, passive: false });
        }, bindDelayMs);
      }
    });

    const visuals = applyCharacterHealthCircleColorToVisuals(
      normalizeVisuals(level.visuals),
      level,
      resolveCharacterForLevel(level, roomCharacterRegistry)
    );
    visualLayout.setConfig(visuals);
    game.renderer.setBackground(visuals.background);
    game.renderer.setBallTrail(visuals.ballTrail);
    game.renderer.setShockwave(visuals.shockwave);
    game.loadLevel(level);
    game.setAimLength?.(pvp.aimLength ?? PVP_DEFAULT_AIM_LENGTH);
    game.confirmShoot = !!localStorage.getItem('peggle_confirmShoot');

    unsubUiState = game.subscribeUiState((snapshot) => {
      if (Number.isFinite(snapshot.orangePegsLeft)) {
        visualLayout.updateHealthBar(snapshot.orangePegsLeft, snapshot.totalOrangePegs);
      }
    });

    controller = new PvpDuelRoomController({
      roomCode,
      clientId,
      runtime: game,
      onState: updateRoomOverlay,
      onError: (error) => {
        roomOverlay.classList.add('visible');
        roomStatusEl.textContent = error?.message || 'Room connection issue. Retrying...';
      }
    });
    controller.handleRoomState(initialRoom);
    controller.start();

    window.addEventListener('resize', resize);
    window.addEventListener('beforeunload', () => {
      controller?.stop();
      if (unsubUiState) unsubUiState();
      game?.stop?.();
    });
    resize();
    game.start();
    requestAnimationFrame(() => requestAnimationFrame(markPlayerReady));
  } catch (error) {
    showError(error?.message || 'Could not start PvP Duel room.');
  }
}

async function bootWithLevels(levels, campaignName, campaignData, options = {}) {

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
  const initialCpuDuelMode = options?.cpuDuel === true;
  let activeCpuDuelMode = initialCpuDuelMode;
  let characterAssignments = new Map();

  function getRegistryCharacter(characterId) {
    const registry = normalizeCharacterRegistry(characterRegistry);
    const assignment = normalizeLevelCharacterAssignment({ characterId });
    return normalizeCharacter(
      registry.characters[assignment.characterId]
      || registry.characters[DEFAULT_CHARACTER_ID]
      || createDefaultCharacter()
    );
  }

  function setLevelCharacterAssignment(level, characterId) {
    if (!level || typeof level !== 'object') return DEFAULT_CHARACTER_ID;
    const assignment = normalizeLevelCharacterAssignment({ characterId });
    const registry = normalizeCharacterRegistry(characterRegistry);
    const character = normalizeCharacter(
      registry.characters[assignment.characterId]
      || registry.characters[DEFAULT_CHARACTER_ID]
      || createDefaultCharacter()
    );
    level.character = normalizeLevelCharacterAssignment({
      ...level.character,
      characterId: assignment.characterId,
      snapshot: createCharacterRefSnapshot(character)
    });
    return assignment.characterId;
  }

  function applyRuntimeCharacterAssignment(level, nodeId) {
    const assignedId = characterAssignments.get(String(nodeId));
    if (assignedId) setLevelCharacterAssignment(level, assignedId);
  }

  function normalizeCharacterAssignmentMap(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const next = new Map();
    for (const [nodeId, characterId] of Object.entries(source)) {
      if (!nodeId) continue;
      const id = normalizeLevelCharacterAssignment({ characterId }).characterId;
      next.set(String(nodeId), id);
    }
    return next;
  }

  function getAvailableCharacterIds() {
    const registry = normalizeCharacterRegistry(characterRegistry);
    return Object.keys(registry.characters || {}).sort();
  }

  function getActiveCharacterId() {
    return normalizeLevelCharacterAssignment(activeLevelData?.character).characterId;
  }

  function resolveVisualsWithCharacter(levelData) {
    const visuals = normalizeVisuals(levelData?.visuals);
    const character = resolveCharacterForLevel(levelData, characterRegistry);
    return applyCharacterHealthCircleColorToVisuals(visuals, levelData, character);
  }

  function getResolvedActiveHealthCircleColor() {
    if (!activeLevelData) return '';
    const character = resolveCharacterForLevel(activeLevelData, characterRegistry);
    const themed = applyCharacterHealthCircleColorToVisuals({ slots: { healthCircle: {} } }, activeLevelData, character);
    return themed?.slots?.healthCircle?.color || '';
  }

  function applyActiveCharacterVisuals(fadeMs = 160) {
    if (!activeLevelData) return;
    const character = resolveCharacterForLevel(activeLevelData, characterRegistry);
    const healthCircleColor = getResolvedActiveHealthCircleColor();
    visualLayout.setHealthCircleColor?.(healthCircleColor);
    if (!ensureLevelPvp(activeLevelData).enabled) {
      const src = getCharacterSlotSource(character, 'idle');
      visualLayout.setCharacterPortraitSource(src, { fadeMs, slotName: 'idle' });
    }
    portraitReactionController.setContext({
      level: activeLevelData,
      registry: characterRegistry,
      game,
      gambleSystem,
      scopeKey: campaignName ? `campaign:${campaignName}` : 'single',
      paused
    });
  }

  function syncPauseCharacterPicker() {
    const nav = pauseOverlay.querySelector('#pauseCharacterNav');
    if (!nav) return;
    const ids = getAvailableCharacterIds();
    nav.dataset.activeCharacterId = getActiveCharacterId();
    nav.dataset.characterIds = ids.join(',');
    const isPvp = activeLevelData ? ensureLevelPvp(activeLevelData).enabled : false;
    nav.classList.toggle('is-hidden', isPvp || activeCpuDuelMode || ids.length <= 1);
  }

  function applyCharacterChoiceToRun(characterId) {
    if (!activeLevelData || currentNodeId == null) return false;
    const previousId = getActiveCharacterId();
    const nextId = getRegistryCharacter(characterId).id;
    if (!nextId || nextId === previousId) return false;

    const startIndex = playableOrder.findIndex(nid => String(nid) === String(currentNodeId));
    if (startIndex < 0) return false;

    for (let i = startIndex; i < playableOrder.length; i++) {
      const nodeId = playableOrder[i];
      const levelIndex = nodeIdToLevelIndex.get(nodeId);
      const level = levelIndex == null ? null : originalLevels[levelIndex];
      if (!level) continue;
      const effectiveId = characterAssignments.get(String(nodeId))
        || normalizeLevelCharacterAssignment(level.character).characterId;
      if (i !== startIndex && effectiveId !== previousId) break;
      characterAssignments.set(String(nodeId), nextId);
      setLevelCharacterAssignment(level, nextId);
      if (levels[levelIndex]) setLevelCharacterAssignment(levels[levelIndex], nextId);
    }

    setLevelCharacterAssignment(activeLevelData, nextId);
    saveProgress();
    applyActiveCharacterVisuals(0);
    syncPauseCharacterPicker();
    return true;
  }

  function cyclePauseCharacter(delta) {
    const ids = getAvailableCharacterIds();
    if (ids.length <= 1) return;
    const currentId = getActiveCharacterId();
    const currentIndex = Math.max(0, ids.indexOf(currentId));
    const nextIndex = ((currentIndex + delta) % ids.length + ids.length) % ids.length;
    applyCharacterChoiceToRun(ids[nextIndex]);
  }

  let characterRegistryComplete = false;
  let fullRegistryRequested = false;
  function refreshPortraitRegistry(nextRegistry, options = {}) {
    if (!nextRegistry) return;
    const incomingComplete = options.complete !== false && nextRegistry.partial !== true;
    // Completeness is monotonic: never let a late subset result clobber a full
    // one that was already applied or is in flight (e.g. a hydration-triggered
    // subset warmup racing the pause menu's full-registry fetch). Without this
    // the pause character picker could silently drop to the campaign subset.
    if (!incomingComplete && (characterRegistryComplete || fullRegistryRequested)) return;
    characterRegistryComplete = incomingComplete;
    characterRegistry = nextRegistry;
    syncPauseCharacterPicker();
    if (!game || !activeLevelData) return;
    portraitReactionController.setContext({
      level: activeLevelData,
      registry: characterRegistry,
      game,
      gambleSystem,
      scopeKey: campaignName ? `campaign:${campaignName}` : 'single',
      paused
    });
    applyActiveCharacterVisuals(0);
  }

  function updatePvpPortraitVisuals(levelData, state, localSide = 'human') {
    if (!levelData || !state) return;
    const maxHp = state.maxHp || 3;
    const portraits = resolvePvpPortraitCharacters(levelData, characterRegistry, localSide);
    const localSrc = getCharacterPvpPortraitSource(portraits.local, { hp: state.playerHp, maxHp });
    const remoteSrc = getCharacterPvpPortraitSource(portraits.remote, { hp: state.cpuHp, maxHp });
    if (localSrc) {
      visualLayout.setCharacterPortraitSource(localSrc, {
        fadeMs: 160,
        slotName: `pvp:${localSide}:${state.playerHp}`
      });
    }
    visualLayout.setPvpOpponentTarget?.({
      visible: true,
      hp: state.cpuHp,
      maxHp,
      portraitSrc: remoteSrc
    });
  }

  let characterRegistryWarmupPromise = null;
  let characterRegistryWarmupKey = '';
  let characterRegistryWarmupSeq = 0;
  function getWarmupCharacterIds() {
    const ids = new Set(collectCharacterIdsFromLevels(originalLevels));
    for (const id of characterAssignments.values()) {
      ids.add(normalizeLevelCharacterAssignment({ characterId: id }).characterId);
    }
    return [...ids].filter(Boolean).sort();
  }

  function startCharacterRegistryWarmup(options = {}) {
    const full = options.full === true;
    if (characterRegistryComplete) return Promise.resolve(characterRegistry);
    if (full) fullRegistryRequested = true;
    const characterIds = full ? [] : getWarmupCharacterIds();
    const key = full ? '__full__' : characterIds.join(',');
    if (characterRegistryWarmupPromise && characterRegistryWarmupKey === key) return characterRegistryWarmupPromise;
    // Pull character images after the first frame. This used to block first play
    // for up to the network timeout, which is especially painful on a clean device.
    characterRegistryWarmupKey = key;
    const requestSeq = ++characterRegistryWarmupSeq;
    characterRegistryWarmupPromise = fetchCharacterRegistryWithFallback({ characterIds })
      .then(registry => {
        // A full result is the most complete and always applies (refreshPortrait-
        // Registry's monotonic guard keeps a stale subset from undoing it). A
        // subset applies only if it's still the latest request, so a newer subset
        // (more levels) wins over an older one.
        if (!full && requestSeq !== characterRegistryWarmupSeq) return registry;
        refreshPortraitRegistry(registry, { complete: full });
        return registry;
      })
      .catch(() => null);
    return characterRegistryWarmupPromise;
  }

  function ensureFullCharacterRegistryReady() {
    return startCharacterRegistryWarmup({ full: true });
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
    characterAssignments = normalizeCharacterAssignmentMap(saved?.characterAssignments);
    for (const nodeId of [...characterAssignments.keys()]) {
      if (!nodeMap.has(nodeId)) characterAssignments.delete(nodeId);
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
    if (characterAssignments.size > 0) {
      nextProgress.characterAssignments = Object.fromEntries(characterAssignments);
    }
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

  // --- Background prefetch ---
  // CDN-hosted backgrounds load slower than the old inline data did, so warm
  // the browser HTTP cache one level ahead (graph children of the current
  // node). The prefetch must mirror the renderer's request mode (crossOrigin)
  // or the cached response can't be reused for the canvas draw.
  const prefetchedBgKeys = new Set();
  let bgPrefetchTimer = null;

  function collectLevelBackgroundSources(level) {
    const sources = [];
    const bg = level?.visuals?.background;
    if (bg?.type === 'image') {
      sources.push(bg.image);
      if (bg.progressionImage) sources.push(bg.progressionImage);
    }
    const survivalBg = level?.survival?.background;
    if (survivalBg?.type === 'image' && survivalBg.image) sources.push(survivalBg.image);
    return sources;
  }

  function prefetchLevelBackgrounds(level) {
    for (const src of collectLevelBackgroundSources(level)) {
      if (!isAssetImageSource(src)) continue;
      const key = assetCacheKey(src);
      if (!key || prefetchedBgKeys.has(key)) continue;
      prefetchedBgKeys.add(key);
      // Same candidate walker as real loads: honors CDN health ordering and
      // never leaves a prefetch hanging on a blackholed host.
      loadImageFromCandidates(src, { crossOrigin: 'anonymous' });
    }
  }

  function prefetchAdjacentLevelBackgrounds(nodeId) {
    const node = nodeMap.get(nodeId);
    const children = Array.isArray(node?.children) ? node.children : [];
    for (const childId of children) {
      const levelIndex = nodeIdToLevelIndex.get(childId);
      const level = levelIndex == null ? null : originalLevels[levelIndex];
      if (level) prefetchLevelBackgrounds(level);
    }
  }

  function schedulePrefetchAdjacentLevelBackgrounds(nodeId, delayMs = 1200) {
    if (bgPrefetchTimer) clearTimeout(bgPrefetchTimer);
    bgPrefetchTimer = setTimeout(() => {
      bgPrefetchTimer = null;
      try {
        prefetchAdjacentLevelBackgrounds(nodeId);
      } catch { /* prefetch is best-effort */ }
    }, delayMs);
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
        startCharacterRegistryWarmup();
        schedulePrefetchAdjacentLevelBackgrounds(currentNodeId, 800);
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
    setHudLockedByMap(false);
    game.pause();
    portraitReactionController.setPaused(true);
    syncPauseCharacterPicker();
    ensureFullCharacterRegistryReady()
      .then(() => syncPauseCharacterPicker())
      .catch(() => null);
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
    setHudLockedByMap(false);
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
    const introOptions = createPegIntroStartOptions({ suppressInputMs: 650 });
    if (activeCpuDuelMode) {
      startRandomCpuDuelLevel({
        ...introOptions,
        pegIntro: createPvpPegIntroOptions()
      });
      return;
    }
    hidePause();
    startLevel(currentNodeId, introOptions);
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

  function setLevelMapExiting(active) {
    visualLayout?.frame?.classList.toggle('visual-frame--level-map-exiting', !!active);
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
      const bleed = 12;
      const left = Math.max(0, Math.round(leftRect.right - frameRect.left) - bleed);
      const right = Math.min(Math.round(frameRect.width), Math.round(rightRect.left - frameRect.left) + bleed);
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
    const closingMap = activeLevelMap;
    showPauseOverlayInstant();
    closingMap.hide();
    activeLevelMap = null;
    activeLevelMapAllowClose = false;
    setLevelMapExiting(false);
    setLevelMapMode(false);
    setLevelMapExitVisual(false);
    setHudLockedByMap(false);
  }

  async function hideSelectedLevelMap(closingMap, options = {}) {
    if (!closingMap) return;
    await closingMap.hide({
      scrollUpMs: LEVEL_MAP_SCROLL_MS,
      scrollDirection: options.direction || 'up'
    });
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

    try {
      const mod = await getLevelMapModule();
      await mod.prewarmLevelMapAssets?.(levels, campaignGraph, { includePortraits: false });
    } catch (error) {
      console.warn('[player] Level map shell prewarm failed', error);
    }

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
          const closingMap = activeLevelMap;
          if (!closingMap) return;
          pauseOverlay.classList.add('pause-overlay--instant');
          pauseOverlay.classList.remove('visible');
          pauseOverlay.classList.remove('pause-overlay--map-mode');
          visualLayout.frame.classList.remove('visual-frame--paused');
          paused = false;
          portraitReactionController.setPaused(false);
          if (game) game.resume();
          setLevelMapMode(true);
          setHudLockedByMap(true);
          prepareGameplayHudEnter(canvas.getBoundingClientRect().height);
          playGameplayHudEnter();
          await hideSelectedLevelMap(closingMap);
          activeLevelMap = null;
          activeLevelMapAllowClose = false;
          setLevelMapMode(false);
          setLevelMapExiting(false);
          setLevelMapExitVisual(false);
          requestAnimationFrame(() => {
            pauseOverlay.classList.remove('pause-overlay--instant');
          });
          return;
        }
        const closingMap = activeLevelMap;
        if (!closingMap) return;
        paused = false;
        if (nodeId !== currentNodeId) {
          currentNodeId = nodeId;
          mirrorState = false;
          saveProgress();
        }
        startLevel(currentNodeId, createPegIntroStartOptions(
          { suppressInputMs: LEVEL_SCROLL_MS + 220 },
          LEVEL_MAP_SCROLL_MS + PEG_INTRO_BLANK_MS
        ));
        setLevelMapMode(true);
        setHudLockedByMap(true);
        prepareGameplayHudEnter(canvas.getBoundingClientRect().height);
        playGameplayHudEnter();
        await hideSelectedLevelMap(closingMap);
        activeLevelMap = null;
        activeLevelMapAllowClose = false;
        setLevelMapMode(false);
        setLevelMapExiting(false);
        setLevelMapExitVisual(false);
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

  let pvpCpuDuelLaunchPromise = null;
  async function startRandomCpuDuelLevel(options = {}) {
    if (pvpCpuDuelLaunchPromise) return pvpCpuDuelLaunchPromise;

    const button = pauseOverlay.querySelector('#pausePvpDuelBtn');
    if (button) button.disabled = true;

    pvpCpuDuelLaunchPromise = (async () => {
      const preferredLevels = initialCpuDuelMode ? [] : originalLevels;
      let level = await loadRandomPvpCpuDuelLevel({ preferredLevels });
      if (!level) {
        level = activeLevelData && ensureLevelPvp(activeLevelData).enabled
          ? preparePvpCpuDuelLevel(activeLevelData)
          : null;
        if (!level) {
          alert('No CPU Duel level configured.');
          return false;
        }
      }

      const fastDirectStart = options.fastStart === true || (
        !options.horizontalTransition &&
        options.pegIntro === undefined &&
        options.skipPvpCountdown !== false
      );
      mirrorState = false;
      const startOptions = {
        levelData: level,
        cpuDuel: true,
        suppressInputMs: Number.isFinite(options.suppressInputMs) ? options.suppressInputMs : 250,
        pegIntro: options.pegIntro !== undefined ? options.pegIntro : (fastDirectStart ? false : null),
        skipPvpCountdown: options.skipPvpCountdown === true || fastDirectStart
      };
      if (options.horizontalTransition) {
        transitionToLevel(currentNodeId, {
          ...startOptions,
          axis: 'x',
          direction: 'right'
        });
        return true;
      }
      return startLevel(currentNodeId, startOptions);
    })().finally(() => {
      pvpCpuDuelLaunchPromise = null;
      if (button) button.disabled = false;
    });

    return pvpCpuDuelLaunchPromise;
  }

  const pauseLevelBtn = pauseOverlay.querySelector('#pauseLevelBtn');
  pauseLevelBtn.addEventListener('pointerenter', () => scheduleLevelMapPrewarm({ immediate: true, includePortraits: true }));
  pauseLevelBtn.addEventListener('touchstart', () => scheduleLevelMapPrewarm({ immediate: true, includePortraits: true }), { passive: true });
  pauseLevelBtn.addEventListener('click', () => showLevelMap());
  const pausePvpDuelBtn = pauseOverlay.querySelector('#pausePvpDuelBtn');
  pausePvpDuelBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startRandomCpuDuelLevel();
  });
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
      if (game.isAimingState?.()) {
        game.state = 'idle';
        game.trajectory = null;
      }
    }
  });
  // Click on backdrop (outside panel) also resumes
  pauseOverlay.addEventListener('click', (e) => {
    if (e.target === pauseOverlay) hidePause();
  });

  pauseOverlay.querySelector('#pauseCharacterPrevBtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cyclePauseCharacter(-1);
  });
  pauseOverlay.querySelector('#pauseCharacterNextBtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cyclePauseCharacter(1);
  });
  let pauseCharacterSwipe = null;
  pauseOverlay.addEventListener('pointerdown', (event) => {
    if (!paused || activeLevelMap || event.target.closest?.('button, input, label')) return;
    const rect = pauseOverlay.getBoundingClientRect();
    if (event.clientY > rect.top + rect.height * 0.3) return;
    pauseCharacterSwipe = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId
    };
  });
  pauseOverlay.addEventListener('pointerup', (event) => {
    if (!pauseCharacterSwipe || pauseCharacterSwipe.pointerId !== event.pointerId) return;
    const dx = event.clientX - pauseCharacterSwipe.x;
    const dy = event.clientY - pauseCharacterSwipe.y;
    pauseCharacterSwipe = null;
    if (Math.abs(dx) < 34 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    cyclePauseCharacter(dx < 0 ? 1 : -1);
  });
  pauseOverlay.addEventListener('pointercancel', () => {
    pauseCharacterSwipe = null;
  });

  // Make topLeft and leftCircle slots trigger pause in play mode
  function setupPauseTriggers() {
    for (const slotId of ['top', 'topRight']) {
      const el = visualLayout.slotElements[slotId];
      if (!el) continue;
      el.classList.remove('visual-slot--pause-trigger', 'visual-slot--input-shield');
      el.classList.add('visual-slot--decorative-inert');
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
  const LEVEL_MAP_SCROLL_MS = LEVEL_SCROLL_MS;
  const HUD_ENTER_MS = 320;
  const PEG_INTRO_BLANK_MS = 58;
  const PEG_INTRO_STAGGER_MS = 12;
  const PEG_INTRO_MAX_SPREAD_MS = 520;
  const PEG_INTRO_DURATION_MS = 320;
  const PEG_INTRO_DIALOGUE_PAD_MS = 80;
  const PORTRAIT_SCROLL_SLOTS = ['character', 'characterCircle', 'healthCircle', 'healthCharCircle'];
  let transitionOverlay = null;
  let transitionTimer = null;
  let hudEnterTimer = null;
  let levelStartDialogueTimer = null;

  function clearPortraitScrollFx() {
    if (!visualLayout) return;
    for (const slotId of PORTRAIT_SCROLL_SLOTS) {
      visualLayout.clearSlotRuntimeFx(slotId);
    }
  }

  function setPortraitScrollFx(offsetY, offsetX = 0) {
    if (!visualLayout) return;
    for (const slotId of PORTRAIT_SCROLL_SLOTS) {
      if (!visualLayout.slotElements?.[slotId]) continue;
      visualLayout.setSlotRuntimeFx(slotId, { translateX: offsetX, translateY: offsetY });
    }
  }

  function clearLevelTransitionArtifacts() {
    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    if (hudEnterTimer) {
      clearTimeout(hudEnterTimer);
      hudEnterTimer = null;
    }
    if (transitionOverlay?.parentNode) {
      transitionOverlay.parentNode.removeChild(transitionOverlay);
    }
    transitionOverlay = null;
    canvas.style.transition = '';
    canvas.style.transform = '';
    canvas.parentElement?.classList.remove('canvas-container--soft-horizontal');
    clearPortraitScrollFx();
    const gambleRoot = gambleSystem?.ui?.root;
    if (gambleRoot) {
      gambleRoot.style.transition = '';
      gambleRoot.style.transform = '';
      gambleRoot.style.willChange = '';
    }
  }

  function prepareGameplayHudEnter(canvasHeight) {
    const distance = Math.max(1, Math.round(canvasHeight || visualLayout?.frame?.getBoundingClientRect?.().height || 0));
    setLevelMapExiting(true);
    setLevelMapExitVisual(false);
    setHudLockedByMap(false);
    const gambleRoot = gambleSystem?.ui?.root;
    if (gambleRoot) {
      gambleRoot.style.transition = 'none';
      gambleRoot.style.transform = `translateY(${distance}px)`;
      gambleRoot.style.willChange = 'transform';
    }
  }

  function playGameplayHudEnter() {
    setHudLockedByMap(false);
    requestAnimationFrame(() => {
      const gambleRoot = gambleSystem?.ui?.root;
      if (gambleRoot) {
        gambleRoot.style.transition = `transform ${HUD_ENTER_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        gambleRoot.style.transform = '';
      }
      hudEnterTimer = setTimeout(() => {
        hudEnterTimer = null;
        if (gambleRoot) {
          gambleRoot.style.transition = '';
          gambleRoot.style.willChange = '';
        }
      }, HUD_ENTER_MS + 80);
    });
  }

  function createPegIntroOptions(delayMs = PEG_INTRO_BLANK_MS) {
    return {
      delayMs,
      staggerMs: PEG_INTRO_STAGGER_MS,
      maxSpreadMs: PEG_INTRO_MAX_SPREAD_MS,
      durationMs: PEG_INTRO_DURATION_MS
    };
  }

  function createPvpPegIntroOptions(delayMs = PEG_INTRO_BLANK_MS) {
    return {
      ...createPegIntroOptions(delayMs),
      order: 'center-out-y',
      originY: WORLD_H / 2
    };
  }

  function createPegIntroStartOptions(options = {}, delayMs = PEG_INTRO_BLANK_MS) {
    return {
      ...options,
      pegIntro: options.pegIntro || createPegIntroOptions(delayMs)
    };
  }

  function transitionToLevel(nodeId, options = {}) {
    const horizontal = options.axis === 'x' || options.direction === 'right' || options.direction === 'left';
    const direction = horizontal
      ? (options.direction === 'left' ? 'left' : 'right')
      : (options.direction === 'down' ? 'down' : 'up');
    const transitionLevel = options.levelData && Array.isArray(options.levelData.pegs)
      ? options.levelData
      : null;
    const isPvpTransition = transitionLevel ? ensureLevelPvp(transitionLevel).enabled : false;
    const resolvePegIntro = (fallbackFactory) => {
      if (options.pegIntro === false) return false;
      if (options.pegIntro) return options.pegIntro;
      return typeof fallbackFactory === 'function' ? fallbackFactory() : null;
    };
    const buildStartOptions = (extra = {}) => ({
      ...(transitionLevel ? { levelData: transitionLevel, cpuDuel: options.cpuDuel === true } : {}),
      suppressInputMs: Number.isFinite(options.suppressInputMs) ? options.suppressInputMs : 650,
      ...(options.skipPvpCountdown === true ? { skipPvpCountdown: true } : {}),
      ...extra
    });
    const frame = visualLayout.frame;
    if (!frame) {
      startLevel(nodeId, buildStartOptions({
        pegIntro: resolvePegIntro(() => (isPvpTransition ? createPvpPegIntroOptions() : null))
      }));
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
      startLevel(nodeId, buildStartOptions({
        pegIntro: resolvePegIntro(() => (isPvpTransition ? createPvpPegIntroOptions() : null))
      }));
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
    outgoingCanvas.className = horizontal ? 'level-transition-canvas--soft-edge' : '';
    outgoingCanvas.style.transform = horizontal ? 'translateX(0)' : 'translateY(0)';
    outgoingCanvas.style.transition = `transform ${LEVEL_SCROLL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    overlay.appendChild(outgoingCanvas);

    frame.appendChild(overlay);
    transitionOverlay = overlay;

    const translate = horizontal ? 'translateX' : 'translateY';
    const incomingStart = horizontal
      ? (direction === 'right' ? '100%' : '-100%')
      : (direction === 'down' ? '-100%' : '100%');
    const outgoingEnd = horizontal
      ? (direction === 'right' ? '-100%' : '100%')
      : (direction === 'down' ? '100%' : '-100%');
    const pegIntro = resolvePegIntro(() => (isPvpTransition
      ? createPvpPegIntroOptions(LEVEL_SCROLL_MS + PEG_INTRO_BLANK_MS)
      : createPegIntroOptions(LEVEL_SCROLL_MS + PEG_INTRO_BLANK_MS)));
    const pegIntroMinMs = pegIntro ? pegIntro.delayMs + PEG_INTRO_DURATION_MS : 0;

    canvas.style.transition = 'none';
    canvas.style.transform = `${translate}(${incomingStart})`;
    if (horizontal) {
      canvas.parentElement?.classList.add('canvas-container--soft-horizontal');
    }
    if (!horizontal) {
      setPortraitScrollFx(direction === 'down' ? -canvasRect.height : canvasRect.height);
    }

    const started = startLevel(nodeId, buildStartOptions({
      clearTransition: false,
      suppressInputMs: pegIntro ? pegIntroMinMs + 120 : (
        Number.isFinite(options.suppressInputMs) ? options.suppressInputMs : 650
      ),
      pegIntro
    }));
    if (!started) {
      clearLevelTransitionArtifacts();
      return;
    }

    requestAnimationFrame(() => {
      canvas.style.transition = `transform ${LEVEL_SCROLL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      canvas.style.transform = `${translate}(0)`;
      outgoingCanvas.style.transform = `${translate}(${outgoingEnd})`;
      if (!horizontal) setPortraitScrollFx(0, 0);
    });

    transitionTimer = setTimeout(() => {
      clearLevelTransitionArtifacts();
    }, LEVEL_SCROLL_MS + 90);
  }

  // --- Level lifecycle ---

  function startLevel(nodeId, options = {}) {
    const clearTransition = options.clearTransition !== false;
    if (clearTransition) clearLevelTransitionArtifacts();
    if (levelStartDialogueTimer) {
      clearTimeout(levelStartDialogueTimer);
      levelStartDialogueTimer = null;
    }
    const preparedLevel = options.levelData && Array.isArray(options.levelData.pegs)
      ? options.levelData
      : null;
    let levelData = null;
    if (preparedLevel) {
      activeCpuDuelMode = options.cpuDuel === true;
      levelData = cloneLevelData(preparedLevel);
    } else {
      activeCpuDuelMode = initialCpuDuelMode;
      const levelIndex = nodeIdToLevelIndex.get(nodeId);
      if (levelIndex == null) return false;
      const original = originalLevels[levelIndex];
      if (!original) return false;
      currentNodeId = nodeId;
      levelData = mirrorState ? mirrorLevel(original) : cloneLevelData(original);
      applyRuntimeCharacterAssignment(levelData, nodeId);
    }
    activeLevelData = levelData;
    syncPauseCharacterPicker();

    // Cleanup previous
    if (unsubUiState) { unsubUiState(); unsubUiState = null; }
    if (game) { game.stop(); }
    paused = false;
    activeLevelMapAllowClose = false;
    setLevelMapExiting(false);
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
          updatePvpPortraitVisuals(levelData, state, 'human');
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
    game.confirmShoot = !!localStorage.getItem('peggle_confirmShoot');

    // Portrait ignite flame builds up live as the in-progress shot clears pegs.
    game.onShotHeat = (h) => visualLayout.setFlameHeat(h);

    // Apply visuals (background + frame + slots)
    const visuals = resolveVisualsWithCharacter(levelData);
    visualLayout.setConfig(visuals);
    game.renderer.setBackground(visuals.background);
    game.renderer.setBallTrail(visuals.ballTrail);
    game.renderer.setShockwave(visuals.shockwave);
    game.renderer.onVerticalProgress = (progress) => {
      visualLayout.updateSurvivalProgressIndicator(progress);
    };
    game.setEndSequenceConfig?.(visuals.endSequence);

    game.loadLevel(levelData);
    let pegIntroMs = 0;
    const pegIntroOptions = options.pegIntro === false
      ? null
      : (options.pegIntro || (pvp.enabled ? createPvpPegIntroOptions() : null));
    if (pegIntroOptions) {
      pegIntroMs = game.queuePegEntryAnimations?.(pegIntroOptions) || 0;
      if (pegIntroMs > 0) game.suppressInputFor?.(pegIntroMs + 80);
    }
    if (pvp.enabled && options.skipPvpCountdown !== true) {
      const countdownMs = game.startIntroCountdown?.(pegIntroMs) || 0;
      if (countdownMs > 0) game.suppressInputFor?.(countdownMs + 80);
    }
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
    game.setAimLength?.(typeof levelData.aimLength === 'number'
      ? (pvp.enabled ? (pvp.aimLength ?? PVP_DEFAULT_AIM_LENGTH) : levelData.aimLength)
      : (pvp.enabled ? (pvp.aimLength ?? PVP_DEFAULT_AIM_LENGTH) : 300));
    dialogueController.setContext({
      level: levelData,
      scopeKey: campaignName ? `campaign:${campaignName}` : 'single',
      game,
      gambleSystem,
      persistSeen: true,
      live: true,
      triggerLevelStart: pegIntroMs <= 0
    });
    dialogueController.setLanguage(currentLanguage);
    if (pegIntroMs > 0) {
      const introGame = game;
      const introLevel = levelData;
      levelStartDialogueTimer = setTimeout(() => {
        levelStartDialogueTimer = null;
        if (game !== introGame || activeLevelData !== introLevel) return;
        dialogueController.evaluateEvent('levelStart', { level: introLevel });
      }, pegIntroMs + PEG_INTRO_DIALOGUE_PAD_MS);
    }

    // Subscribe to UI state for ball counter + health bar
    unsubUiState = game.subscribeUiState((snapshot) => {
      if (snapshot.ballsLeft != null) {
        visualLayout.updateBallCounter(snapshot.ballsLeft, snapshot.initialBallCount);
      }
      if (Number.isFinite(snapshot.orangePegsLeft)) {
        visualLayout.updateHealthBar(snapshot.orangePegsLeft, snapshot.totalOrangePegs);
      }
      visualLayout.setBilliardTopLauncherActive?.(
        !!snapshot.billiardPhase && snapshot.billiardLauncherIndex === 0
      );
      if (!pvp.enabled) {
        visualLayout.setPvpOpponentTarget?.(null);
      }
    });

    game.onGameEnd = (result, score) => {
      const endedGame = game;
      const shouldAutoContinueWin = result === 'won' && !activeCpuDuelMode && !pvp.enabled;
      const bindDelayMs = shouldAutoContinueWin ? 0 : (endedGame?.getEndOverlayInteractDelayMs?.() ?? 1000);
      setTimeout(async () => {
        if (!endedGame || game !== endedGame) return;
        // Guard: only fire once (touchstart + click can both trigger on mobile)
        let fired = false;
        const onceAction = (action, options = {}) => {
          const acceptAfter = performance.now() + Math.max(0, Number(options.ignoreEarlyMs) || 0);
          const guarded = (event) => {
            if (event && performance.now() < acceptAfter) return;
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
          if (options.auto === true) {
            guarded();
            return;
          }
          canvas.addEventListener('click', guarded);
          canvas.addEventListener('touchstart', guarded, { passive: false });
        };

        if (activeCpuDuelMode && pvp.enabled) {
          onceAction(() => {
            startRandomCpuDuelLevel({ suppressInputMs: 650, horizontalTransition: true });
          }, { ignoreEarlyMs: 450 });
        } else if (result === 'won') {
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
            }, { auto: true });
          } else if (outcome.action === 'choose') {
            const allowed = new Set(outcome.choices);
            onceAction(() => {
              saveProgress();
              paused = true;
              showLevelMap(async (nodeId) => {
                if (!allowed.has(nodeId) || !nodeIdToLevelIndex.has(nodeId)) return;
                const closingMap = activeLevelMap;
                paused = false;
                currentNodeId = nodeId;
                mirrorState = false;
                saveProgress();
                startLevel(currentNodeId, createPegIntroStartOptions(
                  { suppressInputMs: LEVEL_SCROLL_MS + 220 },
                  LEVEL_MAP_SCROLL_MS + PEG_INTRO_BLANK_MS
                ));
                setLevelMapMode(true);
                setHudLockedByMap(true);
                prepareGameplayHudEnter(canvas.getBoundingClientRect().height);
                playGameplayHudEnter();
                await hideSelectedLevelMap(closingMap);
                activeLevelMap = null;
                activeLevelMapAllowClose = false;
                setLevelMapMode(false);
                setLevelMapExiting(false);
                setLevelMapExitVisual(false);
              }, { allowClose: false, fallbackNodeId: outcome.choices[0] });
            }, { auto: true });
          } else {
            // Campaign complete — tap to replay
            onceAction(() => {
              completedNodes.clear();
              mirrorState = false;
              currentNodeId = playableOrder[0];
              saveProgress();
              transitionToLevel(currentNodeId);
            }, { auto: true });
          }
        } else if (pvp.enabled) {
          onceAction(() => {
            startRandomCpuDuelLevel({ suppressInputMs: 650, horizontalTransition: true });
          }, { ignoreEarlyMs: 450 });
        } else {
          // Defeat — toggle mirror and restart same level
          mirrorState = !mirrorState;
          onceAction(() => transitionToLevel(currentNodeId));
        }
      }, bindDelayMs);
    };

    resize();
    game.start();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      markPlayerReady();
      startCharacterRegistryWarmup();
    }));
    if (!preparedLevel) {
      schedulePrefetchAdjacentLevelBackgrounds(nodeId);
    }
    return true;
  }

  ensureGambleSystem();
  startLevel(currentNodeId, initialCpuDuelMode
    ? { pegIntro: false, skipPvpCountdown: true, suppressInputMs: 120 }
    : (campaignName ? { pegIntro: createPegIntroOptions() } : {})
  );
  requestAnimationFrame(() => schedulePauseAssetsWarmup());
  // Cold start: the initial campaign payload is partial (level 1 only), so the
  // next level's background can't be prefetched until the full campaign is
  // hydrated. Kick hydration during idle time — it must happen before the
  // first win anyway — then warm the adjacent backgrounds.
  if (campaignName) {
    setTimeout(() => {
      ensureFullCampaignReady()
        .then(() => prefetchAdjacentLevelBackgrounds(currentNodeId))
        .catch(() => { /* best-effort */ });
    }, 4000);
  }
}
