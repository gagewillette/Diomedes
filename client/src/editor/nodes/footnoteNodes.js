// The footnote schema, the reconciler's plugin host, and the markdown round
// trip — everything that does not need React.
//
// The split is not cosmetic. `node --test` cannot load JSX, and the markdown
// round trip is the one part of this feature that genuinely has to be tested
// against a real editor rather than a bare schema. Keeping the nodes here means
// footnoteMarkdown.test.js can boot one; Footnote.jsx re-exports these with
// their node views attached, and is what the app imports.
import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, NodeSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DOMSerializer } from '@tiptap/pm/model';
import footnotePlugin from 'markdown-it-footnote';
import tippy from 'tippy.js';
import {
  FOOTNOTE,
  FOOTNOTES,
  FOOTNOTE_ID_ATTR,
  FOOTNOTE_ID_DATA_ATTR,
  FOOTNOTE_REF,
  citationCounts,
  entryTextPos,
  findEntries,
  insertFootnote,
  newFootnoteId,
  numberFootnotes,
  syncFootnotes,
} from '../footnotes.js';
import { scrollToElement } from '../../lib/scrollTo.js';

const footnotePluginKey = new PluginKey('footnotes');

const idAttribute = {
  [FOOTNOTE_ID_ATTR]: {
    default: null,
    parseHTML: (el) => el.getAttribute(FOOTNOTE_ID_DATA_ATTR),
    renderHTML: (attrs) =>
      attrs[FOOTNOTE_ID_ATTR] ? { [FOOTNOTE_ID_DATA_ATTR]: attrs[FOOTNOTE_ID_ATTR] } : {},
  },
};

const refSelector = (id) => `sup[${FOOTNOTE_ID_DATA_ATTR}="${CSS.escape(id)}"]`;
const entrySelector = (id) => `[data-footnote-entry="${CSS.escape(id)}"]`;

/* ------------------------------------------------------------------ *
 * Numbering, as decorations
 *
 * Nothing here is stored. The plugin recomputes the map on every document
 * change and hands each ref and each entry its number as a DOM attribute, and
 * CSS renders it. That is the whole reason a document can be renumbered by
 * someone else's edit without a single write of our own.
 * ------------------------------------------------------------------ */

function buildDecorations(doc) {
  const numbers = numberFootnotes(doc);
  const counts = citationCounts(doc);
  const decorations = [];

  doc.descendants((node, pos) => {
    const id = node.attrs?.[FOOTNOTE_ID_ATTR];
    if (node.type.name === FOOTNOTE_REF) {
      const number = numbers.get(id);
      if (number) {
        decorations.push(
          Decoration.node(
            pos,
            pos + node.nodeSize,
            { 'data-n': String(number), 'aria-label': `Footnote ${number}` },
            { footnote: { id, number } }
          )
        );
      }
      return false;
    }
    if (node.type.name === FOOTNOTE) {
      const number = numbers.get(id) ?? 0;
      decorations.push(
        Decoration.node(
          pos,
          pos + node.nodeSize,
          { 'data-n': String(number) },
          { footnote: { id, number, citations: counts.get(id) || 0 } }
        )
      );
    }
    return true;
  });

  return DecorationSet.create(doc, decorations);
}

/** The spec a node view's decorations carry, or an empty stand-in. */
export const footnoteSpec = (decorations) =>
  decorations?.find((d) => d.spec?.footnote)?.spec.footnote ?? { number: 0, citations: 0 };

/* ------------------------------------------------------------------ *
 * Jumping between a reference and its note
 * ------------------------------------------------------------------ */

export const jumpToEntry = (view, id) => {
  const el = view.dom.querySelector(entrySelector(id));
  if (el) scrollToElement(el);
  return Boolean(el);
};

export const jumpToRef = (view, id, index = 0) => {
  const els = view.dom.querySelectorAll(refSelector(id));
  const el = els[Math.min(index, els.length - 1)];
  if (el) scrollToElement(el);
  return Boolean(el);
};

/* ------------------------------------------------------------------ *
 * Hover preview
 *
 * The popup renders the note's real content — links, code, emphasis — rather
 * than flattened text, because the most common thing to put in a footnote is a
 * citation with a link in it, and a preview that drops the link is a preview
 * you cannot act on.
 * ------------------------------------------------------------------ */

function previewContent(view, id) {
  const entry = findEntries(view.state.doc).find((e) => e.id === id);
  if (!entry) return null;
  const wrap = document.createElement('div');
  wrap.className = 'gd-footnote-popup';
  const number = numberFootnotes(view.state.doc).get(id);
  if (number) {
    const label = document.createElement('div');
    label.className = 'gd-footnote-popup-n';
    label.textContent = String(number);
    wrap.appendChild(label);
  }
  const body = document.createElement('div');
  body.className = 'gd-footnote-popup-body';
  body.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(entry.node.content));
  wrap.appendChild(body);
  return wrap;
}

