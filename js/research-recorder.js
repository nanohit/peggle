// Developer-only browser recorder. It is activated only by ?research=1.

import { PHYSICS_CONFIG } from './physics.js';
import {
  cloneResearchValue,
  digestResearchLevel,
  digestResearchValue,
  makeResearchRunRecord,
  nativeLevelToResearchRecord,
  RESEARCH_TOOL_VERSION,
  sha256Text,
  stableStringify
} from './research-format.js';
import {
  BrowserVisualCapture,
  createResearchZip,
  jsonLines,
  makeCaptureSessionManifest,
  readBrowserCaptureOptions
} from './research-session.js';

const DEFAULT_GAME_REVISION = '6201ec1120f7dbadecf76a6e40710bb9bacab915';

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function safeLocation() {
  if (typeof window === 'undefined' || !window.location) return 'browser-memory';
  return `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
}

function makeId(prefix = 'run') {
  if (globalThis.crypto?.randomUUID) return `${prefix}:${globalThis.crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function sortedById(values) {
  return [...values].sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
}

function mechanicalBall(ball) {
  return {
    id: String(ball?.id ?? ''),
    active: !!ball?.active,
    x: finiteOrNull(ball?.x),
    y: finiteOrNull(ball?.y),
    vx: finiteOrNull(ball?.vx),
    vy: finiteOrNull(ball?.vy),
    radius: finiteOrNull(ball?.radius),
    stuck: !!ball?.stuck,
    portalCooldown: finiteOrNull(ball?.portalCooldown),
    side: ball?.side ?? null,
    ultraAimStuck: !!ball?.ultraAimStuck,
    yoyoEligible: ball?.yoyoEligible !== false
  };
}

function mechanicalPeg(peg, activeHitIds) {
  return {
    id: String(peg?.id ?? ''),
    type: String(peg?.type ?? ''),
    x: finiteOrNull(peg?.x),
    y: finiteOrNull(peg?.y),
    angle: finiteOrNull(peg?.angle) ?? 0,
    hit: activeHitIds.has(peg?.id),
    destructionAwake: !!peg?._destructionAwake,
    destructionFalling: !!peg?._destructionFalling,
    animationSuspended: !!peg?._animationSuspended
  };
}

export function isResearchRecordingEnabled(locationLike = globalThis.location) {
  if (!locationLike) return false;
  try {
    const url = new URL(locationLike.href || String(locationLike), 'http://localhost');
    const value = url.searchParams.get('research');
    return value != null && value !== '0' && value !== 'false' && value !== 'off';
  } catch {
    return false;
  }
}

export class BrowserResearchRecorder {
  constructor(game, levelData, options = {}) {
    if (!game || typeof game.subscribeGameplayEvents !== 'function' || typeof game.update !== 'function') {
      throw new TypeError('BrowserResearchRecorder requires a Game-like runtime.');
    }
    this.game = game;
    this.options = options;
    this.id = String(options.id || makeId('run:browser'));
    this.startedAt = String(options.at || new Date().toISOString());
    this.endedAt = null;
    this.wallStartedMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.wallEndedSeconds = null;
    this.step = 0;
    this.timeSeconds = 0;
    this.eventSequence = 0;
    this.inputSequence = 0;
    this.events = [];
    this.inputs = [];
    this.checkpoints = [];
    this.finished = false;
    this.finishReason = null;
    this.sampleEverySteps = Math.max(1, Math.trunc(options.sampleEverySteps || 60));
    this.gameRevision = String(options.gameRevision || DEFAULT_GAME_REVISION);
    this.levelRecord = nativeLevelToResearchRecord(cloneResearchValue(levelData), {
      sourcePath: options.sourcePath || safeLocation(),
      sourceRevision: this.gameRevision,
      gameRevision: this.gameRevision,
      tool: 'browser-native-level-snapshot',
      toolVersion: RESEARCH_TOOL_VERSION,
      at: this.startedAt,
      width: game.canvas?.width,
      height: game.canvas?.height
    });
    this.levelDigestPromise = digestResearchLevel(this.levelRecord);

    const captureOptions = { ...readBrowserCaptureOptions(), ...(options.capture || {}) };
    this.visualCapture = new BrowserVisualCapture(game, {
      sessionId: this.id,
      enabled: captureOptions.visual,
      fps: captureOptions.visualFps,
      maxFrames: captureOptions.maxFrames,
      imageType: captureOptions.imageType,
      imageQuality: captureOptions.imageQuality
    });

    this._originalUpdate = game.update;
    this._originalRender = game.render;
    this._originalStop = game.stop;
    const recorder = this;
    game.update = function researchWrappedUpdate(deltaTime) {
      recorder.step += 1;
      const seconds = Number.isFinite(deltaTime) ? Math.max(0, deltaTime / 1000) : 0;
      recorder.timeSeconds += seconds;
      const result = recorder._originalUpdate.apply(this, arguments);
      if (!recorder.finished && recorder.step % recorder.sampleEverySteps === 0) {
        recorder.captureCheckpoint();
      }
      return result;
    };
    game.render = function researchWrappedRender() {
      const result = recorder._originalRender.apply(this, arguments);
      recorder.captureRenderedFrame();
      return result;
    };
    game.stop = function researchWrappedStop() {
      recorder.finish('game-stop');
      return recorder._originalStop.apply(this, arguments);
    };

    this._unsubscribeGameplay = game.subscribeGameplayEvents((type, payload) => {
      this.captureGameplayEvent(type, payload);
    });
    this.installRawInputCapture();
    this.recordEvent('recording_started', {
      sampleEverySteps: this.sampleEverySteps,
      fixedStepSeconds: finiteOrNull(game.fixedStepMs / 1000),
      visualCapture: this.visualCapture.summary()
    });
  }

  wallTimeSeconds() {
    if (this.finished && this.wallEndedSeconds != null) return this.wallEndedSeconds;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return Math.max(0, (now - this.wallStartedMs) / 1000);
  }

  speedMultiplier() {
    return finiteOrNull(this.game?._currentTimeScale) || 1;
  }

  recordInput(type, data = {}) {
    if (this.finished) return null;
    const input = {
      sequence: this.inputSequence++,
      step: this.step,
      timeSeconds: this.timeSeconds,
      wallTimeSeconds: this.wallTimeSeconds(),
      type: String(type),
      data: cloneResearchValue(data || {})
    };
    this.inputs.push(input);
    this.recordEvent(`input.${type}`, { ...input.data, inputSequence: input.sequence });
    this.visualCapture.requestImmediate(`input.${type}`);
    return input;
  }

  installRawInputCapture() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    this._inputAbort = new AbortController();
    const signal = this._inputAbort.signal;
    const canvas = this.game.canvas;
    const pointerData = event => {
      const rect = canvas?.getBoundingClientRect?.();
      const width = rect?.width || canvas?.width || 1;
      const height = rect?.height || canvas?.height || 1;
      const clientX = finiteOrNull(event.clientX);
      const clientY = finiteOrNull(event.clientY);
      const x = clientX == null ? null : (clientX - (rect?.left || 0)) * ((canvas?.width || width) / width);
      const y = clientY == null ? null : (clientY - (rect?.top || 0)) * ((canvas?.height || height) / height);
      return {
        pointerId: event.pointerId ?? 0,
        pointerType: event.pointerType || 'mouse',
        button: event.button ?? -1,
        buttons: event.buttons ?? 0,
        x: finiteOrNull(x),
        y: finiteOrNull(y),
        normalizedX: x == null ? null : x / Math.max(1, canvas?.width || width),
        normalizedY: y == null ? null : y / Math.max(1, canvas?.height || height),
        pressure: finiteOrNull(event.pressure),
        isPrimary: event.isPrimary !== false
      };
    };
    const onPointerMove = event => {
      if (this._lastPointerMoveStep === this.step) return;
      this._lastPointerMoveStep = this.step;
      this.recordInput('pointer_move', pointerData(event));
    };
    canvas?.addEventListener?.('pointermove', onPointerMove, { capture: true, passive: true, signal });
    for (const [eventName, type] of [['pointerdown', 'pointer_down'], ['pointerup', 'pointer_up'], ['pointercancel', 'pointer_cancel']]) {
      canvas?.addEventListener?.(eventName, event => this.recordInput(type, pointerData(event)), {
        capture: true, passive: true, signal
      });
    }
    canvas?.addEventListener?.('wheel', event => this.recordInput('wheel', {
      deltaX: finiteOrNull(event.deltaX),
      deltaY: finiteOrNull(event.deltaY),
      deltaZ: finiteOrNull(event.deltaZ),
      deltaMode: event.deltaMode
    }), { capture: true, passive: true, signal });
    for (const [eventName, type] of [['keydown', 'key_down'], ['keyup', 'key_up']]) {
      document.addEventListener(eventName, event => {
        if (event.repeat && type === 'key_down') return;
        this.recordInput(type, {
          code: event.code || '', key: event.key || '', repeat: !!event.repeat,
          altKey: !!event.altKey, ctrlKey: !!event.ctrlKey,
          metaKey: !!event.metaKey, shiftKey: !!event.shiftKey
        });
      }, { capture: true, signal });
    }
    document.addEventListener('visibilitychange', () => this.recordInput('visibility', {
      state: document.visibilityState
    }), { signal });
    window.addEventListener('resize', () => this.recordInput('viewport_resize', {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      canvasWidth: canvas?.width,
      canvasHeight: canvas?.height,
      devicePixelRatio: finiteOrNull(globalThis.devicePixelRatio)
    }), { signal });
  }

  captureRenderedFrame() {
    if (this.finished) return;
    this.visualCapture.afterRender({
      step: this.step,
      gameTimeSeconds: this.timeSeconds,
      wallTimeSeconds: this.wallTimeSeconds(),
      speedMultiplier: this.speedMultiplier()
    });
  }

  syncDomProbe() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const root = document.documentElement;
    root.dataset.peggleResearchRecorder = this.finished ? 'finished' : 'attached';
    root.dataset.peggleResearchRunId = this.id;
    root.dataset.peggleResearchEvents = String(this.events.length);
    root.dataset.peggleResearchInputs = String(this.inputs.length);
    root.dataset.peggleResearchCheckpoints = String(this.checkpoints.length);
    root.dataset.peggleResearchState = String(this.game.state || '');
  }

  markLevelLoaded() {
    if (this.finished) return;
    this.recordEvent('level_loaded', {
      levelId: this.levelRecord.id,
      name: this.levelRecord.authored.name,
      objectCount: this.levelRecord.authored.objects.length,
      groupCount: this.levelRecord.authored.groups.length
    });
    this.visualCapture.requestImmediate('level_loaded');
    this.captureCheckpoint(true);
  }

  captureGameplayEvent(type, payload = {}) {
    if (this.finished) return;
    const data = cloneResearchValue(payload || {});
    if (type === 'shot_launched') {
      const launchPower = typeof this.game.getCurrentLaunchPower === 'function'
        ? this.game.getCurrentLaunchPower()
        : PHYSICS_CONFIG.launchPower;
      const shotInput = {
        sequence: this.inputSequence++,
        step: this.step,
        timeSeconds: this.timeSeconds,
        wallTimeSeconds: this.wallTimeSeconds(),
        type: 'launch',
        data: {
          angleRadians: finiteOrNull(this.game.aimAngle),
          power: finiteOrNull(launchPower),
          launcher: {
            x: finiteOrNull(this.game.launchX),
            y: finiteOrNull(this.game.launchY)
          },
          billiardLauncherIndex: finiteOrNull(this.game.billiardLauncherIndex)
        }
      };
      this.inputs.push(shotInput);
      data.inputSequence = shotInput.sequence;
      data.angleRadians = shotInput.data.angleRadians;
      data.power = shotInput.data.power;
      data.launcher = shotInput.data.launcher;
    }
    this.recordEvent(type, data, this.captureEventMechanical(type, data));
    if (type === 'shot_launched' || type === 'level_clear' || type === 'level_failed') {
      this.captureCheckpoint(true);
    }
  }

  captureEventMechanical(type, payload) {
    if (type === 'peg_hit' && payload?.pegId != null) {
      const peg = this.game.pegs?.find(candidate => candidate?.id === payload.pegId);
      const activeHits = new Set(this.game.turnHitPegIds || []);
      return {
        peg: peg ? mechanicalPeg(peg, activeHits) : null,
        balls: sortedById(this.game.balls || []).map(mechanicalBall)
      };
    }
    if (type === 'shot_launched' || type === 'bucket_catch') {
      return { balls: sortedById(this.game.balls || []).map(mechanicalBall) };
    }
    return undefined;
  }

  recordEvent(type, data = {}, mechanical = undefined) {
    const event = {
      sequence: this.eventSequence++,
      step: this.step,
      timeSeconds: this.timeSeconds,
      wallTimeSeconds: this.wallTimeSeconds(),
      speedMultiplier: this.speedMultiplier(),
      type: String(type),
      data: cloneResearchValue(data || {})
    };
    if (mechanical !== undefined) event.mechanical = cloneResearchValue(mechanical);
    this.events.push(event);
    this.syncDomProbe();
    return event;
  }

  captureMechanicalState() {
    const activeHits = new Set(this.game.turnHitPegIds || []);
    return {
      state: String(this.game.state || ''),
      score: finiteOrNull(this.game.score),
      ballsLeft: finiteOrNull(this.game.ballsLeft),
      shotsFired: finiteOrNull(this.game.shotsFired),
      aimAngle: finiteOrNull(this.game.aimAngle),
      cameraY: typeof this.game.getCameraY === 'function' ? finiteOrNull(this.game.getCameraY()) : 0,
      turnHitPegIds: [...activeHits].map(String).sort(),
      hitPegIds: [...(this.game.hitPegIds || [])].map(String).sort(),
      balls: sortedById(this.game.balls || []).map(mechanicalBall),
      pegs: sortedById(this.game.pegs || []).map(peg => mechanicalPeg(peg, activeHits)),
      bucket: cloneResearchValue(this.game.physics?.bucket || null),
      survival: typeof this.game.survivalRuntime?.getTrackerState === 'function'
        ? cloneResearchValue(this.game.survivalRuntime.getTrackerState())
        : null
    };
  }

  captureCheckpoint(force = false) {
    if (this.finished && !force) return null;
    const previous = this.checkpoints[this.checkpoints.length - 1];
    if (previous?.step === this.step && !force) return previous;
    const checkpoint = {
      step: this.step,
      timeSeconds: this.timeSeconds,
      sha256: null,
      state: this.captureMechanicalState()
    };
    this.checkpoints.push(checkpoint);
    this.syncDomProbe();
    return checkpoint;
  }

  finish(reason = 'manual') {
    if (this.finished) return;
    this.recordEvent('recording_finished', { reason });
    this.visualCapture.requestImmediate('recording_finished');
    // finish() can run between render ticks (for example during an export), so
    // sample the last fully composed canvas immediately instead of leaving the
    // final-frame request pending forever.
    this.captureRenderedFrame();
    this.captureCheckpoint(true);
    this.finished = true;
    this.finishReason = String(reason);
    this.wallEndedSeconds = Math.max(0,
      ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.wallStartedMs) / 1000);
    this.endedAt = new Date().toISOString();
    this._inputAbort?.abort();
    this.syncDomProbe();
  }

  async getRecord() {
    await this.visualCapture.flush();
    const levelDigest = await this.levelDigestPromise;
    const checkpoints = [];
    for (const checkpoint of this.checkpoints) {
      checkpoints.push({
        ...cloneResearchValue(checkpoint),
        sha256: await digestResearchValue(checkpoint.state)
      });
    }
    const eventCounts = {};
    for (const event of this.events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    const frameIndexText = jsonLines(this.visualCapture.frames);
    const visualSummary = this.visualCapture.summary();
    const artifacts = [];
    if (visualSummary.frameCount > 0) {
      artifacts.push({
        kind: 'frame-index',
        path: 'frames.jsonl',
        sha256: await sha256Text(frameIndexText),
        mediaType: 'application/x-ndjson',
        metadata: visualSummary
      });
      for (const frame of [this.visualCapture.frames[0], this.visualCapture.frames.at(-1)]) {
        if (!frame || artifacts.some(artifact => artifact.path === frame.path)) continue;
        artifacts.push({
          kind: 'screenshot', path: frame.path, sha256: frame.sha256,
          mediaType: frame.mediaType, width: frame.width, height: frame.height,
          metadata: {
            step: frame.step,
            gameTimeSeconds: frame.gameTimeMs / 1000,
            wallTimeSeconds: frame.wallTimeMs / 1000,
            role: frame.sequence === 0 ? 'first-frame' : 'last-frame'
          }
        });
      }
    }
    return makeResearchRunRecord({
      id: this.id,
      provenance: {
        source: {
          system: 'nanohit-peggle-browser-runtime',
          path: safeLocation(),
          revision: this.gameRevision
        },
        ingestion: {
          tool: 'browser-research-recorder',
          toolVersion: RESEARCH_TOOL_VERSION,
          toolRevision: this.gameRevision,
          at: this.endedAt || this.startedAt
        }
      },
      levelRef: {
        id: this.levelRecord.id,
        sha256: levelDigest
      },
      reproduction: {
        capability: 'observational',
        game: { id: 'nanohit-peggle', revision: this.gameRevision },
        tool: { id: 'browser-research-recorder', version: RESEARCH_TOOL_VERSION, revision: this.gameRevision },
        fixedStepSeconds: finiteOrNull(this.game.fixedStepMs / 1000) || (1 / 120),
        physicsConfig: cloneResearchValue(PHYSICS_CONFIG),
        seed: {
          algorithm: 'uncontrolled-math-random',
          master: String(this.options.seed ?? 'uncontrolled'),
          streams: {},
          unseededStreams: ['mechanics', 'visual']
        },
        inputs: this.inputs,
        platform: {
          userAgent: globalThis.navigator?.userAgent || 'unknown',
          language: globalThis.navigator?.language || 'unknown',
          viewport: {
            canvasWidth: finiteOrNull(this.game.canvas?.width),
            canvasHeight: finiteOrNull(this.game.canvas?.height),
            devicePixelRatio: finiteOrNull(globalThis.devicePixelRatio)
          }
        },
        floatPolicy: { storage: 'IEEE-754 JSON numbers', checkpointComparison: 'exact-canonical-json' }
      },
      events: this.events,
      checkpoints,
      measurements: {
        eventCounts,
        finalScore: finiteOrNull(this.game.score),
        shotsFired: finiteOrNull(this.game.shotsFired),
        finishReason: this.finishReason,
        durationSeconds: this.timeSeconds,
        wallDurationSeconds: this.wallTimeSeconds(),
        visualCapture: visualSummary
      },
      artifacts,
      extensions: {
        authoredLevelRecord: this.levelRecord,
        captureSession: {
          format: 'peggle-capture-session',
          version: 1,
          sessionId: this.id,
          frameIndex: visualSummary.frameCount > 0 ? 'frames.jsonl' : null,
          accelerationInvariant: true
        },
        note: 'Browser full-game exact replay is not yet claimed; see research/docs/DETERMINISM_AUDIT.md.'
      },
      warnings: [
        'Gameplay and visual Math.random streams are not yet seeded.',
        ...(visualSummary.droppedWhileEncoding || visualSummary.droppedAtLimit || visualSummary.missedScheduleIntervals
          ? ['Visual capture contains explicitly indexed cadence gaps; consult frames.jsonl and measurements.visualCapture.']
          : []),
        ...visualSummary.errors.map(error => `Visual capture error: ${error}`)
      ],
      losses: []
    });
  }

  async getBundle() {
    this.finish('bundle-export');
    const run = await this.getRecord();
    const level = this.levelRecord;
    const frameIndexText = jsonLines(this.visualCapture.frames);
    const session = makeCaptureSessionManifest({
      sessionId: this.id,
      runtime: { kind: 'browser', game: 'nanohit-peggle', revision: this.gameRevision },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      capturePolicy: this.visualCapture.summary(),
      streams: {
        events: 'events.jsonl', frames: 'frames.jsonl', frameDirectory: 'frames/',
        canonicalLevel: 'level.json', canonicalRun: 'run.json', dataset: 'dataset.jsonl'
      },
      summary: {
        eventCount: run.events.length,
        inputCount: run.reproduction.inputs.length,
        checkpointCount: run.checkpoints.length,
        frameCount: this.visualCapture.frames.length
      },
      warnings: run.warnings
    });
    const files = [
      { path: 'session.json', data: stableStringify(session, 2) + '\n' },
      { path: 'level.json', data: stableStringify(level, 2) + '\n' },
      { path: 'run.json', data: stableStringify(run, 2) + '\n' },
      { path: 'dataset.jsonl', data: `${stableStringify(level)}\n${stableStringify(run)}\n` },
      { path: 'events.jsonl', data: jsonLines(run.events) },
      { path: 'frames.jsonl', data: frameIndexText },
      ...await this.visualCapture.bundleFiles()
    ];
    return { session, level, run, files };
  }

  async download(filename = null) {
    const bundle = await this.getBundle();
    const blob = await createResearchZip(bundle.files, { at: this.endedAt });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || `${this.id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.zip`;
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    return bundle.run;
  }

  async downloadJson(filename = null) {
    this.finish('download');
    const record = await this.getRecord();
    const blob = new Blob([stableStringify(record, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || `${this.id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`;
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    return record;
  }
}

export function attachResearchRecorder(game, levelData, options = {}) {
  if (!isResearchRecordingEnabled() && options.force !== true) return null;
  const previous = globalThis.__peggleResearchRecorder;
  if (previous && previous !== game?.researchRecorder && typeof previous.finish === 'function') {
    previous.finish('replaced');
    if (!Array.isArray(globalThis.__peggleResearchHistory)) globalThis.__peggleResearchHistory = [];
    globalThis.__peggleResearchHistory.push(previous);
  }
  const recorder = new BrowserResearchRecorder(game, levelData, {
    ...options,
    capture: { ...readBrowserCaptureOptions(), ...(options.capture || {}) }
  });
  game.researchRecorder = recorder;
  globalThis.__peggleResearchRecorder = recorder;
  return recorder;
}
