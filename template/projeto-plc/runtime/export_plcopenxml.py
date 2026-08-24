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

def normalizar(texto):
    """Ajusta a serializacao do ElementTree a forma que os fabricantes escrevem.

    O corpo ST sai como <html:xhtml>, com o prefixo declarado na raiz; e XML
    equivalente, mas os importadores sao literais e esperam <xhtml xmlns="...">.
    A declaracao sai com aspas simples, incomum em exportador .NET.
    """
    texto = re.sub(r"<html:xhtml(\s*/?)>", lambda m: f'<xhtml xmlns="{XHTML}"{m.group(1) or ""}>', texto)
    texto = texto.replace("</html:xhtml>", "</xhtml>")
    if "html:" not in texto:
        texto = texto.replace(f' xmlns:html="{XHTML}"', "")
    return texto.replace("<?xml version='1.0' encoding='utf-8'?>", '<?xml version="1.0" encoding="utf-8"?>', 1)


def safe(valor): return re.sub(r"[^A-Za-z0-9_.-]+", "_", valor)


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
header=ET.SubElement(root,q("contentHeader"),{"name":f"{export_stem}_Completo","modificationDateTime":dt.datetime.now(dt.timezone.utc).isoformat()})
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

# POU costuma comecar com comentario de cabecalho, e o re.match e ancorado no
# inicio do texto: a declaracao nao era encontrada, add_pou saia calado e a POU
# desaparecia do XML sem erro nenhum. Procurar com re.search nao serve, porque o
# proprio comentario cita "PROGRAM Main". Entao o cabecalho e separado antes.
def fim_do_comentario(texto):
    """Indice depois do *) que fecha o comentario aberto em 0, ou -1.

    A norma permite comentario aninhado desde a 3a edicao, e o cabecalho do Main
    cita "(* @ROUTINE *)" dentro do proprio comentario. Fechar no primeiro *)
    deixaria o resto do cabecalho passando por codigo.
    """
    profundidade=0; i=0
    while i < len(texto)-1:
        if texto[i:i+2]=="(*": profundidade+=1; i+=2; continue
        if texto[i:i+2]=="*)":
            profundidade-=1; i+=2
            if profundidade==0: return i
            continue
        i+=1
    return -1


def separa_prefacio(text):
    while True:
        resto=text.lstrip()
        if resto.startswith("(*"):
            fim=fim_do_comentario(resto)
            if fim<0: return resto
            text=resto[fim:]
        elif resto.startswith("//"):
            quebra=resto.find("\n")
            if quebra<0: return ""
            text=resto[quebra+1:]
        else:
            return resto


sem_declaracao=[]


def add_pou(source):
    text=separa_prefacio(source_text(source).strip())
    head=re.match(r"(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)(?:\s*:\s*(\w+))?",text,re.I)
    if not head:
        sem_declaracao.append(source)
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
# Exportar um XML sem a POU e pior do que falhar: o arquivo abre no software de
# destino e parece completo.
if sem_declaracao:
    raise SystemExit("Sem PROGRAM/FUNCTION_BLOCK/FUNCTION reconhecido em:\n  "
                     + "\n  ".join(str(x.relative_to(ROOT)) for x in sem_declaracao))

instances=ET.SubElement(root,q("instances")); configurations=ET.SubElement(instances,q("configurations")); config=ET.SubElement(configurations,q("configuration"),{"name":"Config0"}); resource=ET.SubElement(config,q("resource"),{"name":"Application"})
for source in files("globals"):
    text=source.read_text(encoding="utf-8")
    for index,m in enumerate(re.finditer(r"VAR_GLOBAL(.*?)END_VAR",text,re.S|re.I)):
        name=source.stem if index==0 else f"{source.stem}_{index+1}"
        holder=ET.SubElement(resource,q("globalVars"),{"name":name})
        for item in declarations(m.group(1)): add_variable(holder,item)
task=ET.SubElement(resource,q("task"),{"name":"MainTask","interval":"PT0.01S","priority":"10"})
ET.SubElement(task,q("pouInstance"),{"name":"MainInstance","typeName":"Main"})

def corpo_st(item):
    body=next((x for x in item if x.tag.split("}")[-1]=="body"),None)
    if body is None: return None
    return next(((x.text or "") for x in body.iter() if x.tag.split("}")[-1]=="xhtml"),"")


