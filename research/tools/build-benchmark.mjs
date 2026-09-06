#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReferenceProfile,
  extractLevelFeatures,
  featureDelta,
  layoutFingerprint,
  scoreAgainstReference,
  selectDiverseLevels
} from '../benchmark/lib/features.mjs';
import {
  crossValidateSyntheticDiscriminator,
  predictSyntheticDiscriminator
} from '../benchmark/lib/discriminator.mjs';
import { MUTATION_OPERATORS, levelMutationCapability, mutateLevel } from '../benchmark/lib/mutations.mjs';
import { createRandom } from '../benchmark/lib/random.mjs';
import { renderLevelSvg } from '../benchmark/lib/render-svg.mjs';
import { runShotSweep } from '../benchmark/lib/sweep.mjs';
import { readJson, writeJson } from './lib/node-io.mjs';
import { validateResearchRecord } from './validate-record.mjs';

const TOOL_VERSION = '0.2.0';
const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_TEMPLATE = path.join(GAME_ROOT, 'research', 'benchmark', 'review.html');

function revision() {
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

function safeName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || 'unnamed';
}

function relative(outputRoot, target) {
  return path.relative(outputRoot, target).replaceAll('\\', '/');
}

function assertValidLevel(record, label) {
  const result = validateResearchRecord(record);
  if (!result.valid || record.recordType !== 'level') {
    throw new Error(`${label} is not a valid research level: ${result.errors.join('; ')}`);
  }
}

async function loadCorpus(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readJson(absoluteManifest);
  if (manifest.format !== 'peggle-research-corpus' || !Array.isArray(manifest.records)) {
    throw new Error(`${manifestPath} is not a peggle-research-corpus manifest.`);
  }
  const root = path.dirname(absoluteManifest);
  const entries = [];
  for (const entry of manifest.records) {
    const recordPath = path.resolve(root, entry.recordPath);
    const record = await readJson(recordPath);
    assertValidLevel(record, recordPath);
    entries.push({
      ...entry,
      recordPath,
      record,
      id: record.id,
      features: extractLevelFeatures(record)
    });
  }
  return { manifestPath: absoluteManifest, manifest, entries };
}

function deduplicate(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const digest = entry.features.layoutSha256 || layoutFingerprint(entry.record);
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    adaptation: null,
    holdout: null,
    output: path.join(GAME_ROOT, 'research', 'generated', 'benchmark-v1'),
    pilotSize: 8,
    mutationCount: MUTATION_OPERATORS.length,
    reviewPairs: 20,
    simulate: 'originals',
    angleCount: 17,
    maxSteps: 3600,
    seed: 'benchmark-v1',
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--adaptation') options.adaptation = path.resolve(argv[++index]);
    else if (value === '--holdout') options.holdout = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--pilot-size') options.pilotSize = Math.max(1, Number(argv[++index]) || 1);
    else if (value === '--mutation-count') options.mutationCount = Math.max(1, Math.min(MUTATION_OPERATORS.length, Number(argv[++index]) || 1));
    else if (value === '--review-pairs') options.reviewPairs = Math.max(1, Number(argv[++index]) || 1);
    else if (value === '--simulate') options.simulate = argv[++index];
    else if (value === '--angle-count') options.angleCount = Math.max(3, Number(argv[++index]) || 3);
    else if (value === '--max-steps') options.maxSteps = Math.max(1, Number(argv[++index]) || 1);
    else if (value === '--seed') options.seed = argv[++index];
    else if (value === '--at') options.at = argv[++index];
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (!positional[0]) throw new Error('A reference corpus.json path is required.');
  if (!['none', 'originals', 'all'].includes(options.simulate)) {
    throw new Error('--simulate must be none, originals, or all.');
  }
  options.reference = path.resolve(positional[0]);
  return options;
}

