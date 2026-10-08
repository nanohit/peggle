import {randomFrom} from '../destruction/grammar.js';
import {objectBounds,overlapDepth} from '../destruction2/ribbon-geometry.js';
import {TAU,between,choose,clamp,cubic,transform,arc,spline,polarContour,fishProfile,growBranches,samples,trimCubic} from './shapes.js';

export const DOMAINS=['roulette','shoal','architecture','canopy','petals','switchback','slalom','orbits','mobile','fault','flux','spiral','morphogenesis'];
const names={roulette:'Рулетка',shoal:'Течение',architecture:'Несущая система',canopy:'Крона',petals:'Лепестки',switchback:'Переброс',slalom:'Прибой',orbits:'Орбиты',mobile:'Мобиль',fault:'Разлом',flux:'Магнитный рельеф',spiral:'Завиток',morphogenesis:'Сростки'};
const fixed={destructionStatic:true,destructionPhysicsOnHit:false};
const loose={destructionStatic:false,destructionPhysicsOnHit:false};
const latent={destructionStatic:false,destructionPhysicsOnHit:true,destructionPhysicsOnHitBallOnly:true};

export class Builder{
 constructor(seed,domain){this.seed=seed;this.domain=domain;this.r=randomFrom(seed+':des4-geometry');this.id='des4-'+domain+'-'+seed.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,42);this.pegs=[];this.groups=[];this.curves={};this.parts=[];this.relations=[];this.serial=0;}
 part(kind,parameters={}){const a={id:this.id+':a'+this.parts.length,kind,parameters,ids:[]};this.parts.push(a);return a;}
 peg(a,x,y,extra={}){const p={id:this.id+':p'+(++this.serial),x,y,type:'blue',shape:'circle',angle:0,radiusScale:1,...fixed,...extra,constructionAssembly:a.id,constructionRole:extra.constructionRole||a.kind};this.pegs.push(p);a.ids.push(p.id);return p;}
 brick(a,x,y,width,height=10.2,angle=0,extra={}){return this.peg(a,x,y,{shape:'brick',width,height,angle,brickBaseRadius:8.5,...extra});}
 sized(p,gap=0){return {...p,radius:8.5*(p.type==='bumper'?p.bumperScale||1:p.radiusScale||1)+gap,...(p.type.startsWith('portal')?{shape:'brick',width:34*(p.portalScale||1),height:10.2}:{}),...(p.shape==='brick'?{width:p.width+2*gap,height:p.height+2*gap}:{})};}
 clear(p,gap=2,ignore=[]){const q=this.sized({type:'blue',shape:'circle',angle:0,radiusScale:1,...p},gap),b=objectBounds(q);return b.minX>=12&&b.maxX<=388&&b.minY>=106&&b.maxY<=536&&this.pegs.every(o=>ignore.includes(o.id)||overlapDepth(q,this.sized(o))<.1);}
 addIfClear(a,x,y,extra={},gap=4){const q={x,y,...extra};return this.clear(q,gap)?this.peg(a,x,y,extra):null;}
 stroke(a,curve,{circle=false,spacing=circle?25:32,width=32,height=10.2,closed=false,extra={}}={}){
  const segments=curve.segments||[curve],first=segments[0].start,last=segments.at(-1).end,isClosed=closed||Math.hypot(first.x-last.x,first.y-last.y)<.001;
  const id=a.id+':c'+Object.keys(this.curves).length,marks=samples(curve,{shape:circle?'circle':'brick',spacingPx:spacing,brickWidth:width,closedLoop:isClosed,sliceCount:9}).filter(m=>!circle||!m.shortenedTail);
  if(!circle)this.curves[id]={...curve,pegShape:'brick',pegType:'blue',spacingPx:spacing,brickWidth:width,brickHeight:height,pegRadius:8.5,bakeVersion:1,refPoints:marks.map((p,index)=>({index,x:p.x,y:p.y}))};
  return marks.map((m,i)=>this.peg(a,m.x,m.y,{...(!circle?{shape:'brick',width,height,angle:m.angle,brickBaseRadius:8.5,bezierGroupId:id,bezierIndex:i,curveSlices:m.slices}:{}),...extra}));
 }
 animate(a,members,pivot,animation){
  if(!members.length)return;const mean=k=>members.reduce((s,p)=>s+p[k],0)/members.length,id=a.id+':anim'+this.groups.length;
  members.forEach(p=>p.groupId=id);this.groups.push({id,name:a.kind,pattern:'custom',animation:{dx:0,dy:0,rotation:0,duration:5,cycle:false,wrap:false,hitTrigger:false,easing:'easeInOut',pivot:{dx:pivot.x-mean('x'),dy:pivot.y-mean('y')},...animation}});
 }
 dots(a,curve,{spacing=29,scale=1,extra={}}={}){return this.stroke(a,curve,{circle:true,spacing,extra:{radiusScale:scale,...extra}});}
 cargo(a,points,{scale=1}={}){return points.map(p=>this.peg(a,p.x,p.y,{...loose,radiusScale:scale,constructionRole:'cargo'}));}
 field(a,x,y,{radius=94,strength=.25,mode='attract',...extra}={}){return this.peg(a,x,y,{type:'bombMagnet',magnetRadius:radius,magnetStrength:strength,magnetMode:mode,magnetHittable:true,magnetKnockout:true,magnetBlast:false,constructionRole:'cargo-field',...extra});}
 bumper(a,x,y,scale=2){return this.peg(a,x,y,{type:'bumper',bumperScale:scale,bumperBounce:1.5,bumperOrange:false});}
 finish(plan){
  // Targets follow contour runs, structural weaknesses and movable loads.
  // Choose runs within parts, rather than filling every layer with the same
  // alternating sprinkle. The orange budget varies with the composition.
  const r=this.r,available=this.pegs.filter(p=>p.type==='blue'),wanted=Math.round(clamp(available.length*between(r,.34,.45),16,30)),rank=available.map(p=>({p,t:r()}));
  let left=wanted;for(const a of this.parts){const members=rank.filter(q=>a.ids.includes(q.p.id));if(!members.length)continue;const n=Math.max(1,Math.round(wanted*members.length/available.length));
   const start=Math.floor(r()*Math.max(1,members.length-n)),stride=choose(r,[1,1,2]);for(let k=0;k<n&&left;k++){const p=members[(start+k*stride)%members.length].p;if(p.type==='blue'){p.type='orange';left--;}}
  }
  rank.sort((a,b)=>a.t-b.t);for(const {p} of rank)if(left&&p.type==='blue'){p.type='orange';left--;}
  return {version:1,id:this.id,name:names[this.domain]+' · '+this.seed,pegRadius:8.5,ballCount:12,bucketEnabled:true,hitPegTimedClearEnabled:true,hitPegClearDelayMs:1100,pegs:this.pegs,groups:this.groups,bezierCurves:this.curves,flippers:null,
   destruction:{enabled:true,gravityX:0,gravityY:.115,damping:.994,restitution:.34,friction:.72,surfaceGrip:.18,dynamicPegBallBounce:.45,maxSpeed:14,sleepSpeed:.055,sleepFrames:18,stuckPileClearDelayMs:220},
   metadata:{generator:{name:'destruction_fields',version:'0.1.0',seed:this.seed,domain:this.domain,plan,parts:this.parts,relations:this.relations}}};
 }
}

