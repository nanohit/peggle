#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { researchLevelDigestPayload } from '../../js/research-format.js';
import { readJson, sha256Value } from './lib/node-io.mjs';
import { validateResearchRecord } from './validate-record.mjs';

async function main(argv) {
  const [inputPath] = argv;
  if (!inputPath) {
    console.error('Usage: node research/tools/digest-level.mjs <research-level.json>');
    process.exitCode = 2;
    return;
  }
  const record = await readJson(inputPath);
  const validation = validateResearchRecord(record);
  if (!validation.valid || record.recordType !== 'level') {
    throw new Error(`Invalid level record: ${validation.errors.join('; ') || 'recordType is not level'}`);
  }
  console.log(sha256Value(researchLevelDigestPayload(record)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
