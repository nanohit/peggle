// Level Map — Canvas-based campaign tree visualization.
// Renders levels as connected nodes in a scrollable vertical tree.
// Nodes show character portraits (big) or ornamental icons (small).
// States: completed, current, next, secret.

import { topoOrder } from './graph/core.js';
import { computeLayout, toPixelPositions } from './graph/layout.js';
import { getNodeState } from './graph/progression.js';
import { getLevelCharacterPortraitSources, loadCharacterRegistry, resolveCharacterForLevel } from './character-config.js';
import { assetCacheKey, loadImageFromCandidates } from './asset-ref.js';

const BIG_R = 38;
const SMALL_R = 24;
const ROW_GAP = 92;
const COL_GAP = 104;
const PAD_TOP = 58;
const PAD_BOTTOM = 80;
const LINE_W = 3;

const ASSET_PATHS = {
  topBackground: 'visuals/top_level_background.webp',
  repeatBackground: 'visuals/level_backgroun.webp',
  secret: 'visuals/Level_graph/secret.webp',
  completed: 'visuals/Level_graph/completed_level.webp',
  completedSmall: 'visuals/Level_graph/completed_level_small.webp',
  locked: 'visuals/Level_graph/locked_level.webp',
};
const IMAGE_CACHE = new Map();

function loadImg(src) {
  const cacheKey = assetCacheKey(src);
  if (!cacheKey || typeof Image === 'undefined') return Promise.resolve(null);
  const cached = IMAGE_CACHE.get(cacheKey);
  if (cached) return cached.promise;
  const entry = { image: null, promise: null };
  // Drawn onto the map canvas — keep it untainted (CDN assets send CORS;
  // a blocked/hung candidate falls through to the same-origin /api/assets one).
  entry.promise = loadImageFromCandidates(src, { crossOrigin: 'anonymous' }).then(result => {
    if (!result) {
      IMAGE_CACHE.delete(cacheKey);
      return null;
    }
    const img = result.img;
    const finish = () => {
      entry.image = img;
      return img;
    };
    try {
      const decodePromise = typeof img.decode === 'function' ? img.decode() : null;
      if (decodePromise && typeof decodePromise.then === 'function') {
        return decodePromise.then(finish, finish);
      }
    } catch { /* drawImage can still use the loaded image */ }
    return finish();
  });
  IMAGE_CACHE.set(cacheKey, entry);
  return entry.promise;
}

function getLoadedImg(src) {
  return IMAGE_CACHE.get(assetCacheKey(src))?.image || null;
}

async function loadFirstImg(candidates) {
  for (const src of candidates || []) {
    if (!src) continue;
    const img = await loadImg(src);
    if (img) return img;
  }
  return null;
}

function getFirstLoadedImg(candidates) {
  for (const src of candidates || []) {
    if (!src) continue;
    const img = getLoadedImg(src);
    if (img) return img;
  }
  return null;
}

