import { sha256Value } from '../../tools/lib/node-io.mjs';
import { analyzeLevelMotifs } from './motifs.mjs';

const EPSILON = 1e-9;
export const FEATURE_VECTOR_KEYS = [
  'logTargetCount',
  'logObstacleCount',
  'circleFraction',
  'brickFraction',
  'movingFraction',
  'centroidX',
  'centroidY',
  'spreadX',
  'spreadY',
  'coverageX',
  'coverageY',
  'xEntropy',
  'yEntropy',
  'occupancyFraction',
  'edgeFraction',
  'nearestNeighborMean',
  'nearestNeighborCv',
  'proximityMeanDegree',
  'proximityComponentFraction',
  'mirrorSymmetry',
  'overlapPairFraction',
  'overlapObjectFraction',
  'logMotifCount',
  'motifCoverageFraction',
  'lineMotifFraction',
  'arcMotifFraction',
  'gridMotifFraction',
  'clusterMotifFraction',
  'meanMotifRegularity',
  'meanMotifSizeFraction',
  'motifSeparation',
  'framingMinMargin',
  'framingBalance'
];

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values, average = mean(values)) {
  return values.length
    ? Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length)
    : 0;
}

function normalizedEntropy(values, bins, min, max) {
  if (!values.length || max <= min) return 0;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(((value - min) / (max - min)) * bins)));
    counts[index]++;
  }
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / values.length;
    entropy -= probability * Math.log(probability);
  }
  return entropy / Math.log(bins);
}

function objectRadius(object) {
  const geometry = object.geometry || {};
  if (object.kind === 'circle' || object.kind === 'bumper' || object.kind === 'portal') {
    return Math.max(1, finite(geometry.radius, 10));
  }
  if (object.kind === 'brick') {
    return Math.max(1, Math.min(finite(geometry.width, 34), finite(geometry.height, 12)) / 2);
  }
  if (object.kind === 'segment' || object.kind === 'rod') {
    return Math.max(1, finite(geometry.thickness, 10) / 2);
  }
  if (object.kind === 'polygon' && Array.isArray(geometry.points)) {
    const x = finite(object.transform?.x);
    const y = finite(object.transform?.y);
    return Math.max(1, ...geometry.points.map(point => Math.hypot(finite(point.x) - x, finite(point.y) - y)));
  }
  return 8.5;
}

export function isMechanicalObject(object) {
  if (!object) return false;
  if (['target', 'obstacle', 'permanent'].includes(object.role)) return true;
  return ['bumper', 'portal', 'hole'].includes(object.kind);
}

export function mechanicalObjects(levelRecord) {
  return (levelRecord?.authored?.objects || []).filter(isMechanicalObject);
}

function objectPoint(object) {
  return {
    id: String(object.id),
    x: finite(object.transform?.x, Number.NaN),
    y: finite(object.transform?.y, Number.NaN),
    radius: objectRadius(object),
    role: object.role,
    kind: object.kind,
    moving: !!(object.movement || object.animation)
  };
}

function nearestNeighborDistances(points, diagonal) {
  return points.map((point, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let otherIndex = 0; otherIndex < points.length; otherIndex++) {
      if (index === otherIndex) continue;
      const other = points[otherIndex];
      nearest = Math.min(nearest, Math.hypot(point.x - other.x, point.y - other.y));
    }
    return Number.isFinite(nearest) ? nearest / diagonal : 0;
  });
}

function proximityGraph(points, diagonal) {
  if (!points.length) return { meanDegree: 0, componentFraction: 0 };
  const threshold = diagonal * 0.085;
  const adjacency = points.map(() => []);
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      if (Math.hypot(points[left].x - points[right].x, points[left].y - points[right].y) <= threshold) {
        adjacency[left].push(right);
        adjacency[right].push(left);
      }
    }
  }
  let components = 0;
  const visited = new Set();
  for (let index = 0; index < points.length; index++) {
    if (visited.has(index)) continue;
    components++;
    const stack = [index];
    visited.add(index);
    while (stack.length) {
      for (const next of adjacency[stack.pop()]) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
  }
  return {
    meanDegree: mean(adjacency.map(neighbors => neighbors.length)),
    componentFraction: components / points.length
  };
}

