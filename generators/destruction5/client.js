import {generateLevel} from './grammar.js';
import {validateGeometry} from '../destruction4/geometry.js';
export {generateLevel};
const bounds={focus:[.16,.92],kinetic:[0,1],branching:[0,1],openness:[.43,1],lateral:[0,1],complexity:[.15,1],bend:[-.75,.75],phase:[0,Math.PI*2],radialGrowth:[0,1],brickWidth:[30,35],pegScale:[1,1.27],direction:[-1,1]};
export function boundedIntent(genome={}){
 return Object.fromEntries(Object.entries(genome).map(([k,v])=>{
  if(!bounds[k]||!Number.isFinite(v))throw Error('Unknown or nonnumeric design parameter: '+k);
  const [lo,hi]=bounds[k];return [k,k==='direction'?(v<0?-1:1):Math.min(hi,Math.max(lo,v))];
 }));
}
// Browser-safe autonomous synthesis. This cheap filter certifies initial
// geometry only; the public catalog additionally receives full native search.
export function generateCandidates({seed='alea',count=3,attempts=12,genome}={}){
 const levels=[];
 for(let i=0;i<Math.min(128,attempts)&&levels.length<Math.min(16,count);i++){
  const level=generateLevel({seed:seed+'-'+i,genome:boundedIntent(genome)}),g=validateGeometry(level);
  if(g.valid&&g.targets>=12&&level.metadata.generator.plan.nodes.length>=2)levels.push(level);
 }
 return levels;
}
