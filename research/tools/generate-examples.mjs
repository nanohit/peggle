#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importGameLevel } from './import-game-level.mjs';
import { importHaggleTelemetry } from './import-haggle-telemetry.mjs';
import { sha256Value, writeJson } from './lib/node-io.mjs';
import { runHeadlessLab } from './run-lab.mjs';
import { researchLevelDigestPayload } from '../../js/research-format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-08-09T00:00:00.000Z';
const REVISION = 'synthetic-fixture-v1';

const level = await importGameLevel(path.join(ROOT, 'research', 'fixtures', 'native-mini.json'), {
  gameRevision: REVISION,
  at: AT
});
const levelPath = path.join(ROOT, 'research', 'examples', 'native-mini.level.json');
await writeJson(levelPath, level);

const run = await runHeadlessLab(level, {
  angle: Math.PI / 2,
  power: 7.5,
  maxSteps: 1600,
  checkpointEvery: 30,
  seed: 'synthetic-fixture',
  at: AT
});
const runPath = path.join(ROOT, 'research', 'examples', 'native-mini.run.json');
await writeJson(runPath, run);

const flashPath = path.join(ROOT, 'research', 'examples', 'flash-mini.level.json');
execFileSync('python', [
  path.join(ROOT, 'research', 'tools', 'extract_peggle_flash.py'),
  path.join(ROOT, 'research', 'fixtures', 'flash-mini.dat.xml'),
  flashPath,
  '--revision', REVISION,
  '--at', AT
], { cwd: ROOT, stdio: 'inherit' });

const haggleRun = await importHaggleTelemetry(path.join(ROOT, 'research', 'fixtures', 'haggle-mini.jsonl'), {
  levelId: level.id,
  levelSha256: sha256Value(researchLevelDigestPayload(level)),
  haggleRevision: REVISION,
  executableSha256: '0'.repeat(64),
  at: AT
});
const hagglePath = path.join(ROOT, 'research', 'examples', 'haggle-mini.run.json');
await writeJson(hagglePath, haggleRun);

console.log(`wrote ${path.relative(ROOT, levelPath)}`);
console.log(`wrote ${path.relative(ROOT, runPath)}`);
console.log(`wrote ${path.relative(ROOT, flashPath)}`);
console.log(`wrote ${path.relative(ROOT, hagglePath)}`);
