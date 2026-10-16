# Simulation backend: STruC++

HPLC compiles the project's Structured Text with
[STruC++](https://github.com/Autonomy-Logic/STruCpp), which turns ST into C++17. The result
is linked with HPLC's runtime (`runtime/main.cpp`): a fixed-period scan loop, an HTTP API,
the HMI/P&ID pages, debugging (pause, step by scan, routine or line) and forcing.

## Your sources stay vendor-native

The files in `programs/`, `blocks/`, `globals/` and `types/` keep the vendor's form, so you
can paste them back into the IDE. Everything the compiler needs on top of that is done on a
throw-away copy in `.plcsim/generated/src`. Each adaptation is listed in
`plcopen/IMPORT_RULES.md`.

- **Qualified GVL access** (`Field.Valve[i]`). In IEC ST a GVL name is a property of the
  project tree, not a namespace, so `VAR_GLOBAL` blocks are anonymous. The generated copy
  turns each GVL into a struct with the GVL's name. `Field.AO` then reads the same in the
  source, the debugger and the panels. Members with the same name in different GVLs do
  not collide.
- **Vendor system services** (clock, date, day of week) are replaced by variables that the
  runtime fills: `SysTimeCore.SysTimeGetUs`, `GetDateAndTime` and
  `NextoStandard.GetDayOfWeek` today. Other vendors need their own mapping.
- **Vendor library types** (for example hardware diagnostic structures) exist only inside
  the vendor IDE. The import report lists them. They are kept as references in the XML, and
  simulation needs a compatible implementation or stub.
- **Qualifiers STruC++ rejects** (`RETAIN`/`PERSISTENT` on `VAR_OUTPUT`) are removed from
  the generated copy only.

## Known STruC++ issues worked around in the build

| Issue (STruC++ v0.6.x) | Workaround |
|---|---|
| A type with the same name as a struct member is renamed in the declaration but not at the use site | renamed consistently in the generated copy |
| `PROGRAM` calling another `PROGRAM` compiles but generates a call that does not exist | the call is generated as an instance call |
| A declaration inside `case` without braces fails with `jump to case label` | braces are added to the generated C++ |
| Calling a function-block instance declared as a global is not supported | the instance is moved into the calling program in the generated copy |

## License

The STruC++ compiler is GPL-3.0. Its C++ runtime has a runtime-library exception, so the
compiled program can be distributed under any license, the same arrangement as GCC. HPLC
calls the compiler as an external tool and does not ship it.
