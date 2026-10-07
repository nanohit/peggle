import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {generateLevel,FORMS} from './grammar.js';import {validateGeometry} from './geometry.js';
import {RUNTIME_SOURCES,geometryKey} from './cache.mjs';
import {cosine} from '../quality/metrics.js';import {evaluate} from './evaluate.mjs';
if(!isMainThread){parentPort.postMessage(evaluate(workerData.options,{previousProof:workerData.proof}));}else{
const files=['generators/destruction3/cache.mjs','generators/destruction3/evaluate.mjs','generators/destruction3/experiments.mjs','generators/destruction3/grammar.js','generators/destruction3/geometry.js','generators/destruction2/bezier-geometry.js','generators/destruction2/ribbon-geometry.js','generators/destruction/native-simulator.mjs','generators/quality/machine.mjs','js/game.js','js/destruction-mode.js','js/physics.js'];
const runtimeFingerprint=createHash('sha256').update((await Promise.all(RUNTIME_SOURCES.map(f=>readFile(f)))).join('\n')).digest('hex');
const fingerprint=createHash('sha256').update((await Promise.all(files.map(f=>readFile(f)))).join('\n')).digest('hex');
let checkpoint;try{checkpoint=JSON.parse(await readFile('data/des3/candidates.json','utf8'));}catch{}
const results=checkpoint?.fingerprint===fingerprint&&checkpoint.runtimeFingerprint===runtimeFingerprint?checkpoint.results:[],rejected=checkpoint?.fingerprint===fingerprint&&checkpoint.runtimeFingerprint===runtimeFingerprint?checkpoint.rejected:[];
const prior=checkpoint?.runtimeFingerprint===runtimeFingerprint?checkpoint.results:[];
const save=()=>writeFile('data/des3/candidates.json',JSON.stringify({fingerprint,runtimeFingerprint,results,rejected}));await mkdir('data/des3',{recursive:true});
const pool=Number(process.env.DES3_POOL||78),wanted=Number(process.env.DES3_COUNT||32);
const queue=Array.from({length:pool},(_,i)=>({seed:'system-'+String(i).padStart(3,'0'),form:i<pool-6?'grown':FORMS[i-(pool-6)+1]})).filter(options=>![...results,...rejected].some(r=>r.id===generateLevel(options).id));
let active=0,writes=Promise.resolve();
await new Promise((resolve,reject)=>{
 const advance=()=>{while(active<3&&queue.length){const options=queue.shift();active++;
  const key=geometryKey(generateLevel(options)),cached=prior.find(r=>r.id===generateLevel(options).id&&r.geometryKey===key);
  const worker=new Worker(new URL(import.meta.url),{workerData:{options,proof:cached?.proof}});
  worker.on('error',reject);worker.on('message',result=>{
   if(result.reason){rejected.push(result);console.log('reject',result.options.seed,result.reason);}
   else {result.geometryKey=key;results.push(result);console.log('accept',result.options.seed,generateLevel(result.options).metadata.generator.transport,'shots',result.proof.shots);}
   active--;writes=writes.then(save);if(queue.length)advance();else if(!active)writes.then(resolve,reject);
  });
 }if(!active&&!queue.length)writes.then(resolve,reject);};advance();
});
results.sort((a,b)=>a.id.localeCompare(b.id));rejected.sort((a,b)=>a.id.localeCompare(b.id));await save();
const features=new Map(results.map(r=>[r.id,generateLevel(r.options).metadata.generator]));
const chosen=[],remaining=results.slice(),keys=new Map();
function take(index){const [r]=remaining.splice(index,1);chosen.push(r);keys.set(r.key,(keys.get(r.key)||0)+1);}
// Cover functional transfers and familiar calibration forms before novelty.
for(const feature of ['magnet','portal','bridge','tilting-cup','sling','motion','grown']){
 const index=remaining.findIndex(r=>{const g=features.get(r.id);return g.transport===feature||g.form===feature||feature==='motion'&&g.plan.motion||g.plan.assemblies.some(a=>a.type===feature);});if(index>=0)take(index);
}
while(chosen.length<wanted&&remaining.length){let best=-1,score=-Infinity;
 for(const [i,r] of remaining.entries()){
  if((keys.get(r.key)||0)>=2)continue;
  const nearest=Math.max(0,...chosen.map(q=>cosine(r.metrics.tiles,q.metrics.tiles))),sameTransport=chosen.filter(q=>features.get(q.id).transport===features.get(r.id).transport).length;
  const value=1-nearest-(keys.get(r.key)||0)*.12-sameTransport*.008;
  if(value>score){best=i;score=value;}
 }if(best<0)break;take(best);
}
if(chosen.length<18)throw Error('Insufficient proven systems: '+chosen.length+'; extend pool');
const levels=chosen.map((r,i)=>{const l=generateLevel(r.options);l.name=(i+1)+' · '+l.name.split(' · ')[0];l.metadata.generator.validation={fingerprint,route:r.proof.angles,replay:true};return l;});
await writeFile('data/des3/campaign.json',JSON.stringify({name:'Alea · Связанные системы 0.1',levels},null,2));
await writeFile('data/des3/proof.json',JSON.stringify({fingerprint,runtimeFingerprint,runtimeSources:RUNTIME_SOURCES,sources:files,accepted:chosen,rejected,note:'All geometry is procedural. Default growth expands a bounded graph grammar, then synthesizes profiles from ports. Full native search/replay is offline; not a player enjoyment guarantee.'}));
console.log('selected',levels.length,'from',results.length,'accepted;',rejected.length,'rejected');

}
