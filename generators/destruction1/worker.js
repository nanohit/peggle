import {generateIntentLevel} from './grammar.js';
import {evaluateIntentLevel} from './evaluate.mjs';
self.onmessage=({data})=>{
  try {
    for(let i=0;i<6;i++) {
      const seed=i?data.seed+'-'+i:data.seed;
      self.postMessage({progress:`Собираем композицию ${i+1}/6: проверяем геометрию и устойчивость…`});
      const level=generateIntentLevel(seed,data.mode),proof=evaluateIntentLevel(level,{probeShots:false});
      if(!proof.accepted)continue;
      level.metadata.generator.validation={nativeIdle:true,lateDrift:proof.idle.lateDrift};
      self.postMessage({level});return;
    }
    self.postMessage({error:'Не удалось подобрать устойчивую композицию. Попробуй другой seed.'});
  }catch(error){self.postMessage({error:'Ошибка сборки: '+error.message});}
};
self.postMessage({ready:true});
