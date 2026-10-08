import {validateGeometry,compositionMetrics} from '../destruction4/geometry.js';
import {animationEnvelope} from '../destruction4/envelope.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {measure} from '../quality/machine.mjs';
import {designMetrics} from '../quality/metrics.js';
import {probeTransfers} from './transfers.mjs';
import {observe} from './observe.mjs';

export function evaluate(level,{frames=false}={}){
 const geometry=validateGeometry(level),plan=level.metadata.generator.plan,base={id:level.id,geometry,options:{seed:level.metadata.generator.seed}};
 if(!geometry.valid)return {...base,reason:'authored-geometry'};
 const design=designMetrics(level);
 if(geometry.pegs<56||geometry.targets<25||design.occupiedCells<32||design.targetSpanX<275)return {...base,reason:'thin-composition',design};
 const envelope=animationEnvelope(level);if(!envelope.valid)return {...base,reason:'animation-envelope',envelope};
 const idle=new NativeSimulation(level,{seed:'des5-idle'}).settle(3.9),nativeInitial=validateGeometry({pegs:idle.game.pegs});
 if(!nativeInitial.valid)return {...base,reason:'native-initial-geometry',nativeInitial};
 idle.settle(8.1);if(idle.game.getOrangePegsLeft()!==geometry.targets)return {...base,reason:'idle-target-loss'};
 const diagnostic=probeTransfers(level);if(!diagnostic.allEdgesCaught)return {...base,reason:'missed-catch',diagnostic};
 const proof=measure(level,{seed:'des5-native',idleSeconds:3.9});
 if(!proof.complete||!proof.replayComplete)return {...base,reason:'native-route',proof};
 if(proof.shots<3||proof.shots>10||proof.peakFirstFraction>.70)return {...base,reason:'route-rhythm',proof};
 const evidence=observe(level,proof,{frames,diagnostic});
 if(!evidence.interaction.observedLinks)return {...base,reason:'no-catch-on-winning-route',proof,evidence};
 if(level.pegs.some(p=>p.type.startsWith('portal'))&&!evidence.portalEvents.length&&!evidence.bodyPortalEvents.length)return {...base,reason:'unused-portal',proof,evidence};
 if(level.pegs.some(p=>p.type==='bombMagnet')&&evidence.fieldDifference<8&&!evidence.fieldExitDifference)return {...base,reason:'unused-field',proof,evidence};
 const metrics={...design,...compositionMetrics(level),focusShare:plan.focusShare,contributions:plan.contributions,nodes:plan.nodes.length,activeResponses:plan.activeResponses,topology:plan.topology,coupledInk:evidence.interaction.coupledInk,actualCargoCaught:evidence.interaction.catches.filter(c=>c.caught).length};
 return {...base,nativeInitial,envelope,metrics,proof:{...proof,frames:frames?evidence.frames:undefined},evidence:{...evidence,frames:undefined}};
}
