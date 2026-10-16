#!/usr/bin/env python3
"""Instrument only executable C++ statements carrying STruC++ source locations."""
import json
import re
import sys
from pathlib import Path


def instrument(target, source_map):
    mapping = source_map.get('lines', {})
    routines = {r['file']: i + 1 for i, r in enumerate(source_map.get('routines', []))}
    lines = target.read_text().splitlines()
    output = ['extern void plc_debug_point(unsigned int);', 'extern void plc_debug_routine(unsigned int, unsigned int);']
    location = None
    pending = False
    points = set()
    previous_file = None
    for line in lines:
        directive = re.match(r'^\s*#line\s+(\d+)\s+"[^"]*project\.st"', line)
        if directive:
            location = int(directive[1])
            pending = True
            continue
        code = line.strip()
        mapped = mapping.get(str(location), {})
        # Never insert calls between an if and else, before closing braces,
        # case labels or outside statements. The generated compiler wraps bodies.
        executable = code and line[0].isspace() and not code.startswith(('}', '{', '//', '#', 'case ', 'default:', 'else', 'catch'))
        if pending and executable and mapped.get('kind') in {'functions', 'blocks', 'programs', 'routines'}:
            indent = line[:len(line) - len(line.lstrip())]
            file = mapped.get('file')
            if file != previous_file and file in routines:
                output.append(f'{indent}::plc_debug_routine({routines[file]}U, {location}U);')
            output.append(f'{indent}::plc_debug_point({location}U);')
            previous_file = file
            points.add(location)
            pending = False
        elif code and not code.startswith('//'):
            pending = False
        output.append(line)
    target.write_text('\n'.join(output) + '\n')
    return sorted(points)


if __name__ == '__main__':
    target = Path(sys.argv[1])
    points = instrument(target, json.loads(Path(sys.argv[2]).read_text()))
    (target.parent.parent / 'debug_points.json').write_text(json.dumps(points))
    print(f'Live code: {len(points)} ST points instrumented')
