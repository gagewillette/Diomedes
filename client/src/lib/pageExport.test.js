import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimFilename,
  flattenSubtree,
  frontmatter,
  sanitizeFilename,
  subtreeFiles,
} from './pageExport.js';

// Rows shaped like the ones /api/pages/:id/subtree returns. order_key is a
// plain string there too, so "a" sorts before "b" here for the same reason.
let seq = 0;
const page = (id, parentId, title, orderKey = 'a') => ({
  id,
  parent_id: parentId,
  title,
  order_key: orderKey,
  created_at: `2026-01-01T00:00:${String(seq++).padStart(2, '0')}Z`,
  updated_at: '2026-02-02T00:00:00Z',
  content: { type: 'doc', content: [] },
});

const names = (pages, rootId) => subtreeFiles(pages, rootId, () => 'body').map((f) => f.name);

// ---- the walk ----

test('a page with no children exports as one file', () => {
  assert.deepEqual(names([page('p1', null, 'Handbook')], 'p1'), ['Handbook.md']);
});

test('children land beside their parent, in sibling order', () => {
  const pages = [
    page('p1', null, 'Handbook'),
    page('p3', 'p1', 'Security', 'b'),
    page('p2', 'p1', 'Onboarding', 'a'),
  ];
  assert.deepEqual(names(pages, 'p1'), ['Handbook.md', 'Onboarding.md', 'Security.md']);
});

test('a grandchild is exported, and still at the top level', () => {
  const pages = [
    page('p1', null, 'Handbook'),
    page('p2', 'p1', 'Onboarding'),
    page('p3', 'p2', 'Day One'),
  ];
  assert.deepEqual(names(pages, 'p1'), ['Handbook.md', 'Onboarding.md', 'Day One.md']);
});

test('the walk is genuinely recursive: four levels deep still comes out whole', () => {
  const pages = [
    page('p1', null, 'One'),
    page('p2', 'p1', 'Two'),
    page('p3', 'p2', 'Three'),
    page('p4', 'p3', 'Four'),
    page('p5', 'p4', 'Five'),
  ];
  assert.deepEqual(names(pages, 'p1'), ['One.md', 'Two.md', 'Three.md', 'Four.md', 'Five.md']);
});

test('the order is pre-order: a branch is finished before the next sibling starts', () => {
  const pages = [
    page('p1', null, 'Root'),
    page('a', 'p1', 'A', 'a'),
    page('a1', 'a', 'A1'),
    page('b', 'p1', 'B', 'b'),
    page('b1', 'b', 'B1'),
  ];
  assert.deepEqual(names(pages, 'p1'), ['Root.md', 'A.md', 'A1.md', 'B.md', 'B1.md']);
});

test('pages outside the subtree are not exported', () => {
  const pages = [
    page('p1', null, 'Handbook'),
    page('p2', 'p1', 'Onboarding'),
    page('other', null, 'Unrelated'),
    page('otherKid', 'other', 'Also unrelated'),
  ];
  assert.deepEqual(names(pages, 'p1'), ['Handbook.md', 'Onboarding.md']);
});

test('exporting a child exports only that child and what is under it', () => {
  const pages = [
    page('p1', null, 'Handbook'),
    page('p2', 'p1', 'Onboarding'),
    page('p3', 'p2', 'Day One'),
    page('p4', 'p1', 'Security'),
  ];
  assert.deepEqual(names(pages, 'p2'), ['Onboarding.md', 'Day One.md']);
});

test('a parent cycle cannot make the walk loop', () => {
  const pages = [
    { ...page('p1', 'p2', 'One'), order_key: 'a' },
    { ...page('p2', 'p1', 'Two'), order_key: 'a' },
  ];
  assert.deepEqual(names(pages, 'p1'), ['One.md', 'Two.md']);
});

test('an unknown root exports nothing rather than guessing', () => {
  assert.deepEqual(flattenSubtree([page('p1', null, 'Handbook')], 'nope'), []);
});

// ---- names ----

