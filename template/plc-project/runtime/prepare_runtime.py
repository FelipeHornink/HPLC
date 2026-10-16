#!/usr/bin/env python3
"""Portable copy of the sources for the compiler, without touching the project.

The project keeps what came from the manufacturer. Only the adaptations that
exist because of the simulator live here, recorded in translation-report.json.
"""
from pathlib import Path
import json
import re
import shutil
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
GENERATED = ROOT / ".plcsim" / "generated"
TARGET = GENERATED / "src"
FOLDERS = ("types", "functions", "blocks", "globals", "programs", "routines")

# Manufacturer library type written with a dot. The dot is not accepted in a
# type name; flatten it and declare an empty equivalent so compilation succeeds.
DOTTED_TYPE = re.compile(r"(\bOF\s+|:\s*)([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*;")
# Manufacturer hardware diagnostics: they belong to the controller, not to the portable copy.
DIAGNOSTIC = re.compile(r"^\s*\w+(?:\s+AT\s+%\S+)?\s*:\s*(?:ARRAY\s*\[[^\]]*\]\s*OF\s+)?T_DIAG\w*\s*;\s*$", re.M)

if TARGET.exists():
    shutil.rmtree(TARGET)
TARGET.mkdir(parents=True, exist_ok=True)

report = []
flattened = set()
from prepare_native import prepare as prepare_native  # noqa: E402
native_sources, native_report = prepare_native(ROOT)
report.extend(native_report)
for folder in FOLDERS:
    origin = ROOT / folder
    if not origin.is_dir():
        continue
    (TARGET / folder).mkdir(parents=True, exist_ok=True)
    names = {f.name for f in origin.glob("*.st")}
    if native_sources is not None:
        names.update(Path(n).name for n in native_sources if n.startswith(folder + '/'))
    for file_name in sorted(names):
        path = origin / file_name
        text = original = (native_sources[f"{folder}/{path.name}"]
                           if native_sources is not None else path.read_text(encoding="utf-8"))
        transformations = []

        def flatten(m):
            flattened.add(f"{m.group(2)}_{m.group(3)}")
            return f"{m.group(1)}{m.group(2)}_{m.group(3)};"

        text, n = DOTTED_TYPE.subn(flatten, text)
        if n:
            transformations.append({"rule": "library-type.flattened",
                                    "reason": "Type names with a dot are not accepted by the compiler.",
                                    "occurrences": n})
        text, n = DIAGNOSTIC.subn("", text)
        if n:
            transformations.append({"rule": "hardware-diagnostic.omitted",
                                    "reason": "Controller diagnostics do not go into the portable executable.",
                                    "occurrences": n})
        (TARGET / folder / path.name).write_text(text, encoding="utf-8")
        report.append({"source": f"{folder}/{path.name}", "changed": text != original,
                       "transformations": transformations})

if flattened:
    stubs = "\n".join(f"TYPE {name} : STRUCT reserved : BOOL; END_STRUCT; END_TYPE" for name in sorted(flattened))
    (TARGET / "types" / "99_library_types.generated.st").write_text(
        "(* Empty equivalents for manufacturer library types. *)\n" + stubs + "\n", encoding="utf-8")
    report.append({"source": "types/99_library_types.generated.st", "changed": True,
                   "transformations": [{"rule": "library-type.stub",
                                        "reason": "Empty declaration to compile without the library.",
                                        "occurrences": len(flattened)}]})

# --------------------------------------------------------------------------
# Compiler bug workarounds. Each one cites the symptom so it can be removed
# when STruC++ fixes it.
# --------------------------------------------------------------------------
sources = {path: path.read_text(encoding="utf-8")
           for folder in FOLDERS for path in sorted((TARGET / folder).glob("*.st"))}
extra = []

# Addresses used as operands become simulator memory channels.
# The official sources and the XML keep the controller addresses.
channels = {}


