// Stable identity for every block in a document.
//
// Until now a paragraph had no name. It was addressable only by its position
// in `pages.content`, which changes whenever anything above it changes — so
// nothing outside the editor could refer to "that block" across two saves.
// Everything downstream of this migration needs that reference:
//
//   * block-scoped re-embedding — `page_chunks.source_block_ids` records which
//     blocks a chunk was built from, so a one-word edit re-embeds one chunk
//     instead of the whole page,
//   * `page_blocks` and the `?since=rev` delta — a cache that syncs blocks
//     rather than whole documents needs to know which blocks moved,
//   * drag handles that survive someone else editing above the block,
//   * the join point for character-level merge later: a `Y.Array` of `Y.Map`
//     blocks is keyed on exactly this id.
//
// The id is ULID-shaped: a millisecond timestamp in Crockford base-32 followed
// by randomness, so ids sort by creation time and collide with probability that
// rounds to zero without a server round trip. `blk_` prefixes it so an id is
// recognisable in a log line or a JSON blob.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';

export const BLOCK_ID_ATTR = 'blockId';
export const BLOCK_ID_DATA_ATTR = 'data-block-id';

// Crockford base-32: no I, L, O or U, so an id read aloud or copied out of a
// log is unambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const randomChars = (n) => {
  const bytes = new Uint8Array(n);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
};

/** A fresh block id: `blk_` + 10 chars of timestamp + 12 of randomness. */
export function newBlockId(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `blk_${time}${randomChars(12)}`;
}

export const isBlockId = (value) => typeof value === 'string' && /^blk_[0-9A-HJKMNP-TV-Z]{22}$/.test(value);

// The node types that carry an id.
//
// Top-level blocks, because those are what `page_blocks` stores and what the
// chunker already walks. Plus list items and task items, because a list is one
// top-level node containing many independently draggable things — without ids
// on the items, reordering a list would look like a rewrite of the whole list.
//
// The custom nodes are listed explicitly rather than by group, because
// `addGlobalAttributes` needs static names. `warnUnstampedTypes` below is the
// guard against this list rotting when a new node type is added.
export const BLOCK_ID_TYPES = [
  // StarterKit + core blocks
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'horizontalRule',
  'image',
  'table',
  // Diomedes' own nodes — each of these would silently drop the attribute on
  // save if it were left out.
  'callout',
  'toggleBlock',
  'mermaidDiagram',
  'excalidraw',
  'drawioDiagram',
  'iframeEmbed',
  'videoBlock',
  'documentBlock',
  // The footnote apparatus. The container is a top-level block like any other,
  // so page_blocks and the delta endpoint can address it; the entries inside it
  // are stamped for the same reason list items are — so editing one note does
  // not read as a rewrite of every note.
  'footnotes',
  'footnote',
];

const blockIdPluginKey = new PluginKey('blockId');

/**
 * Assign ids to blocks that have none, and break ties between blocks that
 * share one.
 *
 * The duplicate check is not defensive padding — it is the whole paste story.
 * ProseMirror serialises a copy to HTML with attributes intact, so
 * copy-and-paste inside one document would otherwise produce two blocks
 * claiming the same id. Renaming the second occurrence gives exactly the
 * behaviour the design asks for, and gives it for free in both directions:
 *
 *   * copy/paste — the pasted block collides and is renamed, so a page never
 *     holds a duplicate,
 *   * cut/paste — the original is gone, nothing collides, and the block keeps
 *     its identity across the move, which is what stops a drag from looking
 *     like a delete plus an unrelated insert to the embedding queue.
 *
 * Cross-document paste is the same code path: the incoming ids do not collide,
 * so they are kept. That is harmless — an id only has to be unique within its
 * page — and it means a block dragged between two pages keeps its name.
 */
