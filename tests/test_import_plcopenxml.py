#!/usr/bin/env python3
"""Tests of the PLCopenXML importer with synthetic XML.

No customer XML here: the repository may be public. Each case builds the
minimum PLCopenXML that reproduces a defect already seen in a real project.

    python3 tests/test_import_plcopenxml.py
"""
from pathlib import Path
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
RUNTIME = REPO / "template" / "plc-project" / "runtime"
IMPORTER = RUNTIME / "import_plcopenxml.py"
PREPARE = RUNTIME / "prepare_runtime.py"

spec = importlib.util.spec_from_file_location("import_plcopenxml", IMPORTER)
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)

NS = "http://www.plcopen.org/xml/tc6_0200"


def project(pous="", gvls="", types=""):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<project xmlns="{NS}">
  <types><dataTypes>{types}</dataTypes><pous>{pous}</pous></types>
  <instances><configurations><configuration name="C"><resource name="R">
    {gvls}
  </resource></configuration></configurations></instances>
</project>"""


def import_xml(xml, pattern="*.st", prepare=None, env=None):
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        (folder / "in.xml").write_text(xml, encoding="utf-8")
        output = folder / "out"
        if prepare:
            prepare(output)
        subprocess.run([sys.executable, str(IMPORTER), str(folder / "in.xml"), str(output), "--active"],
                       check=True, capture_output=True, text=True, env={**os.environ, **(env or {})})
        return {str(p.relative_to(output)): p.read_text(encoding="utf-8")
                for p in output.rglob(pattern)}


def source(files, name):
    return next(text for path, text in files.items() if path.endswith(f"_{name}.st"))


def collapse_spaces(text):
    return re.sub(r"\s+", " ", text)


ST = '<body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">{}</xhtml></ST></body>'


class InitialValues(unittest.TestCase):
    def test_fb_instance_with_pt(self):
        pou = f"""<pou name="Machine" pouType="program"><interface><localVars>
          <variable name="TimeInState"><type><derived name="TON"/></type>
            <initialValue><structValue><value member="PT"><simpleValue value="TIME#10m0s0ms"/></value></structValue></initialValue>
          </variable></localVars></interface>{ST.format("TimeInState(IN := TRUE);")}</pou>"""
        text = source(import_xml(project(pous=pou)), "Machine")
        self.assertIn("TimeInState : TON := (PT := TIME#10m0s0ms);", text)

    def test_array_of_nested_struct_with_repetition(self):
        types = """
        <dataType name="Range"><baseType><struct>
          <variable name="Maximum"><type><REAL/></type></variable>
          <variable name="Minimum"><type><REAL/></type></variable>
        </struct></baseType></dataType>
        <dataType name="Instrument"><baseType><struct>
          <variable name="Scale"><type><derived name="Range"/></type></variable>
          <variable name="Delay"><type><TIME/></type></variable>
        </struct></baseType></dataType>"""
        gvl = """<globalVars name="Setpoint">
          <variable name="Scales"><type><array><dimension lower="0" upper="3"/>
            <baseType><derived name="Instrument"/></baseType></array></type>
            <initialValue><arrayValue>
              <value><structValue>
                <value member="Scale"><structValue>
                  <value member="Maximum"><simpleValue value="1450"/></value>
                  <value member="Minimum"><simpleValue value="-15"/></value>
                </structValue></value>
                <value member="Delay"><simpleValue value="TIME#4s0ms"/></value>
              </structValue></value>
              <value repetitionValue="3"><structValue>
                <value member="Delay"><simpleValue value="TIME#2s0ms"/></value>
              </structValue></value>
            </arrayValue></initialValue>
          </variable>
          <variable name="Limits"><type><array><dimension lower="0" upper="4"/>
            <baseType><INT/></baseType></array></type>
            <initialValue><arrayValue>
              <value><simpleValue value="1"/></value>
              <value repetitionValue="4"><simpleValue value="7"/></value>
            </arrayValue></initialValue>
          </variable>
        </globalVars>"""
        text = import_xml(project(gvls=gvl, types=types))["globals/01_Setpoint.st"]
        self.assertIn("Scales : ARRAY [0..3] OF Instrument := "
                      "[(Scale := (Maximum := 1450, Minimum := -15), Delay := TIME#4s0ms), "
                      "3((Delay := TIME#2s0ms))];", text)
        self.assertIn("Limits : ARRAY [0..4] OF INT := [1, 4(7)];", text)

    def test_dut_member_with_struct_initial_value(self):
        types = """
        <dataType name="Range"><baseType><struct>
          <variable name="Maximum"><type><REAL/></type></variable>
        </struct></baseType></dataType>
        <dataType name="Valve"><baseType><struct>
          <variable name="Scale"><type><derived name="Range"/></type>
            <initialValue><structValue><value member="Maximum"><simpleValue value="100"/></value></structValue></initialValue>
          </variable>
        </struct></baseType></dataType>"""
        files = import_xml(project(types=types))
        self.assertIn("Scale : Range := (Maximum := 100);", source(files, "Valve"))


class Qualifiers(unittest.TestCase):
    def test_gvl_retain_persistent_and_constant(self):
        gvls = """
        <globalVars name="State"><variable name="Current"><type><INT/></type></variable></globalVars>
        <globalVars name="Special" constant="true">
          <variable name="Interval"><type><UDINT/></type><initialValue><simpleValue value="20000"/></initialValue></variable>
        </globalVars>
        <globalVars name="Setpoint" retain="true" persistent="true">
          <variable name="Time"><type><TIME/></type><initialValue><simpleValue value="T#5s"/></initialValue></variable>
        </globalVars>"""
        text = "\n".join(v for k, v in import_xml(project(gvls=gvls)).items() if k.startswith("globals/"))
        blocks = re.findall(r"^(VAR_GLOBAL[^\n]*)\n(.*?)^END_VAR", text, re.S | re.M)
        headers = {header.strip(): body for header, body in blocks}
        self.assertIn("Current : INT;", headers["VAR_GLOBAL"])
        self.assertIn("Interval : UDINT := 20000;", headers["VAR_GLOBAL CONSTANT"])
        self.assertIn("Time : TIME := T#5s;", headers["VAR_GLOBAL RETAIN PERSISTENT"])
        self.assertIn("(* Original GVL: State *)", text)

    def test_local_retain_persistent_section(self):
        pou = f"""<pou name="HourMeter" pouType="functionBlock"><interface>
          <localVars retain="true" persistent="true">
            <variable name="Count"><type><UDINT/></type></variable></localVars>
          <outputVars retain="true"><variable name="Hours"><type><UDINT/></type></variable></outputVars>
          </interface>{ST.format("Hours := Count;")}</pou>"""
        text = source(import_xml(project(pous=pou)), "HourMeter")
        self.assertIn("VAR RETAIN PERSISTENT\n    Count : UDINT;", text)
        self.assertIn("VAR_OUTPUT RETAIN\n    Hours : UDINT;", text)

    def test_local_after_qualifier_does_not_become_global(self):
        # declared_names read "RETAIN Count" as a single name and the local was
        # no longer recognized; the renamer replaced it with the same-named global.
        gvl = '<globalVars name="G"><variable name="Count"><type><UDINT/></type></variable></globalVars>'
        pou = f"""<pou name="HourMeter" pouType="functionBlock"><interface>
          <localVars retain="true"><variable name="Count"><type><UDINT/></type></variable></localVars>
          </interface>{ST.format("Count := Count + 1;")}</pou>"""
        text = source(import_xml(project(pous=pou, gvls=gvl)), "HourMeter")
        self.assertIn("Count := Count + 1;", text)
        self.assertNotIn("G_Count", text)


def ladder_pou(name, elements, interface="", kind="program"):
    return (f'<pou name="{name}" pouType="{kind}"><interface>{interface}</interface>'
            f'<body><LD><leftPowerRail localId="0"><connectionPointOut formalParameter="none"/></leftPowerRail>'
            f'{elements}</LD></body></pou>')


def contact(id_, ref, variable, edge="none", negated="false"):
    return (f'<contact localId="{id_}" negated="{negated}" storage="none" edge="{edge}">'
            f'<connectionPointIn><connection refLocalId="{ref}"/></connectionPointIn>'
            f'<variable>{variable}</variable></contact>')


def coil(id_, ref, variable, edge="none", storage="none"):
    return (f'<coil localId="{id_}" negated="false" storage="{storage}" edge="{edge}">'
            f'<connectionPointIn><connection refLocalId="{ref}"/></connectionPointIn>'
            f'<variable>{variable}</variable></coil>')


def in_variable(id_, text):
    return f'<inVariable localId="{id_}"><expression>{text}</expression></inVariable>'


def block(id_, kind, en_ref, en_formal=None, inputs=(), output=None, eno=True):
    en = f' formalParameter="{en_formal}"' if en_formal else ""
    pins = "".join(
        f'<variable formalParameter="In{n}"><connectionPointIn><connection refLocalId="{ref}"/></connectionPointIn></variable>'
        for n, ref in enumerate(inputs, 2))
    outputs = '<variable formalParameter="ENO"><connectionPointOut/></variable>' if eno else ""
    if output:
        outputs += (f'<variable formalParameter="Out2"><connectionPointOut>'
                    f'<expression>{output}</expression></connectionPointOut></variable>')
    else:
        outputs += '<variable formalParameter="Out1"><connectionPointOut/></variable>'
    return (f'<block localId="{id_}" typeName="{kind}"><inputVariables>'
            f'<variable formalParameter="EN"><connectionPointIn><connection refLocalId="{en_ref}"{en}/></connectionPointIn></variable>'
            f'{pins}</inputVariables><inOutVariables/><outputVariables>{outputs}</outputVariables></block>')


LOCALS = ('<localVars><variable name="Enable"><type><BOOL/></type></variable>'
          '<variable name="Pulse"><type><BOOL/></type></variable>'
          '<variable name="Output"><type><BOOL/></type></variable>'
          '<variable name="Sec"><type><INT/></type></variable>'
          '<variable name="Min"><type><INT/></type></variable></localVars>')


class LadderEdges(unittest.TestCase):
    def test_rising_edge_contact_uses_r_trig_once(self):
        # The same P contact feeds two blocks. Calling R_TRIG at each use would
        # clear Q on the second: the instance is called once, before its use.
        elements = (contact(1, 0, "Enable") + contact(2, 1, "Pulse", edge="rising")
                    + in_variable(3, "Sec") + in_variable(4, "1")
                    + block(5, "ADD", 2, inputs=(3, 4), output="Sec")
                    + coil(6, 2, "Output"))
        text = source(import_xml(project(pous=ladder_pou("Counter", elements, LOCALS))), "Counter")
        self.assertRegex(text, r"VAR\b[^\n]*\n(?:\s*\(\*.*?\*\)\n)?\s*LD_P_2 : R_TRIG;")
        self.assertIn("(* Created by the LD -> ST conversion", text)
        self.assertEqual(text.count("LD_P_2(CLK := Pulse);"), 1)
        body = text.split("END_VAR")[-1]
        self.assertTrue(body.lstrip().startswith("(* Converted automatically from LD/FBD to ST. *)"), body[:80])
        self.assertLess(body.index("LD_P_2(CLK := Pulse);"), body.index("Sec := (Sec + 1);"))
        self.assertIn("IF (Enable AND LD_P_2.Q) THEN", body)
        self.assertIn("Output := (Enable AND LD_P_2.Q);", body)
        self.assertNotIn("(Enable AND Pulse)", body)

    def test_falling_edge_contact_uses_f_trig(self):
        elements = contact(1, 0, "Pulse", edge="falling") + coil(2, 1, "Output")
        text = source(import_xml(project(pous=ladder_pou("Down", elements, LOCALS))), "Down")
        self.assertIn("LD_N_1 : F_TRIG;", text)
        self.assertIn("LD_N_1(CLK := Pulse);", text)
        self.assertIn("Output := LD_N_1.Q;", text)

    def test_rising_edge_coil(self):
        elements = contact(1, 0, "Enable") + coil(2, 1, "Output", edge="rising")
        text = source(import_xml(project(pous=ladder_pou("Coil", elements, LOCALS))), "Coil")
        self.assertIn("LD_P_2 : R_TRIG;", text)
        self.assertIn("LD_P_2(CLK := Enable);", text)
        self.assertIn("Output := LD_P_2.Q;", text)

    def test_empty_diagram(self):
        text = source(import_xml(project(pous=ladder_pou("Empty", "", LOCALS))), "Empty")
        self.assertIn("(* Empty: original diagram has no executable logic. *)", text)


class ChainedEno(unittest.TestCase):
    def test_eno_saves_the_en_from_when_the_block_ran(self):
        # GT(Sec > 59) -> MOVE 0 -> Sec, and the MOVE ENO enables ADD Min.
        # Recomputing EN after the MOVE would test Sec > 59 with Sec already cleared.
        elements = (contact(1, 0, "Enable")
                    + in_variable(2, "Sec") + in_variable(3, "59") + block(4, "GT", 1, inputs=(2, 3), eno=False)
                    + in_variable(5, "0") + block(6, "MOVE", 4, en_formal="Out1", inputs=(5,), output="Sec")
                    + in_variable(7, "Min") + in_variable(8, "1") + block(9, "ADD", 6, en_formal="ENO", inputs=(7, 8), output="Min"))
        text = source(import_xml(project(pous=ladder_pou("Clock", elements, LOCALS))), "Clock")
        self.assertIn("LD_ENO_6 : BOOL;", text)
        body = collapse_spaces(text.split("END_VAR")[-1])
        self.assertIn("LD_ENO_6 := (Enable AND (Sec > 59)); IF LD_ENO_6 THEN Sec := 0; END_IF;", body)
        self.assertIn("IF LD_ENO_6 THEN Min := (Min + 1); END_IF;", body)

    def test_block_on_the_rail_does_not_save_constant_en(self):
        # EN wired straight to the rail is always TRUE: saving it would be noise.
        elements = (in_variable(2, "Sec") + in_variable(3, "1") + block(4, "ADD", 0, inputs=(2, 3), output="Sec")
                    + in_variable(5, "Min") + in_variable(6, "1") + block(7, "ADD", 4, en_formal="ENO", inputs=(5, 6), output="Min"))
        text = source(import_xml(project(pous=ladder_pou("Rail", elements, LOCALS))), "Rail")
        self.assertNotIn("LD_ENO", text)
        body = collapse_spaces(text.split("END_VAR")[-1])
        self.assertIn("Sec := (Sec + 1); Min := (Min + 1);", body)

    def test_no_eno_consumer_creates_no_variable(self):
        elements = (contact(1, 0, "Enable") + in_variable(2, "Sec") + in_variable(3, "1")
                    + block(4, "ADD", 1, inputs=(2, 3), output="Sec"))
        text = source(import_xml(project(pous=ladder_pou("Simple", elements, LOCALS))), "Simple")
        self.assertNotIn("LD_ENO", text)
        self.assertNotIn("LD_P_", text)


class ProgramCall(unittest.TestCase):
    def test_call_of_program_named_like_a_global_is_not_renamed(self):
        gvl = '<globalVars name="State"><variable name="Heating"><type><BOOL/></type></variable></globalVars>'
        pous = (f'<pou name="Heating" pouType="program"><interface/>{ST.format("State.Heating := TRUE;")}</pou>'
                f'<pou name="Main" pouType="program"><interface/>{ST.format("Heating();")}</pou>')
        main = source(import_xml(project(pous=pous, gvls=gvl)), "Main")
        self.assertIn("Heating();", main)
        self.assertNotIn("State_Heating()", main)


class Reports(unittest.TestCase):
    POU = f'<pou name="Main" pouType="program"><interface/>{ST.format("A := 1;")}</pou>'

    def test_rules_file_has_the_new_name_and_replaces_the_legacy_one(self):
        def legacy(output):
            (output / "plcopen").mkdir(parents=True)
            (output / "plcopen" / "REGRAS_IMPORTACAO.md").write_text("old", encoding="utf-8")
        files = import_xml(project(pous=self.POU), "*.md", prepare=legacy)
        self.assertIn("plcopen/IMPORT_RULES.md", files)
        self.assertNotIn("plcopen/REGRAS_IMPORTACAO.md", files)
        self.assertIn("# Import with native sources", files["plcopen/IMPORT_RULES.md"])
        self.assertIn("# Import report", files["plcopen/IMPORT_REPORT.md"])

    def test_reports_in_portuguese(self):
        files = import_xml(project(pous=self.POU), "*.md", env={"HPLC_LANG": "pt-BR"})
        self.assertIn("# Importacao com fontes nativos", files["plcopen/IMPORT_RULES.md"])
        self.assertIn("# Relatório de importação", files["plcopen/IMPORT_REPORT.md"])


class BackendAdaptation(unittest.TestCase):
    """STruC++ 0.6.3 accepts neither PERSISTENT nor RETAIN on VAR_OUTPUT."""

    def test_unsupported_qualifiers_leave_only_the_generated_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            runtime = folder / "runtime"
            runtime.mkdir()
            for helper in ["prepare_runtime.py", "prepare_native.py", "source_names.py", "import_plcopenxml.py",
                           "messages.py"]:
                (runtime / helper).write_bytes((PREPARE.parent / helper).read_bytes())
            (folder / "plc.toml").write_text('[[task]]\nname = "T"\ninterval_ms = 20\nprogram = "Main"\n',
                                             encoding="utf-8")
            (folder / "blocks").mkdir()
            (folder / "globals").mkdir()
            original_fb = ("FUNCTION_BLOCK HourMeter\nVAR RETAIN PERSISTENT\n    Count : UDINT;\nEND_VAR\n"
                           "VAR_OUTPUT RETAIN PERSISTENT\n    Hours : UDINT;\nEND_VAR\n\nHours := Count;\n"
                           "END_FUNCTION_BLOCK\n")
            original_gvl = "VAR_GLOBAL RETAIN PERSISTENT\n    Setpoint_Time : TIME := T#5s;\nEND_VAR\n"
            (folder / "blocks" / "01_HourMeter.st").write_text(original_fb, encoding="utf-8")
            (folder / "globals" / "00_GlobalVars.st").write_text(original_gvl, encoding="utf-8")
            subprocess.run([sys.executable, str(runtime / "prepare_runtime.py")], cwd=folder,
                           check=True, capture_output=True, text=True)
            generated = folder / ".plcsim" / "generated" / "src"
            fb = (generated / "blocks" / "01_HourMeter.st").read_text(encoding="utf-8")
            gvl = (generated / "globals" / "00_GlobalVars.st").read_text(encoding="utf-8")
            self.assertIn("VAR RETAIN\n", fb)
            self.assertIn("VAR_OUTPUT\n", fb)
            self.assertNotIn("PERSISTENT", fb + gvl)
            self.assertIn("VAR_GLOBAL RETAIN\n", gvl)
            # Official source untouched.
            self.assertEqual((folder / "blocks" / "01_HourMeter.st").read_text(encoding="utf-8"), original_fb)


if __name__ == "__main__":
    unittest.main(verbosity=2)
