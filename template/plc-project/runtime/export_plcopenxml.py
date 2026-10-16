#!/usr/bin/env python3
"""Exports the project sources to PLCopenXML TC6 and a consolidated ST file."""
from pathlib import Path
import datetime as dt
import re
import xml.etree.ElementTree as ET
import copy
import json
import argparse
import os
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import msg  # noqa: E402

# Current mode names, plus the legacy Portuguese ones still accepted.
MODES = {"full": "full", "logic": "logic", "both": "both",
         "completo": "full", "logica": "logic", "ambos": "both"}  # legacy aliases

_parser = argparse.ArgumentParser(description=msg("cli_export_description"))
_parser.add_argument("--base", type=Path, help=msg("cli_base"))
_parser.add_argument("--mode", "--modo", dest="mode", choices=sorted(MODES), help=msg("cli_mode"))
_parser.add_argument("--out", "--saida", dest="out", type=Path, help=msg("cli_out"))
ARGS = _parser.parse_args()


def _env(name):
    """HPLC_EXPORT_<name>, falling back to the legacy PLC_EXPORT_<name>."""
    return os.environ.get(f"HPLC_EXPORT_{name}") or os.environ.get(f"PLC_EXPORT_{name}")


# The extension asks for the mode and passes it through the environment, like the base.
_requested_mode = ARGS.mode or _env("MODE") or "both"
if _requested_mode not in MODES:
    raise SystemExit(msg("err_invalid_mode", mode=_requested_mode))
MODE = MODES[_requested_mode]
FULL = MODE in ("full", "both")
LOGIC = MODE in ("logic", "both")

# The extension runs ITS version of this script over the project (HPLC_PROJECT_ROOT),
# so projects with an old runtime/ get the current export. The importer used in
# the comparison is still the project's own, which generated the sources.
ROOT = Path(os.environ.get("HPLC_PROJECT_ROOT") or Path(__file__).resolve().parent.parent).resolve()
# Each export goes into its own subfolder, so earlier ones are neither mixed nor
# overwritten: export/YYYY-MM-DD_HHMMSS_<mode>. The extension picks the name.
if ARGS.out or _env("DIR"):
    OUT = Path(ARGS.out or _env("DIR"))
else:
    OUT = ROOT / "export" / f"{dt.datetime.now().strftime('%Y-%m-%d_%H%M%S')}_{MODE}"
    suffix = 2
    while OUT.exists():
        OUT = OUT.with_name(f"{OUT.name.rsplit('~', 1)[0]}~{suffix}"); suffix += 1
OUT.mkdir(parents=True, exist_ok=True)
print(msg("export_folder", path=OUT))
PLC = "http://www.plcopen.org/xml/tc6_0200"
XHTML = "http://www.w3.org/1999/xhtml"
ET.register_namespace("", PLC)

original_path = ROOT / "plcopen" / "original.xml"
manifest_source = ROOT / "plcopen" / "manifest.json"
source_name = original_path.stem if original_path.exists() else "HPLC"
if manifest_source.exists():
    try:
        source_name = Path(json.loads(manifest_source.read_text(encoding="utf-8")).get("source", source_name)).stem
    except (OSError, ValueError, TypeError):
        pass
export_stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", source_name)

# Order of the <pou> children required by the PLCopen TC6 schema.
POU_CHILD_ORDER = ["interface", "actions", "transitions", "body", "addData", "documentation"]
# Attributes tied to the source project: they do not go into the application file.
PROJECT_BOUND_ATTRIBUTES = {"checksumnoinit_override", "init_related_code"}


def normalize(text):
    """Adjusts the ElementTree serialization to the shape manufacturers write.

    The ST body comes out as <html:xhtml>, with the prefix declared on the root;
    it is equivalent XML, but importers are literal and expect <xhtml xmlns="...">.
    The declaration comes out with single quotes, unusual for a .NET exporter.
    """
    text = re.sub(r"<html:xhtml(\s*/?)>", lambda m: f'<xhtml xmlns="{XHTML}"{m.group(1) or ""}>', text)
    text = text.replace("</html:xhtml>", "</xhtml>")
    if "html:" not in text:
        text = text.replace(f' xmlns:html="{XHTML}"', "")
    return text.replace("<?xml version='1.0' encoding='utf-8'?>", '<?xml version="1.0" encoding="utf-8"?>', 1)


