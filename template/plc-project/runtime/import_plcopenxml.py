#!/usr/bin/env python3
"""Imports PLCopenXML into browsable ST sources or into an active project."""
from pathlib import Path
import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
import shutil

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import msg  # noqa: E402


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


def render_value(value):
    """TC6 initial value in ST syntax.

    simpleValue is the literal; structValue becomes (member := value, ...) and
    arrayValue becomes [a, b, n(c)]. Reading only simpleValue dropped the PT of
    TON, the transmitter scales and every setpoint stored in an array of structs.
    """
    if value is None:
        return None
    tag = local(value)
    if tag == "simpleValue":
        return value.get("value")
    if tag == "structValue":
        members = [f"{item.get('member')} := {text}" for item in value
                   if local(item) == "value" and (text := render_value(next(iter(item), None))) is not None]
        return f"({', '.join(members)})" if members else None
    if tag == "arrayValue":
        elements = []
        for item in value:
            if local(item) != "value":
                continue
            text = render_value(next(iter(item), None))
            if text is None:
                continue
            repetition = item.get("repetitionValue")
            elements.append(f"{repetition}({text})" if repetition and repetition != "1" else text)
        return f"[{', '.join(elements)}]" if elements else None
    return None


def initial_value(variable):
    initial = child(variable, "initialValue")
    return render_value(next(iter(initial), None)) if initial is not None else None


def variable_line(variable):
    name = variable.get("name", "Unnamed")
    address = variable.get("address")
    declaration = f"    {name}"
    if address:
        declaration += f" AT {address}"
    declaration += f" : {render_type(child(variable, 'type'))}"
    initial = initial_value(variable)
    if initial is not None:
        declaration += f" := {initial}"
    return declaration + ";"


def qualifiers(section):
    """RETAIN, PERSISTENT and CONSTANT of the section, in the order CODESYS writes them."""
    return [keyword for attribute, keyword in (("constant", "CONSTANT"), ("retain", "RETAIN"),
                                               ("persistent", "PERSISTENT"))
            if section.get(attribute) == "true"]


def section_header(keyword, section):
    return " ".join([keyword, *qualifiers(section)])


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
        lines.append(section_header(section_name, section))
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
        implementation, helpers = graphical_to_st(list(body)[0], name)
        if helpers:
            lines.extend(["VAR", LADDER_HELPERS_COMMENT,
                          *(f"    {helper} : {kind};" for helper, kind in helpers), "END_VAR"])
    else:
        raise ValueError(msg("imp_err_language", pou=name, language=body_kind))
    if implementation:
        lines.extend(["", implementation])
    lines.append({"PROGRAM": "END_PROGRAM", "FUNCTION_BLOCK": "END_FUNCTION_BLOCK", "FUNCTION": "END_FUNCTION"}[keyword])
    return "\n".join(lines) + "\n", body_kind, body


# Variables the conversion creates and that do not exist in the XML. The LD_
# prefix sets them apart in the project and lets the export declare them in the
# original interface. The comment below is also the marker the export uses to
# recognize this block (legacy marker: "Criadas na conversao LD -> ST").
LADDER_HELPER_PREFIX = "LD_"
LADDER_HELPERS_COMMENT = ("    (* Created by the LD -> ST conversion: edge memory (LD_P_, LD_N_) and EN of"
                          " a block whose ENO feeds another (LD_ENO_). *)")
# First line of every converted body (legacy: "Convertido automaticamente de LD/FBD para ST.").
LADDER_HEADER = "(* Converted automatically from LD/FBD to ST. *)"
EDGE_BLOCKS = {"rising": ("P", "R_TRIG"), "falling": ("N", "F_TRIG")}


