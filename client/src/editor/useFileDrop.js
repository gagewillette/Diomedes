import { useEffect, useRef, useState } from 'react';

/** Drags carrying real files — the only ones we take over from the browser. */
const dragHasFiles = (dt) => Array.from(dt?.types || []).includes('Files');

/**
 * Where a dropped file should land.
 *
 * `posAtCoords` returns null whenever the pointer is outside the text flow —
 * the editor's padding, the gap under the last block, the margin beside it —
 * so fall back to the nearest position in the text column instead of giving up.
 */
function dropPos(view, event) {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (at) return at.pos;

  const rect = view.dom.getBoundingClientRect();
  if (event.clientY <= rect.top) return 0;
  if (event.clientY >= rect.bottom) return view.state.doc.content.size;

  // Beside the text column: take the position on the same line, mid-column.
  const beside = view.posAtCoords({ left: rect.left + rect.width / 2, top: event.clientY });
  return beside ? beside.pos : view.state.doc.content.size;
}

/**
 * Owns every file drop on the editor, in the capture phase, before ProseMirror
 * or the browser can act on it.
 *
 * ProseMirror only handles a drop that lands on its own DOM *and* resolves to a
 * document position. Anything else falls through: to Chrome, which navigates
 * away to the dropped PDF, or to ProseMirror's clipboard parser, which turns
 * the drag's `file://` URI into a link that leads nowhere. Catching the event
 * up here means a dropped document always becomes a document card.
 *
 * Returns `{ ref, isOver }` — put `ref` on the editor wrapper.
 */
export function useFileDrop({ editor, enabled, onFiles, onBlocked }) {
  const [isOver, setIsOver] = useState(false);
  const ref = useRef(null);
  // dragenter/dragleave fire once per child element crossed, so count depth
  // rather than clearing the highlight on the first dragleave.
  const depth = useRef(0);

  // The listeners are bound once; reach the current props through a ref.
  const latest = useRef({ editor, enabled, onFiles, onBlocked });
  latest.current = { editor, enabled, onFiles, onBlocked };

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const clear = () => {
      depth.current = 0;
      setIsOver(false);
    };

    const onDragEnter = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      if (latest.current.enabled) setIsOver(true);
    };

    const onDragOver = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      // Without this the drop never fires and the browser opens the file.
      event.preventDefault();
      event.dataTransfer.dropEffect = latest.current.enabled ? 'copy' : 'none';
    };

    const onDragLeave = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      depth.current -= 1;
      if (depth.current <= 0) clear();
    };

    const onDrop = (event) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      // Stops both the browser's default and ProseMirror's own drop handler.
      event.preventDefault();
      event.stopPropagation();
      clear();

      const { editor: ed, enabled: on, onFiles: handle, onBlocked: blocked } = latest.current;
      const files = Array.from(event.dataTransfer.files || []);
      if (!files.length) return;
      // Still swallow the drop when uploads are off — letting it through would
      // hand the file to the browser, which navigates away from the page.
      if (!on || !ed) {
        blocked?.(files);
        return;
      }
      handle(files, dropPos(ed.view, event));
    };

    el.addEventListener('dragenter', onDragEnter, true);
    el.addEventListener('dragover', onDragOver, true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop', onDrop, true);
    return () => {
      el.removeEventListener('dragenter', onDragEnter, true);
      el.removeEventListener('dragover', onDragOver, true);
      el.removeEventListener('dragleave', onDragLeave, true);
      el.removeEventListener('drop', onDrop, true);
    };
  }, []);

  return { ref, isOver };
}