def safe(value): return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def q(name): return f"{{{PLC}}}{name}"
def files(folder): return sorted((ROOT / folder).glob("*.st")) if (ROOT / folder).exists() else []

def source_text(source):
    """Expands the Main routines without writing intermediate ST files."""
    lines=[]
    marker=re.compile(r"^\s*\(\*\s*@ROUTINE\s+([^*]+?)\s*\*\)\s*$")
    for line in source.read_text(encoding="utf-8").splitlines():
        match=marker.match(line)
        if match:
            routine=ROOT/"routines"/match.group(1).strip()
            lines.extend(routine.read_text(encoding="utf-8").splitlines())
        else:
            lines.append(line)
    return "\n".join(lines)

scalar = {"BOOL","BYTE","WORD","DWORD","LWORD","SINT","USINT","INT","UINT","DINT","UDINT","LINT","ULINT","REAL","LREAL","TIME","DATE","TOD","DT","STRING","WSTRING"}

def add_type(parent, type_name):
    t = ET.SubElement(parent, q("type"))
    base = type_name.split(":=",1)[0].strip()
    if base.upper() in scalar:
        ET.SubElement(t, q(base.upper()))
    else:
        ET.SubElement(t, q("derived"), {"name": base})
    return t

def declarations(text):
    """Reads ST declarations keeping the physical address.

    An allocated variable looks like `DG_X AT %QB20480 : T_DIAG;`. Without
    recognizing the AT, the whole declaration was dropped on export and the GVL
    went back to the XML without its allocated members.
    """
    result=[]
    for raw in text.splitlines():
        line=re.sub(r"\(\*.*?\*\)","",raw)
        line=re.sub(r"//[^\n]*","",line).strip()
        m=re.match(r"([A-Za-z_]\w*)\s*(?:\bAT\b\s*(%[A-Za-z0-9_.*]+)\s*)?:\s*([^;]+);",line,re.I)
        if not m: continue
        name, address, spec=m.groups(); parts=spec.split(":=",1)
        result.append((name,parts[0].strip(),parts[1].strip() if len(parts)>1 else None,address))
    return result

def add_variable(parent, item):
    name,type_name,initial,address=item
    attributes={"name":name}
    if address: attributes["address"]=address
    var=ET.SubElement(parent,q("variable"),attributes); add_type(var,type_name)
    if initial is not None:
        iv=ET.SubElement(var,q("initialValue")); ET.SubElement(iv,q("simpleValue"),{"value":initial})

root=ET.Element(q("project"))
ET.SubElement(root,q("fileHeader"),{"companyName":"HPLC","productName":"HPLC","productVersion":"0.1","creationDateTime":dt.datetime.now(dt.timezone.utc).isoformat()})
header=ET.SubElement(root,q("contentHeader"),{"name":f"{export_stem}_Full","modificationDateTime":dt.datetime.now(dt.timezone.utc).isoformat()})
coord=ET.SubElement(header,q("coordinateInfo"))
for lang in ("fbd","ld","sfc"):
    ET.SubElement(ET.SubElement(coord,q(lang)),q("scaling"),{"x":"1","y":"1"})

types=ET.SubElement(root,q("types")); data_types=ET.SubElement(types,q("dataTypes")); pous=ET.SubElement(types,q("pous"))
for source in files("types"):
    text=source.read_text(encoding="utf-8")
    for match in re.finditer(r"TYPE\s+(\w+)\s*:\s*STRUCT(.*?)END_STRUCT\s*;?\s*END_TYPE",text,re.S|re.I):
        dtype=ET.SubElement(data_types,q("dataType"),{"name":match.group(1)})
        base=ET.SubElement(dtype,q("baseType")); struct=ET.SubElement(base,q("struct"))
        for item in declarations(match.group(2)): add_variable(struct,item)

