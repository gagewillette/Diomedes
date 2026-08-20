// The view layer for §-references. Everything about *what* a reference means
// lives in lib/sectionRefs.js; this file only paints and navigates.
//
// Deliberately a decoration plugin rather than a schema mark. Decorations are a
// pure overlay: the text nodes are never touched, so `§3.2` stays `§3.2` in the
// document, in `tiptap-markdown`'s output and in what MCP's read_page returns.
// It also means every document that already exists lights up with no migration
// and nothing to undo if we ever drop the feature.
//
// The same plugin gives every heading a slug `id`, which is what makes a
// hand-written `[§2](#2-why-…)` markdown link work as well.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { buildSectionIndex, findSectionRefs, refAriaLabel, resolveRef } from '../lib/sectionRefs.js';

export const sectionRefPluginKey = new PluginKey('sectionRef');

export const SECTION_REF_ATTR = 'data-section-ref';

// Long enough to catch the eye after a smooth scroll, short enough that it is
// gone before it becomes decoration.
const FLASH_MS = 1400;

// Nodes whose text is not prose. A `§3.2` inside any of these is content, not a
// reference, and linking it would be wrong in a way the author cannot undo.
const OPAQUE = new Set(['codeBlock', 'mermaidDiagram', 'drawioDiagram', 'excalidraw']);
const SKIPPED_MARKS = new Set(['code', 'link']);

/** Collect the document's headings, in document order. */
function collectHeadings(doc) {
  const headings = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    headings.push({ level: node.attrs.level, text: node.textContent, pos, size: node.nodeSize });
    return false;
  });
  return headings;
}

/**
 * Decorations for one document: an `id` on every heading, and a link overlay on
 * every §-reference.
 *
 * Exported for tests — it needs a document and nothing else, no DOM and no view.
 */
export function buildDecorations(doc, { editable = false } = {}) {
  const index = buildSectionIndex(collectHeadings(doc));
  const decorations = [];

  for (const heading of index.headings) {
    decorations.push(
      Decoration.node(heading.pos, heading.pos + heading.size, {
        id: heading.id,
        class: 'gd-heading-anchor',
      }),
    );
  }

  doc.descendants((node, pos) => {
    if (OPAQUE.has(node.type.name)) return false;
    if (!node.isText) return true;
    // An existing link wins: no double-decoration, and never a link inside a
    // link. Inline code is content for the same reason a code block is.
    if (node.marks.some((mark) => SKIPPED_MARKS.has(mark.type.name))) return true;

    for (const ref of findSectionRefs(node.text)) {
      const target = resolveRef(index, ref.key);
      decorations.push(
        Decoration.inline(pos + ref.start, pos + ref.end, refAttrs(ref, target, editable)),
      );
    }
    return true;
  });

  return { index, decorations: DecorationSet.create(doc, decorations) };
}

/**
 * An unresolved reference stays plain text with a quiet explanation. A `§9` in a
 * document with eight sections is nearly always a reference to a section that
 * has not been written yet — showing a broken link would be a lie about the
 * document, and showing an error would be noise in the middle of a sentence.
 */
function refAttrs(ref, target, editable) {
  if (!target) {
    return {
      class: 'gd-section-ref gd-section-ref--unresolved',
      [SECTION_REF_ATTR]: ref.key,
      title: `No section ${ref.key} in this page`,
    };
  }
  return {
    class: 'gd-section-ref',
    [SECTION_REF_ATTR]: ref.key,
    role: 'link',
    title: `§${ref.key} → ${target.title}`,
    'aria-label': refAriaLabel(ref.key, target.title),
    // Only a reader gets a tab stop. Inside a live contenteditable an extra
    // focusable span mid-paragraph fights the caret for the Tab key.
    ...(editable ? {} : { tabindex: '0' }),
  };
}

/** Scroll a heading into view and leave the reader looking at it. */
export function scrollToHeading(view, entry) {
  const dom = view.nodeDOM(entry.pos);
  if (!dom || dom.nodeType !== 1) return false;

  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  dom.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });

  // A smooth scroll ends with the heading at the top of the viewport and no
  // other signal that anything happened; the flash is what tells the eye where
  // it landed.
  dom.classList.add('gd-section-landed');
  setTimeout(() => dom.classList.remove('gd-section-landed'), FLASH_MS);

  // Keyboard and screen-reader users have to land where sighted users are
  // looking, or the jump moved the page out from under them.
  try {
    if (!dom.hasAttribute('tabindex')) dom.setAttribute('tabindex', '-1');
    dom.focus({ preventScroll: true });
  } catch {
    /* focus is a nicety; a failed one must not swallow the jump */
  }

  if (entry.id && globalThis.history?.replaceState) {
    globalThis.history.replaceState(null, '', `#${entry.id}`);
  }
  return true;
}

