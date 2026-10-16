const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// This index uses the compiled snapshot. Editing an ST file cannot silently
// change the source shown for an already running binary.
// POU kind and name from a source file. Comments are ignored, and the keyword must
// start a line: a header comment such as "the program reads from top to bottom"
// would otherwise be taken for PROGRAM reads.
function pouHeader(text) {
  const code = text.replace(/\(\*[\s\S]*?\*\)/g, match => match.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
  return code.match(/^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)/im);
}

function buildModel(project) {
  const build = path.join(project, '.plcsim/build');
  const compiled = fs.readFileSync(path.join(build, 'project.st'), 'utf8');
  const sourceMapText = fs.readFileSync(path.join(build, 'source_map.json'), 'utf8');
  const sourceMap = JSON.parse(sourceMapText);
  const compiledLines = compiled.split(/\r?\n/);
  const files = {};
  for (const [id, location] of Object.entries(sourceMap.lines || {})) {
    if (!['functions', 'blocks', 'programs', 'routines'].includes(location.kind) || !location.file || !Number.isInteger(location.line) || location.line < 1) continue;
    const unit = files[location.file] ||= { file: location.file, kind: location.kind, indexed: new Map() };
    const row = unit.indexed.get(location.line) || { line: location.line, text: compiledLines[Number(id) - 1] || '', projectLines: [] };
    row.projectLines.push(Number(id)); unit.indexed.set(location.line, row);
  }
  for (const unit of Object.values(files)) {
    const snapshot = path.resolve(project, '.plcsim/generated/src', unit.file);
    const base = path.resolve(project, '.plcsim/generated/src') + path.sep;
    let text;
    if (snapshot.startsWith(base)) try { text = fs.readFileSync(snapshot, 'utf8'); } catch (_) {}
    unit.rows = text !== undefined ? text.split(/\r?\n/).map((text, i) => ({ line: i + 1, text, projectLines: unit.indexed.get(i + 1)?.projectLines || [] })) : [...unit.indexed.values()].sort((a, b) => a.line - b.line);
    unit.text = unit.rows.map(r => r.text).join('\n');
    const header = pouHeader(unit.text);
    unit.name = header?.[2] || path.basename(unit.file, '.st');
    unit.pouKind = header?.[1] || 'ROUTINE';
    delete unit.indexed;
  }
  const units = Object.values(files);
  const names = new Map(units.map(u => [u.name.toUpperCase(), u]));
  function declarations(text) {
    const result = new Map();
    for (const section of text.matchAll(/\bVAR(?:_\w+)?\b([\s\S]*?)\bEND_VAR\b/gi)) {
      for (const declaration of section[1].matchAll(/(?:^|;)\s*([\w\s,]+?)\s*(?:AT\s+%\S+\s*)?:\s*([A-Za-z_]\w*)/g)) {
        for (const name of declaration[1].split(',')) result.set(name.trim().toUpperCase(), declaration[2].toUpperCase());
      }
    }
    return result;
  }
  const uncomment = text => text.replace(/\(\*[\s\S]*?\*\)|\/\/[^\n]*/g, ' ').replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, ' ');
  const globals = declarations(uncomment(compiled));
  for (const unit of units) {
    const local = declarations(uncomment(unit.text));
    const calls = [];
    // Preserve source order, including inline @ROUTINE expansion markers.
    const body = unit.text.replace(/\bVAR(?:_\w+)?\b[\s\S]*?\bEND_VAR\b/gi, m => m.replace(/[^\n]/g, ' '))
      .replace(/\(\*[\s\S]*?\*\)|\/\/[^\n]*|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
        m => /^\(\*\s*@ROUTINE\b/i.test(m) ? m : m.replace(/[^\n]/g, ' '));
    for (const row of body.split(/\r?\n/)) {
      const mark = row.match(/\(\*\s*@ROUTINE\s+([^*]+?)\s*\*\)/i);
      if (mark) {
        const file = path.posix.join('routines', mark[1].trim());
        if (files[file]) calls.push({ file, label: files[file].name });
        continue;
      }
      // Calls may occur inside IFs and expressions, not only at line start.
      for (const match of uncomment(row).matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
        const token = match[1];
        const type = local.get(token.toUpperCase()) || globals.get(token.toUpperCase()) || token.toUpperCase();
        const target = names.get(type);
        if (target) calls.push({ file: target.file, label: target.name, instance: token });
      }
    }
    const seen = new Set();
    unit.calls = calls.filter(c => { const key = c.file + ':' + (c.instance || c.label); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  const configured = compiled.match(/PROGRAM\s+\w+\s+WITH\s+\w+\s*:\s*(\w+)/i)?.[1];
  const root = names.get(configured?.toUpperCase()) || units.find(u => u.kind === 'programs') || units[0];
  const reached = new Set();
  function branch(unit, label, ancestors = [], id = 'main', instance = '') {
    reached.add(unit.file);
    const recursive = ancestors.includes(unit.file);
    return { id, file: unit.file, label: label || unit.name, instance, recursive,
      children: recursive || ancestors.length >= 12 ? [] : unit.calls.map((call, i) => branch(files[call.file], unit.calls.filter(c => c.file === call.file).length > 1 && call.instance ? `${call.label} (${call.instance})` : call.label, [...ancestors, unit.file], `${id}.${i}`, call.instance)) };
  }
  const tree = root ? [branch(root)] : [];
  // Keep every available POU accessible even when statically unresolved.
  const others = units.filter(u => !reached.has(u.file)).map((u, i) => branch(u, u.name, [], `other.${i}`));
  let points = [];
  try { points = JSON.parse(fs.readFileSync(path.join(build, 'debug_points.json'), 'utf8')); } catch (_) {}
  return { files, tree, others, main: root?.file, lines: sourceMap.lines || {}, points,
    revision: crypto.createHash('sha256').update(compiled).update(sourceMapText).update(JSON.stringify(files)).update(JSON.stringify(points)).digest('hex') };
}

function executionState(model, debug) {
  const executed = {};
  for (const id of debug.trace || []) {
    const location = model.lines[String(id)];
    if (location && model.files[location.file]) (executed[location.file] ||= []).push(location.line);
  }
  for (const file of Object.keys(executed)) executed[file] = [...new Set(executed[file])];
  const paused = Boolean(debug.waiting_line || debug.waiting_routine);
  const id = paused ? debug.current_line : debug.current_line || debug.trace?.at(-1);
  const location = model.lines[String(id)];
  return { executed, current: location && model.files[location.file] ? { file: location.file, line: location.line, paused } : null };
}
module.exports = { buildModel, executionState, pouHeader };