function adaptationSummary(corpus) {
  if (!corpus) return null;
  const unique = deduplicate(corpus.entries.filter(entry => entry.features.counts.targets > 0));
  const primary = deduplicate(corpus.entries.filter(entry => entry.primaryCampaign && entry.features.counts.targets > 0));
  return {
    corpusId: corpus.manifest.id,
    manifestPath: corpus.manifestPath,
    indexed: corpus.entries.length,
    nonemptyUniqueLayouts: unique.length,
    primaryCampaignUniqueLayouts: primary.length,
    role: 'mechanics-and-target-domain-adaptation-not-quality-positive',
    mechanics: [...new Set(primary.flatMap(entry => {
      const mechanics = entry.record.authored.mechanics || {};
      return Object.entries(mechanics)
        .filter(([_key, value]) => value && typeof value === 'object' && value.enabled === true)
        .map(([key]) => key);
    }))].sort()
  };
}

function makeReviewPairs(levels, limit, seed) {
  const random = createRandom(`${seed}:review`);
  const candidates = [];
  for (const level of levels) {
    for (const variant of level.variants) {
      const originalSide = random.random() < 0.5 ? 'left' : 'right';
      const original = {
        levelId: level.id,
        name: level.name,
        previewPath: level.previewPath,
        role: 'reference-original'
      };
      const changed = {
        levelId: variant.id,
        name: level.name,
        previewPath: variant.previewPath,
        role: 'synthetic-perturbation',
        operator: variant.operator
      };
      candidates.push({
        id: `pair:${safeName(level.name)}:${variant.operator}`,
        prompt: 'Which layout has the stronger composition and would be more promising to play?',
        left: originalSide === 'left' ? original : changed,
        right: originalSide === 'right' ? original : changed,
        truth: { originalSide, labelStatus: 'hidden-synthetic-hypothesis' }
      });
    }
  }
  return random.shuffle(candidates).slice(0, Math.min(limit, candidates.length));
}

function compactDossier(level) {
  return {
    id: level.id,
    name: level.name,
    source: level.source,
    previewPath: level.previewPath,
    features: level.features,
    referenceScore: level.referenceScore,
    syntheticDiscriminator: level.syntheticDiscriminator,
    physics: level.physics,
    variants: level.variants.map(variant => ({
      id: variant.id,
      operator: variant.operator,
      previewPath: variant.previewPath,
      features: variant.features,
      featureDelta: variant.featureDelta,
      referenceScore: variant.referenceScore,
      syntheticDiscriminator: variant.syntheticDiscriminator,
      physics: variant.physics
    }))
  };
}

