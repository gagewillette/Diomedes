import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import {
  IconLetterT, IconH1, IconH2, IconH3, IconList, IconListNumbers, IconListCheck,
  IconChevronRight, IconQuote, IconCode, IconTable, IconMinus, IconInfoCircle,
  IconPhoto, IconMovie, IconPaperclip, IconChartDots3, IconPencil, IconMathFunction,
  IconBrandYoutube, IconWorld, IconCalendar, IconTopologyStar3, IconFileTypePdf, IconSuperscript,
} from '@tabler/icons-react';
import { makeSuggestionRender } from './suggestionRender.js';
import { requestDiagramEditor } from './nodes/diagramAutoOpen.js';

const pickFile = (accept) =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });

export function buildSlashItems({ uploadFile, uploadDocument }) {
  const items = [
    { title: 'Text', desc: 'Plain paragraph', icon: IconLetterT, kw: 'paragraph plain',
      run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { title: 'Heading 1', desc: 'Large section heading', icon: IconH1, kw: 'h1 title',
      run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
    { title: 'Heading 2', desc: 'Medium section heading', icon: IconH2, kw: 'h2',
      run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
    { title: 'Heading 3', desc: 'Small section heading', icon: IconH3, kw: 'h3',
      run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
    { title: 'Bullet list', desc: 'Unordered list', icon: IconList, kw: 'ul bullet',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { title: 'Numbered list', desc: 'Ordered list', icon: IconListNumbers, kw: 'ol ordered',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { title: 'To-do list', desc: 'Checklist with checkboxes', icon: IconListCheck, kw: 'task todo check',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { title: 'Toggle', desc: 'Collapsible block', icon: IconChevronRight, kw: 'collapse details',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent({
        type: 'toggleBlock', attrs: { title: 'Toggle', open: true },
        content: [{ type: 'paragraph' }],
      }).run() },
    { title: 'Quote', desc: 'Blockquote', icon: IconQuote, kw: 'blockquote',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { title: 'Code block', desc: 'Code with syntax highlighting', icon: IconCode, kw: 'code snippet',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { title: 'Table', desc: '3×3 table with header row', icon: IconTable, kw: 'grid',
      run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: 'Divider', desc: 'Horizontal rule', icon: IconMinus, kw: 'hr rule separator',
      run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    { title: 'Callout', desc: 'Highlighted info box', icon: IconInfoCircle, kw: 'info warning note admonition',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent({
        type: 'callout', attrs: { variant: 'info' }, content: [{ type: 'paragraph' }],
      }).run() },
    { title: 'Mermaid diagram', desc: 'Flowcharts, sequence diagrams…', icon: IconChartDots3, kw: 'diagram flowchart chart graph',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent({
        type: 'mermaidDiagram',
        attrs: { code: 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]' },
      }).run() },
    { title: 'Excalidraw', desc: 'Free-form whiteboard drawing', icon: IconPencil, kw: 'draw sketch whiteboard diagram',
      run: (e, r) => {
        requestDiagramEditor('excalidraw');
        e.chain().focus().deleteRange(r).insertContent({
          type: 'excalidraw', attrs: { data: { elements: [], appState: {}, files: {} } },
        }).run();
      } },
    { title: 'Draw.io diagram', desc: 'Full diagrams.net editor', icon: IconTopologyStar3, kw: 'drawio diagrams.net flowchart uml network',
      run: (e, r) => {
        requestDiagramEditor('drawioDiagram');
        e.chain().focus().deleteRange(r).insertContent({ type: 'drawioDiagram' }).run();
      } },
    { title: 'Math', desc: 'Inline LaTeX: $E = mc^2$', icon: IconMathFunction, kw: 'latex katex equation formula',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent('$E = mc^2$ ').run() },
    { title: 'YouTube', desc: 'Embed a YouTube video', icon: IconBrandYoutube, kw: 'video embed',
      run: (e, r) => {
        const url = window.prompt('YouTube URL');
        if (url) e.chain().focus().deleteRange(r).setYoutubeVideo({ src: url }).run();
        else e.chain().focus().deleteRange(r).run();
      } },
    { title: 'Embed (iframe)', desc: 'Airtable, Loom, Miro, Figma…', icon: IconWorld, kw: 'iframe embed airtable loom miro figma drawio',
      run: (e, r) => {
        const url = window.prompt('Embed URL (https://…)');
        if (url && /^https?:\/\//.test(url))
          e.chain().focus().deleteRange(r).insertContent({ type: 'iframeEmbed', attrs: { src: url } }).run();
        else e.chain().focus().deleteRange(r).run();
      } },
    { title: 'Footnote', desc: 'Numbered note at the bottom of the page', icon: IconSuperscript,
      kw: 'footnote note citation reference source aside endnote',
      run: (e, r) => e.chain().focus().deleteRange(r).addFootnote().run() },
    { title: 'Date', desc: "Insert today's date", icon: IconCalendar, kw: 'today now',
      run: (e, r) => e.chain().focus().deleteRange(r)
        .insertContent(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
        .run() },
  ];

  if (uploadDocument) {
    items.push({
      title: 'Document',
      desc: 'Upload a PDF or PowerPoint',
      icon: IconFileTypePdf,
      kw: 'pdf pptx powerpoint slides presentation attachment upload',
      run: async (e, r) => {
        e.chain().focus().deleteRange(r).run();
        const file = await pickFile('.pdf,.ppt,.pptx');
        if (!file) return;
        const at = e.state.selection.from;
        const res = await uploadDocument(file);
        if (!res) return;
        e.chain()
          .focus()
          .insertContentAt(at, {
            type: 'documentBlock',
            attrs: {
              attachmentId: res.attachment.id,
              url: res.url,
              filename: res.attachment.filename,
              mime: res.attachment.mime,
              size: res.attachment.size,
              kind: res.docKind,
            },
          })
          .run();
      },
    });
  }

  if (uploadFile) {
    items.push(
      { title: 'Image', desc: 'Upload an image', icon: IconPhoto, kw: 'picture photo upload',
        run: async (e, r) => {
          e.chain().focus().deleteRange(r).run();
          const file = await pickFile('image/*');
          if (!file) return;
          const url = await uploadFile(file);
          if (url) e.chain().focus().setImage({ src: url, alt: file.name }).run();
        } },
      { title: 'Video', desc: 'Upload a video file', icon: IconMovie, kw: 'mp4 movie upload',
        run: async (e, r) => {
          e.chain().focus().deleteRange(r).run();
          const file = await pickFile('video/*');
          if (!file) return;
          const url = await uploadFile(file);
          if (url) e.chain().focus().insertContent({ type: 'videoBlock', attrs: { src: url } }).run();
        } },
      { title: 'File attachment', desc: 'Upload any file as a link', icon: IconPaperclip, kw: 'attach upload document',
        run: async (e, r) => {
          e.chain().focus().deleteRange(r).run();
          const file = await pickFile('*/*');
          if (!file) return;
          const url = await uploadFile(file);
          if (url)
            e.chain().focus().insertContent([
              { type: 'text', text: `📎 ${file.name}`, marks: [{ type: 'link', attrs: { href: url } }] },
              { type: 'text', text: ' ' },
            ]).run();
        } },
    );
  }
  return items;
}

const SlashMenu = forwardRef(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') { setSelected((s) => (s + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setSelected((s) => (s - 1 + items.length) % items.length); return true; }
      if (event.key === 'Enter') { if (items[selected]) command(items[selected]); return true; }
      return false;
    },
  }));
  if (!items.length) return <div className="gd-slash-menu gd-slash-empty">No matches</div>;
  return (
    <div className="gd-slash-menu">
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={item.title}
            className={`gd-slash-item ${i === selected ? 'is-selected' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(e) => e.preventDefault()} /* keep editor focus so the popup survives the click */
            onClick={() => command(item)}
          >
            <Icon size={18} stroke={1.6} />
            <span>
              <b>{item.title}</b>
              <small>{item.desc}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
});
SlashMenu.displayName = 'SlashMenu';

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addOptions() {
    return { items: [] };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        items: ({ query }) => {
          const q = query.toLowerCase();
          return this.options.items
            .filter((i) => i.title.toLowerCase().includes(q) || i.kw.includes(q))
            .slice(0, 12);
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: makeSuggestionRender(SlashMenu),
      }),
    ];
  },
});
