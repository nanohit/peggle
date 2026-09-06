#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_MUTATION_OPERATORS,
  MOTIF_MUTATION_OPERATORS,
  MUTATION_OPERATORS
} from '../benchmark/lib/mutations.mjs';
import { createRandom } from '../benchmark/lib/random.mjs';
import { buildBenchmark } from './build-benchmark.mjs';
import { digestFile, readJson, writeJson } from './lib/node-io.mjs';

const TOOL_VERSION = '0.1.0';
const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function safeName(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'pair';
}

function parseArgs(argv) {
  const options = {
    reference: path.join(GAME_ROOT, 'research', 'generated', 'peggle-deluxe', 'corpus.json'),
    adaptation: path.join(GAME_ROOT, 'research', 'generated', 'production', 'corpus.json'),
    holdout: path.join(GAME_ROOT, 'research', 'generated', 'peggle-nights', 'corpus.json'),
    priorBenchmark: path.join(GAME_ROOT, 'research', 'generated', 'benchmark-v1', 'benchmark.json'),
    priorReview: null,
    output: path.join(GAME_ROOT, 'research', 'generated', 'benchmark-v2'),
    seed: 'deluxe-pilot-v1',
    at: new Date().toISOString(),
    angleCount: 17,
    maxSteps: 3600
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--reference') options.reference = path.resolve(argv[++index]);
    else if (value === '--adaptation') options.adaptation = path.resolve(argv[++index]);
    else if (value === '--holdout') options.holdout = path.resolve(argv[++index]);
    else if (value === '--prior-benchmark') options.priorBenchmark = path.resolve(argv[++index]);
    else if (value === '--prior-review') options.priorReview = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--seed') options.seed = argv[++index];
    else if (value === '--at') options.at = argv[++index];
    else if (value === '--angle-count') options.angleCount = Math.max(3, Number(argv[++index]) || 3);
    else if (value === '--max-steps') options.maxSteps = Math.max(1, Number(argv[++index]) || 1);
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!options.priorReview) throw new Error('--prior-review is required so the existing 20 decisions can be carried forward.');
  return options;
}

function originalCandidate(level) {
  return {
    levelId: level.id,
    name: level.name,
    previewPath: level.previewPath,
    role: 'reference-original'
  };
}

function variantCandidate(level, variant) {
  return {
    levelId: variant.id,
    parentLevelId: level.id,
    name: level.name,
    previewPath: variant.previewPath,
    role: 'synthetic-counterfactual',
    operator: variant.operator,
    family: MOTIF_MUTATION_OPERATORS.includes(variant.operator) ? 'motif-aware' : 'global-layout'
  };
}

function referencePair(level, variant, random) {
  const originalSide = random.random() < 0.5 ? 'left' : 'right';
  const original = originalCandidate(level);
  const changed = variantCandidate(level, variant);
  return {
    id: `pair:${safeName(level.name)}:${variant.operator}`,
    comparisonType: 'reference-vs-variant',
    prompt: 'Which layout has the stronger composition and would be more promising to play?',
    left: originalSide === 'left' ? original : changed,
    right: originalSide === 'right' ? original : changed,
    truth: { originalSide, labelStatus: 'hidden-counterfactual-reference' }
  };
}

function variantDuelPair(level, leftVariant, rightVariant, index, random) {
  const candidates = random.random() < 0.5
    ? [variantCandidate(level, leftVariant), variantCandidate(level, rightVariant)]
    : [variantCandidate(level, rightVariant), variantCandidate(level, leftVariant)];
  return {
    id: `pair:${safeName(level.name)}:variant-duel:${String(index + 1).padStart(2, '0')}`,
    comparisonType: 'variant-vs-variant',
    prompt: 'Which generated alternative has the stronger composition and would be more promising to play?',
    left: candidates[0],
    right: candidates[1],
    truth: { labelStatus: 'no-assumed-winner' }
  };
}

function repeatPair(source, index) {
  return {
    id: `pair:repeat-control:${String(index + 1).padStart(2, '0')}:${safeName(source.id)}`,
    comparisonType: 'repeat-control',
    prompt: source.prompt,
    left: source.right,
    right: source.left,
    truth: {
      repeatOf: source.id,
      sideMapping: 'swapped',
      labelStatus: 'hidden-consistency-control'
    }
  };
}

