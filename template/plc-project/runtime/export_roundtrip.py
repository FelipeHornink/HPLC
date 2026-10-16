#!/usr/bin/env python3
"""Round-trip export: XML that goes back into the SAME manufacturer project.

The generated file is the manufacturer's base XML edited as text, only where
the project changed. Everything else stays byte for byte: BOM, CRLF of the
structure, addData, GUIDs, Ladder and comments. So it imports wherever the base
imports, and a diff against the base shows exactly what was changed here.

Three inputs:
  ancestor  plcopen/original.xml, the XML the sources came from;
  base      the XML that receives the changes (default: the ancestor; it may be
            a newer manufacturer XML, exported after the import);
  sources   the project's current .st files.

Each XML is re-imported with the project's own importer, so it is compared in
the same shape as the sources. Per object (POU, GVL, DUT):
  sources == ancestor            untouched (whatever is in the base wins);
  only the sources changed       the difference is applied to the base;
  both changed the same way      nothing to do;
  both changed differently       conflict: abort without writing.

Before writing, three checks: only the planned objects differ from the base,
the generated XML re-imports equal to the sources, and the manufacturer's
format was kept.

    python3 runtime/export_roundtrip.py [--base XML] [--out export/]
"""
from pathlib import Path
import argparse
import datetime as dt
import difflib
import json
import re
import subprocess
import sys
import tempfile
import xml.parsers.expat

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import msg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
XHTML_NS = "http://www.w3.org/1999/xhtml"
XHTML_OPEN = f'<xhtml xmlns="{XHTML_NS}">'
# First body line of a Ladder POU exported as ST (text comes from messages.py).
# Detection accepts the current English prefix and the legacy Portuguese one.
LADDER_WARNING_PREFIXES = (
    "(* WARNING: POU originally in Ladder",
    "(* ATENCAO: POU originalmente em Ladder",  # legacy
)
# Comment the importer writes in the VAR block of LD -> ST helper variables.
LD_HELPER_MARKERS = (
    "Created by the LD -> ST conversion",
    "Criadas na conversao LD -> ST",  # legacy
)
# Lines the importer generates inside converted bodies. Projects imported by an
# older (Portuguese) importer carry the legacy text; the comparison treats both
# as the same line so those projects do not look changed.
LADDER_HEADER = "(* Converted automatically from LD/FBD to ST. *)"
LEGACY_LADDER_HEADER = "(* Convertido automaticamente de LD/FBD para ST. *)"  # legacy
LEGACY_EMPTY_DIAGRAM = re.compile(r"^\(\* (.*): diagrama original sem logica executavel\. \*\)$")  # legacy

SECTIONS = {"VAR": "localVars", "VAR_TEMP": "tempVars", "VAR_INPUT": "inputVars", "VAR_OUTPUT": "outputVars",
            "VAR_IN_OUT": "inOutVars", "VAR_EXTERNAL": "externalVars", "VAR_GLOBAL": "globalVars", "STRUCT": "struct"}
QUALIFIERS = {"CONSTANT": "constant", "RETAIN": "retain", "PERSISTENT": "persistent"}
ELEMENTARY = {"BOOL", "BYTE", "WORD", "DWORD", "LWORD", "SINT", "USINT", "INT", "UINT", "DINT", "UDINT",
              "LINT", "ULINT", "REAL", "LREAL", "TIME", "LTIME", "DATE", "TOD", "TIME_OF_DAY", "DT",
              "DATE_AND_TIME", "STRING", "WSTRING"}


class ExportError(Exception):
    """Failure that prevents writing the file; the message goes to the user."""


def canonical_body_line(line):
    """Body line with legacy generated markers mapped to the current text."""
    if line == LEGACY_LADDER_HEADER:
        return LADDER_HEADER
    m = LEGACY_EMPTY_DIAGRAM.match(line)
    if m:
        return f"(* {m.group(1)}: original diagram has no executable logic. *)"
    return line


def canonical_body(body):
    return None if body is None else tuple(canonical_body_line(x) for x in body)


def is_ladder_warning(line):
    return line.startswith(LADDER_WARNING_PREFIXES)


# --------------------------------------------------------------------------
# Textual index of the XML: each element with its byte offsets.
# --------------------------------------------------------------------------

class Node:
    __slots__ = ("tag", "attrs", "start", "open_end", "end", "close_start", "children", "parent")

    def __init__(self, tag, attrs, start, parent):
        self.tag, self.attrs, self.start, self.parent = tag, attrs, start, parent
        self.children = []
        self.open_end = self.end = self.close_start = None

    @property
    def name(self):
        return self.attrs.get("name")

    def child(self, tag):
        return next((x for x in self.children if x.tag == tag), None)

    def iter(self):
        yield self
        for child in self.children:
            yield from child.iter()

    def inside(self, tag):
        node = self.parent
        while node is not None:
            if node.tag == tag:
                return True
            node = node.parent
        return False


