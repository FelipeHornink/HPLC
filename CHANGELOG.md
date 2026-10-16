# Changelog

## 0.41.0

- **Starter project:** "HPLC: New PLC project" (and **New project…** in the HPLC view)
  offers a small working program to edit, with the HMI and P&ID ready: motor start/stop,
  run-time counter and blinking lamp.
- `examples/plcopen/water-tank-sample.xml`: a sample PLCopenXML file to try the import.
- Export of projects not imported from XML: GVL names are valid IEC identifiers (the
  numeric file prefix is dropped), and the file is named after the project.
- `docs/GETTING-STARTED.md`: step-by-step guide to the first program and the first import.

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