class Network(dict):
    """Network elements by localId, plus the conversion state.

    edges: a P/N contact becomes an R_TRIG/F_TRIG instance, called only once
    before its first use. Calling it at every use would clear Q on the second.
    saved_eno: a block whose ENO feeds another saves its EN in a variable at the
    moment it runs. Recomputing it later would read what the block already
    changed: GT(SEC > 59) -> MOVE 0 -> SEC -> ENO -> ADD MIN never added a minute.
    """

    def __init__(self, graphic):
        super().__init__((item.get("localId"), item) for item in graphic if item.get("localId"))
        self.edges = {}
        self.calls_done = set()
        self.eno_used = []
        self.saved_eno = {item.get("refLocalId") for item in graphic.iter()
                          if local(item) == "connection" and item.get("formalParameter") == "ENO"}

    def edge(self, local_id, edge, clk):
        letter, kind = EDGE_BLOCKS[edge]
        name = f"{LADDER_HELPER_PREFIX}{letter}_{local_id}"
        self.edges.setdefault(name, (kind, clk))
        return name

    def pending_calls(self):
        pending = [f"{name}(CLK := {clk});" for name, (_, clk) in self.edges.items()
                   if name not in self.calls_done]
        self.calls_done.update(self.edges)
        return pending

    def helpers(self):
        return ([(name, kind) for name, (kind, _) in self.edges.items()]
                + [(eno_name(i), "BOOL") for i in self.eno_used])

    def save_eno(self, block, enable):
        """Saved EN for whoever reads the ENO; None when EN is the constant TRUE."""
        local_id = block.get("localId")
        if local_id not in self.saved_eno or enable in (None, "TRUE"):
            return None
        if local_id not in self.eno_used:
            self.eno_used.append(local_id)
        return eno_name(local_id)


def eno_name(local_id):
    return f"{LADDER_HELPER_PREFIX}ENO_{local_id}"


LADDER_UNSUPPORTED = {"jump", "return", "selectionDivergence", "simultaneousDivergence",
                      "selectionConvergence", "simultaneousConvergence"}

# Standard IEC functions drawn as blocks in ladder. They are not instances:
# calling MOVE(In2 := 0, Out2 => X) does not exist in ST, the equivalent is X := 0.
# MasterTool numbers the pins from In2/Out1, because In1 is EN.
STANDARD_BINARY = {"ADD": "+", "SUB": "-", "MUL": "*", "DIV": "/", "MOD": "MOD",
                   "GT": ">", "GE": ">=", "LT": "<", "LE": "<=", "EQ": "=", "NE": "<>",
                   "AND": "AND", "OR": "OR", "XOR": "XOR"}
STANDARD_COPY = {"MOVE"}
STANDARD_UNARY = {"NOT"}
# Boolean result: the rung power must go into the value, otherwise the condition
# upstream of the comparator is lost when chaining into the next block.
BOOLEAN_RESULT = {"GT", "GE", "LT", "LE", "EQ", "NE", "AND", "OR", "XOR", "NOT"}


def standard_function(block):
    name = (block.get("typeName") or "").upper()
    if block.get("instanceName"):
        return None
    return name if name in STANDARD_BINARY or name in STANDARD_COPY or name in STANDARD_UNARY else None


def pin_order(formal):
    digits = re.sub(r"\D", "", formal or "")
    return int(digits) if digits else 0


def block_enable(block, nodes, pou_name, visiting):
    inputs = child(block, "inputVariables")
    enable = next((item for item in (list(inputs) if inputs is not None else [])
                   if item.get("formalParameter") == "EN"), None)
    if enable is None:
        return None
    return rung_expression(enable, nodes, pou_name, visiting)


def function_arguments(block, nodes, pou_name, visiting):
    inputs = child(block, "inputVariables")
    ordered = []
    for variable in (list(inputs) if inputs is not None else []):
        formal = variable.get("formalParameter")
        if formal is None or formal == "EN":
            continue
        ordered.append((pin_order(formal), rung_expression(variable, nodes, pou_name, visiting)))
    return [expression for _, expression in sorted(ordered, key=lambda item: item[0]) if expression]


def function_expression(block, nodes, pou_name, visiting):
    name = standard_function(block)
    arguments = function_arguments(block, nodes, pou_name, visiting)
    if not arguments:
        raise ValueError(msg("imp_err_function_no_inputs", pou=pou_name, function=name))
    if name in STANDARD_COPY:
        return arguments[0]
    if name in STANDARD_UNARY:
        return f"NOT ({arguments[0]})"
    if len(arguments) < 2:
        raise ValueError(msg("imp_err_function_one_input", pou=pou_name, function=name))
    return "(" + f" {STANDARD_BINARY[name]} ".join(arguments) + ")"


def function_targets(block):
    outputs = child(block, "outputVariables")
    targets = []
    for variable in (list(outputs) if outputs is not None else []):
        if variable.get("formalParameter") in {None, "ENO"}:
            continue
        point = child(variable, "connectionPointOut")
        expression = child(point, "expression") if point is not None else None
        text = (expression.text or "").strip() if expression is not None else ""
        if text:
            targets.append(text)
    return targets


