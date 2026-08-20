/**
 * What a click does to the sidebar's selection.
 *
 * Kept apart from the component for the same reason the vim movement rules are:
 * the interesting part is a handful of ordering decisions that can be exercised
 * on their own, without a tree to render them into.
 *
 * Two orders are in play and they are not the same order:
 *
 *   visible  the rows actually drawn, top to bottom. Shift-click measures its
 *            range against this, because the range you meant is the one you can
 *            see — a collapsed parent's hidden children are not in it.
 *   order    every page in the space, whether it is showing or not. The
 *            selection is *stored* in this order, so collapsing a parent while
 *            five pages are selected does not silently reshuffle them, and a
 *            drop puts them down in the order they were sitting in.
 *
 * The selection is an array rather than a Set precisely because that order is
 * the feature: "preserve the order they were in" is a promise the data
 * structure has to be able to keep.
 */
import { flattenVisible } from './vimTreeNav.js';

// `flattenVisible` asks the expansion set one question, so "everything is open"
// is a set that answers yes. Cheaper and less to go wrong than a second walk.
const ALL_EXPANDED = { has: () => true };

/** Every page in the space, top to bottom, however much of it is showing. */
export const treeOrder = (childrenOf) =>
  flattenVisible(childrenOf, ALL_EXPANDED).map((row) => row.id);

/** The rows on screen, top to bottom. */
export const visibleOrder = (childrenOf, expanded) =>
  flattenVisible(childrenOf, expanded).map((row) => row.id);

/**
 * `ids` sorted into tree order, with anything no longer in the tree dropped.
 *
 * The pruning is not tidiness: pages come and go under a selection — someone
 * else moves one to another space, the page you had selected gets trashed — and
 * a selection holding ids the tree cannot draw would move ghosts.
 */
export function inTreeOrder(order, ids) {
  const wanted = new Set(ids);
  return order.filter((id) => wanted.has(id));
}

/**
 * The selection after a click on `id`, given which modifiers were held.
 *
 *   plain          clear the selection; the click is a navigation, and the
 *                  page becomes the anchor the next shift-click measures from.
 *   ⌘/ctrl         toggle this one page, leaving the rest alone.
 *   shift          select every visible row between the anchor and here.
 *   ⌘/ctrl + shift add that range to what is already selected, which is how
 *                  you gather two separate runs of pages.
 *
 * The anchor deliberately does not move on a shift-click: holding shift and
 * clicking further down should grow the same range rather than start a new one
 * from wherever the last click happened to land.
 */
export function nextSelection({ visible, order, selected, anchorId, id, meta, shift }) {
  const anchorVisible = anchorId && visible.includes(anchorId);
  if (shift && anchorVisible && visible.includes(id)) {
    const from = visible.indexOf(anchorId);
    const to = visible.indexOf(id);
    const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
    return {
      selected: inTreeOrder(order, meta ? [...selected, ...range] : range),
      anchorId,
    };
  }

  if (meta) {
    const has = selected.includes(id);
    const next = has ? selected.filter((s) => s !== id) : [...selected, id];
    // Deselecting leaves the anchor where it was — the page you just removed is
    // a strange place to measure the next range from.
    return { selected: inTreeOrder(order, next), anchorId: has ? anchorId : id };
  }

  return { selected: [], anchorId: id };
}

/**
 * The pages a drag starting on `id` is actually carrying.
 *
 * Dragging a row that is part of the selection takes the whole selection with
 * it; dragging anything else is a plain one-page drag and the selection it
 * ignored goes away, so the tree never carries pages the cursor did not touch.
 */
export function dragPayload(selected, id) {
  return selected.length > 1 && selected.includes(id) ? selected : [id];
}
