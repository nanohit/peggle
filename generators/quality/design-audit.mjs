import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {curateGeneratedPlaylist} from '../../js/generated-playlist.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
import {visualLevel,designMetrics,cosine} from './metrics.js';
await mkdir('data/quality',{recursive:true});
const des1=(await read('data/des1/campaign.json')).levels,des=curateGeneratedPlaylist((await read('data/des/campaign.json')).levels),gen=curateGeneratedPlaylist((await read('data/gen/alea.json')).levels),main=(await read('cdn-data/primary.json')).levels.filter((l,i,a)=>a.findIndex(q=>q.id===l.id)===i),latest=(await read('data/player/campaigns/Alea_Main.json')).levels,blast=(await read('data/gen/blast.json')).levels;
const sets={des1,des,gen,main,latest,blast};const output={};
for(const [name,levels] of Object.entries(sets)){
 const rows=[];for(const l of levels){const pegs=name==='blast'||l.pegs.some(p=>p.type.startsWith('billiard'))?l.pegs:new NativeSimulation(l).game.pegs;rows.push({...visualLevel(l,pegs),metrics:designMetrics(l,pegs)});}
 for(const l of rows)l.metrics.nearestSimilarity=Math.max(0,...rows.filter(q=>q!==l).map(q=>cosine(l.metrics.tiles,q.metrics.tiles)));
 output[name]=rows;
 console.log(name,rows.length,'packed',Math.round(rows.reduce((s,l)=>s+l.metrics.packedFraction,0)/rows.length*100)+'%','nearest similarity',+(rows.reduce((s,l)=>s+l.metrics.nearestSimilarity,0)/rows.length).toFixed(3));
}
await writeFile('data/quality/designs.json',JSON.stringify(output));
