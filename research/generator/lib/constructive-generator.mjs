import { cloneResearchValue } from '../../../js/research-format.js';
import { createRandom } from '../../benchmark/lib/random.mjs';
import { sha256Value } from '../../tools/lib/node-io.mjs';
import { objectsOverlap } from './collision.mjs';

const TOOL_VERSION = '0.1.0';
const VIEWPORT = Object.freeze({ width: 400, height: 600 });
const PEG_RADIUS = 8.5;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function objectRadius(object) {
  if (object.kind === 'circle') return PEG_RADIUS;
  return Math.max(PEG_RADIUS, Math.hypot(finite(object.geometry?.width, 34), finite(object.geometry?.height, 10.2)) / 2);
}

function sampleCurve(samples, normalizedY, key) {
  const scaled = clamp(normalizedY, 0, 1) * (samples.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(samples.length - 1, left + 1);
  const fraction = scaled - left;
  return finite(samples[left]?.[key]) * (1 - fraction) + finite(samples[right]?.[key]) * fraction;
}

function sampleDensityY(samples, random) {
  const total = samples.reduce((sum, sample) => sum + Math.max(0, finite(sample.density)), 0) || 1;
  let cursor = random.range(0, total);
  for (let index = 0; index < samples.length; index++) {
    cursor -= Math.max(0, finite(samples[index].density));
    if (cursor <= 0) {
      const halfStep = 0.5 / Math.max(1, samples.length - 1);
      return clamp(finite(samples[index].y) + random.range(-halfStep, halfStep), 0, 1);
    }
  }
  return 0.5;
}

function transformGeometry(geometry, scale, mirrored, rotation, center) {
  const result = cloneResearchValue(geometry || {});
  if (Number.isFinite(Number(result.radius))) result.radius = PEG_RADIUS;
  if (Number.isFinite(Number(result.width))) result.width = clamp(Number(result.width) * scale, 8, 96);
  if (Number.isFinite(Number(result.height))) result.height = clamp(Number(result.height) * scale, 7, 24);
  const transformPoint = point => {
    const localX = finite(point.x) * (mirrored ? -1 : 1) * scale;
    const localY = finite(point.y) * scale;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      ...point,
      x: center.x + localX * cos - localY * sin,
      y: center.y + localX * sin + localY * cos
    };
  };
  for (const key of ['points', 'curveSlices']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(transformPoint);
  }
  if (['x1', 'x2'].every(key => Number.isFinite(Number(result[key])))
      && ['y1', 'y2'].every(key => Number.isFinite(Number(result[key])))) {
    const first = transformPoint({ x: result.x1, y: result.y1 });
    const second = transformPoint({ x: result.x2, y: result.y2 });
    result.x1 = first.x;
    result.y1 = first.y;
    result.x2 = second.x;
    result.y2 = second.y;
  }
  return result;
}

function instantiateTemplate(template, placement, placementIndex) {
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  return template.objects.map((source, objectIndex) => {
    const localX = finite(source.transform.x) * (placement.mirrored ? -1 : 1) * placement.scale;
    const localY = finite(source.transform.y) * placement.scale;
    const x = placement.center.x + localX * cos - localY * sin;
    const y = placement.center.y + localX * sin + localY * cos;
    const sourceRotation = finite(source.transform.rotation);
    const rotation = (placement.mirrored ? Math.PI - sourceRotation : sourceRotation) + placement.rotation;
    return {
      id: `generated-m${String(placementIndex + 1).padStart(2, '0')}-o${String(objectIndex + 1).padStart(3, '0')}`,
      kind: source.kind,
      role: 'target',
      targetType: 'blue',
      transform: { x, y, rotation, scaleX: 1, scaleY: 1 },
      geometry: source.kind === 'circle'
        ? { shape: 'circle', radius: PEG_RADIUS }
        : transformGeometry(source.geometry, placement.scale, placement.mirrored, placement.rotation, placement.center),
      groupIds: [`generated-motif-${String(placementIndex + 1).padStart(2, '0')}`],
      properties: {},
      source: {
        system: 'motif-template-instantiation',
        templateId: template.id,
        sourceObjectId: source.id
      }
    };
  });
}

