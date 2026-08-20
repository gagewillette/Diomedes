// `[[` is not a single character, so the stock matcher (which builds a
// character class from the trigger) can't express it. This walks back through
// the current text block to the last unclosed `[[`, and — when the cursor sits
// inside a `[[Title]]` that is still plain text — forward through the closing
// `]]` as well, so accepting a suggestion replaces the whole written link
// instead of only the half in front of the cursor.
export function findWikiLinkMatch({ $position }) {
  if (!$position.depth || !$position.parent.isTextblock) return null;

  // The placeholder keeps inline atoms one character wide, so offsets into these
  // strings still line up with document positions.
  const parent = $position.parent;
  const offset = $position.parentOffset;
  const textBefore = parent.textBetween(0, offset, undefined, '￼');
  const start = textBefore.lastIndexOf('[[');
  if (start === -1) return null;

  const head = textBefore.slice(start + 2);
  // Bail out once the link is closed, another bracket opens, or the "title"
  // has grown long enough that this was clearly never a link.
  if (/[[\]\n￼]/.test(head)) return null;

  // Everything from the cursor to the end of the block, up to the first `]]`.
  // Anything else in the way (a bracket, an atom) means the cursor is not
  // sitting inside a written-out link, so only the text before it is the query.
  const textAfter = parent.textBetween(offset, parent.content.size, undefined, '￼');
  const closing = /^([^[\]\n￼]*)\]\]/.exec(textAfter);
  const tail = closing ? closing[1] : '';

  const query = head + tail;
  if (query.length > 120) return null;

  const contentStart = $position.start();
  const to = contentStart + offset + (closing ? closing[0].length : 0);
  return {
    range: { from: contentStart + start, to },
    query,
    text: `[[${query}${closing ? ']]' : ''}`,
  };
}

export default findWikiLinkMatch;
