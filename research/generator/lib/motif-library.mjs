import path from 'node:path';

import { cloneResearchValue } from '../../../js/research-format.js';
import { analyzeLevelMotifs } from '../../benchmark/lib/motifs.mjs';
import { layoutFingerprint } from '../../benchmark/lib/features.mjs';
import { readJson, sha256Value } from '../../tools/lib/node-io.mjs';

const EPSILON = 1e-9;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + finite(value), 0) / values.length : 0;
}

function normalizedGeometry(geometry, center) {
  const result = cloneResearchValue(geometry || {});
  for (const key of ['x1', 'x2']) {
    if (Number.isFinite(Number(result[key]))) result[key] = Number(result[key]) - center.x;
  }
  for (const key of ['y1', 'y2']) {
    if (Number.isFinite(Number(result[key]))) result[key] = Number(result[key]) - center.y;
  }
  for (const key of ['points', 'curveSlices']) {
    if (!Array.isArray(result[key])) continue;
    result[key] = result[key].map(point => ({
      ...point,
      x: finite(point.x) - center.x,
      y: finite(point.y) - center.y
    }));
  }
  return result;
}

function generatorCapability(objects) {
  const reasons = {};
  for (const object of objects) {
    let reason = null;
    if (object.role !== 'target') reason = 'non-target';
    else if (object.movement || object.animation) reason = 'moving';
    else if (object.kind === 'circle') reason = null;
    else if (object.kind === 'brick'
      && object.geometry?.shape !== 'annular-sector'
      && object.geometry?.curved !== true
      && !object.geometry?.curveSlices?.length) reason = null;
    else reason = `unsupported-${object.kind}`;
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    eligible: objects.length >= 3 && Object.keys(reasons).length === 0,
    reasons
  };
}

function templateFromMotif(record, motif, sourceSystem) {
  const objectById = new Map(record.authored.objects.map(object => [String(object.id), object]));
  const objects = motif.objectIds.map(id => objectById.get(String(id))).filter(Boolean);
  const capability = generatorCapability(objects);
  const normalizedObjects = objects.map(object => ({
    id: String(object.id),
    kind: object.kind,
    role: object.role,
    targetType: object.targetType ?? null,
    transform: {
      x: finite(object.transform?.x) - motif.centroid.x,
      y: finite(object.transform?.y) - motif.centroid.y,
      rotation: finite(object.transform?.rotation),
      scaleX: finite(object.transform?.scaleX, 1),
      scaleY: finite(object.transform?.scaleY, 1)
    },
    geometry: normalizedGeometry(object.geometry, motif.centroid),
    properties: cloneResearchValue(object.properties || {})
  }));
  const templateId = `motif-template:${sourceSystem}:${record.id.split(':').at(-1)}:${motif.id}`;
  return {
    id: templateId,
    source: {
      system: sourceSystem,
      levelId: record.id,
      levelName: record.authored.name,
      levelLayoutSha256: layoutFingerprint(record),
      motifId: motif.id,
      objectIds: motif.objectIds
    },
    type: motif.type,
    size: normalizedObjects.length,
    objectKindCounts: Object.fromEntries([...new Set(normalizedObjects.map(object => object.kind))].sort().map(kind => [
      kind, normalizedObjects.filter(object => object.kind === kind).length
    ])),
    brickFraction: normalizedObjects.length
      ? normalizedObjects.filter(object => object.kind === 'brick').length / normalizedObjects.length
      : 0,
    confidence: motif.confidence,
    regularity: motif.regularity,
    spacing: motif.spacing,
    principalAngle: motif.principalAngle,
    extent: {
      width: motif.bounds.maxX - motif.bounds.minX,
      height: motif.bounds.maxY - motif.bounds.minY
    },
    sourceCentroid: motif.centroid,
    sourceBounds: motif.bounds,
    generatorCapability: capability,
    objects: normalizedObjects,
    signature: sha256Value({
      type: motif.type,
      objects: normalizedObjects.map(object => ({
        kind: object.kind,
        x: Math.round(object.transform.x * 1000) / 1000,
        y: Math.round(object.transform.y * 1000) / 1000,
        rotation: Math.round(object.transform.rotation * 10000) / 10000,
        geometry: object.geometry
      }))
    })
  };
}

