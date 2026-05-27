// Peggle Main - App initialization and UI management

import { Game } from './game.js';
import { Editor } from './editor.js';
import { LevelManager, cloneLevelSnapshot, normalizeLevelData } from './levels.js';
import { PHYSICS_CONFIG } from './physics.js';
import { FLIPPER_DEFAULTS, createDefaultFlipperConfig, normalizeFlipperConfig } from './flipper-defaults.js';
import {
  ensureLevelSurvival,
  getSurvivalSpeedCurvePreset,
  normalizeSurvivalGamblePegProperties,
  normalizeSurvivalSettings,
  normalizeSurvivalSpeedCurve,
  SURVIVAL_GAMBLE_BALL_COUNT_MAX,
  SURVIVAL_GAMBLE_BALL_COUNT_MIN,
  SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX,
  SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MIN,
  SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MAX_MS,
  SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MIN_MS,
  SURVIVAL_SPEED_CURVE_PRESETS
} from './survival-mode.js';
import {
  ensureLevelPvp,
  normalizePvpAuthoredPegs,
  normalizePvpSettings,
  PVP_DEFAULT_AIM_LENGTH
} from './pvp-mode.js';
import { PvpRuntime } from './pvp-runtime.js';
import { GambleSystem } from './gamble-system.js';
import { normalizeYoyoSettings } from './yoyo-thread.js';
import {
  normalizeHitPegClearDelayMs,
  normalizeLevelHitPegClearSettings
} from './hit-peg-clear-settings.js';
import {
  MULTIBALL_MAX_SPAWN_COUNT,
  MULTIBALL_MIN_SPAWN_COUNT,
  normalizeMultiballSpawnCount
} from './multiball-settings.js';
import {
  PORTAL_DEFAULT_SCALE,
  PORTAL_MAX_SCALE,
  PORTAL_MIN_SCALE
} from './portal-defaults.js';
import {
  BILLIARD_RED,
  BILLIARD_YELLOW,
  ensureLevelBilliard,
  isBilliardPegType,
  normalizeBilliardSettings
} from './billiard-mode.js';
import {
  ensureLevelDestruction,
  normalizeDestructionSettings
} from './destruction-mode.js';
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import {
  attachCharacterSnapshotToLevel,
  CANONICAL_EMOTION_SLOTS,
  createDefaultCharacter,
  DEFAULT_CHARACTER_ID,
  DEFAULT_PERSONALITY,
  getCharacterSlotSource,
  getCharacterSlotSources,
  loadCharacterRegistry,
  makeCharacterId,
  mergePersonalityPatch,
  normalizeCharacter,
  normalizeCharacterRegistry,
  normalizeLevelCharacterAssignment,
  normalizePersonality,
  normalizePersonalityPatch,
  readCharacterImageFile,
  resolveCharacterForLevel,
  saveCharacterRegistry
} from './character-config.js';
import { PortraitReactionController } from './portrait-reactions.js';
import { CampaignManager } from './campaign-manager.js';
import { api } from './api.js';
import { compressImageFile, compressLevelBackgroundImages } from './image-compression.js';
import { computeLayout, toPixelPositions } from './graph/layout.js';
import { Utils } from './utils.js';
import { DialogueController } from './dialogue-controller.js';
import {
  clampDialogueEmotionMagnitude,
  clampDialogueTimeoutMs,
  createDialogueEntry,
  normalizeDialogueConfig
} from './dialogue-config.js';
import { getStoredLanguage, normalizeLanguage } from './localization.js';
import { PERK_DEFINITIONS } from './gamble-system.js';
import { decodeBakedLevelJsonFromText, extractBakedLevelHash } from './baked-level-codec.js';

// Fixed aspect ratio: 3:4.5 (width:height)
const ASPECT_RATIO = 3 / 4.5;
const MAX_WIDTH = 400;
const PVP_DUEL_LEVELS_STORAGE_KEY = 'pvp:duel:levels';

const CHARACTER_SLOT_LABELS = {
  idle: 'Composed',
  amused: 'Amused',
  enthralled: 'Excited',
  disappointed: 'Disappointed',
  'happy-mocking': 'Playfully mocking',
  worried: 'Worried',
  anger: 'Angry',
  victory: 'After-win'
};

const CHARACTER_EVENT_META = {
  peg_hit: { label: 'Peg hit', group: 'Core play' },
  peg_streak_N: { label: 'Combo milestone', group: 'Core play' },
  spin_triggered: { label: 'Spin starts', group: 'Spin' },
  spin_win_small: { label: 'Small spin win', group: 'Spin' },
  spin_win_big: { label: 'Big spin win', group: 'Spin' },
  spin_lose: { label: 'Spin miss', group: 'Spin' },
  jackpot: { label: 'Jackpot', group: 'Big moments' },
  ball_lost_clean: { label: 'Ball lost', group: 'Losses' },
  ball_lost_after_streak: { label: 'Ball lost after combo', group: 'Losses' },
  pressure_low_balls: { label: 'Low balls pressure', group: 'Losses' },
  level_clear: { label: 'Level cleared', group: 'Big moments' },
  aim_held_too_long: { label: 'Aiming too long', group: 'Personality' },
  safe_play_pattern: { label: 'Playing too safely', group: 'Personality' },
  dialogue_impulse: { label: 'Dialogue nudge', group: 'Dialogue' }
};

const CHARACTER_EVENT_UI_HIDDEN = new Set(['dialogue_impulse']);

const CHARACTER_SCALAR_CONTROLS = [
  { path: ['refractoryMs'], label: 'Cooldown window', min: 0, max: 3000, step: 50, suffix: 'ms' },
  { path: ['refractoryScale'], label: 'Cooldown softness', min: 0, max: 1, step: 0.05, format: 'percent' },
  { path: ['preemptThreshold'], label: 'Big reaction threshold', min: 0.2, max: 1.6, step: 0.05 },
  { path: ['saturationCap'], label: 'Maximum emotion strength', min: 0.5, max: 3, step: 0.05 },
  { path: ['dwellMs'], label: 'Minimum hold time', min: 0, max: 2000, step: 50, suffix: 'ms' },
  { path: ['returnToBaselineDelayMs'], label: 'Return to rest delay', min: 0, max: 6000, step: 100, suffix: 'ms' },
  { path: ['leadMargin'], label: 'Swap confidence margin', min: 0, max: 0.6, step: 0.01, format: 'percent' },
  { path: ['crossfadeMs'], label: 'Normal fade', min: 0, max: 1200, step: 25, suffix: 'ms' },
  { path: ['fastCrossfadeMs'], label: 'Fast fade', min: 0, max: 600, step: 25, suffix: 'ms' }
];

const CHARACTER_RESTING_CONTROLS = [
  { path: ['baseline', 'target'], label: 'Resting intensity', min: 0, max: 1.5, step: 0.05 },
  { path: ['baseline', 'rate'], label: 'Return speed', min: 0, max: 1, step: 0.01 },
  { path: ['boredom', 'afterMs'], label: 'Quiet delay', min: 1000, max: 20000, step: 500, suffix: 'ms' },
  { path: ['boredom', 'magnitudePerSecond'], label: 'Quiet mood strength', min: 0, max: 0.2, step: 0.005 }
];

const CHARACTER_AMBIENT_CONTROLS = [
  { path: ['ambient', 'idleAfterMs'], label: 'Start ambient after', min: 2000, max: 30000, step: 500, suffix: 'ms' },
  { path: ['ambient', 'samplerMinMs'], label: 'Shortest pause between looks', min: 1000, max: 15000, step: 500, suffix: 'ms' },
  { path: ['ambient', 'samplerMaxMs'], label: 'Longest pause between looks', min: 1000, max: 30000, step: 500, suffix: 'ms' }
];

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pathKey(path) {
  return path.join('|');
}

function parsePathKey(key) {
  return String(key || '').split('|').filter(Boolean);
}

function getPathValue(source, path) {
  let cursor = source;
  for (const part of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPathValue(target, path, value) {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[path[path.length - 1]] = value;
}

function deletePathValue(target, path) {
  const stack = [];
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (!cursor || typeof cursor !== 'object') return;
    stack.push([cursor, part]);
    cursor = cursor[part];
  }
  if (cursor && typeof cursor === 'object') delete cursor[path[path.length - 1]];
  for (let i = stack.length - 1; i >= 0; i--) {
    const [parent, key] = stack[i];
    const value = parent[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      delete parent[key];
    }
  }
}

function pruneEmptyObjects(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      pruneEmptyObjects(child);
      if (Object.keys(child).length === 0) delete value[key];
    }
  }
  return value;
}

function formatCharacterLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Expression';
  if (CHARACTER_SLOT_LABELS[raw]) return CHARACTER_SLOT_LABELS[raw];
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function formatTuningValue(value, control = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (control.format === 'percent') return `${Math.round(n * 100)}%`;
  if (control.suffix === 'ms') return `${Math.round(n)}ms`;
  return Number.isInteger(n) ? String(n) : n.toFixed(control.step && control.step < 0.01 ? 3 : 2);
}

function countPersonalityPatchFields(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.length > 0 ? 1 : 0;
  let count = 0;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) count += countPersonalityPatchFields(child);
    else if (child !== undefined) count += 1;
  }
  return count;
}

function characterOverrideComment(path, label = 'this setting') {
  const key = pathKey(path);
  const comments = {
    'baseline|slot': 'Use a different resting face for this level only.',
    'baseline|target': 'Changes how strongly the resting face holds when nothing else is happening.',
    'baseline|rate': 'Changes how quickly the character settles back after reactions.',
    'boredom|slot': 'Chooses the face she drifts toward during quiet or paused play.',
    'boredom|afterMs': 'Changes how long quiet play waits before the character starts drifting.',
    'boredom|magnitudePerSecond': 'Changes how strongly the quiet mood builds over time.',
    refractoryMs: 'After a big reaction, this is how long later reactions are softened.',
    refractoryScale: 'Controls how much smaller reactions become during that cooldown.',
    preemptThreshold: 'Sets how strong a reaction must be to interrupt the current face immediately.',
    saturationCap: 'Limits how intense any one expression can become.',
    dwellMs: 'Keeps a face on screen for at least this long during normal swaps.',
    returnToBaselineDelayMs: 'Waits this long after a reaction before letting the face settle back to rest.',
    leadMargin: 'Requires a new mood to be clearly stronger before it replaces the current face.',
    crossfadeMs: 'Sets the fade speed for ordinary expression changes.',
    fastCrossfadeMs: 'Sets the faster fade used by big moments like jackpots and clears.',
    streakThresholds: 'Chooses which combo counts fire special combo reactions.'
  };
  if (comments[key]) return comments[key];
  if (path[0] === 'impulseTable' && path[2] === 'magnitude') {
    const eventLabel = CHARACTER_EVENT_META[path[1]]?.label || formatCharacterLabel(path[1]);
    return `Changes how strongly ${eventLabel.toLowerCase()} pushes the character mood in this level.`;
  }
  if (path[0] === 'impulseTable' && path[2] === 'distribution') {
    return `Changes which expressions ${label.toLowerCase()} can roll in this level.`;
  }
  return `Overrides ${label.toLowerCase()} for this level only.`;
}

class PeggleApp {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.levelManager = new LevelManager();
    this.campaignManager = new CampaignManager();
    // Refresh campaign UI if remote sync brings new data while overlay is open
    this.campaignManager.onSync = () => {
      if (document.getElementById('campaignOverlay')?.classList.contains('visible')) {
        this._renderCampaignList();
      }
      if (this._editingCampaignId && document.getElementById('campaignEditOverlay')?.classList.contains('visible')) {
        this._refreshCampaignEditor(this._editingCampaignId);
      }
    };
    this.game = null;
    this.editor = null;
    this.gambleSystem = null;
    this.visualLayout = new VisualLayout();
    this._editingCampaignId = null;
    this._campaignsSynced = false;
    this._campaignSyncPromise = null;
    this._primaryCampaignName = undefined;
    this._primaryCampaignPromise = null;
    this._campaignAvailableLevelsRequest = 0;
    this._pvpDuelLevelNames = null;
    this._pvpDuelLevelsPromise = null;
    this._pvpAvailableLevelsRequest = 0;
    this._pendingRemoteLevelSaves = new Map();
    this._remoteLevelSyncFailures = new Map();
    this._characterRegistrySyncTimer = null;
    this._pendingCharacterRegistrySync = null;
    this._editorSideSheetLayer = null;
    this._editorSideSheetIds = ['levelListOverlay', 'campaignOverlay', 'pvpLevelsOverlay', 'campaignEditOverlay', 'dialogueOverlay', 'characterOverlay'];
    this._dialogueSelectedEntryId = null;
    this._dialoguePreviewState = null;
    this.characterRegistry = loadCharacterRegistry();
    this._selectedCharacterEditorId = this.characterRegistry.selectedId || DEFAULT_CHARACTER_ID;
    this._expressionVariantIndex = new Map();
    this.dialogueLanguage = getStoredLanguage();
    this.dialogueController = new DialogueController({ visualLayout: this.visualLayout, persistSeen: false });
    this.portraitReactionController = new PortraitReactionController({ visualLayout: this.visualLayout });
    this.dialogueController.setPortraitReactionController(this.portraitReactionController);

    this.campaignManager.beforeSyncCampaign = (campaign) => this._awaitCampaignRemoteLevelSaves(campaign);
    this.mode = 'editor'; // 'editor' or 'play'
    this._syncTimer = null;

    // Hook into LevelManager.save to auto-sync current level to remote
    const origSave = this.levelManager.save.bind(this.levelManager);
    this.levelManager.save = () => {
      origSave();
      this._debouncedRemoteSync();
    };

    this.visualLayout.mount();
    this.dialogueController.mount();
    this.dialogueController.setLanguage(this.dialogueLanguage);
    this._injectAdminPanel();
    this._ensureCharacterOverlay();
    this.setupCanvas();
    this._mountEditorSideSheets();
    this.setupUI();
    this.initMode();

