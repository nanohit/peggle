import {Builder} from '../destruction4/grammar.js';
import {randomFrom} from '../destruction/grammar.js';
import {createSeesaw} from '../../js/destruction-hinge.js';
import {bounds,reach} from '../destruction2/ribbon-geometry.js';
import {sized} from '../destruction4/geometry.js';
import {TAU,between,choose,cubic,arc,spline,polarContour,transform} from '../destruction4/shapes.js';
import {receiverBoundary,flowBoundary,envelopeBoundary} from './morphology.js';

const fixed={destructionStatic:true,destructionPhysicsOnHit:false};
const latent={destructionStatic:false,destructionPhysicsOnHit:true,destructionPhysicsOnHitBallOnly:true};
const loose={destructionStatic:false,destructionPhysicsOnHit:false};

export class SystemBuilder extends Builder {
 constructor(seed,genome){super(seed,'morphogenesis');this.id='des5-'+seed.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,48);this.genome=genome;this.nodes=[];this.edges=[];this.decisions=[];}
 checkpoint(){return {pegs:this.pegs.length,groups:this.groups.length,parts:this.parts.length,curves:new Set(Object.keys(this.curves)),serial:this.serial};}
 rollback(s){this.pegs.length=s.pegs;this.groups.length=s.groups;this.parts.length=s.parts;this.serial=s.serial;for(const k of Object.keys(this.curves))if(!s.curves.has(k))delete this.curves[k];}
}

// These are role implementations, not board-sized scenes. Every constructor
// receives its envelope/direction from the same graph and returns real ports.
export const CATALOG={
 contour:{source:'des4',role:'enclosure',cost:1},
 channel:{source:'des2',role:'routing',cost:0},
 cup:{source:'des3',role:'receiving',cost:0},
 sling:{source:'des3',role:'receiving',cost:1},
 seesaw:{source:'des3',role:'redistribution',cost:1},
 bridge:{source:'des3',role:'redistribution',cost:2},
 shelf:{source:'des3',role:'release',cost:0},
 support:{source:'des4',role:'storage',cost:1},
 fan:{source:'des2',role:'rebound',cost:0}
};

