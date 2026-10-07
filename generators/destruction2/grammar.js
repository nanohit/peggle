import {randomFrom} from '../destruction/grammar.js';
import {sampleCubicBezier,bakePegsFromSamples} from './bezier-geometry.js';
export const LAYOUTS=Object.freeze([{id:'auto',name:'Свободная композиция'},{id:'river',name:'Река рикошетов'},
 {id:'fan',name:'Веер'},{id:'islands',name:'Открытые острова'},{id:'funnel',name:'Воронка'},
 {id:'switchback',name:'Серпантин'},{id:'orbit',name:'Большая орбита'}]);
export const HEROES=Object.freeze([{id:'auto',name:'Автоматически'},{id:'bounce',name:'Рикошеты'},
 {id:'magnet',name:'Магнит'},{id:'portal',name:'Порталы'},{id:'motion',name:'Движение'},{id:'collapse',name:'Разрушение'}]);
const pick=(rng,a)=>a[Math.floor(rng()*a.length)],range=(r,a,b)=>a+(b-a)*r(),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const point=([x,y])=>({x,y}),cubic=p=>({start:point(p[0]),h1:point(p[1]),h2:point(p[2]),end:point(p[3])});
function arc(cx,cy,rx,ry,start,end){
 const n=Math.ceil(Math.abs(end-start)/(Math.PI/2)),step=(end-start)/n,segments=[];
 for(let i=0;i<n;i++){const a=start+i*step,b=a+step,k=4/3*Math.tan(step/4);
  segments.push(cubic([[cx+rx*Math.cos(a),cy+ry*Math.sin(a)],
   [cx+rx*(Math.cos(a)-k*Math.sin(a)),cy+ry*(Math.sin(a)+k*Math.cos(a))],
   [cx+rx*(Math.cos(b)+k*Math.sin(b)),cy+ry*(Math.sin(b)-k*Math.cos(b))],
   [cx+rx*Math.cos(b),cy+ry*Math.sin(b)]]));}
 return {...segments[0],end:segments.at(-1).end,h2:segments.at(-1).h2,segments};
}
export function normalizeOptions(options={}) {
 const layout=LAYOUTS.some(l=>l.id===options.layout)?options.layout:'auto',hero=HEROES.some(h=>h.id===options.hero)?options.hero:'auto';
 return {seed:String(options.seed||'des2-001').slice(0,60),layout,hero,density:clamp(Number(options.density)||.55,.25,.85),destruction:clamp(Number(options.destruction??.35),0,1)};
}
export function generateLevel(options={}) {
 const input=normalizeOptions(options),rng=randomFrom(input.seed+':des2-plan'),shapeRng=randomFrom(input.seed+':shape');
 const layout=input.layout==='auto'?pick(randomFrom(input.seed+':layout'),LAYOUTS.slice(1).map(l=>l.id)):input.layout;
 const hero=input.hero==='auto'?pick(randomFrom(input.seed+':hero'),HEROES.slice(1).map(h=>h.id)):input.hero;
 const density=input.density,mirror=rng()<.5?-1:1,jitter=()=>range(shapeRng,-9,9);
 const id='des2-'+layout+'-'+hero+'-'+input.seed.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,48);
 const pegs=[],groups=[],curves={},strokes=[],spaces=[],loads=[];let serial=0;
 const peg=(x,y,type='blue',extra={})=>{const p={id:id+':p'+(++serial),x,y,type,shape:'circle',angle:0,
  radiusScale:1,destructionStatic:true,destructionPhysicsOnHit:false,...extra};pegs.push(p);return p;};
 function stroke(curve,material='brick',role='lane',spacing=38) {
  const sid=id+':stroke'+strokes.length,samples=sampleCubicBezier(curve),members=bakePegsFromSamples(samples,
   {shape:material,spacingPx:material==='brick'?34:spacing,brickWidth:34,pegRadius:8.5,sliceCount:7});
  const row={id:sid,role,pegs:[],curve};strokes.push(row);
  if(material==='brick')curves[sid]={...curve,pegShape:'brick',pegType:'blue',spacingPx:34,brickWidth:34,brickHeight:10.2,
   pegRadius:8.5,bakeVersion:1,rotationOffset:0,refPoints:members.map((p,index)=>({index,x:p.x,y:p.y}))};
  members.forEach((m,index)=>{const p=peg(m.x,m.y,'blue',{constructionAssembly:sid,constructionRole:role,
   ...(material==='brick'?{shape:'brick',width:34,height:10.2,brickBaseRadius:8.5,angle:m.angle,
    bezierGroupId:sid,bezierIndex:index,curveSlices:m.slices}: {})});row.pegs.push(p.id);});return row;
 }
 const spacing=range(rng,34,42)-(density-.55)*10;
 // These choose board-scale silhouettes. Coordinates are evaluated from paths;
 // no source level or hand-authored peg array is used.
 if(layout==='river') {
  const phase=mirror*range(rng,30,58),ys=[168+jitter(),310+jitter(),452+jitter()];
  ys.forEach((y,i)=>{const a=i%2===0?42:117,b=i%2===0?281:356;
   stroke(cubic([[a,y],[a+60,y+phase],[b-60,y-phase],[b,y+12]]),'brick','river-bank');
   stroke(cubic([[a+8,y+49],[a+75,y+phase+44],[b-65,y-phase+54],[b-8,y+58]]),'circle','river-targets',spacing);});
  spaces.push({kind:'staggered-openings',width:80});
 }
 if(layout==='switchback') {
  const lean=mirror*range(rng,25,42);
  stroke(cubic([[47,151],[330,170+lean],[52,275-lean],[348,298]]),'brick','upper-switch');
  stroke(cubic([[52,363],[335,375-lean],[55,455+lean],[347,480]]),'brick','lower-switch');
  for(const y of [125,335,515])stroke(cubic([[60,y],[132,y-15],[265,y+15],[340,y]]),'circle','echo',spacing);
  spaces.push({kind:'middle-passage',y:331,width:32});
 }
 if(layout==='fan') {
  const bend=range(rng,20,45),base=440+jitter();
  for(const side of [-1,0,1]){
   const x=200+side*range(rng,113,128),end=200+side*43;
   stroke(cubic([[x,142+Math.abs(side)*22],[x+side*bend,260],[end+side*bend,345],[end,base+Math.abs(side)*26]]),'brick','fan-arm');
  }
  stroke(arc(200,448,110,53,.15,Math.PI-.15),'circle','fan-base',spacing);
  spaces.push({kind:'fan-channels',minimum:28});
 }
 if(layout==='funnel') {
  const gap=range(rng,80,116),top=170+jitter(),bottom=350+jitter();
  for(const side of [-1,1]){
   const outer=side<0?40:360,inner=200+side*gap/2;
   stroke(cubic([[outer,top],[outer-side*15,top+98],[inner-side*26,bottom-15],[inner,bottom]]),'brick','funnel-wing');
   stroke(cubic([[outer-side*24,top+15],[outer-side*48,top+88],[inner-side*35,bottom-70],[inner-side*35,bottom-20]]),'circle','outside-lane',spacing);
  }
  stroke(arc(200,405,112,66,.10,Math.PI-.10),'brick','lower-catcher');
  for(const y of [146,210,272,334,402,514])peg(200+jitter(),y);
  spaces.push({kind:'funnel-aperture',x:200,width:gap});
 }
 if(layout==='islands') {
  const count=density>.65?4:3;
  const centers=count===4?[[108,185,50],[291,235,48],[114,380,52],[294,458,50]]:[[102,190,58],[287,320,67],[123,458,56]];
  for(const [i,[x,y,r]] of centers.entries()){
   const opening=range(rng,1.15,1.7),turn=range(rng,-.8,.8)+(i%2?Math.PI:0);
   const row=stroke(arc(x+jitter(),y+jitter(),r,r,turn+opening/2,turn+Math.PI*2-opening/2),'brick','open-island');
   row.pivot=[x,y];peg(x-17,y-4);peg(x+19,y+5);
  }
  spaces.push({kind:'island-gaps',minimum:27});
 }
 if(layout==='orbit') {
  const cx=200+jitter(),cy=324+jitter(),rx=range(rng,133,149),ry=range(rng,160,179),opening=range(rng,1.2,1.7);
  const row=stroke(arc(cx,cy,rx,ry,-Math.PI/2+opening/2,Math.PI*1.5-opening/2),'brick','open-orbit');row.pivot=[cx,cy];
  stroke(arc(cx,cy,75,66,Math.PI*.12,Math.PI*.87),'circle','inner-orbit',spacing);
  for(const y of [155,220,290,399,486])for(const side of [-1,1]){const x=cx+side*range(rng,36,58),yy=y+jitter();if(clear(x,yy,10))peg(x,yy);}
  spaces.push({kind:'orbit-mouth',width:opening*rx});
 }
 // A leading native mechanic is placed into actual free space, not layered
 // blindly on every composition. Failed placements are left to candidate rejection.
 function distanceToBrick(p,q){
  if(q.curveSlices?.length){let d=Infinity;for(let i=1;i<q.curveSlices.length;i++){const a=q.curveSlices[i-1],b=q.curveSlices[i],dx=b.x-a.x,dy=b.y-a.y,t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1),0,1);d=Math.min(d,Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy));}return d-q.height/2;}
  const dx=p.x-q.x,dy=p.y-q.y,c=Math.cos(q.angle||0),s=Math.sin(q.angle||0);return Math.hypot(Math.max(0,Math.abs(dx*c+dy*s)-q.width/2),Math.max(0,Math.abs(-dx*s+dy*c)-q.height/2));
 }
 function clear(x,y,r,ignore=[]) {return pegs.filter(p=>!ignore.includes(p.id)).every(q=>q.shape==='brick'?distanceToBrick({x,y},q)>r+4:Math.hypot(x-q.x,y-q.y)>r+(q.type.startsWith('portal')?34:8.5*(q.bumperScale||1))+5);}
 const free=[];for(let y=200;y<=452;y+=42)for(let x=83;x<=317;x+=39)if(clear(x,y,23))free.push([x,y]);
 const spot=pick(rng,free)||[200,320];
 if(hero==='bounce')peg(...spot,'bumper',{bumperScale:2.15,bumperBounce:1.5,bumperOrange:false});
 if(hero==='magnet')peg(...spot,'bombMagnet',{magnetRadius:range(rng,76,102),magnetStrength:range(rng,.24,.40),
  magnetMode:pick(rng,['attract','repel']),magnetHittable:true,magnetKnockout:true,magnetBlast:false});
 if(hero==='portal') {
  const available=free.filter(([x,y])=>clear(x,y,39));const start=available.filter(p=>p[1]>=326).sort((a,b)=>b[1]-a[1]||Math.abs(a[0]-200)-Math.abs(b[0]-200))[0]||spot;
  const end=available.filter(p=>p[1]<300&&Math.hypot(p[0]-start[0],p[1]-start[1])>115).sort((a,b)=>a[1]-b[1]||Math.abs(a[0]-(400-start[0]))-Math.abs(b[0]-(400-start[0])))[0]||[400-start[0],180];
  const a=peg(...start,'portalBlue',{portalScale:2.2,portalOneWay:false}),b=peg(...end,'portalOrange',{portalScale:2.2,portalOneWay:false});a.portalTargetId=b.id;b.portalTargetId=a.id;
 }
 if(hero==='motion') {
  const row=pick(rng,strokes.filter(s=>curves[s.id])),members=pegs.filter(p=>row?.pegs.includes(p.id));
  if(row&&members.length){const groupId=id+':motion',cx=members.reduce((s,p)=>s+p.x,0)/members.length,cy=members.reduce((s,p)=>s+p.y,0)/members.length;
   members.forEach(p=>p.groupId=groupId);groups.push({id:groupId,name:'Moving ribbon',pattern:'custom',animation:{dx:layout==='orbit'||layout==='islands'?0:mirror*range(rng,14,24),dy:0,
    rotation:layout==='orbit'||layout==='islands'?Math.PI*2:range(rng,-.12,.12),duration:range(rng,5.5,8),cycle:layout==='orbit'||layout==='islands',wrap:false,hitTrigger:false,easing:'easeInOut',
    ...(row.pivot?{pivot:{dx:row.pivot[0]-cx,dy:row.pivot[1]-cy}}:{})}});
  }
 }
 const loadCount=hero==='collapse'?1+Math.round(input.destruction):(hero==='magnet'?1:(rng()<input.destruction?1:0));
 for(let load=0;load<loadCount;load++) {
  // Blue supports can be shot away. Cargo is ordinary and not rigidly attached
  // to the floor. No gray beam can pin an orange handle after it swings shut.
  const magnet=pegs.find(p=>p.type==='bombMagnet');
  let place=null;for(const [x,y] of free)if(y<430&&(!magnet||Math.hypot(x-magnet.x,y-14-magnet.y)<magnet.magnetRadius*.92)&&[[-38,0],[0,0],[38,0],[-18,-17],[0,-17],[18,-17]].every(([dx,dy])=>clear(x+dx,y+dy,11))) {place=[x,y];break;}
  if(place){const [cx,cy]=place;const floor=peg(cx,cy,'blue',{shape:'brick',width:74,height:10.2,brickBaseRadius:8.5,constructionRole:'breakable-support'});
   const cargo=[];for(const side of [-1,0,1]){const p=peg(cx+side*18.5,cy-13.8,'blue',{destructionStatic:false,constructionRole:'cargo',constructionAssembly:floor.id});cargo.push(p.id);}loads.push({support:floor.id,cargo});}
 }
 // Fill large empty patches with widely spaced accent pegs. This also stops an
 // open layout from degenerating to three isolated toys and a cleanup shot.
 const desired=Math.round(20+density*22),candidates=[];
 const sweep=hero==='motion'?strokes.filter(s=>s.pivot&&pegs.some(p=>s.pegs.includes(p.id)&&p.groupId)).map(s=>({x:s.pivot[0],y:s.pivot[1],r:Math.max(...pegs.filter(p=>s.pegs.includes(p.id)).map(p=>Math.hypot(p.x-s.pivot[0],p.y-s.pivot[1])))+24})):[];
 const outsideSweep=(x,y)=>sweep.every(s=>Math.hypot(x-s.x,y-s.y)>s.r);
 for(let i=0;i<400;i++){const x=range(rng,33,367),y=range(rng,120,510);if(clear(x,y,20)&&outsideSweep(x,y))candidates.push([x,y]);}
 for(const [x,y] of candidates){if(pegs.filter(p=>p.shape==='circle'&&['blue','orange'].includes(p.type)).length>=desired)break;if(clear(x,y,20))peg(x,y,'blue',{constructionRole:'accent'});}
 const eligible=pegs.filter(p=>['blue','orange'].includes(p.type)),wanted=clamp(Math.round(eligible.length*.43),18,27);
 // Stratify orange targets by height and assembly so a big collapse cannot
 // silently finish the entire level while every interesting lane remains blue.
 const targetRng=randomFrom(input.seed+':targets'),pool=eligible.map(p=>({p,tie:targetRng()})),bandCounts=[0,0,0],assemblyCounts=new Map();
 for(let i=0;i<wanted&&pool.length;i++){
  pool.sort((a,b)=>{const score=o=>{const band=Math.min(2,Math.floor((o.p.y-100)/140));return bandCounts[Math.max(0,band)]*2+(assemblyCounts.get(o.p.constructionAssembly)||0)+o.tie;};return score(a)-score(b);});
  const {p}=pool.shift();p.type='orange';const band=clamp(Math.floor((p.y-100)/140),0,2);bandCounts[band]++;assemblyCounts.set(p.constructionAssembly,(assemblyCounts.get(p.constructionAssembly)||0)+1);
 }
 return {version:1,id,name:LAYOUTS.find(l=>l.id===layout).name+' · '+HEROES.find(h=>h.id===hero).name,pegRadius:8.5,ballCount:12,bucketEnabled:true,
  hitPegTimedClearEnabled:true,hitPegClearDelayMs:1100,pegs,groups,bezierCurves:curves,flippers:null,
  destruction:{enabled:true,gravityX:0,gravityY:.115,damping:.994,restitution:.34,friction:.72,surfaceGrip:.18,dynamicPegBallBounce:.45,maxSpeed:14,sleepSpeed:.055,sleepFrames:18,stuckPileClearDelayMs:220},
  metadata:{generator:{name:'destruction_spectacle',version:'0.1.0',seed:input.seed,layout,hero,density,destruction:input.destruction,plan:{strokes:strokes.map(s=>({id:s.id,role:s.role,pegs:s.pegs})),spaces,loads}},
   authorNotes:'Ordinary orange clearing. Procedural Bezier lanes, open space and one native leading mechanic.'}};
}
