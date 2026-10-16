const vscode = require('vscode');
const cp = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { t, language, webviewTranslator, languageEnv } = require('./i18n');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 6 });

// Must work on: Linux/macOS (bash from PATH, no change at all), Windows with
// WSL2 enabled (WSL bash works and can stay as a fallback) and Windows WITHOUT
// WSL2 (the most common failure): many installations have
// C:\Windows\System32\bash.exe (the WSL launcher) before Git's bash.exe in the
// system PATH, and on Windows spawn('bash') without shell:true resolves in
// exactly that PATH order. If WSL2 is not enabled (virtualization off) it fails
// immediately and Build/Play never runs the script, even when Git is installed
// and working. So on Windows we resolve an absolute path to Git's bash.exe
// BEFORE falling back to plain 'bash' from PATH (which only works when WSL is
// enabled, or when Git happens to come first in PATH). `where git` finds Git
// in any install location (not only the default), including portable Git;
// HPLC_BASH (or the legacy PLC_CODEX_BASH) lets the user point to any bash.
function resolveBashCommand() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  for (const name of ['HPLC_BASH', 'PLC_CODEX_BASH']) if (process.env[name]) candidates.push(process.env[name]);
  try {
    const gitExe = cp.execSync('where git', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (gitExe) {
      // .../Git/cmd/git.exe or .../Git/bin/git.exe -> .../Git/bin/bash.exe
      candidates.push(path.join(path.dirname(gitExe), '..', 'bin', 'bash.exe'));
    }
  } catch (_) {}
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  );
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return path.resolve(candidate); } catch (_) {}
  }
  return 'bash'; // last resort: system PATH (works when WSL2 is enabled)
}
const BASH_CMD = resolveBashCommand();

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
let workbenchLayout = false;
let followExecution = false;
let followedLocation;
let liveCode;
const { prepareBuildScript } = require('./workbench-build');
const { createLiveCode } = require('./live-code');
const { prepareRunScript } = require('./workbench-run');
const equipmentPanels = new Map();

async function openWorkbench(item) {
  const requested = typeof item === 'string' ? item : item?.project;
  const project = requested || await requireProject(extensionContext);
  if (!project) return;
  if (!fs.existsSync(path.join(project, '.plcsim/build/project.st'))) {
    vscode.window.showInformationMessage(t('workbench.playFirst'));
    return;
  }
  await openSimulationViews(project);
}

// 'below' | 'sideBySide'. Reads hplc.simulationLayout when the user set it,
// otherwise the legacy hplc.layoutSimulacao ('embaixo' | 'lado a lado').
function simulationLayout() {
  const config = vscode.workspace.getConfiguration('hplc');
  const info = config.inspect?.('simulationLayout');
  const explicit = info && [info.globalValue, info.workspaceValue, info.workspaceFolderValue].some(v => v !== undefined);
  let value = explicit ? config.get('simulationLayout') : undefined;
  if (value === undefined) value = config.get('layoutSimulacao') ?? config.get('simulationLayout'); // legacy setting fallback
  return value === 'sideBySide' || value === 'lado a lado' ? 'sideBySide' : 'below';
}

async function openSimulationViews(project) {
  // HMI in group 1 and live code in group 2, one below the other by default.
  // The layout is reapplied on every Play: if the user closed one of the
  // groups, VS Code would open the second one beside it. With more than two
  // groups the arrangement belongs to the user and is left as is.
  if (vscode.window.tabGroups.all.length <= 2) {
    const sideBySide = simulationLayout() === 'sideBySide';
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: sideBySide ? 0 : 1, groups: [{ size: 0.5 }, { size: 0.5 }]
    });
  }
  workbenchLayout = true;
  await openEquipment(project);
  liveCode.open(project);
  await vscode.commands.executeCommand('workbench.action.closePanel');
}

async function openEquipmentView(project, kind) {
  const key = project;
  const urls = await Promise.all([projectUrl(project), projectPidUrl(project)].map(async url =>
    (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true)));
  let panel = equipmentPanels.get(key);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('hplc.equipment', t('equipment.title', { name: projectManifest(project).name }),
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    equipmentPanels.set(key, panel);
    panel.onDidDispose(() => equipmentPanels.delete(key));
    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'ui-settings') {
          try {
            let data;
            if (message.action === 'get-project-settings') data = projectSettingsSnapshot(project);
            else if (message.action === 'save-project-settings') data = saveProjectSettings(project, message.values);
            else throw new Error(t('equipment.unknownSettingsAction'));
            panel.webview.postMessage({ type: 'ui-settings-result', requestId: message.requestId, frame: message.frame, data });
          } catch (error) { panel.webview.postMessage({ type: 'ui-settings-result', requestId: message.requestId, frame: message.frame, error: error.message }); }
          return;
        }
        if (message.type === 'openBrowser') {
          const local = vscode.Uri.parse(message.kind === 'pid' ? projectPidUrl(project) : projectUrl(project));
          const external = await vscode.env.asExternalUri(local);
          await vscode.env.openExternal(external);
          return;
        }
        if (message.type === 'start') await vscode.commands.executeCommand('hplc.playProject', project);
        if (message.type === 'refresh' || message.type === 'start') await openEquipmentView(project, 'panel');
      } catch (error) { vscode.window.showErrorMessage(error.message); }
    });
  } else panel.reveal(vscode.ViewColumn.One, true);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const nonce = require('crypto').randomBytes(16).toString('hex');
  const origins = [...new Set(urls.map(url => new URL(url).origin))].join(' ');
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escape(origins)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body{height:100%;margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}body{display:flex;flex-direction:column}nav{display:flex;gap:8px;align-items:center;padding:7px;border-bottom:1px solid var(--vscode-panel-border)}button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:6px 12px;cursor:pointer}button[aria-selected=true]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}span{flex:1}iframe{flex:1;width:100%;border:0}iframe[hidden]{display:none}.offline{padding:24px;line-height:1.7}</style></head><body>
<nav><button id="panel" aria-selected="${kind !== 'pid'}">${t('equipment.hmi')}</button><button id="pid" aria-selected="${kind === 'pid'}">P&ID</button><span>${escape(projectManifest(project).name)}</span><button id="browser" title="${t('equipment.openBrowserTooltip')}">${t('equipment.openBrowser')}</button><button id="refresh">${t('common.refresh')}</button></nav>
${hasLivePid(project) ? urls.map((url,i) => `<iframe title="${i ? 'P&ID' : t('equipment.hmi')}" id="frame-${i ? 'pid' : 'panel'}" src="${escape(url)}" ${(kind === 'pid') !== Boolean(i) ? 'hidden' : ''}></iframe>`).join('') : `<div class="offline">${t('equipment.offline')}<br><button id="start">${t('equipment.start')}</button></div>`}
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let selectedView=${JSON.stringify(kind === 'pid' ? 'pid' : 'panel')};
function navigate(id){selectedView=id;for(const tab of ['panel','pid']){document.getElementById(tab).setAttribute('aria-selected',String(tab===id));const frame=document.getElementById('frame-'+tab);if(frame)frame.hidden=tab!==id}}
for(const id of ['panel','pid'])document.getElementById(id).onclick=()=>navigate(id);
window.addEventListener('message',event=>{
 const message=event.data;
 if(message?.channel==='plc-ui'){
  const frame=['panel','pid'].map(id=>document.getElementById('frame-'+id)).find(frame=>frame&&frame.contentWindow===event.source);
  if(!frame||event.origin!==new URL(frame.src).origin||typeof message.requestId!=='string')return;
  if(message.action==='navigate'&&['panel','pid'].includes(message.values?.view)){navigate(message.values.view);frame.contentWindow.postMessage({channel:'plc-ui-result',requestId:message.requestId,data:{ok:true}},event.origin);return}
  if(['get-project-settings','save-project-settings'].includes(message.action))vscode.postMessage({type:'ui-settings',frame:frame.id,requestId:message.requestId,action:message.action,values:message.values});
 }else if(message?.type==='ui-settings-result'){
  const frame=document.getElementById(message.frame);if(frame)frame.contentWindow.postMessage({channel:'plc-ui-result',requestId:message.requestId,data:message.data,error:message.error},new URL(frame.src).origin);
 }
});
document.getElementById('browser').onclick=()=>vscode.postMessage({type:'openBrowser',kind:selectedView});
document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});const start=document.getElementById('start');if(start)start.onclick=()=>vscode.postMessage({type:'start'});
</script></body></html>`;
}


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
  throw new Error(t('ports.noneFree', { from: preferred, to: preferred + 99 }));
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
  const saved = extensionContext?.globalState.get('hplc.projects', []) || [];
  const projects = new Map();
  for (const project of [...saved, ...discoverLocalProjects(), ...(activeProject ? [activeProject] : [])]) {
    const canonical = canonicalProject(project);
    if (fs.existsSync(path.join(canonical, 'plc.toml'))) projects.set(canonical, canonical);
  }
  const result = [...projects.values()].sort();
  if (result.length !== saved.length || result.some((project,index) => project !== saved[index])) {
    await extensionContext?.globalState.update('hplc.projects', result);
  }
  discoveredProjectCache = result;
  return result;
}

async function rememberProject(project) {
  project = canonicalProject(project);
  const projects = extensionContext.globalState.get('hplc.projects', []);
  const normalized = [...new Set(projects.map(canonicalProject))];
  if (!normalized.includes(project)) normalized.push(project);
  await extensionContext.globalState.update('hplc.projects', normalized);
  discoveredProjectCache = undefined;
  return project;
}

async function forgetProject(project) {
  const canonical = canonicalProject(project);
  const projects = extensionContext.globalState.get('hplc.projects', []).filter(item => canonicalProject(item) !== canonical);
  await extensionContext.globalState.update('hplc.projects', projects);
  discoveredProjectCache = undefined;
  if (activeProject && canonicalProject(activeProject) === canonical) activeProject = undefined;
}

// Copies the extension's runtime (template/plc-project/runtime) into a project
// that only has sources. Existing files are never overwritten.
function installRuntime(project) {
  const source = path.join(extensionContext.extensionPath, 'template', 'plc-project', 'runtime');
  if (!fs.existsSync(source)) throw new Error(t('template.missing'));
  fs.cpSync(source, path.join(project, 'runtime'), {
    recursive: true, force: false, errorOnExist: false,
    filter: item => path.basename(item) !== '__pycache__'
  });
}

async function chooseProjectFolder() {
  const selected = await vscode.window.showOpenDialog({ title: t('addProject.dialogTitle'), canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: t('addProject.openLabel') });
  if (!selected?.length) return undefined;
  const project = canonicalProject(selected[0].fsPath);
  if (!fs.existsSync(path.join(project, 'plc.toml'))) throw new Error(t('addProject.invalid', { missing: 'plc.toml' }));
  const missing = ['runtime/run.sh', 'runtime/stop.sh'].filter(item => !fs.existsSync(path.join(project, item)));
  if (missing.length) {
    // Sources only (e.g. an example project): offer to install the HPLC runtime.
    const install = t('addProject.installRuntime');
    const choice = await vscode.window.showWarningMessage(t('addProject.noRuntime', { missing: missing.join(', ') }),
      { modal: true, detail: t('addProject.noRuntimeDetail', { folder: project }) }, install);
    if (choice !== install) return undefined;
    installRuntime(project);
  }
  return rememberProject(project);
}

async function chooseProject(context, forceChoice = false) {
  const projects = await discoverProjects();
  if (!projects.length) {
    vscode.window.showErrorMessage(t('project.noneFound'));
    return undefined;
  }

  const saved = context.globalState.get('hplc.activeProject') || context.workspaceState.get('hplc.activeProject');
  if (!forceChoice && saved && projects.includes(saved)) {
    activeProject = saved;
    return saved;
  }
  if (!forceChoice && projects.length === 1) {
    activeProject = projects[0];
    await context.workspaceState.update('hplc.activeProject', activeProject);
    await context.globalState.update('hplc.activeProject', activeProject);
    return activeProject;
  }

  const roots = vscode.workspace.workspaceFolders || [];
  const items = projects.map(project => ({
    label: `$(circuit-board) ${path.basename(project)}`,
    description: roots.length ? vscode.workspace.asRelativePath(project) : project,
    project
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: t('project.selectTitle'),
    placeHolder: t('project.selectPlaceholder')
  });
  if (!selected) return undefined;
  activeProject = selected.project;
  await context.workspaceState.update('hplc.activeProject', activeProject);
  await context.globalState.update('hplc.activeProject', activeProject);
  projectView?.refresh();
  return activeProject;
}

async function requireProject(context) {
  if (activeProject) return activeProject;
  return chooseProject(context);
}


// The extension used to be called PLC Codex. The old ids (plcCodex.*) remain as
// aliases of the new ones (hplc.*): the control bridge, keybindings and scripts
// of other projects call the old names. If the old extension is still
// installed it already owns those ids; the alias is skipped instead of failing.
const LEGACY_COMMAND_PREFIX = 'plcCodex.';
const legacyWarned = new Set();
function registerCommand(id, handler) {
  const disposables = [vscode.commands.registerCommand(id, handler)];
  if (id.startsWith('hplc.')) {
    const legacy = LEGACY_COMMAND_PREFIX + id.slice('hplc.'.length);
    try {
      disposables.push(vscode.commands.registerCommand(legacy, (...args) => {
        if (!legacyWarned.has(legacy)) {
          legacyWarned.add(legacy);
          output?.appendLine(t('commands.legacyUsed', { legacy, id }));
        }
        return vscode.commands.executeCommand(id, ...args);
      }));
    } catch (error) {
      output?.appendLine(t('commands.legacyUnavailable', { legacy, error: error.message }));
    }
  }
  return vscode.Disposable.from(...disposables);
}

// Environment for every child process: HPLC_LANG tells python/bash scripts
// which language to use for user-visible text.
function childEnv(extra = {}) {
  return { ...process.env, ...extra, ...languageEnv() };
}

function runScript(root, script, onExit, extraEnv = {}) {
  const child = cp.spawn(BASH_CMD, [path.join(root, 'runtime', script)], {
    cwd: root,
    env: childEnv(extraEnv)
  });
  child.stdout.on('data', data => output.append(data.toString()));
  child.stderr.on('data', data => output.append(data.toString()));
  child.on('error', error => {
    output.appendLine(t('process.error', { error: error.message }));
    vscode.window.showErrorMessage(`HPLC: ${error.message}`);
  });
  child.on('exit', code => onExit?.(code));
  return child;
}

function runRuntimeDetached(root, onExit, extraEnv = {}) {
  const logPath = path.join(root, '.plcsim', 'runtime.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const driver = prepareRunScript(root, extensionContext.extensionPath, { panel: extraEnv.HPLC_PORT, pid: extraEnv.HPLC_PID_PORT });
  const child = cp.spawn(BASH_CMD, [driver], {
    cwd: root,
    env: childEnv({ ...extraEnv, HPLC_PROJECT_ROOT: root }),
    detached: true,
    stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  child.on('error', error => {
    output.appendLine(t('runtime.startError', { error: error.message }));
    vscode.window.showErrorMessage(`HPLC: ${error.message}`);
  });
  child.on('exit', code => onExit?.(code));
  child.unref();
  return child;
}

function runProcess(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, env: childEnv(extraEnv) });
    child.stdout.on('data', data => output.append(data.toString()));
    child.stderr.on('data', data => output.append(data.toString()));
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(t('process.exitCode', { command: path.basename(command), code }))));
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
      if (external) message = t('build.externalDependency', { name: external, message });
    } catch (_) {}
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(Math.max(0, lineNumber - 1), Math.max(0, column - 1), Math.max(0, lineNumber - 1), Math.max(1, column)),
      message,
      (match[5] || '').toLowerCase() === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'HPLC / IEC ST';
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
  const located = result.count ? t('build.locatedErrors', { count: result.count }) : t('build.unlocatedError');
  const pending = result.externalCount ? ` · ${t('build.pendingExternal', { count: result.externalCount })}` : '';
  vscode.window.showErrorMessage(t('build.failed', { located, pending }));
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
    let script;
    try { script = prepareBuildScript(project); }
    catch (error) { resolve({ code: -1, transcript: error.message }); return; }
    const child = cp.spawn(BASH_CMD, [script], { cwd: project, env: childEnv({
      HPLC_PROJECT_ROOT: project,
      HPLC_INSTRUMENT_SCRIPT: path.join(extensionContext.extensionPath, 'scripts/instrument_strucpp.py')
    }) });
    const receive = data => { const value = data.toString(); transcript += value; output.append(value); };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.on('error', error => { transcript += error.message; output.appendLine(t('process.error', { error: error.message })); resolve({ code: -1, transcript }); });
    child.on('exit', code => resolve({ code, transcript }));
  });
}

// tests/scenarios.yaml, or the legacy tests/cenarios.yaml of older projects.
function scenarioFile(project) {
  const current = path.join(project, 'tests', 'scenarios.yaml');
  const legacy = path.join(project, 'tests', 'cenarios.yaml'); // legacy
  if (fs.existsSync(current)) return current;
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

// panel/panel.json, or the legacy panel/painel.json of older projects.
function panelConfigFile(project) {
  const current = path.join(project, 'panel', 'panel.json');
  const legacy = path.join(project, 'panel', 'painel.json'); // legacy
  if (fs.existsSync(current)) return current;
  if (fs.existsSync(legacy)) return legacy;
  return current;
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
  const lines = ['name: "Project tests"', 'scenarios:'];
  for (const scenario of scenarios) {
    lines.push(`  - name: ${JSON.stringify(String(scenario.name || 'New scenario'))}`, '    steps:');
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
  const file = scenarioFile(project);
  if (!fs.existsSync(file)) saveScenarioFile(file, []);
  const scenarios = parseScenarioFile(file), catalog = projectVariableCatalog(project);
  const panel = vscode.window.createWebviewPanel('hplc.scenarioEditor', t('scenarioEditor.panelTitle', { name: projectManifest(project).name }), vscode.ViewColumn.One, { enableScripts: true });
  const data = JSON.stringify({ scenarios, catalog }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><style>
body{margin:0;font:12px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}header{height:50px;display:flex;align-items:center;gap:7px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border)}h1{font-size:16px;flex:1}button{border:0;border-radius:3px;padding:7px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}main{display:grid;grid-template-columns:260px 1fr;height:calc(100vh - 51px)}aside{border-right:1px solid var(--vscode-panel-border);padding:10px;overflow:auto}.content{padding:16px;overflow:auto}.scenario{display:flex;align-items:center;gap:5px;width:100%;margin-bottom:4px;text-align:left}.scenario span{flex:1;overflow:hidden;text-overflow:ellipsis}.scenario.active{outline:2px solid var(--vscode-focusBorder)}input,select{padding:7px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}.title{display:flex;gap:7px;margin-bottom:14px}.title input{flex:1;font-size:15px;font-weight:700}.step{display:grid;grid-template-columns:120px minmax(220px,1fr) 160px auto;gap:7px;padding:7px;border-bottom:1px solid var(--vscode-panel-border)}.help{padding:10px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-focusBorder);margin-bottom:12px;color:var(--vscode-descriptionForeground)}.empty{padding:30px;text-align:center;color:var(--vscode-descriptionForeground)}#result{color:var(--vscode-testing-iconPassed)}@media(max-width:760px){main{grid-template-columns:1fr;height:auto}aside{border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.step{grid-template-columns:1fr}}
</style></head><body><header><h1>${t('scenarioEditor.title')}</h1><span id="result"></span><button id="raw" class="secondary">${t('scenarioEditor.openYaml')}</button><button id="save">${t('common.save')}</button></header><main><aside><button id="add">${t('scenarioEditor.add')}</button><div id="scenarios"></div></aside><section class="content"><div class="help">${t('scenarioEditor.help')}</div><div id="empty" class="empty">${t('scenarioEditor.empty')}</div><div id="form" hidden><div class="title"><input id="name" placeholder="${t('scenarioEditor.namePlaceholder')}"><button id="run">${t('scenarioEditor.runNow')}</button><button id="remove" class="secondary">${t('common.delete')}</button></div><div id="steps"></div><button id="addStep" class="secondary">${t('scenarioEditor.addStep')}</button></div></section></main><datalist id="tags"></datalist><script>
${webviewTranslator(['scenarioEditor.', 'common.delete'])}
const vscode=acquireVsCodeApi(),data=${data},scenarios=data.scenarios,$=id=>document.getElementById(id);let selected=scenarios.length?0:-1;for(const v of data.catalog){const o=document.createElement('option');o.value=v.path;$('tags').append(o)}
function renderList(){const root=$('scenarios');root.replaceChildren();scenarios.forEach((s,i)=>{const b=document.createElement('button');b.className='scenario secondary'+(i===selected?' active':'');const n=document.createElement('span');n.textContent=s.name||tr('scenarioEditor.unnamed');const c=document.createElement('small');c.textContent=tr('scenarioEditor.steps',{count:(s.steps||[]).length});b.append(n,c);b.onclick=()=>{selected=i;render()};root.append(b)})}
function renderSteps(){const root=$('steps');root.replaceChildren();const s=scenarios[selected];for(const [i,step] of (s.steps||[]).entries()){const row=document.createElement('div');row.className='step';const action=document.createElement('select');for(const a of ['set','pulse','wait','expect']){const o=document.createElement('option');o.value=a;o.textContent=a;o.selected=step.action===a;action.append(o)}const tag=document.createElement('input');tag.setAttribute('list','tags');tag.placeholder=tr('scenarioEditor.tagPlaceholder');tag.value=step.tag||'';const value=document.createElement('input');value.placeholder=step.action==='wait'?tr('scenarioEditor.msPlaceholder'):tr('scenarioEditor.valuePlaceholder');value.value=step.value??'';tag.hidden=step.action==='wait';value.hidden=step.action==='pulse';const remove=document.createElement('button');remove.className='secondary';remove.textContent=tr('common.delete');action.onchange=()=>{step.action=action.value;if(step.action==='wait'){delete step.tag;step.value=100}else if(step.action==='pulse'){step.tag=step.tag||'';delete step.value}else{step.tag=step.tag||'';step.value=false}renderSteps()};tag.oninput=()=>step.tag=tag.value;value.oninput=()=>{const v=value.value.trim();step.value=/^(true|false)$/i.test(v)?v.toLowerCase()==='true':v!==''&&!Number.isNaN(Number(v))?Number(v):v};remove.onclick=()=>{s.steps.splice(i,1);render()};row.append(action,tag,value,remove);root.append(row)}}
function render(){renderList();const s=scenarios[selected];$('empty').hidden=Boolean(s);$('form').hidden=!s;if(!s)return;$('name').value=s.name;renderSteps()}
$('name').oninput=()=>{scenarios[selected].name=$('name').value;renderList()};$('add').onclick=()=>{scenarios.push({name:tr('scenarioEditor.newScenario'),steps:[]});selected=scenarios.length-1;render()};$('remove').onclick=()=>{scenarios.splice(selected,1);selected=Math.min(selected,scenarios.length-1);render()};$('addStep').onclick=()=>{scenarios[selected].steps.push({action:'set',tag:'',value:false});render()};$('save').onclick=()=>vscode.postMessage({type:'save',scenarios});$('raw').onclick=()=>vscode.postMessage({type:'raw'});$('run').onclick=()=>vscode.postMessage({type:'run',index:selected,scenario:scenarios[selected]});window.addEventListener('message',e=>{$('result').textContent=e.data.ok?(e.data.elapsed!==undefined?tr('scenarioEditor.passedIn',{ms:e.data.elapsed}):tr('scenarioEditor.saved')):tr('scenarioEditor.error',{error:e.data.error})});render();
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    try {
      if (message.type === 'raw') return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      if (message.type === 'save') {
        for (const scenario of message.scenarios || []) for (const step of scenario.steps || []) {
          if (!['set', 'pulse', 'wait', 'expect'].includes(step.action)) throw new Error(t('scenario.invalidAction'));
          if (step.action !== 'wait' && !step.tag) throw new Error(t('scenario.tagRequired', { name: scenario.name }));
          if (step.action === 'wait' && (!Number.isFinite(step.value) || step.value < 0)) throw new Error(t('scenario.invalidTime', { name: scenario.name }));
          if (['set', 'expect'].includes(step.action) && typeof step.value !== 'boolean' && !Number.isFinite(step.value)) throw new Error(t('scenario.invalidValue', { name: scenario.name }));
        }
        saveScenarioFile(file, message.scenarios || []); panel.webview.postMessage({ ok: true });
      } else if (message.type === 'run') {
        if (!hasLivePid(project)) throw new Error(t('scenario.plcOffline'));
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
      log.push(t('scenario.logWaited', { step: index + 1, ms: step.value }));
      continue;
    }
    if (step.action === 'set' || step.action === 'pulse') {
      const write = async value => {
        const result = await fetchJson(`${projectUrl(project)}/api/set?tag=${encodeURIComponent(step.tag)}&val=${encodeURIComponent(value)}`);
        if (!result.ok) throw new Error(t('scenario.writeRefused', { tag: step.tag }));
      };
      await write(step.action === 'pulse' ? 1 : step.value);
      if (step.action === 'pulse') { await new Promise(resolve => setTimeout(resolve, 120)); await write(0); }
      log.push(`${index + 1}. ${step.action} ${step.tag}`);
      continue;
    }
    const state = await fetchJson(`${projectUrl(project)}/api/variables`);
    const variable = (state.variables || []).find(item => item.path === step.tag);
    if (!variable) throw new Error(t('scenario.variableNotFound', { tag: step.tag }));
    const equal = typeof step.value === 'number'
      ? Math.abs(Number(variable.value) - step.value) < 0.000001
      : variable.value === step.value;
    if (!equal) throw new Error(t('scenario.mismatch', { tag: step.tag, expected: step.value, actual: variable.value }));
    log.push(t('scenario.logConfirmed', { step: index + 1, tag: step.tag, value: step.value }));
  }
  return { elapsed: Date.now() - started, log };
}

async function openScenarioRunner(project) {
  const file = scenarioFile(project);
  const relative = path.relative(project, file).split(path.sep).join('/');
  if (!fs.existsSync(file)) throw new Error(t('scenarioRunner.noFile', { file: relative }));
  const scenarios = parseScenarioFile(file);
  if (!scenarios.length) throw new Error(t('scenarioRunner.none'));
  const panel = vscode.window.createWebviewPanel('hplc.scenarios', t('scenarioEditor.panelTitle', { name: projectManifest(project).name }), vscode.ViewColumn.One, { enableScripts: true });
  const safe = JSON.stringify(scenarios).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:900px;margin:auto}header{display:flex;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px}h1{font-size:20px;flex:1;margin:0}.sub{color:var(--vscode-descriptionForeground)}button{border:0;border-radius:2px;padding:7px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:650}.scenario{border:1px solid var(--vscode-panel-border);margin-top:12px}.head{display:flex;gap:10px;align-items:center;padding:10px;background:var(--vscode-sideBarSectionHeader-background)}.head strong{flex:1}.result{padding:10px;white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}.pass{border-left:4px solid var(--vscode-testing-iconPassed)}.fail{border-left:4px solid var(--vscode-testing-iconFailed)}
</style></head><body><header><div><h1>${t('scenarioRunner.title')}</h1><div class="sub">${projectManifest(project).name} · ${relative} · ${t('scenarioRunner.mustRun')}</div></div><button id="all">${t('scenarioRunner.runAll')}</button></header><main id="list"></main><script>
${webviewTranslator('scenarioRunner.')}
const vscode=acquireVsCodeApi(),scenarios=${safe},list=document.getElementById('list');
scenarios.forEach((s,i)=>{const card=document.createElement('section');card.className='scenario';const head=document.createElement('div');head.className='head';const title=document.createElement('strong');title.textContent=s.name;const meta=document.createElement('span');meta.className='sub';meta.textContent=tr('scenarioRunner.steps',{count:s.steps.length});const button=document.createElement('button');button.textContent=tr('scenarioRunner.run');button.onclick=()=>run(i);const result=document.createElement('div');result.className='result';head.append(title,meta,button);card.append(head,result);list.append(card);s.card=card;s.button=button;s.result=result});
function run(index){scenarios[index].button.disabled=true;scenarios[index].result.textContent=tr('scenarioRunner.running');vscode.postMessage({type:'run',index})}document.getElementById('all').onclick=()=>vscode.postMessage({type:'all'});
window.addEventListener('message',e=>{const m=e.data,s=scenarios[m.index];if(!s)return;s.button.disabled=false;s.card.className='scenario '+(m.ok?'pass':'fail');s.result.textContent=(m.ok?tr('scenarioRunner.passed',{ms:m.elapsed})+'\\n':tr('scenarioRunner.failed')+'\\n')+(m.ok?m.log.join('\\n'):m.error)});
</script></body></html>`;
  const execute = async index => {
    try {
      if (!hasLivePid(project)) throw new Error(t('scenario.plcOffline'));
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
  if (!fs.existsSync(file)) throw new Error(t('importReport.none'));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const panel = vscode.window.createWebviewPanel('hplc.importReport', t('importReport.panelTitle', { name: projectManifest(project).name }), vscode.ViewColumn.One, { enableScripts: true });
  const data = JSON.stringify(report).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1100px;margin:auto}header{display:flex;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:14px}h1{font-size:20px;margin:0 0 4px}.grow{flex:1}.muted{color:var(--vscode-descriptionForeground)}button{border:0;border-radius:2px;padding:7px 12px;margin-left:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:650}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.card{border:1px solid var(--vscode-panel-border);padding:10px}.number{font-size:24px;font-weight:750}.ok{border-left:4px solid var(--vscode-testing-iconPassed)}.pending{border-left:4px solid var(--vscode-editorWarning-foreground)}section{margin-top:16px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid var(--vscode-panel-border);padding:7px}th{background:var(--vscode-sideBarSectionHeader-background)}a{color:var(--vscode-textLink-foreground);cursor:pointer}.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:5px 7px;border:1px solid var(--vscode-editorWarning-foreground);background:var(--vscode-textBlockQuote-background)}
