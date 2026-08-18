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

// Parse a markdown string into TipTap JSON using a throwaway headless editor.
export function markdownToJSON(md) {
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
    content: md,
  });
  const json = editor.getJSON();
  editor.destroy();
  return json;
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