function roulette(b){
 const r=b.r,cx=between(r,168,232),cy=between(r,297,355),profile=choose(r,['circle','ellipse','lobed']),amp=profile==='lobed'?between(r,.08,.15):0,rad=Math.min(between(r,113,149),(Math.min(cx-17,383-cx,cy-112,534-cy)-5)/(1+amp)),teeth=choose(r,[2,3,4,5]),a=b.part('rotating-vessel',{cx,cy,rad,teeth,profile});
 const boundary=profile==='lobed'?transform(polarContour({rx:rad,ry:rad,lobes:choose(r,[3,4]),amplitude:amp,phase:r()*TAU}),{x:cx,y:cy}):arc(cx,cy,rad,profile==='ellipse'?rad*.75:rad);
 const ring=b.stroke(a,boundary,{closed:true,width:between(r,28,36),spacing:32});
 const arms=[];for(let i=0;i<teeth;i++){const t=i*TAU/teeth+between(r,0,.15),ra=rad*.42,rb=rad*(profile==='ellipse'?.64:.74);arms.push(...b.stroke(a,cubic([[cx+ra*Math.cos(t),cy+ra*Math.sin(t)],[cx+ra*Math.cos(t+.16),cy+ra*Math.sin(t+.16)],[cx+rb*Math.cos(t+.2),cy+rb*Math.sin(t+.2)],[cx+rb*Math.cos(t+.22),cy+rb*Math.sin(t+.22)]]),{width:27,spacing:27}));}
 b.animate(a,[...ring,...arms],{x:cx,y:cy},{rotation:choose(r,[-1,1])*TAU,duration:between(r,8,13),cycle:true,easing:'linear'});
 const load=b.part('loose-core');b.cargo(load,Array.from({length:choose(r,[4,6,8])},(_,i)=>({x:cx+(i%3-1)*25,y:cy-30+Math.floor(i/3)*25})),{scale:between(r,1,1.2)});
 const satellites=b.part('satellite-ricochet');for(const side of [-1,1]){const x=cx+side*(rad+16),y=cy-rad-37;if(x>25&&x<375)b.addIfClear(satellites,x,y,{radiusScale:1.5});}
 for(let i=0;i<5;i++){const t=-Math.PI*.9+i*Math.PI*.2;b.addIfClear(satellites,cx+Math.cos(t)*(rad+31),cy+Math.sin(t)*(rad+31),{radiusScale:between(r,.95,1.2)});}
 if(r()<.5){const f=b.part('off-axis-field');const x=cx+choose(r,[-1,1])*rad*.2,y=cy+rad*.2;if(b.clear({x,y},8))b.field(f,x,y,{radius:rad*.58,strength:.22});}
 return {law:'rotating-container',cx,cy,rad,teeth,profile};
}

