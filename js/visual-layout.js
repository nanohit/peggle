// Visual Layout - DOM frame, draggable asset slots, theme panel
// Wraps the canvas in a 9:17 frame with decorative elements and a side editor panel

import { SLOT_DEFS, DEFAULT_LAYER_ORDER, resolveAssetPaths, normalizeVisuals } from './visual-config.js';

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

export class VisualLayout {
  constructor() {
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
    this._abortController = null;
    this._slotRuntimeFx = {};
    this.gambleUiMode = false;
    this.gambleOverlayState = { open: false, target: null };

    /** @type {function(object):void|null} */
    this.onConfigChange = null;
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
    const panelIds = ['animPanel', 'bumperPanel', 'flipperPanel', 'portalPanel', 'multiballPanel', 'survivalPanel'];
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

    // Build theme panel
    this._buildPanel();

    // Slot interaction listeners (active only in edit mode)
    this.frame.addEventListener('pointerdown', e => this._onPointerDown(e), { signal: sig });
    document.addEventListener('pointermove', e => this._onPointerMove(e), { signal: sig });
    document.addEventListener('pointerup', e => this._onPointerUp(e), { signal: sig });
    this.frame.addEventListener('wheel', e => this._onWheel(e), { passive: false, signal: sig });

    this.mounted = true;
  }

  dispose() {
    if (!this.mounted) return;
    if (this._abortController) this._abortController.abort();

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
    this.slotElements = {};
    this.mounted = false;
  }

  setConfig(rawConfig) {
    this.config = normalizeVisuals(rawConfig);
    if (this.frame) this.frame.style.backgroundColor = this.config.frameColor;
    this._loadAndPositionSlots();
    this._syncPanelValues();
  }

  resize(frameW, frameH) {
    this._frameW = frameW;
    this._frameH = frameH;
    // Slots use percentage positioning — CSS handles it. Nothing to recalculate.
    this._applyGambleOverlayState();
  }

  setSpinMode(active) {
    if (this.frame) this.frame.classList.toggle('visual-frame--spin', !!active);
  }

  setEditMode(active) {
    this.editMode = !!active;
    if (this.frame) this.frame.classList.toggle('visual-frame--editing', this.editMode);
    if (!this.editMode) this.selectedSlotId = null;
    this._updateSlotInteractivity();
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
    if (slotCfg?.customSrc) return slotCfg.customSrc;
    if (this._resolvedAssets[slotId]) return this._resolvedAssets[slotId];
    if (!def.basename) return null;
    return resolveAssetPaths(def.basename).webp;
  }

