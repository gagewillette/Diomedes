// Depth in the sidebar: how far down a page sits, how far its branch reaches,
// and what the tree is therefore allowed to do with it.
//
// This is the client half of server/src/lib/pageDepth.js. It exists as a plain
// module rather than as closures inside PageTree so it can be tested where the
// project actually runs tests — the same arrangement as pageSelection.js and
// vimNav.js. None of it is authority: the server checks every move and create
// again. What it decides is what the sidebar *offers*, and an item that appears
// and then fails is worse than one that was never there.
//
// MAX_PAGE_DEPTH is duplicated rather than fetched. It decides what a menu shows
// on every row, a round trip per row is not worth it, and the value changes
// about never — but it does have to agree with the server, so the two are named
// the same thing on purpose.
export const MAX_PAGE_DEPTH = 20;

// Levels are 0-based here and 1-based on the server: `renderNode` already
// carries a `depth` that is 0 for a root row, and re-basing it at the boundary
// is one conversion in one place instead of a `+ 1` at every call site.
const levelOf = (depth) => depth + 1;

// ---- indentation ----

// A flat `depth * 14` runs a title off the side of a ~260px sidebar somewhere
// around level 8. That was unreachable while the tree was capped at one level of
// subpages and is ordinary now, so the step narrows once the indent has done its
// job: the first few levels are where indentation actually communicates
// structure, and past that it only has to distinguish one level from the next.
// A level-20 row lands at 130px rather than 270px, leaving half a 260px sidebar
// for the title instead of none of it.
export const INDENT_FULL_LEVELS = 5;
export const INDENT_STEP = 14;
export const INDENT_DEEP_STEP = 4;

export const rowIndent = (depth) =>
  4 +
  Math.min(depth, INDENT_FULL_LEVELS) * INDENT_STEP +
  Math.max(0, depth - INDENT_FULL_LEVELS) * INDENT_DEEP_STEP;

// ---- measuring the tree ----

/**
 * Where every page sits and how far its own branch reaches, in one pass.
 *
 * `childrenOf` is PageTree's map of parent id → child pages, with root pages
 * under the key 'root'. `depths` is 0-based per page; `heights` is how many
 * levels hang below a page, 0 for a leaf, and is keyed by page id with 'root'
 * carrying the height of the whole tree.
 *
 * Done once per render rather than per row: `dropAllowed` and the row menu each
 * ask about depth for every visible page, and walking the subtree inside those
 * would be quadratic in a tree that can now genuinely be deep.
 */
export function treeDepths(childrenOf) {
  const depths = new Map();
  const heights = new Map();
  const walk = (id, depth) => {
    let height = 0;
    for (const child of childrenOf.get(id) || []) {
      depths.set(child.id, depth);
      height = Math.max(height, walk(child.id, depth + 1) + 1);
    }
    heights.set(id, height);
    return height;
  };
  walk('root', 0);
  return { depths, heights };
}

/**
 * Every id under `rootId`, itself included, in no particular order.
 *
 * Two callers want exactly this set and want it for the same reason: a page's
 * own descendants are the one place it can never be put. The drag path uses it
 * to refuse a drop, and the parent picker uses it to leave those pages out of
 * the menu in the first place.
 */
export function subtreeIds(childrenOf, rootId) {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const child of childrenOf.get(ids[i]) || []) ids.push(child.id);
  }
  return ids;
}

// ---- what the depth limit allows ----

/**
 * Whether a page at `depth` can take subpages — i.e. whether there is a level
 * left underneath it.
 */
export const canNest = (depth) => levelOf(depth) + 1 <= MAX_PAGE_DEPTH;

/**
 * Whether a page at `depth` can be nested one level further down, carrying a
 * branch `height` tall with it. This replaces "only a childless page can be
 * nested", which the one-level cap made the same question.
 */
export const canBeNested = (depth, height = 0) =>
  levelOf(depth) + 1 + height <= MAX_PAGE_DEPTH;

/**
 * Whether a drag may be dropped on a row, refused during dragover so the cursor
 * says "no drop" rather than the drop failing after the fact.
 *
 * `zone` is 'inside' for a drop *into* the row, which puts the batch one level
 * below it; anything else lands beside the row, at the row's own level.
 * `dragHeight` is how far the tallest branch in the batch reaches below its own
 * root — what has to fit is the whole branch, not the row under the cursor.
 *
 * Whether the target is inside the batch's own subtree is a separate question,
 * answered by `blockedIds` before this is ever called.
 */
export const dropAllowed = (depth, zone, dragHeight = 0) =>
  levelOf(depth) + (zone === 'inside' ? 1 : 0) + dragHeight <= MAX_PAGE_DEPTH;

// ---- breadcrumbs ----

// How many ancestor levels the header shows before it starts eliding the middle.
// Four keeps `Space / First / Parent / Page` intact — the shape most pages have
// — and folds only when there is genuinely more chain than bar.
export const BREADCRUMB_LIMIT = 4;

/**
 * Split an ancestor chain into what the header shows and what goes behind a menu.
 *
 * The header is one row, and a deep page rendered in full pushes the presence
 * bar, save state and page menu off the end of it — squeezing the first and last
 * segments, which are the two that actually say where you are. So the first
 * ancestor and the last two survive and the middle is elided, which is also
 * where a reader would look for "the levels I skipped".
 *
 * Returns `{ leading, elided, trailing }`; `elided` is empty when the chain is
 * short enough to render whole, and `leading` is then the entire chain.
 */
export function elideCrumbs(crumbs, limit = BREADCRUMB_LIMIT) {
  if (crumbs.length <= limit) return { leading: crumbs, elided: [], trailing: [] };
  return {
    leading: crumbs.slice(0, 1),
    elided: crumbs.slice(1, crumbs.length - 2),
    trailing: crumbs.slice(-2),
  };
}
