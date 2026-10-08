import {randomFrom} from '../destruction/grammar.js';
import {SystemBuilder, source, reservoir, carrier} from '../destruction5/components.js';
import {arc, cubic, spline, transform, polarContour, between, choose, TAU} from '../destruction4/shapes.js';
import {overlapDepth, objectBounds} from '../destruction2/ribbon-geometry.js';
import {HIT_PEG_CLEAR_DELAY_DEFAULT_MS} from '../../js/hit-peg-clear-settings.js';
import {planDrawing,drawComposition} from './drawing.js';
import {FlowComposer,drawFlow,appendToTail,drawingVoids,insideDrawingVoid} from './flow.js';

export const RECHARGE_MS = 1600;
export const BASE_SCROLL_SPEED = 25;
export const FAMILIES = ['river','islands','orchard','slalom','orbits','petals','branch','release','balance','portal','field'];
export const STREAM_ACTIONS = ['drawing','release','balance','portal','field'];
const startAt = {river:0,islands:0,orchard:0,slalom:0,orbits:3,petals:5,branch:7,release:4,balance:8,portal:6,field:10};

// Pages compile an overlapping window of one drawing. The persistent voices
// and episode placement have their own metre, independent of page boundaries.
export class SurvivalGenerator {
  constructor(seed='survival-01') {
    this.seed=String(seed).slice(0,80); this.index=0; this.cursorY=190;
    this.exitX=200; this.recent=[]; this.drawings=[]; this.sinceRelief=0;
    this.flow=new FlowComposer(randomFrom(this.seed+':flow'));this.tail=[];this.voids=[];this.nextReliefAt=0;
  }

