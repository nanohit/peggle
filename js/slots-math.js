// Slots math core extracted from Nocturne/ntn:
// - 3x5 grid
// - fixed win patterns (including sky/eye/jackpot)
// - best-per-type/group pattern resolution
// - luck overwrite generation (luck = forced matching cells)

export const SLOT_ROWS = 3;
export const SLOT_COLS = 5;
export const MAX_LUCK = SLOT_ROWS * SLOT_COLS;

export const SLOT_PATTERNS = {
  // Horizontal (grouped by row)
  horizontal3_r0_p0: { name: 'Horizontal3', multiplier: 1, cells: [[0, 0], [0, 1], [0, 2]], type: 'horizontal', groupId: 'row0' },
  horizontal3_r0_p1: { name: 'Horizontal3', multiplier: 1, cells: [[0, 1], [0, 2], [0, 3]], type: 'horizontal', groupId: 'row0' },
  horizontal3_r0_p2: { name: 'Horizontal3', multiplier: 1, cells: [[0, 2], [0, 3], [0, 4]], type: 'horizontal', groupId: 'row0' },
  horizontal3_r1_p0: { name: 'Horizontal3', multiplier: 1, cells: [[1, 0], [1, 1], [1, 2]], type: 'horizontal', groupId: 'row1' },
  horizontal3_r1_p1: { name: 'Horizontal3', multiplier: 1, cells: [[1, 1], [1, 2], [1, 3]], type: 'horizontal', groupId: 'row1' },
  horizontal3_r1_p2: { name: 'Horizontal3', multiplier: 1, cells: [[1, 2], [1, 3], [1, 4]], type: 'horizontal', groupId: 'row1' },
  horizontal3_r2_p0: { name: 'Horizontal3', multiplier: 1, cells: [[2, 0], [2, 1], [2, 2]], type: 'horizontal', groupId: 'row2' },
  horizontal3_r2_p1: { name: 'Horizontal3', multiplier: 1, cells: [[2, 1], [2, 2], [2, 3]], type: 'horizontal', groupId: 'row2' },
  horizontal3_r2_p2: { name: 'Horizontal3', multiplier: 1, cells: [[2, 2], [2, 3], [2, 4]], type: 'horizontal', groupId: 'row2' },

  horizontal4_r0_p0: { name: 'Horizontal4', multiplier: 2, cells: [[0, 0], [0, 1], [0, 2], [0, 3]], type: 'horizontal', groupId: 'row0' },
  horizontal4_r0_p1: { name: 'Horizontal4', multiplier: 2, cells: [[0, 1], [0, 2], [0, 3], [0, 4]], type: 'horizontal', groupId: 'row0' },
  horizontal4_r1_p0: { name: 'Horizontal4', multiplier: 2, cells: [[1, 0], [1, 1], [1, 2], [1, 3]], type: 'horizontal', groupId: 'row1' },
  horizontal4_r1_p1: { name: 'Horizontal4', multiplier: 2, cells: [[1, 1], [1, 2], [1, 3], [1, 4]], type: 'horizontal', groupId: 'row1' },
  horizontal4_r2_p0: { name: 'Horizontal4', multiplier: 2, cells: [[2, 0], [2, 1], [2, 2], [2, 3]], type: 'horizontal', groupId: 'row2' },
  horizontal4_r2_p1: { name: 'Horizontal4', multiplier: 2, cells: [[2, 1], [2, 2], [2, 3], [2, 4]], type: 'horizontal', groupId: 'row2' },

  horizontal5_r0: { name: 'Horizontal5', multiplier: 3, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], type: 'horizontal', groupId: 'row0' },
  horizontal5_r1: { name: 'Horizontal5', multiplier: 3, cells: [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]], type: 'horizontal', groupId: 'row1' },
  horizontal5_r2: { name: 'Horizontal5', multiplier: 3, cells: [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]], type: 'horizontal', groupId: 'row2' },

  // Vertical (grouped by column)
  vertical3_c0: { name: 'Vertical3', multiplier: 1, cells: [[0, 0], [1, 0], [2, 0]], type: 'vertical', groupId: 'col0' },
  vertical3_c1: { name: 'Vertical3', multiplier: 1, cells: [[0, 1], [1, 1], [2, 1]], type: 'vertical', groupId: 'col1' },
  vertical3_c2: { name: 'Vertical3', multiplier: 1, cells: [[0, 2], [1, 2], [2, 2]], type: 'vertical', groupId: 'col2' },
  vertical3_c3: { name: 'Vertical3', multiplier: 1, cells: [[0, 3], [1, 3], [2, 3]], type: 'vertical', groupId: 'col3' },
  vertical3_c4: { name: 'Vertical3', multiplier: 1, cells: [[0, 4], [1, 4], [2, 4]], type: 'vertical', groupId: 'col4' },

  // Diagonal (each line independent)
  diagonal_tlbr_0: { name: 'Diagonal', multiplier: 1, cells: [[0, 0], [1, 1], [2, 2]], type: 'diagonal', groupId: 'diag_tlbr_0' },
  diagonal_tlbr_1: { name: 'Diagonal', multiplier: 1, cells: [[0, 1], [1, 2], [2, 3]], type: 'diagonal', groupId: 'diag_tlbr_1' },
  diagonal_tlbr_2: { name: 'Diagonal', multiplier: 1, cells: [[0, 2], [1, 3], [2, 4]], type: 'diagonal', groupId: 'diag_tlbr_2' },
  diagonal_trbl_0: { name: 'Diagonal', multiplier: 1, cells: [[0, 4], [1, 3], [2, 2]], type: 'diagonal', groupId: 'diag_trbl_0' },
  diagonal_trbl_1: { name: 'Diagonal', multiplier: 1, cells: [[0, 3], [1, 2], [2, 1]], type: 'diagonal', groupId: 'diag_trbl_1' },
  diagonal_trbl_2: { name: 'Diagonal', multiplier: 1, cells: [[0, 2], [1, 1], [2, 0]], type: 'diagonal', groupId: 'diag_trbl_2' },

  // Specials
  up: { name: 'Up', multiplier: 4, cells: [[0, 2], [1, 1], [1, 3], [2, 0], [2, 4]], type: 'special', groupId: 'up' },
  down: { name: 'Down', multiplier: 4, cells: [[0, 0], [0, 4], [1, 1], [1, 3], [2, 2]], type: 'special', groupId: 'down' },
  sky: { name: 'Sky', multiplier: 8, cells: [[0, 2], [1, 1], [1, 3], [2, 0], [2, 1], [2, 2], [2, 3], [2, 4]], type: 'special', groupId: 'sky' },
  ground: { name: 'Ground', multiplier: 8, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 1], [1, 3], [2, 2]], type: 'special', groupId: 'ground' },
  eye: { name: 'Eye', multiplier: 9, cells: [[0, 1], [0, 2], [0, 3], [1, 0], [1, 4], [2, 1], [2, 2], [2, 3]], type: 'special', groupId: 'eye' },
  jackpot: {
    name: 'Jackpot',
    multiplier: 10,
    cells: [
      [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
      [1, 0], [1, 1], [1, 2], [1, 3], [1, 4],
      [2, 0], [2, 1], [2, 2], [2, 3], [2, 4]
    ],
    type: 'special',
    groupId: 'jackpot'
  }
};

