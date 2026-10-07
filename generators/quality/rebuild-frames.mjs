import {readFile,writeFile} from 'node:fs/promises';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
import {generateLevel} from '../destruction2/grammar.js';
import {visualLevel} from './metrics.js';
import {curateGeneratedPlaylist} from '../../js/generated-playlist.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
function frames(level,p){
 const replay=new NativeSimulation(level,{seed:p.seed}).settle(p.idleSeconds??3),frames=[{turn:0,...visualLevel(level,replay.game.pegs)}];
 for(const [i,a] of p.angles.entries()){
  replay.samples=[];replay.shoot(a,{trace:true});replay.settle(1.5);
  const path=replay.samples.filter((_,i)=>i%6===0).map(s=>s.balls[0]).filter(Boolean);
  frames.push({turn:i+1,...visualLevel(level,replay.game.pegs),paths:[path]});
 }
 if(p.replayComplete!==replay.summary().complete)throw Error('Replay outcome changed: '+level.id);
 return frames;
}
const proof=await read('data/des2/proof.json'),candidates=await read('data/des2/candidates.json');
for(const r of candidates.results)r.proof.frames=frames(generateLevel(r.options),r.proof);
for(const r of proof.accepted)r.proof.frames=candidates.results.find(q=>q.id===r.id).proof.frames;
await writeFile('data/des2/candidates.json',JSON.stringify(candidates));await writeFile('data/des2/proof.json',JSON.stringify(proof,null,2));
const machine=await read('data/quality/machine.json'),levels={des1:(await read('data/des1/campaign.json')).levels,des:curateGeneratedPlaylist((await read('data/des/campaign.json')).levels),gen:curateGeneratedPlaylist((await read('data/gen/alea.json')).levels),latest:(await read('data/player/campaigns/Alea_Main.json')).levels};
for(const [name,rs] of Object.entries(machine.sets))for(const r of rs)r.frames=frames(levels[name].find(l=>l.id===r.id),r);
await writeFile('data/quality/machine.json',JSON.stringify(machine));console.log('Native replay frames rebuilt as immutable geometry snapshots');
