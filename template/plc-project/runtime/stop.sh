#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PID_FILE:-$ROOT/.plcsim/runtime.pid}"
PORT_FILE="${PORT_FILE:-$ROOT/.plcsim/runtime.port}"
PID_PORT_FILE="${PID_PORT_FILE:-$ROOT/.plcsim/runtime.pid-port}"

if [ ! -f "$PID_FILE" ]; then
  echo "PLC is already stopped."
  exit 0
fi

PID="$(tr -cd '0-9' < "$PID_FILE")"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  EXPECTED="$ROOT/.plcsim/build/plc-runtime"
  ACTUAL="$(readlink -f "/proc/$PID/exe" 2>/dev/null || true)"
  ACTUAL="${ACTUAL% (deleted)}"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "ERROR: PID $PID does not belong to this PLC; no process was stopped."
    rm -f "$PID_FILE"
    exit 1
  fi
  kill -TERM "$PID"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "Runtime did not respond to the normal shutdown; forcing it to stop."
    kill -KILL "$PID"
  fi
  echo "PLC stopped (PID $PID)."
else
  echo "Stale PID removed; the PLC was already stopped."
fi
rm -f "$PID_FILE"
rm -f "$PORT_FILE"
rm -f "$PID_PORT_FILE"