function clampLuck(value) {
  const numeric = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(MAX_LUCK, Math.floor(numeric)));
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

export class SlotMathEngine {
  constructor(symbolConfigs = []) {
    this.symbols = [];
    this.probabilities = {};
    this.setSymbols(symbolConfigs);
  }

  setSymbols(symbolConfigs) {
    const valid = Array.isArray(symbolConfigs)
      ? symbolConfigs
        .filter(symbol => symbol && typeof symbol.id === 'string')
        .map(symbol => ({
          ...symbol,
          probability: Number.isFinite(symbol.probability) ? Math.max(0, symbol.probability) : 1
        }))
      : [];

    this.symbols = valid;
    this.probabilities = {};
    for (const symbol of this.symbols) {
      this.probabilities[symbol.id] = symbol.probability;
    }
    this.normalizeProbabilities();
  }

  getSymbols() {
    return this.symbols.map(symbol => ({ ...symbol }));
  }

  getProbabilityMap() {
    return { ...this.probabilities };
  }

  setProbabilityMap(probabilityMap) {
    if (!probabilityMap || typeof probabilityMap !== 'object') return;
    for (const symbol of this.symbols) {
      const value = probabilityMap[symbol.id];
      if (!Number.isFinite(value)) continue;
      this.probabilities[symbol.id] = Math.max(0, value);
    }
    this.normalizeProbabilities();
  }

