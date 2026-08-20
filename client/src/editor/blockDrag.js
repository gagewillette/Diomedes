// Picking a block up and putting it somewhere else.
//
// Every top-level node already has a name (client/src/editor/blockId.js) and a
// sort key in `page_blocks` (server/src/lib/orderKey.js). Reordering was the
// one thing the person editing the page still could not do with either: the
// only way to move a paragraph was cut-and-paste, which is fiddly and — before
// block ids — read to everything downstream as a deletion plus an unrelated
// insertion.
//
// ---- Why the drag is ours and not the browser's ----
//
// The first version of this handed the drag to ProseMirror: it set
// `view.dragging` on a `draggable` element and let the native HTML5 drag run.
// That never worked. A native drag is cancelled outright if the source element
// is hidden or removed while `dragstart` is still on the stack, and the handle
// hid itself (and dispatched a selection transaction, redrawing the block) in
// exactly that window — so the browser dropped the drag on the floor and the
// block never moved. The native path is also a dead end for the feel we want:
// it hands over a frozen bitmap and only tells us where the pointer is on
// whatever `dragover` cadence the OS feels like, which is not enough to slide
// the other blocks out of the way.
//
// So the drag is driven by pointer events instead:
//
//   * pointerdown on the handle captures the pointer, so every move arrives
//     here even when it leaves the editor,
//   * the dragged block is translated under the pointer and the blocks it
//     would displace are translated by exactly one slot, with a CSS transition
//     — that opening gap *is* the drop indicator,
//   * pointerup applies one transaction and then FLIPs every block from where
//     it was drawn to where it now belongs, so the document settles instead of
//     snapping.
//
// One transaction matters more than it looks:
//
//   * the block keeps its id — it is the same node object moving, never
//     re-parsed, so the save that follows is a reorder rather than a
//     delete-plus-create, and the embedding queue re-embeds nothing,
//   * there is no instant where the document holds the block twice, so
//     stampMissingIds never sees a duplicate to rename,
//   * Yjs sees a single edit and merges it like any other, so a drag is safe
//     with other people typing in the same document.
//
// ---- Where the order key comes from ----
//
// Nowhere on this side. The client moves the node in the document and saves the
// document exactly as it always did; `writePageBody` reprojects `page_blocks`
// in the same transaction and `assignOrderKeys` mints keys only for the blocks
// whose stored key no longer sorts in the right place — one key for a one-block
// move. Fractional indexing is what makes that possible, and it is entirely a
// server-side consequence of the new document order.
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { BLOCK_ID_DATA_ATTR } from './blockId.js';

export const blockDragPluginKey = new PluginKey('blockDrag');

// How far left of the text column the handle sits, and how big it is. Kept in
// JS because the handle is positioned in JS anyway; the CSS in styles.css only
// paints it.
const HANDLE_SIZE = 20;
const HANDLE_GAP = 6;
// How long the handle stays put after the pointer leaves the block it belongs
// to. Long enough to cross the gutter at a human pace, short enough that a
// handle left behind never looks stuck. Kept in step with the right-hand pad on
// .gd-block-handle::after, which has to stay >= HANDLE_GAP for the trip from
// text to handle to be one unbroken hover.
const HIDE_DELAY = 260;

// How far the pointer has to travel before a press on the handle becomes a
// drag. Below this it is a click, which selects the block — the two gestures
// start identically and only the distance tells them apart.
const DRAG_THRESHOLD = 4;
// How long a displaced block takes to slide out of the way, and how long the
// settle after a drop runs.
const SLIDE_MS = 180;
const SETTLE_MS = 220;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
// The band at the top and bottom of the scrolling area that scrolls the page
// while a block is held over it, and the fastest it scrolls.
const EDGE = 72;
const MAX_SCROLL_STEP = 22;

const reduceMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Document position of the top-level child at `index`. */
function posOfChild(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * The index of the top-level block a position sits in.
 *
 * `index(0)` answers this for both selection shapes without a special case: for
 * a cursor inside a paragraph it is the paragraph's index, and for a
 * NodeSelection — whose $from sits *before* the node, at depth 0 — it is the
 * index of the node that follows, which is the selected one.
 */
const topLevelIndex = ($pos) => $pos.index(0);

/**
 * Move the top-level block at `from` so that it ends up at index `to`.
 *
 * `to` is read the way `Array.prototype.splice` reads it — the index the block
 * occupies *after* it has been taken out and put back — so a drag only has to
 * count how many of the other blocks end up above it.
 *
 * Written as a plain state/dispatch command so it can be tested without a DOM,
 * and so the drag, the keyboard shortcut and the commands share one definition
 * of what "move this block" means. Returns false — leaving the key to whatever
 * else wants it — when there is nowhere to move to.
 */
export function moveBlockTo(state, dispatch, from, to, { offset = null, scroll = true } = {}) {
  const { doc } = state;
  const last = doc.childCount - 1;
  if (from < 0 || from > last || to < 0 || to > last || from === to) return false;
  if (!dispatch) return true;

  const node = doc.child(from);
  const start = posOfChild(doc, from);
  const tr = state.tr.delete(start, start + node.nodeSize);
  const at = posOfChild(tr.doc, to);
  tr.insert(at, node);

  // Where the caret lands. A block that was carrying a cursor keeps it, at the
  // same offset; anything else gets selected whole, which is both what a click
  // on the handle did a moment ago and a plain statement of what just moved.
  if (offset != null) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + offset, tr.doc.content.size))));
  } else if (NodeSelection.isSelectable(node)) {
    tr.setSelection(NodeSelection.create(tr.doc, at));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
  }

  dispatch(scroll ? tr.scrollIntoView() : tr);
  return true;
}

/**
 * Move the block holding the selection one slot up or down.
 *
 * The keyboard half of the same move: it works out which block the selection
 * names and hands `moveBlockTo` the two indices.
 */
export function moveBlockBy(state, dispatch, direction) {
  const { doc, selection } = state;
  const index = topLevelIndex(selection.$from);
  const target = index + direction;
  if (target < 0 || target >= doc.childCount) return false;
  // A selection that spans two top-level blocks has no single block to move,
  // and guessing which one the person meant would move the wrong one half the
  // time.
  if (topLevelIndex(selection.$to) !== index && !(selection instanceof NodeSelection)) return false;

  // A node selection travels as a node selection; a cursor keeps its offset
  // inside the block it was in.
  const offset =
    selection instanceof NodeSelection ? null : selection.from - posOfChild(doc, index);
  return moveBlockTo(state, dispatch, index, target, { offset });
}

/**
 * The top-level block under the pointer, as a document position.
 *
 * `posAtCoords` returns null in the left gutter the handle itself lives in, so
 * a miss is retried against the text column at the same height — otherwise the
 * handle would vanish the moment the pointer moved towards it.
 */
function blockPosAt(view, clientX, clientY) {
  const rect = view.dom.getBoundingClientRect();
  const found =
    view.posAtCoords({ left: clientX, top: clientY }) ||
    view.posAtCoords({ left: rect.left + rect.width / 2, top: clientY });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.inside > -1 ? found.inside : found.pos);
  // depth 0 means the coordinates landed between two blocks rather than in one.
  return $pos.depth === 0 ? (found.inside > -1 ? found.inside : null) : $pos.before(1);
}

/**
 * Vertical offset that puts the handle beside the block's *first line* rather
 * than the middle of it — so a twenty-line quote gets a handle at the top,
 * where the block visually starts, not floating in its centre.
 */
function firstLineOffset(dom) {
  const height = dom.getBoundingClientRect().height;
  const lineHeight = parseFloat(getComputedStyle(dom).lineHeight);
  const line = Number.isFinite(lineHeight) ? Math.min(lineHeight, height) : height;
  return Math.max(0, (line - HANDLE_SIZE) / 2);
}

