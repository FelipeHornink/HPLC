#!/usr/bin/env python3
"""Tests of the round-trip export back into the manufacturer's original project.

Synthetic XML in the format MasterTool IEC XE writes: BOM, structure in CRLF,
ST bodies in LF, POUs inside addData, list attributes in addData, GUIDs and
Ladder. No customer XML: the repository may be public.

    python3 tests/test_export_roundtrip.py
"""
from pathlib import Path
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
RUNTIME = REPO / "template" / "plc-project" / "runtime"
XHTML = '<xhtml xmlns="http://www.w3.org/1999/xhtml">'
POU_DATA = '<data name="http://www.3s-software.com/plcopenxml/pou" handleUnknown="implementation">'
LADDER_HEADER = "(* Converted automatically from LD/FBD to ST. *)"
LEGACY_LADDER_HEADER = "(* Convertido automaticamente de LD/FBD para ST. *)"

MAIN_BODY = """// Routine calls
Inst();
Rungs();
IF isFirstCycle THEN
\tisFirstCycle := FALSE;
END_IF"""

# Line with trailing whitespace and a comment with a flattened name (GVL_Run):
# both must come back byte for byte, even when the POU changes on another line.
MACHINE_BODY = """IF GVL.Run THEN   \t
\tCounter := Counter + 1; // old: GVL_Run &amp; counter
END_IF
TimeInState(IN := GVL.Run);
IF Counter &gt; 10 THEN
\tCounter := 0;
END_IF
"""


def variable(name, type_, ind, initial="", extra=""):
    lines = [f'{ind}<variable name="{name}">', f"{ind}  <type>", f"{ind}    {type_}", f"{ind}  </type>"]
    if initial:
        lines += [f"{ind}  <initialValue>", *(f"{ind}    {x}" for x in initial.split("\n")), f"{ind}  </initialValue>"]
    if extra:
        lines += [f"{ind}  {x}" for x in extra.split("\n")]
    lines.append(f"{ind}</variable>")
    return "\n".join(lines)


def attribute(name, value, ind):
    return "\n".join([
        f"{ind}<addData>",
        f'{ind}  <data name="http://www.3s-software.com/plcopenxml/attributes" handleUnknown="implementation">',
        f"{ind}    <Attributes>",
        f'{ind}      <Attribute Name="{name}" Value="{value}" />',
        f"{ind}    </Attributes>",
        f"{ind}  </data>",
        f"{ind}</addData>"])


def object_id(guid, ind):
    return "\n".join([
        f"{ind}<addData>",
        f'{ind}  <data name="http://www.3s-software.com/plcopenxml/objectid" handleUnknown="discard">',
        f"{ind}    <ObjectId>{guid}</ObjectId>",
        f"{ind}  </data>",
        f"{ind}</addData>"])


def st_pou(name, kind, interface, body_id, guid):
    i = " " * 14
    return "\n".join([
        f"{i[:-2]}{POU_DATA}",
        f'{i}<pou name="{name}" pouType="{kind}">',
        f"{i}  <interface>", interface, f"{i}  </interface>",
        f"{i}  <body>", f"{i}    <ST>", f"{i}      {XHTML}@@{body_id}@@</xhtml>", f"{i}    </ST>", f"{i}  </body>",
        object_id(guid, i + "  "),
        f"{i}</pou>", f"{i[:-2]}</data>"])


