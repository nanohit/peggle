import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {visualLevel} from './metrics.js';
import {curateGeneratedPlaylist} from '../../js/generated-playlist.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const fixed=Array.from({length:9},(_,i)=>.12+i*(Math.PI-.24)/8);
function angles(sim){
 const g=sim.game,targets=g.pegs.filter(p=>g.isOrangePeg(p)&&!g.hasPegBeenActivated(p.id));
 // Dense proposals are ranked by the native ballistic preview, then each is
 // evaluated with the complete moving Game. The preview never certifies a hit.
 const count=targets.length<=6?181:61;
 const rough=Array.from({length:count},(_,i)=>.04+i*(Math.PI-.08)/(count-1));
 const targetIds=new Set(targets.map(p=>p.id));
 const scored=sim.scope(()=>rough.map(angle=>{
  const path=g.physics.predictTrajectory(g.launchX,g.launchY,angle,g.getCurrentLaunchPower(),600,false);
  let near=Infinity;for(const q of path.points)for(const p of targets)near=Math.min(near,Math.hypot(q.x-p.x,q.y-p.y));
  return {angle,rank:new Set(path.hits.filter(p=>targetIds.has(p.pegId)).map(p=>p.pegId)).size*100+path.hits.length*2-Math.min(100,near)*.1};
 })).sort((a,b)=>b.rank-a.rank);
 const selected=[];for(const p of scored){if(selected.every(q=>Math.abs(p.angle-q)>.018))selected.push(p.angle);if(selected.length===12)break;}
 return [...selected,...fixed.filter(a=>selected.every(p=>Math.abs(a-p)>.025)).slice(0,2)];
}
function trial(sim,angle){const copy=sim.fork(),shot=copy.shoot(angle);if(shot?.timeout)return null;copy.settle(1.5);const state=copy.summary();return {sim:copy,shot,cleared:sim.game.getOrangePegsLeft()-state.orangeLeft,
 score:(sim.game.getOrangePegsLeft()-state.orangeLeft)*100+shot.hitCount*3+Math.min(12,state.crossAssemblyImpacts.length)*2};}
export function measure(level,{route=true,seed='quality-native',firstAngles=fixed,idleSeconds=3}={}){
 let sim=new NativeSimulation(level,{seed}).settle(idleSeconds),initial=sim.summary(),first=[],best=null;
 for(const angle of firstAngles){const t=trial(sim,angle);if(!t){first.push({angle,timeout:true,cleared:0});continue;}first.push({angle,cleared:t.cleared,seconds:t.shot.seconds,fallen:t.sim.summary().fallenTargets,hitCount:t.shot.hitCount,portalTeleports:t.shot.portalTeleports,magnetBodyTicks:t.shot.magnetBodyTicks});if(!best||t.score>best.score)best=t;}
 const selected=[];if(best&&best.cleared>0){selected.push(best.shot.angle);sim=best.sim;}
 if(route)for(let turn=selected.length;turn<(level.ballCount||10)&&!sim.summary().complete&&sim.game.state!=='lost';turn++){
   let next=null;for(const angle of angles(sim)){const t=trial(sim,angle);if(t&&(!next||t.score>next.score))next=t;if(t?.sim.summary().complete)break;}
   if(!next||next.cleared===0&&next.shot.hitCount===0)break;selected.push(next.shot.angle);sim=next.sim;
 }
 const summary=sim.summary(),tail=sim.game.pegs.filter(p=>sim.game.isOrangePeg(p)&&!sim.game.hasPegBeenActivated(p.id));
 // Independent native replay creates the image sequence; it is not a scripted
 // animation of the design graph. Geometry/forces are always the real Game.
 const replay=new NativeSimulation(level,{seed}).settle(idleSeconds),frames=[{turn:0,...visualLevel(level,replay.game.pegs)}];
 for(const [i,angle] of selected.entries()){
  replay.samples=[];replay.shoot(angle,{trace:true});replay.settle(1.5);
  const path=replay.samples.filter((_,i)=>i%6===0).map(s=>s.balls[0]).filter(Boolean);
  frames.push({turn:i+1,...visualLevel(level,replay.game.pegs),paths:[path]});
 }
 return {id:level.id,seed,initialTargets:initial.orangeTotal,first,
   successfulFirstFraction:first.filter(s=>s.cleared>=3).length/first.length,
   peakFirstFraction:Math.max(0,...first.map(s=>s.cleared))/Math.max(1,initial.orangeTotal),
   complete:summary.complete,coverage:summary.fraction,shots:selected.length,angles:selected,idleSeconds,portalTeleports:summary.shots.reduce((n,s)=>n+(s.portalTeleports||0),0),
   replayComplete:replay.summary().complete,replayCoverage:replay.summary().fraction,
   fallen:summary.fallenTargets,direct:summary.directTargets,tail:tail.map(p=>({id:p.id,x:p.x,y:p.y,role:p.constructionRole,type:p.type})),frames};
}
if(process.argv[1]?.endsWith('/machine.mjs')){
 const sets={des1:(await read('data/des1/campaign.json')).levels,des:curateGeneratedPlaylist((await read('data/des/campaign.json')).levels),
 latest:(await read('data/player/campaigns/Alea_Main.json')).levels,gen:curateGeneratedPlaylist((await read('data/gen/alea.json')).levels)};
 const output={version:3,method:'Real Game.update, 9 first angles, dense preview proposals then full native route for des1; 3s idle and 1.5s settle after shots. Solver failure is not proof of impossibility.',sets:{}};
 let previous;try{previous=await read('data/quality/machine.json');if(previous.version!==3)previous=null;}catch{}
 for(const [name,levels] of Object.entries(sets)){output.sets[name]=previous?.sets?.[name]||[];for(const l of levels){if(output.sets[name].some(r=>r.id===l.id))continue;const result=measure(l,{route:name==='des1'});output.sets[name].push(result);console.log(name,l.id,'first max',result.peakFirstFraction.toFixed(2),'coverage',result.coverage.toFixed(2),'complete',result.complete,'shots',result.shots,'tail low',result.tail.filter(p=>p.y>520).length);await writeFile('data/quality/machine.json',JSON.stringify(output));}}
}
