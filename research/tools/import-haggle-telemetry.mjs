#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeResearchRunRecord } from '../../js/research-format.js';
import { digestFile, writeJson } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

export async function importHaggleTelemetry(inputPath, options = {}) {
  if (!options.levelId || !options.levelSha256) throw new Error('levelId and levelSha256 are required');
  const absoluteInput = path.resolve(inputPath);
  const relativeInput = path.relative(GAME_ROOT, absoluteInput).replaceAll('\\', '/');
  const sourcePath = String(options.sourcePath || (relativeInput.startsWith('..') ? absoluteInput : relativeInput));
  const inputSha256 = await digestFile(absoluteInput);
  const lines = (await readFile(absoluteInput, 'utf8')).split(/\r?\n/).filter(Boolean);
  const rawEvents = lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`); }
  });
  const hasGameClock = rawEvents.length > 0 && rawEvents.every(event => Number.isFinite(Number(event.gameTimeMs)));
  const baseWallMs = rawEvents.length > 0 ? Number(rawEvents[0].monotonicMs) || 0 : 0;
  const baseGameMs = hasGameClock ? Number(rawEvents[0].gameTimeMs) : baseWallMs;
  const events = rawEvents.map((event, index) => {
    const wallMs = Number(event.monotonicMs) || baseWallMs;
    const logicalMs = hasGameClock ? Number(event.gameTimeMs) : wallMs;
    const canonicalEvent = {
      sequence: index,
      step: index,
      timeSeconds: Math.max(0, (logicalMs - baseGameMs) / 1000),
      wallTimeSeconds: Math.max(0, (wallMs - baseWallMs) / 1000),
      speedMultiplier: Number(event.speedMultiplier) || 1,
      type: String(event.type || 'unknown'),
      data: event.data && typeof event.data === 'object' ? event.data : {}
    };
    if (event.type === 'peg_hit') {
      canonicalEvent.mechanical = {
        sourcePosition: { x: event.data?.x ?? null, y: event.data?.y ?? null }
      };
    }
    return canonicalEvent;
  });
  const inputs = events
    .filter(event => event.type === 'shot_begin')
    .map((event, sequence) => ({
      sequence,
      step: event.step,
      type: 'launch',
      data: {
        angleRadians: event.data.gunAngleRadians ?? null,
        angleDegrees: event.data.gunAngleDegrees ?? null
      }
    }));
  const variant = rawEvents.find(event => event.gameVariant)?.gameVariant || 'unknown';
  const speedMultipliers = rawEvents.map(event => Number(event.speedMultiplier) || 1);
  const maxSpeedMultiplier = speedMultipliers.reduce((maximum, value) => Math.max(maximum, value), 1);
  const transportVersion = rawEvents.find(event => Number.isInteger(event.version))?.version || 1;
  return makeResearchRunRecord({
    id: String(options.id || `run:haggle:${path.basename(inputPath, path.extname(inputPath))}`),
    provenance: {
      source: {
        system: 'haggle-runtime-telemetry',
        path: sourcePath,
        revision: String(options.haggleRevision || 'unknown'),
        sha256: inputSha256,
        gameVariant: variant,
        executableSha256: options.executableSha256 || null
      },
      ingestion: {
        tool: 'import-haggle-telemetry.mjs',
        toolVersion: '0.2.0',
        toolRevision: String(options.toolRevision || '6201ec1120f7dbadecf76a6e40710bb9bacab915'),
        at: options.at || new Date().toISOString()
      }
    },
    levelRef: { id: options.levelId, sha256: options.levelSha256 },
    reproduction: {
      capability: 'observational',
      game: { id: variant, revision: options.executableSha256 || 'unknown' },
      tool: { id: 'haggle-telemetry-mod', version: '0.2.0', revision: String(options.haggleRevision || 'unknown') },
      fixedStepSeconds: options.fixedStepSeconds == null ? null : Number(options.fixedStepSeconds),
      physicsConfig: { known: false },
      seed: {
        algorithm: 'unknown-source-rng',
        master: 'unobserved',
        streams: {},
        unseededStreams: ['mechanics', 'visual']
      },
      inputs,
      platform: { runtime: 'native-windows-x86', capture: 'haggle' },
      floatPolicy: { storage: 'source callback values', checkpointComparison: 'not-available' }
    },
    events,
    checkpoints: [],
    measurements: {
      eventCount: events.length,
      shotCount: inputs.length,
      pegHitCount: events.filter(event => event.type === 'peg_hit').length,
      speedChangeCount: events.filter(event => event.type === 'speed_change').length,
      maxSpeedMultiplier
    },
    artifacts: [{
      kind: 'telemetry-log',
      path: sourcePath,
      sha256: inputSha256,
      mediaType: 'application/x-ndjson'
    }],
    extensions: {
      rawTransportFormat: `peggle-haggle-telemetry/v${transportVersion}`,
      captureClock: {
        canonicalEventTime: hasGameClock ? 'gameTimeMs' : 'monotonicMs',
        wallTime: 'monotonicMs',
        accelerationInvariant: hasGameClock
      },
      sourceEventCount: rawEvents.length,
      rawTopLevelFields: [...new Set(rawEvents.flatMap(event => Object.keys(event)))].sort()
    },
    warnings: [
      'Haggle capture is observational: source fixed step, physics config, RNG state, exact game tick, and complete object identity are not exposed yet.',
      ...(maxSpeedMultiplier > 1
        ? ['Runtime acceleration was active. Canonical event time uses the virtual game clock; wallTimeSeconds preserves elapsed real time.']
        : []),
      ...(!hasGameClock
        ? ['Legacy telemetry has no gameTimeMs field; canonical event time falls back to wall-clock time and is not acceleration-invariant.']
        : [])
    ],
    losses: ['Raw Haggle callbacks do not yet expose exact simulation steps or stable source object IDs; retain the linked raw telemetry artifact.']
  });
}

async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath || !options['level-id'] || !options['level-sha256']) {
    console.error('Usage: node research/tools/import-haggle-telemetry.mjs <input.jsonl> <run.json> --level-id <id> --level-sha256 <sha256> [--haggle-revision <sha>] [--exe-sha256 <sha>]');
    process.exitCode = 2;
    return;
  }
  const record = await importHaggleTelemetry(inputPath, {
    levelId: options['level-id'],
    levelSha256: options['level-sha256'],
    haggleRevision: options['haggle-revision'],
    executableSha256: options['exe-sha256']
  });
  await writeJson(outputPath, record);
  console.log(`wrote ${outputPath} (${record.events.length} events)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
