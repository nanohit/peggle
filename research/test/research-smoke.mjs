import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserResearchRecorder } from '../../js/research-recorder.js';
import { researchLevelDigestPayload } from '../../js/research-format.js';
import { createResearchZip, GameTimeFrameScheduler } from '../../js/research-session.js';
import { finalizeCaptureSession } from '../tools/finalize-capture-session.mjs';
import { importGameLevel } from '../tools/import-game-level.mjs';
import { importHaggleTelemetry } from '../tools/import-haggle-telemetry.mjs';
import { readJson, sha256Bytes, sha256Value } from '../tools/lib/node-io.mjs';
import { verifyHeadlessLabReplay } from '../tools/replay-lab.mjs';
import { runHeadlessLab } from '../tools/run-lab.mjs';
import { validateResearchRecord } from '../tools/validate-record.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'research', 'fixtures');

function assertValid(record, options = {}) {
  const result = validateResearchRecord(record, options);
  assert.equal(result.valid, true, result.errors.join('\n'));
}

async function testSchemaParses() {
  const schema = JSON.parse(await readFile(path.join(ROOT, 'research', 'schema', 'research-record.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.format.const, 'peggle-research');
}

async function testNativeImportAndDeterministicLab() {
  const level = await importGameLevel(path.join(FIXTURES, 'native-mini.json'), {
    gameRevision: 'fixture-revision',
    at: '2026-08-09T00:00:00.000Z'
  });
  const reingestedLevel = await importGameLevel(path.join(FIXTURES, 'native-mini.json'), {
    gameRevision: 'fixture-revision',
    at: '2026-08-10T00:00:00.000Z'
  });
  assertValid(level);
  assert.equal(level.authored.objects.length, 3);
  assert.equal(
    sha256Value(researchLevelDigestPayload(level)),
    sha256Value(researchLevelDigestPayload(reingestedLevel)),
    'mechanical level digest must ignore ingestion timestamps'
  );
  const options = { angle: Math.PI / 2, power: 7.5, maxSteps: 1600, checkpointEvery: 30, seed: 'fixture', at: '2026-08-09T00:00:00.000Z' };
  const first = await runHeadlessLab(level, options);
  const second = await runHeadlessLab(level, options);
  assertValid(first, { verifyDigests: true });
  assertValid(second, { verifyDigests: true });
  assert.ok(first.measurements.hitObjectIds.includes('target-center'));
  assert.deepEqual(first.measurements, second.measurements);
  assert.equal(first.checkpoints.at(-1).sha256, second.checkpoints.at(-1).sha256);
  await verifyHeadlessLabReplay(level, first);
}

async function testFlashExtractor(tempDir) {
  const output = path.join(tempDir, 'flash-mini.json');
  execFileSync('python', [
    path.join(ROOT, 'research', 'tools', 'extract_peggle_flash.py'),
    path.join(FIXTURES, 'flash-mini.dat.xml'),
    output,
    '--revision', 'fixture-revision',
    '--at', '2026-08-09T00:00:00.000Z'
  ], { cwd: ROOT, stdio: 'pipe' });
  const record = await readJson(output);
  assertValid(record);
  assert.deepEqual(record.authored.objects.map(object => object.kind), ['segment', 'circle', 'brick']);
  assert.equal(record.authored.objects[1].source.raw.ball.mRadius, 10);
}

async function testBrowserRecorderContract() {
  const listeners = new Set();
  const level = JSON.parse(await readFile(path.join(FIXTURES, 'native-mini.json'), 'utf8'));
  const game = {
    canvas: { width: 400, height: 600 },
    state: 'idle',
    score: 0,
    ballsLeft: 10,
    shotsFired: 0,
    aimAngle: Math.PI / 2,
    launchX: 200,
    launchY: 40,
    fixedStepMs: 1000 / 120,
    pegs: level.pegs.map(peg => ({ ...peg })),
    groups: [],
    balls: [{ id: 'ball:test', active: false, x: 200, y: 40, vx: 0, vy: 0, radius: 8.5 }],
    turnHitPegIds: [],
    hitPegIds: [],
    physics: { bucket: { x: 200, y: 575, _phase: 1 } },
    survivalRuntime: { getTrackerState: () => ({ enabled: false }) },
    subscribeGameplayEvents(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update() { this.state = 'playing'; return null; },
    stop() {},
    getCurrentLaunchPower() { return 7.5; },
    getCameraY() { return 0; }
  };
  const recorder = new BrowserResearchRecorder(game, level, {
    gameRevision: 'fixture-revision',
    at: '2026-08-09T00:00:00.000Z',
    sampleEverySteps: 1
  });
  recorder.markLevelLoaded();
  game.balls[0].active = true;
  game.balls[0].vy = 7.5;
  game.shotsFired = 1;
  for (const listener of listeners) listener('shot_launched', { shotsFired: 1, ballsLeft: 9 });
  game.update(1000 / 120);
  game.turnHitPegIds.push('target-center');
  for (const listener of listeners) listener('peg_hit', { pegId: 'target-center', pegType: 'orange', points: 100 });
  recorder.finish('test');
  const record = await recorder.getRecord();
  assertValid(record, { verifyDigests: true });
  assert.equal(record.reproduction.inputs.length, 1);
  assert.ok(record.events.some(event => event.type === 'peg_hit'));
}

async function testHaggleTelemetryImport() {
  const level = await importGameLevel(path.join(FIXTURES, 'native-mini.json'), {
    gameRevision: 'fixture-revision',
    at: '2026-08-09T00:00:00.000Z'
  });
  const record = await importHaggleTelemetry(path.join(FIXTURES, 'haggle-mini.jsonl'), {
    levelId: level.id,
    levelSha256: sha256Value(researchLevelDigestPayload(level)),
    haggleRevision: 'fixture-revision',
    executableSha256: '0'.repeat(64),
    at: '2026-08-09T00:00:00.000Z'
  });
  assertValid(record);
  assert.equal(record.reproduction.capability, 'observational');
  assert.equal(record.reproduction.fixedStepSeconds, null);
  assert.equal(record.measurements.shotCount, 1);
  assert.equal(record.measurements.pegHitCount, 1);
  assert.equal(record.measurements.speedChangeCount, 1);
  assert.equal(record.measurements.maxSpeedMultiplier, 2);
  assert.equal(record.extensions.captureClock.accelerationInvariant, true);
  assert.equal(record.events.at(-1).timeSeconds, 1);
  assert.equal(record.events.at(-1).wallTimeSeconds, 0.65);
  assert.equal(record.artifacts[0].kind, 'telemetry-log');
}

async function testGameTimeVisualSchedulerAndZip() {
  const scheduler = new GameTimeFrameScheduler(30);
  assert.deepEqual(scheduler.consume(0), { scheduledGameTimeMs: 0, missedIntervals: 0 });
  assert.equal(scheduler.consume(16), null);
  assert.equal(Math.round(scheduler.consume(34).scheduledGameTimeMs), 33);
  const jumped = scheduler.consume(100);
  assert.equal(jumped.scheduledGameTimeMs, 100);
  assert.equal(jumped.missedIntervals, 1);
  const zip = await createResearchZip([
    { path: 'session.json', data: '{"ok":true}\n' },
    { path: 'frames/frame-000000.png', data: new Uint8Array([1, 2, 3, 4]) }
  ], { at: '2026-08-09T00:00:00.000Z' });
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual([...bytes.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06]);
}

async function testCaptureSessionFinalizer(tempDir) {
  const sessionDir = path.join(tempDir, 'capture-session');
  const frameDir = path.join(sessionDir, 'frames');
  await mkdir(frameDir, { recursive: true });
  const frameA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const frameB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
  await writeFile(path.join(frameDir, 'frame-00000000.png'), frameA);
  await writeFile(path.join(frameDir, 'frame-00000001.png'), frameB);
  const session = {
    format: 'peggle-capture-session', version: 1, sessionId: 'fixture-session', status: 'complete',
    startedAt: '2026-08-09T00:00:00.000Z',
    runtime: { kind: 'native-windows-x86', game: 'peggle-deluxe-fixture', executableSha256: '1'.repeat(64) },
    clock: { canonical: 'gameTimeMs', wall: 'monotonicMs', accelerationInvariant: true },
    streams: { events: 'events.jsonl', frames: 'frames.jsonl', frameDirectory: 'frames/' }
  };
  const rawEvents = [
    { sequence: 0, monotonicMs: 1000, gameTimeMs: 2000, speedMultiplier: 1, type: 'session_started', data: {} },
    { sequence: 1, monotonicMs: 1100, gameTimeMs: 2100, speedMultiplier: 1, type: 'input.pointer_move', data: { normalizedX: 0.5, normalizedY: 0.25 } },
    { sequence: 2, monotonicMs: 1300, gameTimeMs: 2400, speedMultiplier: 2, type: 'speed_change', data: { previous: 1, current: 2 } },
    { sequence: 3, monotonicMs: 1500, gameTimeMs: 2800, speedMultiplier: 2, type: 'input.pointer_button', data: { name: 'mouse_left', down: true } }
  ];
  const rawFrames = [
    { sequence: 0, path: 'frames/frame-00000000.png', sha256: sha256Bytes(frameA), mediaType: 'image/png', width: 640, height: 480, byteLength: frameA.length, monotonicMs: 1000, gameTimeMs: 2000, missedIntervals: 0, diagnostics: { nonBlackRatio: 0.7 } },
    { sequence: 1, path: 'frames/frame-00000001.png', sha256: sha256Bytes(frameB), mediaType: 'image/png', width: 640, height: 480, byteLength: frameB.length, monotonicMs: 1500, gameTimeMs: 2800, missedIntervals: 1, diagnostics: { nonBlackRatio: 0.8 } }
  ];
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  await writeFile(path.join(sessionDir, 'events.jsonl'), rawEvents.map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(sessionDir, 'frames.jsonl'), rawFrames.map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(sessionDir, 'capture-summary.json'), JSON.stringify({
    status: 'complete', endedAt: '2026-08-09T00:00:01.000Z',
    targetGameFps: 30, frameCount: 2, captureErrors: 0
  }));

  const level = await importGameLevel(path.join(FIXTURES, 'native-mini.json'), {
    gameRevision: 'fixture-revision', at: '2026-08-09T00:00:00.000Z'
  });
  const output = path.join(tempDir, 'capture.run.json');
  const dataset = path.join(tempDir, 'dataset.jsonl');
  const first = await finalizeCaptureSession(sessionDir, output, {
    level, dataset, fixedStepSeconds: 1 / 120,
    toolRevision: 'fixture'
  });
  assertValid(first.run);
  assert.equal(first.run.reproduction.inputs.length, 2);
  assert.equal(first.run.events.at(-1).timeSeconds, 0.8);
  assert.equal(first.run.events.at(-1).wallTimeSeconds, 0.5);
  assert.equal(first.run.measurements.maxSpeedMultiplier, 2);
  assert.equal(first.run.measurements.visualCapture.frameCount, 2);
  assert.equal(first.run.measurements.visualCapture.missedScheduleIntervals, 1);
  assert.equal(first.datasetResult.addedCount, 2);
  const second = await finalizeCaptureSession(sessionDir, output, {
    level, dataset, fixedStepSeconds: 1 / 120,
    toolRevision: 'fixture'
  });
  assert.equal(second.datasetResult.addedCount, 0, 'dataset append must be idempotent');
  const datasetRecords = (await readFile(dataset, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(datasetRecords.map(record => record.recordType), ['level', 'run']);
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'peggle-research-'));
try {
  const tests = [
    testSchemaParses,
    testNativeImportAndDeterministicLab,
    () => testFlashExtractor(tempDir),
    testBrowserRecorderContract,
    testHaggleTelemetryImport,
    testGameTimeVisualSchedulerAndZip,
    () => testCaptureSessionFinalizer(tempDir)
  ];
  for (const test of tests) {
    await test();
    console.log(`ok ${test.name || 'anonymous'}`);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
