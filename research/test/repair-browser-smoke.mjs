// Optional browser integration check. Requires Playwright (can use the bundled
// desktop runtime via NODE_PATH); it never uses the author's browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.env.REPAIR_TEST_URL || 'http://127.0.0.1:8876';
const output = path.resolve('research/generated/radial-loop-v1/qa');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [], remoteWrites = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => { if (!['GET', 'HEAD'].includes(request.method()) && !request.url().startsWith(base)) remoteWrites.push(request.url()); });
// External assets aren't part of this test and no production call is allowed.
await context.route('**/*', route => route.request().url().startsWith(base) || /^(data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
try {
  await page.goto(base); await page.getByRole('link', { name: 'Открыть редактор / продолжить' }).waitFor();
  assert.ok((await page.locator('body').innerText()).includes('Два ремонта'));
  await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: path.join(output, 'landing.png'), fullPage: true });
  console.log('Landing loaded: two visible candidates and explicit start link; no auto-open.');
  if (process.argv.includes('--landing-only')) process.exitCode = 0;
  else {
    await page.getByRole('link', { name: 'Открыть редактор / продолжить' }).click();
    await page.waitForFunction(() => window.peggleApp?.repairSession?.candidates.length === 3);
    await page.locator('#repairSessionPanel.visible').waitFor();
    assert.equal(await page.evaluate(() => window.__PEGGLE_API_BASE__), '/api');
    await page.screenshot({ path: path.join(output, 'editor-control.png'), fullPage: true });
    const importCounts = await page.evaluate(async () => {
      const { captureBezierSemanticState: capture, diffBezierSemanticStates: diff } = await import('/js/bezier-semantic.js');
      return window.peggleApp.repairSession.candidates.map(c => diff(capture(c.baselineLevel), capture(c.currentLevel)).operations.length);
    });
    assert.deepEqual(importCounts, [0, 0, 0]);
    await page.locator('#repairNextBtn').click();
    const edit = await page.evaluate(async () => {
      const app = window.peggleApp, editor = app.editor, level = app.levelManager.getCurrentLevel();
      const groupId = Object.keys(level.bezierCurves)[0];
      editor.selectedPegIds = new Set(level.pegs.filter(p => p.bezierGroupId === groupId).map(p => p.id));
      editor.beginResearchCommand('move-selection'); editor.saveUndoState(); editor.captureDragStartPositions();
      editor.moveSelectedPegs(0, 5); editor.finalizeBezierSelectionExceptions(); editor.finishResearchCommand('move-selection');
      app.levelManager.save(); app._captureCurrentRepairLevel(); await app._repairPersistPromise;
      return { x: level.pegs[0].x, y: level.pegs[0].y, undo: editor.undoStack.length };
    });
    assert.equal(edit.undo, 1);
    await page.locator('#repairBeforeBtn').click(); await page.locator('#repairCurrentBtn').click();
    assert.equal(await page.evaluate(() => window.peggleApp.editor.undoStack.length), 1);
    await page.locator('#repairNote').fill('SYNTHETIC browser transport test — not author feedback.');
    await page.evaluate(async () => { window.peggleApp._captureRepairPanelFields(); await window.peggleApp._repairPersistPromise; });
    await page.reload(); await page.waitForFunction(() => window.peggleApp?.repairSession?.activeIndex === 1);
    assert.equal(await page.evaluate(() => window.peggleApp.editor.undoStack.length), 1);
    assert.match(await page.locator('#repairNote').inputValue(), /SYNTHETIC/);
    await page.evaluate(() => window.peggleApp.editor.undo());
    const undoOps = await page.evaluate(async () => {
      const { analyzeRepairCandidate } = await import('/js/repair-session.js');
      const app = window.peggleApp; app._captureCurrentRepairLevel();
      return analyzeRepairCandidate(app.repairSession.candidates[1]).patch.operations.length;
    });
    assert.equal(undoOps, 0);
    await page.evaluate(() => window.peggleApp.editor.redo());
    await page.locator('#repairPlayBtn').click();
    await page.waitForFunction(() => window.peggleApp?.mode === 'play' && window.peggleApp?.game);
    const preview = await page.evaluate(() => ({ mode: window.peggleApp.mode,
      orange: window.peggleApp.levelManager.getCurrentLevel().pegs.filter(p => p.type === 'orange').length,
      baselineOrange: window.peggleApp.repairSession.candidates[1].currentLevel.pegs.filter(p => p.type === 'orange').length }));
    assert.equal(preview.orange, 25); assert.equal(preview.baselineOrange, 0);
    // Fire through the actual runtime and wait for physical motion, not just
    // a successful switch to the play screen.
    const ballStartY = await page.evaluate(() => window.peggleApp.game.balls[0].y);
    const canvasBox = await page.locator('#gameCanvas').boundingBox();
    await page.mouse.click(canvasBox.x + canvasBox.width * 0.58, canvasBox.y + canvasBox.height * 0.55);
    await page.waitForFunction(y => window.peggleApp.game.shotsFired > 0 && window.peggleApp.game.balls.some(b => b.active && b.y > y + 40), ballStartY);
    await page.screenshot({ path: path.join(output, 'play-preview.png'), fullPage: true });
    await page.locator('#repairCurrentBtn').click();
    assert.equal(await page.evaluate(() => window.peggleApp.editor.undoStack.length), 1);
    const pending = page.waitForEvent('download'); await page.locator('#repairDraftBtn').click();
    const download = await pending; await download.saveAs(path.join(output, 'synthetic-browser-draft.json'));
    const result = JSON.parse(await fs.readFile(path.join(output, 'synthetic-browser-draft.json'), 'utf8'));
    assert.equal(result.status, 'draft'); assert.equal(result.candidates.length, 3);
    assert.equal(result.candidates[1].replay.exact, true);
    assert.ok(await page.evaluate(() => !!window.peggleApp.repairSession));
    // Undo the synthetic test repair, restore the control with the real rotate
    // handler, then test the strict export path as well as the draft path.
    await page.evaluate(() => {
      const app = window.peggleApp; app.editor.undo(); app._captureCurrentRepairLevel(); app._loadRepairCandidate(0, 'current');
      const editor = app.editor, level = app.levelManager.getCurrentLevel(), c = app.repairSession.candidates[0];
      editor.selectedPegIds = new Set(level.pegs.filter(p => p.objectId === c.knownDefect.objectId).map(p => p.id));
      editor.rotationCenter = editor.getSelectionCenter(); editor.beginResearchCommand('rotate-selection'); editor.saveUndoState();
      editor.rotateSelectedPegsAbsolute(-Math.PI / 9); editor.finalizeBezierSelectionExceptions(); editor.finishResearchCommand('rotate-selection');
      app.levelManager.save(); app._captureCurrentRepairLevel();
      app.repairSession.protocol.synthetic = true;
      for (const candidate of app.repairSession.candidates) { candidate.disposition = 'done'; candidate.note = 'SYNTHETIC complete export transport test'; }
    });
    const finishing = page.waitForEvent('download'); await page.locator('#repairFinishBtn').click();
    await (await finishing).saveAs(path.join(output, 'synthetic-browser-complete.json'));
    const complete = JSON.parse(await fs.readFile(path.join(output, 'synthetic-browser-complete.json'), 'utf8'));
    assert.equal(complete.status, 'complete'); assert.equal(complete.candidates[0].gates.control.status, 'passed');
    await page.waitForFunction(() => !window.peggleApp.repairSession);
    const choosing = page.waitForEvent('filechooser');
    await page.evaluate(() => window.peggleApp.importRepairSession());
    await (await choosing).setFiles(path.join(output, 'synthetic-browser-draft.json'));
    await page.waitForFunction(() => !!window.peggleApp.repairSession);
    const resumed = await page.evaluate(async () => {
      const app = window.peggleApp;
      app._activateRepairSession(app.repairSession, { resumed: true });
      app.levelManager.save(); // Re-entry must not wrap onDidSave recursively.
      const { analyzeRepairCandidate } = await import('/js/repair-session.js');
      return { controlOps: analyzeRepairCandidate(app.repairSession.candidates[0]).patch.operations.length,
        studyY: app.repairSession.candidates[1].currentLevel.pegs[0].y };
    });
    assert.equal(resumed.controlOps, 0); assert.equal(resumed.studyY, edit.y);
    assert.equal(remoteWrites.length, 0);
    assert.deepEqual(errors, []);
    console.log('Browser passed: actual import -> edit -> before/current -> durable reload -> undo/redo -> real shot -> draft -> calibrated complete export -> archive resume.');
  }
} catch (error) {
  console.error(JSON.stringify({ pageErrors: errors, url: page.url(), body: (await page.locator('body').innerText()).slice(0, 1000) }));
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally { await browser.close(); }
