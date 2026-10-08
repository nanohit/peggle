import {designMetrics,cosine} from '../quality/metrics.js';

export const ACTION_NAMES={aim:'Рисунок и прицеливание',banks:'Направляющие и рикошеты',timing:'Движение и момент удара',portal:'Возврат через портал',release:'Разрушение опор',handoff:'Передача груза',balance:'Баланс и смена нагрузки',field:'Магнитный груз'};
export const SOURCE_NAMES={alea:'Alea',blast:'Blast → Alea',des1:'Des1',des2:'Des2',des3:'Des3',des5:'Des5',fresh:'Новые формации'};
export function profile(level,source,proof){
 const m=designMetrics(level),g=level.metadata?.generator||{},plan=g.plan||{},parts=g.parts||plan.assemblies||plan.nodes||[];
 const motion=(level.groups||[]).filter(g=>g.animation),hinges=level.pegs.filter(p=>p.destructionHinge?.enabled),bricks=level.pegs.filter(p=>p.shape==='brick');
 const transport=level.pegs.some(p=>p.type.startsWith('portal')),magnet=level.pegs.some(p=>p.type==='bombMagnet');
 const carrier=parts.some(p=>String(p.kind||p.type).includes('carrier'))||plan.sketch?.gesture==='balance';
 let action=source==='des5'?(carrier?'balance':'handoff'):source==='des3'?'handoff':source==='des1'?'release':motion.length?'timing':bricks.length>10?'banks':'aim';
 if(transport&&proof.portalTeleports>0)action='portal';
 if(magnet&&['des1','des3','des5'].includes(source))action='field';
 const gravity=['des1','des3','des5'].includes(source)||['release','handoff','balance','field'].includes(action);
 // "grown" is a generation mode, not a formation: distinguish its actual
 // receiver system instead of discarding all but one of the strongest Des3s.
 const mechanismFamily=source==='des3'?parts.filter(p=>['receiver','catcher'].includes(p.role)).map(p=>p.type).sort().join('+'):null;
 const family=mechanismFamily||g.form||g.layout||g.family||(source==='des1'?g.mode:source==='des5'?plan.sketch?.gesture:motion.length?'animated-'+Math.min(4,motion.length):'static-'+Math.round(bricks.length/12))||action;
 const orient=Array(6).fill(0);for(const p of bricks)orient[Math.min(5,Math.floor(((p.angle||0)%Math.PI+Math.PI)%Math.PI/Math.PI*6))]++;
 const features=[m.pegs/90,m.occupiedCells/70,m.packedFraction,bricks.length/Math.max(1,m.pegs),motion.length/8,hinges.length/8,m.targetSpanX/400,m.targetBelow520/Math.max(1,m.targets)];
 return {id:level.id,source,action,gravity,family:String(family),shots:proof.shots,firstFraction:proof.peakFirstFraction,pegs:m.pegs,targets:m.targets,density:m.occupiedCells/60,packed:m.packedFraction,tiles:m.tiles,orientation:orient,features,
  transport,magnet,motion:motion.length>0,bodyCount:level.groups?.filter(g=>g.destructionBody).length||0};
}
export function similarity(a,b){
 const distance=a.features.reduce((s,v,i)=>s+Math.min(1,Math.abs(v-b.features[i])),0)/a.features.length;
 return cosine(a.tiles,b.tiles)*.45+cosine(a.orientation,b.orientation)*.15+(1-distance)*.20+(a.family===b.family?.20:0);
}