# A POU usually starts with a header comment, and re.match is anchored at the
# start of the text: the declaration was not found, add_pou returned silently and
# the POU vanished from the XML with no error. Searching with re.search does not
# work either, because the comment itself mentions "PROGRAM Main". So the header
# comment is split off first.
def comment_end(text):
    """Index after the *) that closes the comment opened at 0, or -1.

    The standard allows nested comments since the 3rd edition, and the Main
    header mentions "(* @ROUTINE *)" inside its own comment. Closing at the
    first *) would let the rest of the header pass as code.
    """
    depth=0; i=0
    while i < len(text)-1:
        if text[i:i+2]=="(*": depth+=1; i+=2; continue
        if text[i:i+2]=="*)":
            depth-=1; i+=2
            if depth==0: return i
            continue
        i+=1
    return -1


def strip_preface(text):
    while True:
        rest=text.lstrip()
        if rest.startswith("(*"):
            end=comment_end(rest)
            if end<0: return rest
            text=rest[end:]
        elif rest.startswith("//"):
            newline=rest.find("\n")
            if newline<0: return ""
            text=rest[newline+1:]
        else:
            return rest


without_declaration=[]


def add_pou(source):
    text=strip_preface(source_text(source).strip())
    head=re.match(r"(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)(?:\s*:\s*(\w+))?",text,re.I)
    if not head:
        without_declaration.append(source)
        return
    kind,name,return_type=head.groups(); kind=kind.upper()
    pou_type={"PROGRAM":"program","FUNCTION_BLOCK":"functionBlock","FUNCTION":"function"}[kind]
    pou=ET.SubElement(pous,q("pou"),{"name":name,"pouType":pou_type}); interface=ET.SubElement(pou,q("interface"))
    if return_type: add_type(ET.SubElement(interface,q("returnType")),return_type)
    section_map={"VAR_INPUT":"inputVars","VAR_OUTPUT":"outputVars","VAR_IN_OUT":"inOutVars","VAR":"localVars"}
    for section,xml_name in section_map.items():
        pattern=rf"\b{section}\b(.*?)END_VAR"
        matches=list(re.finditer(pattern,text,re.S|re.I))
        for m in matches:
            holder=ET.SubElement(interface,q(xml_name))
            for item in declarations(m.group(1)): add_variable(holder,item)
    body_text=re.sub(r"\bVAR(?:_INPUT|_OUTPUT|_IN_OUT)?\b.*?END_VAR","",text,flags=re.S|re.I)
    body_text=re.sub(rf"^\s*{kind}\s+{re.escape(name)}(?:\s*:\s*\w+)?\s*","",body_text,flags=re.I)
    body_text=re.sub(rf"\s*END_{kind}\s*$","",body_text,flags=re.I).strip()
    body=ET.SubElement(pou,q("body")); st=ET.SubElement(body,q("ST")); x=ET.SubElement(st,f"{{{XHTML}}}xhtml"); x.text=body_text

for folder in ("functions","blocks","programs"):
    for source in files(folder): add_pou(source)
# Exporting an XML without the POU is worse than failing: the file opens in the
# target software and looks complete.
if without_declaration:
    raise SystemExit(msg("err_no_pou_declaration",
                         files="\n  ".join(str(x.relative_to(ROOT)) for x in without_declaration)))

instances=ET.SubElement(root,q("instances")); configurations=ET.SubElement(instances,q("configurations")); config=ET.SubElement(configurations,q("configuration"),{"name":"Config0"}); resource=ET.SubElement(config,q("resource"),{"name":"Application"})
for source in files("globals"):
    text=source.read_text(encoding="utf-8")
    for index,m in enumerate(re.finditer(r"VAR_GLOBAL(.*?)END_VAR",text,re.S|re.I)):
        name=source.stem if index==0 else f"{source.stem}_{index+1}"
        holder=ET.SubElement(resource,q("globalVars"),{"name":name})
        for item in declarations(m.group(1)): add_variable(holder,item)
task=ET.SubElement(resource,q("task"),{"name":"MainTask","interval":"PT0.01S","priority":"10"})
ET.SubElement(task,q("pouInstance"),{"name":"MainInstance","typeName":"Main"})

def st_body(item):
    body=next((x for x in item if x.tag.split("}")[-1]=="body"),None)
    if body is None: return None
    return next(((x.text or "") for x in body.iter() if x.tag.split("}")[-1]=="xhtml"),"")


original_path=ROOT/"plcopen"/"original.xml"
manifest_path=ROOT/"plcopen"/"manifest.json"
fixes=[]
generated_bodies={item.get("name"):body
                  for item in pous
                  if (body:=st_body(item)) is not None}
