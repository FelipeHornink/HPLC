// Browser tests use HTTP fixtures only. They do not start a PLC or execute scans.
const { chromium } = require(process.env.PLC_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const variables = [
  { path: 'Cmd.Run', type: 'BOOL', value: false, writable: true },
  { path: 'Cmd.Pulse', type: 'BOOL', value: false, writable: true },
  { path: 'Setpoint', type: 'REAL', value: 3.5, writable: true },
  { path: 'Pressure', type: 'REAL', value: 4.125, writable: false },
  { path: 'Status.Ready', type: 'BOOL', value: true, writable: false }
];
const initialPid = { version: 1, title: 'Process bench', custom: { preserved: true }, display: { realPrecision: 2, theme: 'light' }, items: [
  { tag: 'Pressure', label: 'Pressure', x: 18, y: 22, unit: 'bar' },
  { tag: 'Cmd.Pulse', label: 'Start', kind: 'momentary', writable: true, x: 70, y: 70 }
], shapes: [{ id: 'original', type: 'pump', x: 45, y: 45, width: 9, height: 10, tag: 'Cmd.Run', extra: 'keep' }] };
// Legacy area keys ("ihm", "comunicacao") on purpose: projects created before the English release must keep working.
const initialPanel = { title: 'Bench', display: { realPrecision: 2 }, areas: {
  monitoring: [{ tag: 'Pressure', label: 'Pressure', unit: 'bar', kind: 'number', writable: false }],
  ihm: [{ tag: 'Cmd.Run', label: 'Run', kind: 'toggle', writable: true }, { tag: 'Status.Ready', label: 'Ready', kind: 'lamp', writable: true }],
  panel: [], interface: [], field: [], comunicacao: []
} };
async function setup(browser, kind) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 680 } });
  const fixture = { pid: structuredClone(initialPid), panel: structuredClone(initialPanel), writes: [], saves: [], errors: [], rejectSave: false };
  page.on('pageerror', error => fixture.errors.push(error.message));
  await page.addInitScript(() => {
    window.sources = [];
    window.EventSource = class { constructor(url) { this.url = url; window.sources.push(this); setTimeout(() => { if (url.endsWith('/state')) this.onmessage?.({ data: JSON.stringify({ mode: 'run', scan: 10 }) }); }, 30); } close() {} };
  });
  await page.route('http://plc.test/**', async route => {
    const url = new URL(route.request().url());
    let data;
    if(url.pathname==='/host') {await route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="margin:0"><iframe id="view" src="/embedded" style="width:100vw;height:100vh;border:0"></iframe><script>window.hostRequests=[];window.addEventListener('message',event=>{const m=event.data;if(m?.channel!=='plc-ui')return;window.hostRequests.push(m);let data={ok:true};if(m.action==='get-project-settings')data={name:'Fixture project',task:'MainTask',program:'Main',programs:['Main'],interval:10,panelPort:8100,pidPort:8101};event.source.postMessage({channel:'plc-ui-result',requestId:m.requestId,data},event.origin)});</script></body></html>`});return;}
    if (url.pathname === '/api/pid-config') data = fixture.pid;
    else if (url.pathname === '/api/panel-config') data = fixture.panel;
    else if (url.pathname === '/api/variables') data = { variables };
    else if (url.pathname === '/api/set') { fixture.writes.push([url.searchParams.get('tag'), url.searchParams.get('val')]); await new Promise(r => setTimeout(r, 60)); data = { ok: true }; }
    else if (url.pathname === '/api/control') data = { ok: true };
    else if (url.pathname === '/api/save-config') {
      if (fixture.rejectSave) { await route.fulfill({ status: 400, contentType: 'application/json', body: '{"ok":false,"error":"Fixture save error"}' }); return; }
      const target = url.searchParams.get('target'); fixture[target] = route.request().postDataJSON(); fixture.saves.push(target); data = { ok: true };
    } else if (url.pathname === '/api/source') { await route.fulfill({ contentType: 'text/plain', body: '(* fixture *)' }); return; }
    else { await route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'template/plc-project/panel', kind === 'pid' ? 'pid.html' : 'index.html'), 'utf8') }); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto('http://plc.test/');
  await page.waitForFunction(() => document.querySelector('#title')?.textContent !== 'P&ID' && document.querySelector('#title')?.textContent !== 'HPLC · BENCH');
  return { page, fixture };
}
async function drag(page, from, to, steps = 8) { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps }); await page.mouse.up(); }
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const { page, fixture } = await setup(browser, 'pid');
    await page.locator('.tag').first().waitFor();
    assert.equal(await page.locator('.tag').count(), 2);
    assert.match(await page.locator('.tag').first().textContent(), /4.13 bar/);
    await page.locator('#editButton').click();
    const canvas = await page.locator('#world').boundingBox();
    for (const [i, tool] of ['line', 'ellipse', 'rect', 'pen'].entries()) {
      await page.locator(`[data-tool="${tool}"]`).click();
      await drag(page, { x: canvas.x + 40 + i * 75, y: canvas.y + canvas.height * .4 }, { x: canvas.x + 85 + i * 75, y: canvas.y + canvas.height * .6 });
    }
    if(await page.locator('#shapes > g').count()!==5) { console.log('Drawing state',await page.evaluate(()=>({editing,tool,gesture,count:config.shapes.length})),fixture.errors); await page.screenshot({path:'/tmp/plc-debug-preview/draw-error.png'}); }
    assert.equal(await page.locator('#shapes > g').count(), 5);
    await page.locator('#undoButton').click(); assert.equal(await page.locator('#shapes > g').count(), 4);
    await page.locator('#redoButton').click(); assert.equal(await page.locator('#shapes > g').count(), 5);
    await page.locator('[data-tool="select"]').click();
    const moved = page.locator('#shapes > g').nth(3), beforeMove = await moved.boundingBox();
    await drag(page, {x:beforeMove.x+beforeMove.width/2,y:beforeMove.y+5}, {x:beforeMove.x+beforeMove.width/2+25,y:beforeMove.y+20});
    const afterMove = await moved.boundingBox(); assert.ok(afterMove.x > beforeMove.x + 15);
    const handle = await page.locator('[data-resize]').boundingBox();
    await drag(page, {x:handle.x+handle.width/2,y:handle.y+handle.height/2}, {x:handle.x+handle.width/2+25,y:handle.y+handle.height/2+20});
    assert.ok((await moved.boundingBox()).width > afterMove.width + 10);
    await page.locator('#addTagButton').click();
    await page.locator('#tagSearch').fill('Cmd.Run');
    await page.locator('.catalog-row').first().click();
    await page.locator('#widgetKind').selectOption('toggle');
    await page.locator('#insertWidget').click();
    assert.equal(fixture.writes.length, 0);
    await page.locator('#saveButton').click();
    await page.waitForFunction(() => document.querySelector('#saveButton').disabled);
    assert.equal(fixture.pid.items.length, 3);
    assert.deepEqual(fixture.pid.custom, { preserved: true });
    assert.equal(fixture.pid.shapes[0].extra, 'keep');
    assert.deepEqual(fixture.pid.shapes.map(s => s.type), ['pump', 'line', 'ellipse', 'rect', 'freehand']);
    await page.locator('#operateButton').click();
    const toggle = page.locator('.tag').last().locator('button');
    await toggle.click(); await page.waitForTimeout(140);
    assert.deepEqual(fixture.writes.at(-1), ['Cmd.Run', '1']);
    const pulse = page.locator('.tag').nth(1).locator('button');
    const box = await pulse.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(200);
    assert.deepEqual(fixture.writes.slice(-2), [['Cmd.Pulse', '1'], ['Cmd.Pulse', '0']]);
    await page.locator('#editButton').click(); await page.locator('#addTagButton').click();
    await page.locator('#tagSearch').fill('Pressure'); await page.locator('.catalog-row').first().click();
    assert.equal(await page.locator('#widgetKind option[value="number"]').evaluate(option=>option.disabled), true);
    await page.locator('#closePicker').click();
    await page.locator('.tag').last().click();
    const label = page.locator('#properties label').filter({hasText:'Label'}).locator('input');
    await label.fill('Revised command'); await label.press('Tab');
    fixture.rejectSave = true; await page.locator('#saveButton').click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Fixture save error'));
    assert.equal(await page.locator('#saveButton').isDisabled(),false);
    assert.notEqual(fixture.pid.items.at(-1).label,'Revised command');
    fixture.rejectSave = false; await page.locator('#saveButton').click(); await page.waitForTimeout(70);
    assert.equal(fixture.pid.items.at(-1).label,'Revised command');
    await page.locator('#addTagButton').click(); await page.locator('#tagSearch').fill('Status.Ready');
    const target = await page.locator('#process').boundingBox();
    const sourceBox=await page.locator('.catalog-row').first().boundingBox();
    await drag(page,{x:sourceBox.x+30,y:sourceBox.y+sourceBox.height/2},{x:target.x+target.width*.8,y:target.y+target.height*.2},20);
    await page.waitForTimeout(60); assert.equal(await page.locator('.tag').count(),4);
    await page.locator('#settingsButton').click();
    await page.locator('#ps-title').fill('Revised process'); await page.locator('#ps-precision').fill('3');
    await page.locator('#ps-save-page').click(); await page.waitForTimeout(70);
    assert.equal(fixture.pid.title, 'Revised process'); assert.equal(fixture.pid.display.realPrecision, 3);
    await page.locator('#ps-close').click();
    await page.screenshot({ path: '/tmp/plc-debug-preview/pid-editor.png' });
    assert.deepEqual(fixture.errors, []);
    await page.close();
    const hmi = await setup(browser, 'panel');
    await hmi.page.locator('.tag-row').first().waitFor();
    assert.equal(await hmi.page.locator('[data-panel-section="signals"]').first().isVisible(), false);
    assert.equal(await hmi.page.locator('#hmiList button').count(), 1); // Read-only BOOL never becomes a command.
    await hmi.page.locator('#hmiList button').click(); await hmi.page.waitForTimeout(120);
    assert.deepEqual(hmi.fixture.writes.at(-1), ['Cmd.Run', '1']);
    await hmi.page.locator('#editButton').click();
    const writesBefore = hmi.fixture.writes.length;
    await hmi.page.locator('#hmiList .tag-row').first().click();
    assert.equal(hmi.fixture.writes.length, writesBefore);
    await hmi.page.locator('#settingsButton').click();
    await hmi.page.locator('#ps-title').fill('Revised HMI'); await hmi.page.locator('#ps-save-page').click(); await hmi.page.waitForTimeout(70);
    assert.equal(hmi.fixture.panel.title, 'Revised HMI');
    await hmi.page.locator('#ps-close').click(); await hmi.page.locator('#closeEditor').click();
    await hmi.page.screenshot({ path: '/tmp/plc-debug-preview/hmi.png' });
    assert.deepEqual(hmi.fixture.errors, []);
    await hmi.page.close();
    const hosted = await setup(browser, 'panel');
    await hosted.page.goto('http://plc.test/host');
    const view=hosted.page.frameLocator('#view');
    await view.locator('#settingsButton').click();
    await view.locator('#ps-project-fields').waitFor({state:'visible'});
    assert.equal(await view.locator('#ps-name').inputValue(),'Fixture project');
    await view.locator('#ps-interval').fill('30'); await view.locator('#ps-save-project').click();
    await view.locator('#ps-project-result').getByText('Project saved.',{exact:false}).waitFor();
    const request=await hosted.page.evaluate(()=>window.hostRequests.find(r=>r.action==='save-project-settings'));
    assert.equal(request.values.interval,30); assert.equal(request.values.program,'Main');
    await view.locator('#ps-close').click(); await view.locator('#pidButton').click();
    await hosted.page.waitForFunction(()=>window.hostRequests.some(r=>r.action==='navigate'&&r.values.view==='pid'));
    assert.deepEqual(hosted.fixture.errors,[]); await hosted.page.close();
    console.log('Panel browser checks passed: legacy layouts, drawing tools, undo/redo, tag catalog/access, save/settings, toggle, momentary ordering, HMI editing and navigation.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
