// Diomedes' own block types, rewritten as blocks markdown can carry.
//
// The markdown serialiser is a headless TipTap editor built from the same
// extension list as the importer (see markdownToJSON), and that list knows
// nothing about callouts, toggles, diagrams or page links — those extensions
// need a DOM and a React node view. A document handed straight to it comes back
// with every one of those blocks silently missing, which for an *export* is the
// worst possible failure: it looks like it worked.
//
// So the document is lowered first, here, as a plain JSON transform. Diagrams
// go back to the fences they were imported from (hydrateDiagramBlocks in
// diagramBlocks.js is the exact inverse), and the rest degrade to the closest
// markdown that keeps the text a person wrote.

const paragraph = (text, marks) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text, ...(marks ? { marks } : {}) }] : [],
});

const codeBlock = (language, code) => ({
  type: 'codeBlock',
  attrs: { language },
  content: code ? [{ type: 'text', text: code }] : [],
});

// A block with nothing but a name to show for it. Written as italic text rather
// than an HTML comment because the importer runs with html: false, so a comment
// would come back as nothing at all.
const placeholder = (label) => paragraph(label, [{ type: 'italic' }]);

// Built as a real link mark rather than literal "[text](href)": the serialiser
// escapes brackets in plain text, so the hand-written version would export as
// \[text\]\(href\).
const linkParagraph = (text, href) => paragraph(text, [{ type: 'link', attrs: { href } }]);

function lower(node) {
  if (!node || typeof node !== 'object') return node;

  switch (node.type) {
    // Both diagram types are text — mermaid source, mxGraph XML — so they
    // round-trip through a fence exactly.
    case 'mermaidDiagram':
      return codeBlock('mermaid', node.attrs?.code || '');
    case 'drawioDiagram':
      return node.attrs?.xml
        ? codeBlock('drawio', node.attrs.xml)
        : placeholder('draw.io diagram (empty)');

    // A callout is a blockquote wearing a badge, and `> [!NOTE]` is how the
    // importer already spells that badge.
    case 'callout':
      return {
        type: 'blockquote',
        content: [
          paragraph(`[!${String(node.attrs?.variant || 'info').toUpperCase()}]`),
          ...(node.content || []).map(lower),
        ],
      };

    // <details> would be stripped (html: false), so the summary becomes a bold
    // line above the body it was hiding. The body is the part worth keeping.
    case 'toggleBlock':
      return {
        type: 'blockquote',
        content: [
          paragraph(node.attrs?.title || 'Details', [{ type: 'bold' }]),
          ...(node.content || []).map(lower),
        ],
      };

    // Inline, and the one custom node that has a real markdown equivalent.
    case 'pageLink': {
      const { label, pageId, spaceSlug } = node.attrs || {};
      const text = label || 'Untitled';
      if (!pageId || !spaceSlug) return { type: 'text', text };
      return {
        type: 'text',
        text,
        marks: [{ type: 'link', attrs: { href: `/s/${spaceSlug}/p/${pageId}` } }],
      };
    }

    // Attachments stay as absolute URLs in v1 — the archive carries markdown,
    // not binaries — so a link to where the file still lives is the honest
    // export.
    case 'documentBlock': {
      const { filename, url } = node.attrs || {};
      const name = filename || 'Document';
      return url ? linkParagraph(name, url) : placeholder(name);
    }
    case 'iframeEmbed':
    case 'videoBlock':
    case 'youtube': {
      const src = node.attrs?.src;
      return src ? linkParagraph(node.type, src) : placeholder(`${node.type} (empty)`);
    }

    // A drawing is neither text nor a URL; there is nothing to write down.
    case 'excalidraw':
      return placeholder('Excalidraw drawing (not representable in markdown)');

    default:
      if (Array.isArray(node.content)) return { ...node, content: node.content.map(lower) };
      return node;
  }
}

/** Rewrite a TipTap doc so a markdown-only editor can serialise all of it. */
export function lowerForMarkdown(doc) {
  return lower(doc);
}

// The serialiser escapes brackets in text, which is right everywhere except
// here: `> \[!NOTE\]` is not a callout to any reader of the file, and it is not
// a callout to our own importer either, so the round-trip would quietly demote
// every callout to a plain quote. Only this exact shape is unescaped — a line
// that is nothing but a quoted badge.
const ESCAPED_BADGE = /^((?:\s*>)+\s*)\\\[!([A-Za-z]+)\\\]\s*$/gm;

export function unescapeCalloutBadges(md) {
  return String(md).replace(ESCAPED_BADGE, (_, quote, variant) => `${quote}[!${variant}]`);
}
