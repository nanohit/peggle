import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stableStringify } from '../../../js/research-format.js';

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Value(value) {
  return sha256Bytes(stableStringify(value));
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${stableStringify(value, 2)}\n`, 'utf8');
}

export async function digestFile(filePath) {
  return sha256Bytes(await readFile(filePath));
}
