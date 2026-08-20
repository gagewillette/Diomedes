// Per-language parsers, as pure functions over a string.
//
// Nothing in here touches the DOM, ProseMirror or the editor. That is the
// point: the worker imports this module and so does the test suite, so the
// parsing rules are pinned by ordinary `node --test` assertions rather than by
// driving a browser.
//
// Every adapter returns diagnostics addressed in **character offsets into the
// code text**. The plugin turns an offset into a document position with
// `nodePos + 1 + offset` and never needs to know which parser produced it, so
// adding a language later is a change to this file alone.
//
// Two deliberate omissions, both from the issue's own risk list:
//
//   * Python is checked with a structural pass (brackets, string terminators,
//     indentation, block headers), not with ruff. `@astral-sh/ruff-wasm-web` is
//     ~1.5 MB of WebAssembly, and shipping that to colour four lines of YAML on
//     an unrelated page is the wrong trade. The adapter table is an interface;
//     swapping this one implementation for ruff later changes nothing else.
//   * TypeScript is not checked at all. There is no tsconfig here, no program
//     and no cross-file resolution, so anything we could say would be about
//     syntax only, and `typescript` is far too large to carry for that.

/** A diagnostic. `from`/`to` are offsets into the code, `to` exclusive. */
const at = (from, to, message, { severity = 'error', source } = {}) => ({
  from: Math.max(0, from),
  to: Math.max(from + 1, to),
  severity,
  message,
  source,
});

/** Offset of the start of 1-based `line`, plus 0-based `column`. */
export function offsetAt(code, line, column = 0) {
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const nl = code.indexOf('\n', offset);
    if (nl === -1) return code.length;
    offset = nl + 1;
  }
  return Math.min(code.length, offset + column);
}

/** The offset of the end of the line containing `offset`. */
const endOfLine = (code, offset) => {
  const nl = code.indexOf('\n', offset);
  return nl === -1 ? code.length : nl;
};

// ---------------------------------------------------------------- JSON

// Locating a JSON syntax error is entirely a matter of reading the engine's
// mind, because `SyntaxError` carries no structured position. There are two
// message shapes in the wild and both are handled:
//
//   * "... in JSON at position 8 (line 1 column 9)" — V8 for most errors, and
//     SpiderMonkey. The offset is right there.
//   * "Unexpected token ',', ...\"…snippet…\" is not valid JSON" — V8 when it
//     decides a context window reads better than a number. The window is
//     centred on the failure, so the snippet is located in the source and then
//     the occurrence of the offending token nearest the middle of that window
//     is the one the engine meant.
//
// Getting this wrong misplaces a squiggle; it never breaks anything, so both
// paths fall back to offset 0 rather than throwing.
const JSON_AT_POSITION = /at position (\d+)/i;
const JSON_LINE_COLUMN = /at line (\d+) column (\d+)/i;
const JSON_SNIPPET = /Unexpected token '(.)',\s*(?:\.\.\.)?"([\s\S]*)"(?:\.\.\.)?\s*is not valid JSON/;

