import {randomFrom, generateLevel as generateDesLevel, FAMILIES} from '../destruction/grammar.js';

export const MODES = Object.freeze([
  {id:'auto',name:'Свободная композиция'}, {id:'compose',name:'Механическая мастерская'},
  {id:'cascade',name:'Каскад среди конструкций'}, {id:'merge',name:'Общий пересып'},
  {id:'parallel',name:'Две ветки'}, {id:'portal',name:'Портальная мастерская'},
  {id:'magnet',name:'Магнитная мастерская'}, {id:'cross',name:'Перекрёстный пересып'}
]);
const round=n=>Math.round(n*1e6)/1e6;
const pick=(rng,values)=>values[Math.floor(rng()*values.length)];
const BUILDINGS=['tower','seesaw','cage','cradle'];

// This is a design plan, never a player objective. Flow edges describe intended
// spatial relationships; the player may break any part in any order.
export function planIntents(seed,mode='auto') {
  if(!MODES.some(m=>m.id===mode))throw Error('Unknown composition mode');
  if(mode==='auto')mode=pick(randomFrom(seed+':mode'),MODES.slice(1).map(m=>m.id));
  const rng=randomFrom(seed+':plan'), mirror=rng()<.5?1:-1;
  const topology=mode==='compose'?pick(rng,['single','parallel','merge']):mode;
  const parallel=topology==='parallel'||topology==='cross';
  const sources=parallel||topology==='merge'?2:1;
  const depth=sources===1&&['cascade','compose'].includes(mode)?pick(rng,[1,2]):1;
  const transport=mode==='compose'&&sources===1?pick(rng,['none','portal','magnet']):mode;
  const portal=transport==='portal'||mode==='cross',magnet=transport==='magnet'&&sources===1;
  const mainX=mirror>0?108:292, freeX=400-mainX;
  const buildings=Array.from({length:sources===2?2:4},()=>pick(rng,BUILDINGS));
  // A low catcher also belongs to the old /des vocabulary. Avoid tall towers
  // immediately below the last bowl, leaving room for falling pegs.
  if(sources===1)buildings[3]=pick(rng,['cage','seesaw']);
  return {mode,topology,sources,parallel,depth,mirror,mainX,freeX,portal,magnet,
    crossed:mode==='cross',radius:sources===2&&!parallel?56+rng()*3:44+rng()*4,
    firstMouth:depth===2?264+rng()*8:278+rng()*12,
    sourceY:145+rng()*8,slope:.16+rng()*.06,
    sourceKind:Array.from({length:sources},()=>parallel?'hopper':pick(rng,['ramp','hopper'])),
    receiverKind:Array.from({length:parallel?2:depth},()=>pick(rng,['tilt','break'])),buildings};
}