def incoming(node):
    """Connections arriving at an element. Several connections mean parallel."""
    point = child(node, "connectionPointIn")
    if point is None:
        return []
    return [(item.get("refLocalId"), item.get("formalParameter"))
            for item in point if local(item) == "connection"]


def join_terms(terms, operator):
    terms = [term for term in terms if term]
    if not terms:
        return None
    if len(terms) == 1:
        return terms[0]
    return "(" + f" {operator} ".join(terms) + ")"


def rung_expression(node, nodes, pou_name, visiting=frozenset()):
    """Boolean expression arriving at the element input; parallel becomes OR."""
    return join_terms(
        [node_expression(ref, formal, nodes, pou_name, visiting) for ref, formal in incoming(node)],
        "OR",
    )


def node_expression(local_id, formal, nodes, pou_name, visiting):
    node = nodes.get(local_id)
    if node is None:
        return None
    if local_id in visiting:
        raise ValueError(msg("imp_err_feedback", pou=pou_name, element=local_id))
    kind = local(node)
    if kind == "leftPowerRail":
        return "TRUE"
    if kind == "inVariable":
        expression = child(node, "expression")
        text = (expression.text or "").strip() if expression is not None else ""
        return text or None
    if kind == "block":
        instance = node.get("instanceName") or node.get("typeName")
        name = standard_function(node)
        if name and formal != "ENO":
            value = function_expression(node, nodes, pou_name, visiting | {local_id})
            if name not in BOOLEAN_RESULT:
                return value
            enable = block_enable(node, nodes, pou_name, visiting | {local_id})
            return join_terms([None if enable in (None, "TRUE") else enable, value], "AND")
        if formal == "ENO":
            if local_id in getattr(nodes, "saved_eno", ()):
                saved = nodes.save_eno(node, block_enable(node, nodes, pou_name, visiting | {local_id}))
                if saved:
                    return saved
            # In a standard block the power passes through: ENO follows EN. Chaining
            # MOVE in series in ladder just continues the same rung condition.
            inputs = child(node, "inputVariables")
            enable = next((item for item in (list(inputs) if inputs is not None else [])
                           if item.get("formalParameter") == "EN"), None)
            if enable is None:
                return "TRUE"
            return rung_expression(enable, nodes, pou_name, visiting | {local_id}) or "TRUE"
        if not formal:
            raise ValueError(msg("imp_err_no_formal", pou=pou_name, block=instance))
        return f"{instance}.{formal}"
    upstream = rung_expression(node, nodes, pou_name, visiting | {local_id})
    if kind == "contact":
        variable = child(node, "variable")
        name = (variable.text or "").strip() if variable is not None else ""
        if not name:
            raise ValueError(msg("imp_err_contact_no_variable", pou=pou_name, element=local_id))
        edge = (node.get("edge") or "none").lower()
        if edge in EDGE_BLOCKS:
            if node.get("negated") == "true":
                raise ValueError(msg("imp_err_contact_negated_edge", pou=pou_name, element=local_id))
            term = f"{nodes.edge(local_id, edge, name)}.Q"
        elif edge != "none":
            raise ValueError(msg("imp_err_contact_edge", pou=pou_name, element=local_id, edge=edge))
        else:
            term = f"NOT {name}" if node.get("negated") == "true" else name
        return join_terms([None if upstream == "TRUE" else upstream, term], "AND")
    return upstream


def negate(expression):
    return f"NOT {expression}" if expression.startswith("(") else f"NOT ({expression})"


def coil_statements(coil, nodes, pou_name):
    variable = child(coil, "variable")
    name = (variable.text or "").strip() if variable is not None else ""
    if not name:
        raise ValueError(msg("imp_err_coil_no_variable", pou=pou_name, element=coil.get("localId")))
    expression = rung_expression(coil, nodes, pou_name) or "FALSE"
    if coil.get("negated") == "true":
        expression = negate(expression)
    lines = []
    edge = (coil.get("edge") or "none").lower()
    if edge in EDGE_BLOCKS:
        # P/N coil: a one-cycle pulse on the edge of the power reaching it.
        instance = nodes.edge(coil.get("localId"), edge, expression)
        lines.extend(nodes.pending_calls())
        expression = f"{instance}.Q"
    elif edge != "none":
        raise ValueError(msg("imp_err_coil_edge", pou=pou_name, element=coil.get("localId"), edge=edge))
    storage = (coil.get("storage") or "").lower()
    if storage in {"set", "reset"}:
        return lines + [f"IF {expression} THEN", f"    {name} := {'TRUE' if storage == 'set' else 'FALSE'};", "END_IF;"]
    return lines + [f"{name} := {expression};"]


