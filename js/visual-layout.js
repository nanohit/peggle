// Visual Layout - DOM frame, draggable asset slots, theme panel
// Wraps the canvas in a 9:17 frame with decorative elements and a side editor panel

import { DEFAULT_SHOCKWAVE_EFFECT, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS, DEFAULT_SHOCKWAVE_MAGNET_FIELD } from './shockwave-effect.js';
import { DEFAULT_END_SEQUENCE, SLOT_DEFS, DEFAULT_LAYER_ORDER, resolveAssetPaths, normalizeVisuals } from './visual-config.js';
import { compressImageFile } from './image-compression.js';
import { PortraitFlame, FLAME_BOX_EXTENT } from './portrait-flame.js';
import {
  assetCacheKey,
  assetCssUrl,
  assetDisplayUrl,
  isAssetImageSource,
  loadImageFromCandidates
} from './asset-ref.js';

const imageCache = new Map();

function loadImage(src) {
  if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { imageCache.set(src, img); resolve(img); };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function preloadAsset(basename) {
  const paths = resolveAssetPaths(basename);
  let img = await loadImage(paths.webp);
  if (img) return paths.webp;
  img = await loadImage(paths.png);
  if (img) return paths.png;
  return null;
}

async function resolveImageSource(source) {
  const result = await loadImageFromCandidates(source);
  return result ? result.url : '';
}

const FRAME_HEIGHT_RATIO = 17 / 9;
// Only the central character group + banner shift up in compact mode.
// topLeft/topRight/leftCircle/rightCircle stay put (they clip if shifted).
// itemCircle/ballCounter stay put (they're in the HUD area).
const COMPACT_TOP_SLOTS = new Set([
  'top',
  'characterCircle',
  'healthCircle',
  'healthCharCircle',
  'character',
]);

export class VisualLayout {
  constructor(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    this.viewport = null;
    this.frame = null;
    this.panel = null;
    this.slotElements = {};
    this.config = null;
    this.mounted = false;
    this.editMode = false;
    this.selectedSlotId = null;
    this._resolvedAssets = {};
    this._frameW = 0;
    this._frameH = 0;
    this._frameSqueeze = 1;
    this._compactShift = 0;
    this._abortController = null;
    this._slotRuntimeFx = {};
    this._characterPortraitRuntime = null;
    this._survivalProgressIndicator = null;
    this._survivalProgressState = null;
    this.gambleUiMode = false;
    this.gambleOverlayState = { open: false, target: null };
    this._includePanel = opts.includePanel !== false;
    this._enableEditorInteractions = opts.enableEditorInteractions !== false;
    this._previewFinalProgression = false;
    this._previewBallTrail = false;
    this._previewShockwave = false;
    this._pvpOpponentTargetState = null;
    this._pvpTargetLayer = null;
    this._pvpAimTimerState = null;
    this._pvpAimTimerRing = null;

    /** @type {function(object):void|null} */
    this.onConfigChange = null;
    /** @type {function(boolean):void|null} */
    this.onPreviewProgressionChange = null;
    /** @type {function(boolean):void|null} */
    this.onBallTrailPreviewChange = null;
    /** @type {function(boolean):void|null} */
    this.onShockwavePreviewChange = null;
  }

  mount() {
    if (this.mounted) return;
    const container = document.getElementById('canvasContainer');
    if (!container) return;

    this._abortController = new AbortController();
    const sig = this._abortController.signal;

    // Viewport wrapper (flex row: frame + panel)
    this.viewport = document.createElement('div');
    this.viewport.className = 'visual-viewport';
    this.viewport.id = 'visualViewport';

    // Frame (9:17, overflow hidden)
    this.frame = document.createElement('div');
    this.frame.className = 'visual-frame';
    this.frame.id = 'visualFrame';

    // Reparent: viewport replaces container in DOM, container goes inside frame
    container.parentNode.insertBefore(this.viewport, container);
    this.frame.appendChild(container);
    this.viewport.appendChild(this.frame);

    // Move editor side-panels out of canvas-container into the frame directly.
    // Frame has overflow:visible so they can pop out, and they position
    // relative to the frame (same dimensions as old canvas-container).
    this._reparentedPanels = [];
    const panelIds = ['animPanel', 'bumperPanel', 'flipperPanel', 'portalPanel', 'multiballPanel', 'modePanelStack', 'aimLengthPanel'];
    for (const pid of panelIds) {
      const panelEl = document.getElementById(pid);
      if (panelEl && container.contains(panelEl)) {
        this._reparentedPanels.push({ el: panelEl, originalParent: container });
        this.frame.appendChild(panelEl);
      }
    }

    // Background slot layer — behind canvas (z-index 0) for columns etc.
    this._slotBg = document.createElement('div');
    this._slotBg.className = 'visual-slot-bg';
    this.frame.appendChild(this._slotBg);

    // Slot clip layer — clips decorative assets to frame bounds (z-index 2, above canvas)
    this._slotClip = document.createElement('div');
    this._slotClip.className = 'visual-slot-clip';
    this.frame.appendChild(this._slotClip);

    // Create slot elements — column slots go in bg layer, rest in clip layer
    for (const def of SLOT_DEFS) {
      const el = document.createElement('div');
      el.className = 'visual-slot';
      el.dataset.slotId = def.id;
      if (def.column) {
        this._slotBg.appendChild(el);
      } else {
        this._slotClip.appendChild(el);
      }
      this.slotElements[def.id] = el;
    }

    // Ignite flame — white bonfire that engulfs the portrait circle and licks
    // upward (z-index 500 via CSS: in front of the banner/game field, behind the
    // portrait group). The canvas is a square box centred on the character circle
    // (see _layoutFlame).
    this._flame = new PortraitFlame(this._slotClip);
    this._layoutFlame();

    // Build theme panel (editor only)
    if (this._includePanel) {
      this._buildPanel();
    }

    // Slot interaction listeners (editor drag/scale)
    if (this._enableEditorInteractions) {
      this.frame.addEventListener('pointerdown', e => this._onPointerDown(e), { signal: sig });
      document.addEventListener('pointermove', e => this._onPointerMove(e), { signal: sig });
      document.addEventListener('pointerup', e => this._onPointerUp(e), { signal: sig });
      this.frame.addEventListener('wheel', e => this._onWheel(e), { passive: false, signal: sig });
    }

    this.mounted = true;
  }

  // ─── Ignite flame (white fire corona around the portrait circle) ─────────
  igniteFlame(intensity) {
    this._flame?.ignite(intensity);
  }

  setFlameHeat(intensity) {
    this._flame?.setHeat(intensity);
  }

  setFlamePreview(stage) {
    this._flame?.setPreview(stage);
  }

  // Position the flame canvas as a square box centred on the character circle,
  // sized FLAME_BOX_EXTENT× the circle diameter, using the SAME %-config the slot
  // uses (robust — no live rect measurement). The flame then draws centred.
  _layoutFlame() {
    const cv = this._flame?.canvas;
    const cfg = this.config?.slots?.characterCircle;
    const def = SLOT_DEFS.find(d => d.id === 'characterCircle');
    if (!cv || !cfg || !def) return;
    const boxWpct = def.baseWidth * (cfg.scale || 1) * FLAME_BOX_EXTENT;
    cv.style.left = cfg.x + '%';
    cv.style.top = this._getAdjustedSlotY('characterCircle', cfg.y) + '%';
    cv.style.width = boxWpct + '%';
  }

  dispose() {
    if (!this.mounted) return;
    if (this._abortController) this._abortController.abort();
    if (this._flame) { this._flame.dispose(); this._flame = null; }

    // Restore editor panels to canvas container
    if (this._reparentedPanels) {
      for (const { el, originalParent } of this._reparentedPanels) {
        originalParent.appendChild(el);
      }
      this._reparentedPanels = null;
    }

    const container = document.getElementById('canvasContainer');
    if (container && this.viewport?.parentNode) {
      this.viewport.parentNode.insertBefore(container, this.viewport);
      this.viewport.remove();
    }
    this.viewport = null;
    this.frame = null;
    this.panel = null;
    this._slotClip = null;
    this._slotBg = null;
    this._pvpTargetLayer = null;
    this._pvpOpponentTargetState = null;
    this._pvpAimTimerState = null;
    this._pvpAimTimerRing = null;
    this.slotElements = {};
    this._survivalProgressIndicator = null;
    this._survivalProgressState = null;
    this.mounted = false;
  }

  setConfig(rawConfig) {
    this.clearCharacterPortraitRuntime();
    this.config = normalizeVisuals(rawConfig);
    // Clear per-slot resolved assets so each level loads its own images fresh
    this._resolvedAssets = {};
    if (this.frame) this.frame.style.backgroundColor = '#000000';
    this._loadAndPositionSlots();
    this.updateSurvivalProgressIndicator(this._survivalProgressState);
    this._syncPanelValues();
  }

  setPreviewFinalProgression(enabled) {
    const next = !!enabled;
    if (this._previewFinalProgression === next) return;
    this._previewFinalProgression = next;
    this._syncProgressionPreviewButton();
    if (this.onPreviewProgressionChange) {
      this.onPreviewProgressionChange(this._previewFinalProgression);
    }
  }

  setBallTrailPreview(enabled) {
    const available = !!this.config?.ballTrail?.enabled;
    const next = !!enabled && available;
    if (this._previewBallTrail === next) return;
    this._previewBallTrail = next;
    this._syncBallTrailPreviewButton();
    if (this.onBallTrailPreviewChange) {
      this.onBallTrailPreviewChange(this._previewBallTrail);
    }
  }

  setShockwavePreview(enabled) {
    const available = !!this.config?.shockwave?.enabled;
    const next = !!enabled && available;
    if (this._previewShockwave === next) return;
    this._previewShockwave = next;
    this._syncShockwaveButtons();
    if (this.onShockwavePreviewChange) {
      this.onShockwavePreviewChange(this._previewShockwave);
    }
  }

  resize(frameW, frameH) {
    this._frameW = frameW;
    this._frameH = frameH;
    const prevShift = this._compactShift;
    const idealH = frameW > 0 ? frameW * FRAME_HEIGHT_RATIO : 0;
    const squeeze = idealH > 0 ? Math.min(1, frameH / idealH) : 1;
    this._frameSqueeze = squeeze;
    this._compactShift = Math.max(0, Math.min(6, (1 - squeeze) * 60));
    if (Math.abs(prevShift - this._compactShift) > 0.001) {
      this._refreshSlotPositions();
    }
    this._applyGambleOverlayState();
    this.updateSurvivalProgressIndicator(this._survivalProgressState);
    this._layoutFlame();
    this._flame?.resize();
  }

  setSpinMode(active) {
    if (this.frame) this.frame.classList.toggle('visual-frame--spin', !!active);
  }

  setEditMode(active) {
    this.editMode = !!active;
    if (this.frame) this.frame.classList.toggle('visual-frame--editing', this.editMode);
    if (!this.editMode) this.selectedSlotId = null;
    this._updateSlotInteractivity();
    this._refreshSlotPositions();
    this._applyLayerOrder();
    if (this.panel) {
      const btn = this.panel.querySelector('#themeEditBtn');
      if (btn) btn.textContent = this.editMode ? 'Done Editing' : 'Edit Layout';
    }
    if (this.editMode) {
      this._showDynamicSlotPreviews();
    } else {
      this._hideDynamicSlotPreviews();
      this._logSlotPositions();
    }
  }

  setPanelVisible(visible) {
    if (this.panel) this.panel.classList.toggle('hidden', !visible);
  }

  setGambleUiMode(active) {
    this.gambleUiMode = !!active;
    if (this.frame) this.frame.classList.toggle('visual-frame--gamble-ui', this.gambleUiMode);
    if (!this.gambleUiMode) {
      this.setGambleOverlayState({ open: false });
    } else {
      this._applyGambleOverlayState();
    }
  }

  setPvpMode(active) {
    if (this.frame) this.frame.classList.toggle('visual-frame--pvp', !!active);
    if (!active) {
      this.setPvpOpponentTarget(null);
      this.setPvpAimTimer(null);
    }
  }

  setBilliardTopLauncherActive(active = false) {
    this.frame?.classList.toggle('visual-frame--billiard-top-active', !!active);
  }

  setGambleOverlayState({ open = false, target = null } = {}) {
    this.gambleOverlayState = {
      open: !!open,
      target: target && Number.isFinite(target.centerX) && Number.isFinite(target.centerY)
        ? {
          centerX: target.centerX,
          centerY: target.centerY,
          scale: Number.isFinite(target.scale) ? target.scale : 1
        }
        : null
    };
    if (this.frame) this.frame.classList.toggle('visual-frame--gamble-open', this.gambleOverlayState.open);
    this._applyGambleOverlayState();
  }

  getSlotAssetUrl(slotId) {
    const def = SLOT_DEFS.find(item => item.id === slotId);
    if (!def || def.dynamic) return null;
    const slotCfg = this.config?.slots?.[slotId];
    if (slotCfg?.customSrc) return assetDisplayUrl(slotCfg.customSrc);
    if (this._resolvedAssets[slotId]) return this._resolvedAssets[slotId];
    if (!def.basename) return null;
    return resolveAssetPaths(def.basename).webp;
  }

  getBackground() {
    return this.config?.background || null;
  }

  setSlotRuntimeFx(slotId, fx) {
    this._setSlotRuntimeFx(slotId, fx);
  }

  clearSlotRuntimeFx(slotId) {
    this._setSlotRuntimeFx(slotId, null);
  }

  setCharacterPortraitSource(src, options = {}) {
    const el = this.slotElements.character;
    if (!el || !isAssetImageSource(src)) return;
    const sourceKey = assetCacheKey(src);
    const source = assetDisplayUrl(src);
    if (!sourceKey || !source) return;
    const fadeMs = Math.max(0, Math.min(2000, Number(options.fadeMs) || 0));
    const cssUrl = assetCssUrl(src) || this._cssUrl(source);

    if (!this._characterPortraitRuntime) {
      this._characterPortraitRuntime = {
        activeSrc: null,
        activeLayer: null,
        cleanupTimer: null
      };
      el.classList.add('visual-slot--portrait-runtime');
      el.style.backgroundImage = 'none';
    }

    const runtime = this._characterPortraitRuntime;
    if (runtime.activeSrc === sourceKey) return;

    const nextLayer = document.createElement('div');
    nextLayer.className = 'visual-portrait-layer';
    nextLayer.dataset.emotionSlot = options.slotName || '';
    nextLayer.style.backgroundImage = cssUrl;
    nextLayer.style.transitionDuration = `${fadeMs}ms`;
    nextLayer.style.opacity = fadeMs > 0 ? '0' : '1';
    el.appendChild(nextLayer);

    const previousLayer = runtime.activeLayer;
    runtime.activeLayer = nextLayer;
    runtime.activeSrc = sourceKey;

    resolveImageSource(src).then(resolvedUrl => {
      if (!resolvedUrl || runtime.activeSrc !== sourceKey || runtime.activeLayer !== nextLayer) return;
      nextLayer.style.backgroundImage = this._cssUrl(resolvedUrl);
    });

    if (runtime.cleanupTimer) {
      clearTimeout(runtime.cleanupTimer);
      runtime.cleanupTimer = null;
    }
    el.querySelectorAll?.('.visual-portrait-layer').forEach(layer => {
      if (layer !== previousLayer && layer !== nextLayer) layer.remove();
    });

    if (fadeMs > 0) {
      requestAnimationFrame(() => {
        nextLayer.style.opacity = '1';
        if (previousLayer) {
          previousLayer.style.transitionDuration = '0ms';
          previousLayer.style.opacity = '1';
        }
      });
      runtime.cleanupTimer = setTimeout(() => {
        el.querySelectorAll?.('.visual-portrait-layer').forEach(layer => {
          if (layer !== runtime.activeLayer) layer.remove();
        });
        runtime.cleanupTimer = null;
      }, fadeMs + 60);
    } else if (previousLayer?.parentNode) {
      previousLayer.parentNode.removeChild(previousLayer);
    }
  }

  clearCharacterPortraitRuntime() {
    const runtime = this._characterPortraitRuntime;
    if (runtime?.cleanupTimer) clearTimeout(runtime.cleanupTimer);
    const el = this.slotElements?.character;
    if (el) {
      el.classList.remove('visual-slot--portrait-runtime');
      el.querySelectorAll?.('.visual-portrait-layer').forEach(layer => layer.remove());
    }
    this._characterPortraitRuntime = null;
  }

  // ─── Panel ────────────────────────────────────────────

  _buildPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'theme-panel';
    this.panel.id = 'themePanel';
    this.panel.innerHTML = `
      <div class="theme-panel-title">Theme</div>
      <div class="theme-panel-body">
        <div class="theme-section">
          <div class="theme-label">Background</div>
          <div class="theme-row">
            <span class="theme-row-label">Type</span>
            <select id="themeBgType" class="theme-select">
              <option value="image">Image</option>
              <option value="gradient">Gradient</option>
              <option value="solid">Solid</option>
              <option value="liquid">Liquid</option>
            </select>
          </div>
          <div class="theme-row" id="themeBgImageRow">
            <span class="theme-row-label">Image</span>
            <div class="theme-row-actions">
              <button id="themeBgImageBtn" class="theme-row-btn">Upload</button>
            </div>
          </div>
          <div class="theme-row" id="themeBgProgressRow">
            <span class="theme-row-label">Progress</span>
            <div class="theme-row-actions">
              <span id="themeBgProgressState" class="theme-row-state">Optional</span>
              <button id="themeBgProgressBtn" class="theme-row-btn">Upload</button>
              <button id="themeBgProgressClearBtn" class="theme-row-btn theme-row-btn--secondary">Clear</button>
            </div>
          </div>
          <div class="theme-row" id="themeBgTopRow">
            <span class="theme-row-label">Top</span>
            <input type="color" id="themeBgTop" value="#16213e" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgBottomRow">
            <span class="theme-row-label">Bottom</span>
            <input type="color" id="themeBgBottom" value="#1a1a2e" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgDarkenRow">
            <span class="theme-row-label">Darken</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgDarken" class="theme-row-range" min="0" max="100" value="50">
              <span id="themeBgDarkenValue" class="theme-range-value">50%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidBaseRow">
            <span class="theme-row-label">Base</span>
            <input type="color" id="themeBgLiquidBase" value="#05020f" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgLiquidMidRow">
            <span class="theme-row-label">Mid</span>
            <input type="color" id="themeBgLiquidMid" value="#24104f" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgLiquidAccentRow">
            <span class="theme-row-label">Accent</span>
            <input type="color" id="themeBgLiquidAccent" value="#8d63ff" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgLiquidScaleRow">
            <span class="theme-row-label">Scale</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidScale" class="theme-row-range" min="50" max="200" value="100">
              <span id="themeBgLiquidScaleValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidRoughnessRow">
            <span class="theme-row-label">Rough</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidRoughness" class="theme-row-range" min="0" max="100" value="58">
              <span id="themeBgLiquidRoughnessValue" class="theme-range-value">58%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidDistortionRow">
            <span class="theme-row-label">Distort</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidDistortion" class="theme-row-range" min="0" max="200" value="100">
              <span id="themeBgLiquidDistortionValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidLacunarityRow">
            <span class="theme-row-label">Lacunarity</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidLacunarity" class="theme-row-range" min="160" max="310" value="225">
              <span id="themeBgLiquidLacunarityValue" class="theme-range-value">2.25</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidTrailRow">
            <span class="theme-row-label">Trail</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidTrail" class="theme-row-range" min="0" max="200" value="100">
              <span id="themeBgLiquidTrailValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidMotionRow">
            <span class="theme-row-label">Motion</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidMotion" class="theme-row-range" min="0" max="100" value="44">
              <span id="themeBgLiquidMotionValue" class="theme-range-value">44%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidReactionRow">
            <span class="theme-row-label">React</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidReaction" class="theme-row-range" min="0" max="200" value="82">
              <span id="themeBgLiquidReactionValue" class="theme-range-value">82%</span>
            </div>
          </div>
          <div class="theme-label" id="themeBgLiquidProgressionLabel">Liquid Progression</div>
          <div class="theme-row" id="themeBgLiquidProgResetRow">
            <span class="theme-row-label">Copy Base to 2nd</span>
            <button id="themeBgLiquidProgResetBtn" class="theme-row-btn theme-row-btn--secondary">Match Base</button>
          </div>
          <div class="theme-row" id="themeBgLiquidProgBaseRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgBaseEnabled"> Base 2</label>
            <input type="color" id="themeBgLiquidProgBase" value="#05020f" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgLiquidProgMidRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgMidEnabled"> Mid 2</label>
            <input type="color" id="themeBgLiquidProgMid" value="#24104f" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgLiquidProgAccentRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgAccentEnabled"> Accent 2</label>
            <input type="color" id="themeBgLiquidProgAccent" value="#8d63ff" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgLiquidProgScaleRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgScaleEnabled"> Scale 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgScale" class="theme-row-range" min="50" max="200" value="100">
              <span id="themeBgLiquidProgScaleValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidProgRoughnessRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgRoughnessEnabled"> Rough 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgRoughness" class="theme-row-range" min="0" max="100" value="58">
              <span id="themeBgLiquidProgRoughnessValue" class="theme-range-value">58%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidProgDistortionRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgDistortionEnabled"> Distort 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgDistortion" class="theme-row-range" min="0" max="200" value="100">
              <span id="themeBgLiquidProgDistortionValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidProgLacunarityRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgLacunarityEnabled"> Lacunarity 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgLacunarity" class="theme-row-range" min="160" max="310" value="225">
              <span id="themeBgLiquidProgLacunarityValue" class="theme-range-value">2.25</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidProgTrailRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgTrailEnabled"> Trail 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgTrail" class="theme-row-range" min="0" max="200" value="100">
              <span id="themeBgLiquidProgTrailValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidProgMotionRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgMotionEnabled"> Motion 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgMotion" class="theme-row-range" min="0" max="100" value="44">
              <span id="themeBgLiquidProgMotionValue" class="theme-range-value">44%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBgLiquidProgReactionRow">
            <label class="theme-row-label"><input type="checkbox" id="themeBgLiquidProgReactionEnabled"> React 2</label>
            <div class="theme-row-actions">
              <input type="range" id="themeBgLiquidProgReaction" class="theme-row-range" min="0" max="200" value="82">
              <span id="themeBgLiquidProgReactionValue" class="theme-range-value">82%</span>
            </div>
          </div>
        </div>
        <div class="theme-section">
          <div class="theme-label">Ball Trail</div>
          <div class="theme-row">
            <label class="theme-row-label"><input type="checkbox" id="themeBallTrailEnabled"> Enabled</label>
            <button id="themeBallTrailPreviewBtn" class="theme-row-btn theme-row-btn--secondary">Preview Tail</button>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Color</span>
            <input type="color" id="themeBallTrailColor" value="#f8f9fa" class="theme-color">
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Length</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailLength" class="theme-row-range" min="20" max="260" value="31">
              <span id="themeBallTrailLengthValue" class="theme-range-value">31%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Width</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailWidth" class="theme-row-range" min="35" max="260" value="70">
              <span id="themeBallTrailWidthValue" class="theme-range-value">70%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Glow</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailGlow" class="theme-row-range" min="0" max="240" value="0">
              <span id="themeBallTrailGlowValue" class="theme-range-value">0%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Opacity</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailOpacity" class="theme-row-range" min="0" max="150" value="32">
              <span id="themeBallTrailOpacityValue" class="theme-range-value">32%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Flow</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailTurbulence" class="theme-row-range" min="0" max="180" value="0">
              <span id="themeBallTrailTurbulenceValue" class="theme-range-value">0%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Smooth</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailSmoothing" class="theme-row-range" min="0" max="100" value="100">
              <span id="themeBallTrailSmoothingValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-label">Trail Progression</div>
          <div class="theme-row">
            <label class="theme-row-label"><input type="checkbox" id="themeBallTrailProgEnabled"> Use 2nd set</label>
            <button id="themeBallTrailProgMatchBtn" class="theme-row-btn theme-row-btn--secondary">Match Base</button>
          </div>
          <div class="theme-row" id="themeBallTrailProgColorRow">
            <span class="theme-row-label">Color 2</span>
            <input type="color" id="themeBallTrailProgColor" value="#f8f9fa" class="theme-color">
          </div>
          <div class="theme-row" id="themeBallTrailProgLengthRow">
            <span class="theme-row-label">Length 2</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailProgLength" class="theme-row-range" min="20" max="260" value="31">
              <span id="themeBallTrailProgLengthValue" class="theme-range-value">31%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBallTrailProgWidthRow">
            <span class="theme-row-label">Width 2</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailProgWidth" class="theme-row-range" min="35" max="260" value="70">
              <span id="themeBallTrailProgWidthValue" class="theme-range-value">70%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBallTrailProgGlowRow">
            <span class="theme-row-label">Glow 2</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailProgGlow" class="theme-row-range" min="0" max="240" value="0">
              <span id="themeBallTrailProgGlowValue" class="theme-range-value">0%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBallTrailProgOpacityRow">
            <span class="theme-row-label">Opacity 2</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailProgOpacity" class="theme-row-range" min="0" max="150" value="32">
              <span id="themeBallTrailProgOpacityValue" class="theme-range-value">32%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBallTrailProgTurbulenceRow">
            <span class="theme-row-label">Flow 2</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailProgTurbulence" class="theme-row-range" min="0" max="180" value="0">
              <span id="themeBallTrailProgTurbulenceValue" class="theme-range-value">0%</span>
            </div>
          </div>
          <div class="theme-row" id="themeBallTrailProgSmoothingRow">
            <span class="theme-row-label">Smooth 2</span>
            <div class="theme-row-actions">
              <input type="range" id="themeBallTrailProgSmoothing" class="theme-row-range" min="0" max="100" value="100">
              <span id="themeBallTrailProgSmoothingValue" class="theme-range-value">100%</span>
            </div>
          </div>
        </div>
        <div class="theme-section">
          <div class="theme-label">Shockwave</div>
          <div class="theme-row">
            <label class="theme-row-label"><input type="checkbox" id="themeShockwaveEnabled"> Enabled</label>
            <button id="themeShockwavePreviewBtn" class="theme-row-btn theme-row-btn--secondary">Preview Wave</button>
          </div>
          <div class="theme-row">
            <label class="theme-row-label"><input type="checkbox" id="themeShockwaveBomb"> Bomb hits</label>
            <label class="theme-row-label"><input type="checkbox" id="themeShockwaveBombTargets"> Each bomb peg</label>
            <label class="theme-row-label"><input type="checkbox" id="themeShockwaveVictory"> Final peg</label>
          </div>
          <div class="theme-row">
            <label class="theme-row-label"><input type="checkbox" id="themeShockwaveVictorySeparate"> Separate final peg</label>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Color</span>
            <input type="color" id="themeShockwaveColor" value="#ffffff" class="theme-color">
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Radius</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveRadius" class="theme-row-range" min="35" max="260" value="100">
              <span id="themeShockwaveRadiusValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Strength</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveStrength" class="theme-row-range" min="0" max="280" value="100">
              <span id="themeShockwaveStrengthValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Width</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveWidth" class="theme-row-range" min="25" max="240" value="100">
              <span id="themeShockwaveWidthValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Duration</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveDuration" class="theme-row-range" min="22" max="180" value="82">
              <span id="themeShockwaveDurationValue" class="theme-range-value">0.82s</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Ripple</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveRipple" class="theme-row-range" min="0" max="240" value="100">
              <span id="themeShockwaveRippleValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row">
            <span class="theme-row-label">Opacity</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveOpacity" class="theme-row-range" min="0" max="120" value="86">
              <span id="themeShockwaveOpacityValue" class="theme-range-value">86%</span>
            </div>
          </div>
          <div class="theme-row" id="themeShockwaveVictoryColorRow">
            <span class="theme-row-label">Final Color</span>
            <input type="color" id="themeShockwaveVictoryColor" value="#ffffff" class="theme-color">
          </div>
          <div class="theme-row" id="themeShockwaveVictoryRadiusRow">
            <span class="theme-row-label">Final Radius</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveVictoryRadius" class="theme-row-range" min="35" max="260" value="100">
              <span id="themeShockwaveVictoryRadiusValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeShockwaveVictoryStrengthRow">
            <span class="theme-row-label">Final Strength</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveVictoryStrength" class="theme-row-range" min="0" max="280" value="100">
              <span id="themeShockwaveVictoryStrengthValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeShockwaveVictoryWidthRow">
            <span class="theme-row-label">Final Width</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveVictoryWidth" class="theme-row-range" min="25" max="240" value="100">
              <span id="themeShockwaveVictoryWidthValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeShockwaveVictoryDurationRow">
            <span class="theme-row-label">Final Duration</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveVictoryDuration" class="theme-row-range" min="22" max="180" value="82">
              <span id="themeShockwaveVictoryDurationValue" class="theme-range-value">0.82s</span>
            </div>
          </div>
          <div class="theme-row" id="themeShockwaveVictoryRippleRow">
            <span class="theme-row-label">Final Ripple</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveVictoryRipple" class="theme-row-range" min="0" max="240" value="100">
              <span id="themeShockwaveVictoryRippleValue" class="theme-range-value">100%</span>
            </div>
          </div>
          <div class="theme-row" id="themeShockwaveVictoryOpacityRow">
            <span class="theme-row-label">Final Opacity</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveVictoryOpacity" class="theme-row-range" min="0" max="120" value="86">
              <span id="themeShockwaveVictoryOpacityValue" class="theme-range-value">86%</span>
            </div>
          </div>
          <div class="theme-row">
            <label class="theme-row-label"><input type="checkbox" id="themeShockwaveMagnetField"> Magnet field ring</label>
          </div>
          <div class="theme-row" id="themeShockwaveMagnetFieldIntensityRow">
            <span class="theme-row-label">Field Intensity</span>
            <div class="theme-row-actions">
              <input type="range" id="themeShockwaveMagnetFieldIntensity" class="theme-row-range" min="0" max="250" value="100">
              <span id="themeShockwaveMagnetFieldIntensityValue" class="theme-range-value">100%</span>
            </div>
          </div>
        </div>
        <div class="theme-section">
          <div class="theme-label">End Slow-Mo</div>
          <div class="theme-row">
            <span class="theme-row-label">Strength</span>
            <div class="theme-row-actions">
              <input type="range" id="themeEndSlowmoStrength" class="theme-row-range" min="0" max="100" value="40">
              <span id="themeEndSlowmoStrengthValue" class="theme-range-value">40%</span>
              <button id="themeEndSlowmoSetDefaultBtn" class="theme-row-btn theme-row-btn--secondary">Set as default</button>
            </div>
          </div>
        </div>
        <div class="theme-section" style="display:none">
          <div class="theme-label">Frame</div>
          <div class="theme-row">
            <span class="theme-row-label">Color</span>
            <input type="color" id="themeFrameColor" value="#0a0a14" class="theme-color">
          </div>
        </div>
        <div class="theme-section">
          <div class="theme-label">Assets</div>
          <button id="themePreviewProgressBtn" class="theme-edit-btn">Preview Final State</button>
          <button id="themeEditBtn" class="theme-edit-btn">Edit Layout</button>
          <div id="themeSlotList" class="theme-slot-list"></div>
          <button id="themeApplyLevelBtn" class="theme-edit-btn" style="margin-top:6px">Apply for Level</button>
          <button id="themeAssignDefaultBtn" class="theme-edit-btn">Assign Default</button>
          <button id="themeRestoreDefaultBtn" class="theme-edit-btn">Restore Default</button>
        </div>
      </div>
    `;
    this.viewport.appendChild(this.panel);
    this._wirePanelEvents();
  }

  _wirePanelEvents() {
    const sig = this._abortController.signal;

    this.panel.querySelector('#themeBgType').addEventListener('change', e => {
      if (!this.config) return;
      this.config.background.type = e.target.value;
      this._syncBgRowVisibility();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgImageBtn').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async ev => {
        const file = ev.target.files[0];
        if (!file || !this.config) return;
        // Background covers full canvas (400×600), allow larger max size
        const dataUrl = await compressImageFile(file, {
          maxWidth: 800,
          maxHeight: 800,
          quality: 0.8,
          fallbackType: 'image/jpeg',
          maxDataUrlBytes: 420 * 1024
        });
        if (!dataUrl) return;
        this.config.background.image = dataUrl;
        this._emitChange();
      };
      input.click();
    }, { signal: sig });

    this.panel.querySelector('#themeBgProgressBtn').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async ev => {
        const file = ev.target.files[0];
        if (!file || !this.config) return;
        const dataUrl = await compressImageFile(file, {
          maxWidth: 800,
          maxHeight: 800,
          quality: 0.8,
          fallbackType: 'image/jpeg',
          maxDataUrlBytes: 420 * 1024
        });
        if (!dataUrl) return;
        this.config.background.progressionImage = dataUrl;
        this._syncProgressBgButtons();
        this._emitChange();
      };
      input.click();
    }, { signal: sig });

    this.panel.querySelector('#themeBgProgressClearBtn').addEventListener('click', () => {
      if (!this.config || !this.config.background.progressionImage) return;
      this.config.background.progressionImage = null;
      this._syncProgressBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgTop').addEventListener('input', e => {
      if (!this.config) return;
      this.config.background.colorTop = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgBottom').addEventListener('input', e => {
      if (!this.config) return;
      this.config.background.colorBottom = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgDarken').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
      this.config.background.darken = value / 100;
      this._syncBackgroundButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidBase').addEventListener('input', e => {
      if (!this.config) return;
      this.config.background.liquid.colorBase = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidMid').addEventListener('input', e => {
      if (!this.config) return;
      this.config.background.liquid.colorMid = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidAccent').addEventListener('input', e => {
      if (!this.config) return;
      this.config.background.liquid.colorAccent = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidScale').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(50, Math.min(200, parseInt(e.target.value, 10) || 100));
      this.config.background.liquid.scale = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidRoughness').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
      this.config.background.liquid.roughness = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidDistortion').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0));
      this.config.background.liquid.distortion = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidLacunarity').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(160, Math.min(310, parseInt(e.target.value, 10) || 0));
      this.config.background.liquid.lacunarity = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidTrail').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0));
      this.config.background.liquid.trail = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidMotion').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
      this.config.background.liquid.motion = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBgLiquidReaction').addEventListener('input', e => {
      if (!this.config) return;
      const value = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0));
      this.config.background.liquid.reaction = value / 100;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    const ensureLiquidProgression = () => {
      if (!this.config?.background?.liquid) return null;
      if (!this.config.background.liquid.progression || typeof this.config.background.liquid.progression !== 'object') {
        this.config.background.liquid.progression = {
          colorBase: null,
          colorMid: null,
          colorAccent: null,
          scale: null,
          roughness: null,
          distortion: null,
          lacunarity: null,
          trail: null,
          motion: null,
          reaction: null,
        };
      }
      return this.config.background.liquid.progression;
    };

    const copyLiquidBaseToProgression = () => {
      if (!this.config?.background?.liquid) return null;
      const liquid = this.config.background.liquid;
      const progression = ensureLiquidProgression();
      if (!progression) return null;
      progression.colorBase = liquid.colorBase ?? '#05020f';
      progression.colorMid = liquid.colorMid ?? '#24104f';
      progression.colorAccent = liquid.colorAccent ?? '#8d63ff';
      progression.scale = liquid.scale ?? 1;
      progression.roughness = liquid.roughness ?? 0.58;
      progression.distortion = liquid.distortion ?? 1;
      progression.lacunarity = liquid.lacunarity ?? 2.25;
      progression.trail = liquid.trail ?? 1;
      progression.motion = liquid.motion ?? 0.44;
      progression.reaction = liquid.reaction ?? 0.82;
      return progression;
    };

    const wireLiquidProgressColor = (enabledId, inputId, key, baseKey) => {
      this.panel.querySelector(enabledId).addEventListener('change', e => {
        if (!this.config) return;
        const progression = ensureLiquidProgression();
        if (!progression) return;
        progression[key] = e.target.checked ? (progression[key] || this.config.background.liquid[baseKey]) : null;
        this._syncLiquidBgButtons();
        this._emitChange();
      }, { signal: sig });

      this.panel.querySelector(inputId).addEventListener('input', e => {
        if (!this.config) return;
        const progression = ensureLiquidProgression();
        if (!progression || progression[key] === null) return;
        progression[key] = e.target.value;
        this._syncLiquidBgButtons();
        this._emitChange();
      }, { signal: sig });
    };

    const wireLiquidProgressRange = (enabledId, inputId, key, baseKey, min, max, fallback, transform = value => value / 100) => {
      this.panel.querySelector(enabledId).addEventListener('change', e => {
        if (!this.config) return;
        const progression = ensureLiquidProgression();
        if (!progression) return;
        progression[key] = e.target.checked ? (progression[key] ?? this.config.background.liquid[baseKey] ?? fallback) : null;
        this._syncLiquidBgButtons();
        this._emitChange();
      }, { signal: sig });

      this.panel.querySelector(inputId).addEventListener('input', e => {
        if (!this.config) return;
        const progression = ensureLiquidProgression();
        if (!progression || progression[key] === null) return;
        const raw = parseInt(e.target.value, 10);
        const value = Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : fallback));
        progression[key] = transform(value);
        this._syncLiquidBgButtons();
        this._emitChange();
      }, { signal: sig });
    };

    wireLiquidProgressColor('#themeBgLiquidProgBaseEnabled', '#themeBgLiquidProgBase', 'colorBase', 'colorBase');
    wireLiquidProgressColor('#themeBgLiquidProgMidEnabled', '#themeBgLiquidProgMid', 'colorMid', 'colorMid');
    wireLiquidProgressColor('#themeBgLiquidProgAccentEnabled', '#themeBgLiquidProgAccent', 'colorAccent', 'colorAccent');
    wireLiquidProgressRange('#themeBgLiquidProgScaleEnabled', '#themeBgLiquidProgScale', 'scale', 'scale', 50, 200, 100);
    wireLiquidProgressRange('#themeBgLiquidProgRoughnessEnabled', '#themeBgLiquidProgRoughness', 'roughness', 'roughness', 0, 100, 58);
    wireLiquidProgressRange('#themeBgLiquidProgDistortionEnabled', '#themeBgLiquidProgDistortion', 'distortion', 'distortion', 0, 200, 100);
    wireLiquidProgressRange('#themeBgLiquidProgLacunarityEnabled', '#themeBgLiquidProgLacunarity', 'lacunarity', 'lacunarity', 160, 310, 225);
    wireLiquidProgressRange('#themeBgLiquidProgTrailEnabled', '#themeBgLiquidProgTrail', 'trail', 'trail', 0, 200, 100);
    wireLiquidProgressRange('#themeBgLiquidProgMotionEnabled', '#themeBgLiquidProgMotion', 'motion', 'motion', 0, 100, 44);
    wireLiquidProgressRange('#themeBgLiquidProgReactionEnabled', '#themeBgLiquidProgReaction', 'reaction', 'reaction', 0, 200, 82);

    this.panel.querySelector('#themeBgLiquidProgResetBtn').addEventListener('click', () => {
      if (!copyLiquidBaseToProgression()) return;
      this._syncLiquidBgButtons();
      this._emitChange();
    }, { signal: sig });

    const ensureBallTrail = () => {
      if (!this.config) return null;
      if (!this.config.ballTrail || typeof this.config.ballTrail !== 'object') {
        this.config.ballTrail = normalizeVisuals({ ballTrail: {} }, true).ballTrail;
      }
      if (!this.config.ballTrail.progression || typeof this.config.ballTrail.progression !== 'object') {
        this.config.ballTrail.progression = {
          enabled: false,
          color: this.config.ballTrail.color || '#f8f9fa',
          length: this.config.ballTrail.length ?? 0.31,
          width: this.config.ballTrail.width ?? 0.7,
          glow: this.config.ballTrail.glow ?? 0,
          opacity: this.config.ballTrail.opacity ?? 0.32,
          turbulence: this.config.ballTrail.turbulence ?? 0,
          smoothing: this.config.ballTrail.smoothing ?? 1
        };
      }
      return this.config.ballTrail;
    };

    const setTrailRange = (key, rawValue) => {
      const trail = ensureBallTrail();
      if (!trail) return;
      const value = Math.max(0, parseInt(rawValue, 10) || 0) / 100;
      trail[key] = value;
      this._syncBallTrailButtons();
      this._emitChange();
    };

    const setTrailProgressRange = (key, rawValue) => {
      const trail = ensureBallTrail();
      if (!trail?.progression) return;
      const value = Math.max(0, parseInt(rawValue, 10) || 0) / 100;
      trail.progression[key] = value;
      this._syncBallTrailButtons();
      this._emitChange();
    };

    this.panel.querySelector('#themeBallTrailEnabled').addEventListener('change', e => {
      const trail = ensureBallTrail();
      if (!trail) return;
      trail.enabled = !!e.target.checked;
      if (!trail.enabled) this.setBallTrailPreview(false);
      this._syncBallTrailButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBallTrailPreviewBtn').addEventListener('click', () => {
      this.setBallTrailPreview(!this._previewBallTrail);
    }, { signal: sig });

    this.panel.querySelector('#themeBallTrailColor').addEventListener('input', e => {
      const trail = ensureBallTrail();
      if (!trail) return;
      trail.color = e.target.value;
      this._syncBallTrailButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBallTrailLength').addEventListener('input', e => setTrailRange('length', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailWidth').addEventListener('input', e => setTrailRange('width', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailGlow').addEventListener('input', e => setTrailRange('glow', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailOpacity').addEventListener('input', e => setTrailRange('opacity', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailTurbulence').addEventListener('input', e => setTrailRange('turbulence', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailSmoothing').addEventListener('input', e => setTrailRange('smoothing', e.target.value), { signal: sig });

    this.panel.querySelector('#themeBallTrailProgEnabled').addEventListener('change', e => {
      const trail = ensureBallTrail();
      if (!trail?.progression) return;
      trail.progression.enabled = !!e.target.checked;
      this._syncBallTrailButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBallTrailProgMatchBtn').addEventListener('click', () => {
      const trail = ensureBallTrail();
      if (!trail?.progression) return;
      trail.progression.color = trail.color;
      trail.progression.length = trail.length;
      trail.progression.width = trail.width;
      trail.progression.glow = trail.glow;
      trail.progression.opacity = trail.opacity;
      trail.progression.turbulence = trail.turbulence;
      trail.progression.smoothing = trail.smoothing;
      this._syncBallTrailButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBallTrailProgColor').addEventListener('input', e => {
      const trail = ensureBallTrail();
      if (!trail?.progression) return;
      trail.progression.color = e.target.value;
      this._syncBallTrailButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeBallTrailProgLength').addEventListener('input', e => setTrailProgressRange('length', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailProgWidth').addEventListener('input', e => setTrailProgressRange('width', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailProgGlow').addEventListener('input', e => setTrailProgressRange('glow', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailProgOpacity').addEventListener('input', e => setTrailProgressRange('opacity', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailProgTurbulence').addEventListener('input', e => setTrailProgressRange('turbulence', e.target.value), { signal: sig });
    this.panel.querySelector('#themeBallTrailProgSmoothing').addEventListener('input', e => setTrailProgressRange('smoothing', e.target.value), { signal: sig });

    const ensureShockwave = () => {
      if (!this.config) return null;
      if (!this.config.shockwave || typeof this.config.shockwave !== 'object') {
        this.config.shockwave = normalizeVisuals({ shockwave: {} }, true).shockwave;
      }
      return this.config.shockwave;
    };
    const ensureEndSequence = () => {
      if (!this.config) return null;
      if (!this.config.endSequence || typeof this.config.endSequence !== 'object') {
        this.config.endSequence = normalizeVisuals({ endSequence: {} }, true).endSequence;
      }
      return this.config.endSequence;
    };
    const ensureShockwaveVictorySettings = (shockwave) => {
      if (!shockwave) return null;
      if (!shockwave.victorySettings || typeof shockwave.victorySettings !== 'object') {
        shockwave.victorySettings = {
          color: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.color,
          radius: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.radius,
          strength: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.strength,
          width: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.width,
          duration: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.duration,
          ripple: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.ripple,
          opacity: DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.opacity
        };
      }
      return shockwave.victorySettings;
    };

    const setShockwaveRange = (key, rawValue) => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      shockwave[key] = Math.max(0, parseInt(rawValue, 10) || 0) / 100;
      this._syncShockwaveButtons();
      this._emitChange();
    };
    const setShockwaveVictoryRange = (key, rawValue) => {
      const shockwave = ensureShockwave();
      const victorySettings = ensureShockwaveVictorySettings(shockwave);
      if (!victorySettings) return;
      victorySettings[key] = Math.max(0, parseInt(rawValue, 10) || 0) / 100;
      this._syncShockwaveButtons();
      this._emitChange();
    };

    this.panel.querySelector('#themeShockwaveEnabled').addEventListener('change', e => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      shockwave.enabled = !!e.target.checked;
      if (!shockwave.enabled) this.setShockwavePreview(false);
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwavePreviewBtn').addEventListener('click', () => {
      this.setShockwavePreview(!this._previewShockwave);
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveBomb').addEventListener('change', e => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      shockwave.bomb = !!e.target.checked;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveBombTargets').addEventListener('change', e => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      shockwave.bombTargets = !!e.target.checked;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveVictory').addEventListener('change', e => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      shockwave.victory = !!e.target.checked;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveVictorySeparate').addEventListener('change', e => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      ensureShockwaveVictorySettings(shockwave);
      shockwave.victorySeparate = !!e.target.checked;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveColor').addEventListener('input', e => {
      const shockwave = ensureShockwave();
      if (!shockwave) return;
      shockwave.color = e.target.value;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveVictoryColor').addEventListener('input', e => {
      const shockwave = ensureShockwave();
      const victorySettings = ensureShockwaveVictorySettings(shockwave);
      if (!victorySettings) return;
      victorySettings.color = e.target.value;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeShockwaveRadius').addEventListener('input', e => setShockwaveRange('radius', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveStrength').addEventListener('input', e => setShockwaveRange('strength', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveWidth').addEventListener('input', e => setShockwaveRange('width', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveDuration').addEventListener('input', e => setShockwaveRange('duration', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveRipple').addEventListener('input', e => setShockwaveRange('ripple', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveOpacity').addEventListener('input', e => setShockwaveRange('opacity', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveVictoryRadius').addEventListener('input', e => setShockwaveVictoryRange('radius', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveVictoryStrength').addEventListener('input', e => setShockwaveVictoryRange('strength', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveVictoryWidth').addEventListener('input', e => setShockwaveVictoryRange('width', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveVictoryDuration').addEventListener('input', e => setShockwaveVictoryRange('duration', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveVictoryRipple').addEventListener('input', e => setShockwaveVictoryRange('ripple', e.target.value), { signal: sig });
    this.panel.querySelector('#themeShockwaveVictoryOpacity').addEventListener('input', e => setShockwaveVictoryRange('opacity', e.target.value), { signal: sig });

    const ensureMagnetField = (shockwave) => {
      if (!shockwave) return null;
      if (!shockwave.magnetField || typeof shockwave.magnetField !== 'object') {
        shockwave.magnetField = {
          enabled: DEFAULT_SHOCKWAVE_MAGNET_FIELD.enabled,
          intensity: DEFAULT_SHOCKWAVE_MAGNET_FIELD.intensity
        };
      }
      return shockwave.magnetField;
    };
    this.panel.querySelector('#themeShockwaveMagnetField').addEventListener('change', e => {
      const magnetField = ensureMagnetField(ensureShockwave());
      if (!magnetField) return;
      magnetField.enabled = !!e.target.checked;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });
    this.panel.querySelector('#themeShockwaveMagnetFieldIntensity').addEventListener('input', e => {
      const magnetField = ensureMagnetField(ensureShockwave());
      if (!magnetField) return;
      magnetField.intensity = Math.max(0, parseInt(e.target.value, 10) || 0) / 100;
      this._syncShockwaveButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeEndSlowmoStrength').addEventListener('input', e => {
      const endSequence = ensureEndSequence();
      if (!endSequence) return;
      endSequence.finalPegSlowmoStrength = Math.max(0, parseInt(e.target.value, 10) || 0) / 100;
      this._syncEndSequenceButtons();
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeEndSlowmoSetDefaultBtn').addEventListener('click', () => {
      const endSequence = ensureEndSequence();
      if (!endSequence) return;
      const btn = this.panel.querySelector('#themeEndSlowmoSetDefaultBtn');
      try {
        this._emitChange();
        const saved = localStorage.getItem('peggle_visualDefaults');
        const defaults = normalizeVisuals(saved ? JSON.parse(saved) : null, true);
        defaults.endSequence = JSON.parse(JSON.stringify(endSequence));
        const json = JSON.stringify(defaults);
        localStorage.setItem('peggle_visualDefaults', json);
        btn.textContent = localStorage.getItem('peggle_visualDefaults') === json ? 'Saved!' : 'Error!';
      } catch (error) {
        btn.textContent = 'Error!';
        console.error('[visuals] End slow-mo default save failed', error);
      }
      setTimeout(() => {
        const current = this.panel?.querySelector('#themeEndSlowmoSetDefaultBtn');
        if (current) current.textContent = 'Set as default';
      }, 1200);
    }, { signal: sig });

    this.panel.querySelector('#themeFrameColor').addEventListener('input', e => {
      if (!this.config) return;
      this.config.frameColor = e.target.value;
      if (this.frame) this.frame.style.backgroundColor = '#000000';
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeEditBtn').addEventListener('click', () => {
      this.setEditMode(!this.editMode);
    }, { signal: sig });

    this.panel.querySelector('#themePreviewProgressBtn').addEventListener('click', () => {
      this.setPreviewFinalProgression(!this._previewFinalProgression);
    }, { signal: sig });

    // Apply for Level — explicitly save current visuals to this level
    this.panel.querySelector('#themeApplyLevelBtn').addEventListener('click', () => {
      if (!this.config) return;
      this._emitChange(); // pushes deep-cloned config into level.visuals and saves
      const btn = this.panel.querySelector('#themeApplyLevelBtn');
      // Verify the save actually persisted
      try {
        const stored = localStorage.getItem('peggle_levels');
        if (stored) {
          btn.textContent = 'Saved!';
        } else {
          btn.textContent = 'Error!';
          console.error('[visuals] Apply for Level: peggle_levels missing from localStorage after save');
        }
      } catch (e) {
        btn.textContent = 'Error!';
        console.error('[visuals] Apply for Level: verification failed', e);
      }
      setTimeout(() => { btn.textContent = 'Apply for Level'; }, 1200);
    }, { signal: sig });

    // Assign Default — save current visuals as the global template for new levels
    this.panel.querySelector('#themeAssignDefaultBtn').addEventListener('click', () => {
      if (!this.config) return;
      const btn = this.panel.querySelector('#themeAssignDefaultBtn');
      try {
        const copy = JSON.parse(JSON.stringify(this.config));
        // Strip customSrc (data URLs are too large for a default)
        for (const id of Object.keys(copy.slots)) {
          delete copy.slots[id].customSrc;
        }
        const json = JSON.stringify(copy);
        localStorage.setItem('peggle_visualDefaults', json);
        // Verify
        const check = localStorage.getItem('peggle_visualDefaults');
        if (check === json) {
          btn.textContent = 'Saved!';
        } else {
          btn.textContent = 'Error!';
          console.error('[visuals] Assign Default: verification mismatch');
        }
      } catch (e) {
        btn.textContent = 'Error!';
        console.error('[visuals] Assign Default: save failed', e);
      }
      setTimeout(() => { btn.textContent = 'Assign Default'; }, 1200);
    }, { signal: sig });

    // Restore Default — reset current level visuals to the saved default template
    this.panel.querySelector('#themeRestoreDefaultBtn').addEventListener('click', () => {
      const btn = this.panel.querySelector('#themeRestoreDefaultBtn');
      const saved = localStorage.getItem('peggle_visualDefaults');
      const defaults = normalizeVisuals(saved ? JSON.parse(saved) : null, true);
      this.setConfig(defaults);
      this._syncPanelValues();
      this._buildSlotList();
      this._emitChange();
      btn.textContent = 'Restored!';
      setTimeout(() => { btn.textContent = 'Restore Default'; }, 1200);
    }, { signal: sig });
  }

  _buildSlotList() {
    const list = this.panel.querySelector('#themeSlotList');
    if (!list) return;
    list.innerHTML = '';

    // Render in layer order (back-to-front → list shows front on top)
    const order = this.config?.layerOrder || DEFAULT_LAYER_ORDER;
    const displayOrder = [...order].reverse(); // front-first in list

    for (const slotId of displayOrder) {
      const def = SLOT_DEFS.find(d => d.id === slotId);
      if (!def || def.hidden) continue;
      const slotCfg = this.config.slots[def.id];
      const scaleVal = Math.round((slotCfg?.scale || 1) * 100);
      const layerIdx = order.indexOf(slotId);

      const row = document.createElement('div');
      row.className = 'theme-slot-row';
      if (this.selectedSlotId === def.id) row.classList.add('selected');
      row.dataset.slotId = def.id;

      const hasColor = def.id === 'healthCircle' || def.id === 'healthCharCircle';
      const colorVal = slotCfg?.color || '#00e5ff';
      const hasDarken = !!def.column;
      const darkenVal = slotCfg?.darken || 0;

      row.innerHTML = `
        <div class="theme-slot-header">
          <label class="theme-slot-toggle">
            <input type="checkbox" ${slotCfg?.visible !== false ? 'checked' : ''}>
            <span class="theme-slot-name">${def.label}</span>
          </label>
          <div class="theme-slot-layer-btns">
            <button class="theme-layer-btn theme-layer-up" title="Bring forward"${layerIdx >= order.length - 1 ? ' disabled' : ''}>&#9650;</button>
            <button class="theme-layer-btn theme-layer-down" title="Send backward"${layerIdx <= 0 ? ' disabled' : ''}>&#9660;</button>
          </div>
        </div>
        <div class="theme-slot-controls">
          <input type="range" class="theme-slot-scale" min="10" max="500" value="${scaleVal}" title="Scale">
          <input type="number" class="theme-slot-scale-num" min="10" max="500" value="${scaleVal}" step="5" title="Scale %">
          <button class="theme-slot-upload" title="Upload image">img</button>
          <button class="theme-slot-reset" title="Reset position">R</button>
        </div>
        ${hasColor ? `<div class="theme-slot-color-row">
          <span class="theme-row-label">Color</span>
          <input type="color" class="theme-slot-color" value="${colorVal}">
        </div>` : ''}
        ${hasDarken ? `<div class="theme-slot-color-row">
          <span class="theme-row-label">Darken</span>
          <input type="range" class="theme-slot-darken" min="0" max="100" value="${darkenVal}" title="Darken %">
          <span class="theme-slot-darken-val">${darkenVal}%</span>
        </div>` : ''}
      `;

      // Visibility toggle
      row.querySelector('input[type="checkbox"]').addEventListener('change', e => {
        if (this.config.slots[def.id]) {
          this.config.slots[def.id].visible = e.target.checked;
          const el = this.slotElements[def.id];
          if (el) el.style.display = e.target.checked ? '' : 'none';
          this._emitChange();
        }
      });

      // Scale slider
      const slider = row.querySelector('.theme-slot-scale');
      const numInput = row.querySelector('.theme-slot-scale-num');

      slider.addEventListener('input', e => {
        if (this.config.slots[def.id]) {
          const v = parseInt(e.target.value);
          this.config.slots[def.id].scale = v / 100;
          numInput.value = v;
          this._positionSlot(def.id);
          this._emitChange();
        }
      });

      numInput.addEventListener('input', e => {
        if (this.config.slots[def.id]) {
          let v = parseInt(e.target.value);
          if (isNaN(v)) return;
          v = Math.max(10, Math.min(500, v));
          this.config.slots[def.id].scale = v / 100;
          slider.value = v;
          this._positionSlot(def.id);
          this._emitChange();
        }
      });

      // Layer buttons
      row.querySelector('.theme-layer-up').addEventListener('click', e => {
        e.stopPropagation();
        this._moveLayer(slotId, 1); // +1 in back-to-front order = forward
      });
      row.querySelector('.theme-layer-down').addEventListener('click', e => {
        e.stopPropagation();
        this._moveLayer(slotId, -1); // -1 = backward
      });

      // Upload
      row.querySelector('.theme-slot-upload').addEventListener('click', () => {
        this._uploadSlotImage(def.id);
      });

      // Reset
      row.querySelector('.theme-slot-reset').addEventListener('click', () => {
        if (this.config.slots[def.id]) {
          this.config.slots[def.id].x = def.defaultX;
          this.config.slots[def.id].y = def.defaultY;
          this.config.slots[def.id].scale = def.defaultScale || 1;
          this.config.slots[def.id].darken = def.defaultDarken || 0;
          this.config.slots[def.id].customSrc = null;
          this._resolvedAssets[def.id] = null;
          this._loadSlotAsset(def);
          this._positionSlot(def.id);
          this._buildSlotList();
          this._emitChange();
        }
      });

      // Color picker (for health slots)
      const colorInput = row.querySelector('.theme-slot-color');
      if (colorInput) {
        colorInput.addEventListener('input', e => {
          if (this.config.slots[def.id]) {
            this.config.slots[def.id].color = e.target.value;
            this._emitChange();
          }
        });
      }

      // Darken slider (for column slots)
      const darkenInput = row.querySelector('.theme-slot-darken');
      if (darkenInput) {
        darkenInput.addEventListener('input', e => {
          if (this.config.slots[def.id]) {
            const v = parseInt(e.target.value);
            this.config.slots[def.id].darken = v;
            row.querySelector('.theme-slot-darken-val').textContent = v + '%';
            const el = this.slotElements[def.id];
            if (el) el.style.filter = `brightness(${1 - v / 100})`;
            this._emitChange();
          }
        });
      }

      // Click row to select
      row.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        this.selectedSlotId = def.id;
        this._buildSlotList();
      });

      list.appendChild(row);
    }
  }

  _uploadSlotImage(slotId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await compressImageFile(file);
      if (!dataUrl) return;
      if (this.config.slots[slotId]) {
        this.config.slots[slotId].customSrc = dataUrl;
        this._resolvedAssets[slotId] = dataUrl;
        const el = this.slotElements[slotId];
        if (el) el.style.backgroundImage = `url('${dataUrl}')`;
        this._emitChange();
      }
    };
    input.click();
  }

  _syncPanelValues() {
    if (!this.panel || !this.config) return;
    const bg = this.config.background;
    const sel = (id) => this.panel.querySelector(id);
    const progression = bg.liquid?.progression || {};
    const bgType = sel('#themeBgType');
    if (bgType) bgType.value = bg.type;
    const bgTop = sel('#themeBgTop');
    if (bgTop) bgTop.value = bg.colorTop;
    const bgBot = sel('#themeBgBottom');
    if (bgBot) bgBot.value = bg.colorBottom;
    const bgDarken = sel('#themeBgDarken');
    if (bgDarken) bgDarken.value = String(Math.round((bg.darken ?? 0.5) * 100));
    const liquidBase = sel('#themeBgLiquidBase');
    if (liquidBase) liquidBase.value = bg.liquid?.colorBase || '#05020f';
    const liquidMid = sel('#themeBgLiquidMid');
    if (liquidMid) liquidMid.value = bg.liquid?.colorMid || '#24104f';
    const liquidAccent = sel('#themeBgLiquidAccent');
    if (liquidAccent) liquidAccent.value = bg.liquid?.colorAccent || '#8d63ff';
    const liquidScale = sel('#themeBgLiquidScale');
    if (liquidScale) liquidScale.value = String(Math.round((bg.liquid?.scale ?? 1) * 100));
    const liquidRoughness = sel('#themeBgLiquidRoughness');
    if (liquidRoughness) liquidRoughness.value = String(Math.round((bg.liquid?.roughness ?? 0.58) * 100));
    const liquidDistortion = sel('#themeBgLiquidDistortion');
    if (liquidDistortion) liquidDistortion.value = String(Math.round((bg.liquid?.distortion ?? 1) * 100));
    const liquidLacunarity = sel('#themeBgLiquidLacunarity');
    if (liquidLacunarity) liquidLacunarity.value = String(Math.round((bg.liquid?.lacunarity ?? 2.25) * 100));
    const liquidTrail = sel('#themeBgLiquidTrail');
    if (liquidTrail) liquidTrail.value = String(Math.round((bg.liquid?.trail ?? 1) * 100));
    const liquidMotion = sel('#themeBgLiquidMotion');
    if (liquidMotion) liquidMotion.value = String(Math.round((bg.liquid?.motion ?? 0.44) * 100));
    const liquidReaction = sel('#themeBgLiquidReaction');
    if (liquidReaction) liquidReaction.value = String(Math.round((bg.liquid?.reaction ?? 0.82) * 100));
    const liquidProgBaseEnabled = sel('#themeBgLiquidProgBaseEnabled');
    if (liquidProgBaseEnabled) liquidProgBaseEnabled.checked = typeof progression.colorBase === 'string';
    const liquidProgBase = sel('#themeBgLiquidProgBase');
    if (liquidProgBase) liquidProgBase.value = progression.colorBase || (bg.liquid?.colorBase || '#05020f');
    const liquidProgMidEnabled = sel('#themeBgLiquidProgMidEnabled');
    if (liquidProgMidEnabled) liquidProgMidEnabled.checked = typeof progression.colorMid === 'string';
    const liquidProgMid = sel('#themeBgLiquidProgMid');
    if (liquidProgMid) liquidProgMid.value = progression.colorMid || (bg.liquid?.colorMid || '#24104f');
    const liquidProgAccentEnabled = sel('#themeBgLiquidProgAccentEnabled');
    if (liquidProgAccentEnabled) liquidProgAccentEnabled.checked = typeof progression.colorAccent === 'string';
    const liquidProgAccent = sel('#themeBgLiquidProgAccent');
    if (liquidProgAccent) liquidProgAccent.value = progression.colorAccent || (bg.liquid?.colorAccent || '#8d63ff');
    const liquidProgScaleEnabled = sel('#themeBgLiquidProgScaleEnabled');
    if (liquidProgScaleEnabled) liquidProgScaleEnabled.checked = Number.isFinite(progression.scale);
    const liquidProgScale = sel('#themeBgLiquidProgScale');
    if (liquidProgScale) liquidProgScale.value = String(Math.round((Number.isFinite(progression.scale) ? progression.scale : (bg.liquid?.scale ?? 1)) * 100));
    const liquidProgRoughnessEnabled = sel('#themeBgLiquidProgRoughnessEnabled');
    if (liquidProgRoughnessEnabled) liquidProgRoughnessEnabled.checked = Number.isFinite(progression.roughness);
    const liquidProgRoughness = sel('#themeBgLiquidProgRoughness');
    if (liquidProgRoughness) liquidProgRoughness.value = String(Math.round((Number.isFinite(progression.roughness) ? progression.roughness : (bg.liquid?.roughness ?? 0.58)) * 100));
    const liquidProgDistortionEnabled = sel('#themeBgLiquidProgDistortionEnabled');
    if (liquidProgDistortionEnabled) liquidProgDistortionEnabled.checked = Number.isFinite(progression.distortion);
    const liquidProgDistortion = sel('#themeBgLiquidProgDistortion');
    if (liquidProgDistortion) liquidProgDistortion.value = String(Math.round((Number.isFinite(progression.distortion) ? progression.distortion : (bg.liquid?.distortion ?? 1)) * 100));
    const liquidProgLacunarityEnabled = sel('#themeBgLiquidProgLacunarityEnabled');
    if (liquidProgLacunarityEnabled) liquidProgLacunarityEnabled.checked = Number.isFinite(progression.lacunarity);
    const liquidProgLacunarity = sel('#themeBgLiquidProgLacunarity');
    if (liquidProgLacunarity) liquidProgLacunarity.value = String(Math.round((Number.isFinite(progression.lacunarity) ? progression.lacunarity : (bg.liquid?.lacunarity ?? 2.25)) * 100));
    const liquidProgTrailEnabled = sel('#themeBgLiquidProgTrailEnabled');
    if (liquidProgTrailEnabled) liquidProgTrailEnabled.checked = Number.isFinite(progression.trail);
    const liquidProgTrail = sel('#themeBgLiquidProgTrail');
    if (liquidProgTrail) liquidProgTrail.value = String(Math.round((Number.isFinite(progression.trail) ? progression.trail : (bg.liquid?.trail ?? 1)) * 100));
    const liquidProgMotionEnabled = sel('#themeBgLiquidProgMotionEnabled');
    if (liquidProgMotionEnabled) liquidProgMotionEnabled.checked = Number.isFinite(progression.motion);
    const liquidProgMotion = sel('#themeBgLiquidProgMotion');
    if (liquidProgMotion) liquidProgMotion.value = String(Math.round((Number.isFinite(progression.motion) ? progression.motion : (bg.liquid?.motion ?? 0.44)) * 100));
    const liquidProgReactionEnabled = sel('#themeBgLiquidProgReactionEnabled');
    if (liquidProgReactionEnabled) liquidProgReactionEnabled.checked = Number.isFinite(progression.reaction);
    const liquidProgReaction = sel('#themeBgLiquidProgReaction');
    if (liquidProgReaction) liquidProgReaction.value = String(Math.round((Number.isFinite(progression.reaction) ? progression.reaction : (bg.liquid?.reaction ?? 0.82)) * 100));
    const fc = sel('#themeFrameColor');
    if (fc) fc.value = this.config.frameColor;
    const trail = this.config.ballTrail || {};
    const trailProgression = trail.progression || {};
    const trailEnabled = sel('#themeBallTrailEnabled');
    if (trailEnabled) trailEnabled.checked = !!trail.enabled;
    const trailColor = sel('#themeBallTrailColor');
    if (trailColor) trailColor.value = trail.color || '#f8f9fa';
    const setTrailRange = (id, value, fallback) => {
      const input = sel(id);
      if (input) input.value = String(Math.round((Number.isFinite(value) ? value : fallback) * 100));
    };
    setTrailRange('#themeBallTrailLength', trail.length, 0.31);
    setTrailRange('#themeBallTrailWidth', trail.width, 0.7);
    setTrailRange('#themeBallTrailGlow', trail.glow, 0);
    setTrailRange('#themeBallTrailOpacity', trail.opacity, 0.32);
    setTrailRange('#themeBallTrailTurbulence', trail.turbulence, 0);
    setTrailRange('#themeBallTrailSmoothing', trail.smoothing, 1);
    const trailProgEnabled = sel('#themeBallTrailProgEnabled');
    if (trailProgEnabled) trailProgEnabled.checked = !!trailProgression.enabled;
    const trailProgColor = sel('#themeBallTrailProgColor');
    if (trailProgColor) trailProgColor.value = trailProgression.color || trail.color || '#f8f9fa';
    setTrailRange('#themeBallTrailProgLength', trailProgression.length, trail.length ?? 0.31);
    setTrailRange('#themeBallTrailProgWidth', trailProgression.width, trail.width ?? 0.7);
    setTrailRange('#themeBallTrailProgGlow', trailProgression.glow, trail.glow ?? 0);
    setTrailRange('#themeBallTrailProgOpacity', trailProgression.opacity, trail.opacity ?? 0.32);
    setTrailRange('#themeBallTrailProgTurbulence', trailProgression.turbulence, trail.turbulence ?? 0);
    setTrailRange('#themeBallTrailProgSmoothing', trailProgression.smoothing, trail.smoothing ?? 1);
    const shockwave = this.config.shockwave || {};
    const shockwaveEnabled = sel('#themeShockwaveEnabled');
    if (shockwaveEnabled) shockwaveEnabled.checked = shockwave.enabled !== false;
    const shockwaveBomb = sel('#themeShockwaveBomb');
    if (shockwaveBomb) shockwaveBomb.checked = shockwave.bomb !== false;
    const shockwaveBombTargets = sel('#themeShockwaveBombTargets');
    if (shockwaveBombTargets) shockwaveBombTargets.checked = shockwave.bombTargets === true;
    const shockwaveVictory = sel('#themeShockwaveVictory');
    if (shockwaveVictory) shockwaveVictory.checked = shockwave.victory !== false;
    const shockwaveVictorySeparate = sel('#themeShockwaveVictorySeparate');
    if (shockwaveVictorySeparate) shockwaveVictorySeparate.checked = shockwave.victorySeparate === true;
    const shockwaveColor = sel('#themeShockwaveColor');
    if (shockwaveColor) shockwaveColor.value = shockwave.color || '#ffffff';
    const victorySettings = shockwave.victorySettings || {};
    const shockwaveVictoryColor = sel('#themeShockwaveVictoryColor');
    if (shockwaveVictoryColor) shockwaveVictoryColor.value = victorySettings.color || shockwave.color || '#ffffff';
    setTrailRange('#themeShockwaveRadius', shockwave.radius, DEFAULT_SHOCKWAVE_EFFECT.radius);
    setTrailRange('#themeShockwaveStrength', shockwave.strength, DEFAULT_SHOCKWAVE_EFFECT.strength);
    setTrailRange('#themeShockwaveWidth', shockwave.width, DEFAULT_SHOCKWAVE_EFFECT.width);
    setTrailRange('#themeShockwaveDuration', shockwave.duration, DEFAULT_SHOCKWAVE_EFFECT.duration);
    setTrailRange('#themeShockwaveRipple', shockwave.ripple, DEFAULT_SHOCKWAVE_EFFECT.ripple);
    setTrailRange('#themeShockwaveOpacity', shockwave.opacity, DEFAULT_SHOCKWAVE_EFFECT.opacity);
    setTrailRange('#themeShockwaveVictoryRadius', victorySettings.radius, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.radius);
    setTrailRange('#themeShockwaveVictoryStrength', victorySettings.strength, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.strength);
    setTrailRange('#themeShockwaveVictoryWidth', victorySettings.width, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.width);
    setTrailRange('#themeShockwaveVictoryDuration', victorySettings.duration, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.duration);
    setTrailRange('#themeShockwaveVictoryRipple', victorySettings.ripple, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.ripple);
    setTrailRange('#themeShockwaveVictoryOpacity', victorySettings.opacity, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.opacity);
    const magnetField = shockwave.magnetField || {};
    const shockwaveMagnetField = sel('#themeShockwaveMagnetField');
    if (shockwaveMagnetField) shockwaveMagnetField.checked = magnetField.enabled !== false;
    setTrailRange('#themeShockwaveMagnetFieldIntensity', magnetField.intensity, DEFAULT_SHOCKWAVE_MAGNET_FIELD.intensity);
    const endSequence = this.config.endSequence || {};
    setTrailRange('#themeEndSlowmoStrength', endSequence.finalPegSlowmoStrength, DEFAULT_END_SEQUENCE.finalPegSlowmoStrength);
    this._syncBgRowVisibility();
    this._syncBackgroundButtons();
    this._syncProgressBgButtons();
    this._syncLiquidBgButtons();
    this._syncBallTrailButtons();
    this._syncShockwaveButtons();
    this._syncEndSequenceButtons();
    this._syncProgressionPreviewButton();
    this._buildSlotList();
  }

  _syncBgRowVisibility() {
    if (!this.panel || !this.config) return;
    const type = this.config.background.type;
    const sel = (id) => this.panel.querySelector(id);
    const imgRow = sel('#themeBgImageRow');
    const progressRow = sel('#themeBgProgressRow');
    const topRow = sel('#themeBgTopRow');
    const botRow = sel('#themeBgBottomRow');
    const liquidBaseRow = sel('#themeBgLiquidBaseRow');
    const liquidMidRow = sel('#themeBgLiquidMidRow');
    const liquidAccentRow = sel('#themeBgLiquidAccentRow');
    const liquidScaleRow = sel('#themeBgLiquidScaleRow');
    const liquidRoughnessRow = sel('#themeBgLiquidRoughnessRow');
    const liquidDistortionRow = sel('#themeBgLiquidDistortionRow');
    const liquidLacunarityRow = sel('#themeBgLiquidLacunarityRow');
    const liquidTrailRow = sel('#themeBgLiquidTrailRow');
    const liquidMotionRow = sel('#themeBgLiquidMotionRow');
    const liquidReactionRow = sel('#themeBgLiquidReactionRow');
    const liquidProgressionLabel = sel('#themeBgLiquidProgressionLabel');
    const liquidProgResetRow = sel('#themeBgLiquidProgResetRow');
    const liquidProgBaseRow = sel('#themeBgLiquidProgBaseRow');
    const liquidProgMidRow = sel('#themeBgLiquidProgMidRow');
    const liquidProgAccentRow = sel('#themeBgLiquidProgAccentRow');
    const liquidProgScaleRow = sel('#themeBgLiquidProgScaleRow');
    const liquidProgRoughnessRow = sel('#themeBgLiquidProgRoughnessRow');
    const liquidProgDistortionRow = sel('#themeBgLiquidProgDistortionRow');
    const liquidProgLacunarityRow = sel('#themeBgLiquidProgLacunarityRow');
    const liquidProgTrailRow = sel('#themeBgLiquidProgTrailRow');
    const liquidProgMotionRow = sel('#themeBgLiquidProgMotionRow');
    const liquidProgReactionRow = sel('#themeBgLiquidProgReactionRow');
    if (imgRow) imgRow.style.display = type === 'image' ? '' : 'none';
    if (progressRow) progressRow.style.display = type === 'image' ? '' : 'none';
    if (topRow) topRow.style.display = type === 'image' ? 'none' : '';
    if (botRow) botRow.style.display = type === 'gradient' ? '' : 'none';
    if (liquidBaseRow) liquidBaseRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidMidRow) liquidMidRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidAccentRow) liquidAccentRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidScaleRow) liquidScaleRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidRoughnessRow) liquidRoughnessRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidDistortionRow) liquidDistortionRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidLacunarityRow) liquidLacunarityRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidTrailRow) liquidTrailRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidMotionRow) liquidMotionRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidReactionRow) liquidReactionRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgressionLabel) liquidProgressionLabel.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgResetRow) liquidProgResetRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgBaseRow) liquidProgBaseRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgMidRow) liquidProgMidRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgAccentRow) liquidProgAccentRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgScaleRow) liquidProgScaleRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgRoughnessRow) liquidProgRoughnessRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgDistortionRow) liquidProgDistortionRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgLacunarityRow) liquidProgLacunarityRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgTrailRow) liquidProgTrailRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgMotionRow) liquidProgMotionRow.style.display = type === 'liquid' ? '' : 'none';
    if (liquidProgReactionRow) liquidProgReactionRow.style.display = type === 'liquid' ? '' : 'none';
    if (topRow && type === 'liquid') topRow.style.display = 'none';
  }

  _syncBackgroundButtons() {
    if (!this.panel || !this.config?.background) return;
    const value = Math.round((Number.isFinite(this.config.background.darken) ? this.config.background.darken : 0.5) * 100);
    const slider = this.panel.querySelector('#themeBgDarken');
    const label = this.panel.querySelector('#themeBgDarkenValue');
    if (slider) slider.value = String(value);
    if (label) label.textContent = `${value}%`;
  }

  _syncProgressBgButtons() {
    if (!this.panel || !this.config) return;
    const hasProgressImage = !!this.config.background?.progressionImage;
    const uploadBtn = this.panel.querySelector('#themeBgProgressBtn');
    const clearBtn = this.panel.querySelector('#themeBgProgressClearBtn');
    const state = this.panel.querySelector('#themeBgProgressState');
    if (uploadBtn) uploadBtn.textContent = hasProgressImage ? 'Change' : 'Upload';
    if (clearBtn) clearBtn.disabled = !hasProgressImage;
    if (state) state.textContent = hasProgressImage ? 'Set' : 'Optional';
    this._syncProgressionPreviewButton();
  }

  _hasPreviewableProgression() {
    const bg = this.config?.background;
    const trail = this.config?.ballTrail;
    if (trail?.enabled && trail.progression?.enabled) return true;
    if (!bg) return false;
    if (bg.type === 'image') return !!bg.progressionImage;
    if (bg.type !== 'liquid') return false;
    const progression = bg.liquid?.progression;
    if (!progression || typeof progression !== 'object') return false;
    return Object.values(progression).some(value => value !== null && value !== undefined && value !== '');
  }

  _syncProgressionPreviewButton() {
    if (!this.panel) return;
    const button = this.panel.querySelector('#themePreviewProgressBtn');
    if (!button) return;
    const available = this._hasPreviewableProgression();
    if (!available && this._previewFinalProgression) {
      this._previewFinalProgression = false;
      if (this.onPreviewProgressionChange) {
        this.onPreviewProgressionChange(false);
      }
    }
    button.disabled = !available;
    button.textContent = this._previewFinalProgression ? 'Hide Final State' : 'Preview Final State';
    button.classList.toggle('is-active', available && this._previewFinalProgression);
  }

  _syncBallTrailPreviewButton() {
    if (!this.panel) return;
    const button = this.panel.querySelector('#themeBallTrailPreviewBtn');
    if (!button) return;
    const available = !!this.config?.ballTrail?.enabled;
    if (!available && this._previewBallTrail) {
      this._previewBallTrail = false;
      if (this.onBallTrailPreviewChange) {
        this.onBallTrailPreviewChange(false);
      }
    }
    button.disabled = !available;
    button.textContent = this._previewBallTrail ? 'Hide Tail Preview' : 'Preview Tail';
    button.classList.toggle('is-active', available && this._previewBallTrail);
  }

  _syncBallTrailButtons() {
    if (!this.panel || !this.config?.ballTrail) return;
    const trail = this.config.ballTrail;
    const progression = trail.progression || {};
    const setValue = (id, value, fallback, format = value => `${Math.round(value * 100)}%`) => {
      const el = this.panel.querySelector(id);
      if (el) el.textContent = format(Number.isFinite(value) ? value : fallback);
    };
    setValue('#themeBallTrailLengthValue', trail.length, 0.31);
    setValue('#themeBallTrailWidthValue', trail.width, 0.7);
    setValue('#themeBallTrailGlowValue', trail.glow, 0);
    setValue('#themeBallTrailOpacityValue', trail.opacity, 0.32);
    setValue('#themeBallTrailTurbulenceValue', trail.turbulence, 0);
    setValue('#themeBallTrailSmoothingValue', trail.smoothing, 1);
    setValue('#themeBallTrailProgLengthValue', progression.length, trail.length ?? 0.31);
    setValue('#themeBallTrailProgWidthValue', progression.width, trail.width ?? 0.7);
    setValue('#themeBallTrailProgGlowValue', progression.glow, trail.glow ?? 0);
    setValue('#themeBallTrailProgOpacityValue', progression.opacity, trail.opacity ?? 0.32);
    setValue('#themeBallTrailProgTurbulenceValue', progression.turbulence, trail.turbulence ?? 0);
    setValue('#themeBallTrailProgSmoothingValue', progression.smoothing, trail.smoothing ?? 1);

    const enabled = !!trail.enabled;
    for (const id of [
      '#themeBallTrailColor',
      '#themeBallTrailLength',
      '#themeBallTrailWidth',
      '#themeBallTrailGlow',
      '#themeBallTrailOpacity',
      '#themeBallTrailTurbulence',
      '#themeBallTrailSmoothing',
      '#themeBallTrailProgEnabled',
      '#themeBallTrailProgMatchBtn'
    ]) {
      const el = this.panel.querySelector(id);
      if (el) el.disabled = !enabled;
    }

    const progressionEnabled = enabled && !!progression.enabled;
    for (const id of [
      '#themeBallTrailProgColor',
      '#themeBallTrailProgLength',
      '#themeBallTrailProgWidth',
      '#themeBallTrailProgGlow',
      '#themeBallTrailProgOpacity',
      '#themeBallTrailProgTurbulence',
      '#themeBallTrailProgSmoothing'
    ]) {
      const el = this.panel.querySelector(id);
      if (el) el.disabled = !progressionEnabled;
    }

    for (const id of [
      '#themeBallTrailProgColorRow',
      '#themeBallTrailProgLengthRow',
      '#themeBallTrailProgWidthRow',
      '#themeBallTrailProgGlowRow',
      '#themeBallTrailProgOpacityRow',
      '#themeBallTrailProgTurbulenceRow',
      '#themeBallTrailProgSmoothingRow'
    ]) {
      const row = this.panel.querySelector(id);
      if (row) row.style.opacity = progressionEnabled ? '1' : '0.62';
    }

    this._syncBallTrailPreviewButton();
    this._syncProgressionPreviewButton();
  }

  _syncShockwavePreviewButton() {
    if (!this.panel) return;
    const button = this.panel.querySelector('#themeShockwavePreviewBtn');
    if (!button) return;
    const available = this.config?.shockwave?.enabled !== false;
    if (!available && this._previewShockwave) {
      this._previewShockwave = false;
      if (this.onShockwavePreviewChange) {
        this.onShockwavePreviewChange(false);
      }
    }
    button.disabled = !available;
    button.textContent = this._previewShockwave ? 'Hide Wave Preview' : 'Preview Wave';
    button.classList.toggle('is-active', available && this._previewShockwave);
  }

  _syncShockwaveButtons() {
    if (!this.panel || !this.config?.shockwave) return;
    const shockwave = this.config.shockwave;
    const formatPercent = value => `${Math.round(value * 100)}%`;
    const setValue = (id, value, fallback, format = formatPercent) => {
      const el = this.panel.querySelector(id);
      if (el) el.textContent = format(Number.isFinite(value) ? value : fallback);
    };
    setValue('#themeShockwaveRadiusValue', shockwave.radius, DEFAULT_SHOCKWAVE_EFFECT.radius);
    setValue('#themeShockwaveStrengthValue', shockwave.strength, DEFAULT_SHOCKWAVE_EFFECT.strength);
    setValue('#themeShockwaveWidthValue', shockwave.width, DEFAULT_SHOCKWAVE_EFFECT.width);
    setValue('#themeShockwaveDurationValue', shockwave.duration, DEFAULT_SHOCKWAVE_EFFECT.duration, value => `${value.toFixed(2)}s`);
    setValue('#themeShockwaveRippleValue', shockwave.ripple, DEFAULT_SHOCKWAVE_EFFECT.ripple);
    setValue('#themeShockwaveOpacityValue', shockwave.opacity, DEFAULT_SHOCKWAVE_EFFECT.opacity);
    const victorySettings = shockwave.victorySettings || {};
    setValue('#themeShockwaveVictoryRadiusValue', victorySettings.radius, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.radius);
    setValue('#themeShockwaveVictoryStrengthValue', victorySettings.strength, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.strength);
    setValue('#themeShockwaveVictoryWidthValue', victorySettings.width, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.width);
    setValue('#themeShockwaveVictoryDurationValue', victorySettings.duration, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.duration, value => `${value.toFixed(2)}s`);
    setValue('#themeShockwaveVictoryRippleValue', victorySettings.ripple, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.ripple);
    setValue('#themeShockwaveVictoryOpacityValue', victorySettings.opacity, DEFAULT_SHOCKWAVE_VICTORY_SETTINGS.opacity);
    const magnetField = shockwave.magnetField || {};
    setValue('#themeShockwaveMagnetFieldIntensityValue', magnetField.intensity, DEFAULT_SHOCKWAVE_MAGNET_FIELD.intensity);

    const enabled = shockwave.enabled !== false;
    for (const id of [
      '#themeShockwaveBomb',
      '#themeShockwaveBombTargets',
      '#themeShockwaveVictory',
      '#themeShockwaveVictorySeparate',
      '#themeShockwaveColor',
      '#themeShockwaveRadius',
      '#themeShockwaveStrength',
      '#themeShockwaveWidth',
      '#themeShockwaveDuration',
      '#themeShockwaveRipple',
      '#themeShockwaveOpacity',
      '#themeShockwaveMagnetField'
    ]) {
      const el = this.panel.querySelector(id);
      if (el) el.disabled = !enabled;
    }
    const magnetFieldIntensity = this.panel.querySelector('#themeShockwaveMagnetFieldIntensity');
    if (magnetFieldIntensity) magnetFieldIntensity.disabled = !enabled || magnetField.enabled === false;
    const bombTargets = this.panel.querySelector('#themeShockwaveBombTargets');
    if (bombTargets) bombTargets.disabled = !enabled || shockwave.bomb === false;
    const victorySeparateToggle = this.panel.querySelector('#themeShockwaveVictorySeparate');
    if (victorySeparateToggle) victorySeparateToggle.disabled = !enabled || shockwave.victory === false;

    const victorySeparate = enabled && shockwave.victory !== false && shockwave.victorySeparate === true;
    for (const id of [
      '#themeShockwaveVictoryColorRow',
      '#themeShockwaveVictoryRadiusRow',
      '#themeShockwaveVictoryStrengthRow',
      '#themeShockwaveVictoryWidthRow',
      '#themeShockwaveVictoryDurationRow',
      '#themeShockwaveVictoryRippleRow',
      '#themeShockwaveVictoryOpacityRow'
    ]) {
      const row = this.panel.querySelector(id);
      if (row) row.style.display = victorySeparate ? '' : 'none';
    }
    for (const id of [
      '#themeShockwaveVictoryColor',
      '#themeShockwaveVictoryRadius',
      '#themeShockwaveVictoryStrength',
      '#themeShockwaveVictoryWidth',
      '#themeShockwaveVictoryDuration',
      '#themeShockwaveVictoryRipple',
      '#themeShockwaveVictoryOpacity'
    ]) {
      const el = this.panel.querySelector(id);
      if (el) el.disabled = !victorySeparate;
    }

    this._syncShockwavePreviewButton();
  }

  _syncEndSequenceButtons() {
    if (!this.panel || !this.config?.endSequence) return;
    const strength = Number.isFinite(this.config.endSequence.finalPegSlowmoStrength)
      ? this.config.endSequence.finalPegSlowmoStrength
      : DEFAULT_END_SEQUENCE.finalPegSlowmoStrength;
    const slider = this.panel.querySelector('#themeEndSlowmoStrength');
    const label = this.panel.querySelector('#themeEndSlowmoStrengthValue');
    if (slider) slider.value = String(Math.round(strength * 100));
    if (label) label.textContent = `${Math.round(strength * 100)}%`;
  }

  _syncLiquidBgButtons() {
    if (!this.panel || !this.config?.background?.liquid) return;
    const progression = this.config.background.liquid.progression || {};
    const scaleValue = this.panel.querySelector('#themeBgLiquidScaleValue');
    const roughnessValue = this.panel.querySelector('#themeBgLiquidRoughnessValue');
    const distortionValue = this.panel.querySelector('#themeBgLiquidDistortionValue');
    const lacunarityValue = this.panel.querySelector('#themeBgLiquidLacunarityValue');
    const trailValue = this.panel.querySelector('#themeBgLiquidTrailValue');
    const motionValue = this.panel.querySelector('#themeBgLiquidMotionValue');
    const reactionValue = this.panel.querySelector('#themeBgLiquidReactionValue');
    const progScaleValue = this.panel.querySelector('#themeBgLiquidProgScaleValue');
    const progRoughnessValue = this.panel.querySelector('#themeBgLiquidProgRoughnessValue');
    const progDistortionValue = this.panel.querySelector('#themeBgLiquidProgDistortionValue');
    const progLacunarityValue = this.panel.querySelector('#themeBgLiquidProgLacunarityValue');
    const progTrailValue = this.panel.querySelector('#themeBgLiquidProgTrailValue');
    const progMotionValue = this.panel.querySelector('#themeBgLiquidProgMotionValue');
    const progReactionValue = this.panel.querySelector('#themeBgLiquidProgReactionValue');
    if (scaleValue) scaleValue.textContent = `${Math.round((this.config.background.liquid.scale ?? 1) * 100)}%`;
    if (roughnessValue) roughnessValue.textContent = `${Math.round((this.config.background.liquid.roughness ?? 0.58) * 100)}%`;
    if (distortionValue) distortionValue.textContent = `${Math.round((this.config.background.liquid.distortion ?? 1) * 100)}%`;
    if (lacunarityValue) lacunarityValue.textContent = (this.config.background.liquid.lacunarity ?? 2.25).toFixed(2);
    if (trailValue) trailValue.textContent = `${Math.round((this.config.background.liquid.trail ?? 1) * 100)}%`;
    if (motionValue) motionValue.textContent = `${Math.round(this.config.background.liquid.motion * 100)}%`;
    if (reactionValue) reactionValue.textContent = `${Math.round(this.config.background.liquid.reaction * 100)}%`;
    if (progScaleValue) progScaleValue.textContent = `${Math.round((Number.isFinite(progression.scale) ? progression.scale : (this.config.background.liquid.scale ?? 1)) * 100)}%`;
    if (progRoughnessValue) progRoughnessValue.textContent = `${Math.round((Number.isFinite(progression.roughness) ? progression.roughness : (this.config.background.liquid.roughness ?? 0.58)) * 100)}%`;
    if (progDistortionValue) progDistortionValue.textContent = `${Math.round((Number.isFinite(progression.distortion) ? progression.distortion : (this.config.background.liquid.distortion ?? 1)) * 100)}%`;
    if (progLacunarityValue) progLacunarityValue.textContent = (Number.isFinite(progression.lacunarity) ? progression.lacunarity : (this.config.background.liquid.lacunarity ?? 2.25)).toFixed(2);
    if (progTrailValue) progTrailValue.textContent = `${Math.round((Number.isFinite(progression.trail) ? progression.trail : (this.config.background.liquid.trail ?? 1)) * 100)}%`;
    if (progMotionValue) progMotionValue.textContent = `${Math.round((Number.isFinite(progression.motion) ? progression.motion : this.config.background.liquid.motion) * 100)}%`;
    if (progReactionValue) progReactionValue.textContent = `${Math.round((Number.isFinite(progression.reaction) ? progression.reaction : this.config.background.liquid.reaction) * 100)}%`;

    const syncControl = (enabledId, inputId, rowId, active) => {
      const enabled = this.panel.querySelector(enabledId);
      const input = this.panel.querySelector(inputId);
      const row = this.panel.querySelector(rowId);
      if (enabled) enabled.checked = active;
      if (input) input.disabled = !active;
      if (row) row.style.opacity = active ? '1' : '0.62';
    };

    syncControl('#themeBgLiquidProgBaseEnabled', '#themeBgLiquidProgBase', '#themeBgLiquidProgBaseRow', typeof progression.colorBase === 'string');
    syncControl('#themeBgLiquidProgMidEnabled', '#themeBgLiquidProgMid', '#themeBgLiquidProgMidRow', typeof progression.colorMid === 'string');
    syncControl('#themeBgLiquidProgAccentEnabled', '#themeBgLiquidProgAccent', '#themeBgLiquidProgAccentRow', typeof progression.colorAccent === 'string');
    syncControl('#themeBgLiquidProgScaleEnabled', '#themeBgLiquidProgScale', '#themeBgLiquidProgScaleRow', Number.isFinite(progression.scale));
    syncControl('#themeBgLiquidProgRoughnessEnabled', '#themeBgLiquidProgRoughness', '#themeBgLiquidProgRoughnessRow', Number.isFinite(progression.roughness));
    syncControl('#themeBgLiquidProgDistortionEnabled', '#themeBgLiquidProgDistortion', '#themeBgLiquidProgDistortionRow', Number.isFinite(progression.distortion));
    syncControl('#themeBgLiquidProgLacunarityEnabled', '#themeBgLiquidProgLacunarity', '#themeBgLiquidProgLacunarityRow', Number.isFinite(progression.lacunarity));
    syncControl('#themeBgLiquidProgTrailEnabled', '#themeBgLiquidProgTrail', '#themeBgLiquidProgTrailRow', Number.isFinite(progression.trail));
    syncControl('#themeBgLiquidProgMotionEnabled', '#themeBgLiquidProgMotion', '#themeBgLiquidProgMotionRow', Number.isFinite(progression.motion));
    syncControl('#themeBgLiquidProgReactionEnabled', '#themeBgLiquidProgReaction', '#themeBgLiquidProgReactionRow', Number.isFinite(progression.reaction));
    this._syncProgressionPreviewButton();
  }

  // ─── Slot rendering ────────────────────────────────────

  _loadAndPositionSlots() {
    if (!this.config) return;
    for (const def of SLOT_DEFS) {
      const slotCfg = this.config.slots[def.id];
      const el = this.slotElements[def.id];
      if (!el) continue;

      el.style.display = (def.hidden || slotCfg?.visible === false) ? 'none' : '';
      // Apply darken filter for column slots
      if (slotCfg?.darken > 0) {
        el.style.filter = `brightness(${1 - slotCfg.darken / 100})`;
      }
      this._loadSlotAsset(def);
      this._positionSlot(def.id);
    }
    this._applyLayerOrder();
  }

  _refreshSlotPositions() {
    if (!this.config) return;
    for (const def of SLOT_DEFS) {
      this._positionSlot(def.id);
    }
    this.updateSurvivalProgressIndicator(this._survivalProgressState);
    this._renderPvpOpponentTarget();
    this._renderPvpAimTimer();
    this._layoutFlame();
  }

  _getAdjustedSlotY(slotId, rawY) {
    if (this.editMode) return rawY;
    if (this._compactShift <= 0 || !COMPACT_TOP_SLOTS.has(slotId)) return rawY;
    // Allow negative values — slot-clip overflow:hidden clips naturally
    return rawY - this._compactShift;
  }

  _positionSlot(slotId) {
    const def = SLOT_DEFS.find(d => d.id === slotId);
    const slotCfg = this.config?.slots[slotId];
    const el = this.slotElements[slotId];
    if (!def || !slotCfg || !el) return;

    const scale = slotCfg.scale || 1;
    el.style.left = slotCfg.x + '%';
    el.style.top = this._getAdjustedSlotY(slotId, slotCfg.y) + '%';
    el.style.width = (def.baseWidth * scale) + '%';
    this._applySlotTransform(slotId);
  }

  async _loadSlotAsset(def) {
    const el = this.slotElements[def.id];
    if (!el) return;

    // Dynamic slots (ball counter) don't load image assets
    if (def.dynamic) return;
    if (def.id === 'character' && this._characterPortraitRuntime) return;

    const slotCfg = this.config?.slots[def.id];

    // Custom source takes priority
    if (slotCfg?.customSrc) {
      if (def.id === 'character' && this._characterPortraitRuntime) return;
      const resolvedUrl = await resolveImageSource(slotCfg.customSrc);
      if (!resolvedUrl) return;
      el.style.backgroundImage = this._cssUrl(resolvedUrl);
      this._resolvedAssets[def.id] = resolvedUrl;
      this._renderPvpOpponentTarget();
      this._renderPvpAimTimer();
      return;
    }

    // Check cache
    if (this._resolvedAssets[def.id]) {
      if (def.id === 'character' && this._characterPortraitRuntime) return;
      el.style.backgroundImage = this._cssUrl(this._resolvedAssets[def.id]);
      this._renderPvpOpponentTarget();
      this._renderPvpAimTimer();
      return;
    }

    const url = await preloadAsset(def.basename);
    if (url) {
      this._resolvedAssets[def.id] = url;
      if (el.dataset.slotId === def.id && !(def.id === 'character' && this._characterPortraitRuntime)) {
        el.style.backgroundImage = this._cssUrl(url);
      }
      this._renderPvpOpponentTarget();
      this._renderPvpAimTimer();
    }
  }

  _cssUrl(src) {
    return `url("${String(src).replace(/"/g, '\\"')}")`;
  }

  // ─── Ball counter ───────────────────────────────────

  updateBallCounter(ballsLeft, totalBalls) {
    const el = this.slotElements.ballCounter;
    if (!el) return;
    const slotCfg = this.config?.slots.ballCounter;
    if (!slotCfg || slotCfg.visible === false) return;

    const finiteBallsLeft = Number.isFinite(ballsLeft);
    const displayBalls = finiteBallsLeft ? Math.max(0, Math.round(ballsLeft)) : 0;
    const finiteTotal = Number.isFinite(totalBalls);
    const displayTotal = finiteTotal ? Math.max(0, Math.round(totalBalls)) : displayBalls;
    const prev = this._ballCountPrev ?? displayTotal;
    this._ballCountPrev = displayBalls;

    // Build inner DOM on first call
    if (!el.querySelector('.bc-ring')) {
      el.innerHTML = '';
      el.style.backgroundImage = 'none';
      el.style.aspectRatio = '1';

      const ring = document.createElement('div');
      ring.className = 'bc-ring';
      el.appendChild(ring);

      const num = document.createElement('div');
      num.className = 'bc-number';
      el.appendChild(num);
    }

    const ring = el.querySelector('.bc-ring');
    const numEl = el.querySelector('.bc-number');
    numEl.textContent = finiteBallsLeft ? displayBalls : '∞';

    // Scale font to element size
    const w = el.offsetWidth;
    if (w > 0) el.style.setProperty('--bc-font-size', Math.round(w * 0.38) + 'px');

    // Ring shows max(totalBalls, ballsLeft) positions so bonus balls get dots too
    const ringSize = Math.max(displayTotal, displayBalls);

    // Adjust or rebuild dot elements
    const existingDots = ring.querySelectorAll('.bc-dot');
    if (existingDots.length < ringSize) {
      // Add new dots (bonus balls gained)
      for (let i = existingDots.length; i < ringSize; i++) {
        const dot = document.createElement('div');
        dot.className = 'bc-dot';
        ring.appendChild(dot);
      }
    } else if (existingDots.length > ringSize) {
      // Remove excess dots
      for (let i = existingDots.length - 1; i >= ringSize; i--) {
        existingDots[i].remove();
      }
    }

    const allDots = ring.querySelectorAll('.bc-dot');
    const n = allDots.length;
    if (n === 0) return;

    // Scale dots smaller when there are more than the base 10
    const dotSize = n <= 10 ? 11 : Math.max(6, Math.round(110 / n));
    ring.style.setProperty('--bc-dot-size', dotSize + '%');

    const filled = Math.max(0, Math.min(n, displayBalls));
    const step = (Math.PI * 2) / n;

    // Rotation offset: center filled dots at bottom (6 o'clock)
    const midIndex = (filled - 1) / 2;
    const offset = Math.PI / 2 - midIndex * step;

    // Position each dot
    const R = 42;
    for (let i = 0; i < n; i++) {
      const angle = i * step + offset;
      const x = 50 + R * Math.cos(angle);
      const y = 50 + R * Math.sin(angle);
      const dot = allDots[i];

      dot.style.left = x + '%';
      dot.style.top = y + '%';

      const isFilled = i < filled;

      // Dot just consumed: pop animation
      if (prev > displayBalls && i === filled && i < prev) {
        dot.classList.remove('bc-dot--filled', 'bc-dot--empty', 'bc-dot--appearing');
        dot.classList.add('bc-dot--popping');
        dot.addEventListener('animationend', () => {
          dot.classList.remove('bc-dot--popping');
          dot.classList.add('bc-dot--empty');
        }, { once: true });
      // Dot just gained (bonus ball): appear animation
      } else if (displayBalls > prev && i >= prev && isFilled) {
        dot.classList.remove('bc-dot--popping', 'bc-dot--empty');
        dot.classList.add('bc-dot--filled', 'bc-dot--appearing');
        dot.addEventListener('animationend', () => {
          dot.classList.remove('bc-dot--appearing');
        }, { once: true });
      } else {
        dot.classList.remove('bc-dot--popping', 'bc-dot--appearing');
        dot.classList.toggle('bc-dot--filled', isFilled);
        dot.classList.toggle('bc-dot--empty', !isFilled);
      }
    }
  }

  hideBallCounter() {
    const el = this.slotElements.ballCounter;
    if (el) {
      el.innerHTML = '';
      el.style.backgroundImage = '';
    }
    this._ballCountPrev = undefined;
  }

  // ─── Survival vertical progress marker ────────────────

  _ensureSurvivalProgressIndicator() {
    if (this._survivalProgressIndicator?.isConnected) return this._survivalProgressIndicator;
    if (!this._slotClip) return null;

    const el = document.createElement('div');
    el.className = 'survival-column-progress-marker';
    const inner = document.createElement('div');
    inner.className = 'survival-column-progress-marker__inner';
    el.appendChild(inner);
    this._slotClip.appendChild(el);
    this._survivalProgressIndicator = el;
    return el;
  }

  updateSurvivalProgressIndicator(progressState) {
    this._survivalProgressState = progressState || null;
    const el = this._ensureSurvivalProgressIndicator();
    if (!el) return;

    const columnDef = SLOT_DEFS.find(def => def.id === 'columnLeft');
    const columnCfg = this.config?.slots?.columnLeft;
    if (!progressState || !columnDef || !columnCfg || columnCfg.visible === false) {
      el.style.display = 'none';
      return;
    }

    const progressRatio = Math.max(0, Math.min(1, progressState.progressRatio ?? 0));
    const frameW = Math.max(1, this._frameW || this.frame?.clientWidth || 1);
    const frameH = Math.max(1, this._frameH || this.frame?.clientHeight || 1);
    const frameScale = Math.min(1, frameW / 444);
    const hudSqueeze = Math.max(0.82, Math.min(1, this._frameSqueeze || 1));
    const dockTop = ((frameH - (96 * frameScale * hudSqueeze)) / frameH) * 100;

    const topLeftDef = SLOT_DEFS.find(def => def.id === 'topLeft');
    const topLeftCfg = this.config?.slots?.topLeft;
    const topLeftWidth = topLeftDef && topLeftCfg
      ? topLeftDef.baseWidth * (topLeftCfg.scale || 1)
      : 0;
    const topLeftHeight = topLeftWidth * (frameW / frameH);
    const topLeftCenterY = topLeftCfg
      ? this._getAdjustedSlotY('topLeft', topLeftCfg.y)
      : 10;

    const travelTop = Math.max(9, topLeftCenterY + topLeftHeight * 0.5 + 1.5);
    const travelBottom = Math.max(travelTop + 8, Math.min(92, dockTop - 2));
    const top = travelTop + progressRatio * (travelBottom - travelTop);

    el.style.display = '';
    el.style.left = '0';
    el.style.top = `${top}%`;
    el.style.setProperty('--survival-progress-ratio', progressRatio.toFixed(4));
  }

  // ─── Health bar (orange pegs) ──────────────────────

  updateHealthBar(orangeLeft, totalOrange) {
    this._healthBarState = { orangeLeft, totalOrange };
    this._updateHealthCircle(orangeLeft, totalOrange);
    this._updateHealthCharCircle(orangeLeft, totalOrange);
    this._renderPvpOpponentTarget();
  }

  setHealthCircleColor(color) {
    if (!this.config?.slots?.healthCircle || typeof color !== 'string' || !color.trim()) return;
    this.config.slots.healthCircle.color = color.trim();
    const state = this._healthBarState || { orangeLeft: 1, totalOrange: 1 };
    this._updateHealthCircle(state.orangeLeft, state.totalOrange);
    this._renderPvpOpponentTarget();
  }

  _updateHealthCircle(orangeLeft, totalOrange) {
    const el = this.slotElements.healthCircle;
    if (!el) return;
    const slotCfg = this.config?.slots.healthCircle;
    if (!slotCfg || slotCfg.visible === false) return;

    const ratio = totalOrange > 0 ? orangeLeft / totalOrange : 1;
    const color = slotCfg.color || '#00e5ff';

    // Build inner DOM on first call:
    // .health-clip (clips via clip-path) > .health-fill (colored circle with glow)
    if (!el.querySelector('.health-clip')) {
      el.innerHTML = '';
      el.style.backgroundImage = 'none';
      el.style.aspectRatio = '1';

      const clip = document.createElement('div');
      clip.className = 'health-clip';
      const fill = document.createElement('div');
      fill.className = 'health-fill';
      clip.appendChild(fill);
      el.appendChild(clip);
    }

    const fill = el.querySelector('.health-fill');
    fill.style.background = color;
    // Clip from top: at ratio=1 full circle, at ratio=0 nothing visible
    fill.style.clipPath = `inset(${(1 - ratio) * 100}% 0 0 0)`;

    // drop-shadow on the clip wrapper glows around the clipped shape edges
    const clip = el.querySelector('.health-clip');
    const glowPx = Math.round(4 * ratio + 2);
    clip.style.filter = ratio > 0 ? `drop-shadow(0 0 ${glowPx}px ${color})` : 'none';
  }

  _updateHealthCharCircle() {
    // Static copy of characterCircle — no glow, no scaling
  }

  setPvpOpponentTarget(state = null) {
    if (!state || state.visible === false) {
      this._pvpOpponentTargetState = null;
      if (this._pvpTargetLayer) {
        this._pvpTargetLayer.remove();
        this._pvpTargetLayer = null;
      }
      return;
    }
    const next = {
      hp: Math.max(0, Number.isFinite(state.hp) ? state.hp : 3),
      maxHp: Math.max(1, Number.isFinite(state.maxHp) ? state.maxHp : 3),
      portraitSrc: typeof state.portraitSrc === 'string' && state.portraitSrc.trim()
        ? state.portraitSrc.trim()
        : null
    };
    // This is called every frame from the pvp loop; the full re-render does a
    // burst of getBoundingClientRect/getComputedStyle (forced layout) per call.
    // Skip when nothing changed — layout-affecting paths re-render explicitly.
    const prev = this._pvpOpponentTargetState;
    if (prev
      && prev.hp === next.hp
      && prev.maxHp === next.maxHp
      && prev.portraitSrc === next.portraitSrc
      && this._pvpTargetLayer) {
      return;
    }
    this._pvpOpponentTargetState = next;
    this._renderPvpOpponentTarget();
  }

  getCanvasSlotCircle(slotId = 'characterCircle', canvas = null) {
    const slot = this.slotElements?.[slotId];
    const targetCanvas = canvas || document.getElementById('gameCanvas');
    if (!slot || !targetCanvas || slot.style.display === 'none') return null;
    const slotRect = slot.getBoundingClientRect();
    const canvasRect = targetCanvas.getBoundingClientRect();
    if (!slotRect.width || !slotRect.height || !canvasRect.width || !canvasRect.height) return null;
    return {
      x: ((slotRect.left + slotRect.width / 2) - canvasRect.left) * (targetCanvas.width / canvasRect.width),
      y: ((slotRect.top + slotRect.height / 2) - canvasRect.top) * (targetCanvas.height / canvasRect.height),
      radius: Math.max(
        slotRect.width * (targetCanvas.width / canvasRect.width),
        slotRect.height * (targetCanvas.height / canvasRect.height)
      ) / 2
    };
  }

  _ensurePvpTargetLayer() {
    if (this._pvpTargetLayer || !this._slotClip) return this._pvpTargetLayer;
    const layer = document.createElement('div');
    layer.className = 'pvp-target-layer';
    this._slotClip.appendChild(layer);
    this._pvpTargetLayer = layer;
    return layer;
  }

  _getPvpTargetSlot(slotId) {
    const layer = this._ensurePvpTargetLayer();
    if (!layer) return null;
    let el = layer.querySelector(`[data-pvp-slot-id="${slotId}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = `pvp-target-slot pvp-target-slot--${slotId}`;
      el.dataset.pvpSlotId = slotId;
      layer.appendChild(el);
    }
    return el;
  }

  _renderPvpOpponentTarget() {
    const state = this._pvpOpponentTargetState;
    if (!state || !this.frame) return;
    const layer = this._ensurePvpTargetLayer();
    const canvas = document.getElementById('gameCanvas');
    const frameRect = this.frame.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect?.();
    if (!layer || !canvasRect || !canvasRect.width || !canvasRect.height) return;

    const ratio = Math.max(0, Math.min(1, state.hp / state.maxHp));
    const slotIds = ['characterCircle', 'healthCircle', 'healthCharCircle', 'character'];
    const visibleSlotIds = new Set();
    const sourceAnchor = this.slotElements?.characterCircle?.getBoundingClientRect?.();
    if (!sourceAnchor || !sourceAnchor.width || !sourceAnchor.height) return;
    const sourceAnchorCenterX = sourceAnchor.left + sourceAnchor.width / 2;
    const sourceAnchorCenterY = sourceAnchor.top + sourceAnchor.height / 2;
    const anchorCanvasY = sourceAnchorCenterY - canvasRect.top;
    const targetAnchorCenterX = sourceAnchorCenterX;
    const targetAnchorCenterY = canvasRect.top + (canvasRect.height - anchorCanvasY);
    const explicitOffsetY = Number.isFinite(state.offsetY) ? state.offsetY : 0;

    for (const slotId of slotIds) {
      const source = this.slotElements?.[slotId];
      if (!source || source.style.display === 'none') continue;
      const sourceRect = source.getBoundingClientRect();
      if (!sourceRect.width || !sourceRect.height) continue;

      const centerX = sourceRect.left + sourceRect.width / 2;
      const centerY = sourceRect.top + sourceRect.height / 2;
      const copiedCenterX = targetAnchorCenterX + (centerX - sourceAnchorCenterX);
      const copiedCenterY = targetAnchorCenterY + (centerY - sourceAnchorCenterY) + explicitOffsetY;

      const clone = this._getPvpTargetSlot(slotId);
      if (!clone) continue;
      visibleSlotIds.add(slotId);
      clone.style.display = '';
      clone.style.left = `${copiedCenterX - frameRect.left}px`;
      clone.style.top = `${copiedCenterY - frameRect.top}px`;
      clone.style.width = `${sourceRect.width}px`;
      clone.style.height = `${sourceRect.height}px`;
      clone.style.opacity = source.style.opacity || '';
      clone.style.filter = source.style.filter || '';

      if (slotId === 'healthCircle') {
        const slotCfg = this.config?.slots?.healthCircle;
        const color = slotCfg?.color || '#00e5ff';
        clone.style.backgroundImage = 'none';
        clone.style.opacity = '1';
        clone.style.setProperty('--pvp-health-color', color);
        clone.style.setProperty('--pvp-health-ratio', ratio.toFixed(4));
        if (!clone.querySelector('.health-clip')) {
          clone.innerHTML = '';
          const clip = document.createElement('div');
          clip.className = 'health-clip';
          const fill = document.createElement('div');
          fill.className = 'health-fill';
          clip.appendChild(fill);
          clone.appendChild(clip);
        }
        const clip = clone.querySelector('.health-clip');
        const fill = clone.querySelector('.health-fill');
        fill.style.background = color;
        fill.style.clipPath = `inset(${(1 - ratio) * 100}% 0 0 0)`;
        clip.style.filter = ratio > 0 ? `drop-shadow(0 0 ${Math.round(5 * ratio + 3)}px ${color})` : 'none';
      } else {
        clone.innerHTML = '';
        if (slotId === 'character' && state.portraitSrc) {
          clone.style.backgroundImage = `url("${state.portraitSrc.replace(/"/g, '\\"')}")`;
        } else {
          const computedBg = getComputedStyle(source).backgroundImage;
          clone.style.backgroundImage = computedBg && computedBg !== 'none'
            ? computedBg
            : source.style.backgroundImage;
        }
      }
    }

    for (const el of layer.querySelectorAll('.pvp-target-slot')) {
      if (!visibleSlotIds.has(el.dataset.pvpSlotId)) {
        el.style.display = 'none';
      }
    }
  }

  setPvpAimTimer(state = null) {
    if (!state || state.visible === false || !Number.isFinite(state.ratio)) {
      this._pvpAimTimerState = null;
      this._pvpAimTimerHasGeom = false;
      if (this._pvpAimTimerRing) this._pvpAimTimerRing.style.opacity = '0';
      return;
    }
    this._pvpAimTimerState = {
      ratio: Math.max(0, Math.min(1, state.ratio))
    };
    // Per-frame fast path: while the ring stays anchored to the same slot
    // geometry only the arc progress changes — two CSS vars, no layout reads.
    // Layout-affecting paths call _renderPvpAimTimer() directly, which
    // recomputes geometry and re-arms this cache.
    if (this._pvpAimTimerHasGeom && this._pvpAimTimerRing) {
      const ring = this._pvpAimTimerRing;
      const ratio = this._pvpAimTimerState.ratio;
      ring.style.setProperty('--pvp-timer-ratio', ratio.toFixed(4));
      ring.style.setProperty('--pvp-timer-dash-offset', (138.5 * (1 - ratio)).toFixed(3));
      ring.style.opacity = '1';
      return;
    }
    this._renderPvpAimTimer();
  }

  _ensurePvpAimTimerRing() {
    if (this._pvpAimTimerRing || !this._slotClip) return this._pvpAimTimerRing;
    const ring = document.createElement('div');
    ring.className = 'pvp-aim-timer-ring';
    ring.innerHTML = `
      <svg class="pvp-aim-timer-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <path class="pvp-aim-timer-track" d="M 50 6 A 44 44 0 0 1 50 94"></path>
        <path class="pvp-aim-timer-track" d="M 50 6 A 44 44 0 0 0 50 94"></path>
        <path class="pvp-aim-timer-arc" d="M 50 6 A 44 44 0 0 1 50 94"></path>
        <path class="pvp-aim-timer-arc" d="M 50 6 A 44 44 0 0 0 50 94"></path>
      </svg>
    `;
    this._slotClip.appendChild(ring);
    this._pvpAimTimerRing = ring;
    return ring;
  }

  _renderPvpAimTimer() {
    this._pvpAimTimerHasGeom = false;
    const state = this._pvpAimTimerState;
    const ring = this._ensurePvpAimTimerRing();
    if (!ring) return;
    if (!state || !this.frame) {
      ring.style.opacity = '0';
      return;
    }
    const frameRect = this.frame.getBoundingClientRect();
    const sourceRects = ['characterCircle', 'healthCircle', 'healthCharCircle']
      .map(slotId => this.slotElements?.[slotId])
      .filter(el => el && el.style.display !== 'none')
      .map(el => el.getBoundingClientRect())
      .filter(rect => rect.width && rect.height);
    if (sourceRects.length === 0) {
      ring.style.opacity = '0';
      return;
    }
    const widest = sourceRects.reduce((best, rect) => (
      Math.max(rect.width, rect.height) > Math.max(best.width, best.height) ? rect : best
    ), sourceRects[0]);
    const characterRect = this.slotElements?.characterCircle?.getBoundingClientRect?.() || widest;
    const size = Math.max(widest.width, widest.height) + 14;
    ring.style.left = `${characterRect.left + characterRect.width / 2 - frameRect.left}px`;
    ring.style.top = `${characterRect.top + characterRect.height / 2 - frameRect.top}px`;
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
    ring.style.setProperty('--pvp-timer-ratio', state.ratio.toFixed(4));
    ring.style.setProperty('--pvp-timer-dash-offset', (138.5 * (1 - state.ratio)).toFixed(3));
    ring.style.opacity = '1';
    this._pvpAimTimerHasGeom = true;
  }

  hideHealthBar() {
    const hc = this.slotElements.healthCircle;
    if (hc) {
      hc.innerHTML = '';
      hc.style.backgroundImage = '';
      hc.style.boxShadow = '';
    }
  }

  // ─── Edit-mode previews for dynamic slots ─────────

  _showDynamicSlotPreviews() {
    // Show health circle at ~60% fill as preview
    this._updateHealthCircle(6, 10);
    // Show ball counter with sample data
    this._ballCountPrev = 8;
    this.updateBallCounter(8, 10);
    this._dynamicPreviewActive = true;
  }

  _hideDynamicSlotPreviews() {
    if (!this._dynamicPreviewActive) return;
    this._dynamicPreviewActive = false;
    // Clear dynamic content — game will re-render if playing
    this.hideBallCounter();
    this.hideHealthBar();
  }

  _logSlotPositions() {
    if (!this.config) return;
    const order = this.config.layerOrder;
    console.log('%c[SLOT POSITIONS] Copy these as new defaults:', 'color: #0ff; font-weight: bold');
    for (const slotId of order) {
      const s = this.config.slots[slotId];
      if (!s) continue;
      const parts = [`x: ${+s.x.toFixed(2)}, y: ${+s.y.toFixed(2)}, scale: ${+s.scale.toFixed(2)}`];
      if (s.color) parts.push(`color: '${s.color}'`);
      if (s.darken) parts.push(`darken: ${s.darken}`);
      console.log(`  ${slotId}: { ${parts.join(', ')} }`);
    }
    console.log('%c[LAYER ORDER] back→front:', 'color: #0ff; font-weight: bold', order.join(', '));
  }

  _updateSlotInteractivity() {
    for (const def of SLOT_DEFS) {
      const el = this.slotElements[def.id];
      if (!el) continue;
      el.classList.toggle('visual-slot--editable', this.editMode);
      el.classList.toggle('visual-slot--selected', this.editMode && this.selectedSlotId === def.id);
    }
  }

  // ─── Drag / Scale ────────────────────────────────────

  _onPointerDown(e) {
    if (!this.editMode) return;

    // Find which slot was clicked
    const el = e.target.closest('.visual-slot');
    if (!el) {
      this.selectedSlotId = null;
      this._updateSlotInteractivity();
      this._buildSlotList();
      return;
    }

    const slotId = el.dataset.slotId;
    this.selectedSlotId = slotId;
    this._updateSlotInteractivity();
    this._buildSlotList();

    // Start drag
    const frameRect = this.frame.getBoundingClientRect();
    const slotCfg = this.config.slots[slotId];
    if (!slotCfg) return;

    this._dragState = {
      slotId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: slotCfg.x,
      startY: slotCfg.y,
      frameW: frameRect.width,
      frameH: frameRect.height,
    };

    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this._dragState) return;
    const { slotId, startClientX, startClientY, startX, startY, frameW, frameH } = this._dragState;
    const dx = ((e.clientX - startClientX) / frameW) * 100;
    const dy = ((e.clientY - startClientY) / frameH) * 100;
    const slotCfg = this.config.slots[slotId];
    if (!slotCfg) return;

    slotCfg.x = Math.max(0, Math.min(100, startX + dx));
    slotCfg.y = Math.max(0, Math.min(100, startY + dy));
    this._positionSlot(slotId);
  }

  _onPointerUp(e) {
    if (!this._dragState) return;
    this._dragState = null;
    this._emitChange();
  }

  _onWheel(e) {
    if (!this.editMode || !this.selectedSlotId) return;
    const el = e.target.closest('.visual-slot');
    if (!el || el.dataset.slotId !== this.selectedSlotId) return;

    e.preventDefault();
    const slotCfg = this.config.slots[this.selectedSlotId];
    if (!slotCfg) return;

    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    slotCfg.scale = Math.max(0.1, Math.min(5, (slotCfg.scale || 1) + delta));
    this._positionSlot(this.selectedSlotId);
    this._buildSlotList(); // update scale slider
    this._emitChange();
  }

  // ─── Layer order ───────────────────────────────────────

  _applyLayerOrder() {
    if (!this.config) return;
    const order = this.config.layerOrder || DEFAULT_LAYER_ORDER;
    for (let i = 0; i < order.length; i++) {
      const el = this.slotElements[order[i]];
      if (el) el.style.zIndex = 2 + i; // canvas is z-index 1
    }
  }

  _moveLayer(slotId, direction) {
    if (!this.config) return;
    const order = this.config.layerOrder;
    const idx = order.indexOf(slotId);
    if (idx < 0) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= order.length) return;
    // Swap
    [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];
    this._applyLayerOrder();
    this._buildSlotList();
    this._emitChange();
  }

  // ─── Config change callback ────────────────────────────

  _emitChange() {
    if (this.onConfigChange && this.config) {
      this.onConfigChange(this.config);
    }
  }

  _applySlotTransform(slotId) {
    const el = this.slotElements[slotId];
    if (!el) return;
    // Slot moved — the cached pvp aim-timer anchor geometry may be stale.
    this._pvpAimTimerHasGeom = false;
    const def = SLOT_DEFS.find(d => d.id === slotId);
    const fx = this._slotRuntimeFx[slotId];
    let transform = 'translate(-50%, -50%)';
    if (fx) {
      if (fx.translateX || fx.translateY) {
        transform += ` translate(${Math.round(fx.translateX || 0)}px, ${Math.round(fx.translateY || 0)}px)`;
      }
      if (Number.isFinite(fx.scale) && fx.scale !== 1) {
        transform += ` scale(${fx.scale})`;
      }
      if (Number.isFinite(fx.rotate) && fx.rotate !== 0) {
        transform += ` rotate(${fx.rotate}deg)`;
      }
    }
    if (def?.mirror) transform += ' scaleX(-1)';
    el.style.transform = transform;
  }

  _setSlotRuntimeFx(slotId, fx) {
    if (fx) {
      this._slotRuntimeFx[slotId] = fx;
    } else {
      delete this._slotRuntimeFx[slotId];
    }
    this._applySlotTransform(slotId);
  }

  _applyGambleOverlayState() {
    const target = this.gambleOverlayState?.target;
    const frameRect = this.frame?.getBoundingClientRect?.();
    if (!this.gambleUiMode || !this.gambleOverlayState?.open || !target || !frameRect) {
      this._setSlotRuntimeFx('rightCircle', null);
      this._setSlotRuntimeFx('ballCounter', null);
      return;
    }

    for (const slotId of ['rightCircle', 'ballCounter']) {
      const el = this.slotElements[slotId];
      const slotCfg = this.config?.slots?.[slotId];
      const def = SLOT_DEFS.find(item => item.id === slotId);
      if (!el || !slotCfg || !def || slotCfg.visible === false) {
        this._setSlotRuntimeFx(slotId, null);
        continue;
      }

      const currentCenterX = frameRect.width * (slotCfg.x / 100);
      const adjustedY = this._getAdjustedSlotY(slotId, slotCfg.y);
      const currentCenterY = frameRect.height * (adjustedY / 100);
      this._setSlotRuntimeFx(slotId, {
        translateX: target.centerX - currentCenterX,
        translateY: target.centerY - currentCenterY,
        scale: target.scale || 1
      });
    }
  }
}
