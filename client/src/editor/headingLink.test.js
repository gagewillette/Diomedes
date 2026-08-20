import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { buildSectionIndex } from '../lib/sectionRefs.js';
import { collectHeadings } from './SectionRef.js';
import { allowsHeadingLink, headingItems, linkSourceSpans, scoreHeading } from './headingLink.js';

// The same bare schema sectionRef.test.js uses: enough ProseMirror to hold a
// heading, a link mark and a code block, and no DOM anywhere.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    codeBlock: { group: 'block', content: 'text*', code: true, marks: '' },
    text: { group: 'inline' },
  },
  marks: {
    link: { attrs: { href: { default: null } }, inclusive: true },
  },
});

const h = (level, text) => schema.nodes.heading.create({ level }, schema.text(text));
const doc = (...nodes) => schema.nodes.doc.create(null, nodes);
const code = (text) => schema.nodes.codeBlock.create(null, schema.text(text));

/** A paragraph of `['plain', ['linked', href], …]` runs. */
const p = (...runs) =>
  schema.nodes.paragraph.create(
    null,
    runs.map((run) =>
      Array.isArray(run)
        ? schema.text(run[0], [schema.marks.link.create({ href: run[1] })])
        : schema.text(run),
    ),
  );

const indexOf = (document) => buildSectionIndex(collectHeadings(document));

const SAMPLE = () =>
  doc(
    h(2, 'Option A — local embeddings'),
    h(2, 'Option B — OpenAI'),
    h(2, 'Changing models or dimensions'),
    h(3, '3.2 Local-first read cache'),
  );

const titles = (items) => items.map((i) => i.title);

// ---- the picker ----

test('an empty query lists the page in document order', () => {
  const items = headingItems(indexOf(SAMPLE()), '');
  assert.deepEqual(titles(items), [
    'Option A — local embeddings',
    'Option B — OpenAI',
    'Changing models or dimensions',
    'Local-first read cache',
  ]);
});

test('a picked heading carries the slug href, so nobody types a slug', () => {
  const [item] = headingItems(indexOf(SAMPLE()), 'changing');
  assert.equal(item.title, 'Changing models or dimensions');
  assert.equal(item.href, '#changing-models-or-dimensions');
});

test('matching is case-insensitive and matches mid-title too', () => {
  assert.deepEqual(titles(headingItems(indexOf(SAMPLE()), 'OPENAI')), ['Option B — OpenAI']);
  assert.deepEqual(titles(headingItems(indexOf(SAMPLE()), 'dimensions')), [
    'Changing models or dimensions',
  ]);
});

test('a title prefix outranks a hit in the middle of another title', () => {
  const items = headingItems(indexOf(SAMPLE()), 'option');
  assert.deepEqual(titles(items).slice(0, 2), ['Option A — local embeddings', 'Option B — OpenAI']);
});

test('a numbered section is reachable by its number', () => {
  const [item] = headingItems(indexOf(SAMPLE()), '3.2');
  assert.equal(item.title, 'Local-first read cache');
  assert.equal(item.number, '3.2');
});

test('a slug on the clipboard still finds its heading', () => {
  const [item] = headingItems(indexOf(SAMPLE()), 'local-first-read');
  assert.equal(item.href, '#32-local-first-read-cache');
});

test('a query matching nothing offers nothing, so a stray # shows no menu', () => {
  assert.deepEqual(headingItems(indexOf(SAMPLE()), '42'), []);
  assert.equal(scoreHeading({ title: 'Option A', id: 'option-a' }, 'zzz'), null);
});

test('the list is capped so the popup cannot outgrow the page', () => {
  const many = doc(...Array.from({ length: 30 }, (_, i) => h(2, `Section ${i}`)));
  assert.equal(headingItems(indexOf(many), '').length, 12);
});

// ---- where the picker is allowed to open ----

const stateOf = (document, pos) => {
  const state = EditorState.create({ schema, doc: document });
  return pos == null
    ? state
    : state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
};

test('a # at the very start of a block is left to the heading input rule', () => {
  const document = doc(p('#'));
  assert.equal(allowsHeadingLink(stateOf(document), 1), false);
});

test('a # after any text opens the picker', () => {
  const document = doc(p('see #'));
  assert.equal(allowsHeadingLink(stateOf(document), 5), true);
});

test('a # inside a code block is code', () => {
  const document = doc(code('# not a heading link'));
  assert.equal(allowsHeadingLink(stateOf(document), 3), false);
});

// ---- the live-preview source view ----

const LINKED = () => doc(p('see ', ['Changing models', '#changing-models-or-dimensions'], ' below'));

/** Where the link sits in `LINKED()`: text starts at 1, so the mark is 5..21. */
const LINK_FROM = 5;
const LINK_TO = 5 + 'Changing models'.length;

test('the caret inside a heading link unfolds it into markdown', () => {
  const spans = linkSourceSpans(stateOf(LINKED(), LINK_FROM + 3));
  assert.deepEqual(spans, [
    { pos: LINK_FROM, side: -1, text: '[' },
    { pos: LINK_TO, side: 1, text: '](#changing-models-or-dimensions)' },
  ]);
});

test('the caret parked just after the link still shows its source', () => {
  // This is where the picker leaves the caret, and seeing what it just wrote is
  // the point of the feature.
  assert.equal(linkSourceSpans(stateOf(LINKED(), LINK_TO)).length, 2);
});

test('a caret elsewhere in the paragraph renders the link normally', () => {
  assert.deepEqual(linkSourceSpans(stateOf(LINKED(), 2)), []);
  assert.deepEqual(linkSourceSpans(stateOf(LINKED(), LINK_TO + 4)), []);
});

test('a selection dragged out of the link does not unfold it', () => {
  const state = EditorState.create({ schema, doc: LINKED() });
  const dragged = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, LINK_FROM + 2, LINK_TO + 4)),
  );
  assert.deepEqual(linkSourceSpans(dragged), []);
});

test('an external link keeps its URL folded away', () => {
  const document = doc(p('see ', ['the docs', 'https://example.com/a/very/long/path'], ' below'));
  assert.deepEqual(linkSourceSpans(stateOf(document, 7)), []);
});

test('the revealed source is the markdown the document exports', () => {
  const [open, close] = linkSourceSpans(stateOf(LINKED(), LINK_FROM + 3));
  const label = LINKED().textBetween(LINK_FROM, LINK_TO);
  assert.equal(`${open.text}${label}${close.text}`, '[Changing models](#changing-models-or-dimensions)');
});
