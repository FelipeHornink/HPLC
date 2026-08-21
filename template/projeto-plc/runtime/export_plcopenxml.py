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
    # Estrategia de fidelidade: o XML exportado difere do original apenas no
    # texto do corpo das POUs. Interface, GVLs, ProjectStructure e extensoes do
    # fabricante ficam intactas. Assim o arquivo importa onde o original importa,
    # e o diff estrutural e verificavel: so <xhtml> muda.
    #
    # Para isso o ST volta a forma do fabricante: o prefixo da lista global
    # desfaz-se em acesso qualificado, e os servicos de sistema voltam a ser a
    # chamada de biblioteca original. As duas transformacoes estao registradas
    # no manifesto da importacao.
    reverse={}
    for entry in import_manifest.get("globalVars",[]):
        prefix=entry.get("prefix") or f"{entry['name']}_"
        for member in entry.get("members",[]):
            reverse[f"{prefix}{member}"]=f"{entry['name']}.{member}"
    ordenados=sorted(reverse, key=len, reverse=True)
    servicos=import_manifest.get("adaptations",{}).get("systemServices",{})
    desfaz_servico=[]
    if "SysTimeCore.SysTimeGetUs" in servicos:
        desfaz_servico.append((re.compile(r"(\w+)\s*:=\s*Sistema_TempoUs\s*;", re.I), r"SysTimeCore.SysTimeGetUs(\1);"))
    if "GetDateAndTime" in servicos:
        desfaz_servico.append((re.compile(r"(\w+)\s*:=\s*Sistema_DataHora\s*;", re.I), r"GetDateAndTime(\1);"))
    if "NextoStandard.GetDayOfWeek" in servicos:
        desfaz_servico.append((re.compile(r"\bSistema_DiaDaSemana\b", re.I), "NextoStandard.GetDayOfWeek()"))

    def para_o_fabricante(codigo):
        for padrao, troca in desfaz_servico:
            codigo=padrao.sub(troca, codigo)
        for flat in ordenados:
            codigo=re.sub(rf"(?<![.\w]){re.escape(flat)}(?![\w])", reverse[flat], codigo)
        return codigo

    generated_bodies={}
    for item in pous:
        body=next((x for x in item if x.tag.split("}")[-1]=="body"),None)
        if body is None: continue
        texto=next(((x.text or "") for x in body.iter() if x.tag.split("}")[-1]=="xhtml"),"")
        generated_bodies[item.get("name")]=para_o_fabricante(texto)

    # O MasterTool 3.76 exporta <pouInstance typeName=""> vazio, e o esquema TC6
    # exige o tipo. Sem ele o importador nao vincula a tarefa ao programa. Quando
    # existe uma POU com o mesmo nome da instancia, o vinculo e obvio e a
    # correcao fica registrada em correcoes_aplicadas.
    nomes_pou={item.get("name") for item in original_root.iter() if item.tag.split("}")[-1]=="pou"}
    correcoes=[]
    for instancia in (x for x in original_root.iter() if x.tag.split("}")[-1]=="pouInstance"):
        if instancia.get("typeName"): continue
        nome=instancia.get("name") or ""
        if nome in nomes_pou:
            instancia.set("typeName",nome)
            correcoes.append(f'pouInstance {nome}: typeName vazio preenchido com "{nome}"')
        else:
            correcoes.append(f"pouInstance {nome}: typeName vazio e sem POU de mesmo nome; nao corrigido")

    trocados=0
    for original_pou in (item for item in original_root.iter() if item.tag.split("}")[-1]=="pou"):
        codigo=generated_bodies.get(original_pou.get("name"))
        if codigo is None: continue
        body=next((x for x in original_pou if x.tag.split("}")[-1]=="body"),None)
        if body is None: continue
        destino=next((x for x in body.iter() if x.tag.split("}")[-1]=="xhtml"),None)
        if destino is None: continue
        # Corpo grafico permanece grafico: substituir por ST mudaria a linguagem
        # da POU, e a conversao para ST existe apenas para o simulador.
        if next((x for x in body if x.tag.split("}")[-1]!="ST"),None) is not None: continue
        destino.text=codigo
        trocados+=1
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
for aviso in correcoes:
    print(f"Correcao: {aviso}")