def block_statements(block, nodes, pou_name):
    block_type = block.get("typeName", "")
    instance = block.get("instanceName") or block_type
    name = standard_function(block)
    if name:
        targets = function_targets(block)
        if not targets and block.get("localId") not in nodes.saved_eno:
            # Without a target, the function only feeds the next element: it becomes
            # an inline expression there, and generates no statement here.
            return []
        enable = block_enable(block, nodes, pou_name, frozenset())
        prefix = []
        saved = nodes.save_eno(block, enable)
        if saved:
            prefix = [f"{saved} := {enable};"]
            enable = saved
        if not targets:
            return prefix
        value = function_expression(block, nodes, pou_name, frozenset())
        lines = [f"{target} := {value};" for target in targets]
        if enable in (None, "TRUE"):
            return prefix + lines
        return prefix + [f"IF {enable} THEN", *(f"    {line}" for line in lines), "END_IF;"]
    arguments = []
    enable = None
    inputs = child(block, "inputVariables")
    for variable in list(inputs) if inputs is not None else []:
        formal = variable.get("formalParameter")
        if formal is None:
            continue
        expression = rung_expression(variable, nodes, pou_name)
        # EN is not an argument: it conditions the call. Ignoring it would make
        # the block run every cycle, silently changing the machine logic.
        if formal == "EN":
            enable = expression
            continue
        if expression:
            arguments.append(f"{formal} := {expression}")
    outputs = child(block, "outputVariables")
    for variable in list(outputs) if outputs is not None else []:
        formal = variable.get("formalParameter")
        if formal in {None, "ENO"}:
            continue
        point = child(variable, "connectionPointOut")
        expression = child(point, "expression") if point is not None else None
        if expression is not None and (expression.text or "").strip():
            arguments.append(f"{formal} => {expression.text.strip()}")
    call = f"{instance}({', '.join(arguments)});"
    prefix = []
    saved = nodes.save_eno(block, enable)
    if saved:
        prefix = [f"{saved} := {enable};"]
        enable = saved
    if enable in (None, "TRUE"):
        return prefix + [call]
    return prefix + [f"IF {enable} THEN", f"    {call}", "END_IF;"]


def out_variable_statements(node, nodes, pou_name):
    expression = child(node, "expression")
    name = (expression.text or "").strip() if expression is not None else ""
    value = rung_expression(node, nodes, pou_name)
    if not name or not value:
        return []
    return [f"{name} := {value};"]


def graphical_to_st(graphic, pou_name):
    """Converts the LD/FBD network into ST keeping the XML order.

    Series contacts become AND, parallel connections become OR, coils become
    assignments and the EN of each block becomes IF. Whatever has no direct
    equivalent, such as jump and divergence, fails explicitly: we never produce
    an incomplete implementation pretending the conversion worked.
    """
    nodes = Network(graphic)
    unsupported = sorted({local(item) for item in graphic if local(item) in LADDER_UNSUPPORTED})
    if unsupported:
        raise ValueError(msg("imp_err_unsupported_network", pou=pou_name, element=unsupported[0]))
    handlers = {"block": block_statements, "coil": coil_statements, "outVariable": out_variable_statements}
    statements = []
    for item in graphic:
        handler = handlers.get(local(item))
        if handler:
            generated = handler(item, nodes, pou_name)
            # Edge contact used here for the first time: the instance runs
            # before the statement, only once per network.
            statements.extend(nodes.pending_calls())
            statements.extend(generated)
    if not statements:
        # legacy text: "(* <pou>: diagrama original sem logica executavel. *)"
        return f"(* {pou_name}: original diagram has no executable logic. *)", []
    return LADDER_HEADER + "\n" + "\n".join(statements), nodes.helpers()


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


# --------------------------------------------------------------------------
# Adaptations for the simulator backend. The official sources keep what came
# from the manufacturer; prepare_native.py applies these only to the copy.
# --------------------------------------------------------------------------

