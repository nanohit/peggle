import { cloneResearchValue, digestResearchLevel } from '../../../js/research-format.js';
import { analyzeLevelMotifs } from './motifs.mjs';
import { createRandom } from './random.mjs';

const TOOL_VERSION = '0.3.0';

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'variant';
}

export function objectMutationCapability(object) {
  if (object?.role !== 'target') return { eligible: false, reason: 'not-target' };
  if (object.movement || object.animation) return { eligible: false, reason: 'moving-object' };
  if (!Number.isFinite(Number(object.transform?.x)) || !Number.isFinite(Number(object.transform?.y))) {
    return { eligible: false, reason: 'non-finite-transform' };
  }
  if (object.kind === 'circle') return { eligible: true, reason: 'static-circle' };
  if (object.kind === 'brick'
      && object.geometry?.shape !== 'annular-sector'
      && object.geometry?.curved !== true
      && !(Array.isArray(object.geometry?.curveSlices) && object.geometry.curveSlices.length)) {
    return { eligible: true, reason: 'static-straight-brick' };
  }
  return { eligible: false, reason: `unsupported-${object.kind || 'unknown'}-geometry` };
}

export function levelMutationCapability(level) {
  const targets = (level?.authored?.objects || []).filter(object => object.role === 'target');
  const reasons = {};
  let eligibleTargets = 0;
  for (const object of targets) {
    const capability = objectMutationCapability(object);
    if (capability.eligible) eligibleTargets++;
    else reasons[capability.reason] = (reasons[capability.reason] || 0) + 1;
  }
  return {
    eligible: targets.length > 0 && eligibleTargets === targets.length,
    targetCount: targets.length,
    eligibleTargetCount: eligibleTargets,
    excludedTargetCount: targets.length - eligibleTargets,
    reasons
  };
}

function mutableTargets(level) {
  const capability = levelMutationCapability(level);
  if (!capability.eligible) {
    const detail = Object.entries(capability.reasons).map(([reason, count]) => `${reason}:${count}`).join(', ');
    throw new Error(`Level is not safe for object-wise mutation (${detail || 'no targets'}).`);
  }
  return level.authored.objects.filter(object => objectMutationCapability(object).eligible);
}

function translateGeometry(geometry, deltaX, deltaY) {
  if (!geometry || typeof geometry !== 'object') return;
  for (const key of ['x1', 'x2']) {
    if (Number.isFinite(Number(geometry[key]))) geometry[key] = Number(geometry[key]) + deltaX;
  }
  for (const key of ['y1', 'y2']) {
    if (Number.isFinite(Number(geometry[key]))) geometry[key] = Number(geometry[key]) + deltaY;
  }
  if (Array.isArray(geometry.points)) {
    geometry.points = geometry.points.map(point => ({
      ...point,
      x: finite(point.x) + deltaX,
      y: finite(point.y) + deltaY
    }));
  }
  if (Array.isArray(geometry.curveSlices)) {
    geometry.curveSlices = geometry.curveSlices.map(slice => ({
      ...slice,
      x: finite(slice.x) + deltaX,
      y: finite(slice.y) + deltaY
    }));
  }
}

function objectMargin(object) {
  const radius = finite(object.geometry?.radius, 0);
  const halfWidth = finite(object.geometry?.width, 0) / 2;
  const halfHeight = finite(object.geometry?.height, 0) / 2;
  return Math.max(4, radius, Math.hypot(halfWidth, halfHeight));
}

function moveObject(object, nextX, nextY, bounds) {
  const previousX = finite(object.transform.x);
  const previousY = finite(object.transform.y);
  const margin = objectMargin(object);
  const x = clamp(nextX, bounds.minX + margin, bounds.maxX - margin);
  const y = clamp(nextY, bounds.minY + margin, bounds.maxY - margin);
  object.transform.x = x;
  object.transform.y = y;
  translateGeometry(object.geometry, x - previousX, y - previousY);
}

