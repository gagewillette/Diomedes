import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKSPACE, UPLOAD_MAX_BYTES_MIN, UPLOAD_MAX_BYTES_MAX, mergeWorkspace,
} from './workspace.js';
import {
  fileTooLargeMessage, getMaxFileBytes, setMaxFileBytes, trackedUpload,
} from './uploadStore.js';

const file = (size, name = 'clip.mp4') => ({ name, size });

test('the store starts on the same default the server hands out', () => {
  assert.equal(getMaxFileBytes(), DEFAULT_WORKSPACE.uploads.maxBytes);
});

test('a file at or under the limit is not refused', () => {
  setMaxFileBytes(10_000_000);
  assert.equal(fileTooLargeMessage(file(1)), null);
  assert.equal(fileTooLargeMessage(file(10_000_000)), null, 'exactly at the limit is allowed');
  // A file object with no usable size (some drop sources) is left to the server.
  assert.equal(fileTooLargeMessage({ name: 'x' }), null);
  assert.equal(fileTooLargeMessage(null), null);
});

test('an oversized file is named, with both figures, in the workspace unit', () => {
  setMaxFileBytes(10_000_000);
  const message = fileTooLargeMessage(file(25_000_000, 'demo.mp4'));
  assert.match(message, /demo\.mp4/);
  assert.match(message, /25\.0 MB/);
  assert.match(message, /10\.0 MB/);
});

test('junk never widens the limit', () => {
  setMaxFileBytes(10_000_000);
  for (const junk of [undefined, null, NaN, Infinity, 0, -1, '50000000']) setMaxFileBytes(junk);
  assert.equal(getMaxFileBytes(), 10_000_000);
});

test('trackedUpload refuses before it opens a request', async () => {
  setMaxFileBytes(1_000_000);
  // No fetch, no XHR: if the guard did not fire first, this would throw
  // something about XMLHttpRequest rather than about the size.
  await assert.rejects(
    () => trackedUpload('/api/pages/p1/attachments', file(9_000_000, 'big.pdf'), null),
    /big\.pdf is 9\.0 MB/
  );
});

test('the client clamps the limit to the same range as the server', () => {
  const bytes = (v) => mergeWorkspace({ uploads: { maxBytes: v } }).uploads.maxBytes;
  assert.equal(bytes(25_000_000), 25_000_000);
  assert.equal(bytes(0), UPLOAD_MAX_BYTES_MIN);
  assert.equal(bytes(9_000_000_000), UPLOAD_MAX_BYTES_MAX);
  assert.equal(bytes('50mb'), DEFAULT_WORKSPACE.uploads.maxBytes);
  assert.equal(bytes(undefined), DEFAULT_WORKSPACE.uploads.maxBytes);
});
