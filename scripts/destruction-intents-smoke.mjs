import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {IntentObjectives} from '../js/intent-objectives.js';
import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';
import {generateIntentLevel} from '../generators/destruction1/grammar.js';
import {validateIntentGeometry,structureKey} from '../generators/destruction1/geometry.js';
import {replayIntentLevel} from '../generators/destruction1/evaluate.mjs';
import {curateGeneratedPlaylist} from '../js/generated-playlist.js';
const campaign=JSON.parse(await readFile('data/des1/campaign.json','utf8')),proof=JSON.parse(await readFile('data/des1/proof.json','utf8'));
const keys=new Set();
for(const level of campaign.levels){
 assert(validateIntentGeometry(level).valid,level.id);const key=structureKey(level);assert(!keys.has(key),'Duplicate structure');keys.add(key);
 const p=proof.accepted.find(p=>p.id===level.id);assert(p?.accepted);const state=replayIntentLevel(level,p);assert(state.complete,level.id);assert.equal(state.intent.done,state.intent.total);
 for(const n of level.metadata.intentGraph.nodes.filter(n=>['cup','magnet'].includes(n.kind))){const capture=state.intentEvents.find(e=>e.stage===n.id&&e.type==='capture'),activation=state.intentEvents.find(e=>e.stage===n.id&&e.type==='activate');assert(capture&&activation&&capture.time<=activation.time,level.id+': release before capture');}
 const other=replayIntentLevel(level,p.holdout);assert(other.complete,'Holdout failed: '+level.id);
}
// A premature cup release cannot be rescued by clearing all orange targets.
const level=generateIntentLevel('first','cascade'),sim=new NativeSimulation(level).settle(2),cup=level.metadata.intentGraph.nodes.find(n=>n.kind==='cup');
sim.game.intentObjectives.activate(cup.triggerIds[0]);sim.settle(.1);assert.equal(sim.game.state,'lost');assert.equal(sim.game.isLevelObjectiveComplete(),false);
// Parallel cargo must visit its own receiver; two unrelated packets cannot
// satisfy each other's branch by crossing the final y threshold.
const branches=generateIntentLevel('first','parallel').metadata.intentGraph,obj=new IntentObjectives(branches),out=branches.nodes.at(-1),cargo=out.paths[0].cargoIds[0];
obj.passports.get(cargo).add(out.paths[1].stage);assert(!obj.eligible(out,cargo));obj.passports.get(cargo).add(out.paths[0].stage);assert(obj.eligible(out,cargo));
// A blocked-side collision is not a teleport. Explicit pairs override proximity
// in BOTH ball physics and the falling-body solver.
const cross=generateIntentLevel('first','cross'),native=new NativeSimulation(cross),portals=cross.metadata.intentGraph.nodes.filter(n=>n.kind==='portal');
for(const n of portals){const entry=native.game.pegs.find(p=>p.id===n.entryId);assert.equal(native.game.physics.findPortalExit(entry).id,n.exitId);assert.equal(native.game.destructionSystem.findPortalExit(entry,native.game.pegs).id,n.exitId);}
const io=native.game.intentObjectives,n=portals[0],id=n.cargoIds[0];io.passports.get(id).add(n.prerequisites[0]);io.portal([{bodyId:'peg:'+id,entry:{id:n.entryId},exit:null}]);assert.equal(io.nodes.get(n.id).delivered.size,0);
// Default maps show one family representative, full source variants interleave.
const des=JSON.parse(await readFile('data/des/campaign.json','utf8'));assert.equal(curateGeneratedPlaylist(des.levels).length,8);const variants=curateGeneratedPlaylist(des.levels,{variants:true});for(let i=1;i<variants.length;i++)assert.notEqual(variants[i].metadata.generator.family,variants[i-1].metadata.generator.family);
const bridge=des.levels.find(l=>l.metadata.generator.family==='bridges'),assembly=bridge.metadata.generator.plan.assemblies.find(a=>a.type==='bridge');
assert(assembly.shooterOpening>=27);const fixture={...bridge,pegs:bridge.pegs.filter(p=>assembly.pegs.includes(p.id))},bs=new NativeSimulation(fixture).settle(4),lock=fixture.pegs.find(p=>p.constructionRole==='bridge-lock');
bs.shoot(Math.atan2(lock.y-bs.game.launchY,lock.x-bs.game.launchX));assert(bs.game.hitPegIds.includes(lock.id)||bs.game.turnHitPegIds.includes(lock.id)||!bs.game.pegs.some(p=>p.id===lock.id),'Ball cannot reach the bridge lock');
console.log('ok',campaign.levels.length,'different native chains, two timing/RNG routes each; early-release failure, correct branch passports, explicit portal pairs, unlocked curated playlists and reachable bridge lock');
