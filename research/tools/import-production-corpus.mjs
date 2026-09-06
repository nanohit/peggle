#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeLevelToResearchRecord } from '../../js/research-format.js';
import { extractLevelFeatures, layoutFingerprint } from '../benchmark/lib/features.mjs';
import { sha256Value, writeJson } from './lib/node-io.mjs';

const TOOL_VERSION = '0.1.0';
const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function gameRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: GAME_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}

function safeName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'unnamed';
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        accept: 'application/json',
        'user-agent': `peggle-research-production-importer/${TOOL_VERSION}`
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new Error(`Too many redirects for ${url}`));
        return resolve(getJson(new URL(response.headers.location, url).toString(), redirects + 1));
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GET ${url} returned ${response.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`GET ${url} returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error(`GET ${url} timed out`)));
    request.on('error', reject);
  });
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function parseArgs(argv) {
  const options = {
    baseUrl: 'https://alea.sh',
    output: path.join(GAME_ROOT, 'research', 'generated', 'production'),
    concurrency: 6,
    deploymentRevision: 'unknown',
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--base-url') options.baseUrl = argv[++index];
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--concurrency') options.concurrency = Math.max(1, Number(argv[++index]) || 1);
    else if (value === '--deployment-revision') options.deploymentRevision = argv[++index];
    else if (value === '--at') options.at = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

export async function importProductionCorpus(options = {}) {
  const config = { ...parseArgs([]), ...options };
  const baseUrl = String(config.baseUrl).replace(/\/$/, '');
  const revision = gameRevision();
  const [levelIndexResponse, campaignIndexResponse, primaryCampaign] = await Promise.all([
    getJson(`${baseUrl}/api/levels`),
    getJson(`${baseUrl}/api/campaigns`),
    getJson(`${baseUrl}/api/campaigns?primary=true`)
  ]);
  const levelIndex = Array.isArray(levelIndexResponse)
    ? levelIndexResponse
    : (levelIndexResponse.levels || levelIndexResponse.names || []);
  const names = levelIndex.map(entry => typeof entry === 'string' ? entry : entry.name).filter(Boolean);
  const primaryNames = new Set(primaryCampaign.levelNames || []);
  const imported = await mapConcurrent(names, config.concurrency, async (requestedName, index) => {
    const uri = `${baseUrl}/api/levels?name=${encodeURIComponent(requestedName)}`;
    const response = await getJson(uri);
    const nativeLevel = response.level || response;
    const record = nativeLevelToResearchRecord(nativeLevel, {
      id: `level:alea-production:${slug(requestedName)}`,
      sourcePath: uri,
      sourceRevision: config.deploymentRevision,
      gameRevision: revision,
      tool: 'import-production-corpus.mjs',
      toolVersion: TOOL_VERSION,
      toolRevision: revision,
      at: config.at
    });
    record.provenance.source = {
      system: 'alea-production-api',
      uri,
      revision: config.deploymentRevision,
      sha256: sha256Value(nativeLevel),
      requestedName
    };
    record.authored.tags = [...new Set([
      ...(record.authored.tags || []),
      'production-authored',
      ...(primaryNames.has(requestedName) ? ['campaign:primary'] : [])
    ])];
    record.extensions = {
      ...(record.extensions || {}),
      production: {
        requestedName,
        index,
        primaryCampaign: primaryNames.has(requestedName)
      }
    };
    const fileName = `${String(index + 1).padStart(3, '0')}-${safeName(requestedName)}.json`;
    const recordPath = path.join(config.output, 'records', fileName);
    await writeJson(recordPath, record);
    const features = extractLevelFeatures(record);
    return {
      id: record.id,
      name: record.authored.name,
      requestedName,
      recordPath: path.relative(config.output, recordPath).replaceAll('\\', '/'),
      layoutSha256: layoutFingerprint(record),
      objectCount: record.authored.objects.length,
      targetCount: features.counts.targets,
      primaryCampaign: primaryNames.has(requestedName),
      sourceSha256: record.provenance.source.sha256
    };
  });
  const duplicateMap = new Map();
  for (const entry of imported) {
    const values = duplicateMap.get(entry.layoutSha256) || [];
    values.push(entry.requestedName);
    duplicateMap.set(entry.layoutSha256, values);
  }
  const manifest = {
    format: 'peggle-research-corpus',
    formatVersion: 1,
    id: 'corpus:alea-production',
    createdAt: config.at,
    provenance: {
      baseUrl,
      deploymentRevision: config.deploymentRevision,
      importer: { id: 'import-production-corpus.mjs', version: TOOL_VERSION, revision }
    },
    campaigns: {
      index: campaignIndexResponse.campaigns || campaignIndexResponse,
      primary: primaryCampaign
    },
    counts: {
      indexed: names.length,
      imported: imported.length,
      nonempty: imported.filter(entry => entry.objectCount > 0).length,
      primary: imported.filter(entry => entry.primaryCampaign).length,
      uniqueLayouts: duplicateMap.size
    },
    duplicateLayoutGroups: [...duplicateMap.entries()]
      .filter(([_digest, groupedNames]) => groupedNames.length > 1)
      .map(([layoutSha256, groupedNames]) => ({ layoutSha256, names: groupedNames })),
    records: imported
  };
  await writeJson(path.join(config.output, 'corpus.json'), manifest);
  return manifest;
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const manifest = await importProductionCorpus(options);
    console.log(`wrote ${path.join(options.output, 'corpus.json')} (${manifest.counts.imported} levels, ${manifest.counts.uniqueLayouts} unique layouts)`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
