import {arc, cubic, spline, transform, polarContour, between, choose, TAU} from '../destruction4/shapes.js';

// These are drawing operations, not finished formations. A program can repeat
// a reflected pair, nest a counter-rhythm inside an orbit, or grow new branches.
// Composition is sampled before any peg/collision/trajectory is calculated.
export const DRAWING_OPERATIONS = ['repeat', 'reflect', 'nest', 'radial', 'branch'];

export function planDrawing(r, {progress=0, relief=false, previous=[]}={}) {
  const operation=choose(r,DRAWING_OPERATIONS.filter(x=>x!==previous.at(-1)));
  const theme={path:choose(r,['bow','wave','loop']),material:choose(r,['brick','brick','dots']),
    bend:between(r,-.65,.65),phase:r()*TAU,opening:between(r,.7,2.3),lobes:choose(r,[0,2,3,4]),
    amplitude:between(r,.04,.16),direction:r()<.5?-1:1};
  const budget=relief?3:Math.round(4+progress*2), leaves=[];
  const leaf=(box,parameters={})=>{
    const n={op:'path',...box,path:theme.path,material:theme.material,bend:theme.bend,
      phase:theme.phase,opening:theme.opening,lobes:theme.lobes,amplitude:theme.amplitude,
      angle:0,...parameters};leaves.push(n);return n;
  };
  const grow=(op,box,depth=0)=>{
    const {x,y,w,h}=box;
    if(op==='repeat') {
      const count=choose(r,relief?[2]:[2,3]),gap=choose(r,[27,39]),childH=(h-gap*(count-1))/count;
      const nested=depth===0&&w>270&&childH>104&&budget>=5&&r()<.48;
      const nodes=Array.from({length:count},(_,i)=>{
        const b={x:x+Math.sin(theme.phase+i*1.4)*14,y:y-h/2+childH/2+i*(childH+gap),w:w-28,h:childH};
        return nested?grow('reflect',b,depth+1):leaf(b,{path:choose(r,['bow','wave']),bend:theme.bend*(i%2?-1:1)});
      });return {op,count,relation:'rhythmic-echo',nodes};
    }
    if(op==='reflect') {
      const gap=between(r,54,89),childW=(w-gap)/2,shift=between(r,-31,31),paired=depth===0&&r()<.48;
      const left=leaf({x:x-(gap+childW)/2,y:y-shift,w:childW,h:h*.80},
        {path:'bow',angle:theme.direction*Math.PI/2,opening:between(r,1.6,2.6)});
      const right={...left,x:2*x-left.x,y:y+shift,angle:-left.angle,mirror:true};leaves.push(right);
      const nodes=[left,right];
      if(paired)nodes.push(leaf({x,y:y+h*.36,w:w*.52,h:52},{path:'bow',material:'dots',angle:0}));
      return {op,relation:paired?'opposed-wings-and-return':'opposed-gestures',nodes};
    }
    if(op==='nest') {
      const path=choose(r,['bow','loop']),scale=between(r,.43,.58),nodes=[leaf(box,{path})];
      nodes.push(leaf({x:x+theme.bend*13,y:y+between(r,-12,12),w:w*scale,h:h*scale},
        {path:choose(r,['loop','bow']),material:theme.material==='brick'?'dots':'brick',phase:theme.phase+Math.PI}));
      if(!relief&&r()<.4)nodes.push(leaf({x,y,w:54,h:54},{path:'loop',material:'dots',lobes:0}));
      return {op,relation:'frame-and-counter-rhythm',nodes};
    }
    if(op==='radial') {
      const count=choose(r,relief?[3,4]:[3,4,5,6]),reach=Math.min(w,h)/2-15;
      const nodes=Array.from({length:count},(_,i)=>{
        const angle=theme.phase+i*TAU/count;
        return leaf({x:x+Math.cos(angle)*reach*.50,y:y+Math.sin(angle)*reach*.50,w:reach*.84,h:reach*.35},
          {path:'wave',angle,bend:theme.direction*.55});
      });
      nodes.push(leaf({x,y,w:reach*1.94,h:reach*1.94},{path:'loop',material:'dots',lobes:0}));
      return {op,count,relation:'rotated-siblings-and-orbit',nodes};
    }
    // A branching drawing grows from common tangents. The generated skeleton
    // controls both its ribbons and its fruit; there is no stored tree drawing.
    const nodes=[],root={x,y:y+h*.44},depths=2;
    const fork=(p,width,length,rank,sides=[-1,1])=>{
      for(const side of sides){
        const end={x:p.x+side*width,y:p.y-length*between(r,.90,1.12)},mid={x:p.x+side*width*.13,y:p.y-length*.52};
        const n={op:'branch-path',start:{x:p.x+side*11,y:p.y-13},mid,end,
          material:theme.material,bend:theme.bend};nodes.push(n);leaves.push(n);
        if(rank>1)fork(end,width*.48,length*.81,rank-1,
          relief||r()<.24?[side*.45]:[-1,1]);
        else{const n=leaf({x:end.x,y:end.y-25,w:39,h:38},{path:'bow',material:'dots',angle:Math.PI});nodes.push(n);}
      }
    };
    fork(root,w*.24,h*.31,depths);return {op,depths,relation:'shared-stem-and-grown-heads',nodes};
  };
  const box={x:200+theme.bend*13,y:310,w:between(r,292,324),h:between(r,285,337)};
  const tree=grow(operation,box);
  // Timing is a response belonging to a drawn object, not a requirement to
  // put a mechanism into every patch. Only a circular envelope is rotated.
  const motion=operation==='radial'&&progress>.15?'hit-spin':
    operation==='nest'&&theme.lobes===0&&progress>.1&&r()<.65?'turn':null;
  return {version:1,operation,theme,tree,leaves,motion,relief};
}

