import {generateIntentLevel} from './grammar.js';
import {evaluateIntentLevel, replayIntentLevel} from './evaluate.mjs';

self.onmessage = ({data}) => {
  try {
    for (let i=0;i<6;i++) {
      const seed=i ? data.seed+'-'+i : data.seed;
      self.postMessage({progress:`Проверяем цепочку ${i+1}/6: сохранность груза и полный маршрут…`});
      const level=generateIntentLevel(seed,data.mode);
      const proof=evaluateIntentLevel(level);
      if (!proof.accepted) continue;
      const replay=replayIntentLevel(level,proof);
      if(!replay.complete) continue;
      level.metadata.generator.validation={native:true,route:proof.route.map(s=>s.angle),stages:proof.progress.total};
      self.postMessage({level});return;
    }
    self.postMessage({error:'Этот seed не дал надёжной цепочки. Попробуй другой seed или другое намерение.'});
  } catch(error) {self.postMessage({error:'Ошибка проверки: '+error.message});}
};
self.postMessage({ready:true});
