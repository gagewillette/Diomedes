import { extractText } from '../lib/util.js';

// Chunks are sized for text-embedding-3-small: small enough that a hit points
// at a specific passage, large enough to keep the surrounding argument intact.
export const MAX_CHUNK_TOKENS = 500;
export const OVERLAP_TOKENS = 50;

// Cheap stand-in for a real tokenizer — within ~10% for English prose, and the
// cap it feeds is a soft target, so the extra dependency is not worth it.
export const estimateTokens = (text) => Math.ceil((text || '').trim().length / 4);

// Flatten a TipTap doc into top-level blocks, tagging headings so chunks can
// break on section boundaries and inherit their heading trail.
//
// Each block carries the stable id the editor stamped on it. That id is what
// makes incremental re-embedding possible: a chunk records which blocks it was
// built from, so a save can re-embed only the chunks that intersect the blocks
// it changed. Blocks with no id (a document written before this migration, or
// one built by a client that does not stamp) simply contribute nothing to that
// set, and the chunk they land in is treated as un-attributable — see
// chunksForBlocks in queue.js.
export function docBlocks(doc) {
  const blocks = [];
  for (const node of Array.isArray(doc?.content) ? doc.content : []) {
    if (node.type === 'footnotes') {
      blocks.push(...footnoteBlocks(node));
      continue;
    }
    const text = extractText(node).trim();
    if (!text) continue;
    blocks.push({
      text,
      level: node.type === 'heading' ? node.attrs?.level || 1 : 0,
      blockId: node.attrs?.blockId || null,
    });
  }
  return blocks;
}

/**
 * The footnote apparatus, flattened to one block per note.
 *
 * Left whole it would be a single block holding every note on the page, so a
 * semantic hit anywhere in it would point at "the footnotes" rather than at the
 * note that actually matched — and on a page with forty citations that block
 * would blow straight past the chunk cap and be split on sentence boundaries
 * that fall in the middle of unrelated notes.
 *
 * The synthetic heading resets the heading trail, so a chunk built from a note
 * is prefixed `Page title > Footnotes` instead of inheriting whichever section
 * happened to be last on the page.
 *
 * Every block here is attributed to the *container's* id, not to the note's.
 * That is deliberate: `splitBlocks` projects top-level nodes, so an edit to any
 * note reports the container as the block that changed, and a chunk claiming a
 * finer id than the writer ever reports would never be re-embedded.
 */
function footnoteBlocks(node) {
  const blockId = node.attrs?.blockId || null;
  const notes = (Array.isArray(node.content) ? node.content : [])
    .map((note) => extractText(note).trim())
    .filter(Boolean);
  if (!notes.length) return [];
  return [
    { text: 'Footnotes', level: 1, blockId },
    ...notes.map((text) => ({ text, level: 0, blockId })),
  ];
}

// Last ~n tokens of text, cut at a word boundary.
function tailTokens(text, n) {
  const chars = n * 4;
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const space = tail.indexOf(' ');
  return space === -1 ? tail : tail.slice(space + 1);
}

// Break a block that alone exceeds the cap: sentences first, words as a last
// resort (long code blocks and tables have no sentence boundaries).
function splitOversized(text) {
  if (estimateTokens(text) <= MAX_CHUNK_TOKENS) return [text];
  const pieces = [];
  let current = '';
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (estimateTokens(sentence) > MAX_CHUNK_TOKENS) {
      push();
      let words = '';
      for (const word of sentence.split(/\s+/)) {
        if (words && estimateTokens(`${words} ${word}`) > MAX_CHUNK_TOKENS) {
          pieces.push(words);
          words = word;
        } else {
          words = words ? `${words} ${word}` : word;
        }
      }
      if (words) pieces.push(words);
      continue;
    }
    if (current && estimateTokens(`${current} ${sentence}`) > MAX_CHUNK_TOKENS) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return pieces;
}

// Split a page into embeddable chunks. Every chunk is prefixed with the page
// title and its heading trail so an isolated passage still carries the context
// the embedding needs to be discriminative.
export function chunkPage({ title = '', content } = {}) {
  const blocks = docBlocks(content);
  const chunks = [];
  let trail = [];
  let body = [];
  let bodyTokens = 0;

  const header = () => [title.trim(), ...trail.filter(Boolean)].filter(Boolean).join(' > ');

  // Which blocks fed the chunk being built, and which fed the heading trail it
  // sits under. A heading contributes its text to every chunk in its section
  // via the prefix, so editing a heading has to re-embed that whole section —
  // recording it as a source is what makes that happen automatically instead
  // of being a special case somebody has to remember.
  let sources = new Set();
  let trailSources = [];
  // The overlap tail carries text from the previous chunk into this one, so the
  // block that text came from is a source of both.
  let carried = [];

  const flush = ({ overlap }) => {
    if (!body.length) return;
    const text = body.join('\n\n');
    const prefix = header();
    const full = prefix ? `${prefix}\n\n${text}` : text;
    const blockIds = [...new Set([...trailSources.filter(Boolean), ...sources])];
    chunks.push({
      index: chunks.length,
      content: full,
      tokenCount: estimateTokens(full),
      blockIds,
    });
    const carry = overlap ? tailTokens(text, OVERLAP_TOKENS) : '';
    body = carry ? [carry] : [];
    bodyTokens = carry ? estimateTokens(carry) : 0;
    // Only the block the carried text came from survives into the next chunk.
    sources = new Set(carry ? carried : []);
    carried = [];
  };

  for (const block of blocks) {
    if (block.level) {
      // A heading starts a new section; it lives in the trail, not the body.
      flush({ overlap: false });
      trail = trail.slice(0, block.level - 1);
      trail[block.level - 1] = block.text;
      trailSources = trailSources.slice(0, block.level - 1);
      trailSources[block.level - 1] = block.blockId;
      continue;
    }
    for (const piece of splitOversized(block.text)) {
      const tokens = estimateTokens(piece);
      if (bodyTokens && bodyTokens + tokens > MAX_CHUNK_TOKENS) {
        carried = block.blockId ? [block.blockId] : [];
        flush({ overlap: true });
      }
      body.push(piece);
      bodyTokens += tokens;
      if (block.blockId) sources.add(block.blockId);
    }
  }
  flush({ overlap: false });

  // Heading-only or empty pages still deserve one chunk so the title is findable.
  if (!chunks.length) {
    const text = [title.trim(), ...blocks.map((b) => b.text)].filter(Boolean).join('\n\n');
    if (text) {
      chunks.push({
        index: 0,
        content: text,
        tokenCount: estimateTokens(text),
        blockIds: [...new Set(blocks.map((b) => b.blockId).filter(Boolean))],
      });
    }
  }
  return chunks;
}