# Manufacturer system services. Clock and calendar depend on the controller, so
# the backend copy reads its own variables and the simulator fills them.
SYSTEM_SERVICES = [
    (re.compile(r"\bSysTimeCore\s*\.\s*SysTimeGetUs\s*\(\s*(\w+)\s*\)\s*;", re.I),
     r"\1 := System_TimeUs;", "SysTimeCore.SysTimeGetUs"),
    (re.compile(r"\bGetDateAndTime\s*\(\s*(\w+)\s*\)\s*;", re.I),
     r"\1 := System_DateTime;", "GetDateAndTime"),
    (re.compile(r"\bNextoStandard\s*\.\s*GetDayOfWeek\s*\(\s*\)", re.I),
     "System_DayOfWeek", "NextoStandard.GetDayOfWeek"),
]
SYSTEM_VARIABLES = [
    ("System_TimeUs", "ULINT", "monotonic clock in microseconds"),
    ("System_DateTime", "EXTENDED_DATE_AND_TIME", "current date and time"),
    ("System_DayOfWeek", "DAYS_OF_WEEK", "day of the week"),
]
# Types the manufacturer brings from a library and the backend copy declares,
# so it is self-contained. Hardware diagnostics do not go in: they belong to
# the controller, not to the logic.
PORTABLE_LIBRARY_TYPES = {
    "EXTENDED_DATE_AND_TIME": (
        "TYPE EXTENDED_DATE_AND_TIME :\nSTRUCT\n"
        "    byYear : UINT;\n    byMonth : USINT;\n    byDay : USINT;\n"
        "    byHours : USINT;\n    byMinutes : USINT;\n    bySeconds : USINT;\n"
        "    wMilliseconds : UINT;\nEND_STRUCT;\nEND_TYPE\n"),
    "DAYS_OF_WEEK": "TYPE DAYS_OF_WEEK : USINT; END_TYPE\n",
}


def apply_system_services(source, used):
    for pattern, replacement, name in SYSTEM_SERVICES:
        source, n = pattern.subn(replacement, source)
        if n:
            used[name] = used.get(name, 0) + n
    return source


def relocate_global_blocks(sources, lists, block_types, moved, not_moved):
    """Moves a global FB instance into the POU that calls it.

    An FB instance in global scope is legal in the standard and MATIEC accepts
    it, but STruC++ 0.6.3 refuses to call it. When only one POU uses the
    instance, the declaration goes there as VAR RETAIN, keeping the retention
    the GVL gave it.
    """
    instances = {}
    for gvl_name, variables in lists.items():
        for variable in variables:
            kind = render_type(child(variable, "type"))
            if kind.upper() in block_types:
                instances[flatten_name(gvl_name, variable.get("name"))] = kind
    if not instances:
        return sources
    by_file = {}
    for name, kind in instances.items():
        callers = [path for path, text in sources.items()
                   if re.search(rf"(?<![.\w]){re.escape(name)}\s*\(", text, re.I)]
        if len(callers) != 1:
            not_moved.append((name, kind, len(callers)))
            continue
        by_file.setdefault(callers[0], []).append((name, kind))
    for path, items in by_file.items():
        body = "".join(f"    {name} : {kind};\n" for name, kind in items)
        declaration = ("VAR RETAIN\n"
                       "    (* Instances moved from the global list; RETAIN keeps the retention. *)\n"
                       f"{body}END_VAR\n")
        sources[path] = re.sub(r"(?m)^((?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+\w+.*\n)",
                               lambda m: m.group(1) + declaration, sources[path], count=1)
        moved.extend((name, kind, path) for name, kind in items)
    return sources


# Qualifiers of each GVL (RETAIN, PERSISTENT, CONSTANT), by list name.
GVL_QUALIFIERS = {}


def collect_globals(root):
    """Map GVL -> members, in XML order, merging GVLs with the same name."""
    # The same GVL can appear in more than one resource of the XML, repeating
    # members. Merge keeping the first occurrence of each name.
    lists = {}
    seen = {}
    for gvl in (item for item in root.iter() if local(item) == "globalVars"):
        name = gvl.get("name") or "GlobalVars"
        GVL_QUALIFIERS.setdefault(name, qualifiers(gvl))
        target = lists.setdefault(name, [])
        known = seen.setdefault(name, set())
        for variable in gvl:
            if local(variable) != "variable":
                continue
            member = (variable.get("name") or "").upper()
            if member in known:
                continue
            known.add(member)
            target.append(variable)
    return lists


def flatten_name(gvl_name, member):
    return f"{gvl_name}_{member}"


QUALIFIED = re.compile(r"\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b")
IDENTIFIER = re.compile(r"(?<![.\w])([A-Za-z_]\w*)")