function shoal(b){
 const r=b.r,count=choose(r,[1,2,3]),heading=between(r,-.24,.24),firstLeft=r()<.5,fish=[];
 for(let i=0;i<count;i++){
  const length=count===1?between(r,250,280):count===2?between(r,165,205):between(r,142,175),depth=count===1?between(r,69,91):between(r,38,51),cx=count===1?between(r,185,215):count===2?200+(i?1:-1)*between(r,18,27):i%2===0?151:249,cy=count===1?between(r,287,339):count===2?215+i*212:173+i*141,angle=(firstLeft!==!!(i%2)?Math.PI:0)+heading;
  const a=b.part('fish',{cx,cy,length,depth,angle}),curve=transform(fishProfile({length,depth,bend:between(r,-8,8)}),{x:cx,y:cy,angle});
  const body=b.stroke(a,curve,{closed:true,width:31,spacing:31}),p=(x,y)=>({x:cx+Math.cos(angle)*x-Math.sin(angle)*y,y:cy+Math.sin(angle)*x+Math.cos(angle)*y});
  const eye=p(length*.29,-6);b.addIfClear(a,eye.x,eye.y,{radiusScale:1.4},1);
  const core=b.part('swimming-load');b.cargo(core,[-1,0,1].map(k=>p(k*24,count===1?depth*.24:0)),{scale:1});
  b.animate(a,body,{x:cx,y:cy},{dx:Math.cos(angle)*between(r,9,19),dy:between(r,-11,11),rotation:between(r,-.09,.09),duration:between(r,2,5),hitTrigger:i===0||r()<.5,hitMode:'single'});
  if(count===1){const gill=b.part('gills');for(let k=0;k<3;k++)b.stroke(gill,transform(arc(-length*.12+k*24,-depth*.18,14,depth*.19,-1.05,1.05),{x:cx,y:cy,angle}),{width:26,spacing:26});}
  fish.push(a.parameters);
 }
 const bubbles=b.part('wake');for(let i=0;i<14;i++){const x=i%2?between(r,22,53):between(r,346,377),y=between(r,140,516);b.addIfClear(bubbles,x,y,{radiusScale:between(r,1,1.6)},9);}
 return {law:'synthesized-fish-profiles',fish};
}

function architecture(b){
 const r=b.r,cx=between(r,175,225),w=Math.min(between(r,219,299),2*Math.min(cx-29,371-cx)),floors=choose(r,[2,3,4,4]),bottom=between(r,483,505),step=between(r,74,88),cols=choose(r,[3,4,5]),positions=Array.from({length:cols},(_,i)=>cx-w/2+i*w/(cols-1)),stepped=cols>3&&r()<.65;
 const structure=b.part('load-bearing-frame',{cx,w,floors,cols,positions,stepped}),cargo=b.part('occupants'),facade=b.part('facade'),loads=[];let roofPositions=positions;
 for(let rank=0;rank<floors;rank++){
  const y=bottom-rank*step,active=stepped&&rank>0?positions.slice(rank%2?1:0,rank%2?cols:cols-1):positions;roofPositions=active;
  for(const x of active)b.brick(structure,x,rank?y+step/2:y+17,between(r,11,16),rank?step-12:22,0,{...(rank?latent:fixed),constructionRole:'support'});
  for(let j=1;j<active.length;j++){const x=(active[j-1]+active[j])/2,span=active[j]-active[j-1]-1;
   b.brick(structure,x,y,span,12,0,{...loose,constructionRole:'floor'});
   if(j%2===rank%2){const offsets=span>91?[-22,0,22]:[-12,12];for(const dx of offsets)loads.push({x:x+dx,y:y-15});}
   else if(rank)for(const side of [-1,1])b.addIfClear(facade,x+side*15,y+step*.55,{radiusScale:between(r,1.1,1.4)},2);
  }
 }
 const roofY=bottom-(floors-1)*step-56,roofCenter=(roofPositions[0]+roofPositions.at(-1))/2,peakX=roofCenter+between(r,-29,29),roof=b.part('roof');
 b.stroke(roof,spline([{x:roofPositions[0]-14,y:roofY+41},{x:peakX,y:roofY-18},{x:roofPositions.at(-1)+14,y:roofY+41}],{tension:.15}),{width:34,spacing:34,extra:latent});
 const footing=b.part('footing');for(const side of [-1,1])b.addIfClear(footing,cx+side*(w/2+24),bottom+15,{radiusScale:1.3},3);
 for(const p of loads)b.addIfClear(cargo,p.x,p.y,{...loose,constructionRole:'cargo'},0);
 return {law:'support-graph',cx,w,floors,cols,roofY,stepped};
}

