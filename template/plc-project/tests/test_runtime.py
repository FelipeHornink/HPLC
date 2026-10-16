#!/usr/bin/env python3
"""End-to-end runtime test on a synthetic project (starts the PLC runtime).

Self-contained: copies this project's runtime/ into a temporary project with a
tiny English program (Main + two routines), builds it, starts it on free ports
and drives the HTTP API: live state, pause, single scan, line and routine
stepping, writing and forcing tags, panel configuration.

    python3 tests/test_runtime.py
"""
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent

MAIN = """PROGRAM Main
VAR
    Counter : INT;
    Enable : BOOL;
    Output : BOOL;
END_VAR
(* @ROUTINE 01_Count.st *)
(* @ROUTINE 02_Outputs.st *)
END_PROGRAM
"""
ROUTINE_COUNT = """IF Enable THEN
    Counter := Counter + 1;
END_IF;
G_Scans := G_Scans + 1;
"""
ROUTINE_OUTPUTS = """Output := Enable AND (Counter > 0);
G_Level := G_Level + 0.5;
"""
GLOBALS = "VAR_GLOBAL\n    G_Scans : DINT;\n    G_Level : REAL;\n    G_Run : BOOL;\nEND_VAR\n"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    folder = Path(tempfile.mkdtemp())
    project = folder / "project"
    shutil.copytree(ROOT / "runtime", project / "runtime", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "panel", project / "panel")
    for name, files in (("programs", {"Main.st": MAIN}), ("globals", {"00_Globals.st": GLOBALS}),
                        ("routines", {"01_Count.st": ROUTINE_COUNT, "02_Outputs.st": ROUTINE_OUTPUTS})):
        (project / name).mkdir()
        for file_name, text in files.items():
            (project / name / file_name).write_text(text, encoding="utf-8")
    for legacy in ("panel.json", "painel.json", "pid.json"):
        (project / "panel" / legacy).unlink(missing_ok=True)
    port, pid_port = free_port(), free_port()
    (project / "plc.toml").write_text(
        f'name = "Runtime test"\npanel_port = {port}\npid_port = {pid_port}\n'
        'source_directories = ["globals", "programs", "routines"]\n\n'
        '[[task]]\nname = "MainTask"\ninterval_ms = 10\nprogram = "Main"\n', encoding="utf-8")
    env = {**os.environ, "HPLC_PORT": str(port), "HPLC_PID_PORT": str(pid_port)}
    process = subprocess.Popen(["bash", str(project / "runtime" / "run.sh")], cwd=project, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://127.0.0.1:{port}"

    def get(path, url=base):
        return json.loads(urlopen(url + path, timeout=2).read())

    def set_value(tag, value):
        return get(f"/api/set?tag={quote(tag)}&val={quote(str(value))}")

    def values():
        return {v["path"]: v for v in get("/api/variables")["variables"]}

    try:
        # The first build includes C++ generation and compilation; slow machines need time.
        for _ in range(600):
            if process.poll() is not None:
                raise AssertionError("runtime exited:\n" + process.stdout.read())
            try:
                get("/api/state")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise AssertionError("runtime did not start")
        assert get("/api/state")["running"] is True
        paused_scan = get("/api/control?action=pause")["scan"]
        time.sleep(0.04)
        assert get("/api/debug")["scan"] == paused_scan
        get("/api/control?action=scan")
        time.sleep(0.04)
        assert get("/api/debug")["scan"] == paused_scan + 1
        get("/api/control?action=step_line")
        time.sleep(0.04)
        first_line = get("/api/debug")
        assert first_line["waiting_line"] and first_line["current_line"] > 0, first_line
        get("/api/control?action=step_line")
        time.sleep(0.03)
        assert get("/api/debug")["current_line"] != first_line["current_line"]
        get("/api/control?action=pause")
        time.sleep(0.03)
        get("/api/control?action=step_routine")
        time.sleep(0.03)
        first_routine = get("/api/debug")
        assert first_routine["waiting_routine"] and first_routine["current_routine"] > 0, first_routine
        get("/api/control?action=step_routine")
        time.sleep(0.03)
        second_routine = get("/api/debug")
        assert second_routine["current_routine"] != first_routine["current_routine"], second_routine
        get("/api/control?action=run")
        time.sleep(0.1)

        assert set_value("Main.Enable", 1)["ok"]
        time.sleep(0.2)
        current = values()
        assert current["Main.Counter"]["value"] > 0, current["Main.Counter"]
        assert current["Main.Output"]["value"] is True
        assert current["G_Scans"]["value"] > 0
        get("/api/control?action=pause")
        assert set_value("G_Level", 7.25)["ok"]
        assert values()["G_Level"]["value"] == 7.25
        get("/api/control?action=run")

        assert get(f"/api/force?tag={quote('G_Run')}&val=1&enabled=1")["ok"]
        time.sleep(0.05)
        forced = values()["G_Run"]
        assert forced["value"] is True and forced["forced"] is True, forced
        assert get(f"/api/force?tag={quote('G_Run')}&val=0&enabled=0")["ok"]

        panel = get("/api/panel-config")
        assert {"monitoring", "ihm", "panel", "interface", "field"} <= set(panel["areas"]), panel
        tags = {item["tag"] for area in panel["areas"].values() for item in area}
        assert tags <= set(values()), tags
        assert (project / "panel" / "panel.json").is_file()
        assert isinstance(get("/api/pid-config", f"http://127.0.0.1:{pid_port}")["items"], list)
        assert get("/api/views") == {"panel": port, "pid": pid_port}

        source_map = json.loads((project / ".plcsim" / "build" / "source_map.json").read_text(encoding="utf-8"))
        routine_files = [r for r in source_map["routines"] if r["file"].startswith("routines/")]
        assert len(routine_files) == 2, routine_files
        print(f"OK: live state, pause, scan, line and routine stepping, write, force; {len(values())} variables")
    finally:
        subprocess.run(["bash", str(project / "runtime" / "stop.sh")], cwd=project, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    main()
