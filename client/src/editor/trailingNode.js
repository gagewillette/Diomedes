// Somewhere to put the caret after a block you cannot type in.
//
// An atom block — a diagram, an image, a divider, an uploaded document — has no
// text position inside it and none after it either. When one of those is the
// last thing in the document there is literally nowhere left to click: the
// gapcursor draws a bar under the block, but the bar is not a text selection,
// and the page reads as frozen. That is the "cursor stuck under the diagram"
// report.
//
// The fix is the one every block editor lands on: the document always ends in
// an empty paragraph. The plugin below appends one whenever the last block is a
// thing you cannot type in, so the trap cannot form in the first place.
//
// Two wrinkles specific to this schema:
//
//   * the footnote apparatus is pinned to the end by `block+ footnotes?`, so
//     the paragraph belongs *before* it, not after,
//   * a remote Yjs update must not be answered with a local structural edit —
//     every connected browser would race to append the same paragraph. Same
//     rule, and the same reason, as blockId.js.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';

export const FOOTNOTES_TYPE = 'footnotes';

// Types that swallow the caret when they sit last. Atoms have no interior at
// all; a table has one, but its cell coordinates are not reachable by pressing
// Down from the last row, which is the same dead end from the reader's side.
const CAGEY_TYPES = new Set(['table']);

const isCagey = (node) => !!node && (node.isAtom || CAGEY_TYPES.has(node.type.name));

/**
 * Position where a trailing paragraph should be inserted, or `null` if the
 * document already ends somewhere the caret can live.
 *
 * Split out from the plugin so it can be tested against a plain document
 * without standing up an editor.
 */
export function trailingParagraphPos(doc, footnotesType = FOOTNOTES_TYPE) {
  const count = doc.childCount;
  if (!count) return null; // an empty doc is filled by the schema, not by us

  const last = doc.child(count - 1);
  // The apparatus is chrome hung off the end of the document; the block the
  // author is actually writing after is the one before it.
  const hasFootnotes = last.type.name === footnotesType;
  const insertAt = hasFootnotes ? doc.content.size - last.nodeSize : doc.content.size;
  const body = hasFootnotes ? (count > 1 ? doc.child(count - 2) : null) : last;

  // A document that is nothing but footnotes still needs a line to type on.
  if (!body) return insertAt;
  return isCagey(body) ? insertAt : null;
}

const trailingNodePluginKey = new PluginKey('trailingNode');

export const TrailingNode = Extension.create({
  name: 'trailingNode',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: trailingNodePluginKey,
        appendTransaction: (transactions, oldState, newState) => {
          if (!this.editor.isEditable) return null;
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta(ySyncPluginKey) || tr.getMeta(trailingNodePluginKey))) {
            return null;
          }
          const pos = trailingParagraphPos(newState.doc);
          if (pos == null) return null;
          const paragraph = newState.schema.nodes.paragraph;
          if (!paragraph) return null;
          const tr = newState.tr.insert(pos, paragraph.create());
          // Undo should take back what the author did, not peel the safety
          // paragraph off first and leave them stuck again.
          tr.setMeta('addToHistory', false);
          tr.setMeta(trailingNodePluginKey, true);
          return tr;
        },
      }),
    ];
  },
});