def _tag_end(raw, start):
    """Index of the '>' closing the start tag, ignoring '>' inside quotes."""
    quote = None
    for i in range(start, len(raw)):
        c = raw[i]
        if quote:
            if c == quote:
                quote = None
        elif c in (0x22, 0x27):
            quote = c
        elif c == 0x3E:
            return i
    raise ExportError(msg("err_truncated_xml"))


def index_xml(raw):
    parser = xml.parsers.expat.ParserCreate()
    root = Node("#doc", {}, 0, None)
    stack = [root]

    def on_open(tag, attrs):
        node = Node(tag.split(" ")[-1].split(":")[-1], attrs, parser.CurrentByteIndex, stack[-1])
        node.open_end = _tag_end(raw, node.start)
        stack[-1].children.append(node)
        stack.append(node)

    def on_close(_tag):
        node = stack.pop()
        if raw[node.open_end - 1] == 0x2F:  # <x ... />
            node.end = node.close_start = node.open_end + 1
        else:
            node.close_start = parser.CurrentByteIndex
            node.end = raw.index(b">", node.close_start) + 1

    parser.StartElementHandler, parser.EndElementHandler = on_open, on_close
    parser.Parse(raw, True)
    return root.children[0]


def content(raw, node):
    return raw[node.open_end + 1:node.close_start]


def indentation(raw, start):
    line = raw.rfind(b"\n", 0, start) + 1
    prefix = raw[line:start]
    return prefix.decode() if not prefix.strip() else ""


def line_start(raw, start):
    """Start of the line break before the element, to remove the whole line."""
    line = raw.rfind(b"\n", 0, start)
    if line < 0 or raw[line + 1:start].strip():
        return start
    return line - 1 if line > 0 and raw[line - 1] == 0x0D else line


ENTITIES = {"lt": "<", "gt": ">", "amp": "&", "quot": '"', "apos": "'"}


def unescape(text):
    def replace(m):
        name = m.group(1)
        if name.startswith("#x"):
            return chr(int(name[2:], 16))
        if name.startswith("#"):
            return chr(int(name[1:]))
        return ENTITIES[name]
    return re.sub(r"&(#x[0-9A-Fa-f]+|#\d+|lt|gt|amp|quot|apos);", replace, text)


