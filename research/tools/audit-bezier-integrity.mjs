#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { auditNativeLevelBezierIntegrity } from '../../js/bezier-integrity.js';

function parseArgs(argv) {
  const options = {
    corpus: path.resolve('research/generated/production/corpus.json'),
    output: path.resolve('research/generated/bezier-integrity'),
    repair: false,
    thresholdPx: 1
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--corpus') options.corpus = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--threshold') options.thresholdPx = Number(argv[++index]);
    else if (value === '--repair-copy') options.repair = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function auditCorpus(options) {
  const corpus = await readJson(options.corpus);
  const corpusRoot = path.dirname(options.corpus);
  const levels = [];
  const totals = {};
  for (const entry of corpus.records || []) {
    const record = await readJson(path.resolve(corpusRoot, entry.recordPath));
    const nativeLevel = record?.extensions?.nativeLevel;
    if (!nativeLevel) continue;
    const audit = auditNativeLevelBezierIntegrity(nativeLevel, {
      thresholdPx: options.thresholdPx,
      repair: options.repair
    });
    if (audit.reports.length === 0) continue;
    for (const [key, value] of Object.entries(audit.counts)) totals[key] = (totals[key] || 0) + value;
    levels.push({
      id: record.id,
      name: record.authored?.name,
      sourceRecord: entry.recordPath,
      counts: audit.counts,
      reports: audit.reports
    });
    if (options.repair) {
      const fileName = `${String(levels.length).padStart(3, '0')}-${String(record.authored?.name || 'level').replace(/[^a-z0-9._-]+/gi, '_')}.level.json`;
      await writeJson(path.join(options.output, 'repaired-copies', fileName), nativeLevel);
    }
  }
  const report = {
    format: 'bezier-integrity-audit',
    version: 1,
    corpus: path.relative(process.cwd(), options.corpus).replaceAll('\\', '/'),
    thresholdPx: options.thresholdPx,
    repairedCopiesWritten: options.repair,
    totals,
    levels
  };
  await writeJson(path.join(options.output, 'report.json'), report);
  return report;
}

const options = parseArgs(process.argv.slice(2));
const report = await auditCorpus(options);
console.log(JSON.stringify({ totals: report.totals, levels: report.levels.length }, null, 2));