function canopy(b){
 const r=b.r,heading=choose(r,[-Math.PI/2,-Math.PI/2-.47,-Math.PI/2+.47]),tree=growBranches(r,{x:between(r,163,237),y:between(r,489,515),length:between(r,109,139),angle:heading,depth:choose(r,[2,3]),spread:between(r,.69,.95),shrink:between(r,.59,.7)}),a=b.part('branching-skeleton');
 const points=tree.edges.flatMap(e=>[e.a,e.b]),minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y)),scale=Math.min(1,302/(maxX-minX),337/(maxY-minY));
 const place={x:200-(minX+maxX)/2*scale,y:480-maxY*scale,sx:scale,sy:scale};for(const e of tree.edges){e.curve=transform(e.curve,place);e.a={...e.curve.start};e.b={...e.curve.end};}tree.leaves=tree.edges.filter(e=>e.rank===0).map(e=>e.b);
 const joints=new Map();for(const e of tree.edges)joints.set(e.b.x.toFixed(3)+','+e.b.y.toFixed(3),{p:e.b,rank:e.rank});
 const edgeMembers=new Map();for(const [i,e] of tree.edges.entries()){
  const branch=b.part('branch',{rank:e.rank}),members=b.stroke(branch,trimCubic(e.curve,i?18:0,e.rank?18:3),{width:e.rank?32:27,spacing:e.rank?32:27});
  edgeMembers.set(e,members);
 }
 const junctions=b.part('branch-junctions');for(const {p,rank} of joints.values())if(rank)b.addIfClear(junctions,p.x,p.y,{radiusScale:1.05},0);
 const fruit=b.part('fruit');for(const p of tree.leaves)b.addIfClear(fruit,p.x,p.y-24,{...latent,radiusScale:between(r,1.25,1.75)},4);
 const topRank=Math.max(...tree.edges.map(e=>e.rank)),near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<.01;
 function subtree(e){return [e,...tree.edges.filter(q=>near(q.a,e.b)).flatMap(subtree)];}
 for(const e of tree.edges.filter(e=>e.rank===topRank-1)){
  const branchSet=subtree(e),members=branchSet.flatMap(q=>edgeMembers.get(q)),points=branchSet.map(q=>q.b);
  members.push(...b.pegs.filter(p=>p.constructionAssembly===junctions.id&&points.some(q=>near(p,q))||p.constructionAssembly===fruit.id&&points.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<30)));
  b.animate(a,members,e.a,{rotation:(e.b.x<e.a.x?1:-1)*between(r,.23,.31),duration:1.6,hitTrigger:true,hitMode:'single'});
 }
 const wind=b.part('wind');for(const side of [-1,1]){
  const x=side<0?33:367;for(let j=0;j<4;j++)b.addIfClear(wind,x+side*Math.sin(j)*8,205+j*77,{radiusScale:between(r,1,1.5)},4);
 }
 return {law:'recursive-growth',edges:tree.edges.map(e=>({a:e.a,b:e.b,rank:e.rank})),leaves:tree.leaves};
}

function petals(b){
 const r=b.r,cx=between(r,169,231),cy=between(r,283,357),lobes=choose(r,[3,4,5,6]),nominal=between(r,108,138),phase=between(r,0,TAU),aspect=between(r,.8,1.15),amplitude=between(r,.17,.26),rad=Math.min(nominal,(Math.min(cx-16,384-cx,cy-111,533-cy)-6)/(Math.max(1,aspect)*(1+amplitude))),a=b.part('harmonic-contour',{cx,cy,lobes,rad,phase,aspect,amplitude});
 const contour=transform(polarContour({rx:rad,ry:rad*aspect,lobes,amplitude,phase}),{x:cx,y:cy});
 const members=b.stroke(a,contour,{closed:true,width:32,spacing:32});
 b.animate(a,members,{x:cx,y:cy},{rotation:choose(r,[-1,1])*TAU,duration:between(r,3,5),hitTrigger:true,hitMode:'spin',hitSteps:lobes});
 const inner=b.part('seed-head');const ir=rad*.37;
 b.dots(inner,arc(cx,cy,ir,ir),{spacing:between(r,23,29),scale:between(r,1,1.15)});
 const load=b.part('loose-seeds');b.cargo(load,[{x:cx-15,y:cy-12},{x:cx+15,y:cy-12},{x:cx,y:cy+15}]);
 const frame=b.part('frame');for(const side of [-1,1])for(let k=0;k<3;k++)b.addIfClear(frame,side<0?24:376,170+k*135,{radiusScale:between(r,1,1.5)},6);
 return {law:'harmonic-boundary',cx,cy,lobes,rad,phase};
}

