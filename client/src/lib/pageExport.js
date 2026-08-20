// Turning a page and its descendants into a flat set of markdown files.
//
// Everything here is a pure function over plain data: no editor, no network,
// no zip writer. That is deliberate — the bugs this feature can actually have
// live in the walk (does it reach a grandchild?) and in the naming (do two
// pages fight over one filename?), and both are cheapest to pin down in a test
// that needs nothing but objects.

// Characters no filesystem worth the name will accept.
const INVALID = /[/\\:*?"<>|]/g;
// The control range, minus tab/newline and friends — those are whitespace, and
// the collapse below turns them into the single space a person would expect.
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f]/g;
// Windows still refuses these, extension or not.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Leaves room for " (12).md" and for the path around it on every filesystem we
// care about. Counted in UTF-8 bytes, because that is what the limit is.
const MAX_NAME_BYTES = 120;

const utf8 = new TextEncoder();

// Cut to a byte budget without splitting a character in half — a lone
// surrogate would make the archive unreadable, which is a worse outcome than a
// slightly shorter name.
function truncateBytes(str, max) {
  if (utf8.encode(str).length <= max) return str;
  let out = '';
  let bytes = 0;
  for (const ch of str) {
    const size = utf8.encode(ch).length;
    if (bytes + size > max) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * A page title as a filename stem (no extension). Sanitised only as far as the
 * filesystem requires: emoji, accents and punctuation that is merely unusual
 * all survive.
 */
export function sanitizeFilename(title) {
  let name = String(title ?? '')
    .replace(CONTROL, '')
    .replace(INVALID, '-')
    .replace(/\s+/g, ' ')
    .trim();
  // A leading dot hides the file on unix; a trailing dot or space is silently
  // dropped by Windows, which would turn two distinct names into one.
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  name = truncateBytes(name, MAX_NAME_BYTES).replace(/[.\s]+$/, '');
  // A title of nothing but separators ("///") sanitises to nothing but the
  // dashes we put there, which is not a name anyone asked for.
  if (!name || /^[-.\s]+$/.test(name)) return 'Untitled';
  if (RESERVED.test(name)) return `_${name}`;
  return name;
}

/**
 * Claim `<base>.md` in a flat archive, stepping to " (2)", " (3)", … while the
 * name is taken. Comparison is case-insensitive because macOS and Windows are:
 * "Notes.md" and "notes.md" cannot both exist there.
 *
 * `claimed` is mutated — it is the archive's set of taken names.
 */
export function claimFilename(base, claimed) {
  let name = `${base}.md`;
  let n = 1;
  while (claimed.has(name.toLowerCase())) {
    n += 1;
    name = `${base} (${n}).md`;
  }
  claimed.add(name.toLowerCase());
  return name;
}

// Siblings render in order_key order (COLLATE "C" on the server, so a plain
// string compare here means the same thing), with created_at and finally id as
// tie-breaks so the walk is deterministic even for keys that collide.
function bySiblingOrder(a, b) {
  const ka = a.order_key ?? '';
  const kb = b.order_key ?? '';
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ca = String(a.created_at ?? '');
  const cb = String(b.created_at ?? '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Pre-order, depth-first walk of a subtree given as a flat list of rows.
 *
 * Depth is whatever the data says it is: the walk recurses until it runs out of
 * children, so a tree that grows a fourth level tomorrow exports four levels
 * tomorrow with no change here. Pages not reachable from `rootId` are ignored,
 * and a parent cycle cannot make the walk loop.
 */
export function flattenSubtree(pages, rootId) {
  const byParent = new Map();
  let root = null;
  for (const page of pages) {
    if (page.id === rootId) root = page;
    const key = page.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(page);
  }
  if (!root) return [];
  for (const kids of byParent.values()) kids.sort(bySiblingOrder);

  const out = [];
  const seen = new Set();
  const walk = (page) => {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    out.push(page);
    for (const kid of byParent.get(page.id) || []) walk(kid);
  };
  walk(root);
  return out;
}

// Double-quoted YAML, escaped the way JSON escapes it — the two agree on
// quotes and backslashes, which is all a title can throw at us.
const yamlString = (value) => JSON.stringify(String(value ?? ''));

/**
 * The YAML frontmatter block that makes a flat archive re-importable later: the
 * title (which is not part of the body), where the page sat in the tree, and
 * when it last changed.
 */
export function frontmatter(page) {
  const lines = [
    '---',
    `title: ${yamlString(page.title || 'Untitled')}`,
    `id: ${yamlString(page.id)}`,
    `parent: ${page.parent_id ? yamlString(page.parent_id) : 'null'}`,
  ];
  if (page.updated_at) lines.push(`updated_at: ${yamlString(page.updated_at)}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * The whole archive as `[{ name, text, page }]`, in walk order.
 *
 * `render` turns one page's stored content into markdown; it is passed in so
 * this stays testable without an editor. The root page claims its filename
 * first, so it is never the one that ends up as "Name (2).md".
 */
export function subtreeFiles(pages, rootId, render) {
  const claimed = new Set();
  return flattenSubtree(pages, rootId).map((page) => {
    const name = claimFilename(sanitizeFilename(page.title), claimed);
    const body = render(page) || '';
    const text = `${frontmatter(page)}\n\n# ${page.title || 'Untitled'}\n\n${body}\n`;
    return { name, text, page };
  });
}
