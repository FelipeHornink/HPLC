#!/usr/bin/env python3
"""Builds the IEC unit and the source map without changing the project sources."""
from pathlib import Path
import json
import os
import re
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import msg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# The build reads the prepared portable copy, never the official project sources.
SOURCE_ROOT = Path(os.environ.get("HPLC_SOURCE_ROOT", ROOT)).resolve()
BUILD = ROOT / ".plcsim" / "build"
BUILD.mkdir(parents=True, exist_ok=True)

manifest = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))
active_directories = set(manifest.get("source_directories", []))
tasks = manifest.get("task", [])
if not tasks:
    raise SystemExit(msg("build_no_task"))
task = tasks[0]
main_program = task.get("program")
task_name = task.get("name", "MainTask")
interval_ms = int(task.get("interval_ms", 10))
for value, label in ((main_program, "program"), (task_name, "name")):
    if not value or not re.fullmatch(r"[A-Za-z_]\w*", value):
        raise SystemExit(msg("build_invalid_task_field", label=label, value=repr(value)))


def files(folder):
    if folder not in active_directories:
        return []
    return sorted((SOURCE_ROOT / folder).glob("*.st"))


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
# A new or freshly emptied project has no global list yet; that is valid.

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
            "file": source.relative_to(SOURCE_ROOT).as_posix(),
            "line": source_line,
            "kind": kind,
        }


POU_HEADER = re.compile(r"^\s*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\b", re.I)


ROUTINE_MARK = re.compile(r"^\s*\(\*\s*@ROUTINE\s+([^*]+?)\s*\*\)\s*$")


def resolve_routine(name):
    if "routines" not in active_directories:
        raise SystemExit(msg("build_routines_inactive"))
    routine = SOURCE_ROOT / "routines" / name.strip()
    if not routine.is_file():
        raise SystemExit(msg("build_routine_not_found", path=routine))
    return routine


def append_routine(routine, stack=()):
    """Expands a routine, and the routines it references itself.

    Recursive so that Main can keep a fixed list of steps: what is a sub-step
    lives in the file of the step that contains it, without becoming a new
    step. The source map is still per file, so the simulation bar and the
    debugger keep pointing at the right place.
    """
    if routine in stack:
        chain = " -> ".join(r.name for r in stack + (routine,))
        raise SystemExit(msg("build_routine_cycle", path=chain))
    if len(stack) > 4:
        raise SystemExit(msg("build_routine_too_deep", name=routine.name))
    for number, line in enumerate(routine.read_text(encoding="utf-8").splitlines(), 1):
        mark = ROUTINE_MARK.match(line)
        if mark:
            append_routine(resolve_routine(mark.group(1)), stack + (routine,))
            append()
            continue
        append(line, routine, number, "routines")


def append_source(source, kind, inject_external=False):
    source_lines = source.read_text(encoding="utf-8").splitlines()
    injected = False
    for number, line in enumerate(source_lines, 1):
        routine_match = ROUTINE_MARK.match(line)
        if routine_match:
            append_routine(resolve_routine(routine_match.group(1)))
            append()
            continue
        append(line, source, number, kind)
        # Before the POU's own VAR: STruC++ does not accept VAR_EXTERNAL
        # interleaved between declaration blocks.
        if inject_external and not injected and POU_HEADER.match(line):
            for generated in external_lines:
                append(generated)
            injected = True
    append()
    return injected


# Every POU that is not a type receives VAR_EXTERNAL. Injecting only into the
# first one, as before, worked for the example project with a single Main, but
# left the other POUs of an imported project unable to see the global variables.
for folder in ("types", "functions", "blocks"):
    for source in ordered_type_files() if folder == "types" else files(folder):
        append_source(source, folder, folder != "types")

external_injected = False
for source in files("programs"):
    injected = append_source(source, "programs", True)
    external_injected = external_injected or injected
if not external_injected:
    raise SystemExit(msg("build_no_external"))

append("CONFIGURATION Config0")
# One block per list, with its own header: merging everything into a single
# VAR_GLOBAL erased RETAIN and CONSTANT, which come right after VAR_GLOBAL.
for body in global_bodies:
    for line in ("VAR_GLOBAL" + body).splitlines():
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

# Execution tree. The list follows the real call order from the task program,
# so the "running PLCs" view shows what runs inside each POU instead of only the
# main program. The VS Code view renders a flat list, so the depth is encoded in
# the name itself.
POU_PATTERN = re.compile(r"^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_]\w*)", re.I)
KIND_LABEL = {"PROGRAM": "PRG", "FUNCTION_BLOCK": "FB", "FUNCTION": "FUN"}
CONTROL_KEYWORDS = {"IF", "ELSIF", "WHILE", "FOR", "CASE", "REPEAT", "RETURN", "NOT", "AND", "OR"}


def declared_kind(relative_path, fallback):
    # prepare_runtime.py turns PROGRAM into FUNCTION_BLOCK in the portable copy.
    # The label shown must be the official source's, not the copy's.
    source = ROOT / relative_path
    if source.is_file():
        for line in source.read_text(encoding="utf-8").splitlines():
            match = POU_PATTERN.match(line)
            if match:
                return match.group(1).upper()
    return fallback


