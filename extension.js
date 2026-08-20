const vscode = require('vscode');
const cp = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 6 });

const runtimes = new Map();
const startingProjects = new Set();
let output;
let activeProject;
let projectView;
let processView;
let variablesView;
let routinesView;
let debugView;
let runtimeControlView;
let liveDecoration;
let currentLineDecoration;
let executedLineDecoration;
let liveUpdateBusy = false;
let lastDebugState;
let extensionContext;
let diagnosticCollection;
let discoveredProjectCache;

function configuredProjectPort(project) {
  try {
    const manifest = fs.readFileSync(path.join(project, 'plc.toml'), 'utf8');
    const match = manifest.match(/^panel_port\s*=\s*(\d+)/m);
    return match ? Number(match[1]) : 8100;
  } catch (_) {
    return 8100;
  }
}

function configuredPidPort(project) {
  try {
    const manifest = fs.readFileSync(path.join(project, 'plc.toml'), 'utf8');
    const match = manifest.match(/^pid_port\s*=\s*(\d+)/m);
    return match ? Number(match[1]) : configuredProjectPort(project) + 1;
  } catch (_) {
    return configuredProjectPort(project) + 1;
  }
}

function projectPort(project) {
  try {
    const runtimePort = Number(fs.readFileSync(path.join(project, '.plcsim', 'runtime.port'), 'utf8').trim());
    if (Number.isInteger(runtimePort) && runtimePort > 0) return runtimePort;
  } catch (_) {}
  return configuredProjectPort(project);
}

function canonicalProject(project) {
  try { return fs.realpathSync(project); } catch (_) { return path.resolve(project); }
}

function projectManifest(project) {
  try {
    const text = fs.readFileSync(path.join(project, 'plc.toml'), 'utf8');
    const taskText = text.match(/\[\[task\]\]([\s\S]*?)(?=\n\[\[|$)/)?.[1] || '';
    return {
      name: text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || path.basename(project),
      task: taskText.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] || 'MainTask',
      program: taskText.match(/^\s*program\s*=\s*"([^"]+)"/m)?.[1] || 'Main',
      intervalMs: Number(taskText.match(/^\s*interval_ms\s*=\s*(\d+)/m)?.[1] || 10),
      text
    };
  } catch (_) { return { name: path.basename(project), task: 'MainTask', program: 'Main', intervalMs: 10, text: '' }; }
}

function projectUrl(project) {
  return `http://127.0.0.1:${projectPort(project)}`;
}

function projectPidPort(project) {
  try {
    const port = Number(fs.readFileSync(path.join(project, '.plcsim', 'runtime.pid-port'), 'utf8').trim());
    if (Number.isInteger(port) && port > 0) return port;
  } catch (_) {}
  return configuredPidPort(project);
}

function projectPidUrl(project) {
  return `http://127.0.0.1:${projectPidPort(project)}`;
}

function portIsAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availableProjectPorts(project) {
  const preferred = configuredProjectPort(project);
  const preferredPid = configuredPidPort(project);
  const offset = Math.max(1, preferredPid - preferred);
  const running = (await discoverProjects()).filter(item => item !== project && hasLivePid(item));
  const occupied = new Set(running.flatMap(item => [projectPort(item), projectPidPort(item)]));
  for (let port = preferred; port < preferred + 100; port++) {
    const pidPort = port + offset;
    if (!occupied.has(port) && !occupied.has(pidPort) && await portIsAvailable(port) && await portIsAvailable(pidPort)) return { panel: port, pid: pidPort };
  }
  throw new Error(`Nenhuma porta livre encontrada entre ${preferred} e ${preferred + 99}.`);
}

function projectPid(project) {
  try {
    const pid = Number(fs.readFileSync(path.join(project, '.plcsim', 'runtime.pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch (_) {
    return undefined;
  }
}

function hasLivePid(project) {
  return projectPid(project) !== undefined;
}

function isProjectFolder(folder) {
  return fs.existsSync(path.join(folder, 'plc.toml')) && fs.existsSync(path.join(folder, 'runtime', 'run.sh'));
}

function discoverLocalProjects() {
  const roots = new Set((vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath));
  const home = os.homedir();
  for (const name of ['Documentos', 'Documents']) roots.add(path.join(home, name));
  const found = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (isProjectFolder(root)) found.add(canonicalProject(root));
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const candidate = path.join(root, entry.name);
      if (isProjectFolder(candidate)) found.add(canonicalProject(candidate));
    }
  }
  return [...found];
}

async function discoverProjects(force = false) {
  if (!force && discoveredProjectCache) return discoveredProjectCache;
  const saved = extensionContext?.globalState.get('plcCodex.projects', []) || [];
  const projects = new Map();
  for (const project of [...saved, ...discoverLocalProjects(), ...(activeProject ? [activeProject] : [])]) {
    const canonical = canonicalProject(project);
    if (fs.existsSync(path.join(canonical, 'plc.toml'))) projects.set(canonical, canonical);
  }
  const result = [...projects.values()].sort();
  if (result.length !== saved.length || result.some((project,index) => project !== saved[index])) {
    await extensionContext?.globalState.update('plcCodex.projects', result);
  }
  discoveredProjectCache = result;
  return result;
}

async function rememberProject(project) {
  project = canonicalProject(project);
  const projects = extensionContext.globalState.get('plcCodex.projects', []);
  const normalized = [...new Set(projects.map(canonicalProject))];
  if (!normalized.includes(project)) normalized.push(project);
  await extensionContext.globalState.update('plcCodex.projects', normalized);
  discoveredProjectCache = undefined;
  return project;
}

async function forgetProject(project) {
  const canonical = canonicalProject(project);
  const projects = extensionContext.globalState.get('plcCodex.projects', []).filter(item => canonicalProject(item) !== canonical);
  await extensionContext.globalState.update('plcCodex.projects', projects);
  discoveredProjectCache = undefined;
  if (activeProject && canonicalProject(activeProject) === canonical) activeProject = undefined;
}

async function chooseProjectFolder() {
  const selected = await vscode.window.showOpenDialog({ title: 'Adicionar pasta de projeto PLC', canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Adicionar projeto' });
  if (!selected?.length) return undefined;
  const project = canonicalProject(selected[0].fsPath);
  const missing = ['plc.toml', 'runtime/run.sh', 'runtime/stop.sh'].filter(item => !fs.existsSync(path.join(project, item)));
  if (missing.length) throw new Error(`Esta pasta não é um projeto PLC Codex válido. Ausente: ${missing.join(', ')}`);
  return rememberProject(project);
}

async function chooseProject(context, forceChoice = false) {
  const projects = await discoverProjects();
  if (!projects.length) {
    vscode.window.showErrorMessage('Nenhum projeto com plc.toml foi encontrado no workspace aberto.');
    return undefined;
  }

  const saved = context.globalState.get('plcCodex.activeProject') || context.workspaceState.get('plcCodex.activeProject');
  if (!forceChoice && saved && projects.includes(saved)) {
    activeProject = saved;
    return saved;
  }
  if (!forceChoice && projects.length === 1) {
    activeProject = projects[0];
    await context.workspaceState.update('plcCodex.activeProject', activeProject);
    await context.globalState.update('plcCodex.activeProject', activeProject);
    return activeProject;
  }

  const roots = vscode.workspace.workspaceFolders || [];
  const items = projects.map(project => ({
    label: `$(circuit-board) ${path.basename(project)}`,
    description: roots.length ? vscode.workspace.asRelativePath(project) : project,
    project
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Selecione o projeto PLC ativo',
    placeHolder: 'Projeto que receberá Build, Play e Stop'
  });
  if (!selected) return undefined;
  activeProject = selected.project;
  await context.workspaceState.update('plcCodex.activeProject', activeProject);
  await context.globalState.update('plcCodex.activeProject', activeProject);
  projectView?.refresh();
  return activeProject;
}

async function requireProject(context) {
  if (activeProject) return activeProject;
  return chooseProject(context);
}

function runScript(root, script, onExit, extraEnv = {}) {
  const child = cp.spawn('bash', [path.join(root, 'runtime', script)], {
    cwd: root,
    env: { ...process.env, ...extraEnv }
  });
  child.stdout.on('data', data => output.append(data.toString()));
  child.stderr.on('data', data => output.append(data.toString()));
  child.on('error', error => {
    output.appendLine(`Erro: ${error.message}`);
    vscode.window.showErrorMessage(`PLC Codex: ${error.message}`);
  });
  child.on('exit', code => onExit?.(code));
  return child;
}

function runRuntimeDetached(root, onExit, extraEnv = {}) {
  const logPath = path.join(root, '.plcsim', 'runtime.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = cp.spawn('bash', [path.join(root, 'runtime', 'run.sh')], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  child.on('error', error => {
    output.appendLine(`Erro ao iniciar runtime: ${error.message}`);
    vscode.window.showErrorMessage(`PLC Codex: ${error.message}`);
  });
  child.on('exit', code => onExit?.(code));
  child.unref();
  return child;
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, env: process.env });
    child.stdout.on('data', data => output.append(data.toString()));
    child.stderr.on('data', data => output.append(data.toString()));
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} encerrou com código ${code}`)));
  });
}

function publishBuildDiagnostics(project, text) {
  diagnosticCollection.clear();
  const sourceMap = readSourceMap(project);
  let importDiagnostics = {};
  try { importDiagnostics = JSON.parse(fs.readFileSync(path.join(project, 'plcopen', 'manifest.json'), 'utf8')).diagnostics || {}; } catch (_) {}
  const externalNames = [...new Set([...(importDiagnostics.unresolvedTypes || []), ...(importDiagnostics.unresolvedBlocks || [])])];
  const grouped = new Map();
  let first;
  const pattern = /^(.*?\.st):(\d+)(?:-(\d+)|:(\d+))?(?:\.\.(?:\d+)-(?:\d+))?\s*:\s*(?:(error|warning)\s*:\s*)?(.+)/i;
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    pattern.lastIndex = 0;
    if (!match) continue;
    let file = match[1], lineNumber = Number(match[2]), column = Number(match[3] || match[4] || 1);
    if (path.basename(file) === 'project.st') {
      const mapped = sourceMap.lines?.[String(lineNumber)];
      if (mapped) { file = mapped.file; lineNumber = mapped.line; column = 1; }
    }
    const absolute = path.isAbsolute(file) ? file : path.join(project, file);
    const uri = vscode.Uri.file(absolute);
    let message = match[6].trim();
    try {
      const sourceLine = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)[lineNumber - 1] || '';
      const external = externalNames.find(name => sourceLine.includes(name));
      if (external) message = `Dependência externa “${external}” não está disponível no simulador. ${message}`;
    } catch (_) {}
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(Math.max(0, lineNumber - 1), Math.max(0, column - 1), Math.max(0, lineNumber - 1), Math.max(1, column)),
      message,
      (match[5] || '').toLowerCase() === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'PLC Codex / IEC ST';
    const key = uri.toString();
    if (!grouped.has(key)) grouped.set(key, { uri, diagnostics: [] });
    grouped.get(key).diagnostics.push(diagnostic);
    if (!first && diagnostic.severity === vscode.DiagnosticSeverity.Error) first = { uri, diagnostic };
  }
  for (const { uri, diagnostics } of grouped.values()) diagnosticCollection.set(uri, diagnostics);
  return { count: [...grouped.values()].reduce((total, item) => total + item.diagnostics.length, 0), first, externalCount: externalNames.length };
}

async function showBuildFailure(project, transcript) {
  const result = publishBuildDiagnostics(project, transcript);
  const located = result.count ? `${result.count} erro(s) localizado(s)` : 'erro sem localização';
  const pending = result.externalCount ? ` · ${result.externalCount} dependência(s) externa(s) pendente(s)` : '';
  vscode.window.showErrorMessage(`PLC não iniciou: ${located}${pending}. O primeiro problema foi aberto no código.`);
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  if (result.first) {
    const editor = await vscode.window.showTextDocument(result.first.uri, { preview: false });
    editor.selection = new vscode.Selection(result.first.diagnostic.range.start, result.first.diagnostic.range.start);
    editor.revealRange(result.first.diagnostic.range, vscode.TextEditorRevealType.InCenter);
  } else {
    output.show(true);
  }
  return result;
}

function buildProject(project) {
  return new Promise(resolve => {
    let transcript = '';
    const child = cp.spawn('bash', [path.join(project, 'runtime', 'build.sh')], { cwd: project, env: process.env });
    const receive = data => { const value = data.toString(); transcript += value; output.append(value); };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.on('error', error => { transcript += error.message; output.appendLine(`Erro: ${error.message}`); resolve({ code: -1, transcript }); });
    child.on('exit', code => resolve({ code, transcript }));
  });
}

function parseScenarioFile(file) {
  const scenarios = [];
  let scenario, step;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const clean = raw.replace(/\s+#.*$/, '');
    let match;
    if ((match = clean.match(/^  - name:\s*(.+)$/))) {
      const rawName = match[1].trim();
      let name = rawName;
      if (/^".*"$/.test(rawName)) try { name = JSON.parse(rawName); } catch (_) {}
      scenario = { name, steps: [] }; scenarios.push(scenario); step = undefined;
    } else if (scenario && (match = clean.match(/^      - (set|pulse|expect):\s*(.+)$/))) {
      step = { action: match[1], tag: match[2].trim() }; scenario.steps.push(step);
    } else if (scenario && (match = clean.match(/^      - wait_ms:\s*(\d+)$/))) {
      scenario.steps.push({ action: 'wait', value: Number(match[1]) }); step = undefined;
    } else if (step && (match = clean.match(/^        value:\s*(.+)$/))) {
      const rawValue = match[1].trim();
      step.value = /^(true|false)$/i.test(rawValue) ? rawValue.toLowerCase() === 'true' : Number(rawValue);
    }
  }
  return scenarios;
}

function saveScenarioFile(file, scenarios) {
  const lines = ['name: "Ensaios do projeto"', 'scenarios:'];
  for (const scenario of scenarios) {
    lines.push(`  - name: ${JSON.stringify(String(scenario.name || 'Novo cenário'))}`, '    steps:');
    for (const step of scenario.steps || []) {
      if (step.action === 'wait') lines.push(`      - wait_ms: ${Math.max(0, Number(step.value) || 0)}`);
      else {
        lines.push(`      - ${step.action}: ${step.tag}`);
        if (step.action !== 'pulse') lines.push(`        value: ${typeof step.value === 'string' ? JSON.stringify(step.value) : String(step.value)}`);
      }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function openScenarioEditor(project) {
  const file = path.join(project, 'tests', 'cenarios.yaml');
  if (!fs.existsSync(file)) saveScenarioFile(file, []);
  const scenarios = parseScenarioFile(file), catalog = projectVariableCatalog(project);
  const panel = vscode.window.createWebviewPanel('plcCodex.scenarioEditor', `Cenários — ${projectManifest(project).name}`, vscode.ViewColumn.One, { enableScripts: true });
  const data = JSON.stringify({ scenarios, catalog }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><style>
body{margin:0;font:12px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}header{height:50px;display:flex;align-items:center;gap:7px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border)}h1{font-size:16px;flex:1}button{border:0;border-radius:3px;padding:7px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}main{display:grid;grid-template-columns:260px 1fr;height:calc(100vh - 51px)}aside{border-right:1px solid var(--vscode-panel-border);padding:10px;overflow:auto}.content{padding:16px;overflow:auto}.scenario{display:flex;align-items:center;gap:5px;width:100%;margin-bottom:4px;text-align:left}.scenario span{flex:1;overflow:hidden;text-overflow:ellipsis}.scenario.active{outline:2px solid var(--vscode-focusBorder)}input,select{padding:7px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}.title{display:flex;gap:7px;margin-bottom:14px}.title input{flex:1;font-size:15px;font-weight:700}.step{display:grid;grid-template-columns:120px minmax(220px,1fr) 160px auto;gap:7px;padding:7px;border-bottom:1px solid var(--vscode-panel-border)}.help{padding:10px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder);margin-bottom:12px;color:var(--vscode-descriptionForeground)}.empty{padding:30px;text-align:center;color:var(--vscode-descriptionForeground)}#result{color:var(--vscode-testing-iconPassed)}@media(max-width:760px){main{grid-template-columns:1fr;height:auto}aside{border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.step{grid-template-columns:1fr}}
</style></head><body><header><h1>Editor de cenários de teste</h1><span id="result"></span><button id="raw" class="secondary">Abrir YAML</button><button id="save">Salvar</button></header><main><aside><button id="add">+ Novo cenário</button><div id="scenarios"></div></aside><section class="content"><div class="help"><b>set</b> mantém um valor; <b>pulse</b> pressiona por 120 ms; <b>wait</b> aguarda; <b>expect</b> reprova se o valor não for o esperado. Os testes atuam no PLC online.</div><div id="empty" class="empty">Crie ou selecione um cenário.</div><div id="form" hidden><div class="title"><input id="name" placeholder="Nome do cenário"><button id="run">Executar agora</button><button id="remove" class="secondary">Excluir</button></div><div id="steps"></div><button id="addStep" class="secondary">+ Adicionar passo</button></div></section></main><datalist id="tags"></datalist><script>
const vscode=acquireVsCodeApi(),data=${data},scenarios=data.scenarios,$=id=>document.getElementById(id);let selected=scenarios.length?0:-1;for(const v of data.catalog){const o=document.createElement('option');o.value=v.path;$('tags').append(o)}
function renderList(){const root=$('scenarios');root.replaceChildren();scenarios.forEach((s,i)=>{const b=document.createElement('button');b.className='scenario secondary'+(i===selected?' active':'');const n=document.createElement('span');n.textContent=s.name||'Sem nome';const c=document.createElement('small');c.textContent=(s.steps||[]).length+' passos';b.append(n,c);b.onclick=()=>{selected=i;render()};root.append(b)})}
function renderSteps(){const root=$('steps');root.replaceChildren();const s=scenarios[selected];for(const [i,step] of (s.steps||[]).entries()){const row=document.createElement('div');row.className='step';const action=document.createElement('select');for(const a of ['set','pulse','wait','expect']){const o=document.createElement('option');o.value=a;o.textContent=a;o.selected=step.action===a;action.append(o)}const tag=document.createElement('input');tag.setAttribute('list','tags');tag.placeholder='Caminho da variável';tag.value=step.tag||'';const value=document.createElement('input');value.placeholder=step.action==='wait'?'milissegundos':'true, false ou número';value.value=step.value??'';tag.hidden=step.action==='wait';value.hidden=step.action==='pulse';const remove=document.createElement('button');remove.className='secondary';remove.textContent='Excluir';action.onchange=()=>{step.action=action.value;if(step.action==='wait'){delete step.tag;step.value=100}else if(step.action==='pulse'){step.tag=step.tag||'';delete step.value}else{step.tag=step.tag||'';step.value=false}renderSteps()};tag.oninput=()=>step.tag=tag.value;value.oninput=()=>{const v=value.value.trim();step.value=/^(true|false)$/i.test(v)?v.toLowerCase()==='true':v!==''&&!Number.isNaN(Number(v))?Number(v):v};remove.onclick=()=>{s.steps.splice(i,1);render()};row.append(action,tag,value,remove);root.append(row)}}
function render(){renderList();const s=scenarios[selected];$('empty').hidden=Boolean(s);$('form').hidden=!s;if(!s)return;$('name').value=s.name;renderSteps()}
$('name').oninput=()=>{scenarios[selected].name=$('name').value;renderList()};$('add').onclick=()=>{scenarios.push({name:'Novo cenário',steps:[]});selected=scenarios.length-1;render()};$('remove').onclick=()=>{scenarios.splice(selected,1);selected=Math.min(selected,scenarios.length-1);render()};$('addStep').onclick=()=>{scenarios[selected].steps.push({action:'set',tag:'',value:false});render()};$('save').onclick=()=>vscode.postMessage({type:'save',scenarios});$('raw').onclick=()=>vscode.postMessage({type:'raw'});$('run').onclick=()=>vscode.postMessage({type:'run',index:selected,scenario:scenarios[selected]});window.addEventListener('message',e=>{$('result').textContent=e.data.ok?(e.data.elapsed!==undefined?'Aprovado em '+e.data.elapsed+' ms':'Salvo.'):'Erro: '+e.data.error});render();
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    try {
      if (message.type === 'raw') return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      if (message.type === 'save') {
        for (const scenario of message.scenarios || []) for (const step of scenario.steps || []) {
          if (!['set', 'pulse', 'wait', 'expect'].includes(step.action)) throw new Error('Ação de cenário inválida.');
          if (step.action !== 'wait' && !step.tag) throw new Error(`Informe a tag em ${scenario.name}.`);
          if (step.action === 'wait' && (!Number.isFinite(step.value) || step.value < 0)) throw new Error(`Tempo inválido em ${scenario.name}.`);
          if (['set', 'expect'].includes(step.action) && typeof step.value !== 'boolean' && !Number.isFinite(step.value)) throw new Error(`Use true, false ou um número em ${scenario.name}.`);
        }
        saveScenarioFile(file, message.scenarios || []); panel.webview.postMessage({ ok: true });
      } else if (message.type === 'run') {
        if (!hasLivePid(project)) throw new Error('PLC offline. Inicie-o antes do ensaio.');
        const result = await runScenario(project, message.scenario); panel.webview.postMessage({ ok: true, ...result });
      }
    } catch (error) { panel.webview.postMessage({ ok: false, error: error.message }); }
  });
}

async function runScenario(project, scenario) {
  const started = Date.now(), log = [];
  await fetchJson(`${projectUrl(project)}/api/control?action=run`);
  for (const [index, step] of scenario.steps.entries()) {
    if (step.action === 'wait') {
      await new Promise(resolve => setTimeout(resolve, step.value));
      log.push(`${index + 1}. aguardou ${step.value} ms`);
      continue;
    }
    if (step.action === 'set' || step.action === 'pulse') {
      const write = async value => {
        const result = await fetchJson(`${projectUrl(project)}/api/set?tag=${encodeURIComponent(step.tag)}&val=${encodeURIComponent(value)}`);
        if (!result.ok) throw new Error(`escrita recusada: ${step.tag}`);
      };
      await write(step.action === 'pulse' ? 1 : step.value);
      if (step.action === 'pulse') { await new Promise(resolve => setTimeout(resolve, 120)); await write(0); }
      log.push(`${index + 1}. ${step.action} ${step.tag}`);
      continue;
    }
    const state = await fetchJson(`${projectUrl(project)}/api/variables`);
    const variable = (state.variables || []).find(item => item.path === step.tag);
    if (!variable) throw new Error(`variável não encontrada: ${step.tag}`);
    const equal = typeof step.value === 'number'
      ? Math.abs(Number(variable.value) - step.value) < 0.000001
      : variable.value === step.value;
    if (!equal) throw new Error(`${step.tag}: esperado ${step.value}, recebido ${variable.value}`);
    log.push(`${index + 1}. confirmado ${step.tag} = ${step.value}`);
  }
  return { elapsed: Date.now() - started, log };
}

async function openScenarioRunner(project) {
  const file = path.join(project, 'tests', 'cenarios.yaml');
  if (!fs.existsSync(file)) throw new Error('O projeto não possui tests/cenarios.yaml.');
  const scenarios = parseScenarioFile(file);
  if (!scenarios.length) throw new Error('Nenhum cenário válido foi encontrado.');
  const panel = vscode.window.createWebviewPanel('plcCodex.scenarios', `Cenários — ${projectManifest(project).name}`, vscode.ViewColumn.One, { enableScripts: true });
  const safe = JSON.stringify(scenarios).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:900px;margin:auto}header{display:flex;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px}h1{font-size:20px;flex:1;margin:0}.sub{color:var(--vscode-descriptionForeground)}button{border:0;border-radius:2px;padding:7px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:650}.scenario{border:1px solid var(--vscode-panel-border);margin-top:12px}.head{display:flex;gap:10px;align-items:center;padding:10px;background:var(--vscode-sideBarSectionHeader-background)}.head strong{flex:1}.result{padding:10px;white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}.pass{border-left:4px solid var(--vscode-testing-iconPassed)}.fail{border-left:4px solid var(--vscode-testing-iconFailed)}
</style></head><body><header><div><h1>Ensaios automáticos</h1><div class="sub">${projectManifest(project).name} · tests/cenarios.yaml · o PLC deve estar executando</div></div><button id="all">Executar todos</button></header><main id="list"></main><script>
const vscode=acquireVsCodeApi(),scenarios=${safe},list=document.getElementById('list');
scenarios.forEach((s,i)=>{const card=document.createElement('section');card.className='scenario';const head=document.createElement('div');head.className='head';const title=document.createElement('strong');title.textContent=s.name;const meta=document.createElement('span');meta.className='sub';meta.textContent=s.steps.length+' passos';const button=document.createElement('button');button.textContent='Executar';button.onclick=()=>run(i);const result=document.createElement('div');result.className='result';head.append(title,meta,button);card.append(head,result);list.append(card);s.card=card;s.button=button;s.result=result});
function run(index){scenarios[index].button.disabled=true;scenarios[index].result.textContent='Executando…';vscode.postMessage({type:'run',index})}document.getElementById('all').onclick=()=>vscode.postMessage({type:'all'});
window.addEventListener('message',e=>{const m=e.data,s=scenarios[m.index];if(!s)return;s.button.disabled=false;s.card.className='scenario '+(m.ok?'pass':'fail');s.result.textContent=(m.ok?'APROVADO · '+m.elapsed+' ms\\n':'REPROVADO\\n')+(m.ok?m.log.join('\\n'):m.error)});
</script></body></html>`;
  const execute = async index => {
    try {
      if (!hasLivePid(project)) throw new Error('PLC offline. Inicie-o antes do ensaio.');
      const result = await runScenario(project, scenarios[index]);
      panel.webview.postMessage({ type: 'result', index, ok: true, ...result });
    } catch (error) { panel.webview.postMessage({ type: 'result', index, ok: false, error: error.message }); }
  };
  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'run') await execute(message.index);
    if (message.type === 'all') for (let index = 0; index < scenarios.length; index++) await execute(index);
  });
}

