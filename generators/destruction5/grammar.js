import {growSystem,finalize} from './planner.js';
export {designGenome} from './planner.js';
export {CATALOG} from './components.js';
export function generateLevel(options={}){
 let last;for(let attempt=0;attempt<24;attempt++){try{return finalize(growSystem({...options,attempt}));}catch(e){last=e;}}
 throw last;
}