function jsonErrorOffset(code, message) {
  const position = message.match(JSON_AT_POSITION);
  if (position) return Math.min(code.length, Number(position[1]));
  const lineColumn = message.match(JSON_LINE_COLUMN);
  if (lineColumn) return offsetAt(code, Number(lineColumn[1]), Number(lineColumn[2]) - 1);

  const snippet = message.match(JSON_SNIPPET);
  if (!snippet) return 0;
  const [, token, window] = snippet;
  const base = code.indexOf(window);
  if (base === -1) return 0;
  const middle = window.length / 2;
  let best = -1;
  for (let i = window.indexOf(token); i !== -1; i = window.indexOf(token, i + 1)) {
    if (best === -1 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
  }
  return best === -1 ? base : base + best;
}

export function lintJson(code) {
  if (!code.trim()) return [];
  try {
    JSON.parse(code);
    return [];
  } catch (err) {
    const message = String(err.message);
    const from = jsonErrorOffset(code, message);
    // Trim the engine's position noise and context window back off: the
    // squiggle already says where, so repeating it in the tooltip is clutter.
    const text = message
      .replace(/\s*(in JSON )?at (position \d+|line \d+ column \d+).*$/i, '')
      .replace(/,\s*(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)?\s*is not valid JSON\s*$/, '')
      .trim();
    return [at(from, from + 1, text || 'Invalid JSON', { source: 'json' })];
  }
}

// ---------------------------------------------------------------- YAML

export async function lintYaml(code) {
  if (!code.trim()) return [];
  const { parseDocument } = await import('yaml');
  const doc = parseDocument(code, { prettyErrors: false, uniqueKeys: true });
  const problems = [
    ...doc.errors.map((e) => ({ e, severity: 'error' })),
    ...doc.warnings.map((e) => ({ e, severity: 'warning' })),
  ];
  return problems.map(({ e, severity }) => {
    // `yaml` gives ranges as [start, value-end, node-end] offsets already, so
    // no line/column arithmetic is needed.
    const [from = 0, to = from + 1] = e.pos || [];
    return at(from, to, e.message, { severity, source: 'yaml' });
  });
}

// ------------------------------------------------------- shared scanner

// Bracket, quote and comment scanning shared by SQL, Python and the JSX guard.
// Written once because the three languages differ only in which delimiters
// they recognise, and a per-language reimplementation is exactly where an
// off-by-one that mis-places every squiggle would hide.
const PAIRS = { ')': '(', ']': '[', '}': '{' };

/**
 * Walk `code`, skipping strings and comments, and report unbalanced brackets
 * and unterminated string literals.
 *
 * `strings` is a list of [open, close, escapes] triples; `lineComments` and
 * `blockComments` are literal delimiters.
 */
function scanDelimiters(code, { strings, lineComments = [], blockComments = [], source }) {
  const out = [];
  const stack = [];
  let i = 0;

  const startsWith = (list) => list.find((d) => code.startsWith(d, i));

  while (i < code.length) {
    const line = startsWith(lineComments);
    if (line) {
      i = endOfLine(code, i);
      continue;
    }
    const block = blockComments.find(([open]) => code.startsWith(open, i));
    if (block) {
      const close = code.indexOf(block[1], i + block[0].length);
      if (close === -1) {
        out.push(at(i, endOfLine(code, i), 'Unterminated block comment', { source }));
        return out;
      }
      i = close + block[1].length;
      continue;
    }
    const quote = strings.find(([open]) => code.startsWith(open, i));
    if (quote) {
      const [open, close, escape] = quote;
      let j = i + open.length;
      let closed = false;
      while (j < code.length) {
        if (escape && code[j] === '\\') { j += 2; continue; }
        // SQL and friends escape a quote by doubling it: 'it''s'.
        if (code.startsWith(close + close, j) && open === close) { j += close.length * 2; continue; }
        if (code.startsWith(close, j)) { j += close.length; closed = true; break; }
        j += 1;
      }
      if (!closed) {
        out.push(at(i, endOfLine(code, i), `Unterminated ${open === '"' ? 'string' : 'literal'}`, { source }));
        return out;
      }
      i = j;
      continue;
    }

    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, pos: i });
    else if (PAIRS[ch]) {
      const top = stack.pop();
      if (!top) out.push(at(i, i + 1, `Unmatched closing '${ch}'`, { source }));
      else if (top.ch !== PAIRS[ch]) {
        out.push(at(i, i + 1, `Closing '${ch}' does not match '${top.ch}'`, { source }));
      }
    }
    i += 1;
  }

  for (const open of stack) {
    out.push(at(open.pos, open.pos + 1, `Unclosed '${open.ch}'`, { source }));
  }
  return out;
}

// ---------------------------------------------------------------- SQL

// Dialect comes off the fence info string — ```sql:mysql — and only changes
// which quoting styles count as legal, which is the part that actually differs
// between the three in a way a reader would notice.
const SQL_DIALECTS = {
  postgres: { identifier: ['"', '"'], dollarQuoted: true },
  mysql: { identifier: ['`', '`'], dollarQuoted: false },
  sqlite: { identifier: ['"', '"'], dollarQuoted: false },
};

