#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, writeJson } from './lib/node-io.mjs';

function parseArgs(argv) {
  if (!argv[0] || !argv[1] || !argv[2]) {
    throw new Error('Usage: node research/tools/summarize-coordinate-transfer-audit.mjs <benchmark.json> <transfer-map.json> <new-review.json> [--output summary.json]');
  }
  const options = {
    benchmark: path.resolve(argv[0]),
    map: path.resolve(argv[1]),
    review: path.resolve(argv[2]),
    output: null
  };
  for (let index = 3; index < argv.length; index++) {
    if (argv[index] === '--output') options.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  options.output ||= path.join(path.dirname(options.review), 'coordinate-transfer-summary.json');
  return options;
}

export async function summarizeCoordinateTransferAudit(options) {
  const benchmark = await readJson(options.benchmark);
  const transferMap = await readJson(options.map);
  const review = await readJson(options.review);
  if (review.benchmarkId !== benchmark.id || review.benchmarkCreatedAt !== benchmark.createdAt) {
    throw new Error('New review does not belong to this coordinate-transfer audit.');
  }
  const newByPair = new Map((review.decisions || []).map(decision => [decision.pairId, decision.choice]));
  const comparisons = transferMap.mapping.map(item => ({
    pairId: item.pairId,
    priorPairId: item.priorPairId,
    stratum: item.stratum,
    priorChoice: item.priorChoice,
    correctedChoice: newByPair.get(item.pairId) || null,
    agrees: newByPair.has(item.pairId) ? newByPair.get(item.pairId) === item.priorChoice : null
  }));
  const completed = comparisons.filter(item => item.correctedChoice != null);
  const byStratum = Object.fromEntries([...new Set(completed.map(item => item.stratum))].sort().map(stratum => {
    const items = completed.filter(item => item.stratum === stratum);
    return [stratum, {
      count: items.length,
      agreement: items.length ? items.filter(item => item.agrees).length / items.length : null
    }];
  }));
  const agreement = completed.length ? completed.filter(item => item.agrees).length / completed.length : null;
  const summary = {
    format: 'peggle-coordinate-transfer-summary',
    formatVersion: 1,
    benchmarkId: benchmark.id,
    completedCount: completed.length,
    requestedCount: comparisons.length,
    agreement,
    byStratum,
    comparisons,
    interpretation: agreement == null
      ? 'No corrected decisions are available yet.'
      : agreement >= 0.8
        ? 'Prior pairwise labels are broadly transferable after the coordinate correction.'
        : agreement >= 0.65
          ? 'Prior labels are partly transferable; use corrected-coordinate decisions for sensitive cases.'
          : 'The presentation error materially affected judgments; do not carry the old labels forward.'
  };
  await writeJson(options.output, summary);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await summarizeCoordinateTransferAudit(options);
  console.log(`coordinate decision agreement: ${summary.agreement ?? 'n/a'} (${summary.completedCount}/${summary.requestedCount})`);
  console.log(`summary: ${options.output}`);
}
