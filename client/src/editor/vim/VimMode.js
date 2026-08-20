import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { focusFileTree, requestSave } from '../../lib/vimFocus.js';

/**
 * Modal editing for the document, for people who set their emulation to vim.
 *
 * This is a hand-rolled subset rather than a full vim: the document is a
 * ProseMirror tree, not a buffer of lines, so anything that thinks in byte
 * offsets does not survive the translation. What is here are the motions,
 * operators and mode switches that get used constantly — the rest of vim is
 * absent rather than half-working, which is easier to trust.
 *
 * Supported in normal mode:
 *   motions      h j k l w b e 0 ^ $ gg G  (all take a count)
 *   operators    d c y  over any motion, doubled for the whole line (dd cc yy)
 *   edits        x p P u Ctrl+R
 *   insert       i a I A o O
 *   visual       v  — motions extend, then d c y
 *   command      :w  :q  :q!  :wq  :x
 */
export const vimPluginKey = new PluginKey('vimMode');

// Vim's unnamed register. Module scope so a yank survives switching pages.
let register = { text: '', linewise: false };

const OPERATORS = new Set(['d', 'c', 'y']);

const clamp = (pos, doc) => Math.max(0, Math.min(pos, doc.content.size));

/** '' for a position that is not a text character (block edge, atom node). */
export function charAt(doc, pos) {
  if (pos < 0 || pos >= doc.content.size) return '';
  return doc.textBetween(pos, pos + 1, '', '');
}

/** 0 = whitespace, 1 = word character, 2 = punctuation — vim's three classes. */
function charClass(ch) {
  if (!ch || /\s/.test(ch)) return 0;
  return /[\wÀ-￿]/.test(ch) ? 1 : 2;
}

export function wordForward(doc, pos) {
  const max = doc.content.size;
  let p = pos;
  const cls = charClass(charAt(doc, p));
  if (cls !== 0) while (p < max && charClass(charAt(doc, p)) === cls) p += 1;
  while (p < max && charClass(charAt(doc, p)) === 0) p += 1;
  return p;
}

export function wordBackward(doc, pos) {
  let p = pos - 1;
  while (p > 0 && charClass(charAt(doc, p)) === 0) p -= 1;
  const cls = charClass(charAt(doc, p));
  if (cls === 0) return Math.max(p, 0);
  while (p > 0 && charClass(charAt(doc, p - 1)) === cls) p -= 1;
  return Math.max(p, 0);
}

export function wordEnd(doc, pos) {
  const max = doc.content.size;
  let p = pos + 1;
  while (p < max && charClass(charAt(doc, p)) === 0) p += 1;
  const cls = charClass(charAt(doc, p));
  while (p + 1 < max && charClass(charAt(doc, p + 1)) === cls) p += 1;
  return Math.min(p, max);
}

const isTextblock = ($p) => $p.parent.isTextblock;
const lineStart = ($p) => (isTextblock($p) ? $p.start() : $p.pos);
const lineEnd = ($p) => (isTextblock($p) ? $p.end() : $p.pos);

function firstNonBlank(doc, $p) {
  const start = lineStart($p);
  const end = lineEnd($p);
  let p = start;
  while (p < end && charClass(charAt(doc, p)) === 0) p += 1;
  return p;
}

/**
 * j/k. Vim moves by screen line and so do we: walking the document tree would
 * treat a wrapped paragraph as one line, which is not what the cursor looks
 * like it is doing. Probe downward/upward by coordinates until we land on a
 * different visual line, stepping far enough to clear an image or table.
 */
function verticalMove(view, pos, dir) {
  let coords;
  try {
    coords = view.coordsAtPos(pos);
  } catch {
    return null;
  }
  const dom = view.domAtPos(pos)?.node;
  const el = dom?.nodeType === 3 ? dom.parentElement : dom;
  const styleHeight = el ? parseFloat(getComputedStyle(el).lineHeight) : NaN;
  const lh = Number.isFinite(styleHeight) && styleHeight > 0
    ? styleHeight
    : Math.max(coords.bottom - coords.top, 16);
  const step = Math.max(4, lh / 2);
  let y = dir > 0 ? coords.bottom + step : coords.top - step;
  for (let i = 0; i < 24; i += 1) {
    const hit = view.posAtCoords({ left: coords.left, top: y });
    if (hit) {
      try {
        if (Math.abs(view.coordsAtPos(hit.pos).top - coords.top) > 2) return hit.pos;
      } catch {
        /* position vanished under us — keep probing */
      }
    }
    y += dir * step;
  }
  return null;
}

