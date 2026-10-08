import {Builder} from '../destruction4/grammar.js';
import {cubic,between} from '../destruction4/shapes.js';
import {validateGeometry,sized} from '../destruction4/geometry.js';
import {bounds} from '../destruction2/ribbon-geometry.js';

export const loose={destructionStatic:false,destructionPhysicsOnHit:false};
export const latent={destructionStatic:false,destructionPhysicsOnHit:true,destructionPhysicsOnHitBallOnly:true};
export const CATALOG={source:{source:'des3'},reservoir:{source:'des3'},carrier:{source:'des3'},bank:{source:'des2'},field:{source:'des2'},landscape:{source:'des4'}};

export class SystemBuilder extends Builder {
 constructor(seed,genome){super(seed,'morphogenesis');this.id='des5-'+seed.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,48);this.genome=genome;this.nodes=[];this.edges=[];this.decisions=[];}
 checkpoint(){return {pegs:this.pegs.length,groups:this.groups.length,parts:this.parts.length,curves:new Set(Object.keys(this.curves)),serial:this.serial};}
 rollback(s){this.pegs.length=s.pegs;this.groups.length=s.groups;this.parts.length=s.parts;this.serial=s.serial;for(const k of Object.keys(this.curves))if(!s.curves.has(k))delete this.curves[k];}
 safeStroke(a,curve,extra={}){
  const cp=this.checkpoint(),ids=a.ids.length,ps=this.stroke(a,curve,{width:this.genome.brickWidth,spacing:this.genome.brickWidth,extra});
  if(!validateGeometry({pegs:this.pegs}).valid){this.rollback(cp);a.ids.length=ids;return [];}
  return ps;
 }
 node(a,spec,start,ports={}){
  const ps=this.pegs.slice(start);for(const p of ps)p.constructionSubsystem=a.nodeId;
  const n={...spec,id:a.nodeId,source:a.source,partIds:this.parts.filter(p=>p.nodeId===a.nodeId).map(p=>p.id),pegIds:ps.map(p=>p.id),loadIds:ps.filter(p=>p.constructionRole==='cargo').map(p=>p.id),inputs:ports.inputs||[],outputs:ports.outputs||[],box:bounds(ps.map(sized)),ink:ps.reduce((s,p)=>s+(p.shape==='brick'?p.width*p.height:Math.PI*8.5**2),0),moving:spec.moving||0,recipe:spec.recipe||{},depth:spec.depth||0};
  this.nodes.push(n);return n;
 }
}

// A mouth, a flat landing and two independently grown shoulders. Dimensions
// are computed attachments, never stored drawings. The landing keeps a load
// involved after its release, rather than bouncing it straight off the board.
export function vessel({x,y,w,depth,bias=0,flare=.82,floor=44}){
 const left={x:x-w/2,y:y-depth},right={x:x+w/2,y:y-depth*(1+bias*.22)},lx=x-floor/2,rx=x+floor/2;
 return {segments:[cubic([[left.x,left.y],[left.x+w*(1-flare)*.3,y-5],[lx-w*.18,y],[lx,y]]),cubic([[lx,y],[lx+floor/3,y],[rx-floor/3,y],[rx,y]]),cubic([[rx,y],[rx+w*.18,y],[right.x-w*(1-flare)*.3,y-5],[right.x,right.y]])],left,right,floor};
}
export const port=(x,y,w)=>({x,y,halfWidth:w/2,accepts:['ball','cargo']});

export function reservoir(b,{id,x,y,w,depth,kinetic=false,direction=1,bias=0,floor=48,role='catch'}){
 const start=b.pegs.length,a=b.part(kinetic?'tipping-vessel':'landing-vessel',{x,y,w,depth,bias,floor});a.nodeId=id;a.source='des3';
 const curve=vessel({x,y,w,depth,bias,floor}),members=b.safeStroke(a,curve,{constructionRole:'receiver-wall'});
 if(!members.length){b.parts.pop();return null;}
 if(kinetic)attachHinge(b,a,members,direction<0?curve.right:curve.left,{direction,angle:.67});
 return b.node(a,{kind:'reservoir',x,y,w,h:depth,role,moving:+kinetic,recipe:{law:'retain-then-tip',operator:'vessel-shoulders',depth,bias,floor}},start,{inputs:[port(x,y-depth-12,w-25)],outputs:[port(x,y+20,floor)]});
}

