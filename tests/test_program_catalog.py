#!/usr/bin/env python3
"""PROGRAM local variables in the simulator catalog.

A project imported from CODESYS keeps operating switches in program local
variables (e.g. a simulation-mode toggle). Without them in the catalog, the
panel and the debugger can neither read nor write them.

Needs STruC++ in ~/.local/strucpp; without it the tests are skipped. The test
that starts the compiled runtime only runs with HPLC_RUNTIME_TESTS=1.

    python3 tests/test_program_catalog.py
"""
from pathlib import Path
from urllib.request import urlopen
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[1]
TEMPLATE_RUNTIME = REPO / "template" / "plc-project" / "runtime"
STRUCPP = Path(os.environ.get("STRUCPP", Path.home() / ".local" / "strucpp"))
RUNTIME_TESTS = os.environ.get("HPLC_RUNTIME_TESTS") == "1"

MAIN = """PROGRAM Main
VAR
    Cycles : INT;
END_VAR
Cycles := Cycles + 1;
Helper();
END_PROGRAM
"""
HELPER = """PROGRAM Helper
VAR
    Enable : BOOL;
    Delay : TON := (PT := T#1s);
END_VAR
VAR_OUTPUT
    Enabled : BOOL;
END_VAR
Delay(IN := Enable);
Enabled := Enable;
G_Count := G_Count + 1;
END_PROGRAM
"""
GVL = "VAR_GLOBAL\n    G_Count : DINT;\nEND_VAR\n"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless((STRUCPP / "strucpp").exists(), "STruC++ not installed")
class ProgramLocals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp())
        shutil.copytree(TEMPLATE_RUNTIME, cls.folder / "runtime", ignore=shutil.ignore_patterns("__pycache__"))
        (cls.folder / "panel").mkdir()
        for name in ("programs", "globals"):
            (cls.folder / name).mkdir()
        (cls.folder / "programs" / "01_Main.st").write_text(MAIN, encoding="utf-8")
        (cls.folder / "programs" / "02_Helper.st").write_text(HELPER, encoding="utf-8")
        (cls.folder / "globals" / "00_GVL.st").write_text(GVL, encoding="utf-8")
        cls.port = free_port()
        (cls.folder / "plc.toml").write_text(
            f'name = "Test"\npanel_port = {cls.port}\npid_port = {cls.port + 1}\n'
            'source_directories = ["programs", "globals"]\n\n'
            '[[task]]\nname = "T"\ninterval_ms = 10\nprogram = "Main"\n', encoding="utf-8")
        build = subprocess.run(["bash", str(cls.folder / "runtime" / "build.sh")],
                               capture_output=True, text=True)
        if build.returncode:
            raise AssertionError(build.stdout + build.stderr)
        catalog = json.loads((cls.folder / ".plcsim" / "build" / "variables.json").read_text(encoding="utf-8"))
        cls.paths = {v["path"] for v in catalog["variables"]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def test_locals_of_the_task_program_and_of_the_called_one(self):
        for path in ("Main.Cycles", "Helper.Enable", "Helper.Enabled", "Helper.Delay.ET", "G_Count"):
            self.assertIn(path, self.paths)

    def test_instance_of_the_called_program_is_not_listed_as_local(self):
        self.assertFalse(any(c.upper().startswith("MAIN.FB_") for c in self.paths))

    def test_generated_panel_uses_project_tags(self):
        panel = json.loads((self.folder / "panel" / "panel.json").read_text(encoding="utf-8"))
        tags = {item["tag"] for area in panel["areas"].values() for item in area}
        self.assertTrue(tags and tags <= self.paths, tags)

    @unittest.skipUnless(RUNTIME_TESTS, "starts the PLC runtime; set HPLC_RUNTIME_TESTS=1")
    def test_writing_a_program_local_changes_the_logic(self):
        env = {**os.environ, "HPLC_SKIP_BUILD": "1", "HPLC_PORT": str(self.port)}
        process = subprocess.Popen(["bash", str(self.folder / "runtime" / "run.sh")], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f"http://127.0.0.1:{self.port}"
        try:
            for _ in range(50):
                try:
                    urlopen(f"{base}/api/state", timeout=1)
                    break
                except OSError:
                    time.sleep(0.1)
            urlopen(f"{base}/api/set?tag=Helper.Enable&val=1", timeout=2).read()
            time.sleep(0.2)
            values = {v["path"]: v["value"] for v in
                      json.loads(urlopen(f"{base}/api/variables", timeout=2).read())["variables"]}
            self.assertTrue(values["Helper.Enabled"])
            self.assertGreater(values["Main.Cycles"], 0)
        finally:
            subprocess.run(["bash", str(self.folder / "runtime" / "stop.sh")], capture_output=True)
            process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
