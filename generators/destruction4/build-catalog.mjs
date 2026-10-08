import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {generateLevel,DOMAINS} from './grammar.js';
import {cosine} from '../quality/metrics.js';
import {RUNTIME_SOURCES,geometryKey} from '../destruction3/cache.mjs';
import {evaluate} from './evaluate.mjs';
import {observe} from './observe.mjs';

if(!isMainThread)parentPort.postMessage(evaluate(workerData.options,{cached:workerData.cached}));else{
 const nativeSources=['generators/destruction4/observe.mjs','generators/quality/metrics.js',...RUNTIME_SOURCES],policySources=['generators/destruction4/envelope.js','generators/destruction2/ribbon-geometry.js','generators/destruction4/geometry.js','generators/destruction4/evaluate.mjs',...nativeSources],sources=['generators/destruction4/grammar.js','generators/destruction4/shapes.js',...policySources],hash=async files=>createHash('sha256').update((await Promise.all(files.map(p=>readFile(p)))).join('\n')).digest('hex'),fingerprint=await hash(sources),policyFingerprint=await hash(policySources),nativeFingerprint=await hash(nativeSources);
 await mkdir('data/des4',{recursive:true});let previous;try{previous=JSON.parse(await readFile('data/des4/candidates.json','utf8'));}catch{}
 const reusable=previous?.policyFingerprint===policyFingerprint,unchanged=row=>DOMAINS.includes(row.options.domain)&&geometryKey(generateLevel(row.options))===row.geometryKey;
 const accepted=reusable?previous.accepted.filter(unchanged):[],rejected=reusable?previous.rejected.filter(unchanged):[],perDomain=Number(process.env.DES4_POOL||8),wanted=Number(process.env.DES4_COUNT||32),queue=DOMAINS.flatMap(domain=>Array.from({length:perDomain},(_,i)=>({domain,seed:'field-'+String(i).padStart(3,'0')}))).filter(o=>![...accepted,...rejected].some(r=>r.id===generateLevel(o).id));
 const compact=row=>({...row,proof:row.proof?{...row.proof,frames:undefined}:undefined});
 const save=()=>writeFile('data/des4/candidates.json',JSON.stringify({fingerprint,policyFingerprint,policySources,nativeFingerprint,nativeSources,sources,accepted:accepted.map(compact),rejected:rejected.map(compact)}));let active=0,writes=Promise.resolve();
 await new Promise((resolve,reject)=>{function next(){while(active<3&&queue.length){const options=queue.shift(),key=geometryKey(generateLevel(options)),cached=previous?.nativeFingerprint===nativeFingerprint?previous.accepted.find(row=>row.id===generateLevel(options).id&&row.geometryKey===key):null;active++;const w=new Worker(new URL(import.meta.url),{workerData:{options,cached}});w.on('error',reject);w.on('message',row=>{
  row.geometryKey=geometryKey(generateLevel(options));if(row.reason){rejected.push(row);console.log('reject',options.domain,options.seed,row.reason);}else{accepted.push(row);console.log('accept',options.domain,options.seed,'shots',row.proof.shots,'response',row.evidence.hitEvents.length,'portals',row.evidence.portalEvents.length);}
  active--;writes=writes.then(save);if(queue.length)next();else if(!active)writes.then(resolve,reject);
 });}}next();if(!active)resolve();});
 accepted.sort((a,b)=>a.id.localeCompare(b.id));await save();if(accepted.length<wanted)throw Error('Need more proven candidates: '+accepted.length+'/'+wanted);
 const selected=[],remaining=accepted.slice(),counts={};
 // Selection compares shape occupancy, orientation, macro structure and route
 // behavior. Color changes alone cannot make an otherwise identical shape new.
 const similarity=(a,b)=>{const occupancy=cosine(a.metrics.tiles,b.metrics.tiles),orientation=cosine(a.metrics.orientationHistogram,b.metrics.orientationHistogram),same=a.options.domain===b.options.domain;return occupancy*.63+orientation*.17+(same?.2:0);};
 for(const domain of ['switchback'])for(let n=0;n<2;n++){
  const choices=remaining.map((row,i)=>({row,i})).filter(q=>q.row.options.domain===domain);if(!choices.length)throw Error('Missing functional portal variety; another iteration is required');
  choices.sort((a,b)=>Math.max(0,...selected.map(q=>similarity(a.row,q)))-Math.max(0,...selected.map(q=>similarity(b.row,q))));const [{i}]=choices;selected.push(remaining.splice(i,1)[0]);counts[domain]=(counts[domain]||0)+1;
 }
 while(selected.length<wanted){let best=-1,bestScore=-Infinity;for(const [i,row] of remaining.entries()){
  if((counts[row.options.domain]||0)>=3)continue;
  const closest=Math.max(0,...selected.map(q=>similarity(row,q))),rhythm=Math.abs(row.proof.shots-5)*.006,score=1-closest-(counts[row.options.domain]||0)*.12-rhythm;
  if(score>bestScore){best=i;bestScore=score;}
 }if(best<0)throw Error('Not enough distinct domains; inspect pool before widening caps');const [row]=remaining.splice(best,1);selected.push(row);counts[row.options.domain]=(counts[row.options.domain]||0)+1;}
 // Interleave macro shapes and mechanics. No two successive levels use the
 // same constructor, and the playlist is a selection, not the generator itself.
 const ordered=[];while(selected.length){let best=0;for(let i=1;i<selected.length;i++){const previous=ordered.at(-1),rank=row=>!previous?row.options.domain==='architecture'?1:0:1-similarity(row,previous);if(rank(selected[i])>rank(selected[best]))best=i;}ordered.push(selected.splice(best,1)[0]);}
 const levels=[],proofs=[];
 for(const [i,row] of ordered.entries()){
  const level=generateLevel(row.options),evidence=observe(level,row.proof,{frames:true});if(!evidence.complete)throw Error('Selected replay failed');
  level.name=(i+1)+' · '+level.name.split(' · ')[0];level.metadata.generator.validation={fingerprint,route:row.proof.angles,replay:true};levels.push(level);proofs.push({...row,proof:{...row.proof,frames:evidence.frames},evidence:{...evidence,frames:undefined}});console.log('replay',i+1,level.id);
 }
 await writeFile('data/des4/campaign.json',JSON.stringify({name:'Alea · Живые формы 0.1',levels},null,2));await writeFile('data/des4/proof.json',JSON.stringify({fingerprint,sources,counts,accepted:proofs,rejected:rejected.map(compact),similarity:'0.63 occupancy + 0.17 orientation + 0.20 same domain; max 3 per domain. Selection is followed by direct visual review.'}));
 console.log('selected',levels.length,'from',accepted.length,'accepted;',rejected.length,'rejected');
}
