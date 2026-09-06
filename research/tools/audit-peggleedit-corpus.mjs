#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PEGGLEEDIT_COORDINATE_REVISION,
  PEGGLEEDIT_PLAYFIELD,
  isPeggleEditLevel
} from '../benchmark/lib/coordinate-space.mjs';
import { readJson } from './lib/node-io.mjs';

function finite(value) {
  return Number.isFinite(Number(value));
}

function near(left, right, tolerance = 1e-6) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function auditObject(object, label, errors, counts) {
  counts.objects++;
  if (object.kind === 'brick') {
    counts.bricks++;
    const geometry = object.geometry || {};
    if (geometry.curved === true || geometry.shape === 'annular-sector') {
      counts.curvedBricks++;
      if (geometry.shape !== 'annular-sector') errors.push(`${label}: curved brick is not an annular-sector.`);
      const slices = geometry.curveSlices;
      if (!Array.isArray(slices) || slices.length < 2) {
        errors.push(`${label}: curved brick has no usable curveSlices.`);
      } else if (slices.some(slice => !['x', 'y', 'nx', 'ny'].every(key => finite(slice?.[key])))) {
        errors.push(`${label}: curved brick has a non-finite curve slice.`);
      }
      const centerRadius = Number(geometry.centerRadius);
      const sectorAngle = Number(geometry.sectorAngleDegrees);
      const expectedWidth = centerRadius * Math.abs(sectorAngle) * Math.PI / 180;
      if (!(centerRadius > 0) || !(Number(geometry.height) > 0) || !(Math.abs(sectorAngle) > 0)) {
        errors.push(`${label}: curved brick has invalid radius, thickness, or sector angle.`);
      }
      if (!near(geometry.width, expectedWidth, Math.max(1e-5, expectedWidth * 1e-6))) {
        errors.push(`${label}: curved brick width is not its centerline arc length.`);
      }
    } else {
      counts.straightBricks++;
      if (geometry.shape !== 'rotated-rectangle') errors.push(`${label}: straight brick has wrong shape ${geometry.shape}.`);
      if (!(Number(geometry.width) > 0) || !(Number(geometry.height) > 0)) {
        errors.push(`${label}: straight brick has invalid dimensions.`);
      }
    }
  }

  if (object.movement) {
    counts.movingObjects++;
    const snapshot = object.source?.presentationTransform;
    if (!snapshot || !finite(snapshot.x) || !finite(snapshot.y) || !finite(snapshot.canonicalRotationDegrees)) {
      errors.push(`${label}: moving object has no deterministic presentation transform.`);
    } else {
      if (!near(object.transform?.x, snapshot.x) || !near(object.transform?.y, snapshot.y)) {
        errors.push(`${label}: moving transform does not match its presentation snapshot.`);
      }
      const expectedRadians = Number(snapshot.canonicalRotationDegrees) * Math.PI / 180;
      if (!near(object.transform?.rotation, expectedRadians)) {
        errors.push(`${label}: moving rotation does not match its presentation snapshot.`);
      }
    }
  }
}

export async function auditPeggleEditCorpus(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const root = path.dirname(absoluteManifest);
  const manifest = await readJson(absoluteManifest);
  if (manifest.format !== 'peggle-research-corpus') throw new Error('Not a research corpus manifest.');
  const errors = [];
  const counts = {
    records: 0,
    objects: 0,
    bricks: 0,
    straightBricks: 0,
    curvedBricks: 0,
    movingObjects: 0
  };
  for (const entry of manifest.records || []) {
    const record = await readJson(path.resolve(root, entry.recordPath));
    counts.records++;
    if (isPeggleEditLevel(record)) {
      const coordinates = record.authored?.coordinateSystem;
      const bounds = coordinates?.bounds;
      const sourceFrame = coordinates?.sourceFrame;
      const launchAxis = record.authored?.mechanics?.launchAxis;
      if (coordinates?.revision !== PEGGLEEDIT_COORDINATE_REVISION
          || !near(bounds?.minX, 0)
          || !near(bounds?.minY, 0)
          || !near(bounds?.maxX, PEGGLEEDIT_PLAYFIELD.width)
          || !near(bounds?.maxY, PEGGLEEDIT_PLAYFIELD.height)
          || !near(coordinates?.viewport?.width, PEGGLEEDIT_PLAYFIELD.width)
          || !near(coordinates?.viewport?.height, PEGGLEEDIT_PLAYFIELD.height)) {
        errors.push(`${record.id}: incorrect PeggleEdit playfield coordinate contract.`);
      }
      if (!near(sourceFrame?.entryDrawOffset?.x, PEGGLEEDIT_PLAYFIELD.drawOffsetX)
          || !near(sourceFrame?.entryDrawOffset?.y, PEGGLEEDIT_PLAYFIELD.drawOffsetY)
          || !near(sourceFrame?.screen?.width, PEGGLEEDIT_PLAYFIELD.screenWidth)
          || !near(sourceFrame?.screen?.height, PEGGLEEDIT_PLAYFIELD.screenHeight)) {
        errors.push(`${record.id}: missing exact PeggleEdit screen-frame mapping.`);
      }
      if (!near(launchAxis?.x, PEGGLEEDIT_PLAYFIELD.launchAxisX)) {
        errors.push(`${record.id}: incorrect classic launch axis.`);
      }
    }
    for (const object of record.authored?.objects || []) {
      auditObject(object, `${record.id}/${object.id}`, errors, counts);
    }
  }
  if (errors.length) {
    const preview = errors.slice(0, 20).join('\n');
    throw new Error(`Corpus representation audit failed (${errors.length} errors):\n${preview}`);
  }
  return {
    corpusId: manifest.id,
    representationRevision: 'peggleedit-semantic-v3-playfield',
    ...counts,
    errors: 0
  };
}

async function main(argv) {
  if (!argv[0]) {
    console.error('Usage: node research/tools/audit-peggleedit-corpus.mjs <corpus.json>');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await auditPeggleEditCorpus(argv[0]);
    console.log(`ok ${result.corpusId}: ${result.records} records, ${result.straightBricks} straight bricks, ${result.curvedBricks} curved bricks, ${result.movingObjects} moving objects`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
