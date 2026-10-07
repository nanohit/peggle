import {polygons,objectBounds,overlapDepth} from './ribbon-geometry.js';
export function validateGeometry(level) {
 const errors=[],objects=level.pegs.map(p=>({...p,radius:8.5*(p.type==='bumper'?(p.bumperScale||1):1),...(p.type.startsWith('portal')?{shape:'brick',width:34*(p.portalScale||1),height:10.2}: {})}));
 const ids=new Set();for(const p of objects){if(ids.has(p.id))errors.push('duplicate-id');ids.add(p.id);
  const b=objectBounds(p);if(!Number.isFinite(p.x+p.y))errors.push('nonfinite');
  if(b.minX<12||b.maxX>388||b.minY<100||b.maxY>540)errors.push('bounds:'+p.id);
  if(p.type==='obstacle')errors.push('permanent-gray-body');
  if(p.shape==='brick'&&p.bezierGroupId&&!level.bezierCurves[p.bezierGroupId])errors.push('missing-bezier');
  if(p.portalTargetId&&!objects.some(q=>q.id===p.portalTargetId))errors.push('missing-portal-pair');
 }
 for(let i=0;i<objects.length;i++)for(let j=i+1;j<objects.length;j++){
  const a=objects[i],b=objects[j];
  // Native neighbors share the edge of one curved stroke. Every other overlap
  // is forbidden, including actual polygons rather than just peg centers.
  if(a.bezierGroupId&&a.bezierGroupId===b.bezierGroupId&&Math.abs(a.bezierIndex-b.bezierIndex)===1)continue;
  if(overlapDepth(a,b)>.7)errors.push('overlap:'+a.id+':'+b.id);
 }
 const g=level.metadata.generator;
 if(level.pegRadius!==8.5||level.metadata.intentGraph)errors.push('changed-game-rules');
 if(g.hero==='collapse'&&!g.plan.loads.length)errors.push('no-collapse-system');
 if(g.hero==='magnet'&&!g.plan.loads.length)errors.push('no-magnet-cargo');
 if(g.hero==='motion'&&!level.groups.some(g=>g.animation))errors.push('no-motion');
 if(g.hero==='portal'&&level.pegs.filter(p=>p.type==='portalBlue').length!==1)errors.push('no-portal');
 const targets=level.pegs.filter(p=>p.type==='orange').length;if(targets<16||targets>32)errors.push('target-budget');
 return {valid:errors.length===0,errors,targets,pegCount:objects.length};
}
