import { launchAxisX } from './coordinate-space.mjs';

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function colorFor(object) {
  if (object.kind === 'portal') return '#8b5cf6';
  if (object.kind === 'bumper') return '#f97316';
  if (object.role === 'obstacle' || object.role === 'permanent') return '#64748b';
  if (String(object.targetType || '').toLowerCase().includes('orange')) return '#f59e0b';
  if (object.role === 'target') return '#38bdf8';
  if (object.role === 'trigger') return '#a78bfa';
  return '#475569';
}

function curveSlicesFor(object) {
  const geometry = object.geometry || {};
  if (Array.isArray(geometry.curveSlices) && geometry.curveSlices.length >= 2) {
    return geometry.curveSlices;
  }
  if (geometry.shape !== 'annular-sector' && geometry.curved !== true) return [];
  const transform = object.transform || {};
  const x = finite(transform.x);
  const y = finite(transform.y);
  const middleAngle = finite(transform.rotation);
  const innerRadius = finite(geometry.innerRadius);
  const outerRadius = finite(geometry.outerRadius, innerRadius + finite(geometry.height, 12));
  const centerRadius = finite(geometry.centerRadius, (innerRadius + outerRadius) / 2);
  const sectorAngle = finite(geometry.sectorAngleDegrees) * Math.PI / 180;
  const count = Math.max(2, Math.min(257, Math.round(finite(geometry.curvePoints, 4))));
  const originX = x - Math.cos(middleAngle) * centerRadius;
  const originY = y - Math.sin(middleAngle) * centerRadius;
  return Array.from({ length: count }, (_value, index) => {
    const angle = middleAngle - sectorAngle / 2 + sectorAngle * index / (count - 1);
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    return { x: originX + nx * centerRadius, y: originY + ny * centerRadius, nx, ny };
  });
}

function curvedBrickPath(object) {
  const slices = curveSlicesFor(object);
  if (slices.length < 2) return '';
  const halfHeight = Math.max(1.5, finite(object.geometry?.height, 12) / 2);
  const top = slices.map(slice => (
    `${finite(slice.x) + finite(slice.nx) * halfHeight},${finite(slice.y) + finite(slice.ny) * halfHeight}`
  ));
  const bottom = [...slices].reverse().map(slice => (
    `${finite(slice.x) - finite(slice.nx) * halfHeight},${finite(slice.y) - finite(slice.ny) * halfHeight}`
  ));
  return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`;
}

function renderObject(object) {
  const transform = object.transform || {};
  const geometry = object.geometry || {};
  const x = finite(transform.x);
  const y = finite(transform.y);
  const rotationDegrees = finite(transform.rotation) * 180 / Math.PI;
  const color = colorFor(object);
  // Peggle's Visible flag governs non-peg artwork/collision entries. PegInfo
  // targets are still drawn by the original editor/game even when that flag is
  // false, so fading them would invent a visual distinction that is not there.
  const hiddenStyle = object.properties?.visible === false && object.role !== 'target'
    ? ' opacity="0.38" stroke-dasharray="3 2"'
    : '';
  const attrs = `data-id="${escapeXml(object.id)}" fill="${color}" stroke="#0f172a" stroke-width="1.5"${hiddenStyle}`;
  if (['circle', 'bumper', 'portal', 'hole'].includes(object.kind)) {
    if (object.kind === 'portal' && geometry.shape === 'rectangle') {
      const width = Math.max(3, finite(geometry.width, 34));
      const height = Math.max(3, finite(geometry.height, 12));
      return `<rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="${Math.min(5, height / 2)}" transform="rotate(${rotationDegrees} ${x} ${y})" ${attrs} />`;
    }
    const radius = Math.max(3, finite(geometry.radius, object.kind === 'portal' ? 16 : 10));
    return `<circle cx="${x}" cy="${y}" r="${radius}" ${attrs} />`;
  }
  if (object.kind === 'brick') {
    const curvePath = curvedBrickPath(object);
    if (curvePath) {
      return `<path d="${curvePath}" data-shape="annular-sector" ${attrs} />`;
    }
    const width = Math.max(3, finite(geometry.width, 34));
    const height = Math.max(3, finite(geometry.height, 12));
    return `<rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="${Math.min(5, height / 2)}" transform="rotate(${rotationDegrees} ${x} ${y})" data-shape="rotated-rectangle" ${attrs} />`;
  }
  if (object.kind === 'segment' || object.kind === 'rod') {
    return `<line x1="${finite(geometry.x1, x)}" y1="${finite(geometry.y1, y)}" x2="${finite(geometry.x2, x)}" y2="${finite(geometry.y2, y)}" stroke="${color}" stroke-width="${Math.max(3, finite(geometry.thickness, 10))}" stroke-linecap="round" data-id="${escapeXml(object.id)}"${hiddenStyle} />`;
  }
  if (object.kind === 'polygon' && Array.isArray(geometry.points) && geometry.points.length) {
    const points = geometry.points.map(point => `${finite(point.x)},${finite(point.y)}`).join(' ');
    const localTransform = geometry.coordinateSpace === 'local'
      ? ` transform="translate(${x} ${y}) rotate(${rotationDegrees})"`
      : '';
    return `<polygon points="${points}"${localTransform} ${attrs} fill-opacity="0.65" />`;
  }
  return '';
}

export function renderLevelSvg(levelRecord, options = {}) {
  const bounds = levelRecord.authored.coordinateSystem.bounds;
  const width = finite(bounds.maxX) - finite(bounds.minX);
  const height = finite(bounds.maxY) - finite(bounds.minY);
  const titleHeight = options.showTitle === false ? 0 : 34;
  const launchX = launchAxisX(levelRecord);
  const launchMarkerY = bounds.minY + (titleHeight ? titleHeight + 6 : 12);
  const objects = levelRecord.authored.objects.map(renderObject).join('\n    ');
  const titleText = options.title ?? levelRecord.authored.name;
  const title = options.showTitle === false ? '' : `
    <rect x="${bounds.minX}" y="${bounds.minY}" width="${width}" height="${titleHeight}" fill="#020617" fill-opacity="0.86" />
    <text x="${bounds.minX + 12}" y="${bounds.minY + 23}" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="16">${escapeXml(titleText)}</text>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${width} ${height}" width="${width}" height="${height}">
  <rect x="${bounds.minX}" y="${bounds.minY}" width="${width}" height="${height}" fill="#e2e8f0" />
  <g opacity="0.22" stroke="#64748b" stroke-width="1">
    ${Array.from({ length: 9 }, (_value, index) => `<line x1="${bounds.minX}" y1="${bounds.minY + (height * index / 8)}" x2="${bounds.maxX}" y2="${bounds.minY + (height * index / 8)}" />`).join('\n    ')}
    ${Array.from({ length: 11 }, (_value, index) => `<line x1="${bounds.minX + (width * index / 10)}" y1="${bounds.minY}" x2="${bounds.minX + (width * index / 10)}" y2="${bounds.maxY}" />`).join('\n    ')}
  </g>
  <g>${objects}</g>
  <path data-role="launch-axis" d="M ${launchX} ${launchMarkerY - 11} L ${launchX - 10} ${launchMarkerY + 7} L ${launchX + 10} ${launchMarkerY + 7} Z" fill="#ef4444" stroke="#7f1d1d" stroke-width="2" />${title}
</svg>
`;
}
