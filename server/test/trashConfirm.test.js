// The confirmation phrase lives in the client, but "an admin cannot empty the
// trash by accident" is behaviour rather than styling, so it is pinned here
// where the project actually runs tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  makeConfirmPhrase, confirmPhraseMatches, CONFIRM_ALPHABET, CONFIRM_LENGTH,
} from '../../client/src/lib/confirmPhrase.js';
import { resolveStoredPath, removeStoredFiles } from '../src/lib/storage.js';

test('a confirmation phrase is four letters from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const phrase = makeConfirmPhrase();
    assert.equal(phrase.length, CONFIRM_LENGTH);
    for (const ch of phrase) assert.ok(CONFIRM_ALPHABET.includes(ch), `${ch} not in alphabet`);
  }
});

test('the alphabet leaves out the letters that read as digits', () => {
  assert.ok(!CONFIRM_ALPHABET.includes('I'));
  assert.ok(!CONFIRM_ALPHABET.includes('O'));
});

test('phrases vary between prompts', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(makeConfirmPhrase());
  assert.ok(seen.size > 50, `expected varied phrases, saw ${seen.size} distinct`);
});

test('only the right phrase confirms', () => {
  assert.ok(confirmPhraseMatches('QRST', 'QRST'));
  assert.ok(!confirmPhraseMatches('QRSU', 'QRST'));
  assert.ok(!confirmPhraseMatches('QRS', 'QRST'));
  assert.ok(!confirmPhraseMatches('', 'QRST'));
});

test('case and stray whitespace are typing accidents, not wrong answers', () => {
  assert.ok(confirmPhraseMatches('qrst', 'QRST'));
  assert.ok(confirmPhraseMatches('  QRST ', 'QRST'));
});

test('an empty phrase never confirms anything', () => {
  assert.ok(!confirmPhraseMatches('', ''));
  assert.ok(!confirmPhraseMatches(null, 'QRST'));
  assert.ok(!confirmPhraseMatches('QRST', null));
});

test('stored paths outside the storage root are refused', () => {
  const root = '/srv/storage';
  assert.equal(resolveStoredPath('spaces/a/file.png', root), path.join(root, 'spaces/a/file.png'));
  assert.equal(resolveStoredPath('../../etc/passwd', root), null);
  assert.equal(resolveStoredPath('/etc/passwd', root), null);
  assert.equal(resolveStoredPath('', root), null);
  assert.equal(resolveStoredPath(null, root), null);
});

test('emptying the trash takes the attachment blobs with it', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'diomedes-storage-'));
  await fsp.writeFile(path.join(root, 'keep.bin'), 'keep');
  await fsp.writeFile(path.join(root, 'gone.bin'), 'gone');

  const removed = await removeStoredFiles(['gone.bin', 'missing.bin', '../escape.bin'], root);

  assert.equal(removed, 2); // the escape attempt is skipped; a missing file is fine
  assert.ok(!(await fsp.stat(path.join(root, 'gone.bin')).catch(() => null)));
  assert.ok(await fsp.stat(path.join(root, 'keep.bin')));
  await fsp.rm(root, { recursive: true, force: true });
});