</style></head><body><header><div class="grow"><h1>${t('importReport.title')}</h1><div class="muted" id="source"></div></div><button id="mapping">${t('importReport.mapping')}</button><button id="build">${t('importReport.build')}</button></header><div id="cards" class="cards"></div><section><h2>${t('importReport.pendingTitle')}</h2><div id="pending" class="chips"></div></section><section><h2>${t('importReport.conversionsTitle')}</h2><div id="conversions"></div></section><section><h2>${t('importReport.pousTitle')}</h2><table><thead><tr><th>${t('importReport.colName')}</th><th>${t('importReport.colType')}</th><th>${t('importReport.colOrigin')}</th><th>${t('importReport.colRuntime')}</th><th>${t('importReport.colFile')}</th></tr></thead><tbody id="pous"></tbody></table></section><section><h2>${t('importReport.librariesTitle', { count: report.libraries?.length || 0 })}</h2><div id="libraries" class="muted"></div></section><script>
${webviewTranslator('importReport.')}
const vscode=acquireVsCodeApi(),d=${data},diag=d.diagnostics||{};document.getElementById('source').textContent=d.source||'';
const stats=[['POUs',d.pous?.length||0],['DUTs',d.dataTypes?.length||0],['GVLs',d.globalVars?.length||0],[tr('importReport.libraries'),d.libraries?.length||0]],cards=document.getElementById('cards');for(const [label,value] of stats){const c=document.createElement('div');c.className='card';c.innerHTML='<div class="number">'+value+'</div><div class="muted">'+label+'</div>';cards.append(c)}
const pending=[...(diag.unresolvedTypes||[]).map(x=>tr('importReport.pendingType',{name:x})),...(diag.unresolvedBlocks||[]).map(x=>tr('importReport.pendingBlock',{name:x}))],pendingEl=document.getElementById('pending');if(!pending.length){pendingEl.className='card ok';pendingEl.textContent=tr('importReport.noPending')}else for(const value of pending){const c=document.createElement('span');c.className='chip';c.textContent=value;pendingEl.append(c)}
const conversions=document.getElementById('conversions');if(!(diag.conversions||[]).length)conversions.textContent=tr('importReport.allSt');else for(const c of diag.conversions){const row=document.createElement('div');row.className='card pending';row.textContent=c.name+': '+c.from+' → '+c.to;conversions.append(row)}
const tbody=document.getElementById('pous');for(const p of d.pous||[]){const tr=document.createElement('tr');for(const value of [p.name,p.type,p.originalLanguage,p.runtimeLanguage]){const td=document.createElement('td');td.textContent=value||'';tr.append(td)}const td=document.createElement('td'),a=document.createElement('a');a.textContent=p.file;a.onclick=()=>vscode.postMessage({type:'open',file:p.file});td.append(a);tr.append(td);tbody.append(tr)}
document.getElementById('libraries').textContent=(d.libraries||[]).map(x=>x.Name||x.name||JSON.stringify(x)).join(' · ')||tr('importReport.noLibraries');document.getElementById('mapping').onclick=()=>vscode.postMessage({type:'mapping'});document.getElementById('build').onclick=()=>vscode.postMessage({type:'build'});
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'open') {
      const target = path.resolve(project, message.file);
      if (target.startsWith(path.resolve(project) + path.sep) && fs.existsSync(target)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
    } else if (message.type === 'mapping') await openMappingEditor(project);
    else if (message.type === 'build') await vscode.commands.executeCommand('hplc.build');
  });
}

function archiveImportedXml(project, source) {
  const folder = path.join(project, 'Imports');
  fs.mkdirSync(folder, { recursive: true });
  let target = path.join(folder, path.basename(source));
  const content = fs.readFileSync(source);
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target).equals(content)) return;
    const extension = path.extname(source);
    target = path.join(folder, `${path.basename(source, extension)}-${Date.now()}-${require('crypto').randomBytes(3).toString('hex')}${extension}`);
  }
  fs.writeFileSync(target, content, { flag: 'wx' });
}

function copyProjectTemplate(context, target) {
  const template = path.join(context.extensionPath, 'template', 'plc-project');
  if (!fs.existsSync(template)) throw new Error(t('template.missing'));
  fs.mkdirSync(target, { recursive: true });
  if (fs.readdirSync(target).length) throw new Error(t('newProject.folderNotEmpty'));
  fs.cpSync(template, target, { recursive: true });
}

const PROJECT_SOURCE_FOLDERS = ['types', 'functions', 'blocks', 'globals', 'programs', 'routines'];