function switchback(b){
 const r=b.r,mirror=r()<.5?-1:1,xx=x=>mirror===1?x:400-x,entry={x:xx(between(r,69,128)),y:between(r,296,414),angle:mirror*between(r,-.38,.38)},exit={x:xx(between(r,249,328)),y:between(r,164,282)},landing={x:xx(between(r,96,259)),y:between(r,395,471)},flight=between(r,25,37);
 if(Math.abs(landing.x-entry.x)<93&&Math.abs(landing.y-entry.y)<88)landing.x=xx(267);
 const vx=(landing.x-exit.x)/flight,vy=(landing.y-exit.y-.06*flight*flight)/flight;
 // Choose the outlet normal from the desired downstream flight, including
 // gravity. Native portal decomposition adds the entry-tangent component.
 exit.angle=Math.atan2(vy,vx)-Math.PI/2;
 const route=b.part('angled-portals',{entry,exit}),pa=b.peg(route,entry.x,entry.y,{type:'portalBlue',angle:entry.angle,portalScale:between(r,1.8,2.4),portalOneWay:true,portalOneWayFlip:false}),pb=b.peg(route,exit.x,exit.y,{type:'portalOrange',angle:exit.angle,portalScale:between(r,1.8,2.4),portalOneWay:true,portalOneWayFlip:true});pa.portalTargetId=pb.id;pb.portalTargetId=pa.id;
 const ramp=b.part('entry-bank');b.stroke(ramp,cubic([[xx(25),entry.y-110],[xx(22),entry.y-41],[entry.x-25*mirror,entry.y-12],[entry.x,entry.y-28]]),{width:32,spacing:32});
 // The exit bank follows a ballistic fan generated from native portal normal
 // and a plausible range of speeds. Full Game probes later determine utility.
 const speed=Math.hypot(vx,vy),startX=exit.x+vx/speed*22,startY=exit.y+vy/speed*22;
 const trajectory=Array.from({length:11},(_,i)=>{const t=i*flight/10;return {x:startX+vx*t,y:startY+vy*t+.06*t*t};}).filter(p=>p.x>24&&p.x<376&&p.y<501);
 const bank=b.part('exit-trajectory');if(trajectory.length>2){const shifted=trajectory.slice(0,-3).map((p,i)=>{const t=i*flight/10,heading=Math.atan2(vy+.12*t,vx);return {x:p.x-Math.sin(heading)*25,y:p.y+Math.cos(heading)*25};});if(shifted.length>2)b.stroke(bank,spline(shifted),{width:32,spacing:32});for(let i=2;i<trajectory.length-3;i++)b.addIfClear(bank,trajectory[i].x,trajectory[i].y,{radiusScale:between(r,1,1.2)},6);}
 const stairs=b.part('wall-ricochet');for(const side of [-1,1])for(let k=0;k<3;k++){
  const x=side<0?37:363,y=174+k*129;if(b.clear({x,y,shape:'brick',width:58,height:11,angle:side*.45},4))b.brick(stairs,x,y,58,11,side*.45);
 }
 const island=b.part('remote-targets'),formation=choose(r,['arc','fan','braid']);
 if(formation==='arc'){b.stroke(island,arc(landing.x,landing.y,60,37,.1,Math.PI-.1),{width:32,spacing:32});for(const dx of [-26,0,26])b.addIfClear(island,landing.x+dx,landing.y-21,{radiusScale:1.25},3);}
 if(formation==='fan')for(const side of [-1,1])b.dots(island,transform(spline([{x:side*58,y:-27},{x:side*37,y:-5},{x:side*22,y:25}]),{x:landing.x,y:landing.y}),{spacing:28,scale:1.18});
 if(formation==='braid')for(const side of [-1,1])b.stroke(island,transform(cubic([[-55,side*18],[-18,side*18+21],[18,side*18-21],[55,side*18]]),{x:landing.x,y:landing.y}),{width:30,spacing:30});
 return {law:'portal-vector-remapping',entry,exit,landing,formation,predictedExitFan:trajectory,estimatedOutletVelocity:{vx,vy}};
}

