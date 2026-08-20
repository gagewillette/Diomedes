import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Superscript from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Youtube from '@tiptap/extension-youtube';
import Mention from '@tiptap/extension-mention';
import Mathematics from '@tiptap/extension-mathematics';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { Markdown } from 'tiptap-markdown';
import { useCallback, useEffect, useRef } from 'react';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { FONT_STACKS } from '../lib/prefs.js';
import SmoothCaret from './SmoothCaret.jsx';
import { SlashCommand, buildSlashItems } from './SlashCommand.jsx';
import { makeSuggestionRender } from './suggestionRender.js';
import MentionList from './MentionList.jsx';
import BubbleToolbar from './BubbleToolbar.jsx';
import { Callout } from './nodes/Callout.jsx';
import { Toggle } from './nodes/Toggle.jsx';
import { MermaidDiagram } from './nodes/Mermaid.jsx';
import { ExcalidrawBlock } from './nodes/ExcalidrawNode.jsx';
import { IframeEmbed, VideoBlock } from './nodes/Embeds.jsx';
import { DrawioBlock } from './nodes/Drawio.jsx';
import { DocumentBlock, docKindFor } from './nodes/DocumentBlock.jsx';
import { useDocumentUpload } from './useDocumentUpload.jsx';
import { useFileDrop } from './useFileDrop.js';
import { PageLink, linkContext } from './nodes/PageLink.jsx';

const lowlight = createLowlight(common);

// Module-level cache so mention suggestions work without prop-drilling.
let userCache = [];

export function buildExtensions({ uploadFile, uploadDocument, placeholder = "Type '/' for commands…" }) {
  return [
    StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3, 4] } }),
    CodeBlockLowlight.configure({ lowlight }),
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    Image.configure({ allowBase64: true }),
    Table.configure({ resizable: true }),
    TableRow, TableCell, TableHeader,
    TaskList, TaskItem.configure({ nested: true }),
    Underline, Superscript, Subscript, TextStyle, Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Youtube.configure({ nocookie: true, width: 640, height: 360 }),
    Mathematics,
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : placeholder),
    }),
    Markdown.configure({
      html: false,
      transformPastedText: true,
      transformCopiedText: false,
      linkify: true,
    }),
    Mention.configure({
      HTMLAttributes: { class: 'gd-mention' },
      renderText: ({ node }) => `@${node.attrs.label}`,
      suggestion: {
        char: '@',
        items: ({ query }) => {
          const q = query.toLowerCase();
          return userCache
            .filter((u) => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
            .slice(0, 8);
        },
        render: makeSuggestionRender(MentionList),
      },
    }),
    SlashCommand.configure({ items: buildSlashItems({ uploadFile, uploadDocument }) }),
    PageLink,
    Callout, Toggle, MermaidDiagram, ExcalidrawBlock, DrawioBlock, IframeEmbed, VideoBlock,
    DocumentBlock,
  ];
}

/** documentBlock attrs from a POST /pages/:id/documents response. */
export const documentAttrs = (res) => ({
  attachmentId: res.attachment.id,
  url: res.url,
  filename: res.attachment.filename,
  mime: res.attachment.mime,
  size: res.attachment.size,
  kind: res.docKind,
});

