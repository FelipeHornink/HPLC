#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/.plcsim/build"
GENERATED="$ROOT/.plcsim/generated/src"
STRUCPP_ROOT="${STRUCPP:-$HOME/.local/strucpp}"

SOURCE_PATHS=("$ROOT/types" "$ROOT/functions" "$ROOT/blocks" "$ROOT/globals" "$ROOT/programs" "$ROOT/routines")
BUILD_INPUTS=("$ROOT/runtime/source_names.py" "$ROOT/runtime/messages.py" "$ROOT/runtime/prepare_native.py" "$ROOT/runtime/import_plcopenxml.py" "$ROOT/plcopen/manifest.json" "$ROOT/plcopen/original.xml" "$ROOT/runtime/http_config.h" "$ROOT/runtime/build.py" "$ROOT/runtime/prepare_runtime.py" "$ROOT/runtime/generate_variable_catalog.py" "$ROOT/runtime/main.cpp" "$ROOT/plc.toml")
if [ -x "$BUILD/plc-runtime" ]; then
  NEED_BUILD=0
  for input in "${BUILD_INPUTS[@]}"; do
    if [ -e "$input" ] && [ "$input" -nt "$BUILD/plc-runtime" ]; then NEED_BUILD=1; break; fi
  done
  # Optional plc.toml directories may not exist. Without filtering, find fails,
  # pipefail propagates the failure and the changed-source check is lost.
  EXISTING_SOURCES=()
  for path in "${SOURCE_PATHS[@]}"; do [ -d "$path" ] && EXISTING_SOURCES+=("$path"); done
  if [ "$NEED_BUILD" = 0 ] && [ ${#EXISTING_SOURCES[@]} -gt 0 ]; then
    CHANGED_SOURCE="$(find "${EXISTING_SOURCES[@]}" -type f -newer "$BUILD/plc-runtime" -print -quit)"
    if [ -n "$CHANGED_SOURCE" ]; then NEED_BUILD=1; fi
  fi
  if [ "$NEED_BUILD" = 0 ]; then
    echo "BUILD OK (cache): $BUILD/plc-runtime"
    exit 0
  fi
fi

if [ ! -x "$STRUCPP_ROOT/strucpp" ]; then
  echo "ERROR: STruC++ compiler not found at $STRUCPP_ROOT/strucpp"
  exit 1
fi

mkdir -p "$BUILD/out"
python3 "$ROOT/runtime/prepare_runtime.py"
HPLC_SOURCE_ROOT="$GENERATED" python3 "$ROOT/runtime/build.py"
"$STRUCPP_ROOT/strucpp" "$BUILD/project.st" -o "$BUILD/out/project.cpp"
python3 "$ROOT/runtime/patch_generated.py" "$BUILD/out/project.cpp"
HPLC_SOURCE_ROOT="$GENERATED" python3 "$ROOT/runtime/generate_variable_catalog.py"
# -fpermissive: STruC++ 0.6.3 declares variables inside case without braces,
# which C++ treats as a jump over initialization.
g++ -std=c++17 -O0 -w -fpermissive -o "$BUILD/plc-runtime" \
  "$ROOT/runtime/main.cpp" "$BUILD/out/project.cpp" \
  -I"$BUILD" -I"$BUILD/out" -I"$STRUCPP_ROOT/runtime/include" -lpthread -lm
# The generator decides by itself: it only writes when the current screen does
# not point to tags of this project, so the user's adjustments are never overwritten.
python3 "$ROOT/runtime/generate_panel.py"
echo "BUILD OK: $BUILD/plc-runtime"
