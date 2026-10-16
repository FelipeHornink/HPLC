#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PID_FILE:-$ROOT/.plcsim/runtime.pid}"
PORT_FILE="${PORT_FILE:-$ROOT/.plcsim/runtime.port}"
PID_PORT_FILE="${PID_PORT_FILE:-$ROOT/.plcsim/runtime.pid-port}"
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "ERROR: PLC is already running (PID $OLD_PID)."
    exit 2
  fi
  rm -f "$PID_FILE"
fi
if [ "${HPLC_SKIP_BUILD:-${PLC_CODEX_SKIP_BUILD:-0}}" != "1" ]; then
  "$ROOT/runtime/build.sh"
fi
PANEL_PORT="${HPLC_PORT:-${PLC_CODEX_PORT:-${PORT:-8100}}}"
PROCESS_VIEW_PORT="${HPLC_PID_PORT:-${PLC_CODEX_PID_PORT:-$((PANEL_PORT + 1))}}"
# panel/panel.json is the current name; panel/painel.json is the legacy one.
PANEL_CONFIG="$ROOT/panel/panel.json"
if [ ! -f "$PANEL_CONFIG" ] && [ -f "$ROOT/panel/painel.json" ]; then PANEL_CONFIG="$ROOT/panel/painel.json"; fi
exec "$ROOT/.plcsim/build/plc-runtime" \
  --port "$PANEL_PORT" \
  --pid-port "$PROCESS_VIEW_PORT" \
  --pidfile "$PID_FILE" \
  --portfile "$PORT_FILE" \
  --pid-portfile "$PID_PORT_FILE" \
  --html "$ROOT/panel/index.html" \
  --panel-config "$PANEL_CONFIG" \
  --panel-dir "$ROOT/panel" \
  --pid-html "$ROOT/panel/pid.html" \
  --pid-config "$ROOT/panel/pid.json"