def expand_case_lists(text):
    # The backend parser does not recognize long label lists. Repeating the same
    # body in separate labels keeps exactly the same selection and statements.
    lines = text.splitlines(keepends=True)
    stack = []
    branches = []
    open_branches = {}
    mask = re.sub(r'\(\*.*?\*\)|//[^\n]*',
                  lambda m: ''.join('\n' if c == '\n' else ' ' for c in m.group()),
                  text, flags=re.S).splitlines()
    for i, line in enumerate(mask):
        label = re.match(r'^\s*(\d+(?:\s*,\s*\d+)*)\s*:(?![=])', line)
        if stack and stack[-1] == 'CASE' and (label or re.match(r'^\s*(ELSE|END_CASE)\b', line, re.I)):
            key = len(stack)
            if key in open_branches:
                start, values = open_branches.pop(key)
                branches.append((start, i, values))
            if label and ',' in label.group(1):
                open_branches[key] = (i, label.group(1).split(','))
        for token in re.findall(r'\b(?:END_CASE|END_IF|END_FOR|END_WHILE|END_REPEAT|CASE|IF|FOR|WHILE|REPEAT)\b', line, re.I):
            token = token.upper()
            if token.startswith('END_'):
                if stack: stack.pop()
            else:
                stack.append(token)
    for start, end, values in reversed(branches):
        first = lines[start]
        body = ''.join(lines[start + 1:end])
        lines[start:end] = [re.sub(r'^(\s*)\d+(?:\s*,\s*\d+)*\s*:',
                                   lambda m: m.group(1) + value.strip() + ':', first) + body
                            for value in values]
    return ''.join(lines), len(branches)


# Qualifiers STruC++ 0.6.3 does not accept: PERSISTENT (CODESYS extension) in
# any section, and RETAIN in VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT. The official
# source keeps both; the simulator does not keep memory between runs.
VAR_HEADER = re.compile(r"^(\s*)(VAR(?:_\w+)?)((?:[ \t]+(?:RETAIN|NON_RETAIN|PERSISTENT|CONSTANT)\b)+)",
                        re.M | re.I)


def without_unsupported_qualifier(m):
    section = m.group(2).upper()
    kept = [q for q in m.group(3).split()
            if q.upper() != "PERSISTENT"
            and not (q.upper() == "RETAIN" and section in {"VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"})]
    return m.group(1) + " ".join([m.group(2), *kept])


for path, text in list(sources.items()):
    new = VAR_HEADER.sub(without_unsupported_qualifier, text)
    if new != text:
        n = sum(1 for a, b in zip(VAR_HEADER.findall(text), VAR_HEADER.findall(new)) if a != b)
        extra.append((path, "section.unsupported-qualifier",
                      "PERSISTENT, and RETAIN on inputs/outputs, are not accepted by STruC++; "
                      "the official source keeps the qualifier.", n))
        sources[path] = new

for path, text in list(sources.items()):
    def channel(m):
        address = m.group(0).upper()
        name = 'SimIO_' + address[1:].replace('.', '_')
        channels[address] = name
        return name
    text, n = re.subn(r'%[IQ]X\d+\.\d+', channel, text, flags=re.I)
    if n:
        extra.append((path, 'io.address-in-memory',
                      'Physical channel replaced by an equivalent simulation variable.', n))
    # MasterTool accepts terminators without a semicolon; the backend requires
    # the separator to recognize CASE after another compound statement.
    text, n = re.subn(r'\b(END_IF|END_CASE|END_FOR|END_WHILE|END_REPEAT)\b(?!\s*;)',
                      r'\1;', text, flags=re.I)
    if n:
        extra.append((path, 'syntax.terminator',
                      'Explicit semicolon after a compound statement.', n))
    text, n = expand_case_lists(text)
    if n:
        extra.append((path, 'case.list-into-branches',
                      'Label list expanded into branches with identical bodies.', n))
    sources[path] = text
if channels:
    path = TARGET / 'globals' / '99_sim_io.generated.st'
    sources[path] = 'VAR_GLOBAL\n' + ''.join(
        f'    {name} : BOOL; (* {address} *)\n' for address, name in sorted(channels.items())
    ) + 'END_VAR\n'
    (GENERATED / 'io-addresses.json').write_text(json.dumps(channels, indent=2) + '\n')

# 1. Type with the same name as a struct member. STruC++ renames the member to
#    NAME_ in the declaration but emits .NAME at the use, and the C++ does not compile.
types = {}
for path, text in sources.items():
    for name in re.findall(r"\bTYPE\s+([A-Za-z_]\w*)\s*:", text, re.I):
        types[name.upper()] = name