function levelAndVariantIndex(benchmark) {
  const levels = new Map(benchmark.pilot.levels.map(level => [level.id, level]));
  const variants = new Map();
  for (const level of benchmark.pilot.levels) {
    for (const variant of level.variants) variants.set(variant.id, { level, variant });
  }
  return { levels, variants };
}

function validatePrior(priorBenchmark, priorReview) {
  if (priorBenchmark.id !== priorReview.benchmarkId) throw new Error('Prior review belongs to a different benchmark.');
  if (priorBenchmark.createdAt !== priorReview.benchmarkCreatedAt) throw new Error('Prior review timestamp does not match its benchmark.');
  if (priorReview.representationRevision !== priorBenchmark.representation?.revision) {
    throw new Error('Prior review representation revision mismatch.');
  }
  if (!priorReview.completed || priorReview.decisions?.length !== priorBenchmark.reviewPairs.length) {
    throw new Error('Prior review must be complete before carrying it forward.');
  }
  const pairIds = new Set(priorBenchmark.reviewPairs.map(pair => pair.id));
  for (const decision of priorReview.decisions) {
    if (!pairIds.has(decision.pairId)) throw new Error(`Prior decision references unknown pair ${decision.pairId}.`);
  }
}

function chooseBalanced(candidates, count, selectedLevelCounts, random) {
  const randomized = random.shuffle(candidates);
  const selected = [];
  while (selected.length < count) {
    const remaining = randomized.filter(candidate => !selected.includes(candidate));
    if (!remaining.length) throw new Error(`Could not choose ${count} balanced candidates.`);
    remaining.sort((left, right) => (
      (selectedLevelCounts.get(left.level.id) || 0) - (selectedLevelCounts.get(right.level.id) || 0)
      || left.level.name.localeCompare(right.level.name)
    ));
    const choice = remaining[0];
    selected.push(choice);
    selectedLevelCounts.set(choice.level.id, (selectedLevelCounts.get(choice.level.id) || 0) + 1);
  }
  return selected;
}

