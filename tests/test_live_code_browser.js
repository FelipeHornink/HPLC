// Optional real browser check. Set PLC_PLAYWRIGHT_MODULE to a Playwright install
// outside this extension, then run node tests/test_live_code_browser.js.
const { chromium } = require(process.env.PLC_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { html } = require('../live-code');
const { buildModel, executionState } = require('../live-code-model');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-browser-'));
  let browser;
  try {
    const compiled = [], lines = {}, sources = {
      'programs/Main.st': 'PROGRAM Main\nVAR\n child : Child;\nEND_VAR\nchild();\nEND_PROGRAM',
      'blocks/Child.st': 'FUNCTION_BLOCK Child\nCounter := Counter + 1;\n(* </script><script>window.injected = true</script> *)\nEND_FUNCTION_BLOCK'
    };
    for (const [file, source] of Object.entries(sources)) {
      const snapshot = path.join(root, '.plcsim/generated/src', file);
      fs.mkdirSync(path.dirname(snapshot), { recursive: true }); fs.writeFileSync(snapshot, source);
      source.split('\n').forEach((text, i) => { compiled.push(text); lines[compiled.length] = { file, line: i + 1, kind: file.split('/')[0] }; });
    }
    const build = path.join(root, '.plcsim/build'); fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(build, 'project.st'), compiled.join('\n'));
    fs.writeFileSync(path.join(build, 'source_map.json'), JSON.stringify({ lines }));
    const id = Number(Object.keys(lines).find(id => lines[id].file === 'blocks/Child.st' && lines[id].line === 2));
    fs.writeFileSync(path.join(build, 'debug_points.json'), JSON.stringify([id]));
    const model = buildModel(root);
    fs.writeFileSync(path.join(root, 'preview.html'), html(root, model));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.sent = []; window.acquireVsCodeApi = () => ({ getState: () => null, setState: state => window.saved = state, postMessage: message => window.sent.push(message) }); });
    await page.goto(pathToFileURL(path.join(root, 'preview.html')).href);
    await page.locator('.routine').first().waitFor();
    assert.equal(await page.locator('#source-file').textContent(), 'programs/Main.st');
    const debug = { mode: 'line', scan: 10, trace: [id], waiting_line: true, current_line: id };
    const message = { type: 'state', running: true, debug, execution: executionState(model, debug), variables: [{ path: 'Main.Counter', type: 'INT', value: 7 }] };
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await send(message);
    assert.equal(await page.locator('#source-file').textContent(), 'blocks/Child.st');
    assert.equal(await page.locator('.line.current').count(), 1);
    assert.match(await page.locator('.line-values').allTextContents().then(values => values.join(' ')), /Counter=7/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('.routine[data-file="programs/Main.st"]').click();
    assert.equal(await page.locator('#follow').isChecked(), false);
    await send(message);
    assert.equal(await page.locator('#source-file').textContent(), 'programs/Main.st');
    await page.locator('#follow').check();
    assert.equal(await page.locator('#source-file').textContent(), 'blocks/Child.st');
    await page.locator('[data-action="step_line"]').click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'control', action: 'step_line' });
    await page.locator('#edit').click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'source', file: 'blocks/Child.st', line: 2 });
    await page.locator('#filter').fill('Child');
    assert.ok(await page.locator('.routine:visible').count() > 0);
    await send({ type: 'state', running: false, debug: {}, execution: { executed: {}, current: null }, variables: [] });
    assert.equal(await page.locator('.current,.executed,.active').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: routine tree, selection/follow, line highlights, inline values, commands, search, stop and escaped ST.');
  } finally { if (browser) await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
