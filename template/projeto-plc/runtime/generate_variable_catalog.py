#!/usr/bin/env python3
"""Gera acesso online somente para variáveis declaradas nos fontes ST ativos."""
from pathlib import Path
import json
import re
import tomllib

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / ".plcsim" / "build"
manifest = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))
active_directories = set(manifest.get("source_directories", []))
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
    "CTU": [("CU", "BOOL"), ("R", "BOOL"), ("PV", "INT"), ("Q", "BOOL"), ("CV", "INT")],
    "CTD": [("CD", "BOOL"), ("LD", "BOOL"), ("PV", "INT"), ("Q", "BOOL"), ("CV", "INT")],
}


def active_files(folder):
    if folder not in active_directories:
        return []
    return sorted((ROOT / folder).glob("*.st"))


def without_comments(text):
    return re.sub(r"\(\*.*?\*\)", "", text, flags=re.S)


def declarations(body):
    result = []
    for match in re.finditer(r"(?m)^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([^;]+);", without_comments(body)):
        names, declared_type = match.groups()
        declared_type = declared_type.split(":=", 1)[0].strip().upper()
        for name in re.split(r"\s*,\s*", names):
            result.append((name, declared_type))
    return result


def variable_blocks(text):
    return "\n".join(match.group(1) for match in re.finditer(r"\bVAR(?:_(?:INPUT|OUTPUT|IN_OUT|TEMP|EXTERNAL|GLOBAL|RETAIN))*\b(.*?)\bEND_VAR\b", text, re.S | re.I))


def parse_named_bodies(folder, keyword, end_keyword):
    result = {}
    sources = {}
    pattern = re.compile(rf"\b{keyword}\s+([A-Za-z_]\w*)(.*?)(?:\b{end_keyword}\b)", re.S | re.I)
    for source in active_files(folder):
        for match in pattern.finditer(without_comments(source.read_text(encoding="utf-8"))):
            result[match.group(1).upper()] = declarations(variable_blocks(match.group(2)))
            sources[match.group(1).upper()] = source.relative_to(ROOT).as_posix()
    return result, sources


structs = {}
for source in active_files("types"):
    text = without_comments(source.read_text(encoding="utf-8"))
    for match in re.finditer(r"\bTYPE\s+([A-Za-z_]\w*)\s*:\s*STRUCT\b(.*?)\bEND_STRUCT\s*;?\s*END_TYPE\b", text, re.S | re.I):
        structs[match.group(1).upper()] = declarations(match.group(2))

blocks, block_sources = parse_named_bodies("blocks", "FUNCTION_BLOCK", "END_FUNCTION_BLOCK")
blocks.update(STANDARD_BLOCKS)
programs, program_sources = parse_named_bodies("programs", "PROGRAM", "END_PROGRAM")
tasks = manifest.get("task", [])
if not tasks:
    raise SystemExit("plc.toml não possui [[task]] com program configurado")
entrypoint = tasks[0].get("program")
if not entrypoint or entrypoint.upper() not in programs:
    raise SystemExit(f"Programa de entrada '{entrypoint}' não existe em programs/*.st")

catalog = []
unsupported = []


def add_leaves(path, declared_type, expression, storage, source, seen=(), root_type=None):
    root_type = root_type or declared_type
    upper_type = declared_type.upper()
    if upper_type in PRIMITIVES:
        root_upper = root_type.upper()
        root_kind = "functionBlock" if root_upper in blocks else "structure" if root_upper in structs else "primitive"
        catalog.append({"path": path, "type": upper_type, "kind": PRIMITIVES[upper_type], "expression": expression, "storage": storage, "source": source, "rootType": root_type, "rootKind": root_kind})
        return
    fields = structs.get(upper_type) or blocks.get(upper_type)
    if not fields:
        unsupported.append({"path": path, "type": declared_type, "source": source})
        return
    if upper_type in seen:
        unsupported.append({"path": path, "type": declared_type, "source": source, "reason": "tipo recursivo"})
        return
    for field, field_type in fields:
        field_expression = f"{expression}.{field.upper()}" if storage == "program" else f"{expression}->{field.upper()}"
        if storage == "program" and field_type.upper() in PRIMITIVES:
            field_expression += ".value"
        add_leaves(f"{path}.{field}", field_type, field_expression, storage, source, (*seen, upper_type), root_type)


