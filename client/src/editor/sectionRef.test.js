import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { buildDecorations, headingForHash, SECTION_REF_ATTR } from './SectionRef.js';

// A minimal doc/heading/paragraph/code schema. Building it here rather than
// booting a TipTap editor keeps the test free of a DOM while still running the
// real ProseMirror walk.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    codeBlock: { group: 'block', content: 'text*', code: true, marks: '' },
    text: { group: 'inline' },
  },
  marks: {
    code: {},
    link: { attrs: { href: { default: null } } },
  },
});

const p = (text, mark) =>
  schema.nodes.paragraph.create(
    null,
    text ? schema.text(text, mark ? [schema.marks[mark].create({})] : null) : null,
  );
const h = (level, text) => schema.nodes.heading.create({ level }, schema.text(text));
const code = (text) => schema.nodes.codeBlock.create(null, schema.text(text));
const doc = (...nodes) => schema.nodes.doc.create(null, nodes);

/** Every §-reference decoration in a document, as `{ text, class, title }`. */
function refs(document, opts) {
  const { decorations } = buildDecorations(document, opts);
  return decorations
    .find()
    .filter((d) => d.type.attrs?.[SECTION_REF_ATTR])
    .map((d) => ({
      text: document.textBetween(d.from, d.to),
      key: d.type.attrs[SECTION_REF_ATTR],
      class: d.type.attrs.class,
      title: d.type.attrs.title,
      tabindex: d.type.attrs.tabindex,
    }));
}

const SAMPLE = () =>
  doc(
    h(2, '3. Foundations — make it feel like Linear'),
    p('Local-first work is described in §3.2 and reviewed per §6.4.'),
    h(3, '3.2 Local-first read cache'),
    h(3, '6.4 Suggested-edit / doc review workflow'),
  );

test('a reference is decorated over exactly its own text', () => {
  const found = refs(SAMPLE());
  assert.deepEqual(found.map((r) => r.text), ['§3.2', '§6.4']);
  assert.deepEqual(found.map((r) => r.key), ['3.2', '6.4']);
});

test('the tooltip names the heading the reference resolves to', () => {
  const [first, second] = refs(SAMPLE());
  assert.equal(first.title, '§3.2 → Local-first read cache');
  assert.equal(second.title, '§6.4 → Suggested-edit / doc review workflow');
});

test('a reference with no matching section is marked unresolved, not broken', () => {
  const [ref] = refs(doc(h(2, '1. Only section'), p('but see §9 for more')));
  assert.match(ref.class, /gd-section-ref--unresolved/);
  assert.equal(ref.title, 'No section 9 in this page');
});

test('code blocks and inline code are never linked', () => {
  assert.deepEqual(refs(doc(h(2, '3.2 Cache'), code('lookup("§3.2")'))), []);
  assert.deepEqual(refs(doc(h(2, '3.2 Cache'), p('see §3.2', 'code'))), []);
});

test('an existing link is left alone — no double decoration', () => {
  assert.deepEqual(refs(doc(h(2, '2. Why'), p('See §2', 'link'))), []);
});

test('a reader gets a tab stop; an author writing the sentence does not', () => {
  assert.equal(refs(SAMPLE())[0].tabindex, '0');
  assert.equal(refs(SAMPLE(), { editable: true })[0].tabindex, undefined);
});

test('references are found wherever text lives, headings included', () => {
  const found = refs(doc(h(2, '1. Intro, see §2'), h(2, '2. Detail')));
  assert.deepEqual(found.map((r) => r.text), ['§2']);
  assert.match(found[0].class, /^gd-section-ref$/);
});

test('every heading gets a slug id decoration', () => {
  const { decorations } = buildDecorations(SAMPLE());
  const ids = decorations.find().map((d) => d.type.attrs?.id).filter(Boolean);
  assert.deepEqual(ids, [
    '3-foundations-make-it-feel-like-linear',
    '32-local-first-read-cache',
    '64-suggested-edit-doc-review-workflow',
  ]);
});

test('building decorations never touches the document', () => {
  const document = SAMPLE();
  const before = JSON.stringify(document.toJSON());
  buildDecorations(document);
  assert.equal(JSON.stringify(document.toJSON()), before);
});

test('a hash resolves by slug, by number, and by the §-prefixed form', () => {
  const { index } = buildDecorations(SAMPLE());
  assert.equal(headingForHash(index, '#32-local-first-read-cache').title, 'Local-first read cache');
  assert.equal(headingForHash(index, '#3.2').title, 'Local-first read cache');
  assert.equal(headingForHash(index, '#%C2%A73.2').title, 'Local-first read cache');
  assert.equal(headingForHash(index, '#nothing-here'), null);
  assert.equal(headingForHash(index, ''), null);
});

test('renumbering a heading re-resolves the references pointing at it', () => {
  const stale = doc(h(2, '3.3 Renamed cache'), p('see §3.2'));
  assert.match(refs(stale)[0].class, /unresolved/);
  const fixed = doc(h(2, '3.2 Renamed cache'), p('see §3.2'));
  assert.equal(refs(fixed)[0].title, '§3.2 → Renamed cache');
});
