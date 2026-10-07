// Native ribbons are unions of warped quads. Also include the chord boxes used
// by PhysicsEngine, so clearance covers both the drawn edge and its collider.
export function polygons(o){
  if(o._ribbonPolygons)return o._ribbonPolygons;
  if(o.shape!=='brick')return [];
  if(o.curveSlices?.length>=2){
    const h=o.height/2,result=[];
    for(let i=1;i<o.curveSlices.length;i++){
      const a=o.curveSlices[i-1],b=o.curveSlices[i];
      result.push([[a.x+a.nx*h,a.y+a.ny*h],[b.x+b.nx*h,b.y+b.ny*h],[b.x-b.nx*h,b.y-b.ny*h],[a.x-a.nx*h,a.y-a.ny*h]]);
      const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
      if(len>1e-6){const nx=-dy/len*h,ny=dx/len*h;result.push([[a.x+nx,a.y+ny],[b.x+nx,b.y+ny],[b.x-nx,b.y-ny],[a.x-nx,a.y-ny]]);}
    }
    return result;
  }
  const co=Math.cos(o.angle),si=Math.sin(o.angle);
  return [[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>[o.x+x*o.width/2*co-y*o.height/2*si,o.y+x*o.width/2*si+y*o.height/2*co])];
}
export function objectBounds(o){
  if(o._ribbonBounds)return o._ribbonBounds;
  if(o.shape==='circle')return {minX:o.x-o.radius,maxX:o.x+o.radius,minY:o.y-o.radius,maxY:o.y+o.radius};
  const points=polygons(o).flat();return {minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),
    minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))};
}
export function bounds(objects){
  if(!objects.length)return {minX:0,maxX:0,minY:0,maxY:0,width:0,height:0};
  const bs=objects.map(objectBounds),b={minX:Math.min(...bs.map(b=>b.minX)),maxX:Math.max(...bs.map(b=>b.maxX)),minY:Math.min(...bs.map(b=>b.minY)),maxY:Math.max(...bs.map(b=>b.maxY))};
  return {...b,width:b.maxX-b.minX,height:b.maxY-b.minY};
}
function axes(poly){return poly.map((p,i)=>{const q=poly[(i+1)%poly.length],dx=q[0]-p[0],dy=q[1]-p[1],l=Math.hypot(dx,dy)||1;return [-dy/l,dx/l];});}
function polygonOverlap(a,b){
  let depth=Infinity;for(const n of [...axes(a),...axes(b)]){
    const proj=p=>p.map(v=>v[0]*n[0]+v[1]*n[1]),aa=proj(a),bb=proj(b);
    const d=Math.min(Math.max(...aa),Math.max(...bb))-Math.max(Math.min(...aa),Math.min(...bb));
    if(d<=0)return d;depth=Math.min(depth,d);
  }return depth;
}
function circleOverlap(circle,poly){
  const candidates=axes(poly);let near=poly[0];
  for(const p of poly)if(Math.hypot(p[0]-circle.x,p[1]-circle.y)<Math.hypot(near[0]-circle.x,near[1]-circle.y))near=p;
  const dx=near[0]-circle.x,dy=near[1]-circle.y,l=Math.hypot(dx,dy);if(l>1e-9)candidates.push([dx/l,dy/l]);
  let depth=Infinity;for(const n of candidates){const p=poly.map(v=>v[0]*n[0]+v[1]*n[1]),center=circle.x*n[0]+circle.y*n[1];
    const d=Math.min(Math.max(...p),center+circle.radius)-Math.max(Math.min(...p),center-circle.radius);if(d<=0)return d;depth=Math.min(depth,d);}
  return depth;
}
export function overlapDepth(a,b){
  if(a.shape==='circle'&&b.shape==='circle')return a.radius+b.radius-Math.hypot(a.x-b.x,a.y-b.y);
  if(b.shape==='circle')return overlapDepth(b,a);
  const ab=objectBounds(a),bb=objectBounds(b);
  if(ab.maxX<=bb.minX||bb.maxX<=ab.minX||ab.maxY<=bb.minY||bb.maxY<=ab.minY)return -1;
  if(a.shape==='circle')return Math.max(...polygons(b).map(p=>circleOverlap(a,p)));
  return Math.max(...polygons(a).flatMap(p=>polygons(b).map(q=>polygonOverlap(p,q))));
}
export function reach(o,center=[o.x,o.y]){
  if(o.shape==='circle')return Math.hypot(o.x-center[0],o.y-center[1])+o.radius;
  return Math.max(...polygons(o).flat().map(p=>Math.hypot(p[0]-center[0],p[1]-center[1])));
}
