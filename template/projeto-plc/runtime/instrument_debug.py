#!/usr/bin/env python3
"""Insere pontos de pausa no C gerado pelo matiec; nunca toca no ST original."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / ".plcsim" / "build"
SOURCE_MAP = json.loads((BUILD / "source_map.json").read_text(encoding="utf-8"))["lines"]
target = BUILD / "out" / "POUS.c"
text = target.read_text(encoding="utf-8")

prototype = "\nextern void plc_debug_point(unsigned int project_line);\nextern void plc_debug_routine(unsigned int routine_id, unsigned int project_line);\n"
include_end = text.find("\n", text.find("#include"))
if include_end < 0:
    raise SystemExit("POUS.c sem include reconhecível")
text = text[:include_end + 1] + prototype + text[include_end + 1:]

result = []
points = set()
routine_files = {
    routine["file"]: index + 1
    for index, routine in enumerate(json.loads((BUILD / "source_map.json").read_text(encoding="utf-8"))["routines"])
    if routine["file"].startswith("routines/")
}
instrumented_routines = set()
pattern = re.compile(r'^#line\s+(\d+)\s+"[^"]*project\.st"')
for line in text.splitlines():
    result.append(line)
    match = pattern.match(line)
    if not match:
        continue
    project_line = int(match.group(1))
    mapped = SOURCE_MAP.get(str(project_line))
    if mapped and mapped.get("kind") in {"functions", "blocks", "programs", "routines"}:
        routine_id = routine_files.get(mapped.get("file"))
        if routine_id and routine_id not in instrumented_routines:
            result.append(f"  plc_debug_routine({routine_id}U, {project_line}U);")
            instrumented_routines.add(routine_id)
        result.append(f"  plc_debug_point({project_line}U);")
        points.add(project_line)

target.write_text("\n".join(result) + "\n", encoding="utf-8")
(BUILD / "debug_points.json").write_text(json.dumps(sorted(points)), encoding="utf-8")
print(f"Instrumentação online: {len(points)} pontos ST e {len(instrumented_routines)} rotinas em {target}")
