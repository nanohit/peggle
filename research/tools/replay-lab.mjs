#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { researchLevelDigestPayload, stableStringify } from '../../js/research-format.js';
import { readJson, sha256Value } from './lib/node-io.mjs';
import { runHeadlessLab } from './run-lab.mjs';
import { validateResearchRecord } from './validate-record.mjs';

function requireValid(record, expectedType) {
  const validation = validateResearchRecord(record, { verifyDigests: true });
  if (!validation.valid || record.recordType !== expectedType) {
    throw new Error(`Invalid ${expectedType} record: ${validation.errors.join('; ') || `recordType is not ${expectedType}`}`);
  }
}

function requireEqual(label, expected, actual) {
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error(`${label} diverged during replay`);
  }
}

export async function verifyHeadlessLabReplay(levelRecord, runRecord) {
  requireValid(levelRecord, 'level');
  requireValid(runRecord, 'run');
  if (runRecord.reproduction.capability !== 'subset-deterministic'
      || runRecord.reproduction.tool?.id !== 'headless-research-lab') {
    throw new Error('Run is not a deterministic headless-lab record.');
  }
  const levelDigest = sha256Value(researchLevelDigestPayload(levelRecord));
  if (runRecord.levelRef.id !== levelRecord.id || runRecord.levelRef.sha256 !== levelDigest) {
    throw new Error('Run levelRef does not match the supplied level record.');
  }
  const launch = runRecord.reproduction.inputs.find(input => input.type === 'launch');
  if (!launch) throw new Error('Run does not contain a launch input.');
  const labOptions = runRecord.extensions?.labOptions || {};
  const replay = await runHeadlessLab(levelRecord, {
    angle: launch.data?.angleRadians,
    power: launch.data?.power,
    fixedStepSeconds: runRecord.reproduction.fixedStepSeconds,
    physicsConfig: runRecord.reproduction.physicsConfig,
    seed: runRecord.reproduction.seed.master,
    maxSteps: labOptions.maxSteps,
    checkpointEvery: labOptions.checkpointEvery,
    at: runRecord.provenance.ingestion.at
  });
  requireEqual(
    'checkpoints',
    runRecord.checkpoints.map(({ step, sha256 }) => ({ step, sha256 })),
    replay.checkpoints.map(({ step, sha256 }) => ({ step, sha256 }))
  );
  requireEqual('events', runRecord.events, replay.events);
  requireEqual('measurements', runRecord.measurements, replay.measurements);
  return replay;
}

async function main(argv) {
  const [levelPath, runPath] = argv;
  if (!levelPath || !runPath) {
    console.error('Usage: node research/tools/replay-lab.mjs <research-level.json> <headless-run.json>');
    process.exitCode = 2;
    return;
  }
  const level = await readJson(levelPath);
  const run = await readJson(runPath);
  await verifyHeadlessLabReplay(level, run);
  console.log(`ok replay ${runPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