function selectedMotif(level, random) {
  const analysis = analyzeLevelMotifs(level);
  const candidates = analysis.motifs.filter(motif => motif.size >= 4 && motif.confidence >= 0.38);
  if (!candidates.length) throw new Error(`No mutation-safe motif was detected in ${level.id}.`);
  const ranked = [...candidates].sort((left, right) => (
    (right.confidence * Math.sqrt(right.size)) - (left.confidence * Math.sqrt(left.size))
    || left.id.localeCompare(right.id)
  ));
  const pool = ranked.slice(0, Math.min(5, ranked.length));
  return pool[random.integer(0, pool.length)];
}

function fitGroupToBounds(objects, positions, bounds) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  objects.forEach((object, index) => {
    const margin = objectMargin(object);
    minX = Math.min(minX, positions[index].x - margin);
    maxX = Math.max(maxX, positions[index].x + margin);
    minY = Math.min(minY, positions[index].y - margin);
    maxY = Math.max(maxY, positions[index].y + margin);
  });
  let shiftX = 0;
  let shiftY = 0;
  if (minX < bounds.minX) shiftX += bounds.minX - minX;
  if (maxX + shiftX > bounds.maxX) shiftX += bounds.maxX - (maxX + shiftX);
  if (minY < bounds.minY) shiftY += bounds.minY - minY;
  if (maxY + shiftY > bounds.maxY) shiftY += bounds.maxY - (maxY + shiftY);
  return positions.map(position => ({ x: position.x + shiftX, y: position.y + shiftY }));
}

function transformMotif(level, motif, mapper, rotationDelta = 0) {
  const bounds = level.authored.coordinateSystem.bounds;
  const ids = new Set(motif.objectIds);
  const objects = mutableTargets(level).filter(object => ids.has(String(object.id)));
  if (objects.length < 3) throw new Error(`Motif ${motif.id} no longer resolves to enough objects.`);
  const source = objects.map(object => ({ x: finite(object.transform.x), y: finite(object.transform.y) }));
  let positions = source.map((point, index) => mapper(point, index, source, objects[index]));
  positions = fitGroupToBounds(objects, positions, bounds);
  objects.forEach((object, index) => {
    const previousX = finite(object.transform.x);
    const previousY = finite(object.transform.y);
    object.transform.x = positions[index].x;
    object.transform.y = positions[index].y;
    if (object.kind === 'brick' && rotationDelta) object.transform.rotation = finite(object.transform.rotation) + rotationDelta;
    translateGeometry(object.geometry, positions[index].x - previousX, positions[index].y - previousY);
  });
  return {
    changedObjectCount: objects.length,
    details: {
      motifId: motif.id,
      motifType: motif.type,
      motifSize: motif.size,
      motifConfidence: motif.confidence,
      objectIds: motif.objectIds
    }
  };
}

function scaleMotif(level, random, factor) {
  const motif = selectedMotif(level, random);
  return transformMotif(level, motif, point => ({
    x: motif.centroid.x + (point.x - motif.centroid.x) * factor,
    y: motif.centroid.y + (point.y - motif.centroid.y) * factor
  }));
}

function regularizeMotif(level, random) {
  const motif = selectedMotif(level, random);
  const ids = new Set(motif.objectIds);
  const objects = mutableTargets(level).filter(object => ids.has(String(object.id)));
  const source = objects.map(object => ({ x: finite(object.transform.x), y: finite(object.transform.y), id: String(object.id) }));
  const targets = new Map();
  if (motif.type === 'arc' && motif.center && source.length >= 4) {
    const ordered = source.map(point => {
      let angle = Math.atan2(point.y - motif.center.y, point.x - motif.center.x);
      while (angle < motif.startAngle) angle += Math.PI * 2;
      return { ...point, angle };
    }).sort((left, right) => left.angle - right.angle);
    ordered.forEach((point, index) => {
      const fraction = ordered.length === 1 ? 0 : index / (ordered.length - 1);
      const angle = motif.startAngle + (motif.endAngle - motif.startAngle) * fraction;
      targets.set(point.id, {
        x: motif.center.x + Math.cos(angle) * motif.radius,
        y: motif.center.y + Math.sin(angle) * motif.radius
      });
    });
  } else {
    const angle = motif.principalAngle;
    const axisX = Math.cos(angle);
    const axisY = Math.sin(angle);
    const normalX = -axisY;
    const normalY = axisX;
    const ordered = source.map(point => ({
      ...point,
      projection: (point.x - motif.centroid.x) * axisX + (point.y - motif.centroid.y) * axisY,
      perpendicular: (point.x - motif.centroid.x) * normalX + (point.y - motif.centroid.y) * normalY
    })).sort((left, right) => left.projection - right.projection);
    const minProjection = ordered[0].projection;
    const maxProjection = ordered[ordered.length - 1].projection;
    ordered.forEach((point, index) => {
      const fraction = ordered.length === 1 ? 0 : index / (ordered.length - 1);
      const projection = minProjection + (maxProjection - minProjection) * fraction;
      const perpendicular = motif.type === 'line' ? point.perpendicular * 0.18 : point.perpendicular;
      targets.set(point.id, {
        x: motif.centroid.x + axisX * projection + normalX * perpendicular,
        y: motif.centroid.y + axisY * projection + normalY * perpendicular
      });
    });
  }
  return transformMotif(level, motif, (_point, index) => targets.get(source[index].id));
}