export default function Editor({ content, editable = true, pageId, space, onUpdate, onReady }) {
  const { preferences } = useAuth();
  const uploadFile = pageId
    ? async (file) => {
        try {
          const fd = new FormData();
          fd.append('file', file);
          const res = await api.post(`/api/pages/${pageId}/attachments`, fd);
          return res.url;
        } catch (err) {
          notifications.show({ color: 'red', message: `Upload failed: ${err.message}` });
          return null;
        }
      }
    : null;

  const { uploadDocument, prompt: documentPrompt } = useDocumentUpload(editable ? pageId : null);
  // The editor's extensions are built once, so reach the current callback
  // through a ref rather than baking in the one from the first render.
  const uploadDocumentRef = useRef(uploadDocument);
  uploadDocumentRef.current = uploadDocument;
  const uploadDocumentStable = useCallback((file) => uploadDocumentRef.current?.(file) ?? null, []);

  // The [[link]] suggestion plugin runs outside React, so hand it the current
  // space through the module-level context before the editor can be typed in.
  linkContext.spaceId = space?.id ?? null;
  linkContext.spaceSlug = space?.slug ?? null;
  linkContext.canWrite = Boolean(editable);

  const editor = useEditor({
    extensions: buildExtensions({
      uploadFile,
      uploadDocument: pageId && editable ? uploadDocumentStable : null,
    }),
    content,
    editable,
    onUpdate: ({ editor: e }) => onUpdate?.(e),
    editorProps: {
      attributes: { class: 'gd-editor' },
      // Drops are handled by useFileDrop on the wrapper, not here — see the
      // comment there for why ProseMirror's own drop path can't be trusted
      // with files.
      handlePaste: (_view, event) => {
        if (!uploadFile || !event.clipboardData?.files?.length) return false;
        handleFiles(Array.from(event.clipboardData.files));
        return true;
      },
    },
  });

  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editable, editor]);

  useEffect(() => {
    api.get('/api/users', { noRedirect: true }).then((d) => { userCache = d.users; }).catch(() => {});
  }, []);

  // Dropped/pasted files, one at a time so a PPTX can stop and ask how it
  // should be stored. `pos` is the drop point; each insertion moves it along so
  // a multi-file drop keeps its order.
  async function handleFiles(files, pos) {
    const view = editor?.view;
    if (!view) return;
    let at = pos;
    for (const file of files) {
      // A PDF or PPTX becomes a document card — the same one /document makes.
      if (docKindFor(file)) {
        const res = await uploadDocumentRef.current?.(file);
        if (!res) continue;
        at = insertDocument(at, res);
      } else if (uploadFile) {
        const url = await uploadFile(file);
        if (!url) continue;
        at = insertUploaded(view, file, url, at);
      }
    }
  }

  // The bar is a block node and always sits on its own line. Returns the
  // position just after it, for the next file in the batch.
  function insertDocument(pos, res) {
    const at = Math.min(pos ?? editor.state.selection.from, editor.state.doc.content.size);
    editor
      .chain()
      .focus()
      .insertContentAt(at, { type: 'documentBlock', attrs: documentAttrs(res) })
      .run();
    return editor.state.selection.to;
  }

  // Returns the position just after the insertion, for the next file.
  function insertUploaded(view, file, url, pos) {
    const { schema } = view.state;
    let node;
    if (file.type.startsWith('image/')) node = schema.nodes.image.create({ src: url, alt: file.name });
    else if (file.type.startsWith('video/')) node = schema.nodes.videoBlock.create({ src: url });
    else {
      node = schema.text(`📎 ${file.name}`, [schema.marks.link.create({ href: url })]);
      const para = schema.nodes.paragraph.create(null, node);
      node = para;
    }
    const tr = view.state.tr;
    let end;
    if (pos != null) {
      const at = Math.min(pos, view.state.doc.content.size);
      tr.insert(at, node);
      end = at + node.nodeSize;
    } else {
      tr.replaceSelectionWith(node);
      end = tr.selection.to;
    }
    view.dispatch(tr);
    return end;
  }

  const smoothCaret = editable && preferences.smoothCaret;

  const { ref: dropRef, isOver } = useFileDrop({
    editor,
    enabled: Boolean(editor && editable && pageId),
    onFiles: handleFiles,
  });

  return (
    <div
      ref={dropRef}
      className={`gd-editor-wrap ${smoothCaret ? 'gd-caret-hidden' : ''} ${isOver ? 'is-file-drop' : ''}`}
      style={{
        '--gd-font-family': FONT_STACKS[preferences.fontFamily] || FONT_STACKS.system,
        '--gd-font-size': `${preferences.fontSize}px`,
        '--gd-line-height': preferences.lineHeight,
      }}
    >
      {editable && <BubbleToolbar editor={editor} />}
      {smoothCaret && <SmoothCaret editor={editor} />}
      <EditorContent editor={editor} />
      {editable && documentPrompt}
    </div>
  );
}
