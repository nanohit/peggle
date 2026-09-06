#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PEGGLEEDIT_PLAYFIELD } from '../benchmark/lib/coordinate-space.mjs';
import { readJson, sha256Value } from './lib/node-io.mjs';
import { validateResearchRecord } from './validate-record.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyCoordinateTransferAudit(root = path.join(GAME_ROOT, 'research', 'generated', 'coordinate-transfer-audit-v1')) {
  const benchmark = await readJson(path.join(root, 'benchmark.json'));
  const transfer = await readJson(path.join(root, 'transfer-map.json'));
  requireCondition(benchmark.reviewPairs.length === transfer.mapping.length, 'Transfer pair/map count mismatch.');
  requireCondition(benchmark.reviewPairs.length >= 20, 'Transfer audit is too small.');
  const mappingById = new Map(transfer.mapping.map(item => [item.pairId, item]));
  for (const pair of benchmark.reviewPairs) {
    const mapping = mappingById.get(pair.id);
    requireCondition(mapping && mapping.geometryChanged === false, `${pair.id}: missing unchanged-geometry evidence.`);
    for (const side of ['left', 'right']) {
      const record = await readJson(path.resolve(root, pair[side].recordPath));
      const validation = validateResearchRecord(record);
      requireCondition(validation.valid, `${pair.id}/${side}: invalid corrected record.`);
      const bounds = record.authored.coordinateSystem.bounds;
      requireCondition(bounds.minX === 0 && bounds.minY === 0
        && bounds.maxX === PEGGLEEDIT_PLAYFIELD.width && bounds.maxY === PEGGLEEDIT_PLAYFIELD.height,
      `${pair.id}/${side}: incorrect PeggleEdit bounds.`);
      requireCondition(record.authored.mechanics.launchAxis?.x === PEGGLEEDIT_PLAYFIELD.launchAxisX,
        `${pair.id}/${side}: incorrect launch axis.`);
      requireCondition(sha256Value(record.authored.objects) === mapping.geometrySha256[side],
        `${pair.id}/${side}: geometry changed during coordinate correction.`);
      const preview = await readFile(path.resolve(root, pair[side].previewPath), 'utf8');
      requireCondition(preview.includes(`M ${PEGGLEEDIT_PLAYFIELD.launchAxisX} `), `${pair.id}/${side}: preview marker is not on x=327.`);
    }
  }
  await access(path.join(root, 'review.html'));
  return { status: 'passed', pairCount: benchmark.reviewPairs.length, eligiblePriorDecisionCount: transfer.eligiblePriorDecisionCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const result = await verifyCoordinateTransferAudit(root);
  console.log(`coordinate transfer audit verified: ${result.pairCount} pairs from ${result.eligiblePriorDecisionCount} eligible prior decisions`);
}
