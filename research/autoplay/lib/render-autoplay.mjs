// Two panels per level: where shots can reach, and where orange should go.

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

function escapeText(value) {
  return String(value).replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]));
}

/** Cool for a peg only one aim reaches, warm for a peg many aims reach. */
function heatColor(fraction) {
  const stops = [
    [0.0, [37, 99, 235]],
    [0.35, [13, 148, 136]],
    [0.65, [202, 138, 4]],
    [1.0, [220, 38, 38]]
  ];
  const value = Math.max(0, Math.min(1, fraction));
  for (let index = 1; index < stops.length; index++) {
    if (value <= stops[index][0]) {
      const [lowStop, low] = stops[index - 1];
      const [highStop, high] = stops[index];
      const t = (value - lowStop) / (highStop - lowStop || 1);
      const channel = position => Math.round(low[position] + (high[position] - low[position]) * t);
      return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
    }
  }
  return 'rgb(220,38,38)';
}

function drawPeg(point, fill, radius = 5.5, stroke = null) {
  const outline = stroke ? ` stroke="${stroke}" stroke-width="2"` : '';
  if (point.kind === 'brick') {
    const degrees = round(finite(point.rotation) * 180 / Math.PI);
    return `<rect x="-11" y="-4" width="22" height="8" rx="2" fill="${fill}"${outline} `
      + `transform="translate(${round(point.x)} ${round(point.y)}) rotate(${degrees})" />`;
  }
  return `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${radius}" fill="${fill}"${outline} />`;
}

const HEADER_HEIGHT = 42;

/** Two-line header so a long subtitle cannot run past a narrow portrait panel. */
function panel(title, subtitleLines, frame, body, offsetX) {
  const lines = (Array.isArray(subtitleLines) ? subtitleLines : [subtitleLines])
    .filter(Boolean)
    .map((line, index) => (
      `<text x="8" y="${34 + index * 12}" font-family="monospace" font-size="10" fill="#94a3b8">${escapeText(line)}</text>`
    ))
    .join('\n  ');
  const height = HEADER_HEIGHT + (Array.isArray(subtitleLines) && subtitleLines.length > 1 ? 12 : 0);
  return `<g transform="translate(${offsetX} 0)">
  <rect x="0" y="0" width="${frame.width}" height="${frame.height}" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" />
  <rect x="0" y="0" width="${frame.width}" height="${height}" fill="#1e293b" />
  <text x="8" y="17" font-family="monospace" font-size="13" fill="#f8fafc">${escapeText(title)}</text>
  ${lines}
  ${body}
</g>`;
}

export function renderAutoplaySvg(record, result) {
  const bounds = record.authored.coordinateSystem.bounds;
  const frame = {
    width: Math.max(200, finite(bounds.maxX, 646)),
    height: Math.max(200, finite(record.authored.coordinateSystem.viewport?.height, finite(bounds.maxY, 543)))
  };
  const gap = 24;
  const launcher = record.authored.mechanics?.launcher
    || { x: finite(record.authored.mechanics?.launchAxis?.x, frame.width / 2), y: 40 };

  const points = new Map();
  for (const object of record.authored.objects) {
    if (object.role !== 'target') continue;
    points.set(String(object.id), {
      x: finite(object.transform?.x),
      y: finite(object.transform?.y),
      rotation: finite(object.transform?.rotation),
      kind: object.kind
    });
  }

  const accessById = new Map(result.reachability.access.map(entry => [entry.id, entry]));
  const widest = Math.max(1, ...result.reachability.access.map(entry => entry.accessWidth));

  // Aim fan: every sampled angle, brightness by how much it hits.
  const maxAngleHits = Math.max(1, ...result.reachability.perAngle.map(entry => entry.meanHits));
  const fan = result.reachability.perAngle.map(entry => {
    const length = 46 + 150 * (entry.meanHits / maxAngleHits);
    const x = launcher.x + Math.cos(entry.angle) * length;
    const y = launcher.y + Math.sin(entry.angle) * length;
    const dead = entry.meanHits === 0;
    return `<line x1="${round(launcher.x)}" y1="${round(launcher.y)}" x2="${round(x)}" y2="${round(y)}" `
      + `stroke="${dead ? '#dc2626' : '#0f766e'}" stroke-width="1" opacity="${dead ? 0.5 : 0.28}" />`;
  }).join('\n  ');

  const reachBody = [
    fan,
    ...[...points.entries()].map(([id, point]) => {
      const entry = accessById.get(id);
      if (!entry || !entry.reachable) return drawPeg(point, '#e2e8f0', 5.5, '#dc2626');
      return drawPeg(point, heatColor(entry.accessWidth / widest));
    })
  ].join('\n  ');

  const orangeIds = new Set(result.orangePlan?.orangeIds || []);
  const planBody = [...points.entries()].map(([id, point]) => {
    const entry = accessById.get(id);
    if (orangeIds.has(id)) return drawPeg(point, '#f97316', 6.5, '#7c2d12');
    if (!entry || !entry.reachable) return drawPeg(point, '#e2e8f0', 5.5, '#dc2626');
    return drawPeg(point, '#60a5fa', 5);
  }).join('\n  ');

  const metrics = result.reachability.metrics;
  const unreachable = metrics.targetCount - metrics.reachableCount;
  const reachSubtitle = [
    `reach ${Math.round(metrics.reachableFraction * 100)}% (${unreachable} closed on shot 1) | dead aims ${Math.round(metrics.deadAngleRate * 100)}%`,
    `stability ${metrics.seedStability} | aim sensitivity ${metrics.aimSensitivity} | pockets ${metrics.pocketCount}`
  ];
  const quality = result.orangePlan?.quality;
  const play = run => (run ? (run.complete ? `${run.ballsUsed} balls` : `${Math.round(run.collectedFraction * 100)}% in ${run.ballsUsed}`) : '-');
  const planSubtitle = quality
    ? [
      `${orangeIds.size} orange | max per shot ${quality.maxShotYield} vs random ${quality.baseline.meanMaxShotYield}`,
      `played ${play(result.validation?.planned)} vs random ${play(result.validation?.random)}`
    ]
    : ['no plan'];

  const totalWidth = frame.width * 2 + gap;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${frame.height}" width="${totalWidth}" height="${frame.height}">
${panel(`${result.name} - reachability`, reachSubtitle, frame, reachBody, 0)}
${panel(`${result.name} - planned orange`, planSubtitle, frame, planBody, frame.width + gap)}
</svg>
`;
}
