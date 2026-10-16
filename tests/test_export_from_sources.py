#!/usr/bin/env python3
"""Export of a project that was not imported from XML (built from its own sources).

    python3 tests/test_export_from_sources.py
"""
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "template" / "plc-project" / "runtime"


class ExportFromSources(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.project = Path(self._tmp.name) / "proj"
        for folder in ("programs", "globals", "blocks", "types", "functions", "routines"):
            (self.project / folder).mkdir(parents=True)
        (self.project / "plc.toml").write_text('name = "Tank Demo"\n[[task]]\nname = "MainTask"\ninterval_ms = 10\nprogram = "Main"\n')
        (self.project / "globals" / "30_GVL_Simulation.st").write_text("VAR_GLOBAL\n    SimEnable : BOOL;\nEND_VAR\n")
        (self.project / "programs" / "Main.st").write_text("PROGRAM Main\nIF SimEnable THEN\n    SimEnable := FALSE;\nEND_IF;\nEND_PROGRAM\n")

    def tearDown(self):
        self._tmp.cleanup()

    def export(self):
        out = self.project / "export" / "test"
        r = subprocess.run([sys.executable, str(RUNTIME / "export_plcopenxml.py")], capture_output=True, text=True,
                           cwd=self.project, env={**os.environ, "HPLC_PROJECT_ROOT": str(self.project),
                                                  "HPLC_EXPORT_MODE": "logic", "HPLC_EXPORT_DIR": str(out)})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return out

    def test_gvl_names_are_iec_identifiers(self):
        xml = next(self.export().glob("*_Application.xml")).read_text(encoding="utf-8")
        names = re.findall(r'<globalVars name="([^"]+)"', xml)
        self.assertEqual(names, ["GVL_Simulation"])

    def test_file_is_named_after_the_project(self):
        out = self.export()
        self.assertTrue((out / "Tank_Demo_Application.xml").exists(), sorted(p.name for p in out.iterdir()))

    def test_exported_xml_imports_again(self):
        xml = next(self.export().glob("*_Application.xml"))
        target = Path(self._tmp.name) / "reimport"
        r = subprocess.run([sys.executable, str(RUNTIME / "import_plcopenxml.py"), str(xml), str(target), "--active"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(list((target / "globals").glob("*GVL_Simulation.st")))


if __name__ == "__main__":
    unittest.main()