# Variable section without the header qualifiers. Without skipping RETAIN and
# friends, "RETAIN Count :" did not match and the first local was lost.
VAR_SECTION = re.compile(r"\bVAR(?:_\w+)?\b(?:\s+(?:RETAIN|NON_RETAIN|PERSISTENT|CONSTANT)\b)*(.*?)\bEND_VAR\b",
                         re.S | re.I)


def declared_names(source):
    names = set()
    for block in VAR_SECTION.findall(source):
        block = re.sub(r"\(\*.*?\*\)|//[^\n]*", " ", block, flags=re.S)
        for piece in block.split(";"):
            m = re.match(r"\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:\bAT\b\s*%\S+\s*)?:", piece)
            if m:
                names.update(x.strip().upper() for x in m.group(1).split(","))
    return names


def split_body(source):
    """Separates the declarations from the executable body, so locals are not renamed."""
    end = 0
    for m in re.finditer(r"\bEND_VAR\b", source, re.I):
        end = m.end()
    if end:
        return source[:end], source[end:]
    newline = source.find("\n")
    return (source[:newline + 1], source[newline + 1:]) if newline >= 0 else (source, "")


def qualified_rewriter(lists, ambiguous_found, programs=()):
    """Flattens global variable access in the code.

    Field.AO becomes Field_AO. Struct members and FB instance members are not
    touched, because the prefix must be the name of a known GVL and the suffix
    one of its members. A reference without prefix, such as Pulse_1s, is renamed
    too, but only when the name belongs to a single GVL and is not a POU local.
    """
    index = {}
    owners = {}
    for gvl_name, variables in lists.items():
        for variable in variables:
            member = variable.get("name")
            if not member:
                continue
            index[(gvl_name.upper(), member.upper())] = flatten_name(gvl_name, member)
            owners.setdefault(member.upper(), []).append((gvl_name, member))
    unique = {key: flatten_name(*pair[0]) for key, pair in owners.items() if len(pair) == 1}
    ambiguous = {key for key, pair in owners.items() if len(pair) > 1}

    def rewrite(source):
        source = QUALIFIED.sub(
            lambda m: index.get((m.group(1).upper(), m.group(2).upper()), m.group(0)),
            source,
        )
        header, body = split_body(source)
        locals_ = declared_names(source)

        def bare(m):
            key = m.group(1).upper()
            if key in locals_:
                return m.group(1)
            # Call of a PROGRAM with the same name as a global: Heating() is the
            # program, not State_Heating().
            if key in programs and re.match(r"\s*\(", body[m.end():]):
                return m.group(1)
            if key in ambiguous:
                ambiguous_found.add(m.group(1))
                return m.group(1)
            return unique.get(key, m.group(1))

        return header + IDENTIFIER.sub(bare, body)

    return rewrite


def render_rules(manifest):
    """Document of the rules applied, generated at each import (IMPORT_RULES.md)."""
    return msg("imp_rules", source=manifest["source"])


# Editor attributes do not belong to the code: they store screen order and checksums.
GVL_EDITOR_ATTRIBUTES = {"order_in_persistent_editor", "checksumnoinit_override", "init_related_code"}


def gvl_pragmas(gvl):
    """CODESYS pragmas of the GVL, such as {attribute 'qualified_only'}.

    The list name does not exist in ST text, but the pragma does, and it decides
    whether the code must write Field.AO or may write AO. Without it the file can
    no longer be pasted back into MasterTool with the same behavior.
    """
    lines = []
    for attribute in gvl.iter():
        if local(attribute) != "Attribute":
            continue
        name = attribute.get("Name")
        if not name or name in GVL_EDITOR_ATTRIBUTES:
            continue
        value = attribute.get("Value") or ""
        lines.append(f"{{attribute '{name}' := '{value}'}}" if value else f"{{attribute '{name}'}}")
    return lines


def render_gvl(gvl):
    # legacy header: "(* GVL original: <name> *)"
    lines = [f"(* Original GVL: {gvl.get('name', 'unnamed')} *)"]
    lines.extend(gvl_pragmas(gvl))
    lines.append(section_header("VAR_GLOBAL", gvl))
    lines.extend(variable_line(variable) for variable in gvl if local(variable) == "variable")
    lines.append("END_VAR")
    return "\n".join(lines) + "\n"


