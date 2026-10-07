import {validateGeometry as validateBodies} from '../destruction/geometry.js';

export function validateIntentGeometry(level) {
  const result=validateBodies(level), errors=[...result.errors], graph=level.metadata?.intentGraph;
  if(!graph?.required) errors.push('missing-intent-graph');
  if(!graph) return {...result,valid:false,errors};
  const pegs=new Map(level.pegs.map(p=>[p.id,p])), nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  if(nodes.size!==graph.nodes.length) errors.push('duplicate-stage');
  for(const c of graph.cargo){
    const peg=pegs.get(c.id);
    if(!peg || peg.type!=='obstacle' || peg.destructionStatic || peg.destructionPhysicsOnHit) errors.push('invalid-cargo:'+c.id);
    if(nodes.get(c.source)?.kind!=='source') errors.push('invalid-origin:'+c.id);
  }
  for(const n of nodes.values()){
    if(n.requiredCount<1 || n.requiredCount>n.cargoIds.length) errors.push('impossible-quota:'+n.id);
    for(const id of n.cargoIds) if(!pegs.has(id)) errors.push('missing-cargo:'+id);
    for(const id of n.triggerIds||[]) if(!pegs.has(id)) errors.push('missing-trigger:'+id);
    if(n.kind==='portal') {
      const entry=pegs.get(n.entryId), exit=pegs.get(n.exitId);
      if(entry?.portalTargetId!==exit?.id || !exit || entry.portalOneWayFlip || !exit.portalOneWayFlip) errors.push('invalid-portal-flow:'+n.id);
    }
    if(n.kind==='magnet' && (!n.region?.radius || !(n.holdSeconds>0))) errors.push('invalid-magnetic-capture:'+n.id);
  }
  const visiting=new Set(), visited=new Set();
  function walk(id){
    if(visiting.has(id)){errors.push('cyclic-transfer');return;}
    if(visited.has(id))return;
    visiting.add(id);
    for(const edge of graph.edges.filter(e=>e.from===id)){
      if(!nodes.has(edge.to))errors.push('missing-stage:'+edge.to);else walk(edge.to);
    }
    visiting.delete(id);visited.add(id);
  }
  for(const id of nodes.keys())walk(id);
  return {...result,valid:errors.length===0,errors};
}

// Mirrors and seed labels do not create new structural compositions. Different
// release operators and transfer edges do: breaking a floor and rotating a
// whole cup require different physical interventions.
export function structureKey(level) {
  const graph=level.metadata.intentGraph, index=new Map(graph.nodes.map((n,i)=>[n.id,i]));
  return JSON.stringify({nodes:graph.nodes.map(n=>[n.kind,n.geometry?.kind||null,n.requiredCount,n.perSource||null]),
    edges:graph.edges.map(e=>[index.get(e.from),index.get(e.to),e.action]),
    portalTargets:graph.nodes.filter(n=>n.kind==='portal').map(n=>graph.nodes.findIndex(c=>c.prerequisites?.includes(n.id)))});
}
