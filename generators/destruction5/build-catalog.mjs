import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {generateLevel} from './grammar.js';
import {evaluate} from './evaluate.mjs';
import {observe} from './observe.mjs';
import {fingerprint as computeFingerprint,SOURCES,geometryKey} from './cache.mjs';
import {cosine} from '../quality/metrics.js';

export function traits(row){const m=row.metrics,l=row.level,g=l.metadata.generator.genome,p=l.metadata.generator.plan,e=row.evidence;
 return [g.focus,g.kinetic,g.branching,g.openness,g.lateral,m.focusShare,m.nodes/6,m.activeResponses/3,m.topology.branches/3,m.topology.merges/2,m.topology.depth/4,...['des2','des3','des4'].map(k=>p.contributions[k]||0),Math.min(1,e.portalEvents.length+e.bodyPortalEvents.length),Math.min(1,e.fieldDifference/40+e.fieldExitDifference),Math.min(1,e.collapse.length/6),row.proof.shots/9,m.coupledInk];
}
export function similarity(a,b){const x=traits(a),y=traits(b),distance=x.reduce((s,v,i)=>s+Math.abs(v-y[i]),0)/x.length;return cosine(a.metrics.tiles,b.metrics.tiles)*.50+cosine(a.metrics.orientationHistogram,b.metrics.orientationHistogram)*.16+(1-distance)*.34;}

if(!isMainThread){const level=generateLevel(workerData),row=evaluate(level);row.level=level;row.geometryKey=geometryKey(level);parentPort.postMessage(row);}
else if(process.argv[1]?.endsWith('/build-catalog.mjs')){
 const fingerprint=await computeFingerprint(),wanted=Number(process.env.DES5_COUNT||32),count=Number(process.env.DES5_POOL||96);await mkdir('data/des5',{recursive:true});
 let previous;try{previous=JSON.parse(await readFile('data/des5/candidates.json','utf8'));}catch{}
 const accepted=previous?.fingerprint===fingerprint?previous.accepted:[],rejected=previous?.fingerprint===fingerprint?previous.rejected:[],known=new Set([...accepted,...rejected].map(r=>r.options.seed)),queue=Array.from({length:count},(_,i)=>({seed:'meta-'+String(i).padStart(3,'0')})).filter(o=>!known.has(o.seed));let active=0,writes=Promise.resolve();
 const compact=row=>({...row,proof:row.proof?{...row.proof,frames:undefined}:undefined}),save=()=>writeFile('data/des5/candidates.json',JSON.stringify({fingerprint,sources:SOURCES,accepted:accepted.map(compact),rejected:rejected.map(compact)}));
 await new Promise((resolve,reject)=>{function next(){while(active<3&&queue.length){const options=queue.shift();active++;const w=new Worker(new URL(import.meta.url),{workerData:options});w.on('error',reject);w.on('message',row=>{(row.reason?rejected:accepted).push(row);active--;console.log(row.id,row.reason||'accept',row.proof?.shots,'nodes',row.metrics?.nodes);writes=writes.then(save);if(queue.length)next();else if(!active)writes.then(resolve,reject);});}if(!active)writes.then(resolve,reject);}next();});
 if(accepted.length<wanted)throw Error('Need more proven candidates '+accepted.length+'/'+wanted);
 const eligible=accepted;
 const selected=[],remaining=eligible.slice();
 while(selected.length<wanted){let best=0,bestScore=-Infinity;for(const [i,row] of remaining.entries()){
  const nearest=Math.max(0,...selected.map(q=>similarity(row,q))),quality=row.metrics.coupledInk*.035+Math.min(row.metrics.pegs,80)/80*.02,
   score=1-nearest+quality;if(score>bestScore){best=i;bestScore=score;}
 }selected.push(remaining.splice(best,1)[0]);}
 const ordered=[];while(selected.length){let best=0,bestScore=-Infinity;for(const [i,row] of selected.entries()){
  const prev=ordered.at(-1),desired=4.5+1.5*Math.sin(ordered.length*Math.PI/6),score=prev?1-similarity(row,prev)-Math.abs(row.proof.shots-desired)*.025:-row.proof.shots*.07+row.metrics.coupledInk*.05;
  if(score>bestScore){best=i;bestScore=score;}
 }ordered.push(selected.splice(best,1)[0]);}
 const levels=[],proofs=[];
 for(const [i,row] of ordered.entries()){
  const level=generateLevel(row.options);if(geometryKey(level)!==row.geometryKey)throw Error('Generator changed during candidate evaluation');
  const evidence=observe(level,row.proof,{frames:true});if(!evidence.complete)throw Error('Native replay failed '+level.id);
  level.name=(i+1)+' · Сцена';level.metadata.generator.validation={fingerprint,route:row.proof.angles,replay:true};levels.push(level);proofs.push({...row,level:undefined,proof:{...row.proof,frames:evidence.frames},evidence:{...evidence,frames:undefined}});console.log('replay',i+1,level.id);
 }
 if(await computeFingerprint()!==fingerprint)throw Error('Sources changed while building catalog');
 await writeFile('data/des5/campaign.json',JSON.stringify({name:'Alea · Сцены 0.2',levels},null,2));
 await writeFile('data/des5/proof.json',JSON.stringify({fingerprint,sources:SOURCES,selectionEligible:eligible.length,accepted:proofs,rejected:rejected.map(r=>({...compact(r),level:undefined})),selection:'Farthest-first composition portfolio after sustained native catch and winning-route gates; full-board target rhythm, curve orientation, structural program and route cadence. Geometry and clearing are feasibility evidence, not a fun score.'}));
 console.log('selected',levels.length,'from',accepted.length,'accepted;',rejected.length,'rejected');
}
