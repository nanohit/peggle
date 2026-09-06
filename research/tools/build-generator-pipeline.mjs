#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGeneratorFoundation } from './build-generator-foundation.mjs';
import { buildGeneratorReview } from './build-generator-review.mjs';
import { generateConstructiveBatch } from './generate-constructive-levels.mjs';
import { verifyGeneratorPipeline } from './verify-generator-pipeline.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = {
    root: path.join(GAME_ROOT, 'research', 'generated', 'generator-v0'),
    count: 12,
    maxAttempts: 160,
    angleCount: 11,
    maxSteps: 2400,
    seed: 'generator-v0',
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--root') options.root = path.resolve(argv[++index]);
    else if (value === '--count') options.count = Math.max(6, Math.trunc(Number(argv[++index]) || 6));
    else if (value === '--max-attempts') options.maxAttempts = Math.max(options.count, Math.trunc(Number(argv[++index]) || options.count));
    else if (value === '--angle-count') options.angleCount = Math.max(3, Math.trunc(Number(argv[++index]) || 3));
    else if (value === '--max-steps') options.maxSteps = Math.max(300, Math.trunc(Number(argv[++index]) || 300));
    else if (value === '--seed') options.seed = argv[++index];
    else if (value === '--at') options.at = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

export async function buildGeneratorPipeline(options) {
  const foundationRoot = path.join(options.root, 'foundation');
  await buildGeneratorFoundation({
    reference: [
      path.join(GAME_ROOT, 'research', 'generated', 'peggle-deluxe', 'corpus.json'),
      path.join(GAME_ROOT, 'research', 'generated', 'peggle-nights', 'corpus.json')
    ],
    adaptation: path.join(GAME_ROOT, 'research', 'generated', 'production', 'corpus.json'),
    output: foundationRoot,
    at: options.at
  });
  await generateConstructiveBatch({
    library: path.join(foundationRoot, 'motif-library.json'),
    pacing: path.join(foundationRoot, 'vertical-profile.json'),
    output: options.root,
    count: options.count,
    maxAttempts: options.maxAttempts,
    angleCount: options.angleCount,
    maxSteps: options.maxSteps,
    seed: options.seed,
    at: options.at
  });
  await buildGeneratorReview({
    manifest: path.join(options.root, 'manifest.json'),
    output: path.join(options.root, 'review'),
    seed: `${options.seed}:review`,
    repeats: Math.min(6, Math.max(3, Math.round(options.count / 3))),
    at: options.at
  });
  return verifyGeneratorPipeline({ root: options.root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildGeneratorPipeline(options);
  console.log(`complete: generator pipeline verified with ${result.acceptedCount} candidates`);
}
