// The decision-making and bookkeeping behind linting, with no ProseMirror and
// no worker in sight.
//
// Everything that could put a squiggle in the wrong place, run a parser on a
// block that should have been skipped, or paint a stale result over a fresh one
// lives here as a pure function, so it is pinned by tests rather than by
// reading a rendered page and hoping.
//
// The plugin in ./lintPlugin.js is the shell around this: it walks the doc,
// posts to the worker and turns the ranges below into decorations.

import { canLint } from './diagnostics.js';
import { parseInfoString, resolveLanguage } from './languages.js';

// Above this, a block is not even highlighted. `common`-grade tokenisers go
// quadratic on pathological input — a minified bundle pasted into a page — and
// a locked tab is a far worse outcome than uncoloured text. Deliberately not
// admin-settable: it is a safety limit, not a preference.
export const HIGHLIGHT_BYTE_CAP = 250_000;

// How long the document has to sit still before a lint pass. Long enough that
// typing a line never triggers one mid-word, short enough that pausing to look
// at what you wrote gets an answer.
export const LINT_DEBOUNCE_MS = 400;

/** Byte length of a string as the caps mean it — UTF-8, not UTF-16 units. */
export const byteLength = (text) =>
  typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : Buffer.byteLength(text, 'utf8');

/**
 * Cheap content hash, used only to answer "is this the same text as last time".
 *
 * FNV-1a over the UTF-16 units. Not a security primitive and never used as one:
 * a collision costs one skipped re-lint of a block that changed, which the next
 * edit fixes.
 */
export function hashCode(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Why this block is not being linted, or null when it should be.
 *
 * Returning a reason rather than a boolean is what lets the block header say
 * "too large to check" instead of silently showing nothing, which reads as
 * "your code is fine".
 */
export function lintSkipReason({ enabled, language, bytes, maxBytes, visible = true }) {
  if (!enabled) return 'off';
  const id = resolveLanguage(language);
  if (!id) return 'no-language';
  if (!canLint(id)) return 'no-checker';
  if (bytes > HIGHLIGHT_BYTE_CAP) return 'huge';
  if (bytes > maxBytes) return 'too-large';
  if (!visible) return 'offscreen';
  return null;
}

/** The sentence the block header shows for a skip reason. null means say nothing. */
export const SKIP_MESSAGES = {
  off: null,
  'no-language': null,
  'no-checker': null,
  huge: 'Too large to colour or check',
  'too-large': 'Too large to check',
  offscreen: null,
};

/** Is this block small enough to bother tokenising at all? */
export const canHighlight = ({ enabled, language, bytes }) =>
  Boolean(enabled) && Boolean(resolveLanguage(language)) && bytes <= HIGHLIGHT_BYTE_CAP;

/**
 * What to send the worker for one block, or null when there is nothing to do.
 *
 * `qualifier` is the part of the fence info string after the colon — ```sql:mysql
 * — which is how a SQL block names its dialect. It rides along because the
 * worker's adapters take it and the plugin should not have to know that only
 * SQL cares.
 */
export function lintRequest({ blockId, language, code, version }) {
  const id = resolveLanguage(language);
  if (!id) return null;
  const { qualifier } = parseInfoString(language);
  return { id: blockId, lang: id, qualifier, code, version };
}

/**
 * Diagnostics offsets → ProseMirror document positions.
 *
 * A codeBlock's text starts one position inside the node, so an offset `n` into
 * the code is at `nodePos + 1 + n`. Both ends are clamped to the node's own text
 * so a parser that over-reports a range — or a result that lands after the block
 * has been shortened — can never produce a decoration that spans out of the
 * block and onto the paragraph below it.
 *
 * A range that clamps to zero width is dropped rather than widened: a
 * zero-width inline decoration renders as nothing, and widening it would put a
 * squiggle under a character the parser never complained about.
 */
export function decorationRanges({ nodePos, textLength, diagnostics }) {
  const start = nodePos + 1;
  const end = start + textLength;
  const out = [];
  for (const d of diagnostics || []) {
    const from = Math.max(start, Math.min(end, start + d.from));
    const to = Math.max(start, Math.min(end, start + d.to));
    if (to <= from) continue;
    out.push({ from, to, severity: d.severity === 'warning' ? 'warning' : 'error', message: d.message, source: d.source });
  }
  return out;
}

/** Errors first, then by position — the order the "N problems" badge walks. */
export const orderDiagnostics = (ranges) =>
  [...ranges].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return a.from - b.from;
  });

/**
 * Per-block request bookkeeping: one call in flight at a time, latest wins.
 *
 * The version counter is the whole story. A block is edited while its parser is
 * still running; the result that arrives describes text that no longer exists,
 * and painting it would put a squiggle under an unrelated character. So every
 * request carries the version it was made for, and a reply whose version is not
 * the current one is dropped on the floor.
 */
export class LintTracker {
  constructor() {
    this.blocks = new Map(); // blockId -> { version, hash, inFlight, results }
  }

  /**
   * Record that `code` is the text of `blockId` now.
   *
   * Returns the request to send, or null when the text is unchanged since the
   * last pass (so a cursor move or an edit elsewhere in the document costs
   * nothing) or when a request for this exact text is already running.
   */
  request({ blockId, language, code }) {
    const hash = hashCode(code);
    const lang = resolveLanguage(language);
    const prev = this.blocks.get(blockId);
    // The language is part of the identity, not just the text. Switching a
    // block from JSON to Python without touching a character changes every
    // answer, and comparing on the text alone would leave the old language's
    // complaints on screen forever.
    if (prev && prev.hash === hash && prev.lang === lang) return null;
    const version = (prev?.version ?? 0) + 1;
    const entry = { version, lang, hash, inFlight: true, results: prev?.results ?? [] };
    this.blocks.set(blockId, entry);
    const request = lintRequest({ blockId, language, code, version });
    if (!request) {
      // No grammar means no adapter: clear whatever the block used to show
      // rather than leaving diagnostics from its previous language behind.
      entry.inFlight = false;
      entry.results = [];
      return null;
    }
    return request;
  }

  /**
   * Accept a worker reply. Returns true when it was current and stored, false
   * when it described a version of the block that has since been edited.
   */
  accept({ id, version, diagnostics }) {
    const entry = this.blocks.get(id);
    if (!entry || entry.version !== version) return false;
    entry.inFlight = false;
    entry.results = diagnostics || [];
    return true;
  }

  /** The diagnostics currently believed to describe `blockId`. */
  results(blockId) {
    return this.blocks.get(blockId)?.results ?? [];
  }

  /** Forget one block — it was deleted, or its language changed to an unchecked one. */
  forget(blockId) {
    this.blocks.delete(blockId);
  }

  /** Drop everything: linting was turned off, or the editor is going away. */
  clear() {
    this.blocks.clear();
  }

  /**
   * Forget every block not in `keep`. Called after a doc walk so a block that
   * was deleted — or dragged to another page — does not hold its entry (and its
   * diagnostics) forever.
   */
  retain(keep) {
    const wanted = keep instanceof Set ? keep : new Set(keep);
    for (const id of [...this.blocks.keys()]) {
      if (!wanted.has(id)) this.blocks.delete(id);
    }
  }
}
