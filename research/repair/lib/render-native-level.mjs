import { curvedBrickOutline, effectiveCompositionSize } from '../../../js/composition-geometry.js';

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function pegColor(peg) {
  if (peg.color) return peg.color;
  return {
    orange: '#ff8a36', green: '#7ddc8b', purple: '#c47cff', obstacle: '#778293',
    bumper: '#e5e7eb', bomb: '#ff4050', bombMagnet: '#27cddd', multi: '#ff58a8'
  }[peg.type] || '#73b8f4';
}

function pegSvg(peg, pegRadius, style = {}) {
  const fill = escapeXml(style.fill ?? pegColor(peg));
  const stroke = escapeXml(style.stroke ?? (peg.type === 'orange' ? '#8a3510' : '#233148'));
  const opacity = Number(style.opacity ?? 1);
  const strokeWidth = Number(style.strokeWidth ?? 1.2);
  const dash = style.dash ? ` stroke-dasharray="${escapeXml(style.dash)}"` : '';
  if (peg.shape === 'brick') {
    const outline = curvedBrickOutline(peg, pegRadius);
    if (outline) return `<polygon points="${outline.map(p => `${p.x},${p.y}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${dash}/>`;
    const { width, height } = effectiveCompositionSize(peg, pegRadius);
    const degrees = Number(peg.angle || 0) * 180 / Math.PI;
    return `<rect x="${peg.x - width / 2}" y="${peg.y - height / 2}" width="${width}" height="${height}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${dash} transform="rotate(${degrees} ${peg.x} ${peg.y})"/>`;
  }
  return `<circle cx="${peg.x}" cy="${peg.y}" r="${pegRadius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${dash}/>`;
}

function gridSvg(width, height) {
  return Array.from({ length: Math.floor(width / 50) + 1 }, (_value, index) => (
    `<line x1="${index * 50}" y1="0" x2="${index * 50}" y2="${height}"/>`
  )).concat(Array.from({ length: Math.floor(height / 50) + 1 }, (_value, index) => (
    `<line x1="0" y1="${index * 50}" x2="${width}" y2="${index * 50}"/>`
  ))).join('');
}

function sceneBackground(width, height) {
  return `<rect width="${width}" height="${height}" fill="#f1f4f9"/>
  <g stroke="#dce2ec" stroke-width="0.6">${gridSvg(width, height)}</g>
  <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" stroke="#d7445a" stroke-width="0.8" opacity="0.35" stroke-dasharray="5 5"/>
  <path d="M ${width / 2 - 8} 38 L ${width / 2} 22 L ${width / 2 + 8} 38 Z" fill="#dc3f49" stroke="#7f1e27"/>`;
}

function sceneBorder(width, height) {
  return `<rect x="0.75" y="0.75" width="${width - 1.5}" height="${height - 1.5}" fill="none" stroke="#273248" stroke-width="1.5"/>`;
}

function pegKey(peg, index) {
  if (peg?.memberId) return String(peg.memberId);
  if (peg?.objectId && Number.isFinite(Number(peg?.bezierIndex))) return `${peg.objectId}:${peg.bezierIndex}`;
  return String(peg?.id || `index:${index}`);
}

function pegChanged(before, after) {
  return Math.hypot(Number(after.x) - Number(before.x), Number(after.y) - Number(before.y)) > 0.25
    || before.shape !== after.shape
    || before.type !== after.type
    || Math.abs(Number(before.angle || 0) - Number(after.angle || 0)) > 1e-4
    || Math.abs(Number(before.width || 0) - Number(after.width || 0)) > 0.25
    || Math.abs(Number(before.height || 0) - Number(after.height || 0)) > 0.25
    || JSON.stringify(before.curveSlices) !== JSON.stringify(after.curveSlices);
}

