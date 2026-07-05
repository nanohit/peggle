// Mirrors every asset referenced by production content into a public GitHub
// repo so jsDelivr / GitHub Pages can serve them as CDN fronts reachable from
// networks where Bunny edge IPs are blackholed (see memory: cdn-rf-fallback).
//
// Usage: node scripts/mirror-assets-to-github.mjs [--dry-run]
// The mirror checkout lives in mirror/alea-assets (gitignored); the script
// clones it on first run, downloads only missing files (names are content
// hashes, so existing files never change), commits and pushes.
//
// Re-run after publishing new levels/campaigns. Until a new asset is mirrored,
// clients that need the mirror fall back to /api/assets automatically.

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const API_BASE = process.env.ALEA_API_BASE || 'https://alea.sh';
const CDN_BASE = process.env.BUNNY_CDN_BASE_URL || 'https://alea-assets.b-cdn.net';
const MIRROR_REPO = process.env.MIRROR_REPO || 'nanohit/alea-assets';
const MIRROR_DIR = process.env.MIRROR_DIR || join(process.cwd(), 'mirror', 'alea-assets');
const DRY_RUN = process.argv.includes('--dry-run');

const KEY_RE = /level-assets\/[A-Za-z0-9_\-./]+\.(?:webp|png|jpe?g|gif|svg)/g;

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function collectKeys() {
  const sources = [
    `${API_BASE}/api/campaigns?primary=true&resolve=true`,
    `${API_BASE}/api/characters`,
    `${API_BASE}/api/levels?player=1`
  ];
  try {
    const list = JSON.parse(await fetchText(`${API_BASE}/api/campaigns`));
    for (const c of list.campaigns || []) {
      if (c?.name) sources.push(`${API_BASE}/api/campaigns?name=${encodeURIComponent(c.name)}&resolve=true`);
    }
  } catch (err) {
    console.warn(`campaign list unavailable: ${err.message}`);
  }
  const keys = new Set();
  for (const url of sources) {
    try {
      const text = await fetchText(url);
      for (const match of text.match(KEY_RE) || []) keys.add(match);
      console.log(`${url} -> ${keys.size} cumulative keys`);
    } catch (err) {
      console.warn(`skip ${url}: ${err.message}`);
    }
  }
  return [...keys].sort();
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });
}

async function main() {
  const keys = await collectKeys();
  if (!keys.length) throw new Error('no asset keys found — refusing to sync an empty mirror');
  console.log(`total referenced assets: ${keys.length}`);

  if (!existsSync(join(MIRROR_DIR, '.git'))) {
    mkdirSync(dirname(MIRROR_DIR), { recursive: true });
    run('gh', ['repo', 'clone', MIRROR_REPO, MIRROR_DIR]);
  }

  let downloaded = 0;
  let bytes = 0;
  for (const key of keys) {
    const dest = join(MIRROR_DIR, key);
    if (existsSync(dest)) continue; // content-hashed: existing file is final
    const url = `${CDN_BASE}/${key}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`miss ${key}: HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!DRY_RUN) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
    }
    downloaded++;
    bytes += buf.length;
  }
  console.log(`new files: ${downloaded} (${(bytes / 1024).toFixed(0)} KiB)`);
  if (DRY_RUN || !downloaded) {
    console.log(DRY_RUN ? 'dry run — nothing written' : 'mirror already up to date');
    return;
  }

  writeFileSync(join(MIRROR_DIR, '.nojekyll'), '');
  run('git', ['-C', MIRROR_DIR, 'add', '-A']);
  run('git', ['-C', MIRROR_DIR, 'commit', '-m', `Mirror ${downloaded} new asset(s)`]);
  run('git', ['-C', MIRROR_DIR, 'push', 'origin', 'HEAD']);
  console.log('pushed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
