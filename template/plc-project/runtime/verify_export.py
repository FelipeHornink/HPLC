#!/usr/bin/env python3
"""Checks that the exported XML differs from the base only in the allowed objects.

Without this, the only way to know whether the file imports in MasterTool or
CODESYS was to try it and look at the screen. The contract is simple: if the
base imports, a file that differs from it only in the objects the project
changed imports too.

    python3 runtime/verify_export.py BASE.xml GENERATED.xml [--allow pou:Name ...]

Without --allow, only the text of <xhtml> may differ (old export contract).
"""
import argparse
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import msg  # noqa: E402


def local(e): return e.tag.split("}")[-1]


def paths_of(root):
    """Signature of each element: path + identifying attributes."""
    index = {}

    def descend(node, prefix):
        counter = Counter()
        for child in node:
            name = local(child)
            key = child.get("name") or child.get("Name") or child.get("typeName")
            if key is None:
                counter[name] += 1
                label = f"{name}[{counter[name]}]"
            else:
                label = f"{name}:{key}"
            path = f"{prefix}/{label}"
            index[path] = child
            descend(child, path)
    descend(root, "")
    return index


# Deliberate fixes of defects in the manufacturer's file (old contract).
FIXES = {"pouInstance": {"typeName"}}


def _fixed(path, before, after):
    kind = path.split("/")[-1].split(":")[0].split("[")[0]
    allowed = FIXES.get(kind, set())
    changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
    return changed and changed <= allowed and all(not before.get(k) for k in changed)


def compare(base, generated, allowed=None):
    """Compares two XML documents (bytes). `allowed`: labels like 'pou:Name'
    whose content may change. Returns {'ok', 'problems', 'summary'}."""
    a = paths_of(ET.fromstring(base))
    b = paths_of(ET.fromstring(generated))
    allowed = set(allowed or ())

    def free(path):
        return any(part in allowed for part in path.split("/"))

    only_base = sorted(c for c in set(a) - set(b) if not free(c))
    only_generated = sorted(c for c in set(b) - set(a) if not free(c))
    attributes, text = [], []
    for key in sorted(set(a) & set(b)):
        if a[key].attrib != b[key].attrib and not free(key) and not (
                not allowed and _fixed(key, a[key].attrib, b[key].attrib)):
            attributes.append(key)
        ta, tb = (a[key].text or "").strip(), (b[key].text or "").strip()
        if ta != tb and not free(key) and not (
                not allowed and key.split("/")[-1].split("[")[0] == "xhtml"):
            text.append(key)
    problems = ([msg("verify_only_base", path=c) for c in only_base]
                + [msg("verify_only_generated", path=c) for c in only_generated]
                + [msg("verify_attributes", path=c) for c in attributes]
                + [msg("verify_text", path=c) for c in text])
    return {"ok": not problems, "problems": problems,
            "summary": {"only_base": len(only_base), "only_generated": len(only_generated),
                        "attributes": len(attributes), "text": len(text)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("generated")
    parser.add_argument("--allow", "--permitir", dest="allow", action="append", default=[],
                        help="label such as pou:Name")
    args = parser.parse_args()
    with open(args.base, "rb") as fa, open(args.generated, "rb") as fb:
        r = compare(fa.read(), fb.read(), args.allow)
    for name, n in r["summary"].items():
        print(f"{name:14s} {n}")
    for p in r["problems"][:30]:
        print(f"  {p}")
    if not r["ok"]:
        print(msg("verify_failed"))
        sys.exit(1)
    print(msg("verify_ok"))


if __name__ == "__main__":
    main()