/** The block range covering the cursor's line plus `count - 1` lines below. */
function lineRange(state, count) {
  const $from = state.selection.$from;
  const depth = isTextblock($from) ? $from.depth : Math.max($from.depth, 1);
  let from = $from.before(depth);
  let to = $from.after(depth);
  for (let i = 1; i < count; i += 1) {
    if (to >= state.doc.content.size) break;
    const $next = state.doc.resolve(Math.min(to + 1, state.doc.content.size));
    const nextDepth = isTextblock($next) ? $next.depth : Math.max($next.depth, 1);
    to = $next.after(nextDepth);
  }
  return { from, to };
}

export const VimMode = Extension.create({
  name: 'vimMode',
  // Ahead of StarterKit so normal-mode keys are swallowed before the ordinary
  // editing keymap ever sees them.
  priority: 1000,

  addProseMirrorPlugins() {
    const editor = this.editor;

    const setState = (view, patch) => {
      view.dispatch(view.state.tr.setMeta(vimPluginKey, patch));
    };

    const toNormal = (view, extra = {}) => {
      const { state } = view;
      const tr = state.tr.setMeta(vimPluginKey, {
        mode: 'normal', operator: null, count: '', prefix: null, command: null, ...extra,
      });
      if (!state.selection.empty) {
        tr.setSelection(TextSelection.create(state.doc, state.selection.from));
      }
      view.dispatch(tr);
    };

    const moveTo = (view, pos, extend) => {
      const { state } = view;
      const $to = state.doc.resolve(clamp(pos, state.doc));
      const selection = extend
        ? TextSelection.between(state.selection.$anchor, $to)
        : Selection.near($to, 1);
      view.dispatch(
        state.tr
          .setSelection(selection)
          .setMeta(vimPluginKey, { count: '', prefix: null })
          .scrollIntoView()
      );
    };

    const yankRange = (view, from, to, linewise) => {
      register = {
        text: view.state.doc.textBetween(from, to, '\n', ''),
        linewise,
      };
    };

    const applyOperator = (view, operator, from, to, linewise) => {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      if (hi <= lo) {
        toNormal(view);
        return;
      }
      yankRange(view, lo, hi, linewise);
      if (operator === 'y') {
        const { state } = view;
        view.dispatch(
          state.tr
            .setSelection(Selection.near(state.doc.resolve(clamp(lo, state.doc)), 1))
            .setMeta(vimPluginKey, {
              mode: 'normal', operator: null, count: '', prefix: null,
            })
        );
        return;
      }
      const tr = view.state.tr.delete(lo, hi);
      tr.setSelection(Selection.near(tr.doc.resolve(clamp(lo, tr.doc)), 1));
      tr.setMeta(vimPluginKey, {
        mode: operator === 'c' ? 'insert' : 'normal',
        operator: null, count: '', prefix: null,
      });
      view.dispatch(tr.scrollIntoView());
    };

    const paste = (view, before) => {
      if (!register.text) return;
      const { state } = view;
      const $from = state.selection.$from;
      if (register.linewise) {
        const at = before ? lineStart($from) - 1 : lineEnd($from) + 1;
        const node = state.schema.nodes.paragraph.create(
          null,
          register.text ? state.schema.text(register.text.replace(/\n+$/, '')) : null
        );
        const pos = clamp(at, state.doc);
        const tr = state.tr.insert(pos, node);
        tr.setSelection(Selection.near(tr.doc.resolve(clamp(pos + 1, tr.doc)), 1));
        view.dispatch(tr.scrollIntoView());
        return;
      }
      const at = clamp(before ? state.selection.from : Math.min(state.selection.from + 1, lineEnd($from)), state.doc);
      const tr = state.tr.insertText(register.text, at);
      tr.setSelection(TextSelection.create(tr.doc, clamp(at + register.text.length - 1, tr.doc)));
      view.dispatch(tr.scrollIntoView());
    };

    const runCommand = (view, raw) => {
      const cmd = raw.trim().replace(/^:+/, '').toLowerCase();
      const leave = () => {
        view.dom.blur();
        focusFileTree();
      };
      if (cmd === 'w' || cmd === 'write') {
        requestSave();
        toNormal(view, { message: 'written' });
      } else if (cmd === 'q' || cmd === 'q!' || cmd === 'quit' || cmd === 'quit!') {
        toNormal(view);
        leave();
      } else if (cmd === 'wq' || cmd === 'x' || cmd === 'wq!') {
        requestSave();
        toNormal(view);
        leave();
      } else if (!cmd) {
        toNormal(view);
      } else {
        toNormal(view, { message: `E492: Not an editor command: ${cmd}` });
      }
    };

    /**
     * A motion resolved against the current cursor. Returns the target
     * position, plus whether an operator over it should act on whole lines.
     */
    const resolveMotion = (view, key, count, prefix) => {
      const { state } = view;
      const doc = state.doc;
      const pos = state.selection.head;
      const $pos = doc.resolve(pos);
      const repeat = (fn) => {
        let p = pos;
        for (let i = 0; i < count; i += 1) p = fn(p);
        return p;
      };
      switch (key) {
        case 'h':
        case 'ArrowLeft':
          return { to: Math.max(pos - count, lineStart($pos)) };
        case 'l':
        case ' ':
        case 'ArrowRight':
          return { to: Math.min(pos + count, lineEnd($pos)) };
        case 'j':
        case 'ArrowDown':
        case 'Enter': {
          let p = pos;
          for (let i = 0; i < count; i += 1) {
            const next = verticalMove(view, p, 1);
            if (next == null) break;
            p = next;
          }
          return { to: p, linewise: true };
        }
        case 'k':
        case 'ArrowUp': {
          let p = pos;
          for (let i = 0; i < count; i += 1) {
            const next = verticalMove(view, p, -1);
            if (next == null) break;
            p = next;
          }
          return { to: p, linewise: true };
        }
        case 'w':
          return { to: repeat((p) => wordForward(doc, p)) };
        case 'b':
          return { to: repeat((p) => wordBackward(doc, p)) };
        case 'e':
          return { to: repeat((p) => wordEnd(doc, p)), inclusive: true };
        case '0':
          return { to: lineStart($pos) };
        case '^':
          return { to: firstNonBlank(doc, $pos) };
        case '$':
          return { to: lineEnd($pos), inclusive: true };
        case 'G':
          return { to: doc.content.size, linewise: true };
        case 'g':
          return prefix === 'g' ? { to: 0, linewise: true } : null;
        default:
          return null;
      }
    };

    return [
      new Plugin({
        key: vimPluginKey,

        state: {
          init: () => ({
            mode: 'normal', operator: null, count: '', prefix: null, command: null, message: '',
          }),
          apply(tr, value) {
            const patch = tr.getMeta(vimPluginKey);
            if (!patch) return value;
            return { ...value, message: '', ...patch };
          },
        },

        props: {
          // A visible reminder of which mode you are in, on the editor element.
          attributes: (state) => {
            const vim = vimPluginKey.getState(state);
            return { class: `gd-vim gd-vim-${vim?.mode || 'normal'}` };
          },

          // Nothing types its way into the document outside insert mode — not
          // through the keyboard, not through IME composition.
          handleTextInput(view) {
            const vim = vimPluginKey.getState(view.state);
            return vim.mode !== 'insert';
          },

          // The block cursor. ProseMirror's caret is a line between two
          // characters; normal mode is meant to sit *on* one.
          decorations(state) {
            const vim = vimPluginKey.getState(state);
            if (!vim || vim.mode === 'insert' || !state.selection.empty) return null;
            const pos = state.selection.head;
            const $pos = state.doc.resolve(pos);
            if (pos >= lineEnd($pos) || !charAt(state.doc, pos)) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(pos, pos + 1, { class: 'gd-vim-block-cursor' }),
            ]);
          },

          handleKeyDown(view, event) {
            const vim = vimPluginKey.getState(view.state);
            if (!vim) return false;
            const { key } = event;

            if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return false;

            if (vim.mode === 'command') {
              if (key === 'Escape') { toNormal(view); return true; }
              if (key === 'Enter') { runCommand(view, vim.command || ''); return true; }
              if (key === 'Backspace') {
                const next = (vim.command || '').slice(0, -1);
                if (!next) toNormal(view);
                else setState(view, { command: next });
                return true;
              }
              if (key.length === 1 && !event.metaKey && !event.ctrlKey) {
                setState(view, { command: (vim.command || '') + key });
                return true;
              }
              return true;
            }

            if (key === 'Escape') {
              toNormal(view);
              return true;
            }

            if (vim.mode === 'insert') return false;

            // Ctrl+H / Ctrl+L belong to the focus jumps, so anything with a
            // modifier other than Shift goes back to the app — except Ctrl+R.
            if (event.metaKey || event.altKey) return false;
            if (event.ctrlKey) {
              if (key === 'r') { editor.commands.redo(); return true; }
              return false;
            }

            const visual = vim.mode === 'visual';
            const count = Math.max(1, parseInt(vim.count || '1', 10));

            // Counts: a leading 0 is the motion, later zeroes are digits.
            if (/^[0-9]$/.test(key) && !(key === '0' && !vim.count)) {
              setState(view, { count: (vim.count || '') + key });
              return true;
            }

            if (key === 'g' && vim.prefix !== 'g') {
              setState(view, { prefix: 'g' });
              return true;
            }

            // Operator pending: a second press of the same letter is linewise.
            if (!visual && OPERATORS.has(key)) {
              if (vim.operator === key) {
                const { from, to } = lineRange(view.state, count);
                applyOperator(view, key, from, to, true);
              } else {
                setState(view, { operator: key });
              }
              return true;
            }

            const motion = resolveMotion(view, key, count, vim.prefix);
            if (motion && motion.to != null) {
              const target = motion.inclusive ? motion.to + 1 : motion.to;
              if (vim.operator) {
                if (motion.linewise) {
                  const { from, to } = lineRange(view.state, count);
                  applyOperator(view, vim.operator, from, to, true);
                } else {
                  applyOperator(view, vim.operator, view.state.selection.head, target, false);
                }
              } else {
                moveTo(view, motion.to, visual);
              }
              return true;
            }

            switch (key) {
              case 'i':
                setState(view, { mode: 'insert', count: '', prefix: null, operator: null });
                return true;
              case 'a': {
                const $pos = view.state.doc.resolve(view.state.selection.head);
                moveTo(view, Math.min(view.state.selection.head + 1, lineEnd($pos)), false);
                setState(view, { mode: 'insert' });
                return true;
              }
              case 'I': {
                const $pos = view.state.doc.resolve(view.state.selection.head);
                moveTo(view, firstNonBlank(view.state.doc, $pos), false);
                setState(view, { mode: 'insert' });
                return true;
              }
              case 'A': {
                const $pos = view.state.doc.resolve(view.state.selection.head);
                moveTo(view, lineEnd($pos), false);
                setState(view, { mode: 'insert' });
                return true;
              }
              case 'o': {
                const $pos = view.state.doc.resolve(view.state.selection.head);
                moveTo(view, lineEnd($pos), false);
                editor.commands.splitBlock();
                setState(view, { mode: 'insert' });
                return true;
              }
              case 'O': {
                const $pos = view.state.doc.resolve(view.state.selection.head);
                const start = lineStart($pos);
                moveTo(view, start, false);
                editor.commands.splitBlock();
                moveTo(view, start, false);
                setState(view, { mode: 'insert' });
                return true;
              }
              case 'v':
                if (visual) toNormal(view);
                else setState(view, { mode: 'visual', count: '', prefix: null });
                return true;
              case 'x': {
                const { state } = view;
                if (visual) {
                  applyOperator(view, 'd', state.selection.from, state.selection.to, false);
                  return true;
                }
                const $pos = state.doc.resolve(state.selection.head);
                const to = Math.min(state.selection.head + count, lineEnd($pos));
                applyOperator(view, 'd', state.selection.head, to, false);
                return true;
              }
              case 'd':
              case 'c':
              case 'y':
                // Visual mode: the operator acts on the highlighted range.
                if (visual) {
                  const { from, to } = view.state.selection;
                  applyOperator(view, key, from, to, false);
                }
                return true;
              case 'p':
                paste(view, false);
                return true;
              case 'P':
                paste(view, true);
                return true;
              case 'u':
                editor.commands.undo();
                return true;
              case ':':
                setState(view, { mode: 'command', command: '', count: '', prefix: null, operator: null });
                return true;
              case 'Backspace':
                moveTo(view, Math.max(view.state.selection.head - count, 0), visual);
                return true;
              default:
                // Everything else is swallowed: an unbound key in normal mode
                // must never fall through and type itself into the document.
                if (key.length === 1) {
                  setState(view, { count: '', prefix: null, operator: null });
                  return true;
                }
                return false;
            }
          },
        },
      }),
    ];
  },
});

export default VimMode;
