#!/usr/bin/env python3
"""Tela e P&ID iniciais a partir do catalogo de variaveis.

Projeto importado nasce com as telas vazias, e mapear centenas de tags a mao
nao escala. Este gerador monta uma configuracao inicial usando o prefixo de
cada lista global do fabricante, que ja separa entrada fisica, saida, comando
de IHM e estado. Serve de ponto de partida; o ajuste fino continua manual.
"""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
CATALOGO = ROOT / ".plcsim" / "build" / "variables.json"
PAINEL = ROOT / "panel" / "painel.json"
PID = ROOT / "panel" / "pid.json"

if not CATALOGO.is_file():
    raise SystemExit("Rode o build antes: o catalogo de variaveis ainda nao existe.")
variaveis = {item["path"]: item for item in json.loads(CATALOGO.read_text(encoding="utf-8"))["variables"]}


def existe(*nomes):
    return [nome for nome in nomes if nome in variaveis]


def vinculo_sim(tag):
    """Bloco "simulation_flag" do item, quando o catalogo tem o par do ponto.

    Duas convencoes do projeto: objeto de processo guarda HabilitaSimulacao (e
    ValorSimulado/RetornoSimuladoLigado) ao lado do valor; canal de IO tem o par
    SimuHabilita<Estrutura>.<campo> / Simu<Estrutura>.<campo>. Sem par, o item
    sai sem vinculo e a tela nao mostra marca -- adivinhar pelo nome em tempo de
    execucao foi justamente o que impedia configurar a flag.
    """
    if "." not in tag:
        return None
    base, campo = tag.rsplit(".", 1)
    irmao = base + ".HabilitaSimulacao"
    if irmao in variaveis:
        vinculo = {"flag": irmao}
        for nome in (base + ".ValorSimulado", base + ".RetornoSimuladoLigado"):
            if nome in variaveis:
                vinculo["value"] = nome
        return vinculo
    pares = {"InputsDigitais": ("SimuHabilitaEntradaDigital", "SimuEntradaDigital"),
             "OutputsDigitais": ("SimuHabilitaSaidaDigital", "SimuSaidaDigital")}
    par = pares.get(base)
    if par and f"{par[0]}.{campo}" in variaveis:
        return {"flag": f"{par[0]}.{campo}", "value": f"{par[1]}.{campo}"}
    return None


def item(tag, rotulo, tipo, **extra):
    base = {"tag": tag, "label": rotulo, "kind": tipo, "writable": tipo != "lamp"}
    base.update(extra)
    vinculo = base.get("simulation_flag") or vinculo_sim(tag)
    if vinculo:
        base["simulation_flag"] = vinculo
    return base


def rotulo_de(tag):
    nome = tag.split(".")[0]
    nome = re.sub(r"^[A-Za-z]+_", "", nome)
    return nome.replace("_", " ").strip() or tag


def digitais(prefixo, faixa, io, tipo):
    saida = []
    for indice in faixa:
        tag = f"{prefixo}[{indice}]"
        if tag in variaveis:
            saida.append(item(tag, f"{io}-{indice:02d}", tipo, ioType=io, address=f"{io}-{indice:02d}"))
    return saida


def por_prefixo(prefixo, tipo, io, limite=None):
    escolhidos = [t for t in variaveis if t.startswith(prefixo) and "[" not in t and "." not in t]
    escolhidos.sort()
    if limite:
        escolhidos = escolhidos[:limite]
    return [item(t, rotulo_de(t), tipo, ioType=io) for t in escolhidos]


def ja_configurado(caminho, chave):
    """Configuracao valida e a que aponta para tags deste projeto.

    A tela do template vem preenchida com o compressor de exemplo. Checar
    apenas se o arquivo tem itens faria o gerador pular exatamente o caso em
    que ele e necessario, deixando a tela cheia de tag inexistente.
    """
    if not caminho.is_file():
        return False
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except ValueError:
        return False
    if chave == "areas":
        tags = [i.get("tag") for area in dados.get("areas", {}).values() for i in area]
    else:
        tags = [i.get("tag") for i in dados.get("items", [])]
    return bool(tags) and any(tag in variaveis for tag in tags)


forcar = "--force" in sys.argv
gerar_painel = forcar or not ja_configurado(PAINEL, "areas")
gerar_pid = forcar or not ja_configurado(PID, "items")
if not gerar_painel and not gerar_pid:
    print("Telas ja apontam para tags deste projeto; nada a gerar.")
    raise SystemExit(0)

ESTADOS = {"0": "S0 · Desligado", "1": "S1 · Parada segura", "10": "S10 · Ligando auxiliares",
           "11": "S11 · Manutencao", "20": "S20 · Alivio", "30": "S30 · Carga", "40": "S40 · Alivio manual"}

