#!/usr/bin/env node
// Round-trip test: level record -> DSL -> level record, over a corpus selection.
//
// Usage:
//   node research/dsl/run-roundtrip.mjs <corpus.json> --levels a,b,c --out <dir>
//   node research/dsl/run-roundtrip.mjs <corpus.json> --limit 8 --out <dir>
//
// Writes one DSL file, one round-trip report, and one comparison SVG per level,
// plus a summary report.md. Nothing here mutates the game or the corpora.

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { readJson, writeJson } from '../tools/lib/node-io.mjs';
import { decompileLevel } from './lib/decompile.mjs';
import { roundTrip } from './lib/roundtrip.mjs';
import { renderComparisonSvg } from './lib/render-dsl.mjs';
import { mean, round } from './lib/geometry.mjs';

function parseArguments(argv) {
  const options = { corpus: null, levels: null, limit: 8, out: null, at: '2026-09-03T00:00:00.000Z' };
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--levels') options.levels = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
    else if (token === '--limit') options.limit = Math.max(1, Math.trunc(Number(argv[++index])));
    else if (token === '--out') options.out = String(argv[++index] || '');
    else if (token === '--at') options.at = String(argv[++index] || '');
    else rest.push(token);
  }
  options.corpus = rest[0] || null;
  return options;
}

function selectRecords(corpus, options) {
  const entries = corpus.records || [];
  if (options.levels?.length) {
    const wanted = new Set(options.levels.map(value => value.toLowerCase()));
    return entries.filter(entry => wanted.has(String(entry.name || '').toLowerCase()));
  }
  return entries.filter(entry => (entry.targetCount ?? 1) > 0).slice(0, options.limit);
}

function formatRow(result) {
  const error = result.error.structural;
  return [
    result.name.padEnd(16).slice(0, 16),
    String(result.targets).padStart(5),
    String(result.coverage.strokeCount).padStart(4),
    `${Math.round(result.coverage.structuralFraction * 100)}%`.padStart(6),
    `${Math.round(result.coverage.fieldFraction * 100)}%`.padStart(5),
    `${Math.round(result.coverage.exactFraction * 100)}%`.padStart(5),
    `${result.compression.ratio}x`.padStart(6),
    String(error.median).padStart(7),
    `${Math.round(error.within2 * 100)}%`.padStart(6),
    result.verdict.status.padStart(7)
  ].join(' | ');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.corpus) {
    console.error('usage: run-roundtrip.mjs <corpus.json> [--levels a,b] [--limit N] [--out dir]');
    process.exit(2);
  }
  const corpusPath = path.resolve(options.corpus);
  const corpusRoot = path.dirname(corpusPath);
  const corpus = await readJson(corpusPath);
  const outputDir = path.resolve(options.out || path.join(corpusRoot, 'dsl-roundtrip'));
  await mkdir(path.join(outputDir, 'dsl'), { recursive: true });
  await mkdir(path.join(outputDir, 'reports'), { recursive: true });
  await mkdir(path.join(outputDir, 'previews'), { recursive: true });

  const selected = selectRecords(corpus, options);
  if (!selected.length) {
    console.error('No matching levels in corpus.');
    process.exit(1);
  }

  const results = [];
  for (const entry of selected) {
    const record = await readJson(path.resolve(corpusRoot, entry.recordPath));
    const dsl = decompileLevel(record, { at: options.at });
    const result = roundTrip(record, dsl);
    const safeName = String(dsl.name || entry.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    await writeJson(path.join(outputDir, 'dsl', `${safeName}.dsl.json`), dsl);
    await writeJson(path.join(outputDir, 'reports', `${safeName}.roundtrip.json`), result);
    await writeFile(path.join(outputDir, 'previews', `${safeName}.svg`), renderComparisonSvg(record, dsl, result), 'utf8');
    results.push(result);
  }

  const header = [
    'level'.padEnd(16), 'objs'.padStart(5), 'strk'.padStart(4), 'struct'.padStart(6),
    'field'.padStart(5), 'exact'.padStart(5), 'compr'.padStart(6), 'med px'.padStart(7),
    '<=2px'.padStart(6), 'verdict'.padStart(7)
  ].join(' | ');
  const lines = [header, '-'.repeat(header.length), ...results.map(formatRow)];

  const aggregate = {
    levels: results.length,
    meanStructuralFraction: round(mean(results.map(result => result.coverage.structuralFraction)), 3),
    meanFieldFraction: round(mean(results.map(result => result.coverage.fieldFraction)), 3),
    meanUnexplainedFraction: round(mean(results.map(result => 1 - result.coverage.explainedFraction)), 3),
    meanExactFraction: round(mean(results.map(result => result.coverage.exactFraction)), 3),
    meanCompression: round(mean(results.map(result => result.compression.ratio)), 2),
    meanStructuralMedianErrorPx: round(mean(results.map(result => result.error.structural.median)), 3),
    meanStructuralWithin2px: round(mean(results.map(result => result.error.structural.within2)), 3),
    good: results.filter(result => result.verdict.status === 'good').length
  };

  const report = [
    `# DSL round-trip: ${corpus.id}`,
    '',
    `Generated: ${options.at}`,
    '',
    '```',
    ...lines,
    '```',
    '',
    '## Aggregate',
    '',
    ...Object.entries(aggregate).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Reading this table',
    '',
    '- `struct` — share of objects claimed by a stroke that encodes an authoring gesture',
    '  (arc, line, path, brick chain, bezier). This is the share a grammar could generate.',
    '- `field` — share claimed only as scattered filler: a region, a population, and a',
    '  packing distance. Reproducible statistically, never peg for peg.',
    '- `exact` — share recovered by inverting stored authoring parameters rather than fitting.',
    '- `compr` — raw coordinate numbers divided by DSL numbers. A description that just',
    '  relisted the points would score 1x and would prove nothing.',
    '- `med px` / `<=2px` — ordered per-stroke replay error, structural strokes only.',
    '  Fields are excluded here on purpose and judged distributionally in the JSON.',
    ''
  ].join('\n');
  await writeFile(path.join(outputDir, 'report.md'), report, 'utf8');
  await writeJson(path.join(outputDir, 'summary.json'), { corpusId: corpus.id, aggregate, results });

  console.log(report);
  console.log(`Written to ${outputDir}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
