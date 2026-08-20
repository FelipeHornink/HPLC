#!/usr/bin/env bash
# Reempacota este bundle como .vsix e instala no VS Code do usuario atual.
# Nao ha build: o repositorio guarda o bundle ja pronto extraido do pacote
# de transferencia, entao empacotar e apenas zipar de volta no layout do vsix.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSAO="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
DESTINO="$ROOT/dist/plc-codex-$VERSAO.vsix"

NODE="$(ls "$HOME"/.vscode-server/bin/*/node 2>/dev/null | head -1 || true)"
if [ -n "$NODE" ]; then "$NODE" --check "$ROOT/extension.js"; fi

mkdir -p "$ROOT/dist"
python3 - "$ROOT" "$DESTINO" <<'PY'
import sys, zipfile
from pathlib import Path
root, destino = Path(sys.argv[1]), Path(sys.argv[2])
raiz = {"extension.vsixmanifest", "[Content_Types].xml"}
ignorar = {".git", "dist", "node_modules", "__pycache__"}
with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as vsix:
    for caminho in sorted(root.rglob("*")):
        if not caminho.is_file():
            continue
        relativo = caminho.relative_to(root)
        if set(relativo.parts) & ignorar or relativo.name in {"empacotar.sh", ".gitignore"}:
            continue
        vsix.write(caminho, relativo.as_posix() if relativo.as_posix() in raiz else f"extension/{relativo.as_posix()}")
print(f"gerado {destino}")
PY

code --install-extension "$DESTINO" --force
echo
echo "Instalado. Execute 'Developer: Reload Window' no VS Code."