members = set()
for text in sources.values():
    for block in re.findall(r"\bSTRUCT\b(.*?)\bEND_STRUCT\b", text, re.S | re.I):
        members.update(m.upper() for m in re.findall(r"^\s*([A-Za-z_]\w*)\s*:", block, re.M))
colliding = {key: name for key, name in types.items() if key in members}
for key, name in colliding.items():
    target = f"{name}_T"
    pattern = re.compile(rf"(\bTYPE\s+|\bOF\s+|:\s*){re.escape(name)}\b", re.I)
    for path in list(sources):
        sources[path], n = pattern.subn(lambda m: m.group(1) + target, sources[path])
        if n:
            extra.append((path, "type.name.collides-with-member",
                          f"Type {name} has the same name as a struct member; "
                          f"STruC++ renames the member in the declaration but not at the use.", n))

# 2. PROGRAM calling PROGRAM. STruC++ accepts it in ST but generates a call to a
#    nonexistent identifier. It becomes a FUNCTION_BLOCK with an instance in the caller.
entry_program = tomllib.loads((ROOT / "plc.toml").read_text(encoding="utf-8"))["task"][0]["program"]
programs = {}
for path, text in sources.items():
    m = re.search(r"^\s*PROGRAM\s+([A-Za-z_]\w*)", text, re.M | re.I)
    if m and m.group(1).upper() != entry_program.upper():
        programs[m.group(1).upper()] = m.group(1)
for key, name in programs.items():
    path = next(c for c, text in sources.items()
                if re.search(rf"^\s*PROGRAM\s+{re.escape(name)}\b", text, re.M | re.I))
    sources[path] = re.sub(rf"^(\s*)PROGRAM(\s+{re.escape(name)}\b)", r"\1FUNCTION_BLOCK\2",
                           sources[path], count=1, flags=re.M | re.I)
    sources[path] = re.sub(r"^\s*END_PROGRAM\s*$", "END_FUNCTION_BLOCK", sources[path],
                           count=1, flags=re.M | re.I)
    extra.append((path, "program.as-block",
                  "PROGRAM called by another POU becomes FUNCTION_BLOCK; STruC++ generates "
                  "an invalid call for a nested PROGRAM.", 1))
for path in list(sources):
    called = [name for key, name in programs.items()
              if re.search(rf"(?<![.\w]){re.escape(name)}\s*\(\s*\)\s*;", sources[path], re.I)]
    if not called:
        continue
    declarations = "".join(f"    fb_{name} : {name};\n" for name in called)
    sources[path] = re.sub(r"(?m)^((?:PROGRAM|FUNCTION_BLOCK)\s+\w+.*\n)",
                           lambda m: m.group(1) + "VAR\n" + declarations + "END_VAR\n",
                           sources[path], count=1)
    for name in called:
        sources[path] = re.sub(rf"(?<![.\w]){re.escape(name)}(\s*\(\s*\)\s*;)",
                               rf"fb_{name}\1", sources[path], flags=re.I)
    extra.append((path, "program.instance-in-caller",
                  "Instance created for each called program.", len(called)))

for path, text in sources.items():
    path.write_text(text, encoding="utf-8")
index = {}
for item in report:
    if item['source'] in index:
        index[item['source']]['transformations'].extend(item['transformations'])
        index[item['source']]['changed'] |= item['changed']
    else:
        index[item['source']] = item
for path, rule, reason, n in extra:
    key = f"{path.parent.name}/{path.name}"
    item = index.setdefault(key, {"source": key, "changed": True, "transformations": []})
    item["changed"] = True
    item["transformations"].append({"rule": rule, "reason": reason, "occurrences": n})
report = list(index.values())

changed = sum(1 for item in report if item["changed"])
(GENERATED / "translation-report.json").write_text(json.dumps({
    "version": 3, "backend": "strucpp", "target": str(TARGET.relative_to(ROOT)),
    "files": report, "summary": {"total": len(report), "changed": changed},
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Portable copy: {changed} of {len(report)} files adapted in {TARGET}")
