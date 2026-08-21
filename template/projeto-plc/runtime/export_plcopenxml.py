#!/usr/bin/env python3
"""Exporta os fontes portáteis para PLCopenXML TC6 e um ST consolidado."""
from pathlib import Path
import datetime as dt
import re
import xml.etree.ElementTree as ET
import copy
import json
import uuid

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "export"
OUT.mkdir(exist_ok=True)
PLC = "http://www.plcopen.org/xml/tc6_0200"
XHTML = "http://www.w3.org/1999/xhtml"
ET.register_namespace("", PLC)

original_path = ROOT / "plcopen" / "original.xml"
manifest_source = ROOT / "plcopen" / "manifest.json"
source_name = original_path.stem if original_path.exists() else "PLC_Codex"
if manifest_source.exists():
    try:
        source_name = Path(json.loads(manifest_source.read_text(encoding="utf-8")).get("source", source_name)).stem
    except (OSError, ValueError, TypeError):
        pass
export_stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", source_name)

# Ordem dos filhos de <pou> exigida pelo esquema PLCopen TC6.
POU_CHILD_ORDER = ["interface", "actions", "transitions", "body", "documentation", "addData"]

def q(name): return f"{{{PLC}}}{name}"
def files(folder): return sorted((ROOT / folder).glob("*.st")) if (ROOT / folder).exists() else []

