# Migrating from PLC Codex to HPLC

Since 0.33.0 the extension is called **HPLC**:

| | before | now |
|---|---|---|
| extension id | `plc-codex.plc-codex` | `FelipeHornink.hplc` |
| control bridge | `plc-codex.plc-codex-control` | `FelipeHornink.hplc-control` |
| commands | `plcCodex.*` | `hplc.*` (the old ids still work as aliases) |

Projects do not change. `plc.toml`, `io.toml`, `.plcsim/` and each project's `runtime/`
keep working. Old file names such as `panel/painel.json` and `tests/cenarios.yaml` are
still read.

VS Code stores extension state by extension id. After the switch, choose the active project
again. Projects inside your workspace folders are rediscovered automatically. Add projects
outside the workspace again with **HPLC: Add project folder**.

Steps:
1. Stop running simulations.
2. Uninstall `plc-codex.plc-codex-control`, then `plc-codex.plc-codex`.
3. Install `hplc-<version>.vsix`, then `hplc-control-<version>.vsix`, and reload the window.
