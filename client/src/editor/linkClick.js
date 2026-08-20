import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { normalizeUrl } from './linkUrl.js';

/**
 * Clicking a link opens it in a new tab — while reading and while editing.
 *
 * A wiki page is read far more often than it is edited, and a link that does
 * nothing when clicked reads as broken. Leaving the page open matters too: the
 * document may be mid-edit, and a same-tab navigation would take the writer
 * away from it.
 *
 * Alt+click is the escape hatch, and the reason plain click can be this eager:
 * it falls through to ProseMirror and drops the caret into the link text, which
 * is how you fix a typo inside a link without going through the dialog.
 *
 * This is a DOM handler rather than ProseMirror's `handleClick` prop for the
 * same reason SectionRef listens on mousedown: `handleClick` only runs at the
 * end of ProseMirror's own click plumbing, which bails out for a range of
 * ordinary cases (a click it decides may have been a drag, anything it treats
 * as default-allowed) and so cannot be relied on to fire on every click.
 */
export const LinkClick = Extension.create({
  name: 'linkClick',

  addProseMirrorPlugins() {
    // Where the button went down, so a click that travelled can be told from
    // one that did not. Selecting the words inside a link ends in a click on
    // that link, and opening a tab out from under someone who was about to
    // retype the text is the worst possible answer.
    let pressed = null;

    return [
      new Plugin({
        key: new PluginKey('linkClick'),
        props: {
          handleDOMEvents: {
            mousedown(_view, event) {
              pressed = { x: event.clientX, y: event.clientY };
              return false;
            },
            click(view, event) {
              const down = pressed;
              pressed = null;
              if (event.button !== 0) return false;

              // A drag: the pointer travelled between press and release, so
              // this was a selection.
              if (down && (Math.abs(down.x - event.clientX) > 3 || Math.abs(down.y - event.clientY) > 3)) {
                return false;
              }
              // Double- and triple-click select a word or a line.
              if (event.detail > 1) return false;
              // Anything already selected means the click finished a selection
              // rather than started a visit. A plain click elsewhere collapses
              // the selection on mousedown, so this only catches the real case.
              if (!view.state.selection.empty) return false;
              // Alt to edit; the platform-native "open in new tab" chords are
              // already doing what we do, so let them through untouched.
              if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;

              const from = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
              const anchor = from?.closest?.('a[href]');
              if (!anchor || !view.dom.contains(anchor)) return false;

              // The anchor has to belong to a `link` mark. Page-link chips and
              // the other node views draw their own anchors and answer their
              // own clicks; asking the document what is at this position is
              // what tells the two apart.
              const linkType = view.state.schema.marks.link;
              if (!linkType) return false;
              let pos;
              try {
                pos = view.posAtDOM(anchor, 0);
              } catch {
                return false;
              }
              const $pos = view.state.doc.resolve(pos);
              const mark =
                linkType.isInSet($pos.nodeAfter?.marks || []) || linkType.isInSet($pos.marks());
              if (!mark) return false;

              // The stored href gets the same scrubbing as one typed into the
              // dialog: documents arrive by paste, import and CRDT sync, not
              // only through our own UI, so this is the last place to catch a
              // `javascript:` href before a click hands it to the browser.
              const href = normalizeUrl(mark.attrs.href);
              if (!href) return false;

              // An in-page `#slug` anchor points at a heading in this very
              // document, and SectionRef already claims those on mousedown and
              // scrolls to them. Opening a second copy of the page in another
              // tab would be a strange way to scroll down.
              if (href.startsWith('#')) return false;

              event.preventDefault();
              window.open(href, '_blank', 'noopener,noreferrer');
              return true;
            },
          },
        },
      }),
    ];
  },
});
