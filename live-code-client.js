/* Runs in the VS Code webview. Source and telemetry are separate: selecting a
   routine never changes the PLC or an editor's cursor. Strings come from
   tr()/L injected by live-code.js (falls back to the key when missing). */
(() => {
  const tr = window.hplcTr || (key => key);
  const vscode = acquireVsCodeApi();
  const model = window.plcModel;
  const instrumented = new Set(model.points);
  const saved = vscode.getState() || {};
  const tree = document.getElementById('tree');
  const code = document.getElementById('code');
  const status = document.getElementById('status');
  const follow = document.getElementById('follow');
  const filter = document.getElementById('filter');
  const vars = document.getElementById('variables');
  const nodes = [], rows = new Map();
  let selected = model.files[saved.selected] ? saved.selected : model.main;
  let following = saved.following !== false;
  let folds = new Set(saved.folds || []);
  let state, busy = false, positioned = '', painted = [], currentRow;
  follow.checked = following;
  function persist() { vscode.setState({ selected, following, folds: [...folds] }); }
  function setFollowing(value) { following = value; follow.checked = value; persist(); }
  function keyword(text) {
    const fragment = document.createDocumentFragment();
    const tokens = /(\(\*.*?\*\)|\/\/.*$|'(?:''|[^'])*'|\b(?:PROGRAM|END_PROGRAM|FUNCTION_BLOCK|END_FUNCTION_BLOCK|FUNCTION|END_FUNCTION|VAR(?:_\w+)?|END_VAR|IF|THEN|ELSE|ELSIF|END_IF|CASE|OF|END_CASE|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|RETURN|BOOL|INT|REAL|TIME|TRUE|FALSE|AND|OR|NOT)\b)/gi;
    let end = 0;
    for (const match of text.matchAll(tokens)) {
      fragment.append(document.createTextNode(text.slice(end, match.index)));
      const token = document.createElement('span');
      token.className = match[0].startsWith('(*') || match[0].startsWith('//') ? 'comment' : match[0].startsWith("'") ? 'string' : 'keyword';
      token.textContent = match[0]; fragment.append(token); end = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(end))); return fragment;
  }
  function addBranch(node, parent, ancestors = []) {
    const wrapper = document.createElement('div'); wrapper.className = 'branch';
    const row = document.createElement('div'); row.className = 'routine'; row.setAttribute('role', 'treeitem'); row.setAttribute('tabindex', '0');
    row.dataset.file = node.file; row.title = (node.instance ? node.instance + ' → ' : '') + node.file + (node.recursive ? ' · ' + tr('liveCode.recursiveCall') : '');
    const caret = document.createElement('button'); caret.className = 'caret'; caret.setAttribute('aria-label', tr('liveCode.expandCollapse', { name: node.label }));
    const label = document.createElement('span'); label.className = 'routine-name'; label.textContent = node.label + (node.recursive ? ' ↻' : '');
    const indicator = document.createElement('span'); indicator.className = 'indicator';
    row.append(caret, label, indicator);
    const children = document.createElement('div'); children.className = 'children'; children.setAttribute('role', 'group'); row.setAttribute('aria-level', String(ancestors.length + 1));
    wrapper.append(row, children); parent.append(wrapper);
    const item = { node, wrapper, row, caret, indicator, children, ancestors }; nodes.push(item);
    function fold() {
      children.hidden = folds.has(node.id); caret.textContent = node.children.length ? children.hidden ? '›' : '⌄' : '·';
      caret.disabled = !node.children.length;
      if (node.children.length) row.setAttribute('aria-expanded', String(!children.hidden));
    }
    caret.onclick = event => { event.stopPropagation(); if (folds.has(node.id)) folds.delete(node.id); else folds.add(node.id); fold(); persist(); };
    row.onclick = () => { setFollowing(false); select(node.file); };
    row.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
      else if ((event.key === 'ArrowRight' && children.hidden) || (event.key === 'ArrowLeft' && !children.hidden)) { event.preventDefault(); caret.click(); }
    };
    for (const child of node.children) addBranch(child, children, [...ancestors, item]);
    fold();
  }
  for (const node of model.tree) addBranch(node, tree);
  if (model.others.length) {
    const other = document.createElement('details'); const label = document.createElement('summary');
    label.textContent = tr('liveCode.otherPous', { count: model.others.length }); other.append(label); tree.append(other);
    for (const node of model.others) addBranch(node, other);
  }
  function select(file) {
    if (!model.files[file]) return;
    if (selected !== file || !rows.size) {
      selected = file; positioned = ''; painted = []; currentRow = undefined; rows.clear(); code.replaceChildren();
      const unit = model.files[file];
      document.getElementById('routine-name').textContent = unit.name;
      document.getElementById('source-file').textContent = file;
      document.getElementById('line-count').textContent = tr('liveCode.lineCount', { count: unit.rows.length });
      for (const source of unit.rows) {
        const row = document.createElement('div'); row.className = 'line'; row.dataset.line = source.line;
        const number = document.createElement('span'); number.className = 'number'; number.textContent = source.line;
        const text = document.createElement('code'); text.append(keyword(source.text || ' '));
        const values = document.createElement('span'); values.className = 'line-values';
        if (!source.projectLines.some(id => instrumented.has(id))) row.classList.add('no-point');
        row.append(number, text, values); code.append(row); rows.set(source.line, { row, values, text: source.text });
      }
      persist();
    }
    for (const item of nodes) { item.row.classList.toggle('selected', item.node.file === selected); item.row.setAttribute('aria-selected', String(item.node.file === selected)); }
    paint();
  }
  function paintVariables() {
    const unit = model.files[selected];
    if (!unit) return;
    // Only expose unambiguous runtime aliases; never invent local/FB values.
    const aliases = new Map(), ambiguous = new Set();
    for (const variable of state?.variables || []) {
      const parts = variable.path.split('.');
      for (const alias of new Set([variable.path, parts.slice(1).join('.'), parts.slice(-2).join('.'), parts.at(-1)])) {
        if (!alias) continue;
        const key = alias.toUpperCase();
        if (aliases.has(key) && aliases.get(key).path !== variable.path) ambiguous.add(key);
        else aliases.set(key, variable);
      }
    }
    for (const alias of ambiguous) aliases.delete(alias);
    const visible = new Map();
    for (const source of rows.values()) {
      const found = new Map();
      const text = source.text.replace(/\(\*.*?\*\)|\/\/.*$|'(?:''|[^'])*'/g, ' ');
      for (const match of text.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)) {
        const variable = aliases.get(match[0].toUpperCase());
        if (variable) { found.set(variable.path, variable); visible.set(variable.path, variable); }
      }
      source.values.textContent = [...found.values()].slice(0, 3).map(v => v.path.split('.').at(-1) + '=' + format(v)).join('  ');
      source.values.title = [...found.values()].map(v => v.path + ' = ' + format(v) + ' (' + v.type + ')').join('\n');
    }
    vars.replaceChildren();
    if (!visible.size) { vars.textContent = state?.variableError || tr('liveCode.noVariables'); return; }
    for (const variable of visible.values()) {
      const row = document.createElement('div'); row.className = 'variable';
      const name = document.createElement('span'); name.textContent = variable.path; name.title = variable.type;
      const value = document.createElement('strong'); value.textContent = format(variable); row.append(name, value); vars.append(row);
    }
  }
  function format(variable) { return variable.type === 'BOOL' ? variable.value ? 'TRUE' : 'FALSE' : String(variable.value); }
  function buttons() {
    for (const button of document.querySelectorAll('[data-action]')) button.disabled = busy || !state?.running;
    document.getElementById('stop').disabled = busy || !state?.running;
  }
  function paint() {
    for (const source of painted) source.row.classList.remove('executed'); painted = [];
    if (currentRow) currentRow.row.classList.remove('current', 'sampled'); currentRow = undefined;
    const execution = state?.execution || { executed: {}, current: null };
    const current = state?.running ? execution.current : null;
    for (const item of nodes) {
      const active = current?.file === item.node.file;
      const executed = Boolean(state?.running && execution.executed[item.node.file]?.length);
      item.row.classList.toggle('active', active); item.row.classList.toggle('executed-routine', executed && !active);
      item.indicator.textContent = active ? current.paused ? 'Ⅱ' : '●' : executed ? '✓' : '';
      item.indicator.title = active ? current.paused ? tr('liveCode.pausedHere') : tr('liveCode.lastObserved') : executed ? tr('liveCode.executedInScan') : '';
    }
    if (state?.running) for (const line of execution.executed[selected] || []) { const source = rows.get(line); if (source) { source.row.classList.add('executed'); painted.push(source); } }
    if (current?.file === selected) {
      currentRow = rows.get(current.line);
      if (currentRow) {
        currentRow.row.classList.add(current.paused ? 'current' : 'sampled');
        const key = selected + ':' + current.line;
        if (following && positioned !== key) { currentRow.row.scrollIntoView({ block: 'center' }); positioned = key; }
      }
    }
    paintVariables(); buttons();
  }
  follow.onchange = () => { setFollowing(follow.checked); positioned = ''; applyFollowing(); paint(); };
  function applyFollowing() {
    const current = state?.execution?.current;
    if (!following || !state?.running || !current) return;
    const item = nodes.find(item => item.node.file === current.file);
    if (item) for (const ancestor of item.ancestors) { folds.delete(ancestor.node.id); ancestor.children.hidden = false; ancestor.caret.textContent = '⌄'; ancestor.row.setAttribute('aria-expanded', 'true'); }
    if (selected !== current.file) select(current.file);
  }
  filter.oninput = () => {
    const query = filter.value.toLowerCase();
    if (query) setFollowing(false);
    for (const item of [...nodes].reverse()) {
      const matches = (item.node.label + ' ' + item.node.file).toLowerCase().includes(query);
      const childVisible = [...item.children.children].some(child => !child.hidden);
      item.wrapper.hidden = !matches && !childVisible;
      if (query && childVisible) item.children.hidden = false;
      else if (!query) item.children.hidden = folds.has(item.node.id);
    }
  };
  document.getElementById('edit').onclick = () => vscode.postMessage({ type: 'source', file: selected, line: state?.execution?.current?.file === selected ? state.execution.current.line : 1 });
  document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });
  for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => vscode.postMessage({ type: 'control', action: button.dataset.action });
  window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'error') { state = { running: false, execution: { executed: {}, current: null }, variables: [] }; paint(); status.textContent = tr('liveCode.noCommunication', { message: message.message }); return; }
    if (message.type === 'busy') { busy = message.value; buttons(); return; }
    if (message.type !== 'state') return;
    state = message;
    const debug = state.debug;
    const mode = { run: tr('liveCode.modeRun'), paused: tr('liveCode.modePaused'), line: tr('liveCode.modeLine'), routine: tr('liveCode.modeRoutine') };
    const current = state.execution.current;
    status.textContent = state.running ? (mode[debug.mode] || debug.mode) + ' · scan ' + debug.scan + (current ? ' · ' + current.file + ':' + current.line : '') : tr('liveCode.plcStopped');
    document.getElementById('telemetry').textContent = !state.running ? tr('liveCode.lastBuild') : !model.points.length ? tr('liveCode.noPoints') : current?.paused ? tr('liveCode.nextInstruction') : tr('liveCode.runtimeSample');
    applyFollowing(); paint();
  });
  select(selected); buttons();
})();
