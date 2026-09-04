#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applyBezierSemanticPatch,
  captureBezierSemanticState,
  diffBezierSemanticStates,
  semanticReplayReport
} from '../../js/bezier-semantic.js';
import { REPAIR_SESSION_RESULT_FORMAT } from '../../js/repair-session.js';
import { renderNativeLevelSvg } from '../repair/lib/render-native-level.mjs';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function safeName(value) {
  return String(value || 'candidate').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function commandEvidence(sequence) {
  return (sequence || []).map(command => ({
    sequence: command.sequence,
    hints: (command?.patch?.hints || command?.hints || []).map(String),
    operations: command?.patch?.operations || []
  }));
}

function addCounts(target, source) {
  for (const [key, count] of Object.entries(source || {})) target[key] = (target[key] || 0) + count;
}

function renderReport(analysis) {
  const cards = analysis.candidates.map(candidate => {
    const knownProperties = candidate.source?.knownProperties || [];
    return `
    <article class="candidate">
      <header>
        <div><span class="role">${escapeHtml(candidate.role)}</span><h2>${escapeHtml(candidate.id)}</h2></div>
        <span class="disposition ${escapeHtml(candidate.disposition)}">${escapeHtml(candidate.disposition)}</span>
      </header>
      <div class="images">
        <figure><img src="${escapeHtml(candidate.beforePreview)}" alt="Before ${escapeHtml(candidate.id)}"><figcaption>Before</figcaption></figure>
        <figure><img src="${escapeHtml(candidate.afterPreview)}" alt="After ${escapeHtml(candidate.id)}"><figcaption>After</figcaption></figure>
      </div>
      <dl>
        <div><dt>Replay</dt><dd>${candidate.replay.exact ? 'exact' : 'FAILED'} (${candidate.replay.replayAccuracy.toFixed(4)})</dd></div>
        <div><dt>Repair fallback</dt><dd>${(candidate.replay.repairFallbackFraction * 100).toFixed(1)}%</dd></div>
        <div><dt>Final-state fallback</dt><dd>${(candidate.replay.stateFallbackFraction * 100).toFixed(1)}%</dd></div>
        <div><dt>Program coverage</dt><dd>${(candidate.replay.stateProgramCoverage * 100).toFixed(1)}%</dd></div>
        <div><dt>Commands</dt><dd>${candidate.operationSequence.length}</dd></div>
        <div><dt>Final operations</dt><dd>${candidate.finalSemanticDiff.operations.length}</dd></div>
      </dl>
      ${candidate.note ? `<p><strong>Note:</strong> ${escapeHtml(candidate.note)}</p>` : ''}
      ${candidate.frictionNote ? `<p><strong>Wanted X, did Y:</strong> ${escapeHtml(candidate.frictionNote)}</p>` : ''}
      ${candidate.dispositionReason ? `<p><strong>Disposition reason:</strong> ${escapeHtml(candidate.dispositionReason)}</p>` : ''}
      ${knownProperties.length ? `<details open><summary>Known candidate properties (${knownProperties.length})</summary><pre>${escapeHtml(JSON.stringify(knownProperties, null, 2))}</pre></details>` : ''}
      <details><summary>Final semantic operations</summary><pre>${escapeHtml(JSON.stringify(candidate.finalSemanticDiff.operations, null, 2))}</pre></details>
    </article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Repair session ${escapeHtml(analysis.sessionId)}</title><style>
  :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#080b13;color:#edf2fb}body{margin:0;padding:28px;max-width:1400px;margin:auto}h1{margin:0 0 8px}.summary{color:#aab5c8;margin-bottom:24px}.candidate{background:#111725;border:1px solid #2a3549;border-radius:14px;padding:16px;margin:18px 0}.candidate header{display:flex;justify-content:space-between;gap:12px;align-items:start}.candidate h2{margin:3px 0 12px}.role{font-size:11px;text-transform:uppercase;color:#71a6ff}.disposition{padding:5px 8px;border-radius:999px;background:#273149}.disposition.done{background:#174d32}.images{display:grid;grid-template-columns:1fr 1fr;gap:12px}.images figure{margin:0}.images img{display:block;width:100%;max-height:600px;background:#f1f4f9;border-radius:8px}.images figcaption{text-align:center;color:#aab5c8;margin-top:5px}dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}dl div{background:#0b101b;padding:8px;border-radius:7px}dt{font-size:11px;color:#94a2b8}dd{margin:3px 0 0;font-weight:650}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080b13;padding:10px;border-radius:7px}@media(max-width:700px){body{padding:10px}.images{grid-template-columns:1fr}dl{grid-template-columns:1fr 1fr}}
  </style></head><body><h1>Repair session</h1><div class="summary">${escapeHtml(analysis.sessionId)} · ${analysis.candidates.length} candidates · independently recomputed from embedded JSON</div>${cards}</body></html>`;
}

async function main() {
  const input = path.resolve(process.argv[2] || 'repair-session-result.json');
  const output = path.resolve(process.argv[3] || `${input.replace(/\.json$/i, '')}-analysis`);
  const result = JSON.parse(await fs.readFile(input, 'utf8'));
  if (result?.format !== REPAIR_SESSION_RESULT_FORMAT) throw new Error(`Expected ${REPAIR_SESSION_RESULT_FORMAT}.`);
  await fs.mkdir(path.join(output, 'previews'), { recursive: true });

  const candidates = [];
  const fallbackReasonCounts = {};
  const languageGapReasonCounts = {};
  for (const [index, candidate] of (result.candidates || []).entries()) {
    const before = captureBezierSemanticState(candidate.baselineLevel);
    const after = captureBezierSemanticState(candidate.finalLevel);
    const patch = diffBezierSemanticStates(before, after, {
      commandEvidence: commandEvidence(candidate.operationSequence)
    });
    const replay = semanticReplayReport(after, applyBezierSemanticPatch(before, patch), patch);
    const base = `${String(index + 1).padStart(2, '0')}-${safeName(candidate.id)}`;
    const beforePreview = `previews/${base}-before.svg`;
    const afterPreview = `previews/${base}-after.svg`;
    await Promise.all([
      fs.writeFile(path.join(output, beforePreview), renderNativeLevelSvg(candidate.baselineLevel, { title: `${candidate.id} — before` })),
      fs.writeFile(path.join(output, afterPreview), renderNativeLevelSvg(candidate.finalLevel, { title: `${candidate.id} — after` }))
    ]);
    addCounts(fallbackReasonCounts, patch.metrics.fallbackReasonCounts);
    addCounts(languageGapReasonCounts, patch.metrics.languageGapReasonCounts);
    candidates.push({
      id: candidate.id, order: candidate.order, role: candidate.role,
      source: clone(candidate.source || {}), knownDefect: clone(candidate.knownDefect || null),
      disposition: candidate.disposition, dispositionReason: candidate.dispositionReason || '',
      note: candidate.note || '', frictionNote: candidate.frictionNote || '',
      operationSequence: clone(candidate.operationSequence || []),
      finalSemanticDiff: patch, replay,
      storedResultAgrees: JSON.stringify(candidate.finalSemanticDiff) === JSON.stringify(patch)
        && JSON.stringify(candidate.replay) === JSON.stringify(replay),
      beforePreview, afterPreview
    });
  }
  const analysis = {
    format: 'repair-session-analysis', version: 1,
    sessionId: result.sessionId, sourceResult: input,
    recomputedAt: new Date().toISOString(),
    warning: 'Replay accuracy, repair fallback and final-state fallback must be interpreted together.',
    fallbackReasonCounts, languageGapReasonCounts,
    refusals: candidates.filter(candidate => candidate.disposition !== 'done').map(candidate => ({
      id: candidate.id, disposition: candidate.disposition, reason: candidate.dispositionReason
    })),
    candidates
  };
  await Promise.all([
    fs.writeFile(path.join(output, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`),
    fs.writeFile(path.join(output, 'report.html'), renderReport(analysis))
  ]);
  console.log(JSON.stringify({ output, candidates: candidates.length, fallbackReasonCounts, languageGapReasonCounts }, null, 2));
}

await main();
