import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {generateIntentLevel} from './grammar.js';
import {structureKey} from './geometry.js';
import {evaluateIntentLevel} from './evaluate.mjs';
const sources=['generators/destruction1/grammar.js','generators/destruction1/geometry.js','generators/destruction1/evaluate.mjs','generators/destruction/grammar.js','js/game.js','js/destruction-mode.js'];
const fingerprint=createHash('sha256').update((await Promise.all(sources.map(p=>readFile(p,'utf8')))).join('\n')).digest('hex');
const candidates=[['first','cascade'],['first','parallel'],['first','merge'],['first','portal'],['first','magnet'],['first','cross'],
 ['compose-0','compose'],['layers-0','cascade'],['compose-3','compose'],['compose-7','compose'],['layers-4','cascade'],['compose-31','compose'],['layers-5','cascade'],['compose-22','compose']];
const levels=[],accepted=[],rejected=[],keys=new Set();
for(const [seed,mode] of candidates) {
 const level=generateIntentLevel(seed,mode),key=structureKey(level);
 if(keys.has(key)){rejected.push({seed,mode,reason:'duplicate-composition'});continue;}
 const proof=evaluateIntentLevel(level);
 if(!proof.accepted){rejected.push({seed,mode,reason:proof.geometry.errors?.length?'geometry':'idle-instability',...proof});console.log('reject',level.id,proof.geometry.errors?.slice(0,2),proof.idle);continue;}
 level.metadata.generator.validation={nativeIdle:true,sourceShots:proof.shots.length};
 levels.push(level);keys.add(key);accepted.push({id:level.id,structure:key,...proof});
 console.log('accept',level.id,level.pegs.length,'pegs',proof.geometry.targets,'targets',level.metadata.generator.plan.depth,'bowl layers');
}
if(levels.length<8)throw Error('Too few usable compositions');
await mkdir('data/des1',{recursive:true});
await writeFile('data/des1/campaign.json',JSON.stringify({name:'Destruction · compositions 2.0',levels},null,2));
await writeFile('data/des1/proof.json',JSON.stringify({version:2,implementationFingerprint:fingerprint,sources,
 checks:'Native idle stability and actual source shots; no mandatory order, full-route guarantee or additional objectives.',accepted,rejected},null,2));
console.log('Catalogue:',levels.length,'distinct ordinary destruction compositions');
