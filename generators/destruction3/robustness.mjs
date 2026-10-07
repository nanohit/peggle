import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile} from 'node:fs/promises';import {measure} from '../quality/machine.mjs';
if(!isMainThread){const {frames,first,...adaptive}=measure(workerData.level,{seed:'des3-independent-stream',idleSeconds:4});parentPort.postMessage({id:workerData.level.id,adaptive});}else{
 const campaign=JSON.parse(await readFile('data/des3/campaign.json','utf8')),proof=JSON.parse(await readFile('data/des3/proof.json','utf8'));
 let previous;try{previous=JSON.parse(await readFile('data/des3/robustness.json','utf8'));}catch{}
 const rows=previous?.fingerprint===proof.fingerprint?previous.rows:[],queue=campaign.levels.filter(l=>!rows.some(r=>r.id===l.id));
 let active=0,writes=Promise.resolve();
 const save=()=>writeFile('data/des3/robustness.json',JSON.stringify({fingerprint:proof.fingerprint,rows,note:'Actual native launcher-ball routes, component release probes and fixed-angle ablation are distinct experiments. Adaptive holdout searches again on another collision stream and start.'}));
 await new Promise((resolve,reject)=>{const advance=()=>{while(active<3&&queue.length){const level=queue.shift();active++;const worker=new Worker(new URL(import.meta.url),{workerData:{level}});worker.on('error',reject);worker.on('message',r=>{const e=proof.accepted.find(r=>r.id===level.id).experiment;rows.push({...e,adaptive:r.adaptive});console.log(level.id,'handoffs',e.handoffs.filter(h=>h.contact||h.viaPortal).length+'/'+e.handoffs.length,'field',e.fieldDisplacement.toFixed(1),'cargo portals',e.transfer.bodyPortals,'holdout',r.adaptive.coverage.toFixed(2));active--;writes=writes.then(save);if(queue.length)advance();else if(!active)writes.then(resolve,reject);});}if(!active&&!queue.length)writes.then(resolve,reject);};advance();});
 rows.sort((a,b)=>campaign.levels.findIndex(l=>l.id===a.id)-campaign.levels.findIndex(l=>l.id===b.id));await save();
}
