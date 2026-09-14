import { rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const outdir = path.resolve(process.cwd(), 'dist');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: ['js/player-bootstrap.js'],
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  outdir,
  platform: 'browser',
  logLevel: 'info'
});