function overlayPegs(beforeLevel, afterLevel, pegRadius) {
  const before = new Map((beforeLevel?.pegs || []).map((peg, index) => [pegKey(peg, index), peg]));
  const after = new Map((afterLevel?.pegs || []).map((peg, index) => [pegKey(peg, index), peg]));
  const unchanged = [], changedBefore = [], changedAfter = [], arrows = [], deleted = [], added = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const left = before.get(key), right = after.get(key);
    if (left && right && !pegChanged(left, right)) {
      unchanged.push(pegSvg(right, pegRadius, { fill: '#c7d0dd', stroke: '#637083', opacity: 0.48, strokeWidth: 0.8 }));
    } else if (left && right) {
      const distance = Math.hypot(Number(right.x) - Number(left.x), Number(right.y) - Number(left.y));
      if (distance > 1) arrows.push(`<line x1="${left.x}" y1="${left.y}" x2="${right.x}" y2="${right.y}" stroke="#6d3fc0" stroke-width="1.2" opacity="0.8" marker-end="url(#move-arrow)"/>`);
      changedBefore.push(pegSvg(left, pegRadius, { fill: '#ffddd8', stroke: '#d83b2d', opacity: 0.62, strokeWidth: 1.5, dash: '4 2' }));
      changedAfter.push(pegSvg(right, pegRadius, { fill: '#8bd0ff', stroke: '#08689f', opacity: 0.78, strokeWidth: 1.5 }));
    } else if (left) {
      deleted.push(pegSvg(left, pegRadius, { fill: '#f46d63', stroke: '#a91d17', opacity: 0.72, strokeWidth: 1.6, dash: '4 2' }));
    } else if (right) {
      added.push(pegSvg(right, pegRadius, { fill: '#79db9a', stroke: '#18723c', opacity: 0.86, strokeWidth: 1.6 }));
    }
  }
  return [...unchanged, ...arrows, ...changedBefore, ...changedAfter, ...deleted, ...added].join('');
}

export function renderNativeLevelSvg(level, options = {}) {
  const width = Number(options.width || 400);
  const height = Number(options.height || (level?.survival?.enabled ? level.survival.worldHeight : 600));
  const pegRadius = Number(level?.pegRadius || 8.5);
  const title = escapeXml(options.title || level?.name || 'Level');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  ${sceneBackground(width, height)}
  <g>${(level?.pegs || []).map(peg => pegSvg(peg, pegRadius)).join('')}</g>
  ${sceneBorder(width, height)}
  <title>${title}</title>
</svg>`;
}

export function renderRepairComparisonSvg(beforeLevel, afterLevel, options = {}) {
  const panelWidth = Number(options.width || 400);
  const panelHeight = Number(options.height || Math.max(
    beforeLevel?.survival?.worldHeight || 600,
    afterLevel?.survival?.worldHeight || 600
  ));
  const headerHeight = 38;
  const width = panelWidth * 3;
  const height = panelHeight + headerHeight;
  const title = escapeXml(options.title || afterLevel?.name || beforeLevel?.name || 'Repair comparison');
  const beforeRadius = Number(beforeLevel?.pegRadius || 8.5);
  const afterRadius = Number(afterLevel?.pegRadius || 8.5);
  const panels = [
    `<g transform="translate(0 ${headerHeight})">${sceneBackground(panelWidth, panelHeight)}<g>${(beforeLevel?.pegs || []).map(peg => pegSvg(peg, beforeRadius)).join('')}</g>${sceneBorder(panelWidth, panelHeight)}</g>`,
    `<g transform="translate(${panelWidth} ${headerHeight})">${sceneBackground(panelWidth, panelHeight)}<g>${(afterLevel?.pegs || []).map(peg => pegSvg(peg, afterRadius)).join('')}</g>${sceneBorder(panelWidth, panelHeight)}</g>`,
    `<g transform="translate(${panelWidth * 2} ${headerHeight})">${sceneBackground(panelWidth, panelHeight)}<g>${overlayPegs(beforeLevel, afterLevel, Math.max(beforeRadius, afterRadius))}</g>${sceneBorder(panelWidth, panelHeight)}</g>`
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <defs><marker id="move-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#6d3fc0"/></marker></defs>
  <rect width="${width}" height="${height}" fill="#101725"/>
  <g fill="#f4f7fb" font-family="Arial, sans-serif" font-size="15" font-weight="700" text-anchor="middle">
    <text x="${panelWidth / 2}" y="24">BEFORE</text><text x="${panelWidth * 1.5}" y="24">AFTER</text><text x="${panelWidth * 2.5}" y="24">OVERLAY · red before · blue after · green added</text>
  </g>
  ${panels}
  <title>${title}</title>
</svg>`;
}
