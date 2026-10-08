import {randomFrom} from '../destruction/grammar.js';
import {SystemBuilder,compileNode,CATALOG} from './components.js';
import {validateGeometry,sized} from '../destruction4/geometry.js';
import {objectBounds} from '../destruction2/ribbon-geometry.js';
import {between,choose,clamp,TAU,cubic} from '../destruction4/shapes.js';

export function designGenome(seed){
 const r=randomFrom(seed+':des5-intent');
 return {focus:between(r,.28,.86),kinetic:between(r,.18,.94),branching:between(r,.10,.88),openness:between(r,.47,.97),lateral:between(r,.13,.94),complexity:between(r,.30,.94),bend:between(r,-.72,.72),phase:r()*TAU,radialGrowth:r(),brickWidth:between(r,30,35),pegScale:between(r,1,1.27),direction:choose(r,[-1,1])};
}
function weighted(r,rows){const total=rows.reduce((s,[,w])=>s+w,0);let t=r()*total;for(const [value,w] of rows){t-=w;if(t<=0)return value;}return rows.at(-1)[0];}
function dimensions(kind,w,r){
 if(kind==='contour')return {w,h:w*between(r,.75,1.10)};
 if(kind==='channel')return {w,h:between(r,115,176)};
 if(kind==='support')return {w:Math.min(215,w),h:between(r,122,158)};
 if(kind==='seesaw'||kind==='bridge'||kind==='shelf')return {w:Math.min(kind==='bridge'?200:188,w),h:70};
 if(kind==='cup'||kind==='sling')return {w,h:w*between(r,.48,.66)};
 return {w,h:between(r,55,88)};
}
const near=(p,v)=>{const dx=v.b.x-v.a.x,dy=v.b.y-v.a.y,t=clamp(((p.x-v.a.x)*dx+(p.y-v.a.y)*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(p.x-v.a.x-t*dx,p.y-v.a.y-t*dy);};
const area=b=>Math.max(0,b.maxX-b.minX)*Math.max(0,b.maxY-b.minY);
function intersection(a,b){return Math.max(0,Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX))*Math.max(0,Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY));}

// A frontier is an unmet physical opportunity. Branching changes the number
// of discharge regions and the preference for old branches vs deeper growth;
// it is not a label on a randomly selected list of components.
export function growthFrontier(nodes,edges,g){
 return nodes.flatMap(node=>node.outputs.flatMap((out,index)=>{
  const split=node.outputs.length===1&&out.halfWidth>=38&&g.branching>.57,
   ports=split?[-1,1].map(side=>({...out,x:out.x+side*out.halfWidth*.5,halfWidth:out.halfWidth*.56,vx:out.vx+side*g.branching*.75,partition:side})): [{...out,partition:0}];
  return ports.map(port=>{const key=node.id+':'+index+':'+port.partition,
   used=edges.some(e=>e.outletKey===key),
   preference=(1-g.branching)*(1+node.depth)**2+g.branching*(1+node.outputs.length)/(1+node.depth*.5);
   return {node,port,index,key,used,weight:preference*(used?.035:1)};
  });
 }));
}

