// Visual Layout Config - data model, defaults, normalization
// Per-level visual theme configuration for decorative frame assets

export const DEFAULT_BACKGROUND = {
  type: 'image',
  colorTop: '#16213e',
  colorBottom: '#1a1a2e',
  image: 'visuals/backgrounds/background1.webp',
};

export const DEFAULT_FRAME_COLOR = '#0a0a14';

// Slot definitions: each describes a decorative asset.
// baseWidth: natural width as % of frame width at scale=1
// defaultX/Y: default center position as % of frame (0-100)
export const SLOT_DEFS = [
  { id: 'columnLeft',       label: 'Column Left',      basename: 'column',                baseWidth: 5,  defaultX: 2.5,   defaultY: 50,    defaultScale: 1, column: true, defaultDarken: 30 },
  { id: 'columnRight',      label: 'Column Right',     basename: 'column',                baseWidth: 5,  defaultX: 97.5,  defaultY: 50,    defaultScale: 1, column: true, mirror: true, defaultDarken: 30 },
  { id: 'top',              label: 'Top Banner',       basename: 'top',                   baseWidth: 50, defaultX: 49.55, defaultY: 0,     defaultScale: 1.56 },
  { id: 'topLeft',          label: 'Top Left',         basename: 'top_left',              baseWidth: 26, defaultX: 19.24, defaultY: 9.71,  defaultScale: 1.47 },
  { id: 'topRight',         label: 'Top Right',        basename: 'top_right',             baseWidth: 26, defaultX: 81.43, defaultY: 9.48,  defaultScale: 1.47 },
  { id: 'characterCircle',  label: 'Character Circle', basename: 'character_circle',      baseWidth: 22, defaultX: 49.55, defaultY: 11.77, defaultScale: 1.16 },
  { id: 'healthCircle',     label: 'Health Circle',    basename: null,                    baseWidth: 12, defaultX: 49.43, defaultY: 11.76, defaultScale: 1.79, dynamic: true, defaultColor: '#ebffeb' },
  { id: 'healthCharCircle', label: 'Health Ring',      basename: 'character_circle',       baseWidth: 20, defaultX: 49.55, defaultY: 11.77, defaultScale: 1.01 },
  { id: 'character',        label: 'Character',        basename: 'character',             baseWidth: 22, defaultX: 49.55, defaultY: 11.3,  defaultScale: 0.83 },
  { id: 'leftCircle',       label: 'Left Circle',      basename: 'left_circle',           baseWidth: 16, defaultX: 10.9,  defaultY: 5.76,  defaultScale: 1.35 },
  { id: 'rightCircle',      label: 'Right Circle',     basename: 'right-center_cirlce',   baseWidth: 16, defaultX: 90.22, defaultY: 5.53,  defaultScale: 1.3 },
  { id: 'itemCircle',       label: 'Item Circle',      basename: 'item_cirlce',           baseWidth: 10, defaultX: 88,    defaultY: 16,    defaultScale: 1 },
  { id: 'arrow',            label: 'Arrow',            basename: 'arrow',                 baseWidth: 30, defaultX: 50,    defaultY: 93,    defaultScale: 1 },
  { id: 'ballCounter',      label: 'Ball Counter',     basename: null,                    baseWidth: 16, defaultX: 90,    defaultY: 5.53,  defaultScale: 1.07, dynamic: true },
];

export function resolveAssetPaths(basename) {
  return {
    webp: `visuals/assets_webtp/${basename}.webp`,
    png: `visuals/Assets_png/${basename}.png`,
  };
}

function defaultSlots() {
  const slots = {};
  for (const def of SLOT_DEFS) {
    slots[def.id] = {
      visible: true,
      customSrc: null,
      x: def.defaultX,
      y: def.defaultY,
      scale: def.defaultScale || 1,
      color: def.defaultColor || null,
      darken: def.defaultDarken || 0,
    };
  }
  return slots;
}

// Default layer order: back to front
export const DEFAULT_LAYER_ORDER = SLOT_DEFS.map(d => d.id);

export const DEFAULT_VISUALS = {
  background: { ...DEFAULT_BACKGROUND },
  frameColor: DEFAULT_FRAME_COLOR,
  ballColor: null,
  slots: defaultSlots(),
  layerOrder: [...DEFAULT_LAYER_ORDER],
};

function loadSavedDefaults() {
  try {
    const saved = localStorage.getItem('peggle_visualDefaults');
    if (saved) return JSON.parse(saved);
  } catch (_) {}
  return null;
}

export function normalizeVisuals(raw, _skipSaved) {
  if (!raw || typeof raw !== 'object') {
    if (!_skipSaved) {
      const saved = loadSavedDefaults();
      if (saved && typeof saved === 'object') {
        return normalizeVisuals(saved, true);
      }
    }
    return JSON.parse(JSON.stringify(DEFAULT_VISUALS));
  }

  const result = {};

  // Background
  const bg = raw.background;
  if (bg && typeof bg === 'object') {
    const validTypes = ['solid', 'gradient', 'image'];
    result.background = {
      type: validTypes.includes(bg.type) ? bg.type : 'image',
      colorTop: typeof bg.colorTop === 'string' ? bg.colorTop : DEFAULT_BACKGROUND.colorTop,
      colorBottom: typeof bg.colorBottom === 'string' ? bg.colorBottom : DEFAULT_BACKGROUND.colorBottom,
      image: typeof bg.image === 'string' ? bg.image : DEFAULT_BACKGROUND.image,
    };
  } else {
    result.background = { ...DEFAULT_BACKGROUND };
  }

  result.frameColor = typeof raw.frameColor === 'string' ? raw.frameColor : DEFAULT_FRAME_COLOR;
  result.ballColor = typeof raw.ballColor === 'string' ? raw.ballColor : null;

  // Slots with position/scale
  result.slots = {};
  for (const def of SLOT_DEFS) {
    const slot = raw.slots?.[def.id];
    if (slot && typeof slot === 'object') {
      result.slots[def.id] = {
        visible: slot.visible !== false,
        customSrc: typeof slot.customSrc === 'string' ? slot.customSrc : null,
        x: typeof slot.x === 'number' ? slot.x : def.defaultX,
        y: typeof slot.y === 'number' ? slot.y : def.defaultY,
        scale: typeof slot.scale === 'number' ? Math.max(0.1, Math.min(5, slot.scale)) : (def.defaultScale || 1),
        color: typeof slot.color === 'string' ? slot.color : (def.defaultColor || null),
        darken: typeof slot.darken === 'number' ? Math.max(0, Math.min(100, slot.darken)) : (def.defaultDarken || 0),
      };
    } else {
      result.slots[def.id] = {
        visible: true,
        customSrc: null,
        x: def.defaultX,
        y: def.defaultY,
        scale: def.defaultScale || 1,
        color: def.defaultColor || null,
        darken: def.defaultDarken || 0,
      };
    }
  }

  // Layer order: validate array of known slot IDs, fill missing
  const validIds = new Set(SLOT_DEFS.map(d => d.id));
  if (Array.isArray(raw.layerOrder)) {
    const seen = new Set();
    const order = [];
    for (const id of raw.layerOrder) {
      if (validIds.has(id) && !seen.has(id)) {
        order.push(id);
        seen.add(id);
      }
    }
    // Append any missing IDs at the end
    for (const id of DEFAULT_LAYER_ORDER) {
      if (!seen.has(id)) order.push(id);
    }
    result.layerOrder = order;
  } else {
    result.layerOrder = [...DEFAULT_LAYER_ORDER];
  }

  return result;
}
