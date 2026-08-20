import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_MIME, PPTX_MIME, PPT_MIME, docTypeFor, inlineAllowed } from '../src/lib/doctypes.js';

test('docTypeFor accepts PDF and PowerPoint, whatever the case', () => {
  assert.deepEqual(docTypeFor('slides.pdf'), { mime: PDF_MIME, kind: 'pdf' });
  assert.deepEqual(docTypeFor('Slides.PDF'), { mime: PDF_MIME, kind: 'pdf' });
  assert.deepEqual(docTypeFor('deck.pptx'), { mime: PPTX_MIME, kind: 'pptx' });
  assert.deepEqual(docTypeFor('old deck.PPT'), { mime: PPT_MIME, kind: 'pptx' });
});

test('docTypeFor rejects everything else', () => {
  for (const name of ['notes.docx', 'photo.png', 'script.html', 'archive.zip', 'noextension', '', null])
    assert.equal(docTypeFor(name), null, `${name} should be rejected`);
});

test('docTypeFor looks at the real extension, not one hidden mid-name', () => {
  assert.equal(docTypeFor('trap.pdf.html'), null);
  assert.deepEqual(docTypeFor('report.html.pdf'), { mime: PDF_MIME, kind: 'pdf' });
});

test('inlineAllowed lets PDFs and media render, never PowerPoint or markup', () => {
  for (const mime of [PDF_MIME, 'text/plain', 'image/png', 'video/mp4', 'audio/mpeg'])
    assert.equal(inlineAllowed(mime), true, `${mime} should render inline`);

  for (const mime of [PPTX_MIME, PPT_MIME, 'text/html', 'image/svg+xml', 'application/octet-stream', '', undefined])
    assert.equal(inlineAllowed(mime), false, `${mime} should be forced to download`);
});
