import {
  DIALOGUE_DEFAULT_IMPULSE_MAGNITUDE,
  DIALOGUE_DEFAULT_TIMEOUT_MS,
  getDialogueContentForLanguage,
  hasDialogueLocaleContent,
  normalizeDialogueConfig
} from './dialogue-config.js';
import { normalizeLanguage } from './localization.js';

const DIALOGUE_SEEN_STORAGE_KEY = 'peggle_dialogue_seen_v1';
const DIALOGUE_FADE_MS = 260;
const GAME_WORLD_REFERENCE_WIDTH = 400;
const DIALOGUE_FRAME_SIDE_PADDING = 8;
const DIALOGUE_SAFE_TOP_PADDING = 18;
const DIALOGUE_PORTRAIT_GAP = 18;
const DIALOGUE_MAX_BOTTOM_RATIO = 0.46;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function dialogueSeenRevision(entry) {
  const revision = {
    trigger: entry?.trigger || null,
    placement: entry?.placement || null,
    content: entry?.content || null
  };
  return hashString(JSON.stringify(revision));
}

export class DialogueController {
  constructor({ visualLayout, persistSeen = true } = {}) {
    this.visualLayout = visualLayout || null;
    this.persistSeen = persistSeen !== false;
    this.language = 'ru';
    this.scopeKey = 'single';
    this.level = null;
    this.config = normalizeDialogueConfig(null);
    this.live = false;
    this.portraitReactionController = null;

    this.root = null;
    this.card = null;
    this.textEl = null;
    this._resizeObserver = null;

    this._uiStateUnsub = null;
    this._perfEventUnsub = null;
    this._gambleEventUnsub = null;
    this._dismissTimer = null;
    this._hideTimer = null;

    this._active = null;
    this._queue = [];
    this._sessionTriggered = new Set();
    this._previewState = null;
    this._seenMap = null;
    this._fontsReadyPromise = null;
  }

