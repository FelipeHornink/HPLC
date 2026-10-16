#!/usr/bin/env python3
"""Embeds panel-settings.js (English + pt-BR, language from window.hplcLang) into
the self-contained template pages, between the PLC_SETTINGS_START/END markers.

    python3 scripts/embed-panel-settings.py
"""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
shared = (root / 'panel-settings.js').read_text(encoding='utf-8')
for name in ['index.html', 'pid.html']:
    path = root / 'template/plc-project/panel' / name
    text = path.read_text(encoding='utf-8')
    new, count = re.subn(r'<!-- PLC_SETTINGS_START -->.*?<!-- PLC_SETTINGS_END -->',
                         lambda _: '<!-- PLC_SETTINGS_START -->\n<script>\n' + shared + '\n</script>\n<!-- PLC_SETTINGS_END -->',
                         text, flags=re.S)
    if not count:
        raise SystemExit(f'{path}: PLC_SETTINGS markers not found')
    path.write_text(new, encoding='utf-8')
    print(f'{path.name}: settings embedded')
