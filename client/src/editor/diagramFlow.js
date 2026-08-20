// What happens to the caret once a diagram is done with it.
//
// A diagram is an atom: the schema gives it no interior, so there is no
// position inside one where text could land, and after the editor modal closes
// `editor.commands.focus()` restores whatever selection was there before —
// which is the diagram node itself. The author is left holding a selected
// picture with no line to type on, which is what "the cursor gets stuck under
// the diagram" describes from the other side.
//
// So creating or saving a diagram ends the same way pressing Enter does: on an
// empty paragraph directly below it.

/**
 * Where the caret should go after the block at `pos`.
 *
 * Returns `{ pos, insert }` — `pos` is the position just after the block, and
 * `insert` says whether a paragraph has to be made there first. An empty
 * textblock that is already sitting below the diagram is reused, so hitting
 * Save twice in a row does not stack up blank lines.
 *
 * `null` means the position is not addressable (a stale `getPos`, usually) and
 * the caller should leave the selection alone.
 */
export function caretTargetAfterBlock(doc, pos) {
  if (typeof pos !== 'number' || pos < 0 || pos > doc.content.size) return null;
  let $pos;
  try {
    $pos = doc.resolve(pos);
  } catch {
    return null;
  }
  const node = $pos.nodeAfter;
  if (!node) return null;
  const end = pos + node.nodeSize;
  let $end;
  try {
    $end = doc.resolve(end);
  } catch {
    return null;
  }
  const next = $end.nodeAfter;
  const reusable = next && next.isTextblock && next.content.size === 0;
  return { pos: end, insert: !reusable };
}

/**
 * Select the diagram block itself, so ⌘C / ⌘X act on the whole thing.
 *
 * The preview is rendered inside a `contenteditable="false"` node view, so a
 * click on it never becomes a ProseMirror text selection on its own — without
 * this there is no gesture that puts a diagram on the clipboard.
 */
export function selectDiagramNode(editor, getPos) {
  if (!editor || typeof getPos !== 'function') return false;
  const pos = getPos();
  if (typeof pos !== 'number') return false;
  return editor.chain().focus().setNodeSelection(pos).run();
}

/**
 * Put the caret on an empty block below the diagram at `getPos()`.
 *
 * Called on save and on insert. Deliberately not called on cancel: backing out
 * of the editor should leave the document exactly as it was.
 */
export function focusBelowDiagram(editor, getPos) {
  if (!editor || typeof getPos !== 'function') return false;
  const pos = getPos();
  const target = caretTargetAfterBlock(editor.state.doc, pos);
  if (!target) {
    editor.commands.focus();
    return false;
  }
  if (target.insert) {
    // insertContentAt places the selection inside what it inserted, which is
    // exactly the empty paragraph we want the author on.
    editor.chain().focus().insertContentAt(target.pos, { type: 'paragraph' }).run();
  } else {
    editor.chain().focus().setTextSelection(target.pos + 1).run();
  }
  return true;
}
