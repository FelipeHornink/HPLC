const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { html, createLiveCode } = require('../live-code');
const { buildModel, executionState } = require('../live-code-model');
const { prepareBuildScript } = require('../workbench-build');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-live-test-'));
  fs.mkdirSync(path.join(root, '.plcsim/build'), { recursive: true });
  fs.writeFileSync(path.join(root, '.plcsim/build/project.st'), 'PROGRAM Main\nCounter := Counter + 1;\n(* <script> *)\nEND_PROGRAM');
  fs.writeFileSync(path.join(root, '.plcsim/build/source_map.json'), JSON.stringify({ lines: { '2': { file: 'programs/Main.st', line: 2, kind: 'programs' } } }));
  return root;
}

test('sidebar contributes exactly one explorer; ST is not a second view', () => {
  const manifest = require('../package.json');
  assert.deepEqual(manifest.contributes.views.hplc.map(v => v.id), ['hplc.projects']);
});

test('code snapshot is safe in HTML and maps executed/paused lines back to their routine', () => {
  const root = project();
  try {
    const model = buildModel(root);
    assert.equal(model.main, 'programs/Main.st');
    const markup = html(root, model);
    assert.ok(!markup.includes('(* <script> *)'));
    const script = [...markup.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
    const context = { window: {} }; vm.runInNewContext(script, context);
    assert.equal(context.window.plcModel.files['programs/Main.st'].rows[0].text, 'Counter := Counter + 1;');
    const state = executionState(model, { trace: [2], waiting_line: true, current_line: 2 });
    assert.deepEqual(state.executed, { 'programs/Main.st': [2] });
    assert.deepEqual(state.current, { file: 'programs/Main.st', line: 2, paused: true });
    assert.equal(executionState(model, { trace: [2] }).current.paused, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live code reuses its panel and controls the correct project', async () => {
  const root = project(), calls = []; let message, dispose;
  const panel = { visible: true, webview: { onDidReceiveMessage: fn => { message = fn; }, postMessage: () => {} },
    onDidDispose: fn => { dispose = fn; }, onDidChangeViewState: () => {}, reveal: () => {}, dispose: () => dispose() };
  const live = createLiveCode({ ViewColumn: { Two: 2 }, window: { createWebviewPanel: () => panel, showErrorMessage: text => { throw Error(text); } } }, {
    name: () => 'Test', running: () => false,
    control: async (...args) => calls.push(args), source: () => {}, stop: () => {}
  });
  try {
    assert.equal(live.open(root), panel);
    assert.equal(live.open(root), panel);
    await message({ type: 'control', action: 'step_line' });
    assert.deepEqual(calls, [[root, 'step_line']]);
    await message({ type: 'control', action: 'shell' });
    assert.equal(calls.length, 1);
  } finally { live.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('instrumented build preserves original runtime and caches unchanged generated driver', () => {
  const root = project();
  try {
    fs.mkdirSync(path.join(root, 'runtime'));
    fs.copyFileSync(path.join(__dirname, '../template/plc-project/runtime/main.cpp'), path.join(root, 'runtime/main.cpp'));
    const source = fs.readFileSync(path.join(__dirname, '../template/plc-project/runtime/build.sh'), 'utf8');
    fs.writeFileSync(path.join(root, 'runtime/build.sh'), source);
    const driver = prepareBuildScript(root);
    assert.equal(fs.readFileSync(path.join(root, 'runtime/build.sh'), 'utf8'), source);
    assert.match(fs.readFileSync(driver, 'utf8'), /--line-directives/);
    assert.match(fs.readFileSync(driver, 'utf8'), /HPLC_INSTRUMENT_SCRIPT/);
    const stat = fs.statSync(driver).mtimeMs;
    prepareBuildScript(root);
    assert.equal(fs.statSync(driver).mtimeMs, stat);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project viewer opens only equipment and live code without creating an AI terminal', async () => {
  // HMI on top and live code below by default, reapplied on every Play;
  // with more than two groups the arrangement belongs to the user.
  // 'embaixo' / 'lado a lado': legacy values of hplc.layoutSimulacao.
  for (const [groupCount, setting, orientation] of [[1, undefined, 1], [2, 'below', 1], [1, 'sideBySide', 0], [2, 'embaixo', 1], [1, 'lado a lado', 0], [3, undefined, null]]) {
    const calls = [];
    const mock = {
      window: { tabGroups: { all: Array.from({ length: groupCount }, () => ({})) } },
      workspace: { getConfiguration: () => ({ get: () => setting }) },
      commands: { executeCommand: async (...args) => calls.push(args) }
    };
    const context = { module: { exports: {} }, process, URL, console,
      require: name => name === 'vscode' ? mock : name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name),
      setInterval, clearInterval, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8') + `
      openEquipment = async project => module.exports.calls.push(['equipment', project]);
      liveCode = { open: project => module.exports.calls.push(['live', project]) };
      module.exports.openSimulationViews = openSimulationViews;
    `, context);
    context.module.exports.calls = calls;
    await context.module.exports.openSimulationViews('/tmp/project');
    const layouts = calls.filter(c => c[0] === 'vscode.setEditorLayout');
    if (orientation === null) assert.equal(layouts.length, 0);
    else assert.deepEqual(layouts.map(c => c[1].orientation), [orientation]);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c => ['equipment', 'live'].includes(c[0])))), [['equipment', '/tmp/project'], ['live', '/tmp/project']]);
    assert.equal(calls.at(-1)[0], 'workbench.action.closePanel');
  }
});

test('Main tree resolves FB instances, nested inline routines and recursion without unrelated comments', () => {
  const root = project();
  try {
    const sources = {
      'programs/Main.st': 'PROGRAM Main\nVAR\n motor : Motor;\nEND_VAR\n(* ignoredComment(\n ignoredCall();\n*)\nmotor();\n(* @ROUTINE Step.st *)\nEND_PROGRAM',
      'blocks/Motor.st': 'FUNCTION_BLOCK Motor\nMain();\nEND_FUNCTION_BLOCK',
      'routines/Step.st': '(* @ROUTINE Sub.st *)\nCounter := Counter + 1;',
      'routines/Sub.st': 'Counter := 0;'
    };
    const map = {}; const compiled = [];
    for (const [file, text] of Object.entries(sources)) {
      const snapshot = path.join(root, '.plcsim/generated/src', file);
      fs.mkdirSync(path.dirname(snapshot), { recursive: true }); fs.writeFileSync(snapshot, text);
      for (const [i, line] of text.split('\n').entries()) {
        compiled.push(line); map[compiled.length] = { file, line: i + 1, kind: file.split('/')[0] };
      }
    }
    fs.writeFileSync(path.join(root, '.plcsim/build/project.st'), compiled.join('\n'));
    fs.writeFileSync(path.join(root, '.plcsim/build/source_map.json'), JSON.stringify({ lines: map }));
    const model = buildModel(root);
    assert.equal(model.tree[0].label, 'Main');
    assert.deepEqual(model.tree[0].children.map(c => c.file), ['blocks/Motor.st', 'routines/Step.st']);
    assert.equal(model.tree[0].children[0].children[0].recursive, true);
    assert.equal(model.tree[0].children[1].children[0].file, 'routines/Sub.st');
    assert.deepEqual(model.others, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('View PLC button is attached to each running project', () => {
  const manifest = require('../package.json');
  const button = manifest.contributes.menus['view/item/context'].find(m => m.command === 'hplc.viewProject');
  assert.equal(button.group, 'inline@1');
  assert.match(button.when, /plcProjectRunning/);
  assert.ok(!fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8').includes('createTerminal('));
});

test('each PLC viewer keeps its own panel, source selection and control target', async () => {
  const first = project(), second = project(), calls = [], panels = [];
  const live = createLiveCode({ ViewColumn: { Two: 2 }, window: {
    createWebviewPanel: () => {
      const panel = { visible: false, webview: { onDidReceiveMessage: fn => panel.message = fn, postMessage: () => {} },
        onDidDispose: fn => panel.cleanup = fn, onDidChangeViewState: () => {}, reveal: () => {}, dispose: () => panel.cleanup() };
      panels.push(panel); return panel;
    }, showErrorMessage: text => { throw Error(text); }
  } }, { name: () => 'PLC', running: () => false, control: async (...args) => calls.push(args), stop: () => {}, source: () => {} });
  try {
    const a = live.open(first), b = live.open(second);
    assert.notEqual(a, b);
    a.webview.html = 'preserved user navigation';
    assert.equal(live.open(first), a);
    assert.equal(a.webview.html, 'preserved user navigation');
    await a.message({ type: 'control', action: 'pause' });
    await b.message({ type: 'control', action: 'step_routine' });
    assert.deepEqual(calls, [[first, 'pause'], [second, 'step_routine']]);
  } finally { live.dispose(); for (const root of [first, second]) fs.rmSync(root, { recursive: true, force: true }); }
});
