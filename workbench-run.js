const fs = require('fs');
const path = require('path');
const { language } = require('./i18n');
function writeIfChanged(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text); }
// UI updates live in generated files. Project HTML, JSON and assets are retained.
// ports: effective ports chosen by the extension. They are written into the page
// so the HMI <-> P&ID buttons do not assume HMI+1 (the runtime of older projects
// does not answer /api/views). lang: UI language for the pages (window.hplcLang).
function prepareRunScript(project, extensionPath, ports, lang = language()) {
  const original = path.join(project, 'runtime/run.sh');
  let source = fs.readFileSync(original, 'utf8');
  if (!source.includes('--html "$ROOT/panel/index.html"') || !source.includes('--pid-html "$ROOT/panel/pid.html"')) return original;
  const folder = path.join(project, '.plcsim/views');
  const views = ports?.panel && ports?.pid
    ? `window.hplcViews=${JSON.stringify({ panel: Number(ports.panel), pid: Number(ports.pid) })};` : '';
  const head = `<script>${views}window.hplcLang=${JSON.stringify(lang === 'pt-BR' ? 'pt-BR' : 'en')}</script>`;
  for (const name of ['index.html', 'pid.html']) {
    const html = fs.readFileSync(path.join(extensionPath, 'template/plc-project/panel', name), 'utf8');
    writeIfChanged(path.join(folder, name), html.replace(/<head>/i, `<head>${head}`));
  }
  source = source.replace(/^ROOT=.*$/m, 'ROOT="$HPLC_PROJECT_ROOT"\nif command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -u "$ROOT")"; fi');
  source = source.replace('--html "$ROOT/panel/index.html"', '--html "$ROOT/.plcsim/views/index.html"').replace('--pid-html "$ROOT/panel/pid.html"', '--pid-html "$ROOT/.plcsim/views/pid.html"');
  const driver = path.join(project, '.plcsim/workbench-run.sh'); writeIfChanged(driver, source); return driver;
}
module.exports = { prepareRunScript };
