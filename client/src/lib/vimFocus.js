/**
 * Focus hand-off between the two halves of the app that vim users move between:
 * the page tree in the sidebar (Ctrl+H) and the document editor (Ctrl+L).
 *
 * Window events rather than props: the tree is mounted per space inside the
 * layout sidebar while the editor lives under the router, so there is no shared
 * parent to hang a ref off without threading it through everything in between.
 */
const TREE = 'vim-focus-tree';
const EDITOR = 'vim-focus-editor';
const SAVE = 'vim-command-save';

export const focusFileTree = () => window.dispatchEvent(new CustomEvent(TREE));
export const focusEditor = () => window.dispatchEvent(new CustomEvent(EDITOR));
/** `:w` from the editor's command line. */
export const requestSave = () => window.dispatchEvent(new CustomEvent(SAVE));

const listen = (name, fn) => {
  window.addEventListener(name, fn);
  return () => window.removeEventListener(name, fn);
};

export const onFocusFileTree = (fn) => listen(TREE, fn);
export const onFocusEditor = (fn) => listen(EDITOR, fn);
export const onRequestSave = (fn) => listen(SAVE, fn);
