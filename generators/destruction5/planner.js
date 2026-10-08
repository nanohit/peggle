import {randomFrom} from '../destruction/grammar.js';
import {SystemBuilder,source,reservoir,carrier,port} from './components.js';
import {between,choose,clamp,TAU,cubic} from '../destruction4/shapes.js';

const absFloor=(p,q)=>Math.abs(p.x-q.x)<(q.floor||44)*.65&&Math.abs(p.y-q.y)<9;

export function designGenome(seed){
 const r=randomFrom(seed+':des5-play');
 return {focus:between(r,.2,.9),kinetic:between(r,.15,.95),branching:r(),openness:between(r,.5,.95),lateral:r(),complexity:between(r,.45,.95),bend:between(r,-.7,.7),phase:r()*TAU,radialGrowth:r(),brickWidth:between(r,30,35),pegScale:1,direction:choose(r,[-1,1])};
}

// Start with a playable composition: a broad gesture, a target rhythm and
// something worthwhile to set in motion. Fit/physics are subsequent checks.
export function growSystem({seed='meta-000',genome:override,attempt=0}={}){
 seed=String(seed).slice(0,60);const g={...designGenome(seed),...override},r=randomFrom(seed+':des5-sketch:'+attempt),b=new SystemBuilder(seed,g),mode=g.kinetic>.57?'balance':g.lateral>.48?'crossflow':'confluence';
 const sketch={gesture:mode,mirror:g.direction,rhythm:choose(r,['stagger','diamond','shear','fan']),wave:between(r,8,25),pitch:between(r,43,54),phase:r()*TAU};
 const xx=x=>g.direction<0?400-x:x;
 const commit=(kind,curve,extra={})=>{
  const cp=b.checkpoint(),a=b.part(kind);a.source=kind==='landscape'?'des4':'des2';a.nodeId='g'+b.nodes.length;const start=b.pegs.length,ps=b.safeStroke(a,curve,extra);
  if(!ps.length){b.rollback(cp);return null;}
  return b.node(a,{kind:'bank',x:ps.reduce((s,p)=>s+p.x,0)/ps.length,y:ps.reduce((s,p)=>s+p.y,0)/ps.length,recipe:{law:'sweep-and-rebound',operator:kind}},start);
 };
 const edge=(from,to,input)=>{if(!from||!to||!from.loadIds.length)return;b.edges.push({id:'e'+b.edges.length,from:from.id,to:to.id,kind:'catch',out:from.outputs[0],in:input||to.inputs[0],cargoIds:from.loadIds,receiverIds:to.pegIds,releaseIds:from.pegIds.filter(id=>b.pegs.find(p=>p.id===id)?.constructionRole==='release-floor'),required:true});};
 let focal,landings=[];
 if(mode==='balance'){
  const count=g.branching>.7?3:g.branching<.2?1:2,y=between(r,294,335),span=count===1?0:count===2?between(r,156,196):between(r,220,242),centers=Array.from({length:count},(_,i)=>count===1?200+g.bend*62:200-span/2+i*span/(count-1));
  const bays=centers.map((x,i)=>({x,y:y+(count===2?(i-.5)*g.bend*93:between(r,-22,22)),w:count===1?between(r,177,263):count===2?between(r,81,132):between(r,77,88),depth:between(r,14,23)+(1-g.openness)*66,floor:count===1?between(r,76,126):count===2?between(r,36,74):between(r,30,52),bias:g.bend*(i%2?-1:1)}));
  focal=carrier(b,{id:'mechanism',bays,pivot:{x:200+between(r,-17,17),y:bays.reduce((sum,q)=>sum+q.y-q.depth,0)/bays.length-between(r,0,14)},direction:count===1?g.direction:0});if(!focal)throw Error('carrier');
  const selected=count===3?choose(r,[[0,2],[1]]):count===2?choose(r,[[0],[1],[0,1]]):[0];
  for(const [j,i] of selected.entries()){
   const q=bays[i],s=source(b,{id:'load'+j,x:q.x+between(r,-8,8),y:between(r,153,179),w:count===3?63:between(r,70,91),count:count===3?3:choose(r,[3,4])});edge(s,focal,focal.inputs[i]);
  }
  const split=count>1&&g.lateral>.65&&g.kinetic<.83,catches=split?[{x:105,w:154},{x:295,w:154}]:[{x:200+g.bend*24,w:between(r,258,318)}];
  for(const [i,q] of catches.entries()){const n=reservoir(b,{id:'landing'+i,...q,y:between(r,470,502),depth:between(r,48,75),bias:g.bend,floor:split?58:between(r,83,116)});if(n)landings.push(n);}
  for(const side of [-1,1]){const q=side<0?bays[0]:bays.at(-1),x0=side<0?30:370,x1=count===1?q.x+side*q.w*.27:q.x-side*12,y0=between(r,195,213),y1=Math.min(q.y-q.depth-26,between(r,215,238));commit('launch-wing',cubic([[x0,y0],[x0-side*19,y0-21],[x1+side*51,y1],[x1,y1]]));}
 }else{
  const ranks=mode==='crossflow'?choose(r,[2,3]):choose(r,[1,2]);
  for(let rank=0;rank<ranks;rank++){
   const y=rank===0?between(r,178,213):rank===1?between(r,291,330):between(r,410,430);
   if(mode==='crossflow'){
    const side=(rank%2?1:-1)*g.direction,x0=side<0?29:371,x1=side<0?between(r,299,352):between(r,48,101),drop=between(r,28,rank===2?66:111),sway=between(r,37,116);
    commit('landscape',cubic([[x0,y],[x0-side*sway,y-21],[x1+side*sway,y+drop+22],[x1,y+drop]]));
   }else{
    const open=between(r,58,113),bottom=y+between(r,83,116),top=between(r,22,39);
    for(const side of [-1,1])commit('converging-wing',cubic([[200+side*(200-top),y],[200+side*171,y+48],[200+side*(open/2+21),bottom-16],[200+side*open/2,bottom]]));
   }
  }
  const positions=choose(r,[[xx(100),xx(290)],[xx(126)],[xx(275)]]);
  for(const [i,x] of positions.entries()){
   const cy=between(r,421,477),w=positions.length===1?between(r,156,196):between(r,117,144),receiver=reservoir(b,{id:'landing'+i,x,y:cy,w,depth:between(r,40,59),bias:g.bend,floor:positions.length===1?66:45,kinetic:g.kinetic>.37&&i===0,direction:x<200?1:-1});
   if(!receiver)continue;landings.push(receiver);
   for(const y of [cy-90,cy-120,cy-150]){const s=source(b,{id:'load'+i,x,y,w:70,count:3});if(s){edge(s,receiver);break;}}
  }
  focal=b.nodes[0];
 }
 if(!landings.length||!b.edges.length)throw Error('no playable transfer');
 for(const n of landings){
  const center=b.pegs.filter(p=>p.constructionSubsystem===n.id&&p.shape==='brick').sort((p,q)=>Math.hypot(p.x-n.x,p.y-n.y)-Math.hypot(q.x-n.x,q.y-n.y))[0];if(center)center.constructionRole='catch-floor';
  if(focal?.kind==='carrier')b.edges.push({id:'e'+b.edges.length,from:focal.id,to:n.id,kind:'recatch',out:port(focal.x,focal.y+40,focal.w*.7),in:n.inputs[0],cargoIds:b.edges.filter(e=>e.to===focal.id).flatMap(e=>e.cargoIds),receiverIds:n.pegIds,releaseIds:b.pegs.filter(p=>p.constructionSubsystem===focal.id&&p.shape==='brick'&&focal.recipe.bays.some(q=>absFloor(p,q))).map(p=>p.id),upstream:b.edges.filter(e=>e.to===focal.id).flatMap(e=>e.releaseIds),required:false});
  const inside=b.part('landing-targets');inside.source='des3';inside.nodeId=n.id;const width=Math.min(n.w*.47,116),count=Math.max(3,Math.floor(width/25));
  for(let i=0;i<count;i++)b.addIfClear(inside,n.x+(i-(count-1)/2)*26,n.y-26,{constructionSubsystem:n.id,constructionRole:'landing-target'},4);
 }
 // One coherent target rhythm covers the board, not an automatic offset echo
 // beside every curve. Reserve only load entries and falling columns.
 const field=b.part('target-landscape',{...sketch});field.source='des2';field.nodeId='targets';const start=b.pegs.length,pitch=sketch.pitch;
 const corridors=b.edges.filter(e=>e.required).map(e=>({x:e.out.x,y0:e.out.y+16,y1:e.in.y-10,w:Math.min(34,e.out.halfWidth)}));
 const effect=b.part('shot-opportunity');effect.source='des2';effect.nodeId='targets';
 if(g.radialGrowth>.56){for(const p of [{x:xx(316),y:365},{x:xx(72),y:379},{x:200,y:396}])if(b.clear({...p,type:'bumper',bumperScale:1.9},3)){b.bumper(effect,p.x,p.y,1.9);break;}}
 else if(g.lateral>.72){for(const e of b.edges.filter(e=>e.required)){const p={x:clamp(e.out.x+g.direction*56,32,368),y:e.out.y+56};if(b.clear(p,5)){b.field(effect,p.x,p.y,{radius:87,strength:.23});break;}}}
 if(g.kinetic<.31&&b.edges.length){
  const e=b.edges.find(e=>e.required),entry={x:e.out.x,y:e.out.y+16},exit={x:e.in.x+g.direction*54,y:e.in.y-39},scale=1.5;
  if(b.clear({...entry,type:'portalBlue',portalScale:scale},1)&&b.clear({...exit,type:'portalOrange',portalScale:scale,angle:.55*g.direction},1)){
   const pa=b.peg(effect,entry.x,entry.y,{type:'portalBlue',portalScale:scale,portalOneWay:true}),pb=b.peg(effect,exit.x,exit.y,{type:'portalOrange',portalScale:scale,angle:.55*g.direction,portalOneWay:true,portalOneWayFlip:true});pa.portalTargetId=pb.id;pb.portalTargetId=pa.id;e.portals=[pa.id,pb.id];
  }
 }
 for(let row=0,y=124;y<=519;row++,y+=pitch)for(let col=0,x=27;x<=376;col++,x+=pitch){
  let px=x,py=y;const u=(x-200)/180,v=(y-320)/210;
  if(sketch.rhythm==='stagger')px+=(row%2?pitch*.45:0)+Math.sin(v*3+sketch.phase)*sketch.wave*.35;
  if(sketch.rhythm==='diamond'){px+=u*Math.cos(v*2)*sketch.wave;py+=Math.abs(u)*sketch.wave*(row%2?-1:1);}
  if(sketch.rhythm==='shear'){px+=v*g.bend*33;py+=u*sketch.wave;}
  if(sketch.rhythm==='fan'){px+=Math.sin(v*2)*u*sketch.wave;py+=Math.cos(u*2+sketch.phase)*sketch.wave;}
  if(corridors.some(c=>py>c.y0&&py<c.y1&&Math.abs(px-c.x)<c.w))continue;
  b.addIfClear(field,px,py,{constructionSubsystem:'targets',constructionRole:'ricochet-target'},11);
 }
 if(b.pegs.length>start)b.node(field,{kind:'field',x:200,y:320,w:350,h:395,recipe:{law:'board-target-rhythm',operator:sketch.rhythm}},start);

 return {builder:b,genome:g,sketch,budget:{targets:Math.round(25+g.complexity*9)},reservations:corridors,attempt};
}

