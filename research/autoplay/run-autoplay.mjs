#!/usr/bin/env node
// Autoplayer: reachability map, multi-shot beam search, and an orange plan.
//
//   node research/autoplay/run-autoplay.mjs <corpus.json> --levels a,b --out <dir>
//   node research/autoplay/run-autoplay.mjs <corpus.json> --limit 8 --out <dir>
//
// Writes per-level JSON, a comparison SVG, and a summary table. Read-only with
// respect to the game and the corpora.

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { readJson, writeJson } from '../tools/lib/node-io.mjs';
import { createSimulator } from './lib/sim.mjs';
import { buildReachability, sweepAngles } from './lib/reachability.mjs';
import { searchClear, searchCollect } from './lib/search.mjs';
import { planOranges } from './lib/orange-plan.mjs';
import { renderAutoplaySvg } from './lib/render-autoplay.mjs';

const TOOL_VERSION = '0.1.0';

function parseArguments(argv) {
  const options = {
    corpus: null, levels: null, limit: 6, out: null,
    angleCount: 96, seedCount: 5, balls: 10, beamWidth: 6, searchAngles: 32,
    maxSteps: 2400, orangeFraction: 0.44, maxPerShot: 4,
    at: '2026-09-03T00:00:00.000Z'
  };
  const rest = [];
  const numeric = new Set(['limit', 'angleCount', 'seedCount', 'balls', 'beamWidth', 'searchAngles', 'maxSteps', 'maxPerShot']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--levels') options.levels = String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean);
    else if (token === '--out') options.out = String(argv[++index] || '');
    else if (token === '--at') options.at = String(argv[++index] || '');
    else if (token === '--orange-fraction') options.orangeFraction = Number(argv[++index]);
    else if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      if (numeric.has(key)) options[key] = Math.max(1, Math.trunc(Number(argv[++index])));
      else options[key] = argv[++index];
    } else rest.push(token);
  }
  options.corpus = rest[0] || null;
  return options;
}

function selectRecords(corpus, options) {
  const entries = corpus.records || [];
  if (options.levels?.length) {
    const wanted = new Set(options.levels.map(value => value.toLowerCase()));
    return entries.filter(entry => wanted.has(String(entry.name || '').toLowerCase()));
  }
  return entries.filter(entry => (entry.targetCount ?? 1) >= 12).slice(0, options.limit);
}

function subsample(values, count) {
  if (count >= values.length) return [...values];
  return Array.from({ length: count }, (_value, index) => (
    values[Math.round((index * (values.length - 1)) / (count - 1))]
  ));
}

function describeRun(run) {
  if (!run) return '-';
  return run.complete ? `${run.ballsUsed}b` : `${Math.round(run.collectedFraction * 100)}%`;
}

function describeRandom(run) {
  if (!run) return '-';
  if (run.completedDraws === run.draws) return `${run.ballsUsed}b`;
  return `${Math.round(run.collectedFraction * 100)}%`;
}

