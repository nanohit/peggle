#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOTIF_MUTATION_OPERATORS, levelMutationCapability } from '../benchmark/lib/mutations.mjs';
import { readJson } from './lib/node-io.mjs';
import { validateResearchRecord } from './validate-record.mjs';

async function requireFile(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) {
    throw new Error(`Artifact escapes benchmark root: ${relativePath}`);
  }
  await access(absolute);
  return absolute;
}

export async function verifyBenchmark(benchmarkPath) {
  const absoluteBenchmark = path.resolve(benchmarkPath);
  const root = path.dirname(absoluteBenchmark);
  const benchmark = await readJson(absoluteBenchmark);
  if (benchmark.format !== 'peggle-quality-benchmark' || ![2, 3].includes(benchmark.formatVersion)) {
    throw new Error('Unsupported benchmark envelope.');
  }
  const expectedRepresentation = benchmark.formatVersion === 3
    ? 'peggleedit-motif-semantic-v1'
    : 'peggleedit-semantic-v2';
  if (benchmark.representation?.revision !== expectedRepresentation) {
    throw new Error('Benchmark does not use the corrected semantic representation.');
  }
  if (benchmark.qualityGate?.status !== 'passed') throw new Error('Benchmark quality gate has not passed.');
  const ids = new Set();
  const previews = new Map();
  let variantCount = 0;
  for (const level of benchmark.pilot.levels) {
    if (ids.has(level.id)) throw new Error(`Duplicate level ID: ${level.id}`);
    ids.add(level.id);
    const recordPath = await requireFile(root, level.recordPath);
    const record = await readJson(recordPath);
    const validation = validateResearchRecord(record);
    if (!validation.valid) throw new Error(`${level.recordPath}: ${validation.errors.join('; ')}`);
    const capability = levelMutationCapability(record);
    if (!capability.eligible) throw new Error(`${level.recordPath} is not mutation-safe: ${JSON.stringify(capability.reasons)}`);
    const previewPath = await requireFile(root, level.previewPath);
    const preview = await readFile(previewPath, 'utf8');
    if (!preview.includes('<svg')) throw new Error(`${level.previewPath} is not SVG.`);
    previews.set(level.id, level.previewPath);
    if (!Number.isFinite(level.syntheticDiscriminator?.outOfFoldProbability)) {
      throw new Error(`Missing discriminator probability for ${level.id}`);
    }
    for (const variant of level.variants) {
      variantCount++;
      if (ids.has(variant.id)) throw new Error(`Duplicate variant ID: ${variant.id}`);
      ids.add(variant.id);
      const variantRecordPath = await requireFile(root, variant.recordPath);
      const variantRecord = await readJson(variantRecordPath);
      const variantValidation = validateResearchRecord(variantRecord);
      if (!variantValidation.valid) throw new Error(`${variant.recordPath}: ${variantValidation.errors.join('; ')}`);
      if (!levelMutationCapability(variantRecord).eligible) throw new Error(`${variant.recordPath} lost mutation safety.`);
      const variantPreviewPath = await requireFile(root, variant.previewPath);
      const variantPreview = await readFile(variantPreviewPath, 'utf8');
      if (!variantPreview.includes('<svg')) throw new Error(`${variant.previewPath} is not SVG.`);
      if (variantPreview.includes(`[${variant.operator}]`)) {
        throw new Error(`${variant.previewPath} leaks the hidden mutation operator in its title.`);
      }
      previews.set(variant.id, variant.previewPath);
      if (!Number.isFinite(variant.syntheticDiscriminator?.outOfFoldProbability)) {
        throw new Error(`Missing discriminator probability for ${variant.id}`);
      }
      if (MOTIF_MUTATION_OPERATORS.includes(variant.operator)) {
        const mutation = variantRecord.authored?.metadata?.benchmarkMutation;
        const objectIds = mutation?.details?.objectIds;
        if (mutation?.family !== 'motif-aware'
            || !Array.isArray(objectIds)
            || objectIds.length < 3
            || new Set(objectIds).size !== objectIds.length
            || mutation.changedObjectCount !== objectIds.length
            || mutation.details?.motifSize !== objectIds.length) {
          throw new Error(`${variant.recordPath} does not preserve a whole detected motif as its mutation unit.`);
        }
      }
    }
  }
  const pairIds = new Set();
  const pairById = new Map();
  for (const pair of benchmark.reviewPairs) {
    if (pairIds.has(pair.id)) throw new Error(`Duplicate review pair ID: ${pair.id}`);
    pairIds.add(pair.id);
    for (const side of ['left', 'right']) {
      const candidate = pair[side];
      if (!ids.has(candidate.levelId)) throw new Error(`${pair.id} references unknown ${side} level ${candidate.levelId}`);
      if (previews.get(candidate.levelId) !== candidate.previewPath) throw new Error(`${pair.id} has inconsistent ${side} preview.`);
      await requireFile(root, candidate.previewPath);
    }
    if (pair.left.name !== pair.right.name) throw new Error(`${pair.id} leaks candidate identity through names.`);
    const comparisonType = pair.comparisonType || 'reference-vs-variant';
    if (comparisonType === 'reference-vs-variant') {
      if (!['left', 'right'].includes(pair.truth?.originalSide)) throw new Error(`${pair.id} has no original side truth.`);
      if (pair[pair.truth.originalSide].role !== 'reference-original') throw new Error(`${pair.id} original-side truth is inconsistent.`);
    } else if (comparisonType === 'variant-vs-variant') {
      if (pair.left.role === 'reference-original' || pair.right.role === 'reference-original') {
        throw new Error(`${pair.id} is not a true variant duel.`);
      }
      if (pair.left.parentLevelId !== pair.right.parentLevelId) throw new Error(`${pair.id} crosses parent levels.`);
    } else if (comparisonType === 'repeat-control') {
      const source = pairById.get(pair.truth?.repeatOf);
      if (!source) throw new Error(`${pair.id} repeats a pair that does not precede it.`);
      if (pair.truth?.sideMapping !== 'swapped'
          || pair.left.levelId !== source.right.levelId
          || pair.right.levelId !== source.left.levelId) {
        throw new Error(`${pair.id} is not an exact side-swapped repeat.`);
      }
    } else {
      throw new Error(`${pair.id} has unknown comparison type ${comparisonType}.`);
    }
    pairById.set(pair.id, pair);
  }
  await requireFile(root, 'report.md');
  await requireFile(root, 'review.html');
  if (benchmark.formatVersion === 3) {
    if (benchmark.reviewPairs.length !== 100 || benchmark.preferenceDesign?.counts?.total !== 100) {
      throw new Error('Preference benchmark v2 must contain exactly 100 review pairs.');
    }
    const counts = benchmark.preferenceDesign.counts;
    const expectedCounts = {
      carriedForward: 20,
      newGlobalReferencePairs: 30,
      newMotifReferencePairs: 30,
      variantDuels: 10,
      repeatControls: 10
    };
    for (const [key, expected] of Object.entries(expectedCounts)) {
      if (counts[key] !== expected) throw new Error(`Preference design ${key} must be ${expected}, found ${counts[key]}.`);
    }
    if (Object.values(benchmark.preferenceDesign.currentOperatorTotals || {}).some(count => count !== 10)) {
      throw new Error('Global operators are not balanced to 10 reference comparisons each.');
    }
    if (Object.values(benchmark.preferenceDesign.motifOperatorTotals || {}).some(count => count !== 6)) {
      throw new Error('Motif operators are not balanced to 6 reference comparisons each.');
    }
    const seedPath = await requireFile(root, 'review-seed.json');
    const seed = await readJson(seedPath);
    if (seed.benchmarkId !== benchmark.id || seed.benchmarkCreatedAt !== benchmark.createdAt) {
      throw new Error('review-seed.json does not match benchmark v2.');
    }
    if (seed.lockedDecisionCount !== 20 || seed.decisions?.length !== 20) {
      throw new Error('review-seed.json must contain exactly 20 locked decisions.');
    }
    seed.decisions.forEach((decision, index) => {
      if (decision.pairId !== benchmark.reviewPairs[index].id) {
        throw new Error(`Seeded decision ${index + 1} does not match the review-pair prefix.`);
      }
    });
    await requireFile(root, 'preference-design.md');
  }
  const dossierPath = await requireFile(root, 'llm-dossiers.jsonl');
  const dossierLines = (await readFile(dossierPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  if (dossierLines.length !== benchmark.pilot.levels.length) {
    throw new Error(`Expected ${benchmark.pilot.levels.length} dossiers, found ${dossierLines.length}.`);
  }
  dossierLines.forEach((line, index) => {
    try { JSON.parse(line); } catch (error) { throw new Error(`Invalid dossier line ${index + 1}: ${error.message}`); }
  });
  return {
    benchmarkId: benchmark.id,
    originals: benchmark.pilot.levels.length,
    variants: variantCount,
    reviewPairs: benchmark.reviewPairs.length,
    dossiers: dossierLines.length,
    artifactsVerified: ids.size * 2 + 3
  };
}

async function main(argv) {
  const benchmarkPath = argv[0];
  if (!benchmarkPath) {
    console.error('Usage: node research/tools/verify-benchmark.mjs <benchmark.json>');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await verifyBenchmark(benchmarkPath);
    console.log(`ok ${result.benchmarkId}: ${result.originals} originals, ${result.variants} variants, ${result.reviewPairs} review pairs`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
