#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/runtime/export_plcopenxml.py"

# O export tem de diferir do original apenas no corpo das POUs. Verificar isso
# aqui evita descobrir um XML recusado pelo fabricante so na tela dele.
ORIGINAL="$ROOT/plcopen/original.xml"
if [ -f "$ORIGINAL" ]; then
  GERADO="$(ls "$ROOT"/export/*_Completo.xml 2>/dev/null | head -1)"
  if [ -n "$GERADO" ]; then
    python3 "$ROOT/runtime/verify_export.py" "$ORIGINAL" "$GERADO"
  fi
fi
