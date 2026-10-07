import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';
import {generateIntentLevel} from '../generators/destruction1/grammar.js';
import {validateIntentGeometry,structureKey} from '../generators/destruction1/geometry.js';
const campaign=JSON.parse(await readFile('data/des1/campaign.json','utf8')),proof=JSON.parse(await readFile('data/des1/proof.json','utf8'));
const keys=new Set();
for(const level of campaign.levels) {
 assert(validateIntentGeometry(level).valid,level.id);
 const key=structureKey(level);assert(!keys.has(key),'Duplicate composition');keys.add(key);
 assert(!level.metadata.intentGraph,'Mandatory graph returned');
 assert(level.pegs.length>=45,'Fragment instead of full level');
 assert(level.metadata.generator.plan.assemblies.filter(a=>['tower','seesaw','cage','cradle'].includes(a.type)).length>=2);
 assert(level.pegs.filter(p=>p.constructionRole==='cargo').every(p=>['orange','blue'].includes(p.type)));
 assert(!level.pegs.some(p=>p.type==='obstacle'&&p.shape==='circle'));
 const generated=generateIntentLevel(level.metadata.generator.seed,level.metadata.generator.mode);
 assert.deepEqual(generated.pegs,level.pegs,'Seed changed geometry');
 const p=proof.accepted.find(p=>p.id===level.id);assert(p?.accepted&&p.idle.orangeLeft===p.geometry.targets);
 const sim=new NativeSimulation(level).settle(2),cup=sim.game.pegs.find(p=>p.constructionRole==='receiver-wall');
 sim.scope(()=>sim.game.activatePeg(cup));sim.settle(1.5);
 assert.notEqual(sim.game.state,'lost','Early cup release incorrectly punished');
 // Standard victory depends only on the ordinary orange targets, even while
 // other receivers, magnets and design flow edges remain untouched.
 sim.game.hitPegIds.push(...sim.game.pegs.filter(p=>p.type==='orange').map(p=>p.id));
 assert(sim.game.isLevelObjectiveComplete(),'Extra win gate returned');
 assert.equal(sim.game.getUiStateSnapshot().intentProgress,undefined);
}
// Native ball collision, rather than direct activation, clears ordinary cargo.
for(const type of ['orange','blue']) {
 const fixture={...campaign.levels[0],pegs:[{id:'cargo',shape:'circle',type,x:200,y:180,destructionStatic:true},
  {id:'keep-playing',shape:'circle',type:'orange',x:350,y:400,destructionStatic:true}],groups:[],metadata:{}};
 const sim=new NativeSimulation(fixture).settle(1);sim.shoot(Math.PI/2);sim.settle(2);
 assert(!sim.game.pegs.some(p=>p.id==='cargo'),'Native ball did not clear '+type+' cargo');
}
const cross=generateIntentLevel('first','cross'),native=new NativeSimulation(cross);
for(const entry of cross.pegs.filter(p=>p.type==='portalBlue')) {
 const p=native.game.pegs.find(p=>p.id===entry.id);
 assert.equal(native.game.physics.findPortalExit(p).id,entry.portalTargetId);
 assert.equal(native.game.destructionSystem.findPortalExit(p,native.game.pegs).id,entry.portalTargetId);
}
assert.deepEqual(generateIntentLevel('repro','auto'),generateIntentLevel('repro','auto'));
const auto=generateIntentLevel('repro','auto');assert.deepEqual(auto,generateIntentLevel('repro',auto.metadata.generator.mode));
console.log('ok',campaign.levels.length,'ordinary full-level compositions; standard win, no early-release penalty, native clearable cargo, deterministic seeds and portal pairs');