function mirrorSymmetry(points, centerX, diagonal) {
  if (points.length < 2) return 0;
  const errors = points.map(point => {
    const mirrorX = 2 * centerX - point.x;
    let nearest = Number.POSITIVE_INFINITY;
    for (const other of points) {
      if (other.kind !== point.kind) continue;
      nearest = Math.min(nearest, Math.hypot(mirrorX - other.x, point.y - other.y));
    }
    return nearest / diagonal;
  });
  return 1 - clamp(mean(errors) / 0.12);
}

function layoutFingerprintPayload(levelRecord) {
  const authored = levelRecord.authored || {};
  return {
    coordinateSystem: authored.coordinateSystem,
    objects: authored.objects,
    groups: authored.groups,
    mechanics: authored.mechanics
  };
}

export function layoutFingerprint(levelRecord) {
  return sha256Value(layoutFingerprintPayload(levelRecord));
}

export function extractLevelFeatures(levelRecord) {
  const coordinateSystem = levelRecord.authored.coordinateSystem;
  const bounds = coordinateSystem.bounds;
  const width = Math.max(EPSILON, finite(bounds.maxX) - finite(bounds.minX));
  const height = Math.max(EPSILON, finite(bounds.maxY) - finite(bounds.minY));
  const diagonal = Math.hypot(width, height);
  const allMechanical = mechanicalObjects(levelRecord);
  const rawPoints = allMechanical.map(objectPoint);
  const finitePoints = rawPoints.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  const targets = finitePoints.filter(point => point.role === 'target');
  const obstacles = finitePoints.filter(point => point.role !== 'target');
  const analysisPoints = targets.length ? targets : finitePoints;
  const xs = analysisPoints.map(point => point.x);
  const ys = analysisPoints.map(point => point.y);
  const averageX = mean(xs);
  const averageY = mean(ys);
  const minX = xs.length ? Math.min(...xs) : finite(bounds.minX);
  const maxX = xs.length ? Math.max(...xs) : finite(bounds.minX);
  const minY = ys.length ? Math.min(...ys) : finite(bounds.minY);
  const maxY = ys.length ? Math.max(...ys) : finite(bounds.minY);
  const nearest = nearestNeighborDistances(analysisPoints, diagonal);
  const nearestMean = mean(nearest);
  const nearestDeviation = deviation(nearest, nearestMean);
  const graph = proximityGraph(analysisPoints, diagonal);
  const gridWidth = 10;
  const gridHeight = 8;
  const occupied = new Set(analysisPoints.map(point => {
    const gx = Math.min(gridWidth - 1, Math.max(0, Math.floor(((point.x - bounds.minX) / width) * gridWidth)));
    const gy = Math.min(gridHeight - 1, Math.max(0, Math.floor(((point.y - bounds.minY) / height) * gridHeight)));
    return `${gx}:${gy}`;
  }));
  let overlaps = 0;
  let overlapSeverity = 0;
  const overlappingObjects = new Set();
  const pairCount = analysisPoints.length * (analysisPoints.length - 1) / 2;
  for (let left = 0; left < analysisPoints.length; left++) {
    for (let right = left + 1; right < analysisPoints.length; right++) {
      const a = analysisPoints[left];
      const b = analysisPoints[right];
      const required = a.radius + b.radius;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < required) {
        overlaps++;
        overlappingObjects.add(left);
        overlappingObjects.add(right);
        overlapSeverity += (required - distance) / Math.max(required, EPSILON);
      }
    }
  }
  const inBoundsCount = finitePoints.filter(point => (
    point.x >= bounds.minX && point.x <= bounds.maxX
    && point.y >= bounds.minY && point.y <= bounds.maxY
  )).length;
  const staticPoints = finitePoints.filter(point => !point.moving);
  const staticInBoundsCount = staticPoints.filter(point => (
    point.x >= bounds.minX && point.x <= bounds.maxX
    && point.y >= bounds.minY && point.y <= bounds.maxY
  )).length;
  const edgeFraction = analysisPoints.length
    ? analysisPoints.filter(point => {
      const nx = (point.x - bounds.minX) / width;
      const ny = (point.y - bounds.minY) / height;
      return nx < 0.08 || nx > 0.92 || ny < 0.08 || ny > 0.92;
    }).length / analysisPoints.length
    : 0;
  const kindCounts = Object.fromEntries(
    [...new Set(finitePoints.map(point => point.kind))].sort().map(kind => [
      kind,
      finitePoints.filter(point => point.kind === kind).length
    ])
  );
  const finiteFraction = rawPoints.length ? finitePoints.length / rawPoints.length : 1;
  const inBoundsFraction = finitePoints.length ? inBoundsCount / finitePoints.length : 1;
  const staticInBoundsFraction = staticPoints.length ? staticInBoundsCount / staticPoints.length : 1;
  const overlapPairFraction = pairCount ? overlaps / pairCount : 0;
  const overlapObjectFraction = analysisPoints.length ? overlappingObjects.size / analysisPoints.length : 0;
  const normalizedOverlapSeverity = pairCount ? overlapSeverity / pairCount : 0;
  const diagnostics = {
    finiteFraction,
    inBoundsFraction,
    staticInBoundsFraction,
    overlapPairFraction,
    overlapObjectFraction,
    overlapSeverity: normalizedOverlapSeverity,
    hardValidity: clamp(finiteFraction * staticInBoundsFraction),
    spacingValidityHeuristic: clamp(1 - overlapObjectFraction),
    targetCountAdequate: targets.length >= 10,
    warnings: [
      ...(finiteFraction < 1 ? ['non-finite mechanical transforms'] : []),
      ...(inBoundsFraction < 1 ? ['mechanical objects outside declared bounds'] : []),
      ...(overlapPairFraction > 0.02 ? ['many approximate footprint overlaps'] : []),
      ...(targets.length < 10 ? ['very small target population'] : [])
    ]
  };
  const motifAnalysis = analyzeLevelMotifs(levelRecord);
  return {
    levelId: levelRecord.id,
    name: levelRecord.authored.name,
    layoutSha256: layoutFingerprint(levelRecord),
    counts: {
      allObjects: levelRecord.authored.objects.length,
      mechanical: finitePoints.length,
      targets: targets.length,
      obstacles: obstacles.length,
      moving: finitePoints.filter(point => point.moving).length,
      kinds: kindCounts
    },
    geometry: {
      centroid: {
        x: (averageX - bounds.minX) / width,
        y: (averageY - bounds.minY) / height
      },
      spread: {
        x: deviation(xs, averageX) / width,
        y: deviation(ys, averageY) / height
      },
      coverage: {
        x: (maxX - minX) / width,
        y: (maxY - minY) / height
      },
      entropy: {
        x: normalizedEntropy(xs, 10, bounds.minX, bounds.maxX),
        y: normalizedEntropy(ys, 8, bounds.minY, bounds.maxY)
      },
      occupancyFraction: occupied.size / (gridWidth * gridHeight),
      edgeFraction,
      nearestNeighbor: {
        mean: nearestMean,
        standardDeviation: nearestDeviation,
        coefficientOfVariation: nearestMean > EPSILON ? nearestDeviation / nearestMean : 0
      },
      proximity: graph,
      mirrorSymmetry: mirrorSymmetry(analysisPoints, bounds.minX + width / 2, diagonal)
    },
    motifs: {
      ...motifAnalysis.summary,
      items: motifAnalysis.motifs
    },
    diagnostics
  };
}

