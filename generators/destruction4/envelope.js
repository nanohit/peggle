import {PegAnimator} from '../../js/animation.js';
import {objectBounds} from '../destruction2/ribbon-geometry.js';
import {sized} from './geometry.js';
export function animationEnvelope(level){
 const pegs=structuredClone(level.pegs),animator=new PegAnimator();animator.loadFromLevel(pegs,structuredClone(level.groups));const violations=[],groupIds=new Set(level.groups.filter(g=>g.animation).map(g=>g.id));
 function check(phase){for(const p of pegs.filter(p=>groupIds.has(p.groupId))){const b=objectBounds(sized(p));if(b.minX<10||b.maxX>390||b.minY<100||b.maxY>540)violations.push({phase,id:p.id,role:p.constructionRole,bounds:b});}}
 const period=Math.max(1,...level.groups.map(g=>g.animation?.duration||0));
 for(let i=0;i<=48;i++){if(i)animator.tick(pegs,period*2/48);check('steady-'+i);}
 // Native animator is driven through complete hit steps. This envelope check
 // is an intervention, distinct from actual hit witnesses in the winning Game.
 for(let step=0;step<8;step++){
  for(const g of level.groups.filter(g=>g.animation?.hitTrigger)){const p=pegs.find(p=>p.groupId===g.id);if(p)animator.notifyHit(p.id);}
  for(let i=0;i<16;i++){animator.tick(pegs,period/16);check('hit-'+step+'-'+i);}
 }
 return {valid:!violations.length,violations:violations.slice(0,8),samples:49+8*16};
}
