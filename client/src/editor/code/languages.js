// The grammar registry behind code-block highlighting.
//
// This replaces `createLowlight(common)`. `common` pulls ~37 grammars into the
// main chunk whether or not a single page in the workspace contains code, and
// the cost is paid on every page load, by every reader, forever. Here the
// lowlight instance starts empty and a grammar is fetched the first time a
// block that needs it is on screen — one small lazy chunk per language.
//
// Registration is idempotent by construction: `ensureLanguage` memoises the
// in-flight promise, so twenty Python blocks on one page share one import and
// one `lowlight.register` call.
import { createLowlight } from 'lowlight';

export const lowlight = createLowlight();

// Display name, aliases and the lazy loader for each language we offer.
//
// The `import()` calls are written out as literals rather than built from the
// key, because a bundler can only split a chunk it can see statically — an
// `import(\`highlight.js/lib/languages/${id}\`)` would either fail or drag the
// whole directory in.
//
// Aliases feed `resolveLanguage`, so ```py, ```python and ```python3 all land
// on the same grammar and the picker shows one entry rather than three.
export const LANGUAGES = {
  bash: { label: 'Shell', aliases: ['sh', 'zsh', 'shell', 'console'], popular: true, load: () => import('highlight.js/lib/languages/bash') },
  c: { label: 'C', aliases: ['h'], load: () => import('highlight.js/lib/languages/c') },
  cpp: { label: 'C++', aliases: ['c++', 'cc', 'hpp', 'cxx'], load: () => import('highlight.js/lib/languages/cpp') },
  csharp: { label: 'C#', aliases: ['cs', 'c#'], load: () => import('highlight.js/lib/languages/csharp') },
  css: { label: 'CSS', aliases: [], load: () => import('highlight.js/lib/languages/css') },
  diff: { label: 'Diff', aliases: ['patch'], load: () => import('highlight.js/lib/languages/diff') },
  dockerfile: { label: 'Dockerfile', aliases: ['docker'], load: () => import('highlight.js/lib/languages/dockerfile') },
  go: { label: 'Go', aliases: ['golang'], load: () => import('highlight.js/lib/languages/go') },
  graphql: { label: 'GraphQL', aliases: ['gql'], load: () => import('highlight.js/lib/languages/graphql') },
  ini: { label: 'TOML / INI', aliases: ['toml'], load: () => import('highlight.js/lib/languages/ini') },
  java: { label: 'Java', aliases: [], load: () => import('highlight.js/lib/languages/java') },
  javascript: { label: 'JavaScript', aliases: ['js', 'mjs', 'cjs', 'jsx'], popular: true, load: () => import('highlight.js/lib/languages/javascript') },
  json: { label: 'JSON', aliases: ['jsonc'], popular: true, load: () => import('highlight.js/lib/languages/json') },
  kotlin: { label: 'Kotlin', aliases: ['kt'], load: () => import('highlight.js/lib/languages/kotlin') },
  lua: { label: 'Lua', aliases: [], load: () => import('highlight.js/lib/languages/lua') },
  markdown: { label: 'Markdown', aliases: ['md'], load: () => import('highlight.js/lib/languages/markdown') },
  php: { label: 'PHP', aliases: [], load: () => import('highlight.js/lib/languages/php') },
  plaintext: { label: 'Plain text', aliases: ['text', 'txt'], load: () => import('highlight.js/lib/languages/plaintext') },
  python: { label: 'Python', aliases: ['py', 'python3'], popular: true, load: () => import('highlight.js/lib/languages/python') },
  r: { label: 'R', aliases: [], load: () => import('highlight.js/lib/languages/r') },
  ruby: { label: 'Ruby', aliases: ['rb'], load: () => import('highlight.js/lib/languages/ruby') },
  rust: { label: 'Rust', aliases: ['rs'], load: () => import('highlight.js/lib/languages/rust') },
  scala: { label: 'Scala', aliases: [], load: () => import('highlight.js/lib/languages/scala') },
  sql: { label: 'SQL', aliases: ['postgres', 'postgresql', 'psql', 'mysql', 'sqlite'], popular: true, load: () => import('highlight.js/lib/languages/sql') },
  swift: { label: 'Swift', aliases: [], load: () => import('highlight.js/lib/languages/swift') },
  typescript: { label: 'TypeScript', aliases: ['ts', 'tsx'], popular: true, load: () => import('highlight.js/lib/languages/typescript') },
  xml: { label: 'HTML / XML', aliases: ['html', 'svg', 'xhtml', 'vue'], popular: true, load: () => import('highlight.js/lib/languages/xml') },
  yaml: { label: 'YAML', aliases: ['yml'], popular: true, load: () => import('highlight.js/lib/languages/yaml') },
};

