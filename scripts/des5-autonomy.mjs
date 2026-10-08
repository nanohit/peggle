import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {generateLevel} from '../generators/destruction5/grammar.js';
import {boundedIntent} from '../generators/destruction5/client.js';
import {geometryKey} from '../generators/destruction3/cache.mjs';
const rows=[];
for(let i=0;i<12;i++)for(const branching of [.12,.86]){
 const level=generateLevel({seed:'unpublished-system-'+i,genome:{branching}}),g=level.metadata.generator;
 rows.push({seed:g.seed,branching,key:geometryKey(level),topology:g.plan.topology,recipes:g.plan.nodes.map(n=>n.recipe),sources:g.plan.contributions});
}
const pairedChanges=Array.from({length:12},(_,i)=>rows[i*2].key!==rows[i*2+1].key).filter(Boolean).length;
await writeFile('/tmp/des5-autonomy-raw.json',JSON.stringify(rows));
assert(new Set(rows.map(r=>r.key)).size>=16,'Distinct synthesis across unseen seeds and branch intent');
assert(pairedChanges>=4,'Mechanical compositions must respond structurally to branch intent');
const mean=(a,k)=>a.reduce((s,r)=>s+r.topology[k],0)/a.length,low=rows.filter(r=>r.branching<.5),high=rows.filter(r=>r.branching>.5);
assert(rows.some(r=>r.recipes.some(p=>p.bays?.length===3))&&rows.some(r=>r.recipes.some(p=>p.bays?.length===1)),'Branch intent must grow different compound mechanisms');
assert(new Set(rows.map(r=>JSON.stringify(r.topology.degrees.map(n=>[n.inputs,n.outputs])))).size>=4,'A seed must grow structure, not only move a fixed diagram');
assert(rows.some(r=>r.sources.des2>0)&&rows.some(r=>r.sources.des3>0)&&rows.some(r=>r.sources.des4>0));
assert.deepEqual(generateLevel({seed:'determinism'}),generateLevel({seed:'determinism'}));
assert.deepEqual(boundedIntent({branching:20,pegScale:.01,direction:0}),{branching:1,pegScale:1,direction:1});assert.throws(()=>boundedIntent({balls:50}));assert.throws(()=>boundedIntent({bend:NaN}));
await writeFile('data/des5/autonomy.json',JSON.stringify({method:'12 unpublished seeds, paired low/high branch intent; freshly computed numerical sketches, curves and compound body attachments. Changing branching affects mechanical compositions, while other play intentions may legitimately remain unchanged.',distinct:new Set(rows.map(r=>r.key)).size,pairedChanges,lowMeanBranches:mean(low,'branches'),highMeanBranches:mean(high,'branches'),lowMeanDepth:mean(low,'depth'),highMeanDepth:mean(high,'depth'),rows},null,2));
console.log('autonomy: distinct',new Set(rows.map(r=>r.key)).size,'changed pairs',pairedChanges,'low/high mean branches',mean(low,'branches'),mean(high,'branches'));