  next({family: forced}={}) {
    const i=this.index++, r=randomFrom(this.seed+':stream:'+i);
    const progress=1-Math.exp(-i/22), relief=this.sinceRelief>=3 || (i>0&&r()<.17);
    // Normal generation expands drawing programs. Named legacy forms below
    // remain explicit calibration cases, not the live stream's recipe bank.
    const actions=['release','balance','portal','field'].filter(f=>i>=startAt[f]&&!this.recent.slice(-2).includes(f));
    const family=forced || (relief||i===0||r()>(.24+progress*.24)?'drawing':choose(r,actions)||'drawing');
    this.recent.push(family); if(this.recent.length>3)this.recent.shift();
    this.sinceRelief=relief?0:this.sinceRelief+1;
    const b=new SystemBuilder(this.seed.replace(/[^\w-]/g,'').slice(0,24)+'-stream-'+i,{brickWidth:34,direction:r()<.5?-1:1,focus:progress});
    b.id='surv:'+this.seed+':'+i;
    const flow=forced?null:this.flow.plan(r,{family,progress});
    if(flow) {
      // This compiler window is taller than one page's advance. Existing
      // numerical constructors still author ordinary native-sized objects.
      b.clear=(p,gap=2,ignore=[])=>{
        const q=b.sized({type:'blue',shape:'circle',angle:0,radiusScale:1,...p},gap),box=objectBounds(q);
        return box.minX>=15&&box.maxX<=385&&box.minY>=90&&box.maxY<=680&&
          b.pegs.every(o=>ignore.includes(o.id)||overlapDepth(q,b.sized(o))<.1);
      };
    }
    const entry=this.exitX, exit=between(r,100,300), direction=r()<.5?-1:1;
    const parts=()=>b.part(family), stroke=(a,c)=>b.stroke(a,c,{width:34,spacing:34});
    const dot=(a,x,y,extra={})=>b.addIfClear(a,x,y,extra,5);
    const centers=[];let drawing=null;
    if(family==='drawing') {
      drawing=planDrawing(r,{progress,relief,previous:this.drawings,box:flow?.box,theme:flow?.theme});drawComposition(b,drawing);
      this.drawings.push(drawing.operation);if(this.drawings.length>3)this.drawings.shift();
    } else if(family==='river') {
      const a=parts(), bend=direction*between(r,70,115), y=between(r,240,290);
      stroke(a,cubic([[34,y-42],[130,y+bend],[270,y-bend],[366,y+42]]));
      const t=b.part('flow-notes');
      for(let k=0;k<11;k++)dot(t,55+k*29,185+Math.sin(k*.6+r())*18);
      for(let k=0;k<9;k++)dot(t,63+k*34,390+Math.sin(k*.65)*21);
    } else if(family==='islands') {
      const n=progress>.45?3:2;
      for(let j=0;j<n;j++) {
        const x=75+(j%2)*230+between(r,-12,12), y=176+j*(n===3?110:193), rad=between(r,47,61), a=parts();
        stroke(a,arc(x,y,rad,rad*.75,j%2?Math.PI*.75:Math.PI*.1,j%2?Math.PI*2.3:Math.PI*1.65));
        centers.push({x,y}); dot(a,x,y);
        for(let k=0;k<5;k++){const t=k*TAU/5;dot(a,x+(rad+28)*Math.cos(t),y+(rad*.75+26)*Math.sin(t));}
      }
    } else if(family==='orchard') {
      const a=parts(), lobes=choose(r,[2,3,4]), rx=between(r,113,151), ry=between(r,102,135);
      const c=transform(polarContour({rx,ry,lobes,amplitude:between(r,.04,.15),phase:r()*TAU}),{x:200,y:290});
      b.dots(a,c,{spacing:29,scale:1});
      const inner=b.part('fruit-phrases');
      for(let row=0;row<3;row++)for(let col=0;col<4;col++)dot(inner,150+col*34+Math.sin(row*1.3)*14,235+row*50);
    } else if(family==='slalom') {
      for(let j=0;j<3;j++){
        const a=parts(), side=direction*(j%2?1:-1), x=200+side*110,y=155+j*116;
        stroke(a,cubic([[x-side*75,y-12],[x+side*35,y-13],[x+side*35,y+44],[x-side*42,y+63]]));
        const notes=b.part('side-phrase');for(let k=0;k<4;k++)dot(notes,200-side*(35+k*34),y+30);
      }
    } else if(family==='orbits') {
      const n=choose(r,progress>.55?[2,3]:[2]), main=between(r,67,83);
      for(let j=0;j<n;j++){
        const a=parts(), x=j%2?286:111,y=n===2?200+j*183:168+j*128, rad=n===3?between(r,43,55):main;
        const ring=stroke(a,arc(x,y,rad,rad*.76,.3,TAU-.45));
        b.animate(a,ring,{x,y},{rotation:direction*TAU,duration:between(r,9,14),cycle:true});
        const inner=b.part('orbit-core');for(let k=0;k<7;k++){const t=k*TAU/7;dot(inner,x+rad*.38*Math.cos(t),y+rad*.30*Math.sin(t));}
      }
    } else if(family==='petals') {
      const a=parts(), x=200,y=286,reach=between(r,90,116), n=choose(r,progress>.5?[3,4,5]:[3,4]);
      const ps=[];
      for(let k=0;k<n;k++){
        const t=k*TAU/n+r()*.15, p=(rad,d)=>[x+rad*Math.cos(d),y+rad*Math.sin(d)];
        ps.push(...stroke(a,cubic([p(32,t),p(reach*.8,t-.45),p(reach,t+.15),p(reach*.88,t+.62)])));
      }
      b.animate(a,ps,{x,y},{rotation:direction*TAU,duration:2.5,hitTrigger:true,hitMode:'spin',hitSteps:n});
      const outer=b.part('petal-orbit');b.dots(outer,arc(x,y,154,159),{spacing:31});
      b.bumper(b.part('hub'),x,y,1.35);
    } else if(family==='branch') {
      const a=parts(), roots=[{x:200+direction*35,y:420}], heads=[];
      const levels=progress>.65?3:2;
      for(let depth=0;depth<levels;depth++){
        const next=[];
        for(const root of roots.splice(0))for(const s of [-1,1]) {
          const spread=(depth===0?93:depth===1?47:24), tip={x:root.x+s*spread,y:root.y-(depth===0?116:depth===1?83:60)};
          stroke(a,cubic([[root.x,root.y-13],[root.x+s*spread*.1,root.y-41],[tip.x,tip.y+30],[tip.x,tip.y]]));
          next.push(tip);heads.push(tip);
        }
        roots.push(...next);
      }
      const fruit=b.part('branch-fruit');for(const tip of heads)dot(fruit,tip.x,tip.y-20);
      for(const x of [53,347])for(const y of [166,231,302,387])dot(fruit,x,y);
    } else if(['release','balance','field'].includes(family)) {
      const left=direction>0?97:303, right=400-left;
      source(b,{id:b.id+':source',x:left,y:174,w:74,count:progress>.5?4:3});
      if(family==='balance') {
        carrier(b,{id:b.id+':balance',bays:[{x:113,y:295,w:126,depth:50,floor:43},{x:282,y:315,w:120,depth:62,floor:44}],pivot:{x:199,y:257},direction:0});
      } else {
        reservoir(b,{id:b.id+':receive',x:left+direction*29,y:306,w:145,depth:69,kinetic:progress>.35,direction,bias:between(r,-.3,.3)});
        if(family==='field')b.field(b.part('cargo-field'),left+direction*65,235,{radius:85,strength:.23,mode:choose(r,['attract','repel'])});
      }
      const a=b.part('outlet-bank');
      stroke(a,cubic([[right-direction*61,345],[right-direction*65,407],[right+direction*41,421],[right+direction*57,382]]));
      const accents=b.part('transfer-notes');for(let k=0;k<7;k++)dot(accents,200+Math.sin(k*.8)*38,140+k*43);
    } else if(family==='portal') {
      const a=parts(), x=direction>0?72:328;
      stroke(a,cubic([[35,243],[131,213],[247,340],[365,310]]));
      const pair=b.id+':portals';
      b.peg(b.part('return-outlet'),400-x,170,{type:'portalBlue',angle:0,portalPairId:pair,portalScale:1.2});
      b.peg(b.part('return-inlet'),x,402,{type:'portalOrange',angle:0,portalPairId:pair,portalScale:1.2});
      const a2=b.part('portal-targets');
      for(let row=0;row<3;row++)for(let k=0;k<6;k++)dot(a2,75+k*50,135+row*118+Math.sin(k*.8)*17);
    }

    this.exitX=exit;
    // Limited accents follow the gesture, not a common grid pasted behind it.
    if(!['drawing','orchard','river','petals','slalom','portal'].includes(family)) {
      const accents=b.part('open-space-notes');
      if(forced)for(let k=0;k<8;k++)dot(accents,between(r,45,355),between(r,133,450));
    }

    if(flow) {
      if(family!=='drawing') {
        const dy=flow.box.y-299;
        for(const p of b.pegs){p.y+=dy;for(const s of p.curveSlices||[])s.y+=dy;}
      }
      const offset=this.cursorY-140;
      drawFlow(b,flow,[...drawingVoids(drawing),...this.voids.map(v=>({...v,y:v.y-offset}))]);
    }

    // A fast local safety filter protects the shape, rather than designing it.
    // The gesture and response above are chosen before collision constraints.
    const reject=new Set();
    for(const p of b.pegs)p.radiusScale=1;
    for(let j=0;j<b.pegs.length;j++){
      const p=b.pegs[j], box=objectBounds(b.sized(p));
      if(box.minX<15||box.maxX>385||box.minY<(flow?90:100)||box.maxY>(flow?680:510)){reject.add(p.id);continue;}
      for(let k=0;k<j;k++) {
        const q=b.pegs[k];if(reject.has(q.id)||p.bezierGroupId&&p.bezierGroupId===q.bezierGroupId)continue;
        if(overlapDepth(b.sized(p),b.sized(q))>.6){reject.add(p.id);break;}
      }
    }
    // Preserve whole moving bodies if any authored part would be rejected.
    const badBodies=new Set(b.pegs.filter(p=>reject.has(p.id)&&p.groupId).map(p=>p.groupId));
    b.pegs=b.pegs.filter(p=>!reject.has(p.id)&&!badBodies.has(p.groupId));
    b.groups=b.groups.filter(g=>b.pegs.some(p=>p.groupId===g.id));
    const firstY=Math.min(...b.pegs.map(p=>objectBounds(b.sized(p)).minY)),lastY=Math.max(...b.pegs.map(p=>objectBounds(b.sized(p)).maxY));
    const offset=this.cursorY-(flow?140:firstY);
    for(const p of b.pegs){p.y+=offset;p.streamIndex=i;for(const s of p.curveSlices||[])s.y+=offset;}
    const retiredPegIds=[];
    if(flow) {
      const voids=drawingVoids(drawing).map(v=>({...v,y:v.y+offset}));
      retiredPegIds.push(...this.tail.filter(p=>p.flowVoice!==undefined&&insideDrawingVoid(p,voids)).map(p=>p.id));
      this.voids=[...this.voids,...voids].filter(v=>v.y+v.ry>this.cursorY-500);
      const tail=this.tail.map(p=>({p,q:b.sized(p)}));for(const o of tail)o.q._ribbonBounds=objectBounds(o.q);
      const crossed=new Set();
      for(const p of b.pegs){
        const q=b.sized(p,1),box=objectBounds(q);q._ribbonBounds=box;
        let conflicts=false;
        for(const {p:o,q:oq} of tail){
          const ob=oq._ribbonBounds;
          if(ob.maxY<box.minY||ob.minY>box.maxY||overlapDepth(q,oq)<=.6)continue;
          // Future foreground drawings own their silhouette. A blue running
          // voice can rest around one, even when compiled by the earlier page.
          if(p.flowVoice===undefined&&o.flowVoice!==undefined)retiredPegIds.push(o.id);
          else conflicts=true;
        }
        if(conflicts)crossed.add(p.id);
      }
      const bodies=new Set(b.pegs.filter(p=>crossed.has(p.id)&&p.groupId).map(p=>p.groupId));
      b.pegs=b.pegs.filter(p=>!crossed.has(p.id)&&!bodies.has(p.groupId));
      b.groups=b.groups.filter(g=>b.pegs.some(p=>p.groupId===g.id));
      const retired=new Set(retiredPegIds);this.tail=this.tail.filter(p=>!retired.has(p.id));
    }

    const support=b.pegs.filter(p=>p.type==='blue'&&p.constructionRole!=='cargo'&&p.flowVoice===undefined);
    const wanted=Math.min(support.length,Math.max(7,Math.round(((relief?9:12)+progress*7)*(flow?flow.advance/350:1))));
    const order=support.map(p=>({p,t:r()}));
    // Targets are runs inside drawn objects, never an orange divider row.
    // Loose cargo stays blue, so its legitimate release cannot cause a loss.
    const runs=new Map();for(const {p} of order){const key=p.constructionAssembly;const rows=runs.get(key)||[];rows.push(p);runs.set(key,rows);}
    let assigned=0;for(const row of runs.values()) {
      const n=Math.max(1,Math.round(wanted*row.length/Math.max(1,support.length))), start=Math.floor(r()*Math.max(1,row.length-n));
      for(const p of row.slice(start,start+n)){if(assigned>=wanted)break;p.type='orange';assigned++;}
    }
    order.sort((a,b)=>a.t-b.t);for(const {p} of order)if(assigned<wanted&&p.type==='blue'){p.type='orange';assigned++;}

    // Reward an existing contour/opening. No extra peg, centre-first search,
    // header space or index cadence can reveal where compiler pages begin.
    let rescue=null;
    const distance=flow?.distance||i*350;
    if(distance>=this.nextReliefAt) {
      const target={x:flow?flow.box.x+flow.side*flow.box.w*between(r,-.25,.25):between(r,70,330),
        y:(flow?flow.box.y:between(r,220,400))+offset+between(r,-60,75)};
      const eligible=b.pegs.filter(p=>p.type==='blue'&&!p.groupId&&p.destructionStatic&&p.flowVoice===undefined&&
        !['cargo','release-floor','receiver-wall','bearing','bearing-arm','carrier-wall'].includes(p.constructionRole));
      const score=p=>Math.hypot(p.x-target.x,p.y-target.y)+(p.shape==='brick'?25:0);
      eligible.sort((a,b)=>score(a)-score(b));rescue=eligible[0]||null;
      if(rescue){Object.assign(rescue,{type:'gamble',gambleBallCount:0,gambleLuckBonus:0,gambleKnockbackEnabled:true,
        gambleKnockbackDistance:Math.round(100+progress*30),gambleKnockbackSmoothMs:180});
        this.nextReliefAt=distance+between(r,370,670);}
    }
    if(i>2&&r()<.20){
      const p=choose(r,b.pegs.filter(p=>p.type==='blue'&&p.shape==='circle'&&p.destructionStatic&&!p.groupId&&p.flowVoice===undefined));
      if(p)Object.assign(p,{type:'multi',multiballSpawnCount:2});
    }
    const height=flow?flow.advance:Math.round(lastY-firstY+between(r,26,45));this.cursorY+=height;
    if(flow)this.tail=appendToTail(this.tail,b.pegs,this.cursorY,b);
    return {index:i,family,drawing,flow,retiredPegIds:[...new Set(retiredPegIds)],relief,entryX:entry,exitX:exit,progress,height,pegs:b.pegs,groups:b.groups,
      targets:b.pegs.filter(p=>p.type==='orange').length,knockback:rescue&&b.pegs.includes(rescue)?rescue.id:null};
  }

  rebase(distance){
    this.cursorY-=distance;for(const v of this.voids)v.y-=distance;
    for(const p of this.tail){p.y-=distance;for(const s of p.curveSlices||[])s.y-=distance;}
  }
}

export function createSurvivalLevel(seed='survival-01') {
  return {version:1,id:'survival-'+seed,name:'Бесконечное течение',pegs:[],groups:[],pegRadius:8.5,
    bucketEnabled:false,ballCount:99,hitPegTimedClearEnabled:true,hitPegClearDelayMs:HIT_PEG_CLEAR_DELAY_DEFAULT_MS,
    destruction:{enabled:true},survival:{enabled:true,endless:true,seed,scrollSpeed:BASE_SCROLL_SPEED,antiCooldownMs:RECHARGE_MS,loseLineY:32},
    metadata:{generator:{name:'survival-stream',version:'0.2',seed},authorNotes:'Сбивай оранжевые, пока они не поднялись к пушке. Золотые пеги отбрасывают поле вниз. Новый шар каждые 1,6 секунды.'}};
}
