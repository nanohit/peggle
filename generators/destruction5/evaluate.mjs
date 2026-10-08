import {validateGeometry,compositionMetrics} from '../destruction4/geometry.js';
import {animationEnvelope} from '../destruction4/envelope.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {measure} from '../quality/machine.mjs';
import {designMetrics} from '../quality/metrics.js';
import {observe} from './observe.mjs';

export function evaluate(level,{frames=false}={}){
 const geometry=validateGeometry(level),plan=level.metadata.generator.plan,base={id:level.id,geometry,options:{seed:level.metadata.generator.seed}};
 if(!geometry.valid)return {...base,reason:'authored-geometry'};
 if(plan.nodes.length<2||geometry.targets<12)return {...base,reason:'insufficient-composition'};
 const envelope=animationEnvelope(level);if(!envelope.valid)return {...base,reason:'animation-envelope',envelope};
 const idle=new NativeSimulation(level,{seed:'des5-idle'}).settle(12);if(idle.game.getOrangePegsLeft()!==geometry.targets)return {...base,reason:'idle-target-loss',remaining:idle.game.getOrangePegsLeft()};
 const proof=measure(level,{seed:'des5-native',idleSeconds:3.9});
 if(!proof.complete||!proof.replayComplete)return {...base,reason:'native-route',proof};
 if(proof.shots<3||proof.shots>9||proof.peakFirstFraction>.80)return {...base,reason:'route-rhythm',proof};
 const evidence=observe(level,proof,{frames});
 if(!evidence.interaction.observedLinks||evidence.interaction.coupledInk<.30)return {...base,reason:'unobserved-orchestration',proof,evidence};
 if(level.pegs.some(p=>p.type.startsWith('portal'))&&!evidence.portalEvents.length&&!evidence.bodyPortalEvents.length)return {...base,reason:'unused-portal',proof,evidence};
 if(level.pegs.some(p=>p.type==='bombMagnet')&&evidence.fieldDifference<12&&!evidence.fieldExitDifference)return {...base,reason:'unused-field',proof,evidence};
 const metrics={...designMetrics(level),...compositionMetrics(level),focusShare:plan.focusShare,contributions:plan.contributions,nodes:plan.nodes.length,activeResponses:plan.activeResponses,topology:plan.topology,coupledInk:evidence.interaction.coupledInk};
 return {...base,envelope,metrics,proof:{...proof,frames:frames?evidence.frames:undefined},evidence:{...evidence,frames:undefined}};
}
