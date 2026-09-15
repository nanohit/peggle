import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
  clear() {}
};

const { normalizeLevelData } = await import('../js/levels.js');
const {
  normalizeCharacterRegistry
} = await import('../js/character-config.js');
const { PortraitReactionController } = await import('../js/portrait-reactions.js');
const { Renderer } = await import('../js/renderer.js');
const { GpuPlayfieldRenderer } = await import('../js/gpu-playfield.js');
const { LevelTransitionFreeze } = await import('../js/level-transition-freeze.js');

function asset(key) {
  return {
    kind: 'asset',
    key,
    primaryUrl: `https://assets.example/${key}`
  };
}

function testLimePegAliasNormalizesToGreen() {
  const level = normalizeLevelData({
    name: 'lime-alias',
    pegs: [{ id: 'p1', type: 'lime', x: 10, y: 20 }],
    groups: []
  });
  assert.equal(level.pegs[0].type, 'green');
}

function testPortraitControllerTreatsAssetObjectsAsAuthoredSlots() {
  const calls = [];
  const visualLayout = {
    setCharacterPortraitSource(src, options) {
      calls.push({ src, slot: options?.slotName || '' });
    },
    clearCharacterPortraitRuntime() {}
  };
  let gameplayListener = null;
  const game = {
    subscribeGameplayEvents(listener) {
      gameplayListener = listener;
      return () => { gameplayListener = null; };
    },
    subscribeUiState(listener) {
      listener({ state: 'idle', ballsLeft: 5, orangePegsLeft: 12, totalOrangePegs: 12 }, 'subscribe');
      return () => {};
    }
  };

  const registry = normalizeCharacterRegistry({
    characters: {
      hero: {
        id: 'hero',
        name: 'Hero',
        slots: {
          idle: asset('idle.webp'),
          amused: asset('amused.webp')
        },
        personality: {
          baseline: { slot: 'idle', target: 0.1 },
          dwellMs: 0,
          impulseTable: {
            peg_hit: {
              magnitude: 1,
              distribution: { amused: 1 }
            }
          }
        }
      }
    }
  });

  const controller = new PortraitReactionController({ visualLayout });
  controller.setContext({
    level: { name: 'portrait-assets', character: { characterId: 'hero' } },
    registry,
    game
  });
  gameplayListener?.('peg_hit', { turnHitCount: 1 });
  controller.dispose();

  assert.deepEqual(
    calls.map(call => call.slot),
    ['idle', 'amused']
  );
  assert.equal(calls[1].src.key, 'amused.webp');
}

