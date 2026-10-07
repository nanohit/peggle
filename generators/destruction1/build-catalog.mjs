import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {generateIntentLevel} from './grammar.js';
import {structureKey} from './geometry.js';
import {evaluateIntentLevel,replayIntentLevel,findIntentRoute} from './evaluate.mjs';
const sources=['generators/destruction1/grammar.js','generators/destruction1/geometry.js','generators/destruction1/evaluate.mjs','generators/destruction/grammar.js','generators/destruction/native-simulator.mjs','js/game.js','js/levels.js','js/portal-defaults.js','js/magnet-defaults.js','js/intent-objectives.js','js/physics.js','js/destruction-mode.js','js/destruction-hinge.js'];
const fingerprint=createHash('sha256').update((await Promise.all(sources.map(p=>readFile(p,'utf8')))).join('\n')).digest('hex');
const candidates=[['first','cascade'],['first','magnet'],['first','parallel'],['first','merge'],['first','portal'],['layers-0','cascade'],['first','cross'],['compose-0','compose'],['layers-4','cascade'],['compose-3','compose'],['compose-7','compose'],['compose-31','compose'],['layers-5','cascade'],['compose-22','compose'],['compose-49','compose']];
const levels=[],proofs=[],rejected=[],keys=new Set();
let previous=null,previousLevels=[];try{previous=JSON.parse(await readFile('data/des1/proof.json','utf8'));previousLevels=JSON.parse(await readFile('data/des1/campaign.json','utf8')).levels;}catch{}
for(const [seed,mode] of candidates){
 const level=generateIntentLevel(seed,mode),key=structureKey(level);
 if(keys.has(key)){rejected.push({seed,mode,reason:'structural-duplicate'});continue;}
 let proof=null;
 // Resume expensive, already completed searches only if the current native
 // game can reproduce the complete sequence on the newly generated geometry.
 const oldLevel=previousLevels.find(p=>p.id===level.id);
 if(oldLevel && JSON.stringify([oldLevel.pegs,oldLevel.groups,oldLevel.destruction,oldLevel.metadata.intentGraph])===JSON.stringify([level.pegs,level.groups,level.destruction,level.metadata.intentGraph])){
   const oldProof=previous.accepted.find(p=>p.id===level.id);
   if(oldProof && replayIntentLevel(level,oldProof).complete)proof=oldProof;
 }
 if(!proof)proof=evaluateIntentLevel(level);
 if(!proof.accepted){rejected.push({seed,mode,reason:proof.geometry.errors?.length?'geometry':'incomplete-native-chain',progress:proof.progress});console.log('reject',seed,mode,proof.progress?.done);continue;}
 const replay=replayIntentLevel(level,proof),early=replayIntentLevel(level,proof,{idleSeconds:2,seed:'intent-holdout'});
 if(!replay.complete)throw Error('Native replay failed: '+level.id);
 proof={...proof,events:replay.intentEvents,progress:replay.intent};
 const captureEvents=proof.events.filter(e=>e.type==='capture');
 if(!captureEvents.length)throw Error('No physical capture');
 for(const e of captureEvents){const activation=proof.events.find(a=>a.type==='activate'&&a.stage===e.stage);if(!activation||activation.time<e.time)throw Error('Release preceded capture');}
 level.metadata.generator.validation={native:true,route:proof.route.map(s=>s.angle),stages:proof.progress.total};
 let holdout=early.complete ? early : (proof.holdout ? replayIntentLevel(level,proof.holdout) : null);
 if(!holdout?.complete)holdout=findIntentRoute(level,{idleSeconds:2,seed:'intent-holdout'}).sim.summary();
 if(!holdout.complete){rejected.push({seed,mode,reason:'holdout-search-incomplete',progress:holdout.intent});console.log('reject holdout',level.id);continue;}
 levels.push(level);keys.add(key);proofs.push({id:level.id,structure:key,...proof,holdout:{complete:holdout.complete,route:holdout.shots,progress:holdout.intent,events:holdout.intentEvents,seed:'intent-holdout',idleSeconds:2},earlyReplay:{complete:early.complete,progress:early.intent}});
 console.log('accept',level.id,proof.route.length,'shots',proof.progress.total,'stages','early',early.complete);
 // Persist progress so an interrupted search never loses accepted evidence.
 await mkdir('data/des1',{recursive:true});
 await writeFile('data/des1/campaign.json',JSON.stringify({name:'Destruction · intentions 1.0',levels},null,2));
 await writeFile('data/des1/proof.json',JSON.stringify({version:1,implementationFingerprint:fingerprint,sources,accepted:proofs,rejected},null,2));
}
console.log('Catalogue:',levels.length,'structurally different chains');
