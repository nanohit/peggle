import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {validateIntentGeometry as validateGeometry} from './geometry.js';

export function intentScore(sim) {
  const objectives = sim.game.intentObjectives;
  if (objectives.failed || sim.game.state === 'lost') return -1e6;
  let score = objectives.snapshot().done * 1000;
  for (const node of objectives.nodes.values()) {
    if (['cup', 'magnet'].includes(node.kind) && node.activatedAt !== null && node.capturedAt === null) return -1e6;
    score += Math.min(node.delivered.size, node.requiredCount) * 60 / node.requiredCount;
    score += Math.min(node.captured.size, node.requiredCount) * 100 / node.requiredCount;
    if (node.kind === 'source' && node.activatedAt !== null) score += 30;
    if (['cup','magnet'].includes(node.kind) && node.capturedAt !== null && node.activatedAt !== null) {
      score += 30 + node.triggerIds.filter(id => !sim.game.pegs.some(p => p.id === id) || sim.game.hitPegIds.includes(id)).length * 8;
    }
  }
  return score + (sim.summary().complete ? 100000 : 0) - sim.shots.length * 5;
}

export function proposals(sim) {
  const g = sim.game, nodes = [...g.intentObjectives.nodes.values()];
  const ready = nodes.filter(n => n.completedAt === null &&
    ((n.kind === 'source' && n.activatedAt === null) || (n.capturedAt !== null && ['cup','magnet'].includes(n.kind))));
  const targets = new Set(ready.flatMap(n => n.triggerIds).filter(id => g.pegs.some(p => p.id === id) && !g.hitPegIds.includes(id)));
  const unsafe = new Set(nodes.filter(n => ['cup','magnet'].includes(n.kind) && n.capturedAt === null).flatMap(n => n.triggerIds));
  const candidates = sim.scope(() => Array.from({length:151}, (_,i) => {
    const angle = .045 + i * (Math.PI-.09)/150;
    const path = g.physics.predictTrajectory(g.launchX, g.launchY, angle, g.getCurrentLaunchPower(), 700, false);
    const hits = path.hits.map(p => p.pegId);
    const firstTarget = hits.findIndex(id => targets.has(id));
    const bad = hits.findIndex(id => unsafe.has(id));
    return {angle, score: (firstTarget >= 0 ? 100-firstTarget*3 : -50) - (bad >= 0 ? 110 : 0)};
  })).sort((a,b) => b.score-a.score);
  const result = [];
  for (const p of candidates) {
    if (result.every(a => Math.abs(a-p.angle) > .022)) result.push(p.angle);
    if (result.length === 20) break;
  }
  return result;
}

export function findIntentRoute(level, {idleSeconds=6, seed='intent-proof', maxShots=level.ballCount}={}) {
  let sim = new NativeSimulation(level,{seed}).settle(Math.max(0,idleSeconds-2)), probes=0;
  const beforeIdle = new Map(sim.game.pegs.map(p => [p.id,{x:p.x,y:p.y}]));
  sim.settle(Math.min(2,idleSeconds));
  const idle = sim.summary();
  idle.lateDrift=Math.max(0,...sim.game.pegs.map(p => Math.hypot(p.x-beforeIdle.get(p.id).x,p.y-beforeIdle.get(p.id).y)));
  for (let turn=0; turn<maxShots && !sim.summary().complete && sim.game.state !== 'lost'; turn++) {
    if (sim.game.ballsLeft <= 0) break;
    const baseline = intentScore(sim);
    let best = null;
    for (const angle of proposals(sim)) {
      const candidate = sim.fork();
      const shot = candidate.shoot(angle); probes++;
      if (shot.timeout) continue;
      // Wait for the cargo separately from the ball. A safe shot may end before
      // a falling packet has settled; no scripted movement is added here.
      candidate.settle(2);
      const score = intentScore(candidate);
      if (!best || score > best.score) best={candidate,score};
      if (candidate.summary().complete) break;
    }
    if (!best || best.score <= baseline) break;
    sim=best.candidate;
  }
  return {sim, probes, idle};
}

export function evaluateIntentLevel(level,options={}) {
  const geometry = validateGeometry(level);
  if (!geometry.valid) return {accepted:false, geometry};
  const result = findIntentRoute(level,options);
  const state = result.sim.summary();
  const accepted = state.complete && result.idle.lateDrift < 2.5 && result.idle.intent.done === 0 && !result.idle.intent.failed;
  return {accepted, geometry, idle:{initialDrift:result.idle.maxDrift,lateDrift:result.idle.lateDrift,progress:result.idle.intent.done},
    seed:options.seed || 'intent-proof', idleSeconds:options.idleSeconds || 6,
    route:state.shots, progress:state.intent, events:state.intentEvents, probes:result.probes};
}

export function replayIntentLevel(level,proof,{idleSeconds=proof.idleSeconds,seed=proof.seed}={}) {
  const sim = new NativeSimulation(level,{seed}).settle(idleSeconds);
  for (const shot of proof.route) {
    if(sim.summary().complete || sim.game.state==='lost' || sim.game.ballsLeft<=0)break;
    sim.shoot(shot.angle);sim.settle(2);
  }
  return sim.summary();
}
