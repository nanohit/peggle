import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {generateLevel,LAYOUTS,HEROES} from './grammar.js';
import {validateGeometry} from './geometry.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {measure} from '../quality/machine.mjs';
import {designMetrics,cosine} from '../quality/metrics.js';
const sources=['generators/destruction2/grammar.js','generators/destruction2/geometry.js','generators/destruction2/bezier-geometry.js','generators/quality/machine.mjs','js/game.js','js/physics.js','js/destruction-mode.js','generators/destruction/native-simulator.mjs'];
const fingerprint=createHash('sha256').update((await Promise.all(sources.map(f=>readFile(f)))).join('\n')).digest('hex');
let checkpoint;try{checkpoint=JSON.parse(await readFile('data/des2/candidates.json','utf8'));}catch{}
const results=checkpoint?.fingerprint===fingerprint?checkpoint.results:[],rejected=checkpoint?.fingerprint===fingerprint?checkpoint.rejected:[];
await mkdir('data/des2',{recursive:true});
for(let round=0;round<4;round++)for(let i=0;i<6;i++){
 const layout=LAYOUTS[i+1].id,hero=HEROES[1+(i+round)%5].id,seed='roam-'+round+'-'+i;
 const options={seed,layout,hero,density:.40+((i+round)%4)*.09,destruction:hero==='collapse'?.7:.25};
 const level=generateLevel(options);if([...results,...rejected].some(r=>r.id===level.id))continue;
 const geometry=validateGeometry(level);
 let reason=null;if(!geometry.valid)reason='geometry';
 if(!reason){const idle=new NativeSimulation(level).settle(3);if(idle.game.getOrangePegsLeft()!==geometry.targets)reason='autonomous-target-loss';
  if(!reason&&hero==='magnet'&&idle.game.destructionSystem.simMagnetTicks===0)reason='inactive-magnet';
  if(!reason&&hero==='motion')for(const t of [1.3,2.1,2.8]){idle.settle(t);const v=validateGeometry({...level,pegs:idle.game.pegs});if(!v.valid){reason='moving-overlap';break;}}
 }
 if(reason){rejected.push({id:level.id,options,reason,errors:geometry.errors.slice(0,3)});console.log('reject',level.id,reason);}
 else{
  const proof=measure(level),metrics=designMetrics(level);
  const relevant=hero!=='portal'||proof.first.some(s=>s.portalTeleports>0&&s.cleared>=2);
  const pass=relevant&&proof.complete&&proof.replayComplete&&proof.peakFirstFraction<=.75&&proof.successfulFirstFraction>=2/9;
  if(pass){results.push({id:level.id,options,metrics,proof});console.log('accept',level.id,'shots',proof.shots,'first',proof.peakFirstFraction.toFixed(2),'packed',metrics.packedFraction.toFixed(2));}
  else{rejected.push({id:level.id,options,reason:'native-quality',coverage:proof.coverage,complete:proof.complete,replay:proof.replayComplete,first:proof.peakFirstFraction});console.log('reject',level.id,'native quality',proof.coverage.toFixed(2),proof.complete);}
 }
 await writeFile('data/des2/candidates.json',JSON.stringify({fingerprint,results,rejected}));
}
// Keep diverse whole-board silhouettes and mechanics; seed labels are not the
// diversity criterion. Select one per layout, then maximize distance in space.
const chosen=[],remaining=results.slice();
for(const l of LAYOUTS.slice(1)){const index=remaining.findIndex(r=>r.options.layout===l.id);if(index>=0)chosen.push(...remaining.splice(index,1));}
while(chosen.length<12&&remaining.length){
 let best=0,score=-Infinity;
 for(const [i,r] of remaining.entries()){const nearest=Math.max(0,...chosen.map(q=>cosine(r.metrics.tiles,q.metrics.tiles)));const mechanics=chosen.filter(q=>q.options.hero===r.options.hero).length;const value=1-nearest-mechanics*.025;if(value>score){best=i;score=value;}}
 chosen.push(...remaining.splice(best,1));
}
if(chosen.length<8)throw Error('Fewer than 8 proven candidates; preserve checkpoint and extend seed pool');
const levels=chosen.map(r=>{const l=generateLevel(r.options);l.metadata.generator.validation={nativeRoute:r.proof.angles,replay:true};return l;});
await writeFile('data/des2/campaign.json',JSON.stringify({name:'Destruction · free roam 0.1',levels},null,2));
await writeFile('data/des2/proof.json',JSON.stringify({version:1,fingerprint,sources,accepted:chosen,rejected,
 note:'Selection uses bounded native search plus replay, not a model of human enjoyment. Every candidate is procedural; no manual peg edits.'},null,2));
console.log('selected',levels.length,'from',results.length,'passed and',rejected.length,'rejected');
