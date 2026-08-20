import { contrastInk, withAlpha } from '../../lib/userColor.js';

/**
 * Remote text caret. Built as DOM rather than JSX because y-prosemirror inserts
 * it as a widget decoration.
 *
 * The label is only shown while the peer is typing. Leaving every name badge on
 * screen permanently is what makes a busy document unreadable; once someone
 * stops typing their name moves to their mouse pointer instead.
 *
 * The `data-peer` attribute matters: ProseMirror keys widget decorations by
 * client id and reuses the existing DOM when the key is unchanged, so this
 * builder runs *once* per peer and never sees their later mode changes. The
 * attribute is what lets syncCaretModes() find the element and update it.
 */
export function buildCaret(user, clientId) {
  const color = user?.color || '#FF2D55';
  const caret = document.createElement('span');
  caret.classList.add('gd-remote-caret');
  if (user?.mode !== 'typing') caret.classList.add('is-idle');
  caret.dataset.peer = String(clientId);
  caret.style.setProperty('--gd-peer-color', color);

  const flag = document.createElement('span');
  flag.classList.add('gd-remote-caret__flag');
  caret.appendChild(flag);

  const label = document.createElement('span');
  label.classList.add('gd-remote-caret__label');
  label.style.background = color;
  label.style.color = contrastInk(color);
  label.textContent = user?.name || 'Someone';
  caret.appendChild(label);

  return caret;
}

/**
 * Apply the current mode to already-rendered carets. See buildCaret: the widget
 * DOM outlives the awareness state that produced it.
 */
export function syncCaretModes(root, peers) {
  if (!root) return;
  for (const { clientId, user } of peers) {
    const el = root.querySelector(`.gd-remote-caret[data-peer="${clientId}"]`);
    if (el) el.classList.toggle('is-idle', user?.mode !== 'typing');
  }
}

/**
 * Remote selection. Always drawn, whatever the mode — watching someone sweep a
 * selection is exactly the "not typing but doing something" case, and the
 * highlight is what makes it legible.
 */
export function buildSelection(user) {
  const color = user?.color || '#FF2D55';
  return {
    class: 'gd-remote-selection',
    style: `background-color: ${withAlpha(color, 0.22)}; --gd-peer-color: ${color};`,
  };
}