def manufacturer_xml(bodies=None, ladder_output="Output", extra_gvl=""):
    bodies = {"MAIN": MAIN_BODY, "MACHINE": MACHINE_BODY, **(bodies or {})}
    i = " " * 20
    machine = "\n".join([
        f"{i[:-2]}<localVars>",
        variable("TimeInState", '<derived name="TON" />', i,
                 '<structValue>\n  <value member="PT">\n    <simpleValue value="TIME#10m0s0ms" />\n  </value>\n</structValue>'),
        variable("Counter", "<INT />", i, '<simpleValue value="0" />'),
        f"{i[:-2]}</localVars>"])
    main = "\n".join([
        f"{i[:-2]}<localVars>",
        variable("isFirstCycle", "<BOOL />", i, '<simpleValue value="TRUE" />'),
        variable("Inst", '<derived name="Machine" />', i),
        f"{i[:-2]}</localVars>"])
    special = "\n".join([
        f"{i[:-2]}<localVars>",
        variable("Pulse", "<BOOL />", i),
        f"{i[:-2]}</localVars>",
        attribute("hide", "", i[:-2])])
    rungs = "\n".join([
        f"{' ' * 12}{POU_DATA}",
        f'{" " * 14}<pou name="Rungs" pouType="program">',
        f"{' ' * 16}<interface>",
        f"{i[:-2]}<localVars>", variable("Output", "<BOOL />", i), f"{i[:-2]}</localVars>",
        f"{' ' * 16}</interface>",
        f"{' ' * 16}<body>",
        f"{' ' * 18}<LD>",
        f'{i}<leftPowerRail localId="0">',
        f'{i}  <position x="0" y="0" />',
        f'{i}  <connectionPointOut formalParameter="none" />',
        f"{i}</leftPowerRail>",
        f'{i}<contact localId="1" negated="false" storage="none" edge="none">',
        f'{i}  <position x="0" y="0" />',
        f"{i}  <connectionPointIn>",
        f'{i}    <connection refLocalId="0" />',
        f"{i}  </connectionPointIn>",
        f"{i}  <connectionPointOut />",
        f"{i}  <variable>GVL.Run</variable>",
        f"{i}</contact>",
        f'{i}<coil localId="2" negated="false" storage="none" edge="none">',
        f'{i}  <position x="0" y="0" />',
        f"{i}  <connectionPointIn>",
        f'{i}    <connection refLocalId="1" />',
        f"{i}  </connectionPointIn>",
        f"{i}  <connectionPointOut />",
        f"{i}  <variable>{ladder_output}</variable>",
        f"{i}</coil>",
        f"{' ' * 18}</LD>",
        f"{' ' * 16}</body>",
        object_id("33333333-3333-3333-3333-333333333333", " " * 16),
        f'{" " * 14}</pou>',
        f"{' ' * 12}</data>"])
    g = " " * 12
    structure = "\n".join([
        '<?xml version="1.0" encoding="utf-8"?>',
        '<project xmlns="http://www.plcopen.org/xml/tc6_0200">',
        '  <fileHeader companyName="" productName="MasterTool IEC XE" productVersion="MasterTool IEC XE 3.78" creationDateTime="2026-01-01T00:00:00.0000000" />',
        '  <contentHeader name="Synthetic.project" modificationDateTime="2026-01-01T00:00:00.0000000">',
        "    <coordinateInfo>",
        "      <fbd>", '        <scaling x="1" y="1" />', "      </fbd>",
        "      <ld>", '        <scaling x="1" y="1" />', "      </ld>",
        "      <sfc>", '        <scaling x="1" y="1" />', "      </sfc>",
        "    </coordinateInfo>",
        "  </contentHeader>",
        "  <types>", "    <dataTypes />", "    <pous />", "  </types>",
        "  <instances>", "    <configurations>",
        '      <configuration name="Device">',
        '        <resource name="Application">',
        '          <task name="MainTask" interval="PT0.02S" priority="13">',
        '            <pouInstance name="MainPrg" typeName="">',
        "              <documentation>", f'                {XHTML[:-1]} />', "              </documentation>",
        "            </pouInstance>",
        "          </task>",
        '          <globalVars name="GVL">',
        variable("Run", "<BOOL />", g),
        variable("Speed", "<INT />", g, '<simpleValue value="0" />'),
        *([extra_gvl] if extra_gvl else []),
        attribute("qualified_only", "", g),
        "          </globalVars>",
        '          <globalVars name="Setpoint" retain="true" persistent="true">',
        variable("StartTime", "<TIME />", g, '<simpleValue value="TIME#5s" />',
                 attribute("order_in_persistent_editor", "1", "") + "\n<documentation>\n"
                 f"  {XHTML} Line 1@@CR@@\n Line 2</xhtml>\n</documentation>"),
        "          </globalVars>",
        "          <addData>",
        st_pou("MainPrg", "program", main, "MAIN", "11111111-1111-1111-1111-111111111111"),
        st_pou("Machine", "functionBlock", machine, "MACHINE", "22222222-2222-2222-2222-222222222222"),
        rungs,
        st_pou("SpecialVariablesPrg", "program", special, "EMPTY", "44444444-4444-4444-4444-444444444444"),
        "          </addData>",
        "        </resource>",
        "      </configuration>",
        "    </configurations>",
        "  </instances>",
        "  <addData>",
        '    <data name="http://www.3s-software.com/plcopenxml/projectstructure" handleUnknown="discard">',
        "      <ProjectStructure>",
        '        <Object Name="MainPrg" ObjectId="11111111-1111-1111-1111-111111111111" />',
        "      </ProjectStructure>",
        "    </data>",
        "  </addData>",
        "</project>",
        ""])
    text = structure.replace("\n", "\r\n")
    for key, body in {**bodies, "EMPTY": "", "CR": "\r"}.items():
        text = text.replace(f"@@{key}@@", body)
    return "﻿".encode() + text.encode("utf-8")


