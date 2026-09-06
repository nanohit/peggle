import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { applySimilarityTransform, transformBezierCurve, sampleCubicBezier } from '../../js/bezier-geometry.js';
import { normalizeLevelData, LevelManager } from '../../js/levels.js';
import { captureBezierSemanticState as capture, diffBezierSemanticStates as diff } from '../../js/bezier-semantic.js';
import { validateRepairSessionDefinition, evaluateRepairStaticChecks } from '../../js/repair-session.js';
import { compileBezierProgram } from '../repair/lib/program.mjs';
import { renderNativeLevelSvg } from '../repair/lib/render-native-level.mjs';
import { generateRadialLevel, RADIAL_SPLIT } from '../repair/lib/radial-generator.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clone = value => JSON.parse(JSON.stringify(value));
export const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const sourceHash = text => sha256(text.replace(/\r\n/g, '\n'));
export const RADIAL_BASELINE_CODE_FILES = Object.freeze([
  'research/repair/lib/radial-generator.mjs', 'research/repair/lib/program.mjs',
  'js/bezier-geometry.js', 'js/bezier-program.js', 'js/levels.js',
  'js/repair-play-preview.js', 'js/physics.js', 'js/game.js', 'js/utils.js'
]);

function controlCandidate() {
  const strokes = [];
  for (const row of [0, 1]) for (const side of [0, 1]) {
    const reflect = p => ({ x: side ? 400 - p.x : p.x, y: p.y + row * 210 });
    const curve = { start: reflect({ x: 55, y: 185 }), h1: reflect({ x: 65, y: 120 }),
      h2: reflect({ x: 145, y: 120 }), end: reflect({ x: 165, y: 185 }) };
    const samples = sampleCubicBezier(curve);
    const length = samples.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - samples[i].x, p.y - samples[i].y), 0);
    strokes.push({ ...curve, groupId: `calibration:${row}:${side}`, pegShape: row ? 'circle' : 'brick', pegType: 'blue',
      spacingPx: length / 7, brickWidth: length / 7, brickHeight: 10.2 });
  }
  const target = normalizeLevelData(compileBezierProgram({ id: 'radial-calibration', name: 'Калибровка редактора', pegRadius: 8.5, strokes }));
  const baseline = clone(target), objectId = 'calibration:0:0';
  const members = baseline.pegs.filter(p => p.objectId === objectId);
  const center = { x: members.reduce((s, p) => s + p.x, 0) / members.length, y: members.reduce((s, p) => s + p.y, 0) / members.length };
  const angle = Math.PI / 9, cos = Math.cos(angle), sin = Math.sin(angle);
  const transform = { angle, scale: 1, tx: center.x - center.x * cos + center.y * sin, ty: center.y - center.x * sin - center.y * cos };
  baseline.bezierCurves[objectId] = transformBezierCurve(baseline.bezierCurves[objectId], transform);
  for (const peg of members) {
    const moved = applySimilarityTransform(peg, transform); peg.x = moved.x; peg.y = moved.y; peg.angle += angle;
    for (const slice of peg.curveSlices || []) {
      const movedSlice = applySimilarityTransform(slice, transform), { nx, ny } = slice;
      Object.assign(slice, movedSlice, { nx: nx * cos - ny * sin, ny: nx * sin + ny * cos });
    }
  }
  const operations = diff(capture(baseline), capture(target)).operations.filter(o => o.expressibility !== 'ignored');
  if (operations.length !== 1 || operations[0].type !== 'transform-stroke') throw new Error('Control is not one executable transform');
  return { id: 'control:single-rotation', role: 'control', baselineLevel: baseline, controlTargetLevel: target,
    source: { compositionFamily: 'calibration-only', excludedFromDesignEvidence: true },
    knownDefect: { id: 'single-stroke-rotation', objectId, acceptanceThresholdPx: 2,
      instruction: 'Калибровка, не оценка вкуса: восстановите симметрию одного нарушенного элемента. Остальные оставьте. Если непонятно — Defer, это полезный результат.',
      injectedTransform: transform, expectedOperation: { type: operations[0].type, objectId, transform: operations[0].transform } } };
}

export function buildRadialDefinition(rules) {
  const rulesHash = sha256(rules);
  const studies = RADIAL_SPLIT.repair.map(seed => {
    const generated = generateRadialLevel(seed, rules);
    if (generated.staticChecks.status !== 'passed') throw new Error(`Repair candidate ${seed} is invalid: ${generated.staticChecks.failures}`);
    return { id: seed, role: 'study', baselineLevel: generated.level, source: {
      source: 'constructive-radial-generator', compositionFamily: 'interrupted-concentric-rings',
      generatorRevision: rules.revision, generatorRulesHash: rulesHash, parameters: generated.parameters,
      strata: ['radial-family-exploration'], knownProperties: ['One deliberately narrow family; not representative of all Peggle designs.'],
      footprint: generated.staticChecks.coverage
    } };
  });
  const definition = { format: 'repair-session', version: 1, sessionId: `${rules.revision}-${rulesHash.slice(0, 8)}-repair`,
    seed: 'radial-first-loop', source: { generatorRevision: rules.revision, generatorRulesHash: rulesHash, rules: clone(rules) },
    protocol: { candidateCount: 3, controlFirst: true, semanticScope: 'composition-standard-v2',
      purpose: 'Two author repairs -> explicit shared rule revision -> six matched unseen seeds. Replay/coverage are instrument diagnostics, not a quality score.',
      scope: '400x600; blue/orange ordinary pegs; no scrolling, destruction, animations or mechanics authoring',
      holdoutSeeds: RADIAL_SPLIT.holdout, metricsVisibleDuringRepair: false,
      inference: 'Exploratory only. No population effect estimate or learned generator claim from two repairs.',
      hypothesesPerRevision: 'Prefer one substantive shared rule change; preserve all seeds and failures.',
      playPreview: 'Optional diagnostic with fixed hash-assigned oranges; never modifies composition.' }, candidates: [controlCandidate(), ...studies] };
  const validation = validateRepairSessionDefinition(definition);
  if (validation.status !== 'passed') throw new Error(validation.failures.join(', '));
  // Use the actual import path, not only normalization.
  const manager = Object.create(LevelManager.prototype); manager.levels = []; manager.save = () => true;
  for (const candidate of definition.candidates) {
    const imported = manager.importLevel(JSON.stringify(candidate.baselineLevel));
    if (diff(capture(candidate.baselineLevel), capture(imported)).operations.length) throw new Error(`Non-empty import: ${candidate.id}`);
    if (evaluateRepairStaticChecks(candidate.baselineLevel).status !== 'passed') throw new Error(`Invalid baseline: ${candidate.id}`);
  }
  return definition;
}

