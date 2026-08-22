// Where a comment is attached, and how to find that place again later.
//
// A page-level comment needs none of this: it is about the page, and the page
// is always there. A comment on a *phrase* has the harder job — the phrase has
// to be findable in a document that other people keep editing, possibly weeks
// later, possibly after the sentence around it has been rewritten twice.
//
// Deliberately NOT a schema mark. A `comment` mark on the text would be the
// obvious implementation, and it is the wrong one here for three reasons:
//
//   * a reader would not be able to comment at all — placing a mark is an edit,
//     and `reader` role has no write access to the document. Commenting is the
//     one thing a reader is explicitly allowed to do (see the `assertSpaceRole`
//     calls on the comment routes), so the anchor cannot live in the document.
//   * every existing page would need a migration, and every anchored comment
//     would leave a mark behind in `getJSON()`, in tiptap-markdown's output and
//     in what MCP's read_page returns — a comment would change the document.
//   * with Collaboration on, writing marks for comments means writing into the
//     CRDT, so opening a page you can only read would still produce Yjs updates.
//
// So the anchor lives on the comment row instead, and is *re-resolved* against
// the current document every time the page is opened. That is the same trade
// the W3C annotation model makes, and it degrades the right way: an anchor that
// can no longer be found does not corrupt anything, it just reports itself as
// orphaned and the comment falls back to being about the page.
//
// The anchor records four things:
//
//   blockId  the id of the block the quote was taken from — the stable name
//            blockId.js stamps on every block. This is the fast path and the
//            precise one: it survives edits anywhere else on the page, and it
//            survives the *same words* appearing elsewhere in the document.
//   quote    the selected text itself, so the anchor still means something if
//            the block is split, merged or deleted.
//   offset   where in the block the quote started, to break ties when a block
//            contains the phrase more than once.
//   prefix/  a few characters either side, which is what tells two identical
//   suffix   quotes apart once the block id is gone.
//
// Nothing in this module touches the DOM or a view — it takes a ProseMirror
// document and returns positions, which is what makes it testable against a
// bare schema.

import { BLOCK_ID_ATTR } from '../editor/blockId.js';

/** How much context to keep either side of the quote. */
export const CONTEXT_CHARS = 32;

/** Longer than this and we are storing the document, not a reference into it. */
export const MAX_QUOTE_CHARS = 300;

/**
 * A document (or a single block) flattened to plain text, with a map back to
 * document positions.
 *
 * `textBetween` would give the text, but not the way back: to turn "character
 * 41 of this block" into a position we need to know which text node character
 * 41 landed in. So both directions are built from one walk, and every search in
 * this module runs over the same flattening — which is what stops an index from
 * meaning one thing when it is written and another when it is read.
 *
 * `basePos` is the document position of `node`'s first child, i.e. `pos + 1`
 * for a node at `pos`, or `0` for the document itself.
 */
export function flatten(node, basePos = 0) {
  let text = '';
  const runs = [];

  node.descendants((child, offset) => {
    if (child.isText) {
      runs.push({ index: text.length, pos: basePos + offset, length: child.text.length });
      text += child.text;
      return false;
    }
    // A block boundary is a gap in the text, not a character in it: without one
    // the last word of a paragraph and the first of the next would concatenate
    // into a word that is in neither. The separator has no position of its own,
    // so no run is recorded for it and it can never be part of a quote's span.
    if (child.isBlock && text.length > 0 && !text.endsWith('\n')) text += '\n';
    return true;
  });

  return { text, runs };
}

/** Document position of flattened-text index `index`, or null. */
export function posAtIndex({ runs }, index) {
  for (const run of runs) {
    // `<=` on the far edge: the index one past the last character of a run is
    // the end of a selection that stops there, and it is a real position.
    if (index >= run.index && index <= run.index + run.length) {
      return run.pos + (index - run.index);
    }
  }
  return null;
}

/** Flattened-text index of document position `pos`, or null. */
export function indexAtPos({ runs }, pos) {
  for (const run of runs) {
    if (pos >= run.pos && pos <= run.pos + run.length) return run.index + (pos - run.pos);
  }
  return null;
}

/** The innermost ancestor of `pos` that carries a block id, as `{ node, pos }`. */
function blockAt(doc, pos) {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.attrs?.[BLOCK_ID_ATTR]) return { node, pos: $pos.before(depth) };
  }
  return null;
}

/** Find a block by the id blockId.js stamped on it, as `{ node, pos }`. */
export function findBlock(doc, blockId) {
  if (!blockId) return null;
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs?.[BLOCK_ID_ATTR] === blockId) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Describe the current selection well enough to find it again.
 *
 * Returns null for anything that is not a run of text — an empty selection, a
 * selected image, whitespace. Those get a page-level comment instead, which is
 * the honest answer: there is no phrase to point at.
 */
