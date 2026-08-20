import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import { Node } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { IconPlus, IconNote } from '@tabler/icons-react';
import {
  Footnote as FootnoteBase,
  FootnoteRef,
  Footnotes as FootnotesBase,
  footnoteSpec,
  jumpToRef,
} from './footnoteNodes.js';
import { FOOTNOTE_ID_ATTR, findEntries, numberFootnotes } from '../footnotes.js';
import { makeSuggestionRender } from '../suggestionRender.js';

// The React half of footnotes: the two node views, and the `[^` picker. The
// schema, the reconciler and the markdown round trip live in footnoteNodes.js,
// which this file only decorates — see the note at the top of that module.

const footnoteSuggestionKey = new PluginKey('footnoteSuggestion');

function FootnoteEntryView({ node, editor, decorations }) {
  const { citations } = footnoteSpec(decorations);
  const id = node.attrs[FOOTNOTE_ID_ATTR];
  // One arrow per citation, the way Wikipedia and GitHub do it: with the note
  // cited twice, a single arrow would silently pick one and strand the other.
  const backrefs = Array.from({ length: Math.max(citations, 1) });

  return (
    <NodeViewWrapper
      className="gd-footnote"
      data-footnote-entry={id}
      role="doc-footnote"
      tabIndex={-1}
    >
      <div className="gd-footnote-gutter" contentEditable={false}>
        <span className="gd-footnote-n" aria-hidden="true" />
        {backrefs.map((_, i) => (
          <button
            key={i}
            type="button"
            className="gd-footnote-backref"
            aria-label={citations > 1 ? `Back to citation ${i + 1}` : 'Back to the reference'}
            onClick={() => jumpToRef(editor.view, id, i)}
          >
            ↩{citations > 1 ? <sub>{i + 1}</sub> : null}
          </button>
        ))}
      </div>
      <NodeViewContent className="gd-footnote-body" />
    </NodeViewWrapper>
  );
}

export const Footnote = FootnoteBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(FootnoteEntryView);
  },
});

function FootnotesView() {
  return (
    <NodeViewWrapper className="gd-footnotes" role="doc-endnotes">
      <div className="gd-footnotes-head" contentEditable={false}>
        Footnotes
      </div>
      <NodeViewContent className="gd-footnotes-list" />
    </NodeViewWrapper>
  );
}

export const Footnotes = FootnotesBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(FootnotesView);
  },
});

/* ------------------------------------------------------------------ *
 * The `[^` picker
 * ------------------------------------------------------------------ */

const FootnotePickerList = forwardRef(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') { setSelected((s) => (s + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setSelected((s) => (s - 1 + items.length) % items.length); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (items[selected]) command(items[selected]);
        return true;
      }
      return false;
    },
  }));

  if (!items.length) return null;
  return (
    <div className="gd-slash-menu">
      {items.map((item, i) => (
        <button
          key={item.id || 'new'}
          className={`gd-slash-item ${i === selected ? 'is-selected' : ''}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
        >
          {item.isNew ? <IconPlus size={15} /> : <IconNote size={15} />}
          <span>
            <b>{item.isNew ? 'New footnote' : `Footnote ${item.number}`}</b>
            <small>{item.isNew ? 'Write a new note at the bottom' : item.preview}</small>
          </span>
        </button>
      ))}
    </div>
  );
});
FootnotePickerList.displayName = 'FootnotePickerList';

// `[^` is two characters, so the stock matcher — which builds a character class
// from the trigger — cannot express it. Same approach as PageLink's `[[`.
function findFootnoteMatch({ $position }) {
  if (!$position.depth || !$position.parent.isTextblock) return null;
  const before = $position.parent.textBetween(0, $position.parentOffset, undefined, '￼');
  const start = before.lastIndexOf('[^');
  if (start === -1) return null;
  const query = before.slice(start + 2);
  if (/[[\]\n￼]/.test(query) || query.length > 80) return null;
  const from = $position.start() + start;
  return { range: { from, to: $position.start() + $position.parentOffset }, query, text: before.slice(start) };
}

export const FootnotePicker = Node.create({
  name: 'footnotePicker',
  // A plugin host, not a node in any document: TipTap has no bare "extension
  // with a suggestion" shape that also owns nothing, and keeping this separate
  // stops the picker's plugin key from colliding with the numbering plugin's.
  addProseMirrorPlugins() {
    return [
      Suggestion({
        pluginKey: footnoteSuggestionKey,
        editor: this.editor,
        char: '[^',
        allowSpaces: true,
        findSuggestionMatch: findFootnoteMatch,
        items: ({ query, editor }) => {
          const doc = editor.state.doc;
          const numbers = numberFootnotes(doc);
          const q = query.toLowerCase();
          const existing = findEntries(doc)
            .map((entry) => ({
              id: entry.id,
              number: numbers.get(entry.id) ?? 0,
              preview: entry.node.textContent.slice(0, 60) || 'Empty note',
            }))
            .filter((item) => !q || item.preview.toLowerCase().includes(q) || String(item.number) === q);
          return [{ isNew: true }, ...existing].slice(0, 9);
        },
        render: makeSuggestionRender(FootnotePickerList),
        command: ({ editor, range, props }) => {
          const chain = editor.chain().focus().deleteRange(range);
          if (props.isNew) chain.addFootnote().run();
          else chain.citeFootnote(props.id).run();
        },
      }),
    ];
  },
});

export const FootnoteExtensions = [FootnoteRef, Footnote, Footnotes, FootnotePicker];
