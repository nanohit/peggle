import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeSimulation} from './native-simulator.mjs';

const campaign = JSON.parse(await readFile('data/des/campaign.json', 'utf8'));
const selectionProof = JSON.parse(await readFile('data/des/proof.json', 'utf8'));
const sources = ['generators/destruction/grammar.js', 'generators/destruction/geometry.js',
  'generators/destruction/evaluate.mjs', 'generators/destruction/native-simulator.mjs',
  'js/game.js', 'js/physics.js', 'js/destruction-mode.js', 'js/destruction-hinge.js'];
const implementationFingerprint = createHash('sha256')
  .update((await Promise.all(sources.map(p => readFile(p, 'utf8')))).join('\n')).digest('hex');
const levels = [];
for (const level of campaign.levels) {
  const sim = new NativeSimulation(level).settle(6);
  const before = new Map(sim.summary().pose.map(p => [p.id, p]));
  sim.settle(4);
  const idle = sim.summary();
  const lateDrift = Math.max(0, ...idle.pose.map(p => Math.hypot(p.x - before.get(p.id).x, p.y - before.get(p.id).y)));
  assert.equal(idle.orangeLeft, idle.orangeTotal, level.id + ': cargo must remain before launch');
  assert.equal(idle.fallenTargets, 0, level.id + ': no targets may fall before launch');
  assert(lateDrift < 2.5, level.id + ': structure must settle');
  const shots = [2.4, Math.PI - 2.4].map(angle => sim.fork().shoot(angle));
  assert(shots.some(s => s.hitCount > 0 || s.fallenTargets > 0), level.id + ': launch must interact with the structure');
  levels.push({id: level.id, idleTargets: idle.orangeLeft, idleFallen: idle.fallenTargets, lateDrift, shots});
  console.log('ok rolling catalogue', level.id, 'drift', lateDrift.toFixed(4));
}
await writeFile('data/des/physics-check.json', JSON.stringify({
  physics: 'rolling-contact-v1', implementationFingerprint,
  selectionPhysicsFingerprint: selectionProof.implementationFingerprint,
  scope: '10-second idle stability and two independent native launch probes; original selection routes are historical',
  levels
}, null, 2));
