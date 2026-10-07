import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const templatePath = path.join(root, 'player-cdn-shell.html');
const refPath = path.join(root, 'cdn-ref.json');
const outputPath = path.join(root, 'vercel-shell', 'index.html');
const maxShellBytes = 7 * 1024;

async function main() {
  const template = await readFile(templatePath, 'utf8');
  const config = JSON.parse(await readFile(refPath, 'utf8'));
  const repository = String(config.repository || 'nanohit/peggle').trim();
  const ref = String(process.env.PEGGLE_CDN_REF || config.ref || '').trim();
  if (!/^[a-f0-9]{7,40}$/i.test(ref)) throw new Error('cdn-ref.json must contain a Git commit SHA');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid CDN repository');

  const cdnBase = `https://cdn.jsdelivr.net/gh/${repository}@${ref}/`;
  const html = template.replaceAll('__PEGGLE_CDN_BASE__', cdnBase);
  if (html.includes('__PEGGLE_CDN_BASE__')) throw new Error('unresolved CDN base placeholder');
  const bytes = Buffer.byteLength(html);
  if (bytes > maxShellBytes) throw new Error(`HTML shell is ${bytes} bytes; limit is ${maxShellBytes}`);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
  console.log(`Vercel shell: ${bytes} bytes -> ${outputPath}`);
  console.log(`Static base: ${cdnBase}`);
  const genBase = path.join(root, 'vercel-shell', 'gen-static');
  await rm(genBase, { recursive: true, force: true });
  await mkdir(genBase, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'js/player-bootstrap.js')],
    bundle: true, format: 'esm', splitting: true, minify: true,
    outdir: path.join(genBase, 'dist'), platform: 'browser', logLevel: 'info'
  });
  for (const dir of ['css', 'fonts', 'cdn-data', 'data/gen']) {
    await cp(path.join(root, dir), path.join(genBase, dir), { recursive: true });
  }
  await mkdir(path.join(genBase, 'visuals/assets_webtp'), { recursive: true });
  await cp(path.join(root, 'visuals/assets_webtp/flipper.webp'), path.join(genBase, 'visuals/assets_webtp/flipper.webp'));
  await mkdir(path.join(root, 'vercel-shell', 'gen'), { recursive: true });
  await cp(path.join(root, 'player-gen-shell.html'), path.join(root, 'vercel-shell', 'gen', 'index.html'));
  console.log('Generated player: /gen; three unlocked collections, 340 unchanged levels');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
