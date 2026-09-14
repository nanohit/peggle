import assert from 'node:assert/strict';

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
  assert.equal('_bucketImg' in renderer, false);
  renderer.dispose();
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
  gpu._renderShading = () => calls.push('shade');
  gpu._renderBloom = () => calls.push('bloom');
  gpu._renderComposite = source => calls.push(`composite:${source}`);
  const targetCtx = { drawImage() { calls.push('copy'); } };

  assert.equal(gpu.drawTo2D(targetCtx, 0, 0, 400, 600, { settleLightingFrames: 3 }), true);
  assert.equal(calls.filter(call => call === 'shade').length, 3);
  assert.equal(calls.filter(call => call === 'bloom').length, 1);
  assert.equal(calls.at(-3), 'composite:lit-a');
  assert.deepEqual(calls.slice(-2), ['flush', 'copy']);
  assert.equal(gpu._temporalSettleFrames, 0);
}

function testGpuOwnershipClearsLegacyForeground() {
  const renderer = Object.create(Renderer.prototype);
  const calls = [];
  renderer.width = 400;
  renderer.height = 600;
  renderer._gpuSceneActive = false;
  renderer._frameSkip = { baseSig: ['old'], fgSig: ['old'] };
  renderer._foregroundCtx = {
    setTransform(...args) { calls.push(['setTransform', ...args]); },
    clearRect(...args) { calls.push(['clearRect', ...args]); }
  };

  assert.equal(renderer._setGpuSceneActive(true), true);
  assert.equal(renderer._frameSkip.baseSig, null);
  assert.equal(renderer._frameSkip.fgSig, null);
  assert.deepEqual(calls, [
    ['setTransform', 1, 0, 0, 1, 0, 0],
    ['clearRect', 0, 0, 400, 600]
  ]);

  renderer.ctx = {};
  renderer._gpuSceneActive = true;
  assert.doesNotThrow(() => renderer.drawBucket({}, 0));
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
  testRendererDisposeClearsSharedCanvasState,
  testTransitionCaptureSettlesBounceLighting,
  testGpuOwnershipClearsLegacyForeground,
  testTransitionFreezesCapturedGameUntilReveal
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
