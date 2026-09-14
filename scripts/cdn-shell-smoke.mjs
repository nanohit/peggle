import { readFile, stat } from 'node:fs/promises';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [html, refConfig, vercelConfig, primaryText, initialText, charactersText, manifest] = await Promise.all([
  readFile('vercel-shell/index.html', 'utf8'),
  readFile('cdn-ref.json', 'utf8').then(JSON.parse),
  readFile('vercel.json', 'utf8').then(JSON.parse),
  readFile('cdn-data/primary.json', 'utf8'),
  readFile('cdn-data/primary.initial.json', 'utf8'),
  readFile('cdn-data/characters.json', 'utf8'),
  readFile('cdn-data/manifest.json', 'utf8').then(JSON.parse)
]);

const primary = JSON.parse(primaryText);
const initial = JSON.parse(initialText);
const characters = JSON.parse(charactersText);
const shellBytes = Buffer.byteLength(html);
const expectedBase = `https://cdn.jsdelivr.net/gh/${refConfig.repository}@${refConfig.ref}/`;

assert(shellBytes < 7 * 1024, `HTML shell is too large: ${shellBytes}`);
assert(html.includes(`<base href="${expectedBase}">`), 'HTML shell is not pinned to cdn-ref.json');
assert(html.includes('window.__PEGGLE_CDN_SNAPSHOT_FIRST__ = true'), 'CDN snapshot mode is not enabled');
assert(!/(?:src|href)="\/(?!api\/)/.test(html), 'HTML contains same-origin static references');
assert(vercelConfig.outputDirectory === 'vercel-shell', 'Vercel must publish only vercel-shell');
assert(vercelConfig.buildCommand === 'node scripts/build-cdn-shell.mjs', 'Vercel build must only generate the shell');
assert(Array.isArray(primary.levels) && primary.levels.length === manifest.levelCount, 'primary snapshot level count mismatch');
assert(Array.isArray(initial.levels) && initial.levels.length > 0, 'initial snapshot is empty');
assert(Object.keys(characters.characters || {}).length === manifest.characterCount, 'character snapshot count mismatch');
assert(!/data:(?:image|audio)\//i.test(primaryText + charactersText), 'CDN snapshots contain inline media');
await stat('dist/player-bootstrap.js');

console.log(`ok CDN shell ${shellBytes} bytes`);
console.log(`ok snapshot ${manifest.levelCount} levels, ${manifest.characterCount} characters`);
console.log(`ok static base ${expectedBase}`);
