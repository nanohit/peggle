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
    entryPoints: {
      'player-bootstrap': path.join(root, 'js/player-bootstrap.js'),
      'des-editor': path.join(root, 'js/des-editor-bootstrap.js')
    },
    bundle: true, format: 'esm', splitting: true, minify: true,
    outdir: path.join(genBase, 'dist'), platform: 'browser', logLevel: 'info'
  });
  for (const dir of ['css', 'fonts', 'cdn-data', 'data/gen', 'data/des']) {
    await cp(path.join(root, dir), path.join(genBase, dir), { recursive: true });
  }
  await mkdir(path.join(genBase, 'visuals/assets_webtp'), { recursive: true });
  await cp(path.join(root, 'visuals/assets_webtp/flipper.webp'), path.join(genBase, 'visuals/assets_webtp/flipper.webp'));
  await mkdir(path.join(root, 'vercel-shell', 'gen'), { recursive: true });
  await cp(path.join(root, 'player-gen-shell.html'), path.join(root, 'vercel-shell', 'gen', 'index.html'));
  const desStyle = `<style>
    .des-tools{display:flex;gap:8px;margin:8px 0}.des-tools>*{flex:1;text-align:center;border:1px solid #285e76;border-radius:8px;padding:11px 6px;background:#062033;color:#a5e9ff;text-decoration:none;font:600 12px system-ui}
    .des-hint{max-width:320px;margin:6px auto;color:#a0bdc9;font:12px/1.4 system-ui;text-align:center}.des-report-link{display:block;text-align:center;font:11px system-ui;color:#81b7ce;margin:6px}
    .des-generator-dialog{max-width:340px;width:calc(100% - 40px);padding:20px;border:1px solid #285e76;border-radius:14px;color:#d7f4ff;background:#061827;z-index:100000}.des-generator-dialog::backdrop{background:#000b}.des-generator-dialog h2{font:600 20px system-ui}.des-generator-dialog p{font:12px/1.5 system-ui;color:#a0bdc9}.des-generator-dialog select,.des-generator-dialog input,.des-generator-dialog button{box-sizing:border-box;width:100%;margin:6px 0;padding:12px;border:1px solid #285e76;border-radius:8px;color:#d7f4ff;background:#0b2b3d;font:14px system-ui}
    .pause-panel{max-height:90dvh;overflow:auto}.des-tools{width:100%}
  </style>`;
  const desShell=(await readFile(path.join(root,'player-gen-shell.html'),'utf8'))
    .replace('Alea · Generated levels','Alea · Destruction')
    .replace('window.__PEGGLE_GENERATED_PLAYER__ = true;','window.__PEGGLE_GENERATED_PLAYER__ = true; window.__PEGGLE_DESTRUCTION_PLAYER__ = true;')
    .replace('</head>',desStyle+'</head>');
  await mkdir(path.join(root,'vercel-shell/des/editor'),{recursive:true});
  await writeFile(path.join(root,'vercel-shell/des/index.html'),desShell);
  const editorShell=(await readFile(path.join(root,'editor.html'),'utf8'))
    .replace('<head>','<head><base href="/gen-static/"><script>window.__PEGGLE_LOCAL_EDITOR__=true;</script>')
    .replace('src="js/main.js"','src="dist/des-editor.js"');
  await writeFile(path.join(root,'vercel-shell/des/editor/index.html'),editorShell);
  await cp(path.join(root,'generators/destruction/report'),path.join(root,'vercel-shell/des/report'),{recursive:true});
  console.log('Destruction: /des; generator, unlocked catalogue, native seesaw editor');
  console.log('Generated player: /gen; three unlocked collections, 340 unchanged levels');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
