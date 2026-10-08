import { rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const outdir = path.resolve(process.cwd(), 'dist');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: {'player-bootstrap':'js/player-bootstrap.js','des-editor':'js/des-editor-bootstrap.js','editor':'js/main.js','intent-worker':'generators/destruction1/worker.js','des2-worker':'generators/destruction2/worker.js','des5-generator':'generators/destruction5/client.js','des5-worker':'generators/destruction5/worker.js'},
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  outdir,
  platform: 'browser',
  logLevel: 'info'
});