function hoverPreview(view) {
  let popup = null;
  // Which reference the open popup belongs to. `mouseover` fires again for
  // every element the pointer crosses inside the target, so without this the
  // popup would be torn down and rebuilt on each one — and the open delay,
  // which starts from scratch every time, would never elapse.
  let shownFor = null;

  const close = () => {
    popup?.destroy();
    popup = null;
    shownFor = null;
  };

  const open = (target) => {
    if (target === shownFor) return;
    const id = target.getAttribute(FOOTNOTE_ID_DATA_ATTR);
    if (!id) return;
    const content = previewContent(view, id);
    if (!content) return;
    close();
    shownFor = target;
    popup = tippy(target, {
      content,
      appendTo: () => document.body,
      // Interactive so a link inside the note can actually be clicked, and so
      // the popup survives the pointer crossing the gap to reach it.
      interactive: true,
      delay: [250, 100],
      maxWidth: 340,
      placement: 'top',
      theme: 'gd-footnote',
      showOnCreate: true,
      trigger: 'manual',
      // Flip above → below → beside rather than covering the reference.
      popperOptions: { modifiers: [{ name: 'flip', options: { fallbackPlacements: ['bottom', 'right', 'left'] } }] },
    });
  };

  const onOver = (event) => {
    const target = event.target.closest?.('.gd-footnote-ref');
    if (target) open(target);
  };
  const onOut = (event) => {
    if (!event.relatedTarget?.closest?.('.gd-footnote-ref, .tippy-box')) close();
  };
  // Keyboard focus gets the same preview a pointer does — the popup is useless
  // to anyone who cannot hover otherwise.
  const onFocus = (event) => {
    const target = event.target.closest?.('.gd-footnote-ref');
    if (target) open(target);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  view.dom.addEventListener('mouseover', onOver);
  view.dom.addEventListener('mouseout', onOut);
  view.dom.addEventListener('focusin', onFocus);
  view.dom.addEventListener('focusout', close);
  document.addEventListener('keydown', onKey);

  return {
    destroy() {
      view.dom.removeEventListener('mouseover', onOver);
      view.dom.removeEventListener('mouseout', onOut);
      view.dom.removeEventListener('focusin', onFocus);
      view.dom.removeEventListener('focusout', close);
      document.removeEventListener('keydown', onKey);
      close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

/**
 * Numbers for serialisation, counted as the walk goes.
 *
 * The serializer visits the document in order and the container is last, so by
 * the time the definitions are written every reference has been seen and the
 * two agree. Kept on the serializer state rather than derived from the editor
 * so that serialising a fragment — a copy to the clipboard — numbers from one
 * just like a whole document does.
 */
function serialNumber(state, id) {
  if (!state.gdFootnotes) state.gdFootnotes = new Map();
  if (!state.gdFootnotes.has(id)) state.gdFootnotes.set(id, state.gdFootnotes.size + 1);
  return state.gdFootnotes.get(id);
}

/**
 * Rewrite markdown-it-footnote's HTML into our own nodes.
 *
 * markdown-it emits the GitHub/Obsidian rendering — a `.footnote-ref` anchor
 * per citation and an `<ol>` of `.footnote-item` list entries — which is the
 * right *output* and the wrong *document*. We keep its parsing (it handles
 * `[^1]`, named `[^label]`, inline `^[text]` and multi-paragraph bodies) and
 * throw away its presentation, minting a real id per note as we go.
 */
function convertFootnoteHTML(element) {
  const section = element.querySelector('section.footnotes');
  if (!section) return;

  const ids = new Map();
  const idFor = (label) => {
    if (!ids.has(label)) ids.set(label, newFootnoteId());
    return ids.get(label);
  };

  const container = document.createElement('div');
  container.setAttribute('data-type', FOOTNOTES);

  for (const item of section.querySelectorAll('li.footnote-item')) {
    const id = idFor(item.id);
    // The back-arrows are rendering, not content — ours are generated.
    item.querySelectorAll('a.footnote-backref').forEach((a) => a.remove());
    const entry = document.createElement('div');
    entry.setAttribute('data-type', FOOTNOTE);
    entry.setAttribute(FOOTNOTE_ID_DATA_ATTR, id);
    entry.innerHTML = item.innerHTML.trim() || '<p></p>';
    container.appendChild(entry);
  }

  for (const sup of element.querySelectorAll('sup.footnote-ref')) {
    const href = sup.querySelector('a')?.getAttribute('href') || '';
    const label = href.replace(/^#/, '');
    // A reference with no definition is not a footnote — leave the text alone
    // rather than inventing an empty note for it.
    if (!label || !ids.has(label)) continue;
    const ref = document.createElement('sup');
    ref.setAttribute(FOOTNOTE_ID_DATA_ATTR, ids.get(label));
    sup.replaceWith(ref);
  }

  element.querySelector('hr.footnotes-sep')?.remove();
  section.replaceWith(container);
}

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

export const FootnoteRef = Node.create({
  name: FOOTNOTE_REF,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return idAttribute;
  },

  parseHTML() {
    return [{ tag: `sup[${FOOTNOTE_ID_DATA_ATTR}]` }];
  },

  // Deliberately empty: the number is a decoration, so the element carries no
  // text of its own and nothing can put a stale number into storage.
  renderHTML({ HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        class: 'gd-footnote-ref',
        role: 'doc-noteref',
        tabindex: '0',
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`[^${serialNumber(state, node.attrs[FOOTNOTE_ID_ATTR])}]`);
        },
        parse: {},
      },
    };
  },

  addInputRules() {
    return [
      // Obsidian's inline form: `^[the note]` becomes a footnote on the closing
      // bracket, with the text already in it.
      new InputRule({
        find: /\^\[([^\]]+)\]$/,
        handler: ({ state, range, match, chain }) => {
          const body = match[1];
          chain()
            .deleteRange(range)
            .command(({ tr }) => {
              const { id } = insertFootnote(tr, state.schema, tr.selection.from);
              const at = entryTextPos(tr.doc, id);
              if (at != null) tr.insertText(body, at);
              return true;
            })
            .run();
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // A selected reference is the keyboard equivalent of hovering one, so
      // Enter does what a click does.
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        if (!(selection instanceof NodeSelection) || selection.node.type.name !== FOOTNOTE_REF) return false;
        return jumpToEntry(editor.view, selection.node.attrs[FOOTNOTE_ID_ATTR]);
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: footnotePluginKey,

        state: {
          init: (_, state) => buildDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },

        props: {
          decorations(state) {
            return footnotePluginKey.getState(state);
          },
          handleClickOn(view, _pos, node) {
            if (node.type.name !== FOOTNOTE_REF) return false;
            return jumpToEntry(view, node.attrs[FOOTNOTE_ID_ATTR]);
          },
        },

        view: hoverPreview,

        // The reconciler. Skipped for remote work for the same reason blockId
        // skips it: a Yjs update has already been reconciled by the client that
        // made it, and having every browser race to tidy the same document
        // would put competing deletions into the CRDT.
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta(footnotePluginKey))) return null;
          if (transactions.some((tr) => tr.getMeta('y-sync$'))) return null;
          const tr = syncFootnotes(newState);
          if (tr) tr.setMeta(footnotePluginKey, true);
          return tr;
        },
      }),
    ];
  },
});