export function stampMissingIds(newState) {
  const { doc, tr } = newState;
  const seen = new Set();
  const fixes = [];

  doc.descendants((node, pos) => {
    if (node.isText) return false;
    // A type that carries no id attribute reports `undefined` here rather than
    // the `null` default of one that does — that is the whole test. Descending
    // continues either way, because an unstamped container (a table cell, say)
    // holds paragraphs that are stamped.
    const id = node.attrs?.[BLOCK_ID_ATTR];
    if (id === undefined) return true;
    if (!isBlockId(id) || seen.has(id)) fixes.push(pos);
    else seen.add(id);
    return true;
  });

  if (!fixes.length) return null;
  for (const pos of fixes) {
    const node = doc.nodeAt(pos);
    if (!node) continue;
    const id = newBlockId();
    seen.add(id);
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, [BLOCK_ID_ATTR]: id });
  }
  // Not an undoable edit of its own: pressing undo after typing should undo the
  // typing, not peel an id off the paragraph it created.
  tr.setMeta('addToHistory', false);
  tr.setMeta(blockIdPluginKey, true);
  return tr;
}

/**
 * Development-time guard against BLOCK_ID_TYPES falling behind the schema.
 *
 * A new block node added without touching that list would not throw, would not
 * fail a test, and would not look wrong on screen — it would just quietly never
 * be addressable, and the first symptom would be a cache that cannot sync it.
 * So the schema is asked directly, once, at editor creation.
 */
function warnUnstampedTypes(schema) {
  const missing = [];
  for (const [name, type] of Object.entries(schema.nodes)) {
    // `group: 'block'` is what makes a node placeable at the top level of a
    // document, which is exactly the set page_blocks stores.
    if (!type.spec.group?.split(' ').includes('block')) continue;
    if (!(BLOCK_ID_ATTR in (type.spec.attrs || {}))) missing.push(name);
  }
  if (missing.length) {
    console.warn(
      `blockId: these block nodes carry no id and cannot be addressed by ` +
        `page_blocks, the delta sync or block-scoped embedding: ${missing.join(', ')}. ` +
        `Add them to BLOCK_ID_TYPES in client/src/editor/blockId.js.`
    );
  }
}

export const BlockId = Extension.create({
  name: 'blockId',

  addOptions() {
    return { types: BLOCK_ID_TYPES };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          [BLOCK_ID_ATTR]: {
            default: null,
            // Splitting a paragraph with Enter creates a *new* block, which
            // must get its own id. The TipTap default of keeping the attribute
            // would hand both halves the same name.
            keepOnSplit: false,
            // Rendered into the DOM so the id survives the HTML round trip
            // ProseMirror uses for copy/paste and for tiptap-markdown.
            parseHTML: (element) => element.getAttribute(BLOCK_ID_DATA_ATTR),
            renderHTML: (attributes) =>
              attributes[BLOCK_ID_ATTR] ? { [BLOCK_ID_DATA_ATTR]: attributes[BLOCK_ID_ATTR] } : {},
          },
        },
      },
    ];
  },

  onCreate() {
    if (import.meta.env?.DEV) warnUnstampedTypes(this.editor.schema);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdPluginKey,
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // Never stamp on behalf of someone else. A remote Yjs update has
          // already been stamped by the client that made it, and having every
          // connected browser race to name the same new paragraph would put a
          // burst of competing attribute writes into the CRDT for no gain.
          if (transactions.some((tr) => tr.getMeta(ySyncPluginKey) || tr.getMeta(blockIdPluginKey))) {
            return null;
          }
          if (!this.editor.isEditable) return null;
          return stampMissingIds(newState);
        },
      }),
    ];
  },
});

/**
 * Every top-level block id in a document, in document order.
 *
 * Shared with the save path so the client can tell the server which blocks it
 * believes the document contains.
 */
export function topLevelBlockIds(doc) {
  const ids = [];
  for (const node of Array.isArray(doc?.content) ? doc.content : []) {
    const id = node?.attrs?.[BLOCK_ID_ATTR];
    if (id) ids.push(id);
  }
  return ids;
}
