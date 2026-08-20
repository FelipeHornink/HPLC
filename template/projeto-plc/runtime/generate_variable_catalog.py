#!/usr/bin/env python3
"""Catalogo online das variaveis globais, para o backend STruC++.

O STruC++ declara cada variavel global como `GlobalVar<V> NOME` em escopo de
arquivo, com o nome em maiusculas. Estrutura vira struct com campos em
maiusculas e array indexa com []. Toda folha termina em IECVar, que expoe
get() e set(). Este gerador percorre os fontes ST preparados e emite os
acessos C++ correspondentes.
"""
from pathlib import Path
import json
import os
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = Path(os.environ.get("PLC_CODEX_SOURCE_ROOT", ROOT)).resolve()
BUILD = ROOT / ".plcsim" / "build"

PRIMITIVES = {
    "BOOL": "bool",
    "SINT": "integer", "INT": "integer", "DINT": "integer", "LINT": "integer",
    "USINT": "integer", "UINT": "integer", "UDINT": "integer", "ULINT": "integer",
    "BYTE": "integer", "WORD": "integer", "DWORD": "integer", "LWORD": "integer",
    "REAL": "real", "LREAL": "real", "TIME": "time",
}
STANDARD_BLOCKS = {
    "TON": [("IN", "BOOL"), ("PT", "TIME"), ("Q", "BOOL"), ("ET", "TIME")],
    "TOF": [("IN", "BOOL"), ("PT", "TIME"), ("Q", "BOOL"), ("ET", "TIME")],
    "TP": [("IN", "BOOL"), ("PT", "TIME"), ("Q", "BOOL"), ("ET", "TIME")],
    "R_TRIG": [("CLK", "BOOL"), ("Q", "BOOL")],
    "F_TRIG": [("CLK", "BOOL"), ("Q", "BOOL")],
}


def without_comments(text):
    text = re.sub(r"\(\*.*?\*\)", " ", text, flags=re.S)
    return re.sub(r"//[^\n]*", " ", text)


def declarations(body):
    result = []
    for chunk in without_comments(body).split(";"):
        match = re.match(r"\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:\bAT\b\s*%\S+\s*)?:\s*(\S.*)", chunk, re.S)
        if not match:
            continue
        names, declared = match.groups()
        declared = declared.split(":=", 1)[0].strip().upper()
        for name in re.split(r"\s*,\s*", names.strip()):
            result.append((name, declared))
    return result


def files(folder):
    directory = SOURCE_ROOT / folder
    return sorted(directory.glob("*.st")) if directory.is_dir() else []


structs = {}
for source in files("types"):
    text = without_comments(source.read_text(encoding="utf-8"))
    for match in re.finditer(r"\bTYPE\s+([A-Za-z_]\w*)\s*:\s*STRUCT\b(.*?)\bEND_STRUCT\s*;?\s*END_TYPE\b", text, re.S | re.I):
        structs[match.group(1).upper()] = declarations(match.group(2))

blocks = dict(STANDARD_BLOCKS)
for folder in ("blocks", "programs", "functions"):
    for source in files(folder):
        text = without_comments(source.read_text(encoding="utf-8"))
        for match in re.finditer(r"\bFUNCTION_BLOCK\s+([A-Za-z_]\w*)(.*?)\bEND_FUNCTION_BLOCK\b", text, re.S | re.I):
            body = "\n".join(m.group(1) for m in re.finditer(r"\bVAR(?:_\w+)?\b(.*?)\bEND_VAR\b", match.group(2), re.S | re.I))
            blocks[match.group(1).upper()] = declarations(body)

# O STruC++ renomeia identificador que colide com nome reservado do C++,
# acrescentando "_". Em vez de adivinhar a regra, lemos os nomes reais do
# header gerado e casamos com os do ST.
HEADER = BUILD / "out" / "project.hpp"
header_text = HEADER.read_text(encoding="utf-8") if HEADER.is_file() else ""
struct_members = {}
for match in re.finditer(r"\bstruct\s+([A-Za-z_]\w*)\s*\{(.*?)\n\};", header_text, re.S):
    membros = set(re.findall(r"^\s*[A-Za-z_][\w:<>,\s]*?\s([A-Za-z_]\w*)\s*\{", match.group(2), re.M))
    struct_members[match.group(1).upper()] = membros
header_globals = set(re.findall(r"\binline\s+GlobalVar<[^>]*>\s+([A-Za-z_]\w*)\s*\{", header_text))


def actual_name(candidate, known):
    """Nome como o compilador o escreveu, tolerando o sufixo de desambiguacao."""
    if not known or candidate in known:
        return candidate
    return f"{candidate}_" if f"{candidate}_" in known else candidate


