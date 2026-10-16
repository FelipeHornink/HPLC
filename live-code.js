const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildModel, executionState } = require('./live-code-model');
const { t, language, webviewTranslator } = require('./i18n');

function html(project, model = buildModel(project)) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify(model).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const client = fs.readFileSync(path.join(__dirname, 'live-code-client.js'), 'utf8');
  return `<!doctype html><html lang="${language()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:12px var(--vscode-font-family)}header{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border)}.controls{display:flex;gap:5px;flex-wrap:wrap;align-items:center}button{padding:4px 8px;border:1px solid transparent;border-radius:3px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,.routine:focus-visible,input:focus-visible{outline:1px solid var(--vscode-focusBorder)}button:disabled{opacity:.4;cursor:default}.controls [data-action=run]{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}label{margin-left:auto;white-space:nowrap}#status{margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#telemetry{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px}.workspace{display:grid;grid-template-columns:clamp(170px,26%,300px) minmax(0,1fr);min-height:0;flex:1}aside{overflow:auto;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:8px 4px}.caption{font-size:10px;font-weight:600;letter-spacing:.7px;text-transform:uppercase;color:var(--vscode-descriptionForeground);padding:0 6px 8px}#filter{width:calc(100% - 12px);margin:0 6px 8px;padding:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}.children{margin-left:13px;border-left:1px solid var(--vscode-tree-indentGuidesStroke)}.children[hidden],.branch[hidden]{display:none}.routine{display:flex;align-items:center;gap:3px;min-height:27px;padding:2px 4px;cursor:pointer;border-left:2px solid transparent}.routine:hover{background:var(--vscode-list-hoverBackground)}.routine.selected{background:var(--vscode-list-inactiveSelectionBackground)}.routine.active{border-left-color:var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground)}.routine.executed-routine .indicator{color:var(--vscode-testing-iconPassed)}.routine-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.caret{width:18px;flex-shrink:0;padding:0;background:transparent;color:inherit;font-size:17px}.indicator{font-size:11px;flex-shrink:0}.editor{display:flex;flex-direction:column;min-width:0;min-height:0}.source-head{padding:7px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--vscode-panel-border)}.source-head div{min-width:0;flex:1}#routine-name{font-weight:600}#source-file{display:block;font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}#line-count{font-size:11px;color:var(--vscode-descriptionForeground)}#code{overflow:auto;flex:1;min-height:0;padding:10px 0}.line{display:flex;gap:12px;min-height:21px;line-height:21px;border-left:3px solid transparent;font:var(--vscode-editor-font-size,13px) var(--vscode-editor-font-family,monospace);white-space:pre;align-items:baseline;min-width:max-content;padding-right:16px}.number{width:42px;text-align:right;flex-shrink:0;color:var(--vscode-editorLineNumber-foreground);user-select:none}.no-point .number{opacity:.5}.line code{font:inherit}.line-values{font-size:11px;color:var(--vscode-debugTokenExpression-value);margin-left:16px;opacity:.85}.keyword{color:var(--vscode-debugTokenExpression-name)}.comment{color:var(--vscode-descriptionForeground);font-style:italic}.string{color:var(--vscode-debugTokenExpression-string)}.executed{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 10%,transparent);border-left-color:var(--vscode-testing-iconPassed)}.current{background:var(--vscode-editor-stackFrameHighlightBackground);border-left-color:var(--vscode-editorWarning-foreground);font-weight:bold}.sampled{border-left-color:var(--vscode-testing-iconPassed);outline:1px solid var(--vscode-editor-wordHighlightBorder)}.current .number{color:var(--vscode-editorWarning-foreground)}details{border-top:1px solid var(--vscode-panel-border);padding:5px 8px}summary{cursor:pointer;color:var(--vscode-descriptionForeground)}#variables{max-height:140px;overflow:auto;padding:6px 0;color:var(--vscode-descriptionForeground)}.variable{display:flex;justify-content:space-between;gap:12px;padding:3px 6px;font-family:var(--vscode-editor-font-family)}.variable strong{color:var(--vscode-debugTokenExpression-value)}
</style></head><body><header><div class="controls"><button data-action="run">▶ ${t('liveCode.run')}</button><button data-action="pause">Ⅱ ${t('liveCode.pause')}</button><button data-action="scan">+ ${t('liveCode.scan')}</button><button data-action="step_routine">+ ${t('liveCode.routine')}</button><button data-action="step_line">+ ${t('liveCode.line')}</button><button id="stop">■ ${t('liveCode.stop')}</button><label><input id="follow" type="checkbox" checked> ${t('liveCode.follow')}</label></div><div id="status" role="status">${t('liveCode.connecting')}</div><div id="telemetry">${t('liveCode.telemetryInitial')}</div></header><div class="workspace"><aside><div class="caption">${t('liveCode.flowFromMain')}</div><input id="filter" type="search" placeholder="${t('liveCode.searchPlaceholder')}" aria-label="${t('liveCode.searchLabel')}"><div id="tree" role="tree" aria-label="${t('liveCode.treeLabel')}"></div></aside><section class="editor"><div class="source-head"><div><span id="routine-name"></span><span id="source-file"></span></div><span id="line-count"></span><button id="edit">${t('liveCode.openSource')} ↗</button></div><main id="code" aria-label="${t('liveCode.codeLabel')}"></main><details><summary>${t('liveCode.variablesSummary')}</summary><div id="variables"></div></details></section></div><script nonce="${nonce}">window.plcModel=${payload};${webviewTranslator('liveCode.')}window.hplcTr=tr;</script><script nonce="${nonce}">${client}</script></body></html>`;
}