function mapTargets(level, mapper) {
  const bounds = level.authored.coordinateSystem.bounds;
  const targets = mutableTargets(level);
  const source = targets.map(object => ({ x: finite(object.transform.x), y: finite(object.transform.y) }));
  targets.forEach((object, index) => {
    const next = mapper(source[index], index, source, bounds);
    moveObject(object, finite(next?.x, source[index].x), finite(next?.y, source[index].y), bounds);
  });
  return targets.length;
}

const operators = {
  'jitter-subtle'(level, random) {
    return mapTargets(level, (point, _index, _all, bounds) => ({
      x: point.x + random.normal(0, (bounds.maxX - bounds.minX) * 0.012),
      y: point.y + random.normal(0, (bounds.maxY - bounds.minY) * 0.012)
    }));
  },
  'spacing-compress'(level) {
    return mapTargets(level, (point, _index, _all, bounds) => {
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      return { x: centerX + (point.x - centerX) * 0.86, y: centerY + (point.y - centerY) * 0.90 };
    });
  },
  'fine-grid'(level) {
    return mapTargets(level, (point, _index, _all, bounds) => {
      const stepX = (bounds.maxX - bounds.minX) / 40;
      const stepY = (bounds.maxY - bounds.minY) / 30;
      return {
        x: bounds.minX + Math.round((point.x - bounds.minX) / stepX) * stepX,
        y: bounds.minY + Math.round((point.y - bounds.minY) / stepY) * stepY
      };
    });
  },
  'band-drift'(level, random) {
    const offsets = new Map();
    return mapTargets(level, (point, _index, _all, bounds) => {
      const bandHeight = (bounds.maxY - bounds.minY) / 6;
      const band = Math.max(0, Math.min(5, Math.floor((point.y - bounds.minY) / bandHeight)));
      if (!offsets.has(band)) {
        offsets.set(band, {
          x: random.normal(0, (bounds.maxX - bounds.minX) * 0.022),
          y: random.normal(0, (bounds.maxY - bounds.minY) * 0.008)
        });
      }
      const offset = offsets.get(band);
      return { x: point.x + offset.x, y: point.y + offset.y };
    });
  },
  'lateral-bias'(level) {
    return mapTargets(level, (point, _index, _all, bounds) => ({
      x: point.x + ((point.y - bounds.minY) / (bounds.maxY - bounds.minY) - 0.5) * (bounds.maxX - bounds.minX) * 0.055,
      y: point.y
    }));
  }
};

const motifOperators = {
  'motif-spacing-tighten'(level, random) {
    return scaleMotif(level, random, 0.91);
  },
  'motif-spacing-expand'(level, random) {
    return scaleMotif(level, random, 1.09);
  },
  'motif-rotate'(level, random) {
    const motif = selectedMotif(level, random);
    const magnitude = random.range(3, 7) * Math.PI / 180;
    const delta = random.random() < 0.5 ? -magnitude : magnitude;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    return transformMotif(level, motif, point => {
      const dx = point.x - motif.centroid.x;
      const dy = point.y - motif.centroid.y;
      return {
        x: motif.centroid.x + dx * cos - dy * sin,
        y: motif.centroid.y + dx * sin + dy * cos
      };
    }, delta);
  },
  'motif-shift'(level, random) {
    const motif = selectedMotif(level, random);
    const bounds = level.authored.coordinateSystem.bounds;
    const deltaX = random.normal(0, (bounds.maxX - bounds.minX) * 0.032);
    const deltaY = random.normal(0, (bounds.maxY - bounds.minY) * 0.024);
    return transformMotif(level, motif, point => ({ x: point.x + deltaX, y: point.y + deltaY }));
  },
  'motif-rhythm-regularize'(level, random) {
    return regularizeMotif(level, random);
  }
};

