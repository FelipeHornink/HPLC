const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startAgentControl } = require('./agent-control');
const canonical = p => fs.realpathSync(p);
const isProject = p => fs.existsSync(path.join(p, 'plc.toml')) && fs.existsSync(path.join(p, 'runtime/run.sh'));
function state(project) {
  const port = Number(fs.readFileSync(path.join(project, '.plcsim/runtime.port'), 'utf8').trim());
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/state`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(2000, () => request.destroy(new Error('Runtime timeout')));
    request.on('error', reject);
  });
}
function roots() { return (vscode.workspace.workspaceFolders || []).map(f => canonical(f.uri.fsPath)); }
function projects() {
  const found = new Set();
  const walk = (dir, depth) => {
    if (isProject(dir)) { found.add(canonical(dir)); return; }
    if (depth === 0) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules','Historico','backups','arquivo'] /* Historico, arquivo: legacy (Portuguese) archive folder names */.includes(entry.name)) continue;
      walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const root of roots()) walk(root, 4);
  return [...found];
}
async function activate(context) {
  await vscode.extensions.getExtension('FelipeHornink.hplc').activate();
  const output = vscode.window.createOutputChannel('HPLC — Local control');
  context.subscriptions.push(output);
  const bridge = await startAgentControl(context.globalStorageUri.fsPath, async (action, requested) => {
    const available = projects();
    if (action !== 'status') {
      if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('Absolute project path required');
      const project = canonical(requested);
      if (!available.includes(project)) throw new Error('Project is not in this VS Code workspace');
      if (action === 'views') {
        await vscode.commands.executeCommand('hplc.openProjectPanel', project);
        await vscode.commands.executeCommand('hplc.openProjectPid', project);
      } else if (action === 'play') {
        await vscode.commands.executeCommand('hplc.playProject', project);
        const runtime = await state(project);
        if (!runtime.running) throw new Error('Runtime is not running after Play');
      } else {
        await vscode.commands.executeCommand('hplc.stop', project);
        const deadline = Date.now() + 10000;
        while (true) {
          let running = false;
          try { running = (await state(project)).running; } catch (_) {}
          if (!running) break;
          if (Date.now() > deadline) throw new Error('Runtime did not stop');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    return await Promise.all(available.map(async project => {
      let runtime; try { runtime = await state(project); } catch (_) { runtime = { running: false }; }
      return { project, runtime };
    }));
  }, ['status', 'play', 'stop', 'views']);
  context.subscriptions.push(bridge);
  output.appendLine(`Local control: ${bridge.descriptor}`);
}
module.exports = { activate };
