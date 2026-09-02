// Live lighting tuner for the GPU playfield.
//
// Dev tool, not shipped UI: it is only mounted when the page asks for it
// (?tune=1, or Ctrl+Shift+L). Everything it edits is the renderer's lighting
// config, so what you see is what a saved preset will reproduce.
//
// Fixtures are draggable directly on the board. They are real emissive geometry
// in the solve, so dragging one moves the light, its spill, and every shadow it
// casts — nothing is precomputed.

const STORAGE_KEY = 'peggle_playfield_lighting';
// Bumped whenever the shipped defaults change. A preset saved under an older
// version is discarded rather than silently shadowing the new defaults.
const LIGHTING_VERSION = 3;

const SLIDERS = [
  { group: 'Tone', key: 'exposure', min: 0.1, max: 3, step: 0.01 },
  { group: 'Tone', key: 'saturation', min: 0, max: 2, step: 0.01 },
  { group: 'Tone', key: 'vignette', min: 0, max: 1, step: 0.01 },
  { group: 'Bloom', key: 'bloom', label: 'strength', min: 0, max: 2, step: 0.01 },
  { group: 'Bloom', key: 'bloomThreshold', label: 'threshold', min: 0.1, max: 4, step: 0.01 },
  { group: 'Overhead rig', key: 'domeIntensity', label: 'intensity', min: 0, max: 5, step: 0.01 },
  { group: 'Overhead rig', key: 'keyDirX', label: 'key x', min: -1, max: 1, step: 0.01 },
  { group: 'Overhead rig', key: 'keyDirY', label: 'key y', min: -1, max: 1, step: 0.01 },
  { group: 'Overhead rig', key: 'keyElevation', label: 'key elevation', min: 0.1, max: 2, step: 0.01 },
  { group: 'Global illumination', key: 'skyIntensity', label: 'ambient', min: 0, max: 4, step: 0.01 },
  { group: 'Global illumination', key: 'bounce', label: 'bounce', min: 0, max: 1.5, step: 0.01 },
  { group: 'Global illumination', key: 'lightElevation', label: 'shadow length', min: 0.03, max: 0.8, step: 0.005 },
  // Lower = steadier under moving lights, at the cost of a little lag.
  { group: 'Global illumination', key: 'giBlend', label: 'smoothing', min: 0.05, max: 1, step: 0.01 },
  { group: 'Material', key: 'gloss', min: 0.2, max: 3, step: 0.01 },
  // 0 = off. Caps how sharp a reflection of the solved field can be.
  { group: 'Material', key: 'specFloor', label: 'field spec blur', min: 0, max: 1, step: 0.01 },
  { group: 'Material', key: 'hitBoost', label: 'hit flash', min: 0, max: 4, step: 0.01 },
  { group: 'Board', key: 'boardTexture', label: 'noise', min: 0, max: 2, step: 0.01 },
  { group: 'Board', key: 'boardGrid', label: 'grid size', min: 8, max: 96, step: 1 },
  { group: 'Board', key: 'boardGridDepth', label: 'grid depth', min: 0, max: 2, step: 0.01 }
];

const BOARD_STYLES = [
  { value: 0, label: 'noise' },
  { value: 1, label: 'grid' },
  { value: 2, label: 'plain' }
];

