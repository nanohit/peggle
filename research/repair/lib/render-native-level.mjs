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

function pegSvg(peg, pegRadius) {
  const fill = escapeXml(pegColor(peg));
  const stroke = peg.type === 'orange' ? '#8a3510' : '#233148';
  if (peg.shape === 'brick') {
    const width = Number(peg.width || pegRadius * 4);
    const height = Number(peg.height || pegRadius * 1.2);
    const degrees = Number(peg.angle || 0) * 180 / Math.PI;
    return `<rect x="${peg.x - width / 2}" y="${peg.y - height / 2}" width="${width}" height="${height}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1.2" transform="rotate(${degrees} ${peg.x} ${peg.y})"/>`;
  }
  return `<circle cx="${peg.x}" cy="${peg.y}" r="${pegRadius}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
}

export function renderNativeLevelSvg(level, options = {}) {
  const width = Number(options.width || 400);
  const height = Number(options.height || level?.survival?.worldHeight || 600);
  const pegRadius = Number(level?.pegRadius || 8.5);
  const title = escapeXml(options.title || level?.name || 'Level');
  const grid = Array.from({ length: Math.floor(width / 50) + 1 }, (_value, index) => (
    `<line x1="${index * 50}" y1="0" x2="${index * 50}" y2="${height}"/>`
  )).concat(Array.from({ length: Math.floor(height / 50) + 1 }, (_value, index) => (
    `<line x1="0" y1="${index * 50}" x2="${width}" y2="${index * 50}"/>`
  ))).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <rect width="${width}" height="${height}" fill="#f1f4f9"/>
  <g stroke="#dce2ec" stroke-width="0.6">${grid}</g>
  <path d="M ${width / 2 - 8} 38 L ${width / 2} 22 L ${width / 2 + 8} 38 Z" fill="#dc3f49" stroke="#7f1e27"/>
  <g>${(level?.pegs || []).map(peg => pegSvg(peg, pegRadius)).join('')}</g>
  <rect x="0.75" y="0.75" width="${width - 1.5}" height="${height - 1.5}" fill="none" stroke="#273248" stroke-width="1.5"/>
  <title>${title}</title>
</svg>`;
}
