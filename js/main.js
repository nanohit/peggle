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
import { VisualLayout } from './visual-layout.js';
import { normalizeVisuals } from './visual-config.js';
import { CampaignManager } from './campaign-manager.js';
import { api } from './api.js';
import { computeLayout, toPixelPositions } from './graph/layout.js';
import { Utils } from './utils.js';
import { DialogueController } from './dialogue-controller.js';
import {
  clampDialogueTimeoutMs,
  createDialogueEntry,
  normalizeDialogueConfig
} from './dialogue-config.js';
import { getStoredLanguage, normalizeLanguage } from './localization.js';
import { PERK_DEFINITIONS } from './gamble-system.js';

// Fixed aspect ratio: 3:4.5 (width:height)
const ASPECT_RATIO = 3 / 4.5;
const MAX_WIDTH = 400;

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
    this._pendingRemoteLevelSaves = new Map();
    this._remoteLevelSyncFailures = new Map();
    this._editorSideSheetLayer = null;
    this._editorSideSheetIds = ['levelListOverlay', 'campaignOverlay', 'campaignEditOverlay', 'dialogueOverlay'];
    this._dialogueSelectedEntryId = null;
    this._dialoguePreviewState = null;
    this.dialogueLanguage = getStoredLanguage();
    this.dialogueController = new DialogueController({ visualLayout: this.visualLayout, persistSeen: false });

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
          <button id="dialogueBtn" class="admin-btn">Dialogues</button>
          <button id="addToTrainingBtn" class="admin-btn">Add to Training</button>
          <button id="themeDefaultBtn" class="admin-btn">Default Theme</button>
        </div>
        <div class="theme-section">
          <div class="theme-label">Levels</div>
          <button id="newLevelBtn" class="admin-btn">+ New Level</button>
          <button id="levelListBtn" class="admin-btn">Level List</button>
          <button id="campaignBtn" class="admin-btn">Campaigns</button>
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
          <button id="exportTrainingBtn" class="admin-btn">Export Training</button>
        </div>
      </div>
    `;
    viewport.appendChild(panel);
    this.adminPanel = panel;
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

    const margin = vpRect.width < 520 ? 6 : 12;
    const anchors = ['visualFrame', 'themePanel', 'adminPanel']
      .map(id => document.getElementById(id))
      .filter(el => el && el.offsetParent !== null);

    let contentRight = 0;
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      contentRight = Math.max(contentRight, rect.right - vpRect.left);
    }

    const maxWidth = Math.max(260, Math.min(360, vpRect.width - margin * 2));
    let width = maxWidth;
    let left = Math.max(margin, vpRect.width - width - margin);
    let docked = false;

    if (contentRight > 0) {
      const rightGap = vpRect.width - contentRight - margin;
      const dockWidth = Math.min(maxWidth, rightGap - margin);
      if (dockWidth >= 280) {
        width = dockWidth;
        left = contentRight + margin;
        docked = true;
      }
    }

    const top = margin;
    const bottom = margin;
    layer.dataset.docked = docked ? 'true' : 'false';

    for (const id of this._editorSideSheetIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.style.left = `${Math.round(left)}px`;
      el.style.right = 'auto';
      el.style.top = `${Math.round(top)}px`;
      el.style.bottom = `${Math.round(bottom)}px`;
      el.style.width = `${Math.round(width)}px`;
      el.classList.toggle('editor-side-sheet--docked', docked);
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
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      const level = this.levelManager.getCurrentLevel();
      if (!level) return;
      const safeName = (level.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
      const snapshot = cloneLevelSnapshot(level);
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
      const normalized = ensureLevelSurvival(level, worldH);
      const prevBackground = prev?.background || {};
      const nextBackground = normalized.background || {};
      if (
        !prev ||
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
        JSON.stringify(prevBackground.liquid || null) !== JSON.stringify(nextBackground.liquid || null)
      ) {
        this.levelManager.save();
      }
      if (this.editor) {
        this.editor.setSurvivalSettings(normalized);
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
        this.dialogueController.refreshLayout();
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

    // Flipper panel
    this.setupFlipperPanel();

    // Survival mode panel
    this.setupSurvivalPanel();
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
      const v = Math.max(0.5, Math.min(5.0, rawValue));
      this.editor.setSelectedPortalScale(v);
    };

    scaleSlider.addEventListener('input', () => {
      const v = parseInt(scaleSlider.value) / 10;
      scaleInput.value = v.toFixed(1);
      setScale(v);
    });

    scaleInput.addEventListener('input', () => {
      const v = parseFloat(scaleInput.value) || 1.0;
      scaleSlider.value = Math.max(5, Math.min(50, Math.round(v * 10)));
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
      this._setSurvivalSettingsVisible(toggle.checked);
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
      backgroundInput.addEventListener('change', () => {
        const file = backgroundInput.files && backgroundInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const image = typeof reader.result === 'string' ? reader.result : null;
          if (!image) return;
          this.updateLevelSurvivalSettings({
            background: { type: 'image', image, fit: 'cover', liquid: null }
          });
        };
        reader.readAsDataURL(file);
      });
    }
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

  setSurvivalPanelVisible(visible) {
    const panel = document.getElementById('survivalPanel');
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
        this.levelManager.updateCurrentLevel({ aimLength: value });
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
    if (options.save !== false) {
      this.levelManager.save();
    }
    this.applySurvivalSettingsToEditor();
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
    return type === 'bumper' || this._isPortalType(type);
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

    // Show/hide peg color picker
    this._syncPegColorPicker();
  }

  _syncPegColorPicker() {
    const row = document.getElementById('pegColorRow');
    const picker = document.getElementById('pegColorPicker');
    if (!row || !picker || !this.editor) return;

    const typeColors = {
      orange: '#ff6b35', blue: '#4ecdc4', green: '#95d5b2',
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
    this.updateLevelTitle();
    this.updateLevelSettings();
  }

  startEditor() {
    this.teardownGambleSystem();

    // Clean up ball counter
    if (this._unsubBallCounter) {
      this._unsubBallCounter();
      this._unsubBallCounter = null;
    }
    this.visualLayout.hideBallCounter();
    this.visualLayout.hideHealthBar();

    if (this.game) {
      this.game.stop();
      this.game = null;
    }

    this.mode = 'editor';
    this.editor = new Editor(this.canvas, this.levelManager);
    
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
    this._applyLevelVisuals();
    this.visualLayout.setSpinMode(false);
    this.visualLayout.setEditMode(false);
    this.visualLayout.setPanelVisible(true);
    if (this.adminPanel) this.adminPanel.classList.remove('hidden');
    this.resizeCanvas(); // re-fit frame with panel visible
    this._setDialogueControllerContextForCurrentLevel({ live: false, refreshPreview: true });
  }

  startGame() {
    this.closeDialogueEditor();
    this.teardownGambleSystem();

    if (this.editor) {
      this.visualLayout.setBallTrailPreview?.(false);
      this.visualLayout.setShockwavePreview?.(false);
      // Close panels if open
      this.closeAnimationPanel();
      this.closeBumperPanel();
      this.closePortalPanel();
      this.closeMultiballPanel();
      this.closeFlipperPanel();
      this.editor.stop();
      this.editor = null;
    }

    const level = this.levelManager.getCurrentLevel();
    if (!level || level.pegs.length === 0) {
      alert('Add some pegs first!');
      this.startEditor();
      return;
    }

    const survival = ensureLevelSurvival(level, this.canvas.height);
    if (!survival.enabled) {
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
    this.game.showPerfOverlay = true; // editor play mode shows debug info

    // Apply trajectory setting
    const trajectoryToggle = document.getElementById('trajectoryToggle');
    this.game.setShowFullTrajectory(trajectoryToggle.checked);

    // Resize to current dimensions
    this.resizeCanvas();

    this.game.loadLevel(level);
    this.game.setAimLength(typeof level.aimLength === 'number' ? level.aimLength : 300);
    
    this.game.onGameEnd = (result, score) => {
      setTimeout(() => {
        // Update play count
        level.metadata.playCount = (level.metadata.playCount || 0) + 1;
        this.levelManager.save();
        
        // Allow restart
        this.canvas.addEventListener('click', this.handleGameRestart, { once: true });
        this.canvas.addEventListener('touchstart', this.handleGameRestart, { once: true });
      }, 1000);
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
    });

    // Update UI
    document.getElementById('playBtn').innerHTML = '✏️';
    document.getElementById('playBtn').title = 'Back to Editor';
    document.querySelector('.toolbar').style.display = 'none';
    this.setSurvivalPanelVisible(false);
    this.setAimLengthPanelVisible(false);
    this._applyLevelVisuals();
    this.visualLayout.setEditMode(false);
    this.visualLayout.setPanelVisible(false);
    if (this.adminPanel) this.adminPanel.classList.add('hidden');
    this.resizeCanvas(); // re-fit frame without panel
    this._setDialogueControllerContextForCurrentLevel({ live: true, refreshPreview: false });
    this.mountGambleSystem();
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
  }

  teardownGambleSystem() {
    if (!this.gambleSystem) return;
    this.gambleSystem.dispose();
    this.gambleSystem = null;
    this.dialogueController.setGambleSystem(null);
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

    const snapshot = this._cloneLevelSnapshot(level);
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
    const aimVal = typeof level.aimLength === 'number' ? level.aimLength : 300;
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
    const curvePresetSelect = document.getElementById('survivalSpeedCurvePreset');
    if (curvePresetSelect) {
      curvePresetSelect.value = SURVIVAL_SPEED_CURVE_PRESETS[survival.speedCurve?.preset]
        ? survival.speedCurve.preset
        : 'custom';
    }
    this._drawSurvivalSpeedCurveEditor(survival.speedCurve);
    this._updateSurvivalBackgroundStatus(survival);
    this._setSurvivalSettingsVisible(!!survival.enabled);
    
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
    
    if (this.mode === 'editor' && this.editor) {
      this.editor.selectedPegIds.clear();
      this._dialogueSelectedEntryId = null;
      this._dialoguePreviewState = null;
      this._setDialogueControllerContextForCurrentLevel({ live: false, refreshPreview: true });
    }
  }

  showLevelList() {
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
                ${this._esc(this._formatDialogueLocaleSummary(entry))} · ${Math.round((entry.timeoutMs || 0) / 1000)}s${entry.once ? ' · once' : ' · repeat'}${entry.enabled ? '' : ' · disabled'}${isPreviewing ? ` · preview ${this._esc(previewState.language.toUpperCase())}` : ''}
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
          </div>
          <div class="dialogue-toggle-grid">
            <label class="dialogue-toggle"><input id="dialogueEnabledToggle" type="checkbox"${selectedEntry.enabled ? ' checked' : ''}> Enabled</label>
            <label class="dialogue-toggle"><input id="dialogueOnceToggle" type="checkbox"${selectedEntry.once ? ' checked' : ''}> Show once</label>
            <label class="dialogue-toggle"><input id="dialogueDismissShotToggle" type="checkbox"${selectedEntry.dismissOn?.shot ? ' checked' : ''}> Hide on shot</label>
            <label class="dialogue-toggle"><input id="dialogueDismissSpinToggle" type="checkbox"${selectedEntry.dismissOn?.spin ? ' checked' : ''}> Hide on spin</label>
          </div>
          <div class="dialogue-block-note">Dismiss only reacts to a real shot or a real spin start, not random taps.</div>
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
    this.closePhysicsSettings();

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

  exportLevel() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const json = this.levelManager.exportLevel(level.id);
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
    return cloneLevelSnapshot(level);
  }

  _readBakedLevelSnapshot(bakedName) {
    const raw = localStorage.getItem('baked:' + bakedName);
    if (!raw) return null;
    try {
      const snapshot = normalizeLevelData(JSON.parse(raw));
      if (!snapshot) return null;
      const normalizedRaw = JSON.stringify(snapshot);
      if (normalizedRaw !== raw) {
        localStorage.setItem('baked:' + bakedName, normalizedRaw);
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  _writeBakedLevelSnapshot(bakedName, snapshot) {
    const normalized = this._cloneLevelSnapshot(snapshot);
    if (!normalized) return null;
    localStorage.setItem('baked:' + bakedName, JSON.stringify(normalized));
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
    const ok = await this._trackPendingRemoteLevelSave(
      bakedName,
      api.saveLevel(bakedName, snapshot)
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
    const snapshot = this._writeBakedLevelSnapshot(bakedName, remoteLevel);
    return snapshot;
  }

  async _prepareCampaignEntryLevel(entry, editorLevels) {
    if (entry.source === 'editor') {
      const editorLevel = this._findEditorLevelByBakedName(entry.name, editorLevels);
      if (!editorLevel) {
        alert('Editor level not found: ' + (entry.displayName || entry.name));
        return false;
      }
      const snapshot = this._writeBakedLevelSnapshot(entry.name, editorLevel);
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

  async _ensureCampaignLevelsReadyForRemote(campaign) {
    const seen = new Set();
    for (const bakedName of campaign.levelNames) {
      if (!bakedName || seen.has(bakedName)) continue;
      seen.add(bakedName);

      let snapshot = this._readBakedLevelSnapshot(bakedName);
      if (!snapshot) {
        const editorLevel = this._findEditorLevelByBakedName(bakedName);
        if (editorLevel) {
          snapshot = this._writeBakedLevelSnapshot(bakedName, editorLevel);
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
      .then((primaryName) => {
        this._primaryCampaignName = typeof primaryName === 'string' && primaryName ? primaryName : null;
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
    this.closeDialogueEditor();
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
            const snapshot = this._writeBakedLevelSnapshot(name, editorLevel);
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

    const snapshot = this._writeBakedLevelSnapshot(bakedName, editorLevel);
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
