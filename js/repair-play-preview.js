// Fixed color assignment for a disposable native play preview. It is not an
// optimized orange policy and must never be fed back as composition editing.
export function makeStandardPlayPreview(level, seed = 'preview-v1') {
  const hash = value => {
    let h = 2166136261;
    for (const c of value) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    // Avalanche the index suffix: plain FNV orders neighboring member IDs
    // into long orange runs, an accidental placement policy of its own.
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return h >>> 0;
  };
  const copy = JSON.parse(JSON.stringify(level));
  copy.pegs.forEach(peg => { peg.type = 'blue'; });
  const ordered = [...copy.pegs].sort((a, b) => hash(`${seed}:${a.memberId}`) - hash(`${seed}:${b.memberId}`)
    || String(a.memberId).localeCompare(String(b.memberId)));
  ordered.slice(0, Math.min(25, ordered.length)).forEach(peg => { peg.type = 'orange'; });
  copy.metadata ||= {};
  copy.metadata.playPreview = { seed, orangePolicy: 'fixed-member-avalanche-hash-25-v1', notCompositionEvidence: true };
  return copy;
}
