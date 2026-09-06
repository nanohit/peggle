#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { readJson, sha256Value } from './lib/node-io.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const schemaPath = fileURLToPath(new URL('../schema/research-record.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true
});
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateResearchRecord(record, options = {}) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);
  if (!isObject(record)) return { valid: false, errors: ['record must be an object'], warnings };
  if (!validateSchema(record)) {
    for (const error of validateSchema.errors || []) {
      fail(`schema${error.instancePath || '/'} ${error.message}`);
    }
  }
  if (record.format !== 'peggle-research') fail('format must be peggle-research');
  if (record.formatVersion !== 1) fail('formatVersion must be 1');
  if (!['level', 'run'].includes(record.recordType)) fail('recordType must be level or run');
  if (typeof record.id !== 'string' || !record.id) fail('id must be a non-empty string');
  if (!isObject(record.provenance?.source) || !record.provenance.source.system) fail('provenance.source.system is required');
  if (!isObject(record.provenance?.ingestion)) fail('provenance.ingestion is required');
  if (!record.provenance?.ingestion?.tool) fail('provenance.ingestion.tool is required');
  if (!record.provenance?.ingestion?.toolVersion) fail('provenance.ingestion.toolVersion is required');
  if (!record.provenance?.ingestion?.at || Number.isNaN(Date.parse(record.provenance.ingestion.at))) {
    fail('provenance.ingestion.at must be an ISO date-time');
  }

  if (record.recordType === 'level') {
    const authored = record.authored;
    if (!isObject(authored)) fail('level.authored is required');
    if (!isObject(authored?.coordinateSystem)) fail('authored.coordinateSystem is required');
    const bounds = authored?.coordinateSystem?.bounds;
    if (!isObject(bounds) || !['minX', 'minY', 'maxX', 'maxY'].every(key => finite(bounds[key]))) {
      fail('coordinateSystem.bounds must contain finite minX/minY/maxX/maxY');
    } else if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) {
      fail('coordinateSystem.bounds must have positive extent');
    }
    if (!Array.isArray(authored?.objects)) fail('authored.objects must be an array');
    if (!Array.isArray(authored?.groups)) fail('authored.groups must be an array');
    if (!isObject(authored?.mechanics)) fail('authored.mechanics must be an object');
    const ids = new Set();
    for (const [index, object] of (authored?.objects || []).entries()) {
      const label = `authored.objects[${index}]`;
      if (!isObject(object)) { fail(`${label} must be an object`); continue; }
      if (typeof object.id !== 'string' || !object.id) fail(`${label}.id is required`);
      else if (ids.has(object.id)) fail(`duplicate object id: ${object.id}`);
      else ids.add(object.id);
      if (!isObject(object.transform) || !finite(object.transform.x) || !finite(object.transform.y) || !finite(object.transform.rotation)) {
        fail(`${label}.transform must contain finite x/y/rotation`);
      }
      if (typeof object.kind !== 'string' || !object.kind) fail(`${label}.kind is required`);
      if (typeof object.role !== 'string' || !object.role) fail(`${label}.role is required`);
    }
    const groupIds = new Set();
    for (const [index, group] of (authored?.groups || []).entries()) {
      const label = `authored.groups[${index}]`;
      if (!group?.id) fail(`${label}.id is required`);
      else if (groupIds.has(group.id)) fail(`duplicate group id: ${group.id}`);
      else groupIds.add(group.id);
      if (!Array.isArray(group?.objectIds)) fail(`${label}.objectIds must be an array`);
      for (const id of group?.objectIds || []) if (!ids.has(id)) fail(`${label} references missing object ${id}`);
    }
    for (const object of authored?.objects || []) {
      for (const groupId of object.groupIds || []) if (!groupIds.has(groupId)) fail(`object ${object.id} references missing group ${groupId}`);
      const destinationId = object.portal?.destinationId;
      if (destinationId != null && !ids.has(destinationId)) fail(`portal ${object.id} references missing destination ${destinationId}`);
    }
  }

  if (record.recordType === 'run') {
    if (!record.levelRef?.id || !SHA256.test(record.levelRef?.sha256 || '')) fail('run.levelRef requires id and lowercase sha256');
    const reproduction = record.reproduction;
    if (!isObject(reproduction)) fail('run.reproduction is required');
    if (!['observational', 'subset-deterministic', 'exact'].includes(reproduction?.capability)) fail('invalid reproduction.capability');
    if (!reproduction?.game?.id || !reproduction?.game?.revision) fail('reproduction.game id/revision are required');
    if (!reproduction?.tool?.id || !reproduction?.tool?.version) fail('reproduction.tool id/version are required');
    const fixedStepSeconds = reproduction?.fixedStepSeconds;
    if (fixedStepSeconds !== null && (!finite(fixedStepSeconds) || fixedStepSeconds <= 0)) {
      fail('reproduction.fixedStepSeconds must be positive or null');
    }
    if (reproduction?.capability !== 'observational' && (!finite(fixedStepSeconds) || fixedStepSeconds <= 0)) {
      fail('deterministic replay requires a positive reproduction.fixedStepSeconds');
    }
    if (!isObject(reproduction?.physicsConfig)) fail('reproduction.physicsConfig is required');
    if (!isObject(reproduction?.seed) || reproduction.seed.master == null || !reproduction.seed.algorithm || !isObject(reproduction.seed.streams)) {
      fail('reproduction.seed requires algorithm/master/streams');
    }
    if (!Array.isArray(reproduction?.inputs)) fail('reproduction.inputs must be an array');
    if (!Array.isArray(record.events)) fail('run.events must be an array');
    if (!Array.isArray(record.checkpoints)) fail('run.checkpoints must be an array');
    let priorSequence = -1;
    for (const [index, event] of (record.events || []).entries()) {
      if (!Number.isInteger(event?.sequence) || event.sequence <= priorSequence) fail(`events[${index}].sequence must increase`);
      priorSequence = event?.sequence ?? priorSequence;
      if (!Number.isInteger(event?.step) || event.step < 0) fail(`events[${index}].step must be a non-negative integer`);
      if (!finite(event?.timeSeconds) || event.timeSeconds < 0) fail(`events[${index}].timeSeconds must be non-negative`);
      if (!event?.type || !isObject(event?.data)) fail(`events[${index}] requires type and data`);
    }
    for (const [index, checkpoint] of (record.checkpoints || []).entries()) {
      if (!Number.isInteger(checkpoint?.step) || checkpoint.step < 0) fail(`checkpoints[${index}].step must be non-negative`);
      if (!SHA256.test(checkpoint?.sha256 || '')) fail(`checkpoints[${index}].sha256 is invalid`);
      if (!isObject(checkpoint?.state)) fail(`checkpoints[${index}].state must be an object`);
      if (options.verifyDigests && isObject(checkpoint?.state) && SHA256.test(checkpoint?.sha256 || '')) {
        const actual = sha256Value(checkpoint.state);
        if (actual !== checkpoint.sha256) fail(`checkpoints[${index}] digest mismatch: expected ${checkpoint.sha256}, got ${actual}`);
      }
    }
    if (reproduction?.capability === 'exact' && (reproduction.seed.unseededStreams || []).length > 0) {
      fail('exact replay cannot declare unseeded streams');
    }
    if (reproduction?.capability === 'observational') {
      warnings.push('record is observational and does not claim exact replay');
      if (fixedStepSeconds === null) warnings.push('source fixed step is unknown');
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

async function main(files) {
  if (files.length === 0) {
    console.error('Usage: node research/tools/validate-record.mjs <record.json> [...]');
    process.exitCode = 2;
    return;
  }
  let failed = false;
  for (const file of files) {
    try {
      const record = await readJson(file);
      const result = validateResearchRecord(record, { verifyDigests: true });
      if (!result.valid) {
        failed = true;
        console.error(`FAIL ${file}`);
        for (const error of result.errors) console.error(`  - ${error}`);
      } else {
        console.log(`ok ${file}`);
        for (const warning of result.warnings) console.log(`  warning: ${warning}`);
      }
    } catch (error) {
      failed = true;
      console.error(`FAIL ${file}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
