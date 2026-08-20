import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIGHLIGHT_BYTE_CAP, LintTracker, byteLength, canHighlight, decorationRanges,
  hashCode, lintRequest, lintSkipReason, orderDiagnostics,
} from './lintState.js';

const MAX = 100_000;

test('offsets map to document positions one inside the node', () => {
  // A codeBlock's text starts at nodePos + 1. Getting this wrong by one puts
  // every squiggle on the wrong character, in every language at once.
  const ranges = decorationRanges({
    nodePos: 10,
    textLength: 20,
    diagnostics: [{ from: 0, to: 3, severity: 'error', message: 'x' }],
  });
  assert.deepEqual(ranges, [{ from: 11, to: 14, severity: 'error', message: 'x', source: undefined }]);
});

test('the mapping holds for a block sitting deep in a long document', () => {
  // The plugin gets `pos` from doc.descendants, so a block after a table or a
  // footnote apparatus is just a bigger number — nothing special, and this
  // pins that there is no per-position fudge anywhere.
  for (const nodePos of [0, 1, 42, 1337, 250_000]) {
    const [range] = decorationRanges({
      nodePos,
      textLength: 50,
      diagnostics: [{ from: 7, to: 9, severity: 'error', message: 'x' }],
    });
    assert.equal(range.from, nodePos + 8);
    assert.equal(range.to, nodePos + 10);
  }
});

test('a range is clamped to the block and never spills onto the next one', () => {
  // A parser that over-reports, or a result that lands after the block was
  // shortened, must not decorate the paragraph below it.
  const ranges = decorationRanges({
    nodePos: 5,
    textLength: 4,
    diagnostics: [
      { from: 2, to: 999, severity: 'error', message: 'over the end' },
      { from: -5, to: 2, severity: 'warning', message: 'before the start' },
    ],
  });
  assert.deepEqual(ranges.map((r) => [r.from, r.to]), [[8, 10], [6, 8]]);
  for (const r of ranges) assert.ok(r.to <= 5 + 1 + 4);
});

test('a range that clamps to nothing is dropped, not widened', () => {
  // A zero-width inline decoration renders as nothing; widening it would put a
  // squiggle under a character the parser never complained about.
  assert.deepEqual(
    decorationRanges({ nodePos: 0, textLength: 3, diagnostics: [{ from: 9, to: 12, message: 'x' }] }),
    []
  );
  assert.deepEqual(decorationRanges({ nodePos: 0, textLength: 3, diagnostics: null }), []);
});

test('an unknown severity is normalised to error', () => {
  const [range] = decorationRanges({
    nodePos: 0,
    textLength: 5,
    diagnostics: [{ from: 0, to: 1, severity: 'nonsense', message: 'x' }],
  });
  assert.equal(range.severity, 'error');
});

test('problems are ordered errors first, then by position', () => {
  const ordered = orderDiagnostics([
    { from: 9, severity: 'warning' },
    { from: 7, severity: 'error' },
    { from: 2, severity: 'warning' },
    { from: 1, severity: 'error' },
  ]);
  assert.deepEqual(ordered.map((d) => [d.severity, d.from]), [
    ['error', 1], ['error', 7], ['warning', 2], ['warning', 9],
  ]);
});

test('byte length counts UTF-8 bytes, which is what the caps mean', () => {
  assert.equal(byteLength('abc'), 3);
  assert.equal(byteLength('é'), 2);
  assert.equal(byteLength('🙂'), 4);
});

test('a block is skipped for a reason the header can show', () => {
  const base = { enabled: true, language: 'json', bytes: 10, maxBytes: MAX };
  assert.equal(lintSkipReason(base), null);
  assert.equal(lintSkipReason({ ...base, enabled: false }), 'off');
  assert.equal(lintSkipReason({ ...base, language: '' }), 'no-language');
  // Highlighted, never parsed: there is no Rust checker here.
  assert.equal(lintSkipReason({ ...base, language: 'rust' }), 'no-checker');
  assert.equal(lintSkipReason({ ...base, bytes: MAX + 1 }), 'too-large');
  assert.equal(lintSkipReason({ ...base, visible: false }), 'offscreen');
});

test('the admin cap and the hard cap are separate limits', () => {
  const base = { enabled: true, language: 'json', maxBytes: MAX };
  // Over the admin cap: coloured, not checked.
  assert.equal(lintSkipReason({ ...base, bytes: 150_000 }), 'too-large');
  assert.ok(canHighlight({ enabled: true, language: 'json', bytes: 150_000 }));
  // Over the hard cap: not even coloured. A 500 KB paste must not lock the tab.
  assert.equal(lintSkipReason({ ...base, bytes: HIGHLIGHT_BYTE_CAP + 1 }), 'huge');
  assert.equal(canHighlight({ enabled: true, language: 'json', bytes: 500_000 }), false);
});

