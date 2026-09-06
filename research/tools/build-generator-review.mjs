#!/usr/bin/env node

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRandom } from '../benchmark/lib/random.mjs';
import { renderLevelSvg } from '../benchmark/lib/render-svg.mjs';
import { readJson, writeJson } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_TEMPLATE = path.join(GAME_ROOT, 'research', 'benchmark', 'review.html');

function parseArgs(argv) {
  const options = {
    manifest: path.join(GAME_ROOT, 'research', 'generated', 'generator-v0', 'manifest.json'),
    output: path.join(GAME_ROOT, 'research', 'generated', 'generator-v0', 'review'),
    seed: 'generator-v0-review',
    repeats: 4,
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--manifest') options.manifest = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--seed') options.seed = argv[++index];
    else if (value === '--repeats') options.repeats = Math.max(0, Math.trunc(Number(argv[++index]) || 0));
    else if (value === '--at') options.at = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function candidateSide(candidate, previewPath) {
  return {
    levelId: candidate.id,
    name: 'Candidate',
    previewPath,
    role: 'constructive-generator-candidate'
  };
}

function repeatPair(pair, index) {
  return {
    ...pair,
    id: `pair:repeat-control:${String(index + 1).padStart(2, '0')}:${safeName(pair.id)}`,
    comparisonType: 'repeat-control',
    left: pair.right,
    right: pair.left,
    truth: { repeatOf: pair.id, sideMapping: 'swapped', labelStatus: 'hidden-consistency-control' }
  };
}

export async function buildGeneratorReview(options) {
  const manifest = await readJson(options.manifest);
  if (manifest.format !== 'peggle-generator-batch' || !manifest.complete) throw new Error('A complete generator batch is required.');
  if (manifest.accepted.length < 6) throw new Error('At least six accepted candidates are required for balanced review.');
  const root = path.dirname(options.manifest);
  const previewDirectory = path.join(options.output, 'previews');
  await rm(options.output, { recursive: true, force: true });
  await mkdir(previewDirectory, { recursive: true });
  const candidates = [];
  for (const candidate of manifest.accepted) {
    const record = await readJson(path.resolve(root, candidate.recordPath));
    const filename = `${String(candidate.index).padStart(3, '0')}-${safeName(candidate.id.split(':').at(-1))}.svg`;
    const previewPath = path.join(previewDirectory, filename);
    await writeFile(previewPath, renderLevelSvg(record, { showTitle: false }), 'utf8');
    candidates.push({ ...candidate, reviewPreviewPath: `previews/${filename}` });
  }
  const random = createRandom(options.seed);
  const offsets = candidates.length >= 10 ? [1, Math.floor(candidates.length / 2) - 1] : [1, 2];
  const seen = new Set();
  const uniquePairs = [];
  for (const offset of offsets) {
    for (let index = 0; index < candidates.length; index++) {
      const otherIndex = (index + offset) % candidates.length;
      if (otherIndex === index) continue;
      const key = [index, otherIndex].sort((a, b) => a - b).join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const pairCandidates = random.random() < 0.5
        ? [candidates[index], candidates[otherIndex]]
        : [candidates[otherIndex], candidates[index]];
      uniquePairs.push({
        id: `pair:generator-v0:${String(uniquePairs.length + 1).padStart(3, '0')}`,
        comparisonType: 'generator-candidate-vs-candidate',
        prompt: 'Which layout has the stronger global composition and offers more promising shots?',
        left: candidateSide(pairCandidates[0], pairCandidates[0].reviewPreviewPath),
        right: candidateSide(pairCandidates[1], pairCandidates[1].reviewPreviewPath),
        truth: { labelStatus: 'no-assumed-winner' }
      });
    }
  }
  const shuffled = random.shuffle(uniquePairs);
  const repeatSources = random.shuffle(shuffled).slice(0, Math.min(options.repeats, shuffled.length));
  const reviewPairs = [...shuffled, ...repeatSources.map(repeatPair)];
  const benchmark = {
    format: 'peggle-benchmark',
    formatVersion: 2,
    id: `generator-review:constructive-v0:${options.seed}`,
    createdAt: options.at,
    representation: { revision: 'generator-semantic-v1-portrait-400x600' },
    purpose: 'Targeted human ranking of harness-passing constructive candidates; no synthetic mutation labels and no ML.',
    sourceManifest: path.relative(options.output, options.manifest).replaceAll('\\', '/'),
    reviewDesign: {
      uniquePairCount: uniquePairs.length,
      repeatControlCount: reviewPairs.length - uniquePairs.length,
      candidateCount: candidates.length,
      axes: ['global composition', 'promising shot structure'],
      note: 'Rectangular-peg validity and coarse playability already passed automated gates.'
    },
    reviewPairs
  };
  await Promise.all([
    writeJson(path.join(options.output, 'benchmark.json'), benchmark),
    copyFile(REVIEW_TEMPLATE, path.join(options.output, 'review.html'))
  ]);
  return benchmark;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const benchmark = await buildGeneratorReview(options);
  console.log(`generator review: ${benchmark.reviewPairs.length} pairs`);
  console.log(`open after serving: ${path.join(options.output, 'review.html')}`);
}
