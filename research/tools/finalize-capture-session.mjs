#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  digestResearchLevel,
  makeResearchRunRecord,
  stableStringify
} from '../../js/research-format.js';
import { digestFile, readJson, writeJson } from './lib/node-io.mjs';

const TOOL_VERSION = '0.3.0';
const SHA256 = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) options[key] = true;
    else { options[key] = next; index++; }
  }
  return { positional, options };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function exists(filePath) {
  try { await access(filePath, fsConstants.F_OK); return true; }
  catch { return false; }
}

async function readJsonLines(filePath, required = true) {
  if (!await exists(filePath)) {
    if (required) throw new Error(`Required session stream is missing: ${filePath}`);
    return [];
  }
  const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: ${error.message}`); }
  });
}

function artifactPath(filePath, outputPath) {
  const relative = path.relative(path.dirname(path.resolve(outputPath)), path.resolve(filePath)).replaceAll('\\', '/');
  return relative && !relative.startsWith('../') ? relative : path.resolve(filePath).replaceAll('\\', '/');
}

function canonicalEvent(raw, index, bases, fixedStepSeconds) {
  const gameMs = finite(raw.gameTimeMs, bases.gameMs);
  const wallMs = finite(raw.monotonicMs, bases.wallMs);
  const timeSeconds = Math.max(0, (gameMs - bases.gameMs) / 1000);
  const wallTimeSeconds = Math.max(0, (wallMs - bases.wallMs) / 1000);
  const step = fixedStepSeconds > 0
    ? Math.max(0, Math.round(timeSeconds / fixedStepSeconds))
    : index;
  return {
    sequence: index,
    step,
    timeSeconds,
    wallTimeSeconds,
    speedMultiplier: finite(raw.speedMultiplier, 1),
    type: String(raw.type || 'unknown'),
    data: raw.data && typeof raw.data === 'object' ? raw.data : {},
    sourceSequence: Number.isInteger(raw.sequence) ? raw.sequence : index
  };
}

function canonicalInput(event, sequence) {
  return {
    sequence,
    step: event.step,
    timeSeconds: event.timeSeconds,
    wallTimeSeconds: event.wallTimeSeconds,
    type: event.type.replace(/^input\./, ''),
    data: event.data
  };
}

async function verifyFrames(sessionDirectory, frames) {
  let bytes = 0;
  let nearBlackFrames = 0;
  for (const [index, frame] of frames.entries()) {
    if (!frame.path || !SHA256.test(frame.sha256 || '')) {
      throw new Error(`frames.jsonl entry ${index + 1} requires path and lowercase SHA-256`);
    }
    const absolute = path.resolve(sessionDirectory, frame.path);
    const actual = await digestFile(absolute);
    if (actual !== frame.sha256) {
      throw new Error(`Frame digest mismatch for ${frame.path}: expected ${frame.sha256}, got ${actual}`);
    }
    bytes += finite(frame.byteLength, 0);
    if (finite(frame.diagnostics?.nonBlackRatio, 1) < 0.01) nearBlackFrames++;
  }
  return { bytes, nearBlackFrames };
}

export async function appendResearchDataset(datasetPath, records) {
  const absolute = path.resolve(datasetPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const lockPath = `${absolute}.lock`;
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error(`Dataset is locked by another writer: ${lockPath}`);
    throw error;
  });
  try {
    const existing = await readJsonLines(absolute, false);
    const byId = new Map(existing.map(record => [record.id, stableStringify(record)]));
    const merged = [...existing];
    for (const record of records) {
      const serialized = stableStringify(record);
      if (byId.has(record.id)) {
        if (byId.get(record.id) !== serialized) throw new Error(`Dataset already contains conflicting record id: ${record.id}`);
        continue;
      }
      byId.set(record.id, serialized);
      merged.push(record);
    }
    const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, merged.map(record => stableStringify(record)).join('\n') + (merged.length ? '\n' : ''), 'utf8');
    try { await rename(temporary, absolute); }
    catch {
      await copyFile(temporary, absolute);
      await rm(temporary, { force: true });
    }
    return { path: absolute, recordCount: merged.length, addedCount: merged.length - existing.length };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function finalizeCaptureSession(sessionPath, outputPath, options = {}) {
  const sessionDirectory = path.resolve(sessionPath);
  const session = await readJson(path.join(sessionDirectory, 'session.json'));
  if (session.format !== 'peggle-capture-session' || session.version !== 1) {
    throw new Error('Unsupported capture session format/version.');
  }
  const level = typeof options.level === 'string' ? await readJson(options.level) : options.level;
  if (level?.format !== 'peggle-research' || level?.recordType !== 'level') {
    throw new Error('A canonical peggle-research level record is required; unresolved native sessions are not assigned a fake level digest.');
  }

  const eventsPath = path.resolve(sessionDirectory, session.streams?.events || 'events.jsonl');
  const framesPath = path.resolve(sessionDirectory, session.streams?.frames || 'frames.jsonl');
  const summaryPath = path.join(sessionDirectory, 'capture-summary.json');
  const rawEvents = await readJsonLines(eventsPath);
  const frames = await readJsonLines(framesPath, false);
  const summary = await exists(summaryPath) ? await readJson(summaryPath) : {};
  if (rawEvents.length === 0) throw new Error('Capture session contains no events.');

  const fixedStepSeconds = options.fixedStepSeconds == null ? null : Number(options.fixedStepSeconds);
  if (fixedStepSeconds !== null && (!(fixedStepSeconds > 0) || !Number.isFinite(fixedStepSeconds))) {
    throw new Error('fixedStepSeconds must be positive or omitted.');
  }
  const bases = {
    wallMs: finite(rawEvents[0].monotonicMs),
    gameMs: finite(rawEvents[0].gameTimeMs, finite(rawEvents[0].monotonicMs))
  };
  const events = rawEvents.map((event, index) => canonicalEvent(event, index, bases, fixedStepSeconds));
  const inputs = events.filter(event => event.type.startsWith('input.')).map(canonicalInput);
  const levelSha256 = await digestResearchLevel(level);
  const eventDigest = await digestFile(eventsPath);
  const frameIndexDigest = await digestFile(framesPath).catch(() => null);
  const sessionDigest = await digestFile(path.join(sessionDirectory, 'session.json'));
  const integrity = options.verifyFrames === false ? {
    bytes: frames.reduce((sum, frame) => sum + finite(frame.byteLength), 0),
    nearBlackFrames: frames.filter(frame => finite(frame.diagnostics?.nonBlackRatio, 1) < 0.01).length
  } : await verifyFrames(sessionDirectory, frames);
  const speedMultipliers = events.map(event => event.speedMultiplier);
  const maxSpeedMultiplier = Math.max(1, ...speedMultipliers);
  // Finalization is intentionally repeatable. A wall-clock "now" here would
  // make an unchanged raw session conflict with its prior dataset record.
  const ingestionAt = options.at || summary.endedAt || session.endedAt ||
    session.startedAt || '1970-01-01T00:00:00.000Z';
  const indexedMissedIntervals = frames.reduce((sum, frame) => sum + finite(frame.missedIntervals), 0);
  const missedIntervals = Math.max(indexedMissedIntervals, finite(summary.missedScheduleIntervals));
  const output = path.resolve(outputPath);
  const artifacts = [
    {
      kind: 'capture-session',
      path: artifactPath(path.join(sessionDirectory, 'session.json'), output),
      sha256: sessionDigest,
      mediaType: 'application/json'
    },
    {
      kind: 'telemetry-log',
      path: artifactPath(eventsPath, output),
      sha256: eventDigest,
      mediaType: 'application/x-ndjson'
    }
  ];
  if (frames.length > 0 && frameIndexDigest) {
    artifacts.push({
      kind: 'frame-index',
      path: artifactPath(framesPath, output),
      sha256: frameIndexDigest,
      mediaType: 'application/x-ndjson',
      metadata: {
        frameCount: frames.length,
        byteLength: integrity.bytes,
        targetGameFps: finite(summary.targetGameFps, null),
        missedScheduleIntervals: missedIntervals,
        nearBlackFrames: integrity.nearBlackFrames,
        accelerationInvariant: true
      }
    });
    for (const frame of [frames[0], frames.at(-1)]) {
      if (!frame || artifacts.some(artifact => artifact.path === artifactPath(path.resolve(sessionDirectory, frame.path), output))) continue;
      artifacts.push({
        kind: 'screenshot',
        path: artifactPath(path.resolve(sessionDirectory, frame.path), output),
        sha256: frame.sha256,
        mediaType: frame.mediaType || 'image/png',
        width: frame.width,
        height: frame.height,
        metadata: {
          gameTimeSeconds: Math.max(0, (finite(frame.gameTimeMs) - bases.gameMs) / 1000),
          wallTimeSeconds: Math.max(0, (finite(frame.monotonicMs) - bases.wallMs) / 1000),
          role: frame.sequence === 0 ? 'first-frame' : 'last-frame'
        }
      });
    }
  }

  const eventCounts = {};
  for (const event of events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
  const run = makeResearchRunRecord({
    id: String(options.id || `run:capture:${session.sessionId}`),
    provenance: {
      source: {
        system: 'peggle-capture-session',
        path: artifactPath(sessionDirectory, output),
        revision: String(session.runtime?.revision || session.runtime?.game || 'unknown'),
        sha256: sessionDigest,
        gameVariant: session.runtime?.game || 'unknown'
      },
      ingestion: {
        tool: 'finalize-capture-session.mjs',
        toolVersion: TOOL_VERSION,
        toolRevision: String(options.toolRevision || 'workspace'),
        at: ingestionAt
      }
    },
    levelRef: { id: level.id, sha256: levelSha256, path: options.levelPath || undefined },
    reproduction: {
      capability: 'observational',
      game: {
        id: String(session.runtime?.game || 'unknown-native-peggle'),
        revision: String(session.runtime?.executableSha256 || session.runtime?.revision || 'unknown')
      },
      tool: { id: 'peggle-native-capture', version: TOOL_VERSION, revision: String(options.toolRevision || 'workspace') },
      fixedStepSeconds,
      physicsConfig: { known: false },
      seed: {
        algorithm: 'unknown-source-rng', master: 'unobserved', streams: {},
        unseededStreams: ['mechanics', 'visual']
      },
      inputs,
      platform: { runtime: 'native-windows-x86', capture: 'external-window-plus-injected-input-clock' },
      floatPolicy: { storage: 'source integer clocks and normalized input coordinates', checkpointComparison: 'not-available' }
    },
    events,
    checkpoints: [],
    measurements: {
      eventCounts,
      eventCount: events.length,
      inputCount: inputs.length,
      durationSeconds: events.at(-1).timeSeconds,
      wallDurationSeconds: events.at(-1).wallTimeSeconds,
      maxSpeedMultiplier,
      gameExitCode: finite(summary.gameExitCode, null),
      gameExitedCleanly: summary.gameExitedCleanly ?? null,
      visualCapture: {
        frameCount: frames.length,
        byteLength: integrity.bytes,
        imageFormat: summary.imageFormat || null,
        jpegQuality: finite(summary.jpegQuality, null),
        missedScheduleIntervals: missedIntervals,
        droppedAtFrameLimit: finite(summary.droppedAtFrameLimit),
        captureErrors: finite(summary.captureErrors),
        nearBlackFrames: integrity.nearBlackFrames,
        targetGameFps: finite(summary.targetGameFps, null),
        estimatedBytesPerGameHour: finite(summary.estimatedBytesPerGameHour, null),
        accelerationInvariant: true
      }
    },
    artifacts,
    extensions: {
      captureSession: session,
      captureSummary: summary,
      captureClock: {
        canonicalEventTime: 'gameTimeMs',
        wallTime: 'monotonicMs',
        accelerationInvariant: true
      },
      frameIndexFields: frames.length ? [...new Set(frames.flatMap(frame => Object.keys(frame)))].sort() : []
    },
    warnings: [
      'Native capture is observational: exact simulation step, RNG state, gameplay object identity, and semantic level transitions are not exposed by this binary revision.',
      ...(missedIntervals > 0 ? [`Visual cadence missed ${missedIntervals} game-time intervals; gaps remain explicit in frames.jsonl.`] : []),
      ...(finite(summary.droppedAtFrameLimit) > 0 ? [`Visual capture reached maxFrames and dropped ${finite(summary.droppedAtFrameLimit)} due captures.`] : []),
      ...(integrity.nearBlackFrames > 0 ? [`${integrity.nearBlackFrames} captured frames are near-black; fullscreen/occlusion capture should be reviewed.`] : []),
      ...(summary.gameExitedCleanly === false ? [`Native game process ended with non-zero exit code ${finite(summary.gameExitCode, -1)}; the session may be truncated.`] : []),
      ...(frames.length === 0 ? ['No visual frames were captured for this session.'] : [])
    ],
    losses: ['Native inputs are window-focused observations; internal DirectInput state and semantic shot/peg callbacks are not claimed.']
  });

  await writeJson(output, run);
  const datasetResult = options.dataset
    ? await appendResearchDataset(options.dataset, [level, run])
    : null;
  return { run, level, datasetResult, sessionDirectory };
}

async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [sessionPath, outputPath] = positional;
  if (!sessionPath || !outputPath || !options.level) {
    console.error('Usage: node research/tools/finalize-capture-session.mjs <session-dir> <run.json> --level <canonical-level.json> [--dataset <dataset.jsonl>] [--fixed-step <seconds>] [--skip-frame-verification]');
    process.exitCode = 2;
    return;
  }
  const result = await finalizeCaptureSession(sessionPath, outputPath, {
    level: options.level,
    levelPath: String(options.level).replaceAll('\\', '/'),
    dataset: options.dataset,
    fixedStepSeconds: options['fixed-step'],
    verifyFrames: !options['skip-frame-verification'],
    id: options.id
  });
  console.log(`wrote ${outputPath} (${result.run.events.length} events, ${result.run.measurements.visualCapture.frameCount} frames)`);
  if (result.datasetResult) {
    console.log(`dataset ${result.datasetResult.path}: ${result.datasetResult.recordCount} records (${result.datasetResult.addedCount} added)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