def source_text(source):
    """Expande as rotinas do Main sem gerar arquivos ST intermediários."""
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
    """Le declaracoes ST preservando o endereco fisico.

    Variavel alocada aparece como `DG_NX3008 AT %QB20480 : T_DIAG;`. Sem
    reconhecer o AT, a declaracao inteira era descartada no export e a GVL
    voltava para o XML sem os membros alocados.
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
ET.SubElement(root,q("fileHeader"),{"companyName":"PLC Codex","productName":"PLC Codex Simulator","productVersion":"0.1","creationDateTime":dt.datetime.now(dt.timezone.utc).isoformat()})
header=ET.SubElement(root,q("contentHeader"),{"name":f"{export_stem}_PLC_Codex","modificationDateTime":dt.datetime.now(dt.timezone.utc).isoformat()})
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

def add_pou(source):
    text=source_text(source).strip()
    head=re.match(r"(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)(?:\s*:\s*(\w+))?",text,re.I)
    if not head: return
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

instances=ET.SubElement(root,q("instances")); configurations=ET.SubElement(instances,q("configurations")); config=ET.SubElement(configurations,q("configuration"),{"name":"Config0"}); resource=ET.SubElement(config,q("resource"),{"name":"Application"})
for source in files("globals"):
    text=source.read_text(encoding="utf-8")
    for index,m in enumerate(re.finditer(r"VAR_GLOBAL(.*?)END_VAR",text,re.S|re.I)):
        name=source.stem if index==0 else f"{source.stem}_{index+1}"
        holder=ET.SubElement(resource,q("globalVars"),{"name":name})
        for item in declarations(m.group(1)): add_variable(holder,item)
task=ET.SubElement(resource,q("task"),{"name":"MainTask","interval":"PT0.01S","priority":"10"})
ET.SubElement(task,q("pouInstance"),{"name":"MainInstance","typeName":"Main"})

original_path=ROOT/"plcopen"/"original.xml"
manifest_path=ROOT/"plcopen"/"manifest.json"
if original_path.exists() and manifest_path.exists():
    original_tree=ET.parse(original_path); original_root=original_tree.getroot()
    import_manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    generated_pous={item.get("name"):item for item in pous}
    for original_pou in (item for item in original_root.iter() if item.tag.split("}")[-1]=="pou"):
        generated=generated_pous.get(original_pou.get("name"))
        if generated is None: continue
        for section_name in ("interface","body"):
            old=next((x for x in original_pou if x.tag.split("}")[-1]==section_name),None)
            new=next((x for x in generated if x.tag.split("}")[-1]==section_name),None)
            if old is not None: original_pou.remove(old)
            if new is not None: original_pou.append(copy.deepcopy(new))
        # O PLCopen exige ordem fixa nos filhos da POU. Inserir o body no fim da
        # lista o deixava depois do addData, e o MasterTool respondia "there are
        # no objects in the export file which can be imported".
        original_pou[:] = sorted(original_pou, key=lambda item: POU_CHILD_ORDER.index(item.tag.split("}")[-1])
                                 if item.tag.split("}")[-1] in POU_CHILD_ORDER else len(POU_CHILD_ORDER))
    generated_types={item.get("name"):item for item in data_types}
    for original_type in (item for item in original_root.iter() if item.tag.split("}")[-1]=="dataType"):
        generated=generated_types.get(original_type.get("name"))
        if generated is None: continue
        old=next((x for x in original_type if x.tag.split("}")[-1]=="baseType"),None)
        new=next((x for x in generated if x.tag.split("}")[-1]=="baseType"),None)
        if old is not None: original_type.remove(old)
        if new is not None: original_type.insert(0,copy.deepcopy(new))
    # O projeto guarda as globais numa lista unica, com o nome de cada lista do
    # fabricante virando prefixo do nome da variavel. O ST exportado usa esses
    # nomes, entao o XML precisa declarar a mesma lista: redistribuir por GVL
    # produziria um arquivo onde o codigo diz Field_DI e a GVL diz DI.
    flat = import_manifest.get("globalsLayout") == "flat"
    generated_flat=[copy.deepcopy(variable) for node in resource
                    if node.tag.split("}")[-1]=="globalVars"
                    for variable in node if variable.tag.split("}")[-1]=="variable"]
    original_gvls=[item for item in original_root.iter() if item.tag.split("}")[-1]=="globalVars"]
    if flat and generated_flat and original_gvls:
        alvo=original_gvls[0]
        alvo.set("name","GlobalVars")
        # O CODESYS decide onde colocar cada objeto pelo ProjectStructure, que
        # casa por ObjectId. A lista consolidada precisa de um id proprio, senao
        # ela nao existe naquele mapa e o import nao acha onde inseri-la.
        gvl_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"plc-codex/globalvars/{export_stem}"))
        # A lista consolidada nao e mais nenhuma das do fabricante, entao o
        # objectid dela e novo e o herdado sai junto com o resto do conteudo.
        alvo[:] = generated_flat
        objectid=ET.SubElement(ET.SubElement(alvo,q("addData")),q("data"),
                               {"name":"http://www.3s-software.com/plcopenxml/objectid",
                                "handleUnknown":"discard"})
        ET.SubElement(objectid,q("ObjectId")).text=gvl_id
        for extra in original_gvls[1:]:
            for pai in original_root.iter():
                if extra in list(pai):
                    pai.remove(extra)
                    break
        # O mapa herdado ainda aponta para as 25 listas antigas. Troca as
        # entradas mortas pela lista consolidada e descarta o que nao existe.
        existentes={node.text for node in original_root.iter() if node.tag.split("}")[-1]=="ObjectId" and node.text}
        for estrutura in (x for x in original_root.iter() if x.tag.split("}")[-1]=="ProjectStructure"):
            substituido=False
            for pai in list(estrutura.iter()):
                for filho in list(pai):
                    if filho.tag.split("}")[-1]!="Object": continue
                    if filho.get("ObjectId") in existentes: continue
                    if not substituido:
                        filho.set("Name","GlobalVars"); filho.set("ObjectId",gvl_id); substituido=True
                    else:
                        pai.remove(filho)
    elif original_gvls:
        generated_globals={item.get("name"):item for item in resource if item.tag.split("}")[-1]=="globalVars"}
        global_file_to_name={Path(item["file"]).stem:item["name"] for item in import_manifest.get("globalVars",[])}
        generated_by_original={global_file_to_name.get(stem,stem):node for stem,node in generated_globals.items()}
        for original_gvl in original_gvls:
            generated=generated_by_original.get(original_gvl.get("name"))
            if generated is None: continue
            preserved=[copy.deepcopy(x) for x in original_gvl if x.tag.split("}")[-1]!="variable"]
            original_gvl[:] = [copy.deepcopy(x) for x in generated if x.tag.split("}")[-1]=="variable"] + preserved
    tree=original_tree
    xml_path=OUT/f"{export_stem}_PLC_Codex.xml"
else:
    tree=ET.ElementTree(root)
    xml_path=OUT/f"{export_stem}_PLC_Codex.xml"
ET.indent(tree,space="  "); tree.write(xml_path,encoding="utf-8",xml_declaration=True)

# O ElementTree serializa o corpo ST como <html:xhtml>, com o prefixo declarado
# na raiz. E XML equivalente, mas o MasterTool e o CODESYS esperam a forma que
# eles mesmos escrevem, <xhtml xmlns="...">, e ignoram o corpo caso contrario.
texto = xml_path.read_text(encoding="utf-8")
texto = re.sub(r"<html:xhtml(\s*/?)>",
               lambda m: f'<xhtml xmlns="{XHTML}"{m.group(1) or ""}>', texto)
texto = texto.replace("</html:xhtml>", "</xhtml>")
if "html:" not in texto:
    texto = texto.replace(f' xmlns:html="{XHTML}"', "")
xml_path.write_text(texto, encoding="utf-8")

ordered=[]
for folder in ("types","functions","blocks","globals","programs"):
    for source in files(folder): ordered.append(f"(* ===== {folder}/{source.name} ===== *)\n{source_text(source).strip()}\n")
bundle=OUT/f"{export_stem}_Completo.st"; bundle.write_text("\n".join(ordered),encoding="utf-8")
print(f"PLCopenXML: {xml_path}")
print(f"ST consolidado: {bundle}")
