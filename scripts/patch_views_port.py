#!/usr/bin/env python3
"""Makes the HMI <-> P&ID buttons of the pages ask the runtime for the real port.

Old pages assumed P&ID = HMI + 1. When the extension changes the preferred port
(busy, for example by VS Code port forwarding), the button opened the wrong
place. The runtime reports the effective ports at /api/views; the +-1 guess
is kept only as a fallback. Idempotent; works on the template and on existing
projects, including pages that still carry the legacy Portuguese helper
(`abrirVista`), which is replaced by the current `openView`.

    python3 scripts/patch_views_port.py <project>/panel/index.html <project>/panel/pid.html
"""
import re
import sys

HELPER = ("function openView(which,fallback){const tab=window.open('about:blank','_blank');"
          "(window.hplcViews?.[which]?Promise.resolve(window.hplcViews):fetch('/api/views').then(r=>r.ok?r.json():Promise.reject()))"
          ".then(v=>v[which]||fallback).catch(()=>fallback).then(port=>{const url=location.protocol+'//'+location.hostname+':'+port;"
          "if(tab)tab.location=url;else window.open(url,'_blank')})}")
# Oldest pages: the button computed the port inline.
INLINE = re.compile(r"window\.open\(location\.protocol\+'//'\+location\.hostname\+':'\+\(Number\(location\.port\)([+-])1\),'_blank'\)")
# Any previous version of the helper, current name or legacy name (abrirVista).
OLD_HELPER = re.compile(r"function (?:openView|abrirVista)\(.*?window\.open\(url,'_blank'\)\}\)\}")
LEGACY_CALL = re.compile(r"\babrirVista\(")


def patch(text):
    if OLD_HELPER.search(text):
        new = OLD_HELPER.sub(lambda _: HELPER, text, count=1)
        new = LEGACY_CALL.sub("openView(", new)
        return new, int(new != text)
    changes = 0

    def replace(m):
        nonlocal changes
        changes += 1
        which = "pid" if m.group(1) == "+" else "panel"
        return f"openView('{which}',Number(location.port){m.group(1)}1)"
    new = INLINE.sub(replace, text)
    if not changes:
        return text, 0
    # The declaration goes at the start of the first button statement (hoisting).
    m = re.search(r"\$\('(?:pidButton|commandsButton)'\)\.onclick=", new)
    return new[:m.start()] + HELPER + ";" + new[m.start():], changes


if __name__ == "__main__":
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        new, n = patch(text)
        if n:
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)
        print(f"{path}: {n} button(s) patched" if n else f"{path}: nothing to patch")
