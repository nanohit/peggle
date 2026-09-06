#!/usr/bin/env node

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloneResearchValue } from '../../js/research-format.js';
import { peggleEditCoordinateContract, PEGGLEEDIT_PLAYFIELD } from '../benchmark/lib/coordinate-space.mjs';
import { createRandom } from '../benchmark/lib/random.mjs';
import { renderLevelSvg } from '../benchmark/lib/render-svg.mjs';
import { readJson, sha256Value, writeJson } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_TEMPLATE = path.join(GAME_ROOT, 'research', 'benchmark', 'review.html');

function parseArgs(argv) {
  const options = {
    benchmark: path.join(GAME_ROOT, 'research', 'generated', 'benchmark-v2', 'benchmark.json'),
    review: path.join(process.env.USERPROFILE || 'C:\\Users\\Pavel', 'Downloads', 'benchmark-review-benchmark-preference-v2-deluxe-100.json'),
    output: path.join(GAME_ROOT, 'research', 'generated', 'coordinate-transfer-audit-v1'),
    count: 30,
    seed: 'coordinate-transfer-audit-v1',
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--benchmark') options.benchmark = path.resolve(argv[++index]);
    else if (value === '--review') options.review = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--count') options.count = Math.max(1, Math.trunc(Number(argv[++index]) || 1));
    else if (value === '--seed') options.seed = argv[++index];
    else if (value === '--at') options.at = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function candidateIndex(benchmark) {
  const result = new Map();
  for (const level of benchmark.pilot?.levels || []) {
    result.set(level.id, level);
    for (const variant of level.variants || []) result.set(variant.id, variant);
  }
  return result;
}

function correctCoordinateContract(sourceRecord, at) {
  const record = cloneResearchValue(sourceRecord);
  const contract = peggleEditCoordinateContract();
  record.authored.coordinateSystem = {
    ...record.authored.coordinateSystem,
    revision: contract.revision,
    bounds: contract.bounds,
    viewport: contract.viewport,
    sourceFrame: contract.sourceFrame
  };
  record.authored.mechanics = {
    ...record.authored.mechanics,
    launchAxis: contract.launchAxis
  };
  record.provenance.ingestion = {
    tool: 'build-coordinate-transfer-audit.mjs',
    toolVersion: '0.1.0',
    toolRevision: 'coordinate-contract-only',
    at
  };
  record.warnings = [...new Set([
    ...(record.warnings || []),
    'Coordinate transfer audit: geometry is unchanged; only the canonical PeggleEdit playfield and launcher-axis contract were corrected.'
  ])];
  return record;
}

function fitsCorrectedPlayfield(record) {
  return (record.authored?.objects || []).every(object => {
    const x = Number(object.transform?.x);
    const y = Number(object.transform?.y);
    return Number.isFinite(x) && Number.isFinite(y)
      && x >= 0 && x <= PEGGLEEDIT_PLAYFIELD.width
      && y >= 0 && y <= PEGGLEEDIT_PLAYFIELD.height;
  });
}

function decisionKey(pair) {
  const operator = pair.left.operator || pair.right.operator || 'no-operator';
  return `${pair.comparisonType || 'comparison'}:${operator}`;
}

export async function buildCoordinateTransferAudit(options) {
  const benchmark = await readJson(options.benchmark);
  const priorReview = await readJson(options.review);
  if (priorReview.benchmarkId !== benchmark.id || priorReview.benchmarkCreatedAt !== benchmark.createdAt || !priorReview.completed) {
    throw new Error('The prior review is not the completed review for this benchmark build.');
  }
  const benchmarkRoot = path.dirname(options.benchmark);
  const candidateById = candidateIndex(benchmark);
  const pairById = new Map(benchmark.reviewPairs.map(pair => [pair.id, pair]));
  const decisionById = new Map(priorReview.decisions.map(decision => [decision.pairId, decision]));
  const recordCache = new Map();
  const loadCandidate = async levelId => {
    if (recordCache.has(levelId)) return recordCache.get(levelId);
    const metadata = candidateById.get(levelId);
    if (!metadata?.recordPath) throw new Error(`Missing benchmark record path for ${levelId}.`);
    const record = await readJson(path.resolve(benchmarkRoot, metadata.recordPath));
    const value = { metadata, record };
    recordCache.set(levelId, value);
    return value;
  };
  const eligible = [];
  for (const decision of priorReview.decisions) {
    const pair = pairById.get(decision.pairId);
    if (!pair || pair.comparisonType === 'repeat-control') continue;
    const left = await loadCandidate(pair.left.levelId);
    const right = await loadCandidate(pair.right.levelId);
    if (!fitsCorrectedPlayfield(left.record) || !fitsCorrectedPlayfield(right.record)) continue;
    eligible.push({ pair, decision, key: decisionKey(pair) });
  }
  const random = createRandom(options.seed);
  const groups = new Map();
  for (const item of random.shuffle(eligible)) {
    if (!groups.has(item.key)) groups.set(item.key, []);
    groups.get(item.key).push(item);
  }
  const selected = [];
  const queues = random.shuffle([...groups.values()]);
  while (selected.length < Math.min(options.count, eligible.length) && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      if (queue.length && selected.length < options.count) selected.push(queue.shift());
    }
  }
  const levelDirectory = path.join(options.output, 'levels');
  const previewDirectory = path.join(options.output, 'previews');
  await rm(options.output, { recursive: true, force: true });
  await Promise.all([mkdir(levelDirectory, { recursive: true }), mkdir(previewDirectory, { recursive: true })]);
  const exported = new Map();
  const exportCandidate = async side => {
    if (exported.has(side.levelId)) return exported.get(side.levelId);
    const source = await loadCandidate(side.levelId);
    const corrected = correctCoordinateContract(source.record, options.at);
    const stem = `${String(exported.size + 1).padStart(3, '0')}-${safeName(side.levelId)}`;
    const recordFile = `${stem}.json`;
    const previewFile = `${stem}.svg`;
    await Promise.all([
      writeJson(path.join(levelDirectory, recordFile), corrected),
      writeFile(path.join(previewDirectory, previewFile), renderLevelSvg(corrected, { showTitle: false }), 'utf8')
    ]);
    const value = {
      levelId: side.levelId,
      name: 'Layout',
      role: side.role,
      ...(side.operator ? { operator: side.operator } : {}),
      recordPath: `levels/${recordFile}`,
      previewPath: `previews/${previewFile}`
    };
    exported.set(side.levelId, value);
    return value;
  };
  const reviewPairs = [];
  const transferMap = [];
  for (let index = 0; index < selected.length; index++) {
    const source = selected[index];
    const leftSource = await loadCandidate(source.pair.left.levelId);
    const rightSource = await loadCandidate(source.pair.right.levelId);
    const pairId = `pair:coordinate-transfer:${String(index + 1).padStart(3, '0')}`;
    reviewPairs.push({
      id: pairId,
      comparisonType: 'coordinate-contract-transfer',
      prompt: source.pair.prompt,
      left: await exportCandidate(source.pair.left),
      right: await exportCandidate(source.pair.right),
      truth: { labelStatus: 'hidden-prior-decision-transfer' }
    });
    transferMap.push({
      pairId,
      priorPairId: source.pair.id,
      priorChoice: decisionById.get(source.pair.id).choice,
      stratum: source.key,
      geometryChanged: false,
      geometrySha256: {
        left: sha256Value(leftSource.record.authored.objects),
        right: sha256Value(rightSource.record.authored.objects)
      },
      sourceRecordPaths: {
        left: leftSource.metadata.recordPath,
        right: rightSource.metadata.recordPath
      },
      oldCoordinateBounds: {
        left: cloneResearchValue(leftSource.record.authored.coordinateSystem.bounds),
        right: cloneResearchValue(rightSource.record.authored.coordinateSystem.bounds)
      },
      correctedCoordinateBounds: { minX: 0, minY: 0, maxX: 646, maxY: 543 },
      launchAxisX: 327
    });
  }
  const auditBenchmark = {
    format: 'peggle-benchmark',
    formatVersion: 2,
    id: `coordinate-transfer-audit:${options.seed}`,
    createdAt: options.at,
    representation: { revision: 'peggleedit-playfield-v1' },
    purpose: 'Measure whether prior pairwise judgments survive correction from the fabricated 800x600 frame to the real 646x543 PeggleEdit playfield.',
    reviewPairs
  };
  const auditMap = {
    format: 'peggle-coordinate-transfer-map',
    formatVersion: 1,
    sourceBenchmarkId: benchmark.id,
    sourceReview: options.review,
    eligiblePriorDecisionCount: eligible.length,
    selectedCount: selected.length,
    excludedCount: priorReview.decisions.length - eligible.length,
    mapping: transferMap
  };
  await Promise.all([
    writeJson(path.join(options.output, 'benchmark.json'), auditBenchmark),
    writeJson(path.join(options.output, 'transfer-map.json'), auditMap),
    copyFile(REVIEW_TEMPLATE, path.join(options.output, 'review.html'))
  ]);
  return { benchmark: auditBenchmark, map: auditMap };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildCoordinateTransferAudit(options);
  console.log(`coordinate transfer audit: ${result.benchmark.reviewPairs.length} pairs (${result.map.eligiblePriorDecisionCount} eligible old decisions)`);
  console.log(`audit: ${options.output}`);
}
