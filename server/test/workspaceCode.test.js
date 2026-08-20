import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_MAX_BYTES_MAX, CODE_MAX_BYTES_MIN, DEFAULT_CODE_INTELLIGENCE, normalizeWorkspace,
} from '../src/lib/workspace.js';

test('a workspace that predates the feature reads as everything-on', () => {
  // The whole reason flags are stored positively: nobody has to migrate the
  // existing settings blob, and a missing key is not "off".
  assert.deepEqual(normalizeWorkspace({ name: 'Docs' }).codeIntelligence, DEFAULT_CODE_INTELLIGENCE);
  assert.deepEqual(normalizeWorkspace(undefined).codeIntelligence, DEFAULT_CODE_INTELLIGENCE);
  assert.deepEqual(normalizeWorkspace({ dataSavings: { fileUploads: false } }).codeIntelligence, {
    highlighting: true,
    linting: true,
    maxBytes: 100_000,
  });
});

test('only an explicit false turns a code-intelligence flag off', () => {
  const ci = (value) => normalizeWorkspace({ codeIntelligence: value }).codeIntelligence;
  assert.equal(ci({ highlighting: false }).highlighting, false);
  assert.equal(ci({ linting: false }).linting, false);
  // A truthy-but-wrong value must not read as "off" — that would be a silent
  // capability loss from a typo.
  assert.equal(ci({ highlighting: 'off' }).highlighting, true);
  assert.equal(ci({ linting: 0 }).linting, true);
  assert.equal(ci({ linting: null }).linting, true);
});

test('the two flags are independent of each other', () => {
  const ci = normalizeWorkspace({ codeIntelligence: { linting: false } }).codeIntelligence;
  assert.equal(ci.linting, false);
  assert.equal(ci.highlighting, true, 'turning checking off must not stop colouring');
});

test('maxBytes is clamped to the settable range and falls back on junk', () => {
  const bytes = (v) => normalizeWorkspace({ codeIntelligence: { maxBytes: v } }).codeIntelligence.maxBytes;
  assert.equal(bytes(250_000), 250_000);
  assert.equal(bytes(CODE_MAX_BYTES_MIN), CODE_MAX_BYTES_MIN);
  assert.equal(bytes(CODE_MAX_BYTES_MAX), CODE_MAX_BYTES_MAX);
  // Out of range clamps rather than erroring: an admin who types a big number
  // gets the ceiling, not a message about bounds they cannot see.
  assert.equal(bytes(0), CODE_MAX_BYTES_MIN);
  assert.equal(bytes(-1), CODE_MAX_BYTES_MIN);
  assert.equal(bytes(50_000_000), CODE_MAX_BYTES_MAX);
  // Junk falls back to the default.
  assert.equal(bytes('100kb'), DEFAULT_CODE_INTELLIGENCE.maxBytes);
  assert.equal(bytes(NaN), DEFAULT_CODE_INTELLIGENCE.maxBytes);
  assert.equal(bytes(Infinity), DEFAULT_CODE_INTELLIGENCE.maxBytes);
  assert.equal(bytes(undefined), DEFAULT_CODE_INTELLIGENCE.maxBytes);
  // Stored as a whole number of bytes so the blob stays readable.
  assert.equal(bytes(123_456.7), 123_457);
});

test('all three settings groups normalise independently', () => {
  const ws = normalizeWorkspace({
    name: 'Docs',
    dataSavings: { fileUploads: false },
    performance: { logging: false },
    codeIntelligence: { linting: false, maxBytes: 20_000 },
  });
  assert.equal(ws.name, 'Docs');
  assert.equal(ws.dataSavings.fileUploads, false);
  assert.equal(ws.dataSavings.livePointers, true);
  assert.equal(ws.performance.logging, false);
  assert.equal(ws.codeIntelligence.linting, false);
  assert.equal(ws.codeIntelligence.highlighting, true);
  assert.equal(ws.codeIntelligence.maxBytes, 20_000);
});

test('normalizeWorkspace is idempotent, so an SSE round trip changes nothing', () => {
  // The settings blob is written back from its own normalised form on every
  // patch; a normaliser that shifted a value each pass would drift.
  const once = normalizeWorkspace({ codeIntelligence: { linting: false, maxBytes: 5 } });
  assert.deepEqual(normalizeWorkspace(once), once);
});
