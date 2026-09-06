// Side-by-side SVG: the original layout next to the layout replayed from the DSL.
// Strokes are colour-coded so it is visible which gesture claimed which pegs.
// Residual objects (the DSL could not explain them) are drawn in red.

import { finite, round } from './geometry.mjs';
import { recompileLevel } from './recompile.mjs';

const PALETTE = [
  '#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04',
  '#db2777', '#65a30d', '#4f46e5', '#0d9488', '#b45309', '#7c3aed'
];

function colorFor(strokeId, index) {
  return PALETTE[index % PALETTE.length];
}

function escapeText(value) {
  return String(value).replace(/[<>&]/g, character => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]
  ));
}

function drawObject(point, fill, radius, opacity = 1) {
  if (point.kind === 'brick') {
    const width = 22;
    const height = 8;
    const degrees = round(finite(point.rotation) * 180 / Math.PI, 2);
    return `<rect x="${round(-width / 2, 2)}" y="${round(-height / 2, 2)}" width="${width}" height="${height}" rx="2" `
      + `fill="${fill}" opacity="${opacity}" transform="translate(${round(point.x, 2)} ${round(point.y, 2)}) rotate(${degrees})" />`;
  }
  return `<circle cx="${round(point.x, 2)}" cy="${round(point.y, 2)}" r="${radius}" fill="${fill}" opacity="${opacity}" />`;
}

function panel(title, subtitle, frame, body, offsetX) {
  return `<g transform="translate(${offsetX} 0)">
  <rect x="0" y="0" width="${frame.width}" height="${frame.height}" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" />
  <rect x="0" y="0" width="${frame.width}" height="26" fill="#1e293b" />
  <text x="8" y="18" font-family="monospace" font-size="13" fill="#f8fafc">${escapeText(title)}</text>
  <text x="${frame.width - 8}" y="18" text-anchor="end" font-family="monospace" font-size="11" fill="#94a3b8">${escapeText(subtitle)}</text>
  <line x1="${frame.launchAxisX}" y1="26" x2="${frame.launchAxisX}" y2="${frame.height}" stroke="#ef4444" stroke-width="1" stroke-dasharray="4 4" opacity="0.5" />
  ${body}
</g>`;
}

export function renderComparisonSvg(record, dsl, roundTripResult) {
  const frame = {
    width: Math.max(200, finite(dsl.frame?.width, 646)),
    height: Math.max(200, finite(dsl.frame?.height, 543)),
    launchAxisX: finite(dsl.frame?.launchAxisX, 327)
  };
  const gap = 24;
  const totalWidth = frame.width * 2 + gap;

  const originals = (record.authored?.objects || [])
    .filter(object => object.role === 'target')
    .map(object => ({
      x: finite(object.transform?.x),
      y: finite(object.transform?.y),
      rotation: finite(object.transform?.rotation),
      kind: object.kind
    }));
  const leftBody = originals.map(point => drawObject(point, '#334155', 5.5, 0.85)).join('\n  ');

  const rebuilt = recompileLevel(dsl);
  const strokeOrder = new Map((dsl.strokes || []).map((stroke, index) => [stroke.id, index]));
  const rightBody = [
    ...rebuilt.points.map(point => drawObject(
      point,
      colorFor(point.strokeId, strokeOrder.get(point.strokeId) ?? 0),
      5.5,
      point.evidence === 'exact' ? 0.95 : 0.6
    )),
    ...rebuilt.residual.map(point => drawObject(point, '#dc2626', 5.5, 0.95))
  ].join('\n  ');

  const error = roundTripResult?.error?.strokes;
  const leftSubtitle = `${originals.length} objects`;
  const rightSubtitle = error
    ? `${dsl.coverage.strokeCount} strokes | ${Math.round(dsl.coverage.explainedFraction * 100)}% explained | ${error.median}px median`
    : `${dsl.coverage.strokeCount} strokes`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${frame.height}" width="${totalWidth}" height="${frame.height}">
${panel(`${dsl.name} - original`, leftSubtitle, frame, leftBody, 0)}
${panel(`${dsl.name} - replayed from DSL`, rightSubtitle, frame, rightBody, frame.width + gap)}
</svg>
`;
}