function createHandle() {
  const el = document.createElement('div');
  el.className = 'gd-block-handle';
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', 'Drag to move this block');
  el.title = 'Drag to move · click to select';
  // Six dots, the near-universal grip. An SVG would need a colour that tracks
  // the theme; a glyph inherits one.
  el.textContent = '⠿';
  return el;
}

/**
 * A hide that can be called off.
 *
 * Split out of the handle — and given injectable timers — because the grace
 * period is the whole of the fix and deserves a test that does not need a DOM.
 * Scheduling twice keeps the first deadline rather than pushing it back: a
 * pointer wandering the gutter should not be able to hold a stale handle open
 * for ever.
 */
export function createHideScheduler(
  hide,
  { delay = HIDE_DELAY, setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  let timer = null;
  return {
    schedule() {
      if (timer != null) return;
      timer = setTimer(() => {
        timer = null;
        hide();
      }, delay);
    },
    cancel() {
      if (timer == null) return;
      clearTimer(timer);
      timer = null;
    },
    get pending() {
      return timer != null;
    },
  };
}

/**
 * Where the drop leaves the block, given where the pointer is.
 *
 * Counting the blocks whose middle the pointer has passed is the whole rule:
 * it is the index the block takes once it has been lifted out and put back, it
 * needs no special case for dragging up versus down, and it has the hysteresis
 * people expect for free — a block only changes places once its neighbour's
 * midpoint is crossed, not the moment the two overlap.
 *
 * `blocks` is every top-level block measured *before* anything moved.
 * Exported for the tests: this is the arithmetic that decides where a drop
 * lands, and it should not need a browser to check.
 */
export function dropIndex(blocks, from, pointerY) {
  let to = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i === from) continue;
    const { top, bottom } = blocks[i];
    if (pointerY > (top + bottom) / 2) to += 1;
  }
  return to;
}

/**
 * How far a block has to slide to get out of the way, in pixels.
 *
 * The slot a block occupies is its own height plus the margin between it and
 * the next one, and margins differ per block type — so measure the real
 * distance between two adjacent blocks rather than assuming one. Falls back to
 * bare height for a document with a single block, where nothing can move.
 */
export function slotAdvance(blocks, from) {
  const self = blocks[from];
  const next = blocks[from + 1];
  if (next) return next.top - self.top;
  const prev = blocks[from - 1];
  if (prev) return self.bottom - prev.bottom;
  return self.height;
}

/**
 * Which way each block has to slide for the dragged block to land at `to`.
 *
 * Everything the block jumps over moves one slot the other way; everything
 * else stays put. Returns a shift in pixels for the block at `index`.
 */
export function shiftFor(index, from, to, advance) {
  if (index === from) return 0;
  if (to > from && index > from && index <= to) return -advance;
  if (to < from && index >= to && index < from) return advance;
  return 0;
}

/**
 * Move a block, without writing a single attribute on it.
 *
 * This is the constraint the whole preview is built around. ProseMirror watches
 * its own DOM with a MutationObserver and treats a changed `style` or `class`
 * on a block as the document having been edited by hand: it re-reads the node
 * and redraws it, which throws the inline style away again. Painting a preview
 * that way is a fight the preview loses — and repainting on every redraw turns
 * it into a loop that locks the tab up.
 *
 * The Web Animations API sets no attribute at all. The transform lives on the
 * animation, `fill: 'forwards'` holds it, and ProseMirror sees nothing to react
 * to. `from` is stated explicitly rather than left implicit because cancelling
 * the previous animation drops its held value first, and a slide has to start
 * where the last one left off.
 */
function glide(dom, from, to, duration) {
  return dom.animate(
    [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }],
    { duration, easing: EASE, fill: 'forwards' }
  );
}

