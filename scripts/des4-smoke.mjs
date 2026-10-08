import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {generateLevel,DOMAINS} from '../generators/destruction4/grammar.js';
import {validateGeometry} from '../generators/destruction4/geometry.js';
import {NativeSimulation} from '../generators/destruction/native-simulator.mjs';
import {geometryKey} from '../generators/destruction3/cache.mjs';
import {curateGeneratedPlaylist} from '../js/generated-playlist.js';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const campaign=await read('data/des4/campaign.json'),proof=await read('data/des4/proof.json'),holdout=await read('data/des4/robustness.json');
const hash=createHash('sha256').update((await Promise.all(proof.sources.map(p=>readFile(p)))).join('\n')).digest('hex');assert.equal(hash,proof.fingerprint,'Proof must match current generator, evaluator and native runtime');
assert.equal(campaign.levels.length,32);assert.equal(curateGeneratedPlaylist(campaign.levels).length,32);assert.equal(holdout.fingerprint,proof.fingerprint);assert.equal(holdout.rows.length,32);
const domains=new Set(),sizes=new Set(),allowed=new Set(['blue','orange','bumper','bombMagnet','portalBlue','portalOrange']);let portals=0,fields=0,triggered=0,houses=0;
for(const l of campaign.levels){
 const g=l.metadata.generator,row=proof.accepted.find(r=>r.id===l.id),p=row.proof,h=holdout.rows.find(r=>r.id===l.id),e=row.evidence;
 domains.add(g.domain);assert(validateGeometry(l).valid,l.id);assert.equal(geometryKey(generateLevel(g)),geometryKey(l),'Catalog must come from numerical generator');assert.equal(row.geometryKey,geometryKey(l));
 assert.equal(l.pegRadius,8.5);assert.equal(l.ballCount,12);assert(l.bucketEnabled&&l.hitPegTimedClearEnabled);assert(!l.metadata.intentGraph);assert(l.pegs.every(p=>allowed.has(p.type)));assert(!l.pegs.some(p=>p.type==='obstacle'));
 l.pegs.filter(p=>p.shape==='circle'&&!p.type.startsWith('portal')).forEach(p=>sizes.add(p.radiusScale||1));
 assert(p.complete&&p.replayComplete&&e.complete&&row.envelope.valid);assert(h.adaptive.complete&&h.adaptive.replayComplete&&h.envelope.valid);
 if(g.domain==='switchback'){assert(e.portalEvents.length+e.bodyPortalEvents.length>0);portals++;}
 if(l.pegs.some(p=>p.type==='bombMagnet')){assert(e.fieldDifference>=12||e.fieldExitDifference>0);fields++;}
 if(l.groups.some(g=>g.animation?.hitTrigger)){assert(e.triggerMotion.some(m=>m.distance>=7));triggered++;}
 if(g.domain==='architecture'){assert(e.collapse.length>=2);houses++;}
 const sim=new NativeSimulation(l,{seed:p.seed}).settle(p.idleSeconds);for(const angle of p.angles){const shot=sim.shoot(angle);assert(shot&&!shot.timeout,l.id+' native timeout');sim.settle(1.5);}assert.equal(sim.game.state,'won',l.id);assert.equal(sim.game.getOrangePegsLeft(),0);
 console.log('ok winning replay',l.id);
}
assert.equal(domains.size,DOMAINS.length);assert(portals>=2&&fields>=3&&triggered>=10&&houses>=2);assert(sizes.size>8);
// Unpublished seeds must synthesize new contours/branches without a model or
// catalog lookup. No claim that arbitrary raw seeds are physically certified.
const recipes=Array.from({length:80},(_,i)=>generateLevel({seed:'autonomy-'+i,domain:'morphogenesis'}));
assert.equal(new Set(recipes.map(l=>geometryKey(l))).size,80);assert(new Set(recipes.map(l=>JSON.stringify(l.metadata.generator.plan.recipes))).size>70);assert(recipes.some(l=>l.metadata.generator.relations.length>=2));
const auto=Array.from({length:160},(_,i)=>generateLevel({seed:'default-'+i}));assert.equal(new Set(auto.map(l=>l.metadata.generator.domain)).size,DOMAINS.length);assert.deepEqual(generateLevel({seed:'deterministic'}),generateLevel({seed:'deterministic'}));
const bootstrap=await readFile('js/player-bootstrap.js','utf8');assert(bootstrap.includes("FIELDS_PLAYER ? '/data/des4/campaign.json'"));assert(bootstrap.includes('destructionGenerator: !SYSTEMS_PLAYER'));assert(bootstrap.includes('SYSTEMS_PLAYER ? null : getQueryParam'));
console.log('ok 32 native winning replays; 13 design laws, computed unpublished shapes, native scales, ordinary rules and unlocked offline catalog');
