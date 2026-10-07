if (typeof window === 'undefined') {
  const memory=new Map();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)}});
}
const {Game}=await import('../../js/game.js');
const {PHYSICS_CONFIG}=await import('../../js/physics.js');
const {DestructionPegSystem}=await import('../../js/destruction-mode.js');
const {setMuted}=await import('../../js/haptics.js');
// Headless evaluation has no audio hardware; muting also removes its idle timer.
setMuted(true);
const nativeContact=DestructionPegSystem.prototype.resolveBodyCollision;
DestructionPegSystem.prototype.resolveBodyCollision=function(a,b,overlap,...args){
  if(this.simContacts&&args[2]!==false){
    const left=a.peg?.constructionAssembly,right=b.peg?.constructionAssembly;
    const speed=Math.hypot((a.body?.vx||0)-(b.body?.vx||0),(a.body?.vy||0)-(b.body?.vy||0));
    if(left&&right&&left!==right&&speed>1.2){
      const key=[left,right].sort().join('|');this.simContacts.set(key,Math.max(speed,this.simContacts.get(key)||0));
    }
  }
  return nativeContact.call(this,a,b,overlap,...args);
};
export const STEP_MS=1000/120;
export function seededRandom(seed,initialState=null){
  let state=2166136261;for(const c of String(seed))state=Math.imul(state^c.charCodeAt(0),16777619);
  if(initialState!==null)state=initialState;
  const next=()=>{state+=0x6D2B79F5;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
  next.clone=()=>seededRandom('',state);return next;
}
const canvas={width:400,height:600,addEventListener(){},removeEventListener(){},getBoundingClientRect(){return {left:0,top:0,width:400,height:600};}};
const noop=()=>null;
const renderer=new Proxy({canvas,width:400,height:600},{get:(object,key)=>key in object?object[key]:noop});
class HeadlessGame extends Game {
  constructor(){super(canvas,{renderer,bindInput:false});this.simMetrics={fallen:0,direct:0,hits:0};}
  handleDestructionFallenPegs(events){this.simMetrics.fallen+=events.filter(e=>this.isOrangePeg(e.peg)&&!this.hitPegIds.includes(e.peg.id)).length;return super.handleDestructionFallenPegs(events);}
  activatePeg(peg,ball,options){const orange=this.isOrangePeg(peg);const result=super.activatePeg(peg,ball,options);if(result&&ball){this.simMetrics.hits++;if(orange)this.simMetrics.direct++;}return result;}
}
function cloneRuntime(value,seen=new Map()){
  if(typeof value==='function')return value.clone?value.clone():value;
  if(!value||typeof value!=='object'||value===canvas||value===renderer)return value;
  if(seen.has(value))return seen.get(value);
  if(value instanceof AbortController)return new AbortController();
  if(ArrayBuffer.isView(value))return value.slice();
  if(value instanceof Map){const copy=new Map();seen.set(value,copy);for(const [k,v] of value)copy.set(cloneRuntime(k,seen),cloneRuntime(v,seen));return copy;}
  if(value instanceof Set){const copy=new Set();seen.set(value,copy);for(const v of value)copy.add(cloneRuntime(v,seen));return copy;}
  const copy=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));seen.set(value,copy);
  for(const key of Object.keys(value))copy[key]=cloneRuntime(value[key],seen);return copy;
}

