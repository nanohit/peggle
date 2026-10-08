import {generateLevel} from './grammar.js';
import {validateGeometry,compositionMetrics} from './geometry.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {measure} from '../quality/machine.mjs';
import {designMetrics} from '../quality/metrics.js';
import {observe} from './observe.mjs';
import {animationEnvelope} from './envelope.js';
export function evaluate(options,{cached=null}={}){
 const level=generateLevel(options),geometry=validateGeometry(level),base={id:level.id,options,geometry};if(!geometry.valid)return {...base,reason:'authored-geometry'};
 const idle=new NativeSimulation(level,{seed:'des4-idle'}).settle(12);if(idle.game.getOrangePegsLeft()!==geometry.targets)return {...base,reason:'idle-target-loss',idleTargets:idle.game.getOrangePegsLeft()};
 const envelope=animationEnvelope(level);if(!envelope.valid)return {...base,reason:'animation-envelope',envelope};
 const proof=cached?.proof||measure(level,{seed:'des4-native',idleSeconds:3.7});if(!proof.complete||!proof.replayComplete)return {...base,reason:'native-route',coverage:proof.coverage,tail:proof.tail};
 if(proof.shots<3||proof.shots>9||proof.peakFirstFraction>.78)return {...base,reason:'route-rhythm',proof};
 if(proof.first.filter(p=>p.hitCount>=3).length<2)return {...base,reason:'narrow-opening',proof};
 const evidence=cached?.evidence||observe(level,proof,{frames:false});if(!evidence.complete)return {...base,reason:'route-replay'};
 if(options.domain==='switchback'&&evidence.portalEvents.length+evidence.bodyPortalEvents.length<1)return {...base,reason:'unused-portal'};
 if(level.pegs.some(p=>p.type==='bombMagnet')&&evidence.fieldDifference<12&&!evidence.fieldExitDifference)return {...base,reason:'decorative-field'};
 if(level.groups.some(g=>g.animation?.hitTrigger)&&!evidence.triggerMotion.length)return {...base,reason:'unseen-response'};
 if(options.domain==='architecture'&&evidence.collapse.length<2)return {...base,reason:'static-house'};
 return {...base,envelope,metrics:{...designMetrics(level),...compositionMetrics(level)},proof,evidence};
}
