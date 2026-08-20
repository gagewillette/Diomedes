import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspace } from '../src/lib/workspace.js';

test('performance logging is on for a workspace that predates the switch', () => {
  assert.deepEqual(normalizeWorkspace({ name: 'Docs' }).performance, {
    logging: true,
    sampleRate: 1,
  });
  assert.equal(normalizeWorkspace(undefined).performance.logging, true);
});

test('only an explicit false turns performance logging off', () => {
  assert.equal(normalizeWorkspace({ performance: { logging: false } }).performance.logging, false);
  assert.equal(normalizeWorkspace({ performance: { logging: 'off' } }).performance.logging, true);
});

test('the sample rate is pinned to 0..1 and falls back when absent or junk', () => {
  const rate = (v) => normalizeWorkspace({ performance: { sampleRate: v } }).performance.sampleRate;
  assert.equal(rate(0.25), 0.25);
  assert.equal(rate(0), 0);
  assert.equal(rate(7), 1);
  assert.equal(rate(-1), 0);
  assert.equal(rate('half'), 1);
  assert.equal(rate(undefined), 1);
  // Rounded to whole percents so the stored blob stays readable.
  assert.equal(rate(0.12345), 0.12);
});

test('the two settings groups are independent', () => {
  const ws = normalizeWorkspace({
    dataSavings: { fileUploads: false },
    performance: { logging: false },
  });
  assert.equal(ws.dataSavings.fileUploads, false);
  assert.equal(ws.dataSavings.livePointers, true);
  assert.equal(ws.performance.logging, false);
});
