#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PID_FILE:-$ROOT/.plcsim/runtime.pid}"
PORT_FILE="${PORT_FILE:-$ROOT/.plcsim/runtime.port}"
PID_PORT_FILE="${PID_PORT_FILE:-$ROOT/.plcsim/runtime.pid-port}"

if [ ! -f "$PID_FILE" ]; then
  echo "PLC já está parado."
  exit 0
fi

PID="$(tr -cd '0-9' < "$PID_FILE")"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  EXPECTED="$ROOT/.plcsim/build/plc-runtime"
  ACTUAL="$(readlink -f "/proc/$PID/exe" 2>/dev/null || true)"
  ACTUAL="${ACTUAL% (deleted)}"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "ERRO: PID $PID não pertence a este PLC; nenhum processo foi encerrado."
    rm -f "$PID_FILE"
    exit 1
  fi
  kill -TERM "$PID"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "Runtime não respondeu ao encerramento normal; forçando parada."
    kill -KILL "$PID"
  fi
  echo "PLC parado (PID $PID)."
else
  echo "PID antigo removido; o PLC já estava parado."
fi
rm -f "$PID_FILE"
rm -f "$PORT_FILE"
rm -f "$PID_PORT_FILE"