const SQL_ALIASES = { postgresql: 'postgres', psql: 'postgres', pg: 'postgres' };

/** Postgres default, per the issue: a bare ```sql fence names no dialect. */
export const sqlDialect = (qualifier) => {
  const key = SQL_ALIASES[qualifier] || qualifier;
  return SQL_DIALECTS[key] ? key : 'postgres';
};

// Statements have to start with something. Anything else is a paste that lost
// its first line, or prose that landed in a SQL fence by mistake.
const SQL_STARTERS = /^(with|select|insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|begin|commit|rollback|explain|analyze|analyse|vacuum|set|show|use|call|do|copy|comment|refresh|reindex|declare|prepare|execute|values|table|pragma|attach|detach|savepoint|release|lock|start|end|if|with)\b/i;

export function lintSql(code, qualifier = '') {
  if (!code.trim()) return [];
  const dialect = SQL_DIALECTS[sqlDialect(qualifier)];
  const strings = [["'", "'", false], dialect.identifier];
  const problems = scanDelimiters(code, {
    strings,
    lineComments: ['--', '#'].slice(0, sqlDialect(qualifier) === 'mysql' ? 2 : 1),
    blockComments: [['/*', '*/']],
    source: 'sql',
  });
  // A delimiter problem makes everything after it meaningless, so the keyword
  // check is only worth running on code that at least scans.
  if (problems.length) return problems;

  // Dollar-quoted bodies ($$ … $$) are a Postgres function body, which is a
  // whole second language; checking the keyword of what is inside would be
  // wrong, so those blocks are left alone entirely.
  if (dialect.dollarQuoted && /\$[A-Za-z_]*\$/.test(code)) return [];

  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  const first = stripped.search(/\S/);
  if (first === -1) return [];
  if (!SQL_STARTERS.test(stripped.slice(first))) {
    const word = stripped.slice(first).split(/\s/)[0];
    return [
      at(first, first + word.length, `'${word}' is not a statement keyword`, {
        severity: 'warning',
        source: 'sql',
      }),
    ];
  }
  return [];
}

// -------------------------------------------------------------- Python

// Lines that open a block and therefore have to end in a colon.
const PY_BLOCK = /^(if|elif|else|for|while|try|except|finally|with|def|class|async\s+def|async\s+with|async\s+for|match|case)\b/;