// Every step is the real Game.update, with only rendering/input injected out.
// The virtual clock runs native game timers too. Forks clone the complete object
// graph (including solver contacts, COM, sleep state and random stream), preserving
// destroyed/deformed structures between shots rather than regenerating a level.
export class NativeSimulation {
  constructor(level,{seed='native'}={}){
    this.clock=0;this.timers=new Map();this.nextTimer=0;this.samples=[];this.shots=[];
    this.levelRadius=level.pegRadius||8.5;this.original=new Map(level.pegs.map(p=>[p.id,{x:p.x,y:p.y,type:p.type}]));
    this.scope(()=>{this.game=new HeadlessGame();this.game.physics.setRandomSource(seededRandom(seed));this.game.loadLevel(structuredClone(level));this.game.destructionSystem.simContacts=new Map();});
  }
  scope(action){
    const realPerformance=globalThis.performance,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout,config={...PHYSICS_CONFIG};
    Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>this.clock}});
    globalThis.setTimeout=(fn,delay=0,...args)=>{const id=++this.nextTimer;this.timers.set(id,{at:this.clock+Number(delay),source:String(fn),fn:()=>fn(...args)});return id;};
    globalThis.clearTimeout=id=>this.timers.delete(id);
    PHYSICS_CONFIG.pegRadius=this.levelRadius;
    try{return action();}finally{Object.assign(PHYSICS_CONFIG,config);globalThis.setTimeout=setTimer;globalThis.clearTimeout=clearTimer;Object.defineProperty(globalThis,'performance',{configurable:true,value:realPerformance});}
  }
  step(n,{trace=false}={}){
    for(let i=0;i<n;i++){
      this.clock+=STEP_MS;for(const [id,t] of this.timers)if(t.at<=this.clock){this.timers.delete(id);t.fn();}
      this.game.update(STEP_MS);
      if(this.game.pegs.some(p=>!Number.isFinite(p.x+p.y+(p.angle||0))))throw Error('Nonfinite body state');
      if(trace&&i%12===0)this.samples.push({time:this.clock,pegs:this.game.pegs.map(p=>({id:p.id,x:p.x,y:p.y,angle:p.angle})),balls:this.game.balls.filter(b=>b.active).map(b=>({x:b.x,y:b.y}))});
    }
  }
  settle(seconds){this.scope(()=>this.step(Math.round(seconds*120)));return this;}
  fork(){
    if(this.timers.size)throw Error('Cannot fork a native game with pending callbacks');
    const copy=Object.create(NativeSimulation.prototype);copy.clock=this.clock;copy.timers=new Map();copy.nextTimer=this.nextTimer;
    copy.game=cloneRuntime(this.game);copy.levelRadius=this.levelRadius;copy.original=this.original;
    copy.samples=[];copy.shots=this.shots.map(s=>({...s}));return copy;
  }
  shoot(angle,{maxShotSeconds=22,trace=false}={}){
    return this.scope(()=>{
      const g=this.game;if(g.state==='won'||g.state==='lost')return null;
      const before=g.getOrangePegsLeft(),start=this.clock,direct=g.simMetrics.direct,fallen=g.simMetrics.fallen,fired=g.shotsFired,hits=g.simMetrics.hits;
      g.aimAngle=angle;g.state='aiming';g.launch();if(g.shotsFired===fired)throw Error('Native launch did not fire');
      let steps=0;for(;steps<maxShotSeconds*120;steps++){this.step(1,{trace});if(['idle','won','lost'].includes(g.state))break;}
      const shot={angle,seconds:(this.clock-start)/1000,orangeBefore:before,orangeAfter:g.getOrangePegsLeft(),
        cleared:before-g.getOrangePegsLeft(),timeout:steps>=maxShotSeconds*120,state:g.state,
        fallenTargets:g.simMetrics.fallen-fallen,directTargets:g.simMetrics.direct-direct,hitCount:g.simMetrics.hits-hits};
      this.shots.push(shot);
      if(g.state==='idle'){
        this.step(72,{trace});
      }
      return shot;
    });
  }
  summary(){
    const g=this.game;return {complete:g.state==='won'||g.getOrangePegsLeft()===0,state:g.state,
      orangeLeft:g.getOrangePegsLeft(),orangeTotal:g.initialOrangePegs,fraction:1-g.getOrangePegsLeft()/Math.max(1,g.initialOrangePegs),
      fallenTargets:g.simMetrics.fallen,directTargets:g.simMetrics.direct,shots:this.shots,
      crossAssemblyImpacts:[...g.destructionSystem.simContacts.entries()].map(([pair,speed])=>({assemblies:pair.split('|'),speed})),
      maxDrift:Math.max(0,...g.pegs.map(p=>Math.hypot(p.x-this.original.get(p.id).x,p.y-this.original.get(p.id).y))),
      pose:g.pegs.map(p=>({...p})),bodies:[...g.destructionSystem.bodies.values()].map(b=>({id:b.id,x:b.x,y:b.y,angle:b.angle,sleeping:b.sleeping,hinge:!!b.hinge}))};
  }
}
export function simulateSequence(level,actions=[],{idleSeconds=2,seed='native',trace=false,afterSeconds=0,...options}={}){
  const sim=new NativeSimulation(level,{seed});sim.settle(idleSeconds);const start=sim.summary();
  for(const angle of actions){if(sim.summary().complete||sim.game.state==='lost')break;const shot=sim.shoot(angle,{...options,trace});if(shot?.timeout)break;}
  if(afterSeconds)sim.settle(afterSeconds);
  return {...sim.summary(),idle:{orangeLeft:start.orangeLeft,orangeTotal:start.orangeTotal,maxDrift:start.maxDrift,
    fallen:start.fallenTargets,pose:start.pose},...(trace?{samples:sim.samples}:{})};
}
