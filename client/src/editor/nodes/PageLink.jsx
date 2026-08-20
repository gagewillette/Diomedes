import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { IconFileText, IconPlus, IconLinkOff } from '@tabler/icons-react';
import { api, emitNavigate, emitPagesChanged } from '../../lib/api.js';
import { makeSuggestionRender } from '../suggestionRender.js';
import { subscribeTitle, getCachedTitle } from './pageTitles.js';
import { subscribeLabel, getCachedLabel } from './pageLabels.js';
import PagePicker from '../../components/PagePicker.jsx';
import { findWikiLinkMatch } from './wikiLinkMatch.js';

// Where the editor currently is. Set by Editor.jsx before rendering, so the
// suggestion plugin — which lives outside React — knows which space to search
// first and whether the user may create a page from an unmatched title.
export const linkContext = { spaceId: null, spaceSlug: null, canWrite: false };

// Suggestion plugins are keyed, and the default key is shared. The slash menu
// already claims it, so this one needs a key of its own or ProseMirror refuses
// to load both into the same editor.
const pageLinkPluginKey = new PluginKey('pageLinkSuggestion');

export const pageHref = (spaceSlug, pageId) => `/s/${spaceSlug}/p/${pageId}`;

// Read-time resolution for a label-only link: `undefined` while the lookup is
// in flight, `null` when nothing in the space is titled that, the page when
// something is. Passing `null` for the label opts out entirely, which is what a
// link that already carries an id does.
function useLabelResolution(label) {
  const spaceId = linkContext.spaceId;
  const [found, setFound] = useState(() =>
    label ? getCachedLabel(spaceId, label) : null
  );

  useEffect(() => {
    if (!label) {
      setFound(null);
      return undefined;
    }
    return subscribeLabel(spaceId, label, setFound);
  }, [spaceId, label]);

  return label ? found : null;
}

function PageLinkView({ node, updateAttributes, editor }) {
  const { pageId, label, spaceSlug } = node.attrs;
  const [picking, setPicking] = useState(false);
  // `undefined` = not looked up yet (show the written label), `null` = the page
  // is gone or unreadable, an object = the page as it is titled right now.
  const [live, setLive] = useState(() => (pageId ? getCachedTitle(pageId) : null));

  useEffect(() => {
    if (!pageId) return undefined;
    return subscribeTitle(pageId, setLive);
  }, [pageId]);

  // The stored `spaceSlug` is a cache of where the target lives, and a page
  // dragged into another space invalidates it everywhere it was written. The
  // server repairs the documents it can reach, but a page being edited right
  // now has its text in the CRDT, where a database rewrite would be overwritten
  // by the next snapshot. So the chip that noticed the drift fixes its own
  // node: the edit travels to every collaborator like any other, and the next
  // snapshot carries the corrected slug to storage.
  useEffect(() => {
    if (!pageId || !live?.spaceSlug || live.spaceSlug === spaceSlug) return;
    if (!editor?.isEditable) return;
    updateAttributes({ spaceSlug: live.spaceSlug });
  }, [pageId, live?.spaceSlug, spaceSlug, editor, updateAttributes]);

  // A link with no id was written against a title that had no page yet — often
  // just moments earlier, by an import that wrote this page before its target.
  // Resolving the label here means the chip heals as soon as the target exists,
  // with no rewrite of the document and no dependence on who was written first.
  const byLabel = useLabelResolution(pageId ? null : label);

  const resolvedId = pageId || byLabel?.id || null;
  const target = pageId ? live : byLabel;
  const resolved = Boolean(resolvedId) && target !== null;
  const text = (target?.title ?? label) || 'Untitled';
  const href = resolved ? pageHref(target?.spaceSlug || spaceSlug, resolvedId) : null;

  // A link written by the MCP server or an import names a title that may never
  // have had a page — or may have one under a slightly different title. The chip
  // is the place to fix that: clicking it picks the target by hand and writes
  // the id into the node, which is the same shape the autocomplete produces, so
  // it follows renames from then on. Read-only readers just see a dead chip.
  const fixable = !resolved && Boolean(editor?.isEditable);

  const open = (e) => {
    e.preventDefault();
    if (href) {
      emitNavigate(href);
      return;
    }
    if (fixable) setPicking(true);
  };

  const assign = (page) => {
    if (!page) return;
    updateAttributes({ pageId: page.id, label: page.title || label, spaceSlug: page.space_slug });
  };

  return (
    <NodeViewWrapper as="span" className="gd-pagelink-wrap">
      <a
        href={href || undefined}
        className={`gd-pagelink ${resolved ? '' : 'is-unresolved'}${fixable ? ' is-fixable' : ''}`}
        onClick={open}
        title={
          resolved
            ? text
            : pageId
              ? `“${label}” is in the trash or not shared with you`
              : fixable
                ? `No page named “${label}” yet — click to link it to a page`
                : `No page named “${label}” yet`
        }
        data-page-link=""
      >
        {resolved ? <IconFileText size={13} /> : <IconLinkOff size={13} />}
        <span>{text}</span>
      </a>
      {picking && (
        <PagePicker
          opened
          onClose={() => setPicking(false)}
          onPick={assign}
          title={`Link “${label}” to a page`}
          spaceId={linkContext.spaceId}
        />
      )}
    </NodeViewWrapper>
  );
}

