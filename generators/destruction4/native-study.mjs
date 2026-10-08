import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {generateLevel,DOMAINS} from './grammar.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {measure} from '../quality/machine.mjs';
import {validateGeometry} from './geometry.js';

if(!isMainThread){
 const level=generateLevel(workerData.options),sim=new NativeSimulation(level).settle(4),idle=sim.summary();
 const geometry=validateGeometry(level),proof=measure(level,{route:workerData.route,seed:'des4-study'});
 parentPort.postMessage({id:level.id,options:workerData.options,geometry,idle:{targets:idle.orangeLeft,drift:idle.maxDrift,fallen:idle.fallenTargets,pegs:idle.pose},proof});
}else{
 const iteration=process.env.DES4_ITERATION||'01',perDomain=Number(process.env.DES4_NATIVE_COUNT||1),route=process.env.DES4_NATIVE_ROUTE!=='0',rows=[],queue=DOMAINS.flatMap(domain=>Array.from({length:perDomain},(_,i)=>({domain,seed:'field-'+String(i).padStart(3,'0')})));
 await mkdir('data/des4/iterations',{recursive:true});let active=0,writes=Promise.resolve();
 await new Promise((resolve,reject)=>{
  function next(){while(active<3&&queue.length){const options=queue.shift();active++;const w=new Worker(new URL(import.meta.url),{workerData:{options,route}});
   w.on('error',reject);w.on('message',row=>{rows.push(row);active--;console.log(row.id,'idle',row.idle.targets,'/',row.proof.initialTargets,'first',row.proof.peakFirstFraction.toFixed(2),'coverage',row.proof.coverage.toFixed(2),'shots',row.proof.shots,'complete',row.proof.complete);writes=writes.then(()=>writeFile('data/des4/iterations/'+iteration+'-native.json',JSON.stringify({iteration,route,rows})));if(queue.length)next();else if(!active)writes.then(resolve,reject);});
  }}next();
 });
}
