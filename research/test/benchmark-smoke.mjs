import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneResearchValue, nativeLevelToResearchRecord } from '../../js/research-format.js';
import {
  buildReferenceProfile,
  extractLevelFeatures,
  layoutFingerprint,
  scoreAgainstReference,
  selectDiverseLevels
} from '../benchmark/lib/features.mjs';
import {
  ALL_MUTATION_OPERATORS,
  MOTIF_MUTATION_OPERATORS,
  MUTATION_OPERATORS,
  levelMutationCapability,
  mutateLevel
} from '../benchmark/lib/mutations.mjs';
import { analyzeLevelMotifs } from '../benchmark/lib/motifs.mjs';
import { PEGGLEEDIT_PLAYFIELD, launchAxisX } from '../benchmark/lib/coordinate-space.mjs';
import { renderLevelSvg } from '../benchmark/lib/render-svg.mjs';
import { runShotSweep } from '../benchmark/lib/sweep.mjs';
import { buildBenchmark } from '../tools/build-benchmark.mjs';
import { auditPeggleEditCorpus } from '../tools/audit-peggleedit-corpus.mjs';
import { readJson, writeJson } from '../tools/lib/node-io.mjs';
import { summarizeReview } from '../tools/summarize-benchmark-review.mjs';
import { validateResearchRecord } from '../tools/validate-record.mjs';
import { verifyBenchmark } from '../tools/verify-benchmark.mjs';

const AT = '2026-01-01T00:00:00.000Z';

function nativeFixture(name, offset = 0) {
  const pegs = Array.from({ length: 16 }, (_value, index) => ({
    id: `${name}-peg-${index}`,
    type: index % 5 === 0 ? 'orange' : 'blue',
    shape: index % 4 === 0 ? 'brick' : 'circle',
    x: 45 + (index % 4) * (82 + offset),
    y: 150 + Math.floor(index / 4) * (82 - offset / 2),
    angle: index % 4 === 0 ? index * 0.08 : 0,
    width: 34,
    height: 12
  }));
  return {
    version: 1,
    id: `fixture-${name}`,
    name,
    difficulty: 1,
    tags: ['fixture'],
    pegs,
    groups: [],
    metadata: {}
  };
}

