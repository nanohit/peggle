import {generateLevel} from './grammar.js';
import {writeFile,mkdir} from 'node:fs/promises';
const iteration=process.env.DES5_ITERATION||'01',count=Number(process.env.DES5_PREVIEWS||24),levels=[];
for(let i=0;i<count;i++){const level=generateLevel({seed:'meta-'+String(i).padStart(3,'0')});levels.push(level);const p=level.metadata.generator.plan;console.log(level.id,level.pegs.length,'pegs;',p.nodes.map(n=>n.kind).join(' → '),'focus',p.focusShare.toFixed(2),'sources',JSON.stringify(p.contributions));}
await mkdir('data/des5/iterations',{recursive:true});await writeFile('data/des5/iterations/'+iteration+'.json',JSON.stringify({iteration,levels},null,2));
