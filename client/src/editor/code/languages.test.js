import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES, ensureLanguage, languageLabel, languageOptions, loadedLanguages, lowlight,
  parseInfoString, resetLanguages, resolveDiagramLanguage, resolveLanguage,
} from './languages.js';

test('the registry starts empty — no grammar is in the main bundle', () => {
  // The whole point of replacing createLowlight(common): a page with no code on
  // it must download no grammars at all.
  assert.deepEqual(lowlight.listLanguages(), []);
});

test('an info string yields a language and a qualifier', () => {
  assert.deepEqual(parseInfoString('python'), { name: 'python', qualifier: '' });
  assert.deepEqual(parseInfoString('SQL:MySQL'), { name: 'sql', qualifier: 'mysql' });
  // Markdown allows more than a language in a fence info string.
  assert.deepEqual(parseInfoString('js title="app.js"'), { name: 'js', qualifier: '' });
  assert.deepEqual(parseInfoString('  yaml  '), { name: 'yaml', qualifier: '' });
  assert.deepEqual(parseInfoString(null), { name: '', qualifier: '' });
});

test('aliases collapse onto one canonical grammar', () => {
  for (const alias of ['py', 'python3', 'Python', 'python']) {
    assert.equal(resolveLanguage(alias), 'python', alias);
  }
  assert.equal(resolveLanguage('js'), 'javascript');
  assert.equal(resolveLanguage('yml'), 'yaml');
  assert.equal(resolveLanguage('html'), 'xml');
  // A dialect qualifier picks the grammar off the first token only.
  assert.equal(resolveLanguage('sql:mysql'), 'sql');
  assert.equal(resolveLanguage('brainfuck'), null);
  assert.equal(resolveLanguage(''), null);
});

test('every alias is unique across the table', () => {
  // Two languages claiming `ts` would make resolveLanguage depend on object key
  // order, which is exactly the kind of bug that shows up as "sometimes the
  // wrong colours".
  const seen = new Map();
  for (const [id, spec] of Object.entries(LANGUAGES)) {
    for (const name of [id, ...spec.aliases]) {
      assert.equal(seen.has(name), false, `${name} is claimed by both ${seen.get(name)} and ${id}`);
      seen.set(name, id);
    }
  }
});

test('diagram fences are recognised but are not highlight targets', () => {
  // ```mermaid becomes a mermaidDiagram node, so offering it as an ordinary
  // grammar would create a second, half-working way to hold a diagram.
  assert.equal(resolveLanguage('mermaid'), null);
  assert.equal(resolveDiagramLanguage('mermaid'), 'mermaid');
  assert.equal(resolveDiagramLanguage('mmd'), 'mermaid');
  assert.equal(resolveDiagramLanguage('draw.io'), 'drawio');
  assert.equal(resolveDiagramLanguage('mxgraph'), 'drawio');
  assert.equal(resolveDiagramLanguage('python'), null);
});

test('labels are human, and an unknown language shows its own name', () => {
  assert.equal(languageLabel('py'), 'Python');
  assert.equal(languageLabel('sql:mysql'), 'SQL');
  assert.equal(languageLabel('mermaid'), 'Mermaid diagram');
  assert.equal(languageLabel('cobol'), 'cobol');
  assert.equal(languageLabel(null), 'Plain text');
});

test('a grammar registers exactly once however many blocks ask for it', async () => {
  resetLanguages();
  const before = lowlight.listLanguages().length;
  // Five blocks of Python on one page, plus the same language under two
  // aliases — one import, one registration.
  const ids = await Promise.all(['python', 'py', 'python3', 'python', 'py'].map(ensureLanguage));
  assert.deepEqual(ids, ['python', 'python', 'python', 'python', 'python']);
  assert.deepEqual(loadedLanguages(), ['python']);
  assert.equal(lowlight.listLanguages().length, before + 1);
  assert.ok(lowlight.registered('python'));

  // And asking again after it is registered is still a no-op.
  assert.equal(await ensureLanguage('python'), 'python');
  assert.deepEqual(loadedLanguages(), ['python']);
});

test('a language we do not carry resolves to null rather than throwing', async () => {
  assert.equal(await ensureLanguage('cobol'), null);
  assert.equal(await ensureLanguage(''), null);
  assert.equal(await ensureLanguage(undefined), null);
});

test('a registered grammar actually colours tokens', async () => {
  await ensureLanguage('python');
  const tree = lowlight.highlight('python', 'def f():\n    return "hi"\n');
  const classes = [];
  const walk = (node) => {
    if (node.properties?.className) classes.push(...node.properties.className);
    (node.children || []).forEach(walk);
  };
  walk(tree);
  // This is the bug the issue opened on: the tokens were always emitted, and
  // the stylesheet had no rule for a single one of them.
  assert.ok(classes.includes('hljs-keyword'), `expected hljs-keyword in ${classes.join(', ')}`);
  assert.ok(classes.includes('hljs-string'));
});

test('picker options are grouped and cover every language exactly once', () => {
  const groups = languageOptions();
  assert.deepEqual(groups.map((g) => g.group), ['Popular', 'All languages', 'Diagrams']);
  const codeValues = [...groups[0].items, ...groups[1].items].map((i) => i.value);
  assert.deepEqual([...codeValues].sort(), Object.keys(LANGUAGES).sort());
  assert.equal(new Set(codeValues).size, codeValues.length);
  assert.ok(groups[0].items.length > 0, 'the Popular group must not be empty');
  assert.deepEqual(groups[2].items.map((i) => i.value), ['mermaid', 'drawio']);
});