catalog = []
unsupported = []


def add_leaves(path, expression, declared, seen=()):
    upper = declared.upper()
    array = re.fullmatch(r"ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s*(.+)", declared, re.I)
    if array:
        lower, higher, item = int(array.group(1)), int(array.group(2)), array.group(3).strip()
        for index in range(lower, higher + 1):
            add_leaves(f"{path}[{index}]", f"{expression}[{index}]", item, seen)
        return
    if upper in PRIMITIVES:
        catalog.append({"path": path, "type": upper, "kind": PRIMITIVES[upper], "expression": expression})
        return
    fields = structs.get(upper) or blocks.get(upper)
    if not fields:
        unsupported.append({"path": path, "type": declared})
        return
    if upper in seen:
        unsupported.append({"path": path, "type": declared, "reason": "tipo recursivo"})
        return
    known = struct_members.get(upper)
    for name, field_type in fields:
        campo = actual_name(name.upper(), known)
        add_leaves(f"{path}.{name}", f"{expression}.{campo}", field_type, (*seen, upper))


for source in files("globals"):
    text = source.read_text(encoding="utf-8")
    for body in re.findall(r"VAR_GLOBAL(.*?)END_VAR", text, re.S | re.I):
        for name, declared in declarations(body):
            add_leaves(name, f"{actual_name(name.upper(), header_globals)}.value", declared)


def add_statement(item):
    path, kind, expression, declared = item["path"], item["kind"], item["expression"], item["type"]
    if kind == "bool":
        return f'    add_bool(b,n,u,f,"{path}",{expression}.get(),1);'
    if kind == "integer":
        return f'    add_integer(b,n,u,f,"{path}","{declared}",(long long)({expression}.get()),1);'
    if kind == "real":
        return f'    add_float(b,n,u,f,"{path}","{declared}",(double)({expression}.get()),1);'
    return f'    add_time(b,n,u,f,"{path}",{expression}.get());'


def set_statement(item, first):
    path, kind, expression, declared = item["path"], item["kind"], item["expression"], item["type"]
    prefix = "if" if first else "else if"
    if kind == "bool":
        value = "(BOOL_t)bv"
    elif kind == "real":
        value = "rv"
    elif kind == "time":
        value = "milliseconds_to_time(rv)"
    else:
        value = "(long long)rv"
    return f'    {prefix} (!strcmp(tag,"{path}")) {{ {expression}.set({value}); return 1; }}'


generated = [
    "/* Gerado a partir de globals/, types/ e blocks/. Nao editar. */",
    "static void generated_add_variables(char *b,size_t n,int*u,int*f) {",
    *(add_statement(item) for item in catalog),
    "}",
    "static int generated_set_tag(const char *tag,const char *raw) {",
    '    int bv=(!strcasecmp(raw,"true")||atoi(raw)!=0); double rv=atof(raw);',
    "    (void)bv; (void)rv;",
    *(set_statement(item, index == 0) for index, item in enumerate(catalog)),
    "    return 0;",
    "}",
]
# Cola com o backend: nome da classe do programa da tarefa e intervalo do ciclo.
import tomllib
manifest = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))
task = manifest.get("task", [{}])[0]
entrypoint = task.get("program", "Main")
interval_ms = int(task.get("interval_ms", 10))
backend = [
    "/* Gerado a partir de plc.toml. Nao editar. */",
    "/* A Configuration gerada ja instancia os programas e monta tarefas e",
    "   recursos, entao o ciclo apenas percorre o que ela declara. */",
    "static Configuration_CONFIG0 plc_config;",
    f"static const long plc_interval_ms = {interval_ms};",
    "static void plc_init(void) {}",
    "static void plc_run_cycle(void) {",
    "    ResourceInstance *recursos = plc_config.get_resources();",
    "    for (size_t r = 0; r < plc_config.get_resource_count(); r++)",
    "        for (size_t t = 0; t < recursos[r].task_count; t++)",
    "            for (size_t p = 0; p < recursos[r].tasks[t].program_count; p++)",
    "                recursos[r].tasks[t].programs[p]->run();",
    "}",
]

BUILD.mkdir(parents=True, exist_ok=True)
(BUILD / "backend_generated.inc").write_text("\n".join(backend) + "\n", encoding="utf-8")
(BUILD / "variables_generated.inc").write_text("\n".join(generated) + "\n", encoding="utf-8")
(BUILD / "variables.json").write_text(json.dumps({
    "version": 2, "backend": "strucpp",
    "variables": [{k: v for k, v in item.items() if k != "expression"} for item in catalog],
    "unsupported": unsupported,
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Catalogo: {len(catalog)} variaveis globais; {len(unsupported)} tipos nao expostos.")