async function openImportReport(project) {
  const file = path.join(project, 'plcopen', 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('Este projeto não possui relatório de importação PLCopenXML.');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const panel = vscode.window.createWebviewPanel('plcCodex.importReport', `Importação — ${projectManifest(project).name}`, vscode.ViewColumn.One, { enableScripts: true });
  const data = JSON.stringify(report).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1100px;margin:auto}header{display:flex;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:14px}h1{font-size:20px;margin:0 0 4px}.grow{flex:1}.muted{color:var(--vscode-descriptionForeground)}button{border:0;border-radius:2px;padding:7px 12px;margin-left:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:650}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.card{border:1px solid var(--vscode-panel-border);padding:10px}.number{font-size:24px;font-weight:750}.ok{border-left:4px solid var(--vscode-testing-iconPassed)}.pending{border-left:4px solid var(--vscode-editorWarning-foreground)}section{margin-top:16px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid var(--vscode-panel-border);padding:7px}th{background:var(--vscode-sideBarSectionHeader-background)}a{color:var(--vscode-textLink-foreground);cursor:pointer}.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:5px 7px;border:1px solid var(--vscode-editorWarning-foreground);background:var(--vscode-textBlockQuote-background)}
</style></head><body><header><div class="grow"><h1>Relatório de importação PLCopenXML</h1><div class="muted" id="source"></div></div><button id="mapping">Mapear telas</button><button id="build">Validar build</button></header><div id="cards" class="cards"></div><section><h2>Pendências de bibliotecas e tipos</h2><div id="pending" class="chips"></div></section><section><h2>Conversões para Structured Text</h2><div id="conversions"></div></section><section><h2>POUs importadas</h2><table><thead><tr><th>Nome</th><th>Tipo</th><th>Origem</th><th>Runtime</th><th>Arquivo</th></tr></thead><tbody id="pous"></tbody></table></section><section><h2>Bibliotecas declaradas (${report.libraries?.length || 0})</h2><div id="libraries" class="muted"></div></section><script>
const vscode=acquireVsCodeApi(),d=${data},diag=d.diagnostics||{};document.getElementById('source').textContent=d.source||'';
const stats=[['POUs',d.pous?.length||0],['DUTs',d.dataTypes?.length||0],['GVLs',d.globalVars?.length||0],['Bibliotecas',d.libraries?.length||0]],cards=document.getElementById('cards');for(const [label,value] of stats){const c=document.createElement('div');c.className='card';c.innerHTML='<div class="number">'+value+'</div><div class="muted">'+label+'</div>';cards.append(c)}
const pending=[...(diag.unresolvedTypes||[]).map(x=>'Tipo: '+x),...(diag.unresolvedBlocks||[]).map(x=>'Bloco: '+x)],pendingEl=document.getElementById('pending');if(!pending.length){pendingEl.className='card ok';pendingEl.textContent='Nenhuma dependência não resolvida detectada.'}else for(const value of pending){const c=document.createElement('span');c.className='chip';c.textContent=value;pendingEl.append(c)}
const conversions=document.getElementById('conversions');if(!(diag.conversions||[]).length)conversions.textContent='Todas as POUs já estavam em ST.';else for(const c of diag.conversions){const row=document.createElement('div');row.className='card pending';row.textContent=c.name+': '+c.from+' → '+c.to;conversions.append(row)}
const tbody=document.getElementById('pous');for(const p of d.pous||[]){const tr=document.createElement('tr');for(const value of [p.name,p.type,p.originalLanguage,p.runtimeLanguage]){const td=document.createElement('td');td.textContent=value||'';tr.append(td)}const td=document.createElement('td'),a=document.createElement('a');a.textContent=p.file;a.onclick=()=>vscode.postMessage({type:'open',file:p.file});td.append(a);tr.append(td);tbody.append(tr)}
document.getElementById('libraries').textContent=(d.libraries||[]).map(x=>x.Name||x.name||JSON.stringify(x)).join(' · ')||'Nenhuma biblioteca declarada.';document.getElementById('mapping').onclick=()=>vscode.postMessage({type:'mapping'});document.getElementById('build').onclick=()=>vscode.postMessage({type:'build'});
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'open') {
      const target = path.resolve(project, message.file);
      if (target.startsWith(path.resolve(project) + path.sep) && fs.existsSync(target)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
    } else if (message.type === 'mapping') await openMappingEditor(project);
    else if (message.type === 'build') await vscode.commands.executeCommand('plcCodex.build');
  });
}

function copyProjectTemplate(context, target) {
  const template = path.join(context.extensionPath, 'template', 'projeto-plc');
  if (!fs.existsSync(template)) throw new Error('Template de projeto não foi incluído na extensão.');
  fs.mkdirSync(target, { recursive: true });
  if (fs.readdirSync(target).length) throw new Error('A pasta escolhida precisa estar vazia.');
  fs.cpSync(template, target, { recursive: true });
}

async function chooseNewProjectTarget(title) {
  const selected = await vscode.window.showOpenDialog({ title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Usar esta pasta' });
  if (!selected?.length) return undefined;
  const name = await vscode.window.showInputBox({ title: 'Nome da pasta do projeto', value: 'Novo Projeto PLC', validateInput: value => !value.trim() ? 'Informe um nome.' : /[\\/]/.test(value) ? 'Use somente o nome, sem barras.' : undefined });
  if (!name) return undefined;
  const target = path.join(selected[0].fsPath, name.trim());
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`A pasta ${target} já existe e não está vazia.`);
  return target;
}

function waitForServer(url, child, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!child || child.exitCode !== null) return reject(new Error('O runtime encerrou antes de abrir o Equipamento.'));
      const request = http.get(url, { agent: httpAgent }, response => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.setTimeout(500, () => request.destroy());
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) reject(new Error(`O servidor não respondeu em ${url} após ${Math.round(timeoutMs / 1000)} s.`));
      else setTimeout(attempt, 200);
    };
    attempt();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: httpAgent }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error('Tempo esgotado')));
    request.on('error', reject);
  });
}

async function openEquipment(project) {
  // Em workspaces SSH/WSL/Container o VS Code cria o encaminhamento correto.
  // A query única força o Simple Browser a carregar a versão atual do painel.
  const panelUri = vscode.Uri.parse(projectUrl(project)).with({ query: `v=${Date.now()}` });
  const external = await vscode.env.asExternalUri(panelUri);
  await vscode.commands.executeCommand('simpleBrowser.show', external.toString(true));
}

async function openPid(project) {
  const panelUri = vscode.Uri.parse(projectPidUrl(project)).with({ query: `v=${Date.now()}` });
  const external = await vscode.env.asExternalUri(panelUri);
  await vscode.commands.executeCommand('simpleBrowser.show', external.toString(true));
}

