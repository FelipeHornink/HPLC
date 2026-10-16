// Checks the PLC Codex -> HPLC rename (and the English contract) without opening VS Code.
//   node tests/test_rename_hplc.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
const nlsPt = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.pt-br.json'), 'utf8'));
const control = JSON.parse(fs.readFileSync(path.join(root, 'agent-control-extension', 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'extension.vsixmanifest'), 'utf8');

assert.equal(`${pkg.publisher}.${pkg.name}`, 'FelipeHornink.hplc');
assert.equal(pkg.displayName, 'HPLC');
assert.match(manifest, new RegExp(`Id="hplc" Version="${pkg.version}" Publisher="FelipeHornink"`));

const commands = pkg.contributes.commands.map(c => c.command);
assert.ok(commands.length > 30);
assert.deepEqual(commands.filter(c => !c.startsWith('hplc.')), [], 'every contributed command uses hplc.');
for (const command of commands) {
  const legacy = command.replace(/^hplc\./, 'plcCodex.');
  assert.ok(pkg.activationEvents.includes(`onCommand:${legacy}`), `alias ${legacy} must activate the extension`);
}
assert.doesNotMatch(JSON.stringify(pkg.contributes), /plcCodex|PLC Codex/);

// Every %key% of package.json exists in English and Portuguese.
const placeholders = [...JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)].map(m => m[1]);
assert.ok(placeholders.length > 40);
for (const key of placeholders) {
  assert.ok(nls[key], `package.nls.json misses ${key}`);
  assert.ok(nlsPt[key], `package.nls.pt-br.json misses ${key}`);
}
assert.doesNotMatch(JSON.stringify(nls), /[ãõçáéíóúâêô]/, 'package.nls.json is English');
const settings = pkg.contributes.configuration.properties;
assert.deepEqual(settings['hplc.language'].enum, ['auto', 'en', 'pt-BR']);
assert.equal(settings['hplc.language'].default, 'auto');
assert.deepEqual(settings['hplc.simulationLayout'].enum, ['below', 'sideBySide']);
assert.equal(settings['hplc.simulationLayout'].default, 'below');
// Legacy setting has no default, otherwise it would always shadow the new one.
assert.equal(settings['hplc.layoutSimulacao']?.default, undefined);
console.log('ok: manifest and localisation');

// Every registration goes through the helper that creates the alias; only the helper calls the API.
assert.equal((extension.match(/vscode\.commands\.registerCommand\(/g) || []).length, 2);
assert.match(extension, /LEGACY_COMMAND_PREFIX = 'plcCodex\.'/);
assert.doesNotMatch(extension.replace(/\/\/.*$/gm, '').replace(/LEGACY_COMMAND_PREFIX = 'plcCodex\.'/, ''), /'plcCodex\./);

assert.equal(`${control.publisher}.${control.name}`, 'FelipeHornink.hplc-control');
assert.deepEqual(control.extensionDependencies, ['FelipeHornink.hplc']);
const bridge = fs.readFileSync(path.join(root, 'agent-control-extension', 'extension.js'), 'utf8');
assert.match(bridge, /getExtension\('FelipeHornink\.hplc'\)/);
assert.doesNotMatch(bridge, /plcCodex\.|plc-codex\.plc-codex/);
console.log('ok: rename HPLC');

// First actions of the view: add folder and import PLCopenXML.
const title = pkg.contributes.menus['view/title'].filter(m => m.when === 'view == hplc.projects').map(m => m.command);
assert.deepEqual(title.slice(0, 2), ['hplc.addProject', 'hplc.importXml']);
assert.match(extension, /treeAction\(t\('tree\.addProjectFolder'\)[\s\S]*treeAction\(t\('tree\.importXml'\)/);
assert.match(extension, /t\('importXml\.step1Title'\)[\s\S]*t\('importXml\.step2Title'\)/);
console.log('ok: initial actions');

// A project in the tree only has folders (explorer); actions are inline buttons,
// with Export before View HMI/P&ID.
const inline = pkg.contributes.menus['view/item/context']
  .filter(m => m.when.includes('viewItem == plcProjectRunning') && m.group?.startsWith('inline'))
  .sort((a, b) => a.group.localeCompare(b.group)).map(m => m.command);
assert.deepEqual(inline, ['hplc.exportXml', 'hplc.viewProject', 'hplc.togglePause', 'hplc.stop']);
assert.match(extension, /HPLC_EXPORT_DIR: exportDir/);
assert.match(extension, /value: 'full'[\s\S]*value: 'logic'[\s\S]*HPLC_EXPORT_MODE/);
assert.match(extension, /template', 'plc-project', 'runtime', 'export_plcopenxml\.py'/);
console.log('ok: per-project actions and export');

// Play writes the effective ports and the language into the served pages
// (HMI <-> P&ID without assuming +1).
{
  const os = require('os');
  const { prepareRunScript } = require('../workbench-run');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hplc-views-'));
  try {
    fs.mkdirSync(path.join(project, 'runtime'));
    fs.writeFileSync(path.join(project, 'runtime/run.sh'), 'ROOT=x\nplc --html "$ROOT/panel/index.html" --pid-html "$ROOT/panel/pid.html"\n');
    prepareRunScript(project, root, { panel: '8200', pid: '8205' }, 'pt-BR');
    for (const name of ['index.html', 'pid.html']) {
      const html = fs.readFileSync(path.join(project, '.plcsim/views', name), 'utf8');
      assert.match(html, /<head><script>window\.hplcViews=\{"panel":8200,"pid":8205\};window\.hplcLang="pt-BR"<\/script>/);
    }
    prepareRunScript(project, root, undefined, 'en');
    assert.match(fs.readFileSync(path.join(project, '.plcsim/views/index.html'), 'utf8'), /<head><script>window\.hplcLang="en"<\/script>/);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
  console.log('ok: effective ports and language in the pages');
}

// Packaging script.
{
  const script = fs.readFileSync(path.join(root, 'package.sh'), 'utf8');
  assert.match(script, /--build-only/);
  assert.match(script, /skip_top = \{"examples", "docs"\}/);
  assert.ok(!fs.existsSync(path.join(root, 'empacotar.sh')));
  console.log('ok: package.sh');
}
