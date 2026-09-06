#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeLevelToResearchRecord } from '../../js/research-format.js';
import { generateConstructiveLevel } from '../generator/lib/constructive-generator.mjs';
import { evaluateStructuralGates } from '../generator/lib/harness.mjs';
import { validateResearchRecord } from './validate-record.mjs';
import { readJson, sha256Value } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = { root: path.join(GAME_ROOT, 'research', 'generated', 'generator-v0') };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') options.root = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return options;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyGeneratorPipeline(options) {
  const manifest = await readJson(path.join(options.root, 'manifest.json'));
  const library = await readJson(path.join(options.root, 'foundation', 'motif-library.json'));
  const pacing = await readJson(path.join(options.root, 'foundation', 'vertical-profile.json'));
  requireCondition(library.format === 'peggle-motif-library', 'Invalid motif library format.');
  requireCondition(library.counts.generatorEligible >= 100, 'Motif library is unexpectedly small.');
  requireCondition(pacing.format === 'peggle-vertical-pacing-profile', 'Invalid vertical pacing profile format.');
  requireCondition(pacing.eligibleProfileCount >= 5, 'Too few authored portrait pacing profiles.');
  requireCondition(pacing.viewport.width === 400 && pacing.viewport.height === 600, 'Generator target viewport must be 400x600.');
  requireCondition(manifest.format === 'peggle-generator-batch' && manifest.complete, 'Generator batch is incomplete.');
  requireCondition(manifest.acceptedCount === manifest.accepted.length && manifest.acceptedCount === manifest.requestedCount, 'Accepted counts do not match.');
  const templateIds = new Set([...library.templates, ...(library.generatorFragments || [])].map(template => template.id));
  for (const entry of manifest.accepted) {
    const record = await readJson(path.resolve(options.root, entry.recordPath));
    const nativeLevel = await readJson(path.resolve(options.root, entry.nativeLevelPath));
    const harness = await readJson(path.resolve(options.root, entry.harnessPath));
    const validation = validateResearchRecord(record);
    requireCondition(validation.valid, `${entry.id}: invalid research record: ${validation.errors.join('; ')}`);
    requireCondition(record.id === entry.id, `${entry.id}: record identity mismatch.`);
    requireCondition(sha256Value(record) === entry.recordSha256, `${entry.id}: record digest mismatch.`);
    requireCondition(sha256Value(nativeLevel) === entry.nativeLevelSha256, `${entry.id}: native-level digest mismatch.`);
    requireCondition(harness.status === 'passed', `${entry.id}: persisted harness did not pass.`);
    const structural = evaluateStructuralGates(record, pacing);
    requireCondition(structural.status === 'passed', `${entry.id}: structural gates no longer pass: ${structural.failures.join(', ')}`);
    requireCondition(nativeLevel.survival?.enabled === false && nativeLevel.survival?.worldHeight === 600, `${entry.id}: native standard-level height is wrong.`);
    requireCondition(nativeLevel.pegs.length === record.authored.objects.length, `${entry.id}: native peg count mismatch.`);
    const roundTrip = nativeLevelToResearchRecord(nativeLevel, {
      id: `${entry.id}:round-trip`, sourceRevision: 'generator-verifier', at: manifest.createdAt
    });
    const roundTripValidation = validateResearchRecord(roundTrip);
    requireCondition(roundTripValidation.valid, `${entry.id}: native round-trip is invalid.`);
    const roundTripById = new Map(roundTrip.authored.objects.map(object => [object.id, object]));
    requireCondition(record.authored.objects.every(object => {
      const restored = roundTripById.get(object.id);
      return restored && restored.kind === object.kind && restored.targetType === object.targetType
        && restored.transform.x === object.transform.x && restored.transform.y === object.transform.y
        && restored.transform.rotation === object.transform.rotation;
    }), `${entry.id}: native round-trip changed target geometry.`);
    const recipe = record.extensions?.generatorRecipe;
    requireCondition(recipe?.placements?.length >= 2, `${entry.id}: missing constructive recipe.`);
    requireCondition(recipe.placements.every(placement => templateIds.has(placement.templateId)), `${entry.id}: recipe references an unknown motif.`);
    const preview = await readFile(path.resolve(options.root, entry.previewPath), 'utf8');
    requireCondition(preview.includes('data-role="launch-axis"'), `${entry.id}: preview lacks launcher axis evidence.`);
  }
  const first = manifest.accepted[0];
  const regenerated = generateConstructiveLevel(library, pacing, {
    seed: first.seed,
    at: manifest.createdAt,
    toolRevision: manifest.tool.version
  });
  requireCondition(regenerated.record.id === first.id, 'Deterministic regeneration changed the first level id.');
  requireCondition(sha256Value(regenerated.record) === first.recordSha256, 'Deterministic regeneration changed the first record digest.');
  const reviewPath = path.join(options.root, 'review', 'benchmark.json');
  try {
    await access(reviewPath);
    const review = await readJson(reviewPath);
    requireCondition(review.reviewPairs.length > manifest.acceptedCount, 'Generator review lacks balanced repeated comparisons.');
    for (const pair of review.reviewPairs) {
      for (const side of ['left', 'right']) await access(path.resolve(path.dirname(reviewPath), pair[side].previewPath));
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Generator review queue has not been built.');
    throw error;
  }
  return {
    status: 'passed',
    acceptedCount: manifest.acceptedCount,
    motifTemplateCount: library.counts.templates,
    eligibleMotifCount: library.counts.generatorEligible,
    pacingProfileCount: pacing.eligibleProfileCount
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await verifyGeneratorPipeline(options);
  console.log(`generator pipeline verified: ${result.acceptedCount} levels, ${result.eligibleMotifCount} eligible motifs, ${result.pacingProfileCount} pacing profiles`);
}
