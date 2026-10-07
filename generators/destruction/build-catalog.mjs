import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { FAMILIES,generateLevel } from './grammar.js';
if(!isMainThread){
  const {evaluateLevel}=await import('./evaluate.mjs');
  const level=generateLevel(workerData.seed,workerData.family);
  const started=Date.now();const quality=evaluateLevel(level);
  parentPort.postMessage({level,quality,ms:Date.now()-started});
}else{
  const sources=['generators/destruction/grammar.js','generators/destruction/geometry.js','generators/destruction/evaluate.mjs','generators/destruction/native-simulator.mjs','js/game.js','js/physics.js','js/destruction-mode.js','js/destruction-hinge.js'];
  const fingerprint=createHash('sha256').update((await Promise.all(sources.map(p=>readFile(p,'utf8')))).join('\n')).digest('hex');
  await mkdir('data/des',{recursive:true});await mkdir('generators/destruction/results',{recursive:true});
  const queue=FAMILIES.flatMap(f=>[1,2].map(n=>({family:f.id,seed:'v01-'+String(n).padStart(2,'0'),attempt:1})));
  const accepted=[],rejected=[];let running=0;
  await new Promise((resolve,reject)=>{
    async function advance(){
      while(running<3&&queue.length){
        const job=queue.shift();running++;
        const cache='generators/destruction/results/'+job.family+'-'+job.seed+'.json';
        let cached=null;try{cached=JSON.parse(await readFile(cache,'utf8'));if(cached.fingerprint!==fingerprint)cached=null;}catch{}
        const finish=async result=>{
          result.fingerprint=fingerprint;if(!cached)await writeFile(cache,JSON.stringify(result,null,2));
          if(result.quality.accepted){accepted.push(result);console.log('ACCEPT',job.family,job.seed,result.quality.route.length,result.quality.fallenTargets,result.quality.crossAssemblyImpacts.length,result.ms+'ms');}
          else {rejected.push({family:job.family,seed:job.seed,quality:result.quality});console.log('REJECT',job.family,job.seed,JSON.stringify({idle:result.quality.idle,complete:result.quality.complete,holdout:result.quality.holdout?.complete,falls:result.quality.fallenTargets,edges:result.quality.crossAssemblyImpacts?.length}));
            if(job.attempt<5)queue.push({...job,seed:job.seed+'r',attempt:job.attempt+1});}
          running--;if(!queue.length&&!running)resolve();else advance().catch(reject);
        };
        if(cached){await finish(cached);continue;}
        const worker=new Worker(new URL(import.meta.url),{workerData:job});
        worker.on('message',r=>finish(r).catch(reject));worker.on('error',reject);
      }
    }advance().catch(reject);
  });
  accepted.sort((a,b)=>FAMILIES.findIndex(f=>f.id===a.level.metadata.generator.family)-FAMILIES.findIndex(f=>f.id===b.level.metadata.generator.family)||a.level.id.localeCompare(b.level.id));
  const campaign={name:'Destruction Lab 0.1',version:1,levels:accepted.map(r=>r.level)};
  await writeFile('data/des/campaign.json',JSON.stringify(campaign));
  await writeFile('data/des/quality.json',JSON.stringify({generator:'destruction_generator0.1',levels:accepted.map(r=>({id:r.level.id,...r.quality})),rejected},null,2));
  console.log('CATALOGUE',accepted.length,'accepted;',rejected.length,'rejected');
  if(FAMILIES.some(f=>!accepted.some(r=>r.level.metadata.generator.family===f.id)))process.exitCode=1;
}