def render_native_gvl(root, name):
    """MixedAttrsVarList is the authoritative partition, not a second declaration.

    The outer block aggregates the same variables for interoperability. The
    children keep CONSTANT/RETAIN per section and must not be duplicated.
    """
    parents = {c: p for p in root.iter() for c in p}
    sections = []
    for gvl in root.iter():
        if local(gvl) != 'globalVars' or gvl.get('name') != name:
            continue
        parent = parents.get(gvl)
        nested = False
        while parent is not None:
            if local(parent) == 'globalVars': nested = True; break
            parent = parents.get(parent)
        if nested: continue
        mixed = next((x for x in gvl.iter() if local(x) == 'MixedAttrsVarList'), None)
        if mixed is None:
            sections.append(render_gvl(gvl))
        else:
            sections.extend(render_gvl(x) for x in mixed if local(x) == 'globalVars')
    return '\n'.join(sections)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xml", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--active", action="store_true", help=msg("imp_cli_active"))
    args = parser.parse_args()
    root = ET.parse(args.xml).getroot()
    output = args.output
    for folder in (("programs", "functions", "blocks", "types", "globals", "plcopen") if args.active else ("pous", "types", "globals")):
        (output / folder).mkdir(parents=True, exist_ok=True)

    if args.active:
        shutil.copy2(args.xml, output / "plcopen" / "original.xml")

    manifest = {"source": str(args.xml), "pous": [], "dataTypes": [], "globalVars": [], "libraries": [], "diagnostics": {}}
    global_lists = collect_globals(root)
    ambiguous_unprefixed = set()
    pous = [item for item in root.iter() if local(item) == "pou"]
    services_used = {}
    sources = {}
    targets = {}
    for index, pou in enumerate(pous, 1):
        source, body_kind, body = render_pou(pou)
        # Official native source: qualified names, services and scopes untouched.
        stem = f"{index:02d}_{safe_name(pou.get('name'))}"
        folder = {"program": "programs", "functionBlock": "blocks", "function": "functions"}.get(pou.get("pouType"), "programs") if args.active else "pous"
        filename = f"{folder}/{stem}.st"
        sources[filename] = source
        targets[filename] = (pou, body_kind, body, stem)

    # Global instances stay in the GVLs; the backend adapts only its copy.
    moved, not_moved = [], []

    for filename, source in sources.items():
        pou, body_kind, body, stem = targets[filename]
        (output / filename).write_text(source, encoding="utf-8")
        if body_kind != "ST" and body is not None and not args.active:
            (output / "pous" / f"{stem}.{body_kind.lower()}.xml").write_text(ET.tostring(body, encoding="unicode"), encoding="utf-8")
        manifest["pous"].append({"name": pou.get("name"), "type": pou.get("pouType"), "originalLanguage": body_kind, "runtimeLanguage": "ST", "file": filename})

    data_types = [item for item in root.iter() if local(item) == "dataType"]
    for index, data_type in enumerate(data_types, 1):
        filename = f"{index:02d}_{safe_name(data_type.get('name'))}.st"
        (output / "types" / filename).write_text(render_data_type(data_type), encoding="utf-8")
        manifest["dataTypes"].append({"name": data_type.get("name"), "file": f"types/{filename}"})

    portable_types = []  # Library types are the backend's responsibility (prepare_native.py).

    for index, (name, variables) in enumerate(global_lists.items(), 1):
        filename = f"{index:02d}_{safe_name(name)}.st"
        (output / 'globals' / filename).write_text(render_native_gvl(root, name), encoding='utf-8')
        manifest['globalVars'].append({
            'name': name, 'file': f'globals/{filename}', 'prefix': f'{name}_',
            'members': [v.get('name') for v in variables],
        })
    manifest['globalsLayout'] = 'qualified'
    manifest['sourceRepresentation'] = 'manufacturer-native'
    manifest["adaptations"] = {
        "systemServices": services_used,
        "relocatedBlockInstances": [{"name": n, "type": tp, "movedTo": f} for n, tp, f in moved],
        "notRelocated": [{"name": n, "type": tp, "callers": c} for n, tp, c in not_moved],
        "portableTypes": portable_types,
    }
    if ambiguous_unprefixed:
        manifest["ambiguousGlobals"] = sorted(ambiguous_unprefixed)

    libraries = []
    for item in root.iter():
        if local(item) != "Library": continue
        library = {key: item.get(key) for key in ("Name", "Namespace", "DefaultResolution", "SystemLibrary") if item.get(key) is not None}
        libraries.append(library)
    manifest["libraries"] = libraries
    # Types the project declares count as resolved; without this the export
    # reported as pending something that is declared in types/.
    defined = {item.get("name", "").lower() for item in root.iter() if local(item) in {"pou", "dataType"}}
    defined.update(item["name"].lower() for item in manifest["dataTypes"])
    builtins = {"BOOL","BYTE","WORD","DWORD","LWORD","SINT","USINT","INT","UINT","DINT","UDINT","LINT","ULINT","REAL","LREAL","TIME","DATE","TOD","DT","STRING","WSTRING","TON","TOF","TP","R_TRIG","F_TRIG","CTU","CTD","CTUD"}
    unresolved_types = sorted({item.get("name") for item in root.iter() if local(item) == "derived" and item.get("name", "").lower() not in defined and item.get("name", "").upper() not in builtins})
    # Standard functions drawn as blocks become operators in ST during the ladder
    # conversion, so they are not external dependencies: listing them was noise.
    resolved_by_converter = set(STANDARD_BINARY) | STANDARD_COPY | STANDARD_UNARY
    unresolved_blocks = sorted({item.get("typeName") for item in root.iter()
                                if local(item) == "block"
                                and item.get("typeName", "").lower() not in defined
                                and item.get("typeName", "").upper() not in builtins
                                and item.get("typeName", "").upper() not in resolved_by_converter}, key=str.lower)
    conversions = [{"name": item["name"], "from": item["originalLanguage"], "to": "ST", "file": item["file"]} for item in manifest["pous"] if item["originalLanguage"] != "ST"]
    manifest["diagnostics"] = {
        "status": "pending" if unresolved_types or unresolved_blocks else "ready",
        "unresolvedTypes": unresolved_types,
        "unresolvedBlocks": unresolved_blocks,
        "conversions": conversions,
        "notes": [msg("imp_note_libraries")] if libraries else [],
    }

    manifest_path = output / ("plcopen/manifest.json" if args.active else "manifest.json")
    if args.active:
        # After the diagnostics, so the document sees the LD/FBD conversions.
        (output / "plcopen" / "IMPORT_RULES.md").write_text(render_rules(manifest), encoding="utf-8")
        legacy_rules = output / "plcopen" / "REGRAS_IMPORTACAO.md"  # legacy name, regenerated as IMPORT_RULES.md
        if legacy_rules.exists():
            legacy_rules.unlink()
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.active:
        diagnostic = manifest["diagnostics"]
        report = [
            msg("imp_report_title", name=args.xml.name), "",
            msg("imp_report_status", status=msg("imp_status_pending") if diagnostic["status"] == "pending"
                else msg("imp_status_ready")), "",
            msg("imp_report_pous", count=len(pous)), msg("imp_report_duts", count=len(data_types)),
            msg("imp_report_gvls", count=len(global_lists)),
            msg("imp_report_conversions", count=len(conversions)),
            msg("imp_report_libraries", count=len(libraries)), "",
            msg("imp_report_conversions_title"), "",
            *([msg("imp_report_conversion", name=item['name'], language=item['from'], file=item['file'])
               for item in conversions] or [msg("imp_report_no_conversions")]), "",
            msg("imp_report_pending_title"), "",
            *([msg("imp_report_pending_type", name=name) for name in unresolved_types]
              + [msg("imp_report_pending_block", name=name) for name in unresolved_blocks]
              or [msg("imp_report_none")]), "",
            msg("imp_report_libraries_title"), "",
            *([f"- `{item.get('DefaultResolution') or item.get('Name')}`" for item in libraries]
              or [msg("imp_report_none")]), "",
            msg("imp_report_footer"), ""
        ]
        (output / "plcopen" / "IMPORT_REPORT.md").write_text("\n".join(report), encoding="utf-8")
    readme = msg("imp_readme", source=args.xml, pous=len(pous),
                 st=sum(1 for p in manifest['pous'] if p['originalLanguage'] == 'ST'),
                 converted=sum(1 for p in manifest['pous'] if p['originalLanguage'] != 'ST'),
                 duts=len(data_types), gvls=len(global_lists))
    (output / ("plcopen/README.md" if args.active else "README.md")).write_text(readme, encoding="utf-8")
    print(msg("imp_done", pous=len(pous), duts=len(data_types), gvls=len(global_lists), output=output))


if __name__ == "__main__":
    main()
