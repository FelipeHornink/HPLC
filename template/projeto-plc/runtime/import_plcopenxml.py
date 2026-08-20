#!/usr/bin/env python3
"""Importa PLCopenXML para fontes ST navegáveis ou para um projeto ativo."""
from pathlib import Path
import argparse
import json
import re
import xml.etree.ElementTree as ET
import shutil


def local(element):
    return element.tag.split("}")[-1]


def child(element, name):
    return next((item for item in element if local(item) == name), None)


def descendants(element, name):
    return [item for item in element.iter() if local(item) == name]


def safe_name(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def render_type(container):
    if container is None or not list(container):
        return "UNKNOWN"
    item = list(container)[0]
    tag = local(item)
    if tag == "derived":
        return item.get("name", "UNKNOWN")
    if tag == "array":
        dimensions = [f"{d.get('lower', '0')}..{d.get('upper', '0')}" for d in item if local(d) == "dimension"]
        return f"ARRAY [{', '.join(dimensions)}] OF {render_type(child(item, 'baseType'))}"
    if tag in {"string", "wstring"}:
        length = item.get("length")
        return tag.upper() + (f"({length})" if length else "")
    if tag in {"subrangeSigned", "subrangeUnsigned"}:
        limits = child(item, "range")
        base = render_type(child(item, "baseType"))
        return f"{base} ({limits.get('lower')}..{limits.get('upper')})" if limits is not None else base
    return tag.upper()


def simple_initial(variable):
    initial = child(variable, "initialValue")
    value = child(initial, "simpleValue") if initial is not None else None
    return value.get("value") if value is not None else None


def variable_line(variable):
    name = variable.get("name", "SemNome")
    address = variable.get("address")
    declaration = f"    {name}"
    if address:
        declaration += f" AT {address}"
    declaration += f" : {render_type(child(variable, 'type'))}"
    initial = simple_initial(variable)
    if initial is not None:
        declaration += f" := {initial}"
    return declaration + ";"


SECTION_NAMES = {
    "localVars": "VAR",
    "tempVars": "VAR_TEMP",
    "inputVars": "VAR_INPUT",
    "outputVars": "VAR_OUTPUT",
    "inOutVars": "VAR_IN_OUT",
    "externalVars": "VAR_EXTERNAL",
}


def render_interface(interface):
    lines = []
    if interface is None:
        return lines
    for section in interface:
        section_name = SECTION_NAMES.get(local(section))
        if not section_name:
            continue
        lines.append(section_name)
        lines.extend(variable_line(variable) for variable in section if local(variable) == "variable")
        lines.append("END_VAR")
    return lines


def render_pou(pou):
    name = pou.get("name")
    pou_type = pou.get("pouType")
    keyword = {"program": "PROGRAM", "functionBlock": "FUNCTION_BLOCK", "function": "FUNCTION"}.get(pou_type, "PROGRAM")
    interface = child(pou, "interface")
    declaration = f"{keyword} {name}"
    if keyword == "FUNCTION" and interface is not None:
        return_type = child(interface, "returnType")
        if return_type is not None:
            declaration += f" : {render_type(return_type)}"
    lines = [declaration, *render_interface(interface)]
    body = child(pou, "body")
    body_kind = local(list(body)[0]) if body is not None and list(body) else "unknown"
    implementation = ""
    if body_kind == "ST":
        st = list(body)[0]
        text = next(((item.text or "") for item in st.iter() if local(item) == "xhtml"), "")
        implementation = text.rstrip()
    elif body_kind in {"LD", "FBD"}:
        implementation = graphical_to_st(list(body)[0], name)
    else:
        raise ValueError(f"POU {name}: linguagem {body_kind} não pode ser convertida automaticamente para ST")
    if implementation:
        lines.extend(["", implementation])
    lines.append({"PROGRAM": "END_PROGRAM", "FUNCTION_BLOCK": "END_FUNCTION_BLOCK", "FUNCTION": "END_FUNCTION"}[keyword])
    return "\n".join(lines) + "\n", body_kind, body


def graphical_to_st(graphic, pou_name):
    """Converte chamadas de blocos LD/FBD em ST mantendo a ordem do XML.

    Redes booleanas ainda não suportadas falham explicitamente; nunca produzimos
    uma implementação vazia fingindo que a conversão deu certo.
    """
    nodes = {item.get("localId"): item for item in graphic if item.get("localId")}
    unsupported = [local(item) for item in graphic if local(item) in {"contact", "coil", "jump", "return", "selectionDivergence", "simultaneousDivergence"}]
    if unsupported:
        raise ValueError(f"POU {pou_name}: rede {unsupported[0]} ainda não suportada pelo conversor LD/FBD")
    statements = []
    for block in (item for item in graphic if local(item) == "block"):
        block_type = block.get("typeName", "")
        instance = block.get("instanceName") or block_type
        arguments = []
        inputs = child(block, "inputVariables")
        for variable in list(inputs) if inputs is not None else []:
            formal = variable.get("formalParameter")
            if formal in {None, "EN"}: continue
            point = child(variable, "connectionPointIn")
            connection = child(point, "connection") if point is not None else None
            source = nodes.get(connection.get("refLocalId")) if connection is not None else None
            expression = child(source, "expression").text if source is not None and child(source, "expression") is not None else None
            if expression and expression.strip(): arguments.append(f"{formal} := {expression.strip()}")
        outputs = child(block, "outputVariables")
        for variable in list(outputs) if outputs is not None else []:
            formal = variable.get("formalParameter")
            if formal in {None, "ENO"}: continue
            point = child(variable, "connectionPointOut")
            expression = child(point, "expression") if point is not None else None
            if expression is not None and (expression.text or "").strip(): arguments.append(f"{formal} => {expression.text.strip()}")
        statements.append(f"{instance}({', '.join(arguments)});")
    if not statements:
        return f"(* {pou_name}: diagrama original sem lógica executável. *)"
    return "(* Convertido automaticamente de LD/FBD para ST. *)\n" + "\n".join(statements)


def render_data_type(data_type):
    name = data_type.get("name")
    base = child(data_type, "baseType")
    item = list(base)[0] if base is not None and list(base) else None
    if item is not None and local(item) == "struct":
        lines = [f"TYPE {name} :", "STRUCT"]
        lines.extend(variable_line(variable) for variable in item if local(variable) == "variable")
        lines.extend(["END_STRUCT;", "END_TYPE"])
        return "\n".join(lines) + "\n"
    if item is not None and local(item) == "enum":
        values = [value.get("name") for value in descendants(item, "value")]
        return f"TYPE {name} : ({', '.join(values)});\nEND_TYPE\n"
    return f"TYPE {name} : {render_type(base)};\nEND_TYPE\n"


def render_gvl(gvl):
    lines = [f"(* GVL original: {gvl.get('name', 'sem nome')} *)", "VAR_GLOBAL"]
    lines.extend(variable_line(variable) for variable in gvl if local(variable) == "variable")
    lines.append("END_VAR")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xml", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--active", action="store_true", help="gera types/functions/blocks/programs/globals no projeto de destino")
    args = parser.parse_args()
    root = ET.parse(args.xml).getroot()
    output = args.output
    for folder in (("programs", "functions", "blocks", "types", "globals", "plcopen") if args.active else ("pous", "types", "globals")):
        (output / folder).mkdir(parents=True, exist_ok=True)

    if args.active:
        shutil.copy2(args.xml, output / "plcopen" / "original.xml")

    manifest = {"source": str(args.xml), "pous": [], "dataTypes": [], "globalVars": [], "libraries": [], "diagnostics": {}}
    pous = [item for item in root.iter() if local(item) == "pou"]
    for index, pou in enumerate(pous, 1):
        source, body_kind, body = render_pou(pou)
        stem = f"{index:02d}_{safe_name(pou.get('name'))}"
        folder = {"program": "programs", "functionBlock": "blocks", "function": "functions"}.get(pou.get("pouType"), "programs") if args.active else "pous"
        filename = f"{stem}.st"
        (output / folder / filename).write_text(source, encoding="utf-8")
        if body_kind != "ST" and body is not None and not args.active:
            (output / "pous" / f"{stem}.{body_kind.lower()}.xml").write_text(ET.tostring(body, encoding="unicode"), encoding="utf-8")
        manifest["pous"].append({"name": pou.get("name"), "type": pou.get("pouType"), "originalLanguage": body_kind, "runtimeLanguage": "ST", "file": f"{folder}/{filename}"})

    data_types = [item for item in root.iter() if local(item) == "dataType"]
    for index, data_type in enumerate(data_types, 1):
        filename = f"{index:02d}_{safe_name(data_type.get('name'))}.st"
        (output / "types" / filename).write_text(render_data_type(data_type), encoding="utf-8")
        manifest["dataTypes"].append({"name": data_type.get("name"), "file": f"types/{filename}"})

    gvls = [item for item in root.iter() if local(item) == "globalVars"]
    for index, gvl in enumerate(gvls, 1):
        name = gvl.get("name") or f"GVL_{index}"
        filename = f"{index:02d}_{safe_name(name)}.st"
        (output / "globals" / filename).write_text(render_gvl(gvl), encoding="utf-8")
        manifest["globalVars"].append({"name": name, "file": f"globals/{filename}"})

    libraries = []
    for item in root.iter():
        if local(item) != "Library": continue
        library = {key: item.get(key) for key in ("Name", "Namespace", "DefaultResolution", "SystemLibrary") if item.get(key) is not None}
        libraries.append(library)
    manifest["libraries"] = libraries
    defined = {item.get("name", "").lower() for item in root.iter() if local(item) in {"pou", "dataType"}}
    builtins = {"BOOL","BYTE","WORD","DWORD","LWORD","SINT","USINT","INT","UINT","DINT","UDINT","LINT","ULINT","REAL","LREAL","TIME","DATE","TOD","DT","STRING","WSTRING","TON","TOF","TP","R_TRIG","F_TRIG","CTU","CTD","CTUD"}
    unresolved_types = sorted({item.get("name") for item in root.iter() if local(item) == "derived" and item.get("name", "").lower() not in defined and item.get("name", "").upper() not in builtins})
    unresolved_blocks = sorted({item.get("typeName") for item in root.iter() if local(item) == "block" and item.get("typeName", "").lower() not in defined and item.get("typeName", "").upper() not in builtins}, key=str.lower)
    conversions = [{"name": item["name"], "from": item["originalLanguage"], "to": "ST", "file": item["file"]} for item in manifest["pous"] if item["originalLanguage"] != "ST"]
    manifest["diagnostics"] = {
        "status": "pending" if unresolved_types or unresolved_blocks else "ready",
        "unresolvedTypes": unresolved_types,
        "unresolvedBlocks": unresolved_blocks,
        "conversions": conversions,
        "notes": ["Bibliotecas proprietárias são preservadas como referências no XML; para simulação, seus tipos/blocos precisam de implementação compatível."] if libraries else [],
    }

    manifest_path = output / ("plcopen/manifest.json" if args.active else "manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.active:
        diagnostic = manifest["diagnostics"]
        report = [
            f"# Relatório de importação — {args.xml.name}", "",
            f"**Status:** {'PENDÊNCIAS DE COMPATIBILIDADE' if diagnostic['status'] == 'pending' else 'PRONTO'}", "",
            f"- {len(pous)} POUs importadas em ST", f"- {len(data_types)} DUTs", f"- {len(gvls)} GVLs",
            f"- {len(conversions)} conversões LD/FBD → ST", f"- {len(libraries)} referências de biblioteca preservadas", "",
            "## Conversões para ST", "",
            *([f"- `{item['name']}`: {item['from']} → ST (`{item['file']}`)" for item in conversions] or ["- Nenhuma; todas as POUs já eram ST."]), "",
            "## Tipos ou blocos externos pendentes", "",
            *([f"- Tipo `{name}`" for name in unresolved_types] + [f"- Bloco `{name}`" for name in unresolved_blocks] or ["- Nenhum."]), "",
            "## Bibliotecas declaradas no XML", "",
            *([f"- `{item.get('DefaultResolution') or item.get('Name')}`" for item in libraries] or ["- Nenhuma."]), "",
            "> Pendência não remove conteúdo do export. Ela indica o que precisa de uma implementação portátil para executar no simulador.", ""
        ]
        (output / "plcopen" / "IMPORT_REPORT.md").write_text("\n".join(report), encoding="utf-8")
    readme = f"""# Referência importada do MasterTool

Fonte: `{args.xml}`

- {len(pous)} POUs ({sum(1 for p in manifest['pous'] if p['originalLanguage'] == 'ST')} originalmente ST e {sum(1 for p in manifest['pous'] if p['originalLanguage'] != 'ST')} convertidas para ST)
- {len(data_types)} DUTs
- {len(gvls)} GVLs

Todos os arquivos ativos são Structured Text. Diagramas LD/FBD foram convertidos
para ST durante a importação quando `--active` foi usado.
O XML original continua sendo a autoridade para IDs, configuração do dispositivo e
extensões específicas do MasterTool.
"""
    (output / ("plcopen/README.md" if args.active else "README.md")).write_text(readme, encoding="utf-8")
    print(f"Importados {len(pous)} POUs, {len(data_types)} DUTs e {len(gvls)} GVLs em {output}")


if __name__ == "__main__":
    main()
