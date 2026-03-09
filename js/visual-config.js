// Visual Layout Config - data model, defaults, normalization
// Per-level visual theme configuration for decorative frame assets

export const DEFAULT_BACKGROUND = {
  type: 'gradient',
  colorTop: '#16213e',
  colorBottom: '#1a1a2e',
};

export const DEFAULT_FRAME_COLOR = '#0a0a14';

// Slot definitions: each describes a decorative asset.
// baseWidth: natural width as % of frame width at scale=1
// defaultX/Y: default center position as % of frame (0-100)
export const SLOT_DEFS = [
  { id: 'topLeft',         label: 'Top Left',         basename: 'top_left',              baseWidth: 26, defaultX: 13, defaultY: 5 },
  { id: 'topRight',        label: 'Top Right',        basename: 'top_right',             baseWidth: 26, defaultX: 87, defaultY: 5 },
  { id: 'top',             label: 'Top Banner',       basename: 'top',                   baseWidth: 50, defaultX: 50, defaultY: 4 },
  { id: 'character',       label: 'Character',        basename: 'character',             baseWidth: 22, defaultX: 50, defaultY: 8 },
  { id: 'characterCircle', label: 'Character Circle', basename: 'character_circle',      baseWidth: 22, defaultX: 50, defaultY: 10 },
  { id: 'leftCircle',      label: 'Left Circle',      basename: 'left_circle',           baseWidth: 16, defaultX: 8,  defaultY: 8 },
  { id: 'rightCircle',     label: 'Right Circle',     basename: 'right-center_cirlce',   baseWidth: 16, defaultX: 92, defaultY: 8 },
  { id: 'itemCircle',      label: 'Item Circle',      basename: 'item_cirlce',           baseWidth: 10, defaultX: 88, defaultY: 16 },
  { id: 'arrow',           label: 'Arrow',            basename: 'arrow',                 baseWidth: 30, defaultX: 50, defaultY: 93 },
  { id: 'ballCounter',     label: 'Ball Counter',     basename: null,                    baseWidth: 16, defaultX: 92, defaultY: 8, dynamic: true },
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
      scale: 1,
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
    result.background = {
      type: bg.type === 'solid' ? 'solid' : 'gradient',
      colorTop: typeof bg.colorTop === 'string' ? bg.colorTop : DEFAULT_BACKGROUND.colorTop,
      colorBottom: typeof bg.colorBottom === 'string' ? bg.colorBottom : DEFAULT_BACKGROUND.colorBottom,
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
        scale: typeof slot.scale === 'number' ? Math.max(0.1, Math.min(5, slot.scale)) : 1,
      };
    } else {
      result.slots[def.id] = {
        visible: true,
        customSrc: null,
        x: def.defaultX,
        y: def.defaultY,
        scale: 1,
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