/** The scrolling box the editor lives in — for autoscroll while dragging. */
function scrollParent(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * The hover handle and the drag it starts.
 *
 * Lives in a plugin view rather than in React because it has to follow the
 * pointer at pointer speed — putting it in React state would re-render the
 * editor's whole subtree on every mousemove.
 */
function handleView(view) {
  // The wrapper EditorContent renders around the ProseMirror node. It is given
  // a class rather than an inline style so the positioning context is visible
  // in the stylesheet next to the handle it contains.
  const host = view.dom.parentElement;
  if (!host) return { destroy() {} };
  host.classList.add('gd-block-handle-host');

  const handle = createHandle();
  handle.style.display = 'none';
  host.appendChild(handle);

  // The block the handle currently points at. Held here, not in plugin state:
  // hovering is not part of the document and putting it in state would put a
  // transaction on every mouse move.
  let hovered = null;
  // Whether the pointer is resting on the handle itself. Anything that would
  // otherwise take the handle away has to check this first: pulling it out from
  // under the pointer is exactly the bug being fixed.
  let onHandle = false;
  // The drag in progress, or null. See `beginDrag` for the shape.
  let drag = null;

  // Hiding is deferred rather than immediate. The handle deliberately sits in
  // the gutter, a few pixels clear of the text column, so a pointer travelling
  // towards it *must* first leave the text — and, for the last stretch, leave
  // the wrapper the mousemove listener is on. Hiding on that first frame made
  // the handle unreachable: it vanished while the pointer was still on its way.
  // A short grace period covers the crossing, and anything proving the pointer
  // is still in play cancels it. The gap itself is bridged by an invisible pad
  // on the handle (see .gd-block-handle::after), so this is the belt to that
  // pair of braces rather than the only defence.
  const hideNow = () => {
    hovered = null;
    handle.style.display = 'none';
  };

  const hider = createHideScheduler(() => {
    if (!onHandle && !drag) hideNow();
  });

  const cancelHide = hider.cancel;

  const hide = () => {
    hider.cancel();
    hideNow();
  };

  const scheduleHide = () => {
    if (hovered == null || onHandle || drag) return;
    hider.schedule();
  };

  const show = (pos) => {
    cancelHide();
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return hide();
    const rect = dom.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const textLeft = view.dom.getBoundingClientRect().left;
    hovered = pos;
    handle.style.display = 'flex';
    handle.style.top = `${rect.top - hostRect.top + firstLineOffset(dom)}px`;
    handle.style.left = `${textLeft - hostRect.left - HANDLE_SIZE - HANDLE_GAP}px`;
  };

  // ---- measuring ----

  /**
   * Every top-level block, in document order, with the rectangle it occupies
   * right now. Positions come from `nodeDOM` rather than `view.dom.children`
   * so that anything the editor draws between the blocks — a drop cursor, a
   * collaborator's widget — is never mistaken for one.
   */
  const measure = () => {
    const { doc } = view.state;
    const blocks = [];
    let pos = 0;
    for (let i = 0; i < doc.childCount; i++) {
      const node = doc.child(i);
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return null;
      const rect = dom.getBoundingClientRect();
      blocks.push({
        index: i,
        pos,
        dom,
        id: node.attrs?.blockId ?? null,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
      });
      pos += node.nodeSize;
    }
    return blocks;
  };

  /**
   * Where every block is drawn, keyed by block id.
   *
   * Keyed by id and not by element because the drop is a real transaction:
   * ProseMirror is free to rebuild the DOM for the node that moved, and an
   * element captured beforehand may not be in the document afterwards. A block
   * with no id — a node type BlockId does not stamp — simply does not animate.
   */
  const captureTops = () => {
    const tops = new Map();
    for (const el of view.dom.querySelectorAll(`:scope > [${BLOCK_ID_DATA_ATTR}]`)) {
      tops.set(el.getAttribute(BLOCK_ID_DATA_ATTR), { dom: el, top: el.getBoundingClientRect().top });
    }
    return tops;
  };

  /**
   * Animate from the positions in `before` to wherever the blocks are now.
   *
   * The document is already correct by this point — the drop has been applied
   * — and only the pixels are catching up: every block starts the frame drawn
   * where the drag left it and travels to the place the new document gives it.
   * The animation holds nothing when it ends, so the blocks are simply where
   * the layout puts them once it is over.
   */
  const settle = (before) => {
    if (!before || reduceMotion()) return;
    for (const el of view.dom.querySelectorAll(`:scope > [${BLOCK_ID_DATA_ATTR}]`)) {
      const was = before.get(el.getAttribute(BLOCK_ID_DATA_ATTR));
      if (was == null) continue;
      const dy = was.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0px)' }],
        { duration: SETTLE_MS, easing: EASE }
      );
    }
  };

  // ---- the drag ----

  /**
   * The element drawing a block, looked up fresh.
   *
   * Never cached across a frame. y-prosemirror rebuilds every top-level element
   * when an update arrives from the CRDT — including one that leaves the
   * document exactly as it was, which no amount of comparing documents will
   * catch — and a drag holding the elements it measured would then be painting
   * a preview onto elements no longer in the page. Positions survive that;
   * elements do not.
   */
  const domOf = (block) => {
    const dom = view.nodeDOM(block.pos);
    if (dom instanceof HTMLElement) block.dom = dom;
    return block.dom;
  };

  /**
   * Mark the block being carried, or clear the mark.
   *
   * Carried in plugin state, by block id, so that the editor draws the class
   * itself and so that the mark follows the block through anything that
   * happens to the document while it is in the air. Never part of the undo
   * history: which block is held is not an edit.
   */
  const setLifted = (id) => {
    if (blockDragPluginKey.getState(view.state)?.lifted === id) return;
    view.dispatch(view.state.tr.setMeta(blockDragPluginKey, id).setMeta('addToHistory', false));
  };

  /**
   * Put one block where the drag says it belongs.
   *
   * Nothing happens when it is already there, so a pointer moving inside one
   * slot animates the block it is carrying and leaves the rest alone. A block
   * whose element has just been rebuilt is put in place without animating: the
   * new element starts at nothing, and sliding it in from nothing would read as
   * a jump.
   */
  const place = (block, dom, dy, duration) => {
    const replaced = block.animOn !== dom;
    if (!replaced && block.dy === dy) return;
    block.anim?.cancel();
    block.anim = glide(dom, replaced ? dy : (block.dy ?? 0), dy, replaced ? 0 : duration);
    block.animOn = dom;
    block.dy = dy;
  };

  const paint = () => {
    if (!drag?.started) return;
    const { blocks, from, to, advance } = drag;
    const slide = reduceMotion() ? 0 : SLIDE_MS;
    // The dragged block follows the pointer with no easing at all — easing
    // something that is already tracking a finger only makes it lag.
    const offset = drag.y - drag.startY + (drag.scrolled ?? 0);
    for (const block of blocks) {
      const dom = domOf(block);
      if (!dom) continue;
      if (block.index === from) place(block, dom, offset, 0);
      else place(block, dom, shiftFor(block.index, from, to, advance), slide);
    }
    // The handle rides along, so the grip stays under the finger holding it.
    // It is ours rather than ProseMirror's, so a plain style is safe here.
    handle.style.transform = `translateY(${offset}px)`;
  };

  /**
   * Take the measurements again after the document changed underneath.
   *
   * Someone else typing in the paragraph above moves every block below it, and
   * a drag that kept its original measurements would drop the block in the
   * wrong place — so the drag follows the document rather than giving up on it.
   * The block being carried is found by its id, which is what block ids are
   * for; only a block that has actually gone is a reason to abandon the drag.
   *
   * Measuring means reading layout, and layout has the preview on it, so the
   * animations holding it come off for the read. `paint` puts them straight
   * back — the two happen in one task, so nothing is drawn in between.
   */
  const remeasure = () => {
    const id = drag.blocks[drag.from]?.id;
    for (const block of drag.blocks) {
      block.anim?.cancel();
      block.anim = null;
      block.animOn = null;
      block.dy = 0;
    }
    const blocks = measure();
    if (!blocks || blocks.length < 2) return false;
    const from = id ? blocks.findIndex((block) => block.id === id) : -1;
    if (from < 0) return false;
    drag.blocks = blocks;
    drag.from = from;
    drag.advance = slotAdvance(blocks, from);
    return true;
  };

  const retarget = () => {
    if (!drag?.started) return;
    const to = dropIndex(drag.blocks, drag.from, drag.y);
    if (to !== drag.to) drag.to = to;
    paint();
  };

  /** Scrolls the page while a block is held against the top or bottom edge. */
  const autoscroll = () => {
    if (!drag?.started) return;
    const box = drag.scroller;
    const rect = box
      ? box.getBoundingClientRect()
      : { top: 0, bottom: innerHeight };
    let step = 0;
    if (drag.y < rect.top + EDGE) step = -Math.ceil(((rect.top + EDGE - drag.y) / EDGE) * MAX_SCROLL_STEP);
    else if (drag.y > rect.bottom - EDGE)
      step = Math.ceil(((drag.y - (rect.bottom - EDGE)) / EDGE) * MAX_SCROLL_STEP);

    if (step) {
      const before = box ? box.scrollTop : scrollY;
      if (box) box.scrollTop += step;
      else scrollBy(0, step);
      const after = box ? box.scrollTop : scrollY;
      const delta = after - before;
      if (delta) {
        // The blocks were measured in viewport coordinates, so scrolling moves
        // them all. Correct the measurements rather than re-measuring, which
        // would read the transforms currently on them.
        for (const block of drag.blocks) {
          block.top -= delta;
          block.bottom -= delta;
        }
        drag.scrolled += delta;
        retarget();
      }
    }
    drag.frame = requestAnimationFrame(autoscroll);
  };

  const beginDrag = () => {
    const blocks = measure();
    const from = blocks?.findIndex((b) => b.pos === drag.pos) ?? -1;
    if (!blocks || from < 0 || blocks.length < 2) {
      drag = null;
      return;
    }
    drag.started = true;
    drag.blocks = blocks;
    drag.from = from;
    drag.to = from;
    drag.advance = slotAdvance(blocks, from);
    drag.scrolled = 0;
    drag.scroller = scrollParent(view.dom);

    host.classList.add('is-block-dragging');
    document.body.classList.add('gd-block-drag-active');
    // The lifted look is a decoration rather than a class put on by hand: the
    // editor owns the attributes of its own elements, and reaches for the DOM
    // whenever anything else changes them.
    setLifted(blocks[from].id);
    drag.frame = requestAnimationFrame(autoscroll);
    retarget();
  };

  /** Take every mark of the drag off the page. Safe to call twice. */
  const clearDrag = () => {
    if (!drag) return null;
    const held = drag;
    drag = null;
    if (held.frame) cancelAnimationFrame(held.frame);
    if (held.started) {
      for (const block of held.blocks) block.anim?.cancel();
      // Anything left running on a block this drag has lost track of — an
      // element replaced by a redraw takes its animation with it, but a block
      // measured before one and forgotten after would not.
      for (const dom of view.dom.children) {
        for (const anim of dom.getAnimations?.() ?? []) anim.cancel();
      }
      setLifted(null);
      host.classList.remove('is-block-dragging');
      document.body.classList.remove('gd-block-drag-active');
      handle.style.transform = '';
    }
    return held;
  };

  const endDrag = (commit) => {
    if (!drag) return;
    const started = drag.started;
    // Captured while the preview is still running: where the blocks are drawn
    // at this instant is where the person can see them, and where the settle
    // has to start from.
    const before = started ? captureTops() : null;
    const held = clearDrag();
    if (!started) return;

    if (commit && held.to !== held.from) {
      const node = view.state.doc.child(held.from);
      moveBlockTo(view.state, view.dispatch.bind(view), held.from, held.to, {
        // The document is not scrolled to the block: it is under the pointer
        // already, and a scroll here would fight the settle.
        scroll: false,
        offset: node.isTextblock ? 0 : null,
      });
    }
    settle(before);
    // The handle's remembered position belongs to the old document.
    hide();
  };

  // ---- events ----

  const onMouseMove = (event) => {
    if (!view.editable || drag) return;
    if (handle.contains(event.target)) {
      cancelHide(); // heading for the handle, not away from the block
      return;
    }
    const pos = blockPosAt(view, event.clientX, event.clientY);
    // A miss is the gap between two blocks, or the gutter above the pad — both
    // places the pointer passes through on the way somewhere, so give it time
    // to arrive instead of hiding under it.
    if (pos == null) return scheduleHide();
    if (pos !== hovered) show(pos);
    else cancelHide();
  };

  // Leaving the wrapper entirely, not merely crossing between blocks inside it.
  const onMouseLeave = (event) => {
    if (event.relatedTarget && host.contains(event.relatedTarget)) return;
    scheduleHide();
  };

  const onHandleEnter = () => {
    onHandle = true;
    cancelHide();
  };

  const onHandleLeave = () => {
    onHandle = false;
    scheduleHide();
  };

  const onPointerDown = (event) => {
    if (!view.editable || event.button !== 0 || hovered == null) return;
    const node = view.state.doc.nodeAt(hovered);
    if (!node) return;
    // Without this the browser starts a text selection — or, on touch, a scroll
    // — the moment the finger moves.
    event.preventDefault();
    // Capture keeps the moves coming when the pointer leaves the handle, which
    // it does immediately. Not every pointer can be captured — a synthetic one,
    // a pointer the browser has already released — and a drag that only tracks
    // while the pointer is over the handle is better than no drag at all.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* tracked through the window listeners below instead */
    }
    drag = { pointerId: event.pointerId, pos: hovered, startY: event.clientY, y: event.clientY, started: false };
  };

  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    if (!drag.started) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      beginDrag();
      if (!drag) return;
    }
    retarget();
  };

  const onPointerUp = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Releasing a capture that was never taken throws, and a drop is far too
    // late to lose to housekeeping: the block would be left in the air.
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (!drag.started) {
      // A press that never travelled: select the block, which is what clicking
      // the handle has always done.
      const pos = drag.pos;
      drag = null;
      const node = view.state.doc.nodeAt(pos);
      if (node && NodeSelection.isSelectable(node)) {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      }
      return;
    }
    endDrag(true);
  };

  const onPointerCancel = () => endDrag(false);

  const onKeyDown = (event) => {
    if (drag && event.key === 'Escape') {
      event.preventDefault();
      endDrag(false);
    }
  };

  // On the wrapper rather than on view.dom: moves inside the text still arrive
  // here by bubbling, and the ones in the gutter — where the handle lives, and
  // where view.dom never sees them — arrive too.
  host.addEventListener('mousemove', onMouseMove);
  host.addEventListener('mouseleave', onMouseLeave);
  handle.addEventListener('mousemove', onMouseMove);
  handle.addEventListener('mouseenter', onHandleEnter);
  handle.addEventListener('mouseleave', onHandleLeave);
  handle.addEventListener('pointerdown', onPointerDown);
  // The moves are watched on the window, not on the handle: pointer capture
  // retargets them to the handle but they still arrive here, and when capture
  // was refused this is the only thing still tracking the pointer once it
  // leaves the grip — which it does on the first pixel.
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  return {
    update(updatedView, prevState) {
      // A drag in flight repaints itself on every update rather than waiting
      // for the pointer to move, which it need not ever do: the elements it
      // is painted on can be replaced underneath it — y-prosemirror rebuilds
      // every top-level element when an update arrives from the CRDT — and a
      // document that has changed shape needs measuring again. Only a document
      // that no longer holds the block being carried ends the drag.
      if (drag) {
        if (!drag.started) return;
        if (!prevState.doc.eq(updatedView.state.doc) && !remeasure()) endDrag(false);
        else retarget();
        return;
      }
      // The document moved under the handle — someone typing, a remote edit, an
      // undo, the drop itself — so the position it remembers may now name a
      // different block. Rather than guess where the old one went, drop the
      // handle; the next mouse move puts it back on whatever is really there.
      if (hovered == null) return;
      // Unless the pointer is on the handle right now — someone typing
      // elsewhere in a shared document must not snatch it away mid-grab.
      if (onHandle) return;
      if (!updatedView.editable || !prevState.doc.eq(updatedView.state.doc)) hide();
    },
    destroy() {
      clearDrag();
      cancelHide();
      host.removeEventListener('mousemove', onMouseMove);
      host.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      host.classList.remove('gd-block-handle-host', 'is-block-dragging');
      document.body.classList.remove('gd-block-drag-active');
      handle.remove();
    },
  };
}

