// The ProseMirror side of code-block linting.
//
// The single hard rule, and the reason this is a plugin rather than a NodeView
// concern: **decorations only**. The editor runs `Collaboration`, so any
// transaction that changes the document is a Yjs update — it syncs to every
// peer, lands in the page's version history, and two people editing the same
// block would fight over whose diagnostics win. A decoration exists in one
// browser's view and nowhere else, which is exactly what a diagnostic is.
//
// The only transactions this plugin ever dispatches carry a meta and no doc
// change, and are marked `addToHistory: false` so they cannot appear in an undo
// stack either.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { LINT_DEBOUNCE_MS, LintTracker, byteLength, decorationRanges, lintSkipReason } from './lintState.js';

export const lintPluginKey = new PluginKey('codeLint');

// Sent when the workspace toggle or the per-user preference changes. The plugin
// re-reads its settings from the meta rather than from a closure, so flipping a
// switch takes effect in an editor that is already open — no reload.
export const LINT_SETTINGS_META = 'codeLintSettings';

// Sent by the NodeView when a block scrolls into or out of view, so an
// offscreen block is never parsed.
export const LINT_VISIBILITY_META = 'codeLintVisibility';

const idle = (fn) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 0);

/** Every codeBlock in the document, with its position, id and text. */
export function codeBlocks(doc) {
  const found = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true;
    found.push({
      pos,
      id: node.attrs.blockId || `pos:${pos}`,
      language: node.attrs.language || '',
      code: node.textContent,
    });
    // Nothing inside a code block is worth descending into.
    return false;
  });
  return found;
}

/**
 * Spawn the worker lazily, and respawn it after it has idled out.
 *
 * Held per plugin instance rather than per module: two editors open at once
 * (the page and a share preview) should not share one queue.
 */
function makeWorkerHandle(onMessage) {
  let worker = null;
  return {
    post(message) {
      if (!worker) {
        try {
          worker = new Worker(new URL('./lintWorker.js', import.meta.url), { type: 'module' });
        } catch {
          // No worker support, or a bundler that could not build one. Linting
          // simply does not happen; highlighting is unaffected.
          return;
        }
        worker.onmessage = (event) => {
          if (event.data?.type === 'idle') {
            worker = null;
            return;
          }
          onMessage(event.data);
        };
        worker.onerror = () => { worker = null; };
      }
      worker.postMessage(message);
    },
    stop() {
      worker?.terminate();
      worker = null;
    },
  };
}

const decorationFor = ({ from, to, severity, message, source }) =>
  Decoration.inline(from, to, {
    class: `gd-lint gd-lint-${severity}`,
    // Read by the NodeView's problem list and by the title tooltip; nothing
    // about it reaches the document.
    title: source ? `${message} (${source})` : message,
  });

/**
 * @param options.getSettings () => { linting, maxBytes } — read fresh on every
 *   pass, so the workspace SSE update needs no plugin surgery.
 */
export function CodeLintPlugin({ getSettings }) {
  const tracker = new LintTracker();
  // blockId -> boolean. Absent means "assume visible": a block whose NodeView
  // has not reported yet is usually the one being typed in.
  const visibility = new Map();
  let view = null;
  let timer = null;
  let settings = getSettings();

  const worker = makeWorkerHandle((reply) => {
    if (!tracker.accept(reply)) return;
    if (!view) return;
    // A no-op transaction whose only job is to make the plugin recompute its
    // DecorationSet. No doc change, no history entry, nothing for Yjs to sync.
    const tr = view.state.tr.setMeta(lintPluginKey, { repaint: true });
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  });

  const build = (doc) => {
    const decorations = [];
    for (const block of codeBlocks(doc)) {
      const results = tracker.results(block.id);
      if (!results.length) continue;
      for (const range of decorationRanges({
        nodePos: block.pos,
        textLength: block.code.length,
        diagnostics: results,
      })) {
        decorations.push(decorationFor(range));
      }
    }
    return DecorationSet.create(doc, decorations);
  };

  const scan = () => {
    if (!view) return;
    const { linting, maxBytes } = settings;
    const blocks = codeBlocks(view.state.doc);
    tracker.retain(blocks.map((b) => b.id));
    if (!linting) return;
    for (const block of blocks) {
      const skip = lintSkipReason({
        enabled: true,
        language: block.language,
        bytes: byteLength(block.code),
        maxBytes,
        visible: visibility.get(block.id) !== false,
      });
      if (skip) {
        // A block that has become unlintable — language changed, grew past the
        // cap — must lose the squiggles it had, not keep them forever.
        if (tracker.results(block.id).length) tracker.forget(block.id);
        continue;
      }
      const request = tracker.request(block);
      if (request) worker.post(request);
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle(scan), LINT_DEBOUNCE_MS);
  };

  return new Plugin({
    key: lintPluginKey,

    state: {
      init: () => DecorationSet.empty,
      apply(tr, old, _oldState, newState) {
        const patch = tr.getMeta(LINT_SETTINGS_META);
        if (patch) {
          settings = { ...settings, ...patch };
          if (!settings.linting) {
            // Turning checking off clears every diagnostic in this browser
            // immediately, which is the acceptance criterion: no reload.
            tracker.clear();
            worker.stop();
            return DecorationSet.empty;
          }
          schedule();
          return build(newState.doc);
        }

        const seen = tr.getMeta(LINT_VISIBILITY_META);
        if (seen) {
          visibility.set(seen.blockId, seen.visible);
          if (seen.visible) schedule();
        }

        if (tr.getMeta(lintPluginKey)?.repaint) return build(newState.doc);
        if (!tr.docChanged) return old;
        schedule();
        // Map the existing set through the change so squiggles track the text
        // they were put under until the next pass replaces them.
        return old.map(tr.mapping, tr.doc);
      },
    },

    props: {
      decorations(state) {
        return lintPluginKey.getState(state);
      },
    },

    view(editorView) {
      view = editorView;
      settings = getSettings();
      if (settings.linting) schedule();
      return {
        destroy() {
          clearTimeout(timer);
          worker.stop();
          tracker.clear();
          view = null;
        },
      };
    },
  });
}

/** Push new settings into a live editor. Called from Editor.jsx on an SSE update. */
export function setLintSettings(editor, settings) {
  if (!editor?.view) return;
  const tr = editor.view.state.tr.setMeta(LINT_SETTINGS_META, settings);
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

/** Called by the NodeView's IntersectionObserver. */
export function reportVisibility(editor, blockId, visible) {
  if (!editor?.view || !blockId) return;
  const tr = editor.view.state.tr.setMeta(LINT_VISIBILITY_META, { blockId, visible });
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
