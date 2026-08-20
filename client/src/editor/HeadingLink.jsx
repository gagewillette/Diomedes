// The view layer for `#`-heading links: the picker that writes one, and the
// live-preview decorations that unfold one back into markdown under the caret.
// What a query matches and what gets revealed lives in headingLink.js.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import Suggestion from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { IconH1, IconH2, IconH3, IconHash } from '@tabler/icons-react';
import { makeSuggestionRender } from './suggestionRender.js';
import { collectHeadings, sectionRefPluginKey } from './SectionRef.js';
import { buildSectionIndex } from '../lib/sectionRefs.js';
import {
  allowsHeadingLink,
  HEADING_LINK_CHAR,
  headingItems,
  linkSourceSpans,
} from './headingLink.js';

export const headingLinkPluginKey = new PluginKey('headingLink');
export const headingSourcePluginKey = new PluginKey('headingLinkSource');

const LEVEL_ICON = { 1: IconH1, 2: IconH2, 3: IconH3 };

/**
 * The section index SectionRef already maintains, or a fresh one.
 *
 * The fallback is not defensive noise: the picker has to work on the very first
 * keystroke of a session, and the plugin state is one transaction behind if the
 * heading being linked to was typed a moment ago.
 */
function indexFor(state) {
  return sectionRefPluginKey.getState(state)?.index ?? buildSectionIndex(collectHeadings(state.doc));
}

const HeadingMenu = forwardRef(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') { setSelected((s) => (s + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setSelected((s) => (s - 1 + items.length) % items.length); return true; }
      if (event.key === 'Enter') { if (items[selected]) command(items[selected]); return true; }
      return false;
    },
  }));
  // Nothing rather than "No matches": a `#` is a character people type in
  // prose — "issue #42", "channel #ops" — and an empty menu popping up under
  // every one of them would be the feature getting in the way.
  if (!items.length) return null;
  return (
    <div className="gd-slash-menu">
      {items.map((item, i) => {
        const Icon = LEVEL_ICON[item.level] || IconHash;
        return (
          <button
            key={item.id}
            className={`gd-slash-item ${i === selected ? 'is-selected' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(e) => e.preventDefault()} /* keep editor focus so the popup survives the click */
            onClick={() => command(item)}
          >
            <Icon size={18} stroke={1.6} />
            <span>
              <b>{item.title}</b>
              <small>{item.number ? `§${item.number} · ${item.href}` : item.href}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
});
HeadingMenu.displayName = 'HeadingMenu';

/** A non-editable `[` or `](#slug)` painted beside the link it belongs to. */
function syntaxWidget(text) {
  return () => {
    const span = document.createElement('span');
    span.className = 'gd-link-syntax';
    span.textContent = text;
    // The brackets are chrome, not content: they must not take the caret, and
    // ProseMirror must not read them back as text the author typed.
    span.contentEditable = 'false';
    return span;
  };
}

/**
 * Decorations that unfold the link under the caret into its markdown.
 *
 * Recomputed from the state on every draw rather than mapped through
 * transactions, because the thing that changes them is usually a selection
 * move — which carries no mapping at all.
 */
function sourceDecorations(state, editable) {
  if (!editable) return DecorationSet.empty;
  const spans = linkSourceSpans(state);
  if (!spans.length) return DecorationSet.empty;
  return DecorationSet.create(
    state.doc,
    spans.map((span) =>
      Decoration.widget(span.pos, syntaxWidget(span.text), {
        side: span.side,
        // A stable key lets ProseMirror keep the same span across keystrokes
        // instead of rebuilding it under the author's cursor.
        key: `gd-link-syntax-${span.side}-${span.text}`,
      }),
    ),
  );
}

export const HeadingLink = Extension.create({
  name: 'headingLink',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      Suggestion({
        pluginKey: headingLinkPluginKey,
        editor,
        char: HEADING_LINK_CHAR,
        // Heading names have spaces in them, so the query has to keep matching
        // past the first one.
        allowSpaces: true,
        allow: ({ state, range }) => allowsHeadingLink(state, range.from),
        items: ({ editor: e, query }) => headingItems(indexFor(e.state), query),
        render: makeSuggestionRender(HeadingMenu),
        command: ({ editor: e, range, props }) => {
          e.chain()
            .focus()
            .insertContentAt(range, {
              type: 'text',
              text: props.title,
              marks: [{ type: 'link', attrs: { href: props.href } }],
            })
            // The link mark is inclusive while autolink is on, so without this
            // the next word the author types joins the link they just made.
            .unsetMark('link')
            .run();
        },
      }),

      new Plugin({
        key: headingSourcePluginKey,
        props: {
          // `isEditable` is a view property rather than document state, so the
          // decorations ask the editor for it rather than read the doc.
          decorations: (state) => sourceDecorations(state, editor.isEditable),
        },
      }),
    ];
  },
});

export default HeadingLink;
