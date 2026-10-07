import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {validateIntentGeometry} from './geometry.js';

// Selection checks ordinary destruction gameplay, not a mandatory chain. There
// are no cargo passports, quotas, stage gates or early-release penalties.
export function evaluateIntentLevel(level,{seed='des1-proof',probeShots=true}={}) {
  const geometry=validateIntentGeometry(level);
  if(!geometry.valid)return {accepted:false,geometry};
  const sim=new NativeSimulation(level,{seed}).settle(2),before=sim.summary();sim.settle(2);
  const idle=sim.summary(),previous=new Map(before.pose.map(p=>[p.id,p]));
  const lateDrift=Math.max(0,...idle.pose.map(p=>Math.hypot(p.x-previous.get(p.id).x,p.y-previous.get(p.id).y)));
  const accepted=idle.orangeLeft===geometry.targets&&lateDrift<3;
  const shots=[];
  if(accepted&&probeShots) {
    const sources=level.metadata.generator.plan.assemblies.filter(a=>['ramp','hopper'].includes(a.type));
    const triggerIds=sources.flatMap(a=>a.triggerIds||[]);
    for(const id of triggerIds) {
      const p=sim.game.pegs.find(p=>p.id===id),copy=sim.fork();
      const shot=copy.shoot(Math.atan2(p.y-copy.game.launchY,p.x-copy.game.launchX));copy.settle(1);
      const state=copy.summary();shots.push({...shot,fallenTargets:state.fallenTargets,orangeLeft:state.orangeLeft,
        crossAssemblyImpacts:state.crossAssemblyImpacts});
    }
  }
  return {accepted,geometry,idle:{seconds:4,orangeLeft:idle.orangeLeft,lateDrift},seed,shots};
}

export function replayIntentLevel(level,proof) {
  const sim=new NativeSimulation(level,{seed:proof.seed}).settle(4);
  for(const shot of proof.route||[])if(!sim.summary().complete&&sim.game.state!=='lost')sim.shoot(shot.angle);
  return sim.summary();
}
