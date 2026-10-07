import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(), out=path.join(root,'vercel-shell');
const config=JSON.parse(await readFile('cdn-ref.json','utf8'));
const ref=String(process.env.PEGGLE_CDN_REF || config.ref);
if(!/^[a-f0-9]{7,40}$/i.test(ref)||!/^nanohit\/peggle$/.test(config.repository)) throw Error('Use an immutable nanohit/peggle commit');
const base=`https://cdn.jsdelivr.net/gh/${config.repository}@${ref}/`;
await rm(out,{recursive:true,force:true});
async function save(file,html){
 const size=Buffer.byteLength(html);if(size>2500)throw Error(`${file}: ${size} bytes exceeds tiny launcher limit`);
 await mkdir(path.dirname(path.join(out,file)),{recursive:true});await writeFile(path.join(out,file),html);console.log(file,size,'bytes');
}
const template=await readFile('player-cdn-shell.html','utf8');
for(const [file,title,flags] of [
 ['index.html','Alea',''],
 ['gen/index.html','Alea · Generated','window.__PEGGLE_GENERATED_PLAYER__=true;'],
 ['des/index.html','Alea · Destruction','window.__PEGGLE_GENERATED_PLAYER__=true;window.__PEGGLE_DESTRUCTION_PLAYER__=true;'],
 ['des2/index.html','Alea · Free roam','window.__PEGGLE_GENERATED_PLAYER__=true;window.__PEGGLE_DESTRUCTION_PLAYER__=true;window.__PEGGLE_SPECTACLE_PLAYER__=true;'],
 ['des3/index.html','Alea · Связанные системы','window.__PEGGLE_GENERATED_PLAYER__=true;window.__PEGGLE_DESTRUCTION_PLAYER__=true;window.__PEGGLE_SYSTEMS_PLAYER__=true;'],
 ['des1/index.html','Alea · Destruction compositions','window.__PEGGLE_GENERATED_PLAYER__=true;window.__PEGGLE_DESTRUCTION_PLAYER__=true;window.__PEGGLE_INTENT_PLAYER__=true;']
]) await save(file,template.replaceAll('__PEGGLE_CDN_BASE__',base).replace('__PEGGLE_TITLE__',title).replace('__PEGGLE_FLAGS__',flags));
// The editor and reports live on the CDN too. document.write creates a parser
// document so existing module/DOMContentLoaded initialization runs normally.
async function documentLauncher(file,source,{editor=false,local=false}={}){
 const sourceBase=new URL('.',new URL(source,base)).href;
 const transform=editor ? `.replace('src="js/main.js"','src="dist/${local?'des-editor':'editor'}.js"').replace(/<link[^>]*fonts\\.(?:googleapis|gstatic)[^>]*>/g,'')` : '';
 const flags=editor ? `window.__PEGGLE_STATIC_BASE__=${JSON.stringify(base)};window.__PEGGLE_CDN_SNAPSHOT_FIRST__=true;window.__PEGGLE_LOCAL_EDITOR__=${local};` : '';
 await save(file,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Alea</title><body style="background:#020712;color:#a5e9ff;font:16px system-ui">Загрузка…<script>${flags}fetch(${JSON.stringify(new URL(source,base).href)}).then(r=>{if(!r.ok)throw Error(r.status);return r.text()}).then(t=>{t=t${transform};t=t.replace(/href="\\/(?!\\/)/g,'href="'+location.origin+'/');t=t.replace(/<head>/,'<head><base href="${editor?base:sourceBase}">');if(!/<head>/.test(t))t=t.replace(/<html[^>]*>/,'$&<head><base href="${sourceBase}"></head>');document.open();document.write(t);document.close()}).catch(e=>{document.body.textContent='Не удалось загрузить. Обновите страницу.';console.error(e)})</script>`);
}
await documentLauncher('des/editor/index.html','editor.html',{editor:true,local:true});
await documentLauncher('editor.html','editor.html',{editor:true});
await documentLauncher('des/report/index.html','generators/destruction/report/index.html');
await documentLauncher('des1/report/index.html','generators/destruction1/report/index.html');
await documentLauncher('des2/report/index.html','generators/destruction2/report/index.html');
await documentLauncher('des3/report/index.html','generators/destruction3/report/index.html');
console.log('CDN:',base,'— Vercel contains only HTML launchers');
