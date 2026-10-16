// i18n: language selection, fallback and dictionary coverage, without VS Code.
//   node tests/test_i18n.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const i18n = require('../i18n');
const root = path.resolve(__dirname, '..');

function withFakeVscode(setting, displayLanguage, fn) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return { env: { language: displayLanguage }, workspace: { getConfiguration: () => ({ get: key => key === 'language' ? setting : undefined }) } };
    return original.call(this, request, ...rest);
  };
  try { return fn(); } finally { Module._load = original; }
}

test('default language is English (no VS Code, auto setting, English display)', () => {
  i18n.setLanguageResolver(undefined);
  assert.equal(i18n.language(), 'en');
  assert.equal(withFakeVscode('auto', 'en-us', () => i18n.language()), 'en');
  assert.equal(withFakeVscode(undefined, 'de', () => i18n.language()), 'en');
});

test('pt-BR when hplc.language is pt-BR or the display language is Portuguese', () => {
  i18n.setLanguageResolver(undefined);
  assert.equal(withFakeVscode('pt-BR', 'en', () => i18n.language()), 'pt-BR');
  assert.equal(withFakeVscode('auto', 'pt-br', () => i18n.language()), 'pt-BR');
  assert.equal(withFakeVscode(undefined, 'pt', () => i18n.language()), 'pt-BR');
  assert.equal(withFakeVscode('en', 'pt-br', () => i18n.language()), 'en');
  assert.equal(i18n.resolveLanguage('auto', 'PT-PT'), 'pt-BR');
  assert.equal(i18n.resolveLanguage('auto', 'en'), 'en');
});

test('translation, placeholders and fallback to English', () => {
  const { dictionaries } = i18n;
  dictionaries.en['test.onlyEnglish'] = 'Only {what}';
  dictionaries.en['test.both'] = 'Hello {name}';
  dictionaries['pt-BR']['test.both'] = 'Olá {name}';
  try {
    i18n.setLanguageResolver(() => 'pt-BR');
    assert.equal(i18n.t('test.both', { name: 'Ana' }), 'Olá Ana');
    assert.equal(i18n.t('test.onlyEnglish', { what: 'English' }), 'Only English');
    assert.equal(i18n.t('test.missingEverywhere'), 'test.missingEverywhere');
    assert.deepEqual(i18n.languageEnv(), { HPLC_LANG: 'pt-BR' });
    i18n.setLanguageResolver(() => 'en');
    assert.equal(i18n.t('test.both', { name: 'Ana' }), 'Hello Ana');
    assert.equal(i18n.t('test.both'), 'Hello {name}');
    assert.deepEqual(i18n.languageEnv(), { HPLC_LANG: 'en' });
    const script = i18n.webviewTranslator('test.');
    const context = {}; require('node:vm').runInNewContext(script + ';result=tr("test.both",{name:"<b>"});', context);
    assert.equal(context.result, 'Hello <b>');
    assert.ok(!script.includes('<'));
  } finally {
    delete dictionaries.en['test.onlyEnglish']; delete dictionaries.en['test.both']; delete dictionaries['pt-BR']['test.both'];
    i18n.setLanguageResolver(undefined);
  }
});

test('every key used in the extension JavaScript exists in the English dictionary', () => {
  const files = ['extension.js', 'live-code.js', 'live-code-client.js', 'live-code-model.js', 'workbench-build.js',
    'workbench-run.js', 'agent-control.js', 'agent-control-extension/extension.js', 'scripts/plc-control.js'];
  const en = i18n.dictionaries.en, pt = i18n.dictionaries['pt-BR'];
  const used = new Set(), missing = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\b(?:t|tr)\(\s*'([^']+)'/g)) {
      used.add(match[1]);
      if (!(match[1] in en)) missing.push(`${file}: ${match[1]}`);
    }
    for (const match of source.matchAll(/webviewTranslator\(\s*'([^']+)'/g)) {
      if (!Object.keys(en).some(key => key.startsWith(match[1]))) missing.push(`${file}: prefix ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(used.size > 100, `only ${used.size} keys found`);
  // pt-BR is complete and keeps the same placeholders.
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  for (const [key, text] of Object.entries(en)) {
    assert.ok(key in pt, `pt-BR missing ${key}`);
    assert.equal(placeholders(pt[key]), placeholders(text), `placeholders differ in ${key}`);
  }
});
