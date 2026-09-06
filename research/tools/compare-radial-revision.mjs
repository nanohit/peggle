import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { analyzeRepairCandidate } from '../../js/repair-session.js';
import { captureBezierSemanticState, semanticReplayReport } from '../../js/bezier-semantic.js';
import { generateRadialLevel, RADIAL_SPLIT, hashUnit } from '../repair/lib/radial-generator.mjs';
import { makeStandardPlayPreview } from '../../js/repair-play-preview.js';
import { renderNativeLevelSvg } from '../repair/lib/render-native-level.mjs';
import { sha256, sourceHash, RADIAL_BASELINE_CODE_FILES, REPO_ROOT } from './build-radial-loop.mjs';

export function prepareRadialComparison(archive, revisedRules) {
  if (archive?.format !== 'repair-session-result') throw new Error('Expected a repair result archive');
  const originalRules = archive.source?.rules;
  if (!originalRules || archive.source.generatorRulesHash !== sha256(originalRules)) throw new Error('Missing or corrupt frozen baseline rules');
  if (revisedRules.revision === originalRules.revision) throw new Error('A revision needs a new revision id');
  if (typeof revisedRules.hypothesis !== 'string' || revisedRules.hypothesis.length < 20) throw new Error('State the proposed shared rule and why it should help');
  const studyIds = archive.candidates.filter(c => c.role === 'study').map(c => c.id);
  if (archive.candidates.length !== 3 || archive.candidates.filter(c => c.role === 'control').length !== 1) throw new Error('Expected one calibration and two repairs');
  if (JSON.stringify(studyIds.slice().sort()) !== JSON.stringify([...RADIAL_SPLIT.repair].sort())) throw new Error('This first loop expects its two fixed repair candidates');
  if (!revisedRules.basedOn?.length || revisedRules.basedOn.some(id => !studyIds.includes(id))) throw new Error('basedOn must name the repaired candidate(s) motivating this revision');
  const observations = archive.candidates.map(candidate => {
    if (candidate.role === 'study') {
      const generated = generateRadialLevel(candidate.id, originalRules);
      if (!semanticReplayReport(captureBezierSemanticState(generated.level), captureBezierSemanticState(candidate.baselineLevel)).exact) {
        throw new Error(`Frozen rules do not reproduce the archived baseline: ${candidate.id}`);
      }
    }
    const analysis = analyzeRepairCandidate({ ...candidate, currentLevel: candidate.finalLevel, transactionLog: candidate.operationSequence });
    for (const gate of ['replay', 'lineage', 'commandLog', 'transactionLog']) {
      if (analysis.gates[gate].status !== 'passed') throw new Error(`Unreliable archive: ${candidate.id}/${gate}`);
    }
    if (candidate.role === 'control' && analysis.gates.control.status !== 'passed') throw new Error('Resolve calibration before using this archive as evidence');
    if (!['done', 'unfixable', 'deferred'].includes(candidate.disposition)) throw new Error(`Unresolved repair: ${candidate.id}`);
    return { id: candidate.id, role: candidate.role, disposition: candidate.disposition, note: candidate.note,
      refusal: candidate.dispositionReason, friction: candidate.frictionNote, metrics: analysis.patch.metrics,
      operations: analysis.patch.operations.filter(o => o.expressibility !== 'ignored').map(o => ({ type: o.type, objectId: o.objectId, reason: o.reason })) };
  });
  const comparisonId = `${originalRules.revision}-vs-${revisedRules.revision}-${sha256(revisedRules).slice(0, 8)}`;
  const pairs = RADIAL_SPLIT.holdout.map((seed, index) => {
    const original = generateRadialLevel(seed, originalRules), revised = generateRadialLevel(seed, revisedRules);
    const reversed = hashUnit(`${comparisonId}:${seed}:side`) < 0.5;
    return { id: `pair-${index + 1}`, seed, labels: reversed ? ['revised', 'original'] : ['original', 'revised'],
      sides: reversed ? [revised, original] : [original, revised] };
  });
  return { format: 'radial-revision-comparison', version: 1, comparisonId,
    repairArchiveHash: sha256(archive), originalRules, revisedRules, observations, pairs,
    inference: 'Matched exploratory holdout within ONE radial family. Report preferences, both-bad and absolute acceptance, not significance or general Peggle quality.' };
}

