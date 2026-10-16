# Changelog

## 0.40.1

- Build errors that only show up in the C++ step (for example a typo read as a function
  call) now point at the `.st` file, line and column, with a plain-language message.
- "PLC did not start" counts only errors; warnings no longer appear as located errors.
- A failed build lists every error with file, line and column in the HPLC output.

## 0.40.0 — first public release

- **Import** PLCopenXML (CODESYS, MasterTool IEC XE): ST kept as is; Ladder and FBD
  converted to ST (edges, EN/ENO, standard functions); initial values, RETAIN, PERSISTENT
  and CONSTANT preserved.
- **Simulate** with a fixed-period scan, an HMI page and a P&ID page (browser or VS Code),
  with built-in screen editors.
- **Live code**: executed lines, values next to the code, pause and step by scan, routine
  or line, force and write variables.
- **Export**, each run in its own folder:
  - **Full**: byte-faithful round-trip to the original vendor project, with a three-way
    comparison against a newer IDE export and automatic verification;
  - **Logic only**: `_Application.xml` plus one `.st` file per POU.
- English by default; Brazilian Portuguese included (`hplc.language`).
- `examples/water-tank`: a complete demo project.
- Optional `hplc-control` extension: an authenticated local bridge so AI assistants can
  press Play and Stop in your VS Code window.