export function levelFeatureVector(features) {
  const count = Math.max(1, features.counts.mechanical);
  return {
    logTargetCount: Math.log1p(features.counts.targets),
    logObstacleCount: Math.log1p(features.counts.obstacles),
    circleFraction: (features.counts.kinds.circle || 0) / count,
    brickFraction: (features.counts.kinds.brick || 0) / count,
    movingFraction: features.counts.moving / count,
    centroidX: features.geometry.centroid.x,
    centroidY: features.geometry.centroid.y,
    spreadX: features.geometry.spread.x,
    spreadY: features.geometry.spread.y,
    coverageX: features.geometry.coverage.x,
    coverageY: features.geometry.coverage.y,
    xEntropy: features.geometry.entropy.x,
    yEntropy: features.geometry.entropy.y,
    occupancyFraction: features.geometry.occupancyFraction,
    edgeFraction: features.geometry.edgeFraction,
    nearestNeighborMean: features.geometry.nearestNeighbor.mean,
    nearestNeighborCv: features.geometry.nearestNeighbor.coefficientOfVariation,
    proximityMeanDegree: features.geometry.proximity.meanDegree,
    proximityComponentFraction: features.geometry.proximity.componentFraction,
    mirrorSymmetry: features.geometry.mirrorSymmetry,
    overlapPairFraction: features.diagnostics.overlapPairFraction,
    overlapObjectFraction: features.diagnostics.overlapObjectFraction,
    logMotifCount: Math.log1p(features.motifs?.motifCount || 0),
    motifCoverageFraction: finite(features.motifs?.coverageFraction),
    lineMotifFraction: finite(features.motifs?.lineFraction),
    arcMotifFraction: finite(features.motifs?.arcFraction),
    gridMotifFraction: finite(features.motifs?.gridFraction),
    clusterMotifFraction: finite(features.motifs?.clusterFraction),
    meanMotifRegularity: finite(features.motifs?.meanRegularity),
    meanMotifSizeFraction: finite(features.motifs?.meanSizeFraction),
    motifSeparation: finite(features.motifs?.separation),
    framingMinMargin: finite(features.motifs?.framingMinMargin),
    framingBalance: finite(features.motifs?.framingBalance)
  };
}