function projectPrograms(project) {
  const folder = path.join(project, 'programs');
  if (!fs.existsSync(folder)) return [];
  const names = new Set();
  for (const file of fs.readdirSync(folder).filter(name => name.toLowerCase().endsWith('.st'))) {
    const text = fs.readFileSync(path.join(folder, file), 'utf8');
    for (const match of text.matchAll(/(?:^|\n)\s*PROGRAM\s+([A-Za-z_]\w*)/gi)) names.add(match[1]);
  }
  return [...names].sort();
}

function replaceManifestValue(text, key, value, quoted = false) {
  const rendered = quoted ? `"${String(value).replace(/"/g, '')}"` : String(value);
  const expression = new RegExp(`^${key}\\s*=.*$`, 'm');
  return expression.test(text) ? text.replace(expression, `${key} = ${rendered}`) : `${key} = ${rendered}\n${text}`;
}

function replaceTaskValue(text, key, value, quoted = false) {
  const rendered = quoted ? `"${String(value).replace(/"/g, '')}"` : String(value);
  return text.replace(/\[\[task\]\]([\s\S]*?)(?=\n\[\[|$)/, block => {
    const expression = new RegExp(`^${key}\\s*=.*$`, 'm');
    return expression.test(block) ? block.replace(expression, `${key} = ${rendered}`) : `${block.trimEnd()}\n${key} = ${rendered}\n`;
  });
}

async function openProjectSettings(project) {
  const manifest = projectManifest(project);
  const programs = projectPrograms(project);
  const panel = vscode.window.createWebviewPanel('plcCodexProjectSettings', `Configuração · ${manifest.name}`, vscode.ViewColumn.One, { enableScripts: true });
  const options = programs.map(name => `<option value="${name}"${name === manifest.program ? ' selected' : ''}>${name}</option>`).join('');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:980px;margin:auto}h1{font-size:20px;margin:0 0 4px}.path{color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:18px;overflow-wrap:anywhere}.tools{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:22px}.tool{display:grid;grid-template-columns:1fr auto;gap:5px;text-align:left;padding:11px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}.tool b{font-size:13px}.tool small{grid-column:1/-1;color:var(--vscode-descriptionForeground);font-weight:400}.raw{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:4px 7px}.settings{border-top:1px solid var(--vscode-panel-border);padding-top:18px}.settings h2{font-size:15px;margin:0 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:grid;gap:5px}.wide{grid-column:1/-1}label{font-weight:650}input,select{padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}.help{font-size:11px;color:var(--vscode-descriptionForeground)}footer{display:flex;align-items:center;gap:10px;margin-top:20px;padding-top:14px;border-top:1px solid var(--vscode-panel-border)}button{padding:8px 14px;border:0;border-radius:3px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}#result{color:var(--vscode-testing-iconPassed)}@media(max-width:700px){.grid,.tools{grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body><h1>Central de configuração</h1><div class="path">${project}</div><section class="tools">
<button class="tool" data-action="mapping"><b>Mapeamento das telas</b><span>›</span><small>IHM, porta, interface, campo e monitoramento</small></button>
<button class="tool" data-action="pid"><b>Editor visual do P&amp;ID</b><span>›</span><small>Imagem, posição e apresentação das tags</small></button>
<button class="tool" data-action="scenarios"><b>Cenários de teste</b><span>›</span><small>Criar, editar, excluir e executar ensaios</small></button>
<button class="tool" data-action="rawPanel"><b>Abrir painel.json</b><span class="raw">JSON</span><small>Configuração bruta da bancada web</small></button>
<button class="tool" data-action="rawPid"><b>Abrir pid.json</b><span class="raw">JSON</span><small>Configuração bruta da visão de processo</small></button>
<button class="tool" data-action="rawScenarios"><b>Abrir cenarios.yaml</b><span class="raw">YAML</span><small>Arquivo bruto versionável dos ensaios</small></button>
<button class="tool" data-action="rawManifest"><b>Abrir plc.toml</b><span class="raw">TOML</span><small>Manifesto bruto do projeto e task</small></button>
<button class="tool" data-action="importReport"><b>Relatório PLCopenXML</b><span>›</span><small>POUs, conversões e dependências importadas</small></button>
</section><section class="settings"><h2>Projeto, execução e portas</h2><div class="grid">
<div class="field wide"><label>Nome do projeto</label><input id="name" value="${manifest.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>
<div class="field"><label>Task</label><input id="task" value="${manifest.task}"><span class="help">Identificador IEC da tarefa.</span></div>
<div class="field"><label>Programa de entrada</label><select id="program">${options}</select><span class="help">Primeiro PROGRAM executado a cada scan.</span></div>
<div class="field"><label>Intervalo do scan (ms)</label><input id="interval" type="number" min="1" max="60000" value="${manifest.intervalMs}"></div>
<div class="field"><label>Porta Comandos</label><input id="panelPort" type="number" min="1024" max="65534" value="${configuredProjectPort(project)}"></div>
<div class="field"><label>Porta P&amp;ID</label><input id="pidPort" type="number" min="1024" max="65535" value="${configuredPidPort(project)}"></div>
</div><footer><button id="save">Salvar configuração</button><span id="result"></span></footer></section><script>
const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>vscode.postMessage({type:'open',action:button.dataset.action}));$('save').onclick=()=>vscode.postMessage({type:'save',values:{name:$('name').value,task:$('task').value,program:$('program').value,interval:Number($('interval').value),panelPort:Number($('panelPort').value),pidPort:Number($('pidPort').value)}});window.addEventListener('message',event=>{if(event.data.type==='saved')$('result').textContent='Configuração salva.';if(event.data.type==='error')$('result').textContent='Erro: '+event.data.message});
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'open') {
      const actions = {
        mapping: () => openMappingEditor(project),
        pid: () => openPidEditor(project),
        scenarios: () => openScenarioEditor(project),
        importReport: () => openImportReport(project),
        rawPanel: () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(project, 'panel', 'painel.json'))),
        rawPid: () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(project, 'panel', 'pid.json'))),
        rawScenarios: () => { const file = path.join(project, 'tests', 'cenarios.yaml'); if (!fs.existsSync(file)) saveScenarioFile(file, []); return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); },
        rawManifest: () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(project, 'plc.toml'))),
      };
      try { await actions[message.action]?.(); } catch (error) { vscode.window.showErrorMessage(`Configuração: ${error.message}`); }
      return;
    }
    if (message.type !== 'save') return;
    try {
      const values = message.values || {};
      if (!values.name?.trim()) throw new Error('Informe o nome do projeto.');
      if (!/^[A-Za-z_]\w*$/.test(values.task || '')) throw new Error('Nome da task inválido.');
      if (!programs.includes(values.program)) throw new Error('Programa de entrada não encontrado em programs/.');
      if (!Number.isInteger(values.interval) || values.interval < 1 || values.interval > 60000) throw new Error('Intervalo inválido.');
      if (![values.panelPort, values.pidPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || values.panelPort === values.pidPort) throw new Error('Portas inválidas ou repetidas.');
      const target = path.join(project, 'plc.toml');
      let text = fs.readFileSync(target, 'utf8');
      text = replaceManifestValue(text, 'name', values.name.trim(), true);
      text = replaceManifestValue(text, 'panel_port', values.panelPort);
      text = replaceManifestValue(text, 'pid_port', values.pidPort);
      text = replaceTaskValue(text, 'name', values.task, true);
      text = replaceTaskValue(text, 'program', values.program, true);
      text = replaceTaskValue(text, 'interval_ms', values.interval);
      fs.writeFileSync(target, text);
      panel.webview.postMessage({ type: 'saved' });
      refreshUi();
    } catch (error) { panel.webview.postMessage({ type: 'error', message: error.message }); }
  });
}

function projectVariableCatalog(project) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(project, '.plcsim', 'build', 'variables.json'), 'utf8'));
    return (data.variables || []).map(variable => ({ path: variable.path, type: variable.type, source: variable.source || '' }));
  } catch (_) {
    try {
      const configuration = JSON.parse(fs.readFileSync(path.join(project, 'panel', 'painel.json'), 'utf8'));
      return [...new Set(Object.values(configuration.areas || {}).flat().map(item => item.tag))].map(path => ({ path, type: 'UNKNOWN', source: '' }));
    } catch (_) { return []; }
  }
}

