#!/usr/bin/env python3
"""Importa PLCopenXML para fontes ST navegáveis ou para um projeto ativo."""
from pathlib import Path
import argparse
import json
import re
import xml.etree.ElementTree as ET
import shutil


def local(element):
    return element.tag.split("}")[-1]


def child(element, name):
    return next((item for item in element if local(item) == name), None)


def descendants(element, name):
    return [item for item in element.iter() if local(item) == name]


def safe_name(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def render_type(container):
    if container is None or not list(container):
        return "UNKNOWN"
    item = list(container)[0]
    tag = local(item)
    if tag == "derived":
        return item.get("name", "UNKNOWN")
    if tag == "array":
        dimensions = [f"{d.get('lower', '0')}..{d.get('upper', '0')}" for d in item if local(d) == "dimension"]
        return f"ARRAY [{', '.join(dimensions)}] OF {render_type(child(item, 'baseType'))}"
    if tag in {"string", "wstring"}:
        length = item.get("length")
        return tag.upper() + (f"({length})" if length else "")
    if tag in {"subrangeSigned", "subrangeUnsigned"}:
        limits = child(item, "range")
        base = render_type(child(item, "baseType"))
        return f"{base} ({limits.get('lower')}..{limits.get('upper')})" if limits is not None else base
    return tag.upper()


def simple_initial(variable):
    initial = child(variable, "initialValue")
    value = child(initial, "simpleValue") if initial is not None else None
    return value.get("value") if value is not None else None


def variable_line(variable):
    name = variable.get("name", "SemNome")
    address = variable.get("address")
    declaration = f"    {name}"
    if address:
        declaration += f" AT {address}"
    declaration += f" : {render_type(child(variable, 'type'))}"
    initial = simple_initial(variable)
    if initial is not None:
        declaration += f" := {initial}"
    return declaration + ";"


SECTION_NAMES = {
    "localVars": "VAR",
    "tempVars": "VAR_TEMP",
    "inputVars": "VAR_INPUT",
    "outputVars": "VAR_OUTPUT",
    "inOutVars": "VAR_IN_OUT",
    "externalVars": "VAR_EXTERNAL",
}


def render_interface(interface):
    lines = []
    if interface is None:
        return lines
    for section in interface:
        section_name = SECTION_NAMES.get(local(section))
        if not section_name:
            continue
        lines.append(section_name)
        lines.extend(variable_line(variable) for variable in section if local(variable) == "variable")
        lines.append("END_VAR")
    return lines


def render_pou(pou):
    name = pou.get("name")
    pou_type = pou.get("pouType")
    keyword = {"program": "PROGRAM", "functionBlock": "FUNCTION_BLOCK", "function": "FUNCTION"}.get(pou_type, "PROGRAM")
    interface = child(pou, "interface")
    declaration = f"{keyword} {name}"
    if keyword == "FUNCTION" and interface is not None:
        return_type = child(interface, "returnType")
        if return_type is not None:
            declaration += f" : {render_type(return_type)}"
    lines = [declaration, *render_interface(interface)]
    body = child(pou, "body")
    body_kind = local(list(body)[0]) if body is not None and list(body) else "unknown"
    implementation = ""
    if body_kind == "ST":
        st = list(body)[0]
        text = next(((item.text or "") for item in st.iter() if local(item) == "xhtml"), "")
        implementation = text.rstrip()
    elif body_kind in {"LD", "FBD"}:
        implementation = graphical_to_st(list(body)[0], name)
    else:
        raise ValueError(f"POU {name}: linguagem {body_kind} não pode ser convertida automaticamente para ST")
    if implementation:
        lines.extend(["", implementation])
    lines.append({"PROGRAM": "END_PROGRAM", "FUNCTION_BLOCK": "END_FUNCTION_BLOCK", "FUNCTION": "END_FUNCTION"}[keyword])
    return "\n".join(lines) + "\n", body_kind, body


LADDER_UNSUPPORTED = {"jump", "return", "selectionDivergence", "simultaneousDivergence",
                      "selectionConvergence", "simultaneousConvergence"}

# Funcoes padrao IEC desenhadas como bloco no ladder. Elas nao sao instancias:
# chamar MOVE(In2 := 0, Out2 => X) nao existe em ST, o equivalente e X := 0.
# O MasterTool numera os pinos a partir de In2/Out1, porque In1 e o EN.
STANDARD_BINARY = {"ADD": "+", "SUB": "-", "MUL": "*", "DIV": "/", "MOD": "MOD",
                   "GT": ">", "GE": ">=", "LT": "<", "LE": "<=", "EQ": "=", "NE": "<>",
                   "AND": "AND", "OR": "OR", "XOR": "XOR"}
STANDARD_COPY = {"MOVE"}
STANDARD_UNARY = {"NOT"}
# Resultado booleano: a energia do rung tem de entrar no valor, senao a condicao
# a montante do comparador se perde ao encadear no bloco seguinte.
BOOLEAN_RESULT = {"GT", "GE", "LT", "LE", "EQ", "NE", "AND", "OR", "XOR", "NOT"}


def standard_function(block):
    name = (block.get("typeName") or "").upper()
    if block.get("instanceName"):
        return None
    return name if name in STANDARD_BINARY or name in STANDARD_COPY or name in STANDARD_UNARY else None


def pin_order(formal):
    digits = re.sub(r"\D", "", formal or "")
    return int(digits) if digits else 0


def block_enable(block, nodes, pou_name, visiting):
    inputs = child(block, "inputVariables")
    enable = next((item for item in (list(inputs) if inputs is not None else [])
                   if item.get("formalParameter") == "EN"), None)
    if enable is None:
        return None
    return rung_expression(enable, nodes, pou_name, visiting)


def function_arguments(block, nodes, pou_name, visiting):
    inputs = child(block, "inputVariables")
    ordered = []
    for variable in (list(inputs) if inputs is not None else []):
        formal = variable.get("formalParameter")
        if formal is None or formal == "EN":
            continue
        ordered.append((pin_order(formal), rung_expression(variable, nodes, pou_name, visiting)))
    return [expression for _, expression in sorted(ordered, key=lambda item: item[0]) if expression]


def function_expression(block, nodes, pou_name, visiting):
    name = standard_function(block)
    arguments = function_arguments(block, nodes, pou_name, visiting)
    if not arguments:
        raise ValueError(f"POU {pou_name}: funcao {name} sem entradas ligadas")
    if name in STANDARD_COPY:
        return arguments[0]
    if name in STANDARD_UNARY:
        return f"NOT ({arguments[0]})"
    if len(arguments) < 2:
        raise ValueError(f"POU {pou_name}: funcao {name} com apenas uma entrada ligada")
    return "(" + f" {STANDARD_BINARY[name]} ".join(arguments) + ")"


def function_targets(block):
    outputs = child(block, "outputVariables")
    targets = []
    for variable in (list(outputs) if outputs is not None else []):
        if variable.get("formalParameter") in {None, "ENO"}:
            continue
        point = child(variable, "connectionPointOut")
        expression = child(point, "expression") if point is not None else None
        text = (expression.text or "").strip() if expression is not None else ""
        if text:
            targets.append(text)
    return targets


def incoming(node):
    """Ligacoes que chegam num elemento. Varias ligacoes significam paralelo."""
    point = child(node, "connectionPointIn")
    if point is None:
        return []
    return [(item.get("refLocalId"), item.get("formalParameter"))
            for item in point if local(item) == "connection"]


def join_terms(terms, operator):
    terms = [term for term in terms if term]
    if not terms:
        return None
    if len(terms) == 1:
        return terms[0]
    return "(" + f" {operator} ".join(terms) + ")"


def rung_expression(node, nodes, pou_name, visiting=frozenset()):
    """Expressao booleana que chega na entrada do elemento; paralelo vira OR."""
    return join_terms(
        [node_expression(ref, formal, nodes, pou_name, visiting) for ref, formal in incoming(node)],
        "OR",
    )


def node_expression(local_id, formal, nodes, pou_name, visiting):
    node = nodes.get(local_id)
    if node is None:
        return None
    if local_id in visiting:
        raise ValueError(f"POU {pou_name}: rede LD com realimentacao no elemento {local_id}")
    kind = local(node)
    if kind == "leftPowerRail":
        return "TRUE"
    if kind == "inVariable":
        expression = child(node, "expression")
        text = (expression.text or "").strip() if expression is not None else ""
        return text or None
    if kind == "block":
        instance = node.get("instanceName") or node.get("typeName")
        name = standard_function(node)
        if name and formal != "ENO":
            value = function_expression(node, nodes, pou_name, visiting | {local_id})
            if name not in BOOLEAN_RESULT:
                return value
            enable = block_enable(node, nodes, pou_name, visiting | {local_id})
            return join_terms([None if enable in (None, "TRUE") else enable, value], "AND")
        if formal == "ENO":
            # Em bloco padrao a energia atravessa: ENO acompanha EN. Encadear
            # MOVE em serie no ladder e so continuar a mesma condicao de rung.
            inputs = child(node, "inputVariables")
            enable = next((item for item in (list(inputs) if inputs is not None else [])
                           if item.get("formalParameter") == "EN"), None)
            if enable is None:
                return "TRUE"
            return rung_expression(enable, nodes, pou_name, visiting | {local_id}) or "TRUE"
        if not formal:
            raise ValueError(f"POU {pou_name}: ligacao sem parametro formal na saida do bloco {instance}")
        return f"{instance}.{formal}"
    upstream = rung_expression(node, nodes, pou_name, visiting | {local_id})
    if kind == "contact":
        variable = child(node, "variable")
        name = (variable.text or "").strip() if variable is not None else ""
        if not name:
            raise ValueError(f"POU {pou_name}: contato {local_id} sem variavel")
        term = f"NOT {name}" if node.get("negated") == "true" else name
        return join_terms([None if upstream == "TRUE" else upstream, term], "AND")
    return upstream


def negate(expression):
    return f"NOT {expression}" if expression.startswith("(") else f"NOT ({expression})"


def coil_statements(coil, nodes, pou_name):
    variable = child(coil, "variable")
    name = (variable.text or "").strip() if variable is not None else ""
    if not name:
        raise ValueError(f"POU {pou_name}: bobina {coil.get('localId')} sem variavel")
    expression = rung_expression(coil, nodes, pou_name) or "FALSE"
    if coil.get("negated") == "true":
        expression = negate(expression)
    storage = (coil.get("storage") or "").lower()
    if storage in {"set", "reset"}:
        return [f"IF {expression} THEN", f"    {name} := {'TRUE' if storage == 'set' else 'FALSE'};", "END_IF;"]
    return [f"{name} := {expression};"]


def block_statements(block, nodes, pou_name):
    block_type = block.get("typeName", "")
    instance = block.get("instanceName") or block_type
    name = standard_function(block)
    if name:
        targets = function_targets(block)
        if not targets:
            # Sem destino, a funcao so alimenta o elemento seguinte: ela vira
            # expressao inline la, e aqui nao gera instrucao nenhuma.
            return []
        value = function_expression(block, nodes, pou_name, frozenset())
        enable = block_enable(block, nodes, pou_name, frozenset())
        lines = [f"{target} := {value};" for target in targets]
        if enable in (None, "TRUE"):
            return lines
        return [f"IF {enable} THEN", *(f"    {line}" for line in lines), "END_IF;"]
    arguments = []
    enable = None
    inputs = child(block, "inputVariables")
    for variable in list(inputs) if inputs is not None else []:
        formal = variable.get("formalParameter")
        if formal is None:
            continue
        expression = rung_expression(variable, nodes, pou_name)
        # EN nao e argumento: ele condiciona a chamada. Ignora-lo faria o bloco
        # rodar todo ciclo, mudando a logica da maquina em silencio.
        if formal == "EN":
            enable = expression
            continue
        if expression:
            arguments.append(f"{formal} := {expression}")
    outputs = child(block, "outputVariables")
    for variable in list(outputs) if outputs is not None else []:
        formal = variable.get("formalParameter")
        if formal in {None, "ENO"}:
            continue
        point = child(variable, "connectionPointOut")
        expression = child(point, "expression") if point is not None else None
        if expression is not None and (expression.text or "").strip():
            arguments.append(f"{formal} => {expression.text.strip()}")
    call = f"{instance}({', '.join(arguments)});"
    if enable in (None, "TRUE"):
        return [call]
    return [f"IF {enable} THEN", f"    {call}", "END_IF;"]


def out_variable_statements(node, nodes, pou_name):
    expression = child(node, "expression")
    name = (expression.text or "").strip() if expression is not None else ""
    value = rung_expression(node, nodes, pou_name)
    if not name or not value:
        return []
    return [f"{name} := {value};"]


def graphical_to_st(graphic, pou_name):
    """Converte a rede LD/FBD em ST preservando a ordem do XML.

    Contatos em serie viram AND, ligacoes paralelas viram OR, bobinas viram
    atribuicao e o EN de cada bloco vira IF. O que nao tem equivalente direto,
    como jump e divergencia, falha explicitamente: nunca produzimos uma
    implementacao incompleta fingindo que a conversao deu certo.
    """
    nodes = {item.get("localId"): item for item in graphic if item.get("localId")}
    unsupported = sorted({local(item) for item in graphic if local(item) in LADDER_UNSUPPORTED})
    if unsupported:
        raise ValueError(f"POU {pou_name}: rede {unsupported[0]} ainda nao suportada pelo conversor LD/FBD")
    handlers = {"block": block_statements, "coil": coil_statements, "outVariable": out_variable_statements}
    statements = []
    for item in graphic:
        handler = handlers.get(local(item))
        if handler:
            statements.extend(handler(item, nodes, pou_name))
    if not statements:
        return f"(* {pou_name}: diagrama original sem logica executavel. *)"
    return "(* Convertido automaticamente de LD/FBD para ST. *)\n" + "\n".join(statements)


def render_data_type(data_type):
    name = data_type.get("name")
    base = child(data_type, "baseType")
    item = list(base)[0] if base is not None and list(base) else None
    if item is not None and local(item) == "struct":
        lines = [f"TYPE {name} :", "STRUCT"]
        lines.extend(variable_line(variable) for variable in item if local(variable) == "variable")
        lines.extend(["END_STRUCT;", "END_TYPE"])
        return "\n".join(lines) + "\n"
    if item is not None and local(item) == "enum":
        values = [value.get("name") for value in descendants(item, "value")]
        return f"TYPE {name} : ({', '.join(values)});\nEND_TYPE\n"
    return f"TYPE {name} : {render_type(base)};\nEND_TYPE\n"


# --------------------------------------------------------------------------
# Regras de adaptacao aplicadas na importacao. Todas ficam registradas em
# plcopen/REGRAS_IMPORTACAO.md, com o que foi tocado em cada uma.
# --------------------------------------------------------------------------

# Servicos de sistema do fabricante. O relogio e o calendario dependem do CP,
# entao o projeto passa a ler variaveis proprias e cada plataforma preenche.
SYSTEM_SERVICES = [
    (re.compile(r"\bSysTimeCore\s*\.\s*SysTimeGetUs\s*\(\s*(\w+)\s*\)\s*;", re.I),
     r"\1 := Sistema_TempoUs;", "SysTimeCore.SysTimeGetUs"),
    (re.compile(r"\bGetDateAndTime\s*\(\s*(\w+)\s*\)\s*;", re.I),
     r"\1 := Sistema_DataHora;", "GetDateAndTime"),
    (re.compile(r"\bNextoStandard\s*\.\s*GetDayOfWeek\s*\(\s*\)", re.I),
     "Sistema_DiaDaSemana", "NextoStandard.GetDayOfWeek"),
]
SYSTEM_VARIABLES = [
    ("Sistema_TempoUs", "ULINT", "relogio monotonico em microssegundos"),
    ("Sistema_DataHora", "EXTENDED_DATE_AND_TIME", "data e hora corrente"),
    ("Sistema_DiaDaSemana", "DAYS_OF_WEEK", "dia da semana"),
]
# Tipos que o fabricante traz de biblioteca e o projeto passa a declarar, para
# ficar autocontido. Diagnostico de hardware nao entra: e do CP, nao da logica.
PORTABLE_LIBRARY_TYPES = {
    "EXTENDED_DATE_AND_TIME": (
        "TYPE EXTENDED_DATE_AND_TIME :\nSTRUCT\n"
        "    byYear : UINT;\n    byMonth : USINT;\n    byDay : USINT;\n"
        "    byHours : USINT;\n    byMinutes : USINT;\n    bySeconds : USINT;\n"
        "    wMilliseconds : UINT;\nEND_STRUCT;\nEND_TYPE\n"),
    "DAYS_OF_WEEK": "TYPE DAYS_OF_WEEK : USINT; END_TYPE\n",
}


def apply_system_services(source, usados):
    for padrao, troca, nome in SYSTEM_SERVICES:
        source, n = padrao.subn(troca, source)
        if n:
            usados[nome] = usados.get(nome, 0) + n
    return source


def relocate_global_blocks(sources, listas, block_types, movidos, nao_movidos):
    """Move instancia de FB global para dentro da POU que a chama.

    Instancia de FB no escopo global e legal na norma e o MATIEC aceita, mas o
    STruC++ 0.6.3 recusa chamar. Quando so uma POU usa a instancia, a declaracao
    vai para la como VAR RETAIN, preservando a retencao que a GVL dava.
    """
    instancias = {}
    for gvl_name, variables in listas.items():
        for variable in variables:
            tipo = render_type(child(variable, "type"))
            if tipo.upper() in block_types:
                instancias[flatten_name(gvl_name, variable.get("name"))] = tipo
    if not instancias:
        return sources
    por_arquivo = {}
    for nome, tipo in instancias.items():
        chamadores = [arquivo for arquivo, texto in sources.items()
                      if re.search(rf"(?<![.\w]){re.escape(nome)}\s*\(", texto, re.I)]
        if len(chamadores) != 1:
            nao_movidos.append((nome, tipo, len(chamadores)))
            continue
        por_arquivo.setdefault(chamadores[0], []).append((nome, tipo))
    for arquivo, itens in por_arquivo.items():
        corpo = "".join(f"    {nome} : {tipo};\n" for nome, tipo in itens)
        declaracao = ("VAR RETAIN\n"
                      "    (* Instancias vindas da lista global; RETAIN preserva a retencao. *)\n"
                      f"{corpo}END_VAR\n")
        sources[arquivo] = re.sub(r"(?m)^((?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+\w+.*\n)",
                                  lambda m: m.group(1) + declaracao, sources[arquivo], count=1)
        movidos.extend((nome, tipo, arquivo) for nome, tipo in itens)
    return sources


def collect_globals(root):
    """Mapa GVL -> membros, na ordem do XML, mesclando GVLs de nome repetido."""
    # Uma mesma GVL pode aparecer em mais de um resource do XML, repetindo
    # membros. Mescla mantendo a primeira ocorrencia de cada nome.
    listas = {}
    vistos = {}
    for gvl in (item for item in root.iter() if local(item) == "globalVars"):
        nome = gvl.get("name") or "GlobalVars"
        alvo = listas.setdefault(nome, [])
        conhecidos = vistos.setdefault(nome, set())
        for variable in gvl:
            if local(variable) != "variable":
                continue
            membro = (variable.get("name") or "").upper()
            if membro in conhecidos:
                continue
            conhecidos.add(membro)
            alvo.append(variable)
    return listas


def flatten_name(gvl_name, member):
    return f"{gvl_name}_{member}"


QUALIFICADO = re.compile(r"\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b")
IDENTIFICADOR = re.compile(r"(?<![.\w])([A-Za-z_]\w*)")


def declared_names(source):
    nomes = set()
    for bloco in re.findall(r"\bVAR(?:_\w+)?\b(.*?)\bEND_VAR\b", source, re.S | re.I):
        for pedaco in bloco.split(";"):
            m = re.match(r"\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:\bAT\b\s*%\S+\s*)?:", pedaco)
            if m:
                nomes.update(x.strip().upper() for x in m.group(1).split(","))
    return nomes


def split_body(source):
    """Separa declaracoes do corpo executavel, para nao renomear locais."""
    fim = 0
    for m in re.finditer(r"\bEND_VAR\b", source, re.I):
        fim = m.end()
    if fim:
        return source[:fim], source[fim:]
    quebra = source.find("\n")
    return (source[:quebra + 1], source[quebra + 1:]) if quebra >= 0 else (source, "")


def qualified_rewriter(listas, ambiguos_encontrados):
    """Achata o acesso a variavel global no codigo.

    Field.AO vira Field_AO. Membro de struct e de instancia de FB nao e tocado,
    porque o prefixo precisa ser o nome de uma GVL conhecida e o sufixo um
    membro dela. Referencia sem prefixo, como Pulse_1s, tambem e renomeada,
    mas so quando o nome pertence a uma unica GVL e nao e local da POU.
    """
    indice = {}
    donos = {}
    for gvl_name, variables in listas.items():
        for variable in variables:
            membro = variable.get("name")
            if not membro:
                continue
            indice[(gvl_name.upper(), membro.upper())] = flatten_name(gvl_name, membro)
            donos.setdefault(membro.upper(), []).append((gvl_name, membro))
    unico = {chave: flatten_name(*par[0]) for chave, par in donos.items() if len(par) == 1}
    ambiguos = {chave for chave, par in donos.items() if len(par) > 1}

    def trocar(source):
        source = QUALIFICADO.sub(
            lambda m: indice.get((m.group(1).upper(), m.group(2).upper()), m.group(0)),
            source,
        )
        cabecalho, corpo = split_body(source)
        locais = declared_names(source)

        def nu(m):
            chave = m.group(1).upper()
            if chave in locais:
                return m.group(1)
            if chave in ambiguos:
                ambiguos_encontrados.add(m.group(1))
                return m.group(1)
            return unico.get(chave, m.group(1))

        return cabecalho + IDENTIFICADOR.sub(nu, corpo)

    return trocar


def render_rules(manifest, listas):
    """Documento das regras aplicadas, gerado a cada importacao."""
    a = manifest["adaptations"]
    linhas = ["# Regras aplicadas na importacao", "",
              f"Origem: `{manifest['source']}`", "",
              "Toda adaptacao abaixo e automatica. O XML original fica intacto em",
              "`plcopen/original.xml` e continua sendo a autoridade.", "",
              "## 1. Uma unica lista de variaveis globais", "",
              f"As {len(listas)} GVLs do fabricante viraram um unico `VAR_GLOBAL` em",
              "`globals/00_GlobalVars.st`, com secoes separadas por comentario. Cada nome",
              "recebe o prefixo da lista de origem, porque a norma IEC nao tem GVL com nome",
              "e membros homonimos de listas diferentes colidiriam.", "",
              "| lista | membros |", "|---|---|"]
    linhas += [f"| `{nome}` | {len(vars)} |" for nome, vars in listas.items() if vars]
    linhas += ["", "O codigo e reescrito junto: `Field.AO` vira `Field_AO`. Referencia sem",
               "prefixo tambem, quando o nome pertence a uma unica lista.", ""]
    if manifest.get("ambiguousGlobals"):
        linhas += ["Nomes ambiguos preservados, precisam de decisao humana:", ""]
        linhas += [f"- `{n}`" for n in manifest["ambiguousGlobals"]] + [""]
    linhas += ["## 2. Servicos de sistema do fabricante", ""]
    if a["systemServices"]:
        linhas += ["Relogio e calendario dependem do CP. As chamadas de biblioteca foram",
                   "trocadas por variaveis do proprio projeto, preenchidas pela plataforma:", "",
                   "| chamada original | ocorrencias | variavel do projeto |", "|---|---|---|"]
        mapa = {"SysTimeCore.SysTimeGetUs": "Sistema_TempoUs",
                "GetDateAndTime": "Sistema_DataHora",
                "NextoStandard.GetDayOfWeek": "Sistema_DiaDaSemana"}
        linhas += [f"| `{k}` | {v} | `{mapa.get(k, '-')}` |" for k, v in a["systemServices"].items()]
        linhas += ["", "Ao levar para um CP real, preencha essas variaveis com o servico",
                   "equivalente do fabricante.", ""]
    else:
        linhas += ["Nenhuma chamada de servico de sistema encontrada.", ""]
    linhas += ["## 3. Instancias de bloco no escopo global", ""]
    if a["relocatedBlockInstances"]:
        linhas += ["Instancia de FB global e legal na norma, mas o STruC++ 0.6.3 nao a chama.",
                   "Quando uma unica POU usa a instancia, a declaracao vai para dentro dela",
                   "como `VAR RETAIN`, preservando a retencao que a lista global dava.", "",
                   "| instancia | tipo | movida para |", "|---|---|---|"]
        linhas += [f"| `{i['name']}` | `{i['type']}` | `{i['movedTo']}` |" for i in a["relocatedBlockInstances"]]
        linhas += [""]
    else:
        linhas += ["Nenhuma instancia de bloco no escopo global.", ""]
    if a["notRelocated"]:
        linhas += ["Nao movidas, por serem usadas por mais de uma POU ou por nenhuma:", "",
                   "| instancia | tipo | POUs que chamam |", "|---|---|---|"]
        linhas += [f"| `{i['name']}` | `{i['type']}` | {i['callers']} |" for i in a["notRelocated"]]
        linhas += [""]
    linhas += ["## 4. Tipos de biblioteca declarados no projeto", ""]
    if a["portableTypes"]:
        linhas += ["Passam a ser declarados em `types/`, para o projeto ficar autocontido:", ""]
        linhas += [f"- `{n}`" for n in a["portableTypes"]] + [""]
    linhas += ["Diagnostico de hardware do fabricante nao e declarado: pertence ao CP e nao",
               "entra no executavel portatil. Fica listado em `IMPORT_REPORT.md`.", "",
               "## 5. Conversao de LD e FBD para ST", ""]
    conversoes = manifest["diagnostics"].get("conversions", [])
    if conversoes:
        linhas += ["Contato em serie vira `AND`, ligacao paralela vira `OR`, bobina vira",
                   "atribuicao e o `EN` de cada bloco vira `IF`. Funcao padrao desenhada como",
                   "bloco vira expressao: `MOVE` vira atribuicao, `ADD` vira `+`.", "",
                   "| POU | de | arquivo |", "|---|---|---|"]
        linhas += [f"| `{c['name']}` | {c['from']} | `{c['file']}` |" for c in conversoes]
        linhas += [""]
    else:
        linhas += ["Nenhuma POU em linguagem grafica.", ""]
    return "\n".join(linhas)


def render_flat_globals(listas, relocados=(), sistema=()):
    """Uma unica GVL, secoes separadas por comentario.

    Sem o nome da GVL o ST vira IEC padrao e compila em qualquer lugar; o
    prefixo mantem unicos os 37 nomes que se repetem entre as listas do
    fabricante, e o comentario preserva de qual lista cada bloco veio.
    """
    lines = ["(* Variaveis globais do projeto.",
             "   Uma unica GVL, com as listas do fabricante separadas por comentario.",
             "   Cada nome carrega o prefixo da lista de origem. *)",
             "VAR_GLOBAL"]
    for gvl_name, variables in listas.items():
        lines.append("")
        lines.append(f"    (* ===== {gvl_name} ===== *)")
        for variable in variables:
            nome = flatten_name(gvl_name, variable.get("name"))
            if nome in relocados:
                lines.append(f"    (* {nome}: instancia movida para a POU que a chama *)")
                continue
            linha = variable_line(variable).lstrip()
            lines.append("    " + linha.replace(variable.get("name"), nome, 1))
    if sistema:
        lines.append("")
        lines.append("    (* ===== Sistema: preenchido pela plataforma, varia por CP ===== *)")
        for nome, tipo, descricao in sistema:
            lines.append(f"    {nome} : {tipo};  (* {descricao} *)")
    lines.append("END_VAR")
    return "\n".join(lines) + "\n"


# Atributos de editor nao pertencem ao codigo: guardam ordem na tela e checksum.
GVL_EDITOR_ATTRIBUTES = {"order_in_persistent_editor", "checksumnoinit_override", "init_related_code"}


def gvl_pragmas(gvl):
    """Pragmas CODESYS da GVL, como {attribute 'qualified_only'}.

    O nome da lista nao existe no texto ST, mas o pragma existe e decide se o
    codigo precisa escrever Field.AO ou pode escrever AO. Sem ele o arquivo
    deixa de ser colavel de volta no MasterTool com o mesmo comportamento.
    """
    lines = []
    for attribute in gvl.iter():
        if local(attribute) != "Attribute":
            continue
        name = attribute.get("Name")
        if not name or name in GVL_EDITOR_ATTRIBUTES:
            continue
        value = attribute.get("Value") or ""
        lines.append(f"{{attribute '{name}' := '{value}'}}" if value else f"{{attribute '{name}'}}")
    return lines


def render_gvl(gvl):
    lines = [f"(* GVL original: {gvl.get('name', 'sem nome')} *)"]
    lines.extend(gvl_pragmas(gvl))
    lines.append("VAR_GLOBAL")
    lines.extend(variable_line(variable) for variable in gvl if local(variable) == "variable")
    lines.append("END_VAR")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xml", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--active", action="store_true", help="gera types/functions/blocks/programs/globals no projeto de destino")
    args = parser.parse_args()
    root = ET.parse(args.xml).getroot()
    output = args.output
    for folder in (("programs", "functions", "blocks", "types", "globals", "plcopen") if args.active else ("pous", "types", "globals")):
        (output / folder).mkdir(parents=True, exist_ok=True)

    if args.active:
        shutil.copy2(args.xml, output / "plcopen" / "original.xml")

    manifest = {"source": str(args.xml), "pous": [], "dataTypes": [], "globalVars": [], "libraries": [], "diagnostics": {}}
    listas_globais = collect_globals(root)
    ambiguos_sem_prefixo = set()
    reescrever = qualified_rewriter(listas_globais, ambiguos_sem_prefixo)
    pous = [item for item in root.iter() if local(item) == "pou"]
    servicos_usados = {}
    fontes = {}
    destinos = {}
    for index, pou in enumerate(pous, 1):
        source, body_kind, body = render_pou(pou)
        source = apply_system_services(reescrever(source), servicos_usados)
        stem = f"{index:02d}_{safe_name(pou.get('name'))}"
        folder = {"program": "programs", "functionBlock": "blocks", "function": "functions"}.get(pou.get("pouType"), "programs") if args.active else "pous"
        filename = f"{folder}/{stem}.st"
        fontes[filename] = source
        destinos[filename] = (pou, body_kind, body, stem)

    block_types = {pou.get("name", "").upper() for pou in pous if pou.get("pouType") == "functionBlock"}
    movidos, nao_movidos = [], []
    fontes = relocate_global_blocks(fontes, listas_globais, block_types, movidos, nao_movidos)
    relocados = {nome for nome, _, _ in movidos}

    for filename, source in fontes.items():
        pou, body_kind, body, stem = destinos[filename]
        (output / filename).write_text(source, encoding="utf-8")
        if body_kind != "ST" and body is not None and not args.active:
            (output / "pous" / f"{stem}.{body_kind.lower()}.xml").write_text(ET.tostring(body, encoding="unicode"), encoding="utf-8")
        manifest["pous"].append({"name": pou.get("name"), "type": pou.get("pouType"), "originalLanguage": body_kind, "runtimeLanguage": "ST", "file": filename})

    data_types = [item for item in root.iter() if local(item) == "dataType"]
    for index, data_type in enumerate(data_types, 1):
        filename = f"{index:02d}_{safe_name(data_type.get('name'))}.st"
        (output / "types" / filename).write_text(render_data_type(data_type), encoding="utf-8")
        manifest["dataTypes"].append({"name": data_type.get("name"), "file": f"types/{filename}"})

    tipos_portateis = [nome for nome in PORTABLE_LIBRARY_TYPES
                       if nome.upper() not in {d.get("name", "").upper() for d in data_types}]
    for ordem, nome in enumerate(tipos_portateis, len(data_types) + 1):
        alvo = f"{ordem:02d}_{safe_name(nome)}.st"
        (output / "types" / alvo).write_text(PORTABLE_LIBRARY_TYPES[nome], encoding="utf-8")
        manifest["dataTypes"].append({"name": nome, "file": f"types/{alvo}", "origin": "portable"})

    filename = "00_GlobalVars.st"
    (output / "globals" / filename).write_text(
        render_flat_globals(listas_globais, relocados,
                            SYSTEM_VARIABLES if servicos_usados else []),
        encoding="utf-8")
    for name, variables in listas_globais.items():
        manifest["globalVars"].append({
            "name": name,
            "file": f"globals/{filename}",
            "prefix": f"{name}_",
            "members": [variable.get("name") for variable in variables],
        })
    manifest["globalsLayout"] = "flat"
    manifest["adaptations"] = {
        "systemServices": servicos_usados,
        "relocatedBlockInstances": [{"name": n, "type": tp, "movedTo": f} for n, tp, f in movidos],
        "notRelocated": [{"name": n, "type": tp, "callers": c} for n, tp, c in nao_movidos],
        "portableTypes": tipos_portateis,
    }
    if ambiguos_sem_prefixo:
        manifest["ambiguousGlobals"] = sorted(ambiguos_sem_prefixo)

    libraries = []
    for item in root.iter():
        if local(item) != "Library": continue
        library = {key: item.get(key) for key in ("Name", "Namespace", "DefaultResolution", "SystemLibrary") if item.get(key) is not None}
        libraries.append(library)
    manifest["libraries"] = libraries
    defined = {item.get("name", "").lower() for item in root.iter() if local(item) in {"pou", "dataType"}}
    builtins = {"BOOL","BYTE","WORD","DWORD","LWORD","SINT","USINT","INT","UINT","DINT","UDINT","LINT","ULINT","REAL","LREAL","TIME","DATE","TOD","DT","STRING","WSTRING","TON","TOF","TP","R_TRIG","F_TRIG","CTU","CTD","CTUD"}
    unresolved_types = sorted({item.get("name") for item in root.iter() if local(item) == "derived" and item.get("name", "").lower() not in defined and item.get("name", "").upper() not in builtins})
    # Funcoes padrao desenhadas como bloco viram operador em ST na conversao do
    # ladder, entao nao sao dependencia externa: listá-las aqui era ruido.
    resolved_by_converter = set(STANDARD_BINARY) | STANDARD_COPY | STANDARD_UNARY
    unresolved_blocks = sorted({item.get("typeName") for item in root.iter()
                                if local(item) == "block"
                                and item.get("typeName", "").lower() not in defined
                                and item.get("typeName", "").upper() not in builtins
                                and item.get("typeName", "").upper() not in resolved_by_converter}, key=str.lower)
    conversions = [{"name": item["name"], "from": item["originalLanguage"], "to": "ST", "file": item["file"]} for item in manifest["pous"] if item["originalLanguage"] != "ST"]
    manifest["diagnostics"] = {
        "status": "pending" if unresolved_types or unresolved_blocks else "ready",
        "unresolvedTypes": unresolved_types,
        "unresolvedBlocks": unresolved_blocks,
        "conversions": conversions,
        "notes": ["Bibliotecas proprietárias são preservadas como referências no XML; para simulação, seus tipos/blocos precisam de implementação compatível."] if libraries else [],
    }

    manifest_path = output / ("plcopen/manifest.json" if args.active else "manifest.json")
    if args.active:
        # Depois dos diagnosticos, para o documento enxergar as conversoes LD/FBD.
        (output / "plcopen" / "REGRAS_IMPORTACAO.md").write_text(
            render_rules(manifest, listas_globais), encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.active:
        diagnostic = manifest["diagnostics"]
        report = [
            f"# Relatório de importação — {args.xml.name}", "",
            f"**Status:** {'PENDÊNCIAS DE COMPATIBILIDADE' if diagnostic['status'] == 'pending' else 'PRONTO'}", "",
            f"- {len(pous)} POUs importadas em ST", f"- {len(data_types)} DUTs", f"- {len(listas_globais)} GVLs",
            f"- {len(conversions)} conversões LD/FBD → ST", f"- {len(libraries)} referências de biblioteca preservadas", "",
            "## Conversões para ST", "",
            *([f"- `{item['name']}`: {item['from']} → ST (`{item['file']}`)" for item in conversions] or ["- Nenhuma; todas as POUs já eram ST."]), "",
            "## Tipos ou blocos externos pendentes", "",
            *([f"- Tipo `{name}`" for name in unresolved_types] + [f"- Bloco `{name}`" for name in unresolved_blocks] or ["- Nenhum."]), "",
            "## Bibliotecas declaradas no XML", "",
            *([f"- `{item.get('DefaultResolution') or item.get('Name')}`" for item in libraries] or ["- Nenhuma."]), "",
            "> Pendência não remove conteúdo do export. Ela indica o que precisa de uma implementação portátil para executar no simulador.", ""
        ]
        (output / "plcopen" / "IMPORT_REPORT.md").write_text("\n".join(report), encoding="utf-8")
    readme = f"""# Referência importada do MasterTool

Fonte: `{args.xml}`

- {len(pous)} POUs ({sum(1 for p in manifest['pous'] if p['originalLanguage'] == 'ST')} originalmente ST e {sum(1 for p in manifest['pous'] if p['originalLanguage'] != 'ST')} convertidas para ST)
- {len(data_types)} DUTs
- {len(listas_globais)} GVLs

Todos os arquivos ativos são Structured Text. Diagramas LD/FBD foram convertidos
para ST durante a importação quando `--active` foi usado.
O XML original continua sendo a autoridade para IDs, configuração do dispositivo e
extensões específicas do MasterTool.
"""
    (output / ("plcopen/README.md" if args.active else "README.md")).write_text(readme, encoding="utf-8")
    print(f"Importados {len(pous)} POUs, {len(data_types)} DUTs e {len(listas_globais)} GVLs em {output}")


if __name__ == "__main__":
    main()