export function compileNode(b,spec){
 const {id,kind,x,y,w,h,direction:d=1}=spec,r=randomFrom(b.seed+':'+id+':'+spec.variant),g=b.genome;
 const a=b.part(kind,{x,y,w,h,direction:d}),start=b.pegs.length,groupStart=b.groups.length;
 a.nodeId=id;a.source=CATALOG[kind].source;
 const payload=b.part('load',{owner:id});payload.nodeId=id;payload.source=a.source;
 const port=(px,py,width,vx=0,vy=1)=>({x:px,y:py,halfWidth:width/2,vx,vy,accepts:['ball','cargo']});
 let inputs=[port(x,y-h/2,w*.6)],outputs=[port(x,y+h/2,w*.55)],recipe={},moving=0;
 function load(points){for(const p of points)b.addIfClear(payload,p.x,p.y,{...loose,constructionRole:'cargo'},0);}
 function hinged(cx,cy,width,side=0){
  const native=createSeesaw({id:a.id+':hinge'+b.groups.length,x:cx,y:cy,width,pivotFraction:side<0?.27:side>0?.73:.5,minAngle:-.56,maxAngle:.56});
  b.groups.push(...native.groups);
  for(const p of native.pegs)b.peg(a,p.x,p.y,{...p,id:b.id+':p'+(++b.serial),type:'blue',...(p.constructionPart==='bearing'?fixed:latent),constructionRole:p.constructionPart==='bearing'?'bearing':'lever'});
  const count=width>110?5:3;load(Array.from({length:count},(_,i)=>({x:cx+(i-(count-1)/2)*19,y:cy-14})));
  moving++;
 }
 if(kind==='seesaw'){
  hinged(x,y,w);inputs=[port(x,y-31,w*.82)];outputs=[port(x-w*.35,y+w*.27,w*.3,-1.2,1),port(x+w*.35,y+w*.27,w*.3,1.2,1)];recipe={law:'native-hinged-distribution',width:w};
 }
 if(kind==='bridge'){
  const gap=between(r,27,36),leaf=Math.max(55,(w-gap)/2),off=(leaf+gap)/2;
  for(const side of [-1,1])hinged(x+side*off,y,leaf,side);
  b.brick(a,x,y+18,gap+10,10.2,0,{...fixed,constructionRole:'release-lock'});
  inputs=[port(x,y-31,w*.82)];outputs=[port(x-off,y+leaf*.31,leaf*.7,-.7,1),port(x+off,y+leaf*.31,leaf*.7,.7,1)];recipe={law:'opposed-hinged-spans',gap,leaf};
 }
 if(kind==='shelf'){
  b.brick(a,x,y,w,10.2,0,{constructionRole:'release-floor'});
  load(Array.from({length:Math.min(6,Math.floor(w/21))},(_,i)=>({x:x+(i-(Math.min(6,Math.floor(w/21))-1)/2)*19,y:y-14})));
  inputs=[port(x,y-31,w*.85)];outputs=[port(x,y+20,w*.8)];recipe={law:'supported-load',width:w};
 }
 if(kind==='support'){
  const ranks=h>112?2:1,columns=w>166?3:2,span=w/(columns-1),bottom=y+h*.33,step=Math.min(67,h*.59),postWidth=between(r,11,14),jitter=between(r,-.02,.02)*span;
  const positions=Array.from({length:columns},(_,i)=>x-w/2+i*span);
  const joints=[],links=[];
  for(let rank=0;rank<ranks;rank++){
   const yy=bottom-rank*step,shift=rank*jitter;
   for(const px of positions){const cx=px+shift;b.brick(a,cx,rank?yy+step/2:yy+18,postWidth,rank?step-12:24,0,{...(rank?latent:fixed),constructionRole:'support'});joints.push({x:cx,y:yy,rank});}
   for(let col=1;col<columns;col++){
    const cx=(positions[col-1]+positions[col])/2+shift,width=span-1;
    b.brick(a,cx,yy,width,12,0,{...loose,constructionRole:'floor'});links.push({rank,from:col-1,to:col,width});
    const n=Math.min(4,Math.floor(width/20));load(Array.from({length:n},(_,i)=>({x:cx+(i-(n-1)/2)*20,y:yy-15})));
   }
  }
  moving=1;inputs=[port(x,bottom-(ranks-1)*step-33,w*.87)];outputs=[port(x-d*w*.28,bottom+41,w*.44,-d*.8,1),port(x+d*w*.28,bottom+41,w*.44,d*.8,1)];
  recipe={law:'support-network',ranks,columns,joints,links,step,jitter};
 }
 if(kind==='cup'||kind==='sling'){
  const radius=w/2,shape=receiverBoundary(spec,g,r),{curve,lip,bottom}=shape,depth=shape.program.depth,bias=bottom.x-x;
  const walls=b.stroke(a,curve,{width:g.brickWidth,spacing:g.brickWidth});
  if(kind==='sling'){
   const group=a.id+':body',hingeX=x-d*(radius+5),hingeY=lip+4;walls.forEach(p=>Object.assign(p,latent,{groupId:group}));
   b.brick(a,hingeX,hingeY,22,10.2,0,{...latent,groupId:group,destructionHinge:{pivotFraction:.5,minAngle:d>0?0:-.82,maxAngle:d>0?.82:0,damping:.997},constructionRole:'pour-handle'});
   b.groups.push({id:group,name:'Подвижный приёмник',pattern:'construction',destructionBody:true});moving++;
  }
  load([-1,0,1].map(k=>({x:bottom.x+k*20,y:bottom.y-17})));
  inputs=[port(x,lip-14,w*.77)];outputs=[port(kind==='sling'?x+d*w*.38:bottom.x,bottom.y+17,w*.52,kind==='sling'?d*.8:0,1)];recipe={law:'mouth-depth-discharge',...shape.program};
 }
 if(kind==='contour'){
  const spiral=g.radialGrowth>.62,closed=!spiral&&g.openness<.68&&spec.role==='focus',rx=w*.45,ry=h*.44,opening=between(r,.75,1.5)*g.openness;
  let curve,profile;
  if(spiral){
   const span=between(r,Math.PI*1.85,Math.PI*2.7),phase=-Math.PI*.5+g.bend*.8;
   const points=Array.from({length:25},(_,i)=>{const t=i/24,a=phase+span*t,rad=.30+.7*t;return {x:x+Math.cos(a)*rx*rad,y:y+Math.sin(a)*ry*rad};});curve=spline(points);profile='radial-growth';recipe.program={operator:'radial-field',span,phase,startRadius:.30,anchors:points};
  }else{
   const field=envelopeBoundary(spec,g,r,{closed});curve=field.curve;recipe.program=field.program;profile=closed?'rotating-containment':'harmonic-aperture';
  }
  const members=b.stroke(a,curve,{width:g.brickWidth,spacing:g.brickWidth});
  if(closed&&spec.response){const arms=choose(r,[2,3,4]);for(let i=0;i<arms;i++){const theta=i*TAU/arms+g.phase;b.stroke(a,cubic([[x+Math.cos(theta)*rx*.46,y+Math.sin(theta)*ry*.46],[x+Math.cos(theta+.2)*rx*.5,y+Math.sin(theta+.2)*ry*.5],[x+Math.cos(theta+.25)*rx*.6,y+Math.sin(theta+.25)*ry*.6],[x+Math.cos(theta+.3)*rx*.65,y+Math.sin(theta+.3)*ry*.65]]),{width:27,spacing:27});}members.push(...b.pegs.slice(start).filter(p=>!members.includes(p)&&p.constructionAssembly===a.id));}
  if(spec.response){b.animate(a,members,{x,y},{rotation:closed?d*TAU:d*between(r,.14,.30),duration:closed?between(r,9,13):between(r,1.8,3),hitTrigger:!closed,hitMode:'single',cycle:closed,easing:closed?'linear':'easeInOut'});moving++;}
  load([-1,0,1].map(k=>({x:x+k*22,y:y+ry*.22})));
  inputs=[{...port(x,y-ry-16,w*.42),accepts:closed?['ball']:['ball','cargo']}];outputs=[port(x+g.bend*w*.15,y+ry+16,w*.57,d*g.lateral*1.6,1)];recipe={...recipe,law:profile,rx,ry,opening:closed?0:opening,phase:g.phase};
 }
 if(kind==='channel'){
  const flow=flowBoundary(spec,g,r),path=flow.curve,p0=flow.anchors[0],p1=flow.anchors.at(-1);
  b.stroke(a,path,{width:g.brickWidth,spacing:g.brickWidth});
  const echo=b.part('flow-echo');echo.nodeId=id;echo.source=a.source;
  const heading=Math.atan2(p1.y-p0.y,p1.x-p0.x),offset=choose(r,[-1,1])*34,parallel=transform(path,{x:-Math.sin(heading)*offset,y:Math.cos(heading)*offset});
  const marks=b.dots(echo,parallel,{spacing:29,scale:g.pegScale});
  // An offset curve can fold inward at a tight bend. Keep only geometrically
  // clear targets; the primary path remains a complete native ribbon.
  for(const p of marks){const others=b.pegs.filter(q=>q.id!==p.id);if(others.some(q=>q.shape==='brick'&&Math.hypot(q.x-p.x,q.y-p.y)<17)){b.pegs=b.pegs.filter(q=>q!==p);echo.ids=echo.ids.filter(id=>id!==p.id);}}
  inputs=[port(p0.x,p0.y-16,w*.28)];outputs=[port(p1.x,p1.y+16,w*.27,d*.8,1)];recipe={law:'shared-spline-flow',...flow.program};
 }
 if(kind==='fan'){
  const rad=w*.45,tilt=g.bend*.45+d*.15;b.dots(a,transform(arc(0,-h*.16,rad,h*.40,.18,Math.PI-.18),{x,y,angle:tilt}),{spacing:27,scale:g.pegScale});
  inputs=[port(x,y-h*.44,w*.65)];outputs=[port(x+d*w*.3,y+h*.38,w*.38,d,1)];recipe={law:'open-rebound-bank'};
 }
 const ps=b.pegs.slice(start);for(const p of ps)p.constructionSubsystem=id;
 const box=bounds(ps.map(sized)),ink=ps.reduce((s,p)=>s+(p.shape==='brick'?p.width*p.height:Math.PI*(8.5*(p.radiusScale||p.bumperScale||1))**2),0);
 // Reserve rotation and hinge excursions, not merely their resting picture.
 let envelope={...box};if(['seesaw','bridge'].includes(kind))envelope={minX:Math.min(box.minX,x-w/2-14),maxX:Math.max(box.maxX,x+w/2+14),minY:Math.min(box.minY,y-w*.30-18),maxY:Math.max(box.maxY,y+w*.30+30)};
 if(kind==='sling'){const pivot={x:x-d*(w/2+5),y:y-h*.32+4},rr=Math.max(...ps.filter(p=>p.shape==='brick').map(p=>reach(sized(p),[pivot.x,pivot.y])));envelope={minX:Math.min(box.minX,pivot.x-rr*.25),maxX:Math.max(box.maxX,pivot.x+rr*.25),minY:Math.min(box.minY,y-h*.6),maxY:Math.max(box.maxY,y+h*.6)};}
 if(kind==='contour'&&moving){
  const animation=b.groups.at(-1).animation,poses=[];
  for(let step=0;step<=8;step++){const angle=animation.rotation*step/8,co=Math.cos(angle),si=Math.sin(angle),point=q=>({x:x+(q.x-x)*co-(q.y-y)*si,y:y+(q.x-x)*si+(q.y-y)*co});
   for(const p of ps){if(p.constructionRole==='cargo'){poses.push(sized(p));continue;}const q={...p,...point(p),angle:p.angle+angle};if(p.curveSlices)q.curveSlices=p.curveSlices.map(v=>({...v,...point(v),nx:v.nx*co-v.ny*si,ny:v.nx*si+v.ny*co}));poses.push(sized(q));}
  }envelope=bounds(poses);
 }
 const pockets=kind==='contour'&&recipe.law!=='radial-growth'?[{x,y:y+h*.13,w:w*.45,h:h*.31,accepts:['bearing'],contained:true}]:[];
 return {...spec,source:a.source,partIds:b.parts.filter(p=>p.nodeId===id).map(p=>p.id),pegIds:ps.map(p=>p.id),groupIds:b.groups.slice(groupStart).map(p=>p.id),inputs,outputs,pockets,box,envelope,ink,recipe,moving,loadIds:ps.filter(p=>p.constructionRole==='cargo').map(p=>p.id)};
}