function slalom(b){
 const r=b.r,count=choose(r,[3,4]),offset=between(r,0,50),slope=between(r,.55,.9),amplitude=between(r,70,126),points=[];
 const a=b.part('folded-river',{count,offset,slope,amplitude});
 for(let i=0;i<=count;i++)points.push({x:200+Math.sin(i*Math.PI+Math.PI/2)*amplitude,y:133+i*between(r,84,96)+offset*.3});
 const channel=spline(points,{tension:slope});
 const members=b.stroke(a,channel,{width:between(r,28,37),spacing:32});
 if(r()<.5)b.animate(a,members,{x:200,y:320},{dx:between(r,-14,14),duration:between(r,5,8),hitTrigger:true,hitMode:'single'});
 const banks=b.part('bank-fans');for(let i=0;i<count;i++){
  const side=i%2?1:-1,cx=side<0?38:362,cy=181+i*93;
  b.dots(banks,arc(cx,cy,38,34,side<0?-Math.PI/2:Math.PI/2,side<0?Math.PI/2:Math.PI*1.5),{spacing:25,scale:between(r,1,1.25)});
 }
 const whirl=b.part('whirlpool');const x=choose(r,[117,283]),y=between(r,450,486);if(b.clear({x,y,type:'bumper',bumperScale:2.4},12))b.bumper(whirl,x,y,2.4);
 return {law:'alternating-spline-channel',points};
}

function orbits(b){
 const r=b.r,count=choose(r,[2,3,4,5]),spheres=[],centers=[];
 for(let i=0;i<count;i++){
  let placement=null;for(let trial=0;trial<220;trial++){
   const rad=between(r,count===2?74:43,count===2?101:65),extent=rad*1.17+11,x=between(r,extent+12,388-extent),y=between(r,112+extent,535-extent);
   if(centers.every(p=>Math.hypot(p.x-x,p.y-y)>p.extent+extent+13)){placement={x,y,rad,extent};break;}
  }if(!placement)break;centers.push(placement);
  const {x,y,rad}=placement,a=b.part('orbit',{x,y,rad}),shape=choose(r,['ring','lobed','spokes']);
  const members=shape==='lobed'?b.stroke(a,transform(polarContour({rx:rad,ry:rad,lobes:choose(r,[3,4]),amplitude:.15,phase:r()*TAU}),{x,y}),{closed:true}):b.dots(a,arc(x,y,rad,rad),{spacing:25,scale:between(r,1,1.15)});
  if(shape==='spokes')for(let k=0;k<3;k++){const t=k*TAU/3;members.push(...b.stroke(a,spline([{x:x+Math.cos(t)*27,y:y+Math.sin(t)*27},{x:x+Math.cos(t)*(rad-19),y:y+Math.sin(t)*(rad-19)}]),{width:27,spacing:27}));}
  b.animate(a,members,{x,y},{rotation:(i%2?1:-1)*TAU,duration:between(r,5,10),cycle:true,easing:'linear',hitTrigger:r()<.45,hitMode:'cycle'});
  const center=b.part('orbit-core');if(i%2===0)b.cargo(center,[{x:x-13,y:y-13},{x:x+13,y:y-13},{x,y:y+13}]);else b.bumper(center,x,y,between(r,1.9,2.6));
  spheres.push({...a.parameters,shape});
 }
 const lanes=b.part('boundary-beats');for(const side of [-1,1])for(let k=0;k<4;k++)b.addIfClear(lanes,side<0?24:376,135+k*107,{radiusScale:between(r,1,1.45)},4);
 return {law:'unequal-orbital-packing',spheres,requestedCount:count};
}

function mobile(b){
 const r=b.r,count=choose(r,[1,2]),pivotX=between(r,169,231),pivotY=between(r,139,174),a=b.part('pendulum-tree',{pivotX,pivotY,count}),parts=[];
 for(let i=0;i<count;i++){
  const x=count===1?between(r,140,259):i?between(r,272,294):between(r,101,122),y=count===1?between(r,362,399):i?between(r,365,406):between(r,285,329),rad=count===1?between(r,57,78):between(r,33,44),arm=b.part('suspended-arm');
  const curve=spline([{x:pivotX,y:pivotY+i*25},{x:(pivotX+x)/2,y:y-100},{x,y:y-rad-18}]);
  const members=b.stroke(arm,curve,{width:29,spacing:29});
  const vessel=b.stroke(arm,arc(x,y,rad,rad),{width:28,spacing:28,closed:true});members.push(...vessel);
  b.animate(arm,members,{x:pivotX,y:pivotY+i*25},{rotation:(x<pivotX?-1:1)*between(r,.11,.2),duration:between(r,2,4),hitTrigger:true,hitMode:'single'});
  const load=b.part('pendulum-load');b.cargo(load,[{x:x-12,y:y+3},{x:x+12,y:y+3}]);parts.push({x,y,rad});
 }
 const ground=b.part('counterweight');const side=parts[0].x<200?1:-1;
 b.dots(ground,arc(200+side*131,between(r,444,473),38,55,side>0?1.95:-1.17,side>0?4.29:1.17),{spacing:27,scale:1.35});
 return {law:'articulated-skeleton',pivotX,pivotY,parts};
}

