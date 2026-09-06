import { createHash } from 'node:crypto';

function seedWord(seed) {
  return Number.parseInt(
    createHash('sha256').update(String(seed)).digest('hex').slice(0, 8),
    16
  ) >>> 0;
}

export function createRandom(seed = '0') {
  let state = seedWord(seed);
  let spareNormal = null;

  function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  return {
    random,
    range(min, max) {
      return min + (max - min) * random();
    },
    integer(min, maxExclusive) {
      return Math.floor(this.range(min, maxExclusive));
    },
    normal(mean = 0, standardDeviation = 1) {
      if (spareNormal != null) {
        const value = spareNormal;
        spareNormal = null;
        return mean + value * standardDeviation;
      }
      const u = Math.max(Number.EPSILON, random());
      const v = random();
      const radius = Math.sqrt(-2 * Math.log(u));
      const angle = 2 * Math.PI * v;
      spareNormal = radius * Math.sin(angle);
      return mean + radius * Math.cos(angle) * standardDeviation;
    },
    shuffle(values) {
      const copy = [...values];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = this.integer(0, index + 1);
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    }
  };
}
