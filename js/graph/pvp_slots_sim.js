// Monte Carlo sim of slot outcomes at various luck levels & symbol counts
// Run: node js/graph/pvp_slots_sim.js

const SLOT_ROWS = 3;
const SLOT_COLS = 5;
const TRIALS = 200_000;

const SLOT_PATTERNS = {
  horizontal3_r0_p0: { cells: [[0,0],[0,1],[0,2]], mult: 1, group: 'h_row0' },
  horizontal3_r0_p1: { cells: [[0,1],[0,2],[0,3]], mult: 1, group: 'h_row0' },
  horizontal3_r0_p2: { cells: [[0,2],[0,3],[0,4]], mult: 1, group: 'h_row0' },
  horizontal3_r1_p0: { cells: [[1,0],[1,1],[1,2]], mult: 1, group: 'h_row1' },
  horizontal3_r1_p1: { cells: [[1,1],[1,2],[1,3]], mult: 1, group: 'h_row1' },
  horizontal3_r1_p2: { cells: [[1,2],[1,3],[1,4]], mult: 1, group: 'h_row1' },
  horizontal3_r2_p0: { cells: [[2,0],[2,1],[2,2]], mult: 1, group: 'h_row2' },
  horizontal3_r2_p1: { cells: [[2,1],[2,2],[2,3]], mult: 1, group: 'h_row2' },
  horizontal3_r2_p2: { cells: [[2,2],[2,3],[2,4]], mult: 1, group: 'h_row2' },
  horizontal4_r0_p0: { cells: [[0,0],[0,1],[0,2],[0,3]], mult: 2, group: 'h_row0' },
  horizontal4_r0_p1: { cells: [[0,1],[0,2],[0,3],[0,4]], mult: 2, group: 'h_row0' },
  horizontal4_r1_p0: { cells: [[1,0],[1,1],[1,2],[1,3]], mult: 2, group: 'h_row1' },
  horizontal4_r1_p1: { cells: [[1,1],[1,2],[1,3],[1,4]], mult: 2, group: 'h_row1' },
  horizontal4_r2_p0: { cells: [[2,0],[2,1],[2,2],[2,3]], mult: 2, group: 'h_row2' },
  horizontal4_r2_p1: { cells: [[2,1],[2,2],[2,3],[2,4]], mult: 2, group: 'h_row2' },
  horizontal5_r0: { cells: [[0,0],[0,1],[0,2],[0,3],[0,4]], mult: 3, group: 'h_row0' },
  horizontal5_r1: { cells: [[1,0],[1,1],[1,2],[1,3],[1,4]], mult: 3, group: 'h_row1' },
  horizontal5_r2: { cells: [[2,0],[2,1],[2,2],[2,3],[2,4]], mult: 3, group: 'h_row2' },
  vertical3_c0: { cells: [[0,0],[1,0],[2,0]], mult: 1, group: 'v_col0' },
  vertical3_c1: { cells: [[0,1],[1,1],[2,1]], mult: 1, group: 'v_col1' },
  vertical3_c2: { cells: [[0,2],[1,2],[2,2]], mult: 1, group: 'v_col2' },
  vertical3_c3: { cells: [[0,3],[1,3],[2,3]], mult: 1, group: 'v_col3' },
  vertical3_c4: { cells: [[0,4],[1,4],[2,4]], mult: 1, group: 'v_col4' },
  diagonal_tlbr_0: { cells: [[0,0],[1,1],[2,2]], mult: 1, group: 'd_tlbr0' },
  diagonal_tlbr_1: { cells: [[0,1],[1,2],[2,3]], mult: 1, group: 'd_tlbr1' },
  diagonal_tlbr_2: { cells: [[0,2],[1,3],[2,4]], mult: 1, group: 'd_tlbr2' },
  diagonal_trbl_0: { cells: [[0,4],[1,3],[2,2]], mult: 1, group: 'd_trbl0' },
  diagonal_trbl_1: { cells: [[0,3],[1,2],[2,1]], mult: 1, group: 'd_trbl1' },
  diagonal_trbl_2: { cells: [[0,2],[1,1],[2,0]], mult: 1, group: 'd_trbl2' },
  up:      { cells: [[0,2],[1,1],[1,3],[2,0],[2,4]], mult: 4, group: 'sp_up' },
  down:    { cells: [[0,0],[0,4],[1,1],[1,3],[2,2]], mult: 4, group: 'sp_down' },
  sky:     { cells: [[0,2],[1,1],[1,3],[2,0],[2,1],[2,2],[2,3],[2,4]], mult: 8, group: 'sp_sky' },
  ground:  { cells: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,1],[1,3],[2,2]], mult: 8, group: 'sp_ground' },
  eye:     { cells: [[0,1],[0,2],[0,3],[1,0],[1,4],[2,1],[2,2],[2,3]], mult: 9, group: 'sp_eye' },
  jackpot: { cells: Array.from({length:3}, (_,r) => Array.from({length:5}, (_,c) => [r,c])).flat(), mult: 10, group: 'sp_jackpot' },
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateGrid(symbolCount, luck) {
  const grid = [];
  for (let r = 0; r < SLOT_ROWS; r++) {
    const row = [];
    for (let c = 0; c < SLOT_COLS; c++) {
      row.push(Math.floor(Math.random() * symbolCount));
    }
    grid.push(row);
  }
  if (luck <= 0) return grid;
  const luckySymbol = Math.floor(Math.random() * symbolCount);
  const positions = [];
  for (let r = 0; r < SLOT_ROWS; r++)
    for (let c = 0; c < SLOT_COLS; c++)
      positions.push([r, c]);
  shuffle(positions);
  const n = Math.min(luck, positions.length);
  for (let i = 0; i < n; i++) {
    grid[positions[i][0]][positions[i][1]] = luckySymbol;
  }
  return grid;
}

