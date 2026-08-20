// The language a person picks has to survive leaving Diomedes and coming back.
//
// `attrs.language` is not decoration: it is what tiptap-markdown writes into a
// fence info string on export, and what the importer reads back off it. A
// picker that set a value the round trip could not carry would look like it
// worked and quietly lose the choice on the next export — the kind of bug that
// only shows up in someone's downloaded archive.
//
// Needs a DOM, because the importer runs markdown-it and ProseMirror's DOM
// parser. See ../domForTests.js.
import '../domForTests.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonToMarkdown, markdownToJSON } from '../../lib/markdown.js';
import { LANGUAGES, resolveLanguage } from './languages.js';

const codeDoc = (language, text) => ({
  type: 'doc',
  content: [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] }],
});

/** The first code block in an imported document. */
const firstCodeBlock = (doc) => doc.content.find((n) => n.type === 'codeBlock');

test('every language the picker offers round-trips through markdown unchanged', () => {
  // Exhaustive on purpose: the picker's job is to write one of these values,
  // and one that the serialiser mangles would be a silent data loss for every
  // block that used it.
  for (const id of Object.keys(LANGUAGES)) {
    const markdown = jsonToMarkdown(codeDoc(id, 'x = 1\n'));
    assert.match(markdown, new RegExp('^```' + id, 'm'), `${id} lost its fence info string`);

    const block = firstCodeBlock(markdownToJSON(markdown));
    assert.ok(block, `${id} did not import back as a code block`);
    assert.equal(block.attrs.language, id, `${id} came back as ${block.attrs.language}`);
  }
});

test('an alias imported from someone else\'s markdown still resolves to one grammar', () => {
  // We never *write* an alias, but a file written elsewhere will: ```py and
  // ```js are what most of the world types.
  const block = firstCodeBlock(markdownToJSON('```py\nprint(1)\n```\n'));
  assert.equal(block.attrs.language, 'py');
  // The attribute is kept verbatim — rewriting someone's fence on import would
  // be an edit they did not ask for — and resolved at render time instead.
  assert.equal(resolveLanguage(block.attrs.language), 'python');
});

test('a SQL dialect qualifier survives the round trip', () => {
  // ```sql:mysql is how a block names its dialect, and the info string is the
  // only place that can live.
  const markdown = jsonToMarkdown(codeDoc('sql:mysql', 'SELECT 1;\n'));
  assert.match(markdown, /^```sql:mysql/m);
  assert.equal(firstCodeBlock(markdownToJSON(markdown)).attrs.language, 'sql:mysql');
  assert.equal(resolveLanguage('sql:mysql'), 'sql');
});

test('a block with no language exports as a bare fence and comes back with none', () => {
  const markdown = jsonToMarkdown(codeDoc(null, 'plain\n'));
  assert.match(markdown, /^```\s*$/m);
  const block = firstCodeBlock(markdownToJSON(markdown));
  assert.ok(!block.attrs.language, `expected no language, got ${block.attrs.language}`);
});

test('the code text itself is unchanged by the round trip', () => {
  const text = 'def f(x):\n    return "a\\tb"  # note\n';
  const block = firstCodeBlock(markdownToJSON(jsonToMarkdown(codeDoc('python', text))));
  assert.equal(block.content[0].text.trimEnd(), text.trimEnd());
});
