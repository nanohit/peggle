import {generateCandidates} from './client.js';
self.onmessage=({data})=>{
 try{self.postMessage({requestId:data.requestId,levels:generateCandidates(data),validation:'initial-geometry-only'});}
 catch(error){self.postMessage({requestId:data.requestId,error:error.message});}
};