function fault(b){
 const r=b.r,mirror=r()<.5?-1:1,xx=x=>mirror===1?x:400-x,n=choose(r,[3,4,5]),joints=[];
 for(let i=0;i<n;i++){
  const x=xx(63+i*274/(n-1)),y=154+i*340/(n-1),w=between(r,69,108),angle=mirror*between(r,-.7,-.34),a=b.part('tectonic-panel',{x,y,w,angle});
  const panel=b.stroke(a,transform(cubic([[-w/2,0],[-w/6,-9],[w/6,9],[w/2,0]]),{x,y,angle}),{width:30,spacing:30});
  b.animate(a,panel,{x,y},{rotation:mirror*between(r,.4,.85),duration:1.8,hitTrigger:true,hitMode:'single'});
  const diamonds=b.part('fault-grains');for(const side of [-1,1])for(let k=0;k<4;k++){
   const a=angle+side*Math.PI/2,d=28+k*26;b.addIfClear(diamonds,x+Math.cos(a)*d,y+Math.sin(a)*d,{radiusScale:between(r,1.05,1.5)},5);
  }
  joints.push({x,y,w,angle});
 }
 const side=b.part('side-impact');for(const s of [-1,1])for(let k=0;k<4;k++)b.addIfClear(side,s<0?23:377,142+k*108,{radiusScale:between(r,1,1.4)},4);
 const rim=b.part('fault-rim');for(const s of [-1,1]){
  const x=s<0?69:331,y=s*mirror<0?between(r,333,390):between(r,240,290),curve=arc(x,y,47,75,s<0?-1.12:1.98,s<0?1.12:4.25);
  const members=b.stroke(rim,curve,{width:29,spacing:29});b.animate(rim,members,{x,y},{rotation:-s*.18,duration:2.4,hitTrigger:true,hitMode:'single'});
 }
 return {law:'oblique-responsive-panels',joints};
}

function flux(b){
 const r=b.r,count=choose(r,[2,3]),mirror=r()<.5?-1:1,xx=x=>mirror===1?x:400-x,fields=[];
 for(let i=0;i<count;i++){
  const x=xx(i%2?between(r,260,300):between(r,100,140)),y=190+i*(count===2?243:139),rad=between(r,47,61),a=b.part('magnetic-lobe',{x,y,rad}),field=b.field(a,x,y,{radius:rad+39,strength:between(r,.27,.4)});
  const members=b.dots(a,arc(x,y,rad,rad),{spacing:29,scale:between(r,1,1.2)});
  b.animate(a,members,{x,y},{rotation:TAU*(i%2?-1:1),duration:between(r,7,10),cycle:true,easing:'linear'});
  const load=b.part('field-load');b.cargo(load,Array.from({length:4},(_,k)=>({x:x+(k%2?1:-1)*17,y:y-20+Math.floor(k/2)*32})),{scale:1});fields.push({x,y,radius:field.magnetRadius});
 }
 const bank=b.part('field-guides');for(let i=1;i<count;i++){
  const p=fields[i-1],q=fields[i],d=Math.sign(q.x-p.x),curve=cubic([[p.x+d*(p.radius-5),p.y+20],[200,p.y+67],[200,q.y-55],[q.x-d*(q.radius-5),q.y-7]]);b.stroke(bank,curve,{width:32,spacing:32});
 }
 const wall=b.part('field-boundary');for(const side of [-1,1])for(let k=0;k<4;k++)b.addIfClear(wall,side<0?24:376,129+k*113,{radiusScale:between(r,1,1.4)},5);
 return {law:'coupled-field-basins',fields};
}

function spiral(b){
 const r=b.r,cx=between(r,175,225),cy=between(r,303,351),rad=between(r,119,144),turns=between(r,1.12,1.72),polarity=choose(r,[-1,1]),phase=between(r,0,TAU),a=b.part('spiral-ribbon',{cx,cy,rad,turns,polarity,phase});
 const points=Array.from({length:65},(_,i)=>{const u=i/64,t=phase+polarity*u*TAU*turns,rr=27+(rad-27)*u**.8;return {x:cx+Math.cos(t)*rr,y:cy+Math.sin(t)*rr};});
 const members=b.stroke(a,spline(points),{width:31,spacing:31});b.animate(a,members,{x:cx,y:cy},{rotation:polarity*TAU,duration:3.6,hitTrigger:true,hitMode:'spin',hitSteps:choose(r,[4,6])});
 const seeds=b.part('spiral-seeds');for(let i=5;i<points.length-1;i+=5){const p=points[i],q=points[i+1],t=Math.atan2(q.y-p.y,q.x-p.x);b.addIfClear(seeds,p.x-Math.sin(t)*23,p.y+Math.cos(t)*23,{...latent,radiusScale:between(r,1,1.3)},3);}
 const caps=b.part('outer-beats');for(const side of [-1,1])for(let k=0;k<3;k++)b.addIfClear(caps,side<0?24:376,171+k*139,{radiusScale:between(r,1,1.5)},5);
 return {law:'synthesized-spiral',cx,cy,rad,turns,polarity,phase};
}

