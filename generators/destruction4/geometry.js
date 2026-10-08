import {objectBounds,overlapDepth} from '../destruction2/ribbon-geometry.js';

export function sized(p){return {...p,radius:8.5*(p.type==='bumper'?p.bumperScale||1:p.radiusScale||1),...(p.type.startsWith('portal')?{shape:'brick',width:34*(p.portalScale||1),height:10.2}:{})};}
export function validateGeometry(level){
 const errors=[],objects=level.pegs.map(sized);
 for(const p of objects){const b=objectBounds(p);if(!Number.isFinite(p.x+p.y))errors.push({kind:'nonfinite',id:p.id});if(b.minX<11||b.maxX>389||b.minY<102||b.maxY>539)errors.push({kind:'bounds',id:p.id,role:p.constructionRole,bounds:b});}
 for(let i=0;i<objects.length;i++)for(let j=i+1;j<objects.length;j++){
  const a=objects[i],b=objects[j],depth=overlapDepth(a,b);if(depth<1.4)continue;
  const joined=a.bezierGroupId&&a.bezierGroupId===b.bezierGroupId&&(Math.abs(a.bezierIndex-b.bezierIndex)===1||Math.abs(a.bezierIndex-b.bezierIndex)===objects.filter(p=>p.bezierGroupId===a.bezierGroupId).length-1);
  if(joined)continue;
  errors.push({kind:'overlap',ids:[a.id,b.id],roles:[a.constructionRole,b.constructionRole],depth});
 }
 if(new Set(objects.map(p=>p.id)).size!==objects.length)errors.push({kind:'duplicate'});
 return {valid:!errors.length,errors,pegs:objects.length,targets:objects.filter(p=>p.type==='orange').length};
}
export function compositionMetrics(level){
 const ps=level.pegs,n=ps.length,mean=k=>ps.reduce((s,p)=>s+p[k],0)/n,cx=mean('x'),cy=mean('y'),xx=ps.reduce((s,p)=>s+(p.x-cx)**2,0)/n,yy=ps.reduce((s,p)=>s+(p.y-cy)**2,0)/n,xy=ps.reduce((s,p)=>s+(p.x-cx)*(p.y-cy),0)/n;
 const bricks=ps.filter(p=>p.shape==='brick'),orient=Array(8).fill(0);for(const p of bricks)orient[Math.floor((((p.angle%Math.PI)+Math.PI)%Math.PI)/Math.PI*8)]++;
 const side=(lo,hi)=>ps.filter(p=>p.x>=lo&&p.x<=hi).length;
 return {pegs:n,targets:ps.filter(p=>p.type==='orange').length,cx,cy,spreadX:Math.sqrt(xx),spreadY:Math.sqrt(yy),diagonalCovariance:xy/Math.sqrt(xx*yy),orientationHistogram:orient,leftWall:side(0,55),rightWall:side(345,400),scales:[...new Set(ps.map(p=>Math.round((p.radiusScale||1)*10)/10))],parts:level.metadata.generator.parts.map(a=>a.kind),hitAnimations:level.groups.filter(g=>g.animation?.hitTrigger).length,steadyAnimations:level.groups.filter(g=>g.animation&&!g.animation.hitTrigger).length};
}