    // One-time diagnostics
    this._logDiagnostics();
  }

  _injectAdminPanel() {
    const viewport = this.visualLayout.viewport;
    if (!viewport) return;

    const panel = document.createElement('div');
    panel.className = 'admin-panel';
    panel.id = 'adminPanel';
    panel.innerHTML = `
      <div class="admin-panel-title">Editor</div>
      <div class="admin-panel-body">
        <div class="theme-section">
          <div class="theme-label">Level Settings</div>
          <input type="text" id="levelName" class="admin-input" placeholder="Level Name">
          <select id="levelDifficulty" class="admin-select">
            <option value="1">Easy</option>
            <option value="2">Medium</option>
            <option value="3">Hard</option>
            <option value="4">Expert</option>
            <option value="5">Extreme</option>
          </select>
          <label class="admin-toggle"><input type="checkbox" id="yoyoThreadToggle"> Yo-yo Thread</label>
          <label class="admin-toggle"><input type="checkbox" id="yoyoDebugDragToggle"> Yo-yo Debug Drag</label>
          <button id="characterBtn" class="admin-btn">Characters</button>
          <button id="dialogueBtn" class="admin-btn">Dialogues</button>
          <button id="addToTrainingBtn" class="admin-btn">Add to Training</button>
          <button id="themeDefaultBtn" class="admin-btn">Default Theme</button>
        </div>
        <div class="theme-section">
          <div class="theme-label">Levels</div>
          <button id="newLevelBtn" class="admin-btn">+ New Level</button>
          <button id="levelListBtn" class="admin-btn">Level List</button>
          <button id="campaignBtn" class="admin-btn">Campaigns</button>
          <button id="pvpLevelsBtn" class="admin-btn">PvP Duel Levels</button>
        </div>
        <div class="theme-section">
          <div class="theme-label">Settings</div>
          <button id="physicsBtn" class="admin-btn">Physics</button>
          <button id="clearBtn" class="admin-btn admin-btn--danger">Clear All Pegs</button>
        </div>
        <div class="theme-section">
          <div class="theme-label">Import / Export</div>
          <button id="exportBtn" class="admin-btn">Export Level</button>
          <button id="importBtn" class="admin-btn">Import Level</button>
          <button id="importLinkBtn" class="admin-btn">Import Player Link</button>
          <button id="exportTrainingBtn" class="admin-btn">Export Training</button>
        </div>
      </div>
    `;
    viewport.appendChild(panel);
    this.adminPanel = panel;
  }

  _ensureCharacterOverlay() {
    if (document.getElementById('characterOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'characterOverlay';
    overlay.className = 'campaign-overlay character-overlay';
    overlay.innerHTML = `
      <div class="level-list-header">
        <button id="closeCharacterOverlay" class="header-btn">&larr;</button>
        <h2 class="level-list-title">Characters</h2>
        <button id="addCharacterBtn" class="header-btn" title="New Character">+</button>
      </div>
      <div id="characterEditorBody" class="dialogue-edit-body character-edit-body"></div>
    `;
    document.body.appendChild(overlay);
  }

  _mountEditorSideSheets() {
    const viewport = this.visualLayout.viewport;
    if (!viewport) return;

    let layer = document.getElementById('editorSideSheetLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'editor-side-sheet-layer';
      layer.id = 'editorSideSheetLayer';
      viewport.appendChild(layer);
    }

    for (const id of this._editorSideSheetIds) {
      const el = document.getElementById(id);
      if (el && el.parentElement !== layer) {
        layer.appendChild(el);
      }
    }

    this._editorSideSheetLayer = layer;
    this._positionEditorSideSheets();
  }

  _positionEditorSideSheets() {
    const viewport = this.visualLayout.viewport;
    const layer = this._editorSideSheetLayer;
    if (!viewport || !layer) return;

    const vpRect = viewport.getBoundingClientRect();
    if (!vpRect.width || !vpRect.height) return;

    const margin = vpRect.width < 520 ? 6 : 8;
    const anchors = ['visualFrame', 'themePanel', 'adminPanel']
      .map(id => document.getElementById(id))
      .filter(el => {
        if (!el || el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

    let contentRight = 0;
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      contentRight = Math.max(contentRight, rect.right - vpRect.left);
    }

    const left = contentRight + margin;
    const width = Math.max(180, vpRect.width - left - margin);
    const top = 0;
    const bottom = 0;

    layer.dataset.docked = 'right';

    for (const id of this._editorSideSheetIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.style.left = `${Math.round(left)}px`;
      el.style.right = 'auto';
      el.style.top = `${Math.round(top)}px`;
      el.style.bottom = `${Math.round(bottom)}px`;
      el.style.width = `${Math.round(width)}px`;
      el.classList.add('editor-side-sheet--docked');
    }
  }

  async _pullRemoteLevels() {
    try {
      const remoteNames = await api.listLevels();
      if (!remoteNames || remoteNames.length === 0) return;
      const localNames = new Set();
      for (const l of this.levelManager.getAllLevels()) {
        localNames.add((l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_'));
        localNames.add(l.name || '');
      }
      let added = 0;
      for (const name of remoteNames) {
        if (localNames.has(name)) continue;
        const data = await api.getLevel(name);
        if (data && Array.isArray(data.pegs)) {
          // Import remote level into local editor
          if (!data.id) data.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const normalized = this.levelManager.normalizeLevel(data);
          if (normalized) {
            this.levelManager.levels.push(normalized);
            added++;
          }
        }
      }
      if (added > 0) {
        this.levelManager.save();
        console.log(`[pull] Imported ${added} remote levels`);
      }
    } catch (e) {
      console.warn('[pull] Failed to pull remote levels:', e);
    }
  }

  _debouncedRemoteSync() {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(async () => {
      this._syncTimer = null;
      const level = this.levelManager.getCurrentLevel();
      if (!level) return;
      const safeName = (level.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
      const snapshot = await this._cloneLevelSnapshotForStorage(level);
      if (!snapshot) return;
      api.saveLevel(safeName, snapshot).then(ok => {
        if (ok) console.log('[auto-sync] Saved to remote:', safeName);
      });
    }, 2000); // 2s debounce to avoid spamming during rapid edits
  }

  _logDiagnostics() {
    const c = this.canvas;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const ctxSettings = ctx.getContextAttributes ? ctx.getContextAttributes() : 'N/A';
    console.log('=== PEGGLE DIAGNOSTICS ===');
    console.log(`Canvas buffer: ${c.width}x${c.height}`);
    console.log(`Canvas CSS: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
    console.log(`devicePixelRatio: ${dpr}`);
    console.log(`Context attributes:`, ctxSettings);
    console.log(`User agent: ${navigator.userAgent}`);
    console.log(`Screen: ${screen.width}x${screen.height} (${screen.colorDepth}bit)`);
    // Check if canvas is offscreen/hidden
    console.log(`Canvas visible: offsetWidth=${c.offsetWidth} offsetHeight=${c.offsetHeight}`);
    // Check for potential CSS performance killers around canvas
    const canvasStyles = getComputedStyle(c);
    console.log(`Canvas filter: ${canvasStyles.filter}`);
    console.log(`Canvas transform: ${canvasStyles.transform}`);
    console.log(`Canvas opacity: ${canvasStyles.opacity}`);
    console.log(`Canvas will-change: ${canvasStyles.willChange}`);
    // Check parent chain for backdrop-filter
    let el = c.parentElement;
    let depth = 0;
    while (el && depth < 10) {
      const s = getComputedStyle(el);
      const bf = s.backdropFilter || s.webkitBackdropFilter;
      const f = s.filter;
      if ((bf && bf !== 'none') || (f && f !== 'none')) {
        console.log(`  Parent[${depth}] ${el.tagName}.${el.className.split(' ')[0]}: backdrop-filter=${bf} filter=${f}`);
      }
      el = el.parentElement;
      depth++;
    }
    console.log('=========================');
  }

  setupCanvas() {
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    // Fixed game-world size — the pixel buffer never changes so levels always
    // render at the same coordinate space regardless of display size.
    const worldW = MAX_WIDTH;                          // 400
    const worldH = Math.round(MAX_WIDTH / ASPECT_RATIO); // 600

    const viewport = document.getElementById('visualViewport');
    const frame = document.getElementById('visualFrame');
    if (!viewport || !frame) {
      // Fallback if visual layout not mounted
      const container = document.getElementById('canvasContainer');
      const r = container.getBoundingClientRect();
      let dw = Math.min(r.width, worldW);
      let dh = dw / ASPECT_RATIO;
      if (dh > r.height) { dh = r.height; dw = dh * ASPECT_RATIO; }
      this.canvas.width = worldW;
      this.canvas.height = worldH;
      this.canvas.style.width = Math.round(dw) + 'px';
      this.canvas.style.height = Math.round(dh) + 'px';
      if (this.game) this.game.resize(worldW, worldH);
      if (this.editor) this.editor.resize(worldW, worldH);
      return;
    }

    const vpRect = viewport.getBoundingClientRect();

    // Account for theme panel + admin panel widths
    const panel = document.getElementById('themePanel');
    const panelW = panel && !panel.classList.contains('hidden')
      ? panel.getBoundingClientRect().width + 6 : 0;
    const adminP = document.getElementById('adminPanel');
    const adminW = adminP && !adminP.classList.contains('hidden')
      ? adminP.getBoundingClientRect().width + 6 : 0;

    const availW = vpRect.width - panelW - adminW;
    const availH = vpRect.height;

    // Fit 9:17 frame in available space (mobile: keep full width, compress height if needed)
    let fw = availW;
    let fh = fw * (17 / 9);
    const isNarrow = availW <= 520;
    let compact = false;
    if (fh > availH) {
      if (isNarrow) {
        fh = availH;
        compact = true;
      } else {
        fh = availH;
        fw = fh * (9 / 17);
      }
    }
    fw = Math.floor(fw);
    fh = Math.floor(fh);
    const squeeze = compact ? Math.min(1, fh / (fw * (17 / 9))) : 1;

    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
    // Scale factor for gamble UI — keeps DOM elements proportional to frame
    // regardless of browser zoom. Reference: 444px (canvas 400 at 90% of frame).
    frame.style.setProperty('--frame-scale', Math.min(1, fw / 444));
    frame.style.setProperty('--frame-squeeze', squeeze.toFixed(4));
    frame.classList.toggle('visual-frame--compact', compact);

    // Display size: 90% of frame width, maintaining game aspect ratio
    let displayW = Math.round(fw * 0.9);
    let displayH = Math.round(displayW / ASPECT_RATIO);
    if (displayH > fh) {
      displayH = fh;
      displayW = Math.round(displayH * ASPECT_RATIO);
    }

    // In compact play mode: nudge canvas up so bucket clears the gamble dock
    if (compact && this.mode === 'play') {
      const frameScale = Math.min(1, fw / 444);
      // Match CSS --hud-squeeze: clamp(0.82, squeeze, 1)
      const hudSqueeze = Math.max(0.82, squeeze);
      const dockH = Math.ceil(96 * frameScale * hudSqueeze);
      const dockTop = fh - dockH;
      // Bucket sits at ~Y=585 in 600-unit world
      const centeredTop = (fh - displayH) / 2;
      const bucketY = centeredTop + displayH * (585 / worldH);
      let nudge = Math.max(0, Math.ceil(bucketY - dockTop));
      // Don't nudge so far that canvas top goes below 2px
      const maxNudge = Math.max(0, Math.floor(centeredTop - 2));
      if (nudge > maxNudge) {
        // Shrink canvas to fit
        const availH = dockTop - 2;
        displayH = Math.floor(availH / (585 / worldH));
        displayW = Math.round(displayH * ASPECT_RATIO);
        nudge = 0;
      }
      frame.style.setProperty('--compact-canvas-nudge', nudge + 'px');
    } else {
      frame.style.removeProperty('--compact-canvas-nudge');
    }

    // Pixel buffer is always the reference game-world size.
    // CSS width/height scales the display; mouse-coordinate code already
    // uses canvas.width / rect.width to handle the ratio.
    this.canvas.width = worldW;
    this.canvas.height = worldH;
    this.canvas.style.width = displayW + 'px';
    this.canvas.style.height = displayH + 'px';

    if (this.game) this.game.resize(worldW, worldH);
    if (this.editor) this.editor.resize(worldW, worldH);

    this.visualLayout.resize(fw, fh);
    this._positionEditorSideSheets();
    this.dialogueController.refreshLayout();

    const level = this.levelManager.getCurrentLevel();
    if (level) {
      const prev = level.survival ? { ...level.survival } : null;
      const prevBilliard = level.billiard ? { ...level.billiard } : null;
      const normalized = ensureLevelSurvival(level, worldH);
      const billiard = ensureLevelBilliard(level);
      const prevBackground = prev?.background || {};
      const nextBackground = normalized.background || {};
      if (
        !prev ||
        !prevBilliard ||
        prev.enabled !== normalized.enabled ||
        prev.worldHeight !== normalized.worldHeight ||
        prev.scrollSpeed !== normalized.scrollSpeed ||
        prev.loseLineY !== normalized.loseLineY ||
        prev.antiCooldownMs !== normalized.antiCooldownMs ||
        JSON.stringify(prev.speedCurve || null) !== JSON.stringify(normalized.speedCurve || null) ||
        JSON.stringify(prev.gamblePeg || null) !== JSON.stringify(normalized.gamblePeg || null) ||
        prevBackground.type !== nextBackground.type ||
        prevBackground.image !== nextBackground.image ||
        prevBackground.fit !== nextBackground.fit ||
        prevBackground.darken !== nextBackground.darken ||
        prevBilliard.enabled !== billiard.enabled ||
        prevBilliard.attractionRadius !== billiard.attractionRadius ||
        prevBilliard.wallBounceAim !== billiard.wallBounceAim ||
        prevBilliard.pvpBounce !== billiard.pvpBounce ||
        prevBilliard.fixedMainBalls !== billiard.fixedMainBalls ||
        prevBilliard.mainBallPenalty !== billiard.mainBallPenalty ||
        JSON.stringify(prevBackground.liquid || null) !== JSON.stringify(nextBackground.liquid || null)
      ) {
        this.levelManager.save();
      }
      if (this.editor) {
        this.editor.setSurvivalSettings(normalized);
        this.editor.setPvpSettings(ensureLevelPvp(level));
      }
      this.updateLevelSettings();
    }
  }

  setupUI() {
    // Play button
    document.getElementById('playBtn').addEventListener('click', () => {
      this.togglePlayMode();
    });

    // Bake button — serialize level to localStorage, open player.html
    document.getElementById('bakeBtn').addEventListener('click', () => {
      this.bakeLevel();
    });

    // Peg type buttons
    document.querySelectorAll('.peg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const selectedType = btn.dataset.type;
        document.querySelectorAll('.peg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.editor) {
          this.editor.setSelectedPegType(selectedType);
          const forceCircleShape = this._isCircleOnlyType(selectedType);
          if (forceCircleShape) {
            this.editor.setSelectedShape('circle');
            this._setActiveShapeButton('circle');
          }
          // Also change type of selected pegs
          if (this.editor.selectedPegIds.size > 0) {
            this.editor.setSelectedPegsType(selectedType);
            this.syncSelectionPanels();
          }
        }
      });
    });

    // Shape buttons
    document.querySelectorAll('.shape-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.editor && this._isCircleOnlyType(this.editor.selectedPegType)) {
          this.editor.setSelectedShape('circle');
          this._setActiveShapeButton('circle');
          return;
        }
        document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.editor) {
          this.editor.setSelectedShape(btn.dataset.shape);
          if (this.editor.selectedPegIds.size > 0) {
            this.editor.setSelectedPegsShape(btn.dataset.shape);
          }
        }
      });
    });

    // Peg color picker
    document.getElementById('pegColorPicker').addEventListener('input', (e) => {
      if (this.editor) {
        const color = e.target.value;
        this.editor.selectedPegColor = color;
        if (this.editor.selectedPegIds.size > 0) {
          this.editor.setSelectedPegsColor(color);
        }
      }
    });

    document.getElementById('pegColorDefaultBtn').addEventListener('click', () => {
      const color = document.getElementById('pegColorPicker').value;
      if (this.editor) this.editor.selectedPegColor = color;
    });

    document.getElementById('pegColorResetBtn').addEventListener('click', () => {
      if (this.editor) {
        this.editor.selectedPegColor = null;
        if (this.editor.selectedPegIds.size > 0) {
          this.editor.setSelectedPegsColor(null);
        }
        this._syncPegColorPicker();
      }
    });

    // Tool buttons
    document.getElementById('gridBtn').addEventListener('click', () => {
      if (this.editor) {
        const gridOn = this.editor.toggleGrid();
        document.getElementById('gridBtn').classList.toggle('active', gridOn);
      }
    });

    document.getElementById('magnetBtn').addEventListener('click', () => {
      if (this.editor) {
        const snapOn = this.editor.toggleSnap();
        document.getElementById('magnetBtn').classList.toggle('active', snapOn);
      }
    });

    document.getElementById('selectBtn').addEventListener('click', () => {
      if (this.editor) {
        const isSelect = this.editor.mode !== 'select';
        this.editor.setMode(isSelect ? 'select' : 'place');
        document.getElementById('selectBtn').classList.toggle('active', isSelect);
        document.getElementById('drawBtn').classList.remove('active');
      }
    });

    document.getElementById('drawBtn').addEventListener('click', () => {
      if (this.editor) {
        const isDraw = this.editor.mode !== 'draw';
        this.editor.setMode(isDraw ? 'draw' : 'place');
        document.getElementById('drawBtn').classList.toggle('active', isDraw);
        document.getElementById('selectBtn').classList.remove('active');
        // Auto-select brick shape for draw mode
        if (isDraw) {
          this.editor.setSelectedShape('brick');
          document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
          document.querySelector('.shape-btn[data-shape="brick"]').classList.add('active');
        }
      }
    });

    // Undo/Redo buttons
    document.getElementById('undoBtn').addEventListener('click', () => {
      if (this.editor) this.editor.undo();
    });

    document.getElementById('redoBtn').addEventListener('click', () => {
      if (this.editor) this.editor.redo();
    });

    // More tools button
    document.getElementById('moreBtn').addEventListener('click', () => {
      document.getElementById('actionsOverlay').classList.toggle('visible');
    });

    // Quick actions
    document.getElementById('mirrorHBtn').addEventListener('click', () => {
      if (this.editor) this.editor.mirrorHorizontal();
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('mirrorVBtn').addEventListener('click', () => {
      if (this.editor) this.editor.mirrorVertical();
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('duplicateBtn').addEventListener('click', () => {
      if (this.editor) this.editor.duplicateSelectedPegs();
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('deleteSelBtn').addEventListener('click', () => {
      if (this.editor) {
        if (this.editor.flipperSelected) {
          this.editor.deleteFlippers();
        } else {
          this.editor.deleteSelectedPegs();
        }
      }
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('groupBtn').addEventListener('click', () => {
      if (this.editor) {
        const group = this.editor.groupSelectedPegs();
        if (group) {
          alert(`Created group: ${group.name}`);
        } else {
          alert('Select at least 2 pegs to group');
        }
      }
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('rotateBtn').addEventListener('click', () => {
      if (this.editor) this.editor.rotateSelectedPegs(Math.PI / 12);
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('animateBtn').addEventListener('click', () => {
      if (this.editor) {
        if (this.editor.selectedPegIds.size === 0) {
          alert('Select pegs to animate');
        } else {
          if (this.editor.enterAnimationMode()) {
            this.showAnimationPanel();
          }
        }
      }
    });

    // Flipper toggle button
    document.getElementById('flipperBtn').addEventListener('click', () => {
      if (!this.editor) return;
      const level = this.levelManager.getCurrentLevel();
      if (!level) return;

      if (level.flippers && level.flippers.enabled) {
        level.flippers.enabled = false;
        this.closeFlipperPanel();
      } else {
        const cameraY = this.editor?.getCameraY?.() || 0;
        const normalized = normalizeFlipperConfig(level.flippers, {
          canvasHeight: this.canvas.height,
          cameraY,
          bounce: PHYSICS_CONFIG.bounce
        });
        level.flippers = normalized || createDefaultFlipperConfig({
          canvasHeight: this.canvas.height,
          cameraY,
          bounce: PHYSICS_CONFIG.bounce,
          enabled: true
        });
        level.flippers.enabled = true;
        this.showFlipperPanel();
      }
      document.getElementById('flipperBtn').classList.toggle('active', level.flippers && level.flippers.enabled);
      this.levelManager.save();
    });

    // Close actions panel when clicking outside
    document.addEventListener('click', (e) => {
      const actionsOverlay = document.getElementById('actionsOverlay');
      const moreBtn = document.getElementById('moreBtn');
      if (!actionsOverlay.contains(e.target) && e.target !== moreBtn) {
        actionsOverlay.classList.remove('visible');
      }
    });

    // Menu actions
    document.getElementById('newLevelBtn').addEventListener('click', () => {
      this.newLevel();
    });

    document.getElementById('levelListBtn').addEventListener('click', () => {
      this.showLevelList();
    });

    document.getElementById('campaignBtn').addEventListener('click', () => {
      this.showCampaignList();
    });

    document.getElementById('pvpLevelsBtn').addEventListener('click', () => {
      this.showPvpDuelLevels();
    });
    document.getElementById('closePvpLevels')?.addEventListener('click', () => {
      this.closePvpDuelLevels();
    });
    document.getElementById('refreshPvpLevelsBtn')?.addEventListener('click', () => {
      this._pvpDuelLevelNames = null;
      this._pvpDuelLevelsPromise = null;
      this.showPvpDuelLevels();
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      if (confirm('Clear all pegs?')) {
        if (this.editor) this.editor.clearAllPegs();
      }
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      this.exportLevel();
    });

    document.getElementById('importBtn').addEventListener('click', () => {
      this.importLevel();
    });

    document.getElementById('importLinkBtn').addEventListener('click', () => {
      this.showImportLinkDialog();
    });

    document.getElementById('exportTrainingBtn').addEventListener('click', () => {
      this.exportTrainingData();
    });

    // Physics settings button
    document.getElementById('physicsBtn').addEventListener('click', () => {
      this.showPhysicsSettings();
    });

    document.getElementById('dialogueBtn').addEventListener('click', () => {
      this.showDialogueEditor();
    });

    document.getElementById('characterBtn')?.addEventListener('click', () => {
      this.showCharacterEditor();
    });

    // Visual layout: config change callback — deep clone so the level owns its
    // own copy and future VisualLayout mutations don't silently change it.
    this.visualLayout.onConfigChange = (config) => {
      const level = this.levelManager.getCurrentLevel();
      if (level) {
        level.visuals = JSON.parse(JSON.stringify(config));
        this.levelManager.save();
        const renderer = this.game?.renderer || this.editor?.renderer;
        if (renderer) {
          renderer.setBackground(config.background);
          renderer.setBallTrail(config.ballTrail);
          renderer.setShockwave(config.shockwave);
        }
        this.game?.setEndSequenceConfig?.(config.endSequence);
        this.dialogueController.refreshLayout();
        if (this.mode === 'editor') {
          this._setPortraitControllerContextForCurrentLevel({ live: false });
        }
      }
    };
    this.visualLayout.onPreviewProgressionChange = (enabled) => {
      if (this.editor) {
        this.editor.previewLevelProgress = enabled ? 1 : null;
      }
    };
    this.visualLayout.onBallTrailPreviewChange = (enabled) => {
      if (this.editor) {
        this.editor.ballTrailPreview = !!enabled;
      }
    };
    this.visualLayout.onShockwavePreviewChange = (enabled) => {
      if (this.editor) {
        this.editor.shockwavePreview = !!enabled;
      }
    };

    // Level settings
    document.getElementById('levelName').addEventListener('change', (e) => {
      this.levelManager.updateCurrentLevel({ name: e.target.value });
      this.updateLevelTitle();
    });

    document.getElementById('levelDifficulty').addEventListener('change', (e) => {
      this.levelManager.updateCurrentLevel({ difficulty: parseInt(e.target.value) });
    });

    const yoyoToggle = document.getElementById('yoyoThreadToggle');
    if (yoyoToggle) {
      yoyoToggle.addEventListener('change', (e) => {
        this.updateLevelYoyoSettings({ enabled: e.target.checked });
      });
    }

    const yoyoDebugDragToggle = document.getElementById('yoyoDebugDragToggle');
    if (yoyoDebugDragToggle) {
      yoyoDebugDragToggle.addEventListener('change', (e) => {
        this.updateLevelYoyoSettings({ debugDrag: e.target.checked });
      });
    }

    document.getElementById('addToTrainingBtn').addEventListener('click', () => {
      const level = this.levelManager.getCurrentLevel();
      if (level) {
        const isInTraining = this.levelManager.isInTraining(level.id);
        if (isInTraining) {
          this.levelManager.removeFromTraining(level.id);
          document.getElementById('addToTrainingBtn').textContent = 'Add to Training';
        } else {
          this.levelManager.addToTraining(level.id);
          document.getElementById('addToTrainingBtn').textContent = 'Remove from Training';
        }
      }
    });

    // Default Theme button — reset visuals to defaults (not pegs)
    document.getElementById('themeDefaultBtn').addEventListener('click', () => {
      this._resetThemeToDefault();
    });

    // Close level list
    document.getElementById('closeLevelList').addEventListener('click', () => {
      this.closeLevelList();
    });

    document.getElementById('closeDialogueOverlay').addEventListener('click', () => {
      this.closeDialogueEditor();
    });

    document.getElementById('addDialogueEntryBtn').addEventListener('click', () => {
      this._addDialogueEntry();
    });

    document.getElementById('closeCharacterOverlay')?.addEventListener('click', () => {
      this.closeCharacterEditor();
    });

    document.getElementById('addCharacterBtn')?.addEventListener('click', () => {
      this._addCharacter();
    });

    // Close physics panel
    document.getElementById('closePhysicsPanel').addEventListener('click', () => {
      this.closePhysicsSettings();
    });

    // Physics sliders
    this.setupPhysicsSliders();

    // Animation panel
    this.setupAnimationPanel();

    // Bumper panel
    this.setupBumperPanel();

    // Portal panel
    this.setupPortalPanel();

    // Multiball panel
    this.setupMultiballPanel();

    // Destruction selected-peg panel
    this.setupDestructionPegPanel();

    // Flipper panel
    this.setupFlipperPanel();

    // Survival mode panel
    this.setupSurvivalPanel();
    this.setupPvpPanel();
    this.setupBilliardPanel();
    this.setupDestructionPanel();
    this.setupAimLengthPanel();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      if (e.key === 'p') {
        this.togglePlayMode();
      } else if (e.key === 'f' && this.mode === 'editor') {
        document.getElementById('flipperBtn').click();
      }
    });
  }

  setupPhysicsSliders() {
    // Gravity
    const gravitySlider = document.getElementById('gravitySlider');
    gravitySlider.value = PHYSICS_CONFIG.gravity * 100;
    gravitySlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.gravity = parseFloat(e.target.value) / 100;
      document.getElementById('gravityValue').textContent = PHYSICS_CONFIG.gravity.toFixed(2);
    });

    // Bounce
    const bounceSlider = document.getElementById('bounceSlider');
    bounceSlider.value = PHYSICS_CONFIG.bounce * 100;
    bounceSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.bounce = parseFloat(e.target.value) / 100;
      document.getElementById('bounceValue').textContent = PHYSICS_CONFIG.bounce.toFixed(2);
    });

    // Speed
    const speedSlider = document.getElementById('speedSlider');
    speedSlider.value = PHYSICS_CONFIG.timeScale * 100;
    speedSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.timeScale = parseFloat(e.target.value) / 100;
      document.getElementById('speedValue').textContent = PHYSICS_CONFIG.timeScale.toFixed(2);
    });

    // Peg size
    const sizeSlider = document.getElementById('sizeSlider');
    sizeSlider.value = PHYSICS_CONFIG.pegRadius;
    sizeSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.pegRadius = parseInt(e.target.value);
      document.getElementById('sizeValue').textContent = PHYSICS_CONFIG.pegRadius;
    });

    // Launch power
    const powerSlider = document.getElementById('powerSlider');
    powerSlider.value = PHYSICS_CONFIG.launchPower;
    powerSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.launchPower = parseFloat(e.target.value);
      document.getElementById('powerValue').textContent = PHYSICS_CONFIG.launchPower.toFixed(1);
    });

    // Full trajectory toggle
    const trajectoryToggle = document.getElementById('trajectoryToggle');
    trajectoryToggle.addEventListener('change', (e) => {
      if (this.game) {
        this.game.setShowFullTrajectory(e.target.checked);
      }
    });
  }

  showPhysicsSettings() {
    this.closeLevelList();
    this.closeCampaignList();
    this.closeCampaignEditor();
    this.closePvpDuelLevels();
    this.closeCharacterEditor();
    this.closeDialogueEditor();
    // Update slider values to current settings
    document.getElementById('gravitySlider').value = PHYSICS_CONFIG.gravity * 100;
    document.getElementById('gravityValue').textContent = PHYSICS_CONFIG.gravity.toFixed(2);
    
    document.getElementById('bounceSlider').value = PHYSICS_CONFIG.bounce * 100;
    document.getElementById('bounceValue').textContent = PHYSICS_CONFIG.bounce.toFixed(2);
    
    document.getElementById('speedSlider').value = PHYSICS_CONFIG.timeScale * 100;
    document.getElementById('speedValue').textContent = PHYSICS_CONFIG.timeScale.toFixed(2);
    
    document.getElementById('sizeSlider').value = PHYSICS_CONFIG.pegRadius;
    document.getElementById('sizeValue').textContent = PHYSICS_CONFIG.pegRadius;
    
    document.getElementById('powerSlider').value = PHYSICS_CONFIG.launchPower;
    document.getElementById('powerValue').textContent = PHYSICS_CONFIG.launchPower.toFixed(1);
    
    document.getElementById('physicsOverlay').classList.add('visible');
  }

  closePhysicsSettings() {
    document.getElementById('physicsOverlay').classList.remove('visible');
  }

  setupAnimationPanel() {
    document.getElementById('closeAnimPanel').addEventListener('click', () => {
      this.closeAnimationPanel();
    });

    // Sliders + number inputs update editor ghost offset (bidirectional sync)
    const dxSlider = document.getElementById('animDxSlider');
    const dySlider = document.getElementById('animDySlider');
    const rotSlider = document.getElementById('animRotSlider');
    const durSlider = document.getElementById('animDurationSlider');
    const dxInput = document.getElementById('animDxInput');
    const dyInput = document.getElementById('animDyInput');
    const rotInput = document.getElementById('animRotInput');
    const durInput = document.getElementById('animDurationInput');
    const inverseBtn = document.getElementById('animInverseBtn');

    // Shift-snap helper: snap value to nearest step when shift is held
    const snapVal = (val, step, e) => (e && e.shiftKey) ? Math.round(val / step) * step : val;

    // Track shift key state for slider snapping + number input step changes
    let shiftHeld = false;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = true;
        dxInput.step = 5; dyInput.step = 5; rotInput.step = 5; durInput.step = 0.5;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = false;
        dxInput.step = 1; dyInput.step = 1; rotInput.step = 1; durInput.step = 0.1;
      }
    });

    dxSlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let v = parseInt(dxSlider.value);
      if (shiftHeld) { v = Math.round(v / 5) * 5; dxSlider.value = v; }
      this.editor.animationGhostOffset.dx = v;
      dxInput.value = v;
    });
    dxInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseInt(dxInput.value) || 0;
      this.editor.animationGhostOffset.dx = v;
      dxSlider.value = Math.max(-800, Math.min(800, v));
    });

    dySlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let v = parseInt(dySlider.value);
      if (shiftHeld) { v = Math.round(v / 5) * 5; dySlider.value = v; }
      this.editor.animationGhostOffset.dy = v;
      dyInput.value = v;
    });
    dyInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseInt(dyInput.value) || 0;
      this.editor.animationGhostOffset.dy = v;
      dySlider.value = Math.max(-800, Math.min(800, v));
    });

    rotSlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let v = parseInt(rotSlider.value);
      if (shiftHeld) { v = Math.round(v / 5) * 5; rotSlider.value = v; }
      this.editor.animationRotation = v * Math.PI / 180;
      rotInput.value = v;
    });
    rotInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseInt(rotInput.value) || 0;
      this.editor.animationRotation = v * Math.PI / 180;
      rotSlider.value = Math.max(-360, Math.min(360, v));
    });

    durSlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let raw = parseInt(durSlider.value);
      if (shiftHeld) { raw = Math.round(raw / 5) * 5; durSlider.value = raw; }
      const v = raw / 10;
      this.editor.animationDuration = v;
      durInput.value = v.toFixed(1);
    });
    durInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseFloat(durInput.value) || 0.5;
      this.editor.animationDuration = v;
      durSlider.value = Math.max(5, Math.min(80, Math.round(v * 10)));
    });

    document.getElementById('animEasingToggle').addEventListener('change', (e) => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationEasing = e.target.checked ? 'easeInOut' : 'linear';
    });

    inverseBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationInverse = !this.editor.animationInverse;
      this._syncAnimationInverseButton();
    });

    // Cycle button
    const cycleBtn = document.getElementById('animCycleBtn');
    cycleBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationCycle = !this.editor.animationCycle;
      // Cycle forces linear easing
      if (this.editor.animationCycle) {
        this.editor.animationEasing = 'linear';
        document.getElementById('animEasingToggle').checked = false;
        document.getElementById('animEasingToggle').disabled = true;
      } else {
        document.getElementById('animEasingToggle').disabled = false;
      }
      this._syncAnimationCycleButton();
    });

    // Circle path button
    const circleBtn = document.getElementById('animCircleBtn');
    const circleModeRow = document.getElementById('animCircleModeRow');
    const circleHalfBtn = document.getElementById('animCircleHalfBtn');
    const circleFullBtn = document.getElementById('animCircleFullBtn');

    const syncCircleButtons = () => {
      const on = !!(this.editor && this.editor.animationCircularPath);
      circleBtn.classList.toggle('active', on);
      circleBtn.textContent = on ? 'Circle: ON' : 'Circle: OFF';
      circleModeRow.style.display = on ? '' : 'none';
      const full = !!(this.editor && this.editor.animationCircularFull);
      circleHalfBtn.classList.toggle('active', !full);
      circleFullBtn.classList.toggle('active', full);
    };

    circleBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationCircularPath = !this.editor.animationCircularPath;
      syncCircleButtons();
    });

    circleHalfBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationCircularFull = false;
      syncCircleButtons();
    });

    circleFullBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationCircularFull = true;
      syncCircleButtons();
    });

    // Hit trigger checkbox
    const hitTriggerToggle = document.getElementById('animHitTriggerToggle');
    const hitModeRow = document.getElementById('animHitModeRow');
    const hitStepsRow = document.getElementById('animHitStepsRow');
    const hitStepsInput = document.getElementById('animHitStepsInput');
    const hitCycleBtn = document.getElementById('animHitCycleBtn');
    const hitSingleBtn = document.getElementById('animHitSingleBtn');
    const hitSpinBtn = document.getElementById('animHitSpinBtn');

    const syncHitModeButtons = () => {
      const mode = this.editor?.animationHitMode || 'cycle';
      hitCycleBtn.classList.toggle('active', mode === 'cycle');
      hitSingleBtn.classList.toggle('active', mode === 'single');
      hitSpinBtn.classList.toggle('active', mode === 'spin');
      // Steps visible for single and spin
      const showSteps = !!(this.editor && this.editor.animationHitTrigger && (mode === 'single' || mode === 'spin'));
      hitStepsRow.style.display = showSteps ? '' : 'none';
    };

    hitTriggerToggle.addEventListener('change', (e) => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationHitTrigger = e.target.checked;
      hitModeRow.style.display = e.target.checked ? '' : 'none';
      syncHitModeButtons();
    });

    hitCycleBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationHitMode = 'cycle';
      syncHitModeButtons();
    });

    hitSingleBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationHitMode = 'single';
      syncHitModeButtons();
    });

    hitSpinBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationHitMode = 'spin';
      syncHitModeButtons();
    });

    hitStepsInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationHitSteps = Math.max(1, Math.min(36, Math.round(parseInt(hitStepsInput.value) || 1)));
    });

    // Preview button
    document.getElementById('animPreviewBtn').addEventListener('click', () => {
      if (!this.editor) return;
      if (this.editor.animationPreview) {
        this.editor.stopAnimationPreview();
        document.getElementById('animPreviewBtn').textContent = 'Preview';
      } else {
        this.editor.startAnimationPreview();
        document.getElementById('animPreviewBtn').textContent = 'Stop';
      }
    });

    // Clear button
    document.getElementById('animClearBtn').addEventListener('click', () => {
      if (!this.editor) return;
      this.editor.stopAnimationPreview();
      document.getElementById('animPreviewBtn').textContent = 'Preview';
      this.editor.clearTargetAnimation();
      this._syncAnimationSliders();
    });

    // Apply button
    document.getElementById('animApplyBtn').addEventListener('click', () => {
      if (!this.editor) return;
      this.editor.stopAnimationPreview();
      document.getElementById('animPreviewBtn').textContent = 'Preview';

      const dx = Math.round(this.editor.animationGhostOffset?.dx || 0);
      const dy = Math.round(this.editor.animationGhostOffset?.dy || 0);
      const rot = this.editor.animationRotation || 0;
      const dur = this.editor.animationDuration || 2;
      const cycle = !!this.editor.animationCycle;
      const easing = cycle ? 'linear' : (document.getElementById('animEasingToggle').checked ? 'easeInOut' : 'linear');
      const inverse = !!this.editor.animationInverse;

      const hitTrigger = !!this.editor.animationHitTrigger;
      const hitMode = this.editor.animationHitMode || 'cycle';
      const hitSteps = this.editor.animationHitSteps || 1;
      const circularPath = !!this.editor.animationCircularPath;
      const circularFull = !!this.editor.animationCircularFull;

      if (dx === 0 && dy === 0 && rot === 0) {
        this.editor.clearTargetAnimation();
      } else {
        this.editor.setTargetAnimation({ dx, dy, rotation: rot, duration: dur, easing, inverse, cycle, wrap: true, hitTrigger, hitMode, hitSteps, circularPath, circularFull });
      }
      this.closeAnimationPanel();
    });
  }

  setupBumperPanel() {
    const bounceSlider = document.getElementById('bumperBounceSlider');
    const bounceInput = document.getElementById('bumperBounceInput');
    const scaleSlider = document.getElementById('bumperScaleSlider');
    const scaleInput = document.getElementById('bumperScaleInput');

    document.getElementById('closeBumperPanel').addEventListener('click', () => {
      this.closeBumperPanel();
    });

    bounceSlider.addEventListener('input', () => {
      if (!this.editor) return;
      const v = parseInt(bounceSlider.value) / 10;
      bounceInput.value = v.toFixed(1);
      this.editor.setSelectedBumperBounce(v);
    });
    bounceInput.addEventListener('input', () => {
      if (!this.editor) return;
      const v = parseFloat(bounceInput.value) || 0.5;
      bounceSlider.value = Math.max(5, Math.min(70, Math.round(v * 10)));
      this.editor.setSelectedBumperBounce(v);
    });

    const setScale = (v) => {
      if (!this.editor) return;
      const clamped = Math.max(0.5, Math.min(7.0, v));
      const level = this.editor.levelManager.getCurrentLevel();
      if (!level) return;
      for (const pegId of this.editor.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg && peg.type === 'bumper') {
          peg.bumperScale = clamped;
        }
      }
      this.editor.levelManager.save();
    };

    scaleSlider.addEventListener('input', () => {
      const v = parseInt(scaleSlider.value) / 10;
      scaleInput.value = v.toFixed(1);
      setScale(v);
    });
    scaleInput.addEventListener('input', () => {
      const v = parseFloat(scaleInput.value) || 1.0;
      scaleSlider.value = Math.max(5, Math.min(70, Math.round(v * 10)));
      setScale(v);
    });

    // Disappear on hit toggle
    const disappearToggle = document.getElementById('bumperDisappearToggle');
    disappearToggle.addEventListener('change', () => {
      if (!this.editor) return;
      const level = this.editor.levelManager.getCurrentLevel();
      if (!level) return;
      for (const pegId of this.editor.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg && peg.type === 'bumper') {
          peg.bumperDisappear = disappearToggle.checked;
          // Uncheck orange if disappear is checked (mutually exclusive)
          if (disappearToggle.checked && peg.bumperOrange) {
            peg.bumperOrange = false;
          }
        }
      }
      if (disappearToggle.checked) {
        document.getElementById('bumperOrangeToggle').checked = false;
      }
      this.editor.levelManager.save();
    });

    // Count as orange toggle
    const orangeToggle = document.getElementById('bumperOrangeToggle');
    orangeToggle.addEventListener('change', () => {
      if (!this.editor) return;
      const level = this.editor.levelManager.getCurrentLevel();
      if (!level) return;
      for (const pegId of this.editor.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg && peg.type === 'bumper') {
          peg.bumperOrange = orangeToggle.checked;
          // Orange implies disappear behavior, but uncheck disappear toggle
          if (orangeToggle.checked && peg.bumperDisappear) {
            peg.bumperDisappear = false;
          }
        }
      }
      if (orangeToggle.checked) {
        document.getElementById('bumperDisappearToggle').checked = false;
      }
      this.editor.levelManager.save();
    });
  }

  setupPortalPanel() {
    const scaleSlider = document.getElementById('portalScaleSlider');
    const scaleInput = document.getElementById('portalScaleInput');
    const oneWayToggle = document.getElementById('portalOneWayToggle');
    const oneWayFlipToggle = document.getElementById('portalOneWayFlipToggle');

    document.getElementById('closePortalPanel').addEventListener('click', () => {
      this.closePortalPanel();
    });

    const setScale = (rawValue) => {
      if (!this.editor) return;
      const v = Math.max(PORTAL_MIN_SCALE, Math.min(PORTAL_MAX_SCALE, rawValue));
      this.editor.setSelectedPortalScale(v);
    };

    scaleSlider.addEventListener('input', () => {
      const v = parseInt(scaleSlider.value) / 10;
      scaleInput.value = v.toFixed(1);
      setScale(v);
    });

    scaleInput.addEventListener('input', () => {
      const v = parseFloat(scaleInput.value) || PORTAL_DEFAULT_SCALE;
      scaleSlider.value = Math.max(PORTAL_MIN_SCALE * 10, Math.min(PORTAL_MAX_SCALE * 10, Math.round(v * 10)));
      setScale(v);
    });

    oneWayToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedPortalOneWay(oneWayToggle.checked);
      oneWayFlipToggle.disabled = !oneWayToggle.checked;
    });

    oneWayFlipToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedPortalOneWayFlip(oneWayFlipToggle.checked);
    });
  }

  showBumperPanel() {
    const props = this.editor ? this.editor.getSelectedBumperProperties() : null;
    if (!props) return;

    document.getElementById('bumperBounceSlider').value = Math.round(props.bounce * 10);
    document.getElementById('bumperBounceInput').value = props.bounce.toFixed(1);
    document.getElementById('bumperScaleSlider').value = Math.round(props.scale * 10);
    document.getElementById('bumperScaleInput').value = props.scale.toFixed(1);
    document.getElementById('bumperDisappearToggle').checked = !!props.disappear;
    document.getElementById('bumperOrangeToggle').checked = !!props.orange;
    document.getElementById('bumperPanel').classList.add('visible');
  }

  closeBumperPanel() {
    document.getElementById('bumperPanel').classList.remove('visible');
  }

  showPortalPanel() {
    const props = this.editor ? this.editor.getSelectedPortalProperties() : null;
    if (!props) return;

    document.getElementById('portalScaleSlider').value = Math.round(props.scale * 10);
    document.getElementById('portalScaleInput').value = props.scale.toFixed(1);
    document.getElementById('portalOneWayToggle').checked = !!props.oneWay;
    document.getElementById('portalOneWayFlipToggle').checked = !!props.oneWayFlip;
    document.getElementById('portalOneWayToggle').disabled = false;
    document.getElementById('portalOneWayFlipToggle').disabled = !props.oneWay;
    document.getElementById('portalPanel').classList.add('visible');
  }

  closePortalPanel() {
    document.getElementById('portalPanel').classList.remove('visible');
  }

  setupMultiballPanel() {
    const countSlider = document.getElementById('multiballCountSlider');
    const countInput = document.getElementById('multiballCountInput');
    const gambleBallSlider = document.getElementById('gamblePegBallCountSlider');
    const gambleBallInput = document.getElementById('gamblePegBallCountInput');
    const gambleKnockbackToggle = document.getElementById('gamblePegKnockbackToggle');
    const gambleKnockbackSlider = document.getElementById('gamblePegKnockbackDistanceSlider');
    const gambleKnockbackInput = document.getElementById('gamblePegKnockbackDistanceInput');
    const gambleKnockbackSmoothSlider = document.getElementById('gamblePegKnockbackSmoothSlider');
    const gambleKnockbackSmoothInput = document.getElementById('gamblePegKnockbackSmoothInput');
    if (!countSlider || !countInput) return;
    countSlider.min = String(MULTIBALL_MIN_SPAWN_COUNT);
    countSlider.max = String(MULTIBALL_MAX_SPAWN_COUNT);
    countInput.min = String(MULTIBALL_MIN_SPAWN_COUNT);
    countInput.max = String(MULTIBALL_MAX_SPAWN_COUNT);
    if (gambleBallSlider && gambleBallInput) {
      gambleBallSlider.min = String(SURVIVAL_GAMBLE_BALL_COUNT_MIN);
      gambleBallSlider.max = String(SURVIVAL_GAMBLE_BALL_COUNT_MAX);
      gambleBallInput.min = String(SURVIVAL_GAMBLE_BALL_COUNT_MIN);
      gambleBallInput.max = String(SURVIVAL_GAMBLE_BALL_COUNT_MAX);
    }
    if (gambleKnockbackSlider && gambleKnockbackInput) {
      gambleKnockbackSlider.min = String(SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MIN);
      gambleKnockbackSlider.max = String(SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX);
      gambleKnockbackInput.min = String(SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MIN);
      gambleKnockbackInput.max = String(SURVIVAL_GAMBLE_KNOCKBACK_DISTANCE_MAX);
    }
    if (gambleKnockbackSmoothSlider && gambleKnockbackSmoothInput) {
      gambleKnockbackSmoothSlider.min = String(SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MIN_MS);
      gambleKnockbackSmoothSlider.max = String(SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MAX_MS);
      gambleKnockbackSmoothInput.min = String(SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MIN_MS);
      gambleKnockbackSmoothInput.max = String(SURVIVAL_GAMBLE_KNOCKBACK_SMOOTH_MAX_MS);
    }

    document.getElementById('closeMultiballPanel').addEventListener('click', () => {
      this.closeMultiballPanel();
    });

    const applySpawnCount = (rawValue) => {
      if (!this.editor) return;
      const normalized = normalizeMultiballSpawnCount(rawValue);
      countSlider.value = normalized;
      countInput.value = normalized;
      this.editor.setSelectedMultiballSpawnCount(normalized);
    };

    countSlider.addEventListener('input', () => {
      const value = parseInt(countSlider.value, 10);
      applySpawnCount(value);
    });

    countInput.addEventListener('input', () => {
      const value = parseInt(countInput.value, 10);
      applySpawnCount(value);
    });

    if (gambleBallSlider && gambleBallInput) {
      const applyGambleBallCount = (rawValue) => {
        if (!this.editor) return;
        const normalized = normalizeSurvivalGamblePegProperties({ gambleBallCount: rawValue });
        gambleBallSlider.value = normalized.gambleBallCount;
        gambleBallInput.value = normalized.gambleBallCount;
        this.editor.setSelectedGambleBallCount(normalized.gambleBallCount);
      };
      gambleBallSlider.addEventListener('input', () => applyGambleBallCount(gambleBallSlider.value));
      gambleBallInput.addEventListener('input', () => applyGambleBallCount(gambleBallInput.value));
    }

    if (gambleKnockbackToggle && gambleKnockbackSlider && gambleKnockbackInput) {
      const syncKnockbackDistanceControls = (enabled) => {
        gambleKnockbackSlider.disabled = !enabled;
        gambleKnockbackInput.disabled = !enabled;
        if (gambleKnockbackSmoothSlider) gambleKnockbackSmoothSlider.disabled = !enabled;
        if (gambleKnockbackSmoothInput) gambleKnockbackSmoothInput.disabled = !enabled;
      };
      const applyGambleKnockbackDistance = (rawValue) => {
        if (!this.editor) return;
        const normalized = normalizeSurvivalGamblePegProperties({ gambleKnockbackDistance: rawValue });
        gambleKnockbackSlider.value = normalized.gambleKnockbackDistance;
        gambleKnockbackInput.value = normalized.gambleKnockbackDistance;
        this.editor.setSelectedGambleKnockbackDistance(normalized.gambleKnockbackDistance);
      };
      const applyGambleKnockbackSmooth = (rawValue) => {
        if (!this.editor || !gambleKnockbackSmoothSlider || !gambleKnockbackSmoothInput) return;
        const normalized = normalizeSurvivalGamblePegProperties({ gambleKnockbackSmoothMs: rawValue });
        gambleKnockbackSmoothSlider.value = normalized.gambleKnockbackSmoothMs;
        gambleKnockbackSmoothInput.value = normalized.gambleKnockbackSmoothMs;
        this.editor.setSelectedGambleKnockbackSmoothMs(normalized.gambleKnockbackSmoothMs);
      };
      gambleKnockbackToggle.addEventListener('change', () => {
        const enabled = gambleKnockbackToggle.checked;
        syncKnockbackDistanceControls(enabled);
        this.editor?.setSelectedGambleKnockbackEnabled(enabled);
      });
      gambleKnockbackSlider.addEventListener('input', () => {
        applyGambleKnockbackDistance(gambleKnockbackSlider.value);
      });
      gambleKnockbackInput.addEventListener('input', () => {
        applyGambleKnockbackDistance(gambleKnockbackInput.value);
      });
      gambleKnockbackSmoothSlider?.addEventListener('input', () => {
        applyGambleKnockbackSmooth(gambleKnockbackSmoothSlider.value);
      });
      gambleKnockbackSmoothInput?.addEventListener('input', () => {
        applyGambleKnockbackSmooth(gambleKnockbackSmoothInput.value);
      });
      syncKnockbackDistanceControls(gambleKnockbackToggle.checked);
    }
  }

  showMultiballPanel() {
    const multiballProps = this.editor ? this.editor.getSelectedMultiballProperties() : null;
    const gambleProps = this.editor ? this.editor.getSelectedGamblePegProperties() : null;
    const panelTitle = document.getElementById('multiballPanelTitle');
    const multiballSettings = document.getElementById('multiballSettings');
    const gambleSettings = document.getElementById('gamblePegSettings');

    if (!multiballProps && !gambleProps) return;

    if (multiballProps) {
      const value = normalizeMultiballSpawnCount(multiballProps.spawnCount);
      if (panelTitle) panelTitle.textContent = 'Multiball';
      if (multiballSettings) multiballSettings.classList.remove('hidden');
      if (gambleSettings) gambleSettings.classList.add('hidden');
      document.getElementById('multiballCountSlider').value = value;
      document.getElementById('multiballCountInput').value = value;
    } else {
      const props = normalizeSurvivalGamblePegProperties(gambleProps);
      if (panelTitle) panelTitle.textContent = 'Lime Peg';
      if (multiballSettings) multiballSettings.classList.add('hidden');
      if (gambleSettings) gambleSettings.classList.remove('hidden');
      const ballSlider = document.getElementById('gamblePegBallCountSlider');
      const ballInput = document.getElementById('gamblePegBallCountInput');
      const knockbackToggle = document.getElementById('gamblePegKnockbackToggle');
      const knockbackSlider = document.getElementById('gamblePegKnockbackDistanceSlider');
      const knockbackInput = document.getElementById('gamblePegKnockbackDistanceInput');
      const knockbackSmoothSlider = document.getElementById('gamblePegKnockbackSmoothSlider');
      const knockbackSmoothInput = document.getElementById('gamblePegKnockbackSmoothInput');
      if (ballSlider) ballSlider.value = props.gambleBallCount;
      if (ballInput) ballInput.value = props.gambleBallCount;
      if (knockbackToggle) knockbackToggle.checked = !!props.gambleKnockbackEnabled;
      if (knockbackSlider) {
        knockbackSlider.value = props.gambleKnockbackDistance;
        knockbackSlider.disabled = !props.gambleKnockbackEnabled;
      }
      if (knockbackInput) {
        knockbackInput.value = props.gambleKnockbackDistance;
        knockbackInput.disabled = !props.gambleKnockbackEnabled;
      }
      if (knockbackSmoothSlider) {
        knockbackSmoothSlider.value = props.gambleKnockbackSmoothMs;
        knockbackSmoothSlider.disabled = !props.gambleKnockbackEnabled;
      }
      if (knockbackSmoothInput) {
        knockbackSmoothInput.value = props.gambleKnockbackSmoothMs;
        knockbackSmoothInput.disabled = !props.gambleKnockbackEnabled;
      }
    }
    document.getElementById('multiballPanel').classList.add('visible');
  }

  closeMultiballPanel() {
    document.getElementById('multiballPanel').classList.remove('visible');
  }

  setupDestructionPegPanel() {
    const panel = document.getElementById('destructionPegPanel');
    const closeBtn = document.getElementById('closeDestructionPegPanel');
    const staticToggle = document.getElementById('destructionStaticToggle');
    const hitToggle = document.getElementById('destructionPhysicsOnHitToggle');
    const ballOnlyToggle = document.getElementById('destructionPhysicsOnHitBallOnlyToggle');
    const groupToggle = document.getElementById('destructionGroupToggle');
    if (!panel || !closeBtn || !staticToggle || !hitToggle || !ballOnlyToggle || !groupToggle) return;

    closeBtn.addEventListener('click', () => this.closeDestructionPegPanel());
    staticToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedDestructionStatic(staticToggle.checked);
      this.showDestructionPegPanel();
    });
    hitToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedDestructionPhysicsOnHit(hitToggle.checked);
      this.showDestructionPegPanel();
    });
    ballOnlyToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedDestructionPhysicsOnHitBallOnly(ballOnlyToggle.checked);
      this.showDestructionPegPanel();
    });
    groupToggle.addEventListener('change', () => {
      if (!this.editor) return;
      const applied = this.editor.setSelectedDestructionGrouped(groupToggle.checked);
      if (!applied) groupToggle.checked = false;
      this.showDestructionPegPanel();
    });
  }

  showDestructionPegPanel() {
    const props = this.editor ? this.editor.getSelectedDestructionProperties() : null;
    if (!props) return;
    const panel = document.getElementById('destructionPegPanel');
    const staticToggle = document.getElementById('destructionStaticToggle');
    const hitToggle = document.getElementById('destructionPhysicsOnHitToggle');
    const ballOnlyToggle = document.getElementById('destructionPhysicsOnHitBallOnlyToggle');
    const groupToggle = document.getElementById('destructionGroupToggle');
    if (!panel || !staticToggle || !hitToggle || !ballOnlyToggle || !groupToggle) return;

    staticToggle.indeterminate = !!props.staticMixed;
    staticToggle.checked = !props.staticMixed && !!props.static;
    hitToggle.indeterminate = !!props.physicsOnHitMixed;
    hitToggle.checked = !props.physicsOnHitMixed && !!props.physicsOnHit;
    hitToggle.disabled = !props.staticMixed && !!props.static;
    ballOnlyToggle.indeterminate = !!props.physicsOnHitBallOnlyMixed;
    ballOnlyToggle.checked = !props.physicsOnHitBallOnlyMixed && !!props.physicsOnHitBallOnly;
    ballOnlyToggle.disabled = (!props.staticMixed && !!props.static) || (!props.physicsOnHitMixed && !props.physicsOnHit);
    groupToggle.indeterminate = !!props.groupedMixed;
    groupToggle.checked = !props.groupedMixed && !!props.grouped;
    groupToggle.disabled = !props.canGroup;
    panel.classList.add('visible');
  }

  closeDestructionPegPanel() {
    document.getElementById('destructionPegPanel')?.classList.remove('visible');
  }

  setupFlipperPanel() {
    document.getElementById('closeFlipperPanel').addEventListener('click', () => {
      this.closeFlipperPanel();
    });

    const bindFlipperSlider = (sliderId, inputId, prop, min, max) => {
      const slider = document.getElementById(sliderId);
      const input = document.getElementById(inputId);

      slider.addEventListener('input', () => {
        const v = parseInt(slider.value);
        input.value = v;
        this._setFlipperProp(prop, v);
      });
      input.addEventListener('input', () => {
        const v = Math.max(min, Math.min(max, parseInt(input.value) || min));
        slider.value = v;
        this._setFlipperProp(prop, v);
      });
    };

    bindFlipperSlider('flipperLengthSlider', 'flipperLengthInput', 'length', 20, 150);
    bindFlipperSlider('flipperOffsetSlider', 'flipperOffsetInput', 'xOffset', 10, 250);
    bindFlipperSlider('flipperRestSlider', 'flipperRestInput', 'restAngle', 5, 60);
    bindFlipperSlider('flipperFlipSlider', 'flipperFlipInput', 'flipAngle', 0, 70);

    // Bounce slider (0.3 - 5.0, stored as float)
    const fBounceSlider = document.getElementById('flipperBounceSlider');
    const fBounceInput = document.getElementById('flipperBounceInput');
    fBounceSlider.addEventListener('input', () => {
      const v = parseFloat(fBounceSlider.value);
      fBounceInput.value = v.toFixed(2);
      this._setFlipperProp('bounce', v);
    });
    fBounceInput.addEventListener('input', () => {
      const v = Math.max(0.3, Math.min(5.0, parseFloat(fBounceInput.value) || PHYSICS_CONFIG.bounce));
      fBounceSlider.value = v.toFixed(2);
      this._setFlipperProp('bounce', v);
    });

    bindFlipperSlider('flipperWidthSlider', 'flipperWidthInput', 'width', 4, 40);

    // Scale slider (0.5 - 3.0, stored as float)
    const fScaleSlider = document.getElementById('flipperScaleSlider');
    const fScaleInput = document.getElementById('flipperScaleInput');
    fScaleSlider.addEventListener('input', () => {
      const v = parseInt(fScaleSlider.value) / 10;
      fScaleInput.value = v.toFixed(1);
      this._setFlipperProp('scale', v);
    });
    fScaleInput.addEventListener('input', () => {
      const v = Math.max(0.5, Math.min(3.0, parseFloat(fScaleInput.value) || 1.0));
      fScaleSlider.value = Math.round(v * 10);
      this._setFlipperProp('scale', v);
    });
  }

  setupSurvivalPanel() {
    const panel = document.getElementById('survivalPanel');
    const toggle = document.getElementById('survivalModeToggle');
    const worldHeightSlider = document.getElementById('survivalHeightSlider');
    const worldHeightInput = document.getElementById('survivalHeightInput');
    const speedSlider = document.getElementById('survivalSpeedSlider');
    const speedInput = document.getElementById('survivalSpeedInput');
    const loseLineSlider = document.getElementById('survivalLoseLineSlider');
    const loseLineInput = document.getElementById('survivalLoseLineInput');
    const antiCooldownSlider = document.getElementById('survivalAntiCooldownSlider');
    const antiCooldownInput = document.getElementById('survivalAntiCooldownInput');
    const curvePresetSelect = document.getElementById('survivalSpeedCurvePreset');
    const curveCanvas = document.getElementById('survivalSpeedCurveCanvas');
    const curveEqualizeBtn = document.getElementById('survivalSpeedCurveEqualizeBtn');
    const curveResetBtn = document.getElementById('survivalSpeedCurveResetBtn');
    const backgroundInput = document.getElementById('survivalBackgroundInput');
    const backgroundUploadBtn = document.getElementById('survivalBackgroundUploadBtn');
    const backgroundRemoveBtn = document.getElementById('survivalBackgroundRemoveBtn');
    const backgroundDarkenSlider = document.getElementById('survivalBackgroundDarkenSlider');
    const backgroundDarkenInput = document.getElementById('survivalBackgroundDarkenInput');

    if (
      !panel || !toggle ||
      !worldHeightSlider || !worldHeightInput ||
      !speedSlider || !speedInput ||
      !loseLineSlider || !loseLineInput ||
      !antiCooldownSlider || !antiCooldownInput
    ) return;

    let shiftHeld = false;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = false;
      }
    });

    const snap5 = (value) => shiftHeld ? Math.round(value / 5) * 5 : value;

    toggle.addEventListener('change', () => {
      this.updateLevelSurvivalSettings({ enabled: toggle.checked });
      if (toggle.checked) {
        this.updateLevelPvpSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelBilliardSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelDestructionSettings({ enabled: false }, { refreshUi: false });
      }
      this._setSurvivalSettingsVisible(toggle.checked);
      this.updateLevelSettings();
    });

    const applyWorldHeight = (rawValue) => {
      const minHeight = this.canvas.height;
      const parsed = Math.round(parseFloat(rawValue) || minHeight);
      const value = Math.max(minHeight, parsed);
      worldHeightSlider.value = value;
      worldHeightInput.value = value;
      this.updateLevelSurvivalSettings({ worldHeight: value });
    };

    worldHeightSlider.addEventListener('input', () => {
      let value = parseInt(worldHeightSlider.value, 10) || this.canvas.height;
      value = snap5(value);
      worldHeightSlider.value = value;
      worldHeightInput.value = value;
    });
    worldHeightSlider.addEventListener('change', () => applyWorldHeight(worldHeightSlider.value));
    worldHeightInput.addEventListener('change', () => applyWorldHeight(worldHeightInput.value));

    const applySpeed = (rawValue) => {
      let parsed = parseFloat(rawValue) || 20;
      parsed = snap5(parsed);
      const value = Math.max(2, Math.min(400, parsed));
      speedSlider.value = value;
      speedInput.value = value.toFixed(1);
      this.updateLevelSurvivalSettings({ scrollSpeed: value });
    };

    speedSlider.addEventListener('input', () => {
      let value = parseInt(speedSlider.value, 10) || 20;
      value = snap5(value);
      speedSlider.value = value;
      speedInput.value = value.toFixed(1);
    });
    speedSlider.addEventListener('change', () => applySpeed(speedSlider.value));
    speedInput.addEventListener('change', () => applySpeed(speedInput.value));

    const applyLoseLine = (rawValue) => {
      const maxLine = Math.max(8, this.canvas.height - 8);
      let parsed = Math.round(parseFloat(rawValue) || 8);
      parsed = snap5(parsed);
      const value = Math.max(8, Math.min(maxLine, parsed));
      loseLineSlider.value = value;
      loseLineInput.value = value;
      this.updateLevelSurvivalSettings({ loseLineY: value });
    };

    loseLineSlider.addEventListener('input', () => {
      let value = parseInt(loseLineSlider.value, 10) || 8;
      value = snap5(value);
      loseLineSlider.value = value;
      loseLineInput.value = value;
    });
    loseLineSlider.addEventListener('change', () => applyLoseLine(loseLineSlider.value));
    loseLineInput.addEventListener('change', () => applyLoseLine(loseLineInput.value));

    const formatCooldownSeconds = (ms) => (Math.round(ms) / 1000).toFixed(1);
    const applyAntiCooldown = (rawValue, fromSeconds = false) => {
      const rawMs = fromSeconds
        ? (parseFloat(rawValue) || 0) * 1000
        : parseFloat(rawValue) || 0;
      const value = Math.max(0, Math.min(10000, Math.round(rawMs / 100) * 100));
      antiCooldownSlider.value = value;
      antiCooldownInput.value = formatCooldownSeconds(value);
      this.updateLevelSurvivalSettings({ antiCooldownMs: value });
    };

    antiCooldownSlider.addEventListener('input', () => {
      const value = Math.max(0, Math.min(10000, parseInt(antiCooldownSlider.value, 10) || 0));
      antiCooldownInput.value = formatCooldownSeconds(value);
    });
    antiCooldownSlider.addEventListener('change', () => applyAntiCooldown(antiCooldownSlider.value));
    antiCooldownInput.addEventListener('change', () => applyAntiCooldown(antiCooldownInput.value, true));

    if (curvePresetSelect && curveCanvas) {
      const applyPreset = (presetId) => {
        if (presetId === 'custom') {
          const level = this.levelManager.getCurrentLevel();
          if (!level) return;
          const survival = ensureLevelSurvival(level, this.canvas.height);
          this.updateLevelSurvivalSettings({
            speedCurve: { ...survival.speedCurve, preset: 'custom' }
          });
          return;
        }
        this.updateLevelSurvivalSettings({
          speedCurve: getSurvivalSpeedCurvePreset(presetId)
        });
      };
      curvePresetSelect.addEventListener('change', () => applyPreset(curvePresetSelect.value));
      if (curveEqualizeBtn) {
        curveEqualizeBtn.addEventListener('click', () => {
          this.updateLevelSurvivalSettings({
            speedCurve: {
              preset: 'custom',
              x1: 0.25,
              y0: 1,
              y1: 1,
              x2: 0.75,
              y2: 1,
              y3: 1
            }
          });
        });
      }
      if (curveResetBtn) {
        curveResetBtn.addEventListener('click', () => {
          const preset = SURVIVAL_SPEED_CURVE_PRESETS[curvePresetSelect.value]
            ? curvePresetSelect.value
            : 'linear';
          applyPreset(preset);
        });
      }
      curveCanvas.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const level = this.levelManager.getCurrentLevel();
        if (!level) return;
        const survival = ensureLevelSurvival(level, this.canvas.height);
        this._survivalCurveDragHandle = this._getSurvivalCurveHandleAt(event, survival.speedCurve, curveCanvas);
        curveCanvas.setPointerCapture?.(event.pointerId);
        this._applySurvivalCurveDrag(event, curveCanvas);
      });
      curveCanvas.addEventListener('pointermove', (event) => {
        if (!this._survivalCurveDragHandle) return;
        event.preventDefault();
        this._applySurvivalCurveDrag(event, curveCanvas);
      });
      const endCurveDrag = (event) => {
        const wasDragging = !!this._survivalCurveDragHandle;
        if (wasDragging && curveCanvas.hasPointerCapture?.(event.pointerId)) {
          curveCanvas.releasePointerCapture(event.pointerId);
        }
        this._survivalCurveDragHandle = null;
        if (wasDragging) {
          this.levelManager.save();
          this.updateLevelSettings();
        }
      };
      curveCanvas.addEventListener('pointerup', endCurveDrag);
      curveCanvas.addEventListener('pointercancel', endCurveDrag);
    }

    if (backgroundInput && backgroundUploadBtn && backgroundRemoveBtn) {
      backgroundUploadBtn.addEventListener('click', () => backgroundInput.click());
      backgroundRemoveBtn.addEventListener('click', () => {
        backgroundInput.value = '';
        this.updateLevelSurvivalSettings({
          background: { type: 'none', image: null, fit: 'cover', liquid: null }
        });
      });
      backgroundInput.addEventListener('change', async () => {
        const file = backgroundInput.files && backgroundInput.files[0];
        if (!file) return;
        backgroundUploadBtn.disabled = true;
        try {
          const level = this.levelManager.getCurrentLevel();
          const survival = level ? ensureLevelSurvival(level, this.canvas.height) : null;
          const maxHeight = Math.max(
            this.canvas.height,
            Math.min(2400, Math.round(Number(survival?.worldHeight) || this.canvas.height * 3))
          );
          const image = await compressImageFile(file, {
            maxWidth: Math.max(800, Math.round(this.canvas.width * 2)),
            maxHeight,
            quality: 0.8,
            fallbackType: 'image/jpeg',
            maxDataUrlBytes: 520 * 1024
          });
          if (!image) {
            alert('Could not read that image.');
            return;
          }
          this.updateLevelSurvivalSettings({
            background: { type: 'image', image, fit: 'cover', liquid: null }
          });
        } finally {
          backgroundUploadBtn.disabled = false;
        }
      });
    }

    if (backgroundDarkenSlider && backgroundDarkenInput) {
      const applyBackgroundDarken = (rawValue) => {
        const value = Math.max(0, Math.min(100, Math.round(parseFloat(rawValue) || 0)));
        backgroundDarkenSlider.value = value;
        backgroundDarkenInput.value = value;
        this.updateLevelSurvivalSettings({
          background: { darken: value / 100 }
        });
      };

      backgroundDarkenSlider.addEventListener('input', () => {
        backgroundDarkenInput.value = backgroundDarkenSlider.value;
      });
      backgroundDarkenSlider.addEventListener('change', () => applyBackgroundDarken(backgroundDarkenSlider.value));
      backgroundDarkenInput.addEventListener('change', () => applyBackgroundDarken(backgroundDarkenInput.value));
    }
  }

  setupPvpPanel() {
    const panel = document.getElementById('pvpPanel');
    const toggle = document.getElementById('pvpModeToggle');
    const controls = document.getElementById('pvpControls');
    const symmetryToggle = document.getElementById('pvpSymmetryToggle');
    const cpuToggle = document.getElementById('pvpCpuToggle');
    const timerSlider = document.getElementById('pvpAimTimerSlider');
    const timerInput = document.getElementById('pvpAimTimerInput');
    const difficultySelect = document.getElementById('pvpDifficultySelect');
    if (!panel || !toggle || !controls || !symmetryToggle || !cpuToggle || !timerSlider || !timerInput || !difficultySelect) {
      return;
    }

    const formatSeconds = (ms) => (Math.round(ms) / 1000).toFixed(2).replace(/\.00$/, '');

    const applyTimer = (rawValue, fromSeconds = false) => {
      const rawMs = fromSeconds
        ? (parseFloat(rawValue) || 5) * 1000
        : parseFloat(rawValue) || 5000;
      const value = Math.max(1000, Math.min(30000, Math.round(rawMs / 250) * 250));
      timerSlider.value = value;
      timerInput.value = formatSeconds(value);
      this.updateLevelPvpSettings({ aimTimerMs: value });
    };

    toggle.addEventListener('change', () => {
      this.updateLevelPvpSettings({ enabled: toggle.checked });
      if (toggle.checked) {
        this.updateLevelSurvivalSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelBilliardSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelDestructionSettings({ enabled: false }, { refreshUi: false });
      }
      this._setPvpSettingsVisible(toggle.checked);
      this.updateLevelSettings();
    });

    symmetryToggle.addEventListener('change', () => {
      this.updateLevelPvpSettings({ symmetryEnabled: symmetryToggle.checked });
    });

    cpuToggle.addEventListener('change', () => {
      this.updateLevelPvpSettings({ cpuEnabled: cpuToggle.checked });
    });

    timerSlider.addEventListener('input', () => {
      timerInput.value = formatSeconds(parseFloat(timerSlider.value) || 5000);
    });
    timerSlider.addEventListener('change', () => applyTimer(timerSlider.value));
    timerInput.addEventListener('change', () => applyTimer(timerInput.value, true));

    difficultySelect.addEventListener('change', () => {
      this.updateLevelPvpSettings({ cpuDifficulty: difficultySelect.value });
    });
  }

  setupBilliardPanel() {
    const panel = document.getElementById('billiardPanel');
    const toggle = document.getElementById('billiardModeToggle');
    const controls = document.getElementById('billiardControls');
    const attractionSlider = document.getElementById('billiardAttractionSlider');
    const attractionInput = document.getElementById('billiardAttractionInput');
    const wallBounceAimToggle = document.getElementById('billiardWallBounceAimToggle');
    const pvpBounceToggle = document.getElementById('billiardPvpBounceToggle');
    const fixedMainBallsToggle = document.getElementById('billiardFixedMainBallsToggle');
    const mainBallPenaltySlider = document.getElementById('billiardMainBallPenaltySlider');
    const mainBallPenaltyInput = document.getElementById('billiardMainBallPenaltyInput');
    if (
      !panel || !toggle || !controls || !attractionSlider || !attractionInput
      || !wallBounceAimToggle || !pvpBounceToggle || !fixedMainBallsToggle
      || !mainBallPenaltySlider || !mainBallPenaltyInput
    ) {
      return;
    }

    const syncMainBallPenaltyEnabled = () => {
      const disabled = fixedMainBallsToggle.checked;
      mainBallPenaltySlider.disabled = disabled;
      mainBallPenaltyInput.disabled = disabled;
    };

    toggle.addEventListener('change', () => {
      this.updateLevelBilliardSettings({ enabled: toggle.checked });
      if (toggle.checked) {
        this.updateLevelSurvivalSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelPvpSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelDestructionSettings({ enabled: false }, { refreshUi: false });
      }
      this._setBilliardSettingsVisible(toggle.checked);
      this.updateLevelSettings();
    });

    const applyAttraction = (rawValue) => {
      const value = Math.max(20, Math.min(80, Math.round(parseFloat(rawValue) || 32)));
      attractionSlider.value = value;
      attractionInput.value = value;
      this.updateLevelBilliardSettings({ attractionRadius: value });
    };

    attractionSlider.addEventListener('input', () => {
      attractionInput.value = attractionSlider.value;
    });
    attractionSlider.addEventListener('change', () => applyAttraction(attractionSlider.value));
    attractionInput.addEventListener('change', () => applyAttraction(attractionInput.value));

    wallBounceAimToggle.addEventListener('change', () => {
      this.updateLevelBilliardSettings({ wallBounceAim: wallBounceAimToggle.checked });
    });

    pvpBounceToggle.addEventListener('change', () => {
      this.updateLevelBilliardSettings({ pvpBounce: pvpBounceToggle.checked });
    });

    fixedMainBallsToggle.addEventListener('change', () => {
      syncMainBallPenaltyEnabled();
      this.updateLevelBilliardSettings({ fixedMainBalls: fixedMainBallsToggle.checked });
    });

    const applyMainBallPenalty = (rawValue) => {
      const value = Math.max(0, Math.min(10, Math.round(parseFloat(rawValue) || 0)));
      mainBallPenaltySlider.value = value;
      mainBallPenaltyInput.value = value;
      this.updateLevelBilliardSettings({ mainBallPenalty: value });
    };

    mainBallPenaltySlider.addEventListener('input', () => {
      mainBallPenaltyInput.value = mainBallPenaltySlider.value;
    });
    mainBallPenaltySlider.addEventListener('change', () => applyMainBallPenalty(mainBallPenaltySlider.value));
    mainBallPenaltyInput.addEventListener('change', () => applyMainBallPenalty(mainBallPenaltyInput.value));
    syncMainBallPenaltyEnabled();
  }

  setupDestructionPanel() {
    const toggle = document.getElementById('destructionModeToggle');
    const controls = document.getElementById('destructionControls');
    const gravityYSlider = document.getElementById('destructionGravityYSlider');
    const gravityYInput = document.getElementById('destructionGravityYInput');
    const gravityXSlider = document.getElementById('destructionGravityXSlider');
    const gravityXInput = document.getElementById('destructionGravityXInput');
    const bounceSlider = document.getElementById('destructionBounceSlider');
    const bounceInput = document.getElementById('destructionBounceInput');
    const ballBounceSlider = document.getElementById('destructionBallBounceSlider');
    const ballBounceInput = document.getElementById('destructionBallBounceInput');
    const bombSlider = document.getElementById('destructionBombSlider');
    const bombInput = document.getElementById('destructionBombInput');
    const gripSlider = document.getElementById('destructionGripSlider');
    const gripInput = document.getElementById('destructionGripInput');
    const pileClearSlider = document.getElementById('destructionPileClearSlider');
    const pileClearInput = document.getElementById('destructionPileClearInput');
    if (
      !toggle || !controls || !gravityYSlider || !gravityYInput || !gravityXSlider || !gravityXInput
      || !bounceSlider || !bounceInput || !ballBounceSlider || !ballBounceInput
      || !bombSlider || !bombInput || !gripSlider || !gripInput
      || !pileClearSlider || !pileClearInput
    ) {
      return;
    }

    const format = (value, digits = 2) => Number(value).toFixed(digits).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    const defaults = normalizeDestructionSettings({});
    const controlMap = {
      gravityY: { slider: gravityYSlider, input: gravityYInput, scale: 100, min: -0.2, max: 1.2, digits: 2 },
      gravityX: { slider: gravityXSlider, input: gravityXInput, scale: 100, min: -0.8, max: 0.8, digits: 2 },
      restitution: { slider: bounceSlider, input: bounceInput, scale: 100, min: 0, max: 1.25, digits: 2 },
      dynamicPegBallBounce: { slider: ballBounceSlider, input: ballBounceInput, scale: 100, min: 0, max: 1.25, digits: 2 },
      bombImpulse: { slider: bombSlider, input: bombInput, scale: 1, min: 0, max: 32, digits: 1 },
      surfaceGrip: { slider: gripSlider, input: gripInput, scale: 100, min: 0, max: 1, digits: 2 },
      stuckPileClearDelayMs: { slider: pileClearSlider, input: pileClearInput, scale: 1, min: 0, max: 2000, digits: 2, secondsInput: true }
    };
    const applyScaled = (prop, slider, input, rawValue, scale, min, max, options = null) => {
      const isMsSecondsInput = prop === 'stuckPileClearDelayMs' && options?.fromSecondsInput === true;
      const rawNumber = parseFloat(rawValue);
      const candidate = isMsSecondsInput ? rawNumber * 1000 : rawNumber;
      const value = Math.max(min, Math.min(max, Number.isFinite(candidate) ? candidate : 0));
      const normalized = normalizeDestructionSettings({ [prop]: value });
      const next = normalized[prop];
      slider.value = Math.round(next * scale);
      if (prop === 'stuckPileClearDelayMs') input.value = format(next / 1000, 2);
      else input.value = format(next, prop === 'bombImpulse' ? 1 : 2);
      this.updateLevelDestructionSettings({ [prop]: next });
    };
    const applyControlValue = (prop, value) => {
      const config = controlMap[prop];
      if (!config) return;
      applyScaled(prop, config.slider, config.input, value, config.scale, config.min, config.max);
    };

    toggle.addEventListener('change', () => {
      this.updateLevelDestructionSettings({ enabled: toggle.checked });
      if (toggle.checked) {
        this.updateLevelSurvivalSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelPvpSettings({ enabled: false }, { refreshUi: false });
        this.updateLevelBilliardSettings({ enabled: false }, { refreshUi: false });
      }
      this._setDestructionSettingsVisible(toggle.checked);
      this.updateLevelSettings();
      this.syncSelectionPanels();
    });

    gravityYSlider.addEventListener('input', () => {
      gravityYInput.value = format(parseFloat(gravityYSlider.value) / 100, 2);
    });
    gravityYSlider.addEventListener('change', () => applyScaled('gravityY', gravityYSlider, gravityYInput, parseFloat(gravityYSlider.value) / 100, 100, -0.2, 1.2));
    gravityYInput.addEventListener('change', () => applyScaled('gravityY', gravityYSlider, gravityYInput, gravityYInput.value, 100, -0.2, 1.2));

    gravityXSlider.addEventListener('input', () => {
      gravityXInput.value = format(parseFloat(gravityXSlider.value) / 100, 2);
    });
    gravityXSlider.addEventListener('change', () => applyScaled('gravityX', gravityXSlider, gravityXInput, parseFloat(gravityXSlider.value) / 100, 100, -0.8, 0.8));
    gravityXInput.addEventListener('change', () => applyScaled('gravityX', gravityXSlider, gravityXInput, gravityXInput.value, 100, -0.8, 0.8));

    bounceSlider.addEventListener('input', () => {
      bounceInput.value = format(parseFloat(bounceSlider.value) / 100, 2);
    });
    bounceSlider.addEventListener('change', () => applyScaled('restitution', bounceSlider, bounceInput, parseFloat(bounceSlider.value) / 100, 100, 0, 1.25));
    bounceInput.addEventListener('change', () => applyScaled('restitution', bounceSlider, bounceInput, bounceInput.value, 100, 0, 1.25));

    ballBounceSlider.addEventListener('input', () => {
      ballBounceInput.value = format(parseFloat(ballBounceSlider.value) / 100, 2);
    });
    ballBounceSlider.addEventListener('change', () => applyScaled('dynamicPegBallBounce', ballBounceSlider, ballBounceInput, parseFloat(ballBounceSlider.value) / 100, 100, 0, 1.25));
    ballBounceInput.addEventListener('change', () => applyScaled('dynamicPegBallBounce', ballBounceSlider, ballBounceInput, ballBounceInput.value, 100, 0, 1.25));

    bombSlider.addEventListener('input', () => {
      bombInput.value = bombSlider.value;
    });
    bombSlider.addEventListener('change', () => applyScaled('bombImpulse', bombSlider, bombInput, bombSlider.value, 1, 0, 32));
    bombInput.addEventListener('change', () => applyScaled('bombImpulse', bombSlider, bombInput, bombInput.value, 1, 0, 32));

    gripSlider.addEventListener('input', () => {
      gripInput.value = format(parseFloat(gripSlider.value) / 100, 2);
    });
    gripSlider.addEventListener('change', () => applyScaled('surfaceGrip', gripSlider, gripInput, parseFloat(gripSlider.value) / 100, 100, 0, 1));
    gripInput.addEventListener('change', () => applyScaled('surfaceGrip', gripSlider, gripInput, gripInput.value, 100, 0, 1));

    pileClearSlider.addEventListener('input', () => {
      pileClearInput.value = format((parseFloat(pileClearSlider.value) || 0) / 1000, 2);
    });
    pileClearSlider.addEventListener('change', () => applyScaled('stuckPileClearDelayMs', pileClearSlider, pileClearInput, pileClearSlider.value, 1, 0, 2000));
    pileClearInput.addEventListener('change', () => applyScaled(
      'stuckPileClearDelayMs',
      pileClearSlider,
      pileClearInput,
      pileClearInput.value,
      1,
      0,
      2000,
      { fromSecondsInput: true }
    ));

    controls.querySelectorAll('[data-destruction-default]').forEach(button => {
      button.addEventListener('click', () => {
        const prop = button.getAttribute('data-destruction-default');
        if (!prop || !Object.prototype.hasOwnProperty.call(defaults, prop)) return;
        applyControlValue(prop, defaults[prop]);
      });
    });
  }

  _getSurvivalCurveMetrics(canvas) {
    const width = canvas?.width || 154;
    const height = canvas?.height || 86;
    const pad = { left: 12, top: 8, right: 10, bottom: 14 };
    return {
      width,
      height,
      pad,
      plotW: Math.max(1, width - pad.left - pad.right),
      plotH: Math.max(1, height - pad.top - pad.bottom)
    };
  }

  _survivalCurvePointToCanvas(canvas, x, speed) {
    const metrics = this._getSurvivalCurveMetrics(canvas);
    const px = metrics.pad.left + Utils.clamp(x, 0, 1) * metrics.plotW;
    const yNorm = (Utils.clamp(speed, 0.05, 3) - 0.05) / (3 - 0.05);
    const py = metrics.pad.top + (1 - yNorm) * metrics.plotH;
    return { x: px, y: py };
  }

  _survivalCurveEventToValue(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const metrics = this._getSurvivalCurveMetrics(canvas);
    const sx = (event.clientX - rect.left) * (metrics.width / Math.max(1, rect.width));
    const sy = (event.clientY - rect.top) * (metrics.height / Math.max(1, rect.height));
    const x = Utils.clamp((sx - metrics.pad.left) / metrics.plotW, 0, 1);
    const yNorm = 1 - Utils.clamp((sy - metrics.pad.top) / metrics.plotH, 0, 1);
    const speed = 0.05 + yNorm * (3 - 0.05);
    return { x, speed };
  }

  _getSurvivalCurveHandleAt(event, rawCurve, canvas) {
    const curve = normalizeSurvivalSpeedCurve(rawCurve);
    const value = this._survivalCurveEventToValue(event, canvas);
    const handles = [
      { id: 'p0', x: 0, speed: curve.y0 },
      { id: 'p1', x: curve.x1, speed: curve.y1 },
      { id: 'p2', x: curve.x2, speed: curve.y2 },
      { id: 'p3', x: 1, speed: curve.y3 }
    ];
    let best = handles[0];
    let bestDist = Infinity;
    for (const handle of handles) {
      const dx = handle.x - value.x;
      const dy = (handle.speed - value.speed) / 3;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        best = handle;
        bestDist = dist;
      }
    }
    return best.id;
  }

  _applySurvivalCurveDrag(event, canvas) {
    const handle = this._survivalCurveDragHandle;
    if (!handle) return;
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const survival = ensureLevelSurvival(level, this.canvas.height);
    const value = this._survivalCurveEventToValue(event, canvas);
    const next = { ...survival.speedCurve, preset: 'custom' };

    if (handle === 'p0') {
      next.y0 = value.speed;
    } else if (handle === 'p1') {
      next.x1 = Math.min(value.x, next.x2);
      next.y1 = value.speed;
    } else if (handle === 'p2') {
      next.x2 = Math.max(value.x, next.x1);
      next.y2 = value.speed;
    } else if (handle === 'p3') {
      next.y3 = value.speed;
    }

    const normalized = normalizeSurvivalSpeedCurve(next);
    this.updateLevelSurvivalSettings(
      { speedCurve: normalized },
      { save: false, refreshUi: false }
    );
    const presetSelect = document.getElementById('survivalSpeedCurvePreset');
    if (presetSelect) presetSelect.value = 'custom';
    this._drawSurvivalSpeedCurveEditor(normalized);
  }

  _drawSurvivalSpeedCurveEditor(rawCurve) {
    const canvas = document.getElementById('survivalSpeedCurveCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const curve = normalizeSurvivalSpeedCurve(rawCurve);
    const metrics = this._getSurvivalCurveMetrics(canvas);
    const p0 = this._survivalCurvePointToCanvas(canvas, 0, curve.y0);
    const p1 = this._survivalCurvePointToCanvas(canvas, curve.x1, curve.y1);
    const p2 = this._survivalCurvePointToCanvas(canvas, curve.x2, curve.y2);
    const p3 = this._survivalCurvePointToCanvas(canvas, 1, curve.y3);
    const baseline = this._survivalCurvePointToCanvas(canvas, 0, 1).y;

    ctx.clearRect(0, 0, metrics.width, metrics.height);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(metrics.pad.left, baseline);
    ctx.lineTo(metrics.width - metrics.pad.right, baseline);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(140, 255, 0, 0.28)';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.strokeStyle = '#8cff00';
    ctx.lineWidth = 2.25;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();

    const drawHandle = (point, fill, radius = 4) => {
      ctx.fillStyle = fill;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    drawHandle(p0, '#ffffff', 4.5);
    drawHandle(p3, '#ffffff', 4.5);
    drawHandle(p1, '#48cfff', 4);
    drawHandle(p2, '#48cfff', 4);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('slow', metrics.pad.left, metrics.height - 4);
    ctx.textAlign = 'right';
    ctx.fillText('fast', metrics.width - metrics.pad.right, metrics.pad.top + 8);
    ctx.restore();
  }

  _setSurvivalSettingsVisible(visible) {
    const container = document.getElementById('survivalControls');
    if (!container) return;
    container.classList.toggle('hidden', !visible);
  }

  _setPvpSettingsVisible(visible) {
    const container = document.getElementById('pvpControls');
    if (!container) return;
    container.classList.toggle('hidden', !visible);
  }

  _setBilliardSettingsVisible(visible) {
    const container = document.getElementById('billiardControls');
    if (!container) return;
    container.classList.toggle('hidden', !visible);
  }

  _setDestructionSettingsVisible(visible) {
    const container = document.getElementById('destructionControls');
    if (!container) return;
    container.classList.toggle('hidden', !visible);
  }

  setSurvivalPanelVisible(visible) {
    const panel = document.getElementById('survivalPanel');
    if (!panel) return;
    panel.classList.toggle('visible', !!visible);
  }

  setPvpPanelVisible(visible) {
    const panel = document.getElementById('pvpPanel');
    if (!panel) return;
    panel.classList.toggle('visible', !!visible);
  }

  setBilliardPanelVisible(visible) {
    const panel = document.getElementById('billiardPanel');
    if (!panel) return;
    panel.classList.toggle('visible', !!visible);
  }

  setDestructionPanelVisible(visible) {
    const panel = document.getElementById('destructionPanel');
    if (!panel) return;
    panel.classList.toggle('visible', !!visible);
  }

  _updateSurvivalBackgroundStatus(survival) {
    const status = document.getElementById('survivalBackgroundStatus');
    const removeBtn = document.getElementById('survivalBackgroundRemoveBtn');
    if (!status) return;
    const hasImage = !!(survival?.background?.type === 'image' && survival.background.image);
    status.textContent = hasImage ? 'Image loaded for full vertical field' : 'No image';
    if (removeBtn) removeBtn.disabled = !hasImage;
  }

  setupAimLengthPanel() {
    const slider = document.getElementById('aimLengthSlider');
    const numInput = document.getElementById('aimLengthInput');
    const clearToggle = document.getElementById('hitPegTimedClearToggle');
    const clearSlider = document.getElementById('hitPegClearDelaySlider');
    const clearInput = document.getElementById('hitPegClearDelayInput');
    if (!slider || !numInput) return;

    const apply = (rawValue) => {
      const value = Math.max(0, Math.min(300, Math.round(parseFloat(rawValue) || 300)));
      slider.value = value;
      numInput.value = value;
      const level = this.levelManager.getCurrentLevel();
      if (level) {
        const pvp = ensureLevelPvp(level);
        if (pvp.enabled) {
          level.pvp = normalizePvpSettings({ ...pvp, aimLength: value });
          this.levelManager.save();
        } else {
          this.levelManager.updateCurrentLevel({ aimLength: value });
        }
      }
      if (this.game) this.game.setAimLength(value);
    };

    slider.addEventListener('input', () => {
      numInput.value = slider.value;
    });
    slider.addEventListener('change', () => apply(slider.value));
    numInput.addEventListener('change', () => apply(numInput.value));

    if (clearToggle && clearSlider && clearInput) {
      const formatSeconds = (ms) => (Math.round(ms) / 1000).toFixed(1);
      const syncClearControls = (enabled) => {
        clearSlider.disabled = !enabled;
        clearInput.disabled = !enabled;
      };
      clearToggle.addEventListener('change', () => {
        const enabled = clearToggle.checked;
        syncClearControls(enabled);
        const level = this.levelManager.getCurrentLevel();
        if (level) {
          this.levelManager.updateCurrentLevel({ hitPegTimedClearEnabled: enabled });
        }
        if (this.game) this.game.setHitPegTimedClearEnabled(enabled);
      });
      const applyClearDelay = (rawValue, fromSeconds = false) => {
        const rawMs = fromSeconds
          ? (parseFloat(rawValue) || 0) * 1000
          : parseFloat(rawValue) || 0;
        const value = normalizeHitPegClearDelayMs(rawMs);
        clearSlider.value = value;
        clearInput.value = formatSeconds(value);
        const level = this.levelManager.getCurrentLevel();
        if (level) {
          this.levelManager.updateCurrentLevel({ hitPegClearDelayMs: value });
        }
        if (this.game) this.game.setHitPegClearDelay(value);
      };

      clearSlider.addEventListener('input', () => {
        clearInput.value = formatSeconds(parseFloat(clearSlider.value) || 0);
      });
      clearSlider.addEventListener('change', () => applyClearDelay(clearSlider.value));
      clearInput.addEventListener('change', () => applyClearDelay(clearInput.value, true));
      syncClearControls(clearToggle.checked);
    }
  }

  setAimLengthPanelVisible(visible) {
    const panel = document.getElementById('aimLengthPanel');
    if (panel) panel.style.display = visible ? '' : 'none';
  }

  updateLevelSurvivalSettings(partialSettings, options = {}) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const current = ensureLevelSurvival(level, this.canvas.height);
    const nextRaw = { ...current, ...partialSettings };
    if (partialSettings?.background) {
      nextRaw.background = { ...(current.background || {}), ...partialSettings.background };
    }
    if (partialSettings?.gamblePeg) {
      nextRaw.gamblePeg = { ...(current.gamblePeg || {}), ...partialSettings.gamblePeg };
    }
    level.survival = normalizeSurvivalSettings(
      nextRaw,
      this.canvas.height
    );
    if (level.survival.enabled) {
      level.pvp = normalizePvpSettings({ ...(level.pvp || {}), enabled: false });
      level.billiard = normalizeBilliardSettings({ ...(level.billiard || {}), enabled: false });
      level.destruction = normalizeDestructionSettings({ ...(level.destruction || {}), enabled: false });
    }
    if (options.save !== false) {
      this.levelManager.save();
    }
    this.applySurvivalSettingsToEditor();
    if (options.refreshUi !== false) {
      this.updateLevelSettings();
    }
  }

  updateLevelPvpSettings(partialSettings, options = {}) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const current = ensureLevelPvp(level);
    level.pvp = normalizePvpSettings({ ...current, ...(partialSettings || {}) });
    if (level.pvp.enabled) {
      if (!Number.isFinite(level.pvp.aimLength)) {
        level.pvp = normalizePvpSettings({ ...level.pvp, aimLength: PVP_DEFAULT_AIM_LENGTH });
      }
      level.survival = normalizeSurvivalSettings({
        ...ensureLevelSurvival(level, this.canvas.height),
        enabled: false
      }, this.canvas.height);
      level.billiard = normalizeBilliardSettings({ ...(level.billiard || {}), enabled: false });
      level.destruction = normalizeDestructionSettings({ ...(level.destruction || {}), enabled: false });
      if (level.pvp.symmetryEnabled) {
        normalizePvpAuthoredPegs(level, this.canvas.height);
      }
    }

    if (options.save !== false) {
      this.levelManager.save();
    }
    this.applyPvpSettingsToEditor();
    if (options.refreshUi !== false) {
      this.updateLevelSettings();
    }
    if (this.editor && this.editor.onPegCountChange) {
      this.editor.onPegCountChange(level.pegs.length);
    }
  }

  updateLevelBilliardSettings(partialSettings, options = {}) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const current = ensureLevelBilliard(level);
    level.billiard = normalizeBilliardSettings({ ...current, ...(partialSettings || {}) });
    if (level.billiard.enabled) {
      level.survival = normalizeSurvivalSettings({
        ...ensureLevelSurvival(level, this.canvas.height),
        enabled: false
      }, this.canvas.height);
      level.pvp = normalizePvpSettings({ ...(level.pvp || {}), enabled: false });
      level.destruction = normalizeDestructionSettings({ ...(level.destruction || {}), enabled: false });
    }

    if (options.save !== false) {
      this.levelManager.save();
    }
    if (this.game) {
      this.game.destructionSettings = level.destruction;
      this.game.destructionSystem.configure(level.destruction);
      this.game.syncDestructionContactSettings?.();
    }
    if (options.refreshUi !== false) {
      this.updateLevelSettings();
    }
  }

  updateLevelDestructionSettings(partialSettings, options = {}) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const current = ensureLevelDestruction(level);
    level.destruction = normalizeDestructionSettings({ ...current, ...(partialSettings || {}) });
    if (level.destruction.enabled) {
      level.survival = normalizeSurvivalSettings({
        ...ensureLevelSurvival(level, this.canvas.height),
        enabled: false
      }, this.canvas.height);
      level.pvp = normalizePvpSettings({ ...(level.pvp || {}), enabled: false });
      level.billiard = normalizeBilliardSettings({ ...(level.billiard || {}), enabled: false });
    }

    if (options.save !== false) {
      this.levelManager.save();
    }
    if (options.refreshUi !== false) {
      this.updateLevelSettings();
    }
  }

  updateLevelYoyoSettings(partialSettings) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const next = normalizeYoyoSettings({ ...(level.yoyo || {}), ...(partialSettings || {}) });
    this.levelManager.updateCurrentLevel({ yoyo: next });
    if (this.mode === 'play' && this.game) {
      this.game.applyYoyoSettings(next);
    }
    this.updateLevelSettings();
  }

  applySurvivalSettingsToEditor() {
    if (!this.editor) return;
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    this.editor.setSurvivalSettings(ensureLevelSurvival(level, this.canvas.height));
  }

  applyPvpSettingsToEditor() {
    if (!this.editor) return;
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    this.editor.setPvpSettings(ensureLevelPvp(level));
  }

  _setFlipperProp(prop, value) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    const cameraY = this.editor?.getCameraY?.() || 0;
    const base = normalizeFlipperConfig(level.flippers, {
      canvasHeight: this.canvas.height,
      cameraY,
      bounce: PHYSICS_CONFIG.bounce
    }) || createDefaultFlipperConfig({
      canvasHeight: this.canvas.height,
      cameraY,
      bounce: PHYSICS_CONFIG.bounce,
      enabled: true
    });
    level.flippers = { ...base, [prop]: value, enabled: true };
    this.levelManager.save();
  }

  showFlipperPanel() {
    const cameraY = this.editor?.getCameraY?.() || 0;
    const f = normalizeFlipperConfig(this.levelManager.getFlippers(), {
      canvasHeight: this.canvas.height,
      cameraY,
      bounce: PHYSICS_CONFIG.bounce
    });
    if (!f) return;

    document.getElementById('flipperLengthSlider').value = f.length ?? FLIPPER_DEFAULTS.length;
    document.getElementById('flipperLengthInput').value = f.length ?? FLIPPER_DEFAULTS.length;
    document.getElementById('flipperOffsetSlider').value = f.xOffset ?? FLIPPER_DEFAULTS.xOffset;
    document.getElementById('flipperOffsetInput').value = f.xOffset ?? FLIPPER_DEFAULTS.xOffset;
    document.getElementById('flipperRestSlider').value = f.restAngle ?? FLIPPER_DEFAULTS.restAngle;
    document.getElementById('flipperRestInput').value = f.restAngle ?? FLIPPER_DEFAULTS.restAngle;
    document.getElementById('flipperFlipSlider').value = f.flipAngle ?? FLIPPER_DEFAULTS.flipAngle;
    document.getElementById('flipperFlipInput').value = f.flipAngle ?? FLIPPER_DEFAULTS.flipAngle;
    document.getElementById('flipperWidthSlider').value = f.width ?? FLIPPER_DEFAULTS.width;
    document.getElementById('flipperWidthInput').value = f.width ?? FLIPPER_DEFAULTS.width;
    const bounce = f.bounce ?? PHYSICS_CONFIG.bounce;
    document.getElementById('flipperBounceSlider').value = bounce.toFixed(2);
    document.getElementById('flipperBounceInput').value = bounce.toFixed(2);
    const scale = f.scale ?? FLIPPER_DEFAULTS.scale;
    document.getElementById('flipperScaleSlider').value = Math.round(scale * 10);
    document.getElementById('flipperScaleInput').value = scale.toFixed(1);
    document.getElementById('flipperPanel').classList.add('visible');
  }

  closeFlipperPanel() {
    document.getElementById('flipperPanel').classList.remove('visible');
  }

  _isPortalType(type) {
    return type === 'portalBlue' || type === 'portalOrange';
  }

  _isCircleOnlyType(type) {
    return type === 'bumper' || this._isPortalType(type) || isBilliardPegType(type);
  }

  _setActiveShapeButton(shape) {
    document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
    const target = document.querySelector(`.shape-btn[data-shape="${shape}"]`);
    if (target) target.classList.add('active');
  }

  syncSelectionPanels() {
    if (!this.editor) return;
    const count = this.editor.selectedPegIds.size;

    if (count > 0 && this.editor.isSelectionAllBumpers()) {
      this.showBumperPanel();
    } else {
      this.closeBumperPanel();
    }

    if (count > 0 && this.editor.isSelectionAllPortals()) {
      this.showPortalPanel();
    } else {
      this.closePortalPanel();
    }

    if (count > 0 && (this.editor.isSelectionAllMultiballs() || this.editor.isSelectionAllGamblePegs())) {
      this.showMultiballPanel();
    } else {
      this.closeMultiballPanel();
    }

    const level = this.levelManager.getCurrentLevel();
    const destruction = level ? ensureLevelDestruction(level) : null;
    if (count > 0 && destruction?.enabled) {
      this.showDestructionPegPanel();
    } else {
      this.closeDestructionPegPanel();
    }

    // Show/hide peg color picker
    this._syncPegColorPicker();
  }

  _syncPegColorPicker() {
    const row = document.getElementById('pegColorRow');
    const picker = document.getElementById('pegColorPicker');
    if (!row || !picker || !this.editor) return;

    const typeColors = {
      orange: '#ff6b35', billiardRed: '#e84d4d', billiardYellow: '#ffd447', blue: '#4ecdc4', green: '#95d5b2',
      purple: '#c77dff', multi: '#ff4d9d', obstacle: '#6b7280',
      gamble: '#8cff00', bumper: '#e0e0e0', portalBlue: '#4ecdc4', portalOrange: '#ff8b3d'
    };

    const count = this.editor.selectedPegIds.size;
    if (count > 0) {
      const color = this.editor.getSelectedPegColor();
      if (color) {
        picker.value = color;
      } else {
        const level = this.levelManager.getCurrentLevel();
        if (level) {
          const firstId = [...this.editor.selectedPegIds][0];
          const peg = level.pegs.find(p => p.id === firstId);
          picker.value = typeColors[peg?.type] || '#4ecdc4';
        }
      }
    } else {
      picker.value = this.editor.selectedPegColor || typeColors[this.editor.selectedPegType] || '#4ecdc4';
    }
  }

  showAnimationPanel() {
    this._syncAnimationSliders();
    document.getElementById('animPanel').classList.add('visible');

    // Wire canvas drag → slider + input sync
    if (this.editor) {
      this.editor.onAnimationOffsetChange = (offset) => {
        const dx = Math.round(offset.dx);
        const dy = Math.round(offset.dy);
        document.getElementById('animDxSlider').value = dx;
        document.getElementById('animDxInput').value = dx;
        document.getElementById('animDySlider').value = dy;
        document.getElementById('animDyInput').value = dy;
      };
    }
  }

  closeAnimationPanel() {
    if (this.editor) {
      this.editor.stopAnimationPreview();
      this.editor.exitAnimationMode();
      this.editor.onAnimationOffsetChange = null;
    }
    document.getElementById('animPreviewBtn').textContent = 'Preview';
    document.getElementById('animPanel').classList.remove('visible');
  }

  _syncAnimationSliders() {
    if (!this.editor) return;
    const off = this.editor.animationGhostOffset || { dx: 0, dy: 0 };
    const rot = Math.round(this.editor.animationRotation * 180 / Math.PI);
    const dur = this.editor.animationDuration;
    const easing = this.editor.animationEasing;

    document.getElementById('animDxSlider').value = Math.round(off.dx);
    document.getElementById('animDxInput').value = Math.round(off.dx);
    document.getElementById('animDySlider').value = Math.round(off.dy);
    document.getElementById('animDyInput').value = Math.round(off.dy);
    document.getElementById('animRotSlider').value = rot;
    document.getElementById('animRotInput').value = rot;
    document.getElementById('animDurationSlider').value = Math.round(dur * 10);
    document.getElementById('animDurationInput').value = dur.toFixed(1);
    document.getElementById('animEasingToggle').checked = easing === 'easeInOut';
    this._syncAnimationInverseButton();
    this._syncAnimationCycleButton();
    this._syncAnimationCircleButton();
    this._syncAnimationHitTrigger();
  }

  _syncAnimationInverseButton() {
    const inverseBtn = document.getElementById('animInverseBtn');
    if (!inverseBtn) return;
    const inverseOn = !!(this.editor && this.editor.animationInverse);
    inverseBtn.classList.toggle('active', inverseOn);
    inverseBtn.textContent = inverseOn ? 'Inverse: ON' : 'Inverse: OFF';
  }

  _syncAnimationCycleButton() {
    const cycleBtn = document.getElementById('animCycleBtn');
    if (!cycleBtn) return;
    const cycleOn = !!(this.editor && this.editor.animationCycle);
    cycleBtn.classList.toggle('active', cycleOn);
    cycleBtn.textContent = cycleOn ? 'Cycle: ON' : 'Cycle: OFF';
    // Disable easing when cycle is on
    const easingToggle = document.getElementById('animEasingToggle');
    if (easingToggle) {
      easingToggle.disabled = cycleOn;
      if (cycleOn) easingToggle.checked = false;
    }
  }

  _syncAnimationCircleButton() {
    const circleBtn = document.getElementById('animCircleBtn');
    if (!circleBtn) return;
    const on = !!(this.editor && this.editor.animationCircularPath);
    circleBtn.classList.toggle('active', on);
    circleBtn.textContent = on ? 'Circle: ON' : 'Circle: OFF';
    const modeRow = document.getElementById('animCircleModeRow');
    if (modeRow) modeRow.style.display = on ? '' : 'none';
    const halfBtn = document.getElementById('animCircleHalfBtn');
    const fullBtn = document.getElementById('animCircleFullBtn');
    if (halfBtn && fullBtn) {
      const full = !!(this.editor && this.editor.animationCircularFull);
      halfBtn.classList.toggle('active', !full);
      fullBtn.classList.toggle('active', full);
    }
  }

  _syncAnimationHitTrigger() {
    const toggle = document.getElementById('animHitTriggerToggle');
    const modeRow = document.getElementById('animHitModeRow');
    const stepsRow = document.getElementById('animHitStepsRow');
    const stepsInput = document.getElementById('animHitStepsInput');
    const cycleBtn = document.getElementById('animHitCycleBtn');
    const singleBtn = document.getElementById('animHitSingleBtn');
    const spinBtn = document.getElementById('animHitSpinBtn');
    if (!toggle) return;
    const on = !!(this.editor && this.editor.animationHitTrigger);
    toggle.checked = on;
    modeRow.style.display = on ? '' : 'none';
    const mode = (this.editor && this.editor.animationHitMode) || 'cycle';
    cycleBtn.classList.toggle('active', mode === 'cycle');
    singleBtn.classList.toggle('active', mode === 'single');
    spinBtn.classList.toggle('active', mode === 'spin');
    stepsRow.style.display = (on && (mode === 'single' || mode === 'spin')) ? '' : 'none';
    stepsInput.value = (this.editor && this.editor.animationHitSteps) || 1;
  }

  initMode() {
    // Ensure we have at least one level
    if (this.levelManager.getLevelCount() === 0) {
      this.levelManager.createLevel('Level 1');
    }

    // Start in editor mode
    this.startEditor();

    // Async: pull remote levels into local cache
    this._pullRemoteLevels();
    // Background-pull the character registry so portraits show without
    // manually clicking Pull from Server. Local data wins if user already
    // has custom characters here.
    this._backgroundPullCharacterRegistry();
    this.updateLevelTitle();
    this.updateLevelSettings();
  }

  async _backgroundPullCharacterRegistry() {
    if (this._characterRegistryAutoPulled) return;
    this._characterRegistryAutoPulled = true;
    if (this._characterRegistryHasUserData(this.characterRegistry)) return;
    try {
      await this._pullCharacterRegistryFromServer(null, { silent: true });
      // Refresh portrait display for the current level if we got new data.
      const level = this.levelManager.getCurrentLevel();
      if (level && this.mode === 'editor') {
        this._showAssignedCharacterIdlePortrait?.(level);
      }
    } catch (e) {
      console.warn('[characters] background pull failed', e);
    }
  }

  startEditor() {
    this.teardownGambleSystem();
    this.portraitReactionController.dispose();

    // Clean up ball counter
    if (this._unsubBallCounter) {
      this._unsubBallCounter();
      this._unsubBallCounter = null;
    }
    this.visualLayout.hideBallCounter();
    this.visualLayout.hideHealthBar();
    this.visualLayout.setPvpOpponentTarget?.(null);
    this.visualLayout.setPvpMode?.(false);

    if (this.game) {
      this.game.stop();
      this.game = null;
    }

    // Defensive: dispose any existing editor before constructing a new one.
    // Several call sites (level import, campaign open, mode toggles) re-enter
    // startEditor while the previous Editor is still mounted; without this,
    // its mousedown / mousemove / keydown listeners leak and a second instance
    // runs alongside the new one — producing draw-mode "stickiness", duplicate
    // pegs on commit, and double alt-drag copies.
    if (this.editor) {
      this.closeAnimationPanel?.();
      this.closeBumperPanel?.();
      this.closePortalPanel?.();
      this.closeMultiballPanel?.();
      this.closeFlipperPanel?.();
      this.editor.stop();
      this.editor = null;
    }

    this.mode = 'editor';
    this.editor = new Editor(this.canvas, this.levelManager);
    this.editor.renderer.onVerticalProgress = (progress) => {
      this.visualLayout.updateSurvivalProgressIndicator(progress);
    };
    
    // Resize to current dimensions
    this.resizeCanvas();
    const currentLevel = this.levelManager.getCurrentLevel();
    if (currentLevel) {
      this.editor.setSurvivalSettings(ensureLevelSurvival(currentLevel, this.canvas.height));
    }
    
    this.editor.onPegCountChange = (count) => {
      document.getElementById('pegCount').textContent = `Pegs: ${count}`;
    };

    this.editor.onSelectionChange = (count) => {
      document.getElementById('selectionCount').textContent = count > 0 ? `Selected: ${count}` : '';
      this.syncSelectionPanels();
    };

    this.editor.onFlipperSelectionChange = (selected) => {
      if (selected) {
        this.showFlipperPanel();
      } else {
        this.closeFlipperPanel();
      }
    };

    this.editor.onFlippersDeleted = () => {
      this.closeFlipperPanel();
      document.getElementById('flipperBtn').classList.remove('active');
    };

    this.editor.onBumperPropertyChange = () => {
      // Sync bumper panel sliders when properties change via drag
      const props = this.editor.getSelectedBumperProperties();
      if (props) {
        document.getElementById('bumperScaleSlider').value = Math.round(props.scale * 10);
        document.getElementById('bumperScaleInput').value = props.scale.toFixed(1);
      }
    };

    this.editor.onModeChange = (mode) => {
      document.getElementById('selectBtn').classList.toggle('active', mode === 'select');
      document.getElementById('drawBtn').classList.toggle('active', mode === 'draw');
    };

    this.editor.onGridChange = (gridOn) => {
      document.getElementById('gridBtn').classList.toggle('active', gridOn);
    };

    this.editor.onSnapChange = (snapOn) => {
      document.getElementById('magnetBtn').classList.toggle('active', snapOn);
    };

    this.editor.onEnterAnimationMode = () => {
      this.showAnimationPanel();
    };

    this.editor.start();

    // Update UI
    document.getElementById('playBtn').innerHTML = '▶';
    document.getElementById('playBtn').title = 'Play Level';
    document.querySelector('.toolbar').style.display = 'flex';
    this.setSurvivalPanelVisible(true);
    this.setPvpPanelVisible(true);
    this.setBilliardPanelVisible(true);
    this.setDestructionPanelVisible(true);
    this.setAimLengthPanelVisible(true);

    // Sync tool button states
    document.getElementById('gridBtn').classList.toggle('active', this.editor.showGrid);
    document.getElementById('magnetBtn').classList.toggle('active', this.editor.snapToGrid);

    // Sync flipper button state
    const flipperData = this.levelManager.getFlippers();
    document.getElementById('flipperBtn').classList.toggle('active', !!(flipperData && flipperData.enabled));
    
    // Show current peg count
    if (currentLevel) {
      document.getElementById('pegCount').textContent = `Pegs: ${currentLevel.pegs.length}`;
    }

    // Keep side-panel settings in sync when switching/returning to editor.
    this.updateLevelSettings();
    this.applyPvpSettingsToEditor();
    this._applyLevelVisuals();
    this.visualLayout.setSpinMode(false);
    this.visualLayout.setEditMode(false);
    this.visualLayout.setPanelVisible(true);
    if (this.adminPanel) this.adminPanel.classList.remove('hidden');
    this.resizeCanvas(); // re-fit frame with panel visible
    this._setPortraitControllerContextForCurrentLevel({ live: false });
    this._setDialogueControllerContextForCurrentLevel({ live: false, refreshPreview: true });
  }

  startGame() {
    this.closeDialogueEditor();
    this.closeCharacterEditor();
    this.teardownGambleSystem();

    if (this.editor) {
      this.visualLayout.setBallTrailPreview?.(false);
      this.visualLayout.setShockwavePreview?.(false);
      // Close panels if open
      this.closeAnimationPanel();
      this.closeBumperPanel();
      this.closePortalPanel();
      this.closeMultiballPanel();
      this.closeDestructionPegPanel();
      this.closeFlipperPanel();
      this.editor.stop();
      this.editor = null;
    }

    const level = this.levelManager.getCurrentLevel();
    const pvp = ensureLevelPvp(level);
    if (!level || (!pvp.enabled && level.pegs.length === 0)) {
      alert('Add some pegs first!');
      this.startEditor();
      return;
    }

    if (pvp.enabled) {
      this.startPvpGame(level, pvp);
      return;
    }

    const billiard = ensureLevelBilliard(level);
    if (billiard.enabled) {
      const redCount = level.pegs.filter(p => p.type === BILLIARD_RED).length;
      const yellowCount = level.pegs.filter(p => p.type === BILLIARD_YELLOW).length;
      if (redCount === 0 || yellowCount === 0) {
        alert('Add at least one red and one yellow billiard peg to play Billiard Mode.');
        this.startEditor();
        return;
      }
      if (redCount !== yellowCount) {
        alert('Billiard Mode needs the same number of red and yellow pegs.');
        this.startEditor();
        return;
      }
    }

    const survival = ensureLevelSurvival(level, this.canvas.height);
    if (!survival.enabled && !billiard.enabled) {
      // Check for at least one orange peg in classic mode
      const orangePegs = level.pegs.filter(p => p.type === 'orange' || (p.type === 'bumper' && p.bumperOrange));
      if (orangePegs.length === 0) {
        alert('Add at least one orange peg to play!');
        this.startEditor();
        return;
      }
    }

    this.mode = 'play';
    this.game = new Game(this.canvas);
    this.visualLayout.setPvpOpponentTarget?.(null);
    this.visualLayout.setPvpMode?.(false);
    this.game.showPerfOverlay = true; // editor play mode shows debug info
    this.game.renderer.onVerticalProgress = (progress) => {
      this.visualLayout.updateSurvivalProgressIndicator(progress);
    };

    // Apply trajectory setting
    const trajectoryToggle = document.getElementById('trajectoryToggle');
    this.game.setShowFullTrajectory(trajectoryToggle.checked);

    // Resize to current dimensions
    this.resizeCanvas();

    const visuals = normalizeVisuals(level?.visuals);
    this.game.renderer.setBackground(visuals.background);
    this.game.renderer.setBallTrail(visuals.ballTrail);
    this.game.renderer.setShockwave(visuals.shockwave);
    this.game.setEndSequenceConfig(visuals.endSequence);
    this.game.loadLevel(level);
    this.game.setAimLength(typeof level.aimLength === 'number' ? level.aimLength : 300);
    
    this.game.onGameEnd = (result, score) => {
      const endedGame = this.game;
      const bindDelayMs = endedGame?.getEndOverlayInteractDelayMs?.() ?? 1000;
      setTimeout(() => {
        if (!endedGame || this.game !== endedGame) return;

        // Update play count once the end overlay becomes interactable.
        level.metadata.playCount = (level.metadata.playCount || 0) + 1;
        this.levelManager.save();

        let fired = false;
        const guardedRestart = (event) => {
          if (fired) return;
          fired = true;
          if (event?.cancelable) event.preventDefault();
          if (typeof event?.stopPropagation === 'function') event.stopPropagation();
          this.canvas.removeEventListener('click', guardedRestart);
          this.canvas.removeEventListener('touchstart', guardedRestart);
          if (endedGame?.dismissEndOverlay) {
            endedGame.dismissEndOverlay(() => {
              if (this.game === endedGame && endedGame.handleRestart()) {
                this.startEditor();
              }
            });
            return;
          }
          if (this.game === endedGame && endedGame.handleRestart()) {
            this.startEditor();
          }
        };

        this.canvas.addEventListener('click', guardedRestart, { once: true });
        this.canvas.addEventListener('touchstart', guardedRestart, { once: true, passive: false });
      }, bindDelayMs);
    };

    this.game.start();

    // Ball counter + health bar: subscribe to game state
    this._unsubBallCounter = this.game.subscribeUiState((snapshot) => {
      if (snapshot.ballsLeft != null) {
        this.visualLayout.updateBallCounter(snapshot.ballsLeft, snapshot.initialBallCount);
      }
      if (Number.isFinite(snapshot.orangePegsLeft)) {
        this.visualLayout.updateHealthBar(snapshot.orangePegsLeft, snapshot.totalOrangePegs);
      }
      this.visualLayout.setBilliardTopLauncherActive?.(
        !!snapshot.billiardPhase && snapshot.billiardLauncherIndex === 0
      );
    });

    // Update UI
    document.getElementById('playBtn').innerHTML = '✏️';
    document.getElementById('playBtn').title = 'Back to Editor';
    document.querySelector('.toolbar').style.display = 'none';
    this.setSurvivalPanelVisible(false);
    this.setPvpPanelVisible(false);
    this.setBilliardPanelVisible(false);
    this.setDestructionPanelVisible(false);
    this.setAimLengthPanelVisible(false);
    this._applyLevelVisuals();
    this.visualLayout.setEditMode(false);
    this.visualLayout.setPanelVisible(false);
    if (this.adminPanel) this.adminPanel.classList.add('hidden');
    this.resizeCanvas(); // re-fit frame without panel
    this.mountGambleSystem();
    this._setPortraitControllerContextForCurrentLevel({ live: true });
    this._setDialogueControllerContextForCurrentLevel({ live: true, refreshPreview: false });
  }

  startPvpGame(level, pvpSettings) {
    normalizePvpAuthoredPegs(level, this.canvas.height);
    this.levelManager.save();

    this.mode = 'play';
    document.getElementById('playBtn').innerHTML = '✏️';
    document.getElementById('playBtn').title = 'Back to Editor';
    document.querySelector('.toolbar').style.display = 'none';
    this.setSurvivalPanelVisible(false);
    this.setPvpPanelVisible(false);
    this.setBilliardPanelVisible(false);
    this.setAimLengthPanelVisible(false);
    this.visualLayout.setPvpMode?.(true);
    this.visualLayout.setEditMode(false);
    this.visualLayout.setPanelVisible(false);
    if (this.adminPanel) this.adminPanel.classList.add('hidden');
    this._applyLevelVisuals();
    this.resizeCanvas();

    this.game = new PvpRuntime(this.canvas, {
      settings: pvpSettings,
      getTargetCircle: () => this.visualLayout.getCanvasSlotCircle?.('characterCircle', this.canvas),
      onVisualState: (state) => {
        if (!state) return;
        this.visualLayout.setPvpOpponentTarget?.({
          visible: true,
          hp: state.cpuHp,
          maxHp: state.maxHp || 3
        });
        this.visualLayout.setPvpAimTimer?.(
          state.timerVisible
            ? { visible: true, ratio: state.timerRatio }
            : null
        );
      },
      onGameEnd: (result, score) => {
        const endedGame = this.game;
        const bindDelayMs = endedGame?.getEndOverlayInteractDelayMs?.() ?? 650;
        setTimeout(() => {
          if (!endedGame || this.game !== endedGame) return;
          level.metadata.playCount = (level.metadata.playCount || 0) + 1;
          this.levelManager.save();

          let fired = false;
          const guardedRestart = (event) => {
            if (fired) return;
            fired = true;
            if (event?.cancelable) event.preventDefault();
            if (typeof event?.stopPropagation === 'function') event.stopPropagation();
            this.canvas.removeEventListener('click', guardedRestart);
            this.canvas.removeEventListener('touchstart', guardedRestart);
            if (endedGame?.dismissEndOverlay) {
              endedGame.dismissEndOverlay(() => {
                if (this.game === endedGame && endedGame.handleRestart()) {
                  this.startEditor();
                }
              });
              return;
            }
            if (this.game === endedGame && endedGame.handleRestart()) {
              this.startEditor();
            }
          };

          this.canvas.addEventListener('click', guardedRestart, { once: true });
          this.canvas.addEventListener('touchstart', guardedRestart, { once: true, passive: false });
        }, bindDelayMs);
      }
    });
    this.game.showPerfOverlay = true;
    this.game.renderer.onVerticalProgress = (progress) => {
      this.visualLayout.updateSurvivalProgressIndicator(progress);
    };

    const trajectoryToggle = document.getElementById('trajectoryToggle');
    this.game.setShowFullTrajectory?.(trajectoryToggle?.checked);
    this.resizeCanvas();

    const visuals = normalizeVisuals(level?.visuals);
    this.game.renderer.setBackground(visuals.background);
    this.game.renderer.setBallTrail(visuals.ballTrail);
    this.game.renderer.setShockwave(visuals.shockwave);
    this.game.loadLevel(level);
    this.game.setAimLength(pvpSettings.aimLength ?? PVP_DEFAULT_AIM_LENGTH);
    this.game.start();

    this._unsubBallCounter = this.game.subscribeUiState((snapshot) => {
      if (snapshot.ballsLeft != null) {
        this.visualLayout.updateBallCounter(snapshot.ballsLeft, snapshot.initialBallCount);
      }
      if (Number.isFinite(snapshot.orangePegsLeft)) {
        this.visualLayout.updateHealthBar(snapshot.orangePegsLeft, snapshot.totalOrangePegs);
      }
    });

    this.resizeCanvas();
    this._setPortraitControllerContextForCurrentLevel({ live: true });
    this._setDialogueControllerContextForCurrentLevel({ live: true, refreshPreview: false });
  }

  mountGambleSystem() {
    if (!this.game) return;
    const statusBar = document.querySelector('.status-bar');
    const pegCountEl = document.getElementById('pegCount');
    const selectionCountEl = document.getElementById('selectionCount');
    if (!statusBar || !pegCountEl || !selectionCountEl) return;

    this.gambleSystem = new GambleSystem({
      game: this.game,
      levelManager: this.levelManager,
      statusBar,
      pegCountEl,
      selectionCountEl,
      host: this.visualLayout.frame,
      visualLayout: this.visualLayout,
      onLayoutChange: () => this.resizeCanvas()
    });
    this.gambleSystem.mount();
    this.dialogueController.setGambleSystem(this.gambleSystem);
    this.portraitReactionController.setGambleSystem(this.gambleSystem);
  }

  teardownGambleSystem() {
    if (!this.gambleSystem) return;
    this.gambleSystem.dispose();
    this.gambleSystem = null;
    this.dialogueController.setGambleSystem(null);
    this.portraitReactionController.setGambleSystem(null);
  }

  handleGameRestart = () => {
    if (this.game && this.game.handleRestart()) {
      this.startEditor();
    }
  };

  _applyLevelVisuals() {
    const level = this.levelManager.getCurrentLevel();
    const rawVisuals = level?.visuals;
    const hasDefault = !!localStorage.getItem('peggle_visualDefaults');

    // Log source for debugging persistence
    if (rawVisuals && typeof rawVisuals === 'object' && rawVisuals.frameColor) {
      console.log('[visuals] Loading per-level visuals for', level.name, '| frameColor:', rawVisuals.frameColor);
    } else if (hasDefault) {
      console.log('[visuals] No per-level visuals, using saved default');
    } else {
      console.log('[visuals] No per-level visuals, no saved default — using system default');
    }

    const visuals = level ? normalizeVisuals(rawVisuals) : normalizeVisuals(null);
    this.visualLayout.setConfig(visuals);

    // Apply background to whatever renderer is active
    const renderer = this.game?.renderer || this.editor?.renderer;
    if (renderer) {
      renderer.setBackground(visuals.background);
      renderer.setBallTrail(visuals.ballTrail);
      renderer.setShockwave(visuals.shockwave);
    }
    this.game?.setEndSequenceConfig?.(visuals.endSequence);
    if (this.mode === 'editor') {
      this._showAssignedCharacterIdlePortrait(level);
    }
  }

  togglePlayMode() {
    if (this.mode === 'editor') {
      this.startGame();
    } else {
      this.startEditor();
    }
  }

  async bakeLevel() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || level.pegs.length === 0) {
      alert('Add some pegs first!');
      return;
    }

    const snapshot = await this._cloneLevelSnapshotForStorage(level);
    if (!snapshot) {
      alert('Failed to bake level snapshot.');
      return;
    }

    // Store in localStorage as local cache
    const safeName = (snapshot.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
    this._writeBakedLevelSnapshot(safeName, snapshot);

    // Persist to remote KV
    this._saveBakedLevelRemote(safeName, snapshot).then(ok => {
      if (ok) console.log('[bake] Synced to remote:', safeName);
      else console.warn('[bake] Remote sync failed for:', safeName);
    });

    // Compress JSON → deflate → base64url → URL hash
    const json = JSON.stringify(snapshot);
    const encoded = new TextEncoder().encode(json);
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(encoded);
    writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());

    // Safe base64 encoding (no spread — avoids stack overflow on large arrays)
    let binary = '';
    for (let i = 0; i < compressed.length; i++) binary += String.fromCharCode(compressed[i]);
    const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    console.log(`[bake] JSON ${json.length} bytes → compressed ${compressed.length} → base64url ${b64.length}`);
    const url = 'player.html#' + b64;
    window.open(url, '_blank');
  }

  _resetThemeToDefault() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    if (!confirm('Reset theme/visuals to default? Pegs and gameplay are unchanged.')) return;
    level.visuals = normalizeVisuals(null, true);
    this.levelManager.save();
    this._applyLevelVisuals();
  }

  updateLevelTitle() {
    const level = this.levelManager.getCurrentLevel();
    document.getElementById('levelTitle').textContent = level ? level.name : 'No Level';
  }

  updateLevelSettings() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    document.getElementById('levelName').value = level.name;
    document.getElementById('levelDifficulty').value = level.difficulty || 1;
    const pvp = ensureLevelPvp(level);
    const aimVal = pvp.enabled
      ? (pvp.aimLength ?? PVP_DEFAULT_AIM_LENGTH)
      : (typeof level.aimLength === 'number' ? level.aimLength : 300);
    const aimSlider = document.getElementById('aimLengthSlider');
    const aimInput = document.getElementById('aimLengthInput');
    if (aimSlider) aimSlider.value = aimVal;
    if (aimInput) aimInput.value = aimVal;
    const hitClearSettings = normalizeLevelHitPegClearSettings(level);
    const hitClearSlider = document.getElementById('hitPegClearDelaySlider');
    const hitClearInput = document.getElementById('hitPegClearDelayInput');
    const hitClearToggle = document.getElementById('hitPegTimedClearToggle');
    if (hitClearToggle) hitClearToggle.checked = !!hitClearSettings.enabled;
    if (hitClearSlider) {
      hitClearSlider.value = Math.round(hitClearSettings.delayMs);
      hitClearSlider.disabled = !hitClearSettings.enabled;
    }
    if (hitClearInput) {
      hitClearInput.value = (Math.round(hitClearSettings.delayMs) / 1000).toFixed(1);
      hitClearInput.disabled = !hitClearSettings.enabled;
    }
    const yoyoSettings = normalizeYoyoSettings(level.yoyo);
    const yoyoToggle = document.getElementById('yoyoThreadToggle');
    if (yoyoToggle) {
      yoyoToggle.checked = !!yoyoSettings.enabled;
    }
    const yoyoDebugDragToggle = document.getElementById('yoyoDebugDragToggle');
    if (yoyoDebugDragToggle) {
      yoyoDebugDragToggle.checked = !!yoyoSettings.debugDrag;
    }

    const survival = ensureLevelSurvival(level, this.canvas.height);
    const minHeight = Math.round(this.canvas.height);
    document.getElementById('survivalModeToggle').checked = !!survival.enabled;
    const heightSlider = document.getElementById('survivalHeightSlider');
    const heightInput = document.getElementById('survivalHeightInput');
    heightSlider.min = String(minHeight);
    heightInput.min = String(minHeight);
    document.getElementById('survivalHeightSlider').value = Math.round(survival.worldHeight);
    heightInput.value = Math.round(survival.worldHeight);
    document.getElementById('survivalSpeedSlider').value = Math.round(survival.scrollSpeed);
    document.getElementById('survivalSpeedInput').value = Number(survival.scrollSpeed).toFixed(1);
    const loseLineSlider = document.getElementById('survivalLoseLineSlider');
    const loseLineInput = document.getElementById('survivalLoseLineInput');
    loseLineSlider.max = Math.max(8, Math.round(this.canvas.height - 8));
    loseLineSlider.value = Math.round(survival.loseLineY);
    loseLineInput.max = Math.max(8, Math.round(this.canvas.height - 8));
    loseLineInput.value = Math.round(survival.loseLineY);
    const antiCooldownSlider = document.getElementById('survivalAntiCooldownSlider');
    const antiCooldownInput = document.getElementById('survivalAntiCooldownInput');
    if (antiCooldownSlider) {
      antiCooldownSlider.value = Math.round(survival.antiCooldownMs || 0);
    }
    if (antiCooldownInput) {
      antiCooldownInput.value = (Math.round(survival.antiCooldownMs || 0) / 1000).toFixed(1);
    }
    const backgroundDarkenSlider = document.getElementById('survivalBackgroundDarkenSlider');
    const backgroundDarkenInput = document.getElementById('survivalBackgroundDarkenInput');
    const backgroundDarken = Math.round(((survival.background?.darken ?? 0.5) * 100));
    if (backgroundDarkenSlider) {
      backgroundDarkenSlider.value = String(backgroundDarken);
    }
    if (backgroundDarkenInput) {
      backgroundDarkenInput.value = String(backgroundDarken);
    }
    const curvePresetSelect = document.getElementById('survivalSpeedCurvePreset');
    if (curvePresetSelect) {
      curvePresetSelect.value = SURVIVAL_SPEED_CURVE_PRESETS[survival.speedCurve?.preset]
        ? survival.speedCurve.preset
        : 'custom';
    }
    this._drawSurvivalSpeedCurveEditor(survival.speedCurve);
    this._updateSurvivalBackgroundStatus(survival);
    this._setSurvivalSettingsVisible(!!survival.enabled);

    const pvpToggle = document.getElementById('pvpModeToggle');
    const pvpSymmetryToggle = document.getElementById('pvpSymmetryToggle');
    const pvpCpuToggle = document.getElementById('pvpCpuToggle');
    const pvpTimerSlider = document.getElementById('pvpAimTimerSlider');
    const pvpTimerInput = document.getElementById('pvpAimTimerInput');
    const pvpDifficultySelect = document.getElementById('pvpDifficultySelect');
    if (pvpToggle) pvpToggle.checked = !!pvp.enabled;
    if (pvpSymmetryToggle) pvpSymmetryToggle.checked = !!pvp.symmetryEnabled;
    if (pvpCpuToggle) pvpCpuToggle.checked = !!pvp.cpuEnabled;
    if (pvpTimerSlider) pvpTimerSlider.value = Math.round(pvp.aimTimerMs);
    if (pvpTimerInput) pvpTimerInput.value = (Math.round(pvp.aimTimerMs) / 1000).toFixed(2).replace(/\.00$/, '');
    if (pvpDifficultySelect) pvpDifficultySelect.value = pvp.cpuDifficulty;
    if (aimSlider) aimSlider.value = aimVal;
    if (aimInput) aimInput.value = aimVal;
    this._setPvpSettingsVisible(!!pvp.enabled);

    const billiard = ensureLevelBilliard(level);
    const billiardToggle = document.getElementById('billiardModeToggle');
    const billiardAttractionSlider = document.getElementById('billiardAttractionSlider');
    const billiardAttractionInput = document.getElementById('billiardAttractionInput');
    const billiardWallBounceAimToggle = document.getElementById('billiardWallBounceAimToggle');
    const billiardPvpBounceToggle = document.getElementById('billiardPvpBounceToggle');
    const billiardFixedMainBallsToggle = document.getElementById('billiardFixedMainBallsToggle');
    const billiardMainBallPenaltySlider = document.getElementById('billiardMainBallPenaltySlider');
    const billiardMainBallPenaltyInput = document.getElementById('billiardMainBallPenaltyInput');
    if (billiardToggle) billiardToggle.checked = !!billiard.enabled;
    if (billiardAttractionSlider) billiardAttractionSlider.value = Math.round(billiard.attractionRadius);
    if (billiardAttractionInput) billiardAttractionInput.value = Math.round(billiard.attractionRadius);
    if (billiardWallBounceAimToggle) billiardWallBounceAimToggle.checked = billiard.wallBounceAim !== false;
    if (billiardPvpBounceToggle) billiardPvpBounceToggle.checked = billiard.pvpBounce === true;
    if (billiardFixedMainBallsToggle) billiardFixedMainBallsToggle.checked = billiard.fixedMainBalls === true;
    if (billiardMainBallPenaltySlider) {
      billiardMainBallPenaltySlider.value = Math.round(billiard.mainBallPenalty);
      billiardMainBallPenaltySlider.disabled = billiard.fixedMainBalls === true;
    }
    if (billiardMainBallPenaltyInput) {
      billiardMainBallPenaltyInput.value = Math.round(billiard.mainBallPenalty);
      billiardMainBallPenaltyInput.disabled = billiard.fixedMainBalls === true;
    }
    this._setBilliardSettingsVisible(!!billiard.enabled);

    const destruction = ensureLevelDestruction(level);
    const destructionToggle = document.getElementById('destructionModeToggle');
    const destructionGravityYSlider = document.getElementById('destructionGravityYSlider');
    const destructionGravityYInput = document.getElementById('destructionGravityYInput');
    const destructionGravityXSlider = document.getElementById('destructionGravityXSlider');
    const destructionGravityXInput = document.getElementById('destructionGravityXInput');
    const destructionBounceSlider = document.getElementById('destructionBounceSlider');
    const destructionBounceInput = document.getElementById('destructionBounceInput');
    const destructionBallBounceSlider = document.getElementById('destructionBallBounceSlider');
    const destructionBallBounceInput = document.getElementById('destructionBallBounceInput');
    const destructionBombSlider = document.getElementById('destructionBombSlider');
    const destructionBombInput = document.getElementById('destructionBombInput');
    const destructionGripSlider = document.getElementById('destructionGripSlider');
    const destructionGripInput = document.getElementById('destructionGripInput');
    const destructionPileClearSlider = document.getElementById('destructionPileClearSlider');
    const destructionPileClearInput = document.getElementById('destructionPileClearInput');
    const fmtDestruction = (value, digits = 2) => Number(value).toFixed(digits).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    if (destructionToggle) destructionToggle.checked = !!destruction.enabled;
    if (destructionGravityYSlider) destructionGravityYSlider.value = Math.round(destruction.gravityY * 100);
    if (destructionGravityYInput) destructionGravityYInput.value = fmtDestruction(destruction.gravityY);
    if (destructionGravityXSlider) destructionGravityXSlider.value = Math.round(destruction.gravityX * 100);
    if (destructionGravityXInput) destructionGravityXInput.value = fmtDestruction(destruction.gravityX);
    if (destructionBounceSlider) destructionBounceSlider.value = Math.round(destruction.restitution * 100);
    if (destructionBounceInput) destructionBounceInput.value = fmtDestruction(destruction.restitution);
    if (destructionBallBounceSlider) destructionBallBounceSlider.value = Math.round(destruction.dynamicPegBallBounce * 100);
    if (destructionBallBounceInput) destructionBallBounceInput.value = fmtDestruction(destruction.dynamicPegBallBounce);
    if (destructionBombSlider) destructionBombSlider.value = Math.round(destruction.bombImpulse);
    if (destructionBombInput) destructionBombInput.value = fmtDestruction(destruction.bombImpulse, 1);
    if (destructionGripSlider) destructionGripSlider.value = Math.round(destruction.surfaceGrip * 100);
    if (destructionGripInput) destructionGripInput.value = fmtDestruction(destruction.surfaceGrip);
    if (destructionPileClearSlider) destructionPileClearSlider.value = Math.round(destruction.stuckPileClearDelayMs);
    if (destructionPileClearInput) destructionPileClearInput.value = fmtDestruction(destruction.stuckPileClearDelayMs / 1000);
    this._setDestructionSettingsVisible(!!destruction.enabled);
    
    const isInTraining = this.levelManager.isInTraining(level.id);
    document.getElementById('addToTrainingBtn').textContent = isInTraining ? 'Remove from Training' : 'Add to Training';

    this.dialogueController.setConfig(level.dialogue);
    if (this.mode === 'editor') {
      if (document.getElementById('dialogueOverlay')?.classList.contains('visible')) {
        this._renderDialogueEditor();
      }
      this._refreshDialoguePreviewFromState();
    }
  }

  newLevel() {
    const name = `Level ${this.levelManager.getLevelCount() + 1}`;
    this.levelManager.createLevel(name);
    this.updateLevelTitle();
    this.updateLevelSettings();
    this.applySurvivalSettingsToEditor();
    this.applyPvpSettingsToEditor();
    
    if (this.mode === 'editor' && this.editor) {
      this.editor.selectedPegIds.clear();
      this._dialogueSelectedEntryId = null;
      this._dialoguePreviewState = null;
      this._setDialogueControllerContextForCurrentLevel({ live: false, refreshPreview: true });
    }
  }

  showLevelList() {
    this.closeCampaignList();
    this.closeCampaignEditor();
    this.closePvpDuelLevels();
    this.closeCharacterEditor();
    this.closeDialogueEditor();
    const levels = this.levelManager.getAllLevels();
    const list = document.getElementById('levelItems');
    list.innerHTML = '';

    levels.forEach((level, index) => {
      const item = document.createElement('div');
      item.className = 'level-item';
      if (index === this.levelManager.currentLevelIndex) {
        item.classList.add('active');
      }

      const isTraining = this.levelManager.isInTraining(level.id);
      
      item.innerHTML = `
        <div class="level-item-info">
          <span class="level-item-name">${this._esc(level.name || 'Untitled')}</span>
          <span class="level-item-meta">
            ${level.pegs.length} pegs · Difficulty ${level.difficulty || 1}
            ${isTraining ? ' · 📊' : ''}
          </span>
        </div>
        <div class="level-item-actions">
          <button class="level-action-btn duplicate-btn" title="Duplicate">📋</button>
          <button class="level-action-btn delete-btn" title="Delete">🗑️</button>
        </div>
      `;

      item.querySelector('.level-item-info').addEventListener('click', () => {
        this.levelManager.setCurrentLevel(index);
        this.updateLevelTitle();
        if (this.mode === 'editor') {
          this.startEditor();
        }
        this.closeLevelList();
      });

      item.querySelector('.duplicate-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.levelManager.duplicateLevel(level.id);
        this.showLevelList();
      });

      item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (levels.length === 1) {
          alert('Cannot delete the last level');
          return;
        }
        if (confirm(`Delete "${level.name}"?`)) {
          this.levelManager.deleteLevel(level.id);
          this.updateLevelTitle();
          if (this.mode === 'editor') {
            this.startEditor();
          }
          this.showLevelList();
        }
      });

      list.appendChild(item);
    });

    this._positionEditorSideSheets();
    document.getElementById('levelListOverlay').classList.add('visible');
  }

  closeLevelList() {
    document.getElementById('levelListOverlay').classList.remove('visible');
  }

  _showAssignedCharacterIdlePortrait(level = this.levelManager.getCurrentLevel()) {
    if (!level || !this.visualLayout) return;
    const character = this._resolveLevelCharacter(level);
    const src = getCharacterSlotSource(character, 'idle');
    this.visualLayout.setCharacterPortraitSource(src, { fadeMs: 0, slotName: 'idle' });
  }

  _resolveLevelCharacter(level = this.levelManager.getCurrentLevel()) {
    this.characterRegistry = normalizeCharacterRegistry(this.characterRegistry);
    return resolveCharacterForLevel(level, this.characterRegistry);
  }

  _setPortraitControllerContextForCurrentLevel(options = {}) {
    const level = this.levelManager.getCurrentLevel();
    const live = !!options.live;
    if (!level) {
      this.portraitReactionController.dispose();
      return;
    }
    if (!live || !this.game) {
      this.portraitReactionController.setContext({
        level,
        registry: this.characterRegistry,
        game: null,
        gambleSystem: null,
        scopeKey: `editor:${level.id}`,
        paused: false
      });
      return;
    }
    this.portraitReactionController.setContext({
      level,
      registry: this.characterRegistry,
      game: this.game,
      gambleSystem: this.gambleSystem,
      scopeKey: level ? `editor:${level.id}` : 'editor',
      paused: false
    });
  }

  _saveCharacterRegistry(registry = this.characterRegistry, { syncRemote = true } = {}) {
    this.characterRegistry = saveCharacterRegistry(registry);
    if (syncRemote) this._scheduleCharacterRegistryRemoteSync();
    return this.characterRegistry;
  }

  _scheduleCharacterRegistryRemoteSync() {
    if (this._characterRegistrySyncTimer) clearTimeout(this._characterRegistrySyncTimer);
    this._characterRegistrySyncTimer = setTimeout(() => {
      this._characterRegistrySyncTimer = null;
      this._pendingCharacterRegistrySync = this._pushCharacterRegistryToServer(null, { silent: true })
        .finally(() => {
          this._pendingCharacterRegistrySync = null;
        });
    }, 1500);
  }

  async _pushCharacterRegistryToServer(button = null, { silent = false } = {}) {
    const registry = normalizeCharacterRegistry(this.characterRegistry);
    let originalLabel = '';
    if (button) {
      originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Pushing...';
    }
    try {
      const ok = await api.saveCharacterRegistry(registry);
      if (button) {
        button.textContent = ok ? 'Pushed ✓' : 'Push failed';
        if (!ok) button.title = 'Server rejected the push or the network is unavailable.';
      }
      if (!ok) {
        if (!silent) alert('Failed to push character registry to server.');
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[characters] push failed', error);
      if (button) button.textContent = 'Push failed';
      if (!silent) alert('Failed to push character registry: ' + (error?.message || error));
      return false;
    } finally {
      if (button) {
        setTimeout(() => {
          button.disabled = false;
          button.textContent = originalLabel || 'Push to Server';
        }, 1400);
      }
    }
  }

  async _pullCharacterRegistryFromServer(button = null, { silent = false } = {}) {
    let originalLabel = '';
    if (button) {
      originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Pulling...';
    }
    try {
      const remote = await api.getCharacterRegistry();
      if (!remote) {
        if (button) button.textContent = 'Nothing on server';
        if (!silent) alert('No character registry stored on the server yet. Push from a populated localhost first.');
        return false;
      }
      if (!silent) {
        const local = normalizeCharacterRegistry(this.characterRegistry);
        const localCount = Object.keys(local.characters || {}).length;
        const localHasUserData = this._characterRegistryHasUserData(local);
        if (localHasUserData) {
          const remoteCount = Object.keys(remote.characters || {}).length;
          const ok = confirm(
            `Replace local characters with the server version?\n\n`
            + `Local: ${localCount} character(s)${localHasUserData ? ' with custom data' : ''}\n`
            + `Server: ${remoteCount} character(s)\n\n`
            + `This will overwrite all local character data.`
          );
          if (!ok) return false;
        }
      }
      const normalized = normalizeCharacterRegistry(remote);
      this._saveCharacterRegistry(normalized, { syncRemote: false });
      this._selectedCharacterEditorId = normalized.selectedId;
      this._renderCharacterEditor();
      if (button) button.textContent = 'Pulled ✓';
      return true;
    } catch (error) {
      console.warn('[characters] pull failed', error);
      if (button) button.textContent = 'Pull failed';
      if (!silent) alert('Failed to pull character registry: ' + (error?.message || error));
      return false;
    } finally {
      if (button) {
        setTimeout(() => {
          button.disabled = false;
          button.textContent = originalLabel || 'Pull from Server';
        }, 1400);
      }
    }
  }

  // True iff the registry holds any character beyond a pristine default.
  _characterRegistryHasUserData(registry) {
    if (!registry || !registry.characters) return false;
    const ids = Object.keys(registry.characters);
    if (ids.length === 0) return false;
    if (ids.length > 1) return true;
    if (ids[0] !== DEFAULT_CHARACTER_ID) return true;
    const defaultCharacter = registry.characters[DEFAULT_CHARACTER_ID];
    if (!defaultCharacter) return false;
    if (defaultCharacter.name && defaultCharacter.name !== 'Lu' && defaultCharacter.name !== DEFAULT_CHARACTER_ID) return true;
    const slots = defaultCharacter.slots || {};
    for (const [slotName, value] of Object.entries(slots)) {
      if (slotName === 'idle') continue;
      if (Array.isArray(value)) {
        if (value.some(v => typeof v === 'string' && v.trim())) return true;
      } else if (typeof value === 'string' && value.trim()) {
        return true;
      }
    }
    return false;
  }

  _updateCurrentLevelCharacter(mutator, options = {}) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return null;
    const assignment = normalizeLevelCharacterAssignment(level.character);
    if (mutator(assignment) === false) return null;
    level.character = normalizeLevelCharacterAssignment(assignment);
    attachCharacterSnapshotToLevel(level, this.characterRegistry);
    if (level.metadata) level.metadata.modified = new Date().toISOString();
    this.levelManager.save();
    if (this.mode === 'play') {
      this._setPortraitControllerContextForCurrentLevel({ live: true });
    } else {
      this._showAssignedCharacterIdlePortrait(level);
    }
    if (options.rerender !== false && document.getElementById('characterOverlay')?.classList.contains('visible')) {
      this._renderCharacterEditor();
    }
    return level.character;
  }

  _refreshCurrentLevelForCharacterChange(characterId) {
    const level = this.levelManager.getCurrentLevel();
    const id = makeCharacterId(characterId);
    if (normalizeLevelCharacterAssignment(level?.character).characterId !== id) return;
    if (this.mode === 'play') {
      this._setPortraitControllerContextForCurrentLevel({ live: true });
    } else {
      this._showAssignedCharacterIdlePortrait(level);
    }
  }

  _replaceAssignedCharacterIdAcrossLevels(previousId, nextId) {
    const oldId = makeCharacterId(previousId);
    const replacementId = makeCharacterId(nextId, oldId);
    const levels = typeof this.levelManager.getAllLevels === 'function'
      ? this.levelManager.getAllLevels()
      : [];
    let touched = false;
    for (const level of levels) {
      const assignment = normalizeLevelCharacterAssignment(level?.character);
      if (assignment.characterId !== oldId) continue;
      assignment.characterId = replacementId;
      level.character = normalizeLevelCharacterAssignment(assignment);
      attachCharacterSnapshotToLevel(level, this.characterRegistry);
      if (level.metadata) level.metadata.modified = new Date().toISOString();
      touched = true;
    }
    if (touched) this.levelManager.save();
    return touched;
  }

  showCharacterEditor() {
    this.closeLevelList();
    this.closeCampaignList();
    this.closeCampaignEditor();
    this.closePvpDuelLevels();
    this.closePhysicsSettings();
    this.closeDialogueEditor();
    this.characterRegistry = loadCharacterRegistry();
    const selectedId = makeCharacterId(this._selectedCharacterEditorId || this.characterRegistry.selectedId || DEFAULT_CHARACTER_ID);
    this._selectedCharacterEditorId = this.characterRegistry.characters[selectedId] ? selectedId : this.characterRegistry.selectedId;
    this._renderCharacterEditor();
    document.getElementById('characterOverlay')?.classList.add('visible');
    this._positionEditorSideSheets();

    // Auto-pull on first open of this session if local has nothing custom yet.
    // Avoids losing the localhost-built character when first opening the editor
    // on production, but never overwrites user-entered local data.
    if (!this._characterRegistryAutoPulled) {
      this._characterRegistryAutoPulled = true;
      if (!this._characterRegistryHasUserData(this.characterRegistry)) {
        this._pullCharacterRegistryFromServer(null, { silent: true });
      }
    }
  }

  closeCharacterEditor() {
    document.getElementById('characterOverlay')?.classList.remove('visible');
  }

  _addCharacter() {
    const registry = normalizeCharacterRegistry(this.characterRegistry);
    let index = Object.keys(registry.characters).length + 1;
    let id = `character-${index}`;
    while (registry.characters[id]) {
      index++;
      id = `character-${index}`;
    }
    registry.characters[id] = normalizeCharacter({
      ...createDefaultCharacter({ id, name: `Character ${index}` }),
      id,
      name: `Character ${index}`
    });
    registry.selectedId = id;
    this._selectedCharacterEditorId = id;
    this._saveCharacterRegistry(registry);
    this._renderCharacterEditor();
  }

  _slotLabel(slot) {
    return formatCharacterLabel(slot);
  }

  _eventLabel(eventType) {
    return CHARACTER_EVENT_META[eventType]?.label || formatCharacterLabel(eventType);
  }

  _getCharacterSlotList(character, { authoredOnly = false } = {}) {
    const personality = normalizePersonality(character?.personality);
    const slots = new Set([
      ...CANONICAL_EMOTION_SLOTS,
      ...Object.keys(character?.slots || {}),
      ...Object.keys(personality.decayRates || {}),
      personality.baseline?.slot,
      personality.boredom?.slot,
      ...Object.keys(personality.ambient?.distribution || {}),
      ...Object.keys(personality.pressure?.distribution || {}),
      ...Object.values(personality.escalation || {})
    ].filter(Boolean));
    for (const row of Object.values(personality.impulseTable || {})) {
      for (const slot of Object.keys(row.distribution || {})) slots.add(slot);
      if (row.escalationSlot) slots.add(row.escalationSlot);
    }
    const ordered = [
      ...CANONICAL_EMOTION_SLOTS.filter(slot => slots.has(slot)),
      ...Array.from(slots).filter(slot => !CANONICAL_EMOTION_SLOTS.includes(slot)).sort()
    ];
    if (!authoredOnly) return ordered;
    const authored = ordered.filter(slot => {
      const value = character?.slots?.[slot];
      if (Array.isArray(value)) return value.some(item => typeof item === 'string' && item.trim());
      return typeof value === 'string' && value.trim();
    });
    return authored.length ? authored : ['idle'];
  }

  _getCharacterEventTypes(personality) {
    const events = new Set([
      ...Object.keys(DEFAULT_PERSONALITY.impulseTable || {}),
      ...Object.keys(personality?.impulseTable || {})
    ]);
    return Array.from(events).filter(eventType => !CHARACTER_EVENT_UI_HIDDEN.has(eventType)).sort((a, b) => {
      const groupA = CHARACTER_EVENT_META[a]?.group || 'Z';
      const groupB = CHARACTER_EVENT_META[b]?.group || 'Z';
      if (groupA !== groupB) return groupA.localeCompare(groupB);
      return this._eventLabel(a).localeCompare(this._eventLabel(b));
    });
  }

  _renderSlotOptions(slots, selectedSlot) {
    return slots.map(slot => `
      <option value="${this._esc(slot)}"${slot === selectedSlot ? ' selected' : ''}>${this._esc(this._slotLabel(slot))}</option>
    `).join('');
  }

  _distributionPercent(distribution, slot) {
    const value = Number(distribution?.[slot]);
    return Math.max(0, Math.min(100, Math.round((Number.isFinite(value) ? value : 0) * 100)));
  }

  _renderCharacterSlider({ path, control, value, scope = 'character', disabled = false, inherited = null }) {
    const key = pathKey(path);
    const n = Number(value);
    const safeValue = Number.isFinite(n) ? n : control.min;
    const dataAttr = scope === 'level' ? 'data-level-number' : 'data-character-number';
    const inheritedHtml = inherited == null ? '' : `<span class="character-inherited">Inherited ${this._esc(formatTuningValue(inherited, control))}</span>`;
    return `
      <label class="character-tune-row${disabled ? ' is-disabled' : ''}">
        <span class="character-tune-head">
          <span class="character-tune-label">${this._esc(control.label)}</span>
          <span class="character-tune-value" data-character-value-for="${this._esc(key)}">${this._esc(formatTuningValue(safeValue, control))}</span>
        </span>
        ${inheritedHtml}
        <input class="character-range" type="range" min="${control.min}" max="${control.max}" step="${control.step}" value="${safeValue}" ${dataAttr}="${this._esc(key)}"${disabled ? ' disabled' : ''}>
      </label>
    `;
  }

  _renderCharacterSelect({ path, label, slots, value, scope = 'character', disabled = false, inherited = null }) {
    const key = pathKey(path);
    const dataAttr = scope === 'level' ? 'data-level-select' : 'data-character-select';
    const inheritedHtml = inherited == null ? '' : `<span class="character-inherited">Inherited ${this._esc(this._slotLabel(inherited))}</span>`;
    return `
      <label class="character-tune-row${disabled ? ' is-disabled' : ''}">
        <span class="character-tune-head">
          <span class="character-tune-label">${this._esc(label)}</span>
        </span>
        ${inheritedHtml}
        <select class="dialogue-field-select" ${dataAttr}="${this._esc(key)}"${disabled ? ' disabled' : ''}>
          ${this._renderSlotOptions(slots, value)}
        </select>
      </label>
    `;
  }

  _renderDistributionWeights({ distribution, slots, scope = 'character', pathPrefix, disabled = false }) {
    const dataAttr = scope === 'level' ? 'data-level-weight' : 'data-character-weight';
    return `
      <div class="character-weight-grid${disabled ? ' is-disabled' : ''}">
        ${slots.map(slot => {
          const path = [...pathPrefix, slot];
          const key = pathKey(path);
          const percent = this._distributionPercent(distribution, slot);
          return `
            <label class="character-weight-row">
              <span>${this._esc(this._slotLabel(slot))}</span>
              <input class="character-range" type="range" min="0" max="100" step="1" value="${percent}" ${dataAttr}="${this._esc(key)}"${disabled ? ' disabled' : ''}>
              <b data-character-value-for="${this._esc(key)}">${percent}%</b>
            </label>
          `;
        }).join('')}
      </div>
    `;
  }

  _renderOverrideSlider({ path, control, basePersonality, patch }) {
    const active = getPathValue(patch, path) !== undefined;
    const inherited = getPathValue(basePersonality, path);
    const value = active ? getPathValue(patch, path) : inherited;
    const key = pathKey(path);
    const comment = characterOverrideComment(path, control.label);
    return `
      <div class="character-override-item">
        <label class="character-override-toggle">
          <input type="checkbox" data-level-toggle="${this._esc(key)}" data-level-toggle-kind="number" data-level-inherited="${this._esc(JSON.stringify(inherited))}"${active ? ' checked' : ''}>
          <span><b>${this._esc(control.label)}</b><small>${this._esc(comment)}</small></span>
        </label>
        ${this._renderCharacterSlider({ path, control, value, scope: 'level', disabled: !active, inherited })}
      </div>
    `;
  }

  _renderOverrideSelect({ path, label, slots, basePersonality, patch }) {
    const active = getPathValue(patch, path) !== undefined;
    const inherited = getPathValue(basePersonality, path);
    const value = active ? getPathValue(patch, path) : inherited;
    const key = pathKey(path);
    const comment = characterOverrideComment(path, label);
    return `
      <div class="character-override-item">
        <label class="character-override-toggle">
          <input type="checkbox" data-level-toggle="${this._esc(key)}" data-level-toggle-kind="string" data-level-inherited="${this._esc(JSON.stringify(inherited))}"${active ? ' checked' : ''}>
          <span><b>${this._esc(label)}</b><small>${this._esc(comment)}</small></span>
        </label>
        ${this._renderCharacterSelect({ path, label, slots, value, scope: 'level', disabled: !active, inherited })}
      </div>
    `;
  }

  _renderExpressionGrid(character, slotNames) {
    return `
      <div class="character-expression-grid">
        ${slotNames.map(slot => {
          const sources = getCharacterSlotSources(character, slot);
          const hasImage = sources.length > 0;
          const variantIndex = hasImage ? this._getExpressionVariantIndex(character.id, slot, sources.length) : 0;
          const currentSrc = hasImage ? sources[variantIndex] : '';
          const isIdle = slot === 'idle';
          const canPreview = !isIdle && hasImage;
          const multi = sources.length > 1;
          const counterLabel = hasImage
            ? `${variantIndex + 1}/${sources.length}${sources.length > 1 ? ' · random' : ''}`
            : '';
          const stateLabel = hasImage
            ? (sources.length > 1 ? `${sources.length} variants · random in play` : 'Ready')
            : 'Uses composed image';
          return `
            <div class="character-expression-card" data-character-slot="${this._esc(slot)}">
              <div class="character-expression-stage">
                <div class="character-expression-thumb"${currentSrc ? ` style="background-image:url('${this._esc(currentSrc)}')"` : ''}></div>
                ${multi ? `
                  <button class="character-variant-arrow character-variant-arrow--prev" type="button" data-character-variant-prev="${this._esc(slot)}" title="Previous image">‹</button>
                  <button class="character-variant-arrow character-variant-arrow--next" type="button" data-character-variant-next="${this._esc(slot)}" title="Next image">›</button>
                ` : ''}
                ${hasImage && multi ? `<div class="character-variant-counter">${this._esc(counterLabel)}</div>` : ''}
              </div>
              <div class="character-expression-title">${this._esc(this._slotLabel(slot))}</div>
              <div class="character-expression-key">${this._esc(slot)}</div>
              <div class="character-expression-state">${this._esc(stateLabel)}</div>
              <div class="character-expression-actions">
                <button class="dialogue-chip-btn" type="button" data-character-upload-slot="${this._esc(slot)}">${hasImage ? 'Add image' : 'Upload'}</button>
                ${isIdle ? '' : `<button class="dialogue-preview-btn" type="button" data-character-preview-slot="${this._esc(slot)}"${canPreview ? '' : ' disabled'}>Preview</button>`}
                <button class="dialogue-icon-btn dialogue-icon-btn--danger" type="button" title="${multi ? 'Remove this image' : 'Clear expression'}" data-character-clear-slot="${this._esc(slot)}">×</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  _expressionVariantKey(characterId, slot) {
    return `${characterId}::${slot}`;
  }

  _getExpressionVariantIndex(characterId, slot, length) {
    if (!length || length <= 0) return 0;
    const key = this._expressionVariantKey(characterId, slot);
    const stored = Number(this._expressionVariantIndex?.get?.(key));
    if (!Number.isFinite(stored) || stored < 0) return 0;
    return stored % length;
  }

  _setExpressionVariantIndex(characterId, slot, index) {
    if (!this._expressionVariantIndex) this._expressionVariantIndex = new Map();
    this._expressionVariantIndex.set(this._expressionVariantKey(characterId, slot), Math.max(0, Math.floor(Number(index) || 0)));
  }

  _cycleExpressionVariant(characterId, slot, delta) {
    const registry = normalizeCharacterRegistry(this.characterRegistry);
    const character = registry.characters[makeCharacterId(characterId)];
    if (!character) return;
    const sources = getCharacterSlotSources(character, slot);
    if (sources.length <= 1) return;
    const current = this._getExpressionVariantIndex(character.id, slot, sources.length);
    const next = ((current + delta) % sources.length + sources.length) % sources.length;
    this._setExpressionVariantIndex(character.id, slot, next);
    this._renderCharacterEditor();
  }

  _renderCharacterRestingPanel(character, slots) {
    const personality = normalizePersonality(character.personality);
    return `
      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Resting Mood</div>
        ${this._renderCharacterSelect({ path: ['baseline', 'slot'], label: 'Default expression', slots, value: personality.baseline.slot })}
        ${CHARACTER_RESTING_CONTROLS.map(control => this._renderCharacterSlider({
          path: control.path,
          control,
          value: getPathValue(personality, control.path)
        })).join('')}
        ${this._renderCharacterSelect({ path: ['boredom', 'slot'], label: 'Quiet mood expression', slots, value: personality.boredom.slot })}
        <div class="character-mini-heading">Expression return speeds</div>
        ${slots.map(slot => this._renderCharacterSlider({
          path: ['decayRates', slot],
          control: { label: this._slotLabel(slot), min: 0, max: 1.4, step: 0.01 },
          value: personality.decayRates?.[slot] ?? 0.3
        })).join('')}
      </div>
    `;
  }

  _renderCharacterEventsPanel(character, slots) {
    const personality = normalizePersonality(character.personality);
    const eventTypes = this._getCharacterEventTypes(personality);
    return `
      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Reaction Events</div>
        <div class="character-event-list">
          ${eventTypes.map(eventType => {
            const row = personality.impulseTable[eventType] || { magnitude: 0.3, distribution: { idle: 1 } };
            return `
              <div class="character-event-card">
                <div class="character-event-title">
                  <span>${this._esc(this._eventLabel(eventType))}</span>
                  <small>${this._esc(CHARACTER_EVENT_META[eventType]?.group || 'Custom')}</small>
                </div>
                ${this._renderCharacterSlider({
                  path: ['impulseTable', eventType, 'magnitude'],
                  control: { label: 'Reaction strength', min: 0, max: 2, step: 0.05 },
                  value: row.magnitude
                })}
                <div class="character-mini-heading">Expression chances</div>
                ${this._renderDistributionWeights({
                  distribution: row.distribution,
                  slots,
                  pathPrefix: ['impulseTable', eventType, 'distribution']
                })}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  _renderCharacterTimingPanel(character) {
    const personality = normalizePersonality(character.personality);
    return `
      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Character Timing</div>
        ${CHARACTER_SCALAR_CONTROLS.map(control => this._renderCharacterSlider({
          path: control.path,
          control,
          value: getPathValue(personality, control.path)
        })).join('')}
        <label class="character-tune-row">
          <span class="character-tune-head">
            <span class="character-tune-label">Combo milestones</span>
            <span class="character-tune-value">${this._esc((personality.streakThresholds || []).join(', '))}</span>
          </span>
          <input class="dialogue-field-input" type="text" value="${this._esc((personality.streakThresholds || []).join(', '))}" placeholder="3, 6, 10" data-character-streaks>
        </label>
      </div>
    `;
  }

  _renderCharacterAmbientPanel(character, slots) {
    const personality = normalizePersonality(character.personality);
    return `
      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Ambient / Pause</div>
        ${CHARACTER_AMBIENT_CONTROLS.map(control => this._renderCharacterSlider({
          path: control.path,
          control,
          value: getPathValue(personality, control.path)
        })).join('')}
        <div class="character-mini-heading">Calm expression chances</div>
        ${this._renderDistributionWeights({
          distribution: personality.ambient.distribution,
          slots,
          pathPrefix: ['ambient', 'distribution']
        })}
      </div>
    `;
  }

  _renderCharacterEscalationPanel(character, slots) {
    const personality = normalizePersonality(character.personality);
    return `
      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Repeat Variety</div>
        <div class="character-escalation-grid">
          ${slots.map(slot => `
            <label class="character-tune-row">
              <span class="character-tune-head">
                <span class="character-tune-label">${this._esc(this._slotLabel(slot))} repeats into</span>
              </span>
              <select class="dialogue-field-select" data-character-select="${this._esc(pathKey(['escalation', slot]))}">
                ${this._renderSlotOptions(slots, personality.escalation?.[slot] || slot)}
              </select>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  _renderLevelOverridesPanel(level, registry, slots = null) {
    const assignment = normalizeLevelCharacterAssignment(level?.character);
    const assignedBase = normalizeCharacter(
      registry.characters[assignment.characterId]
      || assignment.snapshot
      || registry.characters[DEFAULT_CHARACTER_ID]
      || createDefaultCharacter()
    );
    slots = this._getCharacterSlotList(assignedBase, { authoredOnly: true });
    const basePersonality = normalizePersonality(assignedBase.personality);
    const patch = normalizePersonalityPatch(assignment.personalityPatch || {});
    const patchedPersonality = mergePersonalityPatch(basePersonality, patch);
    const overrideCount = countPersonalityPatchFields(patch);
    const eventTypes = this._getCharacterEventTypes(patchedPersonality);

    return `
      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Level Character</div>
        <label class="dialogue-field">
          <span class="dialogue-field-label">Character for this level</span>
          <select id="levelCharacterSelect" class="dialogue-field-select">
            ${Object.keys(registry.characters).sort().map(id => `
              <option value="${this._esc(id)}"${id === assignment.characterId ? ' selected' : ''}>${this._esc(registry.characters[id]?.name || id)} (${this._esc(id)})</option>
            `).join('')}
          </select>
        </label>
        <div class="character-override-summary">${overrideCount} level override${overrideCount === 1 ? '' : 's'} active</div>
        <div class="character-override-help">This level is linked to the saved character above. Switch a row on only when this level needs its own exception.</div>
        ${this._renderOverrideSelect({ path: ['baseline', 'slot'], label: 'Default expression', slots, basePersonality, patch })}
        ${this._renderOverrideSlider({ path: ['baseline', 'target'], control: CHARACTER_RESTING_CONTROLS[0], basePersonality, patch })}
        ${this._renderOverrideSlider({ path: ['baseline', 'rate'], control: CHARACTER_RESTING_CONTROLS[1], basePersonality, patch })}
        ${this._renderOverrideSelect({ path: ['boredom', 'slot'], label: 'Quiet mood expression', slots, basePersonality, patch })}
        ${this._renderOverrideSlider({ path: ['boredom', 'afterMs'], control: CHARACTER_RESTING_CONTROLS[2], basePersonality, patch })}
        ${this._renderOverrideSlider({ path: ['boredom', 'magnitudePerSecond'], control: CHARACTER_RESTING_CONTROLS[3], basePersonality, patch })}
        <div class="character-mini-heading">Timing overrides</div>
        ${CHARACTER_SCALAR_CONTROLS.map(control => this._renderOverrideSlider({ path: control.path, control, basePersonality, patch })).join('')}
        <div class="character-override-item">
          <label class="character-override-toggle">
            <input type="checkbox" data-level-toggle="${this._esc(pathKey(['streakThresholds']))}" data-level-toggle-kind="array" data-level-inherited="${this._esc(JSON.stringify(basePersonality.streakThresholds || []))}"${Array.isArray(patch.streakThresholds) ? ' checked' : ''}>
            <span><b>Combo milestones</b><small>${this._esc(characterOverrideComment(['streakThresholds'], 'Combo milestones'))}</small></span>
          </label>
          <input class="dialogue-field-input" type="text" value="${this._esc((Array.isArray(patch.streakThresholds) ? patch.streakThresholds : basePersonality.streakThresholds || []).join(', '))}" data-level-streaks${Array.isArray(patch.streakThresholds) ? '' : ' disabled'}>
          <span class="character-inherited">Inherited ${this._esc((basePersonality.streakThresholds || []).join(', '))}</span>
        </div>
        <div class="character-mini-heading">Event overrides</div>
        ${eventTypes.map(eventType => {
          const inheritedRow = basePersonality.impulseTable[eventType] || { magnitude: 0.3, distribution: { idle: 1 } };
          const patchRow = patch.impulseTable?.[eventType] || {};
          const magnitudePath = ['impulseTable', eventType, 'magnitude'];
          const distributionPath = ['impulseTable', eventType, 'distribution'];
          const magnitudeActive = getPathValue(patch, magnitudePath) !== undefined;
          const distributionActive = getPathValue(patch, distributionPath) !== undefined;
          const distribution = distributionActive ? patchRow.distribution : inheritedRow.distribution;
          return `
            <div class="character-event-card">
              <div class="character-event-title">
                <span>${this._esc(this._eventLabel(eventType))}</span>
                <small>${this._esc(CHARACTER_EVENT_META[eventType]?.group || 'Custom')}</small>
              </div>
              ${this._renderOverrideSlider({
                path: magnitudePath,
                control: { label: 'Reaction strength', min: 0, max: 2, step: 0.05 },
                basePersonality,
                patch
              })}
              <label class="character-override-toggle">
                <input type="checkbox" data-level-toggle="${this._esc(pathKey(distributionPath))}" data-level-toggle-kind="object" data-level-inherited="${this._esc(JSON.stringify(inheritedRow.distribution || { idle: 1 }))}"${distributionActive ? ' checked' : ''}>
                <span><b>Override expression chances</b><small>${this._esc(characterOverrideComment(distributionPath, this._eventLabel(eventType)))}</small></span>
              </label>
              ${this._renderDistributionWeights({
                distribution,
                slots,
                scope: 'level',
                pathPrefix: distributionPath,
                disabled: !distributionActive
              })}
            </div>
          `;
        }).join('')}
        <div class="dialogue-editor-toolbar">
          <button class="dialogue-preview-btn" type="button" data-character-clear-patch>Clear All Level Overrides</button>
        </div>
      </div>
    `;
  }

  _renderCharacterEditor() {
    const body = document.getElementById('characterEditorBody');
    if (!body) return;
    const level = this.levelManager.getCurrentLevel();
    this.characterRegistry = normalizeCharacterRegistry(this.characterRegistry);
    const registry = this.characterRegistry;
    const characterIds = Object.keys(registry.characters).sort();
    const selectedId = registry.characters[this._selectedCharacterEditorId]
      ? this._selectedCharacterEditorId
      : (registry.selectedId || DEFAULT_CHARACTER_ID);
    this._selectedCharacterEditorId = selectedId;
    const selected = normalizeCharacter(registry.characters[selectedId] || createDefaultCharacter());
    const slotNames = this._getCharacterSlotList(selected);
    const authoredSlots = this._getCharacterSlotList(selected, { authoredOnly: true });
    const editorOptions = characterIds.map(id => `
      <option value="${this._esc(id)}"${id === selectedId ? ' selected' : ''}>${this._esc(registry.characters[id]?.name || id)} (${this._esc(id)})</option>
    `).join('');

    body.innerHTML = `
      <div class="dialogue-editor-toolbar">
        <button class="dialogue-chip-btn" type="button" data-character-new>+ Character</button>
        <button class="dialogue-preview-btn" type="button" data-character-export-trace>Export Trace CSV</button>
        <button class="dialogue-preview-btn" type="button" data-character-pull-server title="Replace local characters with the version stored on the server">Pull from Server</button>
        <button class="dialogue-chip-btn" type="button" data-character-push-server title="Upload local characters (with all images) to the server so production sees them">Push to Server</button>
        <div class="dialogue-toolbar-spacer"></div>
        <button class="dialogue-chip-btn" type="button" data-character-assign-current>Assign to Level</button>
      </div>
      <div class="dialogue-card-block character-panel-block character-picker-block">
        <div class="dialogue-block-title">Character</div>
        <label class="dialogue-field">
          <span class="dialogue-field-label">Editing character</span>
          <select id="characterEditorSelect" class="dialogue-field-select">${editorOptions}</select>
        </label>
      </div>
      <div class="dialogue-editor-note">Characters auto-sync through the shared server registry. Push/Pull is only for forcing a refresh.</div>

      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Expressions</div>
        ${this._renderExpressionGrid(selected, slotNames)}
        <div class="dialogue-inline-grid character-custom-slot">
          <label class="dialogue-field">
            <span class="dialogue-field-label">Add expression slot</span>
            <input id="characterCustomSlotInput" class="dialogue-field-input" type="text" placeholder="composed">
          </label>
          <button class="dialogue-chip-btn" type="button" data-character-add-slot>Add Expression</button>
        </div>
      </div>

      <div class="dialogue-card-block character-panel-block">
        <div class="dialogue-block-title">Character Details</div>
        <div class="dialogue-inline-grid">
          <label class="dialogue-field">
            <span class="dialogue-field-label">ID</span>
            <input id="characterIdInput" class="dialogue-field-input" type="text" value="${this._esc(selected.id)}">
          </label>
          <label class="dialogue-field">
            <span class="dialogue-field-label">Name</span>
            <input id="characterNameInput" class="dialogue-field-input" type="text" value="${this._esc(selected.name)}">
          </label>
        </div>
        <div class="dialogue-editor-toolbar">
          <button class="dialogue-chip-btn" type="button" data-character-save-details>Save Details</button>
          <button class="dialogue-preview-btn" type="button" data-character-export-personality>Export Personality</button>
          <button class="dialogue-preview-btn" type="button" data-character-import-personality>Import Personality</button>
          <button class="dialogue-preview-btn" type="button" data-character-reset-personality>Restore Defaults</button>
        </div>
      </div>

      ${this._renderLevelOverridesPanel(level, registry, authoredSlots)}

      ${this._renderCharacterRestingPanel(selected, authoredSlots)}
      ${this._renderCharacterEventsPanel(selected, authoredSlots)}
      ${this._renderCharacterTimingPanel(selected)}
      ${this._renderCharacterAmbientPanel(selected, authoredSlots)}
      ${this._renderCharacterEscalationPanel(selected, authoredSlots)}
    `;

    this._bindFriendlyCharacterEditor(body, selected);
  }

  _bindFriendlyCharacterEditor(body, selected) {
    body.querySelector('[data-character-new]')?.addEventListener('click', () => this._addCharacter());
    body.querySelector('[data-character-export-trace]')?.addEventListener('click', () => {
      this.portraitReactionController.downloadTraceCsv();
    });
    body.querySelector('[data-character-push-server]')?.addEventListener('click', (event) => {
      this._pushCharacterRegistryToServer(event.currentTarget);
    });
    body.querySelector('[data-character-pull-server]')?.addEventListener('click', (event) => {
      this._pullCharacterRegistryFromServer(event.currentTarget);
    });
    body.querySelector('[data-character-assign-current]')?.addEventListener('click', () => {
      this._updateCurrentLevelCharacter((next) => {
        next.characterId = selected.id;
      });
    });
    body.querySelector('#levelCharacterSelect')?.addEventListener('change', (event) => {
      this._updateCurrentLevelCharacter((next) => {
        next.characterId = event.target.value;
      });
    });
    body.querySelector('[data-character-clear-patch]')?.addEventListener('click', () => {
      this._updateCurrentLevelCharacter((next) => {
        next.personalityPatch = {};
      });
    });
    body.querySelector('#characterEditorSelect')?.addEventListener('change', (event) => {
      this._selectedCharacterEditorId = event.target.value;
      this.characterRegistry.selectedId = this._selectedCharacterEditorId;
      this._saveCharacterRegistry(this.characterRegistry);
      this._renderCharacterEditor();
    });
    body.querySelector('[data-character-save-details]')?.addEventListener('click', () => {
      const rawId = body.querySelector('#characterIdInput')?.value || selected.id;
      const nextId = makeCharacterId(rawId, selected.id);
      const name = (body.querySelector('#characterNameInput')?.value || selected.name || nextId).trim();
      this._saveCharacterEdits(selected.id, { id: nextId, name });
    });
    body.querySelector('[data-character-export-personality]')?.addEventListener('click', () => {
      this._downloadJson(`${selected.id}-personality.json`, normalizePersonality(selected.personality));
    });
    body.querySelector('[data-character-import-personality]')?.addEventListener('click', () => {
      this._importCharacterPersonality(selected.id);
    });
    body.querySelector('[data-character-reset-personality]')?.addEventListener('click', () => {
      this._mutateCharacter(selected.id, (character) => {
        character.personality = createDefaultCharacter({ id: character.id, name: character.name }).personality;
      });
    });
    body.querySelectorAll('[data-character-upload-slot]').forEach((button) => {
      button.addEventListener('click', () => this._uploadCharacterSlot(selected.id, button.dataset.characterUploadSlot));
    });
    body.querySelectorAll('[data-character-preview-slot]').forEach((button) => {
      button.addEventListener('click', () => this._previewCharacterExpressionTransition(selected.id, button.dataset.characterPreviewSlot));
    });
    body.querySelectorAll('[data-character-clear-slot]').forEach((button) => {
      button.addEventListener('click', () => this._removeCharacterSlotVariant(selected.id, button.dataset.characterClearSlot));
    });
    body.querySelectorAll('[data-character-variant-prev]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this._cycleExpressionVariant(selected.id, button.dataset.characterVariantPrev, -1);
      });
    });
    body.querySelectorAll('[data-character-variant-next]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this._cycleExpressionVariant(selected.id, button.dataset.characterVariantNext, 1);
      });
    });
    body.querySelectorAll('.character-expression-card').forEach((card) => {
      card.addEventListener('wheel', (event) => {
        const slot = card.dataset.characterSlot;
        if (!slot) return;
        const registry = normalizeCharacterRegistry(this.characterRegistry);
        const character = registry.characters[makeCharacterId(selected.id)];
        if (!character) return;
        if (getCharacterSlotSources(character, slot).length <= 1) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? 1 : (event.deltaY < 0 ? -1 : 0);
        if (delta) this._cycleExpressionVariant(selected.id, slot, delta);
      }, { passive: false });
    });
    body.querySelector('[data-character-add-slot]')?.addEventListener('click', () => {
      const slot = (body.querySelector('#characterCustomSlotInput')?.value || '').trim();
      if (!slot) return;
      this._mutateCharacter(selected.id, (character) => {
        if (!Object.prototype.hasOwnProperty.call(character.slots, slot)) character.slots[slot] = null;
      });
    });
    body.querySelectorAll('[data-character-number]').forEach((input) => {
      input.addEventListener('input', () => {
        const path = parsePathKey(input.dataset.characterNumber);
        const value = Number(input.value);
        this._updateValueReadout(body, input.dataset.characterNumber, formatTuningValue(value, this._controlForPath(path)));
        this._mutateCharacter(selected.id, (character) => {
          character.personality = normalizePersonality(character.personality);
          setPathValue(character.personality, path, value);
        }, { rerender: false });
      });
    });
    body.querySelectorAll('[data-character-select]').forEach((input) => {
      input.addEventListener('change', () => {
        const path = parsePathKey(input.dataset.characterSelect);
        this._mutateCharacter(selected.id, (character) => {
          character.personality = normalizePersonality(character.personality);
          setPathValue(character.personality, path, input.value);
        }, { rerender: false });
      });
    });
    body.querySelectorAll('[data-character-weight]').forEach((input) => {
      input.addEventListener('input', () => {
        const path = parsePathKey(input.dataset.characterWeight);
        this._updateValueReadout(body, input.dataset.characterWeight, `${Math.round(Number(input.value) || 0)}%`);
        this._mutateCharacter(selected.id, (character) => {
          character.personality = normalizePersonality(character.personality);
          setPathValue(character.personality, path, Math.max(0, Number(input.value) || 0) / 100);
        }, { rerender: false });
      });
    });
    body.querySelector('[data-character-streaks]')?.addEventListener('change', (event) => {
      this._mutateCharacter(selected.id, (character) => {
        character.personality = normalizePersonality(character.personality);
        character.personality.streakThresholds = this._parseNumberList(event.target.value);
      });
    });

    this._bindLevelOverrideControls(body);
  }

  _bindLevelOverrideControls(body) {
    body.querySelectorAll('[data-level-toggle]').forEach((toggle) => {
      toggle.addEventListener('change', () => {
        const path = parsePathKey(toggle.dataset.levelToggle);
        const inherited = this._parseJsonAttribute(toggle.dataset.levelInherited);
        this._updateCurrentLevelPersonalityPatch((patch) => {
          if (toggle.checked) setPathValue(patch, path, inherited);
          else deletePathValue(patch, path);
        });
      });
    });
    body.querySelectorAll('[data-level-number]').forEach((input) => {
      input.addEventListener('input', () => {
        const path = parsePathKey(input.dataset.levelNumber);
        const value = Number(input.value);
        this._updateValueReadout(body, input.dataset.levelNumber, formatTuningValue(value, this._controlForPath(path)));
        this._updateCurrentLevelPersonalityPatch((patch) => {
          setPathValue(patch, path, value);
        }, { rerender: false });
      });
    });
    body.querySelectorAll('[data-level-select]').forEach((input) => {
      input.addEventListener('change', () => {
        const path = parsePathKey(input.dataset.levelSelect);
        this._updateCurrentLevelPersonalityPatch((patch) => {
          setPathValue(patch, path, input.value);
        }, { rerender: false });
      });
    });
    body.querySelectorAll('[data-level-weight]').forEach((input) => {
      input.addEventListener('input', () => {
        const path = parsePathKey(input.dataset.levelWeight);
        this._updateValueReadout(body, input.dataset.levelWeight, `${Math.round(Number(input.value) || 0)}%`);
        this._updateCurrentLevelPersonalityPatch((patch) => {
          setPathValue(patch, path, Math.max(0, Number(input.value) || 0) / 100);
        }, { rerender: false });
      });
    });
    body.querySelector('[data-level-streaks]')?.addEventListener('change', (event) => {
      this._updateCurrentLevelPersonalityPatch((patch) => {
        patch.streakThresholds = this._parseNumberList(event.target.value);
      });
    });
  }

  _updateCurrentLevelPersonalityPatch(mutator, options = {}) {
    return this._updateCurrentLevelCharacter((assignment) => {
      const patch = clonePlain(assignment.personalityPatch || {}) || {};
      mutator(patch);
      pruneEmptyObjects(patch);
      assignment.personalityPatch = normalizePersonalityPatch(patch);
    }, options);
  }

  _parseNumberList(value) {
    const values = String(value || '')
      .split(',')
      .map(part => Math.round(Number(part.trim())))
      .filter(number => Number.isFinite(number) && number > 0);
    return Array.from(new Set(values)).sort((a, b) => a - b);
  }

  _parseJsonAttribute(value) {
    try {
      return JSON.parse(value || 'null');
    } catch (error) {
      return null;
    }
  }

  _controlForPath(path) {
    const key = pathKey(path);
    return [
      ...CHARACTER_SCALAR_CONTROLS,
      ...CHARACTER_RESTING_CONTROLS,
      ...CHARACTER_AMBIENT_CONTROLS,
      { path: ['impulseTable', 'x', 'magnitude'], label: 'Reaction strength', min: 0, max: 2, step: 0.05 }
    ].find(control => pathKey(control.path) === key || (path[0] === 'impulseTable' && path[2] === 'magnitude')) || { step: 0.05 };
  }

  _updateValueReadout(root, key, value) {
    root.querySelectorAll('[data-character-value-for]').forEach((node) => {
      if (node.dataset.characterValueFor === key) node.textContent = value;
    });
  }

  _downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  _importCharacterPersonality(characterId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        const parsed = JSON.parse(raw);
        this._mutateCharacter(characterId, (character) => {
          character.personality = normalizePersonality(parsed);
        });
      } catch (error) {
        alert('Could not import that personality file. Check that it is valid JSON.');
      }
    };
    input.click();
  }

  _previewCharacterExpressionTransition(characterId, slotName) {
    if (!this.visualLayout || !slotName || slotName === 'idle') return;
    const registry = normalizeCharacterRegistry(this.characterRegistry);
    const character = normalizeCharacter(registry.characters[makeCharacterId(characterId)] || createDefaultCharacter());
    const idleSrc = getCharacterSlotSource(character, 'idle');
    const sources = getCharacterSlotSources(character, slotName);
    let targetSrc;
    if (sources.length > 0) {
      const index = this._getExpressionVariantIndex(character.id, slotName, sources.length);
      targetSrc = sources[index];
    } else {
      targetSrc = getCharacterSlotSource(character, slotName);
    }
    if (!targetSrc || targetSrc === idleSrc) return;
    const personality = normalizePersonality(character.personality);
    const fadeMs = Number.isFinite(personality.crossfadeMs) ? personality.crossfadeMs : 320;
    this.visualLayout.setCharacterPortraitSource(idleSrc, { fadeMs: 0, slotName: 'idle' });
    this.visualLayout.setCharacterPortraitSource(targetSrc, {
      fadeMs,
      slotName
    });
  }

  _mutateCharacter(characterId, mutator, options = {}) {
    const registry = normalizeCharacterRegistry(this.characterRegistry);
    const id = makeCharacterId(characterId);
    const character = normalizeCharacter(registry.characters[id] || createDefaultCharacter({ id }));
    if (mutator(character) === false) return null;
    registry.characters[id] = normalizeCharacter(character);
    registry.selectedId = id;
    this._selectedCharacterEditorId = id;
    this._saveCharacterRegistry(registry);
    this._refreshCurrentLevelForCharacterChange(id);
    if (options.rerender !== false) this._renderCharacterEditor();
    return registry.characters[id];
  }

  _saveCharacterEdits(previousId, edits) {
    const registry = normalizeCharacterRegistry(this.characterRegistry);
    const oldId = makeCharacterId(previousId);
    const nextId = makeCharacterId(edits.id, oldId);
    const prev = normalizeCharacter(registry.characters[oldId] || createDefaultCharacter({ id: oldId }));
    const next = normalizeCharacter({
      ...prev,
      id: nextId,
      name: edits.name || prev.name,
      personality: edits.personality || prev.personality
    });
    if (nextId !== oldId) delete registry.characters[oldId];
    registry.characters[nextId] = next;
    registry.selectedId = nextId;
    this._selectedCharacterEditorId = nextId;
    this._saveCharacterRegistry(registry);
    if (nextId !== oldId) {
      this._replaceAssignedCharacterIdAcrossLevels(oldId, nextId);
    }
    this._refreshCurrentLevelForCharacterChange(nextId);
    this._renderCharacterEditor();
  }

  _uploadCharacterSlot(characterId, slotName) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/webp,image/*';
    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const dataUrl = await readCharacterImageFile(file);
      if (!dataUrl) {
        alert('Could not read that image.');
        return;
      }
      this._mutateCharacter(characterId, (character) => {
        const existing = character.slots[slotName];
        const list = Array.isArray(existing)
          ? existing.filter(v => typeof v === 'string' && v.trim())
          : (typeof existing === 'string' && existing.trim() ? [existing] : []);
        list.push(dataUrl);
        character.slots[slotName] = list.length > 1 ? list : list[0];
        this._setExpressionVariantIndex(character.id, slotName, list.length - 1);
      });
    };
    input.click();
  }

  _removeCharacterSlotVariant(characterId, slotName) {
    this._mutateCharacter(characterId, (character) => {
      const existing = character.slots[slotName];
      const list = Array.isArray(existing)
        ? existing.filter(v => typeof v === 'string' && v.trim())
        : (typeof existing === 'string' && existing.trim() ? [existing] : []);
      if (list.length === 0) {
        character.slots[slotName] = null;
        this._setExpressionVariantIndex(character.id, slotName, 0);
        return;
      }
      const index = this._getExpressionVariantIndex(character.id, slotName, list.length);
      list.splice(index, 1);
      if (list.length === 0) {
        character.slots[slotName] = null;
      } else if (list.length === 1) {
        character.slots[slotName] = list[0];
      } else {
        character.slots[slotName] = list;
      }
      const nextIndex = list.length === 0 ? 0 : Math.min(index, list.length - 1);
      this._setExpressionVariantIndex(character.id, slotName, nextIndex);
    });
  }

  _setDialogueControllerContextForCurrentLevel(options = {}) {
    const level = this.levelManager.getCurrentLevel();
    const live = !!options.live;
    this.dialogueController.setContext({
      level,
      scopeKey: level ? `editor:${level.id}` : 'editor',
      game: live ? this.game : null,
      gambleSystem: live ? this.gambleSystem : null,
      persistSeen: false,
      live
    });
    this.dialogueController.setLanguage(this.dialogueLanguage);
    if (options.refreshPreview) {
      this._refreshDialoguePreviewFromState();
    }
  }

  _getCurrentDialogueConfig() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return normalizeDialogueConfig(null);
    const normalized = normalizeDialogueConfig(level.dialogue);
    level.dialogue = normalized;
    return normalized;
  }

  _setCurrentLevelDialogue(config, options = {}) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return null;

    const normalized = normalizeDialogueConfig(config);
    level.dialogue = normalized;
    if (level.metadata) {
      level.metadata.modified = new Date().toISOString();
    }
    this.levelManager.save();
    this.dialogueController.setConfig(normalized);

    if (this.mode === 'editor') {
      this._refreshDialoguePreviewFromState();
      if (options.rerender !== false && document.getElementById('dialogueOverlay')?.classList.contains('visible')) {
        this._renderDialogueEditor();
      }
    }
    return normalized;
  }

  _getSelectedDialogueEntry() {
    const config = this._getCurrentDialogueConfig();
    const selected = config.entries.find(entry => entry.id === this._dialogueSelectedEntryId) || null;
    if (selected) return selected;
    if (config.entries.length > 0) {
      this._dialogueSelectedEntryId = config.entries[0].id;
      return config.entries[0];
    }
    this._dialogueSelectedEntryId = null;
    return null;
  }

  _setSelectedDialogueEntry(entryId) {
    this._dialogueSelectedEntryId = entryId || null;
    if (document.getElementById('dialogueOverlay')?.classList.contains('visible')) {
      this._renderDialogueEditor();
    }
  }

  _updateDialogueEntry(entryId, mutator, options = {}) {
    const config = normalizeDialogueConfig(this._getCurrentDialogueConfig());
    const index = config.entries.findIndex(entry => entry.id === entryId);
    if (index === -1) return null;

    const entry = config.entries[index];
    if (mutator(entry, config, index) === false) return null;
    return this._setCurrentLevelDialogue(config, options);
  }

  _formatDialogueTriggerSummary(entry) {
    if (entry.trigger.type === 'spinReward') {
      if (!entry.trigger.perkIds.length) return 'Spin reward';
      if (entry.trigger.perkIds.length === 1) {
        const perk = PERK_DEFINITIONS.find(item => item.id === entry.trigger.perkIds[0]);
        return perk ? `Spin: ${perk.name}` : 'Spin reward';
      }
      return `Spin: ${entry.trigger.perkIds.length} perks`;
    }
    if (entry.trigger.type === 'pegProgress') {
      return `Peg progress ${entry.trigger.progressPercent}%`;
    }
    if (entry.trigger.type === 'performanceCap30') {
      return 'Stable ~30 FPS cap';
    }
    return 'Level start';
  }

  _getDialogueTriggerHelp(entry) {
    if (entry.trigger.type === 'spinReward') {
      return 'Fires after the slot spin finishes and at least one perk is awarded. Leave all perk boxes unchecked to accept any rewarded perk.';
    }
    if (entry.trigger.type === 'pegProgress') {
      return 'Fires when target progress reaches the selected percent. Classic levels use orange pegs; survival levels use vertical target progress.';
    }
    if (entry.trigger.type === 'performanceCap30') {
      return 'Fires once the runtime observes a stable ~30 FPS cadence with low render/update cost, which usually means iOS Low Power Mode or an external frame cap.';
    }
    return 'Fires when this level starts. If Show once is enabled, it is remembered per campaign and per edited dialogue revision.';
  }

  _formatDialogueLocaleSummary(entry) {
    const parts = [];
    if (entry.content?.ru?.segments?.some(segment => segment.text)) parts.push('RU');
    if (entry.content?.en?.segments?.some(segment => segment.text)) parts.push('EN');
    return parts.length ? parts.join(' / ') : 'No text yet';
  }

  _renderDialogueLocaleCard(entry, language, label) {
    const segments = Array.isArray(entry.content?.[language]?.segments) ? entry.content[language].segments : [];
    const rows = segments.length > 0
      ? segments.map((segment) => {
        const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(segment.color || '')
          ? segment.color
          : '#ffffff';
        return `
          <div class="dialogue-segment-row">
            <textarea
              class="dialogue-field-textarea"
              data-dialogue-segment-text="${this._esc(segment.id)}"
              data-dialogue-language="${language}"
              placeholder="Text segment"
            >${this._esc(segment.text || '')}</textarea>
            <input
              class="dialogue-color-input"
              type="color"
              value="${this._esc(color)}"
              data-dialogue-segment-color="${this._esc(segment.id)}"
              data-dialogue-language="${language}"
            >
            <button
              class="dialogue-icon-btn dialogue-icon-btn--danger"
              type="button"
              title="Remove segment"
              data-dialogue-remove-segment="${this._esc(segment.id)}"
              data-dialogue-language="${language}"
            >×</button>
          </div>
        `;
      }).join('')
      : `<div class="dialogue-segment-empty">${language === 'en' ? 'English can stay empty and fall back to Russian.' : 'Add at least one segment to show dialogue.'}</div>`;

    return `
      <div class="dialogue-locale-card">
        <div class="dialogue-locale-header">
          <div class="dialogue-locale-title">${label}</div>
          <div class="dialogue-locale-actions">
            <button class="dialogue-chip-btn" type="button" data-dialogue-add-segment="${language}">+ Segment</button>
            <button class="dialogue-preview-btn${this._dialoguePreviewState?.entryId === entry.id && this._dialoguePreviewState?.language === language ? ' is-active' : ''}" type="button" data-dialogue-preview="${language}">Preview ${language.toUpperCase()}</button>
          </div>
        </div>
        <div class="dialogue-locale-hint">${language === 'ru' ? 'Noto Serif Semibold with dark shadow in gameplay.' : 'Optional English override with Kelmscott Roman NF.'}</div>
        <div class="dialogue-segment-list">${rows}</div>
      </div>
    `;
  }

  _renderDialogueEditor() {
    const body = document.getElementById('dialogueEditorBody');
    if (!body) return;

    const level = this.levelManager.getCurrentLevel();
    if (!level) {
      body.innerHTML = '<div class="dialogue-editor-empty">No level selected.</div>';
      return;
    }

    const config = this._getCurrentDialogueConfig();
    const selectedEntry = this._getSelectedDialogueEntry();
    const previewState = this._dialoguePreviewState;
    const dialogueEmotionSlots = Array.from(new Set([
      ...CANONICAL_EMOTION_SLOTS,
      ...Object.keys(this._resolveLevelCharacter(level).slots || {})
    ]));
    const emotionOptions = [
      '<option value="">No portrait reaction</option>',
      ...dialogueEmotionSlots.map(slot => `
        <option value="${this._esc(slot)}"${selectedEntry?.emotion === slot ? ' selected' : ''}>${this._esc(slot)}</option>
      `)
    ].join('');

    const entryListHtml = config.entries.length > 0
      ? config.entries.map((entry, index) => {
        const isSelected = entry.id === selectedEntry?.id;
        const isPreviewing = previewState?.entryId === entry.id;
        return `
          <div class="dialogue-entry-item${isSelected ? ' is-selected' : ''}" data-dialogue-entry-id="${this._esc(entry.id)}">
            <button class="dialogue-entry-main" type="button" data-dialogue-select="${this._esc(entry.id)}">
              <div class="dialogue-entry-title-row">
                <span class="dialogue-entry-title">${this._esc(entry.title || 'Untitled dialogue')}</span>
                <span class="dialogue-entry-badge">${this._esc(this._formatDialogueTriggerSummary(entry))}</span>
              </div>
              <div class="dialogue-entry-meta">
                ${this._esc(this._formatDialogueLocaleSummary(entry))} · ${Math.round((entry.timeoutMs || 0) / 1000)}s${entry.once ? ' · once' : ' · repeat'}${entry.emotion ? ` · ${this._esc(entry.mode || 'override')}:${this._esc(entry.emotion)}` : ''}${entry.enabled ? '' : ' · disabled'}${isPreviewing ? ` · preview ${this._esc(previewState.language.toUpperCase())}` : ''}
              </div>
            </button>
            <div class="dialogue-entry-actions">
              <button class="dialogue-icon-btn" type="button" title="Move up" data-dialogue-move="${this._esc(entry.id)}" data-dialogue-direction="-1"${index === 0 ? ' disabled' : ''}>↑</button>
              <button class="dialogue-icon-btn" type="button" title="Move down" data-dialogue-move="${this._esc(entry.id)}" data-dialogue-direction="1"${index === config.entries.length - 1 ? ' disabled' : ''}>↓</button>
              <button class="dialogue-icon-btn dialogue-icon-btn--danger" type="button" title="Delete" data-dialogue-delete="${this._esc(entry.id)}">×</button>
            </div>
          </div>
        `;
      }).join('')
      : '<div class="dialogue-editor-empty">No dialogue entries yet. Add a first-level intro or a perk explanation.</div>';

    const formHtml = selectedEntry ? `
      <div class="dialogue-entry-form">
        <div class="dialogue-card-block">
          <div class="dialogue-block-title">Entry</div>
          <label class="dialogue-field">
            <span class="dialogue-field-label">Title</span>
            <input id="dialogueTitleInput" class="dialogue-field-input" type="text" value="${this._esc(selectedEntry.title || '')}" placeholder="Dialogue title">
          </label>
          <div class="dialogue-inline-grid">
            <label class="dialogue-field">
              <span class="dialogue-field-label">Timeout, seconds</span>
              <input id="dialogueTimeoutInput" class="dialogue-field-input" type="number" min="0" max="120" step="1" value="${Math.round((selectedEntry.timeoutMs || 0) / 1000)}">
            </label>
            <label class="dialogue-field">
              <span class="dialogue-field-label">Vertical offset</span>
              <input id="dialogueOffsetInput" class="dialogue-field-input" type="number" min="-120" max="180" step="2" value="${Math.round(selectedEntry.placement?.offsetY || 0)}">
            </label>
            <label class="dialogue-field">
              <span class="dialogue-field-label">Text size, %</span>
              <input id="dialogueTextScaleInput" class="dialogue-field-input" type="number" min="50" max="180" step="5" value="${Math.round((selectedEntry.placement?.textScale || 1) * 100)}">
            </label>
          </div>
          <div class="dialogue-toggle-grid">
            <label class="dialogue-toggle"><input id="dialogueEnabledToggle" type="checkbox"${selectedEntry.enabled ? ' checked' : ''}> Enabled</label>
            <label class="dialogue-toggle"><input id="dialogueOnceToggle" type="checkbox"${selectedEntry.once ? ' checked' : ''}> Show once</label>
            <label class="dialogue-toggle"><input id="dialogueDismissShotToggle" type="checkbox"${selectedEntry.dismissOn?.shot ? ' checked' : ''}> Hide on shot</label>
            <label class="dialogue-toggle"><input id="dialogueDismissSpinToggle" type="checkbox"${selectedEntry.dismissOn?.spin ? ' checked' : ''}> Hide on spin</label>
          </div>
          <div class="dialogue-block-note">Dismiss only reacts to a real shot or a real spin start, not random taps.</div>
          <div class="dialogue-inline-grid">
            <label class="dialogue-field">
              <span class="dialogue-field-label">Portrait emotion</span>
              <select id="dialogueEmotionSelect" class="dialogue-field-select">
                ${emotionOptions}
              </select>
            </label>
            <label class="dialogue-field">
              <span class="dialogue-field-label">Portrait mode</span>
              <select id="dialogueEmotionModeSelect" class="dialogue-field-select">
                <option value="override"${selectedEntry.mode === 'override' ? ' selected' : ''}>Hold this expression during the line</option>
                <option value="impulse"${selectedEntry.mode === 'impulse' ? ' selected' : ''}>Nudge mood when line starts</option>
              </select>
            </label>
            <label class="dialogue-field dialogue-impulse-strength${selectedEntry.mode === 'impulse' ? '' : ' is-hidden'}">
              <span class="dialogue-field-label">Mood nudge strength <b id="dialogueEmotionMagnitudeValue">${Number(selectedEntry.emotionMagnitude || 0.55).toFixed(2)}</b></span>
              <input id="dialogueEmotionMagnitudeInput" class="character-range" type="range" min="0" max="2" step="0.05" value="${Number(selectedEntry.emotionMagnitude || 0.55).toFixed(2)}"${selectedEntry.mode === 'impulse' ? '' : ' disabled'}>
            </label>
          </div>
        </div>

        <div class="dialogue-card-block">
          <div class="dialogue-block-title">Trigger</div>
          <label class="dialogue-field">
            <span class="dialogue-field-label">When this dialogue should appear</span>
            <select id="dialogueTriggerType" class="dialogue-field-select">
              <option value="levelStart"${selectedEntry.trigger.type === 'levelStart' ? ' selected' : ''}>First level enter / level start</option>
              <option value="spinReward"${selectedEntry.trigger.type === 'spinReward' ? ' selected' : ''}>Spin reward</option>
              <option value="pegProgress"${selectedEntry.trigger.type === 'pegProgress' ? ' selected' : ''}>Peg clear progress</option>
              <option value="performanceCap30"${selectedEntry.trigger.type === 'performanceCap30' ? ' selected' : ''}>Stable ~30 FPS cap / possible power saver</option>
            </select>
          </label>
          <div class="dialogue-block-note">${this._esc(this._getDialogueTriggerHelp(selectedEntry))}</div>
          ${selectedEntry.trigger.type === 'pegProgress' ? `
            <div class="dialogue-trigger-extra">
              <label class="dialogue-field">
                <span class="dialogue-field-label">Show after this percent of target pegs is cleared</span>
                <input id="dialogueProgressInput" class="dialogue-field-input" type="number" min="0" max="100" step="1" value="${Math.round(selectedEntry.trigger.progressPercent || 0)}">
              </label>
            </div>
          ` : ''}
          ${selectedEntry.trigger.type === 'spinReward' ? `
            <div class="dialogue-trigger-extra">
              <div class="dialogue-field-label" style="margin-bottom:6px;">Perks that can trigger this line</div>
              <div class="dialogue-perk-grid">
                ${PERK_DEFINITIONS.map((perk) => `
                  <label class="dialogue-perk-chip">
                    <input type="checkbox" value="${this._esc(perk.id)}" data-dialogue-perk="${this._esc(perk.id)}"${selectedEntry.trigger.perkIds.includes(perk.id) ? ' checked' : ''}>
                    <span>${this._esc(perk.name)}</span>
                  </label>
                `).join('')}
              </div>
              <div class="dialogue-block-note">Leave all unchecked to show this dialogue for any won perk.</div>
            </div>
          ` : ''}
          ${selectedEntry.trigger.type === 'performanceCap30' ? `
            <div class="dialogue-trigger-extra">
              <div class="dialogue-block-note">Shows after the game observes a steady ~30 FPS cap for a couple of seconds while the level itself looks otherwise light to render. Useful for hints like “disable Low Power Mode for smoother visuals”.</div>
            </div>
          ` : ''}
        </div>

        ${this._renderDialogueLocaleCard(selectedEntry, 'ru', 'Russian')}
        ${this._renderDialogueLocaleCard(selectedEntry, 'en', 'English')}
      </div>
    ` : '';

    body.innerHTML = `
      <div class="dialogue-editor-toolbar">
        <button class="dialogue-chip-btn" type="button" data-dialogue-add-entry>+ Add Entry</button>
        <button class="dialogue-preview-btn${previewState?.language === 'ru' && previewState?.entryId === selectedEntry?.id ? ' is-active' : ''}" type="button" data-dialogue-preview="ru"${selectedEntry ? '' : ' disabled'}>Preview RU</button>
        <button class="dialogue-preview-btn${previewState?.language === 'en' && previewState?.entryId === selectedEntry?.id ? ' is-active' : ''}" type="button" data-dialogue-preview="en"${selectedEntry ? '' : ' disabled'}>Preview EN</button>
        <div class="dialogue-toolbar-spacer"></div>
        <button class="dialogue-chip-btn${previewState ? ' is-active' : ''}" type="button" data-dialogue-hide-preview${previewState ? '' : ' disabled'}>Hide Preview</button>
      </div>
      <div class="dialogue-editor-note">Dialogues are saved inside this level, can fire in sequence, and already support future triggers like peg-progress thresholds and multi-line scripting.</div>
      <div class="dialogue-entry-list">${entryListHtml}</div>
      ${formHtml}
    `;

    body.querySelectorAll('[data-dialogue-add-entry]').forEach((button) => {
      button.addEventListener('click', () => this._addDialogueEntry());
    });

    body.querySelectorAll('[data-dialogue-select]').forEach((button) => {
      button.addEventListener('click', () => this._setSelectedDialogueEntry(button.dataset.dialogueSelect));
    });

    body.querySelectorAll('[data-dialogue-move]').forEach((button) => {
      button.addEventListener('click', () => {
        const entryId = button.dataset.dialogueMove;
        const direction = Number(button.dataset.dialogueDirection || 0);
        const configToMove = normalizeDialogueConfig(this._getCurrentDialogueConfig());
        const fromIndex = configToMove.entries.findIndex(entry => entry.id === entryId);
        const toIndex = fromIndex + direction;
        if (fromIndex < 0 || toIndex < 0 || toIndex >= configToMove.entries.length) return;
        const [entry] = configToMove.entries.splice(fromIndex, 1);
        configToMove.entries.splice(toIndex, 0, entry);
        this._dialogueSelectedEntryId = entryId;
        this._setCurrentLevelDialogue(configToMove);
      });
    });

    body.querySelectorAll('[data-dialogue-delete]').forEach((button) => {
      button.addEventListener('click', () => {
        const entryId = button.dataset.dialogueDelete;
        const configToDelete = normalizeDialogueConfig(this._getCurrentDialogueConfig());
        const index = configToDelete.entries.findIndex(entry => entry.id === entryId);
        if (index === -1) return;
        configToDelete.entries.splice(index, 1);
        const nextSelected = configToDelete.entries[index] || configToDelete.entries[index - 1] || null;
        this._dialogueSelectedEntryId = nextSelected?.id || null;
        if (this._dialoguePreviewState?.entryId === entryId) {
          this._dialoguePreviewState = null;
          this.dialogueController.hidePreview();
        }
        this._setCurrentLevelDialogue(configToDelete);
      });
    });

    body.querySelectorAll('[data-dialogue-preview]').forEach((button) => {
      button.addEventListener('click', () => this._previewDialogueEntry(button.dataset.dialoguePreview));
    });

    body.querySelectorAll('[data-dialogue-hide-preview]').forEach((button) => {
      button.addEventListener('click', () => this._hideDialoguePreview());
    });

    if (!selectedEntry) return;

    const titleInput = body.querySelector('#dialogueTitleInput');
    titleInput?.addEventListener('input', (event) => {
      const value = event.target.value;
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.title = value.trim() || 'Dialogue';
      }, { rerender: false });
      const titleItem = Array.from(body.querySelectorAll('.dialogue-entry-item')).find((item) => item.dataset.dialogueEntryId === selectedEntry.id);
      const titleEl = titleItem?.querySelector('.dialogue-entry-title');
      if (titleEl) titleEl.textContent = value.trim() || 'Dialogue';
    });

    body.querySelector('#dialogueTimeoutInput')?.addEventListener('input', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.timeoutMs = clampDialogueTimeoutMs(Number(event.target.value) * 1000);
      }, { rerender: false });
    });

    body.querySelector('#dialogueOffsetInput')?.addEventListener('input', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.placement.offsetY = Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : 0;
      }, { rerender: false });
    });

    body.querySelector('#dialogueTextScaleInput')?.addEventListener('input', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        const percent = Number(event.target.value);
        entry.placement.textScale = Math.max(0.5, Math.min(1.8, (Number.isFinite(percent) ? percent : 100) / 100));
      }, { rerender: false });
    });

    body.querySelector('#dialogueEnabledToggle')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.enabled = !!event.target.checked;
      });
    });

    body.querySelector('#dialogueOnceToggle')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.once = !!event.target.checked;
      });
    });

    body.querySelector('#dialogueDismissShotToggle')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.dismissOn.shot = !!event.target.checked;
      });
    });

    body.querySelector('#dialogueDismissSpinToggle')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.dismissOn.spin = !!event.target.checked;
      });
    });

    body.querySelector('#dialogueEmotionSelect')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.emotion = event.target.value || '';
        if (entry.emotion && !entry.mode) entry.mode = 'override';
        if (!entry.emotion) entry.mode = '';
      });
    });

    body.querySelector('#dialogueEmotionModeSelect')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.mode = event.target.value === 'impulse' ? 'impulse' : 'override';
      });
    });

    body.querySelector('#dialogueEmotionMagnitudeInput')?.addEventListener('input', (event) => {
      const value = clampDialogueEmotionMagnitude(Number(event.target.value));
      const valueEl = body.querySelector('#dialogueEmotionMagnitudeValue');
      if (valueEl) valueEl.textContent = value.toFixed(2);
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.emotionMagnitude = value;
      }, { rerender: false });
    });

    body.querySelector('#dialogueTriggerType')?.addEventListener('change', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.trigger.type = event.target.value;
      });
    });

    body.querySelector('#dialogueProgressInput')?.addEventListener('input', (event) => {
      this._updateDialogueEntry(selectedEntry.id, (entry) => {
        entry.trigger.progressPercent = Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0)));
      }, { rerender: false });
    });

    body.querySelectorAll('[data-dialogue-perk]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const selectedPerks = Array.from(body.querySelectorAll('[data-dialogue-perk]:checked')).map((input) => input.value);
        this._updateDialogueEntry(selectedEntry.id, (entry) => {
          entry.trigger.perkIds = selectedPerks;
        }, { rerender: false });
      });
    });

    body.querySelectorAll('[data-dialogue-add-segment]').forEach((button) => {
      button.addEventListener('click', () => {
        const language = button.dataset.dialogueAddSegment;
        this._updateDialogueEntry(selectedEntry.id, (entry) => {
          entry.content[language].segments.push({
            id: Utils.generateId(),
            text: '',
            color: '#ffffff'
          });
        });
      });
    });

    body.querySelectorAll('[data-dialogue-remove-segment]').forEach((button) => {
      button.addEventListener('click', () => {
        const language = button.dataset.dialogueLanguage;
        const segmentId = button.dataset.dialogueRemoveSegment;
        this._updateDialogueEntry(selectedEntry.id, (entry) => {
          entry.content[language].segments = entry.content[language].segments.filter(segment => segment.id !== segmentId);
        });
      });
    });

    body.querySelectorAll('[data-dialogue-segment-text]').forEach((textarea) => {
      textarea.addEventListener('input', (event) => {
        const language = textarea.dataset.dialogueLanguage;
        const segmentId = textarea.dataset.dialogueSegmentText;
        this._updateDialogueEntry(selectedEntry.id, (entry) => {
          const segment = entry.content[language].segments.find(item => item.id === segmentId);
          if (segment) segment.text = event.target.value;
        }, { rerender: false });
      });
    });

    body.querySelectorAll('[data-dialogue-segment-color]').forEach((input) => {
      input.addEventListener('input', (event) => {
        const language = input.dataset.dialogueLanguage;
        const segmentId = input.dataset.dialogueSegmentColor;
        this._updateDialogueEntry(selectedEntry.id, (entry) => {
          const segment = entry.content[language].segments.find(item => item.id === segmentId);
          if (segment) segment.color = event.target.value || '#ffffff';
        }, { rerender: false });
      });
    });
  }

  _addDialogueEntry() {
    const config = normalizeDialogueConfig(this._getCurrentDialogueConfig());
    const entry = createDialogueEntry({
      title: `Dialogue ${config.entries.length + 1}`,
      content: {
        ru: {
          segments: [
            { id: Utils.generateId(), text: '', color: '#ffffff' }
          ]
        },
        en: { segments: [] }
      }
    });
    config.entries.push(entry);
    this._dialogueSelectedEntryId = entry.id;
    this._setCurrentLevelDialogue(config);
    this.showDialogueEditor();
  }

  _previewDialogueEntry(language) {
    const entry = this._getSelectedDialogueEntry();
    if (!entry) return;
    this.dialogueLanguage = normalizeLanguage(language);
    this._dialoguePreviewState = {
      entryId: entry.id,
      language: this.dialogueLanguage
    };
    this.dialogueController.setLanguage(this.dialogueLanguage);
    this.dialogueController.setConfig(this._getCurrentDialogueConfig());
    this.dialogueController.previewEntry(entry.id, { language: this.dialogueLanguage });
    if (document.getElementById('dialogueOverlay')?.classList.contains('visible')) {
      this._renderDialogueEditor();
    }
  }

  _hideDialoguePreview() {
    this._dialoguePreviewState = null;
    this.dialogueController.hidePreview();
    if (document.getElementById('dialogueOverlay')?.classList.contains('visible')) {
      this._renderDialogueEditor();
    }
  }

  _refreshDialoguePreviewFromState() {
    if (this.mode !== 'editor') return;
    this.dialogueController.setConfig(this._getCurrentDialogueConfig());
    if (!this._dialoguePreviewState?.entryId) {
      this.dialogueController.hidePreview();
      return;
    }
    const targetEntry = this._getCurrentDialogueConfig().entries.find((item) => item.id === this._dialoguePreviewState.entryId);
    if (!targetEntry) {
      this._dialoguePreviewState = null;
      this.dialogueController.hidePreview();
      return;
    }
    const language = normalizeLanguage(this._dialoguePreviewState.language);
    this.dialogueController.setLanguage(language);
    this.dialogueController.previewEntry(targetEntry.id, { language });
  }

  showDialogueEditor() {
    this.closeLevelList();
    this.closeCampaignList();
    this.closeCampaignEditor();
    this.closePvpDuelLevels();
    this.closePhysicsSettings();
    this.closeCharacterEditor();

    const config = this._getCurrentDialogueConfig();
    if (!this._dialogueSelectedEntryId && config.entries.length > 0) {
      this._dialogueSelectedEntryId = config.entries[0].id;
    }
    this._positionEditorSideSheets();
    this._renderDialogueEditor();
    document.getElementById('dialogueOverlay').classList.add('visible');
  }

  closeDialogueEditor() {
    document.getElementById('dialogueOverlay').classList.remove('visible');
    this._hideDialoguePreview();
  }

  async exportLevel() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const snapshot = await this._cloneLevelSnapshotForStorage(level);
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${level.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  }

  importLevel() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const level = this.levelManager.importLevel(event.target.result);
        if (level) {
          this.levelManager.setCurrentLevelById(level.id);
          this.updateLevelTitle();
          if (this.mode === 'editor') {
            this.startEditor();
          }
        } else {
          alert('Failed to import level');
        }
      };
      reader.readAsText(file);
    };
    
    input.click();
  }

  _ensureImportLinkDialog() {
    let overlay = document.getElementById('levelLinkImportOverlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'levelLinkImportOverlay';
    overlay.className = 'link-import-overlay';
    overlay.innerHTML = `
      <div class="link-import-panel" role="dialog" aria-modal="true" aria-labelledby="levelLinkImportTitle">
        <div class="level-list-header link-import-header">
          <button id="closeLevelLinkImport" class="header-btn" type="button">&larr;</button>
          <h2 id="levelLinkImportTitle" class="level-list-title">Import Player Link</h2>
        </div>
        <div class="link-import-body">
          <label class="dialogue-field">
            <span class="dialogue-field-label">Baked player link</span>
            <textarea id="levelLinkImportInput" class="dialogue-field-textarea link-import-textarea" spellcheck="false" placeholder="https://peggle.vercel.app/player.html#eJ..."></textarea>
          </label>
          <div id="levelLinkImportStatus" class="link-import-status">Paste a player.html#... link or the hash after #.</div>
          <div class="dialogue-editor-toolbar link-import-actions">
            <button id="cancelLevelLinkImport" class="dialogue-preview-btn" type="button">Cancel</button>
            <button id="confirmLevelLinkImport" class="dialogue-chip-btn" type="button">Import</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.classList.remove('visible');
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector('#closeLevelLinkImport')?.addEventListener('click', close);
    overlay.querySelector('#cancelLevelLinkImport')?.addEventListener('click', close);
    overlay.querySelector('#levelLinkImportInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        this._importLevelFromLinkDialog();
      }
    });
    overlay.querySelector('#confirmLevelLinkImport')?.addEventListener('click', () => {
      this._importLevelFromLinkDialog();
    });

    return overlay;
  }

  showImportLinkDialog() {
    const overlay = this._ensureImportLinkDialog();
    const input = overlay.querySelector('#levelLinkImportInput');
    const status = overlay.querySelector('#levelLinkImportStatus');
    const importButton = overlay.querySelector('#confirmLevelLinkImport');
    if (input) input.value = '';
    if (status) {
      status.textContent = 'Paste a player.html#... link or the hash after #.';
      status.classList.remove('error', 'success');
    }
    if (importButton) importButton.disabled = false;
    overlay.classList.add('visible');
    requestAnimationFrame(() => input?.focus());
  }

  async _importLevelFromLinkDialog() {
    const overlay = this._ensureImportLinkDialog();
    const input = overlay.querySelector('#levelLinkImportInput');
    const status = overlay.querySelector('#levelLinkImportStatus');
    const importButton = overlay.querySelector('#confirmLevelLinkImport');
    const raw = input?.value || '';
    const hash = extractBakedLevelHash(raw);

    status?.classList.remove('error', 'success');
    if (!hash) {
      if (status) {
        status.textContent = 'Paste the full player.html#... URL, or just the hash after #.';
        status.classList.add('error');
      }
      return;
    }

    if (importButton) importButton.disabled = true;
    if (status) status.textContent = `Decoding ${Math.max(1, Math.round(hash.length / 1024))} KB baked link...`;

    try {
      const json = await decodeBakedLevelJsonFromText(raw);
      const parsed = JSON.parse(json);
      if (!parsed || !Array.isArray(parsed.pegs)) {
        throw new Error('Decoded data is not a level JSON payload.');
      }
      const level = this.levelManager.importLevel(json);
      if (!level) {
        throw new Error('The decoded level could not be imported.');
      }

      this.levelManager.setCurrentLevelById(level.id);
      this.updateLevelTitle();
      overlay.classList.remove('visible');
      this.startEditor();
      alert(`Imported "${level.name || 'Untitled Level'}" with ${level.pegs?.length || 0} pegs.`);
    } catch (e) {
      console.error('[import-link] failed:', e);
      if (status) {
        status.textContent = e?.message || 'Could not import that player link.';
        status.classList.add('error');
      }
    } finally {
      if (importButton) importButton.disabled = false;
    }
  }

  exportTrainingData() {
    const data = this.levelManager.exportTrainingData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `peggle_training_data_${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
  }

  // ─── Campaign Management ─────────────────────────────────

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  _findEditorLevelByBakedName(bakedName, editorLevels = this.levelManager.getAllLevels()) {
    return editorLevels.find(l => {
      const safe = (l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      return safe === bakedName || l.name === bakedName;
    }) || null;
  }

  _cloneLevelSnapshot(level) {
    if (!level) return null;
    const copy = Utils.deepClone(level);
    attachCharacterSnapshotToLevel(copy, this.characterRegistry);
    return cloneLevelSnapshot(copy);
  }

  async _cloneLevelSnapshotForStorage(level) {
    const snapshot = this._cloneLevelSnapshot(level);
    if (!snapshot) return null;
    await compressLevelBackgroundImages(snapshot, {
      viewportWidth: this.canvas?.width || MAX_WIDTH,
      viewportHeight: this.canvas?.height || 600
    });
    return snapshot;
  }

  _isLocalStorageQuotaError(error) {
    return !!error && (
      error.name === 'QuotaExceededError'
      || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || error.code === 22
      || error.code === 1014
    );
  }

  _getLocalStorageEvictionCandidates(protectedKey = '') {
    const candidates = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key === protectedKey) continue;
        const isCampaignCache = key.startsWith('campaign:') || key.startsWith('campaign_ts:');
        const isBakedCache = key.startsWith('baked:');
        if (!isCampaignCache && !isBakedCache) continue;
        const value = localStorage.getItem(key) || '';
        candidates.push({
          key,
          bytes: key.length + value.length,
          priority: isCampaignCache ? 0 : 1
        });
      }
    } catch {
      return [];
    }
    return candidates.sort((a, b) => (a.priority - b.priority) || (b.bytes - a.bytes));
  }

  _setLocalStorageItemWithCleanup(key, value, label = key, options = {}) {
    if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') return false;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      if (!this._isLocalStorageQuotaError(error)) {
        console.warn(`[storage] Failed to write ${label}:`, error);
        return false;
      }
    }

    if (options.removeCurrent !== false) {
      try {
        localStorage.removeItem(key);
        localStorage.setItem(key, value);
        return true;
      } catch (error) {
        if (!this._isLocalStorageQuotaError(error)) {
          console.warn(`[storage] Failed to write ${label}:`, error);
          return false;
        }
      }
    }

    const evicted = [];
    for (const candidate of this._getLocalStorageEvictionCandidates(key)) {
      try {
        localStorage.removeItem(candidate.key);
        evicted.push(candidate.key);
        localStorage.setItem(key, value);
        if (evicted.length > 0) {
          console.warn(`[storage] Freed local cache for ${label} by evicting:`, evicted);
        }
        return true;
      } catch (error) {
        if (!this._isLocalStorageQuotaError(error)) {
          console.warn(`[storage] Failed while freeing cache for ${label}:`, error);
          return false;
        }
      }
    }

    console.warn(`[storage] Skipped local cache for ${label}; browser quota is still full after cleanup.`);
    return false;
  }

  _readBakedLevelSnapshot(bakedName) {
    const raw = localStorage.getItem('baked:' + bakedName);
    if (!raw) return null;
    try {
      const snapshot = normalizeLevelData(JSON.parse(raw));
      if (!snapshot) return null;
      const normalizedRaw = JSON.stringify(snapshot);
      if (normalizedRaw !== raw) {
        this._setLocalStorageItemWithCleanup(
          'baked:' + bakedName,
          normalizedRaw,
          `baked level "${bakedName}"`,
          { removeCurrent: false }
        );
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  _writeBakedLevelSnapshot(bakedName, snapshot) {
    const normalized = this._cloneLevelSnapshot(snapshot);
    if (!normalized) return null;
    this._setLocalStorageItemWithCleanup(
      'baked:' + bakedName,
      JSON.stringify(normalized),
      `baked level "${bakedName}"`
    );
    return normalized;
  }

  async _writeBakedLevelSnapshotForStorage(bakedName, snapshot) {
    const normalized = await this._cloneLevelSnapshotForStorage(snapshot);
    if (!normalized) return null;
    this._setLocalStorageItemWithCleanup(
      'baked:' + bakedName,
      JSON.stringify(normalized),
      `baked level "${bakedName}"`
    );
    return normalized;
  }

  _trackPendingRemoteLevelSave(bakedName, savePromise) {
    const tracked = Promise.resolve(savePromise)
      .then((ok) => {
        if (ok) {
          this._remoteLevelSyncFailures.delete(bakedName);
        } else {
          this._remoteLevelSyncFailures.set(bakedName, `Failed to sync "${bakedName}" to remote storage.`);
        }
        return ok;
      })
      .catch((error) => {
        const message = error?.message || `Failed to sync "${bakedName}" to remote storage.`;
        this._remoteLevelSyncFailures.set(bakedName, message);
        console.warn('[campaign] Level sync threw:', bakedName, error);
        return false;
      })
      .finally(() => {
        if (this._pendingRemoteLevelSaves.get(bakedName) === tracked) {
          this._pendingRemoteLevelSaves.delete(bakedName);
        }
      });

    this._pendingRemoteLevelSaves.set(bakedName, tracked);
    return tracked;
  }

  async _waitForPendingRemoteLevelSave(bakedName) {
    const pending = this._pendingRemoteLevelSaves.get(bakedName);
    if (!pending) return true;
    return await pending;
  }

  async _awaitCampaignRemoteLevelSaves(campaign) {
    if (!campaign || !Array.isArray(campaign.levelNames)) return { ok: true };

    const seen = new Set();
    for (const bakedName of campaign.levelNames) {
      if (!bakedName || seen.has(bakedName)) continue;
      seen.add(bakedName);

      const pendingOk = await this._waitForPendingRemoteLevelSave(bakedName);
      if (!pendingOk) {
        return {
          ok: false,
          levelName: bakedName,
          message: this._remoteLevelSyncFailures.get(bakedName) || `Failed to sync "${bakedName}" to remote storage.`
        };
      }

      const failedMessage = this._remoteLevelSyncFailures.get(bakedName);
      if (failedMessage) {
        return {
          ok: false,
          levelName: bakedName,
          message: failedMessage
        };
      }
    }

    return { ok: true };
  }

  async _saveBakedLevelRemote(bakedName, snapshot) {
    const savePromise = (async () => {
      const outbound = await this._cloneLevelSnapshotForStorage(snapshot);
      return api.saveLevel(bakedName, outbound || snapshot);
    })();
    const ok = await this._trackPendingRemoteLevelSave(
      bakedName,
      savePromise
    );
    if (!ok) {
      console.warn('[campaign] Failed to sync level to remote:', bakedName);
    }
    return ok;
  }

  _saveBakedLevelRemoteInBackground(bakedName, snapshot) {
    this._saveBakedLevelRemote(bakedName, snapshot);
  }

  async _cacheRemoteBakedLevel(bakedName) {
    const remoteLevel = await api.getLevel(bakedName);
    if (!remoteLevel || !Array.isArray(remoteLevel.pegs)) return null;
    const snapshot = await this._writeBakedLevelSnapshotForStorage(bakedName, remoteLevel);
    return snapshot;
  }

  async _prepareCampaignEntryLevel(entry, editorLevels) {
    if (entry.source === 'editor') {
      const editorLevel = this._findEditorLevelByBakedName(entry.name, editorLevels);
      if (!editorLevel) {
        alert('Editor level not found: ' + (entry.displayName || entry.name));
        return false;
      }
      const snapshot = await this._writeBakedLevelSnapshotForStorage(entry.name, editorLevel);
      if (!snapshot) return false;
      this._saveBakedLevelRemoteInBackground(entry.name, snapshot);
      return true;
    }

    if (this._readBakedLevelSnapshot(entry.name)) return true;

    const remoteSnapshot = await this._cacheRemoteBakedLevel(entry.name);
    if (remoteSnapshot) return true;

    alert('Failed to load baked level data: ' + (entry.displayName || entry.name));
    return false;
  }

  _normalizePvpDuelLevelNames(names) {
    return [...new Set((Array.isArray(names) ? names : [])
      .map(name => (typeof name === 'string' ? name.trim() : ''))
      .filter(Boolean))];
  }

  _readLocalPvpDuelLevelNames() {
    try {
      return this._normalizePvpDuelLevelNames(JSON.parse(localStorage.getItem(PVP_DUEL_LEVELS_STORAGE_KEY) || '[]'));
    } catch {
      return [];
    }
  }

  _writeLocalPvpDuelLevelNames(names) {
    try {
      localStorage.setItem(PVP_DUEL_LEVELS_STORAGE_KEY, JSON.stringify(this._normalizePvpDuelLevelNames(names)));
    } catch { /* local cache unavailable */ }
  }

  _isPvpDuelSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.pegs)) return false;
    return !!normalizePvpSettings(snapshot.pvp).enabled;
  }

  async _ensurePvpDuelLevelNames() {
    if (Array.isArray(this._pvpDuelLevelNames)) return this._pvpDuelLevelNames;
    if (this._pvpDuelLevelsPromise) return this._pvpDuelLevelsPromise;

    this._pvpDuelLevelsPromise = (async () => {
      const remoteNames = this._normalizePvpDuelLevelNames(await api.listPvpDuelLevels());
      const localNames = this._readLocalPvpDuelLevelNames();
      const names = remoteNames.length > 0 ? remoteNames : localNames;
      this._pvpDuelLevelNames = names;
      if (remoteNames.length > 0) this._writeLocalPvpDuelLevelNames(remoteNames);
      return names;
    })().finally(() => {
      this._pvpDuelLevelsPromise = null;
      if (document.getElementById('pvpLevelsOverlay')?.classList.contains('visible')) {
        this._renderPvpDuelLevels();
      }
    });

    return this._pvpDuelLevelsPromise;
  }

  async _savePvpDuelLevelNames(names) {
    const normalized = this._normalizePvpDuelLevelNames(names);
    this._pvpDuelLevelNames = normalized;
    this._writeLocalPvpDuelLevelNames(normalized);
    this._renderPvpDuelLevels();
    const ok = await api.savePvpDuelLevels(normalized);
    if (!ok) {
      alert('PvP Duel pool was saved locally, but failed to sync to remote. Rooms on production will not see this change yet.');
      return false;
    }
    return true;
  }

  async _preparePvpDuelEntryLevel(entry, editorLevels) {
    if (entry.source === 'editor') {
      const editorLevel = this._findEditorLevelByBakedName(entry.name, editorLevels);
      if (!editorLevel) {
        alert('Editor level not found: ' + (entry.displayName || entry.name));
        return false;
      }
      if (!normalizePvpSettings(editorLevel.pvp).enabled) {
        alert('Only levels with PvP Mode enabled can be added to Duel.');
        return false;
      }
      const snapshot = await this._writeBakedLevelSnapshotForStorage(entry.name, editorLevel);
      if (!snapshot) return false;
      const ok = await this._saveBakedLevelRemote(entry.name, snapshot);
      if (!ok) {
        alert(`Failed to sync "${entry.displayName || entry.name}" to remote storage. Duel rooms need the baked PvP level on the server.`);
        return false;
      }
      return true;
    }

    let snapshot = this._readBakedLevelSnapshot(entry.name);
    let fromRemote = false;
    if (!snapshot) {
      snapshot = await this._cacheRemoteBakedLevel(entry.name);
      fromRemote = !!snapshot;
    }
    if (!snapshot) {
      alert('Failed to load baked PvP level data: ' + (entry.displayName || entry.name));
      return false;
    }
    if (!this._isPvpDuelSnapshot(snapshot)) {
      alert('Only baked levels with PvP Mode enabled can be added to Duel.');
      return false;
    }
    if (!fromRemote) {
      const ok = await this._saveBakedLevelRemote(entry.name, snapshot);
      if (!ok) {
        alert(`Failed to sync "${entry.displayName || entry.name}" to remote storage. Duel rooms need the baked PvP level on the server.`);
        return false;
      }
    }
    return true;
  }

  async _collectPvpDuelAvailableEntries(remoteNames = []) {
    const editorLevels = this.levelManager.getAllLevels();
    const entries = [];
    const seen = new Set();

    for (const level of editorLevels) {
      if (!normalizePvpSettings(level.pvp).enabled) continue;
      const safe = (level.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
      seen.add(safe);
      entries.push({
        name: safe,
        displayName: level.name || safe,
        source: 'editor'
      });
    }

    const localBaked = this.campaignManager.getBakedLevelNames();
    for (const name of localBaked) {
      if (seen.has(name)) continue;
      const snapshot = this._readBakedLevelSnapshot(name);
      if (!this._isPvpDuelSnapshot(snapshot)) continue;
      seen.add(name);
      entries.push({
        name,
        displayName: name,
        source: 'baked'
      });
    }

    const remoteOnly = [...new Set(remoteNames || [])]
      .filter(name => typeof name === 'string' && name && !seen.has(name))
      .sort();
    for (const name of remoteOnly) {
      const snapshot = this._readBakedLevelSnapshot(name) || await api.getLevel(name);
      if (!this._isPvpDuelSnapshot(snapshot)) continue;
      seen.add(name);
      entries.push({
        name,
        displayName: name,
        source: 'remote'
      });
    }

    entries.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    return { editorLevels, entries };
  }

  _renderPvpDuelLevels() {
    const selectedList = document.getElementById('pvpSelectedLevelItems');
    const availableList = document.getElementById('pvpAvailableLevelItems');
    if (!selectedList || !availableList) return;

    const selectedNames = Array.isArray(this._pvpDuelLevelNames) ? this._pvpDuelLevelNames : null;
    selectedList.innerHTML = '';
    if (!selectedNames) {
      selectedList.innerHTML = '<div class="campaign-empty-hint">Loading Duel pool...</div>';
    } else if (selectedNames.length === 0) {
      selectedList.innerHTML = '<div class="campaign-empty-hint">No Duel levels yet. Add baked levels with PvP Mode enabled.</div>';
    } else {
      for (const name of selectedNames) {
        const item = document.createElement('div');
        item.className = 'campaign-level-item';
        item.innerHTML = `
          <span class="campaign-level-name">${this._esc(name)}</span>
          <div class="campaign-level-actions">
            <button class="campaign-action-btn campaign-edit-level-btn" title="Edit in Editor">&#9998;</button>
            <button class="campaign-action-btn campaign-remove-btn" title="Remove from Duel Pool">&times;</button>
          </div>
        `;
        item.querySelector('.campaign-edit-level-btn')?.addEventListener('click', () => {
          this.closePvpDuelLevels();
          this._editCampaignLevel(name);
        });
        item.querySelector('.campaign-remove-btn')?.addEventListener('click', async () => {
          await this._savePvpDuelLevelNames((this._pvpDuelLevelNames || []).filter(itemName => itemName !== name));
        });
        selectedList.appendChild(item);
      }
    }

    const requestId = ++this._pvpAvailableLevelsRequest;
    availableList.innerHTML = '<div class="campaign-empty-hint">Looking for baked PvP levels...</div>';

    const renderAvailable = async () => {
      let remoteNames = [];
      try {
        remoteNames = await api.listLevels();
      } catch { /* handled by empty fallback */ }
      const { editorLevels, entries } = await this._collectPvpDuelAvailableEntries(remoteNames || []);
      if (requestId !== this._pvpAvailableLevelsRequest) return;

      const selected = new Set(this._pvpDuelLevelNames || []);
      const available = entries.filter(entry => !selected.has(entry.name));
      availableList.innerHTML = '';
      if (available.length === 0) {
        availableList.innerHTML = '<div class="campaign-empty-hint">No available PvP levels. Enable PvP Mode on a level, then bake/sync it here.</div>';
        return;
      }

      for (const entry of available) {
        const item = document.createElement('div');
        item.className = 'campaign-level-item campaign-available-item';
        const sourceLabel = entry.source === 'editor'
          ? 'Editor'
          : (entry.source === 'remote' ? 'Remote' : 'Baked');
        item.innerHTML = `
          <span class="campaign-level-name">${this._esc(entry.displayName)}</span>
          <span class="level-item-meta">${sourceLabel}</span>
          <button class="campaign-action-btn campaign-add-btn" title="Add to Duel Pool">+</button>
        `;

        const addBtn = item.querySelector('.campaign-add-btn');
        addBtn?.addEventListener('click', async () => {
          addBtn.disabled = true;
          addBtn.style.opacity = '0.4';
          const ready = await this._preparePvpDuelEntryLevel(entry, editorLevels);
          if (!ready) {
            addBtn.disabled = false;
            addBtn.style.opacity = '';
            return;
          }
          const next = this._normalizePvpDuelLevelNames([...(this._pvpDuelLevelNames || []), entry.name]);
          await this._savePvpDuelLevelNames(next);
        });

        availableList.appendChild(item);
      }
    };

    renderAvailable();
  }

  async showPvpDuelLevels() {
    this.closeLevelList();
    this.closeCampaignList();
    this.closeCampaignEditor();
    this.closeDialogueEditor();
    this.closePhysicsSettings();
    this.closeCharacterEditor();
    this._positionEditorSideSheets();
    this._renderPvpDuelLevels();
    document.getElementById('pvpLevelsOverlay')?.classList.add('visible');
    await this._ensurePvpDuelLevelNames();
  }

  closePvpDuelLevels() {
    document.getElementById('pvpLevelsOverlay')?.classList.remove('visible');
    this._pvpAvailableLevelsRequest += 1;
  }

  async _ensureCampaignLevelsReadyForRemote(campaign) {
    const seen = new Set();
    for (const bakedName of campaign.levelNames) {
      if (!bakedName || seen.has(bakedName)) continue;
      seen.add(bakedName);

      let snapshot = this._readBakedLevelSnapshot(bakedName);
      if (!snapshot) {
        const editorLevel = this._findEditorLevelByBakedName(bakedName);
        if (editorLevel) {
          snapshot = await this._writeBakedLevelSnapshotForStorage(bakedName, editorLevel);
        } else {
          snapshot = await this._cacheRemoteBakedLevel(bakedName);
        }
      }

      if (!snapshot) {
        return {
          ok: false,
          levelName: bakedName,
          message: `Missing baked level data for "${bakedName}".`
        };
      }

      const ok = await this._saveBakedLevelRemote(bakedName, snapshot);
      if (!ok) {
        return {
          ok: false,
          levelName: bakedName,
          message: `Failed to sync "${bakedName}" to remote storage.`
        };
      }
    }

    return { ok: true };
  }

  _renderCampaignList() {
    this.campaignManager.compactLocal();
    const campaigns = this.campaignManager.getAll();
    const list = document.getElementById('campaignItems');
    list.innerHTML = '';
    const primaryName = this._primaryCampaignName ?? null;
    const isSyncing = !!this._campaignSyncPromise;
    const isPrimaryPending = this._primaryCampaignName === undefined && !!this._primaryCampaignPromise;

    if (campaigns.length === 0) {
      list.innerHTML = `<div class="campaign-empty-hint">${
        isSyncing
          ? 'Loading campaigns...'
          : 'No campaigns yet. Create one to organize baked levels into a playable chain.'
      }</div>`;
    } else if (isSyncing || isPrimaryPending) {
      const status = document.createElement('div');
      status.className = 'campaign-empty-hint';
      status.textContent = isSyncing ? 'Refreshing campaigns in background...' : 'Loading primary campaign...';
      list.appendChild(status);
    }

    for (const campaign of campaigns) {
      const safeName = (campaign.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
      const isPrimary = safeName === primaryName;
      const item = document.createElement('div');
      item.className = 'level-item';

      item.innerHTML = `
        <div class="level-item-info">
          <button class="level-action-btn primary-btn" title="${isPrimary ? 'Primary campaign (shown on player domain)' : 'Set as primary campaign'}" style="color:${isPrimary ? '#4ecdc4' : '#555'};font-size:14px;margin-right:4px">&#9733;</button>
          <span class="level-item-name">${this._esc(campaign.name)}</span>
          <span class="level-item-meta">${campaign.levelNames.length} level${campaign.levelNames.length !== 1 ? 's' : ''} • ${this._esc(safeName)}</span>
        </div>
        <div class="level-item-actions">
          <button class="level-action-btn edit-btn" title="Edit">&#9998;</button>
          <button class="level-action-btn delete-btn" title="Delete">&#128465;</button>
        </div>
      `;

      item.querySelector('.primary-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const newPrimary = isPrimary ? null : safeName;
        const prevPrimary = this._primaryCampaignName ?? null;
        this._primaryCampaignName = newPrimary;
        this._renderCampaignList();
        const ok = await api.setConfig('primaryCampaign', newPrimary);
        if (!ok) {
          this._primaryCampaignName = prevPrimary;
        }
        this._renderCampaignList();
      });

      item.querySelector('.level-item-info').addEventListener('click', () => {
        this.openCampaignEditor(campaign.id);
      });
      item.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openCampaignEditor(campaign.id);
      });
      item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete campaign "${campaign.name}"?`)) {
          this.campaignManager.delete(campaign.id);
          this.showCampaignList();
        }
      });

      list.appendChild(item);
    }

    // Wire up header buttons
    document.getElementById('newCampaignBtn').onclick = () => {
      const c = this.campaignManager.create('New Campaign');
      this.openCampaignEditor(c.id);
    };
    document.getElementById('closeCampaignList').onclick = () => this.closeCampaignList();
  }

  _ensurePrimaryCampaignName() {
    if (this._primaryCampaignPromise) return this._primaryCampaignPromise;
    if (this._primaryCampaignName !== undefined) return Promise.resolve(this._primaryCampaignName);

    this._primaryCampaignPromise = api.getConfig('primaryCampaign')
      .then(async (primaryName) => {
        let next = typeof primaryName === 'string' && primaryName ? primaryName : null;
        if (!next) {
          try {
            const res = await fetch('/data/player/config.json');
            if (res.ok) {
              const config = await res.json();
              const value = config?.primaryCampaign || config?.primary;
              if (typeof value === 'string' && value) next = value;
            }
          } catch { /* static fallback unavailable */ }
        }
        this._primaryCampaignName = next;
        return this._primaryCampaignName;
      })
      .finally(() => {
        this._primaryCampaignPromise = null;
        if (document.getElementById('campaignOverlay')?.classList.contains('visible')) {
          this._renderCampaignList();
        }
      });

    return this._primaryCampaignPromise;
  }

  _ensureCampaignsSynced() {
    if (this._campaignsSynced) return Promise.resolve(true);
    if (this._campaignSyncPromise) return this._campaignSyncPromise;

    this._campaignSyncPromise = this.campaignManager.syncFromRemote()
      .then((ok) => {
        if (ok) this._campaignsSynced = true;
        return ok;
      })
      .finally(() => {
        this._campaignSyncPromise = null;
        if (document.getElementById('campaignOverlay')?.classList.contains('visible')) {
          this._renderCampaignList();
        }
      });

    return this._campaignSyncPromise;
  }

  showCampaignList() {
    this.closeLevelList();
    this.closeCampaignEditor();
    this.closeCharacterEditor();
    this.closeDialogueEditor();
    this.closePvpDuelLevels();
    this._positionEditorSideSheets();
    this._ensurePrimaryCampaignName();
    this._ensureCampaignsSynced();
    this._renderCampaignList();
    document.getElementById('campaignOverlay').classList.add('visible');
  }

  closeCampaignList() {
    document.getElementById('campaignOverlay').classList.remove('visible');
  }

  openCampaignEditor(campaignId) {
    this._editingCampaignId = campaignId;
    this._selectedGraphNode = null;
    this._branchAddMode = null;
    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign) return;

    // Ensure graph model exists
    this.campaignManager.ensureGraph(campaignId);

    this.closeCampaignList();
    this.closePvpDuelLevels();
    this.closeCharacterEditor();
    this.closeDialogueEditor();
    this.closePhysicsSettings();

    const nameInput = document.getElementById('campaignNameInput');
    nameInput.value = campaign.name;
    nameInput.oninput = () => {
      this.campaignManager.update(campaignId, { name: nameInput.value });
    };

    document.getElementById('closeCampaignEdit').onclick = () => {
      this.closeCampaignEditor();
      this.showCampaignList();
    };

    document.getElementById('campaignExportBtn').onclick = () => {
      this.exportCampaign(campaignId);
    };

    document.getElementById('campaignPlayBtn').onclick = () => {
      this.playCampaign(campaignId);
    };

    // Node action buttons
    document.getElementById('nodeEditBtn').onclick = () => this._graphEditSelected(campaignId);
    document.getElementById('nodeBranchBtn').onclick = () => this._graphBranchAtSelected(campaignId);
    document.getElementById('nodeSecretBtn').onclick = () => this._graphToggleSecret(campaignId);
    document.getElementById('nodeRemoveBtn').onclick = () => this._graphRemoveSelected(campaignId);
    document.getElementById('nodeMoveUpBtn').onclick = () => this._graphMoveSelected(campaignId, 'up');
    document.getElementById('nodeMoveDownBtn').onclick = () => this._graphMoveSelected(campaignId, 'down');
    document.getElementById('nodeBranchLeftBtn').onclick = () => this._graphMoveSelected(campaignId, 'left');
    document.getElementById('nodeBranchRightBtn').onclick = () => this._graphMoveSelected(campaignId, 'right');

    this._refreshCampaignEditor(campaignId);

    this._positionEditorSideSheets();
    document.getElementById('campaignEditOverlay').classList.add('visible');
  }

  closeCampaignEditor() {
    this._editingCampaignId = null;
    this._selectedGraphNode = null;
    this._branchAddMode = null;
    document.getElementById('campaignEditOverlay').classList.remove('visible');
  }

  _refreshCampaignEditor(campaignId) {
    this._renderCampaignTree(campaignId);
    this._updateNodeBar(campaignId);
    this._renderCampaignLevels(campaignId);
    this._renderAvailableLevels(campaignId);
  }

  // ─── Tree canvas preview ─────────────────────────────────

  _renderCampaignTree(campaignId) {
    const campaign = this.campaignManager.getById(campaignId);
    const container = document.getElementById('campaignTreeContainer');
    container.innerHTML = '';

    const hint = document.getElementById('campaignEmptyHint');

    if (!campaign || !campaign.graph || campaign.graph.nodes.length === 0) {
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';

    const graph = campaign.graph;
    const nodes = graph.nodes;
    const R = 16, ROW_H = 55, COL_W = 60, PAD = 32;

    const layout = computeLayout(graph);
    if (!layout) return;

    const { positions, width: cw, height: ch0 } = toPixelPositions(layout, nodes, { rowH: ROW_H, colW: COL_W, pad: PAD });
    const ch = ch0 + R * 2;

    // --- Canvas ---
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    canvas.style.cursor = 'pointer';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Connections
    for (const n of nodes) {
      const from = positions.get(n.id);
      if (!from) continue;
      for (const cid of (n.children || [])) {
        const to = positions.get(cid);
        if (!to) continue;
        const midY = (from.y + R + to.y - R) / 2;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y + R);
        ctx.bezierCurveTo(from.x, midY, to.x, midY, to.x, to.y - R);
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }

    // Nodes
    for (const n of nodes) {
      const pos = positions.get(n.id);
      if (!pos) continue;
      const isSel = this._selectedGraphNode === n.id;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, R, 0, Math.PI * 2);
      ctx.fillStyle = n.type === 'secret' ? '#3a3040' : '#2a2a2f';
      ctx.fill();
      ctx.strokeStyle = isSel ? '#4ecdc4' : '#666';
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.stroke();

      // Label
      ctx.fillStyle = n.type === 'secret' ? '#c77dff' : '#ccc';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = n.type === 'secret' ? '?' : (n.levelName || '').slice(0, 5);
      ctx.fillText(label, pos.x, pos.y);
    }

    // Click handler
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = cw / rect.width;
      const sy = ch / rect.height;
      const mx = (e.clientX - rect.left) * sx;
      const my = (e.clientY - rect.top) * sy;

      let hit = null;
      for (const n of nodes) {
        const pos = positions.get(n.id);
        if (!pos) continue;
        const dx = mx - pos.x, dy = my - pos.y;
        if (dx * dx + dy * dy <= (R + 6) * (R + 6)) { hit = n.id; break; }
      }

      this._selectedGraphNode = hit;
      this._branchAddMode = null;  // reset branch mode on selection change
      this._updateNodeBar(campaignId);
      this._renderCampaignTree(campaignId);
    });

    container.appendChild(canvas);
  }

  _updateNodeBar(campaignId) {
    const bar = document.getElementById('campaignNodeBar');
    const label = document.getElementById('selectedNodeLabel');
    if (!bar || !label) return;

    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign || !campaign.graph || this._selectedGraphNode === null) {
      bar.style.display = 'none';
      return;
    }

    const node = campaign.graph.nodes.find(n => n.id === this._selectedGraphNode);
    if (!node) { bar.style.display = 'none'; return; }

    bar.style.display = '';
    label.innerHTML = `<strong>${this._esc(node.levelName || '?')}</strong>${node.type === 'secret' ? ' (secret)' : ''}`;

    const editBtn = document.getElementById('nodeEditBtn');
    if (editBtn) {
      editBtn.disabled = !node.levelName;
      editBtn.title = node.levelName ? 'Edit this level in editor' : 'Node has no level';
    }

    const upBtn = document.getElementById('nodeMoveUpBtn');
    const downBtn = document.getElementById('nodeMoveDownBtn');
    const leftBtn = document.getElementById('nodeBranchLeftBtn');
    const rightBtn = document.getElementById('nodeBranchRightBtn');
    const canUp = this.campaignManager.canMoveGraphNodeUp(campaignId, node.id);
    const canDown = this.campaignManager.canMoveGraphNodeDown(campaignId, node.id);
    const canLeft = this.campaignManager.canMoveGraphBranchSibling(campaignId, node.id, -1);
    const canRight = this.campaignManager.canMoveGraphBranchSibling(campaignId, node.id, 1);
    if (upBtn) upBtn.disabled = !canUp;
    if (downBtn) downBtn.disabled = !canDown;
    if (leftBtn) {
      leftBtn.disabled = !canLeft;
      leftBtn.style.display = (canLeft || canRight) ? '' : 'none';
    }
    if (rightBtn) {
      rightBtn.disabled = !canRight;
      rightBtn.style.display = (canLeft || canRight) ? '' : 'none';
    }
  }

  _graphMoveSelected(campaignId, direction) {
    if (this._selectedGraphNode === null) return;
    const nodeId = this._selectedGraphNode;
    const campaign = this.campaignManager.getById(campaignId);
    const graph = campaign?.graph;
    let movedLevelNodeId = nodeId;
    if (graph && direction === 'up') {
      const parents = graph.nodes.filter(n => Array.isArray(n.children) && n.children.includes(nodeId));
      if (parents.length === 1 && parents[0].children.length === 1) movedLevelNodeId = parents[0].id;
    } else if (graph && direction === 'down') {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (node && Array.isArray(node.children) && node.children.length === 1) movedLevelNodeId = node.children[0];
    }
    let ok = false;
    if (direction === 'up') ok = this.campaignManager.moveGraphNodeUp(campaignId, nodeId);
    else if (direction === 'down') ok = this.campaignManager.moveGraphNodeDown(campaignId, nodeId);
    else if (direction === 'left') ok = this.campaignManager.moveGraphBranchSibling(campaignId, nodeId, -1);
    else if (direction === 'right') ok = this.campaignManager.moveGraphBranchSibling(campaignId, nodeId, 1);
    if (ok) {
      this._selectedGraphNode = movedLevelNodeId;
      this._refreshCampaignEditor(campaignId);
    }
  }

  // ─── Graph editing actions ───────────────────────────────

  _graphEditSelected(campaignId) {
    if (this._selectedGraphNode === null) return;
    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign || !campaign.graph) return;
    const node = campaign.graph.nodes.find(n => n.id === this._selectedGraphNode);
    if (!node || !node.levelName) {
      alert('This node has no level to edit.');
      return;
    }
    this._editCampaignLevel(node.levelName);
  }

  _graphBranchAtSelected(campaignId) {
    if (this._selectedGraphNode === null) return;

    // Prompt for which level to add as new branch
    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign) return;
    const node = campaign.graph.nodes.find(n => n.id === this._selectedGraphNode);
    if (!node) return;

    // Enter "branch add" mode — next available level click will add as branch child
    this._branchAddMode = this._selectedGraphNode;
    this._updateNodeBar(campaignId);

    // Highlight the mode in the node bar
    const label = document.getElementById('selectedNodeLabel');
    if (label) label.innerHTML += ' <em style="color:#4ecdc4">— click a level below to add branch</em>';
  }

  _graphToggleSecret(campaignId) {
    if (this._selectedGraphNode === null) return;
    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign || !campaign.graph) return;

    const node = campaign.graph.nodes.find(n => n.id === this._selectedGraphNode);
    if (!node) return;

    this.campaignManager.setGraphNodeType(
      campaignId, node.id,
      node.type === 'secret' ? 'normal' : 'secret'
    );
    this._refreshCampaignEditor(campaignId);
  }

  _graphRemoveSelected(campaignId) {
    if (this._selectedGraphNode === null) return;
    this.campaignManager.removeGraphNode(campaignId, this._selectedGraphNode);
    this._selectedGraphNode = null;
    this._refreshCampaignEditor(campaignId);
  }

  _editCampaignLevel(bakedName) {
    const levels = this.levelManager.getAllLevels();
    const match = levels.find(l => {
      const safe = (l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      return safe === bakedName || l.name === bakedName;
    });

    if (match) {
      this.levelManager.setCurrentLevelById(match.id);
    } else {
      const snapshot = this._readBakedLevelSnapshot(bakedName);
      if (!snapshot) { alert('Baked level data not found: ' + bakedName); return; }
      const imported = this.levelManager.importLevel(JSON.stringify(snapshot));
      if (!imported) { alert('Failed to import level'); return; }
      this.levelManager.setCurrentLevelById(imported.id);
    }

    this.closeCampaignEditor();
    this.closeCampaignList();
    this.updateLevelTitle();
    this.startEditor();
  }

  // ─── Play order list (derived from graph) ────────────────

  _renderCampaignLevels(campaignId) {
    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign) return;

    const list = document.getElementById('campaignLevelItems');
    list.innerHTML = '';

    if (campaign.levelNames.length === 0) return;

    campaign.levelNames.forEach((name, index) => {
      const item = document.createElement('div');
      item.className = 'campaign-level-item';

      item.innerHTML = `
        <span class="campaign-level-num">${index + 1}</span>
        <span class="campaign-level-name">${this._esc(name)}</span>
        <div class="campaign-level-actions">
          <button class="campaign-action-btn campaign-edit-level-btn" title="Edit in Editor">&#9998;</button>
          <button class="campaign-action-btn campaign-rebake-btn" title="Rebake Level">&#8635;</button>
        </div>
      `;

      item.querySelector('.campaign-edit-level-btn').addEventListener('click', () => {
        this._editCampaignLevel(name);
      });

      item.querySelector('.campaign-rebake-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.style.opacity = '0.4';
        const didRebake = await this._rebakeLevelIfStale(name);
        if (!didRebake) {
          const editorLevels = this.levelManager.getAllLevels();
          const editorLevel = editorLevels.find(l => {
            const safe = (l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
            return safe === name || l.name === name;
          });
          if (editorLevel) {
            const snapshot = await this._writeBakedLevelSnapshotForStorage(name, editorLevel);
            if (snapshot) {
              await this._saveBakedLevelRemote(name, snapshot);
            }
          }
        }
        btn.style.opacity = '';
        btn.disabled = false;
        btn.style.color = '#4ecdc4';
        setTimeout(() => { btn.style.color = ''; }, 800);
      });

      list.appendChild(item);
    });
  }

  // ─── Available levels list ───────────────────────────────

  _buildAvailableLevelEntries(remoteNames = []) {
    const editorLevels = this.levelManager.getAllLevels();
    const editorSafeNames = new Set(editorLevels.map(l => (l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_')));
    const localBaked = this.campaignManager.getBakedLevelNames();
    const allBaked = [...new Set([...localBaked, ...remoteNames])].sort();

    const entries = [];
    for (const level of editorLevels) {
      const safeName = (level.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      entries.push({ name: safeName, displayName: level.name, source: 'editor' });
    }
    for (const name of allBaked) {
      if (!editorSafeNames.has(name)) {
        entries.push({ name, displayName: name, source: 'baked' });
      }
    }

    return { editorLevels, entries };
  }

  _renderAvailableLevels(campaignId) {
    const list = document.getElementById('availableLevelItems');
    const requestId = ++this._campaignAvailableLevelsRequest;

    const renderEntries = (remoteNames = null) => {
      if (requestId !== this._campaignAvailableLevelsRequest || this._editingCampaignId !== campaignId) return;

      const { editorLevels, entries } = this._buildAvailableLevelEntries(remoteNames || []);
      list.innerHTML = '';

      if (entries.length === 0) {
        list.innerHTML = `<div class="campaign-empty-hint">${
          remoteNames === null
            ? 'Looking for baked levels...'
            : 'No levels found. Create levels in the editor first.'
        }</div>`;
        return;
      }

      for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'campaign-level-item campaign-available-item';
        item.innerHTML = `
          <span class="campaign-level-name">${this._esc(entry.displayName)}</span>
          <button class="campaign-action-btn campaign-add-btn" title="Add to Campaign">+</button>
        `;

        const addBtn = item.querySelector('.campaign-add-btn');
        addBtn.addEventListener('click', async () => {
          addBtn.disabled = true;
          addBtn.style.opacity = '0.4';
          const ready = await this._prepareCampaignEntryLevel(entry, editorLevels);
          if (!ready) {
            addBtn.disabled = false;
            addBtn.style.opacity = '';
            return;
          }

          // Branch mode: add as new branch child of the selected node
          if (this._branchAddMode !== undefined && this._branchAddMode !== null) {
            this.campaignManager.addGraphBranch(campaignId, this._branchAddMode, entry.name);
            this._branchAddMode = null;
            this._refreshCampaignEditor(campaignId);
            return;
          }

          // Normal mode: add as child of selected node, or append to end
          const parentId = this._selectedGraphNode;
          this.campaignManager.addGraphNode(campaignId, entry.name, parentId);
          this._refreshCampaignEditor(campaignId);
        });

        list.appendChild(item);
      }
    };

    renderEntries(null);

    api.listLevels().then((remoteNames) => {
      renderEntries(remoteNames || []);
    }).catch(() => {
      renderEntries([]);
    });
  }

  exportCampaign(campaignId) {
    const data = this.campaignManager.exportCampaign(campaignId);
    if (!data || data.levels.length === 0) {
      alert('Campaign has no resolvable levels. Bake the levels first.');
      return;
    }

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(data.name || 'campaign').replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async _rebakeLevelIfStale(bakedName) {
    const editorLevel = this._findEditorLevelByBakedName(bakedName);
    if (!editorLevel) return false;

    const bakedSnapshot = this._readBakedLevelSnapshot(bakedName);
    if (bakedSnapshot) {
      const bakedMod = bakedSnapshot.metadata?.modified || '';
      const editorMod = editorLevel.metadata?.modified || '';
      if (editorMod && bakedMod && editorMod <= bakedMod) return false;
    }

    const snapshot = await this._writeBakedLevelSnapshotForStorage(bakedName, editorLevel);
    if (!snapshot) return false;
    await this._saveBakedLevelRemote(bakedName, snapshot);
    return true;
  }

  async playCampaign(campaignId) {
    const campaign = this.campaignManager.getById(campaignId);
    if (!campaign || campaign.levelNames.length === 0) {
      alert('Campaign has no levels. Add levels first.');
      return;
    }

    const seen = new Set();
    let rebaked = 0;
    for (const bakedName of campaign.levelNames) {
      if (seen.has(bakedName)) continue;
      seen.add(bakedName);
      if (await this._rebakeLevelIfStale(bakedName)) rebaked++;
    }
    if (rebaked > 0) console.log(`[campaign] Auto-rebaked ${rebaked} stale level(s)`);

    const remoteLevelsReady = await this._ensureCampaignLevelsReadyForRemote(campaign);
    const localName = this.campaignManager.publishLocal(campaignId);
    if (!localName) {
      alert('Campaign has no resolvable levels. Bake the levels first.');
      return;
    }

    let remotePublishMessage = '';
    if (!remoteLevelsReady.ok) {
      remotePublishMessage = remoteLevelsReady.message || 'Failed to sync campaign levels to remote storage.';
    } else {
      const campaignSaved = await this.campaignManager._syncCampaign(campaign);
      if (!campaignSaved) {
        remotePublishMessage = `Failed to publish campaign "${campaign.name}" to remote storage.`;
      }
    }

    if (remotePublishMessage) {
      alert(`${remotePublishMessage} Opened local preview only.`);
    }
    window.open('player.html?campaign=' + encodeURIComponent(localName), '_blank');
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.peggleApp = new PeggleApp();
});