function makeCanvasHarness() {
  const calls = [];
  const ctx = {
    setTransform(...args) { calls.push(['setTransform', ...args]); },
    clearRect(...args) { calls.push(['clearRect', ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); }
  };
  const canvas = {
    width: 400,
    height: 600,
    style: {},
    getContext() { return ctx; }
  };
  return { canvas, ctx, calls };
}

function testRendererKeepsGameplayQualityStableAcrossHitBursts() {
  const { canvas } = makeCanvasHarness();
  const renderer = new Renderer(canvas);
  assert.equal(renderer._gpuPlayfield.adaptiveQuality, false);
  assert.equal(renderer._gpuPlayfield.quality, 'high');
  renderer.setPerformanceProfile('lite');
  assert.equal(renderer.performanceProfile, 'lite');
  assert.equal(renderer._gpuPlayfield.quality, 'high');
  assert.equal('_bucketImg' in renderer, false);
  renderer.dispose();
}

function testDisabledAdaptiveQualityIgnoresThirtyFpsCadence() {
  const gpu = new GpuPlayfieldRenderer({ adaptiveQuality: false });
  for (let frame = 0; frame < 100; frame++) {
    gpu._observeFrameCadence(1 / 30);
  }
  assert.equal(gpu.quality, 'high');
  assert.equal(gpu._cadenceSamples, 0);
}

async function testLastPegDoesNotQueueVictoryWarp() {
  const gameSource = await readFile(new URL('../js/game.js', import.meta.url), 'utf8');
  assert.equal(gameSource.includes("kind: 'victorySplash'"), false);
  assert.equal(gameSource.includes('queueVictoryShockwave('), false);
}

async function testOnlyBucketUsesAttachedSurfaceNoise() {
  const gpuSource = await readFile(new URL('../js/gpu-playfield.js', import.meta.url), 'utf8');
  const rendererSource = await readFile(new URL('../js/renderer.js', import.meta.url), 'utf8');
  assert.equal(gpuSource.includes('vec2 materialPoint = (!isPortal && vEnergy > 0.5) ? vSurface : vWorld;'), true);
  assert.equal(gpuSource.includes('float grain = fbm(materialPoint * 0.42);'), true);
  assert.equal(gpuSource.includes('layout(location=5) in vec2 aSurface;'), false);
  assert.equal((rendererSource.match(/surfaceAttached: true/g) || []).length, 2);
}

async function testTransitionOverlayKeepsFixedVignette() {
  const cssSource = await readFile(new URL('../css/neon-machine.css', import.meta.url), 'utf8');
  assert.match(cssSource, /\.level-transition-overlay::after\s*\{[^}]*box-shadow:/s);
  assert.match(cssSource, /\.level-transition-overlay\s*\{[^}]*border-radius:/s);
  assert.match(cssSource, /\.level-transition-strip\s*\{[^}]*z-index:\s*1/s);
}

function testRendererDisposeClearsSharedCanvasState() {
  const { canvas, calls } = makeCanvasHarness();
  const renderer = new Renderer(canvas);
  renderer._bucketParticles.push({ life: 1 });
  renderer._prevBucketFlash = 1;
  renderer.dispose();

  assert.deepEqual(calls.slice(-2), [
    ['setTransform', 1, 0, 0, 1, 0, 0],
    ['clearRect', 0, 0, 400, 600]
  ]);
  assert.equal(renderer._bucketParticles.length, 0);
  assert.equal(renderer._prevBucketFlash, 0);
}

function testTransitionCaptureSettlesBounceLighting() {
  const gpu = new GpuPlayfieldRenderer({ adaptiveQuality: false });
  const calls = [];
  gpu.ready = true;
  gpu.gl = { flush() { calls.push('flush'); } };
  gpu.canvas = {};
  gpu.width = 400;
  gpu.height = 600;
  gpu._targets = { lit: 'lit-a', litPrev: 'lit-b' };
  gpu._temporalSettleFrames = 8;
  gpu._renderDistanceField = rebuild => calls.push(`distance:${rebuild}`);
  gpu._renderCascades = () => calls.push('cascade');
  gpu._renderShading = () => calls.push('shade');
  gpu._renderBloom = () => calls.push('bloom');
  gpu._renderComposite = source => calls.push(`composite:${source}`);
  const targetCtx = { drawImage() { calls.push('copy'); } };

  assert.equal(gpu.drawTo2D(targetCtx, 0, 0, 400, 600, { settleLightingFrames: 3 }), true);
  assert.equal(calls.filter(call => call === 'distance:false').length, 3);
  assert.equal(calls.filter(call => call === 'cascade').length, 3);
  assert.equal(calls.filter(call => call === 'shade').length, 3);
  assert.deepEqual(calls.slice(0, 9), [
    'distance:false', 'cascade', 'shade',
    'distance:false', 'cascade', 'shade',
    'distance:false', 'cascade', 'shade'
  ]);
  assert.equal(calls.filter(call => call === 'bloom').length, 1);
  assert.equal(calls.at(-3), 'composite:lit-a');
  assert.deepEqual(calls.slice(-2), ['flush', 'copy']);
  assert.equal(gpu._temporalSettleFrames, 0);
  assert.equal(gpu._transitionLightingPrimed, true);
}

function testGpuOwnershipClearsLegacyForeground() {
  const renderer = Object.create(Renderer.prototype);
  const calls = [];
  renderer.width = 400;
  renderer.height = 600;
  renderer._gpuSceneActive = false;
  renderer._frameSkip = { baseSig: ['old'], fgSig: ['old'] };
  renderer.baseCtx = {
    setTransform(...args) { calls.push(['baseSetTransform', ...args]); },
    clearRect(...args) { calls.push(['baseClearRect', ...args]); }
  };
  renderer._foregroundCtx = {
    setTransform(...args) { calls.push(['setTransform', ...args]); },
    clearRect(...args) { calls.push(['clearRect', ...args]); }
  };

  assert.equal(renderer._setGpuSceneActive(true), true);
  assert.equal(renderer._frameSkip.baseSig, null);
  assert.equal(renderer._frameSkip.fgSig, null);
  assert.deepEqual(calls, [
    ['baseSetTransform', 1, 0, 0, 1, 0, 0],
    ['baseClearRect', 0, 0, 400, 600],
    ['setTransform', 1, 0, 0, 1, 0, 0],
    ['clearRect', 0, 0, 400, 600]
  ]);

  renderer.ctx = {};
  renderer._gpuSceneActive = true;
  assert.doesNotThrow(() => renderer.drawBucket({}, 0));
}

function testTransitionRevealInvalidatesBothRenderLayers() {
  const renderer = Object.create(Renderer.prototype);
  const calls = [];
  renderer.width = 400;
  renderer.height = 600;
  renderer._frameSkip = {
    epoch: 4,
    baseSig: ['base'],
    baseScratch: ['scratch'],
    baseSkipStreak: 3,
    fgSig: ['fg'],
    fgScratch: ['fg-scratch'],
    fgSkipStreak: 2
  };
  renderer.baseCtx = {
    setTransform(...args) { calls.push(['baseTransform', ...args]); },
    clearRect(...args) { calls.push(['baseClear', ...args]); }
  };
  renderer._foregroundCtx = {
    setTransform(...args) { calls.push(['fgTransform', ...args]); },
    clearRect(...args) { calls.push(['fgClear', ...args]); }
  };

  renderer.invalidateAfterTransitionReveal();

  assert.equal(renderer._frameSkip.epoch, 5);
  assert.equal(renderer._frameSkip.baseSig, null);
  assert.equal(renderer._frameSkip.fgSig, null);
  assert.deepEqual(calls, [
    ['baseTransform', 1, 0, 0, 1, 0, 0],
    ['baseClear', 0, 0, 400, 600],
    ['fgTransform', 1, 0, 0, 1, 0, 0],
    ['fgClear', 0, 0, 400, 600]
  ]);
}

function testRendererPrunesOutgoingForegroundLayers() {
  const removed = [];
  const stale = { parentNode: { removeChild(node) { removed.push(node); } } };
  const current = { parentNode: null };
  const host = {
    querySelectorAll(selector) {
      assert.equal(selector, '.game-foreground-layer');
      return [stale, current];
    },
    appendChild(node) {
      node.parentElement = this;
      node.parentNode = this;
    }
  };
  const renderer = Object.create(Renderer.prototype);
  renderer._foregroundCanvas = current;
  renderer._foregroundCtx = {};
  renderer._ensureLayerHost = () => host;
  renderer._sceneLayerZ = () => ({ foreground: 3 });
  renderer._applyLayerLayout = () => {};
  renderer._applyLayerVisibility = () => {};

  assert.equal(renderer._ensureRenderLayers(), true);
  assert.deepEqual(removed, [stale]);
}

function testFrameSkipSnapshotsDoNotAliasScratchBuffers() {
  const renderer = Object.create(Renderer.prototype);
  renderer._frameSkip = {
    baseSig: null,
    baseScratch: [],
    baseSkipStreak: 0
  };

  const first = renderer._frameSkip.baseScratch;
  first.push('first');
  assert.equal(renderer._adoptSigOrSkip(first, 'baseSig', 'baseScratch', 'baseSkipStreak'), true);

  const second = renderer._frameSkip.baseScratch;
  assert.notEqual(second, renderer._frameSkip.baseSig);
  second.push('second');
  assert.equal(renderer._adoptSigOrSkip(second, 'baseSig', 'baseScratch', 'baseSkipStreak'), true);
  assert.deepEqual(renderer._frameSkip.baseSig, ['second']);
}

function testTransitionFreezesCapturedGameUntilReveal() {
  const calls = [];
  const firstGame = {
    pause() { calls.push('pause:first'); },
    resume() { calls.push('resume:first'); }
  };
  const replacementGame = {
    pause() { calls.push('pause:replacement'); },
    resume() { calls.push('resume:replacement'); }
  };
  const freeze = new LevelTransitionFreeze();

  assert.equal(freeze.freeze(firstGame), true);
  assert.equal(freeze.freeze(firstGame), false);
  assert.equal(freeze.release(replacementGame), false);
  assert.deepEqual(calls, ['pause:first']);

  assert.equal(freeze.freeze(replacementGame), true);
  assert.equal(freeze.release(replacementGame), true);
  assert.deepEqual(calls, ['pause:first', 'pause:replacement', 'resume:replacement']);
}

const tests = [
  testLimePegAliasNormalizesToGreen,
  testPortraitControllerTreatsAssetObjectsAsAuthoredSlots,
  testRendererKeepsGameplayQualityStableAcrossHitBursts,
  testDisabledAdaptiveQualityIgnoresThirtyFpsCadence,
  testLastPegDoesNotQueueVictoryWarp,
  testOnlyBucketUsesAttachedSurfaceNoise,
  testTransitionOverlayKeepsFixedVignette,
  testRendererDisposeClearsSharedCanvasState,
  testTransitionCaptureSettlesBounceLighting,
  testGpuOwnershipClearsLegacyForeground,
  testTransitionRevealInvalidatesBothRenderLayers,
  testRendererPrunesOutgoingForegroundLayers,
  testFrameSkipSnapshotsDoNotAliasScratchBuffers,
  testTransitionFreezesCapturedGameUntilReveal
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