export async function writeRadialComparison(comparison, output) {
  await fs.mkdir(output, { recursive: true });
  const cards = [];
  for (const pair of comparison.pairs) {
    const figures = [];
    for (const [i, item] of pair.sides.entries()) {
      const label = i ? 'B' : 'A', file = `${pair.id}-${label}.json`;
      await fs.writeFile(path.join(output, file), JSON.stringify(item.level));
      const playable = makeStandardPlayPreview(item.level, pair.seed);
      playable.name = `${pair.id} / ${label}`;
      playable.metadata = { playPreview: playable.metadata.playPreview };
      const hash = deflateSync(JSON.stringify(playable)).toString('base64url');
      figures.push(`<figure>${renderNativeLevelSvg(item.level, { title: label })}<figcaption>${label} · <a href="/player.html#${hash}" target="_blank" rel="noopener">Играть ${label}</a> · <a href="${file}" download>JSON</a></figcaption></figure>`);
    }
    cards.push(`<section data-id="${pair.id}"><h2>${pair.id}</h2><div class="pair">${figures.join('')}</div>
<label>Сильнее композиция <select data-key="preference"><option value="">Не оценено</option><option value="A">A</option><option value="B">B</option><option value="tie">Ничья</option><option value="both-bad">Оба плохие</option><option value="cannot-judge">Не могу оценить</option></select></label>
<label><input type="checkbox" data-key="acceptableA"> A годится без большого ремонта</label><label><input type="checkbox" data-key="acceptableB"> B годится без большого ремонта</label>
<label><input type="checkbox" data-key="playedA"> Играл A</label><label><input type="checkbox" data-key="playedB"> Играл B</label>
<label>Лучше играть <select data-key="playPreference"><option value="">Не оценено</option><option>A</option><option>B</option><option value="tie">Ничья</option><option value="both-bad">Оба плохие</option></select></label>
<textarea data-key="note" placeholder="Почему? Что всё ещё требует ремонта?"></textarea></section>`);
  }
  const publicIds = comparison.pairs.map(p => p.id);
  await fs.writeFile(path.join(output, 'comparison-manifest.json'), JSON.stringify({ ...comparison,
    pairs: comparison.pairs.map(p => ({ ...p, sides: p.sides.map(s => ({ revision: s.revision, parameters: s.parameters,
      staticChecks: s.staticChecks, geometryHash: sha256(s.level.pegs) })) })) }, null, 2));
  const literal = JSON.stringify({ comparisonId: comparison.comparisonId, pairIds: publicIds }).replaceAll('<', '\\u003c');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Проверка переноса правил</title><style>
body{font:17px/1.5 system-ui;background:#101623;color:#eaf0ff;max-width:1050px;margin:auto;padding:24px}a{color:#8dd1ff}section{margin:30px 0;padding:18px;border:1px solid #49627c;border-radius:10px}.pair{display:flex;gap:20px}figure{margin:0;flex:1}svg{width:100%;max-height:540px}label{display:inline-block;margin:10px}textarea{display:block;width:95%;min-height:65px}button,select{padding:10px}header{position:sticky;top:0;background:#101623;padding:14px;z-index:2}</style></head><body>
<header><button id="export">Export decisions</button><span id="status"></span></header><h1>Шесть новых пар</h1><p>Стороны перемешаны. Сначала композиция, затем при желании игра. «Лучше» и «уже годится» — разные вопросы. Оба могут быть плохими. Цвета в игровой копии назначены фиксированно, это ещё не политика сложности.</p>
${cards.join('')}<script>
const spec=${literal}, key='radial-review:'+spec.comparisonId; let saved={}; try{saved=JSON.parse(localStorage.getItem(key)||'{}')}catch{}
function read(){return [...document.querySelectorAll('section')].map(s=>Object.fromEntries([['id',s.dataset.id],...[...s.querySelectorAll('[data-key]')].map(e=>[e.dataset.key,e.type==='checkbox'?e.checked:e.value])]))}
for(const row of saved.decisions||[]){const s=document.querySelector('section[data-id="'+row.id+'"]');if(s)for(const e of s.querySelectorAll('[data-key]')){if(e.type==='checkbox')e.checked=!!row[e.dataset.key];else e.value=row[e.dataset.key]||''}}
function snapshot(){return {format:'radial-holdout-review',version:1,comparisonId:spec.comparisonId,decisions:read()}}
document.addEventListener('input',()=>{try{localStorage.setItem(key,JSON.stringify(snapshot()));document.querySelector('#status').textContent=' Saved locally'}catch{document.querySelector('#status').textContent=' Storage failed: export a backup now'}});
document.querySelector('#export').onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(snapshot())],{type:'application/json'}));a.href=url;a.download=spec.comparisonId+'-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
</script></body></html>`);
  return { output, comparisonId: comparison.comparisonId, pairCount: comparison.pairs.length,
    invalidOriginal: comparison.pairs.filter(p => p.sides[p.labels.indexOf('original')].staticChecks.status !== 'passed').length,
    invalidRevised: comparison.pairs.filter(p => p.sides[p.labels.indexOf('revised')].staticChecks.status !== 'passed').length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (async () => {
    if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node research/tools/compare-radial-revision.mjs <repair-result.json> <revised-rules.json> [output]');
    const archive = JSON.parse(await fs.readFile(process.argv[2], 'utf8')), rules = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
    for (const file of RADIAL_BASELINE_CODE_FILES) {
      const expected = archive.source?.codeHashes?.[file];
      const hash = archive.source?.codeHashFormat === 'sha256-lf-v1' ? sourceHash : sha256;
      if ((!expected && !archive.protocol?.synthetic) || (expected && expected !== hash(await fs.readFile(path.join(REPO_ROOT, file), 'utf8')))) {
        throw new Error(`Baseline code differs: ${file}. This tool compares rule parameters only; regenerate the original side from the archived git revision before comparing changed generator/physics code.`);
      }
    }
    const comparison = prepareRadialComparison(archive, rules);
    const output = path.resolve(process.argv[4] || path.join(REPO_ROOT, 'research/generated', comparison.comparisonId));
    console.log(JSON.stringify(await writeRadialComparison(comparison, output), null, 2));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
