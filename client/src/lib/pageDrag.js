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

// How many pages of a selection are actually drawn in the thing the cursor
// carries. Past three the fan stops reading as a stack and starts reading as a
// smudge, and the count badge says the real number anyway.
const STACK_MAX = 3;

/**
 * The ghost the cursor carries during a multi-page drag: a squared-up fan of
 * cards with a count on it.
 *
 * It has to be a real, attached element — `setDragImage` snapshots it out of
 * the live document, and a detached node or one with `display: none` snapshots
 * as nothing. So it is parked off-screen instead, and the caller drops it once
 * the browser has taken its picture.
 *
 * The snapshot is also why the fan is static: the shuffle the rows do as they
 * are picked up is a CSS animation on the tree itself, which is where it can
 * actually play.
 */
export function multiDragImage(titles, total, doc = document) {
  const node = doc.createElement('div');
  node.className = 'gd-drag-stack';
  const shown = titles.slice(0, STACK_MAX);
  // Back to front: the card the drag started from ends up last in the DOM, so
  // it sits on top of the pile rather than under it.
  for (let i = shown.length - 1; i >= 0; i--) {
    const card = doc.createElement('div');
    card.className = 'gd-drag-card';
    card.style.setProperty('--i', String(i));
    card.textContent = shown[i];
    node.appendChild(card);
  }
  if (total > 1) {
    const badge = doc.createElement('span');
    badge.className = 'gd-drag-count';
    badge.textContent = String(total);
    node.appendChild(badge);
  }
  doc.body.appendChild(node);
  return node;
}