function squaredDistance(left, right) {
  return left.reduce((sum, value, index) => sum + ((value - right[index]) ** 2), 0);
}

export function selectDiverseLevels(entries, count) {
  if (entries.length <= count) return [...entries];
  const vectors = entries.map(entry => levelFeatureVector(entry.features));
  const statistics = FEATURE_VECTOR_KEYS.map(key => {
    const values = vectors.map(vector => finite(vector[key]));
    const average = mean(values);
    return { average, deviation: Math.max(EPSILON, deviation(values, average)) };
  });
  const normalized = vectors.map(vector => FEATURE_VECTOR_KEYS.map((key, index) => (
    (finite(vector[key]) - statistics[index].average) / statistics[index].deviation
  )));
  const centroid = FEATURE_VECTOR_KEYS.map(() => 0);
  const selected = [];
  let first = 0;
  let firstDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < normalized.length; index++) {
    const distance = squaredDistance(normalized[index], centroid);
    if (distance < firstDistance || (distance === firstDistance && entries[index].id < entries[first].id)) {
      firstDistance = distance;
      first = index;
    }
  }
  selected.push(first);
  while (selected.length < count) {
    let best = -1;
    let bestDistance = -1;
    for (let index = 0; index < normalized.length; index++) {
      if (selected.includes(index)) continue;
      const distance = Math.min(...selected.map(other => squaredDistance(normalized[index], normalized[other])));
      if (distance > bestDistance || (distance === bestDistance && entries[index].id < entries[best]?.id)) {
        best = index;
        bestDistance = distance;
      }
    }
    selected.push(best);
  }
  return selected.map(index => entries[index]);
}

export function featureDelta(parentFeatures, variantFeatures) {
  const parent = levelFeatureVector(parentFeatures);
  const variant = levelFeatureVector(variantFeatures);
  return Object.fromEntries(FEATURE_VECTOR_KEYS.map(key => [key, variant[key] - parent[key]]));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildReferenceProfile(featureRecords) {
  const vectors = featureRecords.map(levelFeatureVector);
  const dimensions = Object.fromEntries(FEATURE_VECTOR_KEYS.map(key => {
    const values = vectors.map(vector => finite(vector[key]));
    const center = median(values);
    const absoluteDeviations = values.map(value => Math.abs(value - center));
    const robustScale = median(absoluteDeviations) * 1.4826;
    const standardScale = deviation(values, mean(values));
    return [key, {
      center,
      scale: Math.max(0.025, robustScale, standardScale * 0.25),
      min: Math.min(...values),
      max: Math.max(...values)
    }];
  }));
  return {
    method: 'diagonal-robust-reference-profile/v1',
    sampleCount: featureRecords.length,
    dimensions
  };
}

export function scoreAgainstReference(features, profile) {
  const vector = levelFeatureVector(features);
  const zScores = Object.fromEntries(FEATURE_VECTOR_KEYS.map(key => {
    const dimension = profile.dimensions[key];
    return [key, (finite(vector[key]) - dimension.center) / dimension.scale];
  }));
  const meanAbsoluteZ = mean(Object.values(zScores).map(value => Math.min(8, Math.abs(value))));
  const referenceConformity = Math.exp(-meanAbsoluteZ);
  const validity = features.diagnostics.hardValidity;
  return {
    validity,
    referenceConformity,
    meanAbsoluteZ,
    screeningScore: validity * 0.60 + referenceConformity * 0.40,
    zScores,
    caveat: 'Screening score measures hard validity plus proximity to the reference corpus; it is not a learned fun or quality score.'
  };
}
