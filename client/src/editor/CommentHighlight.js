// The commented text, painted.
//
// Same choice SectionRef.js makes, for the same reason: decorations, not marks.
// The document is never touched, so an anchored comment costs nothing in
// `getJSON()`, nothing in the markdown export, nothing in the CRDT — and a
// reader, who cannot write to the document at all, gets the highlights and can
// create them. See lib/commentAnchor.js for why the anchor lives on the comment
// row rather than in the text.
//
// The plugin holds the comment list rather than reading it from React on every
// keystroke: resolving anchors walks the document, so it is done when the list
// or the document changes and at no other time.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { resolveAll } from '../lib/commentAnchor.js';
import { scrollToElement } from '../lib/scrollTo.js';

export const commentHighlightKey = new PluginKey('commentHighlight');

export const COMMENT_ID_ATTR = 'data-comment-id';

/**
 * Draw already-resolved anchors.
 *
 * Resolved anchors only: a comment whose text has been deleted has nowhere to
 * be drawn, and the panel says so in words instead.
 */
function decorate(doc, resolved, activeId) {
  const decorations = [];

  for (const entry of resolved) {
    if (!entry.range) continue;
    decorations.push(
      Decoration.inline(entry.range.from, entry.range.to, {
        // A distinct class rather than a modifier on the resting one, so the
        // active highlight can be a different colour entirely without having to
        // out-specify the base rule.
        class: entry.id === activeId ? 'gd-comment-mark gd-comment-mark--active' : 'gd-comment-mark',
        [COMMENT_ID_ATTR]: entry.id,
        // The looser match is still worth drawing — the words are right even
        // though the block they were taken from is gone — but not worth
        // claiming as certain, so it is drawn more faintly.
        ...(entry.range.exact ? {} : { 'data-comment-approximate': 'true' }),
      }),
    );
  }

  return { resolved, decorations: DecorationSet.create(doc, decorations) };
}

/**
 * Resolve every anchor against a document and draw the result.
 *
 * This is the expensive path — it walks the document once per comment — so the
 * plugin below runs it only when the document or the comment list changes.
 * Exported for tests.
 */
export function buildCommentDecorations(doc, comments, activeId) {
  return decorate(doc, resolveAll(doc, comments), activeId);
}

const emptyState = (doc) => ({
  comments: [],
  activeId: null,
  resolved: [],
  decorations: DecorationSet.empty,
  doc,
});

/** Hand the editor the current comment list. Cheap when nothing changed. */
export function setComments(editor, comments) {
  const view = editor?.view;
  if (!view) return;
  const current = commentHighlightKey.getState(view.state)?.comments;
  if (current === comments) return;
  view.dispatch(view.state.tr.setMeta(commentHighlightKey, { comments }));
}

/** Light one comment's text up, or clear the highlight with null. */
export function setActiveComment(editor, activeId) {
  const view = editor?.view;
  if (!view) return;
  if (commentHighlightKey.getState(view.state)?.activeId === activeId) return;
  view.dispatch(view.state.tr.setMeta(commentHighlightKey, { activeId }));
}

/** Where a comment's text currently sits, or null if it no longer resolves. */
export function rangeOfComment(editor, commentId) {
  const state = editor?.view && commentHighlightKey.getState(editor.view.state);
  return state?.resolved.find((entry) => entry.id === commentId)?.range ?? null;
}

/**
 * Scroll the editor to a comment's text and leave it highlighted.
 *
 * The selection is deliberately not moved. Hovering a comment in the sidebar is
 * a look, not an edit: stealing the caret would lose the author's place in a
 * document they may be halfway through typing into, and in a collaborative
 * session it would broadcast a selection to everyone else as well.
 *
 * Answers false when the comment's text is no longer in the document, which is
 * what the panel turns into "original text was removed".
 */
export function scrollToComment(editor, commentId) {
  const view = editor?.view;
  if (!view) return false;
  const range = rangeOfComment(editor, commentId);
  if (!range) return false;

  setActiveComment(editor, commentId);

  // The highlight itself is the flash, and it stays up for as long as the
  // pointer is on the comment — so `scrollToElement`'s own flash would be a
  // second, competing signal, and its focus call would take the caret.
  const el = elementAt(view, range.from);
  if (el) scrollToElement(el, { flash: false, focus: false });
  return true;
}

/** The element to scroll to for a document position. */
function elementAt(view, pos) {
  try {
    const { node } = view.domAtPos(pos);
    const el = node?.nodeType === 3 ? node.parentElement : node;
    // Prefer the highlight span itself — it is the thing the reader is being
    // sent to look at, and scrolling to the whole paragraph can leave it off
    // the bottom of the screen in a long block.
    return el?.closest?.(`[${COMMENT_ID_ATTR}]`) || el || null;
  } catch {
    // A position that no longer maps to the DOM — mid-render, or a node view
    // that draws no text. Not worth failing the jump over.
    return null;
  }
}

export const CommentHighlight = Extension.create({
  name: 'commentHighlight',

  addOptions() {
    return { onActivate: null, onResolved: null };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin({
        key: commentHighlightKey,

        state: {
          init: (_config, state) => emptyState(state.doc),
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(commentHighlightKey);
            const comments = meta && 'comments' in meta ? meta.comments : value.comments;
            const activeId = meta && 'activeId' in meta ? meta.activeId : value.activeId;

            // Only the active id changed and the document stands still: the
            // spans are in the right places already, so re-flag them rather
            // than resolving every anchor again.
            if (!tr.docChanged && comments === value.comments) {
              if (activeId === value.activeId) return value;
              return { ...value, activeId, ...decorate(newState.doc, value.resolved, activeId) };
            }

            return { comments, activeId, ...buildCommentDecorations(newState.doc, comments, activeId), doc: newState.doc };
          },
        },

        // Which comments could actually be found in the document, reported
        // upward as it changes.
        //
        // The panel needs this to tell "hover me to see the text" from "the text
        // this was about is gone", and it cannot read it off the plugin while
        // rendering: the comment list reaches the plugin from a React effect,
        // which runs *after* the render that would have read it. A panel that
        // asked directly would show every freshly-loaded comment as orphaned
        // until something unrelated re-rendered it.
        view() {
          let reported = null;

          const report = (state) => {
            const resolved = commentHighlightKey.getState(state)?.resolved ?? [];
            const found = resolved.filter((entry) => entry.range).map((entry) => entry.id);
            const key = found.join(',');
            if (key === reported) return;
            reported = key;
            // Out of the dispatch. Calling straight through would mean a React
            // setState in the middle of ProseMirror's update — and at editor
            // creation, in the middle of someone else's render.
            queueMicrotask(() => options.onResolved?.(new Set(found)));
          };

          return {
            update: (view) => report(view.state),
          };
        },

        props: {
          decorations: (state) => commentHighlightKey.getState(state)?.decorations,

          handleDOMEvents: {
            // Clicking commented text is the other half of the sidebar hover:
            // from the text you find the comment, from the comment you find the
            // text. It never claims the event — the caret still lands where it
            // was clicked, because the author may well be editing that sentence.
            mousedown(view, event) {
              if (!options.onActivate) return false;
              const from = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
              const el = from?.closest?.(`[${COMMENT_ID_ATTR}]`);
              if (!el || !view.dom.contains(el)) return false;
              options.onActivate(el.getAttribute(COMMENT_ID_ATTR));
              return false;
            },
          },
        },
      }),
    ];
  },
});