function morphogenesis(b){
 const r=b.r,rootX=between(r,171,229),rootY=between(r,272,351),children=choose(r,[1,2,3,4]),recipes=[];
 // Shape genes are combined analytically. A new seed produces a new contour,
 // not a selection from a named drawing. Attachment sites come from its surface.
 function recipe(rad){return {rad,aspect:between(r,.76,1.17),m:choose(r,[2,3,4,5,6]),n:choose(r,[2,3,5]),a:between(r,.09,.2),c:between(r,.02,.08),phase:between(r,0,TAU),phase2:between(r,0,TAU)};}
 function surface(g,t){const rho=1+g.a*Math.cos(g.m*t+g.phase)+g.c*Math.sin(g.n*t+g.phase2);return {x:g.rad*rho*Math.cos(t),y:g.rad*g.aspect*rho*Math.sin(t)};}
 function outline(g,x,y){return spline(Array.from({length:64},(_,i)=>{const p=surface(g,i*TAU/64);return {x:x+p.x,y:y+p.y};}),{closed:true});}
 function compile(g,x,y,index){
  const a=b.part('grown-contour',{...g,x,y}),curve=outline(g,x,y),members=b.stroke(a,curve,{closed:true,width:31,spacing:31});
  b.animate(a,members,{x,y},{rotation:choose(r,[-1,1])*TAU,duration:between(r,3,5),hitTrigger:true,hitMode:'spin',hitSteps:choose(r,[4,6])});
  const core=b.part('contour-cargo');b.cargo(core,index?[-10,10].map(dx=>({x:x+dx,y})):[-1,0,1].map(k=>({x:x+k*23,y:y-9})),{scale:1});recipes.push(a.parameters);return {a,g,x,y};
 }
 const rootGene=recipe(between(r,73,96)),root=compile(rootGene,rootX,rootY,0),envelopes=[{x:rootX,y:rootY,radius:rootGene.rad*Math.max(1,rootGene.aspect)*(1+rootGene.a+rootGene.c)+8}];
 for(let i=0;i<children;i++){
  let chosen=null;for(let trial=0;trial<70;trial++){
   const gene=recipe(between(r,26,43)),theta=between(r,0,TAU),parentRadius=envelopes[0].radius,childRadius=gene.rad*Math.max(1,gene.aspect)*(1+gene.a+gene.c)+8,distance=parentRadius+childRadius+between(r,16,27),x=rootX+Math.cos(theta)*distance,y=rootY+Math.sin(theta)*distance;
   if(x-childRadius<16||x+childRadius>384||y-childRadius<114||y+childRadius>532||envelopes.some(p=>Math.hypot(p.x-x,p.y-y)<p.radius+childRadius+12))continue;
   chosen={gene,theta,x,y,childRadius};break;
  }if(!chosen)continue;
  const {gene,theta,x,y,childRadius}=chosen,child=compile(gene,x,y,i+1),p=surface(rootGene,theta),q=surface(gene,theta+Math.PI),start={x:rootX+p.x+Math.cos(theta)*13,y:rootY+p.y+Math.sin(theta)*13},end={x:x+q.x-Math.cos(theta)*13,y:y+q.y-Math.sin(theta)*13},link=b.part('growth-neck');
  b.stroke(link,spline([start,{x:(start.x+end.x)/2-Math.sin(theta)*between(r,-9,9),y:(start.y+end.y)/2+Math.cos(theta)*between(r,-9,9)},end]),{width:27,spacing:27});
  b.relations.push({from:root.a.id,to:child.a.id,kind:'surface-graft',theta});envelopes.push({x,y,radius:childRadius});
 }
 const boundary=b.part('growth-boundary');for(const side of [-1,1])for(let k=0;k<3;k++)b.addIfClear(boundary,side<0?24:376,160+k*149,{radiusScale:between(r,1,1.5)},5);
 return {law:'harmonic-growth-with-surface-attachments',recipes,requestedChildren:children};
}

const compilers={roulette,shoal,architecture,canopy,petals,switchback,slalom,orbits,mobile,fault,flux,spiral,morphogenesis};
export function generateLevel({seed='field-000',domain='auto'}={}){
 seed=String(seed).slice(0,60);if(domain==='auto')domain=choose(randomFrom(seed+':des4-domain'),DOMAINS);if(!compilers[domain])throw Error('Unknown design domain: '+domain);
 const b=new Builder(seed,domain),plan=compilers[domain](b);return b.finish(plan);
}
