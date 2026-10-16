/* Shared by the self-contained HMI and P&ID pages (embedded by scripts/embed-panel-settings.py).
   Language: window.hplcLang ('en' default, 'pt-BR'), injected by the extension. */
(() => {
  const PT_BR = {
    'Project settings are available inside VS Code.': 'As configurações do projeto ficam disponíveis dentro do VS Code.',
    'Open this screen with the View PLC button in VS Code to configure the project.': 'Abra esta tela pelo botão Ver PLC no VS Code para configurar o projeto.',
    'Settings': 'Configurações', 'Close settings': 'Fechar configurações', 'This view': 'Esta visualização', 'Screen title': 'Título da tela',
    'Default decimal places': 'Casas decimais padrão', 'Theme': 'Tema', 'Light': 'Claro', 'Dark': 'Escuro', 'Density': 'Densidade',
    'Comfortable': 'Confortável', 'Compact': 'Compacta', 'Save view': 'Salvar visualização', 'Project and execution': 'Projeto e execução',
    'Loading project settings…': 'Carregando configuração do projeto…', 'Project name': 'Nome do projeto', 'Task': 'Task',
    'Startup program': 'Programa inicial', 'Scan in milliseconds': 'Scan em milissegundos', 'HMI port': 'Porta da IHM', 'P&ID port': 'Porta do P&ID',
    'Save project': 'Salvar projeto', 'Program, scan and ports are applied at the next Stop / Play. Saving does not restart the PLC.': 'Programa, scan e portas serão aplicados no próximo Stop / Play. Salvar não reinicia o PLC.',
    'Enter a title and 0 to 8 decimal places.': 'Informe um título e de 0 a 8 casas decimais.', 'View saved.': 'Visualização salva.',
    'Project saved. The current execution was kept.': 'Projeto salvo. A execução atual foi mantida.', 'Settings of the project linked to this screen.': 'Configuração do projeto associado a esta tela.'
  };
  const t = text => (window.hplcLang === 'pt-BR' && PT_BR[text] !== undefined ? PT_BR[text] : text);
  const h = text => t(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const pending = new Map();
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.channel !== 'plc-ui-result') return;
    const request = pending.get(event.data.requestId);
    if (!request) return;
    pending.delete(event.data.requestId); clearTimeout(request.timer);
    event.data.error ? request.reject(Error(event.data.error)) : request.resolve(event.data.data);
  });
  function host(action, values) {
    return new Promise((resolve, reject) => {
      if (window.parent === window) { reject(Error(t('Project settings are available inside VS Code.'))); return; }
      const requestId = crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16)).join('-');
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error(t('Open this screen with the View PLC button in VS Code to configure the project.'))); }, 5000);
      pending.set(requestId, { resolve, reject, timer });
      window.parent.postMessage({ channel: 'plc-ui', requestId, action, values }, '*');
    });
  }
  let dialog, adapter;
  function build() {
    const css = document.createElement('style');
    css.textContent = `.plc-settings{width:min(680px,94vw);max-height:90vh;border:1px solid var(--line);border-radius:14px;padding:0;background:var(--surface);color:var(--text);box-shadow:0 24px 80px #0004}.plc-settings::backdrop{background:#10192388;backdrop-filter:blur(3px)}.ps-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--line)}.ps-head h2{margin:0;font-size:17px}.ps-body{padding:18px 22px;overflow:auto;max-height:70vh}.ps-body h3{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:4px 0 14px}.ps-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ps-grid label{display:grid;gap:5px;font-size:12px}.ps-grid .wide{grid-column:1/-1}.plc-settings input,.plc-settings select{min-width:0;width:100%;padding:9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}.plc-settings button{padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer}.plc-settings .primary{background:var(--accent,#315f78);color:#fff;border-color:transparent}.ps-actions{display:flex;align-items:center;gap:12px;margin-top:14px}.ps-note{font-size:12px;color:var(--muted);line-height:1.6}.ps-result{font-size:12px;min-height:18px;margin-top:9px}.ps-project{margin-top:24px;padding-top:18px;border-top:1px solid var(--line)}@media(max-width:500px){.ps-grid{grid-template-columns:1fr}.ps-grid .wide{grid-column:auto}}`;
    document.head.append(css); dialog = document.createElement('dialog'); dialog.className = 'plc-settings';
    dialog.innerHTML = `<div class="ps-head"><h2>${h('Settings')}</h2><button id="ps-close" aria-label="${h('Close settings')}">✕</button></div><div class="ps-body"><h3>${h('This view')}</h3><div class="ps-grid"><label class="wide">${h('Screen title')}<input id="ps-title"></label><label>${h('Default decimal places')}<input id="ps-precision" type="number" min="0" max="8"></label><label>${h('Theme')}<select id="ps-theme"><option value="light">${h('Light')}</option><option value="dark">${h('Dark')}</option></select></label><label>${h('Density')}<select id="ps-density"><option value="comfortable">${h('Comfortable')}</option><option value="compact">${h('Compact')}</option></select></label></div><div class="ps-actions"><button id="ps-save-page" class="primary">${h('Save view')}</button></div><div id="ps-page-result" class="ps-result" role="status"></div><section class="ps-project"><h3>${h('Project and execution')}</h3><p id="ps-project-note" class="ps-note">${h('Loading project settings…')}</p><div id="ps-project-fields" hidden><div class="ps-grid"><label class="wide">${h('Project name')}<input id="ps-name"></label><label>${h('Task')}<input id="ps-task"></label><label>${h('Startup program')}<select id="ps-program"></select></label><label>${h('Scan in milliseconds')}<input id="ps-interval" type="number" min="1" max="60000"></label><label>${h('HMI port')}<input id="ps-panelPort" type="number" min="1024" max="65535"></label><label>${h('P&ID port')}<input id="ps-pidPort" type="number" min="1024" max="65535"></label></div><div class="ps-actions"><button id="ps-save-project" class="primary">${h('Save project')}</button></div><p class="ps-note">${h('Program, scan and ports are applied at the next Stop / Play. Saving does not restart the PLC.')}</p></div><div id="ps-project-result" class="ps-result" role="status"></div></section></div>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector('#ps-' + id);
    $('close').onclick = () => dialog.close();
    $('save-page').onclick = async () => {
      const button = $('save-page'); button.disabled = true;
      try {
        const precision = Number($('precision').value);
        if (!$('title').value.trim() || !Number.isInteger(precision) || precision < 0 || precision > 8) throw Error(t('Enter a title and 0 to 8 decimal places.'));
        const config = structuredClone(adapter.getConfig());
        config.title = $('title').value.trim();
        config.display = { ...config.display, realPrecision: precision, theme: $('theme').value, density: $('density').value };
        await adapter.save(config); adapter.apply(config);
        $('page-result').textContent = t('View saved.');
      } catch (error) { $('page-result').textContent = error.message; }
      finally { button.disabled = false; }
    };
    $('save-project').onclick = async () => {
      const button = $('save-project'); button.disabled = true;
      const values = {};
      for (const key of ['name', 'task', 'program', 'interval', 'panelPort', 'pidPort']) values[key] = ['interval', 'panelPort', 'pidPort'].includes(key) ? Number($(key).value) : $(key).value;
      try { await host('save-project-settings', values); $('project-result').textContent = t('Project saved. The current execution was kept.'); }
      catch (error) { $('project-result').textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  window.PlcSettings = {
    async open(nextAdapter) {
      adapter = nextAdapter; if (!dialog) build();
      const $ = id => dialog.querySelector('#ps-' + id), config = adapter.getConfig();
      $('title').value = config.title || ''; $('precision').value = config.display?.realPrecision ?? 2;
      $('theme').value = document.documentElement.dataset.theme || config.display?.theme || 'light'; $('density').value = config.display?.density || 'comfortable';
      $('page-result').textContent = ''; $('project-result').textContent = ''; $('project-fields').hidden = true;
      $('project-note').textContent = t('Loading project settings…'); dialog.showModal();
      try {
        const data = await host('get-project-settings'); $('program').replaceChildren();
        for (const name of data.programs) { const option = document.createElement('option'); option.value = option.textContent = name; $('program').append(option); }
        for (const key of ['name', 'task', 'program', 'interval', 'panelPort', 'pidPort']) $(key).value = data[key];
        $('project-fields').hidden = false; $('project-note').textContent = t('Settings of the project linked to this screen.');
      } catch (error) { $('project-note').textContent = error.message; }
    },
    async navigate(view, fallback) { try { await host('navigate', { view }); } catch (_) { fallback?.(); } }
  };
})();
