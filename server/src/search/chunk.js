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
export function docBlocks(doc) {
  const blocks = [];
  for (const node of Array.isArray(doc?.content) ? doc.content : []) {
    const text = extractText(node).trim();
    if (!text) continue;
    blocks.push({ text, level: node.type === 'heading' ? node.attrs?.level || 1 : 0 });
  }
  return blocks;
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

  const flush = ({ overlap }) => {
    if (!body.length) return;
    const text = body.join('\n\n');
    const prefix = header();
    const full = prefix ? `${prefix}\n\n${text}` : text;
    chunks.push({ index: chunks.length, content: full, tokenCount: estimateTokens(full) });
    const carry = overlap ? tailTokens(text, OVERLAP_TOKENS) : '';
    body = carry ? [carry] : [];
    bodyTokens = carry ? estimateTokens(carry) : 0;
  };

  for (const block of blocks) {
    if (block.level) {
      // A heading starts a new section; it lives in the trail, not the body.
      flush({ overlap: false });
      trail = trail.slice(0, block.level - 1);
      trail[block.level - 1] = block.text;
      continue;
    }
    for (const piece of splitOversized(block.text)) {
      const tokens = estimateTokens(piece);
      if (bodyTokens && bodyTokens + tokens > MAX_CHUNK_TOKENS) flush({ overlap: true });
      body.push(piece);
      bodyTokens += tokens;
    }
  }
  flush({ overlap: false });

  // Heading-only or empty pages still deserve one chunk so the title is findable.
  if (!chunks.length) {
    const text = [title.trim(), ...blocks.map((b) => b.text)].filter(Boolean).join('\n\n');
    if (text) chunks.push({ index: 0, content: text, tokenCount: estimateTokens(text) });
  }
  return chunks;
}
