# New PLC project

An HPLC project: IEC 61131-3 Structured Text that is compiled and simulated
on your machine, with a bench HMI and a P&ID page served by the runtime. It is an
engineering simulator, not a certified safety controller.

## Layout

```text
plc.toml     project manifest: name, HTTP ports, source folders and the cyclic task
io.toml      I/O map: one [[di]]/[[do]]/[[ai]]/[[ao]] block per physical channel
programs/    PROGRAMs; the task runs the one named in plc.toml (Main)
blocks/      FUNCTION_BLOCKs
functions/   FUNCTIONs
globals/     VAR_GLOBAL lists (GVLs)
types/       data types (STRUCT, enumerations, aliases)
routines/    ST fragments inlined into a POU with (* @ROUTINE file.st *)
panel/       bench HMI (panel.json) and P&ID (pid.json) screens
tests/       scenarios.yaml: automated set / pulse / wait / expect scenarios
runtime/     compiler driver, HTTP server and PLCopenXML tools (installed by the extension)
plcopen/     created when a vendor PLCopenXML is imported (original.xml, manifest.json)
export/      created by the PLCopenXML / ST export, one folder per run
Imports/     drop vendor XML files here to import them
.plcsim/     build output and simulator state (generated, not versioned)
```

Only the folders listed in `source_directories` of `plc.toml` are compiled.
Start by writing your logic in `programs/Main.st`, or import a PLCopenXML from
the vendor IDE. A complete example is available in `examples/water-tank/` of the
extension repository.
