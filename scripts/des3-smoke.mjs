import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {generateLevel,planComposition} from '../generators/destruction3/grammar.js';import {validateGeometry} from '../generators/destruction3/geometry.js';import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';import {curateGeneratedPlaylist} from '../js/generated-playlist.js';
const read=async f=>JSON.parse(await readFile(f,'utf8')),campaign=await read('data/des3/campaign.json'),proof=await read('data/des3/proof.json'),robust=await read('data/des3/robustness.json');
const hash=createHash('sha256').update((await Promise.all(proof.sources.map(f=>readFile(f)))).join('\n')).digest('hex');assert.equal(hash,proof.fingerprint,'Stale proof source fingerprint');const runtimeHash=createHash('sha256').update((await Promise.all(proof.runtimeSources.map(f=>readFile(f)))).join('\n')).digest('hex');assert.equal(runtimeHash,proof.runtimeFingerprint,'Stale native runtime');
assert(campaign.levels.length>=24);assert.equal(curateGeneratedPlaylist(campaign.levels).length,campaign.levels.length);assert(robust.rows.length===campaign.levels.length);
const allowed=['blue','orange','obstacle','bumper','bombMagnet','portalBlue','portalOrange'];let observedFields=0,transfers=0;const types=new Set();
for(const level of campaign.levels){
 const g=level.metadata.generator,p=proof.accepted.find(p=>p.id===level.id).proof,e=robust.rows.find(r=>r.id===level.id);
 assert(validateGeometry(level).valid,level.id);assert.deepEqual(generateLevel(g).pegs,level.pegs,'Saved level differs from generator');assert.deepEqual(generateLevel(g).bezierCurves,level.bezierCurves);
 assert.equal(level.pegRadius,8.5);assert.equal(level.metadata.intentGraph,undefined);assert(level.pegs.every(p=>allowed.includes(p.type)));assert(!level.pegs.some(p=>p.constructionRole==='cargo-guide'));
 for(const a of g.plan.assemblies)types.add(a.type);assert(p.complete&&p.replayComplete);
 const roots=g.plan.assemblies.filter(a=>a.role==='source').map(a=>a.id);assert(e.handoffs.some(h=>roots.includes(h.from)&&(h.contact||h.viaPortal)),level.id+' lacks observed source transfer');transfers++;
 if(g.transport==='magnet'){assert(e.fieldDisplacement>=10||e.fieldExitDifference>0);assert(e.transfer.magnetTicks>0);observedFields++;}
 const sim=new NativeSimulation(level,{seed:p.seed}).settle(p.idleSeconds);
 for(const angle of p.angles){const shot=sim.shoot(angle);assert(shot&&!shot.timeout,level.id+' native timeout');sim.settle(1.5);}
 assert.equal(sim.game.state,'won',level.id+' did not finalize victory');assert.equal(sim.game.getOrangePegsLeft(),0);
 if(g.plan.motion){const initial=new NativeSimulation(level).settle(2),copy=initial.fork();initial.settle(.3);copy.settle(.3);assert.deepEqual(copy.game.pegs,initial.game.pegs);}
}
for(const kind of ['cup','tilting-cup','sling','seesaw','bridge','portal','magnet'])assert(types.has(kind),'Vocabulary omitted '+kind);assert(observedFields>=3);
const plans=Array.from({length:100},(_,i)=>planComposition({seed:'autonomy-'+i}));assert(plans.every(p=>p.form==='grown'));assert(new Set(plans.map(p=>JSON.stringify([p.nodes.map(n=>n.role),p.edges.map(e=>[e.from,e.to,e.kind])]))).size>=10,'Default growth is a narrow scene selector');
assert(plans.some(p=>p.derivation.some(d=>d.rule==='split')));assert(plans.some(p=>p.derivation.some(d=>d.rule==='merge')));
const fix=await read('data/des3/bridge-fix.json');assert.equal(fix.rows.length,8);assert(fix.rows.every(r=>!r.guides&&r.idleTargetsPreserved&&r.shots.every(s=>!s.timeout)));
const legacy=await read('data/des/campaign.json');assert(!legacy.levels.some(l=>l.pegs.some(p=>p.constructionRole==='cargo-guide')));
const bootstrap=await readFile('js/player-bootstrap.js','utf8');assert(bootstrap.includes('destructionGenerator: !SYSTEMS_PLAYER'));assert(bootstrap.includes('SYSTEMS_PLAYER ? null : getQueryParam'));
console.log('ok',campaign.levels.length,'native winning replays;',transfers,'source transfers;',observedFields,'functional magnetic fields; bounded graph growth, native scale, ordinary rules, unlocked offline catalog, bridge fix');
