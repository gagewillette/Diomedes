// Footnotes: the bookkeeping, with no DOM in it.
//
// A footnote is two things that must never disagree — a `footnoteRef` sitting
// in the prose and a `footnote` entry in the single `footnotes` container at
// the end of the document — plus a number that belongs to neither of them.
//
// The number is the reason this file exists. It is *not* stored. Storing it
// would mean every insert, delete or reorder rewrites the number on every
// footnote after the one that moved: a one-character edit would touch half the
// document, every one of those writes would land in the CRDT, and two people
// renumbering at once would produce a document where the numbers are whatever
// the last write happened to say. So the number is derived, here, from the
// order the refs appear in — the one thing both collaborators already agree on.
//
// The other half is the reconciler. Refs and entries can be separated by any
// edit that touches only one of them (delete the sentence, delete the note,
// paste half of either), and a footnote apparatus that has drifted is worse
// than none: it renders numbers that lead nowhere. `syncFootnotes` runs after
// every local change and puts the two sides back in agreement.

// Crockford base-32, matching blockId.js — an id read out of a log or a JSON
// blob is unambiguous, and ids sort by creation time.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const FOOTNOTE_REF = 'footnoteRef';
export const FOOTNOTE = 'footnote';
export const FOOTNOTES = 'footnotes';

export const FOOTNOTE_ID_ATTR = 'footnoteId';
export const FOOTNOTE_ID_DATA_ATTR = 'data-footnote-id';

const randomChars = (n) => {
  const bytes = new Uint8Array(n);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
};

/** A fresh footnote id: `fn_` + 10 chars of timestamp + 12 of randomness. */
export function newFootnoteId(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `fn_${time}${randomChars(12)}`;
}

export const isFootnoteId = (value) =>
  typeof value === 'string' && /^fn_[0-9A-HJKMNP-TV-Z]{22}$/.test(value);

/** The `footnotes` container, or null when the page has no footnotes. */
export function findContainer(doc) {
  let found = null;
  doc.forEach((node, offset, index) => {
    if (node.type.name === FOOTNOTES) found = { node, pos: offset, index };
  });
  return found;
}

/**
 * Every ref in the prose, in document order.
 *
 * Refs inside the container are reported separately: a footnote citing a
 * footnote is not supported, and the reconciler removes them rather than
 * letting them number themselves into a cycle.
 */
export function findRefs(doc) {
  const container = findContainer(doc);
  const start = container ? container.pos : Infinity;
  const end = container ? container.pos + container.node.nodeSize : Infinity;
  const refs = [];
  const nested = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE_REF) return true;
    const id = node.attrs?.[FOOTNOTE_ID_ATTR];
    (pos >= start && pos < end ? nested : refs).push({ id, pos, node });
    return false;
  });
  return { refs, nested };
}

/** The entries inside the container, in stored order. Duplicate ids are dropped. */
export function findEntries(doc) {
  const container = findContainer(doc);
  if (!container) return [];
  const entries = [];
  const seen = new Set();
  container.node.forEach((node, offset, index) => {
    const id = node.attrs?.[FOOTNOTE_ID_ATTR];
    if (!id || seen.has(id)) return;
    seen.add(id);
    entries.push({ id, node, index, pos: container.pos + 1 + offset });
  });
  return entries;
}

/**
 * id → display number, assigned by first appearance in the prose.
 *
 * Citing one footnote twice gives both refs the same number, which is what
 * every other footnote implementation does and what a reader expects: the
 * number names the note, not the citation.
 */
export function numberFootnotes(doc) {
  const { refs } = findRefs(doc);
  const numbers = new Map();
  for (const ref of refs) {
    if (!ref.id || numbers.has(ref.id)) continue;
    numbers.set(ref.id, numbers.size + 1);
  }
  return numbers;
}

