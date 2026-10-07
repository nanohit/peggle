import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {generateLevel,LAYOUTS,HEROES} from '../generators/destruction2/grammar.js';
import {validateGeometry} from '../generators/destruction2/geometry.js';
import {visualLevel} from '../generators/quality/metrics.js';
import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';
const campaign=JSON.parse(await readFile('data/des2/campaign.json','utf8')),proof=JSON.parse(await readFile('data/des2/proof.json','utf8'));
assert.equal(campaign.levels.length,12);
assert.equal(new Set(campaign.levels.map(l=>l.metadata.generator.layout)).size,6);
assert.equal(new Set(campaign.levels.map(l=>l.metadata.generator.hero)).size,5);
for(const l of campaign.levels){
 assert(validateGeometry(l).valid,l.id);
 assert(l.pegs.every(p=>['blue','orange','bumper','bombMagnet','portalBlue','portalOrange'].includes(p.type)));
 assert.equal(l.pegRadius,8.5);assert.equal(l.metadata.intentGraph,undefined);
 assert.deepEqual(generateLevel(l.metadata.generator).pegs,l.pegs,'URL parameters change geometry');
 const p=proof.accepted.find(r=>r.id===l.id);assert(p.proof.complete&&p.proof.replayComplete);
 const sim=new NativeSimulation(l,{seed:p.proof.seed}).settle(3);
 if(l.metadata.generator.hero==='motion'){
  const branch=sim.fork(),pose=visualLevel(l,branch.game.pegs),copy=structuredClone(pose);branch.settle(.5);assert.deepEqual(pose,copy,'Audit snapshot mutated');
  const moving=sim.game.pegs.filter(p=>p.groupId&&p.bezierGroupId);assert(moving.length>1);
  moving.sort((a,b)=>a.bezierIndex-b.bezierIndex);
  for(let i=1;i<moving.length;i++){const a=moving[i-1].curveSlices.at(-1),b=moving[i].curveSlices[0];assert(Math.hypot(a.x-b.x,a.y-b.y)<1e-5,'Moving ribbon lost continuous seam');}
 }
 if(l.metadata.generator.hero==='portal')assert(p.proof.first.some(s=>s.portalTeleports>0&&s.cleared>=2),'Decorative portal');
 if(l.metadata.generator.hero==='magnet')assert(sim.game.destructionSystem.simMagnetTicks>0,'Decorative magnet');
 for(const a of p.proof.angles){const shot=sim.shoot(a);assert(shot&&!shot.timeout,l.id+' timed out');sim.settle(1.5);}
 assert.equal(sim.game.state,'won',l.id+' did not finalize native victory');
 assert.equal(sim.game.getOrangePegsLeft(),0);
 assert(sim.summary().complete);assert(l.pegs.filter(p=>p.constructionRole==='cargo').every(p=>['blue','orange'].includes(p.type)));
}
for(const seed of ['auto-repro','another-seed','sample-7']){
 const a=generateLevel({seed});assert.deepEqual(a,generateLevel(a.metadata.generator),'Resolved URL differs from auto seed');
}
// Fork the moving Blast curve cache, advance both runtimes, compare geometry.
const gen=JSON.parse(await readFile('data/gen/alea.json','utf8'));
const orbit=gen.levels.find(l=>l.metadata.generator.family==='orbits');assert(orbit);
const native=new NativeSimulation(orbit).settle(2),fork=native.fork();native.settle(.5);fork.settle(.5);
assert.deepEqual(fork.game.pegs,native.game.pegs,'WeakSet cache clone altered Blast geometry');
// Exercise the production browser module in a worker, without opening a browser.
const worker=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;self.postMessage=d=>parentPort.postMessage(d);parentPort.on('message',data=>self.onmessage({data}));import(${JSON.stringify(new URL('../dist/des2-worker.js',import.meta.url).href)});`,{eval:true});
const result=await new Promise((resolve,reject)=>{
 const deadline=setTimeout(()=>{worker.terminate();reject(Error('Worker timeout'));},30000);
 worker.on('error',reject);worker.on('message',d=>{if(d.ready)worker.postMessage({seed:'phone-variant',layout:'auto',hero:'auto',density:.55,destruction:.35});if(d.level||d.error){clearTimeout(deadline);d.error?reject(Error(d.error)):resolve(d.level);}});
});await worker.terminate();assert(validateGeometry(result).valid);assert.deepEqual(generateLevel(result.metadata.generator).pegs,result.pegs);
const bootstrap=await readFile('js/player-bootstrap.js','utf8');assert(bootstrap.includes('unlockAll: true'));assert(bootstrap.includes('/data/des2/campaign.json'));assert(bootstrap.includes('dist/des2-worker.js'));
console.log('ok: 12 native winning replays, 6 layouts, 5 native mechanics, true curved bricks, URL determinism, production worker, Blast fork cache, ordinary objective');