def escape_text(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def escape_attribute(text):
    return escape_text(text).replace('"', "&quot;")


# --------------------------------------------------------------------------
# Reading the ST sources in the shape the importer writes.
# --------------------------------------------------------------------------

class Var:
    __slots__ = ("name", "address", "type", "initial", "comment")

    def __init__(self, name, address, type_, initial, comment):
        self.name, self.address, self.type, self.initial, self.comment = name, address, type_, initial, comment

    def key(self):
        return (self.address or "", re.sub(r"\s+", "", self.type).upper(),
                None if self.initial is None else re.sub(r"\s+", "", self.initial))


class Block:
    def __init__(self, keyword, qualifiers):
        self.keyword, self.qualifiers = keyword, frozenset(qualifiers)
        self.vars, self.ld_helper = [], False

    def key(self):
        return (self.keyword, self.qualifiers)


class Source:
    def __init__(self):
        self.header, self.blocks, self.body, self.rest = "", [], None, ""

    def real_blocks(self):
        return [b for b in self.blocks if not b.ld_helper]

    def shape(self, without_helpers=False):
        """Canonical shape to compare: declarations without comments, and body."""
        blocks = self.real_blocks() if without_helpers else self.blocks
        return (self.header.upper(),
                tuple((b.key(), tuple((v.name.upper(), v.key()) for v in b.vars)) for b in blocks),
                canonical_body(self.body), self.rest)


DECL = re.compile(r"^\s*([A-Za-z_]\w*)\s*(?:\bAT\b\s*(%[A-Za-z0-9_.*]+)\s*)?:\s*(.*?)\s*;\s*"
                  r"(?:\(\*(.*)\*\))?\s*$", re.I | re.S)
BLOCK_START = re.compile(r"^\s*(VAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP|_EXTERNAL|_GLOBAL)?|STRUCT)"
                         r"((?:\s+(?:CONSTANT|RETAIN|PERSISTENT))*)\s*$", re.I)
BLOCK_END = re.compile(r"^\s*(END_VAR|END_STRUCT\s*;?)\s*$", re.I)
HEADER = re.compile(r"^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|TYPE)\b(.*)$", re.I)


def read_declaration(text):
    m = DECL.match(text)
    if not m:
        raise ExportError(msg("err_unrecognized_declaration", text=text.strip()))
    name, address, spec, comment = m.groups()
    type_, _, initial = spec.partition(":=")
    return Var(name, address, type_.strip(), initial.strip() if _ else None, comment)


def read_source(text):
    """Header, declaration blocks and body of a .st written by the importer.

    The body starts after exactly one blank line following the last END_VAR
    (the importer writes one) and ends before the final END_<kind>.
    """
    lines = text.split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    source = Source()
    i = 0
    while i < len(lines):
        line = lines[i]
        head = HEADER.match(line)
        if not source.header and head:
            source.header = re.sub(r"\s+", " ", line.strip())
            i += 1
            continue
        opening = BLOCK_START.match(line)
        if opening:
            block = Block(opening.group(1).upper(), opening.group(2).upper().split())
            i += 1
            pending = ""
            while i < len(lines) and not BLOCK_END.match(lines[i]):
                current = lines[i]
                i += 1
                if not pending and (not current.strip() or current.strip().startswith(("(*", "//", "{"))):
                    if any(marker in current for marker in LD_HELPER_MARKERS):
                        block.ld_helper = True
                    continue
                pending = f"{pending}\n{current}" if pending else current
                without_comment = re.sub(r"\(\*.*?\*\)|//.*$", "", pending, flags=re.S).rstrip()
                if without_comment.endswith(";"):
                    block.vars.append(read_declaration(pending))
                    pending = ""
            if pending:
                raise ExportError(msg("err_declaration_without_semicolon", text=pending.strip()))
            source.blocks.append(block)
            i += 1
            continue
        if source.header and HEADER.match(source.header).group(1).upper() != "TYPE":
            following = next((x for x in lines[i:] if x.strip()), "")
            if line.strip() or not BLOCK_START.match(following):
                break
        i += 1  # GVL comment, pragma, END_TYPE, blank line between blocks
    if source.header and HEADER.match(source.header).group(1).upper() != "TYPE":
        kind = HEADER.match(source.header).group(1).upper()
        if not lines or lines[-1].strip().upper() != f"END_{kind}":
            raise ExportError(msg("err_missing_end", header=source.header, kind=kind))
        body = lines[i:-1]
        if body and not body[0].strip():
            body = body[1:]
        source.body = body
    elif source.header:
        # TYPE: whatever is not a STRUCT (enum, alias) is compared as text.
        source.rest = "\n".join(l.strip() for l in lines if not l.strip().startswith("(*")) \
            if not any(b.keyword == "STRUCT" for b in source.blocks) else ""
    return source


def expand_routines(root, text):
    """Same (* @ROUTINE x *) expansion the ST export does."""
    marker = re.compile(r"^\s*\(\*\s*@ROUTINE\s+([^*]+?)\s*\*\)\s*$")
    output = []
    for line in text.split("\n"):
        m = marker.match(line)
        if m:
            output.extend((root / "routines" / m.group(1).strip()).read_text(encoding="utf-8").split("\n"))
        else:
            output.append(line)
    return "\n".join(output)


# --------------------------------------------------------------------------
# Project objects: POU, GVL and DUT, from the import manifest.
# --------------------------------------------------------------------------

def objects(folder, expand=False):
    manifest = json.loads((folder / "plcopen" / "manifest.json").read_text(encoding="utf-8"))
    result = {}
    for key, kind in (("pous", "pou"), ("globalVars", "gvl"), ("dataTypes", "dut")):
        for item in manifest.get(key, []):
            if item.get("origin") == "portable":
                continue
            path = folder / item["file"]
            if not path.exists():
                raise ExportError(msg("err_object_file_missing", kind=kind.upper(), name=item["name"],
                                      file=item["file"]))
            text = path.read_text(encoding="utf-8")
            if expand:
                text = expand_routines(folder, text)
            result[(kind, item["name"])] = {
                "source": read_source(text), "file": item["file"],
                "language": item.get("originalLanguage", "ST"),
            }
    return manifest, result


def sources_without_manifest(root, manifest):
    known = {item["file"] for key in ("pous", "globalVars", "dataTypes") for item in manifest.get(key, [])}
    new = []
    for folder in ("programs", "blocks", "functions", "globals", "types"):
        for path in sorted((root / folder).glob("*.st")):
            if f"{folder}/{path.name}" not in known:
                new.append(f"{folder}/{path.name}")
    return new


def reimport(root, xml, destination):
    importer = root / "runtime" / "import_plcopenxml.py"
    r = subprocess.run([sys.executable, str(importer), str(xml), str(destination), "--active"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise ExportError(msg("err_importer_failed", xml=xml, output=f"{r.stdout}{r.stderr}"))
    return objects(destination)[1]


# --------------------------------------------------------------------------
# Rendering declarations in the manufacturer's format.
# --------------------------------------------------------------------------

def split_top_level(text, separator=","):
    parts, level, current, quote = [], 0, "", None
    for c in text:
        if quote:
            current += c
            if c == quote:
                quote = None
            continue
        if c in "'\"":
            quote = c
        elif c in "([":
            level += 1
        elif c in ")]":
            level -= 1
        if c == separator and level == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += c
    if current.strip():
        parts.append(current.strip())
    return parts


def type_lines(type_):
    type_ = type_.strip()
    m = re.match(r"ARRAY\s*\[(.*?)\]\s*OF\s+(.+)$", type_, re.I | re.S)
    if m:
        lines = ["<array>"]
        for dimension in split_top_level(m.group(1)):
            lower, _, upper = dimension.partition("..")
            lines.append(f'  <dimension lower="{lower.strip()}" upper="{upper.strip()}" />')
        lines += ["  <baseType>", *(f"    {x}" for x in type_lines(m.group(2))), "  </baseType>", "</array>"]
        return lines
    m = re.match(r"(W?STRING)\s*(?:[(\[]\s*(\d+)\s*[)\]])?$", type_, re.I)
    if m:
        tag = m.group(1).lower()
        return [f'<{tag} length="{m.group(2)}" />' if m.group(2) else f"<{tag} />"]
    if re.match(r"^\w+$", type_):
        return [f"<{type_.upper()} />"] if type_.upper() in ELEMENTARY else [f'<derived name="{type_}" />']
    raise ExportError(msg("err_unsupported_type", type=type_))


def value_lines(value):
    value = value.strip()
    if value.startswith("(") and value.endswith(")") and ":=" in value:
        lines = ["<structValue>"]
        for member in split_top_level(value[1:-1]):
            name, _, inner = member.partition(":=")
            lines += [f'  <value member="{name.strip()}">', *(f"    {x}" for x in value_lines(inner)), "  </value>"]
        return lines + ["</structValue>"]
    if value.startswith("[") and value.endswith("]"):
        lines = ["<arrayValue>"]
        for element in split_top_level(value[1:-1]):
            rep = re.match(r"^(\d+)\s*\((.*)\)$", element, re.S)
            opening = f'<value repetitionValue="{rep.group(1)}">' if rep else "<value>"
            lines += [f"  {opening}", *(f"    {x}" for x in value_lines(rep.group(2) if rep else element)), "  </value>"]
        return lines + ["</arrayValue>"]
    return [f'<simpleValue value="{escape_attribute(value)}" />']


def variable_lines(var):
    attributes = f' name="{var.name}"' + (f' address="{var.address}"' if var.address else "")
    lines = [f"<variable{attributes}>", "  <type>", *(f"    {x}" for x in type_lines(var.type)), "  </type>"]
    if var.initial is not None:
        lines += ["  <initialValue>", *(f"    {x}" for x in value_lines(var.initial)), "  </initialValue>"]
    if var.comment is not None:
        lines += ["  <documentation>", f"    {XHTML_OPEN}{escape_text(var.comment)}</xhtml>", "  </documentation>"]
    return lines + ["</variable>"]


def text_block(lines, ind, nl):
    return nl.join(f"{ind}{x}" for x in lines)


# --------------------------------------------------------------------------
# Plan of edits over the base text.
# --------------------------------------------------------------------------

class Edits:
    def __init__(self, raw):
        self.raw, self.items = raw, []

    def replace(self, start, end, text):
        self.items.append((start, end, text.encode("utf-8") if isinstance(text, str) else text))

    def apply(self):
        ordered = sorted(self.items, key=lambda e: (e[0], e[1]))
        for (a1, b1, _), (a2, b2, _) in zip(ordered, ordered[1:]):
            if a2 < b1 or (a2 == a1 and b1 > a1 and b2 > a2):
                raise ExportError(msg("err_overlapping_edits", a1=a1, b1=b1, a2=a2, b2=b2))
        output, cursor = [], 0
        for start, end, text in ordered:
            output += [self.raw[cursor:start], text]
            cursor = end
        output.append(self.raw[cursor:])
        return b"".join(output)


class Exporter:
    def __init__(self, raw_base, nl, date):
        self.raw, self.nl, self.date = raw_base, nl, date
        self.root = index_xml(raw_base)
        self.edits = Edits(raw_base)
        self.declarations, self.warnings = [], []

    # -- locating objects in the base ------------------------------------
    def object_node(self, kind, name):
        if kind == "pou":
            found = [n for n in self.root.iter() if n.tag == "pou" and n.name == name]
        elif kind == "dut":
            found = [n for n in self.root.iter() if n.tag == "dataType" and n.name == name]
        else:
            found = [n for n in self.root.iter() if n.tag == "globalVars" and n.name == name
                     and not n.inside("globalVars")]
        if len(found) != 1:
            raise ExportError(msg("err_occurrences_in_base", kind=kind.upper(), name=name, count=len(found)))
        return found[0]

    def sections(self, kind, node):
        if kind == "pou":
            interface = node.child("interface")
            return interface, [s for s in (interface.children if interface else []) if s.tag in SECTIONS.values()
                               and s.tag != "globalVars"]
        if kind == "dut":
            base = node.child("baseType")
            struct = base.child("struct") if base else None
            return None, [struct] if struct else []
        mixed = next((n for n in node.iter() if n.tag == "MixedAttrsVarList"), None)
        if mixed is not None:
            return None, [s for s in mixed.children if s.tag == "globalVars"]
        return None, [node]

    # -- body --------------------------------------------------------------
    def replace_body(self, name, node, base, source, ladder):
        body = node.child("body")
        if body is None or not body.children:
            raise ExportError(msg("err_no_body", name=name))
        if ladder:
            graphic = body.children[0]
            ind = indentation(self.raw, graphic.start)
            text = "\n".join([msg("ladder_export_warning", date=self.date), *source.body])
            new = (f"<ST>{self.nl}{ind}  {XHTML_OPEN}{escape_text(text)}</xhtml>{self.nl}{ind}</ST>")
            self.edits.replace(graphic.start, graphic.end, new)
            return len(source.body)
        xhtml = next((n for n in body.iter() if n.tag == "xhtml"), None)
        if xhtml is None or body.children[0].tag != "ST":
            raise ExportError(msg("err_st_body_not_found", name=name))
        raw_text = content(self.raw, xhtml).decode("utf-8")
        core = raw_text.rstrip()
        tail = raw_text[len(core):]
        vendor = core.split("\n")
        if [unescape(x).rstrip("\r") for x in vendor] != [x.rstrip("\r") for x in base.body] \
                and not (base.body == [] and core == ""):
            raise ExportError(msg("err_body_not_reproduced", name=name))
        cr = "\r" if any(x.endswith("\r") for x in vendor[:-1]) else ""
        output, changed = [], 0
        matcher = difflib.SequenceMatcher(None, base.body, source.body, autojunk=False)
        for op, a1, a2, b1, b2 in matcher.get_opcodes():
            if op == "equal":
                output += vendor[a1:a2]
            else:
                output += [escape_text(x) + cr for x in source.body[b1:b2]]
                changed += max(a2 - a1, b2 - b1)
        if output and cr:
            output[-1] = output[-1].rstrip("\r")
        new = "\n".join(output) + (tail if output or not source.body else "")
        self.edits.replace(xhtml.open_end + 1, xhtml.close_start, new)
        return changed

    # -- declarations --------------------------------------------------------
    def replace_declarations(self, kind, name, node, base, source, convert_ladder):
        """Carries the declarations of `source` into the base, variable by variable."""
        container, sections = self.sections(kind, node)
        base_blocks = base.real_blocks()
        source_blocks = source.blocks if convert_ladder else source.real_blocks()
        if len(base_blocks) != len(sections):
            raise ExportError(msg("err_unexpected_structure", kind=kind.upper(), name=name,
                                  blocks=len(base_blocks), sections=len(sections)))
        index = {}  # name -> (section, variable node, base Var, block key)
        for block, section in zip(base_blocks, sections):
            for var in block.vars:
                vnode = next((v for v in section.children if v.tag == "variable" and v.name == var.name), None)
                if vnode is None:
                    raise ExportError(msg("err_variable_not_in_xml", kind=kind.upper(), name=name, variable=var.name))
                index[var.name.upper()] = (section, vnode, var, block.key())
        target_of = {}
        for block, section in zip(base_blocks, sections):
            target_of.setdefault(block.key(), section)
        new_sections = {}  # key -> list of variable lines
        previous_in_section = {}
        seen = set()
        for block in source_blocks:
            key = (block.keyword, block.qualifiers)
            for var in block.vars:
                seen.add(var.name.upper())
                current = index.get(var.name.upper())
                section = None if block.ld_helper else target_of.get(key)
                if current and current[3] == key:
                    self._change_variable(kind, name, current[1], current[2], var)
                    previous_in_section[id(current[0])] = current[1]
                    continue
                if current:  # moved to another section (qualifier or section kind)
                    self._remove(current[1])
                    text = self._moved_variable_text(current[1], current[2], var)
                    action = "moved"
                else:
                    text = None
                    action = "added"
                if section is None:
                    if kind == "gvl" or container is None:
                        raise ExportError(msg("err_new_block", kind=kind.upper(), name=name,
                                              block=f"{block.keyword} {' '.join(sorted(block.qualifiers))}"))
                    new_sections.setdefault((key, block.ld_helper), []).append((var, text))
                else:
                    self._insert(section, previous_in_section.get(id(section)), var, text)
                self.declarations.append({"object": kind, "pou": name, "variable": var.name, "action": action,
                                          "detail": f"{block.keyword} {' '.join(sorted(block.qualifiers))}".strip()})
        for key_name, (section, vnode, var, _) in index.items():
            if key_name not in seen:
                self._remove(vnode)
                self.declarations.append({"object": kind, "pou": name, "variable": var.name, "action": "removed",
                                          "detail": ""})
                self.warnings.append(msg("warn_variable_removed", pou=name, variable=var.name))
        if new_sections:
            self._create_sections(container, sections, new_sections)

    def _change_variable(self, kind, name, vnode, before, after):
        if before.key() == after.key():
            return
        details = []
        if (before.address or "") != (after.address or ""):
            opening = self.raw[vnode.start:vnode.open_end + 1].decode()
            if 'address="' in opening:
                new = re.sub(r'\saddress="[^"]*"', f' address="{after.address}"' if after.address else "", opening)
            else:
                new = opening.replace(f'name="{vnode.name}"', f'name="{vnode.name}" address="{after.address}"', 1)
            self.edits.replace(vnode.start, vnode.open_end + 1, new)
            details.append(msg("detail_address", old=before.address or "-", new=after.address or "-"))
        if re.sub(r"\s+", "", before.type).upper() != re.sub(r"\s+", "", after.type).upper():
            tnode = vnode.child("type")
            ind = indentation(self.raw, tnode.start)
            text = text_block(["<type>", *(f"  {x}" for x in type_lines(after.type)), "</type>"], ind, self.nl)
            self.edits.replace(tnode.start, tnode.end, text[len(ind):])
            details.append(msg("detail_type", old=before.type, new=after.type))
        initial_before = None if before.initial is None else re.sub(r"\s+", "", before.initial)
        initial_after = None if after.initial is None else re.sub(r"\s+", "", after.initial)
        if initial_before != initial_after:
            inode = vnode.child("initialValue")
            tnode = vnode.child("type")
            ind = indentation(self.raw, tnode.start)
            lines = ["<initialValue>", *(f"  {x}" for x in value_lines(after.initial)), "</initialValue>"] \
                if after.initial is not None else None
            if inode is not None and lines:
                self.edits.replace(inode.start, inode.end, text_block(lines, ind, self.nl)[len(ind):])
            elif inode is not None:
                self.edits.replace(line_start(self.raw, inode.start), inode.end, "")
            else:
                self.edits.replace(tnode.end, tnode.end, self.nl + text_block(lines, ind, self.nl))
            details.append(msg("detail_initial_value", old=before.initial, new=after.initial))
        self.declarations.append({"object": kind, "pou": name, "variable": after.name, "action": "changed",
                                  "detail": "; ".join(details)})

    def _remove(self, vnode):
        self.edits.replace(line_start(self.raw, vnode.start), vnode.end, "")

    def _moved_variable_text(self, vnode, before, after):
        """Whole variable (with addData and documentation) for a section move."""
        if before.key() != after.key():
            raise ExportError(msg("err_move_and_change", variable=after.name))
        return self.raw[vnode.start:vnode.end].decode()

    def _insert(self, section, previous, var, text):
        variables = [v for v in section.children if v.tag == "variable"]
        if previous is not None:
            point, ref = previous.end, previous
        elif variables:
            point, ref = line_start(self.raw, variables[0].start), variables[0]
        else:
            following = next((x for x in section.children if x.tag in ("addData", "documentation")), None)
            point = line_start(self.raw, following.start) if following else line_start(
                self.raw, section.close_start)
            ref = None
        ind = indentation(self.raw, ref.start) if ref else indentation(self.raw, section.start) + "  "
        if text is None:
            text = text_block(variable_lines(var), ind, self.nl)
        else:
            text = ind + text
        if section.open_end + 1 == section.end:  # empty self-closed <localVars />
            raise ExportError(msg("err_self_closed_section", tag=section.tag))
        # Insertions at the same point come out in the order requested (stable sort).
        self.edits.replace(point, point, self.nl + text)

    def _create_sections(self, container, sections, new):
        last = sections[-1] if sections else None
        ind = indentation(self.raw, last.start) if last else indentation(self.raw, container.start) + "  "
        point = last.end if last else container.open_end + 1
        parts = []
        for ((keyword, qualifiers), _helper), variables in new.items():
            attributes = "".join(f' {QUALIFIERS[q]}="true"' for q in ("CONSTANT", "RETAIN", "PERSISTENT")
                                 if q in qualifiers)
            lines = [f"{ind}<{SECTIONS[keyword]}{attributes}>"]
            for var, text in variables:
                lines.append(text_block(variable_lines(var), ind + "  ", self.nl) if text is None
                             else ind + "  " + text)
            lines.append(f"{ind}</{SECTIONS[keyword]}>")
            parts.append(self.nl.join(lines))
        self.edits.replace(point, point, self.nl + self.nl.join(parts))


# --------------------------------------------------------------------------
# Comparison, application and verification.
# --------------------------------------------------------------------------

def normalize_for_verification(source, ladder_converted):
    """Re-imported shape without the warning the export puts on top of converted Ladder."""
    shape = list(source.shape())
    if ladder_converted and source.body and is_ladder_warning(source.body[0]):
        shape[2] = canonical_body(source.body[1:])
    return shape


def export(root, base, out, ancestor=None, date=None):
    root, base, out = Path(root), Path(base), Path(out)
    ancestor = Path(ancestor or root / "plcopen" / "original.xml")
    date = date or dt.date.today().isoformat()
    manifest = json.loads((root / "plcopen" / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("sourceRepresentation") != "manufacturer-native":
        raise ExportError(msg("err_old_layout"))
    new = sources_without_manifest(root, manifest)
    if new:
        raise ExportError(msg("err_sources_without_object", files=", ".join(new)))
    _, local = objects(root, expand=True)
    raw = base.read_bytes()
    nl = "\r\n" if b"\r\n" in raw else "\n"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        anc = reimport(root, ancestor, tmp / "ancestor")
        bas = anc if base.resolve() == ancestor.resolve() else reimport(root, base, tmp / "base")

        report = {"base": str(base), "ancestor": str(ancestor), "date": date, "changed_pous": [],
                  "declarations": [], "ladder_converted": [], "newer_in_base": [], "convergent": [],
                  "conflicts": [], "warnings": []}
        plan = []
        for key, item in local.items():
            a, b = anc.get(key), bas.get(key)
            if a is None or b is None:
                raise ExportError(msg("err_missing_in_xml", kind=key[0].upper(), name=key[1],
                                      which=msg("word_ancestor") if a is None else msg("word_base")))
            fs, fa, fb = item["source"].shape(), a["source"].shape(), b["source"].shape()
            if fs == fa:
                if fb != fa:
                    report["newer_in_base"].append(key[1])
                continue
            if fb != fa:
                (report["convergent"] if fs == fb else report["conflicts"]).append(key[1])
                continue
            plan.append((key, item, b))
        if report["conflicts"]:
            raise ExportError(msg("err_conflict", names=", ".join(report["conflicts"])))

        exp = Exporter(raw, nl, date)
        changed = set()
        converted = set()
        for (kind, name), item, b in plan:
            node = exp.object_node(kind, name)
            changed.add((kind, name))
            fl, fb = item["source"], b["source"]
            if kind == "pou":
                ladder = b["language"] != "ST"
                body_changed = canonical_body(fl.body) != canonical_body(fb.body)
                convert = ladder and body_changed
                if fl.header.upper() != fb.header.upper():
                    raise ExportError(msg("err_header_changed", name=name, old=fb.header, new=fl.header))
                if convert:
                    converted.add(name)
                    report["ladder_converted"].append(name)
                    exp.warnings.append(msg("warn_ladder_converted", name=name))
                exp.replace_declarations(kind, name, node, fb, fl, convert)
                lines = exp.replace_body(name, node, fb, fl, convert) if body_changed else 0
                report["changed_pous"].append({"name": name, "language": "LD->ST" if convert else b["language"],
                                               "body_lines": lines})
            else:
                if fl.rest != fb.rest:
                    raise ExportError(msg("err_dut_outside_struct", name=name))
                exp.replace_declarations(kind, name, node, fb, fl, False)
        generated = exp.edits.apply()
        report["declarations"], report["warnings"] = exp.declarations, exp.warnings

        report["verification"] = verify(root, raw, generated, changed, local, bas, converted,
                                        set(report["newer_in_base"]), tmp)
    out.mkdir(parents=True, exist_ok=True)
    return generated, report


def without_xhtml(text):
    return re.sub(r"(<xhtml[^>]*>).*?(</xhtml>)", r"\1\2", text, flags=re.S)


def verify(root, raw, generated, changed, local, bas, converted, newer, tmp):
    import verify_export
    result = {}
    # 1. Structural: outside the changed objects, the tree equals the base.
    structural = verify_export.compare(raw, generated, allowed={
        {"pou": "pou", "gvl": "globalVars", "dut": "dataType"}[t] + ":" + n for t, n in changed})
    result["structural"] = structural
    # 2. Re-import the generated file and compare it with the sources.
    path = tmp / "generated.xml"
    path.write_bytes(generated)
    reimported = reimport(root, path, tmp / "reimport")
    differences = []
    for key, item in local.items():
        r = reimported.get(key)
        if r is None:
            differences.append(msg("diff_missing_in_reimport", name=key[1]))
            continue
        was_converted = key[0] == "pou" and key[1] in converted
        # Object newer in the base and not changed here: the generated file carries the base one.
        expected = bas[key]["source"].shape() if key[1] in newer else item["source"].shape()
        obtained = normalize_for_verification(r["source"], was_converted)
        if tuple(obtained) != tuple(expected):
            differences.append(msg("diff_reimport_base" if key[1] in newer else "diff_reimport_sources",
                                   kind=key[0].upper(), name=key[1]))
    result["reimport"] = {"ok": not differences, "differences": differences}
    # 3. Manufacturer's format.
    tb, tg = raw.decode("utf-8", "replace"), generated.decode("utf-8", "replace")
    lf = lambda t: len(re.findall(r"(?<!\r)\n", without_xhtml(t)))
    problems = []
    if raw.startswith(b"\xef\xbb\xbf") != generated.startswith(b"\xef\xbb\xbf"):
        problems.append(msg("fmt_bom"))
    if "xhtml:" in tg or "html:" in tg:
        problems.append(msg("fmt_prefix"))
    if len(re.findall(r"<xhtml(?![^>]*xmlns=\"http://www\.w3\.org/1999/xhtml\")", tg)):
        problems.append(msg("fmt_xmlns"))
    if lf(tb) != lf(tg):
        problems.append(msg("fmt_lf", base=lf(tb), generated=lf(tg)))
    result["format"] = {"ok": not problems, "problems": problems}
    result["ok"] = structural["ok"] and result["reimport"]["ok"] and not problems
    return result


def report_markdown(report, path):
    v = report["verification"]
    none = msg("md_none")
    lines = [msg("md_title"), "",
             msg("md_file", name=path.name) if path else msg("md_file_not_written"),
             msg("md_base", base=report["base"]), msg("md_ancestor", ancestor=report["ancestor"]),
             msg("md_date", date=report["date"]), "",
             msg("md_changed_pous", count=len(report["changed_pous"])), ""]
    lines += [msg("md_changed_pou", name=p["name"], language=p["language"], lines=p["body_lines"])
              for p in report["changed_pous"]] or [none]
    lines += ["", msg("md_declarations", count=len(report["declarations"])), ""]
    lines += [f"- {d['pou']}.{d['variable']}: {msg('action_' + d['action'])}"
              f"{' — ' + d['detail'] if d['detail'] else ''}"
              for d in report["declarations"]] or [none]
    if report["ladder_converted"]:
        lines += ["", msg("md_ladder_title"), "",
                  *(msg("md_ladder_item", name=n) for n in report["ladder_converted"])]
    if report["newer_in_base"]:
        lines += ["", msg("md_newer_title"), "", *(f"- {n}" for n in report["newer_in_base"])]
    if report["convergent"]:
        lines += ["", msg("md_convergent_title"), "", *(f"- {n}" for n in report["convergent"])]
    if report["warnings"]:
        lines += ["", msg("md_warnings_title"), "", *(f"- {a}" for a in report["warnings"])]
    st, rei, fmt = v["structural"], v["reimport"], v["format"]
    ok, failed = msg("md_ok"), msg("md_failed")
    lines += ["", msg("md_verification_title"), "",
              msg("md_structural", result=ok if st["ok"] else failed),
              *(f"  - {x}" for x in st.get("problems", [])[:20]),
              msg("md_reimport", result=msg("md_reimport_ok") if rei["ok"]
                  else msg("md_reimport_differences", count=len(rei["differences"]))),
              *(f"  - {x}" for x in rei["differences"]),
              msg("md_format", result=ok if fmt["ok"] else failed),
              *(f"  - {x}" for x in fmt["problems"]),
              "", msg("md_result_ok") if v["ok"] else msg("md_result_failed"), ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--base", type=Path, help=msg("cli_base"))
    parser.add_argument("--out", "--saida", dest="out", type=Path, default=ROOT / "export")
    args = parser.parse_args()
    base = args.base or ROOT / "plcopen" / "original.xml"
    try:
        generated, report = export(ROOT, base, args.out)
    except ExportError as error:
        print(msg("error_prefix", error=error))
        sys.exit(2)
    target = write(generated, report, base_name(ROOT, base), args.out)
    sys.exit(0 if target else 1)


def base_name(root, base):
    """original.xml is a copy of the imported XML: the file is named after it."""
    base = Path(base)
    if base.resolve() == (root / "plcopen" / "original.xml").resolve():
        try:
            source = json.loads((root / "plcopen" / "manifest.json").read_text(encoding="utf-8")).get("source")
            if source:
                base = Path(source)
        except (OSError, ValueError):
            pass
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", base.stem)


def write(generated, report, stem, out):
    """Writes the XML only if verification passed; the report always."""
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{stem}_Full.xml"
    for old in (*out.glob("*_Full.xml"), *out.glob("*_Completo.xml")):  # _Completo: legacy name
        old.unlink()
    ok = report["verification"]["ok"]
    if ok:
        target.write_bytes(generated)
    (out / "EXPORT_REPORT.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "EXPORT_REPORT.md").write_text(report_markdown(report, target if ok else None), encoding="utf-8")
    print(report_markdown(report, target if ok else None))
    return target if ok else None


if __name__ == "__main__":
    main()
