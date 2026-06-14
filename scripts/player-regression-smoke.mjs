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

const tests = [
  testLimePegAliasNormalizesToGreen,
  testPortraitControllerTreatsAssetObjectsAsAuthoredSlots
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