function designReviewPairs(benchmark, priorBenchmark, random) {
  const { levels, variants } = levelAndVariantIndex(benchmark);
  const priorPairs = priorBenchmark.reviewPairs.map(pair => {
    for (const side of ['left', 'right']) {
      const candidate = pair[side];
      if (candidate.role === 'reference-original') {
        const level = levels.get(candidate.levelId);
        if (!level || level.previewPath !== candidate.previewPath) {
          throw new Error(`Could not carry prior original candidate ${candidate.levelId} forward exactly.`);
        }
      } else {
        const indexed = variants.get(candidate.levelId);
        if (!indexed || indexed.variant.previewPath !== candidate.previewPath) {
          throw new Error(`Could not carry prior variant candidate ${candidate.levelId} forward exactly.`);
        }
      }
    }
    return { ...pair, comparisonType: 'reference-vs-variant' };
  });
  const existingPairIds = new Set(priorPairs.map(pair => pair.id));
  const selectedLevelCounts = new Map();
  for (const pair of priorPairs) {
    const original = pair[pair.truth.originalSide];
    selectedLevelCounts.set(original.levelId, (selectedLevelCounts.get(original.levelId) || 0) + 1);
  }

  const currentCounts = Object.fromEntries(MUTATION_OPERATORS.map(operator => [operator, 0]));
  for (const pair of priorPairs) {
    const variantSide = pair.truth.originalSide === 'left' ? 'right' : 'left';
    currentCounts[pair[variantSide].operator]++;
  }
  const globalSelections = [];
  for (const operator of MUTATION_OPERATORS) {
    const needed = 10 - currentCounts[operator];
    const candidates = benchmark.pilot.levels
      .map(level => ({ level, variant: level.variants.find(item => item.operator === operator) }))
      .filter(item => item.variant && !existingPairIds.has(`pair:${safeName(item.level.name)}:${operator}`));
    globalSelections.push(...chooseBalanced(candidates, needed, selectedLevelCounts, random));
  }
  const globalPairs = random.shuffle(globalSelections.map(({ level, variant }) => referencePair(level, variant, random)));

  const motifSelections = [];
  for (const operator of MOTIF_MUTATION_OPERATORS) {
    const candidates = benchmark.pilot.levels
      .map(level => ({ level, variant: level.variants.find(item => item.operator === operator) }))
      .filter(item => item.variant);
    motifSelections.push(...chooseBalanced(candidates, 6, selectedLevelCounts, random));
  }
  const motifPairs = random.shuffle(motifSelections.map(({ level, variant }) => referencePair(level, variant, random)));

  const duelLevelCounts = new Map();
  const duelPairs = [];
  const duelLevels = random.shuffle(benchmark.pilot.levels);
  for (let index = 0; index < 10; index++) {
    duelLevels.sort((left, right) => (
      (duelLevelCounts.get(left.id) || 0) - (duelLevelCounts.get(right.id) || 0)
      || left.name.localeCompare(right.name)
    ));
    const level = duelLevels[0];
    duelLevelCounts.set(level.id, (duelLevelCounts.get(level.id) || 0) + 1);
    const globalOperator = MUTATION_OPERATORS[index % MUTATION_OPERATORS.length];
    const motifOperator = MOTIF_MUTATION_OPERATORS[(index * 3) % MOTIF_MUTATION_OPERATORS.length];
    const globalVariant = level.variants.find(variant => variant.operator === globalOperator);
    const motifVariant = level.variants.find(variant => variant.operator === motifOperator);
    duelPairs.push(variantDuelPair(level, globalVariant, motifVariant, index, random));
  }

  const newUnique = random.shuffle([...globalPairs, ...motifPairs, ...duelPairs]);
  if (newUnique.length !== 70) throw new Error(`Expected 70 new unique pairs, found ${newUnique.length}.`);
  const repeatSources = [
    ...random.shuffle(priorPairs).slice(0, 5),
    ...newUnique.slice(0, 5)
  ];
  const repeats = repeatSources.map(repeatPair);
  const newSequence = [];
  const priorRepeatPositions = new Set([6, 13, 20, 27, 34]);
  const newRepeatPositions = new Set([39, 46, 53, 60, 67]);
  let priorRepeatIndex = 0;
  let newRepeatIndex = 5;
  for (let index = 0; index < newUnique.length; index++) {
    newSequence.push(newUnique[index]);
    if (priorRepeatPositions.has(index)) newSequence.push(repeats[priorRepeatIndex++]);
    if (newRepeatPositions.has(index)) newSequence.push(repeats[newRepeatIndex++]);
  }
  if (newSequence.length !== 80) throw new Error(`Expected 80 continuation pairs, found ${newSequence.length}.`);
  return {
    pairs: [...priorPairs, ...newSequence],
    counts: {
      carriedForward: priorPairs.length,
      newGlobalReferencePairs: globalPairs.length,
      newMotifReferencePairs: motifPairs.length,
      variantDuels: duelPairs.length,
      repeatControls: repeats.length,
      total: priorPairs.length + newSequence.length
    },
    currentOperatorTotals: Object.fromEntries(MUTATION_OPERATORS.map(operator => [
      operator,
      currentCounts[operator] + globalSelections.filter(item => item.variant.operator === operator).length
    ])),
    motifOperatorTotals: Object.fromEntries(MOTIF_MUTATION_OPERATORS.map(operator => [
      operator,
      motifSelections.filter(item => item.variant.operator === operator).length
    ]))
  };
}

function preferenceReport(benchmark) {
  const design = benchmark.preferenceDesign;
  return `# Preference benchmark v2\n\nGenerated: ${benchmark.createdAt}\n\n` +
    `This benchmark carries forward ${design.counts.carriedForward} validated v1 decisions and presents ` +
    `${design.counts.total - design.counts.carriedForward} additional decisions.\n\n` +
    `- Global reference-vs-variant pairs: ${design.counts.carriedForward + design.counts.newGlobalReferencePairs}\n` +
    `- Motif-aware reference-vs-variant pairs: ${design.counts.newMotifReferencePairs}\n` +
    `- Variant-vs-variant pairs: ${design.counts.variantDuels}\n` +
    `- Hidden repeat controls: ${design.counts.repeatControls}\n` +
    `- Total decisions: ${design.counts.total}\n\n` +
    `The first ${design.counts.carriedForward} decisions are loaded from review-seed.json and locked in the UI.\n`;
}

