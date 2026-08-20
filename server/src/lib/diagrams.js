// Diagrams arrive as code blocks, and have to be stored as diagrams.
//
// The editor stores a mermaid diagram as a `mermaidDiagram` node whose source
// lives in `attrs.code`, and a draw.io diagram as a `drawioDiagram` whose
// mxGraph XML lives in `attrs.xml`.
// Nothing that writes a page from outside the editor knows that:
// the MCP server, the markdown importer and any REST client all speak markdown,
// where a diagram is a fenced block. Whether that fence survives as a diagram or
// lands as an inert ```mermaid code block then depends on how exactly the client
// happened to spell the info string — which is how a page ends up showing raw
// mermaid source that cannot be rendered, enlarged or edited.
//
// So the write path normalises instead of trusting: any code block that is a
// diagram becomes a diagram node before it is stored. Clients keep sending
// whatever they send, and older MCP builds are fixed without having to ship
// them anything.

// Info strings carry more than a language — ```mermaid title="flow" is valid.
// Only the first token names the language.
const LANGUAGE_ALIASES = new Set(['mermaid', 'mmd']);

/** True for ```mermaid, ```Mermaid, ```mermaid title="x", ```mmd … */
export function isMermaidLanguage(language) {
  if (!language) return false;
  const first = String(language).trim().split(/[\s,{:]/)[0];
  return LANGUAGE_ALIASES.has(first.toLowerCase());
}

// Diagram types that are unmistakable on their own line. `graph`/`flowchart`
// are handled separately: they need a direction, because "graph" alone is an
// ordinary word that could open a block of pseudocode.
const DIAGRAM_KEYWORDS = [
  'sequenceDiagram',
  'classDiagram-v2',
  'classDiagram',
  'stateDiagram-v2',
  'stateDiagram',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'gitGraph',
  'mindmap',
  'timeline',
  'quadrantChart',
  'requirementDiagram',
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Dynamic',
  'C4Deployment',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'architecture-beta',
];

const KEYWORD_RE = new RegExp(`^(?:${DIAGRAM_KEYWORDS.join('|')})\\b`, 'i');
const DIRECTED_RE = /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i;

// A diagram may open with a %%{init: …}%% directive or a --- yaml --- frontmatter
// block. Skip past both to find the line that names the diagram type.
function firstDeclaration(code) {
  const lines = String(code ?? '').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;

  if (i < lines.length && /^---\s*$/.test(lines[i].trim())) {
    i += 1;
    while (i < lines.length && !/^---\s*$/.test(lines[i].trim())) i += 1;
    i += 1; // closing ---
  }
  while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('%%'))) i += 1;
  return (lines[i] || '').trim();
}

/** True when the body of an unlabelled fence is plainly a mermaid diagram. */
export function looksLikeMermaid(code) {
  const declaration = firstDeclaration(code);
  if (!declaration) return false;
  return DIRECTED_RE.test(declaration) || KEYWORD_RE.test(declaration);
}

// draw.io diagrams are mxGraph XML. The fence may name them, or carry no
// useful label at all — in which case the document element gives it away, and
// unambiguously enough that no `graph TD`-style direction check is needed.
const DRAWIO_ALIASES = new Set(['drawio', 'draw.io', 'mxgraph', 'mxfile']);
const DRAWIO_OPEN = /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:mxfile|mxGraphModel)[\s>]/i;

/** True for ```drawio, ```draw.io, ```mxgraph … */
export function isDrawioLanguage(language) {
  if (!language) return false;
  const first = String(language).trim().split(/[\s,{:]/)[0];
  return DRAWIO_ALIASES.has(first.toLowerCase());
}

/** True when the body of a fence is plainly an mxGraph document. */
export function looksLikeDrawio(code) {
  return DRAWIO_OPEN.test(String(code ?? ''));
}

const textOf = (node) =>
  (node.content || [])
    .map((child) => (typeof child.text === 'string' ? child.text : ''))
    .join('');

// The block keeps its identity across the swap — it is the same block, and a
// diagram that came out of here with a fresh name every save would be reported
// as changed and re-embedded on every save. Mirrors client/src/lib/diagramBlocks.js.
const keepId = (node) => (node.attrs?.blockId ? { blockId: node.attrs.blockId } : {});
const toDiagram = (node, code) => ({ type: 'mermaidDiagram', attrs: { ...keepId(node), code } });
// The preview is rendered by the client on first view; only the XML is stored.
const toDrawio = (node, xml) => ({
  type: 'drawioDiagram',
  attrs: { ...keepId(node), xml: xml.trim(), svg: '' },
});

function normalizeNode(node) {
  if (!node || typeof node !== 'object') return node;

  if (node.type === 'codeBlock') {
    const code = textOf(node);
    const language = node.attrs?.language;
    if (isMermaidLanguage(language)) return toDiagram(node, code);
    if (isDrawioLanguage(language)) return toDrawio(node, code);
    if (!language && looksLikeMermaid(code)) return toDiagram(node, code);
    if (!language && looksLikeDrawio(code)) return toDrawio(node, code);
    return node;
  }

  // A diagram whose source was put in the node's text instead of attrs.code
  // renders empty. Lift it rather than lose it.
  if (node.type === 'mermaidDiagram' && !node.attrs?.code && node.content?.length) {
    return toDiagram(node, textOf(node));
  }
  if (node.type === 'drawioDiagram' && !node.attrs?.xml && node.content?.length) {
    return toDrawio(node, textOf(node));
  }

  if (!Array.isArray(node.content)) return node;
  let changed = false;
  const content = node.content.map((child) => {
    const next = normalizeNode(child);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, content } : node;
}

/**
 * Rewrite every diagram code block in a document into a diagram node.
 *
 * Returns the same object when nothing matched, so a save with no diagrams in
 * it costs one walk and no allocation.
 */
export function normalizeDiagrams(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  return normalizeNode(doc);
}