async function openMappingEditor(project) {
  const target = path.join(project, 'panel', 'painel.json');
  const configuration = JSON.parse(fs.readFileSync(target, 'utf8'));
  const catalog = projectVariableCatalog(project);
  const areas = ['monitoring', 'ihm', 'panel', 'interface', 'field'];
  for (const area of areas) if (!Array.isArray(configuration.areas?.[area])) (configuration.areas ||= {})[area] = [];
  const panel = vscode.window.createWebviewPanel('plcCodexMappingEditor', `Mapeamento · ${projectManifest(project).name}`, vscode.ViewColumn.One, { enableScripts: true });
  const safeData = JSON.stringify({ configuration, catalog }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:12px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);overflow:hidden}header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);height:49px;background:var(--vscode-editor-background)}h1{font-size:15px;margin:0;flex:1}button{border:0;border-radius:3px;padding:6px 9px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}main{display:grid;grid-template-columns:280px minmax(450px,1fr) 270px;height:calc(100vh - 49px);min-height:0}aside,.editor{padding:10px;overflow:auto;min-height:0}.catalog{border-right:1px solid var(--vscode-panel-border)}.editor{border-left:1px solid var(--vscode-panel-border)}input,select{width:100%;padding:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}.tag-list{display:grid;gap:3px;margin-top:8px}.tag{padding:6px;border:1px solid var(--vscode-panel-border);border-radius:3px;background:var(--vscode-sideBar-background);cursor:grab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tag small{display:block;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}.areas{padding:10px;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start;min-height:0}.area{border:1px solid var(--vscode-panel-border);border-radius:4px;min-height:120px;min-width:0;padding:7px;overflow:hidden}.area>div{max-height:260px;overflow:auto;overscroll-behavior:contain;padding-right:2px}.area.monitoring{grid-column:1/-1}.area h2{font-size:11px;text-transform:uppercase;margin:0 0 6px;color:var(--vscode-descriptionForeground)}.area.drag{outline:2px solid var(--vscode-focusBorder)}.mapped{display:flex;gap:5px;align-items:center;padding:5px;margin:3px 0;background:var(--vscode-list-inactiveSelectionBackground);border-left:3px solid var(--vscode-focusBorder);cursor:pointer;min-width:0}.mapped span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.mapped small{flex:0 0 auto}.mapped.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.form{display:grid;gap:9px}.field{display:grid;gap:3px}.row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.empty{color:var(--vscode-descriptionForeground);padding:8px;text-align:center}.result{color:var(--vscode-testing-iconPassed)}@media(max-width:900px){body{overflow:auto}main{grid-template-columns:220px 1fr;height:auto}.editor{grid-column:1/-1;border-left:0;border-top:1px solid var(--vscode-panel-border)}.areas{grid-template-columns:1fr}}
</style></head><body><header><h1>Mapeamento das telas</h1><span id="result" class="result"></span><button id="save">Salvar painel.json</button></header><main><aside class="catalog"><input id="search" placeholder="Filtrar variáveis..."><div id="catalog" class="tag-list"></div></aside><section id="areas" class="areas"></section><aside class="editor"><h2>Propriedades do item</h2><div id="empty" class="empty">Arraste uma tag para uma área ou selecione um item.</div><div id="form" class="form" hidden><div class="field"><label>Tag</label><input id="tag" readonly></div><div class="field"><label>Rótulo</label><input id="label"></div><div class="row"><div class="field"><label>Comportamento</label><select id="kind"><option value="switch">Switch — alterna ao clicar</option><option value="pushbutton">Pushbutton — ativo enquanto segura</option><option value="bool">Indicador booleano</option><option value="number">Valor numérico</option><option value="lamp">Sinaleiro</option><option value="analog">Instrumento analógico</option></select></div><div class="field"><label>Tipo IO</label><input id="ioType"></div></div><div class="row"><div class="field"><label>Endereço</label><input id="address"></div><div class="field"><label>Unidade</label><input id="unit"></div></div><div class="row"><div class="field"><label>Precisão</label><input id="precision" type="number" min="0" max="8"></div><div class="field"><label>Aba IHM</label><input id="tab"></div></div><div class="field"><label><input id="writable" type="checkbox" style="width:auto"> Permitir escrita</label></div><button id="remove" class="secondary">Remover da tela</button></div></aside></main><script>
const vscode=acquireVsCodeApi(),data=${safeData},config=data.configuration,catalog=data.catalog,areaNames={monitoring:'Monitoramento',ihm:'IHM',panel:'Porta do painel',interface:'Interface cliente',field:'Campo / equipamento'},$=id=>document.getElementById(id);let selected=null;
function renderCatalog(){const q=$('search').value.toLowerCase(),root=$('catalog');root.replaceChildren();for(const variable of catalog.filter(v=>v.path.toLowerCase().includes(q)).slice(0,500)){const row=document.createElement('div');row.className='tag';row.draggable=true;row.title=variable.path;row.innerHTML='<span></span><small></small>';row.children[0].textContent=variable.path;row.children[1].textContent=variable.type+(variable.source?' · '+variable.source:'');row.ondragstart=e=>e.dataTransfer.setData('text/plain',variable.path);root.append(row)}}
function defaultItem(path){const variable=catalog.find(v=>v.path===path),last=path.split('.').pop(),isBool=variable?.type==='BOOL';return{tag:path,label:last,kind:isBool?'switch':'number',ioType:'VAR',writable:true,...(!isBool?{precision:config.display?.realPrecision??2}:{})}}
function select(area,index){selected={area,index};renderAreas();renderForm()}
function renderAreas(){const root=$('areas');root.replaceChildren();for(const area of Object.keys(areaNames)){const card=document.createElement('section');card.className='area '+area;card.innerHTML='<h2></h2><div></div>';card.children[0].textContent=areaNames[area]+' · '+config.areas[area].length;card.ondragover=e=>{e.preventDefault();card.classList.add('drag')};card.ondragleave=()=>card.classList.remove('drag');card.ondrop=e=>{e.preventDefault();card.classList.remove('drag');const path=e.dataTransfer.getData('text/plain');if(!path)return;config.areas[area].push(defaultItem(path));select(area,config.areas[area].length-1)};for(const [index,item] of config.areas[area].entries()){const row=document.createElement('div');row.className='mapped'+(selected?.area===area&&selected.index===index?' active':'');row.innerHTML='<span></span><small></small>';row.children[0].textContent=item.label||item.tag;row.children[1].textContent=item.ioType||'';row.title=item.tag;row.onclick=()=>select(area,index);card.children[1].append(row)}root.append(card)}}
const fields=['label','kind','ioType','address','unit','precision','tab'];function renderForm(){const item=selected&&config.areas[selected.area]?.[selected.index];$('empty').hidden=Boolean(item);$('form').hidden=!item;if(!item)return;$('tag').value=item.tag;for(const key of fields)$(key).value=key==='kind'?(item[key]==='toggle'?'switch':item[key]==='momentary'?'pushbutton':item[key]??''):item[key]??'';$('writable').checked=item.writable!==false}
for(const key of fields){$(key).oninput=()=>{if(!selected)return;const item=config.areas[selected.area][selected.index],value=$(key).value;if(key==='precision')value===''?delete item[key]:item[key]=Number(value);else value===''?delete item[key]:item[key]=value;renderAreas()}}$('writable').onchange=()=>{if(selected)config.areas[selected.area][selected.index].writable=$('writable').checked};$('remove').onclick=()=>{if(!selected)return;config.areas[selected.area].splice(selected.index,1);selected=null;renderAreas();renderForm()};$('search').oninput=renderCatalog;$('save').onclick=()=>vscode.postMessage({type:'save',configuration:config});window.addEventListener('message',e=>{$('result').textContent=e.data.type==='saved'?'Salvo. Recarregue a página Comandos.':'Erro: '+e.data.message});renderCatalog();renderAreas();
</script></body></html>`;
  panel.webview.onDidReceiveMessage(message => {
    if (message.type !== 'save') return;
    try {
      const next = message.configuration;
      const validPaths = new Set(catalog.map(variable => variable.path));
      for (const area of areas) {
        if (!Array.isArray(next.areas?.[area])) throw new Error(`Área ${area} inválida.`);
        for (const item of next.areas[area]) {
          if (!validPaths.has(item.tag)) throw new Error(`Tag inexistente: ${item.tag}`);
          if (item.precision !== undefined && (!Number.isInteger(item.precision) || item.precision < 0 || item.precision > 8)) throw new Error(`Precisão inválida em ${item.tag}.`);
        }
      }
      fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
      panel.webview.postMessage({ type: 'saved' });
    } catch (error) { panel.webview.postMessage({ type: 'error', message: error.message }); }
  });
}

async function openPidEditor(project) {
  const target = path.join(project, 'panel', 'pid.json');
  const configuration = JSON.parse(fs.readFileSync(target, 'utf8'));
  const catalog = projectVariableCatalog(project);
  const panel = vscode.window.createWebviewPanel('plcCodexPidEditor', `Editor P&ID · ${projectManifest(project).name}`, vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(project, 'panel'))] });
  let backgroundUri = '';
  if (configuration.backgroundImage) {
    const local = path.join(project, 'panel', configuration.backgroundImage.replace(/^\/+/, ''));
    if (fs.existsSync(local)) backgroundUri = panel.webview.asWebviewUri(vscode.Uri.file(local)).toString();
  }
  const safeData = JSON.stringify({ configuration, catalog, backgroundUri }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:12px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}header{height:48px;display:flex;align-items:center;gap:7px;padding:0 10px;border-bottom:1px solid var(--vscode-panel-border)}h1{font-size:15px;margin:0;flex:1}button{border:0;border-radius:3px;padding:6px 9px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}main{height:calc(100vh - 49px);display:grid;grid-template-columns:250px minmax(500px,1fr) 250px}.side{padding:9px;overflow:auto}.left{border-right:1px solid var(--vscode-panel-border)}.right{border-left:1px solid var(--vscode-panel-border)}input{width:100%;padding:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}.tags{display:grid;gap:3px;margin-top:7px}.source{padding:5px;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:grab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.workspace{padding:10px;overflow:auto}.canvas{position:relative;width:100%;aspect-ratio:16/9;min-height:440px;border:1px solid var(--vscode-panel-border);background-color:var(--vscode-editorWidget-background);background-position:center;background-size:contain;background-repeat:no-repeat;overflow:hidden}.canvas.drag{outline:2px solid var(--vscode-focusBorder)}.item{position:absolute;transform:translate(-50%,-50%);width:145px;padding:6px;border:1px solid var(--vscode-focusBorder);border-left:4px solid var(--vscode-testing-iconPassed);border-radius:3px;background:var(--vscode-editor-background);box-shadow:0 1px 4px #0004;cursor:move;user-select:none}.item.active{outline:2px solid var(--vscode-focusBorder)}.item b,.item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item small{color:var(--vscode-descriptionForeground);margin-top:3px}.form{display:grid;gap:8px}.field{display:grid;gap:3px}.row{display:grid;grid-template-columns:1fr 1fr;gap:6px}.empty{color:var(--vscode-descriptionForeground);padding:10px}.result{color:var(--vscode-testing-iconPassed)}@media(max-width:900px){main{grid-template-columns:200px 1fr}.right{grid-column:1/-1;border-left:0;border-top:1px solid var(--vscode-panel-border)}}
</style></head><body><header><h1>Editor visual do P&amp;ID</h1><span id="result" class="result"></span><button id="background" class="secondary">Imagem de fundo</button><button id="clearBackground" class="secondary">Remover imagem</button><button id="save">Salvar pid.json</button></header><main><aside class="side left"><input id="search" placeholder="Filtrar variáveis..."><div id="sources" class="tags"></div></aside><section class="workspace"><div id="canvas" class="canvas"></div></section><aside class="side right"><h2>Cartão selecionado</h2><div id="empty" class="empty">Arraste uma variável para o desenho.</div><div id="form" class="form" hidden><div class="field"><label>Tag</label><input id="tag" readonly></div><div class="field"><label>Rótulo</label><input id="label"></div><div class="row"><div class="field"><label>Unidade</label><input id="unit"></div><div class="field"><label>Precisão</label><input id="precision" type="number" min="0" max="8"></div></div><div class="row"><div class="field"><label>X (%)</label><input id="x" type="number" min="0" max="100"></div><div class="field"><label>Y (%)</label><input id="y" type="number" min="0" max="100"></div></div><button id="remove" class="secondary">Remover cartão</button></div></aside></main><script>
const vscode=acquireVsCodeApi(),data=${safeData},config=data.configuration,catalog=data.catalog,$=id=>document.getElementById(id);let selected=-1,dragging=-1;const canvas=$('canvas');if(data.backgroundUri)canvas.style.backgroundImage='url('+JSON.stringify(data.backgroundUri)+')';
function renderSources(){const q=$('search').value.toLowerCase(),root=$('sources');root.replaceChildren();for(const variable of catalog.filter(v=>v.path.toLowerCase().includes(q)).slice(0,500)){const row=document.createElement('div');row.className='source';row.draggable=true;row.textContent=variable.path;row.title=variable.type+' · '+variable.source;row.ondragstart=e=>e.dataTransfer.setData('text/plain',variable.path);root.append(row)}}
function position(event,index){const rect=canvas.getBoundingClientRect(),item=config.items[index];item.x=Math.max(0,Math.min(100,(event.clientX-rect.left)*100/rect.width));item.y=Math.max(0,Math.min(100,(event.clientY-rect.top)*100/rect.height));renderItems();renderForm()}
function renderItems(){canvas.querySelectorAll('.item').forEach(node=>node.remove());for(const [index,item] of config.items.entries()){const card=document.createElement('div');card.className='item'+(selected===index?' active':'');card.style.left=item.x+'%';card.style.top=item.y+'%';card.innerHTML='<b></b><small></small>';card.children[0].textContent=item.label||item.tag.split('.').pop();card.children[1].textContent=item.tag;card.onpointerdown=e=>{selected=index;dragging=index;card.setPointerCapture(e.pointerId);renderItems();renderForm()};card.onpointermove=e=>{if(dragging===index)position(e,index)};card.onpointerup=()=>dragging=-1;canvas.append(card)}}
function add(path,event){const rect=canvas.getBoundingClientRect(),variable=catalog.find(v=>v.path===path),isReal=['REAL','LREAL'].includes(variable?.type);config.items.push({tag:path,label:path.split('.').pop(),x:Math.round((event.clientX-rect.left)*1000/rect.width)/10,y:Math.round((event.clientY-rect.top)*1000/rect.height)/10,...(isReal?{precision:config.display?.realPrecision??2}:{})});selected=config.items.length-1;renderItems();renderForm()}
canvas.ondragover=e=>{e.preventDefault();canvas.classList.add('drag')};canvas.ondragleave=()=>canvas.classList.remove('drag');canvas.ondrop=e=>{e.preventDefault();canvas.classList.remove('drag');const path=e.dataTransfer.getData('text/plain');if(path)add(path,e)};
const fields=['label','unit','precision','x','y'];function renderForm(){const item=config.items[selected];$('empty').hidden=Boolean(item);$('form').hidden=!item;if(!item)return;$('tag').value=item.tag;for(const key of fields)$(key).value=item[key]??''}for(const key of fields)$(key).oninput=()=>{const item=config.items[selected];if(!item)return;const value=$(key).value;if(['precision','x','y'].includes(key))value===''?delete item[key]:item[key]=Number(value);else value===''?delete item[key]:item[key]=value;renderItems()};$('remove').onclick=()=>{if(selected<0)return;config.items.splice(selected,1);selected=-1;renderItems();renderForm()};$('search').oninput=renderSources;$('background').onclick=()=>vscode.postMessage({type:'pickBackground'});$('clearBackground').onclick=()=>{delete config.backgroundImage;canvas.style.backgroundImage='none'};$('save').onclick=()=>vscode.postMessage({type:'save',configuration:config});window.addEventListener('message',e=>{if(e.data.type==='background'){config.backgroundImage=e.data.relative;canvas.style.backgroundImage='url('+JSON.stringify(e.data.uri)+')'}$('result').textContent=e.data.type==='saved'?'Salvo. Recarregue o P&ID.':e.data.type==='error'?'Erro: '+e.data.message:''});renderSources();renderItems();renderForm();
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    try {
      if (message.type === 'pickBackground') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Selecione a imagem base do P&ID', filters: { Imagens: ['png', 'jpg', 'jpeg', 'svg', 'webp'] } });
        if (!picked?.length) return;
        const extension = path.extname(picked[0].fsPath).toLowerCase();
        const assets = path.join(project, 'panel', 'assets');fs.mkdirSync(assets, { recursive: true });
        const destination = path.join(assets, `pid-background${extension}`);fs.copyFileSync(picked[0].fsPath, destination);
        panel.webview.postMessage({ type: 'background', relative: `assets/${path.basename(destination)}`, uri: panel.webview.asWebviewUri(vscode.Uri.file(destination)).toString() });
      } else if (message.type === 'save') {
        const next = message.configuration,validPaths=new Set(catalog.map(variable=>variable.path));
        if (!Array.isArray(next.items)) throw new Error('Lista de itens inválida.');
        for (const item of next.items) {
          if (!validPaths.has(item.tag)) throw new Error(`Tag inexistente: ${item.tag}`);
          if (![item.x,item.y].every(value=>Number.isFinite(value)&&value>=0&&value<=100)) throw new Error(`Posição inválida em ${item.tag}.`);
          if (item.precision!==undefined&&(!Number.isInteger(item.precision)||item.precision<0||item.precision>8)) throw new Error(`Precisão inválida em ${item.tag}.`);
        }
        fs.writeFileSync(target,JSON.stringify(next,null,2)+'\n');panel.webview.postMessage({type:'saved'});
      }
    } catch (error) { panel.webview.postMessage({ type: 'error', message: error.message }); }
  });
}

function displayValue(variable) {
  if (variable.type === 'BOOL') return variable.value ? 'TRUE' : 'FALSE';
  if (variable.type === 'TIME_MS') return `T#${variable.value}ms`;
  return String(variable.value);
}

async function askVariableValue(variable, action = 'Alterar') {
  if (variable.type === 'BOOL') {
    return vscode.window.showQuickPick(['true', 'false'], {
      title: `${action}: ${variable.path}`,
      placeHolder: `Valor atual: ${displayValue(variable)}`
    });
  }
  return vscode.window.showInputBox({
    title: `${action}: ${variable.path}`,
    value: String(variable.value),
    prompt: `Tipo ${variable.type}${variable.type === 'TIME_MS' ? ' · valor em milissegundos' : ''}`
  });
}

function readSourceMap(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.plcsim', 'build', 'source_map.json'), 'utf8'));
  } catch (_) {
    return { lines: {}, routines: [] };
  }
}

function readWriterMap(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.plcsim', 'build', 'writers.json'), 'utf8')).writers || {};
  } catch (_) {
    return {};
  }
}

function readReferenceMap(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.plcsim', 'build', 'references.json'), 'utf8'));
  } catch (_) {
    return { references: {}, dependencies: {}, dependencyDetails: {}, writeDependencies: {}, writeExpressions: {} };
  }
}

function readVariableMetadata(project) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(project, '.plcsim', 'build', 'variables.json'), 'utf8'));
    return new Map((data.variables || []).map(variable => [variable.path, variable]));
  } catch (_) { return new Map(); }
}

function variableTreePath(variable, metadata) {
  const source = metadata?.source || '', sourceName = path.basename(source, path.extname(source)).replace(/^\d+_/, '');
  const parts = variable.path.split('.'), root = parts[0];
  if (metadata?.rootKind === 'functionBlock') {
    const visible = root.toLowerCase() === 'main' ? parts.slice(1) : parts;
    return ['Objetos e FBs', 'Instâncias de blocos', ...visible].join('/');
  }
  const processObject = metadata?.rootKind === 'structure' && (/process|processo|objeto/i.test(sourceName) || /^(PIT|TIT|FIT|LIT|AIT|Motor|Valvula|Valve)/i.test(root));
  if (processObject) return ['Objetos e FBs', 'Objetos de processo', ...parts].join('/');
  if (source.startsWith('globals/')) return ['DBs e GVLs', sourceName || 'Globais', ...parts].join('/');
  if (root.toLowerCase() === 'main') return ['Programas', root, ...parts.slice(1)].join('/');
  return ['Outras variáveis', sourceName || 'Sem origem', ...parts].join('/');
}

