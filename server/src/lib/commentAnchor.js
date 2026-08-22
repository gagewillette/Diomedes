// What the server will accept as a comment's text anchor.
//
// The anchor is built in the browser, where the document actually is — see
// client/src/lib/commentAnchor.js for the shape and the reasoning. The server
// cannot rebuild it (it has no ProseMirror document to hand) and does not need
// to: an anchor is a *hint* for finding text again, and a wrong one costs a
// comment its highlight, not the page its integrity.
//
// What the server does owe is a bound on what gets stored. Without one, a
// jsonb column reachable by anyone with reader access is a place to park
// arbitrary documents, and `quote` is echoed back to every other reader of the
// page. So the anchor is rebuilt here field by field: anything not named below
// is dropped rather than stored, which also means a future client field cannot
// silently ride along unvalidated.
//
// Deliberately not shared with the client module. The two files agree on a wire
// shape, not on code — the client's half needs ProseMirror and TipTap, neither
// of which belongs in the API process.

/** Must match CONTEXT_CHARS in the client module. */
const CONTEXT_CHARS = 32;

/** Must match MAX_QUOTE_CHARS in the client module. */
const MAX_QUOTE_CHARS = 300;

/**
 * The anchor to store for a comment, or null for a page-level one.
 *
 * Throws nothing: a malformed anchor degrades to a page-level comment rather
 * than losing the comment altogether. Someone who has just typed a paragraph of
 * feedback should not have it rejected because the phrase they highlighted came
 * through oddly — they would lose the paragraph, which is the part that matters.
 */
export function normalizeAnchor(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const quote = typeof value.quote === 'string' ? value.quote.slice(0, MAX_QUOTE_CHARS) : '';
  // An anchor with no words in it cannot be resolved against any document, so
  // it is not an anchor — it is a page-level comment that thinks otherwise.
  if (!quote.trim()) return null;

  const offset = Number(value.offset);

  return {
    blockId: typeof value.blockId === 'string' ? value.blockId.slice(0, 64) : null,
    quote,
    offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
    prefix: typeof value.prefix === 'string' ? value.prefix.slice(-CONTEXT_CHARS) : '',
    suffix: typeof value.suffix === 'string' ? value.suffix.slice(0, CONTEXT_CHARS) : '',
  };
}
