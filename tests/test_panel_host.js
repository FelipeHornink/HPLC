const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { prepareRunScript } = require('../workbench-run');
const root = path.resolve(__dirname, '..');
function load() {
  const context = { module: { exports: {} }, process, URL,
    require: name => name === 'vscode' ? {} : name.startsWith('./') ? require(path.join(root, name)) : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8') + '\nmodule.exports = {projectSettingsSnapshot,saveProjectSettings,panelConfigFile,scenarioFile};', context);
  return context.module.exports;
}
function project(folder) {
  fs.mkdirSync(path.join(folder, 'programs'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'programs/Main.st'), 'PROGRAM Main\nEND_PROGRAM');
  fs.writeFileSync(path.join(folder, 'plc.toml'), '# preserve\nname = "Fixture"\npanel_port = 8100\npid_port = 8101\n\n[[task]]\nname = "MainTask"\ninterval_ms = 10\nprogram = "Main"\n');
}
test('page settings validate and save only the associated project without restarting it', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-settings-'));
  try {
    const a = path.join(temp, 'a'), b = path.join(temp, 'b'); project(a); project(b);
    const other = fs.readFileSync(path.join(b, 'plc.toml'), 'utf8');
    const api = load(); const values = { name: 'New name', task: 'Cycle', program: 'Main', interval: 20, panelPort: 8200, pidPort: 8201 };
    for (const invalid of [{ ...values, interval: 0 }, { ...values, program: 'Missing' }, { ...values, pidPort: 8200 }]) assert.throws(() => api.saveProjectSettings(a, invalid));
    const data = api.saveProjectSettings(a, values);
    assert.equal(data.interval, 20); assert.equal(data.panelPort, 8200);
    assert.match(fs.readFileSync(path.join(a, 'plc.toml'), 'utf8'), /# preserve/);
    assert.equal(fs.readFileSync(path.join(b, 'plc.toml'), 'utf8'), other);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('new pages are generated without replacing project HTML, configuration, assets or runtime', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-run-ui-'));
  try {
    for (const directory of ['runtime', 'panel/assets']) fs.mkdirSync(path.join(temp, directory), { recursive: true });
    const run = fs.readFileSync(path.join(root, 'template/plc-project/runtime/run.sh'), 'utf8');
    fs.writeFileSync(path.join(temp, 'runtime/run.sh'), run);
    fs.writeFileSync(path.join(temp, 'panel/index.html'), 'custom project HTML');
    fs.writeFileSync(path.join(temp, 'panel/pid.json'), '{"custom":"keep"}');
    const driver = prepareRunScript(temp, root);
    assert.match(fs.readFileSync(driver, 'utf8'), /--html "\$ROOT\/\.plcsim\/views\/index.html"/);
    assert.match(fs.readFileSync(driver, 'utf8'), /--panel-dir "\$ROOT\/panel"/);
    assert.match(fs.readFileSync(path.join(temp, '.plcsim/views/pid.html'), 'utf8'), /id="tagPicker"/);
    assert.equal(fs.readFileSync(path.join(temp, 'panel/index.html'), 'utf8'), 'custom project HTML');
    assert.equal(fs.readFileSync(path.join(temp, 'panel/pid.json'), 'utf8'), '{"custom":"keep"}');
    assert.equal(fs.readFileSync(path.join(temp, 'runtime/run.sh'), 'utf8'), run);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('project files: new names first, legacy Portuguese names as fallback', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-names-'));
  try {
    const api = load();
    assert.equal(api.panelConfigFile(temp), path.join(temp, 'panel', 'panel.json'));
    assert.equal(api.scenarioFile(temp), path.join(temp, 'tests', 'scenarios.yaml'));
    fs.mkdirSync(path.join(temp, 'panel')); fs.mkdirSync(path.join(temp, 'tests'));
    fs.writeFileSync(path.join(temp, 'panel', 'painel.json'), '{}');
    fs.writeFileSync(path.join(temp, 'tests', 'cenarios.yaml'), 'scenarios: []\n');
    assert.equal(api.panelConfigFile(temp), path.join(temp, 'panel', 'painel.json'));
    assert.equal(api.scenarioFile(temp), path.join(temp, 'tests', 'cenarios.yaml'));
    fs.writeFileSync(path.join(temp, 'panel', 'panel.json'), '{}');
    fs.writeFileSync(path.join(temp, 'tests', 'scenarios.yaml'), 'scenarios: []\n');
    assert.equal(api.panelConfigFile(temp), path.join(temp, 'panel', 'panel.json'));
    assert.equal(api.scenarioFile(temp), path.join(temp, 'tests', 'scenarios.yaml'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
