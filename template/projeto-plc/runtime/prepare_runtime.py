#!/usr/bin/env python3
"""Copia portatil dos fontes para o compilador, sem tocar no projeto.

O projeto guarda o que veio do fabricante. Aqui ficam apenas as adaptacoes que
existem por causa do simulador, registradas em translation-report.json.
"""
from pathlib import Path
import json
import re
import shutil
import tomllib

ROOT = Path(__file__).resolve().parent.parent
GENERATED = ROOT / ".plcsim" / "generated"
DESTINO = GENERATED / "src"
PASTAS = ("types", "functions", "blocks", "globals", "programs", "routines")

# Tipo de biblioteca do fabricante escrito com ponto. O ponto nao e aceito em
# nome de tipo; achata e declara um equivalente vazio para fechar a compilacao.
TIPO_PONTUADO = re.compile(r"(\bOF\s+|:\s*)([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*;")
# Diagnostico de hardware do fabricante: pertence ao CP, nao entra no portatil.
DIAGNOSTICO = re.compile(r"^\s*\w+(?:\s+AT\s+%\S+)?\s*:\s*(?:ARRAY\s*\[[^\]]*\]\s*OF\s+)?T_DIAG\w*\s*;\s*$", re.M)

if DESTINO.exists():
    shutil.rmtree(DESTINO)
DESTINO.mkdir(parents=True, exist_ok=True)

relatorio = []
achatados = set()
for pasta in PASTAS:
    origem = ROOT / pasta
    if not origem.is_dir():
        continue
    (DESTINO / pasta).mkdir(parents=True, exist_ok=True)
    for arquivo in sorted(origem.glob("*.st")):
        texto = original = arquivo.read_text(encoding="utf-8")
        transformacoes = []

        def achatar(m):
            achatados.add(f"{m.group(2)}_{m.group(3)}")
            return f"{m.group(1)}{m.group(2)}_{m.group(3)};"

        texto, n = TIPO_PONTUADO.subn(achatar, texto)
        if n:
            transformacoes.append({"regra": "tipo.biblioteca.achatado",
                                   "motivo": "Nome de tipo com ponto nao e aceito pelo compilador.",
                                   "ocorrencias": n})
        texto, n = DIAGNOSTICO.subn("", texto)
        if n:
            transformacoes.append({"regra": "diagnostico.hardware.omitido",
                                   "motivo": "Diagnostico do CP nao entra no executavel portatil.",
                                   "ocorrencias": n})
        (DESTINO / pasta / arquivo.name).write_text(texto, encoding="utf-8")
        relatorio.append({"origem": f"{pasta}/{arquivo.name}", "alterado": texto != original,
                          "transformacoes": transformacoes})

if achatados:
    stubs = "\n".join(f"TYPE {nome} : STRUCT reservado : BOOL; END_STRUCT; END_TYPE" for nome in sorted(achatados))
    (DESTINO / "types" / "99_tipos_biblioteca.generated.st").write_text(
        "(* Equivalentes vazios para tipos de biblioteca do fabricante. *)\n" + stubs + "\n", encoding="utf-8")
    relatorio.append({"origem": "types/99_tipos_biblioteca.generated.st", "alterado": True,
                      "transformacoes": [{"regra": "tipo.biblioteca.stub", "motivo": "Declaracao vazia para compilar sem a biblioteca.",
                                          "ocorrencias": len(achatados)}]})

# --------------------------------------------------------------------------
# Contornos de bug do compilador. Cada um cita o sintoma para ser removido
# quando o STruC++ corrigir.
# --------------------------------------------------------------------------
fontes = {caminho: caminho.read_text(encoding="utf-8")
          for pasta in PASTAS for caminho in sorted((DESTINO / pasta).glob("*.st"))}
extra = []

# 1. Tipo com o mesmo nome de um membro de estrutura. O STruC++ renomeia o
#    membro para NOME_ na declaracao mas emite .NOME no uso, e o C++ nao compila.
tipos = {}
for caminho, texto in fontes.items():
    for nome in re.findall(r"\bTYPE\s+([A-Za-z_]\w*)\s*:", texto, re.I):
        tipos[nome.upper()] = nome
