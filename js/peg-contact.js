// Standard-board contact properties shared by research capture and previews.
// Missing bounce follows physics.js, not the editor's *creation* default (2).
export function bumperContactProperties(peg) {
  if (peg?.type !== 'bumper') return {};
  return { bumperScale: peg.bumperScale || 1, bumperBounce: peg.bumperBounce ?? 0.65,
    bumperDisappear: !!peg.bumperDisappear, bumperOrange: !!peg.bumperOrange };
}

export function contactRadius(peg, pegRadius = 8.5) {
  return pegRadius * (peg?.type === 'bumper' ? (peg.bumperScale || 1) : 1);
}