imported=original_path.exists() and manifest_path.exists()
if imported:
    # The full file is the manufacturer's base edited only where the project
    # changed (export_roundtrip.py). Comments, whitespace, addData, GUIDs and
    # unchanged Ladder stay byte for byte; the report says what changed and the
    # verification (re-importing the generated file = sources) runs before writing.
    import export_roundtrip
    if LOGIC:
        for old in (*OUT.glob("*_Application.xml"), *OUT.glob("*_Aplicacao.xml")):  # _Aplicacao: legacy
            old.unlink()
    # The extension passes the base through the environment: avoids path quoting on Windows.
    # The logic-only export does not depend on a base: it comes from the sources,
    # over the imported XML.
    base_path=(ARGS.base or (Path(_env("BASE")) if _env("BASE") else original_path)) \
        if FULL else original_path
    try:
        generated, report = export_roundtrip.export(ROOT, base_path, OUT)
    except export_roundtrip.ExportError as error:
        raise SystemExit(msg("error_prefix", error=error))
    export_stem=export_roundtrip.base_name(ROOT, base_path)
    if FULL:
        xml_path=export_roundtrip.write(generated, report, export_stem, OUT)
        if xml_path is None:
            raise SystemExit(msg("err_verification_failed"))
    else:
        xml_path=None
        if not report["verification"]["ok"]:
            raise SystemExit(msg("err_sources_do_not_reproduce"))
    original_root=ET.fromstring(generated)
    # In the application file the ST body comes from the full one (the
    # manufacturer's exact text, with the changes); only Ladder that is still
    # graphical uses the ST converted from the sources.
    for item in (x for x in original_root.iter() if x.tag.split("}")[-1]=="pou"):
        text=st_body(item)
        body=next((x for x in item if x.tag.split("}")[-1]=="body"),None)
        if text is not None and body is not None and next(iter(body)).tag.split("}")[-1]=="ST":
            generated_bodies[item.get("name")]=text
    # MasterTool 3.76 exports an empty <pouInstance typeName="">, and the TC6
    # schema requires the type. The full file goes back to MasterTool itself and
    # stays as it came; the application file goes to other tools and is fixed.
    pou_names={item.get("name") for item in original_root.iter() if item.tag.split("}")[-1]=="pou"}
    for instance in (x for x in original_root.iter() if x.tag.split("}")[-1]=="pouInstance"):
        if instance.get("typeName"): continue
        name=instance.get("name") or ""
        if name in pou_names:
            instance.set("typeName",name)
            fixes.append(msg("fix_type_name_filled", name=name))
        else:
            fixes.append(msg("fix_type_name_not_fixed", name=name))
else:
    # Project that did not come from an import: there is no manufacturer base,
    # the file is built from scratch from the sources.
    tree=ET.ElementTree(root)
    xml_path=OUT/f"{export_stem}_{'Full' if FULL else 'Application'}.xml"
    ET.indent(tree,space="  "); tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    # ElementTree serializes the ST body as <html:xhtml>, with the prefix
    # declared on the root. MasterTool and CODESYS expect <xhtml xmlns="...">.
    xml_path.write_text(normalize(xml_path.read_text(encoding="utf-8")), encoding="utf-8")

bundle=None
if LOGIC:
    ordered=[]
    for folder in ("types","functions","blocks","globals","programs"):
        for source in files(folder): ordered.append(f"(* ===== {folder}/{source.name} ===== *)\n{source_text(source).strip()}\n")
    bundle=OUT/f"{export_stem}_ST.st"; bundle.write_text("\n".join(ordered),encoding="utf-8")
for fix in fixes:
    print(msg("fix_prefix", fix=fix))