function markdownReport(benchmark) {
  const rows = benchmark.pilot.levels.map(level => (
    `| ${level.name.replaceAll('|', '\\|')} | ${level.features.counts.targets} | ${level.features.counts.obstacles} | ${level.features.counts.moving} | ${level.features.geometry.mirrorSymmetry.toFixed(2)} | ${level.referenceScore.screeningScore.toFixed(3)} | ${level.physics ? level.physics.reachableTargetFraction.toFixed(2) : 'n/a'} |`
  ));
  const mutationRows = benchmark.mutationSummary.byOperator.map(item => (
    `| ${item.operator} | ${item.count} | ${(item.referenceOriginalWinRate * 100).toFixed(0)}% | ${(item.discriminatorOriginalWinRate * 100).toFixed(0)}% | ${item.meanVariantValidity.toFixed(3)} | ${item.meanVariantConformity.toFixed(3)} |`
  ));
  return `# Peggle quality benchmark v1

Generated: ${benchmark.createdAt}

This is a screening benchmark, not a trained definition of fun. Original
commercial layouts are professional reference examples. Synthetic mutations are
negative hypotheses awaiting blind human review. Production Alea levels are used
as target-domain/mechanics adaptation data, not silently promoted to positives.

## Corpus

- Reference corpus: ${benchmark.referenceCorpus.corpusId}
- Eligible unique reference layouts: ${benchmark.referenceCorpus.eligibleUniqueLayouts}
- Mutation-safe reference layouts: ${benchmark.referenceCorpus.mutationSafeLayouts}
- Pilot selection: ${benchmark.pilot.levels.length} layouts via deterministic farthest-point coverage
- Synthetic variants: ${benchmark.mutationSummary.totalVariants}
- Blind review queue: ${benchmark.reviewPairs.length} pairs
- Physics mode: ${benchmark.physicsConfiguration.mode}
${benchmark.externalHoldout ? `- External holdout: ${benchmark.externalHoldout.corpusId} (${benchmark.externalHoldout.levelCount} levels, ${benchmark.externalHoldout.variantCount} unseen variants)` : ''}

## Pilot

| Level | Targets | Obstacles | Moving | Mirror symmetry | Screening | Sweep reachability |
|---|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

## Mutation sanity check

The win rate below asks only whether the reference layout has the higher
validity-plus-reference-conformity screening score. It does not establish that
the reference is more fun.

| Operator | Variants | Profile wins | Discriminator wins | Variant validity | Variant conformity |
|---|---:|---:|---:|---:|---:|
${mutationRows.join('\n')}

Overall profile win rate: ${(benchmark.mutationSummary.referenceOriginalWinRate * 100).toFixed(1)}%.

Grouped out-of-fold synthetic-discriminator pair win rate: ${(benchmark.mutationSummary.syntheticDiscriminator.crossValidation.metrics.withinParentPairWinRate * 100).toFixed(1)}%; balanced accuracy: ${(benchmark.mutationSummary.syntheticDiscriminator.crossValidation.metrics.balancedAccuracy * 100).toFixed(1)}%; ROC AUC: ${benchmark.mutationSummary.syntheticDiscriminator.crossValidation.metrics.rocAuc.toFixed(3)}.
${benchmark.externalHoldout ? `
External-corpus pair win rate: ${(benchmark.externalHoldout.discriminatorOriginalWinRate * 100).toFixed(1)}%. This is the more important transfer check because neither the Nights layouts nor their mutations were used to fit the discriminator.
` : ''}

## Interpretation boundaries

- Reference conformity detects distribution shift; it must not become a copy-the-corpus objective.
- Every reviewed target is a verified static circle or straight brick. Curved and moving layouts remain in the reference corpus but are not object-wise mutated.
- The headless sweep uses the target game's static PhysicsEngine subset and one shot per angle.
- Source animation, complete turn strategy, power-ups, orange assignment, camera pacing, and subjective quality remain outside this pilot.
- Human A/B decisions exported by review.html are the next calibration layer.
`;
}