membros = set()
for texto in fontes.values():
    for bloco in re.findall(r"\bSTRUCT\b(.*?)\bEND_STRUCT\b", texto, re.S | re.I):
        membros.update(m.upper() for m in re.findall(r"^\s*([A-Za-z_]\w*)\s*:", bloco, re.M))
colididos = {chave: nome for chave, nome in tipos.items() if chave in membros}
for chave, nome in colididos.items():
    alvo = f"{nome}_T"
    padrao = re.compile(rf"(\bTYPE\s+|\bOF\s+|:\s*){re.escape(nome)}\b", re.I)
    for caminho in list(fontes):
        fontes[caminho], n = padrao.subn(lambda m: m.group(1) + alvo, fontes[caminho])
        if n:
            extra.append((caminho, "tipo.nome.colide-com-membro",
                          f"Tipo {nome} tem o mesmo nome de um membro de estrutura; "
                          f"o STruC++ renomeia o membro na declaracao e nao no uso.", n))

# 2. PROGRAM chamando PROGRAM. O STruC++ aceita no ST mas gera chamada a um
#    identificador inexistente. Vira FUNCTION_BLOCK com instancia em quem chama.
entrada = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))["task"][0]["program"]
programas = {}
for caminho, texto in fontes.items():
    m = re.search(r"^\s*PROGRAM\s+([A-Za-z_]\w*)", texto, re.M | re.I)
    if m and m.group(1).upper() != entrada.upper():
        programas[m.group(1).upper()] = m.group(1)
for chave, nome in programas.items():
    caminho = next(c for c, texto in fontes.items()
                   if re.search(rf"^\s*PROGRAM\s+{re.escape(nome)}\b", texto, re.M | re.I))
    fontes[caminho] = re.sub(rf"^(\s*)PROGRAM(\s+{re.escape(nome)}\b)", r"\1FUNCTION_BLOCK\2",
                             fontes[caminho], count=1, flags=re.M | re.I)
    fontes[caminho] = re.sub(r"^\s*END_PROGRAM\s*$", "END_FUNCTION_BLOCK", fontes[caminho],
                             count=1, flags=re.M | re.I)
    extra.append((caminho, "programa.como-bloco",
                  "PROGRAM chamado por outra POU vira FUNCTION_BLOCK; o STruC++ gera "
                  "chamada invalida para PROGRAM aninhado.", 1))
for caminho in list(fontes):
    chamados = [nome for chave, nome in programas.items()
                if re.search(rf"(?<![.\w]){re.escape(nome)}\s*\(\s*\)\s*;", fontes[caminho], re.I)]
    if not chamados:
        continue
    declaracoes = "".join(f"    fb_{nome} : {nome};\n" for nome in chamados)
    fontes[caminho] = re.sub(r"(?m)^((?:PROGRAM|FUNCTION_BLOCK)\s+\w+.*\n)",
                             lambda m: m.group(1) + "VAR\n" + declaracoes + "END_VAR\n",
                             fontes[caminho], count=1)
    for nome in chamados:
        fontes[caminho] = re.sub(rf"(?<![.\w]){re.escape(nome)}(\s*\(\s*\)\s*;)",
                                 rf"fb_{nome}\1", fontes[caminho], flags=re.I)
    extra.append((caminho, "programa.instancia-em-quem-chama",
                  "Instancia criada para cada programa chamado.", len(chamados)))

for caminho, texto in fontes.items():
    caminho.write_text(texto, encoding="utf-8")
indice = {item["origem"]: item for item in relatorio}
for caminho, regra, motivo, n in extra:
    chave = f"{caminho.parent.name}/{caminho.name}"
    item = indice.setdefault(chave, {"origem": chave, "alterado": True, "transformacoes": []})
    item["alterado"] = True
    item["transformacoes"].append({"regra": regra, "motivo": motivo, "ocorrencias": n})
relatorio = list(indice.values())

alterados = sum(1 for item in relatorio if item["alterado"])
(GENERATED / "translation-report.json").write_text(json.dumps({
    "version": 2, "backend": "strucpp", "destino": str(DESTINO.relative_to(ROOT)),
    "arquivos": relatorio, "resumo": {"total": len(relatorio), "alterados": alterados},
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Copia portatil: {alterados} de {len(relatorio)} arquivos adaptados em {DESTINO}")
