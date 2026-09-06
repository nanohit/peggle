#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLevelFeatures, layoutFingerprint } from '../benchmark/lib/features.mjs';
import { digestFile, readJson, writeJson } from './lib/node-io.mjs';

const TOOL_VERSION = '0.1.0';
const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACE_ROOT = path.resolve(GAME_ROOT, '..');

function safeName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'unnamed';
}

function sourceSystemFromPath(pakPath) {
  const normalized = pakPath.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('peggle deluxe')) return 'peggle-deluxe';
  if (normalized.includes('peggle nights')) return 'peggle-nights';
  return 'peggle-classic';
}

async function findFile(root, name) {
  const pending = [root];
  while (pending.length) {
    const current = pending.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return fullPath;
      if (entry.isDirectory()) pending.push(fullPath);
    }
  }
  return null;
}

function detectRevision() {
  const upstream = path.join(WORKSPACE_ROOT, 'upstream', 'PeggleEdit');
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: upstream,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    output: null,
    exporter: null,
    revision: detectRevision(),
    limit: Number.POSITIVE_INFINITY,
    includeTrailers: false,
    match: null,
    exclude: null
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--exporter') options.exporter = path.resolve(argv[++index]);
    else if (value === '--revision') options.revision = argv[++index];
    else if (value === '--limit') options.limit = Math.max(1, Number(argv[++index]) || 1);
    else if (value === '--include-trailers') options.includeTrailers = true;
    else if (value === '--match') options.match = new RegExp(argv[++index], 'i');
    else if (value === '--exclude') options.exclude = new RegExp(argv[++index], 'i');
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (!positional[0]) throw new Error('A main.pak path is required.');
  options.pakPath = path.resolve(positional[0]);
  options.sourceSystem = sourceSystemFromPath(options.pakPath);
  options.output ||= path.join(GAME_ROOT, 'research', 'generated', options.sourceSystem);
  return options;
}

export async function exportPakCorpus(options) {
  const exporter = options.exporter || await findFile(
    path.join(GAME_ROOT, 'research', 'tools', 'peggleedit-exporter', 'bin'),
    'PeggleEditExporter.exe'
  );
  if (!exporter) {
    throw new Error('PeggleEditExporter.exe was not found. Run research/tools/peggleedit-exporter/build.ps1 first.');
  }
  const list = execFileSync(exporter, [options.pakPath, '--list'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(entry => options.includeTrailers || /^levels[\\/]/i.test(entry))
    .filter(entry => !/[\\/]_base\.dat$/i.test(entry))
    .filter(entry => !options.match || options.match.test(entry))
    .filter(entry => !options.exclude || !options.exclude.test(entry))
    .slice(0, options.limit);
  const records = [];
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    const stem = path.win32.basename(entry, path.win32.extname(entry));
    const recordPath = path.join(options.output, 'records', `${String(index + 1).padStart(3, '0')}-${safeName(stem)}.json`);
    const stdout = execFileSync(exporter, [options.pakPath, recordPath, options.revision, entry], {
      encoding: 'utf8'
    }).trim();
    const record = await readJson(recordPath);
    const features = extractLevelFeatures(record);
    records.push({
      id: record.id,
      name: record.authored.name,
      archiveEntry: entry.replaceAll('\\', '/'),
      recordPath: path.relative(options.output, recordPath).replaceAll('\\', '/'),
      sourceSha256: record.provenance.source.sha256,
      layoutSha256: layoutFingerprint(record),
      objectCount: record.authored.objects.length,
      targetCount: features.counts.targets,
      exporterOutput: stdout
    });
  }
  const createdAt = new Date().toISOString();
  const manifest = {
    format: 'peggle-research-corpus',
    formatVersion: 1,
    id: `corpus:${options.sourceSystem}`,
    createdAt,
    provenance: {
      sourceSystem: options.sourceSystem,
      pakPath: options.pakPath,
      pakSha256: await digestFile(options.pakPath),
      parser: { id: 'PeggleEditExporter', revision: options.revision },
      exporter: { id: 'export-peggle-pak-corpus.mjs', version: TOOL_VERSION }
    },
    counts: {
      listedAndImported: records.length,
      nonempty: records.filter(entry => entry.targetCount > 0).length,
      uniqueLayouts: new Set(records.map(entry => entry.layoutSha256)).size
    },
    records
  };
  await writeJson(path.join(options.output, 'corpus.json'), manifest);
  return manifest;
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const manifest = await exportPakCorpus(options);
    console.log(`wrote ${path.join(options.output, 'corpus.json')} (${manifest.counts.listedAndImported} levels)`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
