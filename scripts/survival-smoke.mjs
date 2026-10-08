import assert from 'node:assert/strict';
import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';
import {createSurvivalLevel,SurvivalGenerator,STREAM_ACTIONS,RECHARGE_MS} from '../generators/survival/grammar.js';
import {normalizeLevelData} from '../js/levels.js';
import {getPegVerticalExtent} from '../js/survival-mode.js';
import {HIT_PEG_CLEAR_DELAY_DEFAULT_MS} from '../js/hit-peg-clear-settings.js';
import {Ball} from '../js/physics.js';
import {Renderer} from '../js/renderer.js';

const make=seed=>new NativeSimulation(createSurvivalLevel(seed));
function install(sim,pegs){const g=sim.game;g.survivalStream=null;g.pegs=pegs;g.groups=[];g.physics.setPegs(pegs);g.animator.loadFromLevel(pegs,[]);g.destructionSystem.reset(pegs,[]);return g;}
const peg=(id,type,y=200)=>({id,type,x:200,y,shape:'circle',destructionStatic:true});
const normalized=normalizeLevelData(createSurvivalLevel('schema'));
assert(normalized.survival.enabled&&normalized.destruction.enabled&&normalized.survival.endless);
const sim=make('native-core');assert(sim.game.isSurvivalMode()&&sim.game.isDestructionMode());
assert.equal(sim.game.hitPegClearDelayMs,HIT_PEG_CLEAR_DELAY_DEFAULT_MS);
assert(sim.game.pegs.length>60);assert.equal(sim.game.getUiStateSnapshot().ballsLeft,Infinity);
assert.equal(sim.game.survivalRuntime.getScrollSpeed(),25);

