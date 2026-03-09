import { MAX_LUCK, SLOT_COLS, SLOT_ROWS, SlotMathEngine } from './slots-math.js';

const STORAGE_KEY = 'peggle_gamble_settings_v1';

const PERK_DEFINITIONS = [
  {
    id: 'perk_multi',
    name: 'Tri Multi',
    icon: '🎱',
    color: '#ff4d9d',
    defaultProbability: 20
  },
  {
    id: 'perk_aim',
    name: 'Ultra Aim',
    icon: '🎯',
    color: '#58a6ff',
    defaultProbability: 20
  },
  {
    id: 'perk_flippers',
    name: 'Flippers',
    icon: '⌐⌐',
    color: '#c0c0c0',
    defaultProbability: 20
  },
  {
    id: 'perk_yoyo',
    name: 'Yo-yo Thread',
    icon: '🪀',
    color: '#f2cc60',
    defaultProbability: 20
  },
  {
    id: 'perk_bomb',
    name: 'Bomb Shockwave',
    icon: '💣',
    color: '#ff9b54',
    defaultProbability: 20
  }
];

const DEFAULT_SETTINGS = {
  ballCost: 1,
  manualLuck: 0,
  autoLuckEnabled: true,
  autoLuckMaxBonus: 7,
  jackpotPerkCount: 6,
  perkProbabilities: PERK_DEFINITIONS.reduce((map, perk) => {
    map[perk.id] = perk.defaultProbability;
    return map;
  }, {})
};

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeProbabilityMap(map, perkDefinitions) {
  const next = {};
  let total = 0;

  for (const perk of perkDefinitions) {
    const raw = map?.[perk.id];
    const probability = Number.isFinite(raw) ? Math.max(0, raw) : perk.defaultProbability;
    next[perk.id] = probability;
    total += probability;
  }

  if (total <= 0) {
    const equal = 100 / Math.max(1, perkDefinitions.length);
    for (const perk of perkDefinitions) {
      next[perk.id] = equal;
    }
    return next;
  }

  const scale = 100 / total;
  for (const perk of perkDefinitions) {
    next[perk.id] *= scale;
  }
  return next;
}

function formatRewardSummary(rewardMap, perkDefinitions) {
  const parts = [];
  for (const perk of perkDefinitions) {
    const amount = rewardMap[perk.id] || 0;
    if (amount <= 0) continue;
    parts.push(`${perk.icon} +${amount}`);
  }
  return parts.length > 0 ? parts.join('  ') : 'No reward';
}

export class GambleSystem {
  constructor({ game, levelManager, statusBar, pegCountEl, selectionCountEl }) {
    this.game = game;
    this.levelManager = levelManager;
    this.statusBar = statusBar;
    this.pegCountEl = pegCountEl;
    this.selectionCountEl = selectionCountEl;

    this.perkDefinitions = PERK_DEFINITIONS.map(perk => ({ ...perk }));
    this.settings = this.loadSettings();
    this.settings.perkProbabilities = normalizeProbabilityMap(
      this.settings.perkProbabilities,
      this.perkDefinitions
    );

    this.inventory = this.perkDefinitions.reduce((map, perk) => {
      map[perk.id] = 0;
      return map;
    }, {});

    this.engine = new SlotMathEngine(this.perkDefinitions.map(perk => ({
      id: perk.id,
      probability: this.settings.perkProbabilities[perk.id]
    })));

    this.lastSpinGrid = Array.from({ length: SLOT_ROWS }, () => Array.from({ length: SLOT_COLS }, () => null));
    this.lastWinningCells = new Set();
    this.lastMessage = 'Press Spin to roll the slots.';
    this.lastMessageType = 'info';

    this.ui = null;
    this.unsubscribeGameState = null;
    this.handleResize = null;
  }

  mount() {
    if (!this.statusBar || this.ui) return;

    if (this.pegCountEl) this.pegCountEl.style.display = 'none';
    if (this.selectionCountEl) this.selectionCountEl.style.display = 'none';
    this.statusBar.classList.add('gamble-mode');

    this.ui = this.buildUi();
    this.statusBar.appendChild(this.ui.root);
    this.setPanelExpanded(false);
    this.syncHudWidth();
    this.handleResize = () => this.syncHudWidth();
    window.addEventListener('resize', this.handleResize);

    if (typeof this.game?.subscribeUiState === 'function') {
      this.unsubscribeGameState = this.game.subscribeUiState(() => this.refreshUi());
    }
    this.refreshUi();
  }

