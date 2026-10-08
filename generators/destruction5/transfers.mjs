import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {DestructionPegSystem} from '../../js/destruction-mode.js';
import {objectBounds,overlapDepth} from '../destruction2/ribbon-geometry.js';
import {sized} from '../destruction4/geometry.js';
import {visualLevel} from '../quality/metrics.js';

const collision=DestructionPegSystem.prototype.resolveBodyCollision;
DestructionPegSystem.prototype.resolveBodyCollision=function(a,b,overlap,...args){
 const result=collision.call(this,a,b,overlap,...args);this.des5Monitor?.contact(a,b);return result;
};
const step=DestructionPegSystem.prototype.step;
DestructionPegSystem.prototype.step=function(...args){const result=step.apply(this,args);this.des5Monitor?.sample(this,args[0]);return result;};

// Witness a real catch: a released cargo body must touch an authored receiving
// wall, then remain slow and touching that wall for 300 ms. A white-ball bounce,
// box crossing, idle impact or nominal graph edge cannot satisfy this test.
export class TransferMonitor{
 constructor(level){this.level=level;this.rows=level.metadata.generator.plan.edges.filter(e=>e.cargoIds?.length).flatMap(e=>e.cargoIds.map(id=>({edge:e,id,original:level.pegs.find(p=>p.id===id),contactAt:null,hold:0,maxHold:0,last:0,displacement:0,receiver:null})));}
 contact(a,b){
  for(const row of this.rows){let cargo,wall;
   if(a.peg?.id===row.id&&row.edge.receiverIds.includes(b.peg?.id)){cargo=a.peg;wall=b.peg;}
   if(b.peg?.id===row.id&&row.edge.receiverIds.includes(a.peg?.id)){cargo=b.peg;wall=a.peg;}
   if(!cargo||Math.hypot(cargo.x-row.original.x,cargo.y-row.original.y)<24)continue;
   if(row.contactAt===null)row.contactAt=performance.now();row.receiver=wall.id;
  }
 }
 sample(system,pegs){
  const now=performance.now(),map=new Map(pegs.map(p=>[p.id,p]));
  for(const row of this.rows){
   const cargo=map.get(row.id),dt=Math.min(20,Math.max(0,now-row.last));row.last=now;
   if(!cargo){row.hold=0;continue;}
   row.displacement=Math.max(row.displacement,Math.hypot(cargo.x-row.original.x,cargo.y-row.original.y));
   if(row.contactAt===null)continue;
   const body=[...system.bodies.values()].find(b=>b.pegIdSet.has(row.id)),walls=row.edge.receiverIds.map(id=>map.get(id)).filter(Boolean);
   const touching=walls.some(p=>overlapDepth({...sized(cargo),radius:11.5},sized(p))>0);
   const bottom=Math.max(...walls.map(p=>objectBounds(sized(p)).maxY));
   const retained=body&&Math.hypot(body.vx,body.vy)<1.35&&touching&&cargo.y<bottom+5;
   row.hold=retained?row.hold+dt:0;row.maxHold=Math.max(row.maxHold,row.hold);
   if(row.maxHold>=300&&!row.witness)row.witness={time:now,x:cargo.x,y:cargo.y,receiver:row.receiver};
  }
 }
 report(){return this.rows.map(({edge,id,contactAt,maxHold,displacement,witness})=>({edge:edge.id,cargo:id,contactAt,holdMs:Math.round(maxHold),displacement,caught:maxHold>=300,witness}));}
}
export function attachMonitor(sim,level){const monitor=new TransferMonitor(level);sim.game.destructionSystem.des5Monitor=monitor;return monitor;}

export function probeTransfers(level,{frames=false}={}){
 const edges=level.metadata.generator.plan.edges.filter(e=>e.required||e.kind==='recatch'),rows=[],images=[];
 for(const edge of edges){
  const sim=new NativeSimulation(level,{seed:'des5-release'}).settle(3.9),monitor=attachMonitor(sim,level);
  if(edge.upstream?.length){sim.scope(()=>{for(const id of edge.upstream){const p=sim.game.pegs.find(p=>p.id===id);if(p)sim.game.activatePeg(p,null,{allowMultiball:false});}});sim.settle(4);}
  sim.scope(()=>{for(const id of edge.releaseIds){const p=sim.game.pegs.find(p=>p.id===id);if(p)sim.game.activatePeg(p,null,{allowMultiball:false});}});
  if(frames)images.push({edge:edge.id,seconds:0,...visualLevel(level,sim.game.pegs)});
  for(let t=0;t<6;t++){sim.settle(1);if(frames)images.push({edge:edge.id,seconds:t+1,...visualLevel(level,sim.game.pegs)});}
  rows.push({edge:edge.id,from:edge.from,to:edge.to,cargo:monitor.report().filter(r=>r.edge===edge.id)});
 }
 return {method:'Diagnostic native floor hit, timed removal, contact with receiver and >=300 ms retained surface contact; independent of winning-route proof.',rows,frames:images,caught:rows.reduce((s,r)=>s+r.cargo.filter(c=>c.caught).length,0),allEdgesCaught:rows.filter(r=>level.metadata.generator.plan.edges.find(e=>e.id===r.edge).required).every(r=>r.cargo.some(c=>c.caught))};
}
