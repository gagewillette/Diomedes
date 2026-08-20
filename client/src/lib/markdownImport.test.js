// Importing several markdown files in one go.
//
// The bug this exists for was silent: a batch import produced one page that
// read correctly and a run of pages that were blank, with nothing logged and
// nothing to see in the API. Two separate things had to be true for that, and
// both are pinned here — the parse must not carry anything over from the file
// before it, and the blocks it mints must be its own.
//
// Needs a DOM, because markdown-it, an HTML string and ProseMirror's DOM parser
// are what the importer runs on. See ../editor/domForTests.js.
import '../editor/domForTests.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockId } from '../editor/blockId.js';
import { markdownToJSON } from './markdown.js';

/** The kind of file people actually import: prose, a list, a fence, a note. */
const file = (n) => `# Page ${n}

Body of page ${n}, which cites a source.[^${n}]

- item ${n}a
- item ${n}b

\`\`\`mermaid
graph TD
  A${n} --> B${n}
\`\`\`

[^${n}]: The note belonging to page ${n}.
`;

/** Every block id in a document, at any depth. */
function idsIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.attrs?.blockId) out.push(node.attrs.blockId);
  for (const child of node.content || []) idsIn(child, out);
  return out;
}

const textIn = (node) =>
  [node.text || '', ...(node.content || []).map(textIn)].join(' ');

test('a batch of markdown files all parse, not just the first', () => {
  const docs = [1, 2, 3, 4].map((n) => markdownToJSON(file(n)));

  docs.forEach((doc, i) => {
    const n = i + 1;
    assert.equal(doc.type, 'doc');
    assert.ok(doc.content?.length > 1, `page ${n} came out with no body: ${JSON.stringify(doc)}`);
    const text = textIn(doc);
    assert.match(text, new RegExp(`Page ${n}\\b`), `page ${n} lost its heading`);
    assert.match(text, new RegExp(`Body of page ${n}\\b`), `page ${n} lost its prose`);
    assert.match(text, new RegExp(`item ${n}a`), `page ${n} lost its list`);
    // Nothing from the file before it, which is what a parser holding state
    // between calls would leak.
    for (const other of [1, 2, 3, 4].filter((m) => m !== n)) {
      assert.doesNotMatch(text, new RegExp(`Body of page ${other}\\b`), `page ${n} holds page ${other}`);
    }
  });

  // The diagram fence is promoted the same way on every file, not just the one
  // that happened to be parsed first.
  docs.forEach((doc, i) => {
    const diagram = doc.content.find((node) => node.type === 'mermaidDiagram');
    assert.ok(diagram, `page ${i + 1} kept its diagram as an inert code block`);
    assert.match(diagram.attrs.code, new RegExp(`A${i + 1} --> B${i + 1}`));
  });

  // Footnotes travel with their own page: one note each, none pooled onto the
  // first document and none renumbered across files.
  docs.forEach((doc, i) => {
    const container = doc.content.find((node) => node.type === 'footnotes');
    assert.ok(container, `page ${i + 1} lost its footnote apparatus`);
    assert.equal(container.content.length, 1, `page ${i + 1} holds someone else's notes`);
    assert.match(textIn(container), new RegExp(`note belonging to page ${i + 1}`));
  });
});

test('imported blocks are stamped, and no two pages claim the same block', () => {
  const docs = [1, 2, 3, 4].map((n) => markdownToJSON(file(n)));

  const all = [];
  docs.forEach((doc, i) => {
    const ids = idsIn(doc);
    assert.ok(ids.length >= 4, `page ${i + 1} arrived with unnamed blocks`);
    assert.ok(ids.every(isBlockId), `page ${i + 1} has a malformed id: ${ids.join(',')}`);
    assert.equal(new Set(ids).size, ids.length, `page ${i + 1} repeats an id`);
    all.push(...ids);
  });

  // Ids are minted per document, but a registry shared between imports would
  // hand two pages the same name — and `page_blocks` is keyed on it.
  assert.equal(new Set(all).size, all.length, 'two imported pages share a block id');
});