export function finalize({builder:b,genome:g,sketch,budget,reservations,attempt}){
 const r=randomFrom(b.seed+':des5-target-colour'),eligible=b.pegs.filter(p=>p.type==='blue'),chosen=new Set(),wanted=Math.min(budget.targets,Math.floor(eligible.length*.47));
 for(const p of eligible)if(['release-floor','landing-target'].includes(p.constructionRole))chosen.add(p.id);
 const parts=new Map();for(const p of eligible){const key=p.bezierGroupId||p.constructionAssembly;if(!parts.has(key))parts.set(key,[]);parts.get(key).push(p);}
 const pool=[];for(const ps of parts.values()){const offset=Math.floor(r()*ps.length);for(let k=0;k<ps.length;k++){const p=ps[(k+offset)%ps.length];pool.push({p,t:p.constructionRole==='ricochet-target'?r():k/ps.length+r()*.15});}}
 pool.sort((a,c)=>a.t-c.t);for(const {p} of pool)if(chosen.size<wanted)chosen.add(p.id);
 const base=b.finish({});for(const p of eligible)p.type=chosen.has(p.id)?'orange':'blue';base.id=b.id;base.name='Сцена · '+b.seed;
 for(const n of b.nodes){n.pegIds=b.pegs.filter(p=>p.constructionSubsystem===n.id).map(p=>p.id);n.ink=b.pegs.filter(p=>n.pegIds.includes(p.id)).reduce((s,p)=>s+(p.shape==='brick'?p.width*p.height:Math.PI*8.5**2),0);}
 for(const e of b.edges)e.receiverIds=b.nodes.find(n=>n.id===e.to).pegIds.filter(id=>b.pegs.find(p=>p.id===id)?.constructionRole!=='counterweight');
 const contributions={},sources=new Map(b.parts.map(p=>[p.id,p.source])),total=b.pegs.reduce((s,p)=>s+(p.shape==='brick'?p.width*p.height:Math.PI*8.5**2),0);
 for(const p of b.pegs){const source=sources.get(p.constructionAssembly)||'des2',ink=p.shape==='brick'?p.width*p.height:Math.PI*8.5**2;contributions[source]=(contributions[source]||0)+ink/total;}
 const degrees=b.nodes.map(n=>({id:n.id,inputs:b.edges.filter(e=>e.to===n.id).length,outputs:b.edges.filter(e=>e.from===n.id).length}));
 base.metadata={generator:{name:'destruction_play_composition',version:'0.2.0',seed:b.seed,genome:g,budget,parts:b.parts,plan:{sketch,attempt,nodes:b.nodes,edges:b.edges,reservations,decisions:b.decisions,contributions,focusShare:Math.max(...b.nodes.map(n=>n.ink))/total,activeResponses:b.nodes.reduce((s,n)=>s+n.moving,0),topology:{degrees,branches:degrees.filter(n=>n.outputs>1).length,merges:degrees.filter(n=>n.inputs>1).length,depth:b.edges.length}}}};
 return base;
}
