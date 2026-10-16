// Turns build output into diagnostics that point at the user's ST sources.
//
// The build has two compilers. STruC++ reports ST errors against project.st,
// which source_map.json maps back to the original file. Some mistakes pass
// STruC++ and only fail in g++ (for example `dddd (x > y)` is read as a call to
// an unknown function DDDD), and g++ reports them against the generated
// project.cpp, which means nothing to the user. The instrumented build writes
// `plc_debug_point(<project.st line>)` before every statement, so a C++ error is
// mapped to the statement before it and then, through the source map, to the
// .st file. Inside a statement that spans several lines, the identifier quoted
// in the error locates the exact line and column.
const fs = require('fs');
const path = require('path');

const ST_PATTERN = /^(.*?\.st):(\d+)(?:-(\d+)|:(\d+))?(?:\.\.(?:\d+)-(?:\d+))?\s*:\s*(?:(error|warning)\s*:\s*)?(.+)/i;
const CPP_PATTERN = /^(.*?project\.cpp):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.+)$/;
const QUOTED = /[‘'`"]([^’'`"]+)[’'`"]/;

// Friendly wording for the g++ messages users actually hit after an ST typo.
const CPP_RULES = [
  { pattern: /‘?([A-Za-z_]\w*)’? was not declared in this scope/, key: 'build.cpp.undeclared' },
  { pattern: /‘?([A-Za-z_]\w*)’? (?:is not a member of|has no member named)|has no member named ‘([A-Za-z_]\w*)’/, key: 'build.cpp.noMember' },
  { pattern: /‘?([A-Za-z_][\w.]*)’? cannot be used as a function|no match for call to/, key: 'build.cpp.notCallable' },
  { pattern: /no match for ‘operator|invalid operands/, key: 'build.cpp.badOperands' },
  { pattern: /cannot convert|invalid conversion|could not convert/, key: 'build.cpp.badConversion' }
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) { return []; }
}

// project.st line of the statement that contains generated C++ line `cppLine`.
function statementLine(cppLines, cppLine) {
  for (let i = Math.min(cppLine, cppLines.length) - 1; i >= 0; i--) {
    const point = /plc_debug_point\((\d+)U?\)/.exec(cppLines[i]) || /plc_debug_routine\(\d+U?,\s*(\d+)U?\)/.exec(cppLines[i]);
    if (point) return Number(point[1]);
    if (/^(?:void|[A-Za-z_][\w:<>]*)\s+[A-Za-z_][\w:]*::operator\(\)\(\)\s*\{/.test(cppLines[i])) return undefined;
  }
  return undefined;
}

// Finds `name` (case-insensitive, whole word) from the statement start onwards.
function locateName(sourceLines, startLine, name) {
  if (!name) return undefined;
  const word = new RegExp(`(^|[^A-Za-z0-9_])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![A-Za-z0-9_])`, 'i');
  for (let line = startLine; line < Math.min(sourceLines.length, startLine + 40); line++) {
    const code = sourceLines[line - 1].replace(/\/\/.*$/, '').replace(/\(\*.*?\*\)/g, '');
    const match = word.exec(code);
    if (match) return { line, column: match.index + match[1].length + 1, length: match[2].length, text: match[2] };
    if (line > startLine && /;\s*$/.test(code.trim())) break;
  }
  return undefined;
}

function explainCpp(message) {
  for (const rule of CPP_RULES) {
    const match = rule.pattern.exec(message);
    if (match) {
      const name = match.slice(1).find(Boolean) || (QUOTED.exec(message) || [])[1];
      return { key: rule.key, name: name ? name.split('::').pop() : undefined };
    }
  }
  return { key: 'build.cpp.other', name: (QUOTED.exec(message) || [])[1] };
}

/**
 * Parses build output. Returns diagnostics with project-relative files:
 * { file, line, column, length, severity: 'error'|'warning', compiler: 'st'|'cpp',
 *   message, key?, params? } — `key/params` are i18n keys for C++ errors.
 */
function parseBuildOutput(project, text) {
  const build = path.join(project, '.plcsim', 'build');
  const sourceMap = readJson(path.join(build, 'source_map.json'));
  let cppLines;
  const results = [];
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    let match = CPP_PATTERN.exec(raw);
    if (match) {
      cppLines ||= readLines(path.join(build, 'out', 'project.cpp'));
      const severity = match[4] === 'warning' ? 'warning' : 'error';
      const explained = explainCpp(match[5]);
      const stLine = statementLine(cppLines, Number(match[2]));
      const mapped = stLine && sourceMap.lines?.[String(stLine)];
      let file = 'project.cpp', line = Number(match[2]), column = Number(match[3]), length = 1;
      if (mapped) {
        file = mapped.file; line = mapped.line; column = 1;
        const found = locateName(readLines(path.join(project, file)), line, explained.name);
        if (found) { ({ line, column, length } = found); explained.name = found.text; }
      }
      const key = `${file}:${line}:${column}:${match[5]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ file, line, column, length, severity, compiler: 'cpp', message: match[5].trim(),
        key: explained.key, params: { name: explained.name || '', detail: match[5].trim() }, mapped: Boolean(mapped) });
      continue;
    }
    match = ST_PATTERN.exec(raw);
    if (!match) continue;
    let file = match[1], line = Number(match[2]), column = Number(match[3] || match[4] || 1);
    if (path.basename(file) === 'project.st') {
      const mapped = sourceMap.lines?.[String(line)];
      if (mapped) { file = mapped.file; line = mapped.line; column = 1; }
    }
    if (path.isAbsolute(file)) file = path.relative(project, file);
    results.push({ file, line, column, length: 1, severity: (match[5] || '').toLowerCase() === 'warning' ? 'warning' : 'error',
      compiler: 'st', message: match[6].trim(), mapped: true });
  }
  return results;
}

module.exports = { parseBuildOutput, statementLine, locateName, explainCpp };
