import assert from 'node:assert/strict';
import {generateLevel,FAMILIES} from '../generators/destruction/grammar.js';
import {validateGeometry} from '../generators/destruction/evaluate.mjs';
import {NativeSimulation,simulateSequence} from '../generators/destruction/native-simulator.mjs';
for(const f of FAMILIES){
 const a=generateLevel('repro',f.id),b=generateLevel('repro',f.id);
 assert.deepEqual(a,b);assert.notDeepEqual(a,generateLevel('another',f.id));
 assert(validateGeometry(a).valid);assert.equal(a.metadata.generator.plan.assemblies.length,5);
 assert.equal(new Set(a.metadata.generator.plan.assemblies.flatMap(a=>a.pegs)).size,a.pegs.length);
}
const l=generateLevel('fork-test'),s=new NativeSimulation(l,{seed:'native-proof'}).settle(2),a=s.fork(),b=s.fork();
a.shoot(2.518);b.shoot(2.518);assert.deepEqual(a.summary(),b.summary());
const child=a.fork();child.shoot(1.255);
const replay=simulateSequence(l,[2.518,1.255],{seed:'native-proof'});
assert.deepEqual(child.summary().pose,replay.pose);assert.deepEqual(child.shots,replay.shots);
console.log('ok eight deterministic families, native fork and two-shot exact replay');
