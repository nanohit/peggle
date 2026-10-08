import {generateSequence} from './director.js';
self.onmessage=({data})=>{try{self.postMessage({sequence:generateSequence(data.entries,data.options)});}catch(e){self.postMessage({error:e.message});}};
