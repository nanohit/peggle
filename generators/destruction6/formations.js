import {randomFrom} from '../destruction/grammar.js';
import {sampleCubicBezier,bakePegsFromSamples} from '../destruction2/bezier-geometry.js';
import {overlapDepth} from '../destruction2/ribbon-geometry.js';

// Small new members of the arsenal, not a replacement for the earlier grammars.
// A single visual gesture and (at most) one moving assembly lead each board.
export const FORMS=['braid','crescents','rosette','chevrons','lanterns','sail'];
const names={braid:'Переплёт',crescents:'Полумесяцы',rosette:'Роза ветров',chevrons:'Ёлочка',lanterns:'Фонари',sail:'Парус'};
const point=([x,y])=>({x,y});
const cubic=a=>({start:point(a[0]),h1:point(a[1]),h2:point(a[2]),end:point(a[3])});
function arc(cx,cy,rx,ry,a,b){
 const n=Math.ceil(Math.abs(b-a)/(Math.PI/2)),segments=[];
 for(let i=0;i<n;i++){const u=a+(b-a)*i/n,v=a+(b-a)*(i+1)/n,k=4/3*Math.tan((v-u)/4);
  segments.push(cubic([[cx+rx*Math.cos(u),cy+ry*Math.sin(u)],[cx+rx*(Math.cos(u)-k*Math.sin(u)),cy+ry*(Math.sin(u)+k*Math.cos(u))],[cx+rx*(Math.cos(v)+k*Math.sin(v)),cy+ry*(Math.sin(v)-k*Math.cos(v))],[cx+rx*Math.cos(v),cy+ry*Math.sin(v)]]));
 }
 return {...segments[0],end:segments.at(-1).end,h2:segments.at(-1).h2,segments};
}
export function generateFormation({seed='formation-001',form='braid'}={}){
 if(!FORMS.includes(form))throw Error('Unknown formation '+form);
 const rng=randomFrom(seed+':des6:'+form),range=(a,b)=>a+(b-a)*rng(),id='des6-'+form+'-'+seed;
 const pegs=[],groups=[],curves={},strokes=[];let serial=0;
 const peg=(x,y,extra={})=>{const p={id:id+':p'+(++serial),x,y,shape:'circle',angle:0,type:'blue',radiusScale:1,destructionStatic:true,destructionPhysicsOnHit:false,...extra};pegs.push(p);return p;};
 const stroke=(curve,role)=>{
  const sid=id+':s'+strokes.length,members=bakePegsFromSamples(sampleCubicBezier(curve),{shape:'brick',spacingPx:34,brickWidth:34,pegRadius:8.5,sliceCount:7});
  curves[sid]={...curve,pegShape:'brick',pegType:'blue',spacingPx:34,brickWidth:34,brickHeight:10.2,pegRadius:8.5,bakeVersion:1,rotationOffset:0,refPoints:members.map((p,index)=>({index,x:p.x,y:p.y}))};
  const row={id:sid,role,pegs:members.map((m,index)=>peg(m.x,m.y,{shape:'brick',width:34,height:10.2,brickBaseRadius:8.5,angle:m.angle,curveSlices:m.slices,bezierGroupId:sid,bezierIndex:index,constructionAssembly:sid,constructionRole:role}).id)};strokes.push(row);return row;
 };
 const clear=(x,y,r=8.5)=>pegs.every(p=>overlapDepth({x,y,radius:r,shape:'circle'},{...p,radius:8.5})<-.01&&Math.hypot(x-p.x,y-p.y)>24);
 let sweep=null;
 const shift=range(-10,10),bend=range(23,42),side=rng()<.5?-1:1;
 if(form==='braid')for(const s of [-1,1]){
  const x=200+s*104;stroke(cubic([[x,138],[x-s*bend,227],[x+s*bend,378],[x,494]]),'woven-bank');
 }
 if(form==='crescents'){
  for(const [i,y] of [202,385].entries()){
   const turn=(i%2?0:Math.PI),cx=200+shift;
   stroke(arc(cx,y,range(131,148),63,turn-Math.PI*.79,turn+Math.PI*.79),'crescent');
  }
 }
 if(form==='rosette'){
  const cx=200,cy=322,r=range(106,120),inner=range(32,44),twist=range(.34,.62);
  const ids=[];
  for(let i=0;i<4;i++){
   const a=i*Math.PI/2+range(-.12,.12),p=(rad,t)=>[cx+rad*Math.cos(t),cy+rad*Math.sin(t)];
   ids.push(...stroke(cubic([p(inner,a),p(r*.75,a-twist),p(r,a+.26),p(r*.88,a+.54)]),'wind-petal').pegs);
  }
  const groupId=id+':wheel',members=pegs.filter(p=>ids.includes(p.id)),mx=members.reduce((s,p)=>s+p.x,0)/members.length,my=members.reduce((s,p)=>s+p.y,0)/members.length;
  members.forEach(p=>p.groupId=groupId);groups.push({id:groupId,name:'Роза ветров',pattern:'custom',animation:{dx:0,dy:0,rotation:side*Math.PI*2,duration:range(2.6,3.6),cycle:false,wrap:true,hitTrigger:true,hitMode:'spin',hitSteps:4,easing:'easeInOut',pivot:{dx:cx-mx,dy:cy-my}}});
  sweep={x:cx,y:cy,r:r+26};peg(cx,cy,{type:'bumper',bumperScale:1.65,bumperBounce:1.35,bumperOrange:false});
 }
 if(form==='chevrons')for(const y of [170,310,450])for(const s of [-1,1]){
  const x=200+s*151,inner=200+s*35;
  stroke(cubic([[x,y-27],[x-s*45,y-8],[inner+s*35,y+24],[inner,y+29]]),'chevron');
 }
 if(form==='lanterns')for(const [i,[x,y]] of [[103,195],[294,310],[114,451]].entries()){
  const r=range(48,60),a=(i%2?Math.PI:0)+range(-.3,.3),mouth=range(.7,1.1);
  stroke(arc(x,y,r,r*.82,a+mouth,a+Math.PI*2-mouth),'lantern');peg(x,y);
 }
 if(form==='sail'){
  for(const s of [-1,1]){
   const x=200+s*142;stroke(cubic([[x,154],[200+s*50,188],[200+s*125,317],[200+s*35,430]]),'sail-wing');
  }
  stroke(cubic([[63,488],[144,455],[268,522],[337,471]]),'sail-keel');
 }
 // Each gesture has its own target rhythm, rather than the same dotted lattice
 // pasted behind six different sets of curves. They share only size/clearance.
 const phase=range(-9,9),pitch=range(43,49),points=[];
 if(form==='braid')for(let row=0;row<10;row++){
  const y=126+row*41;for(const x of [43,200+Math.sin(row*.9)*32,357])points.push([x,y]);
  if(row%2===0)for(const x of [148,252])points.push([x,y+18]);
 }
 if(form==='crescents'){
  for(const y of [202,385])for(let i=0;i<13;i++){const a=i*Math.PI*2/13;points.push([200+shift+86*Math.cos(a),y+34*Math.sin(a)]);}
  for(const y of [122,292,506])for(let i=0;i<7;i++)points.push([48+i*50,y+Math.sin(i)*phase]);
 }
 if(form==='rosette')for(let i=0;i<30;i++){
  const a=i*Math.PI*2/30,rx=157+Math.sin(a*3)*5,ry=181;points.push([200+rx*Math.cos(a),322+ry*Math.sin(a)]);
 }
 if(form==='chevrons')for(let row=0;row<8;row++)for(let col=0;col<7;col++){
  const x=45+col*51,y=128+row*51+Math.abs(col-3)*9*(row%2?1:-1);points.push([x,y]);
 }
 if(form==='lanterns'){
  for(const [i,[cx,cy]] of [[103,195],[294,310],[114,451]].entries())for(let j=0;j<10;j++){
   const a=j*Math.PI*2/10+i*.3;points.push([cx+78*Math.cos(a),cy+67*Math.sin(a)]);
  }
  for(let i=0;i<9;i++)points.push([200+side*60*Math.sin(i*.85),124+i*47]);
 }
 if(form==='sail')for(let row=0;row<9;row++)for(let col=0;col<7;col++){
  const y=123+row*46+Math.sin(col*.8+row*.3)*5;
  const x=45+col*pitch+(row%2?pitch*.34:0)+Math.sin(row*.9)*phase;points.push([x,y]);
 }
 for(const [x,y] of points){
  if(x<24||x>370||y<111||y>523||sweep&&Math.hypot(x-sweep.x,y-sweep.y)<sweep.r)continue;
  if(clear(x,y,13))peg(x,y,{constructionRole:'field'});
 }
 const eligible=pegs.filter(p=>p.type==='blue'),pool=eligible.map(p=>({p,tie:rng()})),bands=[0,0,0],parts=new Map(),wanted=Math.min(27,Math.max(20,Math.round(eligible.length*.40)));
 for(let i=0;i<wanted;i++){
  pool.sort((a,b)=>{const score=o=>bands[Math.min(2,Math.max(0,Math.floor((o.p.y-110)/140)))]*2+(parts.get(o.p.bezierGroupId||'field')||0)*.3+o.tie;return score(a)-score(b);});
  const {p}=pool.shift();p.type='orange';bands[Math.min(2,Math.max(0,Math.floor((p.y-110)/140)))]++;parts.set(p.bezierGroupId||'field',(parts.get(p.bezierGroupId||'field')||0)+1);
 }
 return {version:1,id,name:names[form],pegRadius:8.5,ballCount:12,bucketEnabled:true,hitPegTimedClearEnabled:true,hitPegClearDelayMs:1100,pegs,groups,bezierCurves:curves,flippers:null,destruction:{enabled:false},metadata:{generator:{name:'des6-formations',version:'0.1',seed,form,hero:form==='rosette'?'motion':'bounce',plan:{strokes,loads:[]}},authorNotes:'Обычные правила Alea. Новый рисунок поля из численных кривых и ритма целей.'}};
}