// Candidate rigs, layered over whatever you have tuned rather than replacing
// it: a test only sets the keys it names, so everything else stays yours.
//
// They exist because measuring the shipped rig (test/tone-probe.html) showed
// the board occupying about 11 of 255 luma steps — the surface is flat, not
// merely dark — with no pixel in the frame above 218. Each preset isolates one
// theory about that so they can be compared instead of argued about.
const LIGHT_TESTS = [
  {
    id: 'exposure',
    label: 'A · exposure only',
    note: 'The obvious fix, as a control. Lifts everything together, so the '
      + 'board stays as flat as it was and the pegs move toward clipping.',
    patch: { exposure: 1.25 }
  },
  {
    id: 'board',
    label: 'B · board albedo',
    note: 'Board reflectance 0.7-2.5% -> 2-6%. Still darker than asphalt, but '
      + 'now it can bounce, so bounce/GI and cast shadows have something to '
      + 'land on. Single highest-leverage change.',
    patch: { boardColor: [0.022, 0.040, 0.062] }
  },
  {
    id: 'range',
    label: 'C · board + vignette',
    note: 'As B, plus a lighter vignette. The playfield fills the frame, so a '
      + '0.42 vignette is crushing the corners where pegs actually sit.',
    patch: { boardColor: [0.022, 0.040, 0.062], vignette: 0.25 }
  },
  {
    id: 'calm',
    label: 'E · board albedo, no patches',
    note: 'B plus a roughness floor on the field-driven specular. Cascade 0 '
      + 'keeps 4 directions, so its dominant vector is only known to a '
      + 'quadrant; steering a near-mirror lobe with it is what turns a lifted '
      + 'board patchy. Try this one against B.',
    patch: { boardColor: [0.022, 0.040, 0.062], specFloor: 0.34 }
  },
  {
    id: 'full',
    label: 'D · full candidate',
    note: 'As C, plus real bloom. Nothing currently reaches white (max 218, '
      + '0% specular), so struck pegs and portals never read as hot.',
    patch: {
      boardColor: [0.022, 0.040, 0.062],
      vignette: 0.25,
      bloom: 0.12,
      bloomThreshold: 1.10,
      exposure: 0.95
    }
  }
];

const CSS = `
.pf-tuner {
  position: fixed; top: 0; right: 0; bottom: 0; width: 292px; z-index: 99999;
  background: rgba(6, 12, 20, 0.94); color: #cfe6f2; overflow-y: auto;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  border-left: 1px solid rgba(90, 200, 255, 0.25); padding: 10px 12px 40px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
.pf-tuner * { box-sizing: border-box; }
.pf-tuner h2 { font-size: 11px; margin: 0 0 8px; letter-spacing: .16em;
  text-transform: uppercase; color: #7fe3ff; }
.pf-tuner h3 { font-size: 10px; margin: 14px 0 5px; letter-spacing: .14em;
  text-transform: uppercase; color: #5f8ea6; border-bottom: 1px solid rgba(90,200,255,.14);
  padding-bottom: 3px; }
.pf-row { display: grid; grid-template-columns: 92px 1fr 42px; gap: 6px;
  align-items: center; margin: 3px 0; }
.pf-row label { color: #9fc4d6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-row input[type=range] { width: 100%; height: 14px; accent-color: #35c8f5; }
.pf-row output { text-align: right; color: #e6f6ff; font-variant-numeric: tabular-nums; }
.pf-fixture { border: 1px solid rgba(90,200,255,.18); border-radius: 4px;
  padding: 6px; margin: 5px 0; background: rgba(12,28,42,.6); }
.pf-fixture.is-active { border-color: #35c8f5; background: rgba(20,52,74,.7); }
.pf-fixture-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.pf-fixture-head b { flex: 1; font-weight: 600; color: #bfe6f7; cursor: pointer; }
.pf-btn { background: #16344a; color: #cfe6f2; border: 1px solid #2b6b8c;
  border-radius: 3px; padding: 3px 7px; cursor: pointer; font: inherit; }
.pf-btn:hover { background: #1e4863; }
.pf-btn--danger { border-color: #8c3a3a; color: #ffb9b9; }
.pf-actions { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 10px; }
.pf-note { color: #6f93a6; margin: 6px 0 0; }
.pf-swatch { width: 18px; height: 14px; border: none; padding: 0; background: none; cursor: pointer; }
.pf-select { background: #12293c; color: #cfe6f2; border: 1px solid #2b6b8c;
  border-radius: 3px; padding: 2px 4px; font: inherit; width: 100%; }
.pf-test { border: 1px solid rgba(255, 196, 60, .35); border-radius: 4px;
  padding: 7px; margin: 4px 0 2px; background: rgba(44, 32, 8, .5); }
.pf-test.is-on { border-color: #ffc43c; background: rgba(66, 48, 10, .66); }
.pf-test h3 { margin-top: 0; color: #ffc43c; border-color: rgba(255,196,60,.2); }
.pf-test select { margin-bottom: 6px; }
.pf-test-note { color: #b9a274; margin: 5px 0 0; }
.pf-btn--ab { border-color: #a8801f; color: #ffe6a6; user-select: none; }
.pf-btn--ab:active { background: #6a4f10; }
.pf-baseline { color: #6f93a6; margin: 6px 0 0; }
.pf-baseline b { color: #9fc4d6; font-weight: 600; }
.pf-handle { position: absolute; border: 1.5px solid rgba(120,235,255,.95);
  border-radius: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 10px rgba(60,210,255,.55);
  cursor: grab; touch-action: none; }
.pf-handle.is-active { border-color: #fff03a; box-shadow: 0 0 0 1px rgba(0,0,0,.7), 0 0 12px rgba(255,225,60,.7); }
.pf-handle:active { cursor: grabbing; }
.pf-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 50; }
`;

