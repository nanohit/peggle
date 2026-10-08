import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile} from 'node:fs/promises';
import {fingerprint as computeFingerprint,geometryKey} from './cache.mjs';
import {evaluate} from './evaluate.mjs';
if(!isMainThread)parentPort.postMessage(evaluate(workerData,{frames:true}));else{
 const iteration=process.env.DES5_ITERATION||'01',file='data/des5/iterations/'+iteration+'-native.json',input=JSON.parse(await readFile('data/des5/iterations/'+iteration+'.json','utf8')),rows=[],queue=input.levels.slice();let active=0,writes=Promise.resolve();
 const fingerprint=await computeFingerprint();
 console.log('begin',iteration,'levels',queue.length,'fingerprint',fingerprint);
 const save=()=>writeFile(file,JSON.stringify({iteration,fingerprint,rows}));
 await new Promise((resolve,reject)=>{function next(){while(active<3&&queue.length){const level=queue.shift();active++;const w=new Worker(new URL(import.meta.url),{workerData:level});w.on('error',reject);w.on('message',row=>{row.geometryKey=geometryKey(level);rows.push(row);active--;console.log(row.id,row.reason||'accept','shots',row.proof?.shots,'links',row.evidence?.interaction.observedLinks,'coupled',row.evidence?.interaction.coupledInk?.toFixed(2));writes=writes.then(save);if(queue.length)next();else if(!active)writes.then(resolve,reject);});}if(!active)writes.then(resolve,reject);}next();});
}