test('highlighting off means no grammar for any block, however small', () => {
  assert.equal(canHighlight({ enabled: false, language: 'json', bytes: 10 }), false);
  assert.equal(canHighlight({ enabled: true, language: 'cobol', bytes: 10 }), false);
});

test('a request carries the canonical grammar and the dialect qualifier', () => {
  assert.deepEqual(lintRequest({ blockId: 'blk_1', language: 'py', code: 'x', version: 3 }), {
    id: 'blk_1', lang: 'python', qualifier: '', code: 'x', version: 3,
  });
  // ```sql:mysql — the dialect rides along so the plugin need not know that
  // only SQL cares about it.
  assert.deepEqual(lintRequest({ blockId: 'blk_2', language: 'sql:mysql', code: 's', version: 1 }), {
    id: 'blk_2', lang: 'sql', qualifier: 'mysql', code: 's', version: 1,
  });
  assert.equal(lintRequest({ blockId: 'blk_3', language: 'cobol', code: 'x', version: 1 }), null);
});

test('hashing is stable and separates different text', () => {
  assert.equal(hashCode('abc'), hashCode('abc'));
  assert.notEqual(hashCode('abc'), hashCode('abd'));
  assert.equal(typeof hashCode(''), 'string');
});

test('unchanged text is not re-linted', () => {
  const tracker = new LintTracker();
  const block = { blockId: 'blk_a', language: 'json', code: '{}' };
  assert.ok(tracker.request(block), 'the first pass must run');
  // An edit elsewhere in the document, a cursor move, a peer's change three
  // paragraphs up — none of that is a reason to re-parse this block.
  assert.equal(tracker.request(block), null);
  assert.ok(tracker.request({ ...block, code: '{"a":1}' }), 'changed text must re-run');
});

test('changing the language re-lints even when the text is identical', () => {
  const tracker = new LintTracker();
  assert.ok(tracker.request({ blockId: 'blk_a', language: 'json', code: 'x: 1' }));
  const again = tracker.request({ blockId: 'blk_a', language: 'yaml', code: 'x: 1' });
  assert.ok(again, 'a new language is a new question about the same text');
  assert.equal(again.lang, 'yaml');
});

test('a stale result is dropped rather than painted over fresh text', () => {
  const tracker = new LintTracker();
  const first = tracker.request({ blockId: 'blk_a', language: 'json', code: '{' });
  // The user keeps typing while the parser is still running.
  const second = tracker.request({ blockId: 'blk_a', language: 'json', code: '{"a": 1}' });
  assert.equal(second.version, first.version + 1);

  // The first reply arrives late. It describes text that no longer exists.
  assert.equal(
    tracker.accept({ id: 'blk_a', version: first.version, diagnostics: [{ from: 0, to: 1, message: 'stale' }] }),
    false
  );
  assert.deepEqual(tracker.results('blk_a'), []);

  // The reply for what is actually on screen is kept.
  assert.equal(tracker.accept({ id: 'blk_a', version: second.version, diagnostics: [] }), true);
  assert.deepEqual(tracker.results('blk_a'), []);
});

test('a reply for a block that no longer exists is discarded', () => {
  const tracker = new LintTracker();
  const req = tracker.request({ blockId: 'blk_a', language: 'json', code: '{' });
  tracker.forget('blk_a');
  assert.equal(tracker.accept({ id: 'blk_a', version: req.version, diagnostics: [{ from: 0, to: 1 }] }), false);
  assert.deepEqual(tracker.results('blk_a'), []);
});

test('changing a block to a language with no grammar clears its diagnostics', () => {
  const tracker = new LintTracker();
  const req = tracker.request({ blockId: 'blk_a', language: 'json', code: '{' });
  tracker.accept({ id: 'blk_a', version: req.version, diagnostics: [{ from: 0, to: 1, message: 'x' }] });
  assert.equal(tracker.results('blk_a').length, 1);

  // Switched to plain text *without editing a character*: the old JSON
  // complaint must not survive the change.
  assert.equal(tracker.request({ blockId: 'blk_a', language: 'cobol', code: '{' }), null);
  assert.deepEqual(tracker.results('blk_a'), []);
});

test('retain forgets blocks that left the document', () => {
  const tracker = new LintTracker();
  for (const id of ['blk_a', 'blk_b', 'blk_c']) {
    const req = tracker.request({ blockId: id, language: 'json', code: `{"${id}"` });
    tracker.accept({ id, version: req.version, diagnostics: [{ from: 0, to: 1, message: 'x' }] });
  }
  tracker.retain(['blk_a', 'blk_c']);
  assert.equal(tracker.results('blk_a').length, 1);
  assert.deepEqual(tracker.results('blk_b'), []);
  assert.equal(tracker.results('blk_c').length, 1);

  tracker.clear();
  assert.deepEqual(tracker.results('blk_a'), []);
});
