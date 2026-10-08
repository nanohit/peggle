import {bakePegsFromSamples,sampleCubicBezier} from '../destruction2/bezier-geometry.js';

export const TAU=Math.PI*2;
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const between=(r,a,b)=>a+(b-a)*r();
export const choose=(r,a)=>a[Math.floor(r()*a.length)];
export const cubic=points=>Object.fromEntries(['start','h1','h2','end'].map((k,i)=>[k,{x:points[i][0],y:points[i][1]}]));
export function transform(curve,{x=0,y=0,angle=0,sx=1,sy=1}={}){
 const co=Math.cos(angle),si=Math.sin(angle),p=q=>({x:x+co*q.x*sx-si*q.y*sy,y:y+si*q.x*sx+co*q.y*sy});
 return curve.segments?{segments:curve.segments.map(c=>transform(c,{x,y,angle,sx,sy}))}:Object.fromEntries(['start','h1','h2','end'].map(k=>[k,p(curve[k])]));
}
export function arc(x,y,rx,ry,start=0,end=TAU){
 const n=Math.ceil(Math.abs(end-start)/(Math.PI/2)),segments=[];
 for(let i=0;i<n;i++){const a=start+(end-start)*i/n,b=start+(end-start)*(i+1)/n,k=4/3*Math.tan((b-a)/4);segments.push(cubic([
  [x+rx*Math.cos(a),y+ry*Math.sin(a)],[x+rx*(Math.cos(a)-k*Math.sin(a)),y+ry*(Math.sin(a)+k*Math.cos(a))],
  [x+rx*(Math.cos(b)+k*Math.sin(b)),y+ry*(Math.sin(b)-k*Math.cos(b))],[x+rx*Math.cos(b),y+ry*Math.sin(b)]]));}
 return {segments};
}
// Interpolating cubics turn a generated skeleton/contour into a single joined
// centerline. Peg boundaries are arc-length boundaries, never chord substitutes.
export function spline(points,{closed=false,tension=1}={}){
 const n=points.length,at=i=>points[closed?(i+n)%n:clamp(i,0,n-1)],segments=[];
 for(let i=0;i<(closed?n:n-1);i++){const a=at(i-1),b=at(i),c=at(i+1),d=at(i+2);segments.push(cubic([
  [b.x,b.y],[b.x+(c.x-a.x)*tension/6,b.y+(c.y-a.y)*tension/6],
  [c.x-(d.x-b.x)*tension/6,c.y-(d.y-b.y)*tension/6],[c.x,c.y]]));}
 return {segments};
}
export function polarContour({rx,ry,lobes=0,amplitude=0,phase=0,skew=0}){
 const n=Math.max(16,lobes*8),points=Array.from({length:n},(_,i)=>{const t=i*TAU/n,r=1+amplitude*Math.cos(lobes*t+phase);return {x:rx*r*Math.cos(t)+skew*Math.sin(t)**2,y:ry*r*Math.sin(t)};});
 return spline(points,{closed:true});
}
export function fishProfile({length,depth,nose=.25,bend=0}){
 const neck=-length*.4,tip=length*.52;
 return {segments:[cubic([[neck,-depth*.14],[-length*.18,-depth*.85+bend],[length*nose,-depth*.72+bend],[tip,0]]),cubic([[tip,0],[length*nose,depth*.7+bend],[-length*.18,depth*.8+bend],[neck,depth*.14]]),
  ...spline([{x:neck,y:depth*.14},{x:-length*.64,y:depth*.68},{x:-length*.59,y:0},{x:-length*.64,y:-depth*.68},{x:neck,y:-depth*.14}],{tension:.3}).segments]};
}
export function trimCubic(curve,start=0,end=0){
 const marks=sampleCubicBezier(curve),lengths=[0];for(let i=1;i<marks.length;i++)lengths.push(lengths[i-1]+Math.hypot(marks[i].x-marks[i-1].x,marks[i].y-marks[i-1].y));
 const total=lengths.at(-1),parameter=distance=>{let i=lengths.findIndex(v=>v>=distance);if(i<1)return distance?1:0;return (i-1+(distance-lengths[i-1])/(lengths[i]-lengths[i-1]))/(marks.length-1);};
 const split=(c,t)=>{const lerp=(a,b)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}),a=c.start,b=c.h1,d=c.h2,e=c.end,ab=lerp(a,b),bd=lerp(b,d),de=lerp(d,e),abd=lerp(ab,bd),bde=lerp(bd,de),p=lerp(abd,bde);return [{start:a,h1:ab,h2:abd,end:p},{start:p,h1:bde,h2:de,end:e}];};
 const ta=parameter(Math.min(total*.4,start)),tb=parameter(Math.max(total*.6,total-end)),first=split(curve,tb)[0];return split(first,ta/tb)[1];
}
export function samples(curve,options){return bakePegsFromSamples(sampleCubicBezier(curve),options);}

// A branching skeleton is grown recursively from local angle/length laws.
// Geometry is generated from the new tree, not selected from a stored drawing.
export function growBranches(r,{x,y,length,angle=-Math.PI/2,depth=3,spread=.7,shrink=.66}){
 const edges=[],leaves=[];
 function grow(a,len,heading,rank){
  const bend=between(r,-.18,.18),b={x:a.x+Math.cos(heading+bend)*len,y:a.y+Math.sin(heading+bend)*len};
  edges.push({a,b,rank,curve:cubic([[a.x,a.y],[a.x+Math.cos(heading)*len*.4,a.y+Math.sin(heading)*len*.4],[b.x-Math.cos(heading+bend)*len*.3,b.y-Math.sin(heading+bend)*len*.3],[b.x,b.y]])});
  if(!rank){leaves.push(b);return;}
  const children=rank===depth?choose(r,[2,3]):2;
  for(let i=0;i<children;i++)grow(b,len*shrink*between(r,.9,1.1),heading+(i-(children-1)/2)*spread+between(r,-.1,.1),rank-1);
 }
 grow({x,y},length,angle,depth);return {edges,leaves};
}
