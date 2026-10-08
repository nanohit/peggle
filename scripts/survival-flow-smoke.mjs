import assert from 'node:assert/strict';
import {SurvivalGenerator,createSurvivalLevel} from '../generators/survival/grammar.js';
import {sized} from '../generators/destruction4/geometry.js';
import {objectBounds,overlapDepth} from '../generators/destruction2/ribbon-geometry.js';
import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';

const rewards=[];let joined=0,overlappingPages=0,retired=0,brickReward=null;
for(const seed of ['flow-01','flow-02','flow-03','flow-04','flow-05','flow-06']) {
  const g=new SurvivalGenerator(seed),live=new Map();let previous=null;
  for(let i=0;i<24;i++) {
    const p=g.next();
    if(previous){
      for(let v=0;v<2;v++){
        const a=previous.flow.banks[v],b=p.flow.banks[v];
        assert.equal(a.end.x,b.start.x);
        assert(Math.abs((a.end.x-a.h2.x)/(a.end.y-a.h2.y)-(b.h1.x-b.start.x)/(b.h1.y-b.start.y))<1e-10);
        joined++;
      }
      const hi=Math.max(...previous.pegs.map(p=>objectBounds(sized(p)).maxY));
      const lo=Math.min(...p.pegs.map(p=>objectBounds(sized(p)).minY));
      overlappingPages+=Number(hi>lo);
    }
    for(const id of p.retiredPegIds){
      const old=live.get(id);assert(old&&old.flowVoice!==undefined&&old.type==='blue','only background blue material can be retired');
      live.delete(id);retired++;
    }
    const near=[...live.values()].filter(o=>o.y>g.cursorY-650).map(sized);
    for(const q of p.pegs.map(sized))for(const o of near){
      assert(overlapDepth(q,o)<1.4,'compiler pages must not introduce intersecting native colliders');
    }
    for(const q of p.pegs){live.set(q.id,q);assert(!['continuation','pressure-relief'].includes(q.constructionRole));}
    if(p.knockback){
      const q=p.pegs.find(q=>q.id===p.knockback);assert(q&&q.flowVoice===undefined);
      assert(!['cargo','release-floor','bearing-arm','carrier-wall'].includes(q.constructionRole));
      rewards.push(q);if(q.shape==='brick'&&!brickReward)brickReward={seed,patch:p,peg:q};
    }
    previous=p;
  }
}
assert(joined===276&&overlappingPages>138*.5&&retired>10);
assert(Math.min(...rewards.map(p=>p.x))<110&&Math.max(...rewards.map(p=>p.x))>285);
assert(rewards.filter(p=>Math.abs(p.x-200)<15).length/rewards.length<.25);
assert(brickReward,'native brick power-ups stay part of a ribbon');

// Compiler state and reserved negative spaces survive rebasing. Native moving
// objects cannot mutate the compiler tail through shared object references.
{
  const a=new SurvivalGenerator('flow-rebase'),b=new SurvivalGenerator('flow-rebase');
  for(let i=0;i<18;i++){a.next();b.next();}
  const shift=3072;b.rebase(shift);
  for(let i=0;i<4;i++){
    const x=a.next(),y=b.next();
    assert.deepEqual(x.retiredPegIds,y.retiredPegIds);
    for(const p of y.pegs){p.y+=shift;for(const s of p.curveSlices||[])s.y+=shift;}
    for(let j=0;j<x.pegs.length;j++){
      assert.equal(x.pegs[j].id,y.pegs[j].id);assert(Math.abs(x.pegs[j].y-y.pegs[j].y)<1e-9);
    }
  }
}
{
  const a=new SurvivalGenerator('flow-rest-pose'),b=new SurvivalGenerator('flow-rest-pose');
  const first=a.next();b.next();
  for(const p of first.pegs){p.x+=100;p.y+=300;for(const s of p.curveSlices||[])s.y+=300;}
  for(let i=0;i<4;i++)assert.deepEqual(a.next(),b.next(),'native motion cannot change future generation');
}
{
  const sim=new NativeSimulation(createSurvivalLevel('flow-runtime')),g=sim.game;
  for(let i=0;i<24;i++){
    const old=new Map(g.pegs.map(p=>[p.id,p]));g.survivalRuntime.setCameraY(g.getCameraY()+100);g.levelElapsedMs+=1000;
    const camera=g.getCameraY();g.survivalStream.maintain(g);
    const live=new Set(g.pegs.map(p=>p.id));
    for(const p of old.values())if(!live.has(p.id)&&p.y>camera-1000)
      assert(p.type==='blue'&&p.flowVoice!==undefined&&p.y>camera+g.canvas.height,'foreground edits stay ahead of the visible viewport');
  }
}
{
  const sim=new NativeSimulation(createSurvivalLevel(brickReward.seed)),g=sim.game;
  g.survivalStream=null;g.pegs=[brickReward.peg];g.groups=[];
  g.physics.setPegs(g.pegs);g.animator.loadFromLevel(g.pegs,g.groups);g.destructionSystem.reset(g.pegs,g.groups);
  const q=g.pegs.find(q=>q.id===brickReward.peg.id),slices=JSON.stringify(q.curveSlices);
  g.survivalRuntime.setCameraY(300);sim.scope(()=>g.activatePeg(q,null));sim.settle(.2);
  assert(g.getCameraY()<205&&JSON.stringify(q.curveSlices)===slices,'native curved reward activates pushback without changing its ribbon');
}
console.log(`ok flow: ${joined} smooth joins, ${overlappingPages} overlapping page extents, ${rewards.length} integrated rewards; cross-page contacts, offscreen retirement and rebasing`);
