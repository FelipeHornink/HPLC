"""Namespace/library adaptations applied only to the backend copy."""
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
import import_plcopenxml as imp
from messages import msg
from source_names import map_code

FOLDERS = ('types', 'functions', 'blocks', 'globals', 'programs', 'routines')


def prepare(root):
    if not (root / 'plcopen/manifest.json').exists(): return None, []
    metadata = json.loads((root / 'plcopen/manifest.json').read_text())
    if metadata.get('globalsLayout') != 'qualified':
        return None, []
    xml = ET.parse(root / 'plcopen/original.xml').getroot()
    lists = imp.collect_globals(xml)
    program_names = {p.get('name', '').upper() for p in xml.iter()
                     if imp.local(p) == 'pou' and p.get('pouType') == 'program'}
    qualified = {(g.upper(), v.get('name').upper()): imp.flatten_name(g, v.get('name'))
                 for g, variables in lists.items() for v in variables}
    owners = {}
    for g, variables in lists.items():
        for v in variables: owners.setdefault(v.get('name').upper(), []).append((g, v.get('name')))
    unique = {n: imp.flatten_name(*pairs[0]) for n, pairs in owners.items() if len(pairs) == 1}
    def rewrite(source):
        locals_ = imp.declared_names(source)
        def qualify(code):
            return imp.QUALIFIED.sub(lambda m: qualified.get((m[1].upper(), m[2].upper()), m[0])
                                     if m[1].upper() not in locals_ else m[0], code)
        header, body = imp.split_body(source)
        header = map_code(header, qualify)
        def names(code):
            code = qualify(code)
            def bare(m):
                name = m[1].upper()
                if name in locals_: return m[0]
                if name in program_names and re.match(r'\s*\(', code[m.end():]): return m[0]
                return unique.get(name, m[0])
            return imp.IDENTIFIER.sub(bare, code)
        return header + map_code(body, names)
    sources, report = {}, []
    services = {}
    for folder in FOLDERS:
        if folder == 'globals': continue
        for f in sorted((root / folder).glob('*.st')):
            text = f.read_text()
            # Clock of the original POU, already updated at the start of Main.
            # The backend uses the same monotonic sample provided by the platform.
            clock = re.compile(r'\bSpecialVariablesPrg\s*\.\s*uliSystemTime\b', re.I)
            text = map_code(text, lambda code: clock.sub('System_TimeUs', code))
            text = rewrite(text)
            text = map_code(text, lambda code: imp.apply_system_services(code, services))
            name = f'{folder}/{f.name}'
            sources[name] = text
            if text != f.read_text():
                report.append({'source': name, 'changed': True, 'transformations': [{
                    'rule': 'manufacturer.namespace-services-in-copy',
                    'reason': 'Qualified GVLs and native services kept in the official source; flattening only for the backend.',
                    'occurrences': 1}]})
    # Each native list keeps all its blocks and qualifiers from the XML.
    for entry in metadata['globalVars']:
        name = entry['file']
        text = (root / name).read_text()
        text = re.sub(r"\{attribute\b[^}]*\}", '', text, flags=re.I)
        members = {m.upper(): f"{entry['name']}_{m}" for m in entry['members']}
        def section(match):
            body = match.group(2)
            # Rename only the declared identifier, never struct members.
            body = re.sub(r'(?m)^(\s*)([A-Za-z_]\w*)(\s+(?:AT\s+%\S+\s*)?:|\s*:)',
                          lambda m: m.group(1) + members.get(m.group(2).upper(), m.group(2)) + m.group(3), body)
            return 'VAR_GLOBAL' + match.group(1) + map_code(body, rewrite) + 'END_VAR'
        text = re.sub(r'\bVAR_GLOBAL\b((?:\s+(?:RETAIN|PERSISTENT|CONSTANT|NON_RETAIN)\b)*)(.*?)\bEND_VAR\b',
                      section, text, flags=re.S | re.I)
        sources[name] = text
        report.append({'source': name, 'changed': True, 'transformations': [{
            'rule': 'gvl.name-only-in-backend', 'reason': 'The backend does not represent named GVLs.', 'occurrences': len(members)}]})
    block_types = {p.get('name', '').upper() for p in xml.iter()
                   if imp.local(p) == 'pou' and p.get('pouType') == 'functionBlock'}
    moved, pending = [], []
    sources = imp.relocate_global_blocks(sources, lists, block_types, moved, pending)
    if pending: raise ValueError(msg('native_unsupported_globals', items=pending))
    for variable, kind, destination in moved:
        for name in sources:
            if name.startswith('globals/'):
                sources[name] = re.sub(rf'(?m)^\s*{re.escape(variable)}\s*:[^;]+;[^\n]*\n', '\n', sources[name], flags=re.I)
        report.append({'source': destination, 'changed': True, 'transformations': [{
            'rule': 'fb.global-local-in-backend', 'reason': f'{variable} stays global in the native source; local instance only in the backend.', 'occurrences': 1}]})
    declared_types = {m.upper() for name, text in sources.items() if name.startswith('types/')
                      for m in re.findall(r'\bTYPE\s+(\w+)', text, re.I)}
    for name, definition in imp.PORTABLE_LIBRARY_TYPES.items():
        if name.upper() not in declared_types:
            sources[f'types/98_{name}.generated.st'] = definition
    # There are no System_* variables in the official sources.
    if services or any('System_TimeUs' in s for s in sources.values()):
        sources['globals/98_system.generated.st'] = 'VAR_GLOBAL\n' + ''.join(
            f'    {name} : {kind};\n' for name, kind, _ in imp.SYSTEM_VARIABLES) + 'END_VAR\n'
    return sources, report