function createLiveCode(vscode, dependencies) {
  const panels = new Map();
  return {
    open(project) {
      let entry = panels.get(project);
      if (entry) {
        const model = buildModel(project);
        entry.panel.reveal(vscode.ViewColumn.Two, true);
        if (entry.model.revision !== model.revision) { entry.model = model; entry.panel.webview.html = html(project, model); }
        return entry.panel;
      }
      const panel = vscode.window.createWebviewPanel('hplc.liveCode', t('liveCode.panelTitle', { name: dependencies.name(project) }),
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
      entry = { panel, model: buildModel(project), busy: false, disposed: false, variables: [], variableTime: 0 };
      panels.set(project, entry);
      const update = async () => {
        if (entry.busy || entry.controlling || entry.disposed || !panel.visible) return;
        entry.busy = true;
        const generation = entry.generation || 0;
        try {
          const running = dependencies.running(project);
          const debug = running ? await dependencies.state(project) : {};
          if (running && dependencies.variables && Date.now() - entry.variableTime >= 500) {
            entry.variableTime = Date.now();
            try { entry.variables = (await dependencies.variables(project)).variables || []; entry.variableError = undefined; }
            catch (_) { entry.variables = []; entry.variableError = t('liveCode.valuesUnavailable'); }
          }
          if (!running) entry.variables = [];
          if (!entry.disposed && generation === (entry.generation || 0)) panel.webview.postMessage({ type: 'state', running, debug,
            execution: executionState(entry.model, debug), variables: entry.variables, variableError: entry.variableError });
        } catch (error) { if (!entry.disposed) panel.webview.postMessage({ type: 'error', message: error.message }); }
        finally { entry.busy = false; }
      };
      panel.webview.onDidReceiveMessage(async message => {
        if (entry.controlling) return;
        try {
          if (message.type === 'control' && ['run', 'pause', 'scan', 'step_line', 'step_routine'].includes(message.action)) {
            entry.controlling = true;
            entry.generation = (entry.generation || 0) + 1;
            panel.webview.postMessage({ type: 'busy', value: true });
            await dependencies.control(project, message.action);
          } else if (message.type === 'stop') {
            entry.controlling = true; entry.generation = (entry.generation || 0) + 1;
            panel.webview.postMessage({ type: 'busy', value: true });
            await dependencies.stop(project);
          }
          else if (message.type === 'source' && typeof message.file === 'string' && entry.model.files[message.file]) {
            const unit = entry.model.files[message.file];
            const line = Number.isInteger(message.line) && unit.rows.some(row => row.line === message.line) ? message.line : 1;
            await dependencies.source(project, message.file, line);
          }
        } catch (error) { vscode.window.showErrorMessage(t('liveCode.error', { message: error.message })); }
        finally { entry.controlling = false; if (!entry.disposed) panel.webview.postMessage({ type: 'busy', value: false }); await update(); }
      });
      panel.webview.html = html(project, entry.model);
      entry.timer = setInterval(update, 150);
      panel.onDidDispose(() => { entry.disposed = true; clearInterval(entry.timer); panels.delete(project); });
      panel.onDidChangeViewState(update);
      update();
      return panel;
    },
    dispose() { for (const entry of panels.values()) entry.panel.dispose(); panels.clear(); }
  };
}
module.exports = { createLiveCode, html };
