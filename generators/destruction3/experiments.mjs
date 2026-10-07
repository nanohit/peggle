import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {DestructionPegSystem} from '../../js/destruction-mode.js';
import {visualLevel} from '../quality/metrics.js';
const contact=DestructionPegSystem.prototype.resolveBodyCollision;
DestructionPegSystem.prototype.resolveBodyCollision=function(a,b,...args){
 if(this.des3Probe){
  const left=a.peg,right=b.peg;
  if(left?.constructionRole==='cargo'&&left.constructionAssembly!==right?.constructionAssembly)this.des3Probe.contacts.add(left.constructionAssembly+'>'+right?.constructionAssembly);
  if(right?.constructionRole==='cargo'&&right.constructionAssembly!==left?.constructionAssembly)this.des3Probe.contacts.add(right.constructionAssembly+'>'+left?.constructionAssembly);
 }
 return contact.call(this,a,b,...args);
};
const bodyPortal=DestructionPegSystem.prototype.applyPortalTeleport;
DestructionPegSystem.prototype.applyPortalTeleport=function(...args){const before=args[0]?._lastPortalTeleport;const changed=bodyPortal.apply(this,args);if(changed&&this.des3Probe&&args[0]?._lastPortalTeleport!==before&&args[0]?._lastPortalTeleport?.exitId){this.des3Probe.bodyPortals++;this.des3Probe.portalEvents.push({...args[0]._lastPortalTeleport,pegIds:[...args[0].pegIdSet]});}return changed;};
function replay(level,angles,{seed='quality-native',idle=3}={}){
 const sim=new NativeSimulation(level,{seed}).settle(idle);
 for(const angle of angles){if(sim.summary().complete||sim.game.state==='lost')break;const shot=sim.shoot(angle);if(shot?.timeout)break;sim.settle(1.5);}
 const s=sim.summary();return {complete:s.complete,coverage:s.fraction,shots:s.shots.length,seconds:s.shots.reduce((n,s)=>n+s.seconds,0),fallen:s.fallenTargets,contacts:s.crossAssemblyImpacts.length};
}
function release(level,{removeFields=false}={}){
 const l=structuredClone(level);if(removeFields)l.pegs=l.pegs.filter(p=>p.type!=='bombMagnet');
 const sim=new NativeSimulation(l).settle(3),plan=level.metadata.generator.plan;
 sim.game.destructionSystem.des3Probe={contacts:new Set(),bodyPortals:0,portalEvents:[]};
 const sourceIds=plan.assemblies.filter(a=>a.role==='source').flatMap(a=>a.triggers);
 // A causal intervention into existing native pegs, not a simulated player
 // route: remove each source's floor/gate using Game's real activation/timers.
 sim.scope(()=>{for(const id of sourceIds){const p=sim.game.pegs.find(p=>p.id===id);if(p)sim.game.activatePeg(p,null,{allowMultiball:false});}});
 const frames=[visualLevel(l,sim.game.pegs)];
 for(let i=0;i<6;i++){sim.settle(.5);if([1,3,5].includes(i))frames.push(visualLevel(l,sim.game.pegs));}
 const probe=sim.game.destructionSystem.des3Probe,magnetTicks=sim.game.destructionSystem.simMagnetTicks;
 const cargoIds=plan.assemblies.filter(a=>a.role==='source').flatMap(a=>a.cargoIds);
 return {contacts:[...probe.contacts],bodyPortals:probe.bodyPortals,portalEvents:probe.portalEvents,magnetTicks,pose:sim.game.pegs.filter(p=>cargoIds.includes(p.id)).map(p=>({id:p.id,x:p.x,y:p.y})),frames};
}
export function experiment(level,proof){
 const baseline=replay(level,proof.angles),removed=structuredClone(level),g=level.metadata.generator;
 const helpers=g.plan.links.flatMap(e=>e.helpers),nativeHelpers=['bombMagnet','portalBlue','portalOrange','bumper'];
 removed.pegs=removed.pegs.filter(p=>!nativeHelpers.includes(p.type));removed.groups=removed.groups.map(({animation,...group})=>group);
 const withoutHelpers=replay(removed,proof.angles),transfer=release(level),withoutField=g.transport==='magnet'?release(level,{removeFields:true}):null;
 let fieldDisplacement=0,fieldExitDifference=0;
 if(withoutField){
  const all=new Set([...transfer.pose,...withoutField.pose].map(p=>p.id));
  for(const id of all){const p=transfer.pose.find(p=>p.id===id),q=withoutField.pose.find(p=>p.id===id);if(p&&q)fieldDisplacement=Math.max(fieldDisplacement,Math.hypot(p.x-q.x,p.y-q.y));else fieldExitDifference++;}
 }
 const handoffs=g.plan.links.map(e=>({from:e.from,to:e.to,kind:e.kind,contact:transfer.contacts.includes(e.from+'>'+e.to),viaPortal:e.kind==='portal'&&transfer.portalEvents.some(event=>{const a=level.pegs.find(p=>p.id===event.entryId),b=level.pegs.find(p=>p.id===event.exitId);return e.helpers.includes(a?.constructionAssembly)&&a?.constructionAssembly===b?.constructionAssembly&&event.pegIds.some(id=>g.plan.assemblies.find(a=>a.id===e.from)?.pegs.includes(id));})}));
 return {id:level.id,baseline,withoutHelpers,helpers,transfer,fieldDisplacement,fieldExitDifference,handoffs,
  caveat:'Release is a component experiment through native Game timers. The independent winning route is actual launcher-ball play. Contact is evidence of a handoff, not proof of a mandatory sequence.'};
}