class Project:
    """Extension project created by importing a manufacturer XML."""

    def __init__(self, xml):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self._tmp.name)
        self.root = self.folder / "project"
        (self.root / "runtime").mkdir(parents=True)
        for name in ("import_plcopenxml.py", "export_plcopenxml.py", "export_roundtrip.py",
                     "verify_export.py", "source_names.py", "messages.py"):
            if (RUNTIME / name).exists():
                shutil.copy2(RUNTIME / name, self.root / "runtime" / name)
        source = self.folder / "Imports" / "Synthetic_v1.xml"
        source.parent.mkdir()
        source.write_bytes(xml)
        subprocess.run([sys.executable, str(self.root / "runtime" / "import_plcopenxml.py"),
                        str(source), str(self.root), "--active"], check=True, capture_output=True, text=True)

    def source(self, name):
        return next(p for p in self.root.rglob(f"*_{name}.st") if "export" not in p.parts)

    def edit(self, name, before, after):
        path = self.source(name)
        text = path.read_text(encoding="utf-8")
        assert before in text, (before, text)
        path.write_text(text.replace(before, after, 1), encoding="utf-8")

    def base(self, xml, name="Synthetic_v2.xml"):
        path = self.folder / "Imports" / name
        path.write_bytes(xml)
        return path

    def export(self, *args, ok=True, env=None, script=None):
        r = subprocess.run([sys.executable, str(script or self.root / "runtime" / "export_plcopenxml.py"),
                            *map(str, args)],
                           capture_output=True, text=True, cwd=self.root, env={**os.environ, **(env or {})})
        if ok and r.returncode != 0:
            raise AssertionError(f"export failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
        return r

    def output(self):
        """Most recent export subfolder (export/YYYY-MM-DD_HHMMSS_<mode>)."""
        folders = sorted((p for p in (self.root / "export").iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime_ns)
        return folders[-1]

    def full(self):
        return next(self.output().glob("*_Full.xml")).read_bytes()

    def application(self):
        return next(self.output().glob("*_Application.xml")).read_text(encoding="utf-8-sig")

    def report(self):
        return json.loads((self.output() / "EXPORT_REPORT.json").read_text(encoding="utf-8"))

    def close(self):
        self._tmp.cleanup()


def pou_text(xml_bytes, name):
    text = xml_bytes.decode("utf-8-sig")
    start = text.index(f'<pou name="{name}" ')
    return text[start:text.index("</pou>", start)]


def xml_body(xml_bytes, name):
    pou = pou_text(xml_bytes, name)
    start = pou.index(XHTML, pou.index("<body>")) + len(XHTML)
    return pou[start:pou.index("</xhtml>", start)]


def without_pou(xml_bytes, *names):
    text = xml_bytes.decode("utf-8-sig")
    for name in names:
        text = text.replace(pou_text(xml_bytes, name), f"<<{name}>>")
    return text


class Case(unittest.TestCase):
    xml = None

    def setUp(self):
        self.original = self.xml or manufacturer_xml()
        self.p = Project(self.original)
        self.addCleanup(self.p.close)


class Unchanged(Case):
    def test_full_is_byte_identical(self):
        self.p.export()
        self.assertEqual(self.p.full(), self.original)
        report = self.p.report()
        self.assertEqual(report["changed_pous"], [])
        self.assertTrue(report["verification"]["ok"], report["verification"])

    def test_report_keys(self):
        self.p.export()
        report = self.p.report()
        self.assertEqual(set(report), {"base", "ancestor", "date", "changed_pous", "declarations",
                                       "ladder_converted", "newer_in_base", "convergent", "conflicts",
                                       "warnings", "verification"})
        v = report["verification"]
        self.assertEqual(set(v), {"structural", "reimport", "format", "ok"})
        self.assertEqual(set(v["structural"]), {"ok", "problems", "summary"})
        self.assertEqual(set(v["reimport"]), {"ok", "differences"})
        self.assertEqual(set(v["format"]), {"ok", "problems"})
        self.assertTrue((self.p.output() / "EXPORT_REPORT.md").exists())


class LegacyGeneratedMarkers(Case):
    """Projects imported by the old Portuguese importer must not look changed."""

    def test_legacy_ladder_header_is_not_a_change(self):
        self.p.edit("Rungs", LADDER_HEADER, LEGACY_LADDER_HEADER)
        self.p.export()
        self.assertEqual(self.p.report()["changed_pous"], [])
        self.assertEqual(self.p.full(), self.original)

    def test_legacy_header_with_real_change_still_converts(self):
        self.p.edit("Rungs", LADDER_HEADER, LEGACY_LADDER_HEADER)
        self.p.edit("Rungs", "Output := GVL.Run;", "Output := NOT GVL.Run;")
        self.p.export()
        report = self.p.report()
        self.assertEqual(report["ladder_converted"], ["Rungs"])
        self.assertTrue(report["verification"]["ok"], report["verification"])

    def test_legacy_markers_are_recognized(self):
        spec = importlib.util.spec_from_file_location("export_roundtrip", RUNTIME / "export_roundtrip.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for marker in ("Created by the LD -> ST conversion", "Criadas na conversao LD -> ST"):
            source = module.read_source(f"PROGRAM P\nVAR\n    A : BOOL;\nEND_VAR\nVAR\n    (* {marker}: x *)\n"
                                        "    LD_P_1 : R_TRIG;\nEND_VAR\n\nA := TRUE;\nEND_PROGRAM\n")
            self.assertEqual([b.ld_helper for b in source.blocks], [False, True], marker)
        for line in ("(* WARNING: POU originally in Ladder (LD), exported ... *)",
                     "(* ATENCAO: POU originalmente em Ladder (LD), exportada ... *)"):
            source = module.read_source(f"PROGRAM P\n\n{line}\nA := TRUE;\nEND_PROGRAM\n")
            self.assertEqual(module.normalize_for_verification(source, True)[2], ("A := TRUE;",))
        self.assertEqual(module.canonical_body_line("(* P: diagrama original sem logica executavel. *)"),
                         "(* P: original diagram has no executable logic. *)")


class BodyChanged(Case):
    def test_only_the_changed_pou_changes_and_the_rest_stays_byte_for_byte(self):
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 1; // resets GVL_Run")
        self.p.export()
        generated = self.p.full()
        self.assertEqual(without_pou(generated, "Machine"), without_pou(self.original, "Machine"))
        body = xml_body(generated, "Machine")
        expected = MACHINE_BODY.replace("\tCounter := 0;", "\tCounter := 1; // resets GVL_Run")
        self.assertEqual(body, expected)
        self.assertTrue(generated.startswith("﻿".encode()))
        report = self.p.report()
        self.assertEqual([x["name"] for x in report["changed_pous"]], ["Machine"])
        self.assertTrue(report["verification"]["ok"], report["verification"])

    def test_comment_with_flattened_name_is_not_rewritten(self):
        self.p.edit("Machine", "Counter := Counter + 1;", "Counter := Counter + 2;")
        self.p.export()
        body = xml_body(self.p.full(), "Machine")
        self.assertIn("// old: GVL_Run &amp; counter", body)
        self.assertIn("IF GVL.Run THEN   \t\n", body)
        self.assertNotIn("GVL.Run &amp; counter", body)


class Declarations(Case):
    def test_new_variable_in_manufacturer_format(self):
        self.p.edit("Machine", "    Counter : INT := 0;\n",
                    "    Counter : INT := 0;\n    MinTime : TIME := TIME#5s0ms; (* Minimum time; adjustable *)\n")
        self.p.edit("Machine", "IF Counter > 10 THEN", "IF Counter > 10 AND TimeInState.ET > MinTime THEN")
        self.p.export()
        pou = pou_text(self.p.full(), "Machine")
        ind = " " * 20
        expected = "\r\n".join([
            f'{ind}<variable name="Counter">', f"{ind}  <type>", f"{ind}    <INT />", f"{ind}  </type>",
            f"{ind}  <initialValue>", f'{ind}    <simpleValue value="0" />', f"{ind}  </initialValue>",
            f"{ind}</variable>",
            f'{ind}<variable name="MinTime">', f"{ind}  <type>", f"{ind}    <TIME />", f"{ind}  </type>",
            f"{ind}  <initialValue>", f'{ind}    <simpleValue value="TIME#5s0ms" />', f"{ind}  </initialValue>",
            f"{ind}  <documentation>", f"{ind}    {XHTML} Minimum time; adjustable </xhtml>",
            f"{ind}  </documentation>", f"{ind}</variable>", f"{ind[:-2]}</localVars>"])
        self.assertIn(expected, pou)
        report = self.p.report()
        self.assertIn({"pou": "Machine", "variable": "MinTime", "action": "added"},
                      [{k: d[k] for k in ("pou", "variable", "action")} for d in report["declarations"]])
        self.assertTrue(report["verification"]["ok"], report["verification"])

    def test_simple_and_struct_initial_values(self):
        self.p.edit("Machine", "Counter : INT := 0;", "Counter : INT := 5;")
        self.p.edit("Machine", "(PT := TIME#10m0s0ms)", "(PT := TIME#2m0s0ms)")
        self.p.export()
        pou = pou_text(self.p.full(), "Machine")
        self.assertIn('<simpleValue value="5" />', pou)
        self.assertIn('<simpleValue value="TIME#2m0s0ms" />', pou)
        self.assertNotIn("TIME#10m0s0ms", pou)
        self.assertEqual(without_pou(self.p.full(), "Machine"), without_pou(self.original, "Machine"))
        changed = [d for d in self.p.report()["declarations"] if d["action"] == "changed"]
        self.assertTrue(any("initial value" in d["detail"] for d in changed), changed)

    def test_changed_type(self):
        self.p.edit("Machine", "Counter : INT := 0;", "Counter : DINT := 0;")
        self.p.export()
        self.assertIn("<DINT />", pou_text(self.p.full(), "Machine"))

    def test_removed_variable(self):
        self.p.edit("MainPrg", "    Inst : Machine;\n", "")
        self.p.edit("MainPrg", "Inst();\n", "")
        self.p.export()
        pou = pou_text(self.p.full(), "MainPrg")
        self.assertNotIn('name="Inst"', pou)
        self.assertIn('<variable name="isFirstCycle">', pou)
        self.assertNotIn("\r\n\r\n", pou)

    def test_new_gvl_variable_keeps_attributes(self):
        self.p.edit("GVL", "    Speed : INT := 0;\n", "    Speed : INT := 0;\n    Fresh : BOOL;\n")
        self.p.export()
        text = self.p.full().decode("utf-8-sig")
        g = " " * 12
        self.assertIn(f'{g}<variable name="Fresh">\r\n{g}  <type>\r\n{g}    <BOOL />\r\n{g}  </type>\r\n'
                      f'{g}</variable>\r\n{g}<addData>', text)
        self.assertIn('<Attribute Name="qualified_only" Value="" />', text)

    def test_qualifier_creates_retain_section(self):
        self.p.edit("Machine", "END_VAR\n", "END_VAR\nVAR RETAIN\n    Starts : UDINT;\nEND_VAR\n")
        self.p.export()
        pou = pou_text(self.p.full(), "Machine")
        self.assertRegex(pou, r'</localVars>\r\n {18}<localVars retain="true">\r\n {20}<variable name="Starts">')


class SelectableBase(Case):
    def test_newer_base_keeps_what_changed_at_the_manufacturer(self):
        new_main = MAIN_BODY.replace("// Routine calls", "// Routine calls (revised in the IDE)")
        base = self.p.base(manufacturer_xml({"MAIN": new_main}))
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 2;")
        self.p.export("--base", base)
        generated = self.p.full()
        self.assertIn("(revised in the IDE)", xml_body(generated, "MainPrg"))
        self.assertIn("Counter := 2;", xml_body(generated, "Machine"))
        report = self.p.report()
        self.assertEqual(report["base"], str(base))
        self.assertIn("MainPrg", report["newer_in_base"])

    def test_same_change_on_both_sides_is_not_a_conflict(self):
        new = MACHINE_BODY.replace("\tCounter := 0;", "\tCounter := 3;")
        base = self.p.base(manufacturer_xml({"MACHINE": new}))
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 3;")
        self.p.export("--base", base)
        self.assertEqual(self.p.full(), base.read_bytes())

    def test_conflict_aborts_without_writing(self):
        base = self.p.base(manufacturer_xml({"MACHINE": MACHINE_BODY.replace("\tCounter := 0;", "\tCounter := 9;")}))
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 2;")
        r = self.p.export("--base", base, ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Machine", r.stdout + r.stderr)
        self.assertIn("conflict", (r.stdout + r.stderr).lower())
        self.assertEqual(list((self.p.root / "export").rglob("*_Full.xml")), [])


class BaseFromExtension(Case):
    def test_base_from_environment(self):
        for variable_name in ("HPLC_EXPORT_BASE", "PLC_EXPORT_BASE"):  # PLC_EXPORT_BASE: legacy
            base = self.p.base(manufacturer_xml({"MAIN": MAIN_BODY.replace("Routine", "Routine v2")}))
            self.p.export(env={variable_name: str(base)})
            self.assertEqual(self.p.report()["base"], str(base))
            self.assertTrue((self.p.output() / "Synthetic_v2_Full.xml").exists())


class Limits(Case):
    def test_new_pou_aborts_with_message(self):
        (self.p.root / "programs" / "99_New.st").write_text("PROGRAM New\nEND_PROGRAM\n", encoding="utf-8")
        r = self.p.export(ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("programs/99_New.st", r.stdout + r.stderr)

    def test_old_layout_project_aborts(self):
        manifest = self.p.root / "plcopen" / "manifest.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data.pop("sourceRepresentation")
        manifest.write_text(json.dumps(data), encoding="utf-8")
        r = self.p.export(ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("re-import", (r.stdout + r.stderr).lower())

    def test_file_name_comes_from_the_imported_xml(self):
        self.p.export()
        self.assertTrue((self.p.output() / "Synthetic_v1_Full.xml").exists())


class Modes(Case):
    def _outputs(self):
        folder = self.p.output()
        return {"full": list(folder.glob("*_Full.xml")), "application": list(folder.glob("*_Application.xml")),
                "routines": list((folder / "routines").glob("*.st")), "st": list(folder.glob("*_ST.st"))}

    def test_full_mode_writes_only_the_full_xml(self):
        self.p.export("--mode", "full")
        s = self._outputs()
        self.assertEqual(len(s["full"]), 1)
        self.assertEqual(s["application"] + s["routines"] + s["st"], [])
        self.assertTrue((self.p.output() / "EXPORT_REPORT.md").exists())

    def test_logic_mode_writes_application_and_routines_without_full(self):
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 7;")
        self.p.export("--mode", "logic")
        s = self._outputs()
        self.assertEqual(s["full"], [])
        self.assertEqual(len(s["application"]), 1)
        self.assertIn("Counter := 7;", (self.p.output() / "routines" / "Machine.st").read_text(encoding="utf-8"))
        self.assertIn("Counter := 7;", self.p.application())

    def test_both_is_the_default(self):
        self.p.export()
        s = self._outputs()
        self.assertEqual((len(s["full"]), len(s["application"]), len(s["st"])), (1, 1, 1))
        self.assertTrue(self.p.output().name.endswith("_both"), self.p.output().name)

    def test_legacy_mode_names_are_accepted(self):
        self.p.export("--modo", "completo")
        self.assertEqual(self._outputs()["application"], [])
        self.assertTrue(self.p.output().name.endswith("_full"), self.p.output().name)

    def test_mode_from_environment(self):
        for variable_name, value in (("HPLC_EXPORT_MODE", "logic"), ("PLC_EXPORT_MODE", "logica")):
            self.p.export(env={variable_name: value})
            self.assertEqual(self._outputs()["full"], [], variable_name)


class Folders(Case):
    def test_each_export_in_its_own_subfolder_with_date_and_mode(self):
        self.p.export("--mode", "full")
        self.p.export("--mode", "logic")
        self.p.export("--mode", "logic")
        folders = sorted(p.name for p in (self.p.root / "export").iterdir() if p.is_dir())
        self.assertEqual(len(folders), 3, folders)
        self.assertTrue(all(re.match(r"\d{4}-\d{2}-\d{2}_\d{6}_(full|logic)(~\d+)?$", n) for n in folders), folders)
        self.assertEqual([p.name for p in (self.p.root / "export").iterdir() if p.is_file()], [])

    def test_folder_chosen_by_the_extension(self):
        for variable_name in ("HPLC_EXPORT_DIR", "PLC_EXPORT_DIR"):  # PLC_EXPORT_DIR: legacy
            target = self.p.root / "export" / f"2026-10-16_120000_logic_{variable_name}"
            self.p.export(env={"HPLC_EXPORT_MODE": "logic", variable_name: str(target)})
            self.assertTrue(list(target.glob("*_Application.xml")), variable_name)

    def test_out_flag(self):
        target = self.p.root / "export" / "chosen"
        self.p.export("--mode", "full", "--out", target)
        self.assertTrue(list(target.glob("*_Full.xml")))


class ExportFromExtension(Case):
    def test_runs_over_a_project_with_an_old_runtime(self):
        for name in ("export_plcopenxml.py", "export_roundtrip.py", "verify_export.py"):
            (self.p.root / "runtime" / name).unlink()
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 8;")
        self.p.export(script=RUNTIME / "export_plcopenxml.py",
                      env={"HPLC_PROJECT_ROOT": str(self.p.root), "HPLC_EXPORT_MODE": "full"})
        self.assertIn("Counter := 8;", xml_body(self.p.full(), "Machine"))
        self.assertTrue(self.p.report()["verification"]["ok"])


class Ladder(Case):
    def test_unchanged_ladder_stays_intact(self):
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 4;")
        self.p.export()
        self.assertEqual(pou_text(self.p.full(), "Rungs"), pou_text(self.original, "Rungs"))

    def test_changed_ladder_goes_out_as_st_with_warning_on_top(self):
        self.p.edit("Rungs", "Output := GVL.Run;", "Output := GVL.Run AND NOT Output;")
        self.p.export()
        pou = pou_text(self.p.full(), "Rungs")
        self.assertNotIn("<LD>", pou)
        self.assertIn("<ST>", pou)
        body = xml_body(self.p.full(), "Rungs")
        self.assertTrue(body.startswith("(* WARNING: POU originally in Ladder"), body[:120])
        self.assertEqual(body.split("\n")[0].count("*)"), 1)
        self.assertIn("Output := GVL.Run AND NOT Output;", body)
        self.assertIn("33333333-3333-3333-3333-333333333333", pou)
        report = self.p.report()
        self.assertIn("Rungs", report["ladder_converted"])
        self.assertTrue(report["verification"]["ok"], report["verification"])

    def test_warning_in_portuguese(self):
        self.p.edit("Rungs", "Output := GVL.Run;", "Output := NOT GVL.Run;")
        self.p.export(env={"HPLC_LANG": "pt-BR"})
        self.assertTrue(xml_body(self.p.full(), "Rungs").startswith("(* ATENCAO: POU originalmente em Ladder"))
        self.assertTrue(self.p.report()["verification"]["ok"])


class Application(Case):
    def test_keeps_attributes_and_manufacturer_shape(self):
        self.p.edit("Machine", "    Counter : INT := 0;\n",
                    "    Counter : INT := 0;\n    MinTime : TIME := TIME#5s0ms;\n")
        self.p.export()
        app = self.p.application()
        self.assertNotIn("xhtml:", app)
        self.assertNotIn("html:", app)
        self.assertIn('<Attribute Name="qualified_only" Value="" />', app)
        self.assertIn('<Attribute Name="order_in_persistent_editor" Value="1" />', app)
        self.assertIn('<Attribute Name="hide" Value="" />', app)
        self.assertIn('<variable name="MinTime">', app)
        self.assertIn("// old: GVL_Run &amp; counter", app)
        # TC6: addData before documentation in variable/globalVars/interface.
        for block in re.findall(r"<variable name=\"StartTime\">.*?</variable>", app, re.S):
            self.assertLess(block.index("<addData>"), block.index("<documentation>"))


class Verification(Case):
    def test_markdown_report_lists_what_changed(self):
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 6;")
        self.p.export()
        md = (self.p.output() / "EXPORT_REPORT.md").read_text(encoding="utf-8")
        self.assertIn("Machine", md)
        self.assertIn("Re-import", md)
        self.assertIn("0 differences", md)

    def test_markdown_report_in_portuguese(self):
        self.p.edit("Machine", "\tCounter := 0;", "\tCounter := 6;")
        self.p.export(env={"HPLC_LANG": "pt-BR"})
        md = (self.p.output() / "EXPORT_REPORT.md").read_text(encoding="utf-8")
        self.assertIn("Reimportação", md)
        self.assertIn("0 diferenças", md)


if __name__ == "__main__":
    unittest.main()
