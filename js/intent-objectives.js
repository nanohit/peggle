// Physical objectives observe native poses and contacts; they never move pegs or
// activate mechanisms. A cargo passport records which stages it actually visited.
export class IntentObjectives {
  constructor(graph) {
    this.graph = graph;
    this.nodes = new Map(graph.nodes.map(node => [node.id, {
      ...node, captured: new Set(), delivered: new Set(), dwell: new Map(),
      activatedAt: null, capturedAt: null, completedAt: null
    }]));
    this.passports = new Map(graph.cargo.map(p => [p.id, new Set()]));
    this.origins = new Map(graph.cargo.map(p => [p.id, p.source]));
    this.events = [];
    this.pendingPortalEvents = [];
    this.elapsed = 0;
    this.complete = false;
    this.failed = false;
    this.failureReason = null;
  }

  quota(node, ids) {
    if (ids.size < node.requiredCount) return false;
    if (!node.perSource) return true;
    const origins = new Set(node.cargoIds.map(id => this.origins.get(id)));
    return [...origins].every(source => [...ids].filter(id => this.origins.get(id) === source).length >= node.perSource);
  }

  eligible(node, id) {
    const passport = this.passports.get(id);
    if (!(node.prerequisites || []).every(stage => passport?.has(stage))) return false;
    const path = node.paths?.find(path => path.cargoIds.includes(id));
    return !path || passport?.has(path.stage);
  }

  activate(pegId) {
    for (const node of this.nodes.values()) {
      if (!node.triggerIds?.includes(pegId) || node.activatedAt !== null) continue;
      node.activatedAt = this.elapsed;
      this.events.push({type: 'activate', stage: node.id, pegId, time: this.elapsed});
      if (['cup','magnet'].includes(node.kind) && node.capturedAt === null) {
        this.failed = true;
        this.failureReason = 'Накопитель открыт раньше времени. Сначала собери груз, затем выпусти его.';
      }
    }
  }

  portal(events) {
    this.pendingPortalEvents.push(...(events || []).filter(event=>event.exit));
  }

  observePortal(node, events) {
    for (const event of events) {
      if (!event.exit) continue;
      const cargoId = event.bodyId?.startsWith('peg:') ? event.bodyId.slice(4) : null;
      if (!this.passports.has(cargoId)) continue;
        if (node.entryId !== event.entry?.id || !this.eligible(node, cargoId)) continue;
        if (node.delivered.has(cargoId)) continue;
        node.delivered.add(cargoId);
        this.passports.get(cargoId).add(node.id);
        this.events.push({type: 'transport', stage: node.id, cargoId, time: this.elapsed});
    }
  }

  tick(pegs, dt) {
    if (this.complete || this.failed) return;
    this.elapsed += dt;
    const portalEvents=this.pendingPortalEvents.splice(0);
    const live = new Map(pegs.map(p => [p.id, p]));
    for (const node of this.nodes.values()) {
      // A fast packet can leave its source and enter a portal in the same game
      // frame. Observe transfers after upstream source poses have been recorded.
      if(node.kind==='portal')this.observePortal(node,portalEvents);
      for (const id of node.cargoIds) {
        const p = live.get(id);
        if (!p || !this.eligible(node, id)) continue;
        if (node.kind === 'source') {
          if (node.activatedAt !== null && p.y > node.releaseY) {
            node.delivered.add(id); this.passports.get(id).add(node.id);
          }
        } else if (node.kind === 'cup' || node.kind === 'magnet') {
          const region = node.region;
          const inside = node.kind === 'magnet'
            ? Math.hypot(p.x - region.x, p.y - region.y) < region.radius
            : p.x > region.minX && p.x < region.maxX && p.y > region.minY && p.y < region.maxY;
          // Capture precedes release: opening an empty vessel does not fulfil a
          // collect-then-pour objective, even if cargo later falls through it.
          if (node.activatedAt === null && inside) {
            const dwell = (node.dwell.get(id) || 0) + dt;
            node.dwell.set(id, dwell);
            if (dwell >= (node.holdSeconds || 0.25)) node.captured.add(id);
          } else if (!node.captured.has(id)) node.dwell.delete(id);
          if (node.capturedAt === null && this.quota(node, node.captured)) {
            node.capturedAt = this.elapsed;
            this.events.push({type: 'capture', stage: node.id, cargoIds: [...node.captured], time: this.elapsed});
          }
          if (node.capturedAt !== null && node.activatedAt !== null && node.captured.has(id) && !inside) {
            node.delivered.add(id); this.passports.get(id).add(node.id);
          }
        } else if (node.kind === 'outlet' && p.y > node.releaseY) {
          node.delivered.add(id); this.passports.get(id).add(node.id);
        }
      }
      if (node.completedAt === null && this.quota(node, node.delivered)) {
        node.completedAt = this.elapsed;
        this.events.push({type: 'complete', stage: node.id, cargoIds: [...node.delivered], time: this.elapsed});
      }
    }
    this.complete = [...this.nodes.values()].every(node => node.completedAt !== null);
    // Only irreversible loss fails the objective. Cargo still present may be
    // nudged, caught again, or released in a later shot.
    if (!this.complete) {
      this.failed = [...this.nodes.values()].some(node => {
        if (node.completedAt !== null) return false;
        const possible = new Set([...node.delivered, ...node.cargoIds.filter(id => live.has(id))]);
        return !this.quota(node, possible);
      });
    }
  }

  snapshot() {
    const nodes = [...this.nodes.values()];
    const current = nodes.find(n => n.completedAt === null && (n.prerequisites || [])
      .every(id => this.nodes.get(id)?.completedAt !== null)) || nodes.find(n => n.completedAt === null);
    const done = nodes.reduce((sum, n) => sum + (n.kind === 'cup' || n.kind === 'magnet'
      ? Number(n.capturedAt !== null) + Number(n.completedAt !== null) : Number(n.completedAt !== null)), 0);
    const total = nodes.reduce((sum, n) => sum + (n.kind === 'cup' || n.kind === 'magnet' ? 2 : 1), 0);
    let instruction = current?.instruction || 'Цепочка завершена';
    if (current?.capturedAt !== null && current?.releaseInstruction) instruction = current.releaseInstruction;
    if (this.failed) instruction = this.failureReason || 'Груз потерян. Начни заново и сохрани путь до чаши.';
    return {done, total, complete: this.complete, failed: this.failed, instruction,
      current: current?.id, captures: current?.captured.size || 0, required: current?.requiredCount || 0};
  }
}