function calculateWins(grid) {
  const grouped = {};
  for (const [pid, pat] of Object.entries(SLOT_PATTERNS)) {
    const first = grid[pat.cells[0][0]][pat.cells[0][1]];
    let match = true;
    for (let i = 1; i < pat.cells.length; i++) {
      if (grid[pat.cells[i][0]][pat.cells[i][1]] !== first) { match = false; break; }
    }
    if (!match) continue;
    const key = pat.group;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ pid, mult: pat.mult, symbol: first });
  }
  const wins = [];
  for (const matches of Object.values(grouped)) {
    matches.sort((a, b) => b.mult - a.mult);
    wins.push(matches[0]);
  }
  return wins;
}

function bestWinMultiplier(wins) {
  if (wins.length === 0) return 0;
  return Math.max(...wins.map(w => w.mult));
}

console.log(`\nMonte Carlo PvP Slots Simulation (${TRIALS.toLocaleString()} trials each)\n`);
console.log('='.repeat(75));

for (const symbols of [5, 6]) {
  console.log(`\n--- ${symbols} SYMBOLS ---`);
  console.log(`${'Luck'.padStart(5)} | ${'Nothing%'.padStart(9)} | ${'H3only%'.padStart(9)} | ${'H4+%'.padStart(9)} | ${'H5+%'.padStart(9)} | ${'Special%'.padStart(9)} | ${'Jackpot%'.padStart(9)}`);
  console.log('-'.repeat(75));
  for (const luck of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    let nothing = 0, h3only = 0, h4plus = 0, h5plus = 0, special = 0, jackpot = 0;
    for (let t = 0; t < TRIALS; t++) {
      const grid = generateGrid(symbols, luck);
      const wins = calculateWins(grid);
      if (wins.length === 0) { nothing++; continue; }
      const best = bestWinMultiplier(wins);
      if (best >= 10) jackpot++;
      else if (best >= 4) special++;
      else if (best >= 3) h5plus++;
      else if (best >= 2) h4plus++;
      else h3only++;
    }
    const pct = (v) => ((v / TRIALS) * 100).toFixed(2).padStart(9);
    console.log(`${String(luck).padStart(5)} | ${pct(nothing)} | ${pct(h3only)} | ${pct(h4plus)} | ${pct(h5plus)} | ${pct(special)} | ${pct(jackpot)}`);
  }
}

// Now simulate the PAIR dynamics
console.log('\n\n' + '='.repeat(75));
console.log('PAIRED OUTCOME ANALYSIS');
console.log('(Trigger player = hit lime peg, Other = did not)');
console.log('='.repeat(75));

for (const symbols of [5]) {
  for (const [triggerLuck, otherLuck, label] of [
    [4, 4, 'Equal luck=4 (baseline)'],
    [7, 4, 'Trigger=7, Other=4 (Option A)'],
    [6, 5, 'Trigger=6, Other=5 (milder split)'],
    [5, 5, 'Equal luck=5 (moderate)'],
  ]) {
    let bothNothing = 0, onlyTrigger = 0, onlyOther = 0, bothWin = 0;
    for (let t = 0; t < TRIALS; t++) {
      const gA = generateGrid(symbols, triggerLuck);
      const gB = generateGrid(symbols, otherLuck);
      const wA = calculateWins(gA).length > 0;
      const wB = calculateWins(gB).length > 0;
      if (!wA && !wB) bothNothing++;
      else if (wA && !wB) onlyTrigger++;
      else if (!wA && wB) onlyOther++;
      else bothWin++;
    }
    const pct = (v) => ((v / TRIALS) * 100).toFixed(1);
    console.log(`\n  ${label} (${symbols} symbols)`);
    console.log(`    Both win:         ${pct(bothWin)}%`);
    console.log(`    Only trigger:     ${pct(onlyTrigger)}%`);
    console.log(`    Only other:       ${pct(onlyOther)}%`);
    console.log(`    Both nothing:     ${pct(bothNothing)}%`);
    console.log(`    "Unfair" (A wins, B nothing): ${pct(onlyTrigger)}%`);
    console.log(`    "Upset" (B wins, A nothing):  ${pct(onlyOther)}%`);
  }
}