export const MUTATION_OPERATORS = Object.freeze(Object.keys(operators));
export const MOTIF_MUTATION_OPERATORS = Object.freeze(Object.keys(motifOperators));
export const ALL_MUTATION_OPERATORS = Object.freeze([...MUTATION_OPERATORS, ...MOTIF_MUTATION_OPERATORS]);

export async function mutateLevel(levelRecord, operatorName, options = {}) {
  const operator = operators[operatorName] || motifOperators[operatorName];
  if (!operator) throw new Error(`Unknown mutation operator: ${operatorName}`);
  const parentSha256 = await digestResearchLevel(levelRecord);
  const seed = String(options.seed ?? `${levelRecord.id}:${operatorName}`);
  const capability = levelMutationCapability(levelRecord);
  if (!capability.eligible) {
    throw new Error(`Mutation ${operatorName} rejected for ${levelRecord.id}: ${JSON.stringify(capability.reasons)}`);
  }
  const level = cloneResearchValue(levelRecord);
  const mutationResult = operator(level, createRandom(seed));
  const changedObjectCount = typeof mutationResult === 'number'
    ? mutationResult
    : mutationResult?.changedObjectCount;
  const mutationDetails = typeof mutationResult === 'object' ? mutationResult.details || null : null;
  if (!changedObjectCount) throw new Error(`Mutation ${operatorName} found no target objects in ${levelRecord.id}`);
  level.id = `${levelRecord.id}:mutation:${slug(operatorName)}:${slug(seed).slice(0, 24)}`;
  level.provenance = {
    source: {
      system: 'synthetic-layout-perturbation',
      parentLevelId: levelRecord.id,
      parentSha256,
      operator: operatorName,
      seed
    },
    ingestion: {
      tool: 'benchmark-mutations.mjs',
      toolVersion: TOOL_VERSION,
      toolRevision: String(options.toolRevision || 'working-tree'),
      at: options.at || new Date().toISOString()
    },
    parents: [{ id: levelRecord.id, sha256: parentSha256 }]
  };
  level.authored.name = `${levelRecord.authored.name} [${operatorName}]`;
  level.authored.tags = [...new Set([
    ...(levelRecord.authored.tags || []),
    'synthetic-perturbation',
    'candidate-negative',
    `mutation:${operatorName}`
  ])];
  level.authored.metadata = {
    ...(levelRecord.authored.metadata || {}),
    benchmarkMutation: {
      operator: operatorName,
      seed,
      changedObjectCount,
      details: mutationDetails,
      family: MOTIF_MUTATION_OPERATORS.includes(operatorName) ? 'motif-aware' : 'global-layout',
      expectedDirection: 'counterfactual-unknown',
      labelStatus: 'synthetic-hypothesis-not-human-validated'
    }
  };
  level.visual = {
    presentation: {
      source: 'benchmark-semantic-render',
      parentVisualRetained: false
    }
  };
  level.extensions = {
    ...(levelRecord.extensions || {}),
    benchmarkMutation: {
      operator: operatorName,
      seed,
      changedObjectCount,
      details: mutationDetails,
      authoritativeFields: ['authored.objects[].transform', 'authored.objects[].geometry'],
      note: 'Source raw fields remain provenance only and were not rewritten.'
    }
  };
  level.warnings = [
    ...(levelRecord.warnings || []),
    'Synthetic negative hypothesis; do not treat as a human quality label until reviewed.'
  ];
  level.losses = [
    ...(levelRecord.losses || []),
    'Parent visual assets were intentionally detached because geometry changed.'
  ];
  return level;
}
