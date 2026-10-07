import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {simulateSequence} from './native-simulator.mjs';
import {generateLevel,FAMILIES} from './grammar.js';
import {validateGeometry} from './geometry.js';
const campaign=JSON.parse(await readFile('data/des/campaign.json','utf8'));
const quality=JSON.parse(await readFile('data/des/quality.json','utf8'));
assert.equal(quality.levels.length,campaign.levels.length);
const proofs=[];
for(const level of campaign.levels){
 const q=quality.levels.find(q=>q.id===level.id);assert(q?.accepted);assert(validateGeometry(level).valid);
 assert.deepEqual(level,generateLevel(level.metadata.generator.seed,level.metadata.generator.family));
 for(const [name,shots,idle,seed] of [['route',q.route,10,q.routeSeed],['holdout',q.holdout.shots,2,q.routeSeed+'-holdout']]){
  assert(shots.length<=8);const result=simulateSequence(level,shots.map(s=>s.angle),{idleSeconds:idle,seed});
  assert(result.complete,level.id+' '+name+' must clear');assert(result.fallenTargets>=3);
  assert(result.crossAssemblyImpacts.length>=1);
  console.log('PROOF',level.id,name,shots.length,'shots',result.fallenTargets,'fallen');
  proofs.push({id:level.id,route:name,complete:true,shots:shots.length,fallenTargets:result.fallenTargets,interAssemblyImpacts:result.crossAssemblyImpacts.length});
 }
}
assert(FAMILIES.every(f=>campaign.levels.some(l=>l.metadata.generator.family===f.id)));
const sources=['generators/destruction/grammar.js','generators/destruction/geometry.js','generators/destruction/evaluate.mjs','generators/destruction/native-simulator.mjs','js/game.js','js/physics.js','js/destruction-mode.js','js/destruction-hinge.js'];
const implementationFingerprint=createHash('sha256').update((await Promise.all(sources.map(p=>readFile(p,'utf8')))).join('\n')).digest('hex');
await writeFile('data/des/proof.json',JSON.stringify({implementationFingerprint,levelCount:campaign.levels.length,families:FAMILIES.map(f=>f.id),proofs},null,2));
console.log('Catalogue verified with final native implementation:',campaign.levels.length,'levels');