  dispose() {
    if (this.unsubscribeGameState) {
      this.unsubscribeGameState();
      this.unsubscribeGameState = null;
    }
    if (this.ui?.root?.parentNode) {
      this.ui.root.parentNode.removeChild(this.ui.root);
    }
    this.ui = null;

    if (this.handleResize) {
      window.removeEventListener('resize', this.handleResize);
      this.handleResize = null;
    }

    this.statusBar?.classList.remove('gamble-mode');
    if (this.pegCountEl) this.pegCountEl.style.display = '';
    if (this.selectionCountEl) this.selectionCountEl.style.display = '';
  }

  loadSettings() {
    const fromLevel = this.readLevelSettings();
    if (fromLevel) {
      return this.sanitizeSettings(fromLevel);
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return this.sanitizeSettings(parsed);
      }
    } catch (error) {
      // Ignore malformed persisted state.
    }
    return clone(DEFAULT_SETTINGS);
  }

  sanitizeSettings(settings) {
    const merged = {
      ...DEFAULT_SETTINGS,
      ...(settings || {})
    };
    merged.ballCost = Math.round(clampNumber(merged.ballCost, 1, 5, DEFAULT_SETTINGS.ballCost));
    merged.manualLuck = Math.round(clampNumber(merged.manualLuck, 0, MAX_LUCK, DEFAULT_SETTINGS.manualLuck));
    merged.autoLuckEnabled = !!merged.autoLuckEnabled;
    merged.autoLuckMaxBonus = Math.round(clampNumber(
      merged.autoLuckMaxBonus,
      0,
      MAX_LUCK,
      DEFAULT_SETTINGS.autoLuckMaxBonus
    ));
    merged.jackpotPerkCount = Math.round(clampNumber(
      merged.jackpotPerkCount,
      1,
      20,
      DEFAULT_SETTINGS.jackpotPerkCount
    ));
    merged.perkProbabilities = normalizeProbabilityMap(merged.perkProbabilities, this.perkDefinitions);
    return merged;
  }

  readLevelSettings() {
    const level = this.levelManager?.getCurrentLevel?.();
    return level?.gambleSettings || null;
  }

  persistSettings() {
    const payload = clone(this.settings);
    const level = this.levelManager?.getCurrentLevel?.();
    if (level) {
      level.gambleSettings = payload;
      this.levelManager.save();
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      // Ignore storage write failures.
    }
  }

  buildUi() {
    const root = document.createElement('div');
    root.className = 'gamble-hud collapsed';

    const perkToolbar = document.createElement('div');
    perkToolbar.className = 'gamble-perk-toolbar';
    root.appendChild(perkToolbar);

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'gamble-toggle-handle';
    toggleButton.setAttribute('aria-label', 'Toggle slots panel');
    toggleButton.setAttribute('aria-expanded', 'false');
    const toggleArrow = document.createElement('span');
    toggleArrow.className = 'gamble-toggle-arrow';
    toggleArrow.textContent = '▴';
    toggleButton.appendChild(toggleArrow);
    root.appendChild(toggleButton);

    const panel = document.createElement('div');
    panel.className = 'gamble-panel';
    root.appendChild(panel);

    const reelsWrap = document.createElement('div');
    reelsWrap.className = 'gamble-reels-wrap';
    panel.appendChild(reelsWrap);

    const grid = document.createElement('div');
    grid.className = 'gamble-grid';
    const gridCells = [];
    for (let row = 0; row < SLOT_ROWS; row++) {
      for (let col = 0; col < SLOT_COLS; col++) {
        const cell = document.createElement('div');
        cell.className = 'gamble-cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.textContent = '·';
        grid.appendChild(cell);
        gridCells.push(cell);
      }
    }
    reelsWrap.appendChild(grid);

    const infoRow = document.createElement('div');
    infoRow.className = 'gamble-info-row';
    panel.appendChild(infoRow);

    const statsCase = document.createElement('div');
    statsCase.className = 'gamble-stats-case';
    infoRow.appendChild(statsCase);

    const luckLabel = document.createElement('div');
    luckLabel.className = 'gamble-luck';
    statsCase.appendChild(luckLabel);

    const resultLabel = document.createElement('div');
    resultLabel.className = 'gamble-result';
    resultLabel.textContent = this.lastMessage;
    statsCase.appendChild(resultLabel);

    const spinButton = document.createElement('button');
    spinButton.type = 'button';
    spinButton.className = 'gamble-btn';
    spinButton.textContent = 'Spin';
    spinButton.addEventListener('click', () => this.spin());
    infoRow.appendChild(spinButton);

    const infoSpacer = document.createElement('div');
    infoSpacer.className = 'gamble-info-spacer';
    infoRow.appendChild(infoSpacer);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'gamble-bottom-row';
    panel.appendChild(bottomRow);

    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'gamble-settings-btn';
    settingsButton.textContent = '⚙';
    settingsButton.title = 'Slots settings';
    bottomRow.appendChild(settingsButton);

    const inventoryButtons = {};
    for (let index = 0; index < this.perkDefinitions.length; index++) {
      const perk = this.perkDefinitions[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gamble-perk-chip';
      button.style.setProperty('--perk-color', perk.color);
      button.setAttribute('aria-label', perk.name);
      button.addEventListener('click', () => this.consumePerk(perk.id));
      perkToolbar.appendChild(button);
      inventoryButtons[perk.id] = button;
    }

    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'gamble-settings-panel hidden';

    const addNumberControl = ({ label, min, max, step, value, onChange }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'gamble-control';

      const title = document.createElement('label');
      title.textContent = label;
      wrapper.appendChild(title);

      const row = document.createElement('div');
      row.className = 'gamble-control-row';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(value);
      const number = document.createElement('input');
      number.type = 'number';
      number.min = String(min);
      number.max = String(max);
      number.step = String(step);
      number.value = String(value);
      row.appendChild(range);
      row.appendChild(number);
      wrapper.appendChild(row);

      const sync = (rawValue) => {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.min(max, Math.max(min, parsed));
        range.value = String(clamped);
        number.value = String(clamped);
        onChange(clamped);
      };

      range.addEventListener('input', (event) => sync(event.target.value));
      number.addEventListener('input', (event) => sync(event.target.value));
      settingsPanel.appendChild(wrapper);
      return { range, number, wrapper };
    };

    const ballCostControl = addNumberControl({
      label: 'Ball Cost',
      min: 1,
      max: 5,
      step: 1,
      value: this.settings.ballCost,
      onChange: (nextValue) => {
        this.settings.ballCost = Math.round(nextValue);
        this.persistSettings();
        this.refreshUi();
      }
    });

    const manualLuckControl = addNumberControl({
      label: 'Manual Luck',
      min: 0,
      max: MAX_LUCK,
      step: 1,
      value: this.settings.manualLuck,
      onChange: (nextValue) => {
        this.settings.manualLuck = Math.round(nextValue);
        this.persistSettings();
        this.refreshUi();
      }
    });

    const autoLuckRow = document.createElement('label');
    autoLuckRow.className = 'gamble-toggle-row';
    const autoLuckText = document.createElement('span');
    autoLuckText.textContent = 'Auto Luck (less balls = more luck)';
    const autoLuckToggle = document.createElement('input');
    autoLuckToggle.type = 'checkbox';
    autoLuckToggle.checked = !!this.settings.autoLuckEnabled;
    autoLuckToggle.addEventListener('change', () => {
      this.settings.autoLuckEnabled = autoLuckToggle.checked;
      this.persistSettings();
      this.refreshUi();
    });
    autoLuckRow.appendChild(autoLuckText);
    autoLuckRow.appendChild(autoLuckToggle);
    settingsPanel.appendChild(autoLuckRow);

    const autoLuckScaleControl = addNumberControl({
      label: 'Auto Luck Max Bonus',
      min: 0,
      max: MAX_LUCK,
      step: 1,
      value: this.settings.autoLuckMaxBonus,
      onChange: (nextValue) => {
        this.settings.autoLuckMaxBonus = Math.round(nextValue);
        this.persistSettings();
        this.refreshUi();
      }
    });

    const jackpotRewardControl = addNumberControl({
      label: 'Jackpot Base Perk Count',
      min: 1,
      max: 20,
      step: 1,
      value: this.settings.jackpotPerkCount,
      onChange: (nextValue) => {
        this.settings.jackpotPerkCount = Math.round(nextValue);
        this.persistSettings();
        this.refreshUi();
      }
    });

    const probabilityControls = {};
    for (const perk of this.perkDefinitions) {
      probabilityControls[perk.id] = addNumberControl({
        label: `${perk.icon} ${perk.name} Probability`,
        min: 0,
        max: 100,
        step: 0.1,
        value: Number(this.settings.perkProbabilities[perk.id].toFixed(1)),
        onChange: (nextValue) => {
          this.settings.perkProbabilities[perk.id] = Math.max(0, nextValue);
          this.settings.perkProbabilities = normalizeProbabilityMap(
            this.settings.perkProbabilities,
            this.perkDefinitions
          );
          this.applyProbabilitySettings();
          this.syncProbabilityInputs(probabilityControls);
          this.persistSettings();
        }
      });
    }

    panel.appendChild(settingsPanel);

    settingsButton.addEventListener('click', () => {
      if (root.classList.contains('collapsed')) {
        this.setPanelExpanded(true);
      }
      settingsPanel.classList.toggle('hidden');
    });

    toggleButton.addEventListener('click', () => {
      this.setPanelExpanded(root.classList.contains('collapsed'));
    });

    return {
      root,
      panel,
      toggleButton,
      toggleArrow,
      spinButton,
      luckLabel,
      settingsButton,
      gridCells,
      resultLabel,
      inventoryButtons,
      settingsPanel,
      ballCostControl,
      manualLuckControl,
      autoLuckToggle,
      autoLuckScaleControl,
      jackpotRewardControl,
      probabilityControls
    };
  }

  setPanelExpanded(expanded) {
    if (!this.ui) return;
    const next = !!expanded;
    this.ui.root.classList.toggle('expanded', next);
    this.ui.root.classList.toggle('collapsed', !next);
    this.ui.panel.hidden = !next;
    this.ui.toggleButton.setAttribute('aria-expanded', next ? 'true' : 'false');
    this.ui.toggleArrow.textContent = next ? '▾' : '▴';
    if (!next) {
      this.ui.settingsPanel.classList.add('hidden');
    }
  }

  syncHudWidth() {
    if (!this.ui?.root || !this.game?.canvas || !this.statusBar) return;
    const canvasRect = this.game.canvas.getBoundingClientRect();
    const statusRect = this.statusBar.getBoundingClientRect();
    const width = Math.round(canvasRect.width || this.game.canvas.clientWidth || this.game.canvas.width || 0);
    if (width <= 0) return;

    const leftOffset = Math.max(0, Math.round(canvasRect.left - statusRect.left));
    this.ui.root.style.width = `${width}px`;
    this.ui.root.style.marginLeft = `${leftOffset}px`;
    this.ui.root.style.marginRight = '0';
  }

  syncProbabilityInputs(controls) {
    for (const perk of this.perkDefinitions) {
      const control = controls[perk.id];
      if (!control) continue;
      const value = Number((this.settings.perkProbabilities[perk.id] || 0).toFixed(1));
      control.range.value = String(value);
      control.number.value = String(value);
    }
  }

  applyProbabilitySettings() {
    this.engine.setProbabilityMap(this.settings.perkProbabilities);
  }

  getAutoLuck() {
    if (!this.settings.autoLuckEnabled) return 0;
    const startingBalls = this.game?.initialBallCount;
    const ballsLeft = this.game?.ballsLeft;
    if (!Number.isFinite(startingBalls) || startingBalls <= 0) return 0;
    if (!Number.isFinite(ballsLeft)) return 0;

    const spent = Math.max(0, startingBalls - Math.max(0, ballsLeft));
    const ratio = spent / startingBalls;
    return Math.round(ratio * this.settings.autoLuckMaxBonus);
  }

  getEffectiveLuck() {
    const manual = Math.round(clampNumber(this.settings.manualLuck, 0, MAX_LUCK, 0));
    const auto = Math.round(clampNumber(this.getAutoLuck(), 0, MAX_LUCK, 0));
    return {
      manual,
      auto,
      total: Math.min(MAX_LUCK, manual + auto)
    };
  }

  canInteract() {
    const state = this.game?.state;
    return state !== 'playing' && state !== 'won' && state !== 'lost';
  }

  isDebugPerkOverrideEnabled() {
    return !!this.game?.showFullTrajectory;
  }

  canSpin() {
    return this.canInteract() && !!this.game?.canGamble?.(this.settings.ballCost);
  }

  setMessage(text, type = 'info') {
    this.lastMessage = text;
    this.lastMessageType = type;
    if (this.ui?.resultLabel) {
      this.ui.resultLabel.textContent = text;
      this.ui.resultLabel.dataset.type = type;
    }
  }

  spin() {
    if (!this.canSpin()) {
      this.setMessage('Cannot gamble while ball is in flight or balls are too low.', 'warn');
      this.refreshUi();
      return;
    }

    const spent = this.game.spendBallsForGamble(this.settings.ballCost);
    if (!spent) {
      this.setMessage('Failed to spend balls for gamble spin.', 'error');
      this.refreshUi();
      return;
    }

    const luck = this.getEffectiveLuck();
    this.applyProbabilitySettings();
    const { grid, wins } = this.engine.spin(luck.total);
    this.lastSpinGrid = grid;
    this.lastWinningCells = this.engine.getWinningCells(wins);

    const { rewards, jackpot } = this.resolveRewards(wins);
    this.addRewards(rewards);

    if (Object.keys(rewards).length === 0) {
      this.setMessage(`No win. Luck ${luck.total} (M${luck.manual} + A${luck.auto}).`, 'info');
    } else if (jackpot) {
      this.setMessage(`JACKPOT! ${formatRewardSummary(rewards, this.perkDefinitions)}`, 'win');
    } else {
      this.setMessage(`Won: ${formatRewardSummary(rewards, this.perkDefinitions)}`, 'win');
    }

    this.refreshUi();
  }

  resolveRewards(wins) {
    const rewards = {};
    if (!Array.isArray(wins) || wins.length === 0) {
      return { rewards, jackpot: false };
    }

    const jackpotHit = wins.some(win => win.patternId === 'jackpot');
    if (jackpotHit) {
      const configuredBase = Math.max(1, Math.round(this.settings.jackpotPerkCount || 0));
      const minimumJackpot = this.getJackpotMinimumRewardCount(wins);
      const rewardCount = Math.min(99, Math.max(configuredBase, minimumJackpot));
      for (let i = 0; i < rewardCount; i++) {
        const index = Math.floor(Math.random() * this.perkDefinitions.length);
        const perk = this.perkDefinitions[index];
        rewards[perk.id] = (rewards[perk.id] || 0) + 1;
      }
      return { rewards, jackpot: true };
    }

    for (const win of wins) {
      const amount = this.getRewardAmountForWin(win);
      rewards[win.symbolId] = (rewards[win.symbolId] || 0) + amount;
    }
    return { rewards, jackpot: false };
  }

  getRewardAmountForWin(win) {
    const multiplier = Number(win?.pattern?.multiplier);
    if (!Number.isFinite(multiplier)) return 1;
    return Math.max(1, Math.round(multiplier / 2));
  }

  getJackpotMinimumRewardCount(wins) {
    let strongestNonJackpot = 0;
    let jackpotBaseline = 0;

    for (const win of wins || []) {
      const amount = this.getRewardAmountForWin(win);
      if (win?.patternId === 'jackpot') {
        jackpotBaseline = Math.max(jackpotBaseline, amount);
      } else {
        strongestNonJackpot = Math.max(strongestNonJackpot, amount);
      }
    }

    // Jackpot should always beat the strongest non-jackpot result.
    return Math.max(5, jackpotBaseline, strongestNonJackpot + 1);
  }

  addRewards(rewards) {
    for (const [perkId, amount] of Object.entries(rewards)) {
      if (!Object.prototype.hasOwnProperty.call(this.inventory, perkId)) continue;
      this.inventory[perkId] += amount;
    }
  }

  consumePerk(perkId) {
    if (!this.canInteract()) {
      this.setMessage('Perks can only be used when ball is not in flight.', 'warn');
      this.refreshUi();
      return;
    }

    const debugOverride = this.isDebugPerkOverrideEnabled();
    const count = this.inventory[perkId] || 0;
    if (!debugOverride && count <= 0) return;

    if (!debugOverride) {
      this.inventory[perkId] -= 1;
    }
    const applied = this.applyPerk(perkId);
    if (!applied.success) {
      if (!debugOverride) {
        this.inventory[perkId] += 1;
      }
      this.setMessage(applied.message, 'warn');
      this.refreshUi();
      return;
    }

    this.setMessage(applied.message, 'info');
    this.refreshUi();
  }

  applyPerk(perkId) {
    switch (perkId) {
      case 'perk_multi': {
        const converted = this.game.convertRandomPegsToMultiball(3);
        if (converted <= 0) {
          return { success: false, message: 'No eligible non-orange pegs to convert.' };
        }
        return { success: true, message: `Converted ${converted} pegs into multiball pegs.` };
      }
      case 'perk_aim': {
        const charges = this.game.grantUltraAim(1);
        return { success: true, message: `Ultra Aim armed. Charges: ${charges}.` };
      }
      case 'perk_flippers': {
        const shots = this.game.grantTemporaryFlippers(1);
        if (shots <= 0) {
          return { success: false, message: 'Flippers are already enabled on this level.' };
        }
        return { success: true, message: `Flippers enabled for ${shots} shot(s).` };
      }
      case 'perk_yoyo': {
        const uses = this.game.grantYoyoThreadUses(1);
        if (uses <= 0) {
          return { success: false, message: 'Yo-yo thread is already enabled on this level.' };
        }
        return { success: true, message: `Yo-yo thread armed. Pullback uses: ${uses}.` };
      }
      case 'perk_bomb': {
        const charges = this.game.grantBombShockwaveCharges(1);
        return { success: true, message: `Bomb armed. Charges: ${charges}.` };
      }
      default:
        return { success: false, message: 'Unknown perk.' };
    }
  }

  refreshUi() {
    if (!this.ui) return;
    this.syncHudWidth();

    const interactionAllowed = this.canInteract();
    const canSpin = this.canSpin();
    this.ui.spinButton.disabled = !canSpin;
    this.ui.spinButton.textContent = 'Spin';
    this.ui.spinButton.title = `Spin slots (-${this.settings.ballCost} ball)`;
    this.ui.autoLuckToggle.checked = !!this.settings.autoLuckEnabled;

    const luck = this.getEffectiveLuck();
    this.ui.luckLabel.textContent = `Luck ${luck.total} (M${luck.manual} + A${luck.auto}) · Cost ${this.settings.ballCost}`;

    for (const cell of this.ui.gridCells) {
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      const symbolId = this.lastSpinGrid?.[row]?.[col] || null;
      const perk = this.perkDefinitions.find(item => item.id === symbolId);
      cell.textContent = perk ? perk.icon : '·';
      cell.style.setProperty('--cell-color', perk ? perk.color : '#6e7681');
      const key = `${row},${col}`;
      cell.classList.toggle('winning', this.lastWinningCells.has(key));
    }

    this.ui.resultLabel.textContent = this.lastMessage;
    this.ui.resultLabel.dataset.type = this.lastMessageType;

    const debugOverride = this.isDebugPerkOverrideEnabled();
    for (const perk of this.perkDefinitions) {
      const button = this.ui.inventoryButtons[perk.id];
      const amount = this.inventory[perk.id] || 0;
      const displayAmount = debugOverride ? '∞' : String(amount);
      button.textContent = perk.icon;
      button.dataset.count = displayAmount;
      button.title = debugOverride
        ? `${perk.name} (debug unlimited)`
        : `${perk.name} (${amount})`;
      button.disabled = !interactionAllowed || (!debugOverride && amount <= 0);
    }
  }
}
