import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generateSupportedRadialLevel, SUPPORT_STUDY_SEEDS } from '../repair/lib/external-support-generator.mjs';
import { generateRadialLevel, hashUnit } from '../repair/lib/radial-generator.mjs';
import { makeStandardPlayPreview } from '../../js/repair-play-preview.js';
import { captureBezierSemanticState, semanticReplayReport } from '../../js/bezier-semantic.js';
import { analyzeRepairCandidate } from '../../js/repair-session.js';
import { writeRadialComparison } from './compare-radial-revision.mjs';
import { sha256, sourceHash, RADIAL_BASELINE_CODE_FILES, REPO_ROOT } from './build-radial-loop.mjs';

export function prepareSupportStudy(radialRules, supportRules, archive = null) {
  const observations = [];
  if (archive) for (const candidate of archive.candidates || []) {
    if (candidate.role === 'study') {
      const regenerated = generateRadialLevel(candidate.id, radialRules);
      if (!semanticReplayReport(captureBezierSemanticState(regenerated.level), captureBezierSemanticState(candidate.baselineLevel)).exact) throw new Error(`Archived core no longer reproduces: ${candidate.id}`);
    }
    const analysis = analyzeRepairCandidate({ ...candidate, currentLevel: candidate.finalLevel, transactionLog: candidate.operationSequence });
    observations.push({ id: candidate.id, role: candidate.role, disposition: candidate.disposition, note: candidate.note,
      refusal: candidate.dispositionReason, gates: Object.fromEntries(Object.entries(analysis.gates).map(([k, v]) => [k, v.status])) });
  }
  const comparisonId = `${supportRules.revision}-${sha256({ radialRules, supportRules, seeds: SUPPORT_STUDY_SEEDS }).slice(0, 8)}`;
  const pairs = [];
  for (const seed of SUPPORT_STUDY_SEEDS) {
    const variants = Object.fromEntries(['base', 'blue-supports', 'side-bumpers'].map(v => [v, generateSupportedRadialLevel(seed, radialRules, supportRules, v)]));
    const targets = makeStandardPlayPreview(variants.base.level, seed).metadata.playPreview.targetMemberIds;
    for (const [kind, left, right] of [['support-placement', 'base', 'blue-supports'], ['bumper-package', 'blue-supports', 'side-bumpers']]) {
      const reversed = hashUnit(`${comparisonId}:${seed}:${kind}`) < 0.5;
      pairs.push({ id: `pair-${pairs.length + 1}`, seed, kind, targetMemberIds: targets,
        labels: reversed ? ['revised', 'original'] : ['original', 'revised'],
        sides: reversed ? [variants[right], variants[left]] : [variants[left], variants[right]] });
    }
  }
  return { format: 'external-support-comparison', version: 1, comparisonId, originalRules: radialRules, supportRules,
    repairArchiveHash: archive ? sha256(archive) : null, observations, pairs,
    inference: 'Exploratory manually specified rule motivated by two repairs in one radial family. Failed/refused calibration remains failed: no calibrated language score claimed. Three independent seeds, not six independent samples. Bumper package changes size, bounce and persistence together, NOT bounce alone. Invalid seeds remain visible; no automatic rule learning.' };
}

export async function buildSupportStudy(archivePath = null, output = path.join(REPO_ROOT, 'research/generated/support-study-v1')) {
  const raw = archivePath ? await fs.readFile(archivePath, 'utf8') : null;
  const archive = raw ? JSON.parse(raw) : null;
  const radialRules = archive?.source?.rules || JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'research/repair/radial-rules-v1.json'), 'utf8'));
  if (archive && archive.source?.generatorRulesHash !== sha256(radialRules)) throw new Error('Archived rule hash mismatch');
  const supportRules = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'research/repair/external-support-rules-v1.json'), 'utf8'));
  const comparison = prepareSupportStudy(radialRules, supportRules, archive);
  const codeFiles = [...RADIAL_BASELINE_CODE_FILES, 'research/repair/lib/external-support-generator.mjs', 'js/peg-contact.js', 'research/tools/build-support-study.mjs', 'research/tools/compare-radial-revision.mjs'];
  comparison.source = { gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    codeHashFormat: 'sha256-lf-v1', codeHashes: Object.fromEntries(await Promise.all(codeFiles.map(async f => [f, sourceHash(await fs.readFile(path.join(REPO_ROOT, f), 'utf8'))]))),
    rawArchiveSha256: raw ? sha256(raw) : null, previewPolicy: 'ordinary-only-frozen-roster-v2',
    note: 'Current code hashes pin this study even in a dirty worktree; baseline geometry is independently matched to the archive. Preview bugs fixed symmetrically on both sides, old plays are not equivalent trials.' };
  return writeRadialComparison(comparison, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildSupportStudy(process.argv[2] || null, process.argv[3] ? path.resolve(process.argv[3]) : undefined)
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
