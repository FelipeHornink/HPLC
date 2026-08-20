#!/usr/bin/env python3
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import quote
import json, subprocess, time

ROOT=Path(__file__).resolve().parent.parent
PORT=8110
TEST_ENV={**__import__('os').environ,'PORT':str(PORT),'PID_FILE':str(ROOT/'.plcsim'/'test-runtime.pid'),'PORT_FILE':str(ROOT/'.plcsim'/'test-runtime.port'),'PID_PORT_FILE':str(ROOT/'.plcsim'/'test-runtime.pid-port')}
proc=subprocess.Popen([str(ROOT/'runtime'/'run.sh')],cwd=ROOT,env=TEST_ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
base=f'http://127.0.0.1:{PORT}'
def get(path): return json.loads(urlopen(base+path,timeout=2).read())
def get_pid(path): return json.loads(urlopen(f'http://127.0.0.1:{PORT+1}'+path,timeout=2).read())
def setv(tag,val): return get(f'/api/set?tag={tag}&val={1 if val else 0}')
def pulse(tag): setv(tag,1); time.sleep(.12); setv(tag,0)
try:
    # O primeiro build inclui geração C e instrumentação; em máquinas mais
    # modestas ele pode levar mais que os oito segundos do antigo limite.
    for _ in range(600):
        try: get('/api/state'); break
        except Exception: time.sleep(.1)
    else: raise AssertionError('runtime não iniciou')
    paused=get('/api/control?action=pause'); paused_scan=paused['scan']; time.sleep(.04)
    assert get('/api/debug')['scan']==paused_scan
    get('/api/control?action=scan'); time.sleep(.04)
    assert get('/api/debug')['scan']==paused_scan+1
    get('/api/control?action=step_line'); time.sleep(.04); first_line=get('/api/debug')
    assert first_line['waiting_line'] and first_line['current_line']>0
    get('/api/control?action=step_line'); time.sleep(.03); second_line=get('/api/debug')
    assert second_line['current_line']!=first_line['current_line']
    get('/api/control?action=pause'); time.sleep(.03)
    get('/api/control?action=step_routine'); time.sleep(.03); first_routine=get('/api/debug')
    assert first_routine['waiting_routine'] and first_routine['current_routine']>0
    get('/api/control?action=step_routine'); time.sleep(.03); second_routine=get('/api/debug')
    assert second_routine['waiting_routine'] and second_routine['current_routine']!=first_routine['current_routine']
    get('/api/control?action=run'); time.sleep(.04)
    assert get('/api/state')['estado']==100
    panel_config=get('/api/panel-config')
    assert {'monitoring','ihm','panel','interface','field'} <= set(panel_config['areas'])
    assert panel_config['display']['realPrecision']==2
    assert any(item['tag']=='StatusMaquina.EstadoAtual' for item in panel_config['areas']['monitoring'])
    pid_config=get_pid('/api/pid-config')
    assert len(pid_config['items'])>=8
    assert pid_config['display']['realPrecision']==2
    commands_html=urlopen(base+'/',timeout=2).read().decode()
    pid_html=urlopen(f'http://127.0.0.1:{PORT+1}/',timeout=2).read().decode()
    assert 'Preparar bancada' not in commands_html and 'Preparar + partir' not in commands_html
    assert 'Abrir P&amp;ID' in commands_html and 'Tema escuro' in commands_html
    assert 'P&amp;ID' in pid_html and 'Abrir Comandos' in pid_html and 'Tema escuro' in pid_html
    setv('InputsDigitais.PermissivoCliente',False)
    assert get('/api/state')['di']['permissivo'] is False
    setv('InputsDigitais.PermissivoCliente',True)
    assert get('/api/state')['di']['permissivo'] is True
    setv('InputsDigitais.PermissivoCliente',False)
    assert get('/api/state')['di']['permissivo'] is False
    setv('InputsDigitais.PermissivoCliente',True)
    get(f"/api/set?tag={quote('SetpointCarga')}&val=7.25")
    assert next(v for v in get('/api/variables')['variables'] if v['path']=='SetpointCarga')['value']==7.25
    initial=get('/api/state')
    assert len(initial['instrumentos'])==11
    assert {'cliente_start','cliente_stop','cliente_emergencia','trip_externo','lsh'} <= set(initial['di'])
    assert {'exaustor','ventilador1','ventilador2','cliente_trip','cliente_alarme'} <= set(initial['dq'])
    setv('InputsDigitais.EmergenciaSaudavel',1)
    setv('InputsDigitais.PermissivoCliente',1)
    pulse('Comandos.IHMReset'); time.sleep(.1)
    assert get('/api/state')['estado']==0
    paused=get('/api/control?action=pause'); armed_scan=paused['scan']
    setv('Comandos.IHMLiga',1); armed=get('/api/state')
    assert armed['mode']=='paused' and armed['scan']==armed_scan and armed['cmd']['ihm_liga'] is True
    get('/api/control?action=scan'); consumed=get('/api/state')
    assert consumed['mode']=='paused' and consumed['scan']==armed_scan+1 and consumed['estado']==1, consumed
    setv('Comandos.IHMLiga',0); get('/api/control?action=run'); time.sleep(1.8); state=get('/api/state')
    assert state['estado']==30, state
    assert state['dq']['motor'] is True, state
    observed=set()
    for _ in range(30):
        observed.add(get('/api/state')['estado'])
        time.sleep(.2)
    assert 20 in observed and 30 in observed, observed
    setv('InputsDigitais.EmergenciaSaudavel',0); time.sleep(.08); state=get('/api/state')
    assert state['estado']==100 and state['dq']['motor'] is False, state
    variables=get('/api/variables')['variables']
    catalog=json.loads((ROOT/'.plcsim'/'build'/'variables.json').read_text())
    assert catalog['entrypoint']=='Main'
    assert len(variables)==len(catalog['variables'])==363
    variable_paths={variable['path'] for variable in variables}
    assert not any(path.startswith(('IO.','PROCESSO.','CONTROLE.','SUPERVISAO.','RETENTIVOS.','INTERFACE.','FBs.')) for path in variable_paths)
    configured_tags={item['tag'] for area in panel_config['areas'].values() for item in area}
    configured_tags.update(item['tag'] for item in pid_config['items'])
    assert configured_tags <= variable_paths, sorted(configured_tags-variable_paths)
    assert any(v['path']=='InputsDigitais.ClienteStart' for v in variables)
    assert any(v['path']=='PIT700.ValorEngenharia' for v in variables)
    for variable in variables:
        value=(1 if variable['value'] else 0) if variable['type']=='BOOL' else variable['value']
        assert get(f"/api/set?tag={quote(variable['path'])}&val={quote(str(value))}")['ok'], variable['path']
    assert all(v['writable'] for v in variables)
    assert any(v['path']=='Main.FBMotor.ComandoSaida' for v in variables)
    forced_path='OutputsDigitais.LigaMotorPrincipal'
    assert get(f'/api/force?tag={quote(forced_path)}&val=1&enabled=1')['ok']; time.sleep(.05)
    forced=next(v for v in get('/api/variables')['variables'] if v['path']==forced_path)
    assert forced['value'] is True and forced['forced'] is True
    assert get(f'/api/force?tag={quote(forced_path)}&val=0&enabled=0')['ok']
    source_map=json.loads((ROOT/'.plcsim'/'build'/'source_map.json').read_text())
    routine_files=[r for r in source_map['routines'] if r['file'].startswith('routines/')]
    assert len(routine_files)==13, routine_files
    assert all((ROOT/r['file']).is_file() for r in routine_files)
    print(f"OK: ao vivo, pausa, scan, linha, força, compressor e {len(variables)} variáveis")
finally:
    subprocess.run([str(ROOT/'runtime'/'stop.sh')],cwd=ROOT,env=TEST_ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try: proc.wait(timeout=2)
    except subprocess.TimeoutExpired: proc.kill()
