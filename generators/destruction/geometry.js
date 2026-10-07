// Contacts between supports are intentional. Deeply embedded cargo is not.
const segmentDistance=(p,a,b)=>{const x=b.x-a.x,y=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*x+(p.y-a.y)*y)/(x*x+y*y||1)));return Math.hypot(p.x-a.x-x*t,p.y-a.y-y*t);};
export function validateGeometry(level){
  const errors=[],ids=new Set();
  for(const p of level.pegs){
    if(ids.has(p.id))errors.push('duplicate-id:'+p.id);ids.add(p.id);
    if(!Number.isFinite(p.x+p.y+(p.angle||0)))errors.push('nonfinite:'+p.id);
    const w=p.shape==='brick'?p.width:17,h=p.shape==='brick'?p.height:17;
    const dx=Math.abs(Math.cos(p.angle||0))*w/2+Math.abs(Math.sin(p.angle||0))*h/2;
    const dy=Math.abs(Math.sin(p.angle||0))*w/2+Math.abs(Math.cos(p.angle||0))*h/2;
    if(p.x-dx<8||p.x+dx>392||p.y-dy<90||p.y+dy>550)errors.push('clearance:'+p.id);
    if(p.destructionHinge&&p.destructionStatic)errors.push('static-hinge:'+p.id);
  }
  const circles=level.pegs.filter(p=>p.shape!=='brick'),bricks=level.pegs.filter(p=>p.shape==='brick');
  for(let i=0;i<circles.length;i++){
    const p=circles[i];
    for(const q of circles.slice(i+1))if(Math.hypot(p.x-q.x,p.y-q.y)<16.2)errors.push('cargo-overlap:'+p.id+':'+q.id);
    for(const q of bricks){
      let gap;
      if(q.curveSlices?.length>=2){gap=Math.min(...q.curveSlices.slice(1).map((b,k)=>segmentDistance(p,q.curveSlices[k],b)))-q.height/2;}
      else{const x=p.x-q.x,y=p.y-q.y,c=Math.cos(q.angle||0),s=Math.sin(q.angle||0);gap=Math.hypot(Math.max(0,Math.abs(x*c+y*s)-q.width/2),Math.max(0,Math.abs(-x*s+y*c)-q.height/2));}
      if(gap<7.7)errors.push('embedded-cargo:'+p.id+':'+q.id);
    }
  }
  if(level.pegRadius!==8.5)errors.push('nonstandard-radius');
  if(!level.destruction?.enabled)errors.push('destruction-disabled');
  return {valid:errors.length===0,errors,pegCount:level.pegs.length,targets:level.pegs.filter(p=>p.type==='orange').length};
}
