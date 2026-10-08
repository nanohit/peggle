import {mkdir,writeFile} from 'node:fs/promises';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {SurvivalGenerator,createSurvivalLevel,FAMILIES} from './grammar.js';
const out='generators/survival/study';await mkdir(out,{recursive:true});
const examples=[];
for(const family of FAMILIES){const g=new SurvivalGenerator('visual-'+family),p=g.next({family});examples.push({id:family,pegs:p.pegs,groups:p.groups});}
await writeFile(out+'/forms.json',JSON.stringify(examples));
const drawings=[];
for(let i=0;i<24;i++){
 const g=new SurvivalGenerator('composition-review-'+i);g.index=12;const p=g.next();
 drawings.push({id:'seed '+i+' / '+(p.drawing?.operation||p.family),pegs:p.pegs,groups:p.groups,program:p.drawing});
}
await writeFile(out+'/compositions.json',JSON.stringify(drawings));

function chooseShot(g){
 const pegs=new Map(g.pegs.map(p=>[p.id,p])), hit=g.getActiveHitPegIdSet();
 let best={angle:Math.PI/2,score:-Infinity};
 for(let k=0;k<41;k++){
  const angle=.30+k*(Math.PI-.60)/40;
  const trace=g.physics.predictTrajectory(g.launchX,g.launchY,angle,g.getCurrentLaunchPower(),420,false);
  const ids=new Set(trace.hits.map(h=>h.pegId));let score=0;
  for(const id of ids){const p=pegs.get(id);if(!p||hit.has(id))continue;
   const y=p.y-g.getCameraY();if(y<35||y>600)continue;
   if(p.type==='orange')score+=2+8*Math.exp(-Math.max(0,y-50)/160);
   else if(p.type==='gamble')score+=5;
   else score+=.15;
  }
  if(score>best.score)best={angle,score};
 }
 return best.angle;
}
const runs=[];
for(const recharge of [1250,1600,2000]){
 const sim=new NativeSimulation(createSurvivalLevel('study-stream')),g=sim.game;
 g.survivalAntiCooldownMs=recharge;const frames=[];let nextFrame=0,knockbacks=0;
 const original=g.survivalRuntime.applyGambleKnockback.bind(g.survivalRuntime);
 g.survivalRuntime.applyGambleKnockback=(...a)=>{knockbacks++;return original(...a);};
 const start=performance.now();
 sim.scope(()=>{
  for(let tick=0;tick<120*(recharge===1600?600:180)&&g.state!=='lost';tick++){
   if(g.survivalShotCooldownRemainingMs<=0&&['idle','aiming'].includes(g.state)){
    g.aimAngle=chooseShot(g);g.state='aiming';g.launch();
   }
   sim.step(1);
   if(tick>=nextFrame){const y=g.getCameraY();frames.push({id:recharge+'ms / '+Math.round(sim.clock/1000)+'s',pegs:g.pegs.filter(p=>p.y-y>-25&&p.y-y<625).map(p=>({...p,y:p.y-y,curveSlices:p.curveSlices?.map(s=>({...s,y:s.y-y}))})),balls:g.balls.filter(b=>b.active).map(b=>({x:b.x,y:b.y-y}))});nextFrame+=120*30;}
  }
 });
 const row={recharge,seconds:Math.round(sim.clock/1000),state:g.state,shots:g.shotsFired,direct:g.simMetrics.direct,knockbacks,generated:g.survivalStream.generated,live:g.pegs.length,ms:Math.round(performance.now()-start)};
 runs.push(row);console.log(row);await writeFile(out+'/native-'+recharge+'.json',JSON.stringify(frames));
}
await writeFile(out+'/tuning.json',JSON.stringify(runs,null,2));
