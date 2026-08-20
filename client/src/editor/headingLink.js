// Linking to a section by its name instead of by its slug.
//
// A heading anchor is `[Changing models](#changing-models-or-dimensions)`, and
// the slug is derived from the heading text by rules nobody should have to hold
// in their head — lowercase, punctuation dropped, spaces hyphenated, duplicates
// suffixed. Asking an author to reproduce that by hand is asking them to be a
// slugifier. Typing `#` and picking the heading off a list is the same gesture
// the `/` menu already trained them in.
//
// Two halves live here, both free of editor and DOM imports so they can be
// tested on a bare ProseMirror state: which headings a `#`-query offers, and
// what markdown to reveal around the link the caret is sitting in. The view
// layer — the popup and the decorations — is in editor/HeadingLink.jsx.
//
// Nothing here invents a new node or mark. A picked heading becomes an ordinary
// link mark with a `#href`, which is what tiptap-markdown already serialises as
// `[label](#slug)`, what MCP's read_page already returns, and what SectionRef's
// click handler already jumps on. The feature is a way of *writing* something
// the document could always hold.
import { getMarkRange } from '@tiptap/core';

/** The character that opens the heading picker. */
export const HEADING_LINK_CHAR = '#';

/** The href a picked heading becomes. */
export const hrefForHeading = (entry) => `#${entry.id}`;

/**
 * Rank one heading against a `#`-query. Lower is better; `null` means no match.
 *
 * A prefix of the title is what someone typing a heading's name means, so it
 * sorts above a hit in the middle of one. The section number ranks alongside
 * the title because `#3.2` is how our numbered docs are cross-referenced, and
 * the slug ranks last — it is the thing this feature exists to avoid typing,
 * but someone who has one on the clipboard should still find its heading.
 */
export function scoreHeading(entry, query) {
  if (!query) return 0;
  const title = (entry.title || '').toLowerCase();
  const number = (entry.number || '').toLowerCase();
  const id = (entry.id || '').toLowerCase();

  if (title.startsWith(query)) return 0;
  if (number && number.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  if (id.includes(query)) return 3;
  return null;
}

/**
 * The headings a `#`-query offers, best first.
 *
 * An empty query lists the page in document order: opening the menu should show
 * you the shape of the page, not an alphabetised index of it.
 */
export function headingItems(index, rawQuery = '', limit = 12) {
  const query = rawQuery.trim().toLowerCase();
  const scored = [];

  (index?.headings ?? []).forEach((entry, ordinal) => {
    if (!entry.id) return;
    const score = scoreHeading(entry, query);
    if (score === null) return;
    scored.push({ score, ordinal, entry });
  });

  // Document order breaks every tie, so the list never reshuffles under a
  // keystroke that did not change which headings matched.
  scored.sort((a, b) => a.score - b.score || a.ordinal - b.ordinal);

  return scored.slice(0, limit).map(({ entry }) => ({
    id: entry.id,
    title: entry.title,
    number: entry.number,
    level: entry.level,
    href: hrefForHeading(entry),
  }));
}

/** The `href` of the link mark covering `pos`, or null if there is none. */
function hrefAt(doc, pos, linkType) {
  const node = doc.nodeAt(pos);
  return node?.marks.find((mark) => mark.type === linkType)?.attrs.href ?? null;
}

/**
 * The literal markdown to reveal around the in-page link the caret is in, as
 * `{ pos, side, text }` spans — or `[]` when the caret is somewhere else.
 *
 * This is the Obsidian move: a link is a link until you put the cursor in it,
 * at which point it is the source you wrote. Revealing it as *decorations*
 * rather than by rewriting the document is what makes it safe here — the
 * brackets are painted on one screen, so a collaborator does not watch the
 * markdown appear around a link they are reading, undo does not step through a
 * cursor move, and what MCP reads back is unchanged either way.
 *
 * `getMarkRange` looks backwards from a position at the end of a marked run, so
 * the caret parked immediately after a link counts as inside it. That is
 * deliberate: it is where the caret lands the moment the picker inserts one,
 * and seeing the source you just created is the whole point.
 */
export function linkSourceSpans(state) {
  const linkType = state.schema.marks.link;
  if (!linkType) return [];

  const { selection } = state;
  const range = getMarkRange(selection.$from, linkType);
  if (!range) return [];

  // A selection reaching out of the link is a drag across the page, not an edit
  // of this link's own words; revealing syntax mid-drag would move the text
  // under the pointer.
  if (selection.from < range.from || selection.to > range.to) return [];

  const href = hrefAt(state.doc, range.from, linkType);
  // Only in-page anchors. An external link's source is a URL the author cannot
  // usefully edit inline, and unfolding it would shove the paragraph sideways.
  if (!href || !href.startsWith('#')) return [];

  return [
    { pos: range.from, side: -1, text: '[' },
    { pos: range.to, side: 1, text: `](${href})` },
  ];
}

/**
 * Whether a `#` typed at `pos` opens the picker.
 *
 * A `#` at the very start of a text block belongs to the heading input rule —
 * `# ` is how you make an H1, and stealing that keystroke would trade a
 * feature people use constantly for one they use occasionally.
 */
export function allowsHeadingLink(state, pos) {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.spec.code) return false;
  return $pos.parentOffset > 0;
}
