import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import * as Y from 'yjs';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';

/**
 * Broadcast the local text selection from a read-only editor.
 *
 * y-prosemirror's cursor plugin only publishes the `cursor` awareness field
 * while `view.hasFocus()` is true. A read-only view is `contenteditable=false`,
 * so it never becomes the document's active element and that check never
 * passes — readers could see everyone else's highlights but broadcast none of
 * their own. Selecting text is exactly what someone without edit rights does
 * (quoting, reviewing, pointing at a sentence), so it should be visible to the
 * room whatever their permissions are.
 *
 * ProseMirror itself keeps `state.selection` in step in read-only mode: its DOM
 * observer falls back to "is the DOM selection inside this view" when the view
 * is not editable. So the selection is already there to publish; only the
 * publishing step is missing, and this plugin supplies it using the same
 * relative-position encoding the cursor plugin uses, writing the same awareness
 * field. Nothing on the receiving side needs to change.
 *
 * While the view *is* editable this plugin stays out of the way entirely and
 * lets y-prosemirror do its job.
 */
export const readonlySelectionKey = new PluginKey('gdReadonlySelection');

const CURSOR_FIELD = 'cursor';

/** Is the browser's selection anchored inside this editor's DOM? */
function selectionInsideView(view) {
  const sel = view.domSelectionRange ? view.domSelectionRange() : window.getSelection();
  const node = sel?.anchorNode;
  if (!node) return false;
  try {
    return view.dom.contains(node.nodeType === 3 ? node.parentNode : node);
  } catch {
    // Firefox throws when the anchor sits in generated content.
    return false;
  }
}

function publishSelection(view, awareness) {
  const ystate = ySyncPluginKey.getState(view.state);
  // Before the first sync there is no binding to resolve positions against.
  if (!ystate?.binding || !ystate.type) return;
  const current = awareness.getLocalState() || {};

  if (!selectionInsideView(view)) {
    // Only clear a cursor this binding owns — a position from another document
    // resolves to null and must be left alone.
    if (
      current[CURSOR_FIELD] != null &&
      relativePositionToAbsolutePosition(
        ystate.doc,
        ystate.type,
        Y.createRelativePositionFromJSON(current[CURSOR_FIELD].anchor),
        ystate.binding.mapping
      ) !== null
    ) {
      awareness.setLocalStateField(CURSOR_FIELD, null);
    }
    return;
  }

  const { anchor: from, head: to } = view.state.selection;
  const anchor = absolutePositionToRelativePosition(from, ystate.type, ystate.binding.mapping);
  const head = absolutePositionToRelativePosition(to, ystate.type, ystate.binding.mapping);
  const cursor = current[CURSOR_FIELD];
  const unchanged =
    cursor != null &&
    Y.compareRelativePositions(Y.createRelativePositionFromJSON(cursor.anchor), anchor) &&
    Y.compareRelativePositions(Y.createRelativePositionFromJSON(cursor.head), head);
  if (unchanged) return;

  awareness.setLocalStateField(CURSOR_FIELD, { anchor, head });
}

/**
 * @param {{ awareness: import('y-protocols/awareness').Awareness }} provider
 */
export function readonlySelectionPlugin(provider) {
  return new Plugin({
    key: readonlySelectionKey,
    view: (view) => {
      const awareness = provider?.awareness;
      if (!awareness) return {};

      const update = () => {
        if (view.isDestroyed || view.editable) return;
        publishSelection(view, awareness);
      };

      // A selection that moves *out* of the editor never reaches ProseMirror —
      // it stops updating state.selection once the DOM selection is elsewhere —
      // so the highlight would otherwise stay pinned to the room forever. This
      // listener only ever clears; publishing stays on the transaction path,
      // where the state is guaranteed to be current.
      const onSelectionChange = () => {
        if (view.isDestroyed || view.editable) return;
        if (!selectionInsideView(view)) publishSelection(view, awareness);
      };
      const doc = view.dom.ownerDocument;
      doc.addEventListener('selectionchange', onSelectionChange);

      return {
        update,
        destroy: () => {
          doc.removeEventListener('selectionchange', onSelectionChange);
          if (!view.editable) awareness.setLocalStateField(CURSOR_FIELD, null);
        },
      };
    },
  });
}

/**
 * TipTap wrapper. Ordered after CollaborationCursor so the sync plugin's state
 * is available by the time this one's view runs.
 */
export const ReadOnlySelection = Extension.create({
  name: 'readOnlySelection',

  addOptions() {
    return { provider: null };
  },

  addProseMirrorPlugins() {
    if (!this.options.provider) return [];
    return [readonlySelectionPlugin(this.options.provider)];
  },
});

export default ReadOnlySelection;
