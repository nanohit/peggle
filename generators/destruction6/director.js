import {randomFrom} from '../destruction/grammar.js';
import {similarity,ACTION_NAMES} from './profile.js';

export const DEFAULT_SEED='des6-night-01';
export const DEFAULT_WEIGHTS={alea:6,blast:8,des1:4,des2:8,des3:6,des5:8,fresh:8};
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
function allocation(entries,count,weights){
 const available=Object.fromEntries(Object.keys(weights).map(k=>[k,entries.filter(e=>e.source===k).length])),total=Object.values(weights).reduce((s,n)=>s+n,0),q={};
 const fractions=[];for(const [k,w] of Object.entries(weights)){const raw=count*w/total;q[k]=Math.min(available[k],Math.floor(raw));fractions.push({k,rest:raw-Math.floor(raw)});}
 fractions.sort((a,b)=>b.rest-a.rest);while(Object.values(q).reduce((s,n)=>s+n,0)<count){let added=false;for(const {k} of fractions){if(q[k]<available[k]){q[k]++;added=true;if(Object.values(q).reduce((s,n)=>s+n,0)===count)break;}}if(!added)throw Error('Not enough distinct proven levels');}
 return q;
}
export function auditSequence(rows){
 const errors=[],windows=[];
 if(new Set(rows.map(r=>r.id)).size!==rows.length)errors.push('duplicate-level');
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i];
  if(a.action===b.action)errors.push('same-action:'+i);
  if(a.gravity&&b.gravity)errors.push('consecutive-gravity:'+i);
  if(a.source===b.source)errors.push('same-source:'+i);
  for(let d=1;d<=3&&i-d>=0;d++)if(rows[i-d].family===b.family)errors.push('formation-cooldown:'+i);
 }
 for(let i=7;i<rows.length;i++){
  const w=rows.slice(i-7,i+1),actions=new Set(w.map(r=>r.action)),sources=new Set(w.map(r=>r.source)),heavy=w.filter(r=>r.gravity).length;
  const e={start:i-7,actions:actions.size,sources:sources.size,gravity:heavy};windows.push(e);
  if(actions.size<4||sources.size<4||heavy>4)errors.push('narrow-window:'+i);
 }
 return {valid:errors.length===0,errors,windows,sources:Object.fromEntries([...new Set(rows.map(r=>r.source))].map(s=>[s,rows.filter(r=>r.source===s).length])),actions:Object.fromEntries([...new Set(rows.map(r=>r.action))].map(s=>[s,rows.filter(r=>r.action===s).length])),meanAdjacentSimilarity:rows.slice(1).reduce((s,r,i)=>s+similarity(r,rows[i]),0)/Math.max(1,rows.length-1)};
}
// Generate a campaign, not a super-level. Conditions govern the itinerary only;
// they add no stages, new mechanics, objective or ordering requirement in a board.
export function generateSequence(entries,{seed=DEFAULT_SEED,count=48,weights=DEFAULT_WEIGHTS}={}){
 seed=String(seed).slice(0,80);count=clamp(Math.floor(count),8,64);
 const sorted=entries.slice().sort((a,b)=>a.id.localeCompare(b.id)),quotas=allocation(sorted,count,weights),rng=randomFrom(seed+':director-v1');
 const families=Object.fromEntries(Object.keys(quotas).map(s=>[s,[...new Set(sorted.filter(e=>e.source===s).map(e=>e.family))]]));
 const caps={};for(const [s,n] of Object.entries(quotas)){let cap=1;while(families[s].reduce((total,f)=>total+Math.min(cap,sorted.filter(r=>r.source===s&&r.family===f).length),0)<n)cap++;caps[s]=cap;}
 // First preserve a portfolio of formations, then solve its order. Choosing
 // levels and their positions greedily together starves rare roles at the end.
 const portfolio=[];
 for(const [source,n] of Object.entries(quotas)){
  const candidates=sorted.filter(e=>e.source===source).map(row=>({row,tie:rng()}));
  for(let k=0;k<n;k++){
   const missing=families[source].filter(f=>!portfolio.some(r=>r.source===source&&r.family===f));
   let best=null,bestScore=-Infinity;
   for(const c of candidates){
    if(portfolio.includes(c.row))continue;
    const uses=portfolio.filter(r=>r.source===source&&r.family===c.row.family).length;
    if(uses>=caps[source])continue;
    if(n>=families[source].length&&n-k<=missing.length&&!missing.includes(c.row.family))continue;
    const score=c.tie*.45-uses*1.5-portfolio.filter(r=>r.action===c.row.action).length*.06+(portfolio.length?1-Math.max(...portfolio.map(r=>similarity(r,c.row))):.4);
    if(score>bestScore){best=c.row;bestScore=score;}
   }
   if(!best)throw Error('Formation portfolio exhausted '+source);portfolio.push(best);
  }
 }
 const sim=portfolio.map(a=>portfolio.map(b=>similarity(a,b))),phase=rng()*Math.PI*2;
 const cost=order=>{
  let hard=0,soft=0;
  for(let i=0;i<count;i++){
   const row=portfolio[order[i]],prev=i?portfolio[order[i-1]]:null;
   if(prev){hard+=Number(prev.action===row.action)+Number(prev.source===row.source)+Number(prev.gravity&&row.gravity);soft+=sim[order[i-1]][order[i]]*.9;}
   for(let d=1;d<=3&&i-d>=0;d++)hard+=Number(portfolio[order[i-d]].family===row.family);
   if(i>=7){const w=order.slice(i-7,i+1).map(j=>portfolio[j]);hard+=Math.max(0,4-new Set(w.map(r=>r.action)).size)+Math.max(0,4-new Set(w.map(r=>r.source)).size)+Math.max(0,w.filter(r=>r.gravity).length-4);}
   const desired=4.5+1.7*Math.sin(i/3.6+phase);soft+=Math.abs(Math.min(9,row.shots)-desired)*.045;
   if(prev?.shots>=7&&row.shots>=7)soft+=.35;
  }
  return {hard,value:hard*50+soft};
 };
 let best=null,bestCost=null;
 for(let restart=0;restart<4;restart++){
  let order=Array.from({length:count},(_,i)=>i);for(let i=count-1;i>0;i--){const j=Math.floor(rng()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  let current=cost(order);
  for(let turn=0;turn<9000;turn++){
   const a=Math.floor(rng()*count),b=Math.floor(rng()*count);if(a===b)continue;
   [order[a],order[b]]=[order[b],order[a]];const next=cost(order),temperature=20*Math.pow(.0006,turn/9000);
   if(next.value<current.value||rng()<Math.exp((current.value-next.value)/temperature))current=next;else [order[a],order[b]]=[order[b],order[a]];
   if(!bestCost||current.value<bestCost.value){best=order.slice();bestCost=current;}
  }
  if(bestCost.hard===0)break;
 }
 const rows=best.map(i=>portfolio[i]),audit=auditSequence(rows);if(!audit.valid)throw Error('No diverse itinerary: '+audit.errors.join(','));
 return {version:'0.1',seed,count,quotas,rows,audit};
}
export function materializeSequence(sequence,sources){
 return sequence.rows.map((entry,index)=>{
  const original=sources[entry.source]?.levels.find(l=>l.id===entry.id);if(!original)throw Error('Missing source level '+entry.id);
  const title=original.name.replace(/^\d+\s*·\s*/,'');
  const level=structuredClone(original);level.name=(index+1)+' · '+(/^\d+$/.test(title)?ACTION_NAMES[entry.action]:title);
  level.metadata={...level.metadata,campaign6:{source:entry.source,originalId:entry.id,action:entry.action,seed:sequence.seed,index}};
  return level;
 });
}
