#!/usr/bin/env node

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateConstructiveLevel } from '../generator/lib/constructive-generator.mjs';
import { runGeneratorHarness } from '../generator/lib/harness.mjs';
import { renderLevelSvg } from '../benchmark/lib/render-svg.mjs';
import { readJson, sha256Value, writeJson } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL_VERSION = '0.1.0';

function parseArgs(argv) {
  const outputDefault = path.join(GAME_ROOT, 'research', 'generated', 'generator-v0');
  const options = {
    library: path.join(outputDefault, 'foundation', 'motif-library.json'),
    pacing: path.join(outputDefault, 'foundation', 'vertical-profile.json'),
    output: outputDefault,
    count: 12,
    maxAttempts: 120,
    angleCount: 11,
    maxSteps: 2400,
    seed: 'generator-v0',
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--library') options.library = path.resolve(argv[++index]);
    else if (value === '--pacing') options.pacing = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--count') options.count = Math.max(1, Math.trunc(Number(argv[++index]) || 1));
    else if (value === '--max-attempts') options.maxAttempts = Math.max(options.count, Math.trunc(Number(argv[++index]) || options.count));
    else if (value === '--angle-count') options.angleCount = Math.max(3, Math.trunc(Number(argv[++index]) || 3));
    else if (value === '--max-steps') options.maxSteps = Math.max(300, Math.trunc(Number(argv[++index]) || 300));
    else if (value === '--seed') options.seed = argv[++index];
    else if (value === '--at') options.at = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function relativeTo(root, absolute) {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

function reasonCounts(attempts) {
  const counts = {};
  for (const attempt of attempts) {
    for (const reason of attempt.failures || []) counts[reason] = (counts[reason] || 0) + 1;
    if (attempt.error) counts[`generation:${attempt.error}`] = (counts[`generation:${attempt.error}`] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

export async function generateConstructiveBatch(options) {
  const library = await readJson(options.library);
  const pacing = await readJson(options.pacing);
  const directories = {
    records: path.join(options.output, 'records'),
    native: path.join(options.output, 'native-levels'),
    previews: path.join(options.output, 'previews'),
    harness: path.join(options.output, 'harness')
  };
  await Promise.all(Object.values(directories).map(directory => rm(directory, { recursive: true, force: true })));
  await Promise.all(Object.values(directories).map(directory => mkdir(directory, { recursive: true })));
  const accepted = [];
  const attempts = [];
  for (let attemptIndex = 0; attemptIndex < options.maxAttempts && accepted.length < options.count; attemptIndex++) {
    const candidateSeed = `${options.seed}:${String(attemptIndex + 1).padStart(4, '0')}`;
    let candidate;
    try {
      candidate = generateConstructiveLevel(library, pacing, {
        seed: candidateSeed,
        at: options.at,
        toolRevision: TOOL_VERSION
      });
    } catch (error) {
      attempts.push({ index: attemptIndex + 1, seed: candidateSeed, status: 'rejected', error: error.message });
      continue;
    }
    const harness = await runGeneratorHarness(candidate.record, pacing, {
      at: options.at,
      physics: {
        angleCount: options.angleCount,
        maxSteps: options.maxSteps,
        seed: `${candidateSeed}:physics`
      }
    });
    const attempt = {
      index: attemptIndex + 1,
      seed: candidateSeed,
      levelId: candidate.record.id,
      status: harness.status,
      failures: harness.failures,
      targetCount: harness.structural.targetCount,
      motifGroupCount: harness.structural.composition.motifGroupCount,
      sourceLevelCount: harness.structural.composition.sourceLevelCount,
      motifTypeCount: harness.structural.composition.motifTypeCount,
      physics: harness.physics ? {
        reachableTargetFraction: harness.physics.sweep.reachableTargetFraction,
        deadShotRate: harness.physics.sweep.deadShotRate,
        bestShotHits: harness.physics.sweep.hitCount.max,
        outcomeDiversity: harness.physics.sweep.outcomeDiversity
      } : null
    };
    attempts.push(attempt);
    if (harness.status !== 'passed') continue;
    const number = String(accepted.length + 1).padStart(3, '0');
    const basename = `${number}-${candidate.record.id.split(':').at(-1)}`;
    const recordPath = path.join(directories.records, `${basename}.json`);
    const nativePath = path.join(directories.native, `${basename}.json`);
    const previewPath = path.join(directories.previews, `${basename}.svg`);
    const harnessPath = path.join(directories.harness, `${basename}.json`);
    await Promise.all([
      writeJson(recordPath, candidate.record),
      writeJson(nativePath, candidate.nativeLevel),
      writeJson(harnessPath, harness),
      writeFile(previewPath, renderLevelSvg(candidate.record), 'utf8')
    ]);
    accepted.push({
      index: accepted.length + 1,
      seed: candidateSeed,
      id: candidate.record.id,
      name: candidate.record.authored.name,
      recordPath: relativeTo(options.output, recordPath),
      nativeLevelPath: relativeTo(options.output, nativePath),
      previewPath: relativeTo(options.output, previewPath),
      harnessPath: relativeTo(options.output, harnessPath),
      recordSha256: sha256Value(candidate.record),
      nativeLevelSha256: sha256Value(candidate.nativeLevel),
      targetCount: candidate.record.authored.objects.length,
      orangeCount: candidate.recipe.orangeCount,
      motifGroupCount: candidate.recipe.placements.length,
      sourceLevelIds: [...new Set(candidate.recipe.placements.map(placement => placement.sourceLevelId))].sort(),
      motifTypes: [...new Set(candidate.recipe.placements.flatMap(placement => placement.motifTypes || [placement.motifType]))].sort(),
      physics: attempt.physics
    });
  }
  const manifest = {
    format: 'peggle-generator-batch',
    formatVersion: 1,
    id: `generator-batch:constructive-v0:${options.seed}`,
    createdAt: options.at,
    tool: { id: 'generate-constructive-levels.mjs', version: TOOL_VERSION },
    method: 'deterministic motif composition with continuous portrait pacing and hard structural/physics gates',
    inputs: {
      motifLibraryId: library.id,
      motifLibrarySha256: sha256Value(library),
      pacingProfileId: pacing.id,
      pacingProfileSha256: sha256Value(pacing)
    },
    requestedCount: options.count,
    acceptedCount: accepted.length,
    attemptedCount: attempts.length,
    complete: accepted.length === options.count,
    gateConfiguration: { angleCount: options.angleCount, maxSteps: options.maxSteps },
    rejectionReasonCounts: reasonCounts(attempts.filter(attempt => attempt.status !== 'passed')),
    accepted,
    attempts,
    limitations: [
      'Generator v0 composes only static circles and straight rectangular pegs supported by the deterministic target-game physics subset.',
      'The source motif is transformed as a whole; local peg relations are not independently randomized.',
      'Passing the harness means structurally viable, not human-approved or guaranteed fun.'
    ]
  };
  await writeJson(path.join(options.output, 'manifest.json'), manifest);
  if (!manifest.complete) {
    throw new Error(`Only ${accepted.length}/${options.count} candidates passed after ${attempts.length} attempts. See manifest.json.`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await generateConstructiveBatch(options);
  console.log(`generated: ${manifest.acceptedCount}/${manifest.attemptedCount} accepted`);
  console.log(`manifest: ${path.join(options.output, 'manifest.json')}`);
}