function recordFor(name, offset = 0) {
  return nativeLevelToResearchRecord(nativeFixture(name, offset), {
    id: `level:fixture:${name}`,
    sourcePath: `fixture:${name}`,
    sourceRevision: 'fixture',
    gameRevision: 'fixture',
    tool: 'benchmark-smoke',
    toolVersion: '1',
    toolRevision: 'fixture',
    at: AT
  });
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'peggle-benchmark-'));
  try {
    const records = [recordFor('alpha', 0), recordFor('beta', 8), recordFor('gamma', -6)];
    const disabledSurvival = nativeFixture('disabled-survival');
    disabledSurvival.survival = { enabled: false, worldHeight: 1800 };
    const disabledRecord = nativeLevelToResearchRecord(disabledSurvival, { width: 400, height: 600, at: AT });
    assert.equal(disabledRecord.authored.coordinateSystem.bounds.maxY, 600);
    const enabledSurvival = nativeFixture('enabled-survival');
    enabledSurvival.survival = { enabled: true, worldHeight: 1800 };
    const enabledRecord = nativeLevelToResearchRecord(enabledSurvival, { width: 400, height: 600, at: AT });
    assert.equal(enabledRecord.authored.coordinateSystem.bounds.maxY, 1800);
    assert.equal(launchAxisX(disabledRecord), 200);
    assert.equal(PEGGLEEDIT_PLAYFIELD.width, 646);
    const features = records.map(extractLevelFeatures);
    assert.equal(features[0].counts.targets, 16);
    assert.equal(features[0].layoutSha256, layoutFingerprint(records[0]));
    const profile = buildReferenceProfile(features);
    const score = scoreAgainstReference(features[0], profile);
    assert.ok(score.screeningScore >= 0 && score.screeningScore <= 1);
    const selected = selectDiverseLevels(records.map((record, index) => ({
      id: record.id,
      record,
      features: features[index]
    })), 2);
    assert.equal(selected.length, 2);

    const variantIds = new Set();
    for (const operator of MUTATION_OPERATORS) {
      const variant = await mutateLevel(records[0], operator, { seed: `smoke:${operator}`, at: AT });
      const validation = validateResearchRecord(variant);
      assert.equal(validation.valid, true, validation.errors.join('\n'));
      assert.notEqual(layoutFingerprint(variant), layoutFingerprint(records[0]));
      variantIds.add(variant.id);
    }
    assert.equal(variantIds.size, MUTATION_OPERATORS.length);
    const motifAnalysis = analyzeLevelMotifs(records[0]);
    assert.ok(motifAnalysis.motifs.length > 0);
    assert.ok(motifAnalysis.summary.coverageFraction > 0.5);
    for (const operator of MOTIF_MUTATION_OPERATORS) {
      const variant = await mutateLevel(records[0], operator, { seed: `smoke:${operator}`, at: AT });
      assert.notEqual(layoutFingerprint(variant), layoutFingerprint(records[0]));
      assert.equal(variant.authored.metadata.benchmarkMutation.family, 'motif-aware');
    }
    assert.equal(ALL_MUTATION_OPERATORS.length, MUTATION_OPERATORS.length + MOTIF_MUTATION_OPERATORS.length);

    assert.match(renderLevelSvg(records[0]), /<svg[\s>]/);

    const curved = cloneResearchValue(records[0]);
    curved.authored.objects = [{
      id: 'curved-regression',
      kind: 'brick',
      role: 'target',
      targetType: 'blue',
      transform: { x: 400, y: 300, rotation: 0, scaleX: 1, scaleY: 1 },
      geometry: {
        shape: 'annular-sector',
        width: 42,
        height: 20,
        innerRadius: 90,
        outerRadius: 110,
        centerRadius: 100,
        sectorAngleDegrees: 24,
        curvePoints: 4
      },
      groupIds: [],
      properties: {}
    }];
    const curvedSvg = renderLevelSvg(curved);
    assert.match(curvedSvg, /<path[^>]+data-shape="annular-sector"/);
    assert.doesNotMatch(curvedSvg, /<rect[^>]+data-id="curved-regression"/);
    assert.equal(levelMutationCapability(curved).eligible, false);

    const moving = cloneResearchValue(records[0]);
    moving.authored.objects[0].movement = { type: 'fixture' };
    assert.equal(levelMutationCapability(moving).eligible, false);

    const sweep = await runShotSweep(records[0], { angleCount: 3, maxSteps: 900, seed: 'smoke', at: AT });
    assert.equal(sweep.angleCount, 3);
    assert.equal(sweep.outcomes.length, 3);

    const corpusRoot = path.join(temp, 'corpus');
    const manifestRecords = [];
    for (let index = 0; index < records.length; index++) {
      const recordPath = path.join(corpusRoot, 'records', `${index}.json`);
      await writeJson(recordPath, records[index]);
      manifestRecords.push({
        id: records[index].id,
        name: records[index].authored.name,
        recordPath: path.relative(corpusRoot, recordPath).replaceAll('\\', '/'),
        layoutSha256: layoutFingerprint(records[index])
      });
    }
    const manifestPath = path.join(corpusRoot, 'corpus.json');
    await writeJson(manifestPath, {
      format: 'peggle-research-corpus',
      formatVersion: 1,
      id: 'corpus:fixture',
      createdAt: AT,
      records: manifestRecords
    });
    const corpusAudit = await auditPeggleEditCorpus(manifestPath);
    assert.equal(corpusAudit.errors, 0);
    const output = path.join(temp, 'benchmark');
    const benchmark = await buildBenchmark({
      reference: manifestPath,
      adaptation: null,
      output,
      pilotSize: 2,
      mutationCount: 2,
      reviewPairs: 3,
      simulate: 'none',
      angleCount: 3,
      maxSteps: 300,
      seed: 'smoke',
      at: AT
    });
    assert.equal(benchmark.pilot.levels.length, 2);
    assert.equal(benchmark.mutationSummary.totalVariants, 4);
    assert.equal(benchmark.reviewPairs.length, 3);
    assert.equal(benchmark.formatVersion, 2);
    assert.equal(benchmark.qualityGate.status, 'passed');
    assert.equal((await readJson(path.join(output, 'benchmark.json'))).format, 'peggle-quality-benchmark');
    assert.match(await readFile(path.join(output, 'report.md'), 'utf8'), /Mutation sanity check/);
    assert.match(await readFile(path.join(output, 'review.html'), 'utf8'), /Blind composition review/);
    const verification = await verifyBenchmark(path.join(output, 'benchmark.json'));
    assert.equal(verification.variants, 4);
    const review = {
      format: 'peggle-benchmark-review',
      formatVersion: 2,
      benchmarkId: benchmark.id,
      representationRevision: benchmark.representation.revision,
      exportedAt: AT,
      decisions: benchmark.reviewPairs.slice(0, 2).map((pair, index) => ({
        pairId: pair.id,
        choice: index === 0 ? pair.truth.originalSide : 'tie'
      }))
    };
    const summary = summarizeReview(benchmark, review);
    assert.equal(summary.counts.reviewed, 2);
    assert.equal(summary.counts.originalChosen, 1);
    assert.equal(summary.counts.ties, 1);
    console.log('benchmark smoke ok');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

await main();
