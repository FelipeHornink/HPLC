#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/.plcsim/build"
GENERATED="$ROOT/.plcsim/generated/src"
STRUCPP_ROOT="${STRUCPP:-$HOME/.local/strucpp}"

SOURCE_PATHS=("$ROOT/types" "$ROOT/functions" "$ROOT/blocks" "$ROOT/globals" "$ROOT/programs" "$ROOT/routines")
BUILD_INPUTS=("$ROOT/runtime/build.py" "$ROOT/runtime/prepare_runtime.py" "$ROOT/runtime/generate_variable_catalog.py" "$ROOT/runtime/main.cpp" "$ROOT/plc.toml")
if [ -x "$BUILD/plc-runtime" ]; then
  NEED_BUILD=0
  for input in "${BUILD_INPUTS[@]}"; do
    if [ -e "$input" ] && [ "$input" -nt "$BUILD/plc-runtime" ]; then NEED_BUILD=1; break; fi
  done
  # Diretorios opcionais de plc.toml podem nao existir. Sem filtrar, o find
  # falha, o pipefail propaga a falha e a checagem de fonte alterada e perdida.
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
  echo "ERRO: compilador STruC++ nao encontrado em $STRUCPP_ROOT/strucpp"
  exit 1
fi

mkdir -p "$BUILD/out"
python3 "$ROOT/runtime/prepare_runtime.py"
PLC_CODEX_SOURCE_ROOT="$GENERATED" python3 "$ROOT/runtime/build.py"
"$STRUCPP_ROOT/strucpp" "$BUILD/project.st" -o "$BUILD/out/project.cpp"
python3 "$ROOT/runtime/patch_generated.py" "$BUILD/out/project.cpp"
PLC_CODEX_SOURCE_ROOT="$GENERATED" python3 "$ROOT/runtime/generate_variable_catalog.py"
# -fpermissive: o STruC++ 0.6.3 declara variavel dentro de case sem chaves,
# o que o C++ trata como salto sobre inicializacao.
g++ -std=c++17 -O0 -w -fpermissive -o "$BUILD/plc-runtime" \
  "$ROOT/runtime/main.cpp" "$BUILD/out/project.cpp" \
  -I"$BUILD" -I"$BUILD/out" -I"$STRUCPP_ROOT/runtime/include" -lpthread -lm
# O proprio gerador decide: so escreve se a tela atual nao aponta para tags
# deste projeto. Assim o ajuste do usuario nunca e sobrescrito.
python3 "$ROOT/runtime/generate_panel.py"
echo "BUILD OK: $BUILD/plc-runtime"
