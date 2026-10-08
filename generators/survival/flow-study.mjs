import {mkdir,writeFile} from 'node:fs/promises';
import {SurvivalGenerator} from './grammar.js';

// Render the assembled strip, including edits to older background voices.
// Isolated patch thumbnails cannot reveal seams or preserve overlap behaviour.
const streams=[];
for(const seed of ['flow-01','flow-02','flow-03','flow-04','flow-05','flow-06']){
  const g=new SurvivalGenerator(seed),live=new Map(),pages=[];
  for(let i=0;i<18;i++){
    const p=g.next();for(const id of p.retiredPegIds)live.delete(id);
    for(const q of p.pegs)live.set(q.id,q);
    pages.push({index:p.index,family:p.family,distance:p.flow.distance,advance:p.height,knockback:p.knockback});
  }
  streams.push({seed,pegs:[...live.values()],pages});
}
await mkdir('generators/survival/study',{recursive:true});
await writeFile('generators/survival/study/flow-streams.json',JSON.stringify(streams));
console.log('Assembled six client-generated strips');
