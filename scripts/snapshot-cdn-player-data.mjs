import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const apiBase = (process.env.ALEA_API_BASE || 'https://alea.sh').replace(/\/$/, '');
const outputDir = path.resolve(process.cwd(), 'cdn-data');

async function fetchJson(route) {
  const response = await fetch(`${apiBase}${route}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
  return await response.json();
}

function compact(value) {
  return `${JSON.stringify(value)}\n`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const [initial, primary, characters] = await Promise.all([
    fetchJson('/api/campaigns?primary=true&initial=true&player=1'),
    fetchJson('/api/campaigns?primary=true&resolve=true&player=1'),
    fetchJson('/api/characters?player=1')
  ]);

  if (!Array.isArray(initial?.levels) || initial.levels.length < 1) {
    throw new Error('primary initial snapshot has no levels');
  }
  if (!Array.isArray(primary?.levels) || primary.levels.length < 1) {
    throw new Error('primary campaign snapshot has no levels');
  }
  if (!characters?.characters || typeof characters.characters !== 'object') {
    throw new Error('character snapshot is invalid');
  }

  const payloads = {
    'primary.initial.json': compact(initial),
    'primary.json': compact(primary),
    'characters.json': compact(characters),
    'config.json': compact({ primaryCampaign: primary.name })
  };
  for (const [name, text] of Object.entries(payloads)) {
    if (/data:(?:image|audio)\//i.test(text)) {
      throw new Error(`${name} still contains inline media`);
    }
  }

  await mkdir(outputDir, { recursive: true });
  for (const [name, text] of Object.entries(payloads)) {
    await writeFile(path.join(outputDir, name), text);
  }

  const manifest = {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: apiBase,
    campaign: primary.name,
    levelCount: primary.levels.length,
    characterCount: Object.keys(characters.characters).length,
    files: Object.fromEntries(Object.entries(payloads).map(([name, text]) => [name, {
      bytes: Buffer.byteLength(text),
      sha256: sha256(text)
    }]))
  };
  await writeFile(path.join(outputDir, 'manifest.json'), compact(manifest));

  console.log(`snapshot ${manifest.campaign}: ${manifest.levelCount} levels, ${manifest.characterCount} characters`);
  for (const [name, meta] of Object.entries(manifest.files)) {
    console.log(`${name}: ${meta.bytes} bytes`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
