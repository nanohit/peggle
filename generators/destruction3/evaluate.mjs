import {generateLevel} from './grammar.js';import {validateGeometry} from './geometry.js';import {NativeSimulation} from '../destruction/native-simulator.mjs';import {measure} from '../quality/machine.mjs';import {designMetrics} from '../quality/metrics.js';import {experiment} from './experiments.mjs';
export function structureKey(l){const g=l.metadata.generator.plan,nodes=g.assemblies.filter(a=>['source','receiver','catcher'].includes(a.role)),index=new Map(nodes.map((a,i)=>[a.id,i]));return JSON.stringify([nodes.map(n=>n.type),g.links.map(e=>[index.get(e.from),index.get(e.to),e.kind]),g.motion,g.transport]);}
export function evaluate(options,{previousProof=null}={}){
 const level=generateLevel(options),geometry=validateGeometry(level);let reason=!geometry.valid?'geometry':null;
 if(!reason){const idle=new NativeSimulation(level).settle(3);if(idle.game.getOrangePegsLeft()!==geometry.targets)reason='idle-target-loss';
  if(!reason&&level.groups.some(g=>g.animation)){
   const period=Math.max(...level.groups.filter(g=>g.animation).map(g=>g.animation.duration))*2,sweep=new NativeSimulation(level);
   for(let phase=0;phase<=24;phase++){if(phase)sweep.settle(period/24);if(!validateGeometry(level,{pose:sweep.game.pegs,dynamic:true}).valid){reason='moving-sweep';break;}}
  }
 }
 if(reason)return {id:level.id,options,reason,errors:geometry.errors.slice(0,4)};
 const proof=previousProof||measure(level),metrics=designMetrics(level);
 if(!proof.complete||!proof.replayComplete||proof.successfulFirstFraction<2/9||proof.peakFirstFraction>.8)return {id:level.id,options,reason:'native-quality',coverage:proof.coverage,complete:proof.complete,first:proof.peakFirstFraction,successful:proof.successfulFirstFraction,tail:proof.tail};
 const e=experiment(level,proof);if(!e.baseline.complete)return {id:level.id,options,reason:'cached-route-replay-failed'};const g=level.metadata.generator,roots=g.plan.assemblies.filter(a=>a.role==='source').map(a=>a.id),rootHandoffs=e.handoffs.filter(h=>roots.includes(h.from));
 if(!rootHandoffs.some(h=>h.contact||h.viaPortal))return {id:level.id,options,reason:'no-source-handoff'};
 if(g.transport==='magnet'&&(e.fieldDisplacement<10&&e.fieldExitDifference===0||e.transfer.magnetTicks===0))return {id:level.id,options,reason:'decorative-field'};
 if(g.transport==='portal'&&e.transfer.bodyPortals===0&&proof.portalTeleports===0)return {id:level.id,options,reason:'decorative-portal'};
 return {id:level.id,options,key:structureKey(level),metrics,proof,experiment:e};
}
