// Fenced code blocks that are really diagrams.
//
// The MCP server does this conversion itself (Diomedes-MCP src/markdown.js),
// but markdown also arrives through the client — the "import markdown" flow —
// where tiptap-markdown hands us plain code blocks. This walks the resulting
// document and promotes the diagram fences to the nodes the editor draws, so
// both routes land on the same document.

// Kept in step with BLOCK_ID_ATTR in ../editor/blockId.js; spelled out here so
// this stays a plain JSON transform with no editor dependencies.
const BLOCK_ID_ATTR = 'blockId';

const DRAWIO_LANGS = new Set(['drawio', 'draw.io', 'mxgraph', 'mxfile']);

/** Does this text look like a draw.io (mxGraph) document? */
export function isDrawioXml(text) {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:mxfile|mxGraphModel)[\s>]/i.test(String(text || ''));
}

function codeBlockText(node) {
  return (node.content || []).map((c) => c.text || '').join('');
}

function convert(node) {
  if (!node || typeof node !== 'object') return node;

  if (node.type === 'codeBlock') {
    const lang = String(node.attrs?.language || '').toLowerCase();
    const code = codeBlockText(node);
    // The block keeps its identity across the swap — it is the same block.
    const blockId = node.attrs?.[BLOCK_ID_ATTR];
    const keepId = blockId ? { [BLOCK_ID_ATTR]: blockId } : {};
    if (lang === 'mermaid') return { type: 'mermaidDiagram', attrs: { ...keepId, code } };
    // An unlabelled or generically labelled fence still counts if the body is
    // unmistakably mxGraph XML — that is how most callers send a diagram.
    if (DRAWIO_LANGS.has(lang) || isDrawioXml(code)) {
      return { type: 'drawioDiagram', attrs: { ...keepId, xml: code.trim(), svg: '' } };
    }
    return node;
  }

  if (Array.isArray(node.content)) {
    return { ...node, content: node.content.map(convert) };
  }
  return node;
}

/** Promote mermaid/draw.io code fences in a TipTap doc to diagram nodes. */
export function hydrateDiagramBlocks(doc) {
  return convert(doc);
}