/** How many times each footnote is cited — one back-link per citation. */
export function citationCounts(doc) {
  const { refs } = findRefs(doc);
  const counts = new Map();
  for (const ref of refs) {
    if (!ref.id) continue;
    counts.set(ref.id, (counts.get(ref.id) || 0) + 1);
  }
  return counts;
}

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Put refs and entries back in agreement, returning a transaction or null when
 * there is nothing to do.
 *
 * Returning null on a no-op is not an optimisation — this runs from
 * `appendTransaction`, and a transaction that always has something to say would
 * loop forever.
 *
 * Four things get fixed, in an order chosen so earlier steps do not invalidate
 * the positions later ones use:
 *
 *   1. refs nested inside a footnote — unsupported, removed,
 *   2. refs whose entry is gone — the citation has nothing to cite, so deleting
 *      the note takes its markers with it,
 *   3. entries no longer cited — deleting the sentence deletes its note,
 *   4. entry order — always the order the refs appear in, so the numbers down
 *      the page read 1, 2, 3 without the reader having to trust us.
 */
export function syncFootnotes(state) {
  const { doc } = state;
  const container = findContainer(doc);
  const { refs, nested } = findRefs(doc);
  const entries = findEntries(doc);
  const entryById = new Map(entries.map((e) => [e.id, e.node]));

  const cited = [];
  const citedSet = new Set();
  for (const ref of refs) {
    if (!ref.id || citedSet.has(ref.id)) continue;
    citedSet.add(ref.id);
    cited.push(ref.id);
  }

  // Refs pointing at a note that no longer exists, plus every nested ref.
  const doomed = [...nested, ...refs.filter((r) => !r.id || !entryById.has(r.id))];
  const keptIds = cited.filter((id) => entryById.has(id));
  const currentIds = entries.map((e) => e.id);
  const orderWrong = !sameOrder(currentIds, keptIds);
  // A container holding entries nobody dropped, in the right order, with no
  // stray refs, is already correct.
  if (!doomed.length && !orderWrong && Boolean(container) === keptIds.length > 0) return null;

  const tr = state.tr;

  // Back to front: an earlier deletion would shift every position after it.
  for (const ref of [...doomed].sort((a, b) => b.pos - a.pos)) {
    tr.delete(ref.pos, ref.pos + ref.node.nodeSize);
  }

  const containerPos = container ? tr.mapping.map(container.pos) : null;
  const containerEnd = container ? tr.mapping.map(container.pos + container.node.nodeSize) : null;

  if (!keptIds.length) {
    // The last footnote is gone, and so are the rule and the heading: an empty
    // apparatus is visual noise announcing nothing.
    if (container) tr.delete(containerPos, containerEnd);
  } else if (container && orderWrong) {
    const type = doc.type.schema.nodes[FOOTNOTES];
    tr.replaceWith(containerPos, containerEnd, type.create(container.node.attrs, keptIds.map((id) => entryById.get(id))));
  }

  if (!tr.docChanged) return null;
  // Deleting a note is the user's edit and belongs in their undo stack; the
  // tidying that follows is ours, and pressing undo should not have to step
  // through it.
  tr.setMeta('addToHistory', false);
  return tr;
}

/**
 * The document with a new, empty footnote appended and a ref for it at `pos`.
 *
 * Both halves go in one transaction on purpose: a ref that exists for even one
 * transaction without its entry is an orphan, and the reconciler would delete
 * it before the user had typed a word.
 */
export function insertFootnote(tr, schema, pos, id = newFootnoteId()) {
  const refType = schema.nodes[FOOTNOTE_REF];
  const noteType = schema.nodes[FOOTNOTE];
  const containerType = schema.nodes[FOOTNOTES];
  const attrs = { [FOOTNOTE_ID_ATTR]: id };

  tr.insert(pos, refType.create(attrs));

  const container = findContainer(tr.doc);
  const entry = noteType.create(attrs, schema.nodes.paragraph.create());
  if (container) {
    // Straight to the end; syncFootnotes moves it into reference order.
    tr.insert(container.pos + container.node.nodeSize - 1, entry);
  } else {
    tr.insert(tr.doc.content.size, containerType.create(null, entry));
  }
  return { tr, id };
}

/** Where the caret goes after `insertFootnote` — inside the new note's paragraph. */
export function entryTextPos(doc, id) {
  const entry = findEntries(doc).find((e) => e.id === id);
  return entry ? entry.pos + 2 : null;
}
