#!/usr/bin/env python3
"""Initial panel and P&ID screens from the variable catalog.

An imported project starts with empty screens, and mapping hundreds of tags by
hand does not scale. This generator builds a generic starting configuration
from the catalog alone (no project naming conventions):

  monitoring  top-level numeric globals, read-only
  hmi         top-level BOOL globals, as switches
  field       members of structures and arrays (BOOL as switches, numbers as values)

It is only a starting point; fine tuning stays manual. It writes a screen only
when the current one does not point to any tag of this project, so a user's
adjustment is never overwritten (use --force to regenerate).
"""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import msg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / ".plcsim" / "build" / "variables.json"
# panel/panel.json is the current name; panel/painel.json is the legacy one.
# An existing project keeps writing to whichever file it already has.
PANEL = ROOT / "panel" / "panel.json"
LEGACY_PANEL = ROOT / "panel" / "painel.json"
if not PANEL.is_file() and LEGACY_PANEL.is_file():
    PANEL = LEGACY_PANEL
PID = ROOT / "panel" / "pid.json"

MONITORING_LIMIT = 16
IHM_LIMIT = 32
FIELD_LIMIT = 32
PID_POSITIONS = [(8, 12), (8, 30), (8, 72), (21, 30), (21, 78), (43, 12), (43, 82), (57, 22), (57, 82),
                 (67, 12), (67, 82), (79, 8), (92, 20), (92, 33), (92, 66), (92, 79)]

if not CATALOG.is_file():
    raise SystemExit(msg("panel_need_build"))
variables = {item["path"]: item for item in json.loads(CATALOG.read_text(encoding="utf-8"))["variables"]}


def label_of(tag):
    name = tag.rsplit(".", 1)[-1]
    return name.replace("_", " ").strip() or tag


def item(tag, kind, **extra):
    entry = {"tag": tag, "label": label_of(tag), "kind": kind, "writable": kind != "lamp"}
    entry.update(extra)
    return entry


def already_configured(path, key):
    """A valid configuration is one that points to tags of this project.

    Checking only whether the file has items would skip exactly the case where
    the generator is needed (a screen copied from another project, full of tags
    that do not exist here).
    """
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return False
    if key == "areas":
        tags = [i.get("tag") for area in data.get("areas", {}).values() for i in area]
    else:
        tags = [i.get("tag") for i in data.get("items", [])]
    return bool(tags) and any(tag in variables for tag in tags)


force = "--force" in sys.argv
write_panel = force or not already_configured(PANEL, "areas")
write_pid = force or not already_configured(PID, "items")
if not write_panel and not write_pid:
    print("Screens already point to tags of this project; nothing to generate.")
    raise SystemExit(0)

top_level = [t for t in sorted(variables) if "." not in t and "[" not in t]
nested = [t for t in sorted(variables) if t not in set(top_level)]
numeric = {"integer", "real", "time"}

monitoring = [item(t, "number", writable=False, ioType="INTERNAL",
                   **({"precision": 2} if variables[t]["kind"] == "real" else {}),
                   **({"unit": "ms"} if variables[t]["kind"] == "time" else {}))
              for t in top_level if variables[t]["kind"] in numeric][:MONITORING_LIMIT]
hmi = [{**item(t, "toggle", ioType="IHM"), "tab": "Commands"}
       for t in top_level if variables[t]["kind"] == "bool"][:IHM_LIMIT]
field = [item(t, "toggle", ioType="VAR") if variables[t]["kind"] == "bool"
         else item(t, "number", ioType="VAR", **({"precision": 2} if variables[t]["kind"] == "real" else {}))
         for t in nested if variables[t]["kind"] in numeric | {"bool"}][:FIELD_LIMIT]

name = ROOT.name
PANEL.parent.mkdir(parents=True, exist_ok=True)
if write_panel:
    PANEL.write_text(json.dumps({
        "version": 1, "title": msg("panel_title", name=name),
        "display": {"realPrecision": 2, "theme": "light"},
        "areas": {"monitoring": monitoring, "hmi": hmi, "panel": [], "interface": [], "field": field, "communication": []},
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

candidates = [entry["tag"] for entry in (*monitoring, *hmi, *field)]
items = [{"tag": tag, "label": label_of(tag), "x": x, "y": y}
         for (x, y), tag in zip(PID_POSITIONS, candidates)]
if write_pid:
    PID.write_text(json.dumps({
        "version": 1, "title": msg("pid_title", name=name),
        "display": {"realPrecision": 2, "theme": "light"},
        "items": items, "animation": {},
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
total = sum(len(v) for v in json.loads(PANEL.read_text(encoding="utf-8"))["areas"].values()) if PANEL.is_file() else 0
print(f"Initial screens: {total} items in the panel and {len(items) if write_pid else 0} in the P&ID.")