const PageLinkList = forwardRef(({ items, command }, ref) => {
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
          key={item.id || `new-${item.title}`}
          className={`gd-slash-item ${i === selected ? 'is-selected' : ''}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
        >
          {item.isNew ? <IconPlus size={15} /> : <span className="gd-slash-icon">{item.icon || '📄'}</span>}
          <span>
            <b>{item.isNew ? `Create “${item.title}”` : item.title || 'Untitled'}</b>
            <small>{item.isNew ? 'New page in this space' : item.space_name}</small>
          </span>
        </button>
      ))}
    </div>
  );
});
PageLinkList.displayName = 'PageLinkList';

export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      pageId: { default: null },
      label: { default: '' },
      spaceSlug: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: 'a[data-page-link]',
      getAttrs: (el) => ({
        pageId: el.getAttribute('data-page-id') || null,
        label: el.getAttribute('data-label') || el.textContent || '',
        spaceSlug: el.getAttribute('data-space-slug') || null,
      }),
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { pageId, label, spaceSlug } = node.attrs;
    const resolved = pageId && spaceSlug;
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-page-link': '',
        'data-page-id': pageId || '',
        'data-space-slug': spaceSlug || '',
        'data-label': label,
        class: `gd-pagelink ${resolved ? '' : 'is-unresolved'}`,
        ...(resolved ? { href: pageHref(spaceSlug, pageId) } : {}),
      }),
      label || 'Untitled',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView, { as: 'span' });
  },

  // Round-trips as Obsidian-style `[[Title]]` in exported markdown.
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`[[${node.attrs.label}]]`);
        },
        parse: {},
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        pluginKey: pageLinkPluginKey,
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        findSuggestionMatch: findWikiLinkMatch,
        items: async ({ query }) => {
          let pages = [];
          try {
            const params = new URLSearchParams({ q: query });
            if (linkContext.spaceId) params.set('spaceId', linkContext.spaceId);
            const data = await api.get(`/api/pages/link-search?${params}`, { noRedirect: true });
            pages = data.pages;
          } catch {
            /* offline or forbidden — fall through to the create option */
          }
          const typed = query.trim();
          const exactMatch = pages.some(
            (p) => (p.title || '').trim().toLowerCase() === typed.toLowerCase()
          );
          // Offer to write the page you just referred to, the way Obsidian does.
          if (typed && !exactMatch && linkContext.canWrite && linkContext.spaceId) {
            pages = [...pages, { isNew: true, title: typed }];
          }
          return pages;
        },
        render: makeSuggestionRender(PageLinkList),
        command: async ({ editor, range, props }) => {
          let attrs;
          if (props.isNew) {
            try {
              const data = await api.post('/api/pages', {
                spaceId: linkContext.spaceId,
                title: props.title,
              });
              emitPagesChanged(linkContext.spaceId);
              attrs = { pageId: data.page.id, label: props.title, spaceSlug: linkContext.spaceSlug };
            } catch {
              // Creation failed — still record the intent as an unresolved link
              // so the text isn't lost and it can resolve later.
              attrs = { pageId: null, label: props.title, spaceSlug: null };
            }
          } else {
            attrs = { pageId: props.id, label: props.title || 'Untitled', spaceSlug: props.space_slug };
          }
          // The chip is followed by a space so the caret has somewhere to land,
          // but the replaced range may already have had one after it — a link
          // written out in full as `[[Title]] and more` is consumed through its
          // closing brackets, and doubling the space there would be visible.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 1, editor.state.doc.content.size));
          const content = [{ type: 'pageLink', attrs }];
          if (after !== ' ') content.push({ type: 'text', text: ' ' });
          editor.chain().focus().insertContentAt(range, content).run();
        },
      }),
    ];
  },
});

export default PageLink;