export async function buildPreferenceBenchmark(options) {
  const priorBenchmark = await readJson(options.priorBenchmark);
  const priorReview = await readJson(options.priorReview);
  validatePrior(priorBenchmark, priorReview);
  const pinnedLevelIds = priorBenchmark.pilot.levels.map(level => level.id);
  const benchmark = await buildBenchmark({
    reference: options.reference,
    adaptation: options.adaptation,
    holdout: options.holdout,
    output: options.output,
    pilotSize: 16,
    pilotLevelIds: pinnedLevelIds,
    mutationCount: ALL_MUTATION_OPERATORS.length,
    mutationOperators: ALL_MUTATION_OPERATORS,
    reviewPairs: 1,
    simulate: 'originals',
    angleCount: options.angleCount,
    maxSteps: options.maxSteps,
    seed: options.seed,
    at: options.at
  });
  const design = designReviewPairs(benchmark, priorBenchmark, createRandom(`${options.seed}:preference-v2`));
  benchmark.formatVersion = 3;
  benchmark.id = 'benchmark:preference-v2:deluxe-100';
  benchmark.generator = {
    id: 'build-preference-benchmark.mjs',
    version: TOOL_VERSION,
    baseGenerator: benchmark.generator
  };
  benchmark.representation = {
    revision: 'peggleedit-motif-semantic-v1',
    parentRevision: 'peggleedit-semantic-v2',
    motifDetector: 'arc-line-proximity-components/v1',
    motifFeatures: true,
    straightBricks: 'canonical-long-axis-rotation',
    curvedBricks: 'annular-sector-with-world-space-curve-slices',
    movingObjects: 'deterministic-source-initial-phase-snapshot',
    blindTitles: 'shared-parent-title-with-operator-hidden'
  };
  benchmark.qualityGate = {
    status: 'passed',
    requirements: [
      'all-reviewed-targets-static',
      'all-reviewed-targets-supported-by-semantic-renderer',
      'motif-mutations-transform-whole-detected-groups',
      'review-design-balanced-by-operator',
      'variant-duels-have-no-assumed-winner',
      'repeat-controls-are-side-swapped',
      'carried-decisions-match-prior-benchmark-exactly'
    ]
  };
  const { pairs: _designedPairs, ...designSummary } = design;
  benchmark.preferenceDesign = {
    version: 1,
    targetDecisionCount: 100,
    ...designSummary,
    priorEvidence: {
      benchmarkId: priorBenchmark.id,
      reviewSha256: await digestFile(options.priorReview),
      decisionCount: priorReview.decisions.length,
      importedAsLockedPrefix: true
    }
  };
  benchmark.reviewPairs = design.pairs;
  await writeJson(path.join(options.output, 'benchmark.json'), benchmark);
  await writeJson(path.join(options.output, 'review-seed.json'), {
    format: 'peggle-benchmark-review-seed',
    formatVersion: 1,
    benchmarkId: benchmark.id,
    benchmarkCreatedAt: benchmark.createdAt,
    representationRevision: benchmark.representation.revision,
    lockedDecisionCount: priorReview.decisions.length,
    source: {
      benchmarkId: priorBenchmark.id,
      reviewSha256: benchmark.preferenceDesign.priorEvidence.reviewSha256
    },
    decisions: priorReview.decisions
  });
  const report = preferenceReport(benchmark);
  await writeFile(path.join(options.output, 'preference-design.md'), report, 'utf8');
  await writeFile(path.join(options.output, 'report.md'), report, 'utf8');
  return benchmark;
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const benchmark = await buildPreferenceBenchmark(options);
    console.log(`wrote ${path.join(options.output, 'benchmark.json')} (${benchmark.reviewPairs.length} pairs, 20 seeded + 80 remaining)`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
