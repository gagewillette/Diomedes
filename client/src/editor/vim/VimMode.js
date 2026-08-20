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
 *   motions      h j k l w W b B e E 0 ^ $ gg G { } % and f F t T with ; ,
 *                Ctrl+D Ctrl+U          (all take a count)
 *   operators    d c y  over any motion, doubled for the whole line (dd cc yy),
 *                and over the iw aw ip ap i" a" i( a( … text objects
 *   shorthands   D C Y S s x X r ~ J
 *   edits        p P u Ctrl+R
 *   insert       i a I A o O
 *   visual       v charwise, V linewise, o to swap ends, then d c y x p ~ J
 *   command      :w  :q  :q!  :wq  :x  :qa
 */
export const vimPluginKey = new PluginKey('vimMode');

// Vim's unnamed register. Module scope so a yank survives switching pages.
let register = { text: '', linewise: false };

const OPERATORS = new Set(['d', 'c', 'y']);

// f F t T wait for the character to search for; r waits for the replacement.
const CHAR_PENDING = new Set(['f', 'F', 't', 'T', 'r']);

const OPEN = '([{<';
const CLOSE = ')]}>';
const QUOTES = '"\'`';

// The bracket a text object is named after — `di(`, `di)` and `dib` are one
// object, the way vim spells them.
const OBJECT_PAIR = {
  '(': '()', ')': '()', b: '()',
  '[': '[]', ']': '[]',
  '{': '{}', '}': '{}', B: '{}',
  '<': '<>', '>': '<>',
};

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

/**
 * The WORD classes behind W B E: whitespace, or not. Folding punctuation in
 * with letters is the whole difference between `b` and `B` — `B` walks back
 * over `foo.bar(baz)` in one go where `b` stops at every bracket and dot.
 */
function bigClass(ch) {
  return charClass(ch) === 0 ? 0 : 1;
}

const classOf = (big) => (big ? bigClass : charClass);

export function wordForward(doc, pos, big = false) {
  const kind = classOf(big);
  const max = doc.content.size;
  let p = pos;
  const cls = kind(charAt(doc, p));
  if (cls !== 0) while (p < max && kind(charAt(doc, p)) === cls) p += 1;
  while (p < max && kind(charAt(doc, p)) === 0) p += 1;
  return p;
}

export function wordBackward(doc, pos, big = false) {
  const kind = classOf(big);
  let p = pos - 1;
  while (p > 0 && kind(charAt(doc, p)) === 0) p -= 1;
  const cls = kind(charAt(doc, p));
  if (cls === 0) return Math.max(p, 0);
  while (p > 0 && kind(charAt(doc, p - 1)) === cls) p -= 1;
  return Math.max(p, 0);
}

export function wordEnd(doc, pos, big = false) {
  const kind = classOf(big);
  const max = doc.content.size;
  let p = pos + 1;
  while (p < max && kind(charAt(doc, p)) === 0) p += 1;
  const cls = kind(charAt(doc, p));
  while (p + 1 < max && kind(charAt(doc, p + 1)) === cls) p += 1;
  return Math.min(p, max);
}

/** The span of the word (or WORD) the cursor is sitting in or just before. */
export function wordAt(doc, pos, big = false) {
  const kind = classOf(big);
  const max = doc.content.size;
  let start = pos;
  const cls = kind(charAt(doc, pos));
  while (start > 0 && kind(charAt(doc, start - 1)) === cls) start -= 1;
  let end = pos;
  while (end < max && kind(charAt(doc, end)) === cls) end += 1;
  return { from: start, to: end, blank: cls === 0 };
}

const isTextblock = ($p) => $p.parent.isTextblock;
const lineStart = ($p) => (isTextblock($p) ? $p.start() : $p.pos);
const lineEnd = ($p) => (isTextblock($p) ? $p.end() : $p.pos);

/**
 * Where a normal-mode cursor is allowed to rest. Vim's cursor sits *on* a
 * character, so it can never stop past the last one — and here it must not,
 * because the block cursor is a decoration over that character while the real
 * caret is transparent: a cursor at end-of-line has nothing to draw and simply
 * vanishes. `j` and `k` carry a goal column, so stepping into a shorter line —
 * a heading, usually — lands exactly there. So do `$`, `x` on the final
 * character, and Escape out of insert at the end of a line.
 */
export function eolCursor(pos, start, end) {
  if (end <= start) return start;
  return Math.min(Math.max(pos, start), end - 1);
}

/**
 * What the block cursor should be painted over: the character under `pos`, or,
 * on an empty line where there is no character at all, the empty slot itself —
 * which the decoration fills with a block of its own rather than drawing
 * nothing.
 */
export function blockCursorAt(doc, pos, start, end) {
  if (pos >= start && pos < end && charAt(doc, pos)) {
    return { type: 'char', from: pos, to: pos + 1 };
  }
  return { type: 'eol', at: Math.min(Math.max(pos, start), end) };
}

function firstNonBlank(doc, $p) {
  const start = lineStart($p);
  const end = lineEnd($p);
  let p = start;
  while (p < end && charClass(charAt(doc, p)) === 0) p += 1;
  return p;
}

/** f F t T, inside the cursor's own line the way vim keeps them. */
function findChar(doc, $p, pos, ch, dir, till, count) {
  const start = lineStart($p);
  const end = lineEnd($p);
  let p = pos;
  for (let n = 0; n < count; n += 1) {
    let q = p + dir;
    while (q >= start && q < end && charAt(doc, q) !== ch) q += dir;
    if (q < start || q >= end) return null;
    p = q;
  }
  return till ? p - dir : p;
}

/** % — the bracket at or after the cursor, and its partner. */
function matchPair(doc, $p, pos) {
  const end = lineEnd($p);
  let p = pos;
  while (p < end && OPEN.indexOf(charAt(doc, p)) < 0 && CLOSE.indexOf(charAt(doc, p)) < 0) p += 1;
  if (p >= end) return null;
  const ch = charAt(doc, p);
  const openIndex = OPEN.indexOf(ch);
  const dir = openIndex >= 0 ? 1 : -1;
  const partner = dir > 0 ? CLOSE[openIndex] : OPEN[CLOSE.indexOf(ch)];
  const max = doc.content.size;
  let depth = 0;
  for (let q = p; q >= 0 && q < max; q += dir) {
    const c = charAt(doc, q);
    if (c === ch) depth += 1;
    else if (c === partner) {
      depth -= 1;
      if (depth === 0) return q;
    }
  }
  return null;
}

/** The pair of `open`/`close` surrounding the cursor, if any. */
function surrounding(doc, $p, pos, open, close) {
  const start = open === close ? lineStart($p) : 0;
  const stop = open === close ? lineEnd($p) : doc.content.size;
  let from = -1;
  let depth = 0;
  for (let q = pos; q >= start; q -= 1) {
    const c = charAt(doc, q);
    if (c === close && q !== pos && open !== close) depth += 1;
    else if (c === open) {
      if (depth === 0) { from = q; break; }
      depth -= 1;
    }
  }
  if (from < 0) return null;
  depth = 0;
  for (let q = from + 1; q < stop; q += 1) {
    const c = charAt(doc, q);
    if (c === open && open !== close) depth += 1;
    else if (c === close) {
      if (depth === 0) return { from, to: q + 1 };
      depth -= 1;
    }
  }
  return null;
}

/**
 * j/k. Vim moves by screen line and so do we: walking the document tree would
 * treat a wrapped paragraph as one line, which is not what the cursor looks
 * like it is doing. Probe downward/upward by coordinates until we land on text
 * whose own line box is clear of the one we started on.
 *
 * The catch, and the reason `k` used to do nothing at all: the gap between two
 * blocks belongs to neither, so a probe that lands in a paragraph margin comes
 * back as the *boundary* position between them rather than a position on
 * either line. Resolving that boundary forward — which is what
 * `Selection.near(pos, 1)` does — drops the cursor at the start of the block
 * below it. Going down that only cost you the column; going up it handed back
 * the very line you were leaving, so `k` from the start of a line was a no-op
 * and the cursor could never climb. Every hit is therefore resolved in the
 * direction of travel, and only accepted once its line box is clear of the one
 * we started on.
 */
function verticalMove(view, pos, dir, goalLeft) {
  const doc = view.state.doc;
  let coords;
  try {
    coords = view.coordsAtPos(pos);
  } catch {
    return null;
  }
  const left = Number.isFinite(goalLeft) ? goalLeft : coords.left;
  const dom = view.domAtPos(pos)?.node;
  const el = dom?.nodeType === 3 ? dom.parentElement : dom;
  const styleHeight = el ? parseFloat(getComputedStyle(el).lineHeight) : NaN;
  const lh = Number.isFinite(styleHeight) && styleHeight > 0
    ? styleHeight
    : Math.max(coords.bottom - coords.top, 16);
  const step = Math.max(3, lh / 3);

  // A boundary between blocks is not a place the cursor can sit; take the
  // nearest text position on the side we are heading towards.
  const snap = (p) => {
    const $p = doc.resolve(clamp(p, doc));
    if (isTextblock($p)) return $p.pos;
    return Selection.near($p, dir).head;
  };

  let y = dir > 0 ? coords.bottom + step : coords.top - step;
  for (let i = 0; i < 48; i += 1) {
    const hit = view.posAtCoords({ left, top: y });
    if (hit) {
      try {
        const landed = snap(hit.pos);
        const box = view.coordsAtPos(landed);
        const clear = dir > 0 ? box.top >= coords.bottom - 1 : box.bottom <= coords.top + 1;
        if (landed !== pos && clear) {
          // We know which line we want; ask it for the goal column directly,
          // rather than keeping whichever edge the margin probe happened to
          // resolve to.
          const aimed = view.posAtCoords({ left, top: (box.top + box.bottom) / 2 });
          if (aimed) {
            const refined = snap(aimed.pos);
            if (refined !== pos && Math.abs(view.coordsAtPos(refined).top - box.top) <= 2) {
              return refined;
            }
          }
          return landed;
        }
      } catch {
        /* position vanished under us — keep probing */
      }
    }
    y += dir * step;
  }
  return null;
}

/**
 * Same column, one block up or down. The geometry probe comes up empty when
 * the cursor is off-screen or sitting under the sticky page header, and a `k`
 * that silently does nothing is worse than one that moves by a paragraph.
 */
function blockMove(state, pos, dir) {
  const doc = state.doc;
  const $pos = doc.resolve(clamp(pos, doc));
  if (!isTextblock($pos)) return null;
  const col = pos - $pos.start();
  const edge = dir > 0 ? $pos.after($pos.depth) : $pos.before($pos.depth);
  const probe = dir > 0 ? edge + 1 : edge - 1;
  if (probe < 0 || probe > doc.content.size) return null;
  const near = Selection.near(doc.resolve(clamp(probe, doc)), dir);
  const $to = near.$head;
  if (!isTextblock($to)) return $to.pos;
  return Math.min($to.start() + col, $to.end());
}

/** { and } — the start of the previous / next block. */
function blockEdge(state, pos, dir) {
  const doc = state.doc;
  const $pos = doc.resolve(clamp(pos, doc));
  if (!isTextblock($pos)) return dir > 0 ? doc.content.size : 0;
  // `{` from mid-block goes to the top of this block first, as vim does.
  if (dir < 0 && pos > lineStart($pos)) return lineStart($pos);
  const stepped = blockMove(state, dir < 0 ? lineStart($pos) : lineEnd($pos), dir);
  if (stepped == null) return dir > 0 ? doc.content.size : 0;
  return lineStart(doc.resolve(clamp(stepped, doc)));
}

/** The block range covering the cursor's line plus `count - 1` lines below. */
function lineRange(state, count, at) {
  const $from = at == null ? state.selection.$from : state.doc.resolve(clamp(at, state.doc));
  const depth = isTextblock($from) ? $from.depth : Math.max($from.depth, 1);
  const from = $from.before(depth);
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

    // Every command that is not a j/k lands here: the goal column only
    // survives an unbroken run of vertical motions, exactly as in vim.
    const CLEARED = {
      count: '', prefix: null, pending: null, object: null, goalLeft: null,
    };

    const setState = (view, patch) => {
      view.dispatch(view.state.tr.setMeta(vimPluginKey, patch));
    };

    // Pull a position back onto the line's last character, so a normal-mode
    // cursor never rests where there is nothing to draw it on.
    const restingPos = (doc, pos) => {
      const $p = doc.resolve(clamp(pos, doc));
      if (!isTextblock($p)) return $p.pos;
      return eolCursor($p.pos, $p.start(), $p.end());
    };

    const toNormal = (view, extra = {}) => {
      const { state } = view;
      const tr = state.tr.setMeta(vimPluginKey, {
        mode: 'normal', operator: null, command: null, linewise: false,
        vanchor: null, vhead: null, ...CLEARED, ...extra,
      });
      const at = restingPos(state.doc, state.selection.empty
        ? state.selection.head
        : state.selection.from);
      if (!state.selection.empty || at !== state.selection.head) {
        tr.setSelection(TextSelection.create(state.doc, at));
      }
      view.dispatch(tr);
    };

    // `eol` is for the handful of commands that land on end-of-line on purpose
    // because insert mode is about to open there — a A o — where vim's
    // last-character rule does not apply.
    const moveTo = (view, pos, extend, extra = {}, { eol = false } = {}) => {
      const { state } = view;
      const vim = vimPluginKey.getState(state);
      const $to = state.doc.resolve(eol ? clamp(pos, state.doc) : restingPos(state.doc, pos));
      let selection;
      if (extend && vim?.linewise) {
        // V: the highlight always covers whole blocks, but the cursor we move
        // from is tracked separately so `k` still steps a line at a time.
        const $anchor = state.doc.resolve(clamp(vim.vanchor ?? state.selection.anchor, state.doc));
        const lo = Math.min(lineStart($anchor), lineStart($to));
        const hi = Math.max(lineEnd($anchor), lineEnd($to));
        selection = TextSelection.create(state.doc, lo, hi);
      } else if (extend) {
        selection = TextSelection.between(state.selection.$anchor, $to);
      } else {
        selection = Selection.near($to, 1);
      }
      view.dispatch(
        state.tr
          .setSelection(selection)
          .setMeta(vimPluginKey, {
            ...CLEARED, ...extra, ...(extend && vim?.linewise ? { vhead: $to.pos } : {}),
          })
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
            .setSelection(Selection.near(state.doc.resolve(restingPos(state.doc, lo)), 1))
            .setMeta(vimPluginKey, {
              mode: 'normal', operator: null, linewise: false, vanchor: null, vhead: null, ...CLEARED,
            })
        );
        return;
      }
      const tr = view.state.tr.delete(lo, hi);
      tr.setSelection(Selection.near(
        tr.doc.resolve(operator === 'c' ? clamp(lo, tr.doc) : restingPos(tr.doc, lo)),
        1
      ));
      tr.setMeta(vimPluginKey, {
        mode: operator === 'c' ? 'insert' : 'normal',
        operator: null, linewise: false, vanchor: null, vhead: null, ...CLEARED,
      });
      view.dispatch(tr.scrollIntoView());
    };

    /** Visual mode's range: charwise vim includes the character under the cursor. */
    const visualRange = (view) => {
      const { state } = view;
      const vim = vimPluginKey.getState(state);
      const { from, to } = state.selection;
      if (vim?.linewise) {
        // Linewise takes the whole blocks, boundaries included, so `Vd` leaves
        // no empty paragraph behind where the line used to be.
        const head = lineRange(state, 1, from);
        const tail = lineRange(state, 1, to);
        return { from: Math.min(head.from, tail.from), to: Math.max(head.to, tail.to), linewise: true };
      }
      const $to = state.doc.resolve(clamp(to, state.doc));
      return { from, to: Math.min(to + 1, lineEnd($to)), linewise: false };
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
      const cmd = raw.trim().replace(/^:+/, '').replace(/\s+/g, '').toLowerCase();
      const leave = () => {
        view.dom.blur();
        focusFileTree();
      };
      if (/^w!?$|^write!?$/.test(cmd)) {
        requestSave();
        toNormal(view, { message: 'written' });
      } else if (/^(q|qa|qall|quit|quita|quitall)!?$/.test(cmd)) {
        toNormal(view);
        leave();
      } else if (/^(wq|wqa|xa|x|xit|exit)!?$/.test(cmd)) {
        requestSave();
        toNormal(view);
        leave();
      } else if (!cmd) {
        toNormal(view);
      } else {
        toNormal(view, { message: `E492: Not an editor command: ${cmd}` });
      }
    };

    /** iw aw ip ap i" a" i( a( … resolved against the cursor. */
    const resolveObject = (view, kind, key, count) => {
      const { state } = view;
      const doc = state.doc;
      const pos = state.selection.head;
      const $pos = doc.resolve(pos);
      const around = kind === 'a';
      if (key === 'w' || key === 'W') {
        const big = key === 'W';
        let { from, to } = wordAt(doc, pos, big);
        for (let i = 1; i < count; i += 1) to = wordForward(doc, to, big);
        if (around) {
          const max = doc.content.size;
          let end = to;
          while (end < max && charClass(charAt(doc, end)) === 0) end += 1;
          if (end === to) while (from > 0 && charClass(charAt(doc, from - 1)) === 0) from -= 1;
          to = end;
        }
        return { from, to };
      }
      if (key === 'p') {
        const { from, to } = lineRange(state, count);
        return around ? { from, to, linewise: true } : { from: lineStart($pos), to: lineEnd($pos) };
      }
      if (QUOTES.includes(key)) {
        const span = surrounding(doc, $pos, pos, key, key);
        if (!span) return null;
        return around ? span : { from: span.from + 1, to: span.to - 1 };
      }
      const pair = OBJECT_PAIR[key];
      if (pair) {
        const span = surrounding(doc, $pos, pos, pair[0], pair[1]);
        if (!span) return null;
        return around ? span : { from: span.from + 1, to: span.to - 1 };
      }
      return null;
    };

    /**
     * A motion resolved against the current cursor. Returns the target
     * position, plus whether an operator over it should act on whole lines.
     */
    const resolveMotion = (view, key, count, vim) => {
      const { state } = view;
      const doc = state.doc;
      // In linewise visual the selection covers whole blocks, so the position
      // to move from is the one we have been tracking, not the selection edge.
      const pos = vim.mode === 'visual' && vim.linewise && vim.vhead != null
        ? clamp(vim.vhead, doc)
        : state.selection.head;
      const $pos = doc.resolve(pos);
      const repeat = (fn) => {
        let p = pos;
        for (let i = 0; i < count; i += 1) p = fn(p);
        return p;
      };
      const vertical = (dir, times) => {
        let p = pos;
        let goal = vim.goalLeft;
        if (!Number.isFinite(goal)) {
          try { goal = view.coordsAtPos(pos).left; } catch { goal = null; }
        }
        for (let i = 0; i < times; i += 1) {
          const next = verticalMove(view, p, dir, goal) ?? blockMove(state, p, dir);
          if (next == null) break;
          p = next;
        }
        return { to: p, linewise: true, goalLeft: goal };
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
        case 'Enter':
          return vertical(1, count);
        case 'k':
        case 'ArrowUp':
          return vertical(-1, count);
        case 'w':
        case 'W':
          return { to: repeat((p) => wordForward(doc, p, key === 'W')) };
        case 'b':
        case 'B':
          return { to: repeat((p) => wordBackward(doc, p, key === 'B')) };
        case 'e':
        case 'E':
          return { to: repeat((p) => wordEnd(doc, p, key === 'E')), inclusive: true };
        case '0':
          return { to: lineStart($pos) };
        case '^':
          return { to: firstNonBlank(doc, $pos) };
        case '$':
          return { to: lineEnd($pos), inclusive: true };
        case '{':
          return { to: blockEdge(state, pos, -1), linewise: true };
        case '}':
          return { to: blockEdge(state, pos, 1), linewise: true };
        case '%': {
          const to = matchPair(doc, $pos, pos);
          return to == null ? null : { to, inclusive: true };
        }
        case 'G': {
          // A count is a line number: 5G goes to the fifth block.
          if (!vim.count) return { to: doc.content.size, linewise: true };
          let $at = doc.resolve(clamp(1, doc));
          for (let i = 1; i < count; i += 1) {
            const next = blockMove(state, $at.pos, 1);
            if (next == null) break;
            $at = doc.resolve(clamp(next, doc));
          }
          return { to: firstNonBlank(doc, $at), linewise: true };
        }
        case 'g':
          return vim.prefix === 'g' ? { to: 0, linewise: true } : null;
        default:
          return null;
      }
    };

    /** Half a screen of j/k, which is what Ctrl+D and Ctrl+U amount to here. */
    const halfPage = (view, dir) => {
      let p = view.state.selection.head;
      for (let i = 0; i < 10; i += 1) {
        const next = verticalMove(view, p, dir) ?? blockMove(view.state, p, dir);
        if (next == null) break;
        p = next;
      }
      moveTo(view, p, vimPluginKey.getState(view.state)?.mode === 'visual');
    };

    return [
      new Plugin({
        key: vimPluginKey,

        state: {
          init: () => ({
            mode: 'normal', operator: null, count: '', prefix: null, command: null, message: '',
            pending: null, object: null, lastFind: null, goalLeft: null,
            linewise: false, vanchor: null, vhead: null,
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
            if (!isTextblock($pos)) return null;
            const at = blockCursorAt(state.doc, pos, lineStart($pos), lineEnd($pos));
            if (at.type === 'char') {
              return DecorationSet.create(state.doc, [
                Decoration.inline(at.from, at.to, { class: 'gd-vim-block-cursor' }),
              ]);
            }
            // An empty line has no character to sit on, so the block is drawn
            // as a widget of its own rather than not at all.
            return DecorationSet.create(state.doc, [
              Decoration.widget(at.at, () => {
                const span = document.createElement('span');
                span.className = 'gd-vim-block-cursor gd-vim-block-cursor-empty';
                return span;
              }, { side: 1, key: 'gd-vim-eol-cursor' }),
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

            // Ctrl+[ is Escape, and always has been.
            if (key === 'Escape' || (event.ctrlKey && key === '[')) {
              toNormal(view);
              return true;
            }

            if (vim.mode === 'insert') return false;

            // Ctrl+H / Ctrl+L belong to the focus jumps, so anything with a
            // modifier other than Shift goes back to the app — except the few
            // control keys vim owns.
            if (event.metaKey || event.altKey) return false;
            if (event.ctrlKey) {
              if (key === 'r') { editor.commands.redo(); return true; }
              if (key === 'd') { event.preventDefault(); halfPage(view, 1); return true; }
              if (key === 'u') { event.preventDefault(); halfPage(view, -1); return true; }
              return false;
            }

            const visual = vim.mode === 'visual';
            const count = Math.max(1, parseInt(vim.count || '1', 10));
            const state = view.state;
            const head = visual && vim.linewise && vim.vhead != null
              ? clamp(vim.vhead, state.doc)
              : state.selection.head;
            const $head = state.doc.resolve(clamp(head, state.doc));

            // f F t T r are waiting for their argument.
            if (vim.pending) {
              if (key.length !== 1) { setState(view, CLEARED); return true; }
              if (vim.pending === 'r') {
                const to = Math.min(head + count, lineEnd($head));
                if (to > head) {
                  const tr = state.tr.insertText(key.repeat(to - head), head, to);
                  tr.setSelection(TextSelection.create(tr.doc, clamp(to - 1, tr.doc)));
                  tr.setMeta(vimPluginKey, CLEARED);
                  view.dispatch(tr);
                } else {
                  setState(view, CLEARED);
                }
                return true;
              }
              const dir = vim.pending === 'f' || vim.pending === 't' ? 1 : -1;
              const till = vim.pending === 't' || vim.pending === 'T';
              const to = findChar(state.doc, $head, head, key, dir, till, count);
              const lastFind = { key: vim.pending, char: key };
              if (to == null) { setState(view, { ...CLEARED, lastFind }); return true; }
              if (vim.operator) {
                applyOperator(view, vim.operator, head, dir > 0 ? to + 1 : to, false);
                setState(view, { lastFind });
              } else {
                moveTo(view, to, visual, { lastFind });
              }
              return true;
            }

            // The character after `di` / `ca` names the text object.
            if (vim.object) {
              const span = resolveObject(view, vim.object, key, count);
              if (!span) { setState(view, { ...CLEARED, operator: null }); return true; }
              applyOperator(view, vim.operator, span.from, span.to, !!span.linewise);
              return true;
            }

            // Counts: a leading 0 is the motion, later zeroes are digits.
            if (/^[0-9]$/.test(key) && !(key === '0' && !vim.count)) {
              setState(view, { count: (vim.count || '') + key });
              return true;
            }

            if (key === 'g' && vim.prefix !== 'g') {
              setState(view, { prefix: 'g' });
              return true;
            }

            if (CHAR_PENDING.has(key) && (key !== 'r' || !visual)) {
              setState(view, { pending: key });
              return true;
            }

            if (key === ';' || key === ',') {
              const last = vim.lastFind;
              if (!last) { setState(view, CLEARED); return true; }
              const forward = last.key === 'f' || last.key === 't';
              const dir = (key === ';' ? forward : !forward) ? 1 : -1;
              const till = last.key === 't' || last.key === 'T';
              const to = findChar(state.doc, $head, head, last.char, dir, till, count);
              if (to == null) { setState(view, CLEARED); return true; }
              if (vim.operator) applyOperator(view, vim.operator, head, dir > 0 ? to + 1 : to, false);
              else moveTo(view, to, visual);
              return true;
            }

            // Operator pending: a second press of the same letter is linewise.
            if (!visual && OPERATORS.has(key)) {
              if (vim.operator === key) {
                const { from, to } = lineRange(state, count);
                applyOperator(view, key, from, to, true);
              } else {
                setState(view, { operator: key });
              }
              return true;
            }

            if (vim.operator && (key === 'i' || key === 'a')) {
              setState(view, { object: key });
              return true;
            }

            const motion = resolveMotion(view, key, count, vim);
            if (motion && motion.to != null) {
              const target = motion.inclusive ? motion.to + 1 : motion.to;
              if (vim.operator) {
                if (motion.linewise) {
                  const lines = lineRange(state, 1, head);
                  const other = lineRange(state, 1, clamp(motion.to, state.doc));
                  applyOperator(
                    view,
                    vim.operator,
                    Math.min(lines.from, other.from),
                    Math.max(lines.to, other.to),
                    true
                  );
                } else {
                  applyOperator(view, vim.operator, head, target, false);
                }
              } else {
                moveTo(view, motion.to, visual, motion.goalLeft != null ? { goalLeft: motion.goalLeft } : {});
              }
              return true;
            }

            switch (key) {
              case 'i':
                setState(view, { mode: 'insert', ...CLEARED, operator: null });
                return true;
              case 'a':
                moveTo(view, Math.min(head + 1, lineEnd($head)), false, {}, { eol: true });
                setState(view, { mode: 'insert' });
                return true;
              case 'I':
                moveTo(view, firstNonBlank(state.doc, $head), false);
                setState(view, { mode: 'insert' });
                return true;
              case 'A':
                moveTo(view, lineEnd($head), false, {}, { eol: true });
                setState(view, { mode: 'insert' });
                return true;
              case 'o':
                // In visual mode `o` swaps which end the cursor is on.
                if (visual) {
                  const { anchor, head: h } = state.selection;
                  view.dispatch(
                    state.tr
                      .setSelection(TextSelection.create(state.doc, h, anchor))
                      .setMeta(vimPluginKey, CLEARED)
                  );
                  return true;
                }
                moveTo(view, lineEnd($head), false, {}, { eol: true });
                editor.commands.splitBlock();
                setState(view, { mode: 'insert' });
                return true;
              case 'O': {
                const start = lineStart($head);
                moveTo(view, start, false);
                editor.commands.splitBlock();
                moveTo(view, start, false);
                setState(view, { mode: 'insert' });
                return true;
              }
              case 'v':
                if (visual && !vim.linewise) toNormal(view);
                else setState(view, { mode: 'visual', linewise: false, vanchor: head, vhead: head, ...CLEARED });
                return true;
              case 'V':
                if (visual && vim.linewise) { toNormal(view); return true; }
                view.dispatch(
                  state.tr
                    .setSelection(TextSelection.create(state.doc, lineStart($head), lineEnd($head)))
                    .setMeta(vimPluginKey, {
                      mode: 'visual', linewise: true, vanchor: head, vhead: head, ...CLEARED,
                    })
                );
                return true;
              case 'x':
                if (visual) {
                  const range = visualRange(view);
                  applyOperator(view, 'd', range.from, range.to, range.linewise);
                  return true;
                }
                applyOperator(view, 'd', head, Math.min(head + count, lineEnd($head)), false);
                return true;
              case 'X':
                applyOperator(view, 'd', Math.max(head - count, lineStart($head)), head, false);
                return true;
              case 's':
                if (visual) {
                  const range = visualRange(view);
                  applyOperator(view, 'c', range.from, range.to, range.linewise);
                  return true;
                }
                applyOperator(view, 'c', head, Math.min(head + count, lineEnd($head)), false);
                return true;
              case 'S':
              case 'C':
              case 'D':
              case 'Y': {
                const operator = key === 'Y' ? 'y' : (key === 'D' ? 'd' : 'c');
                if (key === 'S' || key === 'Y') {
                  const { from, to } = lineRange(state, count);
                  applyOperator(view, operator, from, to, true);
                } else {
                  applyOperator(view, operator, head, lineEnd($head), false);
                }
                return true;
              }
              case 'd':
              case 'c':
              case 'y': {
                // Visual mode: the operator acts on the highlighted range.
                if (visual) {
                  const range = visualRange(view);
                  applyOperator(view, key, range.from, range.to, range.linewise);
                }
                return true;
              }
              case 'p':
              case 'P':
                if (visual) {
                  const range = visualRange(view);
                  const text = register.text;
                  const linewise = register.linewise;
                  applyOperator(view, 'd', range.from, range.to, range.linewise);
                  register = { text, linewise };
                  paste(view, true);
                  toNormal(view);
                  return true;
                }
                paste(view, key === 'P');
                return true;
              case '~': {
                const span = visual
                  ? visualRange(view)
                  : { from: head, to: Math.min(head + count, lineEnd($head)) };
                const { from, to } = span;
                if (to <= from) { setState(view, CLEARED); return true; }
                const text = state.doc.textBetween(from, to, '', '');
                const flipped = text.replace(/\p{L}/gu, (c) => (
                  c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
                ));
                const tr = state.tr.insertText(flipped, from, to);
                tr.setSelection(TextSelection.create(tr.doc, clamp(visual ? from : to, tr.doc)));
                tr.setMeta(vimPluginKey, {
                  mode: 'normal', linewise: false, vanchor: null, vhead: null, ...CLEARED,
                });
                view.dispatch(tr);
                return true;
              }
              case 'J': {
                // `3J` joins three lines, which is two joins.
                const joins = Math.max(1, count - 1);
                const tr = state.tr;
                let at = head;
                for (let i = 0; i < joins; i += 1) {
                  const $at = tr.doc.resolve(clamp(at, tr.doc));
                  if (!isTextblock($at)) break;
                  const end = lineEnd($at);
                  if (end + 1 >= tr.doc.content.size) break;
                  // end + 1 is the seam between the two blocks and belongs to
                  // neither, so step to the first text position past it.
                  const $next = Selection.near(tr.doc.resolve(clamp(end + 1, tr.doc)), 1).$head;
                  if (!isTextblock($next)) break;
                  const nextStart = lineStart($next);
                  if (nextStart <= end) break;
                  tr.delete(end, nextStart);
                  tr.insertText(' ', end);
                  at = end;
                }
                if (!tr.docChanged) { setState(view, CLEARED); return true; }
                tr.setSelection(TextSelection.create(tr.doc, clamp(at, tr.doc)));
                tr.setMeta(vimPluginKey, {
                  mode: 'normal', linewise: false, vanchor: null, vhead: null, ...CLEARED,
                });
                view.dispatch(tr.scrollIntoView());
                return true;
              }
              case 'u':
                editor.commands.undo();
                return true;
              case ':':
                setState(view, { mode: 'command', command: '', operator: null, ...CLEARED });
                return true;
              case 'Backspace':
                moveTo(view, Math.max(head - count, 0), visual);
                return true;
              default:
                // Everything else is swallowed: an unbound key in normal mode
                // must never fall through and type itself into the document.
                if (key.length === 1) {
                  setState(view, { ...CLEARED, operator: null });
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
