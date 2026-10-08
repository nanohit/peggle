export function visualLevel(level,pose=level.pegs){return {id:level.id,name:level.name,radius:level.pegRadius||8.5,
 pegs:pose.map(p=>Object.fromEntries(['id','x','y','angle','type','shape','radiusScale','width','height','curveSlices','bumperScale','bumperOrange','magnetRadius','magnetMode','portalScale','portalOneWay','portalOneWayFlip','constructionAssembly','constructionRole','destructionStatic','destructionPhysicsOnHit'].filter(k=>p[k]!==undefined).map(k=>[k,structuredClone(p[k])]))),groups:level.groups?.length||0};}
export function designMetrics(level,pose=level.pegs){
 const r=level.pegRadius||8.5,circles=pose.filter(p=>p.shape!=='brick'&&['blue','orange'].includes(p.type)),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
 const nearest=circles.map(p=>Math.min(...circles.filter(q=>q!==p).map(q=>distance(p,q))));
 const tiles=Array(96).fill(0);for(const p of pose){const x=Math.max(0,Math.min(7,Math.floor(p.x/50))),y=Math.max(0,Math.min(11,Math.floor(p.y/50)));tiles[y*8+x]++;}
 const mean=a=>a.reduce((s,n)=>s+n,0)/Math.max(1,a.length),targets=pose.filter(p=>p.type==='orange'||p.bumperOrange);
 return {pegs:pose.length,targets:targets.length,gray:pose.filter(p=>p.type==='obstacle').length,
  packedFraction:mean(nearest.map(d=>d<r*2+3?1:0)),meanNearest:mean(nearest),
  targetBelow520:targets.filter(p=>p.y>520).length,
  targetSpanX:Math.max(...targets.map(p=>p.x))-Math.min(...targets.map(p=>p.x)),
  occupiedCells:tiles.filter(n=>n>0).length,tiles,
  movingGroups:level.groups?.filter(g=>g.animation||g.motion).length||0,
  blueGroups:level.groups?.filter(g=>g.destructionBody).length||0};
}
export function cosine(a,b){const dot=a.reduce((s,x,i)=>s+x*b[i],0);return dot/Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0)||1);}