function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
  // The renderer works in linear light; the picker hands back sRGB.
  return srgb.map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
}

function linearToHex(rgb) {
  const srgb = (rgb || [0, 0, 0]).map(v => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  });
  return '#' + srgb.map(v => v.toString(16).padStart(2, '0')).join('');
}

export class PlayfieldTuner {
  constructor(renderer, options = {}) {
    this.renderer = renderer;            // GpuPlayfieldRenderer
    this.getHostCanvas = options.getHostCanvas || (() => renderer.canvas);
    this.onChange = options.onChange || (() => {});
    this.root = null;
    this.overlay = null;
    this.handles = new Map();
    this.activeId = null;
    this.showHandles = false;
    this._drag = null;
    this._raf = 0;
    // Light-test state. `baseline` is the rig as it was before any test was
    // engaged, held frozen for as long as one is; turning the test off restores
    // it verbatim. It is also what gets persisted, so leaving a test switched
    // on — or reloading with one active — can never make it the default.
    this.testId = null;
    this.baseline = null;
    this._previewingBaseline = false;
  }

  static loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== LIGHTING_VERSION) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      if (!parsed.config) return null;
      return {
        config: parsed.config,
        testId: typeof parsed.testId === 'string' ? parsed.testId : null,
        // The tested rig is stored whole, so tweaks made while comparing come
        // back on reload without ever being written into `config`.
        testConfig: parsed.testConfig || null
      };
    } catch { return null; }
  }

  mount() {
    if (this.root || typeof document === 'undefined') return;
    if (!document.getElementById('pf-tuner-css')) {
      const style = document.createElement('style');
      style.id = 'pf-tuner-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement('aside');
    this.root.className = 'pf-tuner';
    document.body.appendChild(this.root);
    this._buildPanel();
    this._ensureOverlay();
    this._syncLoop();
  }

  unmount() {
    cancelAnimationFrame(this._raf);
    this.root?.remove();
    this.overlay?.remove();
    this.root = null;
    this.overlay = null;
    this.fixtureList = null;
    this.handles.clear();
  }

  toggle() {
    if (this.root) this.unmount();
    else this.mount();
  }

  get config() { return this.renderer.config; }

  _apply(partial) {
    this.renderer.setLighting(partial);
    this._save();
    this.onChange(this.renderer.config);
  }

  _save() {
    // Never write while flicking A/B: what is on screen mid-compare is not a
    // state anyone asked to keep.
    if (this._previewingBaseline) return;
    try {
      const live = this.renderer.getLighting();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: LIGHTING_VERSION,
        // Always the untested rig. This is the line that makes the default
        // safe: with a test engaged the live config goes to `testConfig` and
        // `config` keeps the values you tuned.
        config: this.baseline || live,
        testId: this.testId || undefined,
        testConfig: this.testId ? live : undefined
      }));
    } catch {}
  }

  /** Engage a candidate rig, or pass null to go back to yours. */
  _setTest(id, presetConfig = null) {
    if (!id) {
      if (this.baseline) this.renderer.setLighting(this.baseline);
      this.testId = null;
      this.baseline = null;
    } else {
      const test = LIGHT_TESTS.find(t => t.id === id);
      if (!test) return;
      // Snapshot once, on the way in. Re-snapshotting when switching between
      // tests would capture a tested rig as the baseline.
      if (!this.baseline) this.baseline = this.renderer.getLighting();
      this.testId = id;
      this.renderer.setLighting(presetConfig || { ...this.baseline, ...test.patch });
    }
    this._save();
    this._buildPanel();
    this._syncHandles(true);
    this.onChange(this.renderer.config);
  }

  /** Hold to see the untested rig; release to go back to the candidate. The
   *  only reliable way to judge a tone change is to flick between the two. */
  _previewBaseline(on) {
    if (!this.testId || !this.baseline) return;
    if (on) {
      if (this._previewingBaseline) return;
      this._tested = this.renderer.getLighting();
      this._previewingBaseline = true;
      this.renderer.setLighting(this.baseline);
    } else {
      if (!this._previewingBaseline) return;
      this._previewingBaseline = false;
      if (this._tested) this.renderer.setLighting(this._tested);
    }
    this.onChange(this.renderer.config);
  }

  /** Opt-in, and the only path by which a test can become the default. */
  _promoteTest() {
    if (!this.testId) return;
    this.baseline = null;
    this.testId = null;
    this._save();
    this._buildPanel();
  }

  _buildPanel() {
    // A light test can be driven while the panel is closed (the ` key, or the
    // console), so rebuilding has to be a no-op rather than a crash.
    if (!this.root) return;
    const cfg = this.config;
    this.root.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = 'Playfield lighting';
    this.root.appendChild(title);

    this._buildLightTest();

    let group = '';
    for (const spec of SLIDERS) {
      if (spec.group !== group) {
        group = spec.group;
        const h = document.createElement('h3');
        h.textContent = group;
        this.root.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'pf-row';
      const label = document.createElement('label');
      label.textContent = spec.label || spec.key;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      input.value = cfg[spec.key];
      const out = document.createElement('output');
      out.textContent = Number(cfg[spec.key]).toFixed(2);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        out.textContent = value.toFixed(2);
        this._apply({ [spec.key]: value });
      });
      row.append(label, input, out);
      this.root.appendChild(row);
      spec._input = input;
      spec._out = out;
    }

    const colourHead = document.createElement('h3');
    colourHead.textContent = 'Colour';
    this.root.appendChild(colourHead);
    for (const [label, key] of [['dome tint', 'domeColor'], ['board', 'boardColor']]) {
      const row = document.createElement('div');
      row.className = 'pf-row';
      const name = document.createElement('label');
      name.textContent = label;
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.className = 'pf-swatch';
      picker.value = linearToHex(cfg[key]);
      picker.addEventListener('input', () => this._apply({ [key]: hexToLinear(picker.value) }));
      row.append(name, picker, document.createElement('span'));
      this.root.appendChild(row);
    }

    const styleRow = document.createElement('div');
    styleRow.className = 'pf-row';
    const styleLabel = document.createElement('label');
    styleLabel.textContent = 'wall style';
    const styleSelect = document.createElement('select');
    styleSelect.className = 'pf-select';
    for (const option of BOARD_STYLES) {
      const opt = document.createElement('option');
      opt.value = String(option.value);
      opt.textContent = option.label;
      styleSelect.appendChild(opt);
    }
    styleSelect.value = String(cfg.boardStyle);
    styleSelect.onchange = () => this._apply({ boardStyle: Number(styleSelect.value) });
    styleRow.append(styleLabel, styleSelect, document.createElement('span'));
    this.root.appendChild(styleRow);

    const fixHead = document.createElement('h3');
    fixHead.textContent = 'Light fixtures';
    this.root.appendChild(fixHead);

    // The drag handles are an editing affordance, not part of the scene, so
    // they stay off unless asked for — otherwise they read as glowing outlines
    // around lights that are not actually there.
    const handleRow = document.createElement('div');
    handleRow.className = 'pf-row';
    const handleLabel = document.createElement('label');
    handleLabel.textContent = 'show handles';
    const handleToggle = document.createElement('input');
    handleToggle.type = 'checkbox';
    handleToggle.checked = this.showHandles;
    handleToggle.onchange = () => {
      this.showHandles = handleToggle.checked;
      this._syncHandles(true);
    };
    handleRow.append(handleLabel, handleToggle, document.createElement('span'));
    this.root.appendChild(handleRow);
    this.fixtureList = document.createElement('div');
    this.root.appendChild(this.fixtureList);
    this._buildFixtureList();

    const note = document.createElement('p');
    note.className = 'pf-note';
    note.textContent = 'Enable "show handles" to drag fixtures on the board. Shift+drag scales.';
    this.root.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'pf-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'pf-btn';
    addBtn.textContent = '+ light';
    addBtn.onclick = () => this._addFixture();
    const copyBtn = document.createElement('button');
    copyBtn.className = 'pf-btn';
    copyBtn.textContent = 'copy JSON';
    copyBtn.onclick = () => {
      const json = JSON.stringify(this.renderer.getLighting(), null, 2);
      navigator.clipboard?.writeText(json);
      copyBtn.textContent = 'copied';
      setTimeout(() => { copyBtn.textContent = 'copy JSON'; }, 1200);
    };
    const resetBtn = document.createElement('button');
    resetBtn.className = 'pf-btn pf-btn--danger';
    resetBtn.textContent = 'reset';
    resetBtn.onclick = () => {
      this.renderer.resetLighting();
      this.testId = null;
      this.baseline = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      this._buildPanel();
      this._syncHandles(true);
    };
    actions.append(addBtn, copyBtn, resetBtn);
    this.root.appendChild(actions);
  }

  _buildLightTest() {
    const box = document.createElement('div');
    box.className = 'pf-test' + (this.testId ? ' is-on' : '');

    const head = document.createElement('h3');
    head.textContent = 'Light test';
    box.appendChild(head);

    const select = document.createElement('select');
    select.className = 'pf-select';
    const off = document.createElement('option');
    off.value = '';
    off.textContent = 'off — your rig';
    select.appendChild(off);
    for (const test of LIGHT_TESTS) {
      const opt = document.createElement('option');
      opt.value = test.id;
      opt.textContent = test.label;
      select.appendChild(opt);
    }
    select.value = this.testId || '';
    select.onchange = () => this._setTest(select.value || null);
    box.appendChild(select);

    if (this.testId) {
      const test = LIGHT_TESTS.find(t => t.id === this.testId);

      const actions = document.createElement('div');
      actions.className = 'pf-actions';

      const ab = document.createElement('button');
      ab.className = 'pf-btn pf-btn--ab';
      ab.textContent = 'hold to A/B';
      ab.title = 'Hold to see your rig, release for the test. Or hold the ` key.';
      const down = e => { e.preventDefault(); this._previewBaseline(true); };
      const up = () => this._previewBaseline(false);
      ab.addEventListener('pointerdown', down);
      ab.addEventListener('pointerup', up);
      ab.addEventListener('pointerleave', up);
      ab.addEventListener('pointercancel', up);

      const keep = document.createElement('button');
      keep.className = 'pf-btn';
      keep.textContent = 'make default';
      keep.title = 'Adopt the test as your rig. Nothing else overwrites it.';
      keep.onclick = () => this._promoteTest();

      actions.append(ab, keep);
      box.appendChild(actions);

      if (test?.note) {
        const note = document.createElement('p');
        note.className = 'pf-test-note';
        note.textContent = test.note;
        box.appendChild(note);
      }

      // Spell out exactly what is being held aside, so "is my tuning safe" is
      // answerable by looking rather than by trusting.
      const kept = document.createElement('p');
      kept.className = 'pf-baseline';
      const changed = Object.keys(test?.patch || {});
      kept.innerHTML = `overrides <b>${changed.join(', ')}</b><br>`
        + `your rig is held and restored on "off"`;
      box.appendChild(kept);
    } else {
      const note = document.createElement('p');
      note.className = 'pf-baseline';
      note.textContent = 'Layers a candidate over your rig to compare. Your '
        + 'values are kept and restored when you switch back off.';
      box.appendChild(note);
    }

    this.root.appendChild(box);
  }

  _buildFixtureList() {
    if (!this.fixtureList) return;
    this.fixtureList.innerHTML = '';
    for (const fixture of this.config.fixtures) {
      const card = document.createElement('div');
      card.className = 'pf-fixture' + (fixture.id === this.activeId ? ' is-active' : '');
      card.dataset.id = fixture.id;

      const head = document.createElement('div');
      head.className = 'pf-fixture-head';
      const name = document.createElement('b');
      name.textContent = fixture.id;
      name.onclick = () => { this.activeId = fixture.id; this._buildFixtureList(); this._syncHandles(true); };
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.title = 'light on/off';
      toggle.checked = fixture.enabled !== false;
      toggle.onchange = () => this._updateFixture(fixture.id, { enabled: toggle.checked });
      // Separate from on/off: a fixture can light the board without being drawn.
      const shown = document.createElement('input');
      shown.type = 'checkbox';
      shown.title = 'draw the fixture itself';
      shown.checked = fixture.visible === true;
      shown.onchange = () => this._updateFixture(fixture.id, { visible: shown.checked });
      const swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.className = 'pf-swatch';
      swatch.value = linearToHex(fixture.color);
      swatch.oninput = () => this._updateFixture(fixture.id, { color: hexToLinear(swatch.value) });
      const del = document.createElement('button');
      del.className = 'pf-btn pf-btn--danger';
      del.textContent = '×';
      del.onclick = () => this._removeFixture(fixture.id);
      head.append(toggle, shown, name, swatch, del);
      card.appendChild(head);

      for (const [key, min, max, step] of [
        ['intensity', 0, 6, 0.01], ['halfW', 1, 200, 0.5],
        ['halfH', 1, 200, 0.5], ['angle', -3.15, 3.15, 0.01]
      ]) {
        const row = document.createElement('div');
        row.className = 'pf-row';
        const label = document.createElement('label');
        label.textContent = key;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min; input.max = max; input.step = step;
        input.value = fixture[key];
        const out = document.createElement('output');
        out.textContent = Number(fixture[key]).toFixed(2);
        input.oninput = () => {
          out.textContent = Number(input.value).toFixed(2);
          this._updateFixture(fixture.id, { [key]: Number(input.value) });
        };
        row.append(label, input, out);
        card.appendChild(row);
      }
      this.fixtureList.appendChild(card);
    }
  }

  _updateFixture(id, patch, rebuild = false) {
    const fixtures = this.config.fixtures.map(f => (f.id === id ? { ...f, ...patch } : f));
    this._apply({ fixtures });
    if (rebuild) this._buildFixtureList();
    this._syncHandles(true);
  }

  _addFixture() {
    const id = `light-${Date.now().toString(36).slice(-4)}`;
    const fixtures = [...this.config.fixtures, {
      id, x: 0.5, y: 0.5, halfW: 4, halfH: 16, angle: 0,
      color: [0.9, 0.45, 0.15], intensity: 2.0, shape: 'emitter'
    }];
    this.activeId = id;
    this._apply({ fixtures });
    this._buildFixtureList();
    this._syncHandles(true);
  }

  _removeFixture(id) {
    this._apply({ fixtures: this.config.fixtures.filter(f => f.id !== id) });
    if (this.activeId === id) this.activeId = null;
    this._buildFixtureList();
    this._syncHandles(true);
  }

  // ── on-board drag handles ────────────────────────────────────────────────

  _ensureOverlay() {
    const canvas = this.getHostCanvas();
    const host = canvas?.parentElement;
    if (!host) return null;
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.className = 'pf-overlay';
    }
    if (this.overlay.parentElement !== host) host.appendChild(this.overlay);
    return this.overlay;
  }

  /** Handles are positioned against the canvas's on-screen box, so they track
   *  the board through any CSS scaling the layout applies. */
  _syncHandles(rebuild = false) {
    const overlay = this._ensureOverlay();
    const canvas = this.getHostCanvas();
    if (!overlay || !canvas) return;

    if (!this.showHandles) {
      if (this.handles.size) {
        for (const handle of this.handles.values()) handle.remove();
        this.handles.clear();
      }
      return;
    }

    const host = overlay.parentElement;
    const hostRect = host.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    const offsetX = rect.left - hostRect.left;
    const offsetY = rect.top - hostRect.top;

    const seen = new Set();
    for (const fixture of this.config.fixtures) {
      seen.add(fixture.id);
      let handle = this.handles.get(fixture.id);
      if (!handle) {
        handle = document.createElement('div');
        handle.className = 'pf-handle';
        handle.style.pointerEvents = 'auto';
        this._bindDrag(handle, fixture.id);
        overlay.appendChild(handle);
        this.handles.set(fixture.id, handle);
      }
      const w = (fixture.halfW * 2 / this.renderer.width) * rect.width;
      const h = (fixture.halfH * 2 / this.renderer.height) * rect.height;
      handle.style.left = `${offsetX + fixture.x * rect.width - w / 2}px`;
      handle.style.top = `${offsetY + fixture.y * rect.height - h / 2}px`;
      // Floor the hit area: a 3px light strip is otherwise impossible to grab.
      handle.style.width = `${Math.max(16, w)}px`;
      handle.style.height = `${Math.max(16, h)}px`;
      handle.style.transform = `rotate(${fixture.angle}rad)`;
      handle.style.opacity = fixture.enabled === false ? '0.3' : '1';
      handle.classList.toggle('is-active', fixture.id === this.activeId);
      if (rebuild) handle.title = fixture.id;
    }
    for (const [id, handle] of this.handles) {
      if (seen.has(id)) continue;
      handle.remove();
      this.handles.delete(id);
    }
  }

  // Move/up are bound on the window rather than relying on pointer capture:
  // capture is not honoured by every synthetic event source, and a drag that
  // leaves the handle must keep tracking.
  _bindDrag(handle, id) {
    const onMove = event => {
      const drag = this._drag;
      if (!drag || drag.id !== id) return;
      event.preventDefault();
      const rect = this.getHostCanvas().getBoundingClientRect();
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.scaling) {
        this._updateFixture(id, {
          halfW: Math.max(1, drag.originW + dx * 0.35),
          halfH: Math.max(1, drag.originH - dy * 0.35)
        }, true);
      } else {
        this._updateFixture(id, {
          x: Math.max(-0.2, Math.min(1.2, drag.originX + dx / Math.max(rect.width, 1))),
          y: Math.max(-0.2, Math.min(1.2, drag.originY + dy / Math.max(rect.height, 1)))
        });
      }
    };

    const onUp = () => {
      if (this._drag?.id !== id) return;
      this._drag = null;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('mouseup', onUp, true);
    };

    const onDown = event => {
      // A real mouse fires pointerdown and mousedown; only start one drag.
      if (this._drag?.id === id) return;
      const fixture = this.config.fixtures.find(f => f.id === id);
      if (!fixture) return;
      event.preventDefault();
      event.stopPropagation();
      this.activeId = id;
      this._buildFixtureList();
      this._drag = {
        id,
        startX: event.clientX,
        startY: event.clientY,
        originX: fixture.x,
        originY: fixture.y,
        originW: fixture.halfW,
        originH: fixture.halfH,
        scaling: event.shiftKey
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('mouseup', onUp, true);
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('mousedown', onDown);
  }

  // The board can be relaid out at any time (resize, level change), so keep the
  // handles pinned to it rather than positioning them once.
  _syncLoop() {
    this._syncHandles();
    this._raf = requestAnimationFrame(() => this._syncLoop());
  }
}

