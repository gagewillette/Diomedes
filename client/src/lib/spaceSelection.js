// What an export selection actually amounts to, computed in the browser so the
// tree can answer every tick immediately.
//
// This deliberately mirrors expandSelection in server/src/lib/spaceTransfer.js.
// The server is still the authority — it re-expands the selection when the key
// is minted, and what it stores is what the key carries — but the modal has to
// show a parent turning into a structural placeholder the instant a child is
// ticked, and a round trip per checkbox is the wrong way to do that. If the
// rule changes, it changes in both places; both have tests over the same cases.

/** Children keyed by parent id, each list in order_key order. */
export function buildTree(pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const children = new Map();
  for (const page of pages) {
    const parent = page.parent_id && byId.has(page.parent_id) ? page.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(page);
  }
  for (const list of children.values()) {
    list.sort((a, b) => String(a.order_key ?? '').localeCompare(String(b.order_key ?? '')));
  }
  return { byId, children, roots: children.get(null) ?? [] };
}

/** Every descendant of `pageId`, for the "select this page and everything under it" action. */
export function descendantIds(children, pageId, out = []) {
  for (const child of children.get(pageId) ?? []) {
    out.push(child.id);
    descendantIds(children, child.id, out);
  }
  return out;
}

/**
 * The pages that will ride along only to keep the tree shape: an unticked
 * ancestor of something that was ticked.
 *
 * This is the set the modal shades differently, so "I only picked two child
 * pages, why does it say four" answers itself on screen.
 */
export function placeholderIds(byId, selectedIds) {
  const selected = new Set(selectedIds);
  const placeholders = new Set();
  for (const id of selected) {
    let cursor = byId.get(id)?.parent_id ?? null;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (!selected.has(cursor)) placeholders.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }
  return placeholders;
}

/** Counts for the modal's footer. */
export function selectionSummary(byId, selectedIds) {
  const selected = new Set([...selectedIds].filter((id) => byId.has(id)));
  const placeholders = placeholderIds(byId, selected);
  return {
    withContent: selected.size,
    placeholders: placeholders.size,
    total: selected.size + placeholders.size,
  };
}
