/**
 * "Open the editor on the diagram I just inserted."
 *
 * That is a property of the insertion, not of the diagram, so it must not live
 * in the document. It used to: the slash command inserted the node with an
 * `autoOpen` attribute and the node view cleared it on mount. Attributes that
 * are not rendered to HTML are still part of the ProseMirror node, and so are
 * still written into the collaborative document that the server keeps — one
 * missed clear and every later mount of that node view opens the editor again,
 * for everybody, forever.
 *
 * The request lives here instead: one shot, in memory, claimed by the first
 * node view of that type to mount. The deadline only guards against a request
 * whose node view never appeared (an insert undone before it rendered) being
 * claimed by an unrelated diagram much later.
 */

const CLAIM_WINDOW_MS = 5000;

let pending = null;

/** Ask the next `type` node view to mount to open its editor. */
export function requestDiagramEditor(type, now = Date.now()) {
  pending = { type, at: now };
}

/** True once, for the first matching node view that asks in time. */
export function claimDiagramEditor(type, now = Date.now()) {
  if (!pending || pending.type !== type || now - pending.at > CLAIM_WINDOW_MS) return false;
  pending = null;
  return true;
}

/** Testing seam: drop any outstanding request. */
export function resetDiagramEditorRequest() {
  pending = null;
}
