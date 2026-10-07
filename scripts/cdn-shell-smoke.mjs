import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {curateGeneratedPlaylist} from '../js/generated-playlist.js';
const ref=JSON.parse(await readFile('cdn-ref.json','utf8')),base=`https://cdn.jsdelivr.net/gh/${ref.repository}@${ref.ref}/`;
assert.equal(ref.repository,'nanohit/peggle');assert(/^[a-f0-9]{7,40}$/i.test(ref.ref));
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(dir+'/'+e.name):dir+'/'+e.name))).flat();}
for(const file of await files('vercel-shell')){
 assert(file.endsWith('.html'),'Only launchers belong on Vercel: '+file);
 const html=await readFile(file,'utf8');assert(Buffer.byteLength(html)<=2500,file+' exceeds launcher budget');
 assert(html.includes(base),'Unpinned launcher: '+file);assert(!html.includes('/gen-static/'),'Local static bundle remains');
 assert(!/(?:src|href)="\/(?!api\/)/.test(html),'Absolute static URL under CDN base');
 console.log('ok',file,Buffer.byteLength(html));
}
const html=await readFile('vercel-shell/des1/index.html','utf8');assert(html.includes('__PEGGLE_INTENT_PLAYER__=true'));
const config=JSON.parse(await readFile('vercel.json','utf8'));assert.equal(config.outputDirectory,'vercel-shell');
for(const route of ['/gen','/des','/des1','/des/editor','/des1/report'])assert(config.rewrites.some(r=>r.source===route));
for(const file of ['player-bootstrap','des-editor','editor','intent-worker'])await stat('dist/'+file+'.js');
const catalog=JSON.parse(await readFile('data/gen/catalog.json','utf8'));
for(const collection of catalog.collections){const text=await readFile(collection.file,'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),collection.sha256,'Source export changed');const levels=JSON.parse(text).levels;assert.equal(curateGeneratedPlaylist(levels).length,collection.playlistCount||collection.count);assert.equal(curateGeneratedPlaylist(levels,{variants:true}).length,collection.count);}
const des=JSON.parse(await readFile('data/des/campaign.json','utf8'));assert.equal(curateGeneratedPlaylist(des.levels).length,8);assert.equal(curateGeneratedPlaylist(des.levels,{variants:true}).length,16);
console.log('ok source exports preserved; 8 distinct compositions per legacy generated playlist');