original_path=ROOT/"plcopen"/"original.xml"
# Projeto que nao veio de importacao nao passa pelo ramo abaixo, mas o relatorio
# de correcoes e os arquivos por rotina sao gerados sempre. Sem XML original nao
# ha nomenclatura de fabricante para desfazer: o corpo e o proprio ST do projeto.
correcoes=[]
generated_bodies={item.get("name"):corpo for item in pous
                  if (corpo:=corpo_st(item)) is not None}
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

    generated_bodies={nome:para_o_fabricante(corpo) for nome,corpo in generated_bodies.items()}

    # O MasterTool 3.76 exporta <pouInstance typeName=""> vazio, e o esquema TC6
    # exige o tipo. Sem ele o importador nao vincula a tarefa ao programa. Quando
    # existe uma POU com o mesmo nome da instancia, o vinculo e obvio e a
    # correcao fica registrada em correcoes_aplicadas.
    nomes_pou={item.get("name") for item in original_root.iter() if item.tag.split("}")[-1]=="pou"}
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
    xml_path=OUT/f"{export_stem}_Completo.xml"
else:
    tree=ET.ElementTree(root)
    xml_path=OUT/f"{export_stem}_Completo.xml"
ET.indent(tree,space="  "); tree.write(xml_path,encoding="utf-8",xml_declaration=True)

# O ElementTree serializa o corpo ST como <html:xhtml>, com o prefixo declarado
# na raiz. E XML equivalente, mas o MasterTool e o CODESYS esperam a forma que
# eles mesmos escrevem, <xhtml xmlns="...">, e ignoram o corpo caso contrario.
xml_path.write_text(normalizar(xml_path.read_text(encoding="utf-8")), encoding="utf-8")

ordered=[]
for folder in ("types","functions","blocks","globals","programs"):
    for source in files(folder): ordered.append(f"(* ===== {folder}/{source.name} ===== *)\n{source_text(source).strip()}\n")
bundle=OUT/f"{export_stem}_ST.st"; bundle.write_text("\n".join(ordered),encoding="utf-8")
for aviso in correcoes:
    print(f"Correcao: {aviso}")