function sourceLocationIndex(sourceMap) {
  const index = new Map();
  for (const [generatedLine, location] of Object.entries(sourceMap.lines || {})) {
    const key = `${location.file}:${location.line}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(Number(generatedLine));
  }
  return index;
}

function observedWriter(variablePath, referenceIndex, locationIndex, debug, fallback, afterScan = 0) {
  const scans = (debug.trace_history || []).filter(item => Number(item.scan) > afterScan);
  if (!scans.length) scans.push({ scan: debug.scan, trace: debug.trace || [] });
  let selected, selectedScan = -1, selectedOrder = -1;
  for (const scan of scans) {
    const traceOrder = new Map((scan.trace || []).map((line, index) => [Number(line), index]));
    for (const location of referenceIndex.references?.[variablePath]?.writes || []) {
      for (const generatedLine of locationIndex.get(`${location.file}:${location.line}`) || []) {
        const order = traceOrder.get(generatedLine);
        if (order !== undefined && (Number(scan.scan) > selectedScan || (Number(scan.scan) === selectedScan && order >= selectedOrder))) {
          selected = { ...location, scan: Number(scan.scan) }; selectedScan = Number(scan.scan); selectedOrder = order;
        }
      }
    }
  }
  return selected || fallback;
}

function causalSnapshot(variablePath, referenceIndex, variables, writers, seen = new Set(), relation = {}) {
  const variable = variables.get(variablePath), writer = writers.get(variablePath);
  const node = { tag: variablePath, value: variable?.value, type: variable?.type, writer: writer || null, ...relation, children: [] };
  if (seen.has(variablePath) || seen.size >= 8) return node;
  const nextSeen = new Set(seen); nextSeen.add(variablePath);
  const perWrite = (referenceIndex.writeDependencies?.[variablePath] || []).find(item => writer && item.file === writer.file && item.line === writer.line);
  const known = new Map((referenceIndex.dependencyDetails?.[variablePath] || []).map(item => [item.tag, item]));
  const dependencies = perWrite?.dependencies || (referenceIndex.dependencies?.[variablePath] || []).map(tag => known.get(tag) || { tag, negated: false });
  const candidates = dependencies.filter(dependency => {
    const current = variables.get(dependency.tag);
    if (!current || current.type !== 'BOOL') return true;
    const literal = dependency.negated ? !current.value : Boolean(current.value);
    return variable?.type === 'BOOL' ? literal === Boolean(variable.value) : literal;
  });
  node.expression = perWrite?.statement || (referenceIndex.writeExpressions?.[variablePath] || []).find(item => writer && item.file === writer.file && item.line === writer.line)?.statement || '';
  node.children = candidates.map(dependency => causalSnapshot(dependency.tag, referenceIndex, variables, writers, nextSeen, { negated: dependency.negated }));
  return node;
}

async function openCrossReferences(project, variablePath, changes = []) {
  const index = readReferenceMap(project), reference = index.references?.[variablePath] || { reads: [], writes: [] };
  let liveVariables = [];
  if (hasLivePid(project)) try { liveVariables = (await fetchJson(`${projectUrl(project)}/api/variables`)).variables || []; } catch (_) {}
  const values = Object.fromEntries(liveVariables.map(variable => [variable.path, { value: variable.value, type: variable.type }]));
  const buildCause = (tag, depth = 0, seen = new Set(), relation = {}) => {
    const node = { tag, ...relation, ...(values[tag] || {}), children: [] };
    if (depth >= 4 || seen.has(tag)) return node;
    const nextSeen = new Set(seen); nextSeen.add(tag);
    const known = new Map((index.dependencyDetails?.[tag] || []).map(item => [item.tag, item]));
    const details = (index.dependencies?.[tag] || []).map(child => known.get(child) || { tag: child, negated: false });
    node.children = details.map(child => buildCause(child.tag, depth + 1, nextSeen, { negated: child.negated }));
    return node;
  };
  const latestTrace = changes.length ? changes[changes.length - 1].trace : undefined;
  const payload = JSON.stringify({ variablePath, reference, changes, cause: latestTrace || buildCause(variablePath), traceScan: latestTrace ? changes[changes.length - 1].scan : null }).replace(/</g, '\\u003c');
  const panel = vscode.window.createWebviewPanel('plcCodex.references', `Referências — ${variablePath}`, vscode.ViewColumn.One, { enableScripts: true });
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1050px;margin:auto}h1{font-size:18px;margin:0}h2{font-size:13px;text-transform:uppercase;margin-top:20px}.path{font-family:var(--vscode-editor-font-family);color:var(--vscode-textLink-foreground)}.summary{color:var(--vscode-descriptionForeground);margin-top:5px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.location,.change{display:grid;grid-template-columns:1fr auto;gap:6px;padding:8px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}.location:hover,.change:hover{background:var(--vscode-list-hoverBackground)}.routine{font-weight:650}.file{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground)}ul{list-style:none;padding-left:18px}li{margin:5px 0}.node{display:inline-grid;grid-template-columns:minmax(220px,auto) auto;gap:3px 10px;align-items:center;padding:5px 7px;border:1px solid var(--vscode-panel-border);border-left:4px solid var(--vscode-testing-iconPassed);border-radius:2px;cursor:pointer}.node:hover{background:var(--vscode-list-hoverBackground)}.node.false{opacity:.68}.value{font-family:var(--vscode-editor-font-family);color:var(--vscode-debugTokenExpression-value)}.expression{grid-column:1/-1;font-size:10px;color:var(--vscode-descriptionForeground);white-space:normal}.leaf{font-weight:700}.empty{color:var(--vscode-descriptionForeground);padding:8px}@media(max-width:700px){.columns{grid-template-columns:1fr}}
</style></head><body><h1>Referências cruzadas e traceback</h1><div class="path" id="title"></div><div class="summary">A instrumentação existe somente no simulador e não entra no PLCopenXML. O traceback combina a linha realmente percorrida no scan com as dependências do ST.</div><h2 id="traceTitle">Traceback da última mudança</h2><div id="cause"></div><h2>Últimas alterações observadas</h2><div id="changes"></div><div class="columns"><section><h2>Escrito em</h2><div id="writes"></div></section><section><h2>Lido em</h2><div id="reads"></div></section></div><script>
const vscode=acquireVsCodeApi(),d=${payload};document.getElementById('title').textContent=d.variablePath;
function locations(id,list){const root=document.getElementById(id);if(!list.length){root.className='empty';root.textContent='Nenhuma referência encontrada.';return}for(const loc of list){const row=document.createElement('div');row.className='location';const info=document.createElement('div');const routine=document.createElement('div');routine.className='routine';routine.textContent=loc.routine;const file=document.createElement('div');file.className='file';file.textContent=loc.file+':'+loc.line;info.append(routine,file);const open=document.createElement('span');open.textContent='Abrir ›';row.append(info,open);row.onclick=()=>vscode.postMessage({type:'open',file:loc.file,line:loc.line});root.append(row)}}locations('writes',d.reference.writes||[]);locations('reads',d.reference.reads||[]);
const changes=document.getElementById('changes');if(!d.changes.length){changes.className='empty';changes.textContent='Nenhuma alteração registrada desde que o depurador foi aberto.'}for(const c of [...d.changes].reverse()){const row=document.createElement('div');row.className='change';const info=document.createElement('div');info.innerHTML='<span class="routine"></span><div class="file"></div>';info.children[0].textContent=(c.writer?.routine||'Origem desconhecida')+' · '+String(c.before)+' → '+String(c.after);info.children[1].textContent='scan '+c.scan+(c.writer?.file?' · '+c.writer.file+':'+c.writer.line:'');row.append(info);if(c.writer?.file){const open=document.createElement('span');open.textContent='Abrir ›';row.append(open);row.onclick=()=>vscode.postMessage({type:'open',file:c.writer.file,line:c.writer.line})}changes.append(row)}
if(d.traceScan!==null)document.getElementById('traceTitle').textContent='Traceback capturado no scan '+d.traceScan;function tree(node){const li=document.createElement('li'),box=document.createElement('span'),leaf=!node.children?.length;box.className='node'+(leaf?' leaf':'');const name=document.createElement('span');name.textContent=(node.negated?'NOT ':'')+node.tag;const value=document.createElement('span');value.className='value';value.textContent=node.value===undefined?'—':node.type==='BOOL'?(node.value?'TRUE':'FALSE'):String(node.value);box.append(name,value);if(node.expression||leaf){const expression=document.createElement('code');expression.className='expression';expression.textContent=node.expression||(node.writer?.file?'Fim rastreável desta cadeia':'VARIÁVEL-FOLHA · origem externa, I/O ou valor inicial');box.append(expression)}if(node.writer?.file){box.title=node.writer.routine+' · '+node.writer.file+':'+node.writer.line;box.onclick=()=>vscode.postMessage({type:'open',file:node.writer.file,line:node.writer.line})}li.append(box);if(node.children?.length){const ul=document.createElement('ul');for(const child of node.children)ul.append(tree(child));li.append(ul)}return li}const root=document.createElement('ul');root.append(tree(d.cause));document.getElementById('cause').append(root);
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => { if (message.type === 'open') await openSourceLocation(project, message.file, message.line || 1); });
}

function sourceLocation(project, projectLine) {
  const mapped = readSourceMap(project).lines?.[String(projectLine)];
  return mapped ? { ...mapped, fsPath: path.join(project, mapped.file) } : undefined;
}

async function debugControlFor(project, action, updateUi = true) {
  if (!project || !hasLivePid(project)) {
    vscode.window.showWarningMessage('Inicie o PLC antes de controlar a execução.');
    return undefined;
  }
  const state = await fetchJson(`${projectUrl(project)}/api/control?action=${encodeURIComponent(action)}`);
  lastDebugState = state;
  if (updateUi && project === activeProject) {
    routinesView?.refresh(state);
    await updateLiveEditors();
  }
  return state;
}

async function debugControl(action, updateUi = true) {
  return debugControlFor(activeProject, action, updateUi);
}

async function openSourceLocation(project, file, line) {
  const document = await vscode.workspace.openTextDocument(path.join(project, file));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const lineIndex = Math.min(document.lineCount - 1, Math.max(0, line - 1));
  const sourceLine = document.lineAt(lineIndex);
  const start = new vscode.Position(lineIndex, sourceLine.firstNonWhitespaceCharacterIndex);
  editor.selection = new vscode.Selection(start, sourceLine.range.end);
  editor.revealRange(sourceLine.range, vscode.TextEditorRevealType.InCenter);
}

async function updateLiveEditors() {
  if (liveUpdateBusy || !activeProject || !liveDecoration) return;
  const editors = vscode.window.visibleTextEditors.filter(editor =>
    editor.document.languageId === 'iec-st' && editor.document.uri.fsPath.startsWith(activeProject + path.sep)
  );
  if (!hasLivePid(activeProject)) {
    lastDebugState = undefined;
    for (const editor of editors) {
      editor.setDecorations(liveDecoration, []);
      editor.setDecorations(currentLineDecoration, []);
      editor.setDecorations(executedLineDecoration, []);
    }
    return;
  }
  liveUpdateBusy = true;
  try {
    const [data, debug] = await Promise.all([
      fetchJson(`${projectUrl(activeProject)}/api/variables`),
      fetchJson(`${projectUrl(activeProject)}/api/debug`)
    ]);
    lastDebugState = debug;
    routinesView?.update(debug);
    const sourceMap = readSourceMap(activeProject);
    const aliases = new Map();
    const ambiguous = new Set();
    for (const variable of data.variables || []) {
      const parts = variable.path.split('.');
      const candidates = [variable.path, parts.slice(1).join('.'), parts.slice(-2).join('.'), parts.at(-1)];
      for (const alias of candidates) {
        if (!alias) continue;
        if (aliases.has(alias) && aliases.get(alias).path !== variable.path) ambiguous.add(alias);
        else aliases.set(alias, variable);
      }
    }
    for (const alias of ambiguous) aliases.delete(alias);
    const ordered = [...aliases.entries()].sort((a,b) => b[0].length - a[0].length);
    for (const editor of editors) {
      const decorations = [];
      const currentDecorations = [];
      const executedDecorations = [];
      for (let lineNumber=0; lineNumber<editor.document.lineCount; lineNumber++) {
        const line = editor.document.lineAt(lineNumber); const found=[]; const paths=new Set();
        for (const [alias, variable] of ordered) {
          if (line.text.includes(alias) && !paths.has(variable.path)) { found.push([alias,variable]); paths.add(variable.path); }
          if (found.length >= 3) break;
        }
        if (!found.length) continue;
        decorations.push({
          range: new vscode.Range(lineNumber, line.text.length, lineNumber, line.text.length),
          renderOptions: { after: { contentText: `   ◉ ${found.map(([alias,v]) => `${alias.split('.').at(-1)}=${displayValue(v)}`).join('  ')}` } },
          hoverMessage: found.map(([,v]) => `**${v.path}** = \`${displayValue(v)}\` (${v.type})`).join('  \n')
        });
      }
      const current = sourceMap.lines?.[String(debug.current_line)];
      if (debug.waiting_line && current && path.join(activeProject, current.file) === editor.document.uri.fsPath) {
        const line = Math.max(0, current.line - 1);
        if (line < editor.document.lineCount) {
          currentDecorations.push({
            range: editor.document.lineAt(line).range,
            hoverMessage: `Próxima instrução ST · scan ${debug.scan}`
          });
        }
      }
      const seen = new Set();
      for (const projectLine of debug.trace || []) {
        const mapped = sourceMap.lines?.[String(projectLine)];
        if (!mapped || path.join(activeProject, mapped.file) !== editor.document.uri.fsPath || seen.has(mapped.line)) continue;
        seen.add(mapped.line);
        const line = Math.max(0, mapped.line - 1);
        if (line < editor.document.lineCount) executedDecorations.push({ range: editor.document.lineAt(line).range });
      }
      editor.setDecorations(liveDecoration, decorations);
      editor.setDecorations(executedLineDecoration, executedDecorations);
      editor.setDecorations(currentLineDecoration, currentDecorations);
    }
  } catch (_) {
    // O próximo ciclo recupera automaticamente após build/restart.
  } finally {
    liveUpdateBusy = false;
  }
}

class PlcTreeProvider {
  constructor(context) {
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  async getChildren(element) {
    if (element?.kind === 'project') return this.projectChildren(element.project);
    if (element?.kind === 'folder') return this.folderChildren(element.fsPath, element.project);
    const projects = await discoverProjects();
    if (!projects.length) {
      const none = new vscode.TreeItem('Adicionar uma pasta de projeto');
      none.description = 'nenhum projeto cadastrado';
      none.iconPath = new vscode.ThemeIcon('add');
      none.command = { command: 'plcCodex.addProject', title: 'Adicionar projeto' };
      return [none];
    }
    return projects.map(project => {
      const isActive = project === activeProject;
      const isRunning = hasLivePid(project);
      const manifest = projectManifest(project);
      const location = path.basename(path.dirname(project));
      const item = new vscode.TreeItem(manifest.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.kind = 'project';
      item.project = project;
      item.description = isRunning ? `● ONLINE :${projectPort(project)} · ${location}` : (isActive ? `○ ATIVO/PARADO · ${location}` : `○ OFFLINE · ${location}`);
      item.iconPath = new vscode.ThemeIcon(isRunning ? 'debug-start' : 'circuit-board');
      item.tooltip = `${manifest.name}\nEntrada: ${manifest.task} → ${manifest.program} (${manifest.intervalMs} ms)\n${project}\n${isRunning ? `Online · PID ${projectPid(project)} · porta ${projectPort(project)}` : 'Offline'}`;
      item.contextValue = isRunning ? 'plcProjectRunning' : (isActive ? 'plcProjectStopped' : 'plcProjectInactive');
      if (!isActive) item.command = { command: 'plcCodex.activateProject', title: 'Ativar projeto', arguments: [project] };
      return item;
    });
  }
  projectChildren(project) {
    return this.folderChildren(project, project);
  }
  folderChildren(folder, project) {
    const ignored = new Set(['.plcsim', 'node_modules', '.git']);
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter(entry => !ignored.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(entry => {
        const fsPath = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
          item.kind = 'folder';
          item.project = project;
          item.fsPath = fsPath;
          item.iconPath = vscode.ThemeIcon.Folder;
          item.contextValue = 'plcFolder';
          return item;
        }
        const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
        item.kind = 'file';
        item.project = project;
        item.fsPath = fsPath;
        item.resourceUri = vscode.Uri.file(fsPath);
        item.command = { command: 'vscode.open', title: 'Abrir arquivo', arguments: [item.resourceUri] };
        item.contextValue = 'plcFile';
        return item;
      });
  }
}

class ProcessTreeProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  async getChildren() {
    const projects = await discoverProjects();
    const running = projects.map(project => ({ project, pid: projectPid(project) })).filter(item => item.pid);
    if (!running.length) {
      const empty = new vscode.TreeItem('Nenhum PLC executando');
      empty.description = '0 processos';
      empty.iconPath = new vscode.ThemeIcon('circle-slash');
      empty.contextValue = 'plcNoProcess';
      return [empty];
    }
    return running.map(({ project, pid }) => {
      const item = new vscode.TreeItem(path.basename(project));
      item.project = project;
      item.description = `PID ${pid} · porta ${projectPort(project)}`;
      item.tooltip = `${project}\nProcesso ${pid}\nComandos: ${projectUrl(project)}\nP&ID: ${projectPidUrl(project)}`;
      item.iconPath = new vscode.ThemeIcon('pulse');
      item.contextValue = 'plcRunningProcess';
      return item;
    });
  }
}

class RoutinesTreeProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.state = undefined;
  }
  update(state) { if (state) this.state = state; }
  refresh(state) { if (state) this.state = state; this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(element) {
    if (element) return element.plcChildren || [];
    if (!activeProject || !hasLivePid(activeProject)) {
      const empty = new vscode.TreeItem('Inicie o PLC para acompanhar as rotinas');
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    const state = this.state || lastDebugState || { mode: 'run', scan: 0, trace: [] };
    const sourceMap = readSourceMap(activeProject);
    const modeNames = { run: 'AO VIVO', paused: 'PAUSADO', line: 'PASSO DE LINHA' };
    const manifest = projectManifest(activeProject);
    const statusItem = new vscode.TreeItem(`${manifest.task} → ${manifest.program} · ${modeNames[state.mode] || state.mode}`);
    statusItem.id = 'plc-debug-status';
    statusItem.description = `scan ${state.scan} · ciclo ${manifest.intervalMs} ms`;
    statusItem.iconPath = new vscode.ThemeIcon(state.mode === 'run' ? 'debug-start' : state.mode === 'line' ? 'debug-step-into' : 'debug-pause');
    statusItem.contextValue = 'plcDebugStatus';

    const current = sourceMap.lines?.[String(state.current_line)];
    if (state.waiting_line && current) {
      const lineItem = new vscode.TreeItem(`Próxima linha · ${path.basename(current.file)}:${current.line}`);
      lineItem.id = 'plc-debug-current-line';
      lineItem.description = 'aguardando comando';
      lineItem.iconPath = new vscode.ThemeIcon('debug-stackframe-active');
      lineItem.command = { command: 'plcCodex.openRoutine', title: 'Abrir linha atual', arguments: [current.file, current.line] };
      statusItem.children = [lineItem];
    }

    // A arvore acompanha a ordem de chamada. build.py entrega cada POU com o
    // campo depth; o pai de um item e o ultimo item do nivel imediatamente
    // acima. Sem depth a lista degrada para plana, como nas versoes anteriores.
    const traced = (state.trace || []).map(projectLine => sourceMap.lines?.[String(projectLine)]).filter(Boolean);
    const roots = [];
    const openBranch = [];
    (sourceMap.routines || []).forEach((routine, index) => {
      const isCurrent = current && current.file === routine.file && current.line >= routine.startLine && current.line <= routine.endLine;
      const executed = traced.some(item => item.file === routine.file && item.line >= routine.startLine && item.line <= routine.endLine);
      const item = new vscode.TreeItem(routine.title || routine.name);
      item.id = `plc-routine-${index}-${routine.file}-${routine.startLine}`;
      item.description = isCurrent ? `LINHA ${current.line}` : executed ? `executada · scan ${state.scan}` : 'não executada';
      item.iconPath = new vscode.ThemeIcon(isCurrent ? 'debug-stackframe-active' : executed ? 'pass-filled' : 'circle-outline');
      item.contextValue = isCurrent ? 'plcRoutineCurrent' : 'plcRoutine';
      item.command = { command: 'plcCodex.openRoutine', title: 'Abrir rotina', arguments: [routine.file, isCurrent ? current.line : routine.startLine] };
      item.plcChildren = [];
      item.plcIsBlock = String(routine.title || routine.name).startsWith('FB');
      const depth = Number.isInteger(routine.depth) ? Math.max(0, routine.depth) : 0;
      openBranch.length = Math.min(openBranch.length, depth);
      const parent = depth > 0 ? openBranch[depth - 1] : undefined;
      if (parent) parent.plcChildren.push(item); else roots.push(item);
      openBranch[depth] = item;
    });
    // Programas abrem por padrao; blocos de funcao chegam recolhidos para nao
    // encher a aba com instancias de temporizador.
    const applyCollapsible = items => {
      for (const item of items) {
        if (!item.plcChildren.length) continue;
        item.collapsibleState = item.plcIsBlock
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded;
        applyCollapsible(item.plcChildren);
      }
    };
    applyCollapsible(roots);
    return [statusItem, ...(statusItem.children || []), ...roots];
  }
}

class VariablesTreeProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.root = { children: new Map() };
    this.message = 'Inicie um PLC para visualizar as variáveis.';
    this.busy = false;
  }
  getTreeItem(item) { return item; }
  getChildren(element) {
    const node = element?.node || this.root;
    if (!node.children?.size) {
      if (!element && this.message) {
        const item = new vscode.TreeItem(this.message);
        item.iconPath = new vscode.ThemeIcon('info');
        return [item];
      }
      return [];
    }
    return [...node.children.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([name, child]) => {
      const folder = child.children?.size;
      const item = new vscode.TreeItem(name, folder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = child.variable?.path || `plc-variable-folder-${child.fullPath || name}`;
      item.node = child;
      item.project = activeProject;
      if (folder) {
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'plcVariableFolder';
      } else {
        item.description = `${displayValue(child.variable)} · ${child.variable.type}${child.variable.forced ? ' · FORÇADA' : ''}`;
        item.tooltip = child.variable.path;
        item.iconPath = new vscode.ThemeIcon(child.variable.forced ? 'lock' : child.variable.type === 'BOOL' ? 'symbol-boolean' : 'symbol-number');
        item.contextValue = child.variable.forced ? 'plcVariableForced' : 'plcVariableWritable';
        item.command = { command: 'plcCodex.writeVariable', title: 'Escrever uma vez', arguments: [child.variable] };
      }
      return item;
    });
  }
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    this.root = { children: new Map() };
    if (!activeProject || !hasLivePid(activeProject)) {
      this.message = 'Inicie o projeto PLC ativo para visualizar as variáveis.';
      this.emitter.fire();
      this.busy = false;
      return;
    }
    try {
      const data = await fetchJson(`${projectUrl(activeProject)}/api/variables`);
      for (const variable of data.variables || []) {
        let node = this.root;
        const parts = [];
        for (const part of variable.path.split('.')) {
          parts.push(part);
          if (!node.children.has(part)) node.children.set(part, { children: new Map(), fullPath: parts.join('.') });
          node = node.children.get(part);
        }
        node.variable = variable;
      }
      this.message = '';
    } catch (error) {
      this.message = `Variáveis indisponíveis: ${error.message}`;
    } finally {
      this.busy = false;
    }
    this.emitter.fire();
  }
}