def parse_pou(source):
    text = source.read_text(encoding="utf-8")
    lines = text.splitlines()
    header = next((POU_PATTERN.match(line) for line in lines if POU_PATTERN.match(line)), None)
    if not header:
        return None
    without_comments = re.sub(r"\(\*.*?\*\)", "", text, flags=re.S)
    instances = {}
    for block in re.findall(r"\bVAR(?:_\w+)?\b(.*?)\bEND_VAR\b", without_comments, re.S | re.I):
        for chunk in block.split(";"):
            declaration = re.match(r"\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([A-Za-z_]\w*)\s*$", chunk.split(":=")[0], re.S)
            if declaration:
                for name in re.split(r"\s*,\s*", declaration.group(1).strip()):
                    instances[name.upper()] = declaration.group(2).upper()
    statements = re.sub(r"\bVAR(?:_\w+)?\b.*?\bEND_VAR\b", "", without_comments, flags=re.S | re.I)
    calls = []
    for call in re.finditer(r"(?m)^\s*([A-Za-z_]\w*)\s*\(", statements):
        token = call.group(1)
        if token.upper() not in CONTROL_KEYWORDS and token not in calls:
            calls.append(token)
    relative = source.relative_to(SOURCE_ROOT).as_posix()
    return {
        "name": header.group(2),
        "kind": declared_kind(relative, header.group(1).upper()),
        "file": relative,
        "endLine": len(lines),
        "instances": instances,
        "calls": calls,
    }


pous = {}
for folder in ("functions", "blocks", "programs"):
    for source in files(folder):
        pou = parse_pou(source)
        if pou:
            pous[pou["name"].upper()] = pou


def resolve_call(owner, token):
    instance_type = owner["instances"].get(token.upper())
    if instance_type in pous:
        return pous[instance_type], token
    if token.upper() in pous:
        return pous[token.upper()], None
    return None, None


def entry(pou, guides=None, last=None, instances=(), suffix=""):
    # guides stores, for each level above, whether that branch has ended. The
    # root level has no connector; the others use ├─ up to the last sibling, which uses └─.
    title = f"{KIND_LABEL.get(pou['kind'], 'POU')} — {pou['name']}"
    if len(instances) > 1:
        title += f" \u00d7{len(instances)}"
    elif instances and instances[0].upper() != pou["name"].upper():
        title += f" ({instances[0]})"
    guides = guides or ()
    prefix = "".join("   " if finished else "\u2502  " for finished in guides)
    if last is not None:
        prefix += "\u2514\u2500 " if last else "\u251c\u2500 "
    return {
        "name": prefix + title + suffix,
        "title": title,
        "pou": pou["name"],
        "depth": len(guides) + (0 if last is None else 1),
        "file": pou["file"],
        "startLine": 1,
        "endLine": pou["endLine"],
    }


# Without expand_function_blocks, FBs are leaves: the blocks called by the
# programs stay visible, but internal timer instances and the like stay
# collapsed. The VS Code view renders a flat list, so expanding everything by
# default fills the view with noise.
expand_blocks = bool(manifest.get("debug", {}).get("expand_function_blocks", False))
seen = set()
expanded = set()


def grouped_children(pou):
    # Several instances of the same block become one line with the count.
    groups = {}
    for token in pou["calls"]:
        target, instance = resolve_call(pou, token)
        if not target:
            continue
        group = groups.setdefault(target["name"].upper(), (target, []))
        if instance:
            group[1].append(instance)
    return list(groups.values())


def walk(pou, guides=(), last=None, instances=()):
    children = grouped_children(pou)
    leaf = pou["kind"] == "FUNCTION_BLOCK" and not expand_blocks
    suffix = msg("tree_contains", count=len(children)) if leaf and children else ""
    routines.append(entry(pou, guides, last, instances, suffix))
    seen.add(pou["name"].upper())
    for target, _ in children:
        seen.add(target["name"].upper())
    if leaf or pou["name"].upper() in expanded:
        return
    expanded.add(pou["name"].upper())
    child_guides = guides if last is None else (*guides, last)
    for index, (target, child_instances) in enumerate(children):
        walk(target, child_guides, index == len(children) - 1, tuple(child_instances))


if main_program.upper() in pous:
    walk(pous[main_program.upper()])
for key in sorted(pous):
    if key not in seen:
        routines.append(entry(pous[key], suffix=msg("tree_not_called")))

# Visual routines injected into Main through (* @ROUTINE file *).
for source in files("routines"):
    source_lines = source.read_text(encoding="utf-8").splitlines()
    title = re.sub(r"^\d+_", "", source.stem).replace("_", " ")
    routines.append({
        "name": title,
        "title": title,
        "pou": title,
        "depth": 1,
        "file": source.relative_to(SOURCE_ROOT).as_posix(),
        "startLine": 1,
        "endLine": len(source_lines),
    })

(BUILD / "source_map.json").write_text(json.dumps({
    "version": 1,
    "generated": ".plcsim/build/project.st",
    "lines": line_map,
    "routines": routines,
}, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Generated {target} with {len(declarations)} global variables and {len(line_map)} mapped lines.")
