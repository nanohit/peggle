import {validateGeometry as validateBodies} from '../destruction/geometry.js';

export function validateIntentGeometry(level) {
  const result=validateBodies(level),errors=[...result.errors],plan=level.metadata?.generator?.plan;
  if(level.metadata?.intentGraph)errors.push('runtime-objectives-forbidden');
  if(!plan?.assemblies?.length||!plan.flow?.length)errors.push('missing-composition-plan');
  const allowed=new Set(['blue','orange','obstacle','portalBlue','portalOrange','bombMagnet']);
  const pegs=new Map(level.pegs.map(p=>[p.id,p]));
  for(const p of level.pegs) {
    if(!allowed.has(p.type))errors.push('unsupported-native-type:'+p.id);
    if(p.shape==='circle'&&p.type==='obstacle')errors.push('permanent-cargo-ball:'+p.id);
    if(p.constructionRole==='cargo'&&!['orange','blue'].includes(p.type))errors.push('unclearable-cargo:'+p.id);
    if(p.portalTargetId&&!pegs.has(p.portalTargetId))errors.push('missing-portal-pair:'+p.id);
  }
  if(plan) {
    const assigned=plan.assemblies.flatMap(a=>a.pegs);
    if(new Set(assigned).size!==level.pegs.length||assigned.length!==level.pegs.length)errors.push('assembly-coverage');
    if(!plan.assemblies.some(a=>['tower','seesaw','cradle','cage'].includes(a.type)))errors.push('missing-des-constructions');
  }
  return {...result,valid:errors.length===0,errors};
}

// Seed and mirroring do not count as a distinct composition. Building choices,
// release mechanisms and the intended spatial flow do.
export function structureKey(level) {
  const plan=level.metadata.generator.plan,index=new Map(plan.assemblies.map((a,i)=>[a.id,i]));
  return JSON.stringify({assemblies:plan.assemblies.map(a=>[a.type,a.geometry.kind||null]),
    flow:plan.flow.map(e=>[index.get(e.from),index.get(e.to),e.action])});
}
