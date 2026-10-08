import {mkdir,writeFile} from 'node:fs/promises';
import {generateLevel,DOMAINS} from './grammar.js';
import {validateGeometry,compositionMetrics} from './geometry.js';
const iteration=process.env.DES4_ITERATION||'01',perDomain=Number(process.env.DES4_PREVIEWS||3),levels=[];
for(const domain of DOMAINS)for(let i=0;i<perDomain;i++){const l=generateLevel({domain,seed:'field-'+String(i).padStart(3,'0')});levels.push(l);}
await mkdir('data/des4/iterations',{recursive:true});
await writeFile('data/des4/iterations/'+iteration+'.json',JSON.stringify({iteration,levels,analysis:levels.map(l=>({id:l.id,geometry:validateGeometry(l),metrics:compositionMetrics(l)}))}));
console.log(JSON.stringify(levels.map(l=>{const g=validateGeometry(l);return {id:l.id,pegs:g.pegs,errors:g.errors.length,examples:g.errors.slice(0,3)};}),null,2));
