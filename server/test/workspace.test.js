import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspace, DEFAULT_WORKSPACE_NAME } from '../src/lib/workspace.js';

test('a workspace with no settings row has everything switched on', () => {
  const ws = normalizeWorkspace(undefined);
  assert.equal(ws.name, DEFAULT_WORKSPACE_NAME);
  assert.deepEqual(ws.dataSavings, { livePointers: true, fileUploads: true });
});

test('a workspace saved before data savings existed keeps both capabilities', () => {
  assert.deepEqual(normalizeWorkspace({ name: 'Docs' }).dataSavings, {
    livePointers: true,
    fileUploads: true,
  });
});

test('only an explicit false turns a capability off', () => {
  assert.equal(normalizeWorkspace({ dataSavings: { livePointers: false } }).dataSavings.livePointers, false);
  assert.equal(normalizeWorkspace({ dataSavings: { livePointers: false } }).dataSavings.fileUploads, true);
  // Anything that is not `false` — including junk from a hand-edited row —
  // leaves the capability on rather than silently disabling the workspace.
  assert.equal(normalizeWorkspace({ dataSavings: { fileUploads: 'no' } }).dataSavings.fileUploads, true);
});

test('the workspace name survives, blank falls back', () => {
  assert.equal(normalizeWorkspace({ name: '  Team wiki ' }).name, 'Team wiki');
  assert.equal(normalizeWorkspace({ name: '   ' }).name, DEFAULT_WORKSPACE_NAME);
});
