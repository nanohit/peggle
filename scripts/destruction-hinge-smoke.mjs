import assert from 'node:assert/strict';
import { DestructionPegSystem } from '../js/destruction-mode.js';
import { createSeesaw, getSeesawPivot, mirrorDestructionHinge, normalizeDestructionHinge } from '../js/destruction-hinge.js';
const bounds={width:400,height:600,topY:0,lossY:670,bucketEnabled:false};
function run(props={},cargo=[]){
 const c=createSeesaw({x:200,y:250,...props});c.pegs.push(...cargo);
 const s=new DestructionPegSystem({enabled:true});s.reset(c.pegs,c.groups);
 return {s,c,beam:c.pegs[0],body:s.getBodyForPeg(c.pegs[0]),step(n){for(let k=0;k<n;k++)s.step(c.pegs,c.groups,1/120,bounds);}};
}
const payload=(id,x)=>({id,type:'orange',shape:'circle',x,y:236.4,destructionStatic:false,destructionPhysicsOnHit:false});
{
 const r=run({},[payload('left',170),payload('right',230)]);r.step(600);
 assert(Math.abs(r.beam.angle)<0.025,'balanced load must not tip');
 assert(Math.hypot(getSeesawPivot(r.beam).x-200,getSeesawPivot(r.beam).y-250)<0.01);
 console.log('balanced loaded beam',r.beam.angle);
}
{
 const r=run({},[payload('left',160)]);r.step(90);
 assert(r.beam.angle < -0.04,'unequal real load must tip left');
 console.log('weight-driven tip',r.beam.angle);
}
{
 const r=run();r.s.wakeBody(r.body,0,14,r.beam,155,250,'ball');r.step(600);
 assert(r.beam.angle<-.15,'off-centre impact must rotate');
 assert(r.beam.angle>=-.651&&r.beam.angle<=.651);
 assert(Math.hypot(getSeesawPivot(r.beam).x-200,getSeesawPivot(r.beam).y-250)<0.01);
 assert(!r.s.isBreakableBody(r.body));console.log('impact and angular stops',r.beam.angle);
}
{
 const r=run({pivotFraction:.3});r.step(100);
 assert(r.beam.angle>.1,'off-centre gravity produces torque');console.log('off-centre bearing torque',r.beam.angle);
}
{
 const raw={pivotFraction:.25,minAngle:-.3,maxAngle:.8};
 const m=mirrorDestructionHinge(raw);
 assert.equal(m.pivotFraction,.75);assert.equal(m.minAngle,-.8);assert.equal(m.maxAngle,.3);
 assert.deepEqual(mirrorDestructionHinge(m),normalizeDestructionHinge(raw));
 const r=run({pivotFraction:.25,minAngle:-.3,maxAngle:.8});r.step(160);
 const mirrored=run({pivotFraction:.75,minAngle:-.8,maxAngle:.3});mirrored.step(160);
 assert(Math.abs(r.beam.angle+mirrored.beam.angle)<.01,'mirrored bearing must reverse gravity torque');
 console.log('mirrored hinge geometry and torque');
}
{
 const c=createSeesaw();c.pegs.pop();c.pegs[0].destructionHinge.breakImpulse=7;
 const s=new DestructionPegSystem({enabled:true});s.reset(c.pegs,c.groups);const b=s.getBodyForPeg(c.pegs[0]);
 s.queueBodyFracture(b,150,260,6,0,1);assert(b.hinge,'small impact keeps the pin');
 s.queueBodyFracture(b,150,260,8,0,1);assert.equal(b.hinge,null);assert(c.pegs[0]._destructionHingeBroken);
 for(let k=0;k<120;k++)s.step(c.pegs,c.groups,1/120,bounds);
 assert(c.pegs[0].y>320,'released beam must fall under native gravity');
 console.log('breakable joint releases on physical impulse');
}
console.log('hinge physics passed');