// A new project, or one that is about to receive an XML, must start without
// POUs, GVLs, I/O map or configured screens, whatever the template carries.
function resetProjectContent(target) {
  const name = path.basename(target);
  for (const folder of PROJECT_SOURCE_FOLDERS) {
    const full = path.join(target, folder);
    fs.rmSync(full, { recursive: true, force: true });
    fs.mkdirSync(full, { recursive: true });
  }
  fs.rmSync(path.join(target, 'plcopen'), { recursive: true, force: true });
  fs.rmSync(path.join(target, 'export'), { recursive: true, force: true });
  fs.rmSync(path.join(target, '.plcsim'), { recursive: true, force: true });
  for (const folder of ['Imports', 'plcopen', 'export', 'panel']) fs.mkdirSync(path.join(target, folder), { recursive: true });
  fs.writeFileSync(path.join(target, 'panel', 'panel.json'), JSON.stringify({
    version: 1, title: `${name} — mapping pending`,
    display: { realPrecision: 2, theme: 'light' },
    areas: { monitoring: [], hmi: [], panel: [], interface: [], field: [], communication: [] }
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'panel', 'pid.json'), JSON.stringify({
    version: 1, title: `${name} — P&ID pending`,
    display: { realPrecision: 2, theme: 'light' }, items: []
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'io.toml'),
    '# Project I/O map. Fill it with [[di]], [[do]], [[ai]] and [[ao]] blocks.\n');
  // Legacy files that nothing reads any more.
  fs.rmSync(path.join(target, 'panel', 'painel.toml'), { force: true }); // legacy
  fs.rmSync(path.join(target, 'panel', 'painel.json'), { force: true }); // legacy
  if (fs.existsSync(path.join(target, 'tests'))) {
    fs.writeFileSync(path.join(target, 'tests', 'scenarios.yaml'), `name: ${name}\nscenarios: []\n`);
    fs.rmSync(path.join(target, 'tests', 'cenarios.yaml'), { force: true }); // legacy
  }
  fs.writeFileSync(path.join(target, 'README.md'),
    `# ${name}\n\nEmpty HPLC project. Add POUs to \`programs/\` and \`blocks/\`,\n` +
    'types to `types/` and global variables to `globals/`, or import a vendor\n' +
    'PLCopenXML with the project import button.\n');
}

// Reuses the main program detected by the importer and stamps the folder name
// into plc.toml, so the build finds the task without manual editing.
function applyImportedManifest(target) {
  const imported = JSON.parse(fs.readFileSync(path.join(target, 'plcopen', 'manifest.json'), 'utf8'));
  const main = imported.pous.find(item => item.name.toLowerCase().includes('main') && item.type === 'program')
    || imported.pous.find(item => item.type === 'program');
  let manifest = fs.readFileSync(path.join(target, 'plc.toml'), 'utf8')
    .replace(/^name\s*=.*$/m, `name = "${path.basename(target).replace(/"/g, '')}"`);
  if (main) manifest = manifest.replace(/^program\s*=.*$/m, `program = "${main.name}"`);
  fs.writeFileSync(path.join(target, 'plc.toml'), manifest);
  return imported;
}

async function reportImport(target, imported) {
  const diagnostics = imported.diagnostics || {};
  const pending = (diagnostics.unresolvedTypes?.length || 0) + (diagnostics.unresolvedBlocks?.length || 0);
  await openImportReport(target);
  const summary = t('import.summary', { pous: imported.pous.length, duts: imported.dataTypes.length, gvls: imported.globalVars.length });
  if (pending) vscode.window.showWarningMessage(t('import.withPending', { summary, pending }));
  else vscode.window.showInformationMessage(t('import.ready', { summary }));
}

async function chooseNewProjectTarget(title, { defaultName = t('newProject.defaultName'), near } = {}) {
  const selected = await vscode.window.showOpenDialog({ title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: t('newProject.openLabel'), defaultUri: near ? vscode.Uri.file(near) : undefined });
  if (!selected?.length) return undefined;
  const name = await vscode.window.showInputBox({ title: t('newProject.nameTitle', { prefix: title.split(':')[0] }), prompt: t('newProject.namePrompt', { folder: selected[0].fsPath }), value: defaultName, validateInput: value => !value.trim() ? t('newProject.nameRequired') : /[\\/]/.test(value) ? t('newProject.nameNoSlashes') : undefined });
  if (!name) return undefined;
  const target = path.join(selected[0].fsPath, name.trim());
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(t('newProject.targetNotEmpty', { folder: target }));
  return target;
}

function waitForServer(url, child, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!child || child.exitCode !== null) return reject(new Error(t('runtime.exitedEarly')));
      const request = http.get(url, { agent: httpAgent }, response => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.setTimeout(500, () => request.destroy());
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) reject(new Error(t('runtime.serverTimeout', { url, seconds: Math.round(timeoutMs / 1000) })));
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
    request.setTimeout(1500, () => request.destroy(new Error(t('http.timeout'))));
    request.on('error', reject);
  });
}

async function openEquipment(project) { return openEquipmentView(project, 'panel'); }
async function openPid(project) { return openEquipmentView(project, 'pid'); }

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
  const rendered = quoted ? JSON.stringify(String(value)) : String(value);
  const expression = new RegExp(`^${key}\\s*=.*$`, 'm');
  return expression.test(text) ? text.replace(expression, `${key} = ${rendered}`) : `${key} = ${rendered}\n${text}`;
}

function replaceTaskValue(text, key, value, quoted = false) {
  const rendered = quoted ? JSON.stringify(String(value)) : String(value);
  return text.replace(/\[\[task\]\]([\s\S]*?)(?=\n\[\[|$)/, block => {
    const expression = new RegExp(`^${key}\\s*=.*$`, 'm');
    return expression.test(block) ? block.replace(expression, `${key} = ${rendered}`) : `${block.trimEnd()}\n${key} = ${rendered}\n`;
  });
}

function projectSettingsSnapshot(project) {
  const manifest = projectManifest(project);
  return { name: manifest.name, task: manifest.task, program: manifest.program, interval: manifest.intervalMs,
    panelPort: configuredProjectPort(project), pidPort: configuredPidPort(project), programs: projectPrograms(project) };
}

function saveProjectSettings(project, values = {}) {
  const programs = projectPrograms(project);
  if (!values.name?.trim()) throw new Error(t('settings.nameRequired'));
  if (!/^[A-Za-z_]\w*$/.test(values.task || '')) throw new Error(t('settings.invalidTask'));
  if (!programs.includes(values.program)) throw new Error(t('settings.programNotFound'));
  if (!Number.isInteger(values.interval) || values.interval < 1 || values.interval > 60000) throw new Error(t('settings.invalidInterval'));
  if (![values.panelPort, values.pidPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || values.panelPort === values.pidPort) throw new Error(t('settings.invalidPorts'));
  const target = path.join(project, 'plc.toml');
  let text = fs.readFileSync(target, 'utf8');
  text = replaceManifestValue(text, 'name', values.name.trim(), true);
  text = replaceManifestValue(text, 'panel_port', values.panelPort);
  text = replaceManifestValue(text, 'pid_port', values.pidPort);
  text = replaceTaskValue(text, 'name', values.task, true);
  text = replaceTaskValue(text, 'program', values.program, true);
  text = replaceTaskValue(text, 'interval_ms', values.interval);
  fs.writeFileSync(target, text);
  projectView?.refresh();
  return projectSettingsSnapshot(project);
}

async function openProjectSettings(project) {
  const manifest = projectManifest(project);
  const programs = projectPrograms(project);
  const panel = vscode.window.createWebviewPanel('hplcProjectSettings', t('projectSettings.panelTitle', { name: manifest.name }), vscode.ViewColumn.One, { enableScripts: true });
  const options = programs.map(name => `<option value="${name}"${name === manifest.program ? ' selected' : ''}>${name}</option>`).join('');
  const openFile = file => t('projectSettings.openFile', { file });
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:980px;margin:auto}h1{font-size:20px;margin:0 0 4px}.path{color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:18px;overflow-wrap:anywhere}.tools{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:22px}.tool{display:grid;grid-template-columns:1fr auto;gap:5px;text-align:left;padding:11px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}.tool b{font-size:13px}.tool small{grid-column:1/-1;color:var(--vscode-descriptionForeground);font-weight:400}.raw{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:4px 7px}.settings{border-top:1px solid var(--vscode-panel-border);padding-top:18px}.settings h2{font-size:15px;margin:0 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:grid;gap:5px}.wide{grid-column:1/-1}label{font-weight:650}input,select{padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}.help{font-size:11px;color:var(--vscode-descriptionForeground)}footer{display:flex;align-items:center;gap:10px;margin-top:20px;padding-top:14px;border-top:1px solid var(--vscode-panel-border)}button{padding:8px 14px;border:0;border-radius:3px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}#result{color:var(--vscode-testing-iconPassed)}@media(max-width:700px){.grid,.tools{grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body><h1>${t('projectSettings.heading')}</h1><div class="path">${project}</div><section class="tools">
<button class="tool" data-action="mapping"><b>${t('projectSettings.mapping')}</b><span>›</span><small>${t('projectSettings.mappingHint')}</small></button>
<button class="tool" data-action="pid"><b>${t('projectSettings.pidEditor')}</b><span>›</span><small>${t('projectSettings.pidEditorHint')}</small></button>
<button class="tool" data-action="scenarios"><b>${t('projectSettings.scenarios')}</b><span>›</span><small>${t('projectSettings.scenariosHint')}</small></button>
<button class="tool" data-action="rawPanel"><b>${openFile(path.basename(panelConfigFile(project)))}</b><span class="raw">JSON</span><small>${t('projectSettings.rawPanelHint')}</small></button>
<button class="tool" data-action="rawPid"><b>${openFile('pid.json')}</b><span class="raw">JSON</span><small>${t('projectSettings.rawPidHint')}</small></button>
<button class="tool" data-action="rawScenarios"><b>${openFile(path.basename(scenarioFile(project)))}</b><span class="raw">YAML</span><small>${t('projectSettings.rawScenariosHint')}</small></button>
<button class="tool" data-action="rawManifest"><b>${openFile('plc.toml')}</b><span class="raw">TOML</span><small>${t('projectSettings.rawManifestHint')}</small></button>
<button class="tool" data-action="importReport"><b>${t('projectSettings.importReport')}</b><span>›</span><small>${t('projectSettings.importReportHint')}</small></button>
</section><section class="settings"><h2>${t('projectSettings.sectionTitle')}</h2><div class="grid">
<div class="field wide"><label>${t('projectSettings.name')}</label><input id="name" value="${manifest.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>
<div class="field"><label>Task</label><input id="task" value="${manifest.task}"><span class="help">${t('projectSettings.taskHelp')}</span></div>
<div class="field"><label>${t('projectSettings.program')}</label><select id="program">${options}</select><span class="help">${t('projectSettings.programHelp')}</span></div>
<div class="field"><label>${t('projectSettings.interval')}</label><input id="interval" type="number" min="1" max="60000" value="${manifest.intervalMs}"></div>
<div class="field"><label>${t('projectSettings.panelPort')}</label><input id="panelPort" type="number" min="1024" max="65534" value="${configuredProjectPort(project)}"></div>
<div class="field"><label>${t('projectSettings.pidPort')}</label><input id="pidPort" type="number" min="1024" max="65535" value="${configuredPidPort(project)}"></div>
</div><footer><button id="save">${t('projectSettings.save')}</button><span id="result"></span></footer></section><script>
${webviewTranslator('projectSettings.client.')}
const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>vscode.postMessage({type:'open',action:button.dataset.action}));$('save').onclick=()=>vscode.postMessage({type:'save',values:{name:$('name').value,task:$('task').value,program:$('program').value,interval:Number($('interval').value),panelPort:Number($('panelPort').value),pidPort:Number($('pidPort').value)}});window.addEventListener('message',event=>{if(event.data.type==='saved')$('result').textContent=tr('projectSettings.client.saved');if(event.data.type==='error')$('result').textContent=tr('projectSettings.client.error',{message:event.data.message})});
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'open') {
      const actions = {
        mapping: () => openMappingEditor(project),
        pid: () => openPidEditor(project),
        scenarios: () => openScenarioEditor(project),
        importReport: () => openImportReport(project),
        rawPanel: () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(panelConfigFile(project))),
        rawPid: () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(project, 'panel', 'pid.json'))),
        rawScenarios: () => { const file = scenarioFile(project); if (!fs.existsSync(file)) saveScenarioFile(file, []); return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); },
        rawManifest: () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(project, 'plc.toml'))),
      };
      try { await actions[message.action]?.(); } catch (error) { vscode.window.showErrorMessage(t('projectSettings.actionFailed', { message: error.message })); }
      return;
    }
    if (message.type !== 'save') return;
    try {
      saveProjectSettings(project, message.values);
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
      const configuration = JSON.parse(fs.readFileSync(panelConfigFile(project), 'utf8'));
      return [...new Set(Object.values(configuration.areas || {}).flat().map(item => item.tag))].map(path => ({ path, type: 'UNKNOWN', source: '' }));
    } catch (_) { return []; }
  }
}