for source in active_files("globals"):
    for name, declared_type in declarations(variable_blocks(source.read_text(encoding="utf-8"))):
        if declared_type in PRIMITIVES:
            expression = f"(*__GET_GLOBAL_{name.upper()}())"
        else:
            expression = f"__GET_GLOBAL_{name.upper()}()"
        add_leaves(name, declared_type, expression, "global", source.relative_to(ROOT).as_posix())

for name, declared_type in programs[entrypoint.upper()]:
    expression = f"RES0__INST0.{name.upper()}"
    if declared_type in PRIMITIVES:
        expression += ".value"
    add_leaves(f"{entrypoint}.{name}", declared_type, expression, "program", program_sources[entrypoint.upper()])


def add_statement(item):
    p, t, e, kind = item["path"], item["type"], item["expression"], item["kind"]
    if kind == "bool":
        return f'    add_bool(b,n,u,f,"{p}",{e},1);'
    if kind == "integer":
        return f'    add_integer(b,n,u,f,"{p}","{t}",(long long)({e}),1);'
    if kind == "real":
        return f'    add_float(b,n,u,f,"{p}","{t}",(double)({e}),1);'
    return f'    add_time(b,n,u,f,"{p}",{e});'


def set_statement(item, first):
    p, t, e, kind = item["path"], item["type"], item["expression"], item["kind"]
    prefix = "if" if first else "else if"
    if kind == "bool": value = "bv"
    elif kind == "real": value = f"({t})rv"
    elif kind == "time": value = "milliseconds_to_time(rv)"
    elif t.startswith("U") or t in {"BYTE", "WORD", "DWORD", "LWORD"}: value = f"({t})strtoull(raw,NULL,10)"
    else: value = f"({t})strtoll(raw,NULL,10)"
    return f'    {prefix} (!strcmp(tag,"{p}")) {{ {e}={value}; return 1; }}'


generated = [
    "/* Gerado de types/, blocks/, globals/ e do PROGRAM configurado. Não editar. */",
    "static void generated_add_variables(char *b,size_t n,int*u,int*f) {",
    *(add_statement(item) for item in catalog),
    "}",
    "static int generated_set_tag(const char *tag,const char *raw) {",
    "    int bv=(!strcasecmp(raw,\"true\")||atoi(raw)!=0); double rv=atof(raw);",
    *(set_statement(item, index == 0) for index, item in enumerate(catalog)),
    "    return 0;",
    "}",
]
(BUILD / "variables_generated.inc").write_text("\n".join(generated) + "\n", encoding="utf-8")
(BUILD / "variables.json").write_text(json.dumps({
    "version": 1, "entrypoint": entrypoint, "variables": [
        {key: value for key, value in item.items() if key not in {"expression", "storage"}} for item in catalog
    ], "unsupported": unsupported,
}, ensure_ascii=False, indent=2), encoding="utf-8")

