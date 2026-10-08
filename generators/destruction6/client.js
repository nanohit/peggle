import {generateSequence,materializeSequence,DEFAULT_SEED} from './director.js';
export {generateSequence,materializeSequence,DEFAULT_SEED};

export async function resolveCampaign6({manifest,bank,loadSource,seed,buildSequence=generateSequence}){
 const entries=new Map(bank.entries.map(e=>[e.source+':'+e.id,e]));
 const sequence=seed?await buildSequence(bank.entries,{seed,count:manifest.sequence.length}):{seed:manifest.seed,rows:manifest.sequence.map(e=>entries.get(e.source+':'+e.id))};
 if(sequence.rows.some(e=>!e))throw Error('Campaign references an unproven level');
 const sources=Object.fromEntries(await Promise.all([...new Set(sequence.rows.map(e=>e.source))].map(async source=>[source,await loadSource(manifest.sources[source].file)])));
 const levels=materializeSequence(sequence,sources);
 return {name:'Alea · Разные истории · '+sequence.seed,levels,sequence};
}