function placementEnvelope(objects) {
  return objects.reduce((bounds, object) => {
    const radius = objectRadius(object);
    return {
      minX: Math.min(bounds.minX, object.transform.x - radius),
      maxX: Math.max(bounds.maxX, object.transform.x + radius),
      minY: Math.min(bounds.minY, object.transform.y - radius),
      maxY: Math.max(bounds.maxY, object.transform.y + radius)
    };
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

function intersectsExisting(objects, existing, padding = 0.4, trustedGroupId = null) {
  for (const object of objects) {
    for (const other of existing) {
      if (trustedGroupId && (other.groupIds || []).includes(trustedGroupId)) continue;
      if (objectsOverlap(object, other, padding)) return true;
    }
  }
  return false;
}

function chooseTemplate(eligible, usedSources, usedTypes, objects, desiredBrickFraction, random) {
  const currentBricks = objects.filter(object => object.kind === 'brick').length;
  const candidates = random.shuffle(eligible).sort((left, right) => {
    const leftSourceUse = usedSources.get(left.source.levelId) || 0;
    const rightSourceUse = usedSources.get(right.source.levelId) || 0;
    const leftSourcePenalty = leftSourceUse === 0
      ? (usedSources.size < 2 ? -2 : 4)
      : Math.max(0, leftSourceUse - 3) * 1.4;
    const rightSourcePenalty = rightSourceUse === 0
      ? (usedSources.size < 2 ? -2 : 4)
      : Math.max(0, rightSourceUse - 3) * 1.4;
    const leftTypePenalty = usedTypes.get(left.type) || 0;
    const rightTypePenalty = usedTypes.get(right.type) || 0;
    const leftBricks = left.objectKindCounts?.brick || left.objects.filter(object => object.kind === 'brick').length;
    const rightBricks = right.objectKindCounts?.brick || right.objects.filter(object => object.kind === 'brick').length;
    const leftProjected = (currentBricks + leftBricks) / Math.max(1, objects.length + left.size);
    const rightProjected = (currentBricks + rightBricks) / Math.max(1, objects.length + right.size);
    const leftScore = leftSourcePenalty * 1.2 + leftTypePenalty * 0.8 + Math.abs(leftProjected - desiredBrickFraction) * 12;
    const rightScore = rightSourcePenalty * 1.2 + rightTypePenalty * 0.8 + Math.abs(rightProjected - desiredBrickFraction) * 12;
    return leftScore - rightScore
      || right.confidence - left.confidence;
  });
  const pool = candidates.slice(0, Math.min(10, candidates.length));
  return pool[random.integer(0, pool.length)];
}

function chooseSourcePalette(eligible, random, count = 3) {
  const bySource = new Map();
  for (const template of eligible) {
    const sourceId = template.source.levelId;
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId).push(template);
  }
  const candidates = [...bySource.entries()].map(([sourceId, templates]) => {
    const kinds = new Set(templates.flatMap(template => template.objects.map(object => object.kind)));
    const types = new Set(templates.map(template => template.type));
    return {
      sourceId,
      templates,
      score: Math.min(20, templates.length) + types.size * 5 + (kinds.has('brick') ? 10 : 0) + (kinds.has('circle') ? 6 : 0),
      hasBrick: kinds.has('brick'),
      hasCircle: kinds.has('circle')
    };
  }).filter(source => source.templates.length >= 4);
  const mixed = candidates.filter(source => source.hasBrick && source.hasCircle);
  const pool = mixed.length >= count ? mixed : candidates;
  const selected = [];
  const remaining = random.shuffle(pool).sort((left, right) => right.score - left.score);
  while (selected.length < Math.min(count, remaining.length)) {
    const head = remaining.slice(0, Math.min(8, remaining.length));
    const choice = head[random.integer(0, head.length)];
    selected.push(choice);
    remaining.splice(remaining.indexOf(choice), 1);
  }
  return selected.map(source => source.sourceId);
}

function chooseRelationalTemplate(relationIndex, templateById, eligibleIds, placements, usedSources, objects, desiredBrickFraction, composition, safeBounds, random) {
  if (!placements.length || random.random() >= 0.72) return null;
  const currentBricks = objects.filter(object => object.kind === 'brick').length;
  const candidates = [];
  for (const anchor of random.shuffle(placements)) {
    for (const edge of relationIndex.get(anchor.templateId) || []) {
      const forward = edge.from === anchor.templateId;
      const targetId = forward ? edge.to : edge.from;
      if (!eligibleIds.has(targetId)) continue;
      const template = templateById.get(targetId);
      if (!template) continue;
      const sourceUse = usedSources.get(template.source.levelId) || 0;
      if (sourceUse >= 3) continue;
      const direction = forward ? 1 : -1;
      const rawDx = finite(edge.dx, Math.cos(edge.angleRadians) * edge.distanceFraction * 700) * direction;
      const rawDy = finite(edge.dy, Math.sin(edge.angleRadians) * edge.distanceFraction * 700) * direction;
      const mirroredDx = rawDx * (composition.mirrored ? -1 : 1) * composition.scale;
      const scaledDy = rawDy * composition.scale;
      const cos = Math.cos(composition.rotation);
      const sin = Math.sin(composition.rotation);
      const center = {
        x: anchor.center.x + mirroredDx * cos - scaledDy * sin,
        y: anchor.center.y + mirroredDx * sin + scaledDy * cos
      };
      const brickCount = template.objectKindCounts?.brick || template.objects.filter(object => object.kind === 'brick').length;
      const projectedBrickFraction = (currentBricks + brickCount) / Math.max(1, objects.length + template.size);
      const overflow = Math.max(0, safeBounds.minX - center.x, center.x - safeBounds.maxX)
        + Math.max(0, safeBounds.minY - center.y, center.y - safeBounds.maxY);
      candidates.push({
        template,
        anchor,
        edge,
        center,
        score: overflow * 0.2 + Math.abs(projectedBrickFraction - desiredBrickFraction) * 8 + sourceUse * 0.2
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => left.score - right.score || left.template.id.localeCompare(right.template.id));
  const pool = candidates.slice(0, Math.min(6, candidates.length));
  return pool[random.integer(0, pool.length)];
}

function assignTargetTypes(objects, orangeFraction, random) {
  const shuffled = random.shuffle(objects);
  const orangeCount = clamp(Math.round(objects.length * orangeFraction), Math.min(6, objects.length), objects.length);
  const orangeIds = new Set(shuffled.slice(0, orangeCount).map(object => object.id));
  objects.forEach(object => { object.targetType = orangeIds.has(object.id) ? 'orange' : 'blue'; });
  return orangeCount;
}

function nativePeg(object) {
  return {
    id: object.id,
    type: object.targetType,
    shape: object.kind === 'brick' ? 'brick' : 'circle',
    x: object.transform.x,
    y: object.transform.y,
    angle: object.transform.rotation,
    ...(object.kind === 'brick' ? {
      width: finite(object.geometry?.width, 34),
      height: finite(object.geometry?.height, 10.2)
    } : {}),
    groupId: object.groupIds[0] || null,
    bezierGroupId: null,
    bezierIndex: null
  };
}

export function researchRecordToNativeLevel(record) {
  return {
    version: 1,
    id: record.id.replace(/^level:/, ''),
    name: record.authored.name,
    difficulty: 1,
    tags: [...(record.authored.tags || [])],
    pegs: record.authored.objects.map(nativePeg),
    groups: record.authored.groups.map(group => ({ id: group.id, name: group.name })),
    bezierCurves: {},
    pegRadius: PEG_RADIUS,
    aimLength: 300,
    flippers: null,
    survival: { enabled: false, worldHeight: VIEWPORT.height },
    destruction: { enabled: false },
    billiard: { enabled: false },
    pvp: { enabled: false },
    metadata: cloneResearchValue(record.authored.metadata || {})
  };
}

export function generateConstructiveLevel(library, pacing, options = {}) {
  if (library.format !== 'peggle-motif-library') throw new Error('Invalid motif library.');
  if (pacing.format !== 'peggle-vertical-pacing-profile') throw new Error('Invalid vertical pacing profile.');
  const seed = String(options.seed || 'constructive-v0');
  const random = createRandom(seed);
  const fragments = (library.generatorFragments || []).filter(template => template.generatorCapability.eligible && template.size >= 12);
  const coverIds = new Set((library.levelGraphs || []).flatMap(graph => graph.generatorCoverTemplateIds || []));
  const allEligible = fragments.length >= 12
    ? fragments
    : library.templates.filter(template => (
      template.generatorCapability.eligible && template.size >= 5 && (!coverIds.size || coverIds.has(template.id))
    ));
  if (!allEligible.length) throw new Error('Motif library has no generator-eligible templates.');
  const sourcePalette = chooseSourcePalette(allEligible, random, 3);
  const sourcePaletteSet = new Set(sourcePalette);
  const eligible = allEligible.filter(template => sourcePaletteSet.has(template.source.levelId));
  const templateById = new Map([...library.templates, ...(library.generatorFragments || [])].map(template => [template.id, template]));
  const eligibleIds = new Set(eligible.map(template => template.id));
  const relationIndex = new Map();
  for (const graph of library.levelGraphs || []) {
    for (const edge of graph.generatorEdges || graph.edges || []) {
      for (const endpoint of [edge.from, edge.to]) {
        if (!relationIndex.has(endpoint)) relationIndex.set(endpoint, []);
        relationIndex.get(endpoint).push(edge);
      }
    }
  }
  const targetCount = Math.max(24, Math.round(random.range(pacing.targetCount.low, pacing.targetCount.high + 1)));
  const orangeFraction = clamp(random.normal(pacing.orangeFraction.median, 0.045), 0.15, 0.85);
  const desiredBrickFraction = pacing.brickFraction
    ? clamp(random.normal(pacing.brickFraction.median, 0.08), 0.2, 0.88)
    : 0.5;
  const objects = [];
  const groups = [];
  const placements = [];
  const usedSources = new Map();
  const usedTypes = new Map();
  const safeBounds = { minX: 18, maxX: VIEWPORT.width - 18, minY: 108, maxY: VIEWPORT.height - 30 };
  const composition = {
    scale: random.range(0.5, 0.66),
    rotation: random.normal(0, 0.035),
    mirrored: random.random() < 0.35
  };
  let attempts = 0;
  const maxAttempts = Math.max(80, Math.trunc(options.maxPlacementAttempts || 420));
  while (objects.length < targetCount && attempts++ < maxAttempts) {
    const relational = chooseRelationalTemplate(
      relationIndex, templateById, eligibleIds, placements, usedSources, objects,
      desiredBrickFraction, composition, safeBounds, random
    );
    const template = relational?.template
      || chooseTemplate(eligible, usedSources, usedTypes, objects, desiredBrickFraction, random);
    if (!template) break;
    const normalizedY = sampleDensityY(pacing.aggregateSamples, random);
    const centerY = relational?.center.y ?? (safeBounds.minY + normalizedY * (safeBounds.maxY - safeBounds.minY));
    const preferredCenterX = sampleCurve(pacing.aggregateSamples, normalizedY, 'centerX') * VIEWPORT.width;
    const spreadX = Math.max(24, sampleCurve(pacing.aggregateSamples, normalizedY, 'spreadX') * VIEWPORT.width);
    const maximumScale = Math.min(
      0.78,
      (safeBounds.maxX - safeBounds.minX) / Math.max(1, template.extent.width + 36),
      260 / Math.max(1, template.extent.height + 24)
    );
    const scale = clamp(
      relational ? relational.anchor.scale : random.normal(composition.scale, 0.035),
      0.34,
      maximumScale
    );
    if (!(scale >= 0.34)) continue;
    const placement = {
      center: {
        x: relational?.center.x
          ?? clamp(random.normal(preferredCenterX, spreadX * 0.42), safeBounds.minX + 20, safeBounds.maxX - 20),
        y: centerY
      },
      scale,
      rotation: composition.rotation,
      mirrored: composition.mirrored
    };
    let instantiated = instantiateTemplate(template, placement, placements.length);
    let envelope = placementEnvelope(instantiated);
    if (envelope.minX < safeBounds.minX) placement.center.x += safeBounds.minX - envelope.minX;
    if (envelope.maxX > safeBounds.maxX) placement.center.x += safeBounds.maxX - envelope.maxX;
    if (envelope.minY < safeBounds.minY) placement.center.y += safeBounds.minY - envelope.minY;
    if (envelope.maxY > safeBounds.maxY) placement.center.y += safeBounds.maxY - envelope.maxY;
    instantiated = instantiateTemplate(template, placement, placements.length);
    envelope = placementEnvelope(instantiated);
    if (envelope.minX < safeBounds.minX || envelope.maxX > safeBounds.maxX
        || envelope.minY < safeBounds.minY || envelope.maxY > safeBounds.maxY) continue;
    if (intersectsExisting(instantiated, objects, 0.4, relational?.anchor.groupId || null)) continue;
    const groupId = `generated-motif-${String(placements.length + 1).padStart(2, '0')}`;
    instantiated.forEach(object => { object.groupIds = [groupId]; });
    objects.push(...instantiated);
    groups.push({
      id: groupId,
      name: `Motif ${placements.length + 1}`,
      objectIds: instantiated.map(object => object.id),
      source: { templateId: template.id, sourceLevelId: template.source.levelId }
    });
    placements.push({
      groupId,
      templateId: template.id,
      sourceLevelId: template.source.levelId,
      sourceLevelName: template.source.levelName,
      motifType: template.type,
      motifTypes: template.constituentMotifTypes || [template.type],
      objectCount: instantiated.length,
      relation: relational ? {
        anchorGroupId: relational.anchor.groupId,
        sourceEdge: { from: relational.edge.from, to: relational.edge.to },
        sourceDx: relational.edge.dx,
        sourceDy: relational.edge.dy
      } : null,
      ...placement
    });
    usedSources.set(template.source.levelId, (usedSources.get(template.source.levelId) || 0) + 1);
    usedTypes.set(template.type, (usedTypes.get(template.type) || 0) + 1);
  }
  if (objects.length < Math.min(24, targetCount * 0.7)) {
    throw new Error(`Placement exhausted after ${attempts} attempts with only ${objects.length}/${targetCount} targets.`);
  }
  const orangeCount = assignTargetTypes(objects, orangeFraction, random);
  const recipe = {
    method: fragments.length >= 12
      ? 'continuous-density-guided-connected-motif-fragment-composition/v2'
      : 'continuous-density-guided-motif-composition/v1',
    seed,
    libraryId: library.id,
    pacingProfileId: pacing.id,
    targetCountRequested: targetCount,
    targetCountPlaced: objects.length,
    orangeCount,
    orangeFraction: objects.length ? orangeCount / objects.length : 0,
    desiredBrickFraction,
    brickFraction: objects.length ? objects.filter(object => object.kind === 'brick').length / objects.length : 0,
    placementAttempts: attempts,
    composition,
    sourcePalette,
    placements
  };
  const recipeSha256 = sha256Value(recipe);
  const record = {
    format: 'peggle-research',
    formatVersion: 1,
    recordType: 'level',
    id: `level:generated:motif-constructive-v0:${recipeSha256.slice(0, 20)}`,
    provenance: {
      source: {
        system: 'constructive-motif-generator',
        libraryId: library.id,
        pacingProfileId: pacing.id,
        recipeSha256,
        seed
      },
      ingestion: {
        tool: 'constructive-generator.mjs',
        toolVersion: TOOL_VERSION,
        toolRevision: String(options.toolRevision || 'working-tree'),
        at: options.at || new Date().toISOString()
      }
    },
    authored: {
      name: `Generated ${seed}`,
      coordinateSystem: {
        units: 'game-pixel', origin: 'top-left', xAxis: 'right', yAxis: 'down', orientation: 'portrait',
        bounds: { minX: 0, minY: 0, maxX: VIEWPORT.width, maxY: VIEWPORT.height },
        viewport: { ...VIEWPORT },
        revision: 'alea-standard-portrait-v1'
      },
      objects,
      groups,
      mechanics: {
        mode: 'standard', pegRadius: PEG_RADIUS, aimLength: 300,
        launcher: { x: VIEWPORT.width / 2, y: 40, coordinateSpace: 'world' },
        bucket: { enabled: true, width: 70, height: 16 }
      },
      tags: ['generated', 'constructive', 'motif-library', 'generator:v0'],
      metadata: { generatorRecipe: recipe }
    },
    visual: { presentation: { source: 'generator-semantic-preview' } },
    extensions: { generatorRecipe: recipe },
    warnings: [],
    losses: []
  };
  return { record, nativeLevel: researchRecordToNativeLevel(record), recipe };
}
