// The parts of cross-workspace space transfer that are pure functions: which
// pages a selection actually resolves to, how an import code is spelled, and
// how a document's internal page references are rewritten on the way in.
//
// Kept free of `q` and `fetch` so the rules that decide what leaves a workspace
// can be tested without a database or a network.

// Bumped when the snapshot payload changes shape in a way an older importer
// cannot read. The code carries it too, so a workspace can refuse a code it
// does not understand instead of failing halfway through writing pages.
export const SNAPSHOT_VERSION = 1;
export const CODE_PREFIX = 'DIO1';

// A key names one export in a list of them; the ceiling just keeps the
// management table readable.
export const KEY_NAME_MAX = 60;

// Selection ceiling. A snapshot is assembled in memory on the exporting side
// and written page by page on the importing side, so an unbounded selection is
// a way to ask one workspace to hold another workspace's entire corpus in RAM.
export const MAX_EXPORT_PAGES = 2000;

/**
 * Resolve the pages the user ticked into the list a snapshot actually carries.
 *
 * The rule that makes this more than a filter: a page whose parent was *not*
 * ticked still needs that parent to exist on the other side, or the import has
 * nowhere to hang it and the tree the author arranged collapses into a flat
 * list. So every unticked ancestor of a ticked page rides along as a structural
 * placeholder — the title and icon that give the tree its shape, and none of
 * the body content nobody agreed to share.
 *
 * Returns document order (a parent always precedes its own descendants, and
 * siblings keep their order_key order), because that is the order the importer
 * has to write in: a child cannot be inserted before the row it points at.
 *
 * @param {Array<{id: string, parent_id: string|null, order_key?: string}>} pages
 *   Every live page in the space.
 * @param {Iterable<string>} selectedIds Pages whose content was ticked.
 * @returns {Array<{id: string, includeContent: boolean}>}
 */
export function expandSelection(pages, selectedIds) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const selected = new Set([...selectedIds].filter((id) => byId.has(id)));

  // Walk up from each ticked page marking ancestors as needed. The `seen` guard
  // is not paranoia about malformed data so much as about a parent cycle, which
  // would otherwise spin here forever.
  const needed = new Set();
  for (const id of selected) {
    let cursor = id;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      needed.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }

  // Emit in document order by walking the tree rather than sorting the flat
  // list: order_key is only meaningful among siblings, so a flat sort would
  // interleave cousins and could place a child ahead of its parent.
  const children = new Map();
  for (const page of pages) {
    // A page whose parent is missing from the list (or outside it) is a root as
    // far as this walk is concerned, so nothing is silently dropped.
    const parent = page.parent_id && byId.has(page.parent_id) ? page.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(page);
  }
  for (const list of children.values()) {
    list.sort((a, b) => String(a.order_key ?? '').localeCompare(String(b.order_key ?? '')));
  }

  const out = [];
  const walk = (parentId, depth) => {
    // Depth guard for the same reason as the cycle guard above.
    if (depth > 200) return;
    for (const page of children.get(parentId) ?? []) {
      if (needed.has(page.id)) out.push({ id: page.id, includeContent: selected.has(page.id) });
      walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Summarise a selection for the UI: how many pages carry content, and how many
 * are along only to hold the tree together.
 */
export function summarizeSelection(selection) {
  const withContent = selection.filter((s) => s.includeContent).length;
  return { total: selection.length, withContent, placeholders: selection.length - withContent };
}

const encodeOrigin = (origin) => Buffer.from(origin, 'utf8').toString('base64url');
const decodeOrigin = (encoded) => Buffer.from(encoded, 'base64url').toString('utf8');

/**
 * `DIO1.<base64url(origin)>.<secret>` — version, where to pull from, and the
 * credential to pull with.
 *
 * The origin is in the code rather than typed separately because the two halves
 * are useless apart: a secret with no origin cannot be redeemed, and pasting
 * one string is the whole point. base64url is used precisely because it cannot
 * contain a `.`, which is what makes splitting on `.` unambiguous.
 */
export function encodeTransferCode(origin, secret) {
  return `${CODE_PREFIX}.${encodeOrigin(origin)}.${secret}`;
}

/**
 * Parse a pasted code. Throws with a message meant to be shown to the person
 * who pasted it — "this is not a Diomedes code" and "this code is from a newer
 * version" are different problems and deserve different sentences.
 */
export function decodeTransferCode(code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) throw new Error('Import code is required');

  const parts = trimmed.split('.');
  if (parts.length !== 3) throw new Error('That does not look like a Diomedes import code');
  const [prefix, encodedOrigin, secret] = parts;
  if (prefix !== CODE_PREFIX) {
    throw new Error(
      /^DIO\d+$/.test(prefix)
        ? 'This code was made by a newer version of Diomedes than this workspace runs'
        : 'That does not look like a Diomedes import code'
    );
  }
  if (!secret || !/^[A-Za-z0-9_-]+$/.test(secret)) throw new Error('Import code is malformed');

  let origin;
  try {
    origin = decodeOrigin(encodedOrigin);
  } catch {
    throw new Error('Import code is malformed');
  }

  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Import code is malformed');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Import code is malformed');
  }

  // Normalise away any path or trailing slash so the fetch below builds one
  // canonical URL whatever the exporting workspace had APP_URL set to.
  return { origin: url.origin, secret };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rewrite the page ids a document refers to so they point at the imported
 * copies rather than at ids that only mean something in the source workspace.
 *
 * Covers the two ways a document names a page: a `pageLink` node's `pageId`
 * attribute (also used by section references), and an href written as a
 * `/s/<slug>/p/<id>` app path. Anything referring to a page that was not part
 * of the export is left exactly as it was — rewriting it to nothing would turn
 * a link that is merely broken into a link that is silently wrong.
 */
export function remapDocumentIds(node, idMap, spaceSlug) {
  if (Array.isArray(node)) return node.map((child) => remapDocumentIds(child, idMap, spaceSlug));
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'attrs' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.attrs = remapAttrs(value, idMap, spaceSlug);
    } else if (value && typeof value === 'object') {
      out[key] = remapDocumentIds(value, idMap, spaceSlug);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function remapAttrs(attrs, idMap, spaceSlug) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'pageId' && typeof value === 'string' && idMap.has(value)) {
      out[key] = idMap.get(value);
    } else if (key === 'href' && typeof value === 'string') {
      out[key] = remapHref(value, idMap, spaceSlug);
    } else if (value && typeof value === 'object') {
      out[key] = remapDocumentIds(value, idMap, spaceSlug);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Swap the page id inside an in-app document path. The space slug is rewritten
 * too — the imported space has a slug of its own, and a link carrying the old
 * one would resolve to a space that may not exist here at all.
 */
export function remapHref(href, idMap, spaceSlug) {
  return href.replace(
    /(\/s\/)([^/\s]+)(\/p\/)([0-9a-fA-F-]{36})/g,
    (whole, sPrefix, slug, pPrefix, id) => {
      if (!UUID_RE.test(id) || !idMap.has(id)) return whole;
      return `${sPrefix}${spaceSlug ?? slug}${pPrefix}${idMap.get(id)}`;
    }
  );
}