/**
 * Run `move` and animate the blocks from where they were to where they end up.
 *
 * The keyboard shortcut goes through the same settle the drop does, so a block
 * nudged with Alt+Shift+Arrow slides past its neighbour rather than teleporting.
 */
function animateMove(view, move) {
  if (!view || reduceMotion()) return move();
  const before = new Map();
  for (const el of view.dom.querySelectorAll(`:scope > [${BLOCK_ID_DATA_ATTR}]`)) {
    before.set(el.getAttribute(BLOCK_ID_DATA_ATTR), el.getBoundingClientRect().top);
  }
  const result = move();
  if (!result) return result;

  for (const el of view.dom.querySelectorAll(`:scope > [${BLOCK_ID_DATA_ATTR}]`)) {
    const was = before.get(el.getAttribute(BLOCK_ID_DATA_ATTR));
    if (was == null) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0px)' }], {
      duration: SETTLE_MS,
      easing: EASE,
    });
  }
  return result;
}

export const BlockDrag = Extension.create({
  name: 'blockDrag',

  addCommands() {
    return {
      // Exposed as commands so anything else that wants to reorder — a menu, a
      // future vim mapping — goes through the same code the keys do.
      moveBlockUp:
        () =>
        ({ state, dispatch }) =>
          moveBlockBy(state, dispatch, -1),
      moveBlockDown:
        () =>
        ({ state, dispatch }) =>
          moveBlockBy(state, dispatch, 1),
    };
  },

  addKeyboardShortcuts() {
    // Alt+Shift rather than Mod+Shift: on macOS Cmd+Shift+Arrow is
    // select-to-end-of-document, and taking that away from a text editor would
    // be a worse trade than the reorder is worth.
    return {
      'Alt-Shift-ArrowUp': () =>
        animateMove(this.editor.view, () => this.editor.commands.moveBlockUp()),
      'Alt-Shift-ArrowDown': () =>
        animateMove(this.editor.view, () => this.editor.commands.moveBlockDown()),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockDragPluginKey,
        // Which block is currently held, by block id. Plugin state rather than
        // a class put straight on the element: ProseMirror owns the attributes
        // of its own DOM and rewrites anything it did not write.
        //
        // By id and not by position because of how a remote edit arrives. Yjs
        // hands ProseMirror a step that rewrites the whole document rather than
        // the two characters someone actually typed, and mapping a position
        // through that lands wherever the step's arithmetic puts it — which is
        // how the lift ended up marking the first block in the page while the
        // fifth was the one being carried. An id names the block itself.
        state: {
          init: () => ({ lifted: null }),
          apply(tr, value) {
            const meta = tr.getMeta(blockDragPluginKey);
            return meta === undefined ? value : { lifted: meta };
          },
        },
        props: {
          decorations(state) {
            const { lifted } = blockDragPluginKey.getState(state) ?? {};
            if (!lifted) return null;
            let pos = 0;
            for (let i = 0; i < state.doc.childCount; i++) {
              const node = state.doc.child(i);
              if (node.attrs?.blockId === lifted) {
                return DecorationSet.create(state.doc, [
                  Decoration.node(pos, pos + node.nodeSize, { class: 'gd-block-lifted' }),
                ]);
              }
              pos += node.nodeSize;
            }
            return null;
          },
        },
        view: handleView,
      }),
    ];
  },
});