function motifRelations(templates, bounds) {
  const diagonal = Math.max(EPSILON, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  const edges = [];
  for (let left = 0; left < templates.length; left++) {
    const distances = [];
    for (let right = 0; right < templates.length; right++) {
      if (left === right) continue;
      const a = templates[left];
      const b = templates[right];
      const dx = b.sourceCentroid.x - a.sourceCentroid.x;
      const dy = b.sourceCentroid.y - a.sourceCentroid.y;
      distances.push({ right, distance: Math.hypot(dx, dy), dx, dy });
    }
    distances.sort((a, b) => a.distance - b.distance || templates[a.right].id.localeCompare(templates[b.right].id));
    for (const relation of distances.slice(0, Math.min(3, distances.length))) {
      if (relation.right < left) continue;
      const other = templates[relation.right];
      edges.push({
        from: templates[left].id,
        to: other.id,
        fromType: templates[left].type,
        toType: other.type,
        dx: relation.dx,
        dy: relation.dy,
        dxFraction: relation.dx / Math.max(EPSILON, bounds.maxX - bounds.minX),
        dyFraction: relation.dy / Math.max(EPSILON, bounds.maxY - bounds.minY),
        distanceFraction: relation.distance / diagonal,
        angleRadians: Math.atan2(relation.dy, relation.dx),
        horizontalAlignment: 1 - Math.min(1, Math.abs(relation.dx) / Math.max(1, bounds.maxX - bounds.minX)),
        verticalRelation: Math.abs(relation.dy) < 8 ? 'level' : (relation.dy > 0 ? 'below' : 'above')
      });
    }
  }
  return edges;
}

function disjointGeneratorCover(templates) {
  const usedObjectIds = new Set();
  const selected = [];
  const candidates = templates
    .filter(template => template.generatorCapability.eligible && template.size >= 5)
    .sort((left, right) => (
      right.size * right.confidence - left.size * left.confidence
      || right.regularity - left.regularity
      || left.id.localeCompare(right.id)
    ));
  for (const template of candidates) {
    if (template.source.objectIds.some(id => usedObjectIds.has(String(id)))) continue;
    selected.push(template);
    template.source.objectIds.forEach(id => usedObjectIds.add(String(id)));
  }
  return selected;
}

function fragmentTemplate(templates, sourceSystem, fragmentIndex) {
  const reconstructed = templates.flatMap(template => template.objects.map(object => ({
    ...cloneResearchValue(object),
    id: `${template.id}:${object.id}`,
    transform: {
      ...object.transform,
      x: template.sourceCentroid.x + finite(object.transform.x),
      y: template.sourceCentroid.y + finite(object.transform.y)
    }
  })));
  const center = {
    x: mean(reconstructed.map(object => object.transform.x)),
    y: mean(reconstructed.map(object => object.transform.y))
  };
  const objects = reconstructed.map(object => ({
    ...object,
    transform: { ...object.transform, x: object.transform.x - center.x, y: object.transform.y - center.y }
  }));
  const source = templates[0].source;
  const constituentMotifTypes = [...new Set(templates.map(template => template.type))].sort();
  const id = `motif-fragment:${sourceSystem}:${source.levelId.split(':').at(-1)}:${String(fragmentIndex + 1).padStart(3, '0')}`;
  return {
    id,
    source: {
      system: sourceSystem,
      levelId: source.levelId,
      levelName: source.levelName,
      levelLayoutSha256: source.levelLayoutSha256,
      motifTemplateIds: templates.map(template => template.id).sort(),
      objectIds: [...new Set(templates.flatMap(template => template.source.objectIds).map(String))].sort()
    },
    type: `fragment:${constituentMotifTypes.join('+')}`,
    constituentMotifTypes,
    size: objects.length,
    confidence: mean(templates.map(template => template.confidence)),
    regularity: mean(templates.map(template => template.regularity)),
    extent: {
      width: Math.max(...reconstructed.map(object => object.transform.x)) - Math.min(...reconstructed.map(object => object.transform.x)),
      height: Math.max(...reconstructed.map(object => object.transform.y)) - Math.min(...reconstructed.map(object => object.transform.y))
    },
    sourceCentroid: center,
    objectKindCounts: Object.fromEntries([...new Set(objects.map(object => object.kind))].sort().map(kind => [
      kind, objects.filter(object => object.kind === kind).length
    ])),
    brickFraction: objects.length ? objects.filter(object => object.kind === 'brick').length / objects.length : 0,
    generatorCapability: { eligible: true, reasons: {} },
    objects,
    signature: sha256Value({
      sourceLevelId: source.levelId,
      motifs: templates.map(template => template.signature).sort()
    })
  };
}

function connectedGeneratorFragments(generatorCover, edges, sourceSystem) {
  if (generatorCover.length < 2) return [];
  const byId = new Map(generatorCover.map(template => [template.id, template]));
  const adjacency = new Map(generatorCover.map(template => [template.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from).push({ targetId: edge.to, distance: edge.distanceFraction });
    adjacency.get(edge.to).push({ targetId: edge.from, distance: edge.distanceFraction });
  }
  const motifSets = [];
  const seen = new Set();
  for (const maximumObjectCount of [24, 32]) {
    for (const anchor of generatorCover) {
      const selected = [anchor];
      let objectCount = anchor.size;
      while (selected.length < (maximumObjectCount <= 24 ? 3 : 4)) {
        const selectedIds = new Set(selected.map(template => template.id));
        const frontier = selected.flatMap(template => adjacency.get(template.id) || [])
          .filter(candidate => !selectedIds.has(candidate.targetId))
          .sort((left, right) => left.distance - right.distance || left.targetId.localeCompare(right.targetId));
        const next = frontier.map(candidate => byId.get(candidate.targetId))
          .find(template => template && objectCount + template.size <= maximumObjectCount);
        if (!next) break;
        selected.push(next);
        objectCount += next.size;
      }
      if (selected.length < 2 || objectCount < 12) continue;
      const key = selected.map(template => template.id).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      motifSets.push(selected);
    }
  }
  return motifSets.map((templates, index) => fragmentTemplate(templates, sourceSystem, index));
}

async function loadCorpus(manifestPath) {
  const absolute = path.resolve(manifestPath);
  const root = path.dirname(absolute);
  const manifest = await readJson(absolute);
  if (manifest.format !== 'peggle-research-corpus') throw new Error(`${manifestPath} is not a research corpus.`);
  const records = [];
  for (const entry of manifest.records || []) {
    records.push(await readJson(path.resolve(root, entry.recordPath)));
  }
  return { manifest, records };
}

export async function buildMotifLibrary(corpusPaths, options = {}) {
  const corpora = [];
  const templates = [];
  const levelGraphs = [];
  const generatorFragments = [];
  for (const corpusPath of corpusPaths) {
    const { manifest, records } = await loadCorpus(corpusPath);
    const sourceSystem = manifest.provenance?.sourceSystem || manifest.id.replace(/^corpus:/, '');
    corpora.push({
      id: manifest.id,
      createdAt: manifest.createdAt,
      recordCount: records.length,
      manifestSha256: sha256Value(manifest)
    });
    for (const record of records) {
      const analysis = analyzeLevelMotifs(record);
      const levelTemplates = analysis.motifs.map(motif => templateFromMotif(record, motif, sourceSystem));
      const generatorCover = disjointGeneratorCover(levelTemplates);
      const generatorEdges = motifRelations(generatorCover, record.authored.coordinateSystem.bounds);
      const levelFragments = connectedGeneratorFragments(generatorCover, generatorEdges, sourceSystem);
      templates.push(...levelTemplates);
      generatorFragments.push(...levelFragments);
      levelGraphs.push({
        levelId: record.id,
        levelName: record.authored.name,
        sourceSystem,
        coordinateSystem: cloneResearchValue(record.authored.coordinateSystem),
        motifTemplateIds: levelTemplates.map(template => template.id),
        generatorCoverTemplateIds: generatorCover.map(template => template.id),
        generatorCoverTargetCount: generatorCover.reduce((sum, template) => sum + template.size, 0),
        generatorFragmentIds: levelFragments.map(fragment => fragment.id),
        unassignedTargetCount: analysis.summary.unassignedTargetCount,
        edges: motifRelations(levelTemplates, record.authored.coordinateSystem.bounds),
        generatorEdges
      });
    }
  }
  const uniqueSignatures = new Set(templates.map(template => template.signature));
  const eligible = templates.filter(template => template.generatorCapability.eligible);
  const coverIds = new Set(levelGraphs.flatMap(graph => graph.generatorCoverTemplateIds));
  return {
    format: 'peggle-motif-library',
    formatVersion: 1,
    id: options.id || 'motif-library:deluxe-nights:v1',
    createdAt: options.at || new Date().toISOString(),
    generatorContract: {
      allowedTemplateObjects: ['static-circle-target', 'static-straight-brick-target'],
      curvedAndMovingMotifsRetainedForAnalysis: true,
      coordinateNormalization: 'object-transforms-relative-to-detected-motif-centroid'
    },
    corpora,
    counts: {
      levels: levelGraphs.length,
      templates: templates.length,
      generatorEligible: eligible.length,
      disjointGeneratorCoverTemplates: coverIds.size,
      generatorFragments: generatorFragments.length,
      uniqueSignatures: uniqueSignatures.size,
      byType: Object.fromEntries([...new Set(templates.map(template => template.type))].sort().map(type => [
        type,
        templates.filter(template => template.type === type).length
      ])),
      eligibleByType: Object.fromEntries([...new Set(eligible.map(template => template.type))].sort().map(type => [
        type,
        eligible.filter(template => template.type === type).length
      ]))
    },
    templates,
    generatorFragments,
    levelGraphs
  };
}