test('path separators and the other forbidden characters do not survive', () => {
  assert.equal(sanitizeFilename('Q1/Q2'), 'Q1-Q2');
  assert.equal(sanitizeFilename('a\\b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
});

test('emoji and accents are left alone — they are legal filenames', () => {
  assert.equal(sanitizeFilename('🚀 Läunch Plan'), '🚀 Läunch Plan');
});

test('control characters are stripped and whitespace is collapsed', () => {
  assert.equal(sanitizeFilename('Re\u0000lease\tNotes  v2\n'), 'Release Notes v2');
});

test('leading and trailing dots and spaces go, so no hidden or truncated files', () => {
  assert.equal(sanitizeFilename('  ..Draft..  '), 'Draft');
});

test('a 300-character title is cut to something a filesystem will take', () => {
  const name = sanitizeFilename('x'.repeat(300));
  assert.equal(name.length, 120);
  assert.ok(new TextEncoder().encode(`${name} (10).md`).length < 255);
});

test('truncation never splits a character in half', () => {
  // Four bytes each, so the 120-byte budget lands exactly on 30 of them.
  const name = sanitizeFilename('🚀'.repeat(60));
  assert.equal(name, '\u{1F680}'.repeat(30));
  assert.equal(new TextEncoder().encode(name).length, 120);
});

test('an untitled page exports as Untitled.md', () => {
  assert.equal(sanitizeFilename(''), 'Untitled');
  assert.equal(sanitizeFilename(null), 'Untitled');
  assert.equal(sanitizeFilename('   '), 'Untitled');
  assert.equal(sanitizeFilename('///'), 'Untitled');
});

test('names Windows reserves are pushed out of the way', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('com1'), '_com1');
  assert.equal(sanitizeFilename('LPT9'), '_LPT9');
  // Only the exact names are reserved.
  assert.equal(sanitizeFilename('Console'), 'Console');
  assert.equal(sanitizeFilename('COM10'), 'COM10');
});

// ---- collisions ----

test('a repeated name gets a numbered suffix, in walk order', () => {
  const claimed = new Set();
  assert.equal(claimFilename('Notes', claimed), 'Notes.md');
  assert.equal(claimFilename('Notes', claimed), 'Notes (2).md');
  assert.equal(claimFilename('Notes', claimed), 'Notes (3).md');
});

test('collisions are case-insensitive, because macOS and Windows are', () => {
  const claimed = new Set();
  claimFilename('Notes', claimed);
  assert.equal(claimFilename('notes', claimed), 'notes (2).md');
});

test('the parent keeps the unsuffixed name; the duplicate below it is the one renamed', () => {
  const pages = [
    page('p1', null, 'Handbook'),
    page('p2', 'p1', 'Handbook'),
    page('p3', 'p2', 'Handbook'),
  ];
  assert.deepEqual(names(pages, 'p1'), ['Handbook.md', 'Handbook (2).md', 'Handbook (3).md']);
});

test('two untitled pages do not overwrite each other', () => {
  const pages = [page('p1', null, 'Root'), page('p2', 'p1', ''), page('p3', 'p1', '   ')];
  assert.deepEqual(names(pages, 'p1'), ['Root.md', 'Untitled.md', 'Untitled (2).md']);
});

test('titles that differ only in a forbidden character still get separate files', () => {
  const pages = [page('p1', null, 'Root'), page('p2', 'p1', 'A/B'), page('p3', 'p1', 'A:B')];
  assert.deepEqual(names(pages, 'p1'), ['Root.md', 'A-B.md', 'A-B (2).md']);
});

// ---- file contents ----

test('each file carries frontmatter, then the title as an H1, then the body', () => {
  const [file] = subtreeFiles([page('p1', null, 'Handbook')], 'p1', () => 'Hello **world**');
  assert.equal(
    file.text,
    [
      '---',
      'title: "Handbook"',
      'id: "p1"',
      'parent: null',
      'updated_at: "2026-02-02T00:00:00Z"',
      '---',
      '',
      '# Handbook',
      '',
      'Hello **world**',
      '',
    ].join('\n')
  );
});

test('frontmatter records the parent, so the flat archive still knows the shape of the tree', () => {
  const child = page('p2', 'p1', 'Onboarding');
  assert.match(frontmatter(child), /^parent: "p1"$/m);
});

test('a quote in a title cannot break out of the frontmatter', () => {
  assert.match(frontmatter(page('p1', null, 'The "Big" Plan')), /^title: "The \\"Big\\" Plan"$/m);
});

test('an untitled page still gets a heading', () => {
  const [file] = subtreeFiles([page('p1', null, '')], 'p1', () => '');
  assert.match(file.text, /^# Untitled$/m);
});

test('the page each file came from is handed back, so a caller can report on it', () => {
  const files = subtreeFiles([page('p1', null, 'Handbook')], 'p1', () => '');
  assert.equal(files[0].page.id, 'p1');
});
