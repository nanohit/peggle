#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applySimilarityTransform,
  transformBezierCurve
} from '../../js/bezier-geometry.js';
import { ensureLevelSemanticIdentity } from '../../js/bezier-program.js';
import {
  captureBezierSemanticState,
  diffBezierSemanticStates
} from '../../js/bezier-semantic.js';
import { normalizeLevelData } from '../../js/levels.js';
import {
  evaluateRepairStaticChecks,
  REPAIR_SESSION_FORMAT,
  REPAIR_SESSION_VERSION
} from '../../js/repair-session.js';

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

function rotationAround(center, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    angle,
    scale: 1,
    tx: center.x - (center.x * cos - center.y * sin),
    ty: center.y - (center.x * sin + center.y * cos)
  };
}

function rotateBezierStroke(level, groupId, angle) {
  const pegs = (level.pegs || []).filter(peg => peg.bezierGroupId === groupId);
  const curve = level.bezierCurves?.[groupId];
  if (!curve || pegs.length < 3) {
    throw new Error(`Control stroke ${groupId} needs a curve and at least three members.`);
  }
  const center = {
    x: pegs.reduce((sum, peg) => sum + Number(peg.x), 0) / pegs.length,
    y: pegs.reduce((sum, peg) => sum + Number(peg.y), 0) / pegs.length
  };
  const transform = rotationAround(center, angle);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const peg of pegs) {
    const moved = applySimilarityTransform(peg, transform);
    peg.x = moved.x;
    peg.y = moved.y;
    peg.angle = Number(peg.angle || 0) + angle;
    for (const slice of peg.curveSlices || []) {
      const movedSlice = applySimilarityTransform(slice, transform);
      const nx = Number(slice.nx || 0);
      const ny = Number(slice.ny || 0);
      slice.x = movedSlice.x;
      slice.y = movedSlice.y;
      slice.nx = nx * cos - ny * sin;
      slice.ny = nx * sin + ny * cos;
    }
  }
  level.bezierCurves[groupId] = transformBezierCurve(curve, transform);
  ensureLevelSemanticIdentity(level);
  return { center, transform };
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
  // Repair snapshots must already have exactly the shape the editor will
  // produce on load. Otherwise editor-added defaults masquerade as author
  // edits (notably set-level-properties language gaps).
  const level = normalizeLevelData(await readJson(path.resolve(root, metadata.levelPath)));
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

function meaningfulOperations(beforeLevel, afterLevel) {
  return diffBezierSemanticStates(
    captureBezierSemanticState(beforeLevel),
    captureBezierSemanticState(afterLevel)
  ).operations.filter(operation => operation.expressibility !== 'ignored');
}

function assertEditorRoundTripNoOp(candidate) {
  const editorLoaded = normalizeLevelData(clone(candidate.baselineLevel));
  const operations = meaningfulOperations(candidate.baselineLevel, editorLoaded);
  if (operations.length > 0) {
    throw new Error(`${candidate.id} gains semantic operations on editor normalization: ${operations.map(operation => operation.type).join(', ')}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readJson(options.manifest);
  const root = path.dirname(options.manifest);
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length < 5) {
    throw new Error('Repair manifest needs at least five study candidates.');
  }

  const controlSource = manifest.candidates.find(candidate => candidate.source === 'sunny');
  if (!controlSource) throw new Error('Repair manifest needs the symmetric sunny candidate for its control.');
  const controlTarget = await loadCandidate(root, controlSource);
  const controlObjectId = 'source-s11-segment-01';
  const injectedAngle = 20 * Math.PI / 180;
  const controlBaseline = clone(controlTarget.baselineLevel);
  const injection = rotateBezierStroke(controlBaseline, controlObjectId, injectedAngle);
  const expectedOperations = meaningfulOperations(controlBaseline, controlTarget.baselineLevel);
  if (expectedOperations.length !== 1
      || expectedOperations[0].type !== 'transform-stroke'
      || expectedOperations[0].objectId !== controlObjectId) {
    throw new Error(`Control must have one transform-stroke on ${controlObjectId}; got ${expectedOperations.map(operation => `${operation.type}:${operation.objectId || '-'}`).join(', ')}`);
  }
  const controlStaticChecks = evaluateRepairStaticChecks(controlBaseline, controlTarget.staticCheckOptions);
  if (controlStaticChecks.status !== 'passed') {
    throw new Error(`Injected control is statically invalid: ${controlStaticChecks.failures.join(', ')}`);
  }
  const control = {
    ...controlTarget,
    id: `control:${controlSource.source}:single-stroke-rotation`,
    role: 'control',
    baselineLevel: controlBaseline,
    controlTargetLevel: controlTarget.baselineLevel,
    knownDefect: {
      id: 'single-stroke-rotation',
      instruction: 'Calibration: restore the intended symmetry. Change nothing else.',
      objectId: controlObjectId,
      injectedTransform: injection.transform,
      expectedOperation: {
        type: expectedOperations[0].type,
        objectId: expectedOperations[0].objectId,
        transform: expectedOperations[0].transform
      },
      acceptanceThresholdPx: 2
    }
  };

  // The control is a calibration copy, not an exploratory observation. Keep
  // the unmodified source in the five-study pool so the study still spans all
  // five distinct morphologies from the manifest.
  const chosen = seededShuffle(manifest.candidates, options.seed).slice(0, 5);
  const studyCandidates = [];
  for (const metadata of chosen) studyCandidates.push(await loadCandidate(root, metadata));
  for (const candidate of [control, ...studyCandidates]) assertEditorRoundTripNoOp(candidate);
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