class RuntimeControlViewProvider {
  constructor(context) { this.context = context; this.view = undefined; this.timer = undefined; this.busy = false; }
  resolveWebviewView(view) {
    this.view = view; view.webview.options = { enableScripts: true }; view.webview.html = this.html();
    view.webview.onDidReceiveMessage(message => this.handle(message));
    view.onDidChangeVisibility(() => this.syncTimer()); view.onDidDispose(() => { this.stop(); this.view = undefined; });
    this.syncTimer();
  }
  syncTimer() { if (this.view?.visible) { if (!this.timer) this.timer = setInterval(() => this.update(), 500); this.update(); } else this.stop(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  dispose() { this.stop(); }
  async update() {
    if (this.busy || !this.view?.visible) return; this.busy = true;
    try {
      const running = (await discoverProjects()).filter(hasLivePid);
      const projects = await Promise.all(running.map(async project => {
        const debug = await fetchJson(`${projectUrl(project)}/api/debug`);
        const sourceMap = readSourceMap(project); const current = sourceMap.lines?.[String(debug.current_line)];
        const traced = new Set((debug.trace || []).map(line => sourceMap.lines?.[String(line)]?.file).filter(Boolean));
        return {
          project, name: projectManifest(project).name, pid: projectPid(project), port: projectPort(project), pidPort: projectPidPort(project),
          mode: debug.mode, scan: debug.scan, waiting: debug.waiting_line || debug.waiting_routine,
          current: current ? { file: current.file, line: current.line } : undefined,
          routines: (sourceMap.routines || []).map(routine => ({
            ...routine,
            current: Boolean(current && current.file === routine.file && current.line >= routine.startLine && current.line <= routine.endLine),
            executed: traced.has(routine.file)
          }))
        };
      }));
      this.view.webview.postMessage({ type: 'projects', projects });
    } catch (error) { this.view?.webview.postMessage({ type: 'error', message: error.message }); }
    finally { this.busy = false; }
  }
  async activate(project) {
    activeProject = project;
    await this.context.workspaceState.update('plcCodex.activeProject', project);
    await this.context.globalState.update('plcCodex.activeProject', project);
    projectView?.refresh();
    debugView?.update();
  }
  async handle(message) {
    if (message.type === 'stopAll') { await vscode.commands.executeCommand('plcCodex.stopAll'); return; }
    const project = message.project;
    if (!project || !hasLivePid(project)) return;
    try {
      await this.activate(project);
      if (message.type === 'stop') { await vscode.commands.executeCommand('plcCodex.stop', project); return; }
      if (message.type === 'control') {
        const count = Math.min(100, Math.max(1, Number(message.count) || 1));
        let state;
        for (let index = 0; index < count; index++) state = await debugControlFor(project, message.action, false);
        if (['step_routine', 'step_line'].includes(message.action) && state?.current_line) {
          const location = sourceLocation(project, state.current_line);
          if (location) await openSourceLocation(project, location.file, location.line);
        }
        await updateLiveEditors();
      } else if (message.type === 'openRoutine' && message.file) {
        await openSourceLocation(project, message.file, message.line || 1);
      } else if (message.type === 'panel') await openEquipment(project);
      else if (message.type === 'pid') await openPid(project);
      await this.update();
    } catch (error) { vscode.window.showErrorMessage(`PLC Codex: ${error.message}`); }
  }
  html() {
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{padding:5px;color:var(--vscode-foreground);font:12px var(--vscode-font-family);background:var(--vscode-sideBar-background)}.empty{color:var(--vscode-descriptionForeground);padding:8px}.toolbar{display:flex;justify-content:flex-end;margin-bottom:5px}.plc{border:1px solid var(--vscode-sideBarSectionHeader-border);border-radius:5px;margin-bottom:6px;overflow:hidden}.head{display:flex;align-items:center;gap:5px;padding:6px;background:var(--vscode-sideBarSectionHeader-background);cursor:pointer}.name{font-weight:700;flex:1}.mode{font-size:9px;font-weight:800}.run{color:var(--vscode-testing-iconPassed)}.paused,.routine,.line{color:var(--vscode-editorWarning-foreground)}.body{padding:6px}.hidden{display:none}.meta{color:var(--vscode-descriptionForeground);margin-bottom:5px;font-size:11px}.primary,.steps{display:flex;gap:4px;flex-wrap:wrap}.primary{margin-bottom:4px}.steps button{font-size:10px}.primary button{min-width:30px}.primary .stop{margin-left:auto}.steps{border-top:1px solid var(--vscode-sideBarSectionHeader-border);padding-top:4px}button{border:0;border-radius:3px;padding:3px 6px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-weight:650}button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.38;cursor:not-allowed}.play{color:var(--vscode-testing-iconPassed)}.pause{color:var(--vscode-editorWarning-foreground)}.stop{color:var(--vscode-errorForeground)}.equipment-button{margin-top:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.routines{margin-top:6px;border-top:1px solid var(--vscode-sideBarSectionHeader-border)}.routine-row{padding:3px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.routine-row:hover{background:var(--vscode-list-hoverBackground)}.routine-row.executed{color:var(--vscode-testing-iconPassed)}.routine-row.current{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);font-weight:700}
</style></head><body><div class="toolbar"><button class="stop" onclick="vscode.postMessage({type:'stopAll'})">■ Parar todos</button></div><div id="empty" class="empty">Nenhum PLC executando.</div><div id="list"></div><script>
const vscode=acquireVsCodeApi(),list=document.getElementById('list'),empty=document.getElementById('empty'),cards=new Map();
function control(project,action,count=1){vscode.postMessage({type:'control',project,action,count})}
function ensure(p){let c=cards.get(p.project);if(c)return c;const root=document.createElement('section');root.className='plc';const head=document.createElement('div');head.className='head';const arrow=document.createElement('span');arrow.textContent='▾';const name=document.createElement('span');name.className='name';const mode=document.createElement('span');mode.className='mode';head.append(arrow,name,mode);const body=document.createElement('div');body.className='body';head.onclick=()=>{body.classList.toggle('hidden');arrow.textContent=body.classList.contains('hidden')?'▸':'▾'};const meta=document.createElement('div');meta.className='meta';const primary=document.createElement('div');primary.className='primary';for(const [label,action,cls] of [['▶','run','play'],['Ⅱ','pause','pause']]){const b=document.createElement('button');b.textContent=label;b.title=action==='run'?'Executar ao vivo':'Pausar';b.className=cls;b.onclick=()=>control(p.project,action);primary.append(b)}const stop=document.createElement('button');stop.textContent='■';stop.title='Parar este PLC';stop.className='stop';stop.onclick=()=>vscode.postMessage({type:'stop',project:p.project});primary.append(stop);const steps=document.createElement('div');steps.className='steps';const stepButtons=[];for(const [label,action,count] of [['+1 scan','scan',1],['+10','scan',10],['+100','scan',100],['+rotina','step_routine',1],['+linha','step_line',1]]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>control(p.project,action,count);steps.append(b);stepButtons.push(b)}const panel=document.createElement('button');panel.className='equipment-button';panel.textContent='▣ Comandos';panel.onclick=()=>vscode.postMessage({type:'panel',project:p.project});const pid=document.createElement('button');pid.className='equipment-button';pid.textContent='⌁ P&ID';pid.onclick=()=>vscode.postMessage({type:'pid',project:p.project});const routines=document.createElement('div');routines.className='routines';body.append(meta,primary,steps,panel,pid,routines);root.append(head,body);list.append(root);c={root,name,mode,meta,routines,stepButtons};cards.set(p.project,c);return c}
window.addEventListener('message',e=>{const m=e.data;if(m.type==='error'){empty.textContent='Erro: '+m.message;empty.hidden=false;return}if(m.type!=='projects')return;empty.hidden=m.projects.length>0;const alive=new Set(m.projects.map(p=>p.project));for(const [key,c] of cards)if(!alive.has(key)){c.root.remove();cards.delete(key)}for(const p of m.projects){const c=ensure(p),names={run:'RODANDO',paused:'PAUSADO',routine:'PAUSADO',line:'PAUSADO'};c.name.textContent=p.name;c.mode.textContent=names[p.mode]||p.mode;c.mode.className='mode '+p.mode;c.meta.textContent='PID '+p.pid+' · comandos :'+p.port+' · P&ID :'+p.pidPort+' · scan '+p.scan+(p.current?' · próximo: '+p.current.file.split('/').pop()+':'+p.current.line:'');for(const button of c.stepButtons)button.disabled=p.mode==='run';const existing=new Map([...c.routines.children].map(x=>[x.dataset.file,x]));for(const r of p.routines){let row=existing.get(r.file);if(!row){row=document.createElement('div');row.dataset.file=r.file;c.routines.append(row)}row.onclick=()=>vscode.postMessage({type:'openRoutine',project:p.project,file:r.file,line:r.current&&p.current?p.current.line:r.startLine});row.textContent=(r.current?'▶ ':r.executed?'✓ ':'○ ')+r.name;row.className='routine-row'+(r.current?' current':r.executed?' executed':'');existing.delete(r.file)}for(const row of existing.values())row.remove()}});
</script></body></html>`;
  }
}

class LiveDebugViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.timer = undefined;
    this.busy = false;
    this.variables = new Map();
    this.watchPaths = new Set(context.globalState.get('plcCodex.watchPaths', []));
    this.lastWriters = new Map();
    this.manualWrites = new Map();
    this.changeHistory = new Map();
    this.trackedPaths = new Set();
    this.observedProject = '';
    this.metadata = new Map();
    this.referenceIndex = { references: {}, dependencies: {} };
    this.sourceMap = { lines: {}, routines: [] };
    this.locationIndex = new Map();
    this.writerMap = {};
    this.lastDebugScan = 0;
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(message => this.handle(message));
    view.onDidChangeVisibility(() => this.syncTimer());
    view.onDidDispose(() => { this.stop(); this.view = undefined; });
    this.syncTimer();
  }
  syncTimer() {
    if (this.view?.visible) {
      if (!this.timer) this.timer = setInterval(() => this.update(), 500);
      this.update();
    } else this.stop();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  dispose() { this.stop(); }
  async update() {
    if (this.busy || !this.view?.visible) return;
    if (!activeProject || !hasLivePid(activeProject)) {
      this.variables.clear();
      this.view.webview.postMessage({ type: 'offline', project: activeProject ? projectManifest(activeProject).name : '' });
      return;
    }
    this.busy = true;
    try {
      const [variables, debug] = await Promise.all([
        fetchJson(`${projectUrl(activeProject)}/api/variables`),
        fetchJson(`${projectUrl(activeProject)}/api/debug`)
      ]);
      if (this.observedProject !== activeProject) {
        this.variables.clear(); this.lastWriters.clear(); this.manualWrites.clear(); this.changeHistory.clear(); this.lastDebugScan = 0; this.observedProject = activeProject;
        this.metadata = readVariableMetadata(activeProject);
        this.referenceIndex = { references: {}, dependencies: {} };
        this.sourceMap = readSourceMap(activeProject);
        this.locationIndex = sourceLocationIndex(this.sourceMap);
        this.writerMap = {};
      }
      for (const variable of variables.variables || []) variable.treePath = variableTreePath(variable, this.metadata.get(variable.path));
      const receivedVariables = variables.variables || [];
      const firstSnapshot = this.variables.size === 0;
      const nextVariables = new Map(receivedVariables.map(variable => [variable.path, variable]));
      const changes = [];
      const changedVariables = [];
      for (const [variablePath, variable] of nextVariables) {
        const previous = this.variables.get(variablePath);
        if (!previous || previous.value !== variable.value || previous.forced !== variable.forced) changedVariables.push(variable);
        if (previous && previous.value !== variable.value) {
          if (!this.trackedPaths.has(variablePath)) continue;
          const manualAt = this.manualWrites.get(variablePath) || 0;
          const writer = Date.now() - manualAt < 1000
            ? { routine: 'Bancada / depurador', file: '', line: 0 }
            : observedWriter(variablePath, this.referenceIndex, this.locationIndex, debug, this.writerMap[variablePath], this.lastDebugScan);
          if (writer) this.lastWriters.set(variablePath, { ...writer, scan: writer.scan || debug.scan });
          changes.push({ path: variablePath, before: previous.value, after: variable.value, writer: writer || null });
        }
      }
      for (const change of changes) {
        const history = this.changeHistory.get(change.path) || [];
        history.push({ ...change, scan: debug.scan, trace: causalSnapshot(change.path, this.referenceIndex, nextVariables, this.lastWriters) });
        if (history.length > 30) history.shift();
        this.changeHistory.set(change.path, history);
      }
      this.lastDebugScan = Number(debug.scan) || this.lastDebugScan;
      this.variables = nextVariables;
      const current = this.sourceMap.lines?.[String(debug.current_line)];
      this.view.webview.postMessage({
        type: 'state', scan: debug.scan, mode: debug.mode, waiting: debug.waiting_line,
        project: projectManifest(activeProject).name, port: projectPort(activeProject),
        current: current ? `${path.basename(current.file)}:${current.line}` : '',
        watchPaths: [...this.watchPaths],
        lastWriters: Object.fromEntries(this.lastWriters),
        variableCount: receivedVariables.length,
        variables: firstSnapshot ? receivedVariables : changedVariables
      });
    } catch (error) {
      this.view?.webview.postMessage({ type: 'error', message: error.message });
    } finally { this.busy = false; }
  }
  async handle(message) {
    if (message.type === 'references') {
      if (activeProject) {
        this.trackedPaths.add(message.path);
        if (!Object.keys(this.referenceIndex.references || {}).length) {
          this.referenceIndex = readReferenceMap(activeProject);
          this.writerMap = readWriterMap(activeProject);
        }
        await openCrossReferences(activeProject, message.path, this.changeHistory.get(message.path) || []);
      }
      return;
    }
    if (message.type === 'watch') {
      if (this.watchPaths.has(message.path)) this.watchPaths.delete(message.path);
      else this.watchPaths.add(message.path);
      await this.context.globalState.update('plcCodex.watchPaths', [...this.watchPaths]);
      await this.update();
      return;
    }
    if (message.type === 'clearWatch') {
      this.watchPaths.clear();
      await this.context.globalState.update('plcCodex.watchPaths', []);
      await this.update();
      return;
    }
    if (!activeProject || !hasLivePid(activeProject)) return;
    try {
      if (message.type === 'control') {
        const count = Math.min(100, Math.max(1, Number(message.count) || 1));
        for (let index = 0; index < count; index++) await debugControl(message.action, false);
        routinesView?.refresh(lastDebugState);
        await updateLiveEditors();
      } else if (message.type === 'toggle') {
        const variable = this.variables.get(message.path);
        if (!variable || variable.type !== 'BOOL') return;
        const result = await fetchJson(`${projectUrl(activeProject)}/api/set?tag=${encodeURIComponent(variable.path)}&val=${variable.value ? 0 : 1}`);
        if (!result.ok) throw new Error(`a escrita em ${variable.path} foi recusada`);
        this.manualWrites.set(variable.path, Date.now());
      } else if (message.type === 'direct') {
        const variable = this.variables.get(message.path);
        if (!variable) return;
        const result = await fetchJson(`${projectUrl(activeProject)}/api/set?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(message.value)}`);
        if (!result.ok) throw new Error(`a escrita em ${variable.path} foi recusada`);
        this.manualWrites.set(variable.path, Date.now());
      } else if (['write', 'force'].includes(message.type)) {
        const variable = this.variables.get(message.path);
        if (!variable) return;
        const value = await askVariableValue(variable, message.type === 'force' ? 'Forçar continuamente' : 'Escrever uma vez');
        if (value === undefined) return;
        const endpoint = message.type === 'force' ? 'force' : 'set';
        const suffix = message.type === 'force' ? '&enabled=1' : '';
        await fetchJson(`${projectUrl(activeProject)}/api/${endpoint}?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(value)}${suffix}`);
        this.manualWrites.set(variable.path, Date.now());
      } else if (message.type === 'unforce') {
        await fetchJson(`${projectUrl(activeProject)}/api/force?tag=${encodeURIComponent(message.path)}&val=0&enabled=0`);
      }
      await this.update();
    } catch (error) { vscode.window.showErrorMessage(`PLC Codex: ${error.message}`); }
  }
  html() {
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{padding:8px;color:var(--vscode-foreground);font:12px var(--vscode-font-family);background:var(--vscode-sideBar-background)}
button,input{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 7px;border-radius:2px}button:hover{background:var(--vscode-button-hoverBackground)}
.status{padding:7px;border-left:4px solid var(--vscode-errorForeground);background:var(--vscode-textBlockQuote-background);margin-bottom:7px;font-weight:700}.status.online{border-color:var(--vscode-testing-iconPassed)}.project{display:block;font-size:11px;color:var(--vscode-descriptionForeground);font-weight:400;margin-top:2px}.search{width:calc(100% - 14px);margin-bottom:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
details{border-top:1px solid var(--vscode-sideBarSectionHeader-border);padding:4px 0 0 7px}summary{font-weight:600;cursor:pointer}.row{display:grid;grid-template-columns:18px minmax(72px,1fr) 82px auto;gap:5px;align-items:center;padding:3px 2px 3px 4px}.row:hover{background:var(--vscode-list-hoverBackground)}
.name{overflow:hidden;text-overflow:ellipsis}.writer{display:block;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground);font-size:9px;font-weight:400}.value{font-family:var(--vscode-editor-font-family);color:var(--vscode-debugTokenExpression-value)}button.value{padding:2px 5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.value.true{background:var(--vscode-testing-iconPassed);color:#111}input.value{width:74px;padding:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}.forced{color:var(--vscode-editorWarning-foreground);font-weight:bold}.actions button{padding:1px 4px;background:transparent;color:var(--vscode-foreground)}.hidden{display:none}
.watch{border:1px solid var(--vscode-sideBarSectionHeader-border);margin-bottom:7px}.watch-head{display:flex;align-items:center;padding:5px 7px;background:var(--vscode-sideBarSectionHeader-background);font-weight:700}.watch-head span{flex:1}.watch-head button,.star{padding:1px 4px;background:transparent;color:var(--vscode-foreground)}.watch-list{padding:3px 5px}.watch-item{display:grid;grid-template-columns:minmax(80px,1fr) auto;gap:5px;padding:2px;font-family:var(--vscode-editor-font-family)}.watch-item .watch-value{font-weight:700;color:var(--vscode-debugTokenExpression-value)}canvas{display:block;width:100%;height:90px;border-top:1px solid var(--vscode-sideBarSectionHeader-border);background:var(--vscode-editor-background)}.watch-empty{padding:7px;color:var(--vscode-descriptionForeground)}
.watch,.star{display:none}.row{grid-template-columns:minmax(72px,1fr) 82px auto}
</style></head><body>
<div id="status" class="status">● OFFLINE<span class="project">Nenhum projeto ativo</span></div><section class="watch"><div class="watch-head"><span>WATCHLIST E TENDÊNCIA</span><button id="clearWatch" title="Limpar watchlist">Limpar</button></div><div id="watchList" class="watch-list"><div class="watch-empty">Marque uma variável com ☆.</div></div><canvas id="trend"></canvas></section><input id="search" class="search" placeholder="Filtrar DB, objeto ou variável..."><div id="groups"></div>
<script>
const vscode=acquireVsCodeApi(),groups=document.getElementById('groups'),statusEl=document.getElementById('status'),search=document.getElementById('search'),watchList=document.getElementById('watchList'),canvas=document.getElementById('trend');
const rows=new Map(),containers=new Map(),history=new Map();let currentProject='',watchPaths=new Set();
function fmt(v){if(v.type==='BOOL')return v.value?'TRUE':'FALSE';if(v.type==='TIME_MS')return 'T#'+v.value+'ms';const n=Number(v.value);return Number.isFinite(n)?n.toFixed(Number.isInteger(n)?0:2):String(v.value)}
function ensure(v){if(rows.has(v.path))return rows.get(v.path);const parts=(v.treePath||v.path.replaceAll('.','/')).split('/'),leaf=parts.pop();let parent=groups,key='';for(const part of parts){key=key?key+'/'+part:part;let box=containers.get(key);if(!box){box=document.createElement('details');box.open=!key.includes('/');const s=document.createElement('summary');s.textContent=part;box.append(s);parent.append(box);containers.set(key,box)}parent=box}const row=document.createElement('div');row.className='row';row.dataset.path=((v.treePath||'')+' '+v.path).toLowerCase();const star=document.createElement('button');star.className='star';star.title='Adicionar/remover da watchlist';star.onclick=()=>vscode.postMessage({type:'watch',path:v.path});const name=document.createElement('span');name.className='name';name.title=v.path;const label=document.createElement('span');label.textContent=leaf;const writer=document.createElement('small');writer.className='writer';name.append(label,writer);const value=document.createElement(v.type==='BOOL'?'button':'input');value.className='value';if(v.type==='BOOL'){value.onclick=()=>vscode.postMessage({type:'toggle',path:v.path})}else{value.type='number';value.step='any';value.onkeydown=e=>{if(e.key==='Enter'){vscode.postMessage({type:'direct',path:v.path,value:value.value});value.blur()}};value.onchange=()=>vscode.postMessage({type:'direct',path:v.path,value:value.value})}const actions=document.createElement('span');actions.className='actions';for(const [label,type,title] of [['↔','references','Referências e causa'],['🔒','force','Forçar'],['🔓','unforce','Remover força']]){const b=document.createElement('button');b.textContent=label;b.title=title;b.onclick=()=>vscode.postMessage({type,path:v.path});actions.append(b)}row.append(star,name,value,actions);parent.append(row);const item={row,star,value,writer,type:v.type};rows.set(v.path,item);return item}
function renderWatch(vars){const byPath=new Map(vars.map(v=>[v.path,v])),watched=[...watchPaths].map(p=>byPath.get(p)).filter(Boolean);watchList.replaceChildren();if(!watched.length){const e=document.createElement('div');e.className='watch-empty';e.textContent='Marque uma variável com ☆.';watchList.append(e)}for(const v of watched){const row=document.createElement('div');row.className='watch-item';const n=document.createElement('span');n.textContent=v.path;n.title=v.path;const val=document.createElement('span');val.className='watch-value';val.textContent=fmt(v);row.append(n,val);watchList.append(row);const series=history.get(v.path)||[];series.push(Number(v.type==='BOOL'?!!v.value:v.value));if(series.length>120)series.shift();history.set(v.path,series)}drawTrend(watched.slice(0,6))}
function drawTrend(watched){const ratio=devicePixelRatio||1,w=Math.max(180,canvas.clientWidth),h=90;canvas.width=w*ratio;canvas.height=h*ratio;const c=canvas.getContext('2d');c.scale(ratio,ratio);const css=getComputedStyle(document.body),grid=css.getPropertyValue('--vscode-sideBarSectionHeader-border')||'#888',fg=css.getPropertyValue('--vscode-foreground')||'#ddd';c.strokeStyle=grid;c.lineWidth=1;for(let y=22;y<h;y+=22){c.beginPath();c.moveTo(0,y+.5);c.lineTo(w,y+.5);c.stroke()}const colors=['#4b9cd3','#d98e32','#50a66a','#c75c5c','#8d72b8','#2c9c9c'];watched.forEach((v,i)=>{const s=history.get(v.path)||[];if(s.length<2)return;let min=Math.min(...s),max=Math.max(...s);if(min===max){min-=1;max+=1}c.strokeStyle=colors[i];c.lineWidth=1.5;c.beginPath();s.forEach((n,j)=>{const x=j/(119)*w,y=h-5-(n-min)/(max-min)*(h-10);j?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();c.fillStyle=colors[i];c.fillRect(5,5+i*11,7,7);c.fillStyle=fg;c.font='9px sans-serif';c.fillText(v.path.split('.').pop(),15,12+i*11)})}
document.getElementById('clearWatch').onclick=()=>vscode.postMessage({type:'clearWatch'});
window.addEventListener('message',event=>{const m=event.data;if(m.project!==undefined&&m.project!==currentProject){currentProject=m.project;groups.replaceChildren();rows.clear();containers.clear();history.clear()}if(m.type==='offline'){statusEl.className='status';statusEl.innerHTML='● OFFLINE<span class="project">'+(m.project||'Nenhum projeto ativo')+'</span>';for(const item of rows.values()){if(item.type==='BOOL')item.value.textContent='—';else item.value.value=''}return}if(m.type==='error'){statusEl.className='status';statusEl.innerHTML='● SEM COMUNICAÇÃO<span class="project">'+m.message+'</span>';return}if(m.type!=='state')return;statusEl.className='status online';const modes={run:'RODANDO',paused:'PAUSADO',routine:'PASSO DE ROTINA',line:'PASSO DE LINHA'};statusEl.innerHTML='● ONLINE · '+(modes[m.mode]||m.mode)+'<span class="project">'+m.project+' · porta '+m.port+' · scan '+m.scan+' · '+(m.variableCount||0)+' variáveis</span>';for(const v of m.variables){const item=ensure(v);if(v.type==='BOOL'){item.value.textContent=v.value?'TRUE':'FALSE';item.value.className='value '+(v.value?'true ':'')+(v.forced?'forced':'')}else if(document.activeElement!==item.value)item.value.value=String(v.value);item.value.title=v.type+(v.forced?' · FORÇADA':'')}
watchPaths=new Set(m.watchPaths||[]);for(const [p,item] of rows){item.star.textContent=watchPaths.has(p)?'★':'☆';const w=m.lastWriters?.[p];item.writer.textContent=w?('↳ '+w.routine+' · scan '+w.scan):'';item.row.title=w&&w.file?('Última alteração observada; fonte provável: '+w.file+':'+w.line):''}renderWatch(m.variables||[])});
search.addEventListener('input',()=>{const q=search.value.toLowerCase();for(const item of rows.values())item.row.classList.toggle('hidden',!item.row.dataset.path.includes(q))});
</script></body></html>`;
  }
}