function curveFor(n) {
  if(n.op==='branch-path')return cubic([[n.start.x,n.start.y],[n.mid.x,n.mid.y],
    [n.end.x,n.end.y+19],[n.end.x,n.end.y]]);
  const upright=Math.abs(Math.abs(n.angle)-Math.PI/2)<.001;
  const rx=(upright?n.h:n.w)/2,ry=(upright?n.w:n.h)/2;
  let curve;
  if(n.path==='wave') {
    const points=Array.from({length:5},(_,i)=>({x:-rx+i*n.w/4,
      y:Math.sin(i*Math.PI/2+n.phase)*ry*.55+n.bend*(i/4-.5)*ry*.55}));
    curve=spline(points,{tension:.9});
  } else if(n.path==='bow')curve=arc(0,0,rx,ry,-Math.PI/2+n.opening/2,Math.PI*1.5-n.opening/2);
  else curve=polarContour({rx,ry,lobes:n.lobes,amplitude:n.lobes?n.amplitude:0,phase:n.phase,skew:n.bend*rx*.08});
  return transform(curve,{x:n.x,y:n.y,angle:n.angle,sx:n.mirror?-1:1});
}

export function drawComposition(b,program) {
  const rows=[];
  for(const [index,n] of program.leaves.entries()) {
    const a=b.part('drawn-'+n.op,{programIndex:index,path:n.path,relation:program.tree.relation});
    const curve=curveFor(n), ps=n.material==='dots'?b.dots(a,curve,{spacing:28}):b.stroke(a,curve,{width:34,spacing:34});
    for(const p of ps)p.drawingLeaf=index;
    rows.push({a,ps,n});
  }
  if(program.motion==='hit-spin'){
    const all=rows.filter(q=>q.n.material==='brick').flatMap(q=>q.ps),a=rows[0].a;
    b.animate(a,all,{x:200+program.theme.bend*13,y:310},{rotation:program.theme.direction*TAU,
      duration:2.8,hitTrigger:true,hitMode:'spin',hitSteps:program.tree.count});
  } else if(program.motion==='turn') {
    // A circular outer shell can rotate without consuming its inner opening.
    const q=rows[0];
    if(q.n.path==='loop'&&q.n.w<=q.n.h*1.08&&q.n.h<=q.n.w*1.08)
      b.animate(q.a,q.ps,{x:q.n.x,y:q.n.y},{rotation:program.theme.direction*TAU,duration:13,cycle:true,easing:'linear'});
  }
  // Counter-rhythms belong to the drawing: path endpoints for waves, inside
  // openings for shells. There is no random sprinkle or shared background grid.
  if(['repeat','reflect'].includes(program.operation))for(const q of rows){
    const n=q.n;if(n.op!=='path')continue;
    const a=b.part('counter-phrase',{owner:q.a.id});
    if(program.operation==='repeat')for(let k=0;k<5;k++)
      b.addIfClear(a,n.x+(k-2)*39,n.y+Math.sin(k*.7+program.theme.phase)*12+27,{},5);
    else for(let k=0;k<4;k++)b.addIfClear(a,n.x,n.y+(k-1.5)*39,{},6);
  }
  return program;
}
