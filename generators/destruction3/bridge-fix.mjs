import {readFile,writeFile} from 'node:fs/promises';import {NativeSimulation} from '../destruction/native-simulator.mjs';import {visualLevel} from '../quality/metrics.js';
const campaign=JSON.parse(await readFile('data/des/campaign.json','utf8')),rows=[];
for(const level of campaign.levels){const bridges=level.metadata.generator.plan.assemblies.filter(a=>a.type==='bridge');if(!bridges.length)continue;
 const sim=new NativeSimulation(level).settle(3),initial=sim.game.getOrangePegsLeft(),shots=[];
 for(const angle of [.7,Math.PI/2,Math.PI-.7]){const fork=sim.fork(),shot=fork.shoot(angle,{trace:true});shots.push({angle,timeout:shot.timeout,seconds:shot.seconds,cleared:shot.cleared,remaining:fork.game.getOrangePegsLeft(),frame:visualLevel(level,fork.game.pegs)});}
 rows.push({id:level.id,bridgeIds:bridges.map(b=>b.id),guides:level.pegs.filter(p=>p.constructionRole==='cargo-guide').length,idleTargetsPreserved:initial===level.pegs.filter(p=>p.type==='orange').length,shots});console.log(level.id,shots.map(s=>s.timeout?'TIMEOUT':s.seconds.toFixed(1)).join('/'));
}
await writeFile('data/des3/bridge-fix.json',JSON.stringify({note:'Photographed paired bridge exists in /des, not the current /des2 catalog. All four guide posts removed from every published occurrence and the source grammar. Native broad-shot checks exercise real Game; they are not a full new certification of the legacy campaign.',rows},null,2));