export const Footnote = Node.create({
  name: FOOTNOTE,
  content: 'block+',
  defining: true,
  // Keeps an edit inside one note from merging it into its neighbour, and stops
  // a selection dragged across the apparatus from swallowing several at once.
  isolating: true,

  addAttributes() {
    return idAttribute;
  },

  parseHTML() {
    return [{ tag: `div[data-type="${FOOTNOTE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': FOOTNOTE, class: 'gd-footnote' }), 0];
  },

  addCommands() {
    return {
      /** Insert a reference here and an empty note at the end, caret in the note. */
      addFootnote:
        () =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true;
          const { id } = insertFootnote(tr, state.schema, tr.selection.to);
          const at = entryTextPos(tr.doc, id);
          if (at != null) tr.setSelection(TextSelection.create(tr.doc, at));
          tr.scrollIntoView();
          return true;
        },

      /** Cite a footnote that already exists — a second marker, same number. */
      citeFootnote:
        (id) =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true;
          tr.insert(tr.selection.to, state.schema.nodes[FOOTNOTE_REF].create({ [FOOTNOTE_ID_ATTR]: id }));
          return true;
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const n = serialNumber(state, node.attrs[FOOTNOTE_ID_ATTR]);
          // Four-space continuation is what Obsidian, Pandoc and GitHub all
          // accept for a multi-paragraph note.
          state.wrapBlock('    ', `[^${n}]: `, node, () => state.renderContent(node));
        },
        parse: {},
      },
    };
  },
});

export const Footnotes = Node.create({
  name: FOOTNOTES,
  content: `${FOOTNOTE}+`,
  isolating: true,
  // No `group: 'block'` on purpose. The document's content expression is
  // `block+ footnotes?`, so leaving this out of the block group is what makes
  // the container a singleton that can only ever be last — a schema guarantee
  // rather than a rule some plugin has to keep enforcing.
  defining: true,

  parseHTML() {
    return [{ tag: `div[data-type="${FOOTNOTES}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': FOOTNOTES, class: 'gd-footnotes' }), 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          // No delimiter and no wrapper of its own — the container is an
          // implementation detail of the editor, and in markdown the
          // definitions are simply the last blocks in the document. Letting
          // the default close run keeps the blank line that separates them
          // from the prose above.
          state.renderContent(node);
        },
        parse: {
          setup(markdownit) {
            markdownit.use(footnotePlugin);
          },
          updateDOM(element) {
            convertFootnoteHTML(element);
          },
        },
      },
    };
  },
});
