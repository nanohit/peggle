#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureLevelSemanticIdentity } from '../../js/bezier-program.js';
import { REPAIR_SESSION_FORMAT, REPAIR_SESSION_VERSION } from '../../js/repair-session.js';

const clone = value => JSON.parse(JSON.stringify(value));

function parseArgs(argv) {
  return {
    manifest: path.resolve(argv[0] || 'research/generated/repair-pilot-v1/manifest.json'),
    output: path.resolve(argv[1] || 'research/generated/repair-pilot-v1/repair-session.json'),
    seed: argv[2] || 'repair-session-v1'
  };
}

function hashSeed(text) {
  let value = 2166136261;
  for (const character of String(text)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function seededShuffle(values, seed) {
  let state = hashSeed(seed) || 1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function translateLevel(level, dx, dy) {
  for (const peg of level.pegs || []) {
    peg.x += dx; peg.y += dy;
    for (const slice of peg.curveSlices || []) {
      slice.x += dx; slice.y += dy;
    }
  }
  for (const curve of Object.values(level.bezierCurves || {})) {
    for (const key of ['start', 'end', 'h1', 'h2']) {
      if (!curve[key]) continue;
      curve[key].x += dx; curve[key].y += dy;
    }
    for (const point of curve.refPoints || []) {
      point.x += dx; point.y += dy;
    }
  }
  return level;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function sourceRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function loadCandidate(root, metadata) {
  const level = await readJson(path.resolve(root, metadata.levelPath));
  ensureLevelSemanticIdentity(level);
  level.metadata ||= {};
  level.metadata.generatorProgram.commandLog = [];
  return {
    id: metadata.source,
    role: 'study',
    source: {
      source: metadata.source,
      sourceLevelId: metadata.sourceLevelId,
      compositionFamily: metadata.compositionFamily,
      sourceSkeleton: metadata.sourceSkeleton,
      strata: metadata.strata || [],
      knownProperties: metadata.knownProperties || [],
      footprint: metadata.footprint || null
    },
    staticCheckOptions: { width: 400, height: level.survival?.worldHeight || 600, minimumLauncherClearance: 42 },
    baselineLevel: level
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readJson(options.manifest);
  const root = path.dirname(options.manifest);
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length < 5) {
    throw new Error('Repair manifest needs at least five study candidates.');
  }

  const controlSource = manifest.candidates.find(candidate => candidate.source === 'crisscross')
    || manifest.candidates[0];
  const controlTarget = await loadCandidate(root, controlSource);
  const controlBaseline = translateLevel(clone(controlTarget.baselineLevel), 18, 0);
  controlBaseline.name = `Control — recenter ${controlBaseline.name || controlSource.source}`;
  const control = {
    ...controlTarget,
    id: `control:${controlSource.source}:horizontal-offset`,
    role: 'control',
    baselineLevel: controlBaseline,
    controlTargetLevel: controlTarget.baselineLevel,
    knownDefect: {
      id: 'global-horizontal-offset',
      instruction: 'Calibration: move the entire composition back onto the launcher axis without redesigning it.',
      injectedTransform: { dx: 18, dy: 0 },
      expectedCorrection: { dx: -18, dy: 0 }
    }
  };

  // The control is a calibration copy, not an exploratory observation. Keep
  // the unmodified source in the five-study pool so the study still spans all
  // five distinct morphologies from the manifest.
  const chosen = seededShuffle(manifest.candidates, options.seed).slice(0, 5);
  const studyCandidates = [];
  for (const metadata of chosen) studyCandidates.push(await loadCandidate(root, metadata));
  const revision = sourceRevision();
  const session = {
    format: REPAIR_SESSION_FORMAT,
    version: REPAIR_SESSION_VERSION,
    sessionId: `repair-v1:${options.seed}`,
    seed: options.seed,
    source: {
      manifestFormat: manifest.format,
      manifestVersion: manifest.version,
      manifestPhase: manifest.phase,
      sourceRevision: revision
    },
    protocol: {
      purpose: 'Test whether author repairs can be represented as compact program operations.',
      candidateCount: 6,
      controlFirst: true,
      deterministicOrder: true,
      metricsVisibleDuringRepair: false,
      autosave: 'every-level-save',
      finishGates: ['semantic-replay', 'lineage', 'command-log-integrity', 'static-checks-for-done'],
      dispositions: ['done', 'deferred', 'unfixable'],
      warning: 'Exploratory vocabulary discovery; do not aggregate as confirmatory evidence.'
    },
    candidates: [control, ...studyCandidates]
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(session, null, 2)}\n`);
  console.log(JSON.stringify({
    output: options.output,
    sessionId: session.sessionId,
    candidates: session.candidates.map(candidate => ({ id: candidate.id, role: candidate.role }))
  }, null, 2));
}

await main();
