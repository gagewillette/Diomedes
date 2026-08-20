// State shared by every sidebar tree for the duration of one drag.
//
// It cannot live in the drag event. `dataTransfer` only yields its payload on
// drop, by design — a page being dragged over a site must not be readable by
// it — but the tree has to decide *during* dragover whether a row is a legal
// target, and which space the page is coming from. So the details ride along
// here instead, in module scope, which is also what lets a page dragged out of
// one space's tree be understood by another space's tree: they are separate
// components with no common ancestor holding this state.
export const dragState = { current: null };

// How much of a row's height at each edge means "put it beside this page"
// rather than "put it inside". A third each way leaves the middle third as a
// comfortable target for nesting, which is the harder gesture to aim.
const EDGE_FRACTION = 1 / 3;

/** Which of the three drops the cursor is asking for, given a row's box. */
export function dropIntent(rect, clientY) {
  const offset = clientY - rect.top;
  if (offset < rect.height * EDGE_FRACTION) return 'before';
  if (offset > rect.height * (1 - EDGE_FRACTION)) return 'after';
  return 'inside';
}