// Languages that are not code blocks at all — a ```mermaid fence becomes a
// mermaidDiagram node, a ```drawio fence a drawioDiagram. Kept in step with
// MERMAID_LANGS / DRAWIO_LANGS in ../../lib/diagramBlocks.js. The picker
// offers them, but choosing one runs the conversion instead of writing an
// attribute, so the two paths can never diverge into "a mermaid code block".
export const DIAGRAM_LANGUAGES = {
  mermaid: { label: 'Mermaid diagram', aliases: ['mmd'], node: 'mermaidDiagram' },
  drawio: { label: 'draw.io diagram', aliases: ['draw.io', 'mxgraph', 'mxfile'], node: 'drawioDiagram' },
};

// alias -> canonical id, built once. Canonical ids map to themselves so
// resolveLanguage is idempotent.
const ALIASES = new Map();
for (const [id, spec] of Object.entries(LANGUAGES)) {
  ALIASES.set(id, id);
  for (const alias of spec.aliases) ALIASES.set(alias, id);
}

const DIAGRAM_ALIASES = new Map();
for (const [id, spec] of Object.entries(DIAGRAM_LANGUAGES)) {
  DIAGRAM_ALIASES.set(id, id);
  for (const alias of spec.aliases) DIAGRAM_ALIASES.set(alias, id);
}

/**
 * The language name out of a fence info string.
 *
 * An info string carries more than a language — ```python title="setup.py" is
 * valid markdown, and so is ```sql:mysql. Only the first token names the
 * language; the rest is `qualifier`, which the SQL adapter reads to pick a
 * dialect. Mirrors the splitting in ../../lib/diagramBlocks.js so a fence that
 * became a diagram there and a fence that stayed code here agree on what the
 * language was.
 */
export function parseInfoString(info) {
  const raw = String(info ?? '').trim();
  if (!raw) return { name: '', qualifier: '' };
  const head = raw.split(/[\s,{]/)[0];
  const [name, ...rest] = head.split(':');
  return { name: name.toLowerCase(), qualifier: rest.join(':').toLowerCase() };
}

/** Canonical grammar id for a language name or alias, or null if we have none. */
export function resolveLanguage(name) {
  const { name: token } = parseInfoString(name);
  return ALIASES.get(token) ?? null;
}

/** Canonical diagram id if this language is really a diagram fence, else null. */
export function resolveDiagramLanguage(name) {
  const { name: token } = parseInfoString(name);
  return DIAGRAM_ALIASES.get(token) ?? null;
}

/** Human label for whatever is in `attrs.language`. Unknown names show as-is. */
export function languageLabel(name) {
  const id = resolveLanguage(name);
  if (id) return LANGUAGES[id].label;
  const diagram = resolveDiagramLanguage(name);
  if (diagram) return DIAGRAM_LANGUAGES[diagram].label;
  const { name: token } = parseInfoString(name);
  return token || 'Plain text';
}

// id -> Promise<void>. Holds the *in-flight* promise, not a done flag, so two
// blocks racing on the same grammar share one import.
const loaded = new Map();

/** Test seam: forget every registration so a test can assert on a clean slate. */
export function resetLanguages() {
  loaded.clear();
}

/** How many distinct grammars have been asked for. Used by the registry tests. */
export const loadedLanguages = () => [...loaded.keys()];

/**
 * Register the grammar for `name` with the shared lowlight instance, once.
 *
 * Resolves to the canonical id when a grammar is now registered, and to null
 * when we have no grammar for that name — the caller renders the block
 * uncoloured rather than treating it as an error. A failed network fetch is
 * swallowed for the same reason: a missing chunk must never break editing.
 */
export function ensureLanguage(name) {
  const id = resolveLanguage(name);
  if (!id) return Promise.resolve(null);
  if (loaded.has(id)) return loaded.get(id);
  const p = LANGUAGES[id]
    .load()
    .then((mod) => {
      if (!lowlight.registered(id)) lowlight.register(id, mod.default);
      return id;
    })
    .catch(() => {
      // Let a later block retry rather than caching the failure forever.
      loaded.delete(id);
      return null;
    });
  loaded.set(id, p);
  return p;
}

/** Picker options, popular languages first. Shape matches Mantine's Select. */
export function languageOptions() {
  const entry = ([id, spec]) => ({ value: id, label: spec.label });
  const all = Object.entries(LANGUAGES);
  return [
    { group: 'Popular', items: all.filter(([, s]) => s.popular).map(entry) },
    { group: 'All languages', items: all.filter(([, s]) => !s.popular).map(entry) },
    {
      group: 'Diagrams',
      items: Object.entries(DIAGRAM_LANGUAGES).map(([id, spec]) => ({ value: id, label: spec.label })),
    },
  ];
}
