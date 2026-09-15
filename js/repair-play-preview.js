// Fixed color assignment for a disposable native play preview. It is not an
// optimized orange policy and must never be fed back as composition editing.
export function makeStandardPlayPreview(level, seed = 'preview-v2', targetMemberIds = null) {
  const hash = value => {
    let h = 2166136261;
    for (const c of value) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    // Avalanche the index suffix: plain FNV orders neighboring member IDs
    // into long orange runs, an accidental placement policy of its own.
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return h >>> 0;
  };
  const copy = JSON.parse(JSON.stringify(level));
  const eligible = copy.pegs.filter(peg => ['blue', 'orange'].includes(peg.type || 'blue'));
  eligible.forEach(peg => { peg.type = 'blue'; });
  const ordered = [...eligible].sort((a, b) => hash(`${seed}:${a.memberId}`) - hash(`${seed}:${b.memberId}`)
    || String(a.memberId).localeCompare(String(b.memberId)));
  // Freeze the target roster from the baseline for matched comparisons. A
  // newly added support must not secretly replace a target in the core.
  const roster = targetMemberIds ?? ordered.slice(0, 25).map(peg => peg.memberId);
  const targets = new Set(roster);
  eligible.filter(peg => targets.has(peg.memberId)).forEach(peg => { peg.type = 'orange'; });
  copy.metadata ||= {};
  copy.metadata.playPreview = { seed, orangePolicy: 'ordinary-only-frozen-roster-v2', targetMemberIds: [...roster],
    missingTargetMemberIds: roster.filter(id => !eligible.some(peg => peg.memberId === id)),
    notCompositionEvidence: true };
  return copy;
}