export function growSystem({seed='meta-000',genome:override}={}){
 seed=String(seed).slice(0,60);const genome={...designGenome(seed),...override},g=genome,r=randomFrom(seed+':des5-growth'),b=new SystemBuilder(seed,g);
 const budget={pegs:Math.round(48+g.complexity*44),nodes:3+Math.round(g.complexity*3),active:1+Math.round(g.kinetic*2),targets:Math.round(19+g.complexity*8),corridorWidth:26+g.openness*16},reservations=[];
 let serial=0,active=0;
 const eligible=(kind)=>active+CATALOG[kind].cost<=budget.active;
 const receiver=()=>weighted(r,[['cup',.37],['sling',eligible('sling')?g.kinetic*.7:0],['seesaw',eligible('seesaw')?g.kinetic*.65:0],['support',eligible('support')?g.kinetic*.33:0],['contour',g.focus*.42],['fan',g.openness*.48],['channel',g.lateral*.60]].map(([kind,weight])=>[kind,weight/(1+b.nodes.filter(n=>n.kind===kind).length*2.2)]));
 function add(spec,{commit=true}={}){
  const checkpoint=b.checkpoint(),node=compileNode(b,{...spec,response:g.kinetic>.49&&active<budget.active}),geo=validateGeometry({pegs:b.pegs}),board=node.envelope.minX>=12&&node.envelope.maxX<=388&&node.envelope.minY>=105&&node.envelope.maxY<=538;
  if(spec.role==='supply'&&node.loadIds.length<2){b.rollback(checkpoint);return {reason:'depleted-source'};}
  if(active+node.moving>budget.active){b.rollback(checkpoint);return {reason:'response-budget'};}
  if(!geo.valid||!board||b.pegs.length>budget.pegs){b.rollback(checkpoint);return {reason:!geo.valid?'geometry':!board?'motion-envelope':'material-budget',errors:geo.errors.slice(0,3)};}
  const crossing=b.nodes.filter(n=>!(spec.role==='interior'&&spec.parentId===n.id)&&intersection(n.envelope,node.envelope)>Math.min(area(n.envelope),area(node.envelope))*.45);
  if(crossing.length){b.rollback(checkpoint);return {reason:'response-conflict'};}
  // The proposal's score evaluates the same global field. A corridor is empty
  // for a reason; filling it is a cost, even when pegs do not initially overlap.
  const intrusion=b.pegs.slice(checkpoint.pegs).filter(p=>reservations.some(v=>!v.endpoints.includes(node.id)&&near(p,v)<v.width/2+10)).length;
  if(intrusion>3){b.rollback(checkpoint);return {reason:'flight-corridor'};}
  if(!commit){b.rollback(checkpoint);return {node};}
  b.nodes.push(node);active+=node.moving;return {node};
 }
 const rootKind=weighted(r,[['contour',g.focus*1.6],['channel',(1-g.focus)*.95],['support',g.kinetic*.62],['seesaw',g.kinetic*.34],['bridge',g.kinetic*.20],['cup',.16]]);
 for(let trial=0;trial<60&&!b.nodes.length;trial++){
  const kind=trial>34?'channel':rootKind,w=between(r,163,199)+g.focus*41,dim=dimensions(kind,w,r),margin=dim.w/2+22;
  add({id:'n0',kind,x:between(r,margin,400-margin),y:between(r,195,286),...dim,direction:g.direction,role:'focus',depth:0,variant:trial});
 }
 if(!b.nodes.length)throw Error('No full-size initial subsystem fits');
 serial=1;
 for(let step=0;step<budget.nodes*3&&b.nodes.length<budget.nodes;step++){
  const frontier=weighted(r,growthFrontier(b.nodes,b.edges,g).map(f=>[f,f.weight])),parent=frontier.node,pocket=parent.pockets.find(p=>p.w>=69&&p.accepts.includes('bearing')),
   interior=pocket&&eligible('seesaw')&&!b.nodes.some(n=>n.parentId===parent.id)&&r()<g.kinetic*.52,
   upstream=!interior&&parent.inputs.some(p=>p.accepts.includes('cargo'))&&!b.edges.some(e=>e.to===parent.id)&&r()<.19,
   side=!interior&&!upstream&&r()<g.lateral*.30,remote=!interior&&!upstream&&!side&&!b.edges.some(e=>e.kind==='portal')&&r()<g.lateral*.24;
  const mode=interior?'interior':upstream?'supply':side?'rebound':remote?'remote':'receive',kind=interior?'seesaw':mode==='supply'?weighted(r,[['shelf',.4],['cup',.3],['seesaw',eligible('seesaw')?g.kinetic*.45:0]]):mode==='rebound'?weighted(r,[['fan',.4],['channel',.6]]):receiver();
  const port=upstream?choose(r,parent.inputs):frontier.port,candidates=[],failures={};
  for(let trial=0;trial<36;trial++){
   const wantedWidth=interior?between(r,67,Math.min(91,pocket.w)):mode==='rebound'?between(r,79,112):clamp(port.halfWidth*between(r,1.65,2.45),96,mode==='supply'?151:162),dim=dimensions(kind,wantedWidth,r),dy=upstream?-between(r,55,106):mode==='rebound'?between(r,-20,55):between(r,65,113),y=interior?pocket.y+between(r,-8,8):remote?between(r,209,420):port.y+dy;
   const predicted=port.x+port.vx*(Math.sqrt(Math.abs(dy)/.06))*(upstream?-.35:1),x=interior?pocket.x+between(r,-12,12):remote?(parent.x<200?between(r,270,328):between(r,72,130)):mode==='rebound'?parent.x+choose(r,[-1,1])*(parent.w/2+dim.w/2+between(r,14,33)):predicted+between(r,-38,38)*g.lateral;
   const spec={id:'n'+serial,kind,x,y,...dim,direction:upstream?Math.sign(parent.x-x)||g.direction:Math.sign(x-parent.x)||g.direction,role:mode,...(interior?{parentId:parent.id}:{}),depth:parent.depth+(upstream?0:1),variant:step*36+trial},result=add(spec,{commit:false});
   if(result.reason){failures[result.reason]=(failures[result.reason]||0)+1;continue;}
   const node=result.node,input=upstream?parent.inputs[0]:node.inputs[0],output=interior?{x:parent.x,y:parent.y+parent.h*.1,halfWidth:parent.w*.15,vx:0,vy:1}:upstream?node.outputs[0]:port,alignment=Math.abs(input.x-output.x)/Math.max(30,input.halfWidth),spread=Math.hypot(node.x-200,node.y-300)/230;
   const score=-alignment*.55+spread*.25+g.lateral*Math.abs(node.x-parent.x)/200-intersection(node.envelope,parent.envelope)/3000;
   candidates.push({spec,node,input,output,score});
  }
  candidates.sort((a,b)=>b.score-a.score);const chosen=candidates[0];
  if(!chosen){b.decisions.push({parent:parent.id,request:mode,kind,action:'omit',failures});continue;}
  const checkpoint=b.checkpoint(),{node}=add(chosen.spec);if(!node)throw Error('Deterministic proposal did not replay');
  const edge={id:'e'+b.edges.length,from:upstream?node.id:parent.id,to:upstream?parent.id:node.id,kind:interior?'bearing':remote?'portal':mode==='rebound'?'ricochet':'discharge',out:{...chosen.output},in:{...chosen.input},outletKey:upstream?node.id+':0:0':interior?undefined:frontier.key,required:false};
  if(remote){
   const a=b.part('portal-coupler');a.source='des2';a.nodeId=parent.id;const entry={x:edge.out.x,y:edge.out.y+25},exit={x:edge.in.x+between(r,-40,40),y:edge.in.y-between(r,49,79)},flight=between(r,20,29),velocity={vx:(edge.in.x-exit.x)/flight,vy:(edge.in.y-exit.y-.06*flight*flight)/flight},entryAngle=Math.atan2(edge.out.vy,edge.out.vx)-Math.PI/2,exitAngle=Math.atan2(velocity.vy,velocity.vx)-Math.PI/2;
   if(!b.clear({...entry,type:'portalBlue',angle:entryAngle,portalScale:2},5)||!b.clear({...exit,type:'portalOrange',angle:exitAngle,portalScale:2},5)){b.rollback(checkpoint);b.nodes.pop();active-=node.moving;b.decisions.push({parent:parent.id,request:mode,kind,action:'omit',failures:{'portal-aperture':1}});continue;}
   const pa=b.peg(a,entry.x,entry.y,{type:'portalBlue',angle:entryAngle,portalScale:2,portalOneWay:true,portalOneWayFlip:false,constructionSubsystem:parent.id}),pb=b.peg(a,exit.x,exit.y,{type:'portalOrange',angle:exitAngle,portalScale:2,portalOneWay:true,portalOneWayFlip:true,constructionSubsystem:node.id});pa.portalTargetId=pb.id;pb.portalTargetId=pa.id;edge.portals=[pa.id,pb.id];edge.entry=entry;edge.exit=exit;edge.estimatedOutletVelocity=velocity;
  }
  serial++;
  b.edges.push(edge);if(remote){reservations.push({a:edge.out,b:edge.entry,width:budget.corridorWidth,endpoints:[edge.from,edge.to]},{a:edge.exit,b:edge.in,width:budget.corridorWidth,endpoints:[edge.from,edge.to]});}else reservations.push({a:edge.out,b:edge.in,width:budget.corridorWidth,endpoints:[edge.from,edge.to]});b.decisions.push({parent:parent.id,request:mode,kind,action:'grow',node:node.id,reason:mode==='supply'?'load the existing aperture':mode==='rebound'?'redirect a related side shot':remote?'connect a remote compatible aperture':'receive the discharge region'});
 }
 // Rejoining is allowed when an existing aperture catches an unserved fan.
 // It adds a contract, never decorative pegs or a compulsory action sequence.
 if(g.branching>.60)for(const f of growthFrontier(b.nodes,b.edges,g).filter(f=>!f.used)){
  const into=b.nodes.filter(n=>n.id!==f.node.id&&!b.edges.some(e=>e.from===f.node.id&&e.to===n.id)).flatMap(n=>n.inputs.map(p=>({n,p,dy:p.y-f.port.y}))).filter(o=>o.dy>35&&o.dy<170&&Math.abs(o.p.x-f.port.x-f.port.vx*Math.sqrt(o.dy/.06))<o.p.halfWidth*.8);
  into.sort((a,b)=>a.dy-b.dy);const match=into[0];if(!match)continue;
  const corridor={a:f.port,b:match.p,width:budget.corridorWidth,endpoints:[f.node.id,match.n.id]};
  if(b.pegs.some(p=>!corridor.endpoints.includes(p.constructionSubsystem)&&near(p,corridor)<corridor.width/2+8.5))continue;
  b.edges.push({id:'e'+b.edges.length,from:f.node.id,to:match.n.id,kind:'discharge',out:{...f.port},in:{...match.p},outletKey:f.key,rejoin:true,required:false});reservations.push(corridor);
 }
 // Effects are edge implementations. A field requires moving load and acts
 // along a transfer; a bumper belongs to a rebound bank. Neither fills a hole.
 for(const edge of b.edges){
  const source=b.nodes.find(n=>n.id===edge.from);
  if(edge.kind==='discharge'&&source.loadIds.length>=2&&!b.pegs.some(p=>p.type==='bombMagnet')&&r()<g.kinetic*.35){
   const a=b.part('field-coupler');a.source='des2';a.nodeId=edge.from;
   for(const t of [.32,.48,.64]){const x=edge.out.x+(edge.in.x-edge.out.x)*t+g.direction*20,y=edge.out.y+(edge.in.y-edge.out.y)*t;if(!b.clear({x,y},9))continue;
    const p=b.field(a,x,y,{radius:between(r,89,118),strength:between(r,.25,.37)});p.constructionSubsystem=edge.from;edge.field=p.id;break;
   }
  }
  if(edge.kind==='ricochet'&&!b.pegs.some(p=>p.type==='bumper')&&r()<g.lateral*.45){
   const x=(edge.out.x+edge.in.x)/2,y=(edge.out.y+edge.in.y)/2,scale=between(r,1.7,2.2);if(b.clear({x,y,type:'bumper',bumperScale:scale},9)){const a=b.part('rebound-coupler');a.source='des2';a.nodeId=edge.from;const p=b.bumper(a,x,y,scale);p.constructionSubsystem=edge.from;edge.bumper=p.id;}
  }
 }
 // A bank belongs to a connection. It follows the shared graph curvature and
 // is only added when it clears the actual opening and the material budget.
 for(const edge of b.edges.filter(e=>e.kind==='discharge')){
  const dx=edge.in.x-edge.out.x,dy=edge.in.y-edge.out.y;if(dy<35||Math.abs(dx)<25)continue;
  const cp=b.checkpoint(),a=b.part('transfer-bank');a.nodeId=edge.from;a.source='des2';const side=-Math.sign(dx),offset=27;
  b.stroke(a,cubic([[edge.out.x+side*offset,edge.out.y+12],[edge.out.x+side*(offset+g.bend*10),edge.out.y+dy*.36],[edge.in.x+side*(edge.in.halfWidth+14),edge.in.y-dy*.22],[edge.in.x+side*(edge.in.halfWidth+12),edge.in.y-18]]),{width:g.brickWidth,spacing:g.brickWidth});
  if(!validateGeometry({pegs:b.pegs}).valid||b.pegs.length>budget.pegs)b.rollback(cp);else {edge.bank=a.id;for(const p of b.pegs.slice(cp.pegs))p.constructionSubsystem=edge.from;}
 }
 return {builder:b,genome,budget,reservations};
}

