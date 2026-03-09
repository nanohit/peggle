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

    // Slot clip layer — clips decorative assets to frame bounds
    this._slotClip = document.createElement('div');
    this._slotClip.className = 'visual-slot-clip';
    this.frame.appendChild(this._slotClip);

    // Create slot elements inside the clip layer
    for (const def of SLOT_DEFS) {
      const el = document.createElement('div');
      el.className = 'visual-slot';
      el.dataset.slotId = def.id;
      this._slotClip.appendChild(el);
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
  }

  setSpinMode(active) {
    if (this.frame) this.frame.classList.toggle('visual-frame--spin', !!active);
  }

  setEditMode(active) {
    this.editMode = !!active;
    if (this.frame) this.frame.classList.toggle('visual-frame--editing', this.editMode);
    if (!this.editMode) this.selectedSlotId = null;
    this._updateSlotInteractivity();
    if (this.panel) {
      const btn = this.panel.querySelector('#themeEditBtn');
      if (btn) btn.textContent = this.editMode ? 'Done Editing' : 'Edit Layout';
    }
  }

  setPanelVisible(visible) {
    if (this.panel) this.panel.classList.toggle('hidden', !visible);
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
              <option value="gradient">Gradient</option>
              <option value="solid">Solid</option>
            </select>
          </div>
          <div class="theme-row">
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
          <button id="themeApplyDefaultBtn" class="theme-edit-btn" style="margin-top:6px">Apply as Default</button>
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
      this.panel.querySelector('#themeBgBottomRow').style.display = e.target.value === 'solid' ? 'none' : '';
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

    this.panel.querySelector('#themeFrameColor').addEventListener('input', e => {
      if (!this.config) return;
      this.config.frameColor = e.target.value;
      this.frame.style.backgroundColor = e.target.value;
      this._emitChange();
    }, { signal: sig });

    this.panel.querySelector('#themeEditBtn').addEventListener('click', () => {
      this.setEditMode(!this.editMode);
    }, { signal: sig });

    this.panel.querySelector('#themeApplyDefaultBtn').addEventListener('click', () => {
      if (!this.config) return;
      try {
        // Save current visuals as the user's default template
        const copy = JSON.parse(JSON.stringify(this.config));
        // Strip customSrc (data URLs are too large for a default)
        for (const id of Object.keys(copy.slots)) {
          delete copy.slots[id].customSrc;
        }
        localStorage.setItem('peggle_visualDefaults', JSON.stringify(copy));
        const btn = this.panel.querySelector('#themeApplyDefaultBtn');
        btn.textContent = 'Saved!';
        setTimeout(() => { btn.textContent = 'Apply as Default'; }, 1200);
      } catch (_) {}
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
          this.config.slots[def.id].scale = 1;
          this.config.slots[def.id].customSrc = null;
          this._resolvedAssets[def.id] = null;
          this._loadSlotAsset(def);
          this._positionSlot(def.id);
          this._buildSlotList();
          this._emitChange();
        }
      });

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
    const botRow = sel('#themeBgBottomRow');
    if (botRow) botRow.style.display = bg.type === 'solid' ? 'none' : '';
    const fc = sel('#themeFrameColor');
    if (fc) fc.value = this.config.frameColor;
    this._buildSlotList();
  }

  // ─── Slot rendering ────────────────────────────────────

  _loadAndPositionSlots() {
    if (!this.config) return;
    for (const def of SLOT_DEFS) {
      const slotCfg = this.config.slots[def.id];
      const el = this.slotElements[def.id];
      if (!el) continue;

      el.style.display = slotCfg?.visible !== false ? '' : 'none';
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
    el.style.transform = 'translate(-50%, -50%)';
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
}
