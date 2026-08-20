import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import Document from '@tiptap/extension-document';
import { BlockId } from '../editor/blockId.js';
import { FootnoteExtensions } from '../editor/nodes/Footnote.jsx';
import { hydrateDiagramBlocks } from './diagramBlocks.js';
import { lowerForMarkdown, unescapeCalloutBadges } from './exportDoc.js';

// Parse a markdown string into TipTap JSON using a throwaway headless editor.
export function markdownToJSON(md) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      // Same content expression the real editor uses. Without it the parsed
      // footnote container has nowhere to go and markdown-it's work is thrown
      // away silently — every imported note lost, with no error to notice.
      Document.extend({ content: 'block+ footnotes?' }),
      StarterKit.configure({ document: false }),
      Link,
      Image,
      Table, TableRow, TableCell, TableHeader,
      TaskList, TaskItem,
      ...FootnoteExtensions,
      Markdown.configure({ html: false }),
      // Imported markdown becomes real blocks the moment it lands, rather than
      // waiting for someone to open the page and edit it. Without this the MCP
      // import path would write a document with no addressable blocks in it.
      BlockId,
    ],
    content: md,
  });
  const json = editor.getJSON();
  editor.destroy();
  // The headless editor above has no diagram extensions — it has no DOM to
  // render into — so ```mermaid and ```drawio fences come out of it as code
  // blocks. The server normalises that on write, but the imported document is
  // also shown before it round-trips, so convert here too and let the two agree.
  return hydrateDiagramBlocks(json);
}

// Serialise TipTap JSON back to markdown — the mirror of markdownToJSON, built
// from the same extension list so a page that came in as a markdown import goes
// back out as the markdown it came from.
//
// The editor here has no DOM to draw into and no React, which is why the
// document is lowered first: diagrams, callouts, toggles and page links become
// blocks this extension list actually knows, instead of being dropped on the
// floor. See exportDoc.js.
export function jsonToMarkdown(json) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit,
      Link,
      Image,
      Table, TableRow, TableCell, TableHeader,
      TaskList, TaskItem,
      Markdown.configure({ html: false }),
    ],
    content: lowerForMarkdown(json),
  });
  const md = editor.storage.markdown.getMarkdown();
  editor.destroy();
  return unescapeCalloutBadges(md);
}

export function downloadFile(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