export async function buildBenchmark(options) {
  const referenceCorpus = await loadCorpus(options.reference);
  const adaptationCorpus = options.adaptation ? await loadCorpus(options.adaptation) : null;
  const holdoutCorpus = options.holdout ? await loadCorpus(options.holdout) : null;
  const eligible = deduplicate(referenceCorpus.entries.filter(entry => (
    entry.features.counts.targets >= 10
    && entry.features.diagnostics.finiteFraction === 1
  )));
  const mutationSafe = eligible.filter(entry => levelMutationCapability(entry.record).eligible);
  if (mutationSafe.length < options.pilotSize) {
    throw new Error(`Only ${mutationSafe.length} mutation-safe reference levels; cannot select ${options.pilotSize}.`);
  }
  const profile = buildReferenceProfile(eligible.map(entry => entry.features));
  let selected;
  if (Array.isArray(options.pilotLevelIds) && options.pilotLevelIds.length) {
    const byId = new Map(mutationSafe.map(entry => [entry.id, entry]));
    const pinned = options.pilotLevelIds.map(id => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`Pinned pilot level is unavailable or mutation-unsafe: ${id}`);
      return entry;
    });
    if (new Set(pinned.map(entry => entry.id)).size !== pinned.length) throw new Error('Pinned pilot levels contain duplicates.');
    const remaining = mutationSafe.filter(entry => !pinned.some(item => item.id === entry.id));
    const additionalCount = Math.max(0, options.pilotSize - pinned.length);
    selected = [
      ...pinned,
      ...(additionalCount ? selectDiverseLevels(remaining, additionalCount) : [])
    ].slice(0, options.pilotSize);
  } else {
    selected = selectDiverseLevels(mutationSafe, options.pilotSize);
  }
  const toolRevision = revision();
  const pilotLevels = [];
  const availableOperators = options.mutationOperators || MUTATION_OPERATORS;
  const mutationOperators = availableOperators.slice(0, Math.min(options.mutationCount, availableOperators.length));
  for (let levelIndex = 0; levelIndex < selected.length; levelIndex++) {
    const entry = selected[levelIndex];
    const stem = `${String(levelIndex + 1).padStart(2, '0')}-${safeName(entry.record.authored.name)}`;
    const originalRecordPath = path.join(options.output, 'levels', 'originals', `${stem}.json`);
    const originalPreviewPath = path.join(options.output, 'previews', 'originals', `${stem}.svg`);
    await writeJson(originalRecordPath, entry.record);
    await mkdir(path.dirname(originalPreviewPath), { recursive: true });
    await writeFile(originalPreviewPath, renderLevelSvg(entry.record, { title: entry.record.authored.name }), 'utf8');
    const originalPhysics = options.simulate === 'none' ? null : await runShotSweep(entry.record, {
      angleCount: options.angleCount,
      maxSteps: options.maxSteps,
      seed: `${options.seed}:${entry.record.id}`,
      at: options.at
    });
    const original = {
      id: entry.record.id,
      name: entry.record.authored.name,
      source: {
        corpusId: referenceCorpus.manifest.id,
        archiveEntry: entry.archiveEntry || null,
        sourceSha256: entry.sourceSha256 || entry.record.provenance.source.sha256 || null
      },
      recordPath: relative(options.output, originalRecordPath),
      previewPath: relative(options.output, originalPreviewPath),
      features: entry.features,
      referenceScore: scoreAgainstReference(entry.features, profile),
      physics: originalPhysics,
      capabilities: { mutation: levelMutationCapability(entry.record) },
      variants: []
    };
    for (let mutationIndex = 0; mutationIndex < mutationOperators.length; mutationIndex++) {
      const operator = mutationOperators[mutationIndex];
      const variantRecord = await mutateLevel(entry.record, operator, {
        seed: `${options.seed}:${levelIndex}:${mutationIndex}`,
        at: options.at,
        toolRevision
      });
      assertValidLevel(variantRecord, `${entry.record.id}/${operator}`);
      const variantStem = `${stem}-${String(mutationIndex + 1).padStart(2, '0')}-${operator}`;
      const variantRecordPath = path.join(options.output, 'levels', 'variants', `${variantStem}.json`);
      const variantPreviewPath = path.join(options.output, 'previews', 'variants', `${variantStem}.svg`);
      await writeJson(variantRecordPath, variantRecord);
      await mkdir(path.dirname(variantPreviewPath), { recursive: true });
      await writeFile(variantPreviewPath, renderLevelSvg(variantRecord, { title: entry.record.authored.name }), 'utf8');
      const variantFeatures = extractLevelFeatures(variantRecord);
      const variantPhysics = options.simulate === 'all' ? await runShotSweep(variantRecord, {
        angleCount: options.angleCount,
        maxSteps: options.maxSteps,
        seed: `${options.seed}:${variantRecord.id}`,
        at: options.at
      }) : null;
      original.variants.push({
        id: variantRecord.id,
        name: variantRecord.authored.name,
        operator,
        recordPath: relative(options.output, variantRecordPath),
        previewPath: relative(options.output, variantPreviewPath),
        features: variantFeatures,
        featureDelta: featureDelta(original.features, variantFeatures),
        referenceScore: scoreAgainstReference(variantFeatures, profile),
        physics: variantPhysics
      });
    }
    pilotLevels.push(original);
    console.log(`benchmark ${levelIndex + 1}/${selected.length}: ${original.name}`);
  }
  const allVariants = pilotLevels.flatMap(level => level.variants.map(variant => ({ level, variant })));
  const discriminatorSamples = pilotLevels.flatMap(level => ([
    {
      id: `original:${level.id}`,
      groupId: level.id,
      label: 1,
      features: level.features
    },
    ...level.variants.map(variant => ({
      id: `variant:${variant.id}`,
      groupId: level.id,
      label: 0,
      operator: variant.operator,
      features: variant.features
    }))
  ]));
  const discriminator = crossValidateSyntheticDiscriminator(discriminatorSamples, { folds: 5 });
  for (const level of pilotLevels) {
    level.syntheticDiscriminator = {
      outOfFoldProbability: discriminator.predictions[`original:${level.id}`],
      interpretation: 'probability-of-reference-original-vs-current-mutations'
    };
    for (const variant of level.variants) {
      variant.syntheticDiscriminator = {
        outOfFoldProbability: discriminator.predictions[`variant:${variant.id}`],
        interpretation: 'probability-of-reference-original-vs-current-mutations'
      };
    }
  }
  const byOperator = mutationOperators.map(operator => {
    const values = allVariants.filter(item => item.variant.operator === operator);
    return {
      operator,
      count: values.length,
      referenceOriginalWinRate: values.filter(item => item.level.referenceScore.screeningScore > item.variant.referenceScore.screeningScore).length / values.length,
      discriminatorOriginalWinRate: values.filter(item => item.level.syntheticDiscriminator.outOfFoldProbability > item.variant.syntheticDiscriminator.outOfFoldProbability).length / values.length,
      meanVariantValidity: values.reduce((sum, item) => sum + item.variant.referenceScore.validity, 0) / values.length,
      meanVariantConformity: values.reduce((sum, item) => sum + item.variant.referenceScore.referenceConformity, 0) / values.length
    };
  });
  const reviewPairs = makeReviewPairs(pilotLevels, options.reviewPairs, options.seed);
  let externalHoldout = null;
  if (holdoutCorpus) {
    const holdoutEligible = deduplicate(holdoutCorpus.entries.filter(entry => (
      entry.features.counts.targets >= 10
      && entry.features.diagnostics.finiteFraction === 1
      && levelMutationCapability(entry.record).eligible
    )));
    const holdoutLevels = selectDiverseLevels(holdoutEligible, Math.min(options.pilotSize, holdoutEligible.length));
    const holdoutRows = [];
    for (const entry of holdoutLevels) {
      const originalProbability = predictSyntheticDiscriminator(discriminator.finalModel, entry.features);
      for (const operator of mutationOperators) {
        const variant = await mutateLevel(entry.record, operator, {
          seed: `${options.seed}:external-holdout:${entry.record.id}:${operator}`,
          at: options.at,
          toolRevision
        });
        const variantFeatures = extractLevelFeatures(variant);
        holdoutRows.push({
          levelId: entry.record.id,
          levelName: entry.record.authored.name,
          operator,
          originalProbability,
          variantProbability: predictSyntheticDiscriminator(discriminator.finalModel, variantFeatures)
        });
      }
    }
    externalHoldout = {
      corpusId: holdoutCorpus.manifest.id,
      manifestPath: holdoutCorpus.manifestPath,
      selectionMethod: 'deterministic-farthest-point-over-layout-features',
      levelCount: holdoutLevels.length,
      levelNames: holdoutLevels.map(entry => entry.record.authored.name),
      variantCount: holdoutRows.length,
      discriminatorOriginalWinRate: holdoutRows.filter(row => row.originalProbability > row.variantProbability).length / holdoutRows.length,
      byOperator: mutationOperators.map(operator => {
        const values = holdoutRows.filter(row => row.operator === operator);
        return {
          operator,
          count: values.length,
          originalWinRate: values.filter(row => row.originalProbability > row.variantProbability).length / values.length
        };
      }),
      role: 'external-professional-corpus-transfer-check-not-training-data-for-the-pilot-discriminator'
    };
  }
  const benchmark = {
    format: 'peggle-quality-benchmark',
    formatVersion: 2,
    id: `benchmark:quality-v1:${safeName(options.seed)}`,
    createdAt: options.at,
    generator: { id: 'build-benchmark.mjs', version: TOOL_VERSION, revision: toolRevision },
    representation: {
      revision: 'peggleedit-semantic-v2',
      straightBricks: 'canonical-long-axis-rotation',
      curvedBricks: 'annular-sector-with-world-space-curve-slices',
      movingObjects: 'deterministic-source-initial-phase-snapshot',
      blindTitles: 'shared-parent-title-with-operator-hidden'
    },
    qualityGate: {
      status: 'passed',
      requirements: [
        'all-reviewed-targets-static',
        'all-reviewed-targets-supported-by-semantic-renderer',
        'no-curved-object-wise-mutations',
        'no-moving-object-wise-mutations',
        'mutation-identity-hidden-from-review-images'
      ]
    },
    hypotheses: {
      professionalReference: 'Original Peggle layouts are quality-positive references, subject to target-physics compatibility checks.',
      productionAdaptation: 'Alea production layouts represent target mechanics and author/domain context, not automatic quality positives.',
      syntheticNegatives: 'Mutations are expected degradations but remain unlabeled until blind review.'
    },
    referenceCorpus: {
      corpusId: referenceCorpus.manifest.id,
      manifestPath: referenceCorpus.manifestPath,
      importedLayouts: referenceCorpus.entries.length,
      eligibleUniqueLayouts: eligible.length,
      mutationSafeLayouts: mutationSafe.length,
      profile
    },
    adaptationCorpus: adaptationSummary(adaptationCorpus),
    externalHoldout,
    physicsConfiguration: {
      mode: options.simulate,
      angleCount: options.angleCount,
      maxSteps: options.maxSteps,
      engine: 'nanohit-peggle PhysicsEngine static subset'
    },
    pilot: {
      selection: {
        method: Array.isArray(options.pilotLevelIds) && options.pilotLevelIds.length
          ? 'pinned-prefix-then-deterministic-farthest-point'
          : 'deterministic-farthest-point-over-z-normalized-layout-features',
        requestedSize: options.pilotSize,
        seed: options.seed,
        manualCherryPicking: false,
        pinnedLevelIds: options.pilotLevelIds || []
      },
      levels: pilotLevels
    },
    mutationSummary: {
      operators: mutationOperators,
      totalVariants: allVariants.length,
      referenceOriginalWinRate: allVariants.filter(item => item.level.referenceScore.screeningScore > item.variant.referenceScore.screeningScore).length / allVariants.length,
      syntheticDiscriminator: {
        role: 'diagnostic-original-vs-synthetic-discriminator-not-human-quality-model',
        crossValidation: {
          method: discriminator.method,
          foldCount: discriminator.foldCount,
          folds: discriminator.folds,
          metrics: discriminator.metrics
        },
        finalModel: discriminator.finalModel
      },
      byOperator
    },
    reviewPairs
  };
  await writeJson(path.join(options.output, 'benchmark.json'), benchmark);
  await writeFile(path.join(options.output, 'report.md'), markdownReport(benchmark), 'utf8');
  await writeFile(
    path.join(options.output, 'llm-dossiers.jsonl'),
    `${pilotLevels.map(level => JSON.stringify(compactDossier(level))).join('\n')}\n`,
    'utf8'
  );
  await copyFile(REVIEW_TEMPLATE, path.join(options.output, 'review.html'));
  return benchmark;
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    await mkdir(options.output, { recursive: true });
    const benchmark = await buildBenchmark(options);
    console.log(`wrote ${path.join(options.output, 'benchmark.json')} (${benchmark.pilot.levels.length} originals, ${benchmark.mutationSummary.totalVariants} variants)`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
