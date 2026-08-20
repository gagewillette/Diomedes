import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnose, canLint, offsetAt, sqlDialect, lintJson, lintPython, lintSql,
} from './diagnostics.js';

// The whole contract with the plugin is "offsets into the code text", so every
// assertion here is about a number that indexes back into the same string.
const slice = (code, d) => code.slice(d.from, d.to);

test('offsetAt walks lines the same way a parser counts them', () => {
  const code = 'a\nbb\nccc';
  assert.equal(offsetAt(code, 1, 0), 0);
  assert.equal(offsetAt(code, 2, 0), 2);
  assert.equal(offsetAt(code, 3, 2), 7);
  // Past the end clamps rather than returning something that would map outside
  // the node.
  assert.equal(offsetAt(code, 99, 0), code.length);
});

test('valid JSON produces nothing', () => {
  assert.deepEqual(lintJson('{"a": [1, 2, {"b": null}]}'), []);
  assert.deepEqual(lintJson('   '), []);
});

test('invalid JSON points at the offending character', () => {
  const code = '{\n  "a": 1,\n  "b": ,\n}';
  const [d] = lintJson(code);
  assert.ok(d, 'expected a diagnostic');
  assert.equal(d.severity, 'error');
  // The comma after "b": is what breaks it; whichever engine phrasing we get,
  // the offset must land on that line.
  assert.ok(d.from >= code.indexOf('"b"'), `offset ${d.from} landed before the bad line`);
  assert.ok(d.from <= code.length);
  // The position noise is stripped back out of the message.
  assert.doesNotMatch(d.message, /at (position|line) \d+/i);
});

test('YAML syntax errors carry the range the parser gave', async () => {
  const code = 'a: 1\n b: 2\n';
  const found = await diagnose('yaml', code);
  assert.ok(found.length >= 1);
  assert.ok(found.every((d) => d.to > d.from && d.to <= code.length));
});

test('YAML duplicate keys are reported, valid YAML is not', async () => {
  assert.deepEqual(await diagnose('yaml', 'a: 1\nb: 2\nlist:\n  - x\n  - y\n'), []);
  const dupes = await diagnose('yaml', 'a: 1\na: 2\n');
  assert.equal(dupes.length, 1);
  assert.match(dupes[0].message, /unique/i);
});

test('SQL dialect comes off the fence qualifier and defaults to postgres', () => {
  assert.equal(sqlDialect(''), 'postgres');
  assert.equal(sqlDialect('mysql'), 'mysql');
  assert.equal(sqlDialect('psql'), 'postgres');
  assert.equal(sqlDialect('oracle'), 'postgres');
});

test('SQL: balanced statements pass, unbalanced parens are located', () => {
  assert.deepEqual(lintSql('SELECT a, b FROM t WHERE x IN (1, 2);'), []);
  // A quote inside a comment must not open a string.
  assert.deepEqual(lintSql("-- don't worry\nSELECT 1;"), []);
  // Doubled quotes are an escaped quote, not a close-then-open.
  assert.deepEqual(lintSql("SELECT 'it''s fine';"), []);

  const code = 'SELECT * FROM t WHERE (a = 1;';
  const [d] = lintSql(code);
  assert.equal(slice(code, d), '(');
  assert.match(d.message, /Unclosed/);
});

test('SQL: an unterminated string is reported once, not cascaded', () => {
  const code = "SELECT 'oops;\nSELECT 1;";
  const found = lintSql(code);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Unterminated/);
});

test('SQL: prose in a sql fence is a warning naming the first word', () => {
  const [d] = lintSql('Hello there, this is not SQL');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /'Hello'/);
});

test('SQL: a postgres function body is left alone', () => {
  // The $$ body is a different language; guessing about its contents would be
  // worse than saying nothing.
  assert.deepEqual(lintSql('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;'), []);
});

test('Python: ordinary code is clean, including docstrings with quotes', () => {
  assert.deepEqual(lintPython('def f(x):\n    """It\'s a docstring."""\n    return x + 1\n'), []);
  assert.deepEqual(lintPython('xs = [1, 2, 3]\nprint(sum(xs))\n'), []);
  // `else` in a conditional expression is not a block header.
  assert.deepEqual(lintPython('y = 1 if x else 2\n'), []);
});

test('Python: a block header without a colon is located on that line', () => {
  const code = 'def f(x)\n    return x\n';
  const [d] = lintPython(code);
  assert.match(d.message, /Expected ':'/);
  assert.equal(slice(code, d), 'def f(x)');
});

test('Python: unbalanced brackets and unterminated strings are found', () => {
  const open = lintPython('print((1, 2)\n');
  assert.equal(open.length, 1);
  assert.match(open[0].message, /Unclosed/);

  const str = lintPython('s = "oops\nprint(s)\n');
  assert.match(str[0].message, /Unterminated/);
});

test('Python: mixing tabs and spaces in one indent is an error', () => {
  const found = lintPython('def f():\n \tpass\n');
  assert.ok(found.some((d) => /tabs and spaces/.test(d.message)));
});

test('JavaScript: modules and scripts both parse; a real syntax error does not', async () => {
  assert.deepEqual(await diagnose('javascript', 'export const a = 1;\n'), []);
  assert.deepEqual(await diagnose('javascript', 'var a = 1; with (a) { }\n'), []);
  assert.deepEqual(await diagnose('javascript', 'await fetch("/x");\n'), []);

  const code = 'function f( {\n';
  const [d] = await diagnose('javascript', code);
  assert.ok(d, 'expected a syntax error');
  assert.ok(d.from >= 0 && d.to <= code.length);
  assert.doesNotMatch(d.message, /\(\d+:\d+\)/, 'line:col noise should be stripped');
});

test('JavaScript: JSX is skipped rather than reported as broken', async () => {
  // acorn cannot parse JSX; claiming a component is a syntax error would be a
  // false positive on every React snippet in the workspace.
  assert.deepEqual(await diagnose('javascript', 'const App = () => <div className="x">hi</div>;\n'), []);
});

test('a language with no adapter yields nothing and says so', async () => {
  assert.equal(canLint('rust'), false);
  assert.equal(canLint('typescript'), false, 'TS is highlight-only — no program, no tsconfig');
  assert.deepEqual(await diagnose('rust', 'fn main() { ('), []);
  assert.deepEqual(await diagnose(null, 'anything'), []);
});

test('every diagnostic range stays inside the code it came from', async () => {
  const samples = [
    ['json', '{"a": }'],
    ['yaml', 'a: 1\n b: 2'],
    ['sql', 'SELECT ((1'],
    ['python', 'def f(\n'],
    ['javascript', 'const = ;'],
  ];
  for (const [lang, code] of samples) {
    for (const d of await diagnose(lang, code)) {
      assert.ok(d.from >= 0 && d.from < d.to && d.to <= code.length,
        `${lang}: [${d.from},${d.to}] outside 0..${code.length}`);
      assert.equal(typeof d.message, 'string');
      assert.ok(['error', 'warning'].includes(d.severity));
    }
  }
});
