import {execFileSync} from 'node:child_process';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// A CDN snapshot, never a checkout cleanup. Full research remains in the parent
// Git commit. jsDelivr rejects uncompressed package trees larger than 50 MB.
const sourceRef=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('Commit source changes first');
const index='/tmp/alea-cdn-runtime.index',env={...process.env,GIT_INDEX_FILE:index};
const git=(args,input)=>execFileSync('git',args,{env,input,encoding:'utf8',maxBuffer:8e6}).trim();
const entries=git(['ls-tree','-rl',sourceRef]).split('\n').map(s=>{const [head,path]=s.split('\t');const [mode,type,sha,size]=head.trim().split(/\s+/);return {mode,type,sha,path,size:Number(size)};});
const archive=p=>p.startsWith('data/quality/')||(/^data\/des\d*\//.test(p)&&!/^data\/des\d*\/(?:campaign|summary|autonomy|source-inventory|bank|formations)\.json$/.test(p))||(p.startsWith('generators/')&&!p.includes('/report/')&&!p.endsWith('/README.md'))||/^(api|server|scripts|test|docs|\.claude)\//.test(p)||(p.startsWith('js/')&&p!=='js/cdn-preload.js')||p==='visuals/demo_layout_safari_16pro.png'||p==='curve_example.jpg';
await rm(index,{force:true});git(['read-tree',sourceRef]);
const removed=entries.filter(r=>archive(r.path)).map(r=>r.path);
git(['update-index','--force-remove','--stdin'],removed.join('\n')+'\n');
const packed=new Map();let bytes=0;
for(const r of entries.filter(r=>!archive(r.path))){
 let size=r.size;
 if(/^(data|cdn-data)\//.test(r.path)&&r.path.endsWith('.json')){
  const original=JSON.parse(await readFile(r.path,'utf8')),content=JSON.stringify(original);
  assert.deepEqual(JSON.parse(content),original);packed.set(r.path,content);size=Buffer.byteLength(content);
 }
 bytes+=size;
}
const catalog=JSON.parse(packed.get('data/gen/catalog.json'));
for(const c of catalog.collections)c.sha256=createHash('sha256').update(packed.get(c.file)).digest('hex');
packed.set('data/gen/catalog.json',JSON.stringify(catalog));
for(const [path,content] of packed){const sha=git(['hash-object','-w','--stdin'],content);git(['update-index','--cacheinfo','100644,'+sha+','+path]);}
if(bytes>=49e6)throw Error('CDN snapshot needs more packaging headroom: '+bytes);
const branch=process.env.ALEA_CDN_BRANCH||'codex/des5-cdn';if(!/^codex\/[a-z0-9-]+$/.test(branch))throw Error('Invalid CDN branch');
let previous;try{previous=git(['rev-parse','refs/heads/'+branch]);}catch{}
const tree=git(['write-tree']),parents=previous&&previous!==sourceRef?['-p',sourceRef,'-p',previous]:['-p',sourceRef],ref=git(['commit-tree',tree,...parents,'-m','Build compact CDN snapshot; preserve canonical levels and full research in parent']);
git(['update-ref','refs/heads/'+branch,ref]);await rm(index,{force:true});
await writeFile('/tmp/alea-cdn-release.json',JSON.stringify({ref,sourceRef,tree,bytes,files:entries.length-removed.length,archivedFiles:removed.length}));
console.log({ref,sourceRef,bytes,files:entries.length-removed.length});
