import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findRanges, wrapIndex } from '../lib/findText.js';

export const findPluginKey = new PluginKey('findInPage');

const EMPTY = {
  query: '',
  regex: false,
  caseSensitive: false,
  matches: [],
  active: -1,
  error: null,
  truncated: false,
};

function locate(doc, state) {
  const { ranges, error, truncated } = findRanges(doc, state.query, state);
  return { ...state, matches: ranges, error, truncated };
}

function decorate(state) {
  if (!state.matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    state.doc,
    state.matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === state.active ? 'gd-find-match gd-find-match-active' : 'gd-find-match',
      }),
    ),
  );
}

export const FindInPage = Extension.create({
  name: 'findInPage',

  addCommands() {
    return {
      // Set (or clear) the query and recompute matches, keeping the active
      // match near where the cursor already is.
      setFindQuery:
        (payload) =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findPluginKey, { type: 'query', payload }));
          return true;
        },
      // step: +1 next, -1 previous
      stepFindMatch:
        (step) =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findPluginKey, { type: 'step', step }));
          return true;
        },
      clearFind:
        () =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findPluginKey, { type: 'clear' }));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: findPluginKey,
        state: {
          init: () => ({ ...EMPTY, decorations: DecorationSet.empty }),
          apply(tr, value, oldState, newState) {
            const meta = tr.getMeta(findPluginKey);

            if (meta?.type === 'clear') {
              return { ...EMPTY, decorations: DecorationSet.empty };
            }

            if (meta?.type === 'query') {
              const next = locate(newState.doc, { ...EMPTY, ...value, ...meta.payload });
              // Jump to the first match at or after the caret so find picks up
              // where the reader is looking, not at the top of the page.
              const caret = newState.selection.from;
              const at = next.matches.findIndex((m) => m.to >= caret);
              next.active = next.matches.length ? (at === -1 ? 0 : at) : -1;
              return { ...next, decorations: decorate({ ...next, doc: newState.doc }) };
            }

            if (meta?.type === 'step') {
              if (!value.matches.length) return value;
              const active = wrapIndex(value.active + meta.step, value.matches.length);
              const next = { ...value, active };
              return { ...next, decorations: decorate({ ...next, doc: newState.doc }) };
            }

            if (!value.query) return value;

            if (tr.docChanged) {
              // Re-run the search against the edited document; positions from the
              // old doc would drift as soon as text is inserted before a match.
              const next = locate(newState.doc, value);
              next.active = next.matches.length ? Math.min(Math.max(value.active, 0), next.matches.length - 1) : -1;
              return { ...next, decorations: decorate({ ...next, doc: newState.doc }) };
            }

            return value;
          },
        },
        props: {
          decorations(state) {
            return findPluginKey.getState(state)?.decorations || DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/** Read the current find state off an editor, for UI. */
export function getFindState(editor) {
  if (!editor) return EMPTY;
  return findPluginKey.getState(editor.state) || EMPTY;
}