export function finalize({builder:b,genome:g,budget,reservations}){
 const r=randomFrom(b.seed+':des5-targets'),eligible=b.pegs.filter(p=>['blue','orange'].includes(p.type));eligible.forEach(p=>p.type='blue');
 const groupStarts=new Map(),groupCounts=new Map();for(const p of eligible){const key=p.bezierGroupId||p.constructionAssembly;groupCounts.set(key,(groupCounts.get(key)||0)+1);}for(const [key,n] of groupCounts)groupStarts.set(key,Math.floor(r()*n));
 const indices=new Map(),wanted=Math.min(budget.targets,Math.round(eligible.length*.46)),counts=new Map(),pool=eligible.map(p=>{const key=p.bezierGroupId||p.constructionAssembly,i=indices.get(key)||0;indices.set(key,i+1);return {p,t:((i-groupStarts.get(key)+groupCounts.get(key))%groupCounts.get(key))/groupCounts.get(key)+(p.constructionRole==='cargo'?.12:0)};}),nodeWeights=new Map(b.nodes.map(n=>[n.id,n.ink**(.9+g.focus*.3)]));
 while(pool.length&&[...counts.values()].reduce((s,n)=>s+n,0)<wanted){
  pool.sort((a,b)=>{const score=o=>((counts.get(o.p.constructionSubsystem)||0)+o.t*.45)/Math.max(1,nodeWeights.get(o.p.constructionSubsystem)||900);return score(a)-score(b);});
  const {p}=pool.shift();p.type='orange';counts.set(p.constructionSubsystem,(counts.get(p.constructionSubsystem)||0)+1);
 }
 const chosen=new Set(eligible.filter(p=>p.type==='orange').map(p=>p.id)),base=b.finish({});
 // Builder supplies native settings and path bookkeeping, while target mass
 // belongs to the global plan rather than each component constructor.
 // b.finish assigns its own additional targets; restore the exact global set.
 for(const p of eligible)p.type=chosen.has(p.id)?'orange':'blue';
 base.id=b.id;base.name='Оркестрация · '+b.seed;
 const nodeInk=b.nodes.reduce((s,n)=>s+n.ink,0),partSources=new Map(b.parts.map(p=>[p.id,p.source])),contributions={};let totalInk=0;
 for(const p of b.pegs){const ink=p.shape==='brick'?p.width*p.height:Math.PI*(8.5*(p.radiusScale||1))**2;totalInk+=ink;const source=partSources.get(p.constructionAssembly)||'des2';contributions[source]=(contributions[source]||0)+ink;}
 for(const source of Object.keys(contributions))contributions[source]/=totalInk;
 const degrees=b.nodes.map(n=>({id:n.id,inputs:b.edges.filter(e=>e.to===n.id).length,outputs:b.edges.filter(e=>e.from===n.id).length}));
 base.metadata={generator:{name:'destruction_orchestrated',version:'0.1.0',seed:b.seed,genome:g,budget,parts:b.parts,plan:{nodes:b.nodes,edges:b.edges,reservations,decisions:b.decisions,contributions,focusShare:b.nodes[0].ink/nodeInk,activeResponses:b.nodes.reduce((s,n)=>s+n.moving,0),topology:{degrees,branches:degrees.filter(n=>n.outputs>1).length,merges:degrees.filter(n=>n.inputs>1).length,depth:Math.max(...b.nodes.map(n=>n.depth))}}}};
 return base;
}