export function generateIntentLevel(seed='des1-001',mode='auto') {
  const plan=planIntents(seed,mode),rng=randomFrom(seed+':geometry');
  const id='des1-'+plan.mode+'-'+String(seed).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,48);
  const pegs=[],groups=[],assemblies=[],flow=[];let serial=0;
  const peg=(x,y,type='blue',extra={})=>{
    const p={id:id+':p'+(++serial),x:round(x),y:round(y),type,shape:'circle',angle:0,
      destructionStatic:false,destructionPhysicsOnHit:false,...extra};pegs.push(p);return p;
  };
  const brick=(x,y,width,height,angle=0,type='blue',extra={})=>peg(x,y,type,
    {shape:'brick',width:round(width),height:round(height),angle:round(angle),brickBaseRadius:8.5,...extra});
  const asleep={destructionPhysicsOnHit:true,destructionPhysicsOnHitBallOnly:true};
  const fixed={destructionStatic:true};
  const label=(p,a,role)=>{p.constructionAssembly=a.id;p.constructionRole=role;a.pegs.push(p.id);return p;};
  const assembly=(kind,geometry)=>{const a={id:id+':assembly'+assemblies.length,type:kind,pegs:[],geometry};assemblies.push(a);return a;};
  const connect=(from,to,action)=>flow.push({from:from.id,to:to.id,action});

  function source(index,cx,direction) {
    const kind=plan.sourceKind[index],cy=plan.sourceY+(index?5:0),width=80;
    const angle=kind==='ramp'?direction*plan.slope:0,c=Math.cos(angle),s=Math.sin(angle);
    const a=assembly(kind,{x:cx,y:cy,width,angle,direction});
    let gate;
    if(kind==='ramp') {
      label(brick(cx,cy,width,8,angle,'obstacle',fixed),a,'slope');
      gate=label(peg(cx+direction*(width/2-3)*c+s*12.5,cy+direction*(width/2-3)*s-c*12.5,'orange',asleep),a,'release-gate');
    } else {
      const groupId=a.id+':trapdoor';groups.push({id:groupId,name:'Створка',pattern:'construction',destructionBody:true});
      label(brick(cx,cy,width,8,0,'obstacle',{...asleep,groupId,destructionHinge:{pivotFraction:direction>0?.15:.85,
        minAngle:direction>0?0:-1.32,maxAngle:direction>0?1.32:.03,damping:.997,stopBounce:.02}}),a,'trapdoor');
      gate=label(peg(cx+direction*(width/2+12),cy-5,'orange',{...asleep,groupId}),a,'release-handle');
    }
    a.cargoIds=[];a.triggerIds=[gate.id];
    for(let k=0;k<4;k++) {
      const offset=kind==='ramp'?direction*(width/2-22-k*17.8):(k-1.5)*17.8;
      // Ordinary blue/orange pegs: hittable, clearable, and cleared on falling
      // by the unchanged destruction engine. No permanent cargo balls.
      const p=label(peg(cx+offset*c+s*12.5,cy+offset*s-c*12.5,k===1?'blue':'orange'),a,'cargo');a.cargoIds.push(p.id);
    }
    a.geometry.outletX=kind==='ramp'?gate.x:cx-direction*width*.18;
    return a;
  }

  function cup(cx,mouth,radius,direction,upstream,kind) {
    const a=assembly('cup',{kind,x:cx,mouthY:mouth,radius,direction});
    const cy=mouth-radius*.5,a0=Math.PI/6,span=Math.PI*2/3,segments=7+Math.floor(rng()*2),groupId=a.id+':vessel';
    if(kind==='tilt')groups.push({id:groupId,name:'Опрокидываемая чаша',pattern:'construction',destructionBody:true});
    a.triggerIds=[];
    for(let k=0;k<segments;k++) {
      const angle=a0+span*(k+.5)/segments,half=span/segments/2;
      const curveSlices=Array.from({length:7},(_,j)=>{const t=angle-half+j*half*2/6;return {x:round(cx+radius*Math.cos(t)),y:round(cy+radius*Math.sin(t)),nx:Math.cos(t),ny:Math.sin(t)};});
      const p=label(brick(cx+radius*Math.cos(angle),cy+radius*Math.sin(angle),radius*span/segments,7.6,angle+Math.PI/2,'blue',
        {curveSlices,...(kind==='tilt'?{...asleep,groupId}:fixed)}),a,'receiver-wall');a.triggerIds.push(p.id);
    }
    if(kind==='tilt') {
      const hingeX=cx-direction*radius*Math.cos(a0);
      const p=label(brick(hingeX,mouth,24,7.6,0,'blue',{...asleep,groupId,destructionHinge:{pivotFraction:.5,
        minAngle:direction>0?0:-1.32,maxAngle:direction>0?1.32:.03,damping:.997,stopBounce:.02}}),a,'pour-handle');a.triggerIds.push(p.id);
    }
    for(const from of upstream)connect(from,a,'fall-into-cup');return a;
  }

  function portal(from,targetX,mouth) {
    const a=assembly('portal',{x:targetX,mouthY:mouth}),g=from.geometry;
    const entry=label(peg(g.outletX+g.direction*18,g.y+60,'portalBlue',{...fixed,portalScale:3.4,portalOneWay:true,portalOneWayFlip:false}),a,'transport-entry');
    const exit=label(peg(targetX,mouth-50,'portalOrange',{...fixed,portalScale:3.4,portalOneWay:true,portalOneWayFlip:true}),a,'transport-exit');
    entry.portalTargetId=exit.id;exit.portalTargetId=entry.id;
    a.entryId=entry.id;a.exitId=exit.id;connect(from,a,'portal-transfer');return a;
  }

  function magnet(from) {
    const g=from.geometry,x=g.outletX+g.direction*20,y=g.y+75,a=assembly('magnet',{x,y});
    label(peg(x,y,'bombMagnet',{...fixed,magnetRadius:48,magnetStrength:.9,magnetMode:'attract',magnetBlast:false,
      magnetHittable:true,magnetKnockout:true}),a,'magnetic-field');connect(from,a,'magnetic-deflection');return a;
  }

  function building(kind,cx,base,index) {
    const family=FAMILIES.find(f=>[f.primary,f.secondary,f.core].includes(kind));
    const template=generateDesLevel(seed+':building:'+index,family.id);
    const original=template.metadata.generator.plan.assemblies.find(a=>a.type===kind);
    const a=assembly(kind,{x:cx,y:base,source:'destruction_generator0.1'}),dx=cx-original.x,dy=base-original.y;
    const oldPegs=template.pegs.filter(p=>original.pegs.includes(p.id));
    const ids=new Map(oldPegs.map(p=>[p.id,id+':p'+(++serial)]));
    const groupIds=new Map(oldPegs.filter(p=>p.groupId).map(p=>[p.groupId,a.id+':'+p.groupId.split(':').at(-1)]));
    for(const old of oldPegs) {
      const p=structuredClone(old);p.id=ids.get(old.id);p.x=round(p.x+dx);p.y=round(p.y+dy);p.constructionAssembly=a.id;
      if(p.groupId)p.groupId=groupIds.get(p.groupId);
      if(p.curveSlices)p.curveSlices=p.curveSlices.map(s=>({...s,x:round(s.x+dx),y:round(s.y+dy)}));
      pegs.push(p);a.pegs.push(p.id);
    }
    for(const g of template.groups)if(groupIds.has(g.id))groups.push({...structuredClone(g),id:groupIds.get(g.id)});
    a.supportContacts=original.supportContacts;a.trigger=original.trigger;return a;
  }

  let receivers=[];
  if(plan.sources===2) {
    const sources=[source(0,82,1),source(1,318,-1)];
    if(plan.parallel)for(let i=0;i<2;i++) {
      const target=plan.crossed?1-i:i,cx=target?294:106,direction=target?-1:1;
      const upstream=plan.portal?portal(sources[i],cx,plan.firstMouth):sources[i];
      receivers.push(cup(cx,plan.firstMouth,plan.radius,direction,[upstream],plan.receiverKind[i]));
    } else receivers=[cup(200,plan.firstMouth,plan.radius,plan.mirror,sources,plan.receiverKind[0])];
    for(let i=0;i<2;i++) {
      const b=building(plan.buildings[i],i?294:106,508+i*8,i);
      for(const r of receivers)connect(r,b,'fall-to-lower-constructions');
    }
  } else {
    const direction=plan.mirror;
    let sourceX=plan.portal?plan.freeX:plan.mainX;
    if(plan.sourceKind[0]==='ramp')sourceX-=direction*22;
    const s=source(0,sourceX,direction);
    let upstream=s,cx=plan.mainX;
    if(plan.portal)upstream=portal(s,cx,plan.firstMouth);
    if(plan.magnet){upstream=magnet(s);cx=upstream.geometry.x;}
    let r=cup(cx,plan.firstMouth,plan.radius,direction,[upstream],plan.receiverKind[0]);
    if(plan.depth===2)r=cup(cx+direction*18,408+rng()*6,plan.radius-2,-direction,[r],plan.receiverKind[1]);
    receivers=[r];
    const bases=plan.portal?[332,492]:[234,382,526];
    for(let i=0;i<bases.length;i++)building(plan.buildings[i],plan.freeX,bases[i],i);
    const catcher=building(plan.buildings[3],plan.depth===2?cx+direction*18:cx,532,3);
    connect(r,catcher,'fall-to-lower-construction');
  }
  const explanation='Обычный destruction-уровень. Пересыпы, чаши и механизмы связаны расположением и настоящей физикой; разрушать их можно в любом порядке.';
  return {version:1,id,name:MODES.find(m=>m.id===plan.mode).name+' · '+seed,pegRadius:8.5,ballCount:12,bucketEnabled:true,
    hitPegTimedClearEnabled:true,hitPegClearDelayMs:1100,pegs,groups,bezierCurves:{},flippers:null,
    destruction:{enabled:true,gravityX:0,gravityY:.115,damping:.994,restitution:.34,friction:.72,surfaceGrip:.18,
      dynamicPegBallBounce:.45,maxSpeed:14,sleepSpeed:.055,sleepFrames:18,bombImpulse:12,stuckPileClearDelayMs:220},
    metadata:{authorNotes:explanation,generator:{name:'destruction_compositions',version:'2.0.0',seed,mode:plan.mode,
      plan:{...plan,assemblies,flow}}}};
}