function resolveLevelForNode(levels, node) {
  if (!node) return null;
  if (typeof node.levelIndex === 'number') return levels[node.levelIndex];
  if (node.levelName) {
    return levels.find(l => {
      const safe = (l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      return safe === node.levelName || l.name === node.levelName;
    });
  }
  return null;
}

function characterPortraitKey(level) {
  const character = resolveCharacterForLevel(level, loadCharacterRegistry());
  const idle = character?.slots?.idle;
  return `${character?.id || 'character'}:${idle || '__default_character__'}`;
}

function characterPortraitSources(level) {
  return getLevelCharacterPortraitSources(level, loadCharacterRegistry(), 'idle');
}

export function prewarmLevelMapAssets(levels = [], graph = { nodes: [] }, options = {}) {
  const includePortraits = options.includePortraits === true;
  const staticLoads = Object.values(ASSET_PATHS).map(src => loadImg(src));
  if (!includePortraits) return Promise.all(staticLoads);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const portraitLoads = nodes.map(node => {
    const level = resolveLevelForNode(levels, node);
    return loadFirstImg(characterPortraitSources(level));
  });
  return Promise.all([...staticLoads, ...portraitLoads]);
}

export class LevelMap {
  /**
   * @param {Object} opts
   * @param {Array} opts.levels       - Resolved level data array (in play order)
   * @param {Object} opts.graph       - { nodes: [{id, levelIndex|levelName, children, type}] }
   * @param {Set}    opts.completedNodes - Set of completed node IDs
   * @param {number|null} opts.currentNodeId - Node ID currently being played
   * @param {Function} opts.onSelect  - Callback(nodeId) when player taps a selectable node
   * @param {Function} opts.onClose   - Callback when map is closed
   */
  constructor(opts) {
    this.levels = opts.levels || [];
    this.graph = opts.graph || { nodes: [] };
    this.completedNodes = opts.completedNodes || new Set();
    this.currentNodeId = opts.currentNodeId ?? null;
    this.onSelect = opts.onSelect || null;
    this.onClose = opts.onClose || null;
    this.closable = opts.closable !== false;
    this.contentInsetTop = Math.max(0, Math.round(opts.contentInsetTop || 0));
    this.boundsRect = opts.boundsRect || null;
    this.boundsEl = opts.boundsEl || null;
    this.boundsFillParentHeight = opts.boundsFillParentHeight === true;

    this.playOrder = [];              // node IDs in play order
    this.nodePositions = new Map();   // nodeId → {x, y, big, row, col}
    this.canvasW = 0;
    this.canvasH = 0;

    this._assets = {};
    this._portraits = new Map();      // nodeId → Image

    this._overlay = null;
    this._scrollEl = null;
    this._contentEl = null;
    this._canvas = null;
    this._ctx = null;
    this._disposed = false;

    // Parent map for unlock logic (node is unlocked when all parents are completed)
    this._parentMap = new Map();
    for (const n of (this.graph.nodes || [])) {
      for (const cid of (n.children || [])) {
        if (!this._parentMap.has(cid)) this._parentMap.set(cid, []);
        this._parentMap.get(cid).push(n.id);
      }
    }

    this._computePlayOrder();
    this._computeLayout();
  }

  // ─── Public API ──────────────────────────────────────────

  async show(parent) {
    if (!this.graph?.nodes?.length) return;
    this._loadAssets()
      .then(() => {
        if (!this._disposed) {
          this._applyScrollingBackground();
          this._render();
        }
      })
      .catch(error => console.warn('[level-map] Asset load failed', error));
    this._primeAssetsFromCache();
    this._buildDOM(parent);
    if (this._disposed) return;
    this._render();
    requestAnimationFrame(() => this._scrollToCurrent());
  }

  hide(options = {}) {
    this._disposed = true;
    const overlay = this._overlay;
    if (!overlay) return Promise.resolve();

    const fadeMs = Math.max(0, Number(options.fadeMs || 0));
    const scrollUpMs = Math.max(0, Number(options.scrollUpMs || 0));
    const scrollDirection = options.scrollDirection === 'down' ? 'down' : 'up';
    const cleanup = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (this._overlay === overlay) {
        this._overlay = null;
        this._contentEl = null;
        this._canvas = null;
        this._ctx = null;
      }
    };

    if (scrollUpMs > 0) {
      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          cleanup();
          resolve();
        };
        overlay.style.transition = `transform ${scrollUpMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        overlay.style.transform = 'translateY(0)';
        overlay.style.pointerEvents = 'none';
        overlay.style.willChange = 'transform';
        overlay.classList.add('level-map-overlay--slide-up');
        requestAnimationFrame(() => {
          overlay.style.transform = scrollDirection === 'down' ? 'translateY(100%)' : 'translateY(-100%)';
        });
        const timer = setTimeout(finish, scrollUpMs + 80);
        overlay.addEventListener('transitionend', () => {
          clearTimeout(timer);
          finish();
        }, { once: true });
      });
    }

    if (fadeMs <= 0) {
      cleanup();
      return Promise.resolve();
    }

    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      overlay.style.transition = `opacity ${fadeMs}ms ease`;
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
      const timer = setTimeout(finish, fadeMs + 34);
      overlay.addEventListener('transitionend', () => {
        clearTimeout(timer);
        finish();
      }, { once: true });
    });
  }

  get visible() {
    return !!this._overlay;
  }

  // ─── Play order (topological sort) ───────────────────────

  _computePlayOrder() {
    this.playOrder = topoOrder(this.graph, true);
  }

  // ─── Layout ──────────────────────────────────────────────

  _computeLayout() {
    const nodes = this.graph?.nodes;
    if (!nodes?.length) return;

    const layout = computeLayout(this.graph);
    if (!layout) return;

    const { parentMap, nodeMap } = layout;
    const padX = Math.max(60, BIG_R + 20);
    const { positions: rawPos, width: rawW, height: rawH } = toPixelPositions(
      layout, nodes, { rowH: ROW_GAP, colW: COL_GAP, padX, padY: PAD_TOP }
    );
    const minCanvasW = Math.max(0, Math.round(this.boundsRect?.width || 0));
    const width = Math.max(rawW, minCanvasW);
    const xOffset = Math.round((width - rawW) / 2);
    const height = rawH + PAD_BOTTOM + BIG_R * 2;

    // Big vs small node determination
    const bigSet = new Set();
    for (const n of nodes) {
      const pids = parentMap.get(n.id) || [];
      if (pids.length === 0) { bigSet.add(n.id); continue; }
      const level = this._resolveLevel(n);
      const parentLevel = this._resolveLevel(nodeMap.get(pids[0]));
      const charKey = this._characterPortraitKey(level);
      const pCharKey = this._characterPortraitKey(parentLevel);
      if (charKey !== pCharKey) bigSet.add(n.id);
    }

    // Merge big flag into positions
    for (const n of nodes) {
      const pos = rawPos.get(n.id);
      if (pos) {
        pos.big = bigSet.has(n.id);
        pos.x += xOffset;
        this.nodePositions.set(n.id, pos);
      }
    }

    this.canvasW = width;
    this.canvasH = height;
  }

  _resolveLevel(node) {
    return resolveLevelForNode(this.levels, node);
  }

  _getNodeState(nodeId) {
    const node = this.graph.nodes.find(n => n.id === nodeId);
    return getNodeState(nodeId, node, this.currentNodeId, this.completedNodes, this._parentMap);
  }

  _characterPortraitKey(level) {
    return characterPortraitKey(level);
  }

  _characterPortraitSources(level) {
    return characterPortraitSources(level);
  }

  // ─── Asset loading ───────────────────────────────────────

  async _loadAssets() {
    const entries = Object.entries(ASSET_PATHS);
    const staticLoads = Promise.all(entries.map(([, p]) => loadImg(p))).then(imgs => {
      entries.forEach(([k], i) => { this._assets[k] = imgs[i]; });
    });

    const portraitLoads = [];
    for (const node of this.graph.nodes) {
      const level = this._resolveLevel(node);
      portraitLoads.push(
        loadFirstImg(this._characterPortraitSources(level)).then(img => {
          if (img) this._portraits.set(node.id, img);
        })
      );
    }
    await Promise.all([staticLoads, ...portraitLoads]);
  }

  _primeAssetsFromCache() {
    for (const [key, path] of Object.entries(ASSET_PATHS)) {
      const img = getLoadedImg(path);
      if (img) this._assets[key] = img;
    }

    for (const node of this.graph.nodes) {
      const level = this._resolveLevel(node);
      const img = getFirstLoadedImg(this._characterPortraitSources(level));
      if (img) this._portraits.set(node.id, img);
    }
  }

  // ─── DOM ─────────────────────────────────────────────────

  _buildDOM(parent) {
    this._overlay = document.createElement('div');
    this._overlay.className = 'level-map-overlay';

    if (this.boundsRect) {
      const b = this.boundsRect;
      this._overlay.style.inset = 'auto';
      this._overlay.style.left = Math.round(b.left || 0) + 'px';
      this._overlay.style.top = Math.round(b.top || 0) + 'px';
      this._overlay.style.width = Math.round(b.width || 0) + 'px';
      this._overlay.style.height = Math.round(b.height || 0) + 'px';
    } else if (this.boundsEl && parent && parent.contains(this.boundsEl)) {
      const parentRect = parent.getBoundingClientRect();
      const boundsRect = this.boundsEl.getBoundingClientRect();
      this._overlay.style.inset = 'auto';
      this._overlay.style.left = Math.round(boundsRect.left - parentRect.left) + 'px';
      this._overlay.style.width = Math.round(boundsRect.width) + 'px';
      if (this.boundsFillParentHeight) {
        this._overlay.style.top = '0px';
        this._overlay.style.height = Math.round(parentRect.height) + 'px';
      } else {
        this._overlay.style.top = Math.round(boundsRect.top - parentRect.top) + 'px';
        this._overlay.style.height = Math.round(boundsRect.height) + 'px';
      }
      const br = this.boundsFillParentHeight ? '' : getComputedStyle(this.boundsEl).borderRadius;
      if (br) this._overlay.style.borderRadius = br;
    }

    // Tap backdrop to close
    this._overlay.addEventListener('click', (e) => {
      if (this.closable && e.target === this._overlay) {
        this.hide();
        if (this.onClose) this.onClose();
      }
    });

    // Scroll container
    this._scrollEl = document.createElement('div');
    this._scrollEl.className = 'level-map-scroll';
    if (this.boundsRect?.width) {
      this._scrollEl.style.setProperty('--level-map-content-width', Math.round(this.boundsRect.width) + 'px');
    }

    this._contentEl = document.createElement('div');
    this._contentEl.className = 'level-map-content';
    this._contentEl.style.width = this.canvasW + 'px';
    this._contentEl.style.paddingTop = (10 + this.contentInsetTop) + 'px';

    // Canvas
    const dpr = window.devicePixelRatio || 1;
    this._canvas = document.createElement('canvas');
    this._canvas.className = 'level-map-canvas';
    this._canvas.width = this.canvasW * dpr;
    this._canvas.height = this.canvasH * dpr;
    this._canvas.style.width = this.canvasW + 'px';
    this._canvas.style.height = this.canvasH + 'px';

    this._ctx = this._canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);

    this._canvas.addEventListener('click', (e) => { e.stopPropagation(); this._onClick(e); });

    this._contentEl.appendChild(this._canvas);
    this._scrollEl.appendChild(this._contentEl);
    this._overlay.appendChild(this._scrollEl);
    parent.appendChild(this._overlay);
    this._overlay.classList.add('visible');
    this._applyScrollingBackground();
  }

  // ─── Rendering ───────────────────────────────────────────

  _render() {
    const ctx = this._ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvasW, this.canvasH);

    // Connection lines (behind nodes)
    this._drawConnections(ctx);

    // Nodes (in depth order so deeper nodes are on top)
    const sorted = [...this.graph.nodes].sort((a, b) => {
      const pa = this.nodePositions.get(a.id);
      const pb = this.nodePositions.get(b.id);
      return (pa?.row || 0) - (pb?.row || 0);
    });
    for (const node of sorted) {
      const pos = this.nodePositions.get(node.id);
      if (pos) this._drawNode(ctx, node, pos);
    }
  }

  _applyScrollingBackground() {
    if (!this._contentEl) return;
    const topImg = this._assets.topBackground;
    const repeatImg = this._assets.repeatBackground;
    const width = Math.max(1, Math.ceil(this.canvasW || this.boundsRect?.width || 1));
    const topHeight = this._scaledBackgroundHeight(topImg, width);
    const repeatHeight = this._scaledBackgroundHeight(repeatImg, width);
    const scrollHeight = Math.max(0, Math.ceil(this._scrollEl?.clientHeight || this.boundsRect?.height || 0));
    const minBackgroundHeight = Math.max(topHeight + repeatHeight, scrollHeight + repeatHeight);

    this._contentEl.style.setProperty('--level-map-bg-width', `${width}px`);
    this._contentEl.style.setProperty('--level-map-top-bg-height', `${topHeight}px`);
    this._contentEl.style.setProperty('--level-map-repeat-bg-height', `${repeatHeight}px`);
    this._contentEl.style.setProperty('--level-map-repeat-bg-y', `${topHeight}px`);
    this._contentEl.style.setProperty('--level-map-min-bg-height', `${minBackgroundHeight}px`);
  }

  _scaledBackgroundHeight(img, width) {
    const sourceW = Math.max(1, img?.naturalWidth || img?.width || 941);
    const sourceH = Math.max(1, img?.naturalHeight || img?.height || 1672);
    return Math.max(1, Math.ceil(width * sourceH / sourceW));
  }

  _drawConnections(ctx) {
    for (const node of this.graph.nodes) {
      const from = this.nodePositions.get(node.id);
      if (!from) continue;
      const children = node.children || [];
      if (children.length === 0) continue;

      const fromR = from.big ? BIG_R : SMALL_R;

      for (const cid of children) {
        const to = this.nodePositions.get(cid);
        if (!to) continue;
        const toR = to.big ? BIG_R : SMALL_R;
        this._drawCurve(ctx, from.x, from.y + fromR + 2, to.x, to.y - toR - 2);
      }
    }
  }

  _drawCurve(ctx, x1, y1, x2, y2) {
    const midY = (y1 + y2) / 2;

    // Outer stroke (dark border)
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = LINE_W + 3;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Inner stroke (lighter)
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    ctx.strokeStyle = '#777';
    ctx.lineWidth = LINE_W;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  _drawNode(ctx, node, pos) {
    const state = this._getNodeState(node.id);

    if (state === 'secret') {
      this._drawSecretNode(ctx, pos);
      return;
    }

    // Locked nodes rendered same as 'next' (dimmed) with lock overlay
    const renderState = state === 'locked' ? 'next' : state;

    if (pos.big) {
      this._drawBigNode(ctx, node, pos, renderState);
    } else {
      this._drawSmallNode(ctx, pos, renderState);
    }

    if (state === 'locked') {
      this._drawLockOverlay(ctx, pos);
    }
  }

  _drawLockOverlay(ctx, pos) {
    const r = pos.big ? BIG_R : SMALL_R;
    const { x, y } = pos;
    const asset = this._assets.locked;
    if (asset) {
      const s = r * 0.7;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(asset, x - s, y - s, s * 2, s * 2);
      ctx.globalAlpha = 1;
    } else {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#888';
      ctx.font = `bold ${r * 0.6}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔒', x, y);
      ctx.restore();
    }
  }

  _drawBigNode(ctx, node, pos, state) {
    const r = BIG_R;
    const { x, y } = pos;
    ctx.save();

    // Glow for current level
    if (state === 'current') {
      ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
      ctx.shadowBlur = 22;
    }

    // Base circle (from asset or fallback)
    const base = this._assets.completed;
    if (base) {
      ctx.drawImage(base, x - r, y - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1f';
      ctx.fill();
    }

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Portrait
    const portrait = this._portraits.get(node.id);
    if (portrait) {
      const maxW = r * 1.48;
      const maxH = r * 1.86;
      const aspect = portrait.width / portrait.height;
      let dw = maxW;
      let dh = dw / aspect;
      if (dh > maxH) {
        dh = maxH;
        dw = dh * aspect;
      }
      const bottom = y + r - 5;
      ctx.drawImage(portrait, x - dw / 2, bottom - dh, dw, dh);

      // Darken for future levels
      if (state === 'next') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.beginPath();
        ctx.arc(x, y, r - 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Border ring
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = state === 'current' ? '#fff' : state === 'completed' ? '#999' : '#444';
    ctx.lineWidth = state === 'current' ? 3 : 2;
    ctx.stroke();

    ctx.restore();
  }

  _drawSmallNode(ctx, pos, state) {
    const r = SMALL_R;
    const { x, y } = pos;
    ctx.save();

    if (state === 'current') {
      ctx.shadowColor = 'rgba(255, 255, 255, 0.45)';
      ctx.shadowBlur = 16;
    }

    // Ornamental asset
    const asset = this._assets.completedSmall;
    if (asset) {
      // Dim for future
      if (state === 'next') ctx.globalAlpha = 0.4;
      ctx.drawImage(asset, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1f';
      ctx.fill();
    }

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // White center dot
    if (state === 'completed' || state === 'current') {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = state === 'current' ? '#fff' : '#aaa';
      ctx.fill();
    }

    // Border
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = state === 'current' ? '#fff' : state === 'completed' ? '#666' : '#333';
    ctx.lineWidth = state === 'current' ? 2.5 : 1.5;
    ctx.stroke();

    ctx.restore();
  }

  _drawSecretNode(ctx, pos) {
    const r = SMALL_R;
    const { x, y } = pos;

    const asset = this._assets.secret;
    if (asset) {
      ctx.drawImage(asset, x - r, y - r, r * 2, r * 2);
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1f';
      ctx.fill();
      ctx.fillStyle = '#888';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', x, y);
      ctx.restore();
    }
  }

  // ─── Scroll ──────────────────────────────────────────────

  _scrollToCurrent() {
    if (!this._scrollEl) return;
    if (this._scrollEl.clientWidth === 0 || this._scrollEl.clientHeight === 0) {
      requestAnimationFrame(() => this._scrollToCurrent());
      return;
    }
    // Scroll to current node, or first unlocked "next" node, or last completed
    let targetId = this.currentNodeId;
    if (targetId == null || !this.nodePositions.has(targetId)) {
      // Find first 'next' node in play order
      for (const nid of this.playOrder) {
        if (this._getNodeState(nid) === 'next') { targetId = nid; break; }
      }
    }
    if (targetId == null || !this.nodePositions.has(targetId)) return;
    const pos = this.nodePositions.get(targetId);
    const top = pos.y - this._scrollEl.clientHeight / 2;
    const left = pos.x - this._scrollEl.clientWidth / 2;
    this._scrollEl.scrollTop = Math.max(0, top);
    this._scrollEl.scrollLeft = Math.max(0, left);
  }

  // ─── Interaction ─────────────────────────────────────────

  _onClick(e) {
    if (!this.onSelect) return;

    const rect = this._canvas.getBoundingClientRect();
    const sx = this.canvasW / rect.width;
    const sy = this.canvasH / rect.height;
    const mx = (e.clientX - rect.left) * sx;
    const my = (e.clientY - rect.top) * sy;

    for (const node of this.graph.nodes) {
      const pos = this.nodePositions.get(node.id);
      if (!pos) continue;

      const r = pos.big ? BIG_R : SMALL_R;
      const dx = mx - pos.x, dy = my - pos.y;
      if (dx * dx + dy * dy <= (r + 8) * (r + 8)) {
        const state = this._getNodeState(node.id);
        if (state === 'completed' || state === 'current' || state === 'next') {
          this.onSelect(node.id);
        }
        return;
      }
    }
  }
}

// Re-export for backward compat
export { graphFromLevels as linearGraphFromLevels } from './graph/core.js';
