// The starter project shipped with the extension must stay consistent: every tag the
// screens use is declared in the ST sources, and "New project" copies it.
//   node tests/test_starter_project.js
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const starter = path.join(root, 'template', 'starter-project');

function declaredNames() {
  const names = new Set();
  for (const folder of ['globals', 'programs']) {
    for (const file of fs.readdirSync(path.join(starter, folder))) {
      const text = fs.readFileSync(path.join(starter, folder, file), 'utf8').replace(/\(\*[\s\S]*?\*\)/g, '');
      for (const match of text.matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) names.add(match[1]);
    }
  }
  return names;
}

test('every tag on the HMI, P&ID and I/O map is declared in the sources', () => {
  const declared = declaredNames();
  const panel = JSON.parse(fs.readFileSync(path.join(starter, 'panel/panel.json'), 'utf8'));
  const pid = JSON.parse(fs.readFileSync(path.join(starter, 'panel/pid.json'), 'utf8'));
  const io = fs.readFileSync(path.join(starter, 'io.toml'), 'utf8');
  const tags = [
    ...Object.values(panel.areas).flat().map(item => item.tag),
    ...pid.items.map(item => item.tag), ...pid.shapes.filter(shape => shape.tag).map(shape => shape.tag),
    ...[...io.matchAll(/^name="([^"]+)"/gm)].map(match => match[1])
  ];
  assert.ok(tags.length > 10);
  for (const tag of tags) assert.ok(declared.has(tag.split('.')[0]), `tag not declared: ${tag}`);
});

test('the starter has the files a project needs and Main pulls in every routine', () => {
  for (const file of ['plc.toml', 'io.toml', 'programs/Main.st', 'panel/panel.json', 'panel/pid.json', 'tests/scenarios.yaml'])
    assert.ok(fs.existsSync(path.join(starter, file)), file);
  const main = fs.readFileSync(path.join(starter, 'programs/Main.st'), 'utf8');
  for (const routine of fs.readdirSync(path.join(starter, 'routines')))
    assert.match(main, new RegExp(`@ROUTINE ${routine.replace('.', '\\.')}`));
});

test('"New project" offers the starter and copies it over the skeleton', () => {
  const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(extension, /value: 'starter'[\s\S]*value: 'empty'/);
  assert.match(extension, /'template', 'starter-project'/);
  assert.match(extension, /treeAction\(t\('tree\.newProject'\)/);
});

test('live code takes the POU name from the declaration, not from a comment', () => {
  const { pouHeader } = require('../live-code-model');
  const main = fs.readFileSync(path.join(starter, 'programs/Main.st'), 'utf8');
  assert.equal(pouHeader(main)[2], 'Main');
  assert.equal(pouHeader('// the program reads data\nFUNCTION_BLOCK FB_X\nEND_FUNCTION_BLOCK')[2], 'FB_X');
});
