import assert from 'node:assert/strict';

import { generateConstructiveLevel } from '../generator/lib/constructive-generator.mjs';
import { evaluateStructuralGates } from '../generator/lib/harness.mjs';
import { validateResearchRecord } from '../tools/validate-record.mjs';
import { sha256Value } from '../tools/lib/node-io.mjs';

const AT = '2026-01-01T00:00:00.000Z';

function template(sourceIndex, templateIndex, kind) {
  const type = ['line', 'arc', 'cluster'][templateIndex % 3];
  const id = `motif-template:fixture-${sourceIndex}:level-${sourceIndex}:motif-${templateIndex}`;
  const objects = Array.from({ length: 5 }, (_value, index) => ({
    id: `source-${sourceIndex}-${templateIndex}-${index}`,
    kind,
    role: 'target',
    targetType: 'blue',
    transform: {
      x: type === 'cluster' ? (index % 2) * 28 - 14 : (index - 2) * 24,
      y: type === 'arc' ? Math.abs(index - 2) * 8 : (type === 'cluster' ? Math.floor(index / 2) * 24 - 24 : 0),
      rotation: kind === 'brick' ? 0.1 * (index - 2) : 0,
      scaleX: 1,
      scaleY: 1
    },
    geometry: kind === 'circle' ? { shape: 'circle', radius: 8.5 } : { shape: 'rectangle', width: 28, height: 10 },
    properties: {}
  }));
  return {
    id,
    source: { system: 'fixture', levelId: `level:fixture:${sourceIndex}`, levelName: `Fixture ${sourceIndex}` },
    type,
    size: objects.length,
    confidence: 0.9,
    extent: { width: 110, height: type === 'arc' ? 32 : 60 },
    objectKindCounts: { [kind]: objects.length },
    brickFraction: kind === 'brick' ? 1 : 0,
    generatorCapability: { eligible: true, reasons: {} },
    objects
  };
}

function fixtureLibrary() {
  const templates = [];
  const levelGraphs = [];
  for (let sourceIndex = 0; sourceIndex < 3; sourceIndex++) {
    const sourceTemplates = Array.from({ length: 6 }, (_value, templateIndex) => (
      template(sourceIndex, templateIndex, templateIndex % 2 ? 'brick' : 'circle')
    ));
    templates.push(...sourceTemplates);
    levelGraphs.push({
      levelId: `level:fixture:${sourceIndex}`,
      edges: sourceTemplates.slice(1).map((item, index) => ({
        from: sourceTemplates[index].id,
        to: item.id,
        dx: index % 2 ? -75 : 75,
        dy: 72,
        distanceFraction: 0.15,
        angleRadians: Math.atan2(72, index % 2 ? -75 : 75)
      }))
    });
  }
  return {
    format: 'peggle-motif-library',
    formatVersion: 1,
    id: 'motif-library:fixture',
    counts: { templates: templates.length, generatorEligible: templates.length },
    templates,
    levelGraphs
  };
}

function fixturePacing() {
  return {
    format: 'peggle-vertical-pacing-profile',
    formatVersion: 1,
    id: 'vertical-profile:fixture',
    viewport: { width: 400, height: 600 },
    eligibleProfileCount: 6,
    targetCount: { low: 30, median: 35, high: 40 },
    orangeFraction: { low: 0.25, median: 0.4, high: 0.6 },
    brickFraction: { low: 0.35, median: 0.55, high: 0.75 },
    aggregateSamples: Array.from({ length: 25 }, (_value, index) => ({
      y: index / 24,
      density: 1 / 25,
      centerX: 0.5,
      spreadX: 0.25
    }))
  };
}

const library = fixtureLibrary();
const pacing = fixturePacing();
const first = generateConstructiveLevel(library, pacing, { seed: 'generator-smoke', at: AT, toolRevision: 'fixture' });
const second = generateConstructiveLevel(library, pacing, { seed: 'generator-smoke', at: AT, toolRevision: 'fixture' });
assert.equal(sha256Value(first.record), sha256Value(second.record));
assert.equal(first.record.id, second.record.id);
const validation = validateResearchRecord(first.record);
assert.equal(validation.valid, true, validation.errors.join('\n'));
assert.equal(first.nativeLevel.survival.enabled, false);
assert.equal(first.nativeLevel.survival.worldHeight, 600);
assert.ok(first.nativeLevel.pegs.some(peg => peg.shape === 'brick'));
assert.ok(first.nativeLevel.pegs.some(peg => peg.shape === 'circle'));
const structural = evaluateStructuralGates(first.record, pacing);
assert.ok(!structural.failures.includes('schema-invalid'));
assert.ok(!structural.failures.includes('out-of-bounds'));
assert.ok(!structural.failures.includes('object-overlap'));
assert.ok(structural.composition.sourceLevelCount >= 2);
console.log('generator smoke ok');