  getBackground() {
    return this.config?.background || null;
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
            </select>
          </div>
          <div class="theme-row" id="themeBgImageRow">
            <span class="theme-row-label">Image</span>
            <button id="themeBgImageBtn" class="theme-edit-btn" style="font-size:10px;padding:2px 6px">Upload</button>
          </div>
          <div class="theme-row" id="themeBgTopRow">
            <span class="theme-row-label">Top</span>
            <input type="color" id="themeBgTop" value="#16213e" class="theme-color">
          </div>
          <div class="theme-row" id="themeBgBottomRow">
            <span class="theme-row-label">Bottom</span>
            <input type="color" id="themeBgBottom" value="#1a1a2e" class="theme-color">
          </div>
        </div>
        <div class="theme-section">
          <div class="theme-label">Frame</div>
          <div class="theme-row">
            <span class="theme-row-label">Color</span>
            <input type="color" id="themeFrameColor" value="#0a0a14" class="theme-color">
          </div>
        </div>
        <div class="theme-section">
          <div class="theme-label">Assets</div>
          <button id="themeEditBtn" class="theme-edit-btn">Edit Layout</button>
          <div id="themeSlotList" class="theme-slot-list"></div>
          <button id="themeApplyLevelBtn" class="theme-edit-btn" style="margin-top:6px">Apply for Level</button>
          <button id="themeAssignDefaultBtn" class="theme-edit-btn">Assign Default</button>
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
      input.onchange = ev => {
        const file = ev.target.files[0];
        if (!file || !this.config) return;
        const reader = new FileReader();
        reader.onload = re => {
          this.config.background.image = re.target.result;
          this._emitChange();
        };
        reader.readAsDataURL(file);
      };
      input.click();
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

    this.panel.querySelector('#themeFrameColor').addEventListener('input', e => {
      if (!this.config) return;
      this.config.frameColor = e.target.value;
      this.frame.style.backgroundColor = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeEditBtn').addEventListener('click', () => {
      this.setEditMode(!this.editMode);
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
      if (!def) continue;
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
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = re => {
        const dataUrl = re.target.result;
        if (this.config.slots[slotId]) {
          this.config.slots[slotId].customSrc = dataUrl;
          this._resolvedAssets[slotId] = dataUrl;
          const el = this.slotElements[slotId];
          if (el) el.style.backgroundImage = `url('${dataUrl}')`;
          this._emitChange();
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  _syncPanelValues() {
    if (!this.panel || !this.config) return;
    const bg = this.config.background;
    const sel = (id) => this.panel.querySelector(id);
    const bgType = sel('#themeBgType');
    if (bgType) bgType.value = bg.type;
    const bgTop = sel('#themeBgTop');
    if (bgTop) bgTop.value = bg.colorTop;
    const bgBot = sel('#themeBgBottom');
    if (bgBot) bgBot.value = bg.colorBottom;
    const fc = sel('#themeFrameColor');
    if (fc) fc.value = this.config.frameColor;
    this._syncBgRowVisibility();
    this._buildSlotList();
  }

  _syncBgRowVisibility() {
    if (!this.panel || !this.config) return;
    const type = this.config.background.type;
    const sel = (id) => this.panel.querySelector(id);
    const imgRow = sel('#themeBgImageRow');
    const topRow = sel('#themeBgTopRow');
    const botRow = sel('#themeBgBottomRow');
    if (imgRow) imgRow.style.display = type === 'image' ? '' : 'none';
    if (topRow) topRow.style.display = type === 'image' ? 'none' : '';
    if (botRow) botRow.style.display = type === 'gradient' ? '' : 'none';
  }

  // ─── Slot rendering ────────────────────────────────────

  _loadAndPositionSlots() {
    if (!this.config) return;
    for (const def of SLOT_DEFS) {
      const slotCfg = this.config.slots[def.id];
      const el = this.slotElements[def.id];
      if (!el) continue;

      el.style.display = slotCfg?.visible !== false ? '' : 'none';
      // Apply darken filter for column slots
      if (slotCfg?.darken > 0) {
        el.style.filter = `brightness(${1 - slotCfg.darken / 100})`;
      }
      this._loadSlotAsset(def);
      this._positionSlot(def.id);
    }
    this._applyLayerOrder();
  }

  _positionSlot(slotId) {
    const def = SLOT_DEFS.find(d => d.id === slotId);
    const slotCfg = this.config?.slots[slotId];
    const el = this.slotElements[slotId];
    if (!def || !slotCfg || !el) return;

    const scale = slotCfg.scale || 1;
    el.style.left = slotCfg.x + '%';
    el.style.top = slotCfg.y + '%';
    el.style.width = (def.baseWidth * scale) + '%';
    this._applySlotTransform(slotId);
  }

  async _loadSlotAsset(def) {
    const el = this.slotElements[def.id];
    if (!el) return;

    // Dynamic slots (ball counter) don't load image assets
    if (def.dynamic) return;

    const slotCfg = this.config?.slots[def.id];

    // Custom source takes priority
    if (slotCfg?.customSrc) {
      el.style.backgroundImage = `url('${slotCfg.customSrc}')`;
      this._resolvedAssets[def.id] = slotCfg.customSrc;
      return;
    }

    // Check cache
    if (this._resolvedAssets[def.id]) {
      el.style.backgroundImage = `url('${this._resolvedAssets[def.id]}')`;
      return;
    }

    const url = await preloadAsset(def.basename);
    if (url) {
      this._resolvedAssets[def.id] = url;
      if (el.dataset.slotId === def.id) {
        el.style.backgroundImage = `url('${url}')`;
      }
    }
  }

  // ─── Ball counter ───────────────────────────────────

  updateBallCounter(ballsLeft, totalBalls) {
    const el = this.slotElements.ballCounter;
    if (!el) return;
    const slotCfg = this.config?.slots.ballCounter;
    if (!slotCfg || slotCfg.visible === false) return;

    const prev = this._ballCountPrev ?? totalBalls;
    this._ballCountPrev = ballsLeft;

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
    numEl.textContent = ballsLeft;

    // Scale font to element size
    const w = el.offsetWidth;
    if (w > 0) el.style.setProperty('--bc-font-size', Math.round(w * 0.38) + 'px');

    // Ring shows max(totalBalls, ballsLeft) positions so bonus balls get dots too
    const ringSize = Math.max(totalBalls, ballsLeft);

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

    const filled = Math.max(0, Math.min(n, ballsLeft));
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
      if (prev > ballsLeft && i === filled && i < prev) {
        dot.classList.remove('bc-dot--filled', 'bc-dot--empty', 'bc-dot--appearing');
        dot.classList.add('bc-dot--popping');
        dot.addEventListener('animationend', () => {
          dot.classList.remove('bc-dot--popping');
          dot.classList.add('bc-dot--empty');
        }, { once: true });
      // Dot just gained (bonus ball): appear animation
      } else if (ballsLeft > prev && i >= prev && isFilled) {
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

  // ─── Health bar (orange pegs) ──────────────────────

  updateHealthBar(orangeLeft, totalOrange) {
    this._updateHealthCircle(orangeLeft, totalOrange);
    this._updateHealthCharCircle(orangeLeft, totalOrange);
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
      const currentCenterY = frameRect.height * (slotCfg.y / 100);
      this._setSlotRuntimeFx(slotId, {
        translateX: target.centerX - currentCenterX,
        translateY: target.centerY - currentCenterY,
        scale: target.scale || 1
      });
    }
  }
}