# Arquivo da aplicacao: so a logica, na forma que a norma TC6 descreve, sem
# nenhuma extensao de fabricante. E o que se leva para qualquer software.
#
# Nem o MasterTool nem o CODESYS escrevem assim: os dois deixam types/pous vazio,
# guardam POU e DUT dentro de addData proprietario e amarram cada objeto ao GUID
# do pai pelo ProjectStructure. Isso faz o arquivo deles servir de round-trip do
# proprio projeto, nao de intercambio. Aqui o arquivo e montado do zero.
if original_path.exists():
    aplicacao=ET.Element(q("project"))
    agora=dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    ET.SubElement(aplicacao,q("fileHeader"),{
        "companyName":"PLC Codex","productName":"PLC Codex","productVersion":"1.0",
        "creationDateTime":agora})
    cabecalho=ET.SubElement(aplicacao,q("contentHeader"),{"name":export_stem,"modificationDateTime":agora})
    coordenadas=ET.SubElement(cabecalho,q("coordinateInfo"))
    for lingua in ("fbd","ld","sfc"):
        ET.SubElement(ET.SubElement(coordenadas,q(lingua)),q("scaling"),{"x":"1","y":"1"})
    tipos=ET.SubElement(aplicacao,q("types"))
    destino_dt=ET.SubElement(tipos,q("dataTypes"))
    destino_pou=ET.SubElement(tipos,q("pous"))

    def sem_extensao(no):
        limpo=copy.deepcopy(no)
        for _ in range(4):
            for pai in list(limpo.iter()):
                for filho in list(pai):
                    if filho.tag.split("}")[-1]=="addData":
                        pai.remove(filho)
        return limpo

    for item in (x for x in original_root.iter() if x.tag.split("}")[-1]=="dataType"):
        destino_dt.append(sem_extensao(item))
    # Corpo grafico nao e portatil: as redes LD e FBD do fabricante dependem de
    # <vendorElement> cujo conteudo vive em addData proprietario. Sem o addData o
    # elemento fica incompleto e o esquema recusa; com ele o arquivo deixa de ser
    # neutro. No arquivo da aplicacao toda POU leva ST, que e a forma que qualquer
    # ferramenta le. O Ladder original continua no arquivo completo.
    graficas=[]
    for item in (x for x in original_root.iter() if x.tag.split("}")[-1]=="pou"):
        copia=sem_extensao(item)
        corpo=next((x for x in copia if x.tag.split("}")[-1]=="body"), None)
        codigo=generated_bodies.get(item.get("name"))
        if corpo is not None and codigo is not None:
            linguagem=next((x.tag.split("}")[-1] for x in corpo), None)
            if linguagem and linguagem != "ST":
                graficas.append(f"{item.get('name')} ({linguagem})")
            copia.remove(corpo)
            novo_corpo=ET.SubElement(copia,q("body"))
            ET.SubElement(ET.SubElement(novo_corpo,q("ST")),f"{{{XHTML}}}xhtml").text=codigo
            # body vem antes de documentation e addData na sequencia do esquema
            ordem=["interface","actions","transitions","body","documentation","addData"]
            copia[:] = sorted(copia, key=lambda c: ordem.index(c.tag.split("}")[-1])
                              if c.tag.split("}")[-1] in ordem else len(ordem))
        destino_pou.append(copia)
    instancias=ET.SubElement(aplicacao,q("instances"))
    configuracoes=ET.SubElement(instancias,q("configurations"))
    configuracao=ET.SubElement(configuracoes,q("configuration"),{"name":"Config"})
    recurso=ET.SubElement(configuracao,q("resource"),{"name":"Application"})
    # A norma nao permite VAR_GLOBAL e VAR_GLOBAL CONSTANT na mesma lista, e o
    # importador do CODESYS recusa o arquivo por causa disso. O MasterTool exporta
    # Special_Variables em tres blocos, dois normais e um constante. Aqui os
    # blocos de mesma natureza sao unidos e o bloco constante ganha lista propria.
    listas={}
    for gvl in (x for x in original_root.iter() if x.tag.split("}")[-1]=="globalVars"):
        base=gvl.get("name") or "GlobalVars"
        constante=gvl.get("constant")=="true"
        chave=(base, constante)
        atual=listas.get(chave)
        if atual is None:
            limpo=sem_extensao(gvl)
            limpo.set("name", f"{base}_Const" if constante else base)
            listas[chave]=limpo
        else:
            vistos={v.get("name") for v in atual if v.tag.split("}")[-1]=="variable"}
            for v in sem_extensao(gvl):
                if v.tag.split("}")[-1]=="variable" and v.get("name") not in vistos:
                    atual.append(v); vistos.add(v.get("name"))
    renomeadas=[chave[0] for chave in listas if chave[1] and (chave[0], False) in listas]
    # O esquema TC6 fixa a ordem dos filhos de <resource>: task, globalVars,
    # pouInstance, documentation, addData. Emitir globalVars antes do task faz o
    # CODESYS recusar o arquivo inteiro com "elemento filho 'task' invalido".
    for tarefa in (x for x in original_root.iter() if x.tag.split("}")[-1]=="task"):
        recurso.append(sem_extensao(tarefa))
    for lista in listas.values():
        recurso.append(lista)

    ORDEM_RESOURCE=["task","globalVars","pouInstance","documentation","addData"]
    ORDEM_POU=["interface","actions","transitions","body","documentation","addData"]
    for no, ordem in ((recurso, ORDEM_RESOURCE), *((x, ORDEM_POU) for x in destino_pou)):
        indices=[ordem.index(c.tag.split("}")[-1]) for c in no if c.tag.split("}")[-1] in ordem]
        if indices != sorted(indices):
            raise SystemExit(f"ordem de filhos fora do esquema em <{no.tag.split('}')[-1]}>: "
                             f"{[c.tag.split('}')[-1] for c in no][:6]}")

    destino=OUT/f"{export_stem}_Aplicacao.xml"
    arvore=ET.ElementTree(aplicacao)
    ET.indent(arvore,space="  "); arvore.write(destino,encoding="utf-8",xml_declaration=True)
    destino.write_text(normalizar(destino.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"Aplicacao: {destino}")
    print(f"   {len(destino_pou)} POUs, {len(destino_dt)} DUTs e "
          f"{len([x for x in recurso if x.tag.split('}')[-1]=='globalVars'])} GVLs, "
          f"sem extensao de fabricante; {destino.stat().st_size // 1024} KB")
    if graficas:
        print(f"   {len(graficas)} POUs graficas convertidas para ST: {', '.join(graficas)}")
    for base in renomeadas:
        print(f"   Lista {base} tinha bloco constante e normal juntos; o constante "
              f"virou {base}_Const, como a norma exige.")

# Rotinas soltas: um arquivo ST por POU, para colar uma de cada vez em qualquer
# IDE. E o caminho que sempre funciona, sem depender de importador.
rotinas=OUT/"rotinas"
for antigo in rotinas.glob("*.st"):
    antigo.unlink()
rotinas.mkdir(exist_ok=True)
escritas=0
for nome, codigo in sorted(generated_bodies.items()):
    fonte=next((x for pasta in ("programs","blocks","functions")
                for x in files(pasta)
                if re.search(rf"\b(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+{re.escape(nome)}\b",
                             x.read_text(encoding="utf-8"), re.I)), None)
    if fonte is None:
        continue
    texto=fonte.read_text(encoding="utf-8")
    declaracoes=texto[:texto.lower().rfind("end_var")+len("end_var")] if "end_var" in texto.lower() else texto.splitlines()[0]
    fim={"programs":"END_PROGRAM","blocks":"END_FUNCTION_BLOCK","functions":"END_FUNCTION"}[fonte.parent.name]
    (rotinas/f"{safe(nome)}.st").write_text(f"{declaracoes}\n\n{codigo}\n{fim}\n", encoding="utf-8")
    escritas+=1
print(f"Rotinas: {rotinas} ({escritas} arquivos, um por POU)")

print(f"Completo: {xml_path}")
print(f"ST consolidado: {bundle}")
