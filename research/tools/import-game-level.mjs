#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeLevelToResearchRecord } from '../../js/research-format.js';
import { digestFile, readJson, writeJson } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function gameRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: GAME_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}

export async function importGameLevel(inputPath, options = {}) {
  const absoluteInput = path.resolve(inputPath);
  const level = await readJson(absoluteInput);
  const revision = String(options.gameRevision || gameRevision());
  const relativePath = path.relative(GAME_ROOT, absoluteInput).replaceAll('\\', '/');
  const record = nativeLevelToResearchRecord(level, {
    sourcePath: relativePath.startsWith('..') ? absoluteInput : relativePath,
    sourceRevision: revision,
    gameRevision: revision,
    tool: 'import-game-level.mjs',
    toolVersion: '0.1.0',
    toolRevision: revision,
    at: options.at,
    width: options.width,
    height: options.height
  });
  record.provenance.source.sha256 = await digestFile(absoluteInput);
  return record;
}

async function main(argv) {
  const [inputPath, outputPath] = argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node research/tools/import-game-level.mjs <native-level.json> <research-level.json>');
    process.exitCode = 2;
    return;
  }
  const record = await importGameLevel(inputPath);
  await writeJson(outputPath, record);
  console.log(`wrote ${outputPath} (${record.authored.objects.length} objects)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
