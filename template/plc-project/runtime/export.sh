#!/usr/bin/env bash
# Exports PLCopenXML (full and application) and ST. Optional arguments:
#   --base XML          manufacturer XML that receives the changes (default: plcopen/original.xml)
#   --mode full|logic|both
#   --out DIR           export folder (default: export/YYYY-MM-DD_HHMMSS_<mode>)
# Verification (only the planned objects differ from the base, re-import equals
# the sources, manufacturer's format kept) runs inside the export, before
# writing; the result goes to EXPORT_REPORT.md in the export folder.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/runtime/export_plcopenxml.py" "$@"