  normalizeProbabilities() {
    const symbolIds = this.symbols.map(symbol => symbol.id);
    if (symbolIds.length === 0) return;

    let total = 0;
    for (const id of symbolIds) {
      const value = Number.isFinite(this.probabilities[id]) ? Math.max(0, this.probabilities[id]) : 0;
      this.probabilities[id] = value;
      total += value;
    }

    if (total <= 0) {
      const equal = 100 / symbolIds.length;
      for (const id of symbolIds) {
        this.probabilities[id] = equal;
      }
      return;
    }

    const scale = 100 / total;
    for (const id of symbolIds) {
      this.probabilities[id] *= scale;
    }
  }

  getRandomSymbolId() {
    if (this.symbols.length === 0) return null;
    const random = Math.random() * 100;
    let cumulative = 0;
    for (const symbol of this.symbols) {
      cumulative += this.probabilities[symbol.id] || 0;
      if (random < cumulative) {
        return symbol.id;
      }
    }
    return this.symbols[this.symbols.length - 1].id;
  }

  generateGrid(luck = 0) {
    const grid = [];
    for (let row = 0; row < SLOT_ROWS; row++) {
      const rowValues = [];
      for (let col = 0; col < SLOT_COLS; col++) {
        rowValues.push(this.getRandomSymbolId());
      }
      grid.push(rowValues);
    }

    const clampedLuck = clampLuck(luck);
    if (clampedLuck <= 0) return grid;

    const luckySymbol = this.getRandomSymbolId();
    if (!luckySymbol) return grid;

    const positions = [];
    for (let row = 0; row < SLOT_ROWS; row++) {
      for (let col = 0; col < SLOT_COLS; col++) {
        positions.push([row, col]);
      }
    }
    shuffleInPlace(positions);
    const overwriteCount = Math.min(clampedLuck, positions.length);
    for (let i = 0; i < overwriteCount; i++) {
      const [row, col] = positions[i];
      grid[row][col] = luckySymbol;
    }
    return grid;
  }

  checkPatternMatch(grid, cells) {
    if (!Array.isArray(cells) || cells.length === 0) return null;
    const [startRow, startCol] = cells[0];
    const first = grid?.[startRow]?.[startCol];
    if (first == null) return null;

    for (let i = 1; i < cells.length; i++) {
      const [row, col] = cells[i];
      if (grid?.[row]?.[col] !== first) {
        return null;
      }
    }
    return first;
  }

  calculateWins(grid) {
    const allMatches = [];
    for (const [patternId, pattern] of Object.entries(SLOT_PATTERNS)) {
      const symbolId = this.checkPatternMatch(grid, pattern.cells);
      if (!symbolId) continue;
      allMatches.push({
        patternId,
        pattern,
        symbolId
      });
    }

    const grouped = {};
    for (const match of allMatches) {
      const key = `${match.pattern.type}_${match.pattern.groupId}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(match);
    }

    const wins = [];
    for (const matches of Object.values(grouped)) {
      matches.sort((a, b) => b.pattern.multiplier - a.pattern.multiplier);
      wins.push(matches[0]);
    }
    return wins;
  }

  spin(luck = 0) {
    const grid = this.generateGrid(luck);
    const wins = this.calculateWins(grid);
    return { grid, wins };
  }

  getWinningCells(wins) {
    const cells = new Set();
    for (const win of wins || []) {
      for (const [row, col] of win.pattern.cells) {
        cells.add(`${row},${col}`);
      }
    }
    return cells;
  }
}
