#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applyBezierSemanticPatch,
  captureBezierSemanticState,
  diffBezierSemanticStates,
  semanticReplayReport
} from '../../js/bezier-semantic.js';

function parseArgs(argv) {
  const options = {
    manifest: path.resolve(argv[0] || 'research/generated/repair-pilot-v0/manifest.json'),
    repairedDirectory: path.resolve(argv[1] || 'research/generated/repair-pilot-v0/repaired'),
    output: path.resolve(argv[2] || 'research/generated/repair-pilot-v0/repair-summary.json')
  };
  return options;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try { return await readJson(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readJson(options.manifest);
  const root = path.dirname(options.manifest);
  const pairs = [];
  const missing = [];
  for (const candidate of manifest.candidates || []) {
    const repairedPath = path.join(options.repairedDirectory, `${candidate.source}.level.json`);
    const repaired = await readOptionalJson(repairedPath);
    if (!repaired) {
      missing.push(candidate.source);
      continue;
    }
    const beforeLevel = await readJson(path.resolve(root, candidate.levelPath));
    const commandLog = await readOptionalJson(path.join(options.repairedDirectory, `${candidate.source}.commands.json`));
    const embeddedCommands = repaired?.metadata?.generatorProgram?.commandLog || [];
    const hints = (commandLog?.commands || commandLog || embeddedCommands)
      .flatMap(command => command?.patch?.hints || command?.hints || command?.type || [])
      .map(String);
    const before = captureBezierSemanticState(beforeLevel);
    const after = captureBezierSemanticState(repaired);
    // Intent is inferred from final state. The command log is deliberately only
    // a disambiguation hint, never the source of patch operations.
    const patch = diffBezierSemanticStates(before, after, { commandHints: hints });
    const replayed = applyBezierSemanticPatch(before, patch);
    const replay = semanticReplayReport(after, replayed, patch);
    pairs.push({
      source: candidate.source,
      strata: candidate.strata,
      patch,
      replay,
      publishedPair: {
        replayAccuracy: replay.replayAccuracy,
        fallbackFraction: replay.fallbackFraction
      }
    });
  }
  const strata = {};
  for (const pair of pairs) {
    for (const name of pair.strata || []) {
      strata[name] ||= [];
      strata[name].push(pair);
    }
  }
  const byStratum = Object.fromEntries(Object.entries(strata).map(([name, values]) => [name, {
    pairCount: values.length,
    meanReplayAccuracy: average(values.map(value => value.replay.replayAccuracy)),
    meanFallbackFraction: average(values.map(value => value.replay.fallbackFraction)),
    fallbackReasonCounts: values.reduce((counts, value) => {
      for (const [reason, count] of Object.entries(value.replay.fallbackReasonCounts || {})) {
        counts[reason] = (counts[reason] || 0) + count;
      }
      return counts;
    }, {}),
    languageGapReasonCounts: values.reduce((counts, value) => {
      for (const [reason, count] of Object.entries(value.patch.metrics.languageGapReasonCounts || {})) {
        counts[reason] = (counts[reason] || 0) + count;
      }
      return counts;
    }, {})
  }]));
  const report = {
    format: 'bezier-repair-summary',
    version: 1,
    phase: manifest.phase,
    confirmationEligible: manifest.phase !== 'exploratory-do-not-include-in-confirmatory-metrics',
    warning: 'Replay accuracy and fallback fraction are inseparable; do not report either alone.',
    repairedPairCount: pairs.length,
    missing,
    aggregate: {
      meanReplayAccuracy: average(pairs.map(value => value.replay.replayAccuracy)),
      meanFallbackFraction: average(pairs.map(value => value.replay.fallbackFraction))
    },
    byStratum,
    pairs
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ repairedPairCount: pairs.length, missing, aggregate: report.aggregate }, null, 2));
}

await main();