monitoring = []
for tag, rotulo, extra in (("Estado_Atual", "Estado atual", {"valueLabels": ESTADOS}),
                           ("Estado_Proximo", "Proximo estado", {"valueLabels": ESTADOS}),
                           ("Estado_TempoAtivo", "Tempo no estado", {"unit": "ms"})):
    if tag in variaveis:
        monitoring.append(item(tag, rotulo, "number", writable=False, ioType="INTERNO", **extra))
monitoring += [item(t, rotulo_de(t), "lamp", ioType="INTERNO") for t in existe("Reten_ResumoTrip", "IHM_TOGGLE_HERE")]
monitoring += por_prefixo("Status_", "lamp", "INTERNO", limite=12)

ihm = []
for tag in sorted(t for t in variaveis if t.startswith("IHM_MOM_")):
    ihm.append({**item(tag, rotulo_de(tag), "momentary", ioType="IHM"), "tab": "Operacao"})
for tag in sorted(t for t in variaveis if t.startswith("IHM_") and variaveis[t]["kind"] == "bool" and not t.startswith("IHM_MOM_")):
    ihm.append({**item(tag, rotulo_de(tag), "toggle", ioType="IHM"), "tab": "Operacao" if "MODO" in tag or "ALIVIO" in tag or "TOGGLE" in tag else "Alarmes"})
for tag in sorted(t for t in variaveis if t.startswith("IHM_") and variaveis[t]["kind"] in {"real", "integer"}):
    ihm.append({**item(tag, rotulo_de(tag), "number", ioType="IHM", precision=2), "tab": "Parametros"})
for indice in range(0, 32):
    tag = f"SField_AI[{indice}]"
    if tag in variaveis:
        ihm.append({**item(tag, f"AI-{indice:02d} simulado", "number", ioType="AI", precision=2), "tab": "Instrumentos"})

painel = digitais("RField_DI", range(0, 8), "DI", "toggle") + por_prefixo("Saida_SINALEIRO", "lamp", "DO")
interface = digitais("RField_DI", range(8, 16), "DI", "toggle") + por_prefixo("Saida_RESUMO", "lamp", "DO") + por_prefixo("Saida_COMPRESSOR", "lamp", "DO")
field = digitais("RField_DI", range(16, 32), "DI", "toggle") + por_prefixo("Saida_LIGA", "lamp", "DO")
field += [item(f"Field_Transmissor[{i}].engValue", f"Transmissor {i}", "number", writable=False, ioType="AI", precision=2)
          for i in range(0, 8) if f"Field_Transmissor[{i}].engValue" in variaveis]

nome = ROOT.name
if gerar_painel:
    PAINEL.write_text(json.dumps({
    "version": 1, "title": f"{nome} · bancada",
    "display": {"realPrecision": 2, "theme": "light"},
    "areas": {"monitoring": monitoring, "ihm": ihm, "panel": painel, "interface": interface, "field": field},
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

posicoes = [(8, 12), (8, 30), (8, 72), (21, 30), (21, 78), (43, 12), (43, 82), (57, 22), (57, 82),
            (67, 12), (67, 82), (79, 8), (92, 20), (92, 33), (92, 66), (92, 79)]
candidatos = ([t for t in ("Estado_Atual", "Reten_ResumoTrip") if t in variaveis]
              + sorted(t for t in variaveis if t.startswith("Saida_LIGA"))
              + sorted(t for t in variaveis if t.startswith("Saida_COMANDO"))
              + [f"Field_Transmissor[{i}].engValue" for i in range(0, 6) if f"Field_Transmissor[{i}].engValue" in variaveis])
itens = []
for (x, y), tag in zip(posicoes, candidatos):
    entrada = {"tag": tag, "label": rotulo_de(tag), "x": x, "y": y}
    if tag == "Estado_Atual":
        entrada["valueLabels"] = ESTADOS
    itens.append(entrada)
animacao = {chave: tag for chave, tag in (("motor", "Saida_LIGA_MOTOR_PRINCIPAL"),
                                          ("valve", "Saida_COMANDO_VALVULA_SUCCAO"),
                                          ("exhaust", "Saida_LIGA_EXAUSTOR")) if tag in variaveis}
if gerar_pid:
    PID.write_text(json.dumps({
        "version": 1, "title": f"{nome} · P&ID",
        "display": {"realPrecision": 2, "theme": "light"},
        "items": itens, "animation": animacao,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
total = sum(len(v) for v in json.loads(PAINEL.read_text(encoding="utf-8"))["areas"].values())
print(f"Telas iniciais: {total} itens no painel e {len(itens) if gerar_pid else 0} no P&ID.")
