# Contributing

Thanks for helping. Bug reports, vendor test files and pull requests are all welcome.

## Reporting a problem

Open an issue with:
- the HPLC version, your OS (Ubuntu or WSL2) and your VS Code version;
- what you did, what you expected and what happened;
- the relevant part of the **HPLC** output panel.
- For import or export problems, also attach `plcopen/IMPORT_REPORT.md` or
  `export/<…>/EXPORT_REPORT.md`.

**Never attach customer data.** Before you share a vendor XML, reduce it to the smallest
file that still shows the problem, and rename customer tags, POUs and comments.

## Vendor support

The most useful contribution is a small, anonymized PLCopenXML from an IDE that is not
covered yet (see the roadmap in the README), together with what you expected to happen.
Each case becomes a synthetic test in `tests/`; customer files are never committed.

## Development

The repository is the extension bundle, so there is no build step.

```bash
for t in tests/*.py; do python3 "$t"; done
for t in tests/test_*.js; do node "$t"; done   # the *_browser tests need Playwright
./package.sh --build-only                      # dist/hplc-<version>.vsix
```

- Keep user-visible text in English and add the Brazilian Portuguese translation:
  - `i18n.js` for the extension;
  - `package.nls*.json` for contributed commands and settings;
  - `runtime/messages.py` for reports and messages;
  - the `PT_BR` dictionaries in the panel pages.
- A change to the export must keep `_Full.xml` byte-identical for unchanged input. The
  tests in `tests/test_export_roundtrip.py` guard this.
