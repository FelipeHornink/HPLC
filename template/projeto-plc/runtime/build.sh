#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/.plcsim/build"
MATIEC_ROOT="${MATIEC:-$HOME/.local/matiec}"

if [ ! -x "$MATIEC_ROOT/iec2c" ]; then
  echo "ERRO: compilador matiec não encontrado em $MATIEC_ROOT/iec2c"
  exit 1
fi

mkdir -p "$BUILD/out"
python3 "$ROOT/runtime/build.py"
"$MATIEC_ROOT/iec2c" -O l -I "$MATIEC_ROOT/lib" -T "$BUILD/out" "$BUILD/project.st"
python3 "$ROOT/runtime/generate_variable_catalog.py"
python3 "$ROOT/runtime/instrument_debug.py"
gcc -O2 -w -o "$BUILD/plc-runtime" \
  "$ROOT/runtime/main.c" "$BUILD/out/Config0.c" "$BUILD/out/Res0.c" \
  -I"$BUILD" -I"$BUILD/out" -I"$MATIEC_ROOT/lib/C" -lpthread -lm
echo "BUILD OK: $BUILD/plc-runtime"