async function openMappingEditor(project) {
  const target = panelConfigFile(project);
  const configuration = JSON.parse(fs.readFileSync(target, 'utf8'));
  const catalog = projectVariableCatalog(project);
  // Area keys: new projects use 'hmi'/'communication'; projects created before the
  // English release keep the legacy 'ihm'/'comunicacao' keys (the pages read both).
  const legacyKey = (modern, legacy) => Array.isArray(configuration.areas?.[legacy]) && !Array.isArray(configuration.areas?.[modern]) ? legacy : modern;
  const hmiKey = legacyKey('hmi', 'ihm'), communicationKey = legacyKey('communication', 'comunicacao');
  const areas = ['monitoring', hmiKey, 'panel', 'interface', 'field', communicationKey];
  for (const area of areas) if (!Array.isArray(configuration.areas?.[area])) (configuration.areas ||= {})[area] = [];
  const panel = vscode.window.createWebviewPanel('hplcMappingEditor', t('mapping.panelTitle', { name: projectManifest(project).name }), vscode.ViewColumn.One, { enableScripts: true });
  const safeData = JSON.stringify({ configuration, catalog }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:12px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);overflow:hidden}header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);height:49px;background:var(--vscode-editor-background)}h1{font-size:15px;margin:0;flex:1}button{border:0;border-radius:3px;padding:6px 9px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}main{display:grid;grid-template-columns:280px minmax(450px,1fr) 270px;height:calc(100vh - 49px);min-height:0}aside,.editor{padding:10px;overflow:auto;min-height:0}.catalog{border-right:1px solid var(--vscode-panel-border)}.editor{border-left:1px solid var(--vscode-panel-border)}input,select{width:100%;padding:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}.tag-list{display:grid;gap:3px;margin-top:8px}.tag{padding:6px;border:1px solid var(--vscode-panel-border);border-radius:3px;background:var(--vscode-sideBar-background);cursor:grab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tag small{display:block;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}.areas{padding:10px;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start;min-height:0}.area{border:1px solid var(--vscode-panel-border);border-radius:4px;min-height:120px;min-width:0;padding:7px;overflow:hidden}.area>div{max-height:260px;overflow:auto;overscroll-behavior:contain;padding-right:2px}.area.monitoring,.area.comunicacao{grid-column:1/-1}.area h2{font-size:11px;text-transform:uppercase;margin:0 0 6px;color:var(--vscode-descriptionForeground)}.area.drag{outline:2px solid var(--vscode-focusBorder)}.mapped{display:flex;gap:5px;align-items:center;padding:5px;margin:3px 0;background:var(--vscode-list-inactiveSelectionBackground);border-left:3px solid var(--vscode-focusBorder);cursor:pointer;min-width:0}.mapped span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.mapped small{flex:0 0 auto}.mapped.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.form{display:grid;gap:9px}.field{display:grid;gap:3px}.row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.empty{color:var(--vscode-descriptionForeground);padding:8px;text-align:center}.result{color:var(--vscode-testing-iconPassed)}@media(max-width:900px){body{overflow:auto}main{grid-template-columns:220px 1fr;height:auto}.editor{grid-column:1/-1;border-left:0;border-top:1px solid var(--vscode-panel-border)}.areas{grid-template-columns:1fr}}
</style></head><body><header><h1>${t('mapping.heading')}</h1><span id="result" class="result"></span><button id="save">${t('mapping.saveFile', { file: path.basename(target) })}</button></header><main><aside class="catalog"><input id="search" placeholder="${t('mapping.filter')}"><div id="catalog" class="tag-list"></div></aside><section id="areas" class="areas"></section><aside class="editor"><h2>${t('mapping.properties')}</h2><div id="empty" class="empty">${t('mapping.empty')}</div><div id="form" class="form" hidden><div class="field"><label>Tag</label><input id="tag" readonly></div><div class="field"><label>${t('mapping.label')}</label><input id="label"></div><div class="row"><div class="field"><label>${t('mapping.behavior')}</label><select id="kind"><option value="switch">${t('mapping.kind.switch')}</option><option value="pushbutton">${t('mapping.kind.pushbutton')}</option><option value="bool">${t('mapping.kind.bool')}</option><option value="number">${t('mapping.kind.number')}</option><option value="lamp">${t('mapping.kind.lamp')}</option><option value="analog">${t('mapping.kind.analog')}</option></select></div><div class="field"><label>${t('mapping.ioType')}</label><input id="ioType"></div></div><div class="row"><div class="field"><label>${t('mapping.address')}</label><input id="address"></div><div class="field"><label>${t('mapping.unit')}</label><input id="unit"></div></div><div class="row"><div class="field"><label>${t('mapping.precision')}</label><input id="precision" type="number" min="0" max="8"></div><div class="field"><label>${t('mapping.tab')}</label><input id="tab"></div></div><div class="field"><label><input id="writable" type="checkbox" style="width:auto"> ${t('mapping.writable')}</label></div><button id="remove" class="secondary">${t('mapping.remove')}</button></div></aside></main><script>
${webviewTranslator('mapping.client.')}
const vscode=acquireVsCodeApi(),data=${safeData},config=data.configuration,catalog=data.catalog,areaNames={monitoring:tr('mapping.client.area.monitoring'),[${JSON.stringify(hmiKey)}]:tr('mapping.client.area.ihm'),panel:tr('mapping.client.area.panel'),interface:tr('mapping.client.area.interface'),field:tr('mapping.client.area.field'),[${JSON.stringify(communicationKey)}]:tr('mapping.client.area.comunicacao')},$=id=>document.getElementById(id);let selected=null;
function renderCatalog(){const q=$('search').value.toLowerCase(),root=$('catalog');root.replaceChildren();for(const variable of catalog.filter(v=>v.path.toLowerCase().includes(q)).slice(0,500)){const row=document.createElement('div');row.className='tag';row.draggable=true;row.title=variable.path;row.innerHTML='<span></span><small></small>';row.children[0].textContent=variable.path;row.children[1].textContent=variable.type+(variable.source?' · '+variable.source:'');row.ondragstart=e=>e.dataTransfer.setData('text/plain',variable.path);root.append(row)}}
function defaultItem(path){const variable=catalog.find(v=>v.path===path),last=path.split('.').pop(),isBool=variable?.type==='BOOL';return{tag:path,label:last,kind:isBool?'switch':'number',ioType:'VAR',writable:true,...(!isBool?{precision:config.display?.realPrecision??2}:{})}}
function select(area,index){selected={area,index};renderAreas();renderForm()}
function renderAreas(){const root=$('areas');root.replaceChildren();for(const area of Object.keys(areaNames)){const card=document.createElement('section');card.className='area '+area;card.innerHTML='<h2></h2><div></div>';card.children[0].textContent=areaNames[area]+' · '+config.areas[area].length;card.ondragover=e=>{e.preventDefault();card.classList.add('drag')};card.ondragleave=()=>card.classList.remove('drag');card.ondrop=e=>{e.preventDefault();card.classList.remove('drag');const path=e.dataTransfer.getData('text/plain');if(!path)return;config.areas[area].push(defaultItem(path));select(area,config.areas[area].length-1)};for(const [index,item] of config.areas[area].entries()){const row=document.createElement('div');row.className='mapped'+(selected?.area===area&&selected.index===index?' active':'');row.innerHTML='<span></span><small></small>';row.children[0].textContent=item.label||item.tag;row.children[1].textContent=item.ioType||'';row.title=item.tag;row.onclick=()=>select(area,index);card.children[1].append(row)}root.append(card)}}
const fields=['label','kind','ioType','address','unit','precision','tab'];function renderForm(){const item=selected&&config.areas[selected.area]?.[selected.index];$('empty').hidden=Boolean(item);$('form').hidden=!item;if(!item)return;$('tag').value=item.tag;for(const key of fields)$(key).value=key==='kind'?(item[key]==='toggle'?'switch':item[key]==='momentary'?'pushbutton':item[key]??''):item[key]??'';$('writable').checked=item.writable!==false}
for(const key of fields){$(key).oninput=()=>{if(!selected)return;const item=config.areas[selected.area][selected.index],value=$(key).value;if(key==='precision')value===''?delete item[key]:item[key]=Number(value);else value===''?delete item[key]:item[key]=value;renderAreas()}}$('writable').onchange=()=>{if(selected)config.areas[selected.area][selected.index].writable=$('writable').checked};$('remove').onclick=()=>{if(!selected)return;config.areas[selected.area].splice(selected.index,1);selected=null;renderAreas();renderForm()};$('search').oninput=renderCatalog;$('save').onclick=()=>vscode.postMessage({type:'save',configuration:config});window.addEventListener('message',e=>{$('result').textContent=e.data.type==='saved'?tr('mapping.client.saved'):tr('mapping.client.error',{message:e.data.message})});renderCatalog();renderAreas();
</script></body></html>`;
  panel.webview.onDidReceiveMessage(message => {
    if (message.type !== 'save') return;
    try {
      const next = message.configuration;
      const validPaths = new Set(catalog.map(variable => variable.path));
      for (const area of areas) {
        if (!Array.isArray(next.areas?.[area])) throw new Error(t('mapping.invalidArea', { area }));
        for (const item of next.areas[area]) {
          if (!validPaths.has(item.tag)) throw new Error(t('mapping.unknownTag', { tag: item.tag }));
          if (item.precision !== undefined && (!Number.isInteger(item.precision) || item.precision < 0 || item.precision > 8)) throw new Error(t('mapping.invalidPrecision', { tag: item.tag }));
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
  if (!Array.isArray(configuration.shapes)) configuration.shapes = [];
  const catalog = projectVariableCatalog(project);
  const panel = vscode.window.createWebviewPanel('hplcPidEditor', t('pidEditor.panelTitle', { name: projectManifest(project).name }), vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(project, 'panel'))] });
  let backgroundUri = '';
  if (configuration.backgroundImage) {
    const local = path.join(project, 'panel', configuration.backgroundImage.replace(/^\/+/, ''));
    if (fs.existsSync(local)) backgroundUri = panel.webview.asWebviewUri(vscode.Uri.file(local)).toString();
  }
  // Basic P&ID shapes the user can draw freely on the canvas (besides the tag
  // cards). Geometry is simple enough to need no drawing library, yet
  // recognisable as instrumentation/process symbols. w/h are the default size
  // (%) when added; the user resizes afterwards.
  const shapeTypes = [
    { type: 'valve', label: t('pidEditor.shape.valve'), w: 6, h: 6 },
    { type: 'pipe', label: t('pidEditor.shape.pipe'), w: 16, h: 2.5 },
    { type: 'motor', label: t('pidEditor.shape.motor'), w: 9, h: 9 },
    { type: 'pump', label: t('pidEditor.shape.pump'), w: 8, h: 8 },
    { type: 'vessel', label: t('pidEditor.shape.vessel'), w: 8, h: 20 },
    { type: 'label', label: t('pidEditor.shape.label'), w: 16, h: 4 },
  ];
  const safeData = JSON.stringify({ configuration, catalog, backgroundUri, shapeTypes }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;font:12px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}header{height:48px;display:flex;align-items:center;gap:7px;padding:0 10px;border-bottom:1px solid var(--vscode-panel-border)}h1{font-size:15px;margin:0;flex:1}button{border:0;border-radius:3px;padding:6px 9px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}main{height:calc(100vh - 49px);display:grid;grid-template-columns:250px minmax(500px,1fr) 260px}.side{padding:9px;overflow:auto}.left{border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;min-height:0}.right{border-left:1px solid var(--vscode-panel-border)}input,select{width:100%;padding:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px}input[type=color]{padding:2px;height:30px}h2{font-size:11px;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:12px 0 6px}h2:first-child{margin-top:0}.tags{display:grid;gap:3px;margin-top:7px}.source{padding:5px;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:grab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.palette{display:grid;grid-template-columns:1fr 1fr;gap:5px}.palette button{padding:8px 5px;font-size:11px;text-align:center}.workspace{padding:10px;overflow:auto}.canvas{position:relative;width:100%;aspect-ratio:16/9;min-height:440px;border:1px solid var(--vscode-panel-border);background-color:var(--vscode-editorWidget-background);background-position:center;background-size:contain;background-repeat:no-repeat;overflow:hidden}.canvas.drag{outline:2px solid var(--vscode-focusBorder)}.item{position:absolute;transform:translate(-50%,-50%);width:145px;padding:6px;border:1px solid var(--vscode-focusBorder);border-left:4px solid var(--vscode-testing-iconPassed);border-radius:3px;background:var(--vscode-editor-background);box-shadow:0 1px 4px #0004;cursor:move;user-select:none;z-index:2}.item.active{outline:2px solid var(--vscode-focusBorder)}.item b,.item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item small{color:var(--vscode-descriptionForeground);margin-top:3px}.shape{position:absolute;transform:translate(-50%,-50%);cursor:move;user-select:none;display:flex;align-items:center;justify-content:center}.shape svg{width:100%;height:100%;overflow:visible;fill:var(--vscode-charts-blue,#4b8ccb);stroke:var(--vscode-panel-border);stroke-width:2;opacity:.8}.shape.active svg{outline:2px solid var(--vscode-focusBorder);opacity:1}.shape.type-label{color:var(--vscode-foreground);font-size:11px;white-space:nowrap}.shape .caption{position:absolute;top:100%;left:50%;transform:translateX(-50%);font-size:9px;color:var(--vscode-descriptionForeground);white-space:nowrap;margin-top:2px}.handle{position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;background:var(--vscode-focusBorder);border-radius:2px;cursor:nwse-resize}.form{display:grid;gap:8px}.field{display:grid;gap:3px}.row{display:grid;grid-template-columns:1fr 1fr;gap:6px}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}.empty{color:var(--vscode-descriptionForeground);padding:10px}.result{color:var(--vscode-testing-iconPassed)}small.hint{color:var(--vscode-descriptionForeground)}@media(max-width:900px){main{grid-template-columns:200px 1fr}.right{grid-column:1/-1;border-left:0;border-top:1px solid var(--vscode-panel-border)}}
</style></head><body><header><h1>${t('pidEditor.heading')}</h1><span id="result" class="result"></span><button id="background" class="secondary">${t('pidEditor.background')}</button><button id="clearBackground" class="secondary">${t('pidEditor.clearBackground')}</button><button id="save">${t('pidEditor.saveFile', { file: 'pid.json' })}</button></header><main>
<aside class="side left">
<h2>${t('pidEditor.shapes')}</h2>
<div id="palette" class="palette"></div>
<h2>${t('pidEditor.variables')}</h2>
<input id="search" placeholder="${t('pidEditor.filter')}">
<div id="sources" class="tags"></div>
</aside>
<section class="workspace"><div id="canvas" class="canvas"></div></section>
<aside class="side right">
<h2>${t('pidEditor.selection')}</h2>
<div id="empty" class="empty">${t('pidEditor.empty')}</div>
<div id="itemForm" class="form" hidden>
<div class="field"><label>Tag</label><input id="tag" readonly></div>
<div class="field"><label>${t('pidEditor.client.label')}</label><input id="label"></div>
<div class="row"><div class="field"><label>${t('pidEditor.unit')}</label><input id="unit"></div><div class="field"><label>${t('pidEditor.precision')}</label><input id="precision" type="number" min="0" max="8"></div></div>
<div class="row"><div class="field"><label>X (%)</label><input id="x" type="number" min="0" max="100"></div><div class="field"><label>Y (%)</label><input id="y" type="number" min="0" max="100"></div></div>
<button id="removeItem" class="secondary">${t('pidEditor.removeCard')}</button>
</div>
<div id="shapeForm" class="form" hidden>
<div class="field"><label>${t('pidEditor.type')}</label><input id="shapeType" readonly></div>
<div class="field"><label id="shapeLabelLabel">${t('pidEditor.client.label')}</label><input id="shapeLabel"></div>
<div class="field" id="shapeTagField"><label>${t('pidEditor.shapeTag')}</label><input id="shapeTag" list="catalogList" placeholder="${t('pidEditor.shapeTagPlaceholder')}"><small class="hint">${t('pidEditor.shapeTagHint')}</small></div>
<div class="row" id="shapeColors"><div class="field"><label>${t('pidEditor.onColor')}</label><input id="shapeOnColor" type="color"></div><div class="field"><label>${t('pidEditor.offColor')}</label><input id="shapeOffColor" type="color"></div></div>
<div class="row3"><div class="field"><label>X (%)</label><input id="shapeX" type="number" min="0" max="100" step="0.5"></div><div class="field"><label>Y (%)</label><input id="shapeY" type="number" min="0" max="100" step="0.5"></div><div class="field"><label>${t('pidEditor.rotation')}</label><input id="shapeRot" type="number" step="5"></div></div>
<div class="row"><div class="field"><label>${t('pidEditor.width')}</label><input id="shapeW" type="number" min="1" max="100" step="0.5"></div><div class="field"><label>${t('pidEditor.height')}</label><input id="shapeH" type="number" min="1" max="100" step="0.5"></div></div>
<button id="removeShape" class="secondary">${t('pidEditor.removeShape')}</button>
</div>
<datalist id="catalogList"></datalist>
</aside>
</main><script>
${webviewTranslator('pidEditor.client.')}
const vscode=acquireVsCodeApi(),data=${safeData},config=data.configuration,catalog=data.catalog,shapeTypes=data.shapeTypes,$=id=>document.getElementById(id);
// selection = {kind:'item'|'shape', index} or null. drag keeps the same shape plus a mode, so the global pointermove knows what to update.
let selection=null,drag=null;
const canvas=$('canvas');if(data.backgroundUri)canvas.style.backgroundImage='url('+JSON.stringify(data.backgroundUri)+')';
function shapeIcon(type){switch(type){
  case 'valve':return '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="0,15 50,50 0,85 100,15 50,50 100,85"/></svg>';
  case 'pipe':return '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect x="0" y="25" width="100" height="50" rx="20"/></svg>';
  case 'motor':return '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/><text x="50" y="52" text-anchor="middle" dominant-baseline="middle" font-size="40" fill="var(--vscode-editor-background)" stroke="none">M</text></svg>';
  case 'pump':return '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/><path d="M30 28 L74 50 L30 72 Z" fill="var(--vscode-editor-background)" stroke="none"/></svg>';
  case 'vessel':return '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect x="10" y="0" width="80" height="100" rx="38"/></svg>';
  default:return '';
}}
for(const def of shapeTypes){const btn=document.createElement('button');btn.className='secondary';btn.textContent=def.label;btn.title=tr('pidEditor.client.addShape',{label:def.label});btn.onclick=()=>addShape(def);$('palette').append(btn)}
function addShape(def){const id='shape_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);config.shapes.push({id,type:def.type,x:50,y:50,width:def.w,height:def.h,rotation:0,label:def.type==='label'?tr('pidEditor.client.text'):'',tag:'',onColor:'#4d7558',offColor:'#914949'});select('shape',config.shapes.length-1);renderCanvas()}
function select(kind,index){selection={kind,index};renderCanvas();renderForm()}
function clampPct(v){return Math.max(0,Math.min(100,v))}
function pointerPct(event){const rect=canvas.getBoundingClientRect();return{x:clampPct((event.clientX-rect.left)*100/rect.width),y:clampPct((event.clientY-rect.top)*100/rect.height)}}
function renderSources(){const q=$('search').value.toLowerCase(),root=$('sources');root.replaceChildren();const list=$('catalogList');list.replaceChildren();for(const variable of catalog){const opt=document.createElement('option');opt.value=variable.path;list.append(opt)}for(const variable of catalog.filter(v=>v.path.toLowerCase().includes(q)).slice(0,500)){const row=document.createElement('div');row.className='source';row.draggable=true;row.textContent=variable.path;row.title=variable.type+' · '+variable.source;row.ondragstart=e=>e.dataTransfer.setData('text/plain',variable.path);root.append(row)}}
function renderCanvas(){
  canvas.querySelectorAll('.item,.shape').forEach(node=>node.remove());
  for(const [index,shape] of config.shapes.entries()){
    const el=document.createElement('div');
    el.className='shape type-'+shape.type+(selection?.kind==='shape'&&selection.index===index?' active':'');
    el.style.left=shape.x+'%';el.style.top=shape.y+'%';el.style.width=shape.width+'%';el.style.height=shape.height+'%';el.style.transform='translate(-50%,-50%) rotate('+(shape.rotation||0)+'deg)';
    if(shape.type==='label'){el.textContent=shape.label||tr('pidEditor.client.text')}else{el.innerHTML=shapeIcon(shape.type);if(shape.label){const caption=document.createElement('span');caption.className='caption';caption.textContent=shape.label;el.append(caption)}}
    el.onpointerdown=e=>{e.stopPropagation();select('shape',index);drag={kind:'shape',index,mode:'move'};el.setPointerCapture(e.pointerId)};
    el.onpointermove=e=>{if(drag&&drag.kind==='shape'&&drag.index===index&&drag.mode==='move'){const p=pointerPct(e);shape.x=p.x;shape.y=p.y;renderCanvas()}};
    el.onpointerup=()=>{drag=null};
    if(selection?.kind==='shape'&&selection.index===index){const handle=document.createElement('div');handle.className='handle';handle.onpointerdown=e=>{e.stopPropagation();drag={kind:'shape',index,mode:'resize'};handle.setPointerCapture(e.pointerId)};handle.onpointermove=e=>{if(drag&&drag.mode==='resize'&&drag.index===index){const rect=canvas.getBoundingClientRect();shape.width=Math.max(1,Math.min(100,(e.clientX-rect.left)*100/rect.width-shape.x+shape.width/2));shape.height=Math.max(1,Math.min(100,(e.clientY-rect.top)*100/rect.height-shape.y+shape.height/2));renderCanvas()}};handle.onpointerup=()=>{drag=null};el.append(handle)}
    canvas.append(el);
  }
  for(const [index,item] of config.items.entries()){const card=document.createElement('div');card.className='item'+(selection?.kind==='item'&&selection.index===index?' active':'');card.style.left=item.x+'%';card.style.top=item.y+'%';card.innerHTML='<b></b><small></small>';card.children[0].textContent=item.label||item.tag.split('.').pop();card.children[1].textContent=item.tag;card.onpointerdown=e=>{e.stopPropagation();select('item',index);drag={kind:'item',index,mode:'move'};card.setPointerCapture(e.pointerId)};card.onpointermove=e=>{if(drag&&drag.kind==='item'&&drag.index===index){const p=pointerPct(e);item.x=p.x;item.y=p.y;renderCanvas()}};card.onpointerup=()=>{drag=null};canvas.append(card)}
}
function add(tagPath,event){const rect=canvas.getBoundingClientRect(),variable=catalog.find(v=>v.path===tagPath),isReal=['REAL','LREAL'].includes(variable?.type);config.items.push({tag:tagPath,label:tagPath.split('.').pop(),x:Math.round((event.clientX-rect.left)*1000/rect.width)/10,y:Math.round((event.clientY-rect.top)*1000/rect.height)/10,...(isReal?{precision:config.display?.realPrecision??2}:{})});select('item',config.items.length-1)}
canvas.ondragover=e=>{e.preventDefault();canvas.classList.add('drag')};canvas.ondragleave=()=>canvas.classList.remove('drag');canvas.ondrop=e=>{e.preventDefault();canvas.classList.remove('drag');const p=e.dataTransfer.getData('text/plain');if(p)add(p,e)};
canvas.onpointerdown=()=>{select(null,-1)};
const itemFields=['label','unit','precision','x','y'];
const shapeFieldMap={shapeLabel:'label',shapeTag:'tag',shapeOnColor:'onColor',shapeOffColor:'offColor',shapeX:'x',shapeY:'y',shapeRot:'rotation',shapeW:'width',shapeH:'height'};
function renderForm(){
  const item=selection?.kind==='item'?config.items[selection.index]:null;
  const shape=selection?.kind==='shape'?config.shapes[selection.index]:null;
  $('empty').hidden=Boolean(item||shape);$('itemForm').hidden=!item;$('shapeForm').hidden=!shape;
  if(item){$('tag').value=item.tag;for(const key of itemFields)$(key).value=item[key]??''}
  if(shape){
    $('shapeType').value=shapeTypes.find(t=>t.type===shape.type)?.label||shape.type;
    $('shapeLabelLabel').textContent=shape.type==='label'?tr('pidEditor.client.text'):tr('pidEditor.client.label');
    $('shapeTagField').hidden=shape.type==='label';$('shapeColors').hidden=shape.type==='label'||!shape.tag;
    $('shapeLabel').value=shape.label??'';$('shapeTag').value=shape.tag??'';$('shapeOnColor').value=shape.onColor||'#4d7558';$('shapeOffColor').value=shape.offColor||'#914949';
    $('shapeX').value=shape.x??0;$('shapeY').value=shape.y??0;$('shapeRot').value=shape.rotation??0;$('shapeW').value=shape.width??6;$('shapeH').value=shape.height??6;
  }
}
for(const key of itemFields)$(key).oninput=()=>{const item=config.items[selection?.index];if(!item)return;const value=$(key).value;if(['precision','x','y'].includes(key))value===''?delete item[key]:item[key]=Number(value);else value===''?delete item[key]:item[key]=value;renderCanvas()};
for(const [id,key] of Object.entries(shapeFieldMap))$(id).oninput=()=>{const shape=config.shapes[selection?.index];if(!shape)return;const value=$(id).value;if(['x','y','rotation','width','height'].includes(key))shape[key]=value===''?0:Number(value);else shape[key]=value;if(id==='shapeTag')renderForm();renderCanvas()};
$('removeItem').onclick=()=>{if(selection?.kind!=='item')return;config.items.splice(selection.index,1);select(null,-1)};
$('removeShape').onclick=()=>{if(selection?.kind!=='shape')return;config.shapes.splice(selection.index,1);select(null,-1)};
$('search').oninput=renderSources;$('background').onclick=()=>vscode.postMessage({type:'pickBackground'});$('clearBackground').onclick=()=>{delete config.backgroundImage;canvas.style.backgroundImage='none'};$('save').onclick=()=>vscode.postMessage({type:'save',configuration:config});
window.addEventListener('message',e=>{if(e.data.type==='background'){config.backgroundImage=e.data.relative;canvas.style.backgroundImage='url('+JSON.stringify(e.data.uri)+')'}$('result').textContent=e.data.type==='saved'?tr('pidEditor.client.saved'):e.data.type==='error'?tr('pidEditor.client.error',{message:e.data.message}):''});
renderSources();renderCanvas();renderForm();
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => {
    try {
      if (message.type === 'pickBackground') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: t('pidEditor.pickBackground'), filters: { [t('pidEditor.imagesFilter')]: ['png', 'jpg', 'jpeg', 'svg', 'webp'] } });
        if (!picked?.length) return;
        const extension = path.extname(picked[0].fsPath).toLowerCase();
        const assets = path.join(project, 'panel', 'assets');fs.mkdirSync(assets, { recursive: true });
        const destination = path.join(assets, `pid-background${extension}`);fs.copyFileSync(picked[0].fsPath, destination);
        panel.webview.postMessage({ type: 'background', relative: `assets/${path.basename(destination)}`, uri: panel.webview.asWebviewUri(vscode.Uri.file(destination)).toString() });
      } else if (message.type === 'save') {
        const next = message.configuration,validPaths=new Set(catalog.map(variable=>variable.path));
        const allowedShapeTypes = new Set(shapeTypes.map(t => t.type));
        if (!Array.isArray(next.items)) throw new Error(t('pidEditor.invalidItems'));
        for (const item of next.items) {
          if (!validPaths.has(item.tag)) throw new Error(t('pidEditor.unknownTag', { tag: item.tag }));
          if (![item.x,item.y].every(value=>Number.isFinite(value)&&value>=0&&value<=100)) throw new Error(t('pidEditor.invalidPosition', { tag: item.tag }));
          if (item.precision!==undefined&&(!Number.isInteger(item.precision)||item.precision<0||item.precision>8)) throw new Error(t('pidEditor.invalidPrecision', { tag: item.tag }));
        }
        if (!Array.isArray(next.shapes)) throw new Error(t('pidEditor.invalidShapes'));
        for (const shape of next.shapes) {
          if (!allowedShapeTypes.has(shape.type)) throw new Error(t('pidEditor.unknownShapeType', { type: shape.type }));
          if (![shape.x, shape.y].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error(t('pidEditor.invalidShapePosition', { id: shape.id }));
          if (![shape.width, shape.height].every(value => Number.isFinite(value) && value > 0 && value <= 100)) throw new Error(t('pidEditor.invalidShapeSize', { id: shape.id }));
          if (shape.rotation !== undefined && !Number.isFinite(shape.rotation)) throw new Error(t('pidEditor.invalidShapeRotation', { id: shape.id }));
          if (shape.tag && !validPaths.has(shape.tag)) throw new Error(t('pidEditor.unknownShapeTag', { id: shape.id, tag: shape.tag }));
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

// action: already-translated title prefix chosen by the caller.
async function askVariableValue(variable, action = t('variable.change')) {
  if (variable.type === 'BOOL') {
    return vscode.window.showQuickPick(['true', 'false'], {
      title: `${action}: ${variable.path}`,
      placeHolder: t('variable.currentValue', { value: displayValue(variable) })
    });
  }
  return vscode.window.showInputBox({
    title: `${action}: ${variable.path}`,
    value: String(variable.value),
    prompt: variable.type === 'TIME_MS' ? t('variable.typePromptMs', { type: variable.type }) : t('variable.typePrompt', { type: variable.type })
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

// Folder path ("a/b/c") of a variable in the variables tree. Segment labels
// are translated and must not contain '/'.
function variableTreePath(variable, metadata) {
  const source = metadata?.source || '', sourceName = path.basename(source, path.extname(source)).replace(/^\d+_/, '');
  const parts = variable.path.split('.'), root = parts[0];
  if (metadata?.rootKind === 'functionBlock') {
    const visible = root.toLowerCase() === 'main' ? parts.slice(1) : parts;
    return [t('variableTree.objectsAndFbs'), t('variableTree.blockInstances'), ...visible].join('/');
  }
  // legacy: also recognises Portuguese source/tag names (processo, objeto, Valvula).
  const processObject = metadata?.rootKind === 'structure' && (/process|processo|objeto/i.test(sourceName) || /^(PIT|TIT|FIT|LIT|AIT|Motor|Valvula|Valve)/i.test(root));
  if (processObject) return [t('variableTree.objectsAndFbs'), t('variableTree.processObjects'), ...parts].join('/');
  if (source.startsWith('globals/')) return [t('variableTree.dbsAndGvls'), sourceName || t('variableTree.globals'), ...parts].join('/');
  if (root.toLowerCase() === 'main') return [t('variableTree.programs'), root, ...parts.slice(1)].join('/');
  return [t('variableTree.otherVariables'), sourceName || t('variableTree.noSource'), ...parts].join('/');
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
  const panel = vscode.window.createWebviewPanel('hplc.references', t('references.panelTitle', { path: variablePath }), vscode.ViewColumn.One, { enableScripts: true });
  panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:1050px;margin:auto}h1{font-size:18px;margin:0}h2{font-size:13px;text-transform:uppercase;margin-top:20px}.path{font-family:var(--vscode-editor-font-family);color:var(--vscode-textLink-foreground)}.summary{color:var(--vscode-descriptionForeground);margin-top:5px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.location,.change{display:grid;grid-template-columns:1fr auto;gap:6px;padding:8px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}.location:hover,.change:hover{background:var(--vscode-list-hoverBackground)}.routine{font-weight:650}.file{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground)}ul{list-style:none;padding-left:18px}li{margin:5px 0}.node{display:inline-grid;grid-template-columns:minmax(220px,auto) auto;gap:3px 10px;align-items:center;padding:5px 7px;border:1px solid var(--vscode-panel-border);border-left:4px solid var(--vscode-testing-iconPassed);border-radius:2px;cursor:pointer}.node:hover{background:var(--vscode-list-hoverBackground)}.node.false{opacity:.68}.value{font-family:var(--vscode-editor-font-family);color:var(--vscode-debugTokenExpression-value)}.expression{grid-column:1/-1;font-size:10px;color:var(--vscode-descriptionForeground);white-space:normal}.leaf{font-weight:700}.empty{color:var(--vscode-descriptionForeground);padding:8px}@media(max-width:700px){.columns{grid-template-columns:1fr}}
</style></head><body><h1>${t('references.heading')}</h1><div class="path" id="title"></div><div class="summary">${t('references.summary')}</div><h2 id="traceTitle">${t('references.traceTitle')}</h2><div id="cause"></div><h2>${t('references.changesTitle')}</h2><div id="changes"></div><div class="columns"><section><h2>${t('references.writtenIn')}</h2><div id="writes"></div></section><section><h2>${t('references.readIn')}</h2><div id="reads"></div></section></div><script>
${webviewTranslator('references.client.')}
const vscode=acquireVsCodeApi(),d=${payload};document.getElementById('title').textContent=d.variablePath;
function locations(id,list){const root=document.getElementById(id);if(!list.length){root.className='empty';root.textContent=tr('references.client.none');return}for(const loc of list){const row=document.createElement('div');row.className='location';const info=document.createElement('div');const routine=document.createElement('div');routine.className='routine';routine.textContent=loc.routine;const file=document.createElement('div');file.className='file';file.textContent=loc.file+':'+loc.line;info.append(routine,file);const open=document.createElement('span');open.textContent=tr('references.client.open');row.append(info,open);row.onclick=()=>vscode.postMessage({type:'open',file:loc.file,line:loc.line});root.append(row)}}locations('writes',d.reference.writes||[]);locations('reads',d.reference.reads||[]);
const changes=document.getElementById('changes');if(!d.changes.length){changes.className='empty';changes.textContent=tr('references.client.noChanges')}for(const c of [...d.changes].reverse()){const row=document.createElement('div');row.className='change';const info=document.createElement('div');info.innerHTML='<span class="routine"></span><div class="file"></div>';info.children[0].textContent=(c.writer?.routine||tr('references.client.unknownSource'))+' · '+String(c.before)+' → '+String(c.after);info.children[1].textContent='scan '+c.scan+(c.writer?.file?' · '+c.writer.file+':'+c.writer.line:'');row.append(info);if(c.writer?.file){const open=document.createElement('span');open.textContent=tr('references.client.open');row.append(open);row.onclick=()=>vscode.postMessage({type:'open',file:c.writer.file,line:c.writer.line})}changes.append(row)}
if(d.traceScan!==null)document.getElementById('traceTitle').textContent=tr('references.client.traceAtScan',{scan:d.traceScan});function tree(node){const li=document.createElement('li'),box=document.createElement('span'),leaf=!node.children?.length;box.className='node'+(leaf?' leaf':'');const name=document.createElement('span');name.textContent=(node.negated?'NOT ':'')+node.tag;const value=document.createElement('span');value.className='value';value.textContent=node.value===undefined?'—':node.type==='BOOL'?(node.value?'TRUE':'FALSE'):String(node.value);box.append(name,value);if(node.expression||leaf){const expression=document.createElement('code');expression.className='expression';expression.textContent=node.expression||(node.writer?.file?tr('references.client.chainEnd'):tr('references.client.leaf'));box.append(expression)}if(node.writer?.file){box.title=node.writer.routine+' · '+node.writer.file+':'+node.writer.line;box.onclick=()=>vscode.postMessage({type:'open',file:node.writer.file,line:node.writer.line})}li.append(box);if(node.children?.length){const ul=document.createElement('ul');for(const child of node.children)ul.append(tree(child));li.append(ul)}return li}const root=document.createElement('ul');root.append(tree(d.cause));document.getElementById('cause').append(root);
</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message => { if (message.type === 'open') await openSourceLocation(project, message.file, message.line || 1); });
}

function sourceLocation(project, projectLine) {
  const mapped = readSourceMap(project).lines?.[String(projectLine)];
  return mapped ? { ...mapped, fsPath: path.join(project, mapped.file) } : undefined;
}

async function debugControlFor(project, action, updateUi = true) {
  if (!project || !hasLivePid(project)) {
    vscode.window.showWarningMessage(t('debug.startPlcFirst'));
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

async function openSourceLocation(project, file, line, preserveFocus = false) {
  const document = await vscode.workspace.openTextDocument(path.join(project, file));
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus, viewColumn: workbenchLayout ? vscode.ViewColumn.Two : vscode.ViewColumn.Active });
  const lineIndex = Math.min(document.lineCount - 1, Math.max(0, line - 1));
  const sourceLine = document.lineAt(lineIndex);
  const start = new vscode.Position(lineIndex, sourceLine.firstNonWhitespaceCharacterIndex);
  if (!preserveFocus) editor.selection = new vscode.Selection(start, start);
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
    const currentLocation = sourceMap.lines?.[String(debug.current_line)];
    if (followExecution && (debug.waiting_line || debug.waiting_routine) && currentLocation) {
      const key = `${activeProject}:${debug.scan}:${debug.current_line}`;
      if (key !== followedLocation) {
        await openSourceLocation(activeProject, currentLocation.file, currentLocation.line, true);
        followedLocation = key;
      }
    } else followedLocation = undefined;
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
      if ((debug.waiting_line || debug.waiting_routine) && current && path.join(activeProject, current.file) === editor.document.uri.fsPath) {
        const line = Math.max(0, current.line - 1);
        if (line < editor.document.lineCount) {
          currentDecorations.push({
            range: editor.document.lineAt(line).range,
            hoverMessage: t('liveEditor.nextInstruction', { scan: debug.scan })
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
    // The next cycle recovers automatically after a build/restart.
  } finally {
    liveUpdateBusy = false;
  }
}

function treeAction(label, description, icon, command, tooltip, args = []) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.kind = 'action';
  item.description = description;
  item.tooltip = tooltip;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = 'plcAction';
  item.command = { command, title: label, arguments: args };
  return item;
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
    // The two ways to start always stay on top: open an existing HPLC project
    // or convert a vendor PLCopenXML into a new project.
    const actions = [
      treeAction(t('tree.addProjectFolder'), t('tree.addProjectFolderDescription'), 'folder-opened', 'hplc.addProject',
        t('tree.addProjectFolderTooltip')),
      treeAction(t('tree.importXml'), t('tree.importXmlDescription'), 'cloud-download', 'hplc.importXml',
        t('tree.importXmlTooltip'))
    ];
    if (!projects.length) {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (folder && fs.readdirSync(folder).length === 0) {
        actions.push(treeAction(t('tree.initializeFolder'), path.basename(folder), 'new-folder', 'hplc.initializeFolder',
          t('tree.initializeFolderTooltip'), [folder]));
      }
      return actions;
    }
    return [...actions, ...projects.map(project => {
      const isActive = project === activeProject;
      const isRunning = hasLivePid(project);
      const manifest = projectManifest(project);
      const location = path.basename(path.dirname(project));
      const item = new vscode.TreeItem(manifest.name, vscode.TreeItemCollapsibleState.Expanded);
      item.kind = 'project';
      item.project = project;
      item.description = isRunning ? t('tree.projectRunning') : t('tree.projectStopped');
      item.id = project;
      item.iconPath = new vscode.ThemeIcon(isRunning ? 'debug-start' : 'circuit-board');
      item.tooltip = `${manifest.name}\n${t('tree.projectEntry', { task: manifest.task, program: manifest.program, interval: manifest.intervalMs })}\n${project}\n${isRunning ? t('tree.projectOnline', { pid: projectPid(project), port: projectPort(project) }) : t('tree.projectOffline')}`;
      item.contextValue = isRunning ? 'plcProjectRunning' : (isActive ? 'plcProjectStopped' : 'plcProjectInactive');
      if (!isActive) item.command = { command: 'hplc.activateProject', title: t('tree.activateProject'), arguments: [project] };
      return item;
    })];
  }
  projectChildren(project) { return this.folderChildren(project, project); }
  folderChildren(folder, project) {
    const ignored = new Set(['.plcsim', 'node_modules', '.git']);
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter(entry => !ignored.has(entry.name))
      .sort((a, b) => {
        const order = ['Imports', 'programs', 'routines', 'blocks', 'functions', 'globals', 'types', 'plcopen', 'panel', 'export', 'tests', 'runtime'];
        const rank = entry => entry.isDirectory() ? (order.includes(entry.name) ? order.indexOf(entry.name) : 50) : 100;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      })
      .map(entry => {
        const fsPath = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
          item.kind = 'folder';
          item.project = project;
          item.fsPath = fsPath;
          const labels = { Imports: [t('tree.folderImports'), 'cloud-download'], programs: [t('tree.folderPrograms'), 'code'], routines: [t('tree.folderRoutines'), 'list-tree'], blocks: [t('tree.folderBlocks'), 'symbol-class'], functions: [t('tree.folderFunctions'), 'symbol-method'], globals: [t('tree.folderGlobals'), 'symbol-variable'], types: [t('tree.folderTypes'), 'symbol-structure'], plcopen: [t('tree.folderPlcopen'), 'file-code'], panel: [t('tree.folderPanel'), 'dashboard'], export: [t('tree.folderExport'), 'export'], runtime: [t('tree.folderRuntime'), 'gear'] };
          if (folder === project && labels[entry.name]) {
            item.label = labels[entry.name][0];
            item.description = entry.name + '/';
            item.iconPath = new vscode.ThemeIcon(labels[entry.name][1]);
          } else item.iconPath = vscode.ThemeIcon.Folder;
          item.contextValue = 'plcFolder';
          return item;
        }
        const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
        item.kind = 'file';
        item.project = project;
        item.fsPath = fsPath;
        item.resourceUri = vscode.Uri.file(fsPath);
        item.command = { command: 'vscode.open', title: t('tree.openFile'), arguments: [item.resourceUri, { viewColumn: workbenchLayout ? vscode.ViewColumn.Two : vscode.ViewColumn.Active, preview: false }] };
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
      const empty = new vscode.TreeItem(t('processes.none'));
      empty.description = t('processes.noneDescription');
      empty.iconPath = new vscode.ThemeIcon('circle-slash');
      empty.contextValue = 'plcNoProcess';
      return [empty];
    }
    return running.map(({ project, pid }) => {
      const item = new vscode.TreeItem(path.basename(project));
      item.project = project;
      item.description = t('processes.description', { pid, port: projectPort(project) });
      item.tooltip = `${project}\n${t('processes.tooltip', { pid, panelUrl: projectUrl(project), pidUrl: projectPidUrl(project) })}`;
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
      const empty = new vscode.TreeItem(t('routines.startPlc'));
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    const state = this.state || lastDebugState || { mode: 'run', scan: 0, trace: [] };
    const sourceMap = readSourceMap(activeProject);
    const modeNames = { run: t('routines.modeRun'), paused: t('routines.modePaused'), line: t('routines.modeLine') };
    const manifest = projectManifest(activeProject);
    const statusItem = new vscode.TreeItem(`${manifest.task} → ${manifest.program} · ${modeNames[state.mode] || state.mode}`);
    statusItem.id = 'plc-debug-status';
    statusItem.description = t('routines.statusDescription', { scan: state.scan, interval: manifest.intervalMs });
    statusItem.iconPath = new vscode.ThemeIcon(state.mode === 'run' ? 'debug-start' : state.mode === 'line' ? 'debug-step-into' : 'debug-pause');
    statusItem.contextValue = 'plcDebugStatus';

    const current = sourceMap.lines?.[String(state.current_line)];
    if (state.waiting_line && current) {
      const lineItem = new vscode.TreeItem(t('routines.nextLine', { location: `${path.basename(current.file)}:${current.line}` }));
      lineItem.id = 'plc-debug-current-line';
      lineItem.description = t('routines.waitingCommand');
      lineItem.iconPath = new vscode.ThemeIcon('debug-stackframe-active');
      lineItem.command = { command: 'hplc.openRoutine', title: t('routines.openCurrentLine'), arguments: [current.file, current.line] };
      statusItem.children = [lineItem];
    }

    // The tree follows the call order. build.py delivers each POU with a
    // depth field; an item's parent is the last item of the level right
    // above. Without depth the list degrades to flat, as in older versions.
    const traced = (state.trace || []).map(projectLine => sourceMap.lines?.[String(projectLine)]).filter(Boolean);
    const roots = [];
    const openBranch = [];
    (sourceMap.routines || []).forEach((routine, index) => {
      const isCurrent = current && current.file === routine.file && current.line >= routine.startLine && current.line <= routine.endLine;
      const executed = traced.some(item => item.file === routine.file && item.line >= routine.startLine && item.line <= routine.endLine);
      const item = new vscode.TreeItem(routine.title || routine.name);
      item.id = `plc-routine-${index}-${routine.file}-${routine.startLine}`;
      item.description = isCurrent ? t('routines.currentLine', { line: current.line }) : executed ? t('routines.executed', { scan: state.scan }) : t('routines.notExecuted');
      item.iconPath = new vscode.ThemeIcon(isCurrent ? 'debug-stackframe-active' : executed ? 'pass-filled' : 'circle-outline');
      item.contextValue = isCurrent ? 'plcRoutineCurrent' : 'plcRoutine';
      item.command = { command: 'hplc.openRoutine', title: t('routines.openRoutine'), arguments: [routine.file, isCurrent ? current.line : routine.startLine] };
      item.plcChildren = [];
      item.plcIsBlock = String(routine.title || routine.name).startsWith('FB');
      const depth = Number.isInteger(routine.depth) ? Math.max(0, routine.depth) : 0;
      openBranch.length = Math.min(openBranch.length, depth);
      const parent = depth > 0 ? openBranch[depth - 1] : undefined;
      if (parent) parent.plcChildren.push(item); else roots.push(item);
      openBranch[depth] = item;
    });
    // Programs open expanded by default; function blocks arrive collapsed so
    // timer instances do not flood the view.
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
    this.message = t('variables.startPlc');
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
        item.description = `${displayValue(child.variable)} · ${child.variable.type}${child.variable.forced ? ` · ${t('variables.forced')}` : ''}`;
        item.tooltip = child.variable.path;
        item.iconPath = new vscode.ThemeIcon(child.variable.forced ? 'lock' : child.variable.type === 'BOOL' ? 'symbol-boolean' : 'symbol-number');
        item.contextValue = child.variable.forced ? 'plcVariableForced' : 'plcVariableWritable';
        item.command = { command: 'hplc.writeVariable', title: t('variables.writeOnce'), arguments: [child.variable] };
      }
      return item;
    });
  }
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    this.root = { children: new Map() };
    if (!activeProject || !hasLivePid(activeProject)) {
      this.message = t('variables.startActiveProject');
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
      this.message = t('variables.unavailable', { error: error.message });
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
    await this.context.workspaceState.update('hplc.activeProject', project);
    await this.context.globalState.update('hplc.activeProject', project);
    projectView?.refresh();
    debugView?.update();
  }
  async handle(message) {
    if (message.type === 'stopAll') { await vscode.commands.executeCommand('hplc.stopAll'); return; }
    const project = message.project;
    if (!project || !hasLivePid(project)) return;
    try {
      await this.activate(project);
      if (message.type === 'stop') { await vscode.commands.executeCommand('hplc.stop', project); return; }
      if (message.type === 'control') {
        const count = Math.min(100, Math.max(1, Number(message.count) || 1));
        let state;
        for (let index = 0; index < count; index++) state = await debugControlFor(project, message.action, false);
        if (followExecution && ['step_routine', 'step_line'].includes(message.action) && state?.current_line) {
          const location = sourceLocation(project, state.current_line);
          if (location) await openSourceLocation(project, location.file, location.line, true);
        }
        await updateLiveEditors();
      } else if (message.type === 'openRoutine' && message.file) {
        await openSourceLocation(project, message.file, message.line || 1);
      } else if (message.type === 'panel') await openEquipment(project);
      else if (message.type === 'pid') await openPid(project);
      await this.update();
    } catch (error) { vscode.window.showErrorMessage(`HPLC: ${error.message}`); }
  }
  html() {
    return `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{padding:5px;color:var(--vscode-foreground);font:12px var(--vscode-font-family);background:var(--vscode-sideBar-background)}.empty{color:var(--vscode-descriptionForeground);padding:8px}.toolbar{display:flex;justify-content:flex-end;margin-bottom:5px}.plc{border:1px solid var(--vscode-sideBarSectionHeader-border);border-radius:5px;margin-bottom:6px;overflow:hidden}.head{display:flex;align-items:center;gap:5px;padding:6px;background:var(--vscode-sideBarSectionHeader-background);cursor:pointer}.name{font-weight:700;flex:1}.mode{font-size:9px;font-weight:800}.run{color:var(--vscode-testing-iconPassed)}.paused,.routine,.line{color:var(--vscode-editorWarning-foreground)}.body{padding:6px}.hidden{display:none}.meta{color:var(--vscode-descriptionForeground);margin-bottom:5px;font-size:11px}.primary,.steps{display:flex;gap:4px;flex-wrap:wrap}.primary{margin-bottom:4px}.steps button{font-size:10px}.primary button{min-width:30px}.primary .stop{margin-left:auto}.steps{border-top:1px solid var(--vscode-sideBarSectionHeader-border);padding-top:4px}button{border:0;border-radius:3px;padding:3px 6px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-weight:650}button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.38;cursor:not-allowed}.play{color:var(--vscode-testing-iconPassed)}.pause{color:var(--vscode-editorWarning-foreground)}.stop{color:var(--vscode-errorForeground)}.equipment-button{margin-top:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.routines{margin-top:6px;border-top:1px solid var(--vscode-sideBarSectionHeader-border)}.routine-row{padding:3px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.routine-row:hover{background:var(--vscode-list-hoverBackground)}.routine-row.hidden{display:none}.routine-caret{display:inline-block;width:13px;text-align:center;opacity:.75}.routine-caret.leaf{opacity:0}.routine-row.executed{color:var(--vscode-testing-iconPassed)}.routine-row.current{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);font-weight:700}
</style></head><body><div class="toolbar"><button class="stop" onclick="vscode.postMessage({type:'stopAll'})">${t('runtimeControl.stopAll')}</button></div><div id="empty" class="empty">${t('runtimeControl.none')}</div><div id="list"></div><script>
${webviewTranslator('runtimeControl.')}
const vscode=acquireVsCodeApi(),list=document.getElementById('list'),empty=document.getElementById('empty'),cards=new Map();
function control(project,action,count=1){vscode.postMessage({type:'control',project,action,count})}
function ensure(p){let c=cards.get(p.project);if(c)return c;const root=document.createElement('section');root.className='plc';const head=document.createElement('div');head.className='head';const arrow=document.createElement('span');arrow.textContent='▾';const name=document.createElement('span');name.className='name';const mode=document.createElement('span');mode.className='mode';head.append(arrow,name,mode);const body=document.createElement('div');body.className='body';head.onclick=()=>{body.classList.toggle('hidden');arrow.textContent=body.classList.contains('hidden')?'▸':'▾'};const meta=document.createElement('div');meta.className='meta';const primary=document.createElement('div');primary.className='primary';for(const [label,action,cls] of [['▶','run','play'],['Ⅱ','pause','pause']]){const b=document.createElement('button');b.textContent=label;b.title=action==='run'?tr('runtimeControl.runLive'):tr('runtimeControl.pause');b.className=cls;b.onclick=()=>control(p.project,action);primary.append(b)}const stop=document.createElement('button');stop.textContent='■';stop.title=tr('runtimeControl.stopThis');stop.className='stop';stop.onclick=()=>vscode.postMessage({type:'stop',project:p.project});primary.append(stop);const steps=document.createElement('div');steps.className='steps';const stepButtons=[];for(const [label,action,count] of [[tr('runtimeControl.stepScan'),'scan',1],['+10','scan',10],['+100','scan',100],[tr('runtimeControl.stepRoutine'),'step_routine',1],[tr('runtimeControl.stepLine'),'step_line',1]]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>control(p.project,action,count);steps.append(b);stepButtons.push(b)}const panel=document.createElement('button');panel.className='equipment-button';panel.textContent=tr('runtimeControl.panel');panel.onclick=()=>vscode.postMessage({type:'panel',project:p.project});const pid=document.createElement('button');pid.className='equipment-button';pid.textContent='⌁ P&ID';pid.onclick=()=>vscode.postMessage({type:'pid',project:p.project});const routines=document.createElement('div');routines.className='routines';routines.hidden=true;body.append(meta,primary,steps,panel,pid);root.append(head,body);list.append(root);c={root,name,mode,meta,routines,stepButtons};cards.set(p.project,c);return c}
const collapsed=new Set();function applyFolds(rows){let hiddenDepth=null;rows.forEach((item,i)=>{const hasChild=rows[i+1]&&rows[i+1].depth>item.depth;item.caret.className='routine-caret'+(hasChild?'':' leaf');item.caret.textContent=hasChild?(collapsed.has(item.key)?'▸':'▾'):'·';if(hiddenDepth!==null&&item.depth>hiddenDepth){item.row.classList.add('hidden');return}hiddenDepth=null;item.row.classList.remove('hidden');if(hasChild&&collapsed.has(item.key))hiddenDepth=item.depth})}window.addEventListener('message',e=>{const m=e.data;if(m.type==='error'){empty.textContent=tr('runtimeControl.error',{error:m.message});empty.hidden=false;return}if(m.type!=='projects')return;empty.hidden=m.projects.length>0;const alive=new Set(m.projects.map(p=>p.project));for(const [key,c] of cards)if(!alive.has(key)){c.root.remove();cards.delete(key)}for(const p of m.projects){const c=ensure(p),names={run:tr('runtimeControl.modeRunning'),paused:tr('runtimeControl.modePaused'),routine:tr('runtimeControl.modePaused'),line:tr('runtimeControl.modePaused')};c.name.textContent=p.name;c.mode.textContent=names[p.mode]||p.mode;c.mode.className='mode '+p.mode;c.meta.textContent=tr('runtimeControl.meta',{pid:p.pid,port:p.port,pidPort:p.pidPort,scan:p.scan})+(p.current?tr('runtimeControl.next',{location:p.current.file.split('/').pop()+':'+p.current.line}):'');for(const button of c.stepButtons)button.disabled=p.mode==='run';const existing=new Map([...c.routines.children].map(x=>[x.dataset.key,x]));const rows=[];p.routines.forEach((r,i)=>{const key=i+':'+r.file+':'+r.startLine,depth=Number.isInteger(r.depth)?r.depth:0;let row=existing.get(key);if(!row){row=document.createElement('div');row.dataset.key=key;const caret=document.createElement('span');caret.className='routine-caret';const label=document.createElement('span');row.append(caret,label);c.routines.append(row)}else existing.delete(key);const [caret,label]=row.children;row.dataset.depth=depth;row.style.paddingLeft=(3+depth*13)+'px';label.textContent=(r.current?'▶ ':r.executed?'✓ ':'○ ')+(r.title||r.name);row.className='routine-row'+(r.current?' current':r.executed?' executed':'');row.onclick=()=>vscode.postMessage({type:'openRoutine',project:p.project,file:r.file,line:r.current&&p.current?p.current.line:r.startLine});caret.onclick=event=>{event.stopPropagation();if(collapsed.has(key))collapsed.delete(key);else collapsed.add(key);applyFolds(rows)};rows.push({row,caret,key,depth})});for(const row of existing.values())row.remove();applyFolds(rows)}});
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
    this.watchPaths = new Set(context.globalState.get('hplc.watchPaths', []));
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
            ? { routine: t('liveDebug.manualWriter'), file: '', line: 0 }
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
      await this.context.globalState.update('hplc.watchPaths', [...this.watchPaths]);
      await this.update();
      return;
    }
    if (message.type === 'clearWatch') {
      this.watchPaths.clear();
      await this.context.globalState.update('hplc.watchPaths', []);
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
        if (!result.ok) throw new Error(t('liveDebug.writeRejected', { path: variable.path }));
        this.manualWrites.set(variable.path, Date.now());
      } else if (message.type === 'direct') {
        const variable = this.variables.get(message.path);
        if (!variable) return;
        const result = await fetchJson(`${projectUrl(activeProject)}/api/set?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(message.value)}`);
        if (!result.ok) throw new Error(t('liveDebug.writeRejected', { path: variable.path }));
        this.manualWrites.set(variable.path, Date.now());
      } else if (['write', 'force'].includes(message.type)) {
        const variable = this.variables.get(message.path);
        if (!variable) return;
        const value = await askVariableValue(variable, message.type === 'force' ? t('liveDebug.forceContinuously') : t('variables.writeOnce'));
        if (value === undefined) return;
        const endpoint = message.type === 'force' ? 'force' : 'set';
        const suffix = message.type === 'force' ? '&enabled=1' : '';
        await fetchJson(`${projectUrl(activeProject)}/api/${endpoint}?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(value)}${suffix}`);
        this.manualWrites.set(variable.path, Date.now());
      } else if (message.type === 'unforce') {
        await fetchJson(`${projectUrl(activeProject)}/api/force?tag=${encodeURIComponent(message.path)}&val=0&enabled=0`);
      }
      await this.update();
    } catch (error) { vscode.window.showErrorMessage(`HPLC: ${error.message}`); }
  }
  html() {
    return `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{padding:8px;color:var(--vscode-foreground);font:12px var(--vscode-font-family);background:var(--vscode-sideBar-background)}
button,input{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 7px;border-radius:2px}button:hover{background:var(--vscode-button-hoverBackground)}
.status{padding:7px;border-left:4px solid var(--vscode-errorForeground);background:var(--vscode-textBlockQuote-background);margin-bottom:7px;font-weight:700}.status.online{border-color:var(--vscode-testing-iconPassed)}.project{display:block;font-size:11px;color:var(--vscode-descriptionForeground);font-weight:400;margin-top:2px}.search{width:calc(100% - 14px);margin-bottom:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
details{border-top:1px solid var(--vscode-sideBarSectionHeader-border);padding:4px 0 0 7px}summary{font-weight:600;cursor:pointer}.row{display:grid;grid-template-columns:18px minmax(72px,1fr) 82px auto;gap:5px;align-items:center;padding:3px 2px 3px 4px}.row:hover{background:var(--vscode-list-hoverBackground)}
.name{overflow:hidden;text-overflow:ellipsis}.writer{display:block;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground);font-size:9px;font-weight:400}.value{font-family:var(--vscode-editor-font-family);color:var(--vscode-debugTokenExpression-value)}button.value{padding:2px 5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.value.true{background:var(--vscode-testing-iconPassed);color:#111}input.value{width:74px;padding:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}.forced{color:var(--vscode-editorWarning-foreground);font-weight:bold}.actions button{padding:1px 4px;background:transparent;color:var(--vscode-foreground)}.hidden{display:none}
.watch{border:1px solid var(--vscode-sideBarSectionHeader-border);margin-bottom:7px}.watch-head{display:flex;align-items:center;padding:5px 7px;background:var(--vscode-sideBarSectionHeader-background);font-weight:700}.watch-head span{flex:1}.watch-head button,.star{padding:1px 4px;background:transparent;color:var(--vscode-foreground)}.watch-list{padding:3px 5px}.watch-item{display:grid;grid-template-columns:minmax(80px,1fr) auto;gap:5px;padding:2px;font-family:var(--vscode-editor-font-family)}.watch-item .watch-value{font-weight:700;color:var(--vscode-debugTokenExpression-value)}canvas{display:block;width:100%;height:90px;border-top:1px solid var(--vscode-sideBarSectionHeader-border);background:var(--vscode-editor-background)}.watch-empty{padding:7px;color:var(--vscode-descriptionForeground)}
.watch,.star{display:none}.row{grid-template-columns:minmax(72px,1fr) 82px auto}
</style></head><body>
<div id="status" class="status">● OFFLINE<span class="project">${t('liveDebug.noActiveProject')}</span></div><section class="watch"><div class="watch-head"><span>${t('liveDebug.watchTitle')}</span><button id="clearWatch" title="${t('liveDebug.clearWatchTitle')}">${t('liveDebug.clearWatch')}</button></div><div id="watchList" class="watch-list"><div class="watch-empty">${t('liveDebug.watchEmpty')}</div></div><canvas id="trend"></canvas></section><input id="search" class="search" placeholder="${t('liveDebug.filterPlaceholder')}"><div id="groups"></div>
<script>
${webviewTranslator('liveDebug.')}
const vscode=acquireVsCodeApi(),groups=document.getElementById('groups'),statusEl=document.getElementById('status'),search=document.getElementById('search'),watchList=document.getElementById('watchList'),canvas=document.getElementById('trend');
const rows=new Map(),containers=new Map(),history=new Map();let currentProject='',watchPaths=new Set();
function fmt(v){if(v.type==='BOOL')return v.value?'TRUE':'FALSE';if(v.type==='TIME_MS')return 'T#'+v.value+'ms';const n=Number(v.value);return Number.isFinite(n)?n.toFixed(Number.isInteger(n)?0:2):String(v.value)}
function ensure(v){if(rows.has(v.path))return rows.get(v.path);const parts=(v.treePath||v.path.replaceAll('.','/')).split('/'),leaf=parts.pop();let parent=groups,key='';for(const part of parts){key=key?key+'/'+part:part;let box=containers.get(key);if(!box){box=document.createElement('details');box.open=!key.includes('/');const s=document.createElement('summary');s.textContent=part;box.append(s);parent.append(box);containers.set(key,box)}parent=box}const row=document.createElement('div');row.className='row';row.dataset.path=((v.treePath||'')+' '+v.path).toLowerCase();const star=document.createElement('button');star.className='star';star.title=tr('liveDebug.toggleWatch');star.onclick=()=>vscode.postMessage({type:'watch',path:v.path});const name=document.createElement('span');name.className='name';name.title=v.path;const label=document.createElement('span');label.textContent=leaf;const writer=document.createElement('small');writer.className='writer';name.append(label,writer);const value=document.createElement(v.type==='BOOL'?'button':'input');value.className='value';if(v.type==='BOOL'){value.onclick=()=>vscode.postMessage({type:'toggle',path:v.path})}else{value.type='number';value.step='any';value.onkeydown=e=>{if(e.key==='Enter'){vscode.postMessage({type:'direct',path:v.path,value:value.value});value.blur()}};value.onchange=()=>vscode.postMessage({type:'direct',path:v.path,value:value.value})}const actions=document.createElement('span');actions.className='actions';for(const [label,type,title] of [['↔','references',tr('liveDebug.references')],['🔒','force',tr('liveDebug.force')],['🔓','unforce',tr('liveDebug.unforce')]]){const b=document.createElement('button');b.textContent=label;b.title=title;b.onclick=()=>vscode.postMessage({type,path:v.path});actions.append(b)}row.append(star,name,value,actions);parent.append(row);const item={row,star,value,writer,type:v.type};rows.set(v.path,item);return item}
function renderWatch(vars){const byPath=new Map(vars.map(v=>[v.path,v])),watched=[...watchPaths].map(p=>byPath.get(p)).filter(Boolean);watchList.replaceChildren();if(!watched.length){const e=document.createElement('div');e.className='watch-empty';e.textContent=tr('liveDebug.watchEmpty');watchList.append(e)}for(const v of watched){const row=document.createElement('div');row.className='watch-item';const n=document.createElement('span');n.textContent=v.path;n.title=v.path;const val=document.createElement('span');val.className='watch-value';val.textContent=fmt(v);row.append(n,val);watchList.append(row);const series=history.get(v.path)||[];series.push(Number(v.type==='BOOL'?!!v.value:v.value));if(series.length>120)series.shift();history.set(v.path,series)}drawTrend(watched.slice(0,6))}
function drawTrend(watched){const ratio=devicePixelRatio||1,w=Math.max(180,canvas.clientWidth),h=90;canvas.width=w*ratio;canvas.height=h*ratio;const c=canvas.getContext('2d');c.scale(ratio,ratio);const css=getComputedStyle(document.body),grid=css.getPropertyValue('--vscode-sideBarSectionHeader-border')||'#888',fg=css.getPropertyValue('--vscode-foreground')||'#ddd';c.strokeStyle=grid;c.lineWidth=1;for(let y=22;y<h;y+=22){c.beginPath();c.moveTo(0,y+.5);c.lineTo(w,y+.5);c.stroke()}const colors=['#4b9cd3','#d98e32','#50a66a','#c75c5c','#8d72b8','#2c9c9c'];watched.forEach((v,i)=>{const s=history.get(v.path)||[];if(s.length<2)return;let min=Math.min(...s),max=Math.max(...s);if(min===max){min-=1;max+=1}c.strokeStyle=colors[i];c.lineWidth=1.5;c.beginPath();s.forEach((n,j)=>{const x=j/(119)*w,y=h-5-(n-min)/(max-min)*(h-10);j?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();c.fillStyle=colors[i];c.fillRect(5,5+i*11,7,7);c.fillStyle=fg;c.font='9px sans-serif';c.fillText(v.path.split('.').pop(),15,12+i*11)})}
document.getElementById('clearWatch').onclick=()=>vscode.postMessage({type:'clearWatch'});
window.addEventListener('message',event=>{const m=event.data;if(m.project!==undefined&&m.project!==currentProject){currentProject=m.project;groups.replaceChildren();rows.clear();containers.clear();history.clear()}if(m.type==='offline'){statusEl.className='status';statusEl.innerHTML='● OFFLINE<span class="project">'+(m.project||tr('liveDebug.noActiveProject'))+'</span>';for(const item of rows.values()){if(item.type==='BOOL')item.value.textContent='—';else item.value.value=''}return}if(m.type==='error'){statusEl.className='status';statusEl.innerHTML='● '+tr('liveDebug.noCommunication')+'<span class="project">'+m.message+'</span>';return}if(m.type!=='state')return;statusEl.className='status online';const modes={run:tr('liveDebug.modeRunning'),paused:tr('liveDebug.modePaused'),routine:tr('liveDebug.modeRoutine'),line:tr('liveDebug.modeLine')};statusEl.innerHTML='● ONLINE · '+(modes[m.mode]||m.mode)+'<span class="project">'+tr('liveDebug.onlineMeta',{project:m.project,port:m.port,scan:m.scan,count:m.variableCount||0})+'</span>';for(const v of m.variables){const item=ensure(v);if(v.type==='BOOL'){item.value.textContent=v.value?'TRUE':'FALSE';item.value.className='value '+(v.value?'true ':'')+(v.forced?'forced':'')}else if(document.activeElement!==item.value)item.value.value=String(v.value);item.value.title=v.type+(v.forced?' · '+tr('liveDebug.forced'):'')}
watchPaths=new Set(m.watchPaths||[]);for(const [p,item] of rows){item.star.textContent=watchPaths.has(p)?'★':'☆';const w=m.lastWriters?.[p];item.writer.textContent=w?('↳ '+w.routine+' · scan '+w.scan):'';item.row.title=w&&w.file?tr('liveDebug.lastChange',{location:w.file+':'+w.line}):''}renderWatch(m.variables||[])});
search.addEventListener('input',()=>{const q=search.value.toLowerCase();for(const item of rows.values())item.row.classList.toggle('hidden',!item.row.dataset.path.includes(q))});
</script></body></html>`;
  }
}