/** Jump to the section a `§`-key names. Returns false when there is none. */
export function jumpToSection(view, key) {
  const state = sectionRefPluginKey.getState(view.state);
  const target = resolveRef(state?.index, key);
  return target ? scrollToHeading(view, target) : false;
}

/**
 * Resolve a URL hash to a heading. Accepts the slug we render (`#3-2-local-…`),
 * the section number on its own (`#§3.2`, `#3.2`), and the percent-encoded form
 * a browser produces when the reader copies the address bar.
 */
export function headingForHash(index, rawHash) {
  if (!index || !rawHash) return null;
  let hash = rawHash.replace(/^#/, '');
  try {
    hash = decodeURIComponent(hash);
  } catch {
    /* a malformed escape is just not a section */
  }
  if (!hash) return null;

  const bySlug = index.headings.find((h) => h.id === hash);
  if (bySlug) return bySlug;

  const numeric = hash.replace(/^§+/, '');
  return /^\d+(\.\d+)*$/.test(numeric) ? resolveRef(index, numeric) : null;
}

export const SectionRef = Extension.create({
  name: 'sectionRef',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: sectionRefPluginKey,

        state: {
          init: (_config, state) => buildDecorations(state.doc, { editable: editor.isEditable }),
          apply(tr, value, _oldState, newState) {
            // Only the document's shape can change which references resolve; a
            // selection move must not cost a walk of the whole doc.
            if (!tr.docChanged && !tr.getMeta(sectionRefPluginKey)) {
              return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
            }
            return buildDecorations(newState.doc, { editable: editor.isEditable });
          },
        },

        props: {
          decorations: (state) => sectionRefPluginKey.getState(state)?.decorations,

          handleDOMEvents: {
            mousedown(view, event) {
              const from = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
              const el = from?.closest?.(`[${SECTION_REF_ATTR}][role="link"]`);
              if (!el) return false;
              // While editing, a plain click has to keep placing the caret —
              // the author is writing the sentence the reference sits in. The
              // modifier is the same one that follows a link in every editor.
              if (view.editable && !(event.metaKey || event.ctrlKey)) return false;
              event.preventDefault();
              return jumpToSection(view, el.getAttribute(SECTION_REF_ATTR));
            },
            keydown(view, event) {
              if (event.key !== 'Enter' && event.key !== ' ') return false;
              const el = view.dom.ownerDocument?.activeElement?.closest?.(
                `[${SECTION_REF_ATTR}][role="link"]`,
              );
              if (!el) return false;
              event.preventDefault();
              return jumpToSection(view, el.getAttribute(SECTION_REF_ATTR));
            },
          },
        },

        view(view) {
          let landed = false;

          const jumpToHash = () => {
            const hash = globalThis.location?.hash;
            const index = sectionRefPluginKey.getState(view.state)?.index;
            const target = headingForHash(index, hash);
            if (target) scrollToHeading(view, target);
          };

          const onHashChange = () => jumpToHash();
          globalThis.addEventListener?.('hashchange', onHashChange);

          // Editability is a view property, not document state, so a switch
          // between reading and editing has to ask for the rebuild itself.
          let editable = view.editable;

          return {
            update(v) {
              if (v.editable !== editable) {
                editable = v.editable;
                v.dispatch(v.state.tr.setMeta(sectionRefPluginKey, 'refresh'));
              }
              // The document arrives after mount — from a fetch, or from the
              // CRDT once it syncs — so the deep link waits for the first
              // document that actually has headings in it.
              if (landed) return;
              const index = sectionRefPluginKey.getState(v.state)?.index;
              if (!index?.headings.length) return;
              landed = true;
              requestAnimationFrame(jumpToHash);
            },
            destroy() {
              globalThis.removeEventListener?.('hashchange', onHashChange);
            },
          };
        },
      }),
    ];
  },
});
