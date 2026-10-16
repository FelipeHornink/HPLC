# Exporting back to the PLC IDE

**HPLC: Export** asks which of two kinds of export you want. Each export is written to its
own folder, `export/<YYYY-MM-DD_HHMMSS>_<full|logic>/`, so earlier exports are never
overwritten.

| Output | Use it for | Contents |
|---|---|---|
| `<name>_Full.xml` (**Full export**) | importing back into the **same** vendor project | the base vendor XML, byte for byte, edited only where the project changed |
| `<name>_Application.xml` (**Logic only**) | any IEC 61131-3 IDE: CODESYS, MasterTool, Schneider, ABB, WAGO… | the logic only, in ST, in plain PLCopen TC6 form |
| `routines/*.st` (**Logic only**) | pasting one POU at a time into any IDE | one file per POU, with declarations and body |
| `<name>_ST.st` (**Logic only**) | reading the whole project at once | every POU concatenated |
| `EXPORT_REPORT.md` / `.json` (**Full export**) | reviewing the export | what changed, plus the automatic verification |

`routines/` always works because it does not depend on any importer or schema. Create an
empty POU in the target IDE and paste the file into it.

## Logic only: `_Application.xml`

Validated on CODESYS 3.5 SP22 and MasterTool IEC XE 3.78:

1. In the target IDE, **select the `Application` node** in the device tree. Do not select
   the project root or the `Device`: the IDE then answers "no objects ... selected
   location".
2. Choose Project › Import PLCopenXML and pick `<name>_Application.xml`.
3. Set up the device, I/O mapping and vendor libraries by hand. Device descriptions, I/O
   mapping and vendor libraries are not portable, and PLCopenXML does not carry libraries.

What makes the file portable:
- Every POU is in ST. Ladder and FBD networks depend on vendor `addData` and would not
  import elsewhere.
- Vendor extensions are dropped, except attributes that change program semantics:
  `qualified_only`, `order_in_persistent_editor` and `hide`. Attributes tied to the
  original project (`checksumnoinit_override`, `init_related_code`) are removed.
- The TC6 child order is enforced: `addData` comes before `documentation`, and `task` comes
  before `globalVars`.
- A list that mixes `VAR_GLOBAL` and `VAR_GLOBAL CONSTANT` is split, with a `_Const` suffix
  on the constant part, because the standard forbids mixing them.
- The ST body is written as `<xhtml xmlns="http://www.w3.org/1999/xhtml">`. MasterTool
  rejects a prefixed `<xhtml:xhtml>`.

## Full export (round-trip): `_Full.xml`

`runtime/export_roundtrip.py` edits the **text** of the base vendor XML instead of
re-serializing it. The BOM, CRLF structure, `addData`, GUIDs, Ladder networks and comments
stay byte for byte. The vendor IDE already accepts the base file, and the generated file
differs from it only where the project changed, so it imports wherever the base imports.

### Choosing the base

- The default base is `plcopen/original.xml`, the XML the project was imported from.
- The base can also be a newer XML exported from the IDE after the import. The extension
  asks which one to use. On the command line, use `--base Imports/X.xml`.

### Three-way comparison per object (POU, GVL, DUT)

The comparison uses three versions of each object:
- the *ancestor*: `original.xml`;
- the *base*: the XML you chose;
- the *sources*: your current `.st` files.

Each XML is re-imported with the project's own importer, so all three are compared in the
same form:

| Situation | Result |
|---|---|
| changed only in HPLC | applied to the base |
| changed only in the base | kept as in the base |
| changed identically on both sides | nothing to do |
| changed differently on both sides | **conflict: the export aborts without writing** |

### What gets edited

- **POU bodies** are compared with a line diff. Unchanged lines are copied from the vendor
  text, with comments and trailing spaces intact. Only changed lines are written, using the
  vendor's escaping.
- **Declarations** can be added, changed (type, initial value, address), removed, or moved
  between sections (RETAIN, PERSISTENT, CONSTANT). They are written in the vendor's format.
  A `(* comment *)` on a new variable becomes its `documentation`. Existing `addData` is
  never rewritten.
- **Ladder POUs** you did not change stay untouched. A Ladder POU you changed in the
  simulator is exported as ST, with a `(* WARNING: POU originally in Ladder ... *)` line at
  the top. Its `LD_*` helper variables are declared in a section of their own. Both the
  report and the extension warn you.

### Not supported

The export aborts with a clear message in these cases:
- a POU, GVL or DUT was added or removed. That needs a GUID in the vendor's
  `ProjectStructure`, so create or delete the object in the IDE.
- the kind or return type of a POU changed;
- an enum or alias type changed;
- the project was imported with the old flattened-globals layout. Re-import it first.

A changed comment on an existing declaration is not exported. The importer does not read
`documentation`, so that change is not detected.

### Verification before writing

The `_Full.xml` is written only if all three checks pass:

1. **Structural:** outside the planned objects, the XML tree is identical to the base.
2. **Re-import:** the generated XML, re-imported, shows **0 differences** from the project
   sources. An object that is newer in the base is compared with the base instead.
3. **Format:** the BOM is unchanged, no bare LF is added to the structure, and every
   `xhtml` element is unprefixed.

## Command line

```bash
python3 runtime/export_plcopenxml.py --mode full  --base Imports/newer.xml
python3 runtime/export_plcopenxml.py --mode logic
python3 runtime/export_plcopenxml.py --mode both --out /tmp/out
```

The same options are available as environment variables: `HPLC_EXPORT_MODE`,
`HPLC_EXPORT_BASE` and `HPLC_EXPORT_DIR`. `HPLC_LANG` (`en` or `pt-BR`) sets the language
of the report.

## Why a vendor file does not import into another project

Neither MasterTool nor CODESYS uses `types/pous`. Both keep POUs and DUTs inside the
`http://www.3s-software.com/plcopenxml/pou` extension, and they tie every object to its
parent's GUID through `ProjectStructure`. That makes their file a round-trip format for the
same project, not an interchange format. This is why the logic-only export builds a fresh
file without those ties.

## References

- https://content.helpme-codesys.com/en/CODESYS%20Development%20System/_cds_cmd_import_plcopenxml.html
- https://content.helpme-codesys.com/en/CODESYS%20Development%20System/_cds_project_export_import.html
