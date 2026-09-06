#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trainPreferenceFromReview } from '../benchmark/lib/preference-model.mjs';
import { readJson, writeJson } from './lib/node-io.mjs';

async function main(argv) {
  const [benchmarkPath, reviewPath, outputPath] = argv;
  if (!benchmarkPath || !reviewPath || !outputPath) {
    console.error('Usage: node research/tools/train-preference-model.mjs <benchmark.json> <review.json> <model.json>');
    process.exitCode = 2;
    return;
  }
  try {
    const model = trainPreferenceFromReview(await readJson(benchmarkPath), await readJson(reviewPath));
    await writeJson(outputPath, model);
    console.log(`wrote ${outputPath}: ${model.trainingPairs} pairs, held-out accuracy ${(model.crossValidation.metrics.accuracy * 100).toFixed(1)}%, gate ${model.qualityGate.status}`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

