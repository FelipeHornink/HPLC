#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PID_FILE:-$ROOT/.plcsim/runtime.pid}"
PORT_FILE="${PORT_FILE:-$ROOT/.plcsim/runtime.port}"
PID_PORT_FILE="${PID_PORT_FILE:-$ROOT/.plcsim/runtime.pid-port}"
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "ERRO: PLC já está executando (PID $OLD_PID)."
    exit 2
  fi
  rm -f "$PID_FILE"
fi
if [ "${PLC_CODEX_SKIP_BUILD:-0}" != "1" ]; then
  "$ROOT/runtime/build.sh"
fi
PANEL_PORT="${PLC_CODEX_PORT:-${PORT:-8100}}"
PROCESS_VIEW_PORT="${PLC_CODEX_PID_PORT:-$((PANEL_PORT + 1))}"
exec "$ROOT/.plcsim/build/plc-runtime" \
  --port "$PANEL_PORT" \
  --pid-port "$PROCESS_VIEW_PORT" \
  --pidfile "$PID_FILE" \
  --portfile "$PORT_FILE" \
  --pid-portfile "$PID_PORT_FILE" \
  --html "$ROOT/panel/index.html" \
  --panel-config "$ROOT/panel/painel.json" \
  --panel-dir "$ROOT/panel" \
  --pid-html "$ROOT/panel/pid.html" \
  --pid-config "$ROOT/panel/pid.json"
