#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, writeJson } from './lib/node-io.mjs';

export function summarizeReview(benchmark, review) {
  if (benchmark.format !== 'peggle-quality-benchmark') throw new Error('Invalid benchmark file.');
  if (review.format !== 'peggle-benchmark-review') throw new Error('Invalid review export.');
  if (![2, 3].includes(benchmark.formatVersion) || benchmark.qualityGate?.status !== 'passed') {
    throw new Error('Benchmark is not approved for review-label ingestion.');
  }
  if (review.formatVersion !== benchmark.formatVersion) {
    throw new Error(`Review format ${review.formatVersion} does not match benchmark format ${benchmark.formatVersion}.`);
  }
  if (review.benchmarkId !== benchmark.id) throw new Error('Review belongs to a different benchmark.');
  if (review.representationRevision !== benchmark.representation?.revision) {
    throw new Error('Review representation revision does not match the benchmark.');
  }
  const pairs = new Map(benchmark.reviewPairs.map(pair => [pair.id, pair]));
  const seen = new Set();
  const rows = [];
  for (const decision of review.decisions || []) {
    if (seen.has(decision.pairId)) throw new Error(`Duplicate decision for ${decision.pairId}`);
    seen.add(decision.pairId);
    const pair = pairs.get(decision.pairId);
    if (!pair) throw new Error(`Unknown pair ${decision.pairId}`);
    if (!['left', 'right', 'tie'].includes(decision.choice)) throw new Error(`Invalid choice for ${decision.pairId}`);
    const comparisonType = pair.comparisonType || 'reference-vs-variant';
    const selectedCandidate = decision.choice === 'tie' ? null : pair[decision.choice];
    if (comparisonType === 'reference-vs-variant') {
      const variantSide = pair.truth.originalSide === 'left' ? 'right' : 'left';
      const variant = pair[variantSide];
      rows.push({
        pairId: pair.id,
        comparisonType,
        operator: variant.operator,
        parentLevelId: pair[pair.truth.originalSide].levelId,
        choice: decision.choice,
        selectedLevelId: selectedCandidate?.levelId || null,
        outcome: decision.choice === 'tie'
          ? 'tie'
          : (decision.choice === pair.truth.originalSide ? 'original' : 'variant')
      });
    } else {
      rows.push({
        pairId: pair.id,
        comparisonType,
        repeatOf: pair.truth?.repeatOf || null,
        parentLevelId: pair.left.parentLevelId || pair.right.parentLevelId || null,
        choice: decision.choice,
        selectedLevelId: selectedCandidate?.levelId || null,
        selectedOperator: selectedCandidate?.operator || null,
        leftOperator: pair.left.operator || null,
        rightOperator: pair.right.operator || null,
        outcome: decision.choice === 'tie' ? 'tie' : 'selected-candidate'
      });
    }
  }
  const referenceRows = rows.filter(row => row.comparisonType === 'reference-vs-variant');
  const decided = referenceRows.filter(row => row.outcome !== 'tie');
  const operators = [...new Set(referenceRows.map(row => row.operator))].sort().map(operator => {
    const values = referenceRows.filter(row => row.operator === operator);
    const nonTies = values.filter(row => row.outcome !== 'tie');
    return {
      operator,
      reviewed: values.length,
      ties: values.filter(row => row.outcome === 'tie').length,
      originalPreferenceRate: nonTies.length
        ? nonTies.filter(row => row.outcome === 'original').length / nonTies.length
        : null
    };
  });
  const rowByPair = new Map(rows.map(row => [row.pairId, row]));
  const repeatRows = rows.filter(row => row.comparisonType === 'repeat-control').map(row => {
    const source = rowByPair.get(row.repeatOf);
    const consistent = !!source && (
      (source.outcome === 'tie' && row.outcome === 'tie')
      || (source.selectedLevelId != null && source.selectedLevelId === row.selectedLevelId)
    );
    return { ...row, sourceChoice: source?.choice || null, consistent };
  });
  return {
    format: 'peggle-benchmark-review-summary',
    formatVersion: benchmark.formatVersion,
    benchmarkId: benchmark.id,
    reviewExportedAt: review.exportedAt || null,
    counts: {
      queued: benchmark.reviewPairs.length,
      reviewed: rows.length,
      referenceComparisons: referenceRows.length,
      originalChosen: referenceRows.filter(row => row.outcome === 'original').length,
      variantChosen: referenceRows.filter(row => row.outcome === 'variant').length,
      variantDuels: rows.filter(row => row.comparisonType === 'variant-vs-variant').length,
      repeatControls: repeatRows.length,
      ties: rows.filter(row => row.outcome === 'tie').length
    },
    originalPreferenceRate: decided.length
      ? decided.filter(row => row.outcome === 'original').length / decided.length
      : null,
    byOperator: operators,
    repeatConsistency: repeatRows.length
      ? {
          reviewed: repeatRows.length,
          consistent: repeatRows.filter(row => row.consistent).length,
          rate: repeatRows.filter(row => row.consistent).length / repeatRows.length,
          controls: repeatRows
        }
      : null,
    decisions: rows,
    interpretation: 'Human calibration of synthetic negative hypotheses; variant choices identify unsafe mutation labels or useful alternative compositions.'
  };
}

async function main(argv) {
  const [benchmarkPath, reviewPath, outputPath] = argv;
  if (!benchmarkPath || !reviewPath || !outputPath) {
    console.error('Usage: node research/tools/summarize-benchmark-review.mjs <benchmark.json> <review.json> <summary.json>');
    process.exitCode = 2;
    return;
  }
  try {
    const summary = summarizeReview(await readJson(benchmarkPath), await readJson(reviewPath));
    await writeJson(outputPath, summary);
    console.log(`wrote ${outputPath} (${summary.counts.reviewed} decisions)`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