function formatRow(result) {
  const metrics = result.reachability.metrics;
  const quality = result.orangePlan?.quality;
  return [
    String(result.name).padEnd(16).slice(0, 16),
    String(metrics.targetCount).padStart(5),
    `${Math.round(metrics.reachableFraction * 100)}%`.padStart(6),
    String(metrics.seedStability).padStart(6),
    String(metrics.aimSensitivity).padStart(6),
    String(metrics.pocketCount).padStart(4),
    `${Math.round(result.search.bestClearedFraction * 100)}%`.padStart(6),
    String(result.orangePlan?.placed ?? '-').padStart(4),
    String(quality ? quality.maxShotYield : '-').padStart(5),
    String(quality ? quality.baseline.meanMaxShotYield : '-').padStart(6),
    describeRun(result.validation?.planned).padStart(7),
    describeRandom(result.validation?.random).padStart(7)
  ].join(' | ');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.corpus) {
    console.error('usage: run-autoplay.mjs <corpus.json> [--levels a,b] [--limit N] [--out dir]');
    process.exit(2);
  }
  const corpusPath = path.resolve(options.corpus);
  const corpusRoot = path.dirname(corpusPath);
  const corpus = await readJson(corpusPath);
  const outputDir = path.resolve(options.out || path.join(corpusRoot, 'autoplay'));
  await mkdir(path.join(outputDir, 'levels'), { recursive: true });
  await mkdir(path.join(outputDir, 'previews'), { recursive: true });

  const selected = selectRecords(corpus, options);
  if (!selected.length) {
    console.error('No matching levels in corpus.');
    process.exit(1);
  }

  const angles = sweepAngles(options.angleCount);
  const results = [];
  for (const entry of selected) {
    const record = await readJson(path.resolve(corpusRoot, entry.recordPath));
    const started = Date.now();
    const sim = createSimulator(record, { maxSteps: options.maxSteps });
    try {
      const reachability = buildReachability(sim, {
        angles,
        seedCount: options.seedCount,
        seed: `reach:${record.id}`
      });
      const search = searchClear(sim, {
        angles: subsample(angles, options.searchAngles),
        balls: options.balls,
        beamWidth: options.beamWidth,
        seed: `search:${record.id}`
      });
      // Peggle ships a fixed 25 oranges regardless of level size; the authored
      // Alea levels sit near 44% of a much smaller peg count. Take whichever is
      // smaller so the plan is playable at either scale, and never ask for more
      // oranges than the sweep can actually reach - an orange nothing reaches on
      // the untouched layout is a coin flip, not a design decision.
      const reachableCount = reachability.metrics.reachableCount;
      const orangeCount = Math.max(4, Math.min(
        options.orangeCount || Math.min(25, Math.round(reachability.metrics.targetCount * options.orangeFraction)),
        Math.floor(reachableCount * 0.75)
      ));
      const planWith = capCandidates => planOranges(reachability, {
        count: orangeCount,
        balls: options.balls,
        depth: search.depth,
        seed: `orange:${record.id}`,
        ...(capCandidates ? { capCandidates } : {})
      });
      let orangePlan = planWith(null);
      // Static cover is a proxy. The real check is playing both assignments with
      // pegs actually disappearing.
      const validationAngles = subsample(angles, options.searchAngles);
      const validate = (ids, label) => (ids?.length
        ? searchCollect(sim, {
          angles: validationAngles,
          balls: options.balls,
          beamWidth: Math.max(3, options.beamWidth - 1),
          seed: `${label}:${record.id}`,
          objectiveIds: ids
        })
        : null);
      // Close the loop on the static proxy. If playing the plan overshoots the
      // ball budget, loosen the per-shot cap; if it finishes far too early,
      // tighten it. The proxy chooses the starting point, the play decides.
      const CAP_LADDER = [2, 3, 4, 5, 6, 8];
      const easyBallFloor = Math.max(2, Math.ceil(options.balls * 0.4));
      let plannedRun = validate(orangePlan.orangeIds, 'validate-planned');
      const tuning = [];
      for (let attempt = 0; attempt < 2 && plannedRun; attempt++) {
        tuning.push({
          cap: orangePlan.chosenCap,
          complete: plannedRun.complete,
          ballsUsed: plannedRun.ballsUsed,
          collectedFraction: plannedRun.collectedFraction
        });
        const tooHard = !plannedRun.complete;
        const tooEasy = plannedRun.complete && plannedRun.ballsUsed < easyBallFloor;
        if (!tooHard && !tooEasy) break;
        const nextCap = tooHard
          ? CAP_LADDER.find(cap => cap > orangePlan.chosenCap)
          : [...CAP_LADDER].reverse().find(cap => cap < orangePlan.chosenCap);
        if (!nextCap) break;
        const retried = planWith([nextCap]);
        if (!retried.orangeIds?.length) break;
        const retriedRun = validate(retried.orangeIds, `validate-planned-cap${nextCap}`);
        if (!retriedRun) break;
        // Keep the retry only if it moved toward the budget.
        const improved = tooHard
          ? (retriedRun.complete || retriedRun.collectedFraction > plannedRun.collectedFraction)
          : (retriedRun.complete && retriedRun.ballsUsed > plannedRun.ballsUsed);
        if (!improved) break;
        orangePlan = retried;
        plannedRun = retriedRun;
      }
      const baselineRuns = (orangePlan.baselineOrangeSamples || [])
        .map((sample, index) => validate(sample, `validate-random-${index}`))
        .filter(Boolean);
      const summarize = run => run && {
        collectedFraction: run.collectedFraction,
        ballsUsed: run.ballsUsed,
        complete: run.complete
      };
      const averageOf = pick => (baselineRuns.length
        ? Math.round((baselineRuns.reduce((sum, run) => sum + pick(run), 0) / baselineRuns.length) * 1000) / 1000
        : 0);
      const validation = {
        ballBudget: options.balls,
        planned: summarize(plannedRun),
        random: baselineRuns.length ? {
          draws: baselineRuns.length,
          collectedFraction: averageOf(run => run.collectedFraction),
          ballsUsed: averageOf(run => run.ballsUsed),
          completedDraws: baselineRuns.filter(run => run.complete).length,
          complete: baselineRuns.every(run => run.complete),
          perDraw: baselineRuns.map(summarize)
        } : null,
        capTuning: tuning,
        note: 'Balls a beam search needed to collect every orange, playing with pegs removed. '
          + 'Equal to the budget when it never finished. Random is averaged over independent draws.'
      };
      const result = {
        format: 'peggle-autoplay-report',
        formatVersion: 1,
        tool: { id: 'run-autoplay.mjs', version: TOOL_VERSION },
        levelId: record.id,
        name: record.authored?.name || entry.name,
        createdAt: options.at,
        simulator: sim.info,
        configuration: {
          angleCount: options.angleCount,
          seedCount: options.seedCount,
          searchAngles: options.searchAngles,
          balls: options.balls,
          beamWidth: options.beamWidth,
          maxSteps: options.maxSteps,
          orangeFraction: options.orangeFraction,
          maxPerShot: options.maxPerShot
        },
        reachability,
        search,
        orangePlan,
        validation,
        elapsedMs: Date.now() - started
      };
      const safeName = String(result.name).replace(/[^A-Za-z0-9_-]+/g, '_');
      await writeJson(path.join(outputDir, 'levels', `${safeName}.autoplay.json`), result);
      await writeFile(path.join(outputDir, 'previews', `${safeName}.svg`), renderAutoplaySvg(record, result), 'utf8');
      results.push(result);
      console.error(`  ${result.name}: ${result.elapsedMs}ms, ${reachability.metrics.trialCount + search.shotsSimulated} shots`);
    } finally {
      sim.dispose();
    }
  }

  const header = [
    'level'.padEnd(16), 'pegs'.padStart(5), 'reach'.padStart(6),
    'stabl'.padStart(6), 'aimsen'.padStart(6), 'pkts'.padStart(4), 'clear'.padStart(6),
    'orng'.padStart(4), 'max/s'.padStart(5), 'rndmx'.padStart(6),
    'plan'.padStart(7), 'random'.padStart(7)
  ].join(' | ');
  const lines = [header, '-'.repeat(header.length), ...results.map(formatRow)];

  const average = pick => Math.round(results.reduce((sum, result) => sum + pick(result), 0) / results.length * 1000) / 1000;
  const completed = pick => results.filter(pick).length;
  const aggregate = {
    levels: results.length,
    meanReachableFraction: average(result => result.reachability.metrics.reachableFraction),
    meanDeadAngleRate: average(result => result.reachability.metrics.deadAngleRate),
    meanSeedStability: average(result => result.reachability.metrics.seedStability),
    meanAimSensitivity: average(result => result.reachability.metrics.aimSensitivity),
    meanClearedFraction: average(result => result.search.bestClearedFraction),
    meanNeverHitFraction: average(result => result.search.neverHitFraction),
    meanPlannedMaxShotYield: average(result => result.orangePlan?.quality?.maxShotYield || 0),
    meanRandomMaxShotYield: average(result => result.orangePlan?.quality?.baseline?.meanMaxShotYield || 0),
    plannedCompletedWithinBudget: completed(result => result.validation?.planned?.complete),
    randomAllDrawsCompletedWithinBudget: completed(result => result.validation?.random?.complete),
    meanPlannedBallsUsed: average(result => result.validation?.planned?.ballsUsed || 0),
    meanRandomBallsUsed: average(result => result.validation?.random?.ballsUsed || 0),
    meanPlannedCollectedFraction: average(result => result.validation?.planned?.collectedFraction || 0),
    meanRandomCollectedFraction: average(result => result.validation?.random?.collectedFraction || 0)
  };

  const report = [
    `# Autoplay: ${corpus.id}`,
    '',
    `Generated: ${options.at}`,
    '',
    '```',
    ...lines,
    '```',
    '',
    '## Aggregate',
    '',
    ...Object.entries(aggregate).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Columns',
    '',
    '- `reach` — share of pegs any sampled first shot can touch. A lower bound.',
    '- `stabl` — agreement between seeds at the same aim. Low means the outcome is',
    '  engine jitter rather than aim, i.e. the level is a lottery.',
    '- `aimsen` — how much the outcome changes between neighbouring aims.',
    '- `pkts` — pockets: groups of pegs the same aims reach.',
    '- `clear` — best share cleared by the beam search within the ball budget.',
    '- `orng` — oranges placed.',
    '- `max/s` — most oranges any single sampled shot collects under the plan.',
    '- `rndmx` — the same for a uniform random assignment of equal size, which is what',
    '  the v0 generator produced.',
    '- `plan` / `random` — the beam search actually playing each assignment with pegs',
    '  disappearing. `7b` means it collected everything in seven balls; a percentage',
    '  means it never finished inside the budget and that is how far it got.',
    '',
    '## Scope',
    '',
    'This is the DOM-free physics subset: no animation, no motion rigs in motion, no',
    'power-ups, perks, free balls or scoring. Reachability is sampled, so it under-',
    'reports; it never proves a peg is unreachable.',
    ''
  ].join('\n');

  await writeFile(path.join(outputDir, 'report.md'), report, 'utf8');
  await writeJson(path.join(outputDir, 'summary.json'), {
    corpusId: corpus.id,
    configuration: results[0]?.configuration || null,
    aggregate,
    levels: results.map(result => ({
      name: result.name,
      levelId: result.levelId,
      metrics: result.reachability.metrics,
      search: {
        bestClearedFraction: result.search.bestClearedFraction,
        fullyCleared: result.search.fullyCleared,
        neverHitFraction: result.search.neverHitFraction,
        shotsSimulated: result.search.shotsSimulated
      },
      orange: result.orangePlan?.quality || null,
      orangeCount: result.orangePlan?.placed ?? 0,
      validation: result.validation || null,
      elapsedMs: result.elapsedMs
    }))
  });

  console.log(report);
  console.log(`Written to ${outputDir}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
