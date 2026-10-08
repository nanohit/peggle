import {TAU,between,spline} from '../destruction4/shapes.js';

// These programs synthesize centerlines from a bounded field, not from stored
// drawings. The physical envelope and shared intent determine their degrees
// of freedom; peg size never changes to rescue a crowded proposal.
export function receiverBoundary({x,y,w,h,direction=1},g,r){
 const depth=h*between(r,.59,.79),lip=y-h*.32,lean=(g.bend*.14+between(r,-.08,.08))*w,
  exponent=between(r,.65,1.5),split=Math.max(0,g.branching-.55)*depth*.62,
  tilt=direction*between(r,0,.16)*h;
 const point=t=>({x:x+Math.cos(t*Math.PI)*w/2+lean*Math.sin(t*Math.PI)**2,
  y:lip+depth*Math.sin(t*Math.PI)**exponent-split*Math.sin(t*TAU)**2+tilt*Math.cos(t*Math.PI)});
 const anchors=Array.from({length:13},(_,i)=>point(i/12));
 return {curve:spline(anchors,{tension:.86}),bottom:point(.5),lip,
  program:{operator:'aperture-field',mouth:w,depth,lean,exponent,split,tilt,anchors}};
}

export function flowBoundary({x,y,w,h,direction:d=1},g,r){
 const turns=h>145&&g.complexity>.6?2:1,amplitude=w*between(r,.28,.41),bias=g.bend*w*.10,
  count=turns*4+1,anchors=Array.from({length:count},(_,i)=>{const t=i/(count-1);return {
   x:x-d*amplitude*Math.cos(t*Math.PI*turns)+bias*Math.sin(t*Math.PI),y:y+h*(t-.5)*.84};});
 return {curve:spline(anchors,{tension:between(r,.6,.95)}),anchors,
  program:{operator:'flow-field',turns,amplitude,bias,anchors}};
}

export function envelopeBoundary({x,y,w,h},g,r,{closed=false}={}){
 const rx=w*.45,ry=h*.44,terms=[2,3,5].map(frequency=>({frequency,
  amplitude:between(r,-.085,.085)*(1-g.openness*.35),phase:g.phase+between(r,-.8,.8)})),
  normalization=1+terms.reduce((s,t)=>s+Math.abs(t.amplitude),0),
  opening=closed?0:between(r,.65,1.25)*g.openness,
  span=TAU-opening*2,count=closed?40:37,anchors=Array.from({length:count},(_,i)=>{
   const theta=-Math.PI/2+opening+span*i/(count-(closed?0:1)),
    radius=(1+terms.reduce((s,t)=>s+t.amplitude*Math.cos(t.frequency*theta+t.phase),0))/normalization;
   return {x:x+rx*radius*Math.cos(theta)+g.bend*12*Math.sin(theta)**2,y:y+ry*radius*Math.sin(theta)};
  });
 return {curve:spline(anchors,{closed,tension:.95}),rx,ry,opening,
  program:{operator:'harmonic-envelope',terms,normalization,opening,anchors}};
}