# Índice estático de leitura, escrita e dependências. A extensão combina estes
# dados com mudanças observadas online para indicar origem e causa provável.
source_map = json.loads((BUILD / "source_map.json").read_text(encoding="utf-8"))
project_text = (BUILD / "project.st").read_text(encoding="utf-8")
project_lines = re.sub(r"\(\*.*?\*\)", lambda match: "\n" * match.group(0).count("\n"), project_text, flags=re.S).splitlines()
canonical = {item["path"].upper(): item["path"] for item in catalog}
routine_by_file = {item["file"]: item["name"] for item in source_map.get("routines", [])}
writers = {}
references = {item["path"]: {"reads": [], "writes": []} for item in catalog}
dependencies = {}
dependency_details = {}
write_expressions = {}
write_dependencies = {}
assignment = re.compile(r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*:=", re.I)
token_pattern = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")


def resolve_token(token):
    upper = token.upper()
    if upper in canonical:
        return [canonical[upper]]
    local = f"{entrypoint}.{upper}".upper()
    if local in canonical:
        return [canonical[local]]
    if "." not in upper:
        return [path for key, path in canonical.items() if key.endswith(f".{upper}")]
    return []


def append_unique(items, value):
    if not any(item["file"] == value["file"] and item["line"] == value["line"] for item in items):
        items.append(value)


active_file = None
condition_stack = []
for generated_line, mapped in source_map.get("lines", {}).items():
    text = project_lines[int(generated_line) - 1]
    if mapped["file"] != active_file:
        active_file, condition_stack = mapped["file"], []
    upper_text = text.upper()
    if re.search(r"\bELSIF\b", upper_text) and condition_stack:
        condition_stack.pop()
    if re.match(r"^\s*ELSE\s*$", upper_text) and condition_stack:
        condition_stack.pop()
    condition_match = re.search(r"\b(?:IF|ELSIF)\s+(.+?)\s+THEN\b", text, re.I)
    if condition_match:
        condition = {}
        condition_text = condition_match.group(1)
        for token in token_pattern.finditer(condition_text):
            negated = bool(re.search(r"\bNOT\s*$", condition_text[:token.start()], re.I))
            for resolved in resolve_token(token.group(0)):
                condition[resolved] = condition.get(resolved, False) or negated
        condition_stack.append(condition)
    location = {
        "routine": routine_by_file.get(mapped["file"], Path(mapped["file"]).stem),
        "file": mapped["file"], "line": mapped["line"],
    }
    matches = list(assignment.finditer(text))
    lhs_spans = [match.span(1) for match in matches]
    read_paths = set()
    read_polarity = {}
    for token in token_pattern.finditer(text):
        if any(start <= token.start() < end for start, end in lhs_spans):
            continue
        resolved = resolve_token(token.group(0))
        read_paths.update(resolved)
        negated = bool(re.search(r"\bNOT\s*$", text[:token.start()], re.I))
        for variable_path in resolved:
            read_polarity[variable_path] = read_polarity.get(variable_path, False) or negated
    for variable_path in read_paths:
        append_unique(references[variable_path]["reads"], location)
    for match in matches:
        before = text[:match.start()].rstrip()
        if before.endswith(("(", ",")):  # parâmetro nomeado de chamada de FB
            continue
        for variable_path in dict.fromkeys(resolve_token(match.group(1))):
            writers[variable_path] = location
            append_unique(references[variable_path]["writes"], location)
            expressions = write_expressions.setdefault(variable_path, [])
            expression_item = {**location, "statement": text.strip()}
            if not any(item["file"] == location["file"] and item["line"] == location["line"] for item in expressions):
                expressions.append(expression_item)
            dependencies.setdefault(variable_path, set()).update(read_paths)
            dependencies[variable_path].update(*(set(condition) for condition in condition_stack))
            dependencies[variable_path].discard(variable_path)
            details = dependency_details.setdefault(variable_path, {})
            for dependency in read_paths:
                if dependency != variable_path:
                    details[dependency] = details.get(dependency, False) or read_polarity.get(dependency, False)
            for condition in condition_stack:
                for dependency, negated in condition.items():
                    if dependency != variable_path:
                        details[dependency] = details.get(dependency, False) or negated
            per_write = {dependency: read_polarity.get(dependency, False) for dependency in read_paths if dependency != variable_path}
            for condition in condition_stack:
                for dependency, negated in condition.items():
                    if dependency != variable_path:
                        per_write[dependency] = per_write.get(dependency, False) or negated
            entries = write_dependencies.setdefault(variable_path, [])
            write_item = {**location, "statement": text.strip(), "dependencies": [{"tag": tag, "negated": negated} for tag, negated in sorted(per_write.items())]}
            if not any(item["file"] == location["file"] and item["line"] == location["line"] for item in entries):
                entries.append(write_item)
    if re.search(r"\bEND_IF\b", upper_text) and condition_stack:
        condition_stack.pop()
(BUILD / "writers.json").write_text(json.dumps({
    "version": 1, "writers": writers,
}, ensure_ascii=False, indent=2), encoding="utf-8")
(BUILD / "references.json").write_text(json.dumps({
    "version": 1,
    "references": references,
    "dependencies": {path: sorted(values) for path, values in dependencies.items()},
    "dependencyDetails": {path: [{"tag": tag, "negated": negated} for tag, negated in sorted(values.items())] for path, values in dependency_details.items()},
    "writeExpressions": write_expressions,
    "writeDependencies": write_dependencies,
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Catálogo ST: {len(catalog)} variáveis de {entrypoint}; {len(unsupported)} tipos não expostos.")