export function installPlayfieldTuner(renderer, options = {}) {
  if (!renderer || typeof document === 'undefined') return null;
  const tuner = new PlayfieldTuner(renderer, options);

  const saved = PlayfieldTuner.loadSaved();
  if (saved) {
    renderer.setLighting(saved.config);
    // A test that was left engaged comes back engaged, but the rig it is
    // layered over is still the one in `config` — the test never becomes it.
    if (saved.testId && LIGHT_TESTS.some(t => t.id === saved.testId)) {
      tuner.baseline = renderer.getLighting();
      tuner.testId = saved.testId;
      const test = LIGHT_TESTS.find(t => t.id === saved.testId);
      renderer.setLighting(saved.testConfig || { ...tuner.baseline, ...test.patch });
    }
  }

  const params = new URLSearchParams(location.search);
  if (params.get('tune') === '1') tuner.mount();

  window.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyL') {
      event.preventDefault();
      tuner.toggle();
      return;
    }
    // Hold ` to flick back to your rig without reaching for the panel. Ignored
    // while typing so it can't fire from a text field.
    if (event.code === 'Backquote' && !event.repeat && !event.ctrlKey && !event.metaKey
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      tuner._previewBaseline(true);
    }
  });
  window.addEventListener('keyup', event => {
    if (event.code === 'Backquote') tuner._previewBaseline(false);
  });
  // A lost focus mid-hold would otherwise strand the preview on screen.
  window.addEventListener('blur', () => tuner._previewBaseline(false));

  window.playfieldTuner = tuner;
  return tuner;
}
