import {readFile,writeFile} from 'node:fs/promises';
import {measure} from '../quality/machine.mjs';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
const campaign=JSON.parse(await readFile('data/des2/campaign.json','utf8')),proof=JSON.parse(await readFile('data/des2/proof.json','utf8'));
function replay(level,angles,{idle=3,seed='quality-native'}={}){
 const sim=new NativeSimulation(level,{seed}).settle(idle);const shots=[];
 for(const a of angles){if(sim.summary().complete||sim.game.state==='lost')break;const s=sim.shoot(a);shots.push(s);if(s?.timeout)break;sim.settle(1.5);}
 const s=sim.summary();return {complete:s.complete,coverage:s.fraction,shots:shots.length,hitCount:shots.reduce((n,s)=>n+(s?.hitCount||0),0),seconds:shots.reduce((n,s)=>n+(s?.seconds||0),0)};
}
const rows=[];
for(const level of campaign.levels){
 const p=proof.accepted.find(p=>p.id===level.id),hero=level.metadata.generator.hero;
 const ablation=structuredClone(level);
 if(hero==='motion')ablation.groups=ablation.groups.map(({animation,...g})=>g);
 else if(hero==='collapse')ablation.pegs.forEach(p=>{if(p.constructionRole==='cargo')p.destructionStatic=true;});
 else ablation.pegs=ablation.pegs.filter(p=>!['bumper','bombMagnet','portalBlue','portalOrange'].includes(p.type));
 const removed=replay(ablation,p.proof.angles),baseline=replay(level,p.proof.angles),holdouts=[replay(level,p.proof.angles,{idle:2.5,seed:'other-stream'}),replay(level,p.proof.angles,{idle:4,seed:'other-stream-2'})];
 const {frames,first,...adaptive}=measure(level,{seed:'adaptive-holdout',idleSeconds:4});
 rows.push({id:level.id,hero,baseline,removed,holdouts,adaptive});console.log(level.id,'adaptive',adaptive.coverage.toFixed(2),'without',hero,removed.coverage.toFixed(2),'holdouts',holdouts.map(r=>r.coverage.toFixed(2)).join('/'));
}
await writeFile('data/des2/robustness.json',JSON.stringify({method:'Identical winning angles, with leading mechanic disabled (targets unchanged). Holdouts change idle time and RNG. An adaptive search on a distinct RNG/start is also included. This is a causal diagnostic for this route, not a necessity or player-skill test.',rows},null,2));