function attachHinge(b,a,members,pivot,{direction=0,angle=.45}={}){
 const group=a.id+':body';for(const p of members)Object.assign(p,latent,{groupId:group});
 const pin=members.reduce((best,p)=>Math.hypot(p.x-pivot.x,p.y-pivot.y)<Math.hypot(best.x-pivot.x,best.y-pivot.y)?p:best);
 // Native hinge limits refer to this peg's angle, not to the compound body's
 // rest pose. A curved brick is rendered/collided from world-space slices;
 // give its centre-mounted joint a neutral frame without changing that ribbon.
 // Otherwise a near-vertical lip can snap the whole vessel at initialization.
 if(pin.curveSlices?.length>=2)pin.angle=0;
 pin.destructionHinge={pivotFraction:.5,minAngle:direction>0?-.08:-angle,maxAngle:direction<0?.08:angle,damping:.998,stopBounce:.03};pin.constructionRole='bearing-arm';
 b.groups.push({id:group,name:'Составной балансир',pattern:'construction',destructionBody:true});
 b.addIfClear(a,pin.x,pin.y+23,{radiusScale:.9,constructionRole:'bearing'},1);
 return pin;
}

// Grow a single native body from receiving lobes and connecting arms. Number,
// height, width and attachment order change the actual mechanism: spoon,
// unequal balance, three-bay distributor, etc. No per-frame scripted motion.
export function carrier(b,{id,bays,pivot,depth=0,direction=0}){
 const start=b.pegs.length,a=b.part('compound-carrier',{bays,pivot});a.nodeId=id;a.source='des3';const segments=[];
 for(let i=0;i<bays.length;i++){
  const v=vessel(bays[i]);
  if(i){const prev=vessel(bays[i-1]),dy=pivot.y-(prev.right.y+v.left.y)/2;segments.push(cubic([[prev.right.x,prev.right.y],[prev.right.x+16,prev.right.y+dy],[v.left.x-16,v.left.y+dy],[v.left.x,v.left.y]]));}
  segments.push(...v.segments);
 }
 const members=b.safeStroke(a,{segments},{constructionRole:'carrier-wall'});if(!members.length){b.parts.pop();return null;}
 const pin=attachHinge(b,a,members,pivot,{direction,angle:between(b.r,.94,1.20)});
 const weights=[];
 if(b.genome.focus>.5&&bays.length>1){
  // A counterweight is ordinary attached material. Hitting it changes the
  // native body's centre of mass, so another shot can reverse the balance.
  const candidates=members.filter(p=>Math.abs(p.x-pin.x)>29&&Math.abs(p.x-pin.x)<85).sort((p,q)=>Math.abs(p.x-(pin.x-b.genome.direction*50))-Math.abs(q.x-(pin.x-b.genome.direction*50)));
  for(const p of candidates){
   const extra={...latent,groupId:pin.groupId,constructionRole:'counterweight'},count=b.genome.focus>.76?3:2;
   for(let i=0;i<count;i++){const y=p.y+14+i*17.1;if(b.clear({x:p.x,y},.2)){const q=b.peg(a,p.x,y,extra);weights.push(q.id);}else break;}
   if(weights.length)break;
  }
 }
 return b.node(a,{kind:'carrier',x:pivot.x,y:pivot.y,w:bays.at(-1).x+bays.at(-1).w/2-bays[0].x+bays[0].w/2,h:Math.max(...bays.map(q=>q.depth)),moving:1,depth,recipe:{law:'compound-balance',operator:'attach-vessels-to-arms',bays,pin:pin.id,weights}},start,{inputs:bays.map(q=>port(q.x,q.y-q.depth-12,q.w-24)),outputs:bays.map(q=>port(q.x,q.y+18,q.floor||44))});
}

export function source(b,{id,x,y,w=74,count=3,depth=0}){
 const start=b.pegs.length,a=b.part('release-floor',{x,y,w,count});a.nodeId=id;a.source='des3';
 const floor=b.brick(a,x,y,w,10.2,0,{constructionRole:'release-floor'});
 if(!validateGeometry({pegs:b.pegs}).valid){b.pegs.pop();b.parts.pop();return null;}
 const load=b.part('supported-load',{owner:id});load.nodeId=id;load.source='des3';
 for(let i=0;i<count;i++)b.addIfClear(load,x+(i-(count-1)/2)*19,y-14,{...loose,constructionRole:'cargo'},0);
 return b.node(a,{kind:'source',x,y,w,h:28,depth,recipe:{law:'release-supported-load',floorId:floor.id}},start,{inputs:[port(x,y-32,w)],outputs:[port(x,y+16,w)]});
}
