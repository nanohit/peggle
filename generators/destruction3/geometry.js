import {objectBounds,overlapDepth} from '../destruction2/ribbon-geometry.js';
export function validateGeometry(level,{pose=level.pegs,dynamic=false}={}){
 const errors=[],sized=p=>({...p,radius:8.5*(p.bumperScale||1),...(p.type.startsWith('portal')?{shape:'brick',width:34*p.portalScale,height:10.2}: {})}),objects=pose.map(sized),ids=new Set();
 for(const p of objects){
  const b=objectBounds(p);if(ids.has(p.id))errors.push('duplicate');ids.add(p.id);
  if(!Number.isFinite(p.x+p.y))errors.push('nonfinite');
  if(b.minX<12||b.maxX>388||b.minY<100||b.maxY>540)errors.push('bounds:'+p.id);
  if(p.constructionRole==='cargo-guide')errors.push('guide-post');
  if(p.type==='obstacle'&&p.shape!=='brick')errors.push('permanent-cargo');
  if(p.bezierGroupId&&!level.bezierCurves[p.bezierGroupId])errors.push('curve-missing');
  if(p.portalTargetId&&!objects.some(q=>q.id===p.portalTargetId))errors.push('portal-unpaired');
 }
 for(let i=0;i<objects.length;i++)for(let j=i+1;j<objects.length;j++){
  const a=objects[i],b=objects[j];
  if(a.bezierGroupId===b.bezierGroupId&&a.bezierGroupId&&Math.abs(a.bezierIndex-b.bezierIndex)===1)continue;
  if(a.groupId&&a.groupId===b.groupId&&a.constructionRole==='pour-handle'||b.groupId&&a.groupId===b.groupId&&b.constructionRole==='pour-handle')continue;
  // Contacts after settling belong to the native solver; authored penetration
  // across independent parts is rejected before simulation.
  if(dynamic&&(a.destructionStatic===false||b.destructionStatic===false))continue;
  if(overlapDepth(a,b)>.7)errors.push('overlap:'+a.id+':'+b.id);
 }
 const plan=level.metadata.generator.plan,targets=level.pegs.filter(p=>p.type==='orange').length;
 if(targets<13||targets>28)errors.push('targets');
 if(level.pegRadius!==8.5||level.metadata.intentGraph)errors.push('changed-rules');
 const nodes=plan.assemblies.filter(a=>['source','receiver','catcher'].includes(a.role));
 const connected=new Set(plan.links.flatMap(e=>[e.from,e.to]));if(nodes.some(n=>!connected.has(n.id)))errors.push('disconnected-system');
 for(const e of plan.links){if(!e.helpers.length&&e.kind==='portal')errors.push('unbuilt-transport');
  if(e.kind==='fall'&&Math.abs(e.out.x-e.in.x)>e.in.halfWidth-12)errors.push('missed-inlet');
  if(e.in.y<=e.out.y)errors.push('uphill-transfer');}
 const magnet=level.pegs.find(p=>p.type==='bombMagnet');if(magnet){const source=plan.assemblies.find(a=>a.role==='source'),cargo=objects.filter(p=>source.cargoIds.includes(p.id));if(!cargo.some(p=>Math.hypot(p.x-magnet.x,p.y-magnet.y)<magnet.magnetRadius))errors.push('empty-field');}
 return {valid:errors.length===0,errors,targets,pegs:level.pegs.length};
}