# Perfil portatil: a aplicacao vale em qualquer fabricante, a descricao de
# hardware nao. Os blocos <data name="Device"> embutem um dump proprietario dos
# modulos Nexto e, apesar de marcados handleUnknown="discard", o importador do
# CODESYS 3.5.22 tenta interpreta-los e aborta com erro generico de documento
# XML antes de processar qualquer POU. Sao 92% do tamanho do arquivo.
if original_path.exists():
    portatil=ET.parse(xml_path)
    raiz=portatil.getroot()
    removidos=0
    for pai in list(raiz.iter()):
        for filho in list(pai):
            if filho.tag.split("}")[-1]=="data" and filho.get("name")=="Device":
                pai.remove(filho); removidos+=1
    # addData que ficou sem conteudo, e configuracao de modulo que so existia
    # para carregar esse dump, saem tambem.
    vazios=0
    for _ in range(3):
        for pai in list(raiz.iter()):
            for filho in list(pai):
                nome=filho.tag.split("}")[-1]
                if nome=="addData" and len(filho)==0:
                    pai.remove(filho); vazios+=1
                elif nome=="configuration" and filho.get("name")!="Device" and len(filho)==0:
                    pai.remove(filho); vazios+=1
    destino=OUT/f"{export_stem}_Aplicacao.xml"
    ET.indent(portatil,space="  "); portatil.write(destino,encoding="utf-8",xml_declaration=True)
    texto=destino.read_text(encoding="utf-8")
    texto=re.sub(r"<html:xhtml(\s*/?)>", lambda m: f'<xhtml xmlns="{XHTML}"{m.group(1) or ""}>', texto)
    texto=texto.replace("</html:xhtml>","</xhtml>")
    if "html:" not in texto:
        texto=texto.replace(f' xmlns:html="{XHTML}"', "")
    destino.write_text(texto, encoding="utf-8")
    print(f"Portatil: {destino}")
    print(f"   {removidos} dumps de hardware e {vazios} nos vazios removidos; "
          f"{destino.stat().st_size // 1024} KB contra {xml_path.stat().st_size // 1024} KB")

# Perfil neutro: para levar a logica a um projeto que nao e o de origem.
#
# MasterTool e CODESYS nao usam types/pous; ambos guardam POU e DUT dentro da
# extensao http://www.3s-software.com/plcopenxml/pou, e amarram cada objeto ao
# GUID do pai pelo ProjectStructure. Importar num projeto diferente falha porque
# o Application de destino tem outro GUID: o objeto nao tem onde se encaixar, e
# a lista de itens insereveis sai vazia mesmo com o alvo certo selecionado.
#
# Sem ProjectStructure e sem ObjectId nao ha vinculo a resolver, e o importador
# insere no no selecionado. A descricao de hardware sai junto, porque descreve
# um CP que o destino nao tem.
if original_path.exists():
    neutro=ET.parse(xml_path)
    raiz=neutro.getroot()
    contagem={"Device":0,"ObjectId":0,"ProjectStructure":0,"configuration":0}
    for _ in range(4):
        for pai in list(raiz.iter()):
            for filho in list(pai):
                nome=filho.tag.split("}")[-1]
                alvo=filho.get("name") or ""
                if nome=="data" and alvo=="Device":
                    pai.remove(filho); contagem["Device"]+=1
                elif nome=="data" and alvo.endswith("/objectid"):
                    pai.remove(filho); contagem["ObjectId"]+=1
                elif nome=="data" and alvo.endswith("/projectstructure"):
                    pai.remove(filho); contagem["ProjectStructure"]+=1
                elif nome=="configuration" and filho.get("name")!="Device":
                    pai.remove(filho); contagem["configuration"]+=1
                elif nome=="addData" and len(filho)==0:
                    pai.remove(filho)
    destino=OUT/f"{export_stem}_Neutro.xml"
    ET.indent(neutro,space="  "); neutro.write(destino,encoding="utf-8",xml_declaration=True)
    texto=destino.read_text(encoding="utf-8")
    texto=re.sub(r"<html:xhtml(\s*/?)>", lambda m: f'<xhtml xmlns="{XHTML}"{m.group(1) or ""}>', texto)
    texto=texto.replace("</html:xhtml>","</xhtml>")
    if "html:" not in texto:
        texto=texto.replace(f' xmlns:html="{XHTML}"', "")
    destino.write_text(texto, encoding="utf-8")
    print(f"Neutro: {destino}")
    print("   removidos: " + ", ".join(f"{v} {k}" for k, v in contagem.items() if v)
          + f"; {destino.stat().st_size // 1024} KB")

print(f"PLCopenXML: {xml_path}")
print(f"ST consolidado: {bundle}")