async function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('PLC Codex');
  diagnosticCollection = vscode.languages.createDiagnosticCollection('plc-codex');
  liveDecoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  currentLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    borderRadius: '3px',
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    before: { contentText: '▶ ', color: new vscode.ThemeColor('editorWarning.foreground'), fontWeight: 'bold' },
    after: { contentText: '   ◀ PRÓXIMA LINHA', color: new vscode.ThemeColor('editorWarning.foreground'), fontWeight: 'bold' }
  });
  executedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    overviewRulerColor: new vscode.ThemeColor('testing.iconPassed'),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  projectView = new PlcTreeProvider(context);
  routinesView = new RoutinesTreeProvider();
  variablesView = new VariablesTreeProvider();
  runtimeControlView = new RuntimeControlViewProvider(context);
  debugView = new LiveDebugViewProvider(context);
  const tree = vscode.window.createTreeView('plcCodex.projects', { treeDataProvider: projectView });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('plcCodex.runtimeControl', runtimeControlView, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('plcCodex.liveDebug', debugView, { webviewOptions: { retainContextWhenHidden: true } }));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(circuit-board) PLC: selecionar projeto';
  status.command = 'plcCodex.selectProject';
  status.show();

  const refreshUi = () => {
    const running = activeProject ? hasLivePid(activeProject) : false;
    status.text = activeProject
      ? `${running ? '$(debug-start)' : '$(debug-stop)'} PLC: ${path.basename(activeProject)}${running ? ' executando' : ''}`
      : '$(circuit-board) PLC: selecionar projeto';
    status.command = running ? 'plcCodex.stop' : (activeProject ? 'plcCodex.play' : 'plcCodex.selectProject');
    projectView.refresh();
    routinesView.refresh();
    runtimeControlView.update();
  };
  const pidWatcher = vscode.workspace.createFileSystemWatcher('**/.plcsim/runtime.pid');
  pidWatcher.onDidCreate(refreshUi);
  pidWatcher.onDidDelete(refreshUi);
  pidWatcher.onDidChange(refreshUi);
  const liveTimer = setInterval(updateLiveEditors, 500);

  context.subscriptions.push(
    output,
    diagnosticCollection,
    liveDecoration,
    currentLineDecoration,
    executedLineDecoration,
    tree,
    runtimeControlView,
    debugView,
    status,
    pidWatcher,
    { dispose: () => clearInterval(liveTimer) },
    vscode.commands.registerCommand('plcCodex.refresh', async () => { discoveredProjectCache = undefined; await discoverProjects(true); projectView.refresh(); runtimeControlView.update(); }),
    vscode.commands.registerCommand('plcCodex.addProject', async () => {
      try {
        const project = await chooseProjectFolder();
        if (!project) return;
        activeProject = project;
        await context.globalState.update('plcCodex.activeProject', project);
        await context.workspaceState.update('plcCodex.activeProject', project);
        refreshUi(); debugView.update();
        vscode.window.showInformationMessage(`Projeto adicionado: ${projectManifest(project).name}`);
      } catch (error) { vscode.window.showErrorMessage(`Adicionar projeto: ${error.message}`); }
    }),
    vscode.commands.registerCommand('plcCodex.removeProject', async item => {
      const project = typeof item === 'string' ? item : item?.project;
      if (!project) return;
      if (hasLivePid(project)) { vscode.window.showWarningMessage('Pare o PLC antes de removê-lo da lista.'); return; }
      await forgetProject(project); refreshUi(); debugView.update();
    }),
    vscode.commands.registerCommand('plcCodex.configureProject', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (project) await openProjectSettings(project);
    }),
    vscode.commands.registerCommand('plcCodex.editMapping', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (!project) return;
      if (!fs.existsSync(path.join(project, '.plcsim', 'build', 'variables.json'))) {
        vscode.window.showWarningMessage('Execute Build ou Play uma vez para gerar o catálogo completo de variáveis.');
      }
      await openMappingEditor(project);
    }),
    vscode.commands.registerCommand('plcCodex.editPid', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (!project) return;
      if (!fs.existsSync(path.join(project, '.plcsim', 'build', 'variables.json'))) vscode.window.showWarningMessage('Execute Build ou Play uma vez para gerar o catálogo completo de variáveis.');
      await openPidEditor(project);
    }),
    vscode.commands.registerCommand('plcCodex.runScenarios', async item => {
      try {
        const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
        if (project) await openScenarioRunner(project);
      } catch (error) { vscode.window.showErrorMessage(`Cenários: ${error.message}`); }
    }),
    vscode.commands.registerCommand('plcCodex.importReport', async item => {
      try {
        const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
        if (project) await openImportReport(project);
      } catch (error) { vscode.window.showErrorMessage(`Relatório PLCopenXML: ${error.message}`); }
    }),
    vscode.commands.registerCommand('plcCodex.configurePanel', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (!project) return;
      const selected = await vscode.window.showQuickPick([
        { label: 'Bancada de comandos', description: 'IHM, porta, interface e campo', file: 'painel.json' },
        { label: 'Visão P&ID', description: 'Tags e posições sobre o processo', file: 'pid.json' }
      ], { title: 'Qual visualização deseja configurar?' });
      if (!selected) return;
      const target = path.join(project, 'panel', selected.file);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(context.extensionPath, 'template', 'projeto-plc', 'panel', selected.file), target);
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
      vscode.window.showInformationMessage(selected.file === 'pid.json' ? 'Edite tag, x, y e precision; depois recarregue o P&ID.' : 'Edite area, tag, kind, writable e precision; depois recarregue Comandos.');
    }),
    vscode.commands.registerCommand('plcCodex.newProject', async () => {
      try {
        const target = await chooseNewProjectTarget('Pasta onde o novo projeto PLC será criado');
        if (!target) return;
        copyProjectTemplate(context, target);
        const name = path.basename(target).replace(/"/g, '');
        const manifest = fs.readFileSync(path.join(target, 'plc.toml'), 'utf8').replace(/^name\s*=.*$/m, `name = "${name}"`);
        fs.writeFileSync(path.join(target, 'plc.toml'), manifest);
        activeProject = target;
        await rememberProject(target);
        await context.workspaceState.update('plcCodex.activeProject', target);
        await context.globalState.update('plcCodex.activeProject', target);
        refreshUi();
        vscode.window.showInformationMessage(`Projeto PLC criado: ${name}`);
      } catch (error) { vscode.window.showErrorMessage(`Novo projeto: ${error.message}`); }
    }),
    vscode.commands.registerCommand('plcCodex.importXml', async () => {
      try {
        const picked = await vscode.window.showOpenDialog({ title: 'Selecione o PLCopenXML exportado pelo fabricante', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { PLCopenXML: ['xml'] }, openLabel: 'Importar XML' });
        if (!picked?.length) return;
        const target = await chooseNewProjectTarget('Pasta onde o projeto importado será criado');
        if (!target) return;
        copyProjectTemplate(context, target);
        for (const folder of ['types','functions','blocks','globals','programs','routines']) {
          const full = path.join(target, folder);
          fs.rmSync(full, { recursive: true, force: true });
          fs.mkdirSync(full, { recursive: true });
        }
        fs.writeFileSync(path.join(target, 'panel', 'painel.json'), JSON.stringify({
          version: 1,
          title: `${path.basename(target)} — mapeamento pendente`,
          display: { realPrecision: 2, theme: 'light' },
          areas: { monitoring: [], ihm: [], panel: [], interface: [], field: [] }
        }, null, 2) + '\n');
        fs.writeFileSync(path.join(target, 'panel', 'pid.json'), JSON.stringify({
          version: 1,
          title: `${path.basename(target)} — P&ID pendente`,
          display: { realPrecision: 2, theme: 'light' },
          items: []
        }, null, 2) + '\n');
        output.show(true);
        output.appendLine(`\n=== IMPORTAR PLCopenXML: ${picked[0].fsPath} ===`);
        await runProcess('python3', [path.join(target, 'runtime', 'import_plcopenxml.py'), picked[0].fsPath, target, '--active'], target);
        const imported = JSON.parse(fs.readFileSync(path.join(target, 'plcopen', 'manifest.json'), 'utf8'));
        const main = imported.pous.find(item => item.name.toLowerCase().includes('main') && item.type === 'program') || imported.pous.find(item => item.type === 'program');
        let manifest = fs.readFileSync(path.join(target, 'plc.toml'), 'utf8').replace(/^name\s*=.*$/m, `name = "${path.basename(target).replace(/"/g, '')}"`);
        if (main) manifest = manifest.replace(/^program\s*=.*$/m, `program = "${main.name}"`);
        fs.writeFileSync(path.join(target, 'plc.toml'), manifest);
        activeProject = target;
        await rememberProject(target);
        await context.workspaceState.update('plcCodex.activeProject', target);
        await context.globalState.update('plcCodex.activeProject', target);
        refreshUi();
        const diagnostics = imported.diagnostics || {};
        const pending = (diagnostics.unresolvedTypes?.length || 0) + (diagnostics.unresolvedBlocks?.length || 0);
        await openImportReport(target);
        const summary = `${imported.pous.length} POUs em ST, ${imported.dataTypes.length} DUTs, ${imported.globalVars.length} GVLs`;
        if (pending) vscode.window.showWarningMessage(`XML importado: ${summary}. ${pending} dependências pendentes; consulte o relatório aberto.`);
        else vscode.window.showInformationMessage(`XML importado e pronto: ${summary}.`);
      } catch (error) { vscode.window.showErrorMessage(`Importação cancelada: ${error.message}`); output.show(true); }
    }),
    vscode.commands.registerCommand('plcCodex.refreshVariables', () => variablesView.refresh()),
    vscode.commands.registerCommand('plcCodex.debugRun', async () => { try { await debugControl('run'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    vscode.commands.registerCommand('plcCodex.debugPause', async () => { try { await debugControl('pause'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    vscode.commands.registerCommand('plcCodex.debugStepScan', async () => { try { await debugControl('scan'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    vscode.commands.registerCommand('plcCodex.debugLineMode', async () => { try { await debugControl('line'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    vscode.commands.registerCommand('plcCodex.debugStepLine', async () => { try { await debugControl('next'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    vscode.commands.registerCommand('plcCodex.openRoutine', async (file, line) => {
      if (activeProject && file) await openSourceLocation(activeProject, file, line || 1);
    }),
    vscode.commands.registerCommand('plcCodex.selectProject', async () => {
      await chooseProject(context, true);
      refreshUi();
    }),
    vscode.commands.registerCommand('plcCodex.activateProject', async project => {
      activeProject = project;
      await context.workspaceState.update('plcCodex.activeProject', project);
      await context.globalState.update('plcCodex.activeProject', project);
      refreshUi();
      variablesView.refresh();
      debugView.update();
    }),
    vscode.commands.registerCommand('plcCodex.playProject', async project => {
      project = typeof project === 'string' ? project : project?.project;
      if (project && project !== activeProject) {
        activeProject = project;
        await context.workspaceState.update('plcCodex.activeProject', project);
        await context.globalState.update('plcCodex.activeProject', project);
      }
      await vscode.commands.executeCommand('plcCodex.play');
    }),
    vscode.commands.registerCommand('plcCodex.openProjectPanel', async project => {
      project = typeof project === 'string' ? project : project?.project;
      if (project && project !== activeProject) {
        activeProject = project;
        await context.workspaceState.update('plcCodex.activeProject', project);
        await context.globalState.update('plcCodex.activeProject', project);
        refreshUi();
      }
      await vscode.commands.executeCommand('plcCodex.openPanel');
    }),
    vscode.commands.registerCommand('plcCodex.openProjectPid', async project => {
      project = typeof project === 'string' ? project : project?.project;
      if (project && project !== activeProject) {
        activeProject = project;
        await context.workspaceState.update('plcCodex.activeProject', project);
        await context.globalState.update('plcCodex.activeProject', project);
        refreshUi();
      }
      await vscode.commands.executeCommand('plcCodex.openPid');
    }),
    vscode.commands.registerCommand('plcCodex.build', async () => {
      const root = await requireProject(context);
      if (!root) return;
      output.show(true);
      output.appendLine(`\n=== BUILD: ${root} ===`);
      const result = await buildProject(root);
      if (result.code === 0) {
        publishBuildDiagnostics(root, result.transcript);
        vscode.window.showInformationMessage('PLC compilado com sucesso. Nenhum erro IEC encontrado.');
      } else await showBuildFailure(root, result.transcript);
    }),
    vscode.commands.registerCommand('plcCodex.play', async () => {
      const root = await requireProject(context);
      if (!root) return;
      if (hasLivePid(root)) {
        vscode.window.showWarningMessage('O PLC já está executando.');
        refreshUi();
        return;
      }
      if (startingProjects.has(root)) {
        vscode.window.showInformationMessage('Este PLC ainda está compilando. Aguarde a indicação “executando”.');
        return;
      }
      startingProjects.add(root);
      output.show(true);
      output.appendLine(`\n=== PLAY: ${root} ===`);
      output.appendLine('Validando o projeto antes de iniciar o runtime...');
      const buildResult = await buildProject(root);
      startingProjects.delete(root);
      if (buildResult.code !== 0) {
        await showBuildFailure(root, buildResult.transcript);
        refreshUi();
        return;
      }
      publishBuildDiagnostics(root, buildResult.transcript);
      const ports = await availableProjectPorts(root);
      const child = runRuntimeDetached(root, code => {
        runtimes.delete(root);
        output.appendLine(`Runtime encerrado (código ${code}).`);
        if (code && code !== 0) {
          vscode.window.showErrorMessage(`O runtime PLC encerrou com erro ${code}. Consulte a saída “PLC Codex”.`);
          output.show(true);
        }
        refreshUi();
      }, { PLC_CODEX_PORT: String(ports.panel), PLC_CODEX_PID_PORT: String(ports.pid), PLC_CODEX_SKIP_BUILD: '1' });
      runtimes.set(root, child);
      refreshUi();
      try {
        await waitForServer(projectUrl(root), child);
        vscode.window.showInformationMessage(`${projectManifest(root).name} executando: Comandos :${ports.panel} · P&ID :${ports.pid}.`);
        refreshUi();
        await variablesView.refresh();
        await openEquipment(root);
      } catch (error) {
        vscode.window.showErrorMessage(`PLC Codex: ${error.message}`);
        output.show(true);
      }
    }),
    vscode.commands.registerCommand('plcCodex.stop', async item => {
      const requested = typeof item === 'string' ? item : item?.project;
      const root = requested || await requireProject(context);
      if (!root) return;
      output.appendLine(`\n=== STOP: ${root} ===`);
      runScript(root, 'stop.sh', code => {
        if (code === 0) vscode.window.showInformationMessage('PLC parado.');
        else vscode.window.showErrorMessage(`Não foi possível parar o PLC (código ${code}).`);
        refreshUi();
        variablesView.refresh();
      });
      runtimes.delete(root);
      refreshUi();
    }),
    vscode.commands.registerCommand('plcCodex.stopAll', async () => {
      const running = (await discoverProjects()).filter(hasLivePid);
      if (!running.length) { vscode.window.showInformationMessage('Nenhum PLC está executando.'); return; }
      for (const root of running) {
        output.appendLine(`\n=== STOP ALL: ${root} ===`);
        runScript(root, 'stop.sh', () => refreshUi());
        runtimes.delete(root);
      }
      vscode.window.showInformationMessage(`Parando ${running.length} PLC${running.length > 1 ? 's' : ''}.`);
      refreshUi(); debugView.update();
    }),
    vscode.commands.registerCommand('plcCodex.openPanel', async () => {
      const root = await requireProject(context);
      if (!root) return;
      if (!hasLivePid(root)) {
        await vscode.commands.executeCommand('plcCodex.play');
        if (!hasLivePid(root)) return;
      }
      try {
        await waitForServer(projectUrl(root), runtimes.get(root) || { exitCode: null });
      } catch (error) {
        vscode.window.showErrorMessage(`PLC Codex: ${error.message}`);
        return;
      }
      await openEquipment(root);
    }),
    vscode.commands.registerCommand('plcCodex.openPid', async () => {
      const root = await requireProject(context);
      if (!root) return;
      if (!hasLivePid(root)) {
        await vscode.commands.executeCommand('plcCodex.play');
        if (!hasLivePid(root)) return;
      }
      try {
        await waitForServer(projectPidUrl(root), runtimes.get(root) || { exitCode: null });
      } catch (error) {
        vscode.window.showErrorMessage(`PLC Codex P&ID: ${error.message}`);
        return;
      }
      await openPid(root);
    }),
    vscode.commands.registerCommand('plcCodex.writeVariable', async variable => {
      if (!activeProject || !hasLivePid(activeProject)) return;
      const value = await askVariableValue(variable, 'Escrever uma vez');
      if (value === undefined) return;
      try {
        const result = await fetchJson(`${projectUrl(activeProject)}/api/set?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(value)}`);
        if (!result.ok) throw new Error('o runtime recusou a escrita');
        await variablesView.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Não foi possível alterar ${variable.path}: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand('plcCodex.forceVariable', async variable => {
      if (!activeProject || !hasLivePid(activeProject)) return;
      const value = await askVariableValue(variable, 'Forçar continuamente');
      if (value === undefined) return;
      try {
        const result = await fetchJson(`${projectUrl(activeProject)}/api/force?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(value)}&enabled=1`);
        if (!result.ok) throw new Error('o runtime recusou a força');
        await variablesView.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Não foi possível forçar ${variable.path}: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand('plcCodex.unforceVariable', async variable => {
      if (!activeProject || !hasLivePid(activeProject)) return;
      try {
        const result = await fetchJson(`${projectUrl(activeProject)}/api/force?tag=${encodeURIComponent(variable.path)}&val=0&enabled=0`);
        if (!result.ok) throw new Error('o runtime recusou a remoção');
        await variablesView.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`Não foi possível remover a força de ${variable.path}: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand('plcCodex.exportXml', async item => {
      const requested = typeof item === 'string' ? item : item?.project;
      const root = requested || await requireProject(context);
      if (!root) return;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plcopen', 'manifest.json'), 'utf8'));
        const diagnostics = manifest.diagnostics || {};
        const pending = [...(diagnostics.unresolvedTypes || []), ...(diagnostics.unresolvedBlocks || [])];
        if (pending.length) {
          const choice = await vscode.window.showWarningMessage(
            `Este projeto possui ${pending.length} dependências de simulação pendentes. Elas serão preservadas como referências no XML.`,
            { modal: true }, 'Exportar mesmo assim', 'Abrir relatório'
          );
          if (choice === 'Abrir relatório') {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root, 'plcopen', 'IMPORT_REPORT.md')));
            return;
          }
          if (choice !== 'Exportar mesmo assim') return;
        }
      } catch (_) {}
      output.show(true);
      output.appendLine(`\n=== EXPORTAR PLCopenXML: ${root} ===`);
      runScript(root, 'export.sh', code => {
        if (code === 0) vscode.window.showInformationMessage('PLCopenXML e ST consolidado gerados na pasta export/.');
        else vscode.window.showErrorMessage(`Falha na exportação PLCopenXML (código ${code}).`);
      });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { discoveredProjectCache = undefined; projectView.refresh(); }),
    vscode.window.onDidChangeActiveTextEditor(() => updateLiveEditors()),
    { dispose: () => { for (const child of runtimes.values()) if (child.exitCode === null) child.kill('SIGTERM'); } }
  );

  await chooseProject(context);
  refreshUi();
}

function deactivate() {
  for (const child of runtimes.values()) if (child.exitCode === null) child.kill('SIGTERM');
}

module.exports = { activate, deactivate };
