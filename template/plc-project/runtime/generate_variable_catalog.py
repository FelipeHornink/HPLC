#!/usr/bin/env python3
"""Online catalog of global variables and PROGRAM locals, for STruC++.

STruC++ declares each global variable as `GlobalVar<V> NAME` at file scope,
with the name in upper case. A structure becomes a struct with upper-case
fields and arrays are indexed with []. Every leaf ends in an IECVar, which
exposes get() and set(). This generator walks the prepared ST sources and
emits the matching C++ accessors.
"""
from pathlib import Path
import json
import os
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = Path(os.environ.get("HPLC_SOURCE_ROOT", ROOT)).resolve()
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
        # A VAR RETAIN / VAR_GLOBAL CONSTANT header leaves the qualifier glued to
        # the first declaration; without removing it, that variable vanished from the catalog.
        chunk = re.sub(r"^\s*(?:(?:RETAIN|NON_RETAIN|PERSISTENT|CONSTANT)\b\s*)+", "", chunk, flags=re.I)
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

# STruC++ renames identifiers that collide with C++ reserved names by appending
# "_". Instead of guessing the rule, read the real names from the generated
# header and match them with the ST ones.
HEADER = BUILD / "out" / "project.hpp"
header_text = HEADER.read_text(encoding="utf-8") if HEADER.is_file() else ""
struct_members = {}
for match in re.finditer(r"\bstruct\s+([A-Za-z_]\w*)\s*\{(.*?)\n\};", header_text, re.S):
    members = set(re.findall(r"^\s*[A-Za-z_][\w:<>,\s]*?\s([A-Za-z_]\w*)\s*\{", match.group(2), re.M))
    struct_members[match.group(1).upper()] = members
header_globals = set(re.findall(r"\binline\s+GlobalVar<[^>]*>\s+([A-Za-z_]\w*)\s*\{", header_text))
# Members of each generated class (program and block), to match the real name.
class_members = {}
for match in re.finditer(r"^class\s+([A-Za-z_]\w*)\b[^;{]*\{(.*?)^\};", header_text, re.S | re.M):
    class_members[match.group(1).upper()] = set(
        re.findall(r"^\s+[A-Za-z_][\w:<>, ]*?[\s*&]([A-Za-z_]\w*)\s*(?:=[^;]*|\{[^;]*\})?;", match.group(2), re.M))


def actual_name(candidate, known):
    """Name as the compiler wrote it, tolerating the disambiguation suffix."""
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
        unsupported.append({"path": path, "type": declared, "reason": "recursive type"})
        return
    known = struct_members.get(upper)
    for name, field_type in fields:
        field = actual_name(name.upper(), known)
        add_leaves(f"{path}.{name}", f"{expression}.{field}", field_type, (*seen, upper))


for source in files("globals"):
    text = source.read_text(encoding="utf-8")
    for body in re.findall(r"VAR_GLOBAL(.*?)END_VAR", text, re.S | re.I):
        for name, declared in declarations(body):
            add_leaves(name, f"{actual_name(name.upper(), header_globals)}.value", declared)
total_globals = len(catalog)


# PROGRAM locals. A CODESYS project keeps operating switches in program
# variables (the manufacturer's simulation mode, for example); without them here,
# neither the panel nor the debugger can reach them. The task program is the
# Inst0 instance of the Configuration; a program called by another became a
# FUNCTION_BLOCK with the fb_<Name> instance in the caller (prepare_runtime),
# and is followed through it.
STATE_SECTIONS = re.compile(r"\bVAR(?:_INPUT|_OUTPUT)?\b(?!_)(?:\s+(?:RETAIN|NON_RETAIN|CONSTANT)\b)*(.*?)\bEND_VAR\b",
                              re.S | re.I)
programs = {}
for source in files("programs"):
    text = without_comments(source.read_text(encoding="utf-8"))
    header = re.search(r"^\s*(?:PROGRAM|FUNCTION_BLOCK)\s+([A-Za-z_]\w*)", text, re.M | re.I)
    if header:
        programs[header.group(1).upper()] = (header.group(1),
                                             declarations("\n".join(STATE_SECTIONS.findall(text))))


def add_program(name, expression, class_name, visited=()):
    if name.upper() in visited or name.upper() not in programs:
        return
    original, locals_ = programs[name.upper()]
    known = class_members.get(class_name.upper())
    for local, kind in locals_:
        member = actual_name(local.upper(), known)
        if kind in programs and local.upper() == f"FB_{kind}":
            add_program(kind, f"{expression}.{member}", kind, (*visited, name.upper()))
            continue
        add_leaves(f"{original}.{local}", f"{expression}.{member}", kind)


import tomllib
manifest = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))
task = manifest.get("task", [{}])[0]
entrypoint = task.get("program", "Main")
interval_ms = int(task.get("interval_ms", 10))
add_program(entrypoint, "plc_config.INST0", f"Program_{entrypoint}")


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
    "/* Generated from globals/, types/ and blocks/. Do not edit. */",
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
# Glue with the backend: class name of the task program and cycle interval.


def system_services():
    """Controller clock and calendar, for the System_* variables of the import.

    The backend copy replaces SysTimeGetUs, GetDateAndTime and GetDayOfWeek
    with project variables; here the simulator fills them before each cycle.
    A project without those variables gets an empty function.
    """
    body = []
    if "SYSTEM_TIMEUS" in header_globals:
        body.append("    SYSTEM_TIMEUS.value = (uint64_t)__CURRENT_TIME_NS / 1000;")
    calendar = "SYSTEM_DATETIME" in header_globals
    if calendar or "SYSTEM_DAYOFWEEK" in header_globals:
        body += ["    struct timespec now;", "    clock_gettime(CLOCK_REALTIME, &now);",
                 "    struct tm local;", "    localtime_r(&now.tv_sec, &local);"]
    if calendar:
        body += ["    EXTENDED_DATE_AND_TIME date;",
                 "    date.BYYEAR = local.tm_year + 1900;", "    date.BYMONTH = local.tm_mon + 1;",
                 "    date.BYDAY = local.tm_mday;", "    date.BYHOURS = local.tm_hour;",
                 "    date.BYMINUTES = local.tm_min;", "    date.BYSECONDS = local.tm_sec;",
                 "    date.WMILLISECONDS = now.tv_nsec / 1000000;",
                 "    SYSTEM_DATETIME.value = date;"]
    if "SYSTEM_DAYOFWEEK" in header_globals:
        body.append("    SYSTEM_DAYOFWEEK.value = local.tm_wday;")
    return ["static void plc_system_services(void) {", *body, "}"]


backend = [
    "/* Generated from plc.toml. Do not edit. */",
    "/* The generated Configuration already instantiates the programs and builds",
    "   tasks and resources, so the cycle only walks what it declares. */",
    "static Configuration_CONFIG0 plc_config;",
    f"static const long plc_interval_ms = {interval_ms};",
    "static void plc_init(void) {}",
    *system_services(),
    "static void plc_run_cycle(void) {",
    "    ResourceInstance *resources = plc_config.get_resources();",
    "    for (size_t r = 0; r < plc_config.get_resource_count(); r++)",
    "        for (size_t t = 0; t < resources[r].task_count; t++)",
    "            for (size_t p = 0; p < resources[r].tasks[t].program_count; p++)",
    "                resources[r].tasks[t].programs[p]->run();",
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
print(f"Catalog: {len(catalog)} variables ({total_globals} global, {len(catalog) - total_globals} program); "
      f"{len(unsupported)} types not exposed.")
