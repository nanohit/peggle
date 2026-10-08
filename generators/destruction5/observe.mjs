import {Game} from '../../js/game.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {observe as observeMechanics} from '../destruction4/observe.mjs';

const activate=Game.prototype.activatePeg;
Game.prototype.activatePeg=function(peg,ball,options){
 const result=activate.call(this,peg,ball,options);
 if(result&&ball&&this.des5Events)this.des5Events.push({pegId:peg.id,node:this.des5Ownership.get(peg.id),shot:this.des5Shot,time:performance.now(),x:peg.x,y:peg.y,vx:ball.vx,vy:ball.vy});
 return result;
};

export function observe(level,proof,{frames=true}={}){
 const mechanics=observeMechanics(level,proof,{frames}),plan=level.metadata.generator.plan,parts=new Map(level.metadata.generator.parts.map(p=>[p.id,p.nodeId])),ownership=new Map(level.pegs.map(p=>[p.id,p.constructionSubsystem||parts.get(p.constructionAssembly)]));
 const sim=new NativeSimulation(level,{seed:proof.seed}).settle(proof.idleSeconds);sim.game.des5Events=[];sim.game.des5Ownership=ownership;
 const crossings=[],cargo=level.pegs.filter(p=>p.constructionRole==='cargo');
 for(const [i,angle] of proof.angles.entries()){
  if(sim.summary().complete)break;sim.game.des5Shot=i;sim.samples=[];sim.shoot(angle,{trace:true});sim.settle(1.5);
  for(const p of cargo)for(const edge of plan.edges.filter(e=>e.from===ownership.get(p.id))){
   const trace=sim.samples.map(s=>s.pegs.find(q=>q.id===p.id)).filter(Boolean);
   for(let j=1;j<trace.length;j++){const a=trace[j-1],b=trace[j],into=edge.in;if(a.y<into.y&&b.y>=into.y&&Math.abs(b.x-into.x)<into.halfWidth+8.5){crossings.push({edge:edge.id,peg:p.id,shot:i});break;}}
  }
 }
 const events=sim.game.des5Events.filter(e=>e.node),transitions=[];
 for(let i=1;i<events.length;i++){const a=events[i-1],b=events[i];if(a.shot===b.shot&&a.node!==b.node)transitions.push({from:a.node,to:b.node,shot:a.shot,seconds:(b.time-a.time)/1000});}
 const impacts=sim.summary().crossAssemblyImpacts.map(p=>({...p,nodes:p.assemblies.map(a=>parts.get(a))})).filter(p=>p.nodes[0]&&p.nodes[1]&&p.nodes[0]!==p.nodes[1]);
 const links=plan.edges.map(edge=>{const white=transitions.filter(t=>t.from===edge.from&&t.to===edge.to),body=impacts.filter(p=>p.nodes.includes(edge.from)&&p.nodes.includes(edge.to)),aperture=crossings.filter(p=>p.edge===edge.id),portals=mechanics.portalEvents.filter(p=>edge.portals?.includes(p.entryId)&&edge.portals?.includes(p.exitId));return {id:edge.id,from:edge.from,to:edge.to,kind:edge.kind,whiteTransitions:white.length,nativeBodyImpacts:body.length,authoredApertureCrossings:aperture.length,nativePortalTransfers:portals.length,observed:!!(white.length||body.length||aperture.length||portals.length)};});
 const involved=new Set(links.filter(l=>l.observed).flatMap(l=>[l.from,l.to])),totalInk=plan.nodes.reduce((s,n)=>s+n.ink,0),coupledInk=plan.nodes.filter(n=>involved.has(n.id)).reduce((s,n)=>s+n.ink,0)/totalInk;
 return {...mechanics,interaction:{events,transitions,impacts,crossings,links,coupledInk,observedLinks:links.filter(l=>l.observed).length,totalLinks:links.length,hitNodes:[...new Set(events.map(e=>e.node))]},complete:mechanics.complete&&sim.summary().complete};
}
