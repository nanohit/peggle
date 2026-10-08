import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile} from 'node:fs/promises';
import {measure} from '../quality/machine.mjs';

export {animationEnvelope} from './envelope.js';
import {animationEnvelope} from './envelope.js';

if(!isMainThread){const {frames,first,...adaptive}=measure(workerData,{seed:'des4-independent',idleSeconds:4.9});parentPort.postMessage({id:workerData.id,adaptive,envelope:animationEnvelope(workerData)});}else if(process.argv[1]?.endsWith('/robustness.mjs')){
 const campaign=JSON.parse(await readFile('data/des4/campaign.json','utf8')),proof=JSON.parse(await readFile('data/des4/proof.json','utf8'));let previous;try{previous=JSON.parse(await readFile('data/des4/robustness.json','utf8'));}catch{}
 const rows=previous?.fingerprint===proof.fingerprint?previous.rows:[],queue=campaign.levels.filter(l=>!rows.some(r=>r.id===l.id));let active=0,writes=Promise.resolve();
 const save=()=>writeFile('data/des4/robustness.json',JSON.stringify({fingerprint:proof.fingerprint,rows,note:'Independent full Game search/replay with another collision RNG and start time. Native Animator envelopes are sampled, not continuous proofs.'}));
 await new Promise((resolve,reject)=>{function next(){while(active<3&&queue.length){const level=queue.shift();active++;const w=new Worker(new URL(import.meta.url),{workerData:level});w.on('error',reject);w.on('message',row=>{rows.push(row);active--;console.log(level.id,'holdout',row.adaptive.complete,'shots',row.adaptive.shots,'envelope',row.envelope.valid);writes=writes.then(save);if(queue.length)next();else if(!active)writes.then(resolve,reject);});}if(!active)writes.then(resolve,reject);}next();});
 if(rows.some(r=>!r.adaptive.complete||!r.adaptive.replayComplete||!r.envelope.valid))throw Error('Selected catalog requires another iteration; inspect robustness.json');
}
