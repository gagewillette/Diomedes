// Pure text-matching helpers for in-document find. No editor imports here so the
// logic stays testable on its own (see findText.test.js).

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export const escapeRegExp = (s) => s.replace(REGEX_SPECIALS, '\\$&');

// Runaway patterns on a long document are the one way find can hang the tab.
export const MAX_MATCHES = 2000;

/**
 * Compile a user query into a global RegExp.
 * @returns {{ re: RegExp|null, error: string|null }}
 */
export function compileQuery(query, { regex = false, caseSensitive = false } = {}) {
  if (!query) return { re: null, error: null };
  // 'm' so ^ and $ anchor to each block, matching how the document reads.
  const flags = caseSensitive ? 'gm' : 'gim';
  try {
    return { re: new RegExp(regex ? query : escapeRegExp(query), flags), error: null };
  } catch (err) {
    // Only user-written regex can fail to compile; escaped literals never do.
    return { re: null, error: err.message.replace(/^Invalid regular expression:.*?: /, '') };
  }
}

/**
 * Find every match of `query` in `text`.
 * @returns {{ matches: {start:number,end:number}[], error: string|null, truncated: boolean }}
 */
export function findMatches(text, query, opts = {}) {
  const { re, error } = compileQuery(query, opts);
  if (!re) return { matches: [], error, truncated: false };

  const matches = [];
  let truncated = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Zero-length matches (e.g. `\b`, `a*`) would spin forever without a nudge.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
    if (matches.length >= MAX_MATCHES) { truncated = true; break; }
  }
  return { matches, error: null, truncated };
}

/** Wrap an index into [0, length), so next/prev cycle through the document. */
export function wrapIndex(index, length) {
  if (length <= 0) return -1;
  return ((index % length) + length) % length;
}

/**
 * Flatten a ProseMirror doc into one string plus a segment table mapping string
 * offsets back to document positions. A newline is inserted at every block
 * boundary so a match can never span two paragraphs.
 */
export function buildTextIndex(doc) {
  const segments = [];
  let text = '';
  doc.descendants((node, pos) => {
    if (node.isText) {
      segments.push({ start: text.length, from: pos, length: node.text.length });
      text += node.text;
    } else if (node.isBlock && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
    }
    return true;
  });
  return { text, segments };
}

/** Map a string offset from buildTextIndex back to a document position. */
export function indexToPos(segments, index) {
  for (const seg of segments) {
    if (index >= seg.start && index < seg.start + seg.length) return seg.from + (index - seg.start);
  }
  return null;
}

/** Locate every match in a document as {from,to} position ranges. */
export function findRanges(doc, query, opts = {}) {
  const { text, segments } = buildTextIndex(doc);
  const { matches, error, truncated } = findMatches(text, query, opts);
  const ranges = [];
  for (const m of matches) {
    const from = indexToPos(segments, m.start);
    const to = indexToPos(segments, m.end - 1);
    // Skip anything that landed on a synthetic block separator.
    if (from == null || to == null) continue;
    ranges.push({ from, to: to + 1 });
  }
  return { ranges, error, truncated };
}
