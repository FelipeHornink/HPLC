// Build errors must point at the user's .st file, not at generated C++.
//   node tests/test_build_diagnostics.js
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseBuildOutput, explainCpp } = require('../build-diagnostics');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hplc-diag-'));
  fs.mkdirSync(path.join(root, 'blocks'));
  fs.mkdirSync(path.join(root, '.plcsim/build/out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'blocks/Alarms.st'), [
    'FUNCTION_BLOCK Alarms',                          // 1
    'VAR i : INT; Delay : TON; END_VAR',              // 2
    'Delay(IN := (Enable AND',                        // 3
    '      typo   (Value > Limit)),',                 // 4
    '      PT := T#1S);',                             // 5
    'Count := Count + 1;',                            // 6
    'END_FUNCTION_BLOCK'].join('\n'));
  fs.writeFileSync(path.join(root, '.plcsim/build/source_map.json'), JSON.stringify({ lines: {
    '100': { file: 'blocks/Alarms.st', line: 3 }, '103': { file: 'blocks/Alarms.st', line: 6 } } }));
  fs.writeFileSync(path.join(root, '.plcsim/build/out/project.cpp'), [
    'void ALARMS::operator()() {',                    // 1
    '    ::plc_debug_routine(1U, 100U);',             // 2
    '    ::plc_debug_point(100U);',                   // 3
    '    DELAY.IN = (ENABLE & (TYPO(VALUE > LIMIT)));', // 4
    '    ::plc_debug_point(103U);',                   // 5
    '    COUNT = COUNT + 1;',                         // 6
    '}'].join('\n'));
  return root;
}

test('g++ error in generated C++ is mapped to the ST line and column of the identifier', () => {
  const root = project();
  try {
    const text = `${root}/.plcsim/build/out/project.cpp:4:30: error: ‘TYPO’ was not declared in this scope\n`;
    const [d] = parseBuildOutput(root, text);
    assert.equal(d.file, 'blocks/Alarms.st');
    assert.equal(d.line, 4);
    assert.equal(d.column, 7);
    assert.equal(d.length, 4);
    assert.equal(d.severity, 'error');
    assert.equal(d.key, 'build.cpp.undeclared');
    assert.equal(d.params.name, 'typo');   // spelled as in the source, not upper-cased
    assert.ok(d.mapped);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ST compiler messages on project.st are mapped through the source map', () => {
  const root = project();
  try {
    const [w] = parseBuildOutput(root, 'project.st:103:5: warning: Implicit narrowing conversion from INT to USINT');
    assert.deepEqual([w.file, w.line, w.severity, w.compiler], ['blocks/Alarms.st', 6, 'warning', 'st']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unmappable C++ error is still reported, flagged as unmapped', () => {
  const root = project();
  try {
    const [d] = parseBuildOutput(root, `${root}/.plcsim/build/out/project.cpp:1:1: error: something odd`);
    assert.equal(d.mapped, false);
    assert.equal(d.severity, 'error');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('common g++ messages get friendly keys', () => {
  assert.equal(explainCpp("‘X’ was not declared in this scope").key, 'build.cpp.undeclared');
  assert.equal(explainCpp("‘struct S’ has no member named ‘Foo’").key, 'build.cpp.noMember');
  assert.equal(explainCpp("‘Y’ cannot be used as a function").key, 'build.cpp.notCallable');
  assert.equal(explainCpp('weird').key, 'build.cpp.other');
});

test('every message key the parser can return exists in English and pt-BR', () => {
  const { dictionaries } = require('../i18n');
  const keys = ['build.cpp.undeclared', 'build.cpp.noMember', 'build.cpp.notCallable', 'build.cpp.badOperands',
    'build.cpp.badConversion', 'build.cpp.other', 'build.cpp.detail', 'build.cpp.unmapped',
    'build.summaryHeader', 'build.summaryWarnings'];
  for (const lang of ['en', 'pt-BR']) for (const key of keys) assert.ok(dictionaries[lang][key], `${lang}: ${key}`);
});
