// Wiki-style page links: [[Another Page]] typed in the editor becomes a
// `pageLink` node in the stored TipTap document. This module mirrors those
// nodes into the `page_links` table so backlinks ("what points here?") are a
// plain indexed query instead of a scan over every document.
//
// A link can be *unresolved* — written against a title that has no page yet.
// Those rows keep `target_id NULL` and remember the title, so creating or
// renaming a page later can adopt them (see `resolveLinksByTitle`).
import { q } from '../db.js';

export const PAGE_LINK_NODE = 'pageLink';

// Titles are matched loosely so "Design Docs" and "design docs" are the same
// link target. Kept in one place because the SQL below has to agree with it.
export const normalizeTitle = (title) => (title || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Walk a TipTap document collecting every page-link node.
export function extractLinks(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === PAGE_LINK_NODE) {
    const pageId = node.attrs?.pageId || null;
    const label = (node.attrs?.label || '').trim();
    if (pageId || label) out.push({ pageId, label });
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) extractLinks(child, out);
  }
  return out;
}

// Replace the stored link rows for a page to match its current content.
// Rewritten wholesale rather than diffed: a page has a handful of links and
// this runs inside the same request that already wrote the document.
export async function syncPageLinks(pageId, doc, spaceId) {
  const links = extractLinks(doc);

  // Collapse duplicates — linking the same page five times is still one edge.
  const byKey = new Map();
  for (const link of links) {
    const key = link.pageId || `title:${normalizeTitle(link.label)}`;
    if (!byKey.has(key)) byKey.set(key, link);
  }

  const resolved = [];
  for (const link of byKey.values()) {
    resolved.push({ ...(await resolveTarget(link, spaceId)), label: link.label });
  }

  await q('DELETE FROM page_links WHERE source_id = $1', [pageId]);
  for (const link of resolved) {
    await q(
      `INSERT INTO page_links (source_id, target_id, target_title, by_id) VALUES ($1, $2, $3, $4)`,
      [pageId, link.targetId, link.label, link.byId]
    );
  }
  return resolved;
}

// A link picked from the autocomplete carries the target's id and is treated as
// an identity link: it survives renames, because that is the whole point of
// storing an id. A link typed against a bare title is matched by title inside
// the same space instead, which is what makes `[[Roadmap]]` written before the
// Roadmap page existed start working once someone writes it.
async function resolveTarget({ pageId, label }, spaceId) {
  if (pageId) {
    const { rows } = await q('SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId]);
    if (rows[0]) return { targetId: rows[0].id, byId: true };
  }
  const key = normalizeTitle(label);
  if (!key || !spaceId) return { targetId: null, byId: false };
  const { rows } = await q(
    `SELECT id FROM pages
     WHERE space_id = $1 AND deleted_at IS NULL
       AND lower(regexp_replace(btrim(title), '\\s+', ' ', 'g')) = $2
     ORDER BY created_at LIMIT 1`,
    [spaceId, key]
  );
  return { targetId: rows[0]?.id || null, byId: false };
}

// ---- exact title resolution, for machines ----
//
// `link-search` is an autocomplete: a substring match, ranked by recency and
// cut off at twelve rows. That is right for a human picking from a menu and
// wrong for anything resolving `[[a title]]` to a page, because the exact match
// being looked for can sit outside that window while unrelated substring hits
// fill it. Bulk imports over the MCP hit exactly that (issue #66). The two
// helpers below back `POST /api/pages/resolve-titles`, which answers the
// question a machine is actually asking: which page *is* titled this?

// Which of the pages sharing a normalized title a link should point at.
// A page in the space the link was written in wins outright — that is what
// `[[Overview]]` means when you are inside a space that has one. Failing that a
// single match anywhere the caller can read resolves, and a genuine tie is
// reported as a tie rather than decided by an arbitrary ordering.
export function pickTitleMatch(candidates, preferSpaceId) {
  if (!candidates?.length) return { status: 'not_found' };
  const preferred = preferSpaceId ? candidates.filter((p) => p.space_id === preferSpaceId) : [];
  const pool = preferred.length ? preferred : candidates;
  if (pool.length > 1) return { status: 'ambiguous', candidates: pool };
  return { status: 'ok', page: pool[0] };
}

// The lookup itself: one round trip for a whole document's worth of links,
// matched on the same normalization `resolveTarget` and `page_links` use.
// Returns normalized title -> candidate pages, oldest first.
export async function lookupTitles(titles, acc) {
  const keys = [...new Set(titles.map(normalizeTitle).filter(Boolean))];
  const byKey = new Map(keys.map((k) => [k, []]));
  if (!keys.length) return byKey;
  const { rows } = await q(
    `SELECT p.id, p.title, p.icon, p.space_id, s.slug AS space_slug, s.name AS space_name,
            lower(regexp_replace(btrim(p.title), '\\s+', ' ', 'g')) AS norm
     FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE p.deleted_at IS NULL
       AND p.space_id IN (${acc.sql})
       AND lower(regexp_replace(btrim(p.title), '\\s+', ' ', 'g')) = ANY($${acc.params.length + 1}::text[])
     ORDER BY p.created_at, p.id`,
    [...acc.params, keys]
  );
  for (const row of rows) byKey.get(row.norm)?.push(row);
  return byKey;
}

// Adopt dangling links that were written against this page's title. Called
// after a page is created or renamed so `[[Roadmap]]` typed last week starts
// resolving the moment someone actually writes the Roadmap page.
export async function resolveLinksByTitle(page) {
  const key = normalizeTitle(page.title);
  if (!key) return 0;
  const { rowCount } = await q(
    `UPDATE page_links l SET target_id = $1
     FROM pages src
     WHERE l.source_id = src.id
       AND l.target_id IS NULL
       AND NOT l.by_id
       AND src.space_id = $2
       AND lower(regexp_replace(btrim(l.target_title), '\\s+', ' ', 'g')) = $3`,
    [page.id, page.space_id, key]
  );
  return rowCount;
}

// A rename can also *stop* matching title-written links that had adopted the
// old title, so drop those back to unresolved instead of leaving a stale edge.
// Id-carrying links are deliberately untouched — they follow the rename.
export async function unresolveStaleTitleLinks(page) {
  const key = normalizeTitle(page.title);
  await q(
    `UPDATE page_links SET target_id = NULL
     WHERE target_id = $1
       AND NOT by_id
       AND lower(regexp_replace(btrim(target_title), '\\s+', ' ', 'g')) <> $2`,
    [page.id, key]
  );
}
