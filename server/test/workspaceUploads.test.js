import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UPLOADS, UPLOAD_MAX_BYTES_MAX, UPLOAD_MAX_BYTES_MIN, normalizeWorkspace,
} from '../src/lib/workspace.js';
import { formatBytes } from '../src/lib/util.js';

test('a workspace that predates the setting keeps the old hard-coded ceiling', () => {
  assert.deepEqual(normalizeWorkspace({ name: 'Docs' }).uploads, DEFAULT_UPLOADS);
  assert.deepEqual(normalizeWorkspace(undefined).uploads, DEFAULT_UPLOADS);
});

test('the upload ceiling is clamped to the settable range and falls back on junk', () => {
  const bytes = (v) => normalizeWorkspace({ uploads: { maxBytes: v } }).uploads.maxBytes;
  assert.equal(bytes(25_000_000), 25_000_000);
  assert.equal(bytes(UPLOAD_MAX_BYTES_MIN), UPLOAD_MAX_BYTES_MIN);
  assert.equal(bytes(UPLOAD_MAX_BYTES_MAX), UPLOAD_MAX_BYTES_MAX);
  // Clamped rather than rejected, like the code-block ceiling.
  assert.equal(bytes(0), UPLOAD_MAX_BYTES_MIN);
  assert.equal(bytes(-1), UPLOAD_MAX_BYTES_MIN);
  assert.equal(bytes(9_000_000_000), UPLOAD_MAX_BYTES_MAX);
  assert.equal(bytes('50mb'), DEFAULT_UPLOADS.maxBytes);
  assert.equal(bytes(NaN), DEFAULT_UPLOADS.maxBytes);
  assert.equal(bytes(Infinity), DEFAULT_UPLOADS.maxBytes);
  assert.equal(bytes(undefined), DEFAULT_UPLOADS.maxBytes);
  assert.equal(bytes(1_500_000.4), 1_500_000);
});

test('the upload group normalises independently of the other groups', () => {
  const ws = normalizeWorkspace({
    dataSavings: { fileUploads: false },
    codeIntelligence: { maxBytes: 20_000 },
    uploads: { maxBytes: 5_000_000 },
  });
  assert.equal(ws.uploads.maxBytes, 5_000_000);
  assert.equal(ws.codeIntelligence.maxBytes, 20_000, 'the two maxBytes must not collide');
  assert.equal(ws.dataSavings.fileUploads, false);
});

test('normalizeWorkspace stays idempotent with the upload group in it', () => {
  const once = normalizeWorkspace({ uploads: { maxBytes: 5 } });
  assert.deepEqual(normalizeWorkspace(once), once);
});

test('the limit in a 413 message reads as the admin typed it', () => {
  // Decimal MB on both sides: an admin who sets 250 MB must not be told 262.1 MB.
  assert.equal(formatBytes(250_000_000), '250.0 MB');
  assert.equal(formatBytes(DEFAULT_UPLOADS.maxBytes), '512.0 MB');
  assert.equal(formatBytes(UPLOAD_MAX_BYTES_MIN), '1.0 MB');
  assert.equal(formatBytes(0), '0 B');
});