// Drive actual browser frames at 60Hz. NativeSimulation normally supplies 120Hz
// input, which previously hid the reload transition's halved physics cadence.
{
 const previousRaf=globalThis.requestAnimationFrame;
 globalThis.requestAnimationFrame=()=>0;
 const drive=state=>{
  const s=make('browser-cadence'),g=install(s,[]),ball=new Ball(200,220);
  ball.launch(0,1);ball.gravityVector={x:0,y:0};g.balls=[ball];g.physics.setBalls(g.balls);
  g.state=state;g.setFrameRateCap(0);g._stopped=false;s.clock=1000;g.lastTime=s.clock;
  let steps=0;const update=g.physics.update.bind(g.physics);
  g.physics.update=(...args)=>{steps++;return update(...args);};
  s.scope(()=>{for(let i=0;i<60;i++){s.clock+=1000/60;g.gameLoop(s.clock);}});
  return {steps,x:ball.x,y:ball.y};
 };
 try{
  const flying=drive('playing'),reloaded=drive('idle');
  assert(flying.steps>=119);assert.deepEqual(reloaded,flying,'reload must preserve ball speed at 60Hz');
 }finally{if(previousRaf===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=previousRaf;}
}
{
 const s=make('loaded-anchor'),g=install(s,[]),flight=new Ball(200,260);
 flight.launch(0,.5);flight.gravityVector={x:0,y:0};g.balls=[flight];g.physics.setBalls(g.balls);
 g.survivalRuntime.setCameraY(200);g.ensureSurvivalLauncherBall();g.state='aiming';
 s.scope(()=>{
  for(let i=0;i<60;i++){s.step(1);assert(Math.abs(g.getLauncherBall().y-g.getCameraY()-40)<1e-8);}
  g.survivalRuntime.applyGambleKnockback(100,180);
  for(let i=0;i<24;i++){s.step(1);assert(Math.abs(g.getLauncherBall().y-g.getCameraY()-40)<1e-8);}
 });
}
{
 const r=Object.create(Renderer.prototype);
 for(const [camera,loaded] of [[0,true],[180,false],[4100,false],[1028,false],[1050,true]]){
  const props=r._collectPlayfieldProps({balls:[],launchX:200,launchY:camera+40,aimAngle:Math.PI/2,showLauncher:loaded});
  const gun=props.find(p=>p.shape==='ring');assert.equal(gun.y-camera,40,'GPU gun must follow scroll and rebasing during reload');
 }
}
{
 const s=make('no-final-slowmo'),g=install(s,[peg('last','orange',260)]);
 s.scope(()=>g.activatePeg(g.pegs[0],null));assert.equal(g._isLastPegSlowmoActive(),false);
 assert.equal(g._startLastPegSlowmo(),false);
 g._lastPegSlowmoElapsedMs=100;assert.equal(g._resolveTimeScale(16.67),1);
 const ordinary=new NativeSimulation({id:'ordinary-last',pegs:[peg('last','orange',260)],groups:[],ballCount:12});
 ordinary.scope(()=>ordinary.game.activatePeg(ordinary.game.pegs[0],null));
 assert(ordinary.game._isLastPegSlowmoActive());assert(ordinary.game._resolveTimeScale(150)<1,'ordinary final-peg effect remains');
}
console.log('ok browser 60Hz reload cadence, loaded ball and GPU gun camera anchors, survival slowmo disabled, ordinary effect retained');

for(const type of ['blue','multi','gamble','bumper','obstacle','portalBlue']){
 const s=make('boundary-'+type),g=install(s,[peg('boundary',type,20)]);
 s.scope(()=>g.checkSurvivalEndConditions());assert.notEqual(g.state,'lost',type+' must be allowed above the gun');
 assert.notEqual(g.state,'won','empty orange window must never complete the endless game');
 assert.equal(g.isLevelObjectiveComplete(),false);
}
{
 const s=make('orange-loss'),g=install(s,[peg('threat','orange',39)]);
 s.scope(()=>g.checkSurvivalEndConditions());assert.equal(g.state,'lost');
 const stopped=g.getCameraY();s.settle(2);assert.equal(g.getCameraY(),stopped,'loss freezes the stream');
}
{
 const s=make('hit-orange'),g=install(s,[peg('hit','orange',39)]);g.turnHitPegIds=['hit'];
 s.scope(()=>g.checkSurvivalEndConditions());assert.equal(g.state,'idle','a pending clear is safe');
}
{
 const s=make('fixed-clock'),g=install(s,[]);s.scope(()=>{g.state='aiming';g.launch();});
 assert.equal(g.survivalShotCooldownRemainingMs,RECHARGE_MS);
 g.balls.forEach(b=>b.active=false);s.scope(()=>g.endTurn());s.settle(.3);
 assert(g.survivalShotCooldownRemainingMs>1200);assert.equal(g.state,'playing','early ball loss must retain reload');
 s.settle(1.31);assert.equal(g.state,'idle');assert(g.getLauncherBall());
 s.scope(()=>{g.state='aiming';g.launch();});s.settle(1.61);assert.equal(g.state,'idle');
 const active=g.balls.filter(b=>b.active).length;s.scope(()=>{g.state='aiming';g.launch();});
 assert(g.balls.filter(b=>b.active).length>active,'can shoot while a preceding ball is active');
}
{
 const s=make('clear-clock'),g=install(s,[peg('timed','blue',250)]);
 s.scope(()=>g.activatePeg(g.pegs[0],null));s.settle(.6);assert(g.pegs.length);
 s.settle(.61);assert.equal(g.pegs.length,0);assert.notEqual(g.state,'won');
}
{
 const s=make('real-knockback'),g=s.game,k=g.pegs.find(p=>p.type==='gamble');assert(k);
 // A real run clears earlier oranges before reaching this camera position.
 // Flow drawings can begin higher than the former centre-header fixture.
 s.scope(()=>{for(const p of g.pegs)if(p.type==='orange'&&p.y<245)g.activatePeg(p,null);});
 g.survivalRuntime.setCameraY(200);g.survivalStream.maintain(g);const n=g.survivalStream.generated;
 s.scope(()=>g.activatePeg(k,null));s.settle(.2);
 assert(g.getCameraY()<105,'native gamble hit actually pushes the field down by its configured distance');
 assert.equal(g.survivalStream.generated,n,'reversing scroll does not regenerate content');
 assert.equal(g.getUiStateSnapshot().ballsLeft,Infinity);
}
{
 const s=make('one-relief'),g=s.game,k=g.pegs.find(p=>p.type==='gamble');
 s.scope(()=>{g.activatePeg(k,null);g.balls.forEach(b=>b.active=false);g.state='aiming';g.launch();});
 const push=g.survivalRuntime.knockbackDistance;
 s.scope(()=>assert.equal(g.activatePeg(k,null),false,'new shots cannot reactivate a pending relief peg'));
 assert.equal(g.survivalRuntime.knockbackDistance,push);
}

const a=new SurvivalGenerator('autonomous'),b=new SurvivalGenerator('autonomous');
const families=new Set(),ids=new Set();let moving=0,relief=0,mechanical=0;
for(let i=0;i<160;i++) {
 const patch=a.next();assert.deepEqual(patch,b.next());families.add(patch.family);
 moving+=patch.groups.filter(g=>g.animation).length;relief+=Number(!!patch.knockback);mechanical+=patch.groups.filter(g=>g.destructionBody).length;
 assert(patch.targets>=5,'readable orange pressure');
 for(const p of patch.pegs){assert(!ids.has(p.id));ids.add(p.id);assert.equal(p.radiusScale,1);if(p.curveSlices)assert(p.curveSlices.length>=7);}
}
assert.deepEqual([...families].sort(),STREAM_ACTIONS.slice().sort());assert(moving>5&&relief>35&&mechanical>5);
console.log('ok native survival: orange-only loss, timed clearing, fixed reload, overlapping shots, actual relief; 160 deterministic generated intervals');

// Long-distance transport exercises the real streaming maintenance and native
// animation/body state, including repeated rebases, without thousands of shots.
const long=make('long-stream'),g=long.game;let maximum=0;
for(let i=0;i<1800;i++) {
 g.survivalRuntime.setCameraY(g.getCameraY()+125);g.levelElapsedMs+=1000;
 g.survivalStream.maintain(g);g.animator.tick(g.pegs,.016,{width:400,height:g.survivalRuntime.getWorldHeight()});
 maximum=Math.max(maximum,g.pegs.length);assert(g.getCameraY()<4200);assert.equal(new Set(g.pegs.map(p=>p.id)).size,g.pegs.length);
 for(const p of g.pegs)assert(Number.isFinite(p.x+p.y));
 assert(g.animator.originalPositions.size<=g.pegs.length);
 assert(g.destructionSystem.bodies.size<=g.pegs.length);
}
assert(g.survivalRuntime.originY>200000);assert(g.survivalStream.generated>500);assert(maximum<600);
assert(g.groups.length<24&&g.survivalStream.recent.length<=8);
console.log('ok 225,000px endless stream, '+g.survivalStream.generated+' generated intervals, max '+maximum+' live pegs; native state and storage bounded');
assert.equal(getPegVerticalExtent({shape:'brick',width:34,height:10.2,angle:Math.PI/2},8.5),17);

function mechanic(family,field=true){
 const s=make('mechanic-'+family),g=s.game,p=new SurvivalGenerator('mechanic-'+family).next({family});
 g.survivalStream=null;g.pegs=p.pegs.filter(p=>field||p.type!=='bombMagnet');g.groups=p.groups;
 g.physics.setPegs(g.pegs);g.animator.loadFromLevel(g.pegs,g.groups);g.destructionSystem.reset(g.pegs,g.groups);return s;
}
for(const family of ['release','balance','field']) {
 const s=mechanic(family),g=s.game,floor=g.pegs.find(p=>p.constructionRole==='release-floor');
 const cargo=g.pegs.filter(p=>p.constructionRole==='cargo'),before=cargo.map(p=>({x:p.x,y:p.y}));
 s.scope(()=>g.activatePeg(floor,null));s.settle(2.5);
 assert(cargo.some((p,i)=>Math.hypot(p.x-before[i].x,p.y-before[i].y)>100),family+' releases native cargo');
 if(family==='field') {
  const off=mechanic(family,false),other=off.game.pegs.filter(p=>p.constructionRole==='cargo');
  off.scope(()=>off.game.activatePeg(off.game.pegs.find(p=>p.constructionRole==='release-floor'),null));off.settle(2.5);
  assert(g.destructionSystem.simMagnetTicks>0);
  assert(cargo.some((p,i)=>Math.hypot(p.x-other[i].x,p.y-other[i].y)>5),'magnet changes cargo motion');
 }
}
for(const family of ['orbits','petals']) {
 const s=mechanic(family),g=s.game,p=g.pegs.find(p=>p.groupId),before={x:p.x,y:p.y};
 if(family==='petals')g.animator.notifyHit(p.id);s.settle(1);
 assert(Math.hypot(p.x-before.x,p.y-before.y)>20,family+' moves in native animator');
}
{
 const s=mechanic('balance'),g=s.game,p=g.pegs.find(p=>p.constructionRole==='carrier-wall');
 const body=g.destructionSystem.getBodyForPeg(p);assert(body?.hinge);
 s.scope(()=>g.destructionSystem.applyBallImpact(p,{x:p.x,y:p.y-10,vx:0,vy:10},{vx:0,vy:10,speed:10,normalX:0,normalY:1}));
 s.settle(.5);assert(Math.abs(body.angle)>.05,'native balance responds to impact');
}
{
 const s=mechanic('portal'),g=s.game,p=g.pegs.find(p=>p.type==='portalOrange'),ball=new Ball(p.x,p.y-55);
 ball.launch(Math.PI/2,8);g.balls=[ball];g.physics.setBalls(g.balls);g.state='playing';s.settle(.8);
 assert(g.physics.simPortals>0,'generated return portals actually teleport a native ball');
}
console.log('ok native release, balance, magnetic cargo ablation, rotating/hit-triggered groups and portal return');