# Application file: only the logic, in the shape the TC6 standard describes,
# without any manufacturer extension. It is what you take to any software.
#
# Neither MasterTool nor CODESYS write it this way: both leave types/pous empty,
# keep POUs and DUTs inside proprietary addData and tie each object to the GUID
# of its parent through ProjectStructure. That makes their file a round-trip of
# the project itself, not an interchange file. Here the file is built from scratch.
if imported and LOGIC:
    application=ET.Element(q("project"))
    now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    ET.SubElement(application,q("fileHeader"),{
        "companyName":"HPLC","productName":"HPLC","productVersion":"1.0",
        "creationDateTime":now})
    content_header=ET.SubElement(application,q("contentHeader"),{"name":export_stem,"modificationDateTime":now})
    coordinates=ET.SubElement(content_header,q("coordinateInfo"))
    for language in ("fbd","ld","sfc"):
        ET.SubElement(ET.SubElement(coordinates,q(language)),q("scaling"),{"x":"1","y":"1"})
    app_types=ET.SubElement(application,q("types"))
    target_dt=ET.SubElement(app_types,q("dataTypes"))
    target_pou=ET.SubElement(app_types,q("pous"))

    def without_extension(node):
        """Copy without manufacturer extensions, except attributes ({attribute}).

        qualified_only (GVL), order_in_persistent_editor (persistent list) and
        hide are program semantics, not ties to the project: without them the
        GVL no longer requires qualified names and the persistent editor loses
        its order. The ones tied to the original project are dropped.
        """
        clean=copy.deepcopy(node)
        for parent in list(clean.iter()):
            for child in list(parent):
                if child.tag.split("}")[-1]!="addData":
                    continue
                for data in list(child):
                    if not (data.get("name") or "").endswith("/attributes"):
                        child.remove(data); continue
                    for attribute_list in data:
                        for attribute in list(attribute_list):
                            if attribute.get("Name") in PROJECT_BOUND_ATTRIBUTES:
                                attribute_list.remove(attribute)
                    if not any(len(attribute_list) for attribute_list in data):
                        child.remove(data)
                if not len(child):
                    parent.remove(child)
        return clean

    for item in (x for x in original_root.iter() if x.tag.split("}")[-1]=="dataType"):
        target_dt.append(without_extension(item))
    # A graphical body is not portable: the manufacturer's LD and FBD networks
    # depend on <vendorElement> whose content lives in proprietary addData.
    # Without the addData the element is incomplete and the schema rejects it;
    # with it the file is no longer neutral. In the application file every POU
    # carries ST, which any tool reads. The original Ladder stays in the full file.
    # The ST converted from ladder uses variables the import created (LD_P_*,
    # LD_N_*, LD_ENO_*: edge memory and saved EN). The original interface does
    # not have them, and without declaring them the ST does not compile at the target.
    project_pous={p.get("name"):p for p in pous}
    def declare_ladder_helpers(copy_, name):
        source=project_pous.get(name)
        interface=next((x for x in copy_ if x.tag.split("}")[-1]=="interface"),None)
        if source is None or interface is None: return
        existing={v.get("name","").upper() for v in interface.iter() if v.tag.split("}")[-1]=="variable"}
        new=[v for v in source.iter() if v.tag.split("}")[-1]=="variable"
             and (v.get("name") or "").startswith("LD_") and v.get("name").upper() not in existing]
        if not new: return
        section=ET.Element(q("localVars"))
        for v in new: section.append(copy.deepcopy(v))
        # In the TC6 schema sections come before documentation and addData.
        position=next((i for i,x in enumerate(interface) if x.tag.split("}")[-1] in {"documentation","addData"}),len(interface))
        interface.insert(position,section)
    graphical=[]
    for item in (x for x in original_root.iter() if x.tag.split("}")[-1]=="pou"):
        copy_=without_extension(item)
        body=next((x for x in copy_ if x.tag.split("}")[-1]=="body"), None)
        code=generated_bodies.get(item.get("name"))
        if body is not None and code is not None:
            language=next((x.tag.split("}")[-1] for x in body), None)
            if language and language != "ST":
                graphical.append(f"{item.get('name')} ({language})")
                declare_ladder_helpers(copy_, item.get("name"))
            copy_.remove(body)
            new_body=ET.SubElement(copy_,q("body"))
            ET.SubElement(ET.SubElement(new_body,q("ST")),f"{{{XHTML}}}xhtml").text=code
            # body comes before documentation and addData in the schema sequence
            order=["interface","actions","transitions","body","addData","documentation"]
            copy_[:] = sorted(copy_, key=lambda c: order.index(c.tag.split("}")[-1])
                              if c.tag.split("}")[-1] in order else len(order))
        target_pou.append(copy_)
    app_instances=ET.SubElement(application,q("instances"))
    app_configurations=ET.SubElement(app_instances,q("configurations"))
    app_configuration=ET.SubElement(app_configurations,q("configuration"),{"name":"Config"})
    app_resource=ET.SubElement(app_configuration,q("resource"),{"name":"Application"})
    # The standard does not allow VAR_GLOBAL and VAR_GLOBAL CONSTANT in the same
    # list, and the CODESYS importer rejects the file because of it. MasterTool
    # exports Special_Variables in three blocks, two normal and one constant.
    # Here blocks of the same nature are merged and the constant block gets its own list.
    lists={}
    for gvl in (x for x in original_root.iter() if x.tag.split("}")[-1]=="globalVars"):
        base=gvl.get("name") or "GlobalVars"
        constant=gvl.get("constant")=="true"
        key=(base, constant)
        current=lists.get(key)
        if current is None:
            clean=without_extension(gvl)
            clean.set("name", f"{base}_Const" if constant else base)
            lists[key]=clean
        else:
            seen={v.get("name") for v in current if v.tag.split("}")[-1]=="variable"}
            for v in without_extension(gvl):
                if v.tag.split("}")[-1]=="variable" and v.get("name") not in seen:
                    current.append(v); seen.add(v.get("name"))
    renamed=[key[0] for key in lists if key[1] and (key[0], False) in lists]
    # The TC6 schema fixes the order of the <resource> children: task, globalVars,
    # pouInstance, documentation, addData. Emitting globalVars before task makes
    # CODESYS reject the whole file with "invalid child element 'task'".
    for task_node in (x for x in original_root.iter() if x.tag.split("}")[-1]=="task"):
        app_resource.append(without_extension(task_node))
    for gvl_list in lists.values():
        app_resource.append(gvl_list)

    RESOURCE_ORDER=["task","globalVars","pouInstance","addData","documentation"]
    POU_ORDER=["interface","actions","transitions","body","addData","documentation"]
    for node, order in ((app_resource, RESOURCE_ORDER), *((x, POU_ORDER) for x in target_pou)):
        indices=[order.index(c.tag.split("}")[-1]) for c in node if c.tag.split("}")[-1] in order]
        if indices != sorted(indices):
            raise SystemExit(msg("err_child_order", tag=node.tag.split('}')[-1],
                                 children=[c.tag.split('}')[-1] for c in node][:6]))

    target=OUT/f"{export_stem}_Application.xml"
    tree=ET.ElementTree(application)
    ET.indent(tree,space="  "); tree.write(target,encoding="utf-8",xml_declaration=True)
    target.write_text(normalize(target.read_text(encoding="utf-8")), encoding="utf-8")
    print(msg("export_application", path=target))
    print(msg("export_application_summary", pous=len(target_pou), duts=len(target_dt),
              gvls=len([x for x in app_resource if x.tag.split('}')[-1]=='globalVars']),
              kb=target.stat().st_size // 1024))
    if graphical:
        print(msg("export_graphical_converted", count=len(graphical), names=", ".join(graphical)))
    for base in renamed:
        print(msg("export_constant_list_renamed", name=base))

if LOGIC:
    # Loose routines: one ST file per POU, to paste one at a time into any IDE.
    # It is the path that always works, without depending on an importer.
    routines=OUT/"routines"
    for old in routines.glob("*.st"):
        old.unlink()
    routines.mkdir(exist_ok=True)
    written=0
    for name, code in sorted(generated_bodies.items()):
        source=next((x for folder in ("programs","blocks","functions")
                     for x in files(folder)
                     if re.search(rf"\b(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+{re.escape(name)}\b",
                                  x.read_text(encoding="utf-8"), re.I)), None)
        if source is None:
            continue
        text=source.read_text(encoding="utf-8")
        declaration_text=text[:text.lower().rfind("end_var")+len("end_var")] if "end_var" in text.lower() else text.splitlines()[0]
        end={"programs":"END_PROGRAM","blocks":"END_FUNCTION_BLOCK","functions":"END_FUNCTION"}[source.parent.name]
        (routines/f"{safe(name)}.st").write_text(f"{declaration_text}\n\n{code}\n{end}\n", encoding="utf-8")
        written+=1
    print(msg("export_routines", path=routines, count=written))

if FULL and xml_path:
    print(msg("export_full", path=xml_path))
if bundle:
    print(msg("export_bundle", path=bundle))
