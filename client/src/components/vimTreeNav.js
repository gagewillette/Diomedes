/**
 * Movement rules for vim navigation in the page tree.
 *
 * Two ways to travel, deliberately different:
 *
 *   j / k  walk every page in the tree. Arriving at a collapsed parent opens
 *          it and carries on into its children, so holding j eventually visits
 *          the whole space. k is the exact mirror — going up retraces the same
 *          path, opening what it needs to.
 *   { / }  step between top-level pages only. Children are skipped whether
 *          they are showing or not, which is how you cross a big space fast.
 *
 * Kept apart from the component so the rules can be exercised on their own.
 */

const kidsOf = (childrenOf, id) => childrenOf.get(id) || [];

/** The rows currently drawn, top to bottom. */
export function flattenVisible(childrenOf, expanded) {
  const rows = [];
  const walk = (key, depth) => {
    for (const page of kidsOf(childrenOf, key)) {
      rows.push({ id: page.id, page, depth, hasKids: kidsOf(childrenOf, page.id).length > 0 });
      if (expanded.has(page.id)) walk(page.id, depth + 1);
    }
  };
  walk('root', 0);
  return rows;
}

/**
 * The last page you would reach by walking down into `page` with everything
 * open — plus the ids that had to be opened to get there.
 */
function deepestLast(childrenOf, expanded, page) {
  let cursor = page;
  const expand = [];
  for (;;) {
    const kids = kidsOf(childrenOf, cursor.id);
    if (!kids.length) break;
    if (!expanded.has(cursor.id)) expand.push(cursor.id);
    cursor = kids[kids.length - 1];
  }
  return { id: cursor.id, expand };
}

/** j — down one page, opening a parent to step into its children. */
export function moveDown(childrenOf, expanded, currentId) {
  const rows = flattenVisible(childrenOf, expanded);
  if (!rows.length) return null;
  if (!currentId || !rows.some((r) => r.id === currentId)) {
    return { id: rows[0].id, expand: [] };
  }
  const index = rows.findIndex((r) => r.id === currentId);
  const row = rows[index];
  if (row.hasKids && !expanded.has(row.id)) {
    return { id: kidsOf(childrenOf, row.id)[0].id, expand: [row.id] };
  }
  const next = rows[index + 1];
  return next ? { id: next.id, expand: [] } : null;
}

/** k — up one page, opening a collapsed parent above to land inside it. */
export function moveUp(childrenOf, expanded, currentId) {
  const rows = flattenVisible(childrenOf, expanded);
  if (!rows.length) return null;
  if (!currentId || !rows.some((r) => r.id === currentId)) {
    return { id: rows[rows.length - 1].id, expand: [] };
  }
  const index = rows.findIndex((r) => r.id === currentId);
  const prev = rows[index - 1];
  if (!prev) return null;
  if (prev.hasKids && !expanded.has(prev.id)) return deepestLast(childrenOf, expanded, prev.page);
  return { id: prev.id, expand: [] };
}

/** The top-level page the cursor currently sits under. */
function rootAncestor(byId, id) {
  let cursor = byId.get(id);
  while (cursor?.parent_id && byId.has(cursor.parent_id)) cursor = byId.get(cursor.parent_id);
  return cursor || null;
}

/** { and } — between top-level pages, ignoring children entirely. */
export function jumpParent(childrenOf, pages, currentId, direction) {
  const roots = kidsOf(childrenOf, 'root');
  if (!roots.length) return null;
  const byId = new Map(pages.map((p) => [p.id, p]));
  const anchor = currentId ? rootAncestor(byId, currentId) : null;
  const at = anchor ? roots.findIndex((r) => r.id === anchor.id) : -1;
  if (at === -1) return { id: direction > 0 ? roots[0].id : roots[roots.length - 1].id, expand: [] };
  // From inside a subtree, } goes to the next top-level page and { returns to
  // the top of the one you are in — the same asymmetry vim's paragraph jumps
  // have, and the reason { twice steps back one page rather than none.
  if (direction < 0 && currentId !== anchor.id) return { id: anchor.id, expand: [] };
  const next = roots[at + direction];
  return next ? { id: next.id, expand: [] } : null;
}
