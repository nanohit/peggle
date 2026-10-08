import {cubic,between,choose,TAU} from '../destruction4/shapes.js';
import {objectBounds,overlapDepth} from '../destruction2/ribbon-geometry.js';

// A drawing continues beyond a compiler page. Its two voices have independent
// entrances, rests and materials; an episode belongs to that ongoing gesture.
// Page extents never determine empty rows or the placement of power-ups.
export class FlowComposer {
  constructor(r) {
    this.distance=0;this.phase=r()*TAU;this.amplitude=between(r,98,134);
    this.left=200+this.amplitude*Math.sin(this.phase);this.right=400-this.left;
    this.leftSlope=this.amplitude/250*Math.cos(this.phase);this.rightSlope=-this.leftSlope;
    this.phraseLeft=0;this.side=r()<.5?-1:1;
    this.voicePhase=between(r,0,400);this.theme=null;
  }

  plan(r,{family,progress}) {
    if(this.phraseLeft--<=0) {
      this.phraseLeft=choose(r,[3,4,5]);
      this.theme={path:choose(r,['bow','wave','loop']),material:choose(r,['brick','brick','dots']),
        bend:between(r,-.55,.55),phase:r()*TAU,opening:between(r,1,2.4),
        lobes:choose(r,[0,2,3]),amplitude:between(r,.04,.12),direction:this.side};
      this.bankMaterial=choose(r,['brick','dots']);
    }
    const mechanical=family!=='drawing', broad=!mechanical&&r()<.30;
    const advance=between(r,mechanical?282:broad?250:195,mechanical?330:broad?305:265);
    const phase=this.phase+(this.distance+advance)/250;
    const left=200+this.amplitude*Math.sin(phase),right=400-left;
    const leftSlope=this.amplitude/250*Math.cos(phase),rightSlope=-leftSlope;
    const bank=(x,end,slope,nextSlope)=>cubic([[x,140],[x+slope*advance/3,140+advance/3],
      [end-nextSlope*advance/3,140+advance*2/3],[end,140+advance]]);
    const banks=[bank(this.left,left,this.leftSlope,leftSlope),bank(this.right,right,this.rightSlope,rightSlope)];
    this.left=left;this.right=right;this.leftSlope=leftSlope;this.rightSlope=rightSlope;
    this.side=-this.side;
    const width=broad?between(r,266,304):between(r,165,214);
    const x=broad?between(r,183,217):200+this.side*between(r,49,68);
    const box={x,y:140+advance*.42,w:width,h:between(r,broad?230:190,broad?292:250)};
    const plan={distance:this.distance,advance,side:this.side,broad,box,banks,
      theme:{...this.theme,material:r()<.3?(this.theme.material==='brick'?'dots':'brick'):this.theme.material,
        bend:this.theme.bend+between(r,-.10,.10),phase:this.theme.phase+this.distance/850},
      bankMaterial:this.bankMaterial,voicePhase:this.voicePhase,progress};
    this.distance+=advance;
    return plan;
  }
}

export const drawingVoids=program=>(program?.leaves||[]).filter(n=>n.path==='loop')
  .map(n=>({x:n.x,y:n.y,rx:n.w/2+20,ry:n.h/2+20,angle:n.angle||0}));

export function insideDrawingVoid(p,voids) {
  return voids.some(v=>{
    const dx=p.x-v.x,dy=p.y-v.y,co=Math.cos(v.angle),si=Math.sin(v.angle);
    return ((dx*co+dy*si)/v.rx)**2+((-dx*si+dy*co)/v.ry)**2<1;
  });
}

export function drawFlow(b,plan,voids=[]) {
  const all=[];
  for(const [voice,curve] of plan.banks.entries()) {
    const a=b.part('flow-bank',{voice}),material=voice===0?plan.bankMaterial:
      plan.bankMaterial==='brick'?'dots':'brick';
    const members=material==='brick'?b.stroke(a,curve,{width:34,spacing:34}):b.dots(a,curve,{spacing:28});
    const owned=new Set(members),others=b.pegs.filter(p=>!owned.has(p)).map(p=>b.sized(p));
    for(const p of others)p._ribbonBounds=objectBounds(p);
    const kept=[];
    for(const p of members) {
      const d=plan.distance+p.y-140+plan.voicePhase;
      // These rests belong to each long phrase, not to generation boundaries.
      // The second voice overlaps the first voice's rests in a different metre.
      const phase=((d+(voice?247:0))%(voice?619:733)+(voice?619:733))%(voice?619:733);
      const primaryPhase=((d%733)+733)%733;
      const sounding=phase>(voice?366:180)||(voice===1&&primaryPhase<=180);
      const q=b.sized(p,3);q._ribbonBounds=objectBounds(q);
      const clear=others.every(o=>overlapDepth(q,o)<.1);
      if(sounding&&clear&&!insideDrawingVoid(p,voids)){p.flowVoice=voice;kept.push(p);all.push(p);}
    }
    const keep=new Set(kept);
    b.pegs=b.pegs.filter(p=>!owned.has(p)||keep.has(p));
  }
  return all;
}

// Keep only a bounded, immutable rest-pose tail. Native moving pegs must not
// change future generation, and rebasing must translate the compiler tail too.
export function appendToTail(tail,pegs,cursor,b) {
  return [...tail,...pegs].filter(p=>objectBounds(b.sized(p)).maxY>cursor-500)
    .map(p=>({...p,curveSlices:p.curveSlices?.map(s=>({...s}))}));
}
