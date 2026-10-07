import {generateLevel} from './grammar.js';
import {validateGeometry} from './geometry.js';
import {NativeSimulation} from '../destruction/native-simulator.mjs';
export function buildVariant(options,progress=()=>{}){
 for(let i=0;i<8;i++){
  progress(`Собираем уровень ${i+1}/8…`);
  const level=generateLevel({...options,seed:i?options.seed+'-'+i:options.seed});
  const geometry=validateGeometry(level);if(!geometry.valid)continue;
  const sim=new NativeSimulation(level).settle(3);
  if(sim.game.getOrangePegsLeft()!==geometry.targets)continue;
  if(level.metadata.generator.hero==='motion'){
   let valid=true;for(const t of [1.3,2.1,2.8]){sim.settle(t);if(!validateGeometry({...level,pegs:sim.game.pegs}).valid){valid=false;break;}}
   if(!valid)continue;
  }
  level.metadata.generator.validation={nativeIdle:true,geometry:true};return level;
 }
 throw Error('Не удалось подобрать свободную композицию. Попробуй другой seed.');
}
self.onmessage=({data})=>{try{self.postMessage({level:buildVariant(data,progress=>self.postMessage({progress}))});}catch(e){self.postMessage({error:e.message});}};
self.postMessage({ready:true});