export async function buildRadialLoop(options = {}) {
  const rulesPath = path.resolve(options.rulesPath || path.join(REPO_ROOT, 'research/repair/radial-rules-v1.json'));
  const output = path.resolve(options.output || path.join(REPO_ROOT, 'research/generated/radial-loop-v1'));
  const rules = JSON.parse(await fs.readFile(rulesPath, 'utf8')), definition = buildRadialDefinition(rules);
  const fingerprints = {};
  for (const file of [...RADIAL_BASELINE_CODE_FILES, 'js/bezier-semantic.js', 'js/semantic-object-codec.js', 'js/composition-geometry.js', 'js/editor.js']) {
    fingerprints[file] = sourceHash(await fs.readFile(path.join(REPO_ROOT, file), 'utf8'));
  }
  definition.source.codeHashes = fingerprints;
  definition.source.codeHashFormat = 'sha256-lf-v1';
  definition.source.buildRuntime = { node: process.version, v8: process.versions.v8 };
  definition.sessionId += `-${sha256(fingerprints).slice(0, 8)}`;
  try { definition.source.gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch { definition.source.gitRevision = null; }
  await fs.mkdir(path.join(output, 'previews'), { recursive: true });
  await fs.writeFile(path.join(output, 'repair-session.json'), JSON.stringify(definition));
  const manifest = { format: 'radial-loop-manifest', version: 1, sessionId: definition.sessionId, rules, split: RADIAL_SPLIT,
    source: definition.source, definitionHash: sha256(definition),
    next: 'After two repairs, revise rules with an explicit hypothesis. Compare old/new rules on every fixed holdout seed; retain failures and both-bad verdicts.',
    candidates: definition.candidates.map(c => ({ id: c.id, role: c.role, source: c.source, staticChecks: evaluateRepairStaticChecks(c.baselineLevel) })) };
  await fs.writeFile(path.join(output, 'generator-manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [i, c] of definition.candidates.entries()) await fs.writeFile(path.join(output, 'previews', `${i}.svg`), renderNativeLevelSvg(c.baselineLevel));
  const relative = path.relative(REPO_ROOT, output).split(path.sep).join('/');
  const editorUrl = `/editor.html?repair=${encodeURIComponent(`/${relative}/repair-session.json`)}`;
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Первый цикл генератора</title>
<style>body{font:18px/1.6 system-ui;background:#101623;color:#eaf0ff;max-width:1060px;margin:40px auto;padding:20px}a{color:#99d6ff}.start{display:inline-block;padding:12px 24px;background:#245395;color:white;border-radius:8px}section{display:flex;gap:24px}figure{flex:1;margin:0}img{width:100%;max-height:480px}small{color:#b4c3da}</style>
<h1>Два ремонта → изменение правил → новые уровни</h1><p>Сейчас: обычное поле 400×600. Одно радиальное семейство, а не универсальный генератор.</p>
<ol><li>Короткая калибровка: восстановить нарушенную симметрию. Она не войдёт в оценку дизайна.</li><li>Два уровня: правьте композицию как обычно. Добавлять, удалять и отказываться можно. В заметке — зачем меняли; в Wanted X — что помешало.</li><li>Before / Current не сбрасывают undo. Play preview — отдельная игровая копия с 25 оранжевыми; Current вернёт ремонт.</li><li>Finish &amp; export. Если проверка мешает — Export draft / backup, и пришлите файл: работа не пропадёт.</li></ol>
<p><a class="start" href="${editorUrl}">Открыть редактор / продолжить</a> · <a href="repair-session.json" download>Скачать сессию</a></p>
<p>Сначала только эти два ремонта. Дальше — одна обоснованная правка общих правил и шесть новых пар old/new. Ничего не объявляем качественным по replay или покрытию языка.</p>
<section>${definition.candidates.slice(1).map((c, i) => `<figure><img src="previews/${i + 1}.svg" alt="Кандидат ${i + 1}"><figcaption>Кандидат ${i + 1} · ${c.baselineLevel.pegs.length} пегов</figcaption></figure>`).join('')}</section>
<p><small>Изменения параметров объясняют только это семейство. Если оба уровня требуют полного перерисовывания, это основание изменить семейство, не требование спасать кандидатов. Снимки хранятся локально; не публикуются автоматически.</small></p></html>`);
  return { output, sessionId: definition.sessionId, candidates: manifest.candidates.map(c => ({ id: c.id, pegs: c.staticChecks.pegCount, static: c.staticChecks.status })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildRadialLoop({ rulesPath: process.argv[2], output: process.argv[3] }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