  mount() {
    if (this.root || !this.visualLayout?.frame) return;

    const root = document.createElement('div');
    root.className = 'dialogue-layer';
    root.innerHTML = `
      <div class="dialogue-card">
        <div class="dialogue-text" aria-live="polite"></div>
      </div>
    `;
    this.visualLayout.frame.appendChild(root);

    this.root = root;
    this.card = root.querySelector('.dialogue-card');
    this.textEl = root.querySelector('.dialogue-text');
    this.refreshLayout();
    this._ensureFontLayoutRefresh();

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.refreshLayout());
      this._resizeObserver.observe(this.visualLayout.frame);
    }
  }

  dispose() {
    this._detachGame();
    this._detachGambleSystem();
    this._clearTimers();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this.root?.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.root = null;
    this.card = null;
    this.textEl = null;
    this._active = null;
    this._queue = [];
    this._previewState = null;
  }

  setLanguage(language) {
    this.language = normalizeLanguage(language);
    if (this._active) {
      this._renderEntry(this._active.entry, this._active.previewLanguage || this.language);
    }
  }

  setPortraitReactionController(controller) {
    this.portraitReactionController = controller || null;
  }

  setConfig(rawConfig) {
    this.config = normalizeDialogueConfig(rawConfig);

    if (!this._active) return;

    const updatedEntry = this.config.entries.find(item => item.id === this._active.entry.id);
    if (!updatedEntry) {
      this.dismissActive('entry-removed', { immediate: true });
      return;
    }

    this._active.entry = updatedEntry;
    if (!this._renderEntry(updatedEntry, this._active.previewLanguage || this.language)) {
      this.dismissActive('entry-empty', { immediate: true });
      return;
    }
    this.refreshLayout();
  }

  setContext({
    level,
    scopeKey = 'single',
    game = null,
    gambleSystem = null,
    persistSeen = this.persistSeen,
    live = true,
    triggerLevelStart = true
  } = {}) {
    this.mount();
    this._detachGame();
    this._detachGambleSystem();
    this._clearTimers();
    this._queue = [];
    this._active = null;
    this._previewState = null;
    this._sessionTriggered.clear();
    this._hideImmediately();

    this.level = level || null;
    this.scopeKey = scopeKey || 'single';
    this.persistSeen = persistSeen !== false;
    this.live = !!live;
    this.setConfig(level?.dialogue);

    if (game) this._attachGame(game);
    if (gambleSystem) this._attachGambleSystem(gambleSystem);
    this.refreshLayout();

    if (triggerLevelStart !== false && this.live && this.level) {
      this.evaluateEvent('levelStart', { level: this.level });
    }
  }

  setGame(game) {
    this._detachGame();
    if (game) this._attachGame(game);
  }

  setGambleSystem(gambleSystem) {
    this._detachGambleSystem();
    if (gambleSystem) this._attachGambleSystem(gambleSystem);
  }

  refreshLayout() {
    if (!this.root || !this.visualLayout?.frame) return;
    const bounds = this._computeBounds(this._active?.entry || null);
    this.root.style.left = `${Math.round(bounds.left)}px`;
    this.root.style.right = `${Math.round(bounds.right)}px`;
    this.root.style.top = `${Math.round(bounds.top)}px`;
    this.root.style.bottom = 'auto';
    this.root.style.setProperty('--dialogue-font-size', `${bounds.fontSize}px`);
    this.root.style.setProperty('--dialogue-max-width', `${Math.round(bounds.maxWidth)}px`);
    const cardHeight = this._measureCardHeight(bounds.fontSize);
    const adjustedTop = this._resolveTop(bounds, cardHeight);
    this.root.style.top = `${Math.round(adjustedTop)}px`;
  }

  previewEntry(entryOrId, options = {}) {
    const entry = typeof entryOrId === 'string'
      ? this.config.entries.find(item => item.id === entryOrId)
      : entryOrId;
    if (!entry) return;
    this._previewState = {
      entryId: entry.id,
      language: normalizeLanguage(options.language || this.language)
    };
    this._queue = [];
    this._showEntry(entry, { preview: true, languageOverride: this._previewState.language, skipSeen: true });
  }

  refreshPreview() {
    if (!this._previewState) return;
    const entry = this.config.entries.find(item => item.id === this._previewState.entryId);
    if (!entry) {
      this.hidePreview();
      return;
    }
    this.previewEntry(entry, { language: this._previewState.language });
  }

  hidePreview() {
    this._previewState = null;
    this._queue = [];
    this.dismissActive('preview-hide', { immediate: true });
  }

  evaluateEvent(type, payload = {}) {
    if (!this.level || !this.live) return;
    for (const entry of this.config.entries) {
      if (!entry.enabled) continue;
      if (entry.trigger.type !== type) continue;
      if (this._sessionTriggered.has(entry.id)) continue;
      if (entry.once && this._hasSeen(entry)) continue;
      if (!this._matchesTrigger(entry, type, payload)) continue;
      this._sessionTriggered.add(entry.id);
      if (!this._queue.some(item => item.id === entry.id) && this._active?.entry?.id !== entry.id) {
        this._queue.push(entry);
      }
    }
    this._flushQueue();
  }

  dismissActive(reason = 'manual', options = {}) {
    if (!this._active) return;
    const immediate = !!options.immediate;
    const active = this._active;
    if (active?.emotionToken && this.portraitReactionController?.clearDialogueOverride) {
      this.portraitReactionController.clearDialogueOverride(active.emotionToken);
    }
    this._clearTimers();
    this._active = null;

    if (immediate || !this.root) {
      this._hideImmediately();
      if (!active.preview) this._flushQueue();
      return;
    }

    this.root.classList.remove('dialogue-layer--visible');
    this.root.classList.add('dialogue-layer--hiding');
    this._hideTimer = setTimeout(() => {
      this.root?.classList.remove('dialogue-layer--hiding');
      if (!this._active) this.root?.classList.remove('dialogue-layer--mounted');
      this._hideTimer = null;
      if (!active.preview) this._flushQueue();
    }, DIALOGUE_FADE_MS);
  }

  _attachGame(game) {
    if (typeof game?.subscribeUiState !== 'function') return;
    this._uiStateUnsub = game.subscribeUiState((snapshot, reason) => {
      if (snapshot?.state === 'won' || snapshot?.state === 'lost') {
        this.dismissActive(snapshot.state, { immediate: true });
        return;
      }
      if (reason === 'launch' && this._active?.entry?.dismissOn?.shot) {
        this.dismissActive('shot');
      }
      if (!Number.isFinite(snapshot?.totalOrangePegs) || snapshot.totalOrangePegs <= 0) return;
      const progress = clamp(
        (snapshot.totalOrangePegs - snapshot.orangePegsLeft) / snapshot.totalOrangePegs,
        0,
        1
      );
      this.evaluateEvent('pegProgress', { progress });
    });
    if (typeof game?.subscribePerformanceEvents === 'function') {
      this._perfEventUnsub = game.subscribePerformanceEvents((type, payload) => {
        if (type === 'performanceCap30') {
          this.evaluateEvent('performanceCap30', payload || {});
        }
      });
    }
  }

  _detachGame() {
    if (this._uiStateUnsub) {
      this._uiStateUnsub();
      this._uiStateUnsub = null;
    }
    if (this._perfEventUnsub) {
      this._perfEventUnsub();
      this._perfEventUnsub = null;
    }
  }

  _attachGambleSystem(gambleSystem) {
    if (typeof gambleSystem?.subscribeEvents !== 'function') return;
    this._gambleEventUnsub = gambleSystem.subscribeEvents((type, payload) => {
      if (type === 'spin-start' && this._active?.entry?.dismissOn?.spin) {
        this.dismissActive('spin');
      } else if (type === 'spin-resolved') {
        this.evaluateEvent('spinReward', payload || {});
      }
    });
  }

  _detachGambleSystem() {
    if (this._gambleEventUnsub) {
      this._gambleEventUnsub();
      this._gambleEventUnsub = null;
    }
  }

  _flushQueue() {
    if (this._active || this._queue.length === 0) return;
    const next = this._queue.shift();
    if (!next) return;
    this._showEntry(next, { preview: false });
  }

  _showEntry(entry, options = {}) {
    this.mount();
    this._clearTimers();
    this._queue = options.preview ? [] : this._queue.filter(item => item.id !== entry.id);
    this._active = {
      entry,
      preview: !!options.preview,
      previewLanguage: options.languageOverride || null
    };

    if (!this._renderEntry(entry, options.languageOverride || this.language)) {
      this._active = null;
      if (!options.preview) this._flushQueue();
      return;
    }

    if (entry.once && !options.skipSeen && this.persistSeen) {
      this._markSeen(entry);
    }

    this.refreshLayout();
    this.root.classList.remove('dialogue-layer--hiding');
    this.root.classList.add('dialogue-layer--mounted');
    requestAnimationFrame(() => {
      this.root?.classList.add('dialogue-layer--visible');
    });

    const timeoutMs = Number.isFinite(entry.timeoutMs) ? entry.timeoutMs : DIALOGUE_DEFAULT_TIMEOUT_MS;
    this._applyEntryEmotion(entry, timeoutMs);
    if (timeoutMs > 0) {
      this._dismissTimer = setTimeout(() => {
        this.dismissActive('timeout');
      }, timeoutMs);
    }
  }

  _applyEntryEmotion(entry, timeoutMs) {
    const emotion = typeof entry?.emotion === 'string' ? entry.emotion.trim() : '';
    if (!emotion || !this.portraitReactionController) return;
    const mode = entry.mode === 'impulse' ? 'impulse' : 'override';
    if (mode === 'impulse') {
      this.portraitReactionController.fireDialogueImpulse?.(emotion, {
        magnitude: Number.isFinite(entry.emotionMagnitude)
          ? entry.emotionMagnitude
          : DIALOGUE_DEFAULT_IMPULSE_MAGNITUDE,
        eventType: 'dialogue_impulse'
      });
      return;
    }
    const token = this.portraitReactionController.setDialogueOverride?.(emotion, {
      durationMs: Number.isFinite(timeoutMs) ? timeoutMs : DIALOGUE_DEFAULT_TIMEOUT_MS
    });
    if (this._active && token) this._active.emotionToken = token;
  }

  _renderEntry(entry, preferredLanguage) {
    if (!this.textEl || !this.root) return false;
    const content = getDialogueContentForLanguage(entry, preferredLanguage);
    if (!hasDialogueLocaleContent(content.locale)) {
      this.textEl.innerHTML = '';
      return false;
    }

    this.root.dataset.lang = content.language;
    this.textEl.innerHTML = '';
    for (const segment of content.locale.segments) {
      const span = document.createElement('span');
      span.className = 'dialogue-segment';
      span.textContent = segment.text || '';
      span.style.color = segment.color || '#ffffff';
      this.textEl.appendChild(span);
    }
    this._ensureFontLayoutRefresh();
    return true;
  }

  _matchesTrigger(entry, type, payload) {
    if (type === 'levelStart') return true;
    if (type === 'pegProgress') {
      const threshold = clamp((entry.trigger.progressPercent || 0) / 100, 0, 1);
      return Number.isFinite(payload.progress) && payload.progress >= threshold;
    }
    if (type === 'spinReward') {
      const rewardIds = Array.isArray(payload.rewardIds) ? payload.rewardIds.filter(Boolean) : [];
      if (rewardIds.length === 0) return false;
      if (!Array.isArray(entry.trigger.perkIds) || entry.trigger.perkIds.length === 0) {
        return true;
      }
      return entry.trigger.perkIds.some(id => rewardIds.includes(id));
    }
    if (type === 'performanceCap30') {
      return payload?.detected === true;
    }
    return false;
  }

  _computeBounds(entry = null) {
    const frame = this.visualLayout?.frame;
    if (!frame) {
      return {
        left: 32,
        right: 32,
        top: 84,
        desiredTop: 84,
        minTop: 32,
        maxBottom: 220,
        fontSize: 28,
        maxWidth: 280
      };
    }
    const frameRect = frame.getBoundingClientRect();
    const canvasRect = this._getCanvasRect(frameRect);
    const portraitBounds = this._getPortraitBounds(frameRect);
    const canvasScale = clamp(canvasRect.width / GAME_WORLD_REFERENCE_WIDTH, 0.55, 2.4);
    const placementOffsetY = Number.isFinite(entry?.placement?.offsetY) ? entry.placement.offsetY : 0;
    const textScale = clamp(Number(entry?.placement?.textScale) || 1, 0.5, 1.8);
    const maxWidth = Math.max(140, Math.min(canvasRect.width * 0.9, frameRect.width * 0.78));
    const centerX = canvasRect.left + canvasRect.width / 2;
    const left = clamp(
      centerX - maxWidth / 2,
      DIALOGUE_FRAME_SIDE_PADDING,
      Math.max(DIALOGUE_FRAME_SIDE_PADDING, frameRect.width - maxWidth - DIALOGUE_FRAME_SIDE_PADDING)
    );
    const rightInset = Math.max(DIALOGUE_FRAME_SIDE_PADDING, frameRect.width - left - maxWidth);
    const fallbackTop = canvasRect.top + canvasRect.height * 0.18;
    const anchorTop = portraitBounds
      ? portraitBounds.bottom + DIALOGUE_PORTRAIT_GAP * canvasScale
      : fallbackTop;
    const desiredTop = anchorTop + placementOffsetY * canvasScale;
    const minTop = Math.max(DIALOGUE_SAFE_TOP_PADDING, canvasRect.top + canvasRect.height * 0.08);
    const maxBottom = Math.max(minTop + 44, canvasRect.top + canvasRect.height * DIALOGUE_MAX_BOTTOM_RATIO);
    const availableWidth = Math.max(140, frameRect.width - left - rightInset);
    const fontSize = clamp(canvasRect.width * 0.105 * textScale, 12, 64);
    return {
      left,
      right: rightInset,
      top: desiredTop,
      desiredTop,
      minTop,
      maxBottom,
      fontSize,
      maxWidth: Math.min(availableWidth, maxWidth)
    };
  }

  _measureCardHeight(fontSize = 28) {
    const cardRect = this.card?.getBoundingClientRect?.();
    if (cardRect?.height && cardRect.height > 0) {
      return cardRect.height;
    }
    const textRect = this.textEl?.getBoundingClientRect?.();
    if (textRect?.height && textRect.height > 0) {
      return textRect.height;
    }
    return Math.max(fontSize * 1.6, 44);
  }

  _resolveTop(bounds, cardHeight) {
    const safeHeight = Number.isFinite(cardHeight) && cardHeight > 0 ? cardHeight : 0;
    const maxTop = Math.max(bounds.minTop, bounds.maxBottom - safeHeight);
    return clamp(bounds.desiredTop, bounds.minTop, maxTop);
  }

  _getCanvasRect(frameRect) {
    const frame = this.visualLayout?.frame;
    const canvas = frame?.querySelector?.('#gameCanvas') || frame?.querySelector?.('canvas');
    if (canvas && typeof canvas.getBoundingClientRect === 'function') {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      return {
        left: rect.left - frameRect.left,
        right: rect.right - frameRect.left,
        top: rect.top - frameRect.top,
        bottom: rect.bottom - frameRect.top,
        width,
        height
      };
    }

    const width = Math.max(1, frameRect.width * 0.9);
    const height = Math.max(1, width * 1.5);
    const left = (frameRect.width - width) / 2;
    const top = (frameRect.height - height) / 2;
    return {
      left,
      right: left + width,
      top,
      bottom: top + height,
      width,
      height
    };
  }

  _getPortraitBounds(frameRect) {
    const portraitIds = ['characterCircle', 'healthCircle', 'healthCharCircle', 'character'];
    let minTop = Number.POSITIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    for (const slotId of portraitIds) {
      const rect = this._getSlotRect(slotId, frameRect);
      if (!rect) continue;
      minTop = Math.min(minTop, rect.top);
      maxBottom = Math.max(maxBottom, rect.bottom);
    }
    if (!Number.isFinite(minTop) || !Number.isFinite(maxBottom)) return null;
    return {
      top: minTop,
      bottom: maxBottom,
      centerY: (minTop + maxBottom) / 2
    };
  }

  _getSlotRect(slotId, frameRect = null) {
    const frame = this.visualLayout?.frame;
    const el = this.visualLayout?.slotElements?.[slotId];
    if (!frame || !el) return null;
    const baseRect = frameRect || frame.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left - baseRect.left,
      right: rect.right - baseRect.left,
      top: rect.top - baseRect.top,
      bottom: rect.bottom - baseRect.top
    };
  }

  _hideImmediately() {
    this._clearTimers();
    if (!this.root) return;
    this.root.classList.remove('dialogue-layer--visible', 'dialogue-layer--hiding', 'dialogue-layer--mounted');
    this.root.removeAttribute('data-lang');
  }

  _ensureFontLayoutRefresh() {
    if (this._fontsReadyPromise || !document.fonts?.ready) return;
    this._fontsReadyPromise = document.fonts.ready
      .then(() => this.refreshLayout())
      .catch(() => {})
      .finally(() => {
        this._fontsReadyPromise = null;
      });
  }

  _clearTimers() {
    if (this._dismissTimer) {
      clearTimeout(this._dismissTimer);
      this._dismissTimer = null;
    }
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
  }

  _loadSeenMap() {
    if (this._seenMap) return this._seenMap;
    try {
      const raw = localStorage.getItem(DIALOGUE_SEEN_STORAGE_KEY);
      this._seenMap = raw ? JSON.parse(raw) : {};
    } catch {
      this._seenMap = {};
    }
    return this._seenMap;
  }

  _hasSeen(entry) {
    if (!this.persistSeen || !this.level?.id) return false;
    const key = this._seenKey(entry);
    const map = this._loadSeenMap();
    return !!map[key];
  }

  _markSeen(entry) {
    if (!this.persistSeen || !this.level?.id) return;
    const map = this._loadSeenMap();
    const key = this._seenKey(entry);
    map[key] = Date.now();
    try {
      localStorage.setItem(DIALOGUE_SEEN_STORAGE_KEY, JSON.stringify(map));
    } catch {
      // Ignore quota issues.
    }
  }

  _seenKey(entry) {
    return `${this.scopeKey}|${this.level?.id || this.level?.name || 'level'}|${entry.id}|${dialogueSeenRevision(entry)}`;
  }
}
