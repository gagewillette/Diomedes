import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSectionIndex,
  findSectionRefs,
  normalizeKey,
  parseHeading,
  resolveRef,
  slugify,
} from './sectionRefs.js';

const keys = (text) => findSectionRefs(text).map((r) => r.key);

test('plain and dotted references are recognised', () => {
  assert.deepEqual(keys('order is in §10.'), ['10']);
  assert.deepEqual(keys('routed through the §6.4 approval queue'), ['6.4']);
  assert.deepEqual(keys('covers §3.2, §3.4, §4.1'), ['3.2', '3.4', '4.1']);
  assert.deepEqual(keys('deeply nested §6.4.2 here'), ['6.4.2']);
});

test('a space after the sign is allowed, as legal writing sets it', () => {
  assert.deepEqual(keys('see § 5 for details'), ['5']);
});

test('the plural sign links its first number and leaves a range alone', () => {
  assert.deepEqual(keys('§§5'), ['5']);
  const [ref] = findSectionRefs('see §§ 5–7 for the rules');
  assert.equal(ref.key, '5');
  assert.equal(ref.raw, '§§ 5');
});

test('a bare sign, or one attached to a word, is not a reference', () => {
  assert.deepEqual(keys('the § character'), []);
  assert.deepEqual(keys('§foo is not numbered'), []);
  assert.deepEqual(keys('x§5 mid-word'), []);
});

test('offsets cover exactly the reference text', () => {
  const text = 'see §3.2 now';
  const [ref] = findSectionRefs(text);
  assert.equal(text.slice(ref.start, ref.end), '§3.2');
});

test('a reference at the very start of a text node counts', () => {
  assert.deepEqual(keys('§5 opens the paragraph'), ['5']);
});

test('a trailing period does not make a different section', () => {
  assert.equal(normalizeKey('3.'), '3');
  assert.deepEqual(keys('as in §3. Later'), ['3']);
});

test('numbered headings register under their number', () => {
  assert.deepEqual(parseHeading('3. Foundations — make it feel like Linear'), {
    number: '3',
    title: 'Foundations — make it feel like Linear',
  });
  assert.deepEqual(parseHeading('3.2 Local-first read cache **[L]**'), {
    number: '3.2',
    title: 'Local-first read cache **[L]**',
  });
});

test('an explicit {#5} marker wins over the heading text', () => {
  const parsed = parseHeading('Why this matters {#5}');
  assert.equal(parsed.number, '5');
  assert.equal(parsed.title, 'Why this matters');
});

test('an unnumbered heading claims no number', () => {
  assert.equal(parseHeading('Foundations').number, null);
});

test('slugs match the hand-written markdown anchors already in our docs', () => {
  assert.equal(
    slugify('2. Why this is actively hurting vectorization today'),
    '2-why-this-is-actively-hurting-vectorization-today',
  );
});

const index = (...headings) =>
  buildSectionIndex(headings.map((h, i) => ({ ...h, pos: i * 10 })));

test('references resolve to the numbered heading that claims them', () => {
  const idx = index(
    { level: 2, text: '3. Foundations' },
    { level: 3, text: '3.2 Local-first read cache' },
    { level: 3, text: '6.4 Suggested-edit / doc review workflow' },
  );
  assert.equal(resolveRef(idx, '3.2').title, 'Local-first read cache');
  assert.equal(resolveRef(idx, '6.4').pos, 20);
  assert.equal(resolveRef(idx, '9'), null);
});

test('an unnumbered document falls back to counting its top-level sections', () => {
  const idx = index(
    { level: 1, text: 'Title' },
    { level: 2, text: 'Background' },
    { level: 3, text: 'A detail' },
    { level: 2, text: 'Proposal' },
  );
  assert.equal(resolveRef(idx, '1').title, 'Background');
  assert.equal(resolveRef(idx, '2').title, 'Proposal');
  assert.equal(resolveRef(idx, '3'), null);
});

test('one numbered heading is enough to switch the ordinal fallback off', () => {
  const idx = index({ level: 2, text: 'Background' }, { level: 2, text: '7. Proposal' });
  assert.equal(resolveRef(idx, '7').title, 'Proposal');
  assert.equal(resolveRef(idx, '1'), null);
});

test('two headings claiming one number: the first in the document wins', () => {
  const idx = index({ level: 2, text: '3.2 First' }, { level: 2, text: '3.2 Second' });
  assert.equal(resolveRef(idx, '3.2').title, 'First');
});

test('repeated heading text still gets distinct anchors', () => {
  const idx = index({ level: 2, text: 'Notes' }, { level: 2, text: 'Notes' });
  assert.deepEqual(idx.headings.map((h) => h.id), ['notes', 'notes-1']);
});
