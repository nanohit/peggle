#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, writeJson } from './lib/node-io.mjs';

function parseArgs(argv) {
  if (!argv[0] || !argv[1]) throw new Error('Usage: node research/tools/summarize-generator-review.mjs <benchmark.json> <review.json> [--output summary.json]');
  const options = { benchmark: path.resolve(argv[0]), review: path.resolve(argv[1]), output: null };
  for (let index = 2; index < argv.length; index++) {
    if (argv[index] === '--output') options.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  options.output ||= path.join(path.dirname(options.review), 'generator-review-summary.json');
  return options;
}

function canonicalChoice(pair, choice) {
  if (choice === 'tie') return 'tie';
  return pair[choice]?.levelId || null;
}

export async function summarizeGeneratorReview(options) {
  const benchmark = await readJson(options.benchmark);
  const review = await readJson(options.review);
  if (review.benchmarkId !== benchmark.id || review.benchmarkCreatedAt !== benchmark.createdAt) {
    throw new Error('Review does not belong to this generator benchmark.');
  }
  const pairById = new Map(benchmark.reviewPairs.map(pair => [pair.id, pair]));
  const scores = new Map();
  const decisionByPair = new Map();
  for (const decision of review.decisions || []) {
    const pair = pairById.get(decision.pairId);
    if (!pair) throw new Error(`Unknown pair: ${decision.pairId}`);
    decisionByPair.set(pair.id, decision);
    if (pair.comparisonType === 'repeat-control') continue;
    for (const side of ['left', 'right']) {
      const id = pair[side].levelId;
      if (!scores.has(id)) scores.set(id, { levelId: id, appearances: 0, wins: 0, ties: 0, losses: 0, points: 0 });
      const score = scores.get(id);
      score.appearances++;
      if (decision.choice === 'tie') { score.ties++; score.points += 0.5; }
      else if (decision.choice === side) { score.wins++; score.points++; }
      else score.losses++;
    }
  }
  const repeatControls = benchmark.reviewPairs.filter(pair => pair.comparisonType === 'repeat-control').map(pair => {
    const repeatDecision = decisionByPair.get(pair.id);
    const sourcePair = pairById.get(pair.truth.repeatOf);
    const sourceDecision = decisionByPair.get(pair.truth.repeatOf);
    const sourceWinner = sourceDecision ? canonicalChoice(sourcePair, sourceDecision.choice) : null;
    const repeatWinner = repeatDecision ? canonicalChoice(pair, repeatDecision.choice) : null;
    return {
      pairId: pair.id,
      repeatOf: pair.truth.repeatOf,
      complete: !!sourceDecision && !!repeatDecision,
      consistent: !!sourceDecision && !!repeatDecision && sourceWinner === repeatWinner,
      sourceWinner,
      repeatWinner
    };
  });
  const ranking = [...scores.values()].map(score => ({
    ...score,
    pointRate: score.appearances ? score.points / score.appearances : 0
  })).sort((left, right) => right.pointRate - left.pointRate || right.wins - left.wins || left.levelId.localeCompare(right.levelId));
  const completedControls = repeatControls.filter(control => control.complete);
  const summary = {
    format: 'peggle-generator-review-summary',
    formatVersion: 1,
    benchmarkId: benchmark.id,
    reviewPath: options.review,
    completed: review.completed === true && (review.decisions || []).length === benchmark.reviewPairs.length,
    decisionCount: (review.decisions || []).length,
    ranking,
    repeatControls,
    repeatAgreement: completedControls.length
      ? completedControls.filter(control => control.consistent).length / completedControls.length
      : null,
    interpretation: 'Point rate is a transparent pairwise tournament score (win=1, tie=0.5, loss=0), not a learned model.'
  };
  await writeJson(options.output, summary);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await summarizeGeneratorReview(options);
  console.log(`decisions: ${summary.decisionCount}; repeat agreement: ${summary.repeatAgreement ?? 'n/a'}`);
  console.log(`summary: ${options.output}`);
}
