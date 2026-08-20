#!/usr/bin/env python3
"""Monta a unidade IEC e o mapa fonte sem alterar os fontes do projeto."""
from pathlib import Path
import json
import re
import tomllib

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / ".plcsim" / "build"
BUILD.mkdir(parents=True, exist_ok=True)

manifest = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))
active_directories = set(manifest.get("source_directories", []))
tasks = manifest.get("task", [])
if not tasks:
    raise SystemExit("plc.toml não possui uma [[task]] configurada")
task = tasks[0]
main_program = task.get("program")
task_name = task.get("name", "MainTask")
interval_ms = int(task.get("interval_ms", 10))
for value, label in ((main_program, "program"), (task_name, "name")):
    if not value or not re.fullmatch(r"[A-Za-z_]\w*", value):
        raise SystemExit(f"[[task]].{label} inválido: {value!r}")


def files(folder):
    if folder not in active_directories:
        return []
    return sorted((ROOT / folder).glob("*.st"))


def ordered_type_files():
    sources = files("types")
    declarations = {}
    texts = {}
    for source in sources:
        text = source.read_text(encoding="utf-8")
        texts[source] = text
        match = re.search(r"\bTYPE\s+([A-Za-z_]\w*)", text, re.I)
        if match:
            declarations[match.group(1).lower()] = source
    dependencies = {}
    for source, text in texts.items():
        own = next((name for name, owner in declarations.items() if owner == source), None)
        dependencies[source] = {
            owner for name, owner in declarations.items()
            if name != own and re.search(rf"\b{re.escape(name)}\b", text, re.I)
        }
    ordered, visiting, visited = [], set(), set()

    def visit(source):
        if source in visited:
            return
        if source in visiting:
            return
        visiting.add(source)
        for dependency in sorted(dependencies.get(source, ()), key=lambda item: item.name):
            visit(dependency)
        visiting.remove(source)
        visited.add(source)
        ordered.append(source)

    for source in sources:
        visit(source)
    return ordered


def group_text(folder):
    return "\n".join(path.read_text(encoding="utf-8") for path in files(folder))


globals_st = group_text("globals")
global_bodies = re.findall(r"VAR_GLOBAL(.*?)END_VAR", globals_st, re.S | re.I)
if not global_bodies:
    raise SystemExit("Nenhum bloco VAR_GLOBAL encontrado em globals/")

declarations = []
for body in global_bodies:
    for line in body.splitlines():
        clean = re.sub(r"\(\*.*?\*\)", "", line).strip()
        match = re.match(r"([A-Za-z_]\w*)\s*:\s*(.+);", clean)
        if match:
            data_type = match.group(2).split(":=", 1)[0].strip()
            declarations.append((match.group(1), data_type))

external_lines = ["VAR_EXTERNAL", *(
    f"    {name} : {data_type};" for name, data_type in declarations
), "END_VAR"]

unit_lines = []
line_map = {}
routines = []


def append(line="", source=None, source_line=None, kind=None):
    unit_lines.append(line)
    if source is not None:
        line_map[str(len(unit_lines))] = {
            "file": source.relative_to(ROOT).as_posix(),
            "line": source_line,
            "kind": kind,
        }


def append_source(source, kind, inject_external=False):
    source_lines = source.read_text(encoding="utf-8").splitlines()
    injected = False
    for number, line in enumerate(source_lines, 1):
        routine_match = re.match(r"^\s*\(\*\s*@ROUTINE\s+([^*]+?)\s*\*\)\s*$", line)
        if routine_match:
            if "routines" not in active_directories:
                raise SystemExit("Main referencia rotinas, mas 'routines' não está em source_directories")
            routine = ROOT / "routines" / routine_match.group(1).strip()
            if not routine.is_file():
                raise SystemExit(f"Rotina referenciada não encontrada: {routine}")
            for routine_number, routine_line in enumerate(routine.read_text(encoding="utf-8").splitlines(), 1):
                append(routine_line, routine, routine_number, "routines")
            append()
            continue
        append(line, source, number, kind)
        if inject_external and not injected and re.match(r"^\s*END_VAR\b", line, re.I):
            for generated in external_lines:
                append(generated)
            injected = True
    append()
    return injected


for folder in ("types", "functions", "blocks"):
    for source in ordered_type_files() if folder == "types" else files(folder):
        append_source(source, folder)

external_injected = False
for source in files("programs"):
    injected = append_source(source, "programs", not external_injected)
    external_injected = external_injected or injected
if not external_injected:
    raise SystemExit("O primeiro PROGRAM não possui bloco VAR/END_VAR para VAR_EXTERNAL.")

append("CONFIGURATION Config0")
append("VAR_GLOBAL")
for body in global_bodies:
    for line in body.splitlines():
        append(line)
append("END_VAR")
append("  RESOURCE Res0 ON PLC")
append(f"    TASK {task_name}(INTERVAL := T#{interval_ms}ms, PRIORITY := 0);")
append(f"    PROGRAM Inst0 WITH {task_name} : {main_program};")
append("  END_RESOURCE")
append("END_CONFIGURATION")

unit = "\n".join(unit_lines) + "\n"
target = BUILD / "project.st"
target.write_text(unit, encoding="utf-8")

# Seções comentadas no Main tornam-se rotinas visuais sem alterar o ST exportado.
section_pattern = re.compile(r"\(\*\s*([0-9/]+)\s*[—-]\s*(.*?)\s*\*\)")
for folder, keyword in (("functions", "FUNCTION"), ("blocks", "FUNCTION_BLOCK")):
    for source in files(folder):
        source_lines = source.read_text(encoding="utf-8").splitlines()
        declaration = next((line for line in source_lines if re.match(rf"^\s*{keyword}\s+", line, re.I)), "")
        match = re.match(rf"^\s*{keyword}\s+([A-Za-z_]\w*)", declaration, re.I)
        if match:
            prefix = "FUN" if folder == "functions" else "FB"
            routines.append({
                "name": f"{prefix} — {match.group(1)}",
                "file": source.relative_to(ROOT).as_posix(),
                "startLine": 1,
                "endLine": len(source_lines),
            })
for source in files("programs"):
    source_lines = source.read_text(encoding="utf-8").splitlines()
    declaration = next((line for line in source_lines if re.match(r"^\s*PROGRAM\s+", line, re.I)), "")
    match = re.match(r"^\s*PROGRAM\s+([A-Za-z_]\w*)", declaration, re.I)
    if match:
        routines.append({
            "name": f"PRG — {match.group(1)}",
            "file": source.relative_to(ROOT).as_posix(),
            "startLine": 1,
            "endLine": len(source_lines),
        })
for source in files("routines"):
    title = re.sub(r"^\d+_", "", source.stem).replace("_", " ")
    source_lines = source.read_text(encoding="utf-8").splitlines()
    routines.append({
        "name": title,
        "file": source.relative_to(ROOT).as_posix(),
        "startLine": 1,
        "endLine": len(source_lines),
    })

(BUILD / "source_map.json").write_text(json.dumps({
    "version": 1,
    "generated": ".plcsim/build/project.st",
    "lines": line_map,
    "routines": routines,
}, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Gerado {target} com {len(declarations)} variáveis globais e {len(line_map)} linhas mapeadas.")
