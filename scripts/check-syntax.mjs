import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = [
  ...readdirSync('api').filter(name => name.endsWith('.js')).map(name => `api/${name}`),
  ...readdirSync('scripts').filter(name => name.endsWith('.mjs')).map(name => `scripts/${name}`),
  ...readdirSync('research/tools').filter(name => name.endsWith('.mjs')).map(name => `research/tools/${name}`),
  ...readdirSync('research/generator/lib').filter(name => name.endsWith('.mjs')).map(name => `research/generator/lib/${name}`),
  ...readdirSync('research/repair/lib').filter(name => name.endsWith('.mjs')).map(name => `research/repair/lib/${name}`),
  ...readdirSync('research/test').filter(name => name.endsWith('.mjs')).map(name => `research/test/${name}`),
  ...readdirSync('js').filter(name => name.endsWith('.js')).map(name => `js/${name}`),
  'research/tools/lib/node-io.mjs',
  'research/test/research-smoke.mjs',
  'research/test/benchmark-smoke.mjs',
  'research/test/generator-smoke.mjs',
  'js/main.js',
  'js/editor.js',
  'js/physics.js',
  'js/destruction-mode.js',
  'js/player-bootstrap.js',
  'js/image-compression.js',
  'js/visual-layout.js',
  'js/character-config.js',
  'js/research-format.js',
  'js/research-recorder.js',
  'js/research-session.js'
];

let failed = false;
for (const file of new Set(files)) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: readFileSync(file),
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`FAIL ${file}`);
    console.error(result.stderr || result.stdout);
  }
}
if (failed) process.exitCode = 1;
else console.log(`ok syntax (${new Set(files).size} files)`);