export function lintPython(code) {
  if (!code.trim()) return [];
  const problems = scanDelimiters(code, {
    // Triple quotes first: '"' would otherwise match the first character of
    // '"""' and close on the second, splitting one docstring into three.
    strings: [
      ['"""', '"""', true],
      ["'''", "'''", true],
      ['"', '"', true],
      ["'", "'", true],
    ],
    lineComments: ['#'],
    source: 'python',
  });
  if (problems.length) return problems;

  // Structural checks run per logical line, and only on lines that are not
  // inside a bracket continuation or a triple-quoted string — `scanDelimiters`
  // has already proved those are balanced, so a cheap re-walk is enough to know
  // which lines are top-of-statement.
  const out = [];
  const lines = code.split('\n');
  let offset = 0;
  let depth = 0;
  let inTriple = null;
  let tabs = false;
  let spaces = false;

  for (const line of lines) {
    const openedAt = offset;
    offset += line.length + 1;
    if (inTriple) {
      if (line.includes(inTriple)) inTriple = null;
      continue;
    }
    const code0 = depth === 0 ? line : '';
    const triple = line.match(/("""|''')/);
    // A line whose triple quote is not closed on the same line opens a block.
    if (triple && (line.split(triple[1]).length - 1) % 2 === 1) inTriple = triple[1];

    const bare = line.replace(/#.*$/, '');
    depth += (bare.match(/[([{]/g) || []).length - (bare.match(/[)\]}]/g) || []).length;
    if (depth < 0) depth = 0;

    if (!code0.trim()) continue;

    const indent = code0.match(/^[ \t]*/)[0];
    if (indent.includes('\t')) tabs = true;
    if (indent.includes(' ')) spaces = true;
    if (indent.includes('\t') && indent.includes(' ')) {
      out.push(
        at(openedAt, openedAt + indent.length, 'Indentation mixes tabs and spaces', {
          source: 'python',
        })
      );
    }

    const body = code0.trim();
    if (PY_BLOCK.test(body) && !bare.trimEnd().endsWith(':') && !bare.includes(';')) {
      // `else` in a conditional expression (`a if b else c`) is not a block
      // header, and neither is a `with`/`for` inside a comprehension.
      if (!/\b(if|for)\b.*\b(else|in)\b/.test(body) || /^(def|class)\b/.test(body)) {
        const end = openedAt + code0.trimEnd().length;
        out.push(at(openedAt + indent.length, end, "Expected ':' at the end of this block header", { source: 'python' }));
      }
    }
  }

  if (tabs && spaces) {
    out.push(at(0, 1, 'File mixes tab-indented and space-indented lines', {
      severity: 'warning',
      source: 'python',
    }));
  }
  return out;
}

// ---------------------------------------------------------- JavaScript

// Acorn has no idea what JSX is, so a React component in a ```js fence would
// light up with "Unexpected token" on its first tag. Rather than pull in
// acorn-jsx to be wrong about a different set of things, a block that looks
// like it contains JSX is left unchecked and says so.
const LOOKS_LIKE_JSX = /(?:^|[=(,>]|=>|return)\s*<[A-Za-z][\w.]*(?:\s|\/?>)/m;

export async function lintJavascript(code) {
  if (!code.trim()) return [];
  if (LOOKS_LIKE_JSX.test(code)) return [];
  const { parse } = await import('acorn');
  const options = { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true };
  try {
    parse(code, { ...options, sourceType: 'module' });
    return [];
  } catch (moduleError) {
    // A fence is often a snippet, not a module. `import`/`export` need module
    // mode, but `with` statements and a bare `arguments` need script mode, so
    // both are tried and only a failure in both is a real error.
    try {
      parse(code, { ...options, sourceType: 'script' });
      return [];
    } catch {
      const from = typeof moduleError.pos === 'number' ? moduleError.pos : 0;
      const message = String(moduleError.message).replace(/\s*\(\d+:\d+\)\s*$/, '');
      return [at(from, from + 1, message, { source: 'acorn' })];
    }
  }
}

// ------------------------------------------------------------- registry

// The languages a diagnostic can come from. A language absent from this table
// is highlighted and never parsed — that is the normal case, not a gap.
export const ADAPTERS = {
  json: { label: 'JSON', run: (code) => lintJson(code) },
  yaml: { label: 'YAML', run: (code) => lintYaml(code) },
  sql: { label: 'SQL', run: (code, qualifier) => lintSql(code, qualifier) },
  python: { label: 'Python', run: (code) => lintPython(code) },
  javascript: { label: 'JavaScript', run: (code) => lintJavascript(code) },
};

export const canLint = (language) => Boolean(ADAPTERS[language]);

/**
 * Run the adapter for `language` over `code`.
 *
 * Always resolves — a parser that throws on input it did not expect must not
 * take the worker down with it, and "no diagnostics" is the right answer for a
 * checker that cannot make sense of the block.
 */
export async function diagnose(language, code, qualifier = '') {
  const adapter = ADAPTERS[language];
  if (!adapter) return [];
  try {
    const results = await adapter.run(code, qualifier);
    // Clamp here rather than in five adapters: whatever a parser claims, a
    // range outside the text would map to a position outside the node.
    return (results || [])
      .filter((d) => d && typeof d.from === 'number')
      .map((d) => ({
        ...d,
        from: Math.max(0, Math.min(code.length, d.from)),
        to: Math.max(0, Math.min(code.length, Math.max(d.to, d.from + 1))),
      }));
  } catch {
    return [];
  }
}
