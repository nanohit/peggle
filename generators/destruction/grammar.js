import { createSeesaw } from '../../js/destruction-hinge.js';

export const FAMILIES = Object.freeze([
  {id:'counterweights',name:'Противовесы',primary:'seesaw',secondary:'tower',core:'bridge',hint:'Освободите груз на одном конце качелей: второй конец изменит наклон.'},
  {id:'courtyards',name:'Дворики',primary:'tower',secondary:'seesaw',core:'cage',hint:'Выбейте опору. Перекрытие и его груз упадут на нижний этаж.'},
  {id:'bridges',name:'Разводные мосты',primary:'tower',secondary:'cage',core:'bridge',hint:'Центральный замок удерживает две половины моста.'},
  {id:'cradles',name:'Подвесные люльки',primary:'cradle',secondary:'tower',core:'seesaw',hint:'Сильный удар по подвесной раме ломает крепление и освобождает груз.'},
  {id:'cages',name:'Клетки и колёса',primary:'cage',secondary:'seesaw',core:'cradle',hint:'Замкнутое колесо держит груз. Разбейте обод, чтобы он высыпался.'},
  {id:'dominoes',name:'Домино из перекрытий',primary:'tower',secondary:'cradle',core:'bridge',hint:'Сначала верхняя опора: падающее перекрытие может запустить следующий механизм.'},
  {id:'spillways',name:'Пересыпные станции',primary:'seesaw',secondary:'cradle',core:'cage',hint:'Груз с верхних качелей попадает в нижние конструкции.'},
  {id:'workshops',name:'Механические мастерские',primary:'cradle',secondary:'cage',core:'bridge',hint:'Сочетайте удар по замку, разрушение опоры и перевес качелей.'}
]);
export function randomFrom(seed) {
  let state=2166136261;for(const c of String(seed))state=Math.imul(state^c.charCodeAt(0),16777619);
  return ()=>{state+=0x6D2B79F5;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
}
const round=x=>Math.round(x*1e6)/1e6;

export function generateLevel(seed='des-001',familyId='counterweights') {
  const family=FAMILIES.find(f=>f.id===familyId);if(!family)throw Error('Unknown destruction family');
  const rng=randomFrom(seed);const pegs=[],groups=[],assemblies=[];let serial=0;
  const id='des-'+family.id+'-'+String(seed).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
  const sphere=(x,y,type='orange',extra={})=>({id:id+':p'+(++serial),shape:'circle',type,x:round(x),y:round(y),angle:0,
    destructionStatic:false,destructionPhysicsOnHit:false,...extra});
  const plank=(x,y,width,height=10.2,angle=0,type='obstacle',extra={})=>({id:id+':p'+(++serial),shape:'brick',type,
    x:round(x),y:round(y),width:round(width),height:round(height),angle:round(angle),brickBaseRadius:8.5,
    destructionStatic:false,destructionPhysicsOnHit:false,...extra});
  const put=p=>{pegs.push(p);return p;};
  let current;
  const cargo=(cx,base,rows=[4,3],slope=0)=>{
    let target=0;
    for(let row=0;row<rows.length;row++)for(let col=0;col<rows[row];col++){
      const x=(col-(rows[row]-1)/2)*17.6;
      const type=(col+row+current.index)%3===0?'blue':'orange';
      put(sphere(cx+x,base-row*15.25+x*Math.sin(slope),type,{constructionAssembly:current.id,constructionRole:'cargo'}));
      if(type==='orange')target++;
    }
    return target;
  };
  function tower(cx,base,w,index) {
    const span=Math.min(78,w*.63),height=43+Math.round(rng()*12);
    for(const side of [-1,1]){
      put(plank(cx+side*span/2,base,26,8,0,'obstacle',{destructionStatic:true,constructionRole:'foundation'}));
      put(plank(cx+side*span/2,base-4-height/2,height,10.2,Math.PI/2,'blue',{
        constructionRole:'key-support',destructionPhysicsOnHit:index%3===1,
        destructionPhysicsOnHitBallOnly:index%3===1}));
    }
    const roofY=base-4-height-5.1;
    put(plank(cx,roofY,span+28,10.2,0,'obstacle',{constructionRole:'roof'}));
    cargo(cx,roofY-13.8,index%2?[4,3]:[4,3,2]);
    current.trigger='remove-support';current.supportContacts=[['foundation','key-support'],['key-support','roof'],['roof','cargo']];
  }
  function seesaw(cx,base,w,index) {
    const built=createSeesaw({id:current.id,x:cx,y:base-32,width:w,minAngle:-.70,maxAngle:.70});
    pegs.push(...built.pegs);groups.push(...built.groups);
    cargo(cx,base-45.8,index%2?[4,3]:[4,3,2]);
    current.trigger='change-load-or-hit-edge';current.supportContacts=[['bearing','beam'],['beam','cargo']];
  }
  function cage(cx,base,w,index) {
    const radius=34+(index%2)*3,cy=base-radius-8;
    const groupId=current.id+':ring';groups.push({id:groupId,name:'Разрушаемый обод',pattern:'construction',destructionBody:true});
    for(let k=0;k<8;k++){
      const a=k*Math.PI/4,half=Math.PI/8;
      const slices=Array.from({length:6},(_,s)=>{const t=a-half+s*2*half/5;return {x:cx+radius*Math.cos(t),y:cy+radius*Math.sin(t),nx:Math.cos(t),ny:Math.sin(t)};});
      put(plank(cx+radius*Math.cos(a),cy+radius*Math.sin(a),radius*Math.PI/4,8,a+Math.PI/2,'blue',{
        groupId,curveSlices:slices,constructionRole:'breakable-shell'}));
    }
    put(plank(cx,base,76,8,0,'obstacle',{destructionStatic:true,constructionRole:'foundation'}));
    cargo(cx,cy+12,[3,2,1]);
    current.trigger='fracture-shell';current.supportContacts=[['foundation','breakable-shell'],['breakable-shell','cargo']];
  }
  function cradle(cx,base,w,index) {
    const width=92,height=58,top=base-height-12,bottom=base-12;
    const g=current.id+':frame';groups.push({id:g,name:'Подвесная рама',pattern:'construction',destructionBody:true});
    put(plank(cx,top,width,8,0,'obstacle',{groupId:g,constructionRole:'breakable-anchor',
      destructionHinge:{pivotFraction:.5,minAngle:-.7,maxAngle:.7,damping:.997,stopBounce:.05,breakImpulse:7.0}}));
    for(const side of [-1,1])put(plank(cx+side*(width-8)/2,(top+bottom)/2,height,8,Math.PI/2,'obstacle',{groupId:g,constructionRole:'hanging-wall'}));
    put(plank(cx,bottom,width,8,0,'obstacle',{groupId:g,constructionRole:'tray'}));
    put(plank(cx,top-17,8,14,0,'obstacle',{destructionStatic:true,constructionRole:'wall-hook'}));
    cargo(cx,bottom-12.8,[4,3]);
    current.trigger='break-anchor';current.supportContacts=[['wall-hook','breakable-anchor'],['breakable-anchor','tray'],['tray','cargo']];
  }
  function bridge(cx,base,w,index) {
    for(const side of [-1,1]){
      const built=createSeesaw({id:current.id+(side<0?':left':':right'),x:cx+side*55,y:base-28,width:80,
        pivotFraction:side<0?.2:.8,minAngle:-.65,maxAngle:.65});
      pegs.push(...built.pegs);groups.push(...built.groups);
      cargo(cx+side*55,base-41.8,[3,2]);
      // Fixed guide posts keep rolling cargo out of the shooting channel while
      // the bridge is closed. Once a leaf drops, cargo can pass underneath.
      put(plank(cx+side*18,base-48,6,26,0,'obstacle',{destructionStatic:true,constructionRole:'cargo-guide'}));
      put(plank(cx+side*94,base-48,6,26,0,'obstacle',{destructionStatic:true,constructionRole:'cargo-guide'}));
    }
    // Thirty-pixel opening admits the native 17px ball. A visible crossbar under
    // the opening supports both leaves and can actually be hit from above.
    put(plank(cx,base-17.8,44,10.2,0,'blue',{destructionPhysicsOnHit:true,destructionPhysicsOnHitBallOnly:true,constructionRole:'bridge-lock'}));
    current.shooterOpening=30;
    current.trigger='remove-central-lock';current.supportContacts=[['bridge-lock','beam'],['bearing','beam'],['beam','cargo']];
  }
  const recipes={tower,seesaw,cage,cradle,bridge};
  const columns=[96+(rng()-.5)*10,304+(rng()-.5)*10];
  const top=245+(rng()-.5)*14,bottom=510+(rng()-.5)*12;
  const modules=[
    {type:family.primary,x:columns[0],y:top,width:120},
    {type:family.primary,x:columns[1],y:top+Math.round((rng()-.5)*12),width:120},
    {type:family.secondary,x:columns[0]+Math.round((rng()-.5)*12),y:bottom,width:124},
    {type:family.secondary,x:columns[1]+Math.round((rng()-.5)*12),y:bottom-8,width:124},
    {type:family.core,x:200+(rng()-.5)*12,y:375,width:122}
  ];
  for(const [index,m] of modules.entries()){
    current={id:id+':assembly'+index,index,...m,pegs:[],supportContacts:[]};const start=pegs.length;
    recipes[m.type](m.x,m.y,m.width,index);
    for(const peg of pegs.slice(start)){peg.constructionAssembly=current.id;current.pegs.push(peg.id);}
    assemblies.push(current);
  }
  return {version:1,id,name:family.name+' · '+seed,pegRadius:8.5,ballCount:8,bucketEnabled:true,
    hitPegTimedClearEnabled:true,hitPegClearDelayMs:1100,pegs,groups,bezierCurves:{},flippers:null,
    destruction:{enabled:true,gravityX:0,gravityY:.115,damping:.994,restitution:.34,friction:.72,surfaceGrip:.18,
      dynamicPegBallBounce:.45,maxSpeed:14,sleepSpeed:.055,sleepFrames:18,bombImpulse:12,stuckPileClearDelayMs:220},
    metadata:{authorNotes:family.hint,generator:{name:'destruction_generator0.1',version:'0.1.0',seed,family:family.id,
      principles:['physical-supports','load-transfer','gravity','fracture','hinges','ball-only-latches'],
      plan:{assemblies,flow:[{from:0,to:4},{from:1,to:4},{from:4,to:2},{from:4,to:3}],
        shooterClearance:90,bucketClearance:45,pegRadius:8.5}}}};
}