export function buildAnchor(doc, from, to) {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(Math.max(from, to), doc.content.size);
  if (end <= start) return null;

  const flat = flatten(doc, 0);
  const iStart = indexAtPos(flat, start);
  const iEnd = indexAtPos(flat, end);
  if (iStart == null || iEnd == null || iEnd <= iStart) return null;

  const quote = flat.text.slice(iStart, iEnd);
  if (!quote.trim()) return null;

  const block = blockAt(doc, start);
  // The offset is measured inside the block, not the document, because that is
  // the only one of the two that survives an edit further up the page.
  let offset = 0;
  if (block) {
    const blockFlat = flatten(block.node, block.pos + 1);
    offset = indexAtPos(blockFlat, start) ?? 0;
  }

  return {
    blockId: block?.node.attrs?.[BLOCK_ID_ATTR] ?? null,
    quote: quote.slice(0, MAX_QUOTE_CHARS),
    offset,
    prefix: flat.text.slice(Math.max(0, iStart - CONTEXT_CHARS), iStart),
    suffix: flat.text.slice(iEnd, iEnd + CONTEXT_CHARS),
  };
}

/** Every index at which `needle` occurs in `haystack`. */
function occurrences(haystack, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * How well the text around `index` matches the context the anchor recorded.
 *
 * Only used to choose between occurrences of the *same* quote, so it does not
 * need to be a similarity metric — the number of matching characters running
 * outward from the quote is enough to separate "the sentence we meant" from
 * "the same three words in an unrelated paragraph".
 */
function contextScore(text, index, quoteLength, anchor) {
  let score = 0;
  const before = text.slice(Math.max(0, index - CONTEXT_CHARS), index);
  const after = text.slice(index + quoteLength, index + quoteLength + CONTEXT_CHARS);
  const prefix = anchor.prefix || '';
  const suffix = anchor.suffix || '';

  for (let i = 1; i <= Math.min(before.length, prefix.length); i++) {
    if (before[before.length - i] !== prefix[prefix.length - i]) break;
    score++;
  }
  for (let i = 0; i < Math.min(after.length, suffix.length); i++) {
    if (after[i] !== suffix[i]) break;
    score++;
  }
  return score;
}

/** Pick the occurrence closest to where the anchor says it should be. */
function bestOccurrence(text, anchor, indices, expected) {
  let best = null;
  let bestKey = null;
  for (const index of indices) {
    const key = [contextScore(text, index, anchor.quote.length, anchor), -Math.abs(index - expected)];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = index;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Find the anchor's text in the document as it stands now.
 *
 * Returns `{ from, to, exact }` or null. `exact` is false when the quote was
 * found somewhere other than the block it was taken from — the comment is
 * almost certainly still about that text, but the block was split, merged or
 * rebuilt, so it is worth saying so rather than claiming certainty.
 *
 * Order matters: the block is tried first even though the whole-document search
 * would usually find the same span, because "the same words, in the block the
 * commenter was looking at" is a stronger claim than "the same words".
 */
export function resolveAnchor(doc, anchor) {
  if (!anchor?.quote) return null;

  const block = findBlock(doc, anchor.blockId);
  if (block) {
    const flat = flatten(block.node, block.pos + 1);
    const index = bestOccurrence(flat.text, anchor, occurrences(flat.text, anchor.quote), anchor.offset ?? 0);
    if (index != null) {
      const from = posAtIndex(flat, index);
      const to = posAtIndex(flat, index + anchor.quote.length);
      if (from != null && to != null) return { from, to, exact: true };
    }
  }

  // The block is gone, or no longer contains the phrase. The words themselves
  // are the fallback, disambiguated by the context either side.
  const flat = flatten(doc, 0);
  const index = bestOccurrence(flat.text, anchor, occurrences(flat.text, anchor.quote), 0);
  if (index == null) return null;
  const from = posAtIndex(flat, index);
  const to = posAtIndex(flat, index + anchor.quote.length);
  return from != null && to != null ? { from, to, exact: false } : null;
}

/**
 * Resolve many anchors in one pass over the comment list.
 *
 * Comments without an anchor are page-level and are simply left out; a comment
 * whose anchor no longer resolves is reported with `range: null`, which is what
 * the panel renders as "original text was removed".
 *
 * `userId` rides along because the highlight is drawn in its author's presence
 * colour — the same colour their caret has — so a page with several people's
 * comments on it reads as several people's comments.
 */
export function resolveAll(doc, comments) {
  const out = [];
  for (const comment of comments || []) {
    if (!comment?.anchor?.quote) continue;
    out.push({
      id: comment.id,
      userId: comment.user_id ?? null,
      // A resolved comment is still *resolvable* — its text is still findable,
      // and the panel needs to know that to tell "settled" apart from "the text
      // this was about is gone". It simply stops being drawn; see decorate().
      resolved: Boolean(comment.resolved),
      anchor: comment.anchor,
      range: resolveAnchor(doc, comment.anchor),
    });
  }
  return out;
}

/**
 * The quote as the comment list should show it — one line, and short enough to
 * sit above the comment rather than bury it.
 */
export function quotePreview(anchor, max = 90) {
  const quote = (anchor?.quote || '').replace(/\s+/g, ' ').trim();
  return quote.length > max ? `${quote.slice(0, max - 1)}…` : quote;
}

/** Reject an anchor that did not come from `buildAnchor` — the server's guard. */
export function isValidAnchor(value) {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const { blockId, quote, offset, prefix, suffix } = value;
  if (typeof quote !== 'string' || !quote.trim() || quote.length > MAX_QUOTE_CHARS) return false;
  if (blockId != null && typeof blockId !== 'string') return false;
  if (offset != null && (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0)) return false;
  for (const context of [prefix, suffix]) {
    if (context != null && (typeof context !== 'string' || context.length > CONTEXT_CHARS * 4)) return false;
  }
  return true;
}