async function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('HPLC');
  diagnosticCollection = vscode.languages.createDiagnosticCollection('hplc');
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
    after: { contentText: t('debug.nextLineMarker'), color: new vscode.ThemeColor('editorWarning.foreground'), fontWeight: 'bold' }
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
  const tree = vscode.window.createTreeView('hplc.projects', { treeDataProvider: projectView });

  liveCode = createLiveCode(vscode, {
    name: project => projectManifest(project).name,
    running: hasLivePid,
    state: project => fetchJson(`${projectUrl(project)}/api/debug`),
    variables: project => fetchJson(`${projectUrl(project)}/api/variables`),
    control: (project, action) => debugControlFor(project, action, false),
    stop: project => vscode.commands.executeCommand('hplc.stop', project),
    source: openSourceLocation
  });
  context.subscriptions.push(liveCode);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = t('status.selectProject');
  status.command = 'hplc.selectProject';
  status.show();

  const refreshUi = () => {
    const running = activeProject ? hasLivePid(activeProject) : false;
    status.text = activeProject
      ? `${running ? '$(debug-start)' : '$(debug-stop)'} PLC: ${path.basename(activeProject)}${running ? t('status.runningSuffix') : ''}`
      : t('status.selectProject');
    status.command = running ? 'hplc.stop' : (activeProject ? 'hplc.play' : 'hplc.selectProject');
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
    registerCommand('hplc.initializeFolder', async folder => {
      if (!folder) return;
      try {
        copyProjectTemplate(context, folder); resetProjectContent(folder);
        const manifestFile = path.join(folder, 'plc.toml');
        fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(/^name\s*=.*$/m, `name = ${JSON.stringify(path.basename(folder))}`));
        activeProject = await rememberProject(folder);
        await context.globalState.update('hplc.activeProject', activeProject);
        await context.workspaceState.update('hplc.activeProject', activeProject);
        refreshUi();
      } catch (error) { vscode.window.showErrorMessage(error.message); }
    }),
    registerCommand('hplc.openLiveCode', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (project && fs.existsSync(path.join(project, '.plcsim/build/project.st'))) liveCode.open(project);
      else vscode.window.showInformationMessage(t('liveCode.playFirst'));
    }),
    registerCommand('hplc.openWorkbench', openWorkbench),
    registerCommand('hplc.viewProject', openWorkbench),
    registerCommand('hplc.toggleFollowExecution', async () => {
      followExecution = !followExecution; followedLocation = undefined;
      await vscode.commands.executeCommand('setContext', 'hplc.followExecution', followExecution);
      await updateLiveEditors();
      vscode.window.showInformationMessage(followExecution ? t('debug.followOn') : t('debug.followOff'));
    }),
    registerCommand('hplc.refresh', async () => { discoveredProjectCache = undefined; await discoverProjects(true); projectView.refresh(); runtimeControlView.update(); }),
    registerCommand('hplc.addProject', async () => {
      try {
        const project = await chooseProjectFolder();
        if (!project) return;
        activeProject = project;
        await context.globalState.update('hplc.activeProject', project);
        await context.workspaceState.update('hplc.activeProject', project);
        refreshUi(); debugView.update();
        vscode.window.showInformationMessage(t('project.added', { name: projectManifest(project).name }));
      } catch (error) { vscode.window.showErrorMessage(t('project.addFailed', { error: error.message })); }
    }),
    registerCommand('hplc.removeProject', async item => {
      const project = typeof item === 'string' ? item : item?.project;
      if (!project) return;
      if (hasLivePid(project)) { vscode.window.showWarningMessage(t('project.stopBeforeRemove')); return; }
      await forgetProject(project); refreshUi(); debugView.update();
    }),
    registerCommand('hplc.configureProject', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (project) await openProjectSettings(project);
    }),
    registerCommand('hplc.editMapping', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (!project) return;
      if (!fs.existsSync(path.join(project, '.plcsim', 'build', 'variables.json'))) {
        vscode.window.showWarningMessage(t('catalog.buildFirst'));
      }
      // The real editor lives in the page served by the runtime (block palette,
      // drag, PNG background, Save writing the JSON through the local endpoint).
      // This webview is the fallback for when the runtime cannot start
      // (no toolchain, for example).
      await vscode.commands.executeCommand('hplc.openPanel');
      if (hasLivePid(project)) {
        vscode.window.showInformationMessage(t('mapping.useEditButton'));
        return;
      }
      await openMappingEditor(project);
    }),
    registerCommand('hplc.editPid', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (!project) return;
      if (!fs.existsSync(path.join(project, '.plcsim', 'build', 'variables.json'))) vscode.window.showWarningMessage(t('catalog.buildFirst'));
      // The real editor lives in the page served by the runtime (block palette,
      // drag, PNG background, Save writing the JSON through the local endpoint).
      // This webview is the fallback for when the runtime cannot start
      // (no toolchain, for example).
      await vscode.commands.executeCommand('hplc.openPid');
      if (hasLivePid(project)) {
        vscode.window.showInformationMessage(t('pid.useEditButton'));
        return;
      }
      await openPidEditor(project);
    }),
    registerCommand('hplc.runScenarios', async item => {
      try {
        const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
        if (project) await openScenarioRunner(project);
      } catch (error) { vscode.window.showErrorMessage(t('scenarios.failed', { error: error.message })); }
    }),
    registerCommand('hplc.importReport', async item => {
      try {
        const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
        if (project) await openImportReport(project);
      } catch (error) { vscode.window.showErrorMessage(t('importReport.failed', { error: error.message })); }
    }),
    registerCommand('hplc.configurePanel', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || await requireProject(context);
      if (!project) return;
      const selected = await vscode.window.showQuickPick([
        { label: t('configurePanel.panelLabel'), description: t('configurePanel.panelDescription'), kind: 'panel' },
        { label: t('configurePanel.pidLabel'), description: t('configurePanel.pidDescription'), kind: 'pid' }
      ], { title: t('configurePanel.title') });
      if (!selected) return;
      // panelConfigFile: panel/panel.json, legacy panel/painel.json, else panel/panel.json (new).
      const target = selected.kind === 'pid' ? path.join(project, 'panel', 'pid.json') : panelConfigFile(project);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const templatePanel = path.join(context.extensionPath, 'template', 'plc-project', 'panel');
        let source = path.join(templatePanel, selected.kind === 'pid' ? 'pid.json' : 'panel.json');
        // legacy: older templates ship painel.json
        if (!fs.existsSync(source) && selected.kind !== 'pid') source = path.join(templatePanel, 'painel.json');
        fs.copyFileSync(source, target);
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
      vscode.window.showInformationMessage(selected.kind === 'pid' ? t('configurePanel.pidHint') : t('configurePanel.panelHint'));
    }),
    registerCommand('hplc.newProject', async () => {
      try {
        const target = await chooseNewProjectTarget(t('newProject.folderTitle'));
        if (!target) return;
        copyProjectTemplate(context, target);
        resetProjectContent(target);
        const name = path.basename(target).replace(/"/g, '');
        const manifest = fs.readFileSync(path.join(target, 'plc.toml'), 'utf8').replace(/^name\s*=.*$/m, `name = "${name}"`);
        fs.writeFileSync(path.join(target, 'plc.toml'), manifest);
        activeProject = target;
        await rememberProject(target);
        await context.workspaceState.update('hplc.activeProject', target);
        await context.globalState.update('hplc.activeProject', target);
        refreshUi();
        vscode.window.showInformationMessage(t('newProject.created', { name }));
      } catch (error) { vscode.window.showErrorMessage(t('newProject.failed', { error: error.message })); }
    }),
    registerCommand('hplc.importXml', async () => {
      try {
        const picked = await vscode.window.showOpenDialog({ title: t('importXml.step1Title'), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { PLCopenXML: ['xml'] }, openLabel: t('importXml.useThisXml') });
        if (!picked?.length) return;
        // The Imports/ folder usually lives inside the vendor project: the
        // dialog opens one level above the XML and suggests the file name.
        const xmlDir = path.dirname(picked[0].fsPath);
        const target = await chooseNewProjectTarget(t('importXml.step2Title'), {
          defaultName: path.basename(picked[0].fsPath, path.extname(picked[0].fsPath)),
          near: path.basename(xmlDir).toLowerCase() === 'imports' ? path.dirname(xmlDir) : xmlDir
        });
        if (!target) return;
        copyProjectTemplate(context, target);
        resetProjectContent(target);
        output.show(true);
        output.appendLine(t('importXml.outputHeader', { file: picked[0].fsPath }));
        await runProcess('python3', [path.join(target, 'runtime', 'import_plcopenxml.py'), picked[0].fsPath, target, '--active'], target);
        archiveImportedXml(target, picked[0].fsPath);
        const imported = applyImportedManifest(target);
        activeProject = target;
        await rememberProject(target);
        await context.workspaceState.update('hplc.activeProject', target);
        await context.globalState.update('hplc.activeProject', target);
        refreshUi();
        await reportImport(target, imported);
      } catch (error) { vscode.window.showErrorMessage(t('importXml.cancelled', { error: error.message })); output.show(true); }
    }),
    // Import into an existing project. Previously only the path that creates a
    // new folder existed, so an empty project could not receive an XML.
    registerCommand('hplc.importXmlInto', async item => {
      const requested = typeof item === 'string' ? item : item?.project;
      const root = requested || await requireProject(context);
      if (!root) return;
      try {
        const picked = await vscode.window.showOpenDialog({ title: t('importXmlInto.pickTitle'), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { PLCopenXML: ['xml'] }, openLabel: t('importXmlInto.openLabel') });
        if (!picked?.length) return;
        const replaceSources = t('importXmlInto.replaceSources');
        const confirm = await vscode.window.showWarningMessage(
          t('importXmlInto.confirm', { project: path.basename(root), folders: PROJECT_SOURCE_FOLDERS.join(', ') }),
          { modal: true }, replaceSources
        );
        if (confirm !== replaceSources) return;
        resetProjectContent(root);
        output.show(true);
        output.appendLine(t('importXmlInto.outputHeader', { project: path.basename(root), file: picked[0].fsPath }));
        await runProcess('python3', [path.join(root, 'runtime', 'import_plcopenxml.py'), picked[0].fsPath, root, '--active'], root);
        archiveImportedXml(root, picked[0].fsPath);
        const imported = applyImportedManifest(root);
        activeProject = root;
        await rememberProject(root);
        await context.workspaceState.update('hplc.activeProject', root);
        await context.globalState.update('hplc.activeProject', root);
        refreshUi();
        await reportImport(root, imported);
      } catch (error) { vscode.window.showErrorMessage(t('importXml.cancelled', { error: error.message })); output.show(true); }
    }),
    registerCommand('hplc.togglePause', async item => {
      const project = (typeof item === 'string' ? item : item?.project) || activeProject;
      if (!project) return;
      try {
        const current = await fetchJson(`${projectUrl(project)}/api/debug`);
        await debugControlFor(project, current.mode === 'run' ? 'pause' : 'run');
      } catch (error) { vscode.window.showErrorMessage(t('debug.togglePauseFailed', { error: error.message })); }
    }),
    registerCommand('hplc.refreshVariables', () => variablesView.refresh()),
    registerCommand('hplc.debugRun', async () => { try { await debugControl('run'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    registerCommand('hplc.debugPause', async () => { try { await debugControl('pause'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    registerCommand('hplc.debugStepScan', async () => { try { await debugControl('scan'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    registerCommand('hplc.debugLineMode', async () => { try { await debugControl('line'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    registerCommand('hplc.debugStepLine', async () => { try { await debugControl('next'); } catch (error) { vscode.window.showErrorMessage(error.message); } }),
    registerCommand('hplc.openRoutine', async (file, line) => {
      if (activeProject && file) await openSourceLocation(activeProject, file, line || 1);
    }),
    registerCommand('hplc.selectProject', async () => {
      await chooseProject(context, true);
      refreshUi();
    }),
    registerCommand('hplc.activateProject', async project => {
      activeProject = project;
      await context.workspaceState.update('hplc.activeProject', project);
      await context.globalState.update('hplc.activeProject', project);
      refreshUi();
      variablesView.refresh();
      debugView.update();
    }),
    registerCommand('hplc.playProject', async project => {
      project = typeof project === 'string' ? project : project?.project;
      if (project && project !== activeProject) {
        activeProject = project;
        await context.workspaceState.update('hplc.activeProject', project);
        await context.globalState.update('hplc.activeProject', project);
      }
      await vscode.commands.executeCommand('hplc.play');
    }),
    registerCommand('hplc.openProjectPanel', async project => {
      project = typeof project === 'string' ? project : project?.project;
      if (project && project !== activeProject) {
        activeProject = project;
        await context.workspaceState.update('hplc.activeProject', project);
        await context.globalState.update('hplc.activeProject', project);
        refreshUi();
      }
      await vscode.commands.executeCommand('hplc.openPanel');
    }),
    registerCommand('hplc.openProjectPid', async project => {
      project = typeof project === 'string' ? project : project?.project;
      if (project && project !== activeProject) {
        activeProject = project;
        await context.workspaceState.update('hplc.activeProject', project);
        await context.globalState.update('hplc.activeProject', project);
        refreshUi();
      }
      await vscode.commands.executeCommand('hplc.openPid');
    }),
    registerCommand('hplc.build', async () => {
      const root = await requireProject(context);
      if (!root) return;
      output.show(true);
      output.appendLine(`\n=== BUILD: ${root} ===`);
      const result = await buildProject(root);
      if (result.code === 0) {
        publishBuildDiagnostics(root, result.transcript);
        vscode.window.showInformationMessage(t('build.succeeded'));
      } else await showBuildFailure(root, result.transcript);
    }),
    registerCommand('hplc.play', async () => {
      const root = await requireProject(context);
      if (!root) return;
      if (hasLivePid(root)) {
        await openSimulationViews(root);
        refreshUi();
        return;
      }
      if (startingProjects.has(root)) {
        vscode.window.showInformationMessage(t('play.stillCompiling'));
        return;
      }
      startingProjects.add(root);
      output.show(true);
      output.appendLine(`\n=== PLAY: ${root} ===`);
      output.appendLine(t('play.validating'));
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
        output.appendLine(t('play.runtimeExited', { code }));
        if (code && code !== 0) {
          vscode.window.showErrorMessage(t('play.runtimeFailed', { code }));
          output.show(true);
        }
        refreshUi();
      }, {
        HPLC_PORT: String(ports.panel), HPLC_PID_PORT: String(ports.pid), HPLC_SKIP_BUILD: '1',
        // legacy: runtime/ copied into older projects still reads the old names
        PLC_CODEX_PORT: String(ports.panel), PLC_CODEX_PID_PORT: String(ports.pid), PLC_CODEX_SKIP_BUILD: '1'
      });
      runtimes.set(root, child);
      refreshUi();
      try {
        await waitForServer(projectUrl(root), child);
        vscode.window.showInformationMessage(t('play.running', { name: projectManifest(root).name, panel: ports.panel, pid: ports.pid }));
        refreshUi();
        await variablesView.refresh();
        await openSimulationViews(root);
      } catch (error) {
        vscode.window.showErrorMessage(`HPLC: ${error.message}`);
        output.show(true);
      }
    }),
    registerCommand('hplc.stop', async item => {
      const requested = typeof item === 'string' ? item : item?.project;
      const root = requested || await requireProject(context);
      if (!root) return;
      output.appendLine(`\n=== STOP: ${root} ===`);
      runScript(root, 'stop.sh', code => {
        if (code === 0) vscode.window.showInformationMessage(t('stop.stopped'));
        else vscode.window.showErrorMessage(t('stop.failed', { code }));
        refreshUi();
        variablesView.refresh();
      });
      runtimes.delete(root);
      refreshUi();
    }),
    registerCommand('hplc.stopAll', async () => {
      const running = (await discoverProjects()).filter(hasLivePid);
      if (!running.length) { vscode.window.showInformationMessage(t('stop.noneRunning')); return; }
      for (const root of running) {
        output.appendLine(`\n=== STOP ALL: ${root} ===`);
        runScript(root, 'stop.sh', () => refreshUi());
        runtimes.delete(root);
      }
      vscode.window.showInformationMessage(t(running.length > 1 ? 'stop.stoppingMany' : 'stop.stoppingOne', { count: running.length }));
      refreshUi(); debugView.update();
    }),
    registerCommand('hplc.openPanel', async () => {
      const root = await requireProject(context);
      if (!root) return;
      if (!hasLivePid(root)) {
        await vscode.commands.executeCommand('hplc.play');
        if (!hasLivePid(root)) return;
      }
      try {
        await waitForServer(projectUrl(root), runtimes.get(root) || { exitCode: null });
      } catch (error) {
        vscode.window.showErrorMessage(`HPLC: ${error.message}`);
        return;
      }
      await openEquipment(root);
    }),
    registerCommand('hplc.openPid', async () => {
      const root = await requireProject(context);
      if (!root) return;
      if (!hasLivePid(root)) {
        await vscode.commands.executeCommand('hplc.play');
        if (!hasLivePid(root)) return;
      }
      try {
        await waitForServer(projectPidUrl(root), runtimes.get(root) || { exitCode: null });
      } catch (error) {
        vscode.window.showErrorMessage(`HPLC P&ID: ${error.message}`);
        return;
      }
      await openPid(root);
    }),
    registerCommand('hplc.writeVariable', async variable => {
      if (!activeProject || !hasLivePid(activeProject)) return;
      const value = await askVariableValue(variable, t('variables.writeOnce'));
      if (value === undefined) return;
      try {
        const result = await fetchJson(`${projectUrl(activeProject)}/api/set?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(value)}`);
        if (!result.ok) throw new Error(t('variables.writeRejected'));
        await variablesView.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(t('variables.writeFailed', { path: variable.path, error: error.message }));
      }
    }),
    registerCommand('hplc.forceVariable', async variable => {
      if (!activeProject || !hasLivePid(activeProject)) return;
      const value = await askVariableValue(variable, t('variables.forceContinuously'));
      if (value === undefined) return;
      try {
        const result = await fetchJson(`${projectUrl(activeProject)}/api/force?tag=${encodeURIComponent(variable.path)}&val=${encodeURIComponent(value)}&enabled=1`);
        if (!result.ok) throw new Error(t('variables.forceRejected'));
        await variablesView.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(t('variables.forceFailed', { path: variable.path, error: error.message }));
      }
    }),
    registerCommand('hplc.unforceVariable', async variable => {
      if (!activeProject || !hasLivePid(activeProject)) return;
      try {
        const result = await fetchJson(`${projectUrl(activeProject)}/api/force?tag=${encodeURIComponent(variable.path)}&val=0&enabled=0`);
        if (!result.ok) throw new Error(t('variables.unforceRejected'));
        await variablesView.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(t('variables.unforceFailed', { path: variable.path, error: error.message }));
      }
    }),
    registerCommand('hplc.exportXml', async item => {
      const requested = typeof item === 'string' ? item : item?.project;
      const root = requested || await requireProject(context);
      if (!root) return;
      // Two destinations: back into the SAME vendor project (full, on top of the
      // imported XML) or only the ST logic, to pull into any project.
      const imported = fs.existsSync(path.join(root, 'plcopen', 'original.xml'));
      const mode = await vscode.window.showQuickPick([
        { label: t('export.fullLabel'), value: 'full',
          description: imported ? t('export.fullDescription') : t('export.fullUnavailable'),
          detail: t('export.fullDetail') },
        { label: t('export.logicLabel'), value: 'logic',
          description: '_Application.xml + routines/*.st',
          detail: t('export.logicDetail') }
      ], { title: t('export.title', { name: projectManifest(root).name }) });
      if (!mode) return;
      if (mode.value === 'full' && !imported) {
        vscode.window.showWarningMessage(t('export.fullNeedsImport'));
        return;
      }
      // Base of the full export: the XML that receives the changes. Default is
      // the imported XML; a newer XML from the vendor keeps what was changed in
      // the IDE after the import (the export aborts on conflict).
      // Each export goes to its own subfolder: export/YYYY-MM-DD_HHMMSS_<mode>.
      const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace('T', '_').replace(/:/g, '').slice(0, 17);
      const exportDir = path.join(root, 'export', `${stamp}_${mode.value}`);
      const env = { HPLC_EXPORT_MODE: mode.value, HPLC_EXPORT_DIR: exportDir, HPLC_PROJECT_ROOT: root };
      if (mode.value === 'full') {
        const pick = await vscode.window.showQuickPick([
          { label: t('export.baseImported'), description: 'plcopen/original.xml', value: 'original' },
          { label: t('export.baseOther'), description: t('export.baseOtherDescription'), value: 'other' }
        ], { title: t('export.baseTitle') });
        if (!pick) return;
        if (pick.value === 'other') {
          const imports = [path.join(root, '..', 'Imports'), path.join(root, 'Imports')].find(dir => fs.existsSync(dir));
          const chosen = await vscode.window.showOpenDialog({
            canSelectMany: false, filters: { PLCopenXML: ['xml'] }, title: t('export.baseDialogTitle'),
            defaultUri: imports ? vscode.Uri.file(imports) : undefined
          });
          if (!chosen?.length) return;
          env.HPLC_EXPORT_BASE = chosen[0].fsPath;
        }
      }
      output.show(true);
      output.appendLine(t('export.outputHeader', {
        mode: mode.value === 'full' ? t('export.modeFull') : t('export.modeLogic'),
        root, base: env.HPLC_EXPORT_BASE ? t('export.outputBase', { base: env.HPLC_EXPORT_BASE }) : ''
      }));
      // Export with the installed extension's exporter, not the copy in the project's runtime/.
      const exporter = path.join(context.extensionPath, 'template', 'plc-project', 'runtime', 'export_plcopenxml.py');
      const finished = async code => {
        let reportPath = path.join(exportDir, 'EXPORT_REPORT.md');
        let reportJson = path.join(exportDir, 'EXPORT_REPORT.json');
        // legacy: older exporters wrote RELATORIO_EXPORT.*
        if (!fs.existsSync(reportPath) && fs.existsSync(path.join(exportDir, 'RELATORIO_EXPORT.md'))) reportPath = path.join(exportDir, 'RELATORIO_EXPORT.md');
        if (!fs.existsSync(reportJson) && fs.existsSync(path.join(exportDir, 'RELATORIO_EXPORT.json'))) reportJson = path.join(exportDir, 'RELATORIO_EXPORT.json');
        let report = {};
        try { report = JSON.parse(fs.readFileSync(reportJson, 'utf8')); } catch (_) {}
        const openReport = () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(reportPath));
        const openReportLabel = t('export.openReport');
        const folder = `export/${path.basename(exportDir)}/`;
        if (code !== 0) {
          const choice = await vscode.window.showErrorMessage(t('export.failed', { code }), openReportLabel);
          if (choice && fs.existsSync(reportPath)) openReport();
          return;
        }
        if (mode.value === 'logic') {
          let files = [];
          try { files = fs.readdirSync(exportDir); } catch (_) {}
          // legacy: _Aplicacao.xml from older exporters
          const app = files.find(name => name.endsWith('_Application.xml')) || files.find(name => name.endsWith('_Aplicacao.xml'));
          const showFolder = t('export.showFolder'), openXml = t('export.openXml');
          const choice = await vscode.window.showInformationMessage(
            t('export.logicDone', { folder, file: app || '_Application.xml' }),
            showFolder, openXml);
          if (choice === showFolder) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(app ? path.join(exportDir, app) : exportDir));
          if (choice === openXml && app) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(exportDir, app)));
          projectView.refresh();
          return;
        }
        const ladder = report.ladder_converted || report.ladder_convertidas || []; // legacy key
        if (ladder.length) {
          const choice = await vscode.window.showWarningMessage(
            t(ladder.length > 1 ? 'export.ladderWarningMany' : 'export.ladderWarningOne', { pous: ladder.join(', ') }),
            { modal: true }, openReportLabel);
          if (choice) openReport();
          return;
        }
        // legacy: pous_alteradas / nome from older exporters
        const changed = (report.changed_pous || report.pous_alteradas || []).map(item => item.name ?? item.nome);
        const choice = await vscode.window.showInformationMessage(
          t('export.fullDone', { folder, changes: changed.length ? t('export.changedPous', { pous: changed.join(', ') }) : t('export.noChangedPous') }),
          openReportLabel);
        if (choice) openReport();
      };
      runProcess('python3', [exporter], root, env)
        .then(() => finished(0), error => { output.appendLine(error.message); finished(1); });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { discoveredProjectCache = undefined; projectView.refresh(); }),
    vscode.window.onDidChangeActiveTextEditor(() => updateLiveEditors()),
    { dispose: () => { for (const child of runtimes.values()) if (child.exitCode === null) child.kill('SIGTERM'); } }
  );

  if ((await discoverProjects()).length) await chooseProject(context);
  refreshUi();
  try {
    const bridge = await require('./agent-control').startAgentControl(context.globalStorageUri.fsPath, async (action, requested) => {
      const projects = await discoverProjects(true);
      if (action !== 'status') {
        if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('Use an absolute project path');
        const project = canonicalProject(requested);
        if (!projects.includes(project) || !isProjectFolder(project)) throw new Error('Project is not registered in this VS Code window');
        await vscode.commands.executeCommand(action === 'play' ? 'hplc.playProject' : 'hplc.stop', project);
        if (action === 'play' && !hasLivePid(project)) throw new Error('Play did not start the project; inspect HPLC output');
        if (action === 'stop') {
          const deadline = Date.now() + 10000;
          while (hasLivePid(project) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
          if (hasLivePid(project)) throw new Error('Stop did not finish; inspect HPLC output');
        }
      }
      return projects.map(project => ({ project, name: projectManifest(project).name, running: hasLivePid(project), panel: projectUrl(project), pid: projectPidUrl(project) }));
    });
    context.subscriptions.push(bridge);
    output.appendLine(t('agentControl.ready', { descriptor: bridge.descriptor }));
  } catch (error) { output.appendLine(t('agentControl.unavailable', { error: error.message })); }
}

function deactivate() {
  for (const child of runtimes.values()) if (child.exitCode === null) child.kill('SIGTERM');
}

module.exports = { activate, deactivate };
