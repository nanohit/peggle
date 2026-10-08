import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {observe as observeMechanics} from '../destruction4/observe.mjs';
import {attachMonitor,probeTransfers} from './transfers.mjs';

export function classifyCatches(plan,catches,release){
 const sequential=(e,c)=>e.kind!=='recatch'||catches.some(p=>p.cargo===c.cargo&&p.caught&&p.witness?.time<=c.contactAt&&plan.edges.find(q=>q.id===p.edge)?.to===e.from);
 const links=plan.edges.map(e=>{
  const all=catches.filter(c=>c.edge===e.id&&c.caught),real=all.filter(c=>sequential(e,c)),test=release.rows.find(r=>r.edge===e.id)?.cargo||[];
  return {id:e.id,from:e.from,to:e.to,kind:e.kind,actualCargoCaught:real.length,directLowerCatches:all.length-real.length,diagnosticCargoCaught:test.filter(c=>c.caught).length,observed:real.length>0};
 });
 const involved=new Set(links.filter(l=>l.observed).flatMap(l=>[l.from,l.to])),total=plan.nodes.reduce((s,n)=>s+n.ink,0);
 return {catches,release:{...release,frames:undefined},links,observedLinks:links.filter(l=>l.observed).length,totalLinks:links.length,coupledInk:plan.nodes.filter(n=>involved.has(n.id)).reduce((s,n)=>s+n.ink,0)/total};
}

export function observe(level,proof,{frames=true,diagnostic}={}){
 const mechanics=observeMechanics(level,proof,{frames}),sim=new NativeSimulation(level,{seed:proof.seed}).settle(proof.idleSeconds),monitor=attachMonitor(sim,level),plan=level.metadata.generator.plan;
 for(const angle of proof.angles){if(sim.summary().complete)break;sim.shoot(angle);sim.settle(1.5);}
 const interaction=classifyCatches(plan,monitor.report(),diagnostic||probeTransfers(level));
 return {...mechanics,complete:mechanics.complete&&sim.summary().complete,interaction};
}
