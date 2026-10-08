import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {PegAnimator} from '../../js/animation.js';
import {PhysicsEngine} from '../../js/physics.js';
import {DestructionPegSystem} from '../../js/destruction-mode.js';
import {visualLevel} from '../quality/metrics.js';

// Read-only hooks on native events; diagnostic state belongs to each simulated
// instance. They neither activate pegs nor prescribe an animation/trajectory.
const notify=PegAnimator.prototype.notifyHit;
PegAnimator.prototype.notifyHit=function(id){
 const pending=this.des4Events?this.animations.map((a,i)=>({a,i})).filter(({a,i})=>a.hitTrigger&&a.pegIds.includes(id)&&!this._hitTriggerState.get(i)?.active):[];
 const result=notify.call(this,id);for(const {a,i} of pending)if(this._hitTriggerState.get(i)?.active)this.des4Events.push({pegId:id,groupId:a.groupId,mode:a.hitMode,step:this._hitTriggerState.get(i).step});return result;
};
const teleport=PhysicsEngine.prototype.tryPortalTeleport;
PhysicsEngine.prototype.tryPortalTeleport=function(ball,...args){const before={vx:ball?.vx,vy:ball?.vy};const result=teleport.call(this,ball,...args);if(this.des4Events&&result?.entry)this.des4Events.push({entryId:result.entry.id,exitId:result.exit.id,before,after:{vx:ball.vx,vy:ball.vy,x:ball.x,y:ball.y}});return result;};
const bodyPortal=DestructionPegSystem.prototype.applyPortalTeleport;
DestructionPegSystem.prototype.applyPortalTeleport=function(body,...args){const before=body?._lastPortalTeleport,result=bodyPortal.call(this,body,...args);if(this.des4Events&&body?._lastPortalTeleport!==before&&body?._lastPortalTeleport?.exitId)this.des4Events.push({...body._lastPortalTeleport,ids:[...body.pegIdSet]});return result;};

export function observe(level,proof,{seed=proof.seed,idle=proof.idleSeconds,frames=true}={}){
 const sim=new NativeSimulation(level,{seed}).settle(idle),original=new Map(sim.game.pegs.map(p=>[p.id,{x:p.x,y:p.y}])),motion=new Map(),shots=[],images=frames?[{turn:0,...visualLevel(level,sim.game.pegs)}]:[];
 sim.game.animator.des4Events=[];sim.game.physics.des4Events=[];sim.game.destructionSystem.des4Events=[];
 for(const [i,angle] of proof.angles.entries()){
  if(sim.summary().complete)break;sim.samples=[];const result=sim.shoot(angle,{trace:true});sim.settle(1.5);shots.push(result);
  for(const sample of sim.samples)for(const p of sample.pegs){const q=original.get(p.id);if(!q)continue;const m=motion.get(p.id)||{dx:0,dy:0,distance:0};m.dx=Math.max(m.dx,Math.abs(p.x-q.x));m.dy=Math.max(m.dy,Math.abs(p.y-q.y));m.distance=Math.max(m.distance,Math.hypot(p.x-q.x,p.y-q.y));motion.set(p.id,m);}
  if(frames){const points=sim.samples.filter((_,j)=>j%6===0).map(s=>s.balls[0]).filter(Boolean),paths=[[]];for(const p of points){const path=paths.at(-1);if(path.length&&Math.hypot(path.at(-1).x-p.x,path.at(-1).y-p.y)>125)paths.push([]);paths.at(-1).push(p);}images.push({turn:i+1,...visualLevel(level,sim.game.pegs),paths});}
 }
 const state=sim.summary(),events=sim.game.animator.des4Events,partIds=new Map(level.metadata.generator.parts.map(a=>[a.id,a]));
 const activeGroups=new Set(events.map(e=>e.groupId)),triggerMotion=level.pegs.filter(p=>activeGroups.has(p.groupId)).map(p=>({...motion.get(p.id),id:p.id,group:p.groupId})).filter(p=>p.distance>=7),cargo=level.pegs.filter(p=>p.constructionRole==='cargo'),cargoMotion=cargo.map(p=>({id:p.id,...motion.get(p.id)}));
 const collapse=level.pegs.filter(p=>['floor','support'].includes(p.constructionRole)).map(p=>({id:p.id,...motion.get(p.id)})).filter(p=>p.distance>25);
 let fieldDifference=0,fieldExitDifference=0;
 if(level.pegs.some(p=>p.type==='bombMagnet')){
  const without=structuredClone(level);without.pegs=without.pegs.filter(p=>p.type!=='bombMagnet');const ablation=new NativeSimulation(without,{seed}).settle(idle);
  for(const angle of proof.angles.slice(0,2)){if(ablation.summary().complete)break;ablation.shoot(angle);ablation.settle(1.5);}
  // Compare the same two shot policy, not a newly optimized route; the effect
  // can change after destruction, so it is evidence of contribution, not need.
  const baseline=new NativeSimulation(level,{seed}).settle(idle);for(const angle of proof.angles.slice(0,2)){if(baseline.summary().complete)break;baseline.shoot(angle);baseline.settle(1.5);}
  for(const p of cargo){const a=baseline.game.pegs.find(q=>q.id===p.id),b=ablation.game.pegs.find(q=>q.id===p.id);if(a&&b)fieldDifference=Math.max(fieldDifference,Math.hypot(a.x-b.x,a.y-b.y));else if(!!a!==!!b)fieldExitDifference++;}
 }
 return {complete:state.complete,state:state.state,shots,hitEvents:events,triggerMotion,portalEvents:sim.game.physics.des4Events,bodyPortalEvents:sim.game.destructionSystem.des4Events,magnetTicks:shots.reduce((s,q)=>s+(q?.magnetBodyTicks||0),0),fieldDifference,fieldExitDifference,cargoMotion,collapse,
  horizontalTravel:Math.max(0,...[...motion.values()].map(p=>p.dx)),verticalTravel:Math.max(0,...[...motion.values()].map(p=>p.dy)),frames:images};
}
