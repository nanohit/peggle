import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {measure} from '../quality/machine.mjs';
import {visualLevel} from '../quality/metrics.js';
import {validateGeometry} from '../destruction2/geometry.js';
import {animationEnvelope} from '../destruction4/envelope.js';
import {RUNTIME_SOURCES} from '../destruction3/cache.mjs';
import {generateFormation,FORMS} from './formations.js';
import {profile} from './profile.js';

export const SOURCES={alea:'cdn-data/primary.json',blast:'data/gen/alea.json',des1:'data/des1/campaign.json',des2:'data/des2/campaign.json',des3:'data/des3/campaign.json',des5:'data/des5/campaign.json',fresh:'data/des6/formations.json'};
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
function replay(level,proof){
 const sim=new NativeSimulation(level,{seed:proof.seed}).settle(proof.idleSeconds??3),frames=[{turn:0,...visualLevel(level,sim.game.pegs)}];
 for(const [i,angle] of proof.angles.entries()){
  if(sim.summary().complete)break;sim.samples=[];const shot=sim.shoot(angle,{trace:true});if(shot?.timeout)return {complete:false};sim.settle(1.5);
  const paths=[[]];for(const p of sim.samples.filter((_,j)=>j%6===0).map(s=>s.balls[0]).filter(Boolean)){if(paths.at(-1).length&&Math.hypot(p.x-paths.at(-1).at(-1).x,p.y-paths.at(-1).at(-1).y)>125)paths.push([]);paths.at(-1).push(p);}
  frames.push({turn:i+1,...visualLevel(level,sim.game.pegs),paths});
 }
 return {complete:sim.summary().complete,frames,shots:sim.shots,portalTeleports:sim.shots.reduce((n,s)=>n+s.portalTeleports,0),fallen:sim.summary().fallenTargets};
}
if(!isMainThread){
 const {level,source,cached,key}=workerData;let reason=null;
 if(source==='fresh'){
  const geometry=validateGeometry(level),envelope=animationEnvelope(level);
  if(!geometry.valid)reason='geometry:'+geometry.errors.slice(0,3).join(',');
  else if(!envelope.valid)reason='motion-envelope';
 }
 const idle=new NativeSimulation(level,{seed:'des6-idle'}).settle(12).summary();
 if(idle.orangeLeft!==idle.orangeTotal)reason='idle-target-loss';
 if(reason){parentPort.postMessage({id:level.id,source,key,reason});}
 else{
  let proof=cached?.complete&&cached?.replayComplete?cached:null,evidence=proof?replay(level,proof):null;
  if(!evidence?.complete){proof=measure(level);evidence=proof.complete&&proof.replayComplete?{complete:true,frames:proof.frames,portalTeleports:proof.portalTeleports,fallen:proof.fallen}:null;}
  if(!evidence?.complete)reason='no-full-native-route';
  else if(proof.shots<2||proof.peakFirstFraction>.85)reason='too-autonomous';
  if(!reason){proof={...proof,frames:evidence.frames,portalTeleports:evidence.portalTeleports,fallen:evidence.fallen};const p=profile(level,source,proof);parentPort.postMessage({id:level.id,source,key,profile:p,proof:{...proof,first:undefined},provenance:cached&&evidence?'Existing route replayed in current native Game; exact source level preserved':'New native adaptive search and independent replay',idle:{seconds:12,targets:idle.orangeTotal},level:source==='fresh'?level:undefined});}
  else parentPort.postMessage({id:level.id,source,key,reason,coverage:proof.coverage,shots:proof.shots});
 }
}else if(process.argv[1]?.endsWith('/build-bank.mjs')){
 await mkdir('data/des6',{recursive:true});
 const nativeFingerprint=hash((await Promise.all(RUNTIME_SOURCES.map(p=>readFile(p)))).join('\n')+'\nbank-policy-1');
 const fingerprint=hash(nativeFingerprint+(await readFile('generators/destruction6/profile.js'))+(await readFile('generators/destruction6/formations.js')));
 let previous;try{previous=await read('data/des6/bank-proof.json');}catch{}
 const freshInputs=FORMS.flatMap(form=>Array.from({length:6},(_,i)=>generateFormation({seed:'new-'+i,form}))),freshKeys=new Set(freshInputs.map(l=>hash(JSON.stringify(l))));
 const keep=r=>r.source!=='fresh'||freshKeys.has(r.key);
 const accepted=previous?.nativeFingerprint===nativeFingerprint?previous.accepted.filter(keep):[],rejected=previous?.nativeFingerprint===nativeFingerprint?previous.rejected.filter(keep):[],queue=[],inventory={},sourceLevels={};
 for(const [source,file] of Object.entries(SOURCES)){
  if(source==='fresh')continue;const bytes=await readFile(file),campaign=JSON.parse(bytes);sourceLevels[source]=campaign.levels;inventory[source]={file,sha256:hash(bytes),levels:campaign.levels.length};
  let proofs=[];if(['des2','des3','des5'].includes(source))proofs=(await read('data/'+source+'/proof.json')).accepted;
  const seen=new Set();for(const level of campaign.levels){
   if(seen.has(level.id))continue;seen.add(level.id);
   if((level.pegRadius||8.5)!==8.5||level.pegs.filter(p=>p.type==='orange').length<15||level.survival?.enabled||level.pvp?.enabled)continue;
   const key=hash(JSON.stringify(level));if([...accepted,...rejected].some(r=>r.key===key))continue;
   queue.push({source,level,key,cached:proofs.find(p=>p.id===level.id)?.proof});
  }
 }
 for(const level of freshInputs){
  const key=hash(JSON.stringify(level));if([...accepted,...rejected].some(r=>r.key===key))continue;queue.push({source:'fresh',level,key});
 }
 let active=0,writes=Promise.resolve();const save=()=>writeFile('data/des6/bank-proof.json',JSON.stringify({fingerprint,nativeFingerprint,accepted,rejected,inventory}));
 await new Promise((resolve,reject)=>{function next(){while(active<3&&queue.length){const job=queue.shift();active++;const w=new Worker(new URL(import.meta.url),{workerData:job});w.on('error',reject);w.on('message',row=>{(row.reason?rejected:accepted).push(row);active--;console.log(row.source,row.id,row.reason||'accept',row.proof?.shots);writes=writes.then(save);if(queue.length)next();else if(!active)writes.then(resolve,reject);});}if(!active)writes.then(resolve,reject);}next();});
 accepted.sort((a,b)=>a.id.localeCompare(b.id));
 const fresh=accepted.filter(r=>r.source==='fresh').map(r=>r.level);sourceLevels.fresh=fresh;await writeFile(SOURCES.fresh,JSON.stringify({name:'Des6 · Новые формации',levels:fresh}));
 for(const row of accepted){const level=sourceLevels[row.source].find(l=>l.id===row.id);if(hash(JSON.stringify(level))!==row.key)throw Error('Source level changed during evaluation');row.profile=profile(level,row.source,row.proof);}
 inventory.fresh={file:SOURCES.fresh,sha256:hash(await readFile(SOURCES.fresh)),levels:fresh.length};
 await writeFile('data/des6/bank.json',JSON.stringify({version:'0.1',fingerprint,sources:inventory,entries:accepted.map(r=>r.profile)}));await save();
 console.log('bank',accepted.length,'rejected',rejected.length,'new',fresh.length);
}
