// Picking a block up and putting it somewhere else.
//
// Every top-level node already has a name (client/src/editor/blockId.js) and a
// sort key in `page_blocks` (server/src/lib/orderKey.js). Reordering was the
// one thing the person editing the page still could not do with either: the
// only way to move a paragraph was cut-and-paste, which is fiddly and — before
// block ids — read to everything downstream as a deletion plus an unrelated
// insertion.
//
// ---- Why the drag is ProseMirror's and not ours ----
//
// The handle does not compute a drop position, move a node, or write an order
// key. All it does is put the block under the pointer into a NodeSelection and
// hand ProseMirror a `view.dragging` slice with `move: true`. From there the
// editor's own drop machinery runs: the drop cursor (StarterKit's Dropcursor)
// draws where the block would land, and the drop applies *one* transaction that
// deletes the source and inserts the slice.
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
 * Move the block holding the selection one slot up or down.
 *
 * Written as a plain state/dispatch command so it can be tested without a DOM,
 * and so the keyboard shortcut and the handle share one definition of what
 * "move this block" means. Returns false — leaving the key to whatever else
 * wants it — when there is nowhere to move to.
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

  if (!dispatch) return true;

  const node = doc.child(index);
  const from = posOfChild(doc, index);
  const offset = selection.from - from; // where the cursor sat inside the block
  const tr = state.tr.delete(from, from + node.nodeSize);
  const to = posOfChild(tr.doc, target);
  tr.insert(to, node);
  tr.setSelection(
    selection instanceof NodeSelection
      ? NodeSelection.create(tr.doc, to)
      : TextSelection.near(tr.doc.resolve(Math.min(to + offset, tr.doc.content.size)))
  );
  dispatch(tr.scrollIntoView());
  return true;
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
  el.setAttribute('draggable', 'true');
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
 * The hover handle.
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
    if (!onHandle) hideNow();
  });

  const cancelHide = hider.cancel;

  const hide = () => {
    hider.cancel();
    hideNow();
  };

  const scheduleHide = () => {
    if (hovered == null || onHandle) return;
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

  const onMouseMove = (event) => {
    if (!view.editable || view.dragging) return;
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

  // Selecting on mousedown rather than on click: by the time a click fires the
  // drag has already had to decide what it is moving.
  const onMouseDown = () => {
    if (hovered == null) return;
    const { state } = view;
    const node = state.doc.nodeAt(hovered);
    if (!node || !NodeSelection.isSelectable(node)) return;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, hovered)));
  };

  const onDragStart = (event) => {
    if (hovered == null || !view.editable) return;
    const { state } = view;
    const node = state.doc.nodeAt(hovered);
    if (!node || !NodeSelection.isSelectable(node)) return;

    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, hovered)));
    const slice = view.state.selection.content();

    // The slice is what ProseMirror actually drops. The dataTransfer payload
    // only exists so the browser will start a drag at all, and so dropping the
    // block into another application yields something sensible.
    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = 'copyMove';
    const serialized = view.serializeForClipboard?.(slice);
    if (serialized) event.dataTransfer.setData('text/html', serialized.dom.innerHTML);
    event.dataTransfer.setData('text/plain', node.textContent || ' ');
    const dom = view.nodeDOM(hovered);
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);

    // `move: true` is what makes the drop delete the source in the same
    // transaction as the insert.
    view.dragging = { slice, move: true };
    host.classList.add('is-block-dragging');
  };

  const onDragEnd = () => {
    onHandle = false;
    host.classList.remove('is-block-dragging');
    // The drag started on the handle, which is a sibling of view.dom rather
    // than a child of it, so ProseMirror's own dragstart/dragend handlers never
    // saw it. Only a drop *inside* the editor clears `view.dragging`; a drag
    // abandoned anywhere else — Escape, a drop on the sidebar, a drop in
    // another window — would leave it set for good, and onMouseMove reads it as
    // "a drag is still running" and stops showing the handle at all. Clearing
    // it here is safe: dragend fires after the drop, so a real drop has already
    // taken the slice.
    view.dragging = null;
    hide();
  };

  // On the wrapper rather than on view.dom: moves inside the text still arrive
  // here by bubbling, and the ones in the gutter — where the handle lives, and
  // where view.dom never sees them — arrive too.
  host.addEventListener('mousemove', onMouseMove);
  host.addEventListener('mouseleave', onMouseLeave);
  handle.addEventListener('mousemove', onMouseMove);
  handle.addEventListener('mouseenter', onHandleEnter);
  handle.addEventListener('mouseleave', onHandleLeave);
  handle.addEventListener('mousedown', onMouseDown);
  handle.addEventListener('dragstart', onDragStart);
  handle.addEventListener('dragend', onDragEnd);

  return {
    update(updatedView, prevState) {
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
      cancelHide();
      host.removeEventListener('mousemove', onMouseMove);
      host.removeEventListener('mouseleave', onMouseLeave);
      host.classList.remove('gd-block-handle-host', 'is-block-dragging');
      handle.remove();
    },
  };
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
      'Alt-Shift-ArrowUp': () => this.editor.commands.moveBlockUp(),
      'Alt-Shift-ArrowDown': () => this.editor.commands.moveBlockDown(),
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({ key: blockDragPluginKey, view: handleView })];
  },
});
