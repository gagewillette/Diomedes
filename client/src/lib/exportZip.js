// "Export as ZIP": one page and everything under it, as a flat archive of
// markdown files.
//
// The interesting parts — the walk and the filenames — live in pageExport.js
// where they can be tested without a browser. This module is only the wiring:
// one request for the subtree, one markdown render per page, one zip.

import { zipSync, strToU8 } from 'fflate';
import { api } from './api.js';
import { jsonToMarkdown, downloadFile } from './markdown.js';
import { sanitizeFilename, subtreeFiles } from './pageExport.js';

/**
 * Fetch a page's subtree, render every page in it to markdown and hand the
 * browser `<Page Title>.zip`. Returns how many files were written, so a caller
 * can say so.
 */
export async function exportPageZip(pageId) {
  // One request, not one per page: the tree can be any depth, and a fan-out of
  // N requests would get slower exactly as the feature gets more useful.
  const { pages } = await api.get(`/api/pages/${pageId}/subtree?content=1`);
  const files = subtreeFiles(pages, pageId, (page) => jsonToMarkdown(page.content));
  if (!files.length) throw new Error('Page not found');

  const entries = {};
  for (const file of files) entries[file.name] = strToU8(file.text);
  // Flat by design: every key here is a bare filename, so no zip reader is ever
  // asked to create a directory.
  const zip = zipSync(entries, { level: 6 });

  const root = pages.find((p) => p.id === pageId);
  downloadFile(`${sanitizeFilename(root?.title)}.zip`, zip, 'application/zip');
  return files.length;
}
