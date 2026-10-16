const fs = require('fs');
const path = require('path');

// Generated driver: preserve project-owned runtime files and ST sources.
function prepareBuildScript(project) {
  const original = path.join(project, 'runtime/build.sh');
  let source = fs.readFileSync(original, 'utf8');
  const compiler = '"$STRUCPP_ROOT/strucpp" "$BUILD/project.st" -o "$BUILD/out/project.cpp"';
  if (!source.includes(compiler)) return original;
  source = source.replace(/^ROOT=.*$/m, 'ROOT="$HPLC_PROJECT_ROOT"\nif command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -u "$ROOT")"; HPLC_INSTRUMENT_SCRIPT="$(cygpath -u "$HPLC_INSTRUMENT_SCRIPT")"; fi');
  source = source.replace(compiler, compiler + ' --line-directives\npython3 "$HPLC_INSTRUMENT_SCRIPT" "$BUILD/out/project.cpp" "$BUILD/source_map.json"');
  source = source.replace(/^(BUILD_INPUTS=\([^\n]*\))$/m, '$1\nBUILD_INPUTS+=("$0" "$HPLC_INSTRUMENT_SCRIPT")');
  // Instrumentation fills trace history; size the debug response for its full
  // bounded capacity instead of the old 128 KiB buffer (which can overflow).
  const liveMain = path.join(project, '.plcsim/workbench-main.cpp');
  const runtimeSource = fs.readFileSync(path.join(project, 'runtime/main.cpp'), 'utf8');
  const instrumentedRuntime = runtimeSource.replace(/131072/g, '((MAX_DEBUG_TRACE * (MAX_TRACE_HISTORY + 1) * 12) + 8192)');
  fs.mkdirSync(path.dirname(liveMain), { recursive: true });
  if (!fs.existsSync(liveMain) || fs.readFileSync(liveMain, 'utf8') !== instrumentedRuntime) fs.writeFileSync(liveMain, instrumentedRuntime);
  source = source.replace('"$ROOT/runtime/main.cpp" "$BUILD/out/project.cpp"',
    '-I"$ROOT/runtime" "$ROOT/.plcsim/workbench-main.cpp" "$BUILD/out/project.cpp"');
  source = source.replace('BUILD_INPUTS+=("$0" "$HPLC_INSTRUMENT_SCRIPT")',
    'BUILD_INPUTS+=("$0" "$HPLC_INSTRUMENT_SCRIPT" "$ROOT/.plcsim/workbench-main.cpp")');
  const driver = path.join(project, '.plcsim/workbench-build.sh');
  fs.mkdirSync(path.dirname(driver), { recursive: true });
  if (!fs.existsSync(driver) || fs.readFileSync(driver, 'utf8') !== source) fs.writeFileSync(driver, source);
  return driver;
}
module.exports = { prepareBuildScript };
