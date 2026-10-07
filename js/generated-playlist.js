// A source export can contain several seed variants of one composition. Keep the
// exports intact, but make the default play order a tour of distinct compositions.
export function curateGeneratedPlaylist(levels, { variants = false, selectedId = null } = {}) {
  const exact = new Set();
  const unique = levels.filter(level => {
    const geometry = JSON.stringify([level.pegs.map(p => [p.type, p.shape, p.x, p.y, p.angle || 0,
      p.width, p.height, p.curveSlices, p.destructionStatic, p.destructionPhysicsOnHit,
      p.destructionPhysicsOnHitBallOnly,p.destructionHinge,p.animation,
      p.magnetMode,p.magnetRadius,p.magnetStrength,p.magnetBlast,p.magnetKnockout,
      p.portalScale,p.portalOneWay,p.portalOneWayFlip,level.pegs.findIndex(q=>q.id===p.portalTargetId),
      level.groups?.findIndex(g=>g.id===p.groupId)]),level.groups?.map(g=>[g.destructionBody,g.animation]),
      level.destruction,level.pvp,level.flippers,level.ballCount]);
    if (exact.has(geometry)) return false;
    exact.add(geometry);
    return true;
  });
  if (variants) {
    // Round-robin avoids putting near-identical variants next to each other.
    const families = new Map();
    for (const level of unique) {
      const key = level.metadata?.generator?.family || level.id;
      if (!families.has(key)) families.set(key, []);
      families.get(key).push(level);
    }
    const ordered = [];
    while ([...families.values()].some(v => v.length)) {
      for (const queue of families.values()) if (queue.length) ordered.push(queue.shift());
    }
    return ordered;
  }
  const representatives = new Map();
  for (const level of unique) {
    const key = level.metadata?.generator?.family || level.id;
    if (!representatives.has(key) || level.id === selectedId) representatives.set(key, level);
  }
  return [...representatives.values()];
}
