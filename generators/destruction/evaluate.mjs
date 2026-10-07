import { NativeSimulation, simulateSequence } from './native-simulator.mjs';
import {validateGeometry} from './geometry.js';
export {validateGeometry} from './geometry.js';

const coarse=Array.from({length:17},(_,i)=>.16+i*(Math.PI-.32)/16);
export function candidateAngles(sim){
  const g=sim.game,angles=coarse.filter((_,i)=>i%2===0);
  const remaining=g.pegs.filter(p=>g.isOrangePeg(p)&&!g.hitPegIds.includes(p.id));
  if(remaining.length<=8)angles.unshift(.08,Math.PI-.08,.035,Math.PI-.035);
  const targets=new Set(remaining.map(p=>p.id));
  const targetAssemblies=new Set(remaining.map(p=>p.constructionAssembly));
  const supports=new Set(g.pegs.filter(p=>p.type==='blue'&&targetAssemblies.has(p.constructionAssembly)&&!g.hitPegIds.includes(p.id)).map(p=>p.id));
  // Cheap native trajectory preview only proposes shots. The complete moving-body
  // game decides their score; frozen previews are never accepted as physical proof.
  const ranked=sim.scope(()=>Array.from({length:121},(_,i)=>{
    const angle=.1+i*(Math.PI-.2)/120;
    const path=g.physics.predictTrajectory(g.launchX,g.launchY,angle,g.getCurrentLaunchPower(),remaining.length<=8?800:300,false);
    const hit=new Set(path.hits.map(p=>p.pegId)),count=[...hit].filter(id=>targets.has(id)).length;
    const distance=Math.min(...remaining.map(p=>Math.min(...path.points.map(q=>Math.hypot(p.x-q.x,p.y-q.y)))));
    return {angle,rank:count*100+[...hit].filter(id=>supports.has(id)).length*24-distance};
  })).sort((a,b)=>b.rank-a.rank);
  for(const r of ranked){if(angles.every(a=>Math.abs(a-r.angle)>.024))angles.push(r.angle);if(angles.length>=25)break;}
  return angles;
}
export function findRoute(initial,{maxShots=8}={}){
  let sim=initial,probes=0;
  for(let turn=0;turn<maxShots&&!sim.summary().complete&&sim.game.state!=='lost';turn++){
    let best=null;
    for(const angle of candidateAngles(sim)){
      const candidate=sim.fork();const shot=candidate.shoot(angle);probes++;
      if(shot.timeout)continue;
      const state=candidate.summary();
      const rank=(sim.game.getOrangePegsLeft()-state.orangeLeft)*100+shot.fallenTargets*2+Math.min(shot.hitCount,8)*3+state.crossAssemblyImpacts.length-shot.seconds*.05;
      if(!best||rank>best.rank)best={candidate,rank};
      if(state.complete)break;
    }
    if(!best)break;
    if(best.candidate.game.getOrangePegsLeft()===sim.game.getOrangePegsLeft()&&best.candidate.shots.at(-1).hitCount===0)break;
    sim=best.candidate;
  }
  return {sim,probes};
}
export function evaluateLevel(level,{seed='native',holdout=true}={}){
  const geometry=validateGeometry(level);if(!geometry.valid)return {accepted:false,geometry};
  const sim=new NativeSimulation(level,{seed}).settle(6),idlePose=sim.summary();sim.settle(4);
  const idle=sim.summary(),positions=new Map(idlePose.pose.map(p=>[p.id,p]));
  const lateDrift=Math.max(0,...idle.pose.map(p=>Math.hypot(p.x-positions.get(p.id).x,p.y-positions.get(p.id).y)));
  if(idle.orangeLeft!==geometry.targets||idle.fallenTargets||lateDrift>2.5)return {accepted:false,geometry,idle:{lateDrift,orangeLeft:idle.orangeLeft}};
  const firstShots=coarse.map(angle=>{const copy=sim.fork();return copy.shoot(angle);});
  const route=findRoute(sim),result=route.sim.summary();
  const replay=simulateSequence(level,result.shots.map(s=>s.angle),{idleSeconds:10,seed});
  if(JSON.stringify(replay.pose)!==JSON.stringify(result.pose))throw Error('Native replay mismatch');
  const robustness=holdout?findRoute(new NativeSimulation(level,{seed:seed+'-holdout'}).settle(2)):null;
  const fresh=robustness?.sim.summary();
  const accepted=result.complete&&(!fresh||fresh.complete)&&result.crossAssemblyImpacts.length>=1&&result.fallenTargets>=3;
  return {accepted,geometry,idle:{lateDrift,maxDrift:idle.maxDrift,orangeLeft:idle.orangeLeft},
    firstShots:firstShots.map(s=>({angle:s.angle,cleared:s.cleared,fallen:s.fallenTargets,timeout:s.timeout})),
    firstShotCoverage:firstShots.filter(s=>s.cleared>0).length/firstShots.length,
    route:result.shots,routeSeed:seed,complete:result.complete,fallenTargets:result.fallenTargets,
    directTargets:result.directTargets,crossAssemblyImpacts:result.crossAssemblyImpacts,probes:route.probes,
    holdout:fresh?{complete:fresh.complete,shots:fresh.shots,fallenTargets:fresh.fallenTargets,probes:robustness.probes}:null};
}
