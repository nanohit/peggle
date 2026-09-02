// Level Map — Canvas-based campaign tree visualization.
// Renders levels as connected nodes in a scrollable vertical tree.
// Nodes are rendered procedurally as illuminated machine controls.
// States: completed, current, next, secret.

import { topoOrder } from './graph/core.js';
import { computeLayout, toPixelPositions } from './graph/layout.js';
import { getNodeState } from './graph/progression.js';
import { loadCharacterRegistry, resolveCharacterForLevel } from './character-config.js';

const BIG_R = 38;
const SMALL_R = 24;
const ROW_GAP = 92;
const COL_GAP = 104;
const PAD_TOP = 58;
const PAD_BOTTOM = 80;
const LINE_W = 3;

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
  return character?.id || 'character';
}

export function prewarmLevelMapAssets() {
  // Kept for API compatibility. The map has no raster assets to prewarm.
  return Promise.resolve([]);
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
    const width = Math.max(1, Math.ceil(this.canvasW || this.boundsRect?.width || 1));
    const scrollHeight = Math.max(0, Math.ceil(this._scrollEl?.clientHeight || this.boundsRect?.height || 0));
    this._contentEl.style.setProperty('--level-map-bg-width', `${width}px`);
    this._contentEl.style.setProperty('--level-map-min-bg-height', `${Math.max(this.canvasH, scrollHeight)}px`);
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
        const fromState = this._getNodeState(node.id);
        const toState = this._getNodeState(cid);
        const energized = fromState === 'completed'
          || fromState === 'current'
          || toState === 'current';
        this._drawCurve(ctx, from.x, from.y + fromR + 2, to.x, to.y - toR - 2, energized);
      }
    }
  }

  _drawCurve(ctx, x1, y1, x2, y2, energized = false) {
    const midY = (y1 + y2) / 2;

    // Recessed cable trench.
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    ctx.strokeStyle = 'rgba(0, 3, 9, 0.9)';
    ctx.lineWidth = LINE_W + 7;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    ctx.strokeStyle = energized ? 'rgba(13, 87, 113, 0.92)' : 'rgba(20, 42, 55, 0.76)';
    ctx.lineWidth = LINE_W + 3;
    ctx.stroke();

    const cable = ctx.createLinearGradient(x1, y1, x2, y2);
    cable.addColorStop(0, energized ? '#8df5ff' : '#395b68');
    cable.addColorStop(0.5, energized ? '#2ac7e4' : '#183745');
    cable.addColorStop(1, energized ? '#8df5ff' : '#395b68');
    ctx.save();
    if (energized) {
      ctx.shadowColor = 'rgba(70, 224, 255, 0.72)';
      ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    ctx.strokeStyle = cable;
    ctx.lineWidth = energized ? 2.2 : 1.5;
    ctx.stroke();
    ctx.restore();

    if (energized) {
      const pulseX = (x1 + x2) * 0.5;
      ctx.save();
      ctx.shadowColor = '#8df5ff';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#e9feff';
      ctx.beginPath();
      ctx.arc(pulseX, midY, 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
    ctx.save();
    ctx.fillStyle = 'rgba(0, 5, 11, 0.62)';
    ctx.beginPath();
    ctx.arc(x, y, r - 3, 0, Math.PI * 2);
    ctx.fill();

    const lockW = r * 0.72;
    const lockH = r * 0.56;
    ctx.strokeStyle = 'rgba(106, 153, 171, 0.7)';
    ctx.lineWidth = Math.max(2, r * 0.11);
    ctx.beginPath();
    ctx.arc(x, y - lockH * 0.42, lockW * 0.29, Math.PI, 0);
    ctx.stroke();
    const body = ctx.createLinearGradient(x, y - 2, x, y + lockH);
    body.addColorStop(0, '#58788a');
    body.addColorStop(0.35, '#243e4c');
    body.addColorStop(1, '#09141d');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(x - lockW * 0.5, y - 2, lockW, lockH, r * 0.1);
    ctx.fill();
    ctx.fillStyle = '#93c7d3';
    ctx.beginPath();
    ctx.arc(x, y + lockH * 0.22, Math.max(1.5, r * 0.07), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawBigNode(ctx, node, pos, state) {
    const r = BIG_R;
    const { x, y } = pos;
    const current = state === 'current';
    const completed = state === 'completed';
    const accent = current ? '#71efff' : completed ? '#ff7a24' : '#31586b';
    const accentSoft = current ? 'rgba(58, 220, 255, 0.72)' : completed ? 'rgba(255, 91, 24, 0.55)' : 'rgba(47, 85, 104, 0.34)';
    ctx.save();

    // Physical cast shadow and dark lower sidewall.
    const shadow = ctx.createRadialGradient(x + 4, y + r * 0.72, 1, x + 4, y + r * 0.72, r * 1.28);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(x + 4, y + r * 0.72, r * 1.18, r * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#030a11';
    ctx.beginPath();
    ctx.arc(x + 2.8, y + 4.8, r, 0, Math.PI * 2);
    ctx.fill();

    if (current || completed) {
      ctx.shadowColor = accentSoft;
      ctx.shadowBlur = current ? 24 : 13;
    }
    const metal = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    metal.addColorStop(0, '#d8f7fb');
    metal.addColorStop(0.13, '#4f788b');
    metal.addColorStop(0.38, '#0b1d2a');
    metal.addColorStop(0.62, '#7ea4b1');
    metal.addColorStop(0.78, '#162f3d');
    metal.addColorStop(1, '#02070d');
    ctx.fillStyle = metal;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.79, 0, Math.PI * 2);
    ctx.fill();
    const glass = ctx.createRadialGradient(x - r * 0.29, y - r * 0.35, r * 0.04, x, y, r * 0.72);
    glass.addColorStop(0, current ? '#c9fbff' : completed ? '#ffc081' : '#456979');
    glass.addColorStop(0.13, current ? '#37c7de' : completed ? '#e24b12' : '#1b3c4e');
    glass.addColorStop(0.48, '#071722');
    glass.addColorStop(1, '#01050a');
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.68, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(225, 253, 255, 0.74)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.83, Math.PI * 1.08, Math.PI * 1.78);
    ctx.stroke();

    const index = Math.max(1, this.playOrder.indexOf(node.id) + 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = current || completed ? '#eafcff' : '#7093a3';
    ctx.font = `800 ${r * 0.62}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(String(index).padStart(2, '0'), x, y + 1);
    ctx.fillStyle = current ? '#72efff' : completed ? '#ff8940' : '#547482';
    ctx.font = `700 ${r * 0.16}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(current ? 'LIVE' : completed ? 'CLEAR' : 'STAGE', x, y + r * 0.43);

    if (completed) this._drawCheck(ctx, x + r * 0.69, y + r * 0.64, r * 0.22);

    ctx.restore();
  }

  _drawSmallNode(ctx, pos, state) {
    const r = SMALL_R;
    const { x, y } = pos;
    const current = state === 'current';
    const completed = state === 'completed';
    const accent = current ? '#65edff' : completed ? '#ff7024' : '#315365';
    ctx.save();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
    ctx.beginPath();
    ctx.ellipse(x + 2, y + r * 0.72, r * 0.94, r * 0.43, 0, 0, Math.PI * 2);
    ctx.fill();

    if (current || completed) {
      ctx.shadowColor = current ? 'rgba(74, 226, 255, 0.8)' : 'rgba(255, 88, 24, 0.56)';
      ctx.shadowBlur = current ? 18 : 10;
    }
    const ring = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    ring.addColorStop(0, '#bcecf2');
    ring.addColorStop(0.24, '#24495c');
    ring.addColorStop(0.55, '#07141e');
    ring.addColorStop(0.78, '#628797');
    ring.addColorStop(1, '#02070c');
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
    ctx.fill();
    const lens = ctx.createRadialGradient(x - r * 0.26, y - r * 0.3, 1, x, y, r * 0.63);
    lens.addColorStop(0, current ? '#e8feff' : completed ? '#ffd0a7' : '#7292a0');
    lens.addColorStop(0.2, accent);
    lens.addColorStop(0.62, '#071620');
    lens.addColorStop(1, '#010409');
    ctx.fillStyle = lens;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.58, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(225, 253, 255, 0.64)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.75, Math.PI * 1.08, Math.PI * 1.74);
    ctx.stroke();

    if (completed) {
      this._drawCheck(ctx, x, y, r * 0.36);
    } else {
      ctx.fillStyle = current ? '#f4ffff' : '#7794a1';
      ctx.beginPath();
      ctx.arc(x, y, current ? 3.4 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _drawSecretNode(ctx, pos) {
    const r = SMALL_R;
    const { x, y } = pos;
    ctx.save();
    ctx.shadowColor = 'rgba(223, 52, 255, 0.72)';
    ctx.shadowBlur = 18;
    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.34, 1, x, y, r);
    body.addColorStop(0, '#fff1ff');
    body.addColorStop(0.18, '#e64cff');
    body.addColorStop(0.52, '#501578');
    body.addColorStop(1, '#090213');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(246, 206, 255, 0.8)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(x, y, r - 2, Math.PI * 1.05, Math.PI * 1.82);
    ctx.stroke();
    ctx.fillStyle = '#fff4ff';
    ctx.font = `800 ${r * 0.9}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y + 1);
    ctx.restore();
  }

  _drawCheck(ctx, x, y, size) {
    ctx.save();
    ctx.strokeStyle = '#f4ffff';
    ctx.lineWidth = Math.max(1.6, size * 0.28);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(98, 239, 255, 0.82)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x - size * 0.6, y);
    ctx.lineTo(x - size * 0.15, y + size * 0.45);
    ctx.lineTo(x + size * 0.68, y - size * 0.48);
    ctx.stroke();
    ctx.restore();
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
