#!/usr/bin/env bash
# Repackages this bundle as .vsix files (HPLC and the HPLC — Local control bridge).
# There is no build step: the repository holds the ready bundle, so packaging
# is just zipping it back into the vsix layout.
#
#   ./package.sh               builds both .vsix files and installs them in VS Code
#   ./package.sh --build-only  only builds them in dist/ (does not install or touch VS Code)
#
# The extension used to be called PLC Codex (plc-codex.plc-codex). Before
# installing HPLC for the first time, uninstall the old one: both would
# register the same legacy commands.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_ONLY=0
case "${1:-}" in
  --build-only|--so-gerar) BUILD_ONLY=1 ;;  # --so-gerar: legacy flag
esac
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"
CONTROL_VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/agent-control-extension/package.json'))['version'])")"
TARGET="$ROOT/dist/hplc-$VERSION.vsix"
CONTROL_TARGET="$ROOT/dist/hplc-control-$CONTROL_VERSION.vsix"

NODE="$(ls "$HOME"/.vscode-server/bin/*/node 2>/dev/null | head -1 || command -v node || true)"
if [ -n "$NODE" ]; then
  "$NODE" --check "$ROOT/extension.js"
  "$NODE" --check "$ROOT/i18n.js"
  "$NODE" --check "$ROOT/agent-control-extension/extension.js"
fi

mkdir -p "$ROOT/dist"
python3 - "$ROOT" "$TARGET" "$CONTROL_TARGET" <<'PY'
import json, sys, zipfile
from pathlib import Path
root, target, control_target = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
top_level = {"extension.vsixmanifest", "[Content_Types].xml"}
skip = {".git", "dist", "node_modules", "__pycache__", "tests", "backups", "agent-control-extension"}
skip_top = {"examples", "docs"}
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as vsix:
    for item in sorted(root.rglob("*")):
        if not item.is_file():
            continue
        relative = item.relative_to(root)
        if set(relative.parts) & skip or relative.parts[0] in skip_top or relative.name in {"package.sh", "empacotar.sh", ".gitignore"}:
            continue
        vsix.write(item, relative.as_posix() if relative.as_posix() in top_level else f"extension/{relative.as_posix()}")
print(f"built {target}")

# Control bridge: a separate extension, with its own manifest generated here.
package = json.loads((root / "agent-control-extension" / "package.json").read_text(encoding="utf-8"))
manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}" />
    <DisplayName>{package['displayName']}</DisplayName>
    <Description xml:space="preserve">{package['description']}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="{','.join(package.get('extensionDependencies', []))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
"""
with zipfile.ZipFile(control_target, "w", zipfile.ZIP_DEFLATED) as vsix:
    vsix.writestr("extension.vsixmanifest", manifest)
    vsix.write(root / "[Content_Types].xml", "[Content_Types].xml")
    for name in ("package.json", "extension.js"):
        vsix.write(root / "agent-control-extension" / name, f"extension/{name}")
    vsix.write(root / "agent-control.js", "extension/agent-control.js")
print(f"built {control_target}")
PY

if [ "$BUILD_ONLY" = 1 ]; then
  echo "Built without installing. To install: code --install-extension <vsix> --force"
  exit 0
fi
code --install-extension "$TARGET" --force
code --install-extension "$CONTROL_TARGET" --force
echo
echo "Installed. Run 'Developer: Reload Window' in VS Code."
