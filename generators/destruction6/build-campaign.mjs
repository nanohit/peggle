import {readFile,writeFile} from 'node:fs/promises';
import {generateSequence,DEFAULT_SEED} from './director.js';
const bank=JSON.parse(await readFile('data/des6/bank.json','utf8'));
const sequence=generateSequence(bank.entries,{seed:process.env.DES6_SEED||DEFAULT_SEED});
await writeFile('data/des6/campaign.json',JSON.stringify({name:'Alea · Разные истории',version:'0.1',seed:sequence.seed,fingerprint:bank.fingerprint,sources:bank.sources,sequence:sequence.rows.map(r=>({id:r.id,source:r.source})),audit:sequence.audit}));
await writeFile('data/des6/sequence.json',JSON.stringify(sequence));
console.log('campaign',sequence.count,sequence.audit.sources,sequence.audit.actions,'similarity',sequence.audit.meanAdjacentSimilarity);
