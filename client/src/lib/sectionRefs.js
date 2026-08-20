// Section-sign cross-references: turning `§3.2` in prose into a jump to the
// heading numbered 3.2.
//
// Our long-form docs are written the way a spec or a statute is written — "see
// §5.1", "routed through the §6.4 approval queue" — and until now those were
// inert text. Everything here is deliberately free of editor imports so the two
// halves that matter can be tested on their own: what counts as a reference,
// and which heading a reference names. The view layer that draws them lives in
// editor/SectionRef.js.
//
// Nothing in this file rewrites text. A reference stays literally `§3.2` in the
// document and in exported markdown; the link is a decoration painted over it.

// `§` or `§§` (the plural form legal writing uses), an optional space, then a
// dotted number. The leading group forces a word boundary so `x§5` mid-word is
// left alone, and `§` on its own or `§foo` never matches at all.
//
// A range — `§§5–7` — matches only its first number: the rest of the text is
// left plain rather than swallowed into a link that could only point one place.
const REF_RE = /(^|[^\p{L}\p{N}_])(§§?)(\s?)(\d+(?:\.\d+)*)/gu;

/** Drop a trailing period so `§3.` and `§3` name the same section. */
export const normalizeKey = (number) => String(number).replace(/\.+$/, '');

/**
 * Every §-reference in a run of text.
 * @returns {{start:number,end:number,key:string,raw:string}[]} offsets into `text`
 */
export function findSectionRefs(text) {
  if (!text || !text.includes('§')) return [];
  const out = [];
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const raw = m[2] + m[3] + m[4];
    out.push({ start, end: start + raw.length, key: normalizeKey(m[4]), raw });
    // Step back to just after this match so `§5 §6` both match even when the
    // separator between them is the boundary character the next match needs.
    REF_RE.lastIndex = start + raw.length;
  }
  return out;
}

/**
 * Split a heading's text into the number it claims and the title that follows.
 *
 * `## 3. Foundations` → `{ number: '3', title: 'Foundations' }`. A heading can
 * also opt in explicitly with a trailing `{#5}` marker, for docs whose
 * numbering doesn't live in the heading text — that wins over a leading number.
 */
export function parseHeading(text) {
  const trimmed = (text || '').trim();
  const explicit = trimmed.match(/\{#([^}\s]+)\}$/);
  const body = explicit ? trimmed.slice(0, explicit.index).trim() : trimmed;

  const leading = body.match(/^(\d+(?:\.\d+)*)\.?(?:\s+(.*))?$/);
  // A heading that is nothing but a number has no title of its own; fall back
  // to the whole text so a tooltip never comes up empty.
  const title = (leading?.[2] ?? body).trim() || body || trimmed;

  const number = explicit ? normalizeKey(explicit[1]) : leading ? normalizeKey(leading[1]) : null;
  return { number, title };
}

/** GitHub-style anchor slug, so hand-written `[§2](#2-why-…)` links resolve too. */
export function slugify(text) {
  return (text || '')
    .trim()
    .replace(/\{#[^}\s]+\}$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Index a document's headings by the section number a `§`-ref would name.
 *
 * @param headings `{ level, text, pos }` in document order
 * @returns `{ byKey, headings }` — headings carry their resolved slug `id`.
 *
 * Numbered headings are primary. If a document numbers nothing, `§5` falls back
 * to the 5th top-level (H2) section in document order, so plain docs still
 * navigate. Two headings claiming the same number: the first one wins, which
 * matches how a reader scanning down the page would resolve it.
 */
export function buildSectionIndex(headings = []) {
  const seenSlugs = new Map();
  const entries = headings.map((h) => {
    const { number, title } = parseHeading(h.text);
    const base = slugify(h.text) || 'section';
    // Two headings with the same words still need distinct anchors.
    const n = seenSlugs.get(base) ?? 0;
    seenSlugs.set(base, n + 1);
    return { ...h, number, title, id: n === 0 ? base : `${base}-${n}` };
  });

  const byKey = new Map();
  for (const entry of entries) {
    if (entry.number && !byKey.has(entry.number)) byKey.set(entry.number, entry);
  }

  if (byKey.size === 0) {
    let ordinal = 0;
    for (const entry of entries) {
      if (entry.level !== 2) continue;
      ordinal += 1;
      const key = String(ordinal);
      if (!byKey.has(key)) byKey.set(key, entry);
    }
  }

  return { byKey, headings: entries };
}

/** The heading a `§`-ref names, or null when the document has no such section. */
export function resolveRef(index, key) {
  return index?.byKey?.get(normalizeKey(key)) ?? null;
}

/** What a screen reader announces on a resolved ref. */
export const refAriaLabel = (key, title) => `Jump to section ${key}, ${title}`;
