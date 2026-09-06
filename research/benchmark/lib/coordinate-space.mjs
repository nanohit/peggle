export const PEGGLEEDIT_COORDINATE_REVISION = 'peggleedit-playfield-v1';

// PeggleEdit keeps level-entry coordinates in the white playfield's local
// frame. Its editor draws those entries into the full 800x600 game frame with
// Level.DrawAdjustX/Y. Keeping the local frame canonical avoids baking editor
// chrome into authored geometry while preserving an exact screen mapping.
export const PEGGLEEDIT_PLAYFIELD = Object.freeze({
  width: 646,
  height: 543,
  screenWidth: 800,
  screenHeight: 600,
  drawOffsetX: 73,
  drawOffsetY: 43,
  backgroundOffsetX: 73,
  backgroundOffsetY: 53,
  launchAxisX: 327
});

export function isPeggleEditLevel(levelRecord) {
  const source = String(levelRecord?.provenance?.source?.system || '').toLowerCase();
  const parser = String(levelRecord?.authored?.mechanics?.sourceParser || '').toLowerCase();
  return source.startsWith('peggle-') || parser.includes('peggleedit');
}

export function peggleEditCoordinateContract() {
  const frame = PEGGLEEDIT_PLAYFIELD;
  return {
    revision: PEGGLEEDIT_COORDINATE_REVISION,
    bounds: { minX: 0, minY: 0, maxX: frame.width, maxY: frame.height },
    viewport: { width: frame.width, height: frame.height },
    sourceFrame: {
      screen: { width: frame.screenWidth, height: frame.screenHeight },
      entryDrawOffset: { x: frame.drawOffsetX, y: frame.drawOffsetY },
      backgroundDrawOffset: { x: frame.backgroundOffsetX, y: frame.backgroundOffsetY }
    },
    launchAxis: {
      x: frame.launchAxisX,
      coordinateSpace: 'source-playfield',
      evidence: 'full-screen-center-minus-PeggleEdit-Level.DrawAdjustX'
    }
  };
}

export function launchAxisX(levelRecord) {
  const bounds = levelRecord?.authored?.coordinateSystem?.bounds || { minX: 0, maxX: 0 };
  const mechanics = levelRecord?.authored?.mechanics || {};
  if (Number.isFinite(Number(mechanics.launcher?.x))) return Number(mechanics.launcher.x);
  if (Number.isFinite(Number(mechanics.launchAxis?.x))) return Number(mechanics.launchAxis.x);
  return Number(bounds.minX) + (Number(bounds.maxX) - Number(bounds.minX)) / 2;
}
