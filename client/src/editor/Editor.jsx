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
import { useEffect, useMemo, useRef } from 'react';
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
import { PageLink, linkContext } from './nodes/PageLink.jsx';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { buildCaret, buildSelection } from './collab/carets.js';
import PointerLayer from './collab/PointerLayer.jsx';
import { usePresence } from './collab/presence.js';
import { useContentSnapshot, useSeedContent } from './collab/persistence.js';

const lowlight = createLowlight(common);

// Module-level cache so mention suggestions work without prop-drilling.
let userCache = [];

export function buildExtensions({ uploadFile, placeholder = "Type '/' for commands…", collab, me }) {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4] },
      // Yjs keeps its own per-user undo stack. Leaving ProseMirror's history
      // plugin in place would let one person's undo revert someone else's
      // paragraph, because it only knows about the local document.
      ...(collab ? { history: false } : {}),
    }),
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
    SlashCommand.configure({ items: buildSlashItems({ uploadFile }) }),
    PageLink,
    Callout, Toggle, MermaidDiagram, ExcalidrawBlock, DrawioBlock, IframeEmbed, VideoBlock,
    ...(collab
      ? [
          Collaboration.configure({ document: collab.ydoc, field: 'default' }),
          CollaborationCursor.configure({
            provider: collab.provider,
            user: me,
            render: buildCaret,
            selectionRender: buildSelection,
          }),
        ]
      : []),
  ];
}

export default function Editor({
  content,
  editable = true,
  pageId,
  space,
  onUpdate,
  onReady,
  collab = null,
  me = null,
  onSaveState,
}) {
  const { preferences } = useAuth();
  const wrapRef = useRef(null);
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

  // The [[link]] suggestion plugin runs outside React, so hand it the current
  // space through the module-level context before the editor can be typed in.
  linkContext.spaceId = space?.id ?? null;
  linkContext.spaceSlug = space?.slug ?? null;
  linkContext.canWrite = Boolean(editable);

  // The extension list is built once per session: TipTap binds Collaboration to
  // a specific Y.Doc at creation time, and rebuilding it would drop the binding.
  const extensions = useMemo(
    () => buildExtensions({ uploadFile, collab, me }),
    // ydoc/provider identity, not the session object: the session re-wraps on
    // every connection-status change and rebuilding the list would be pointless.
    [collab?.ydoc, collab?.provider, me] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const editor = useEditor({
    extensions,
    // With collaboration on, the document comes from the CRDT. Passing initial
    // content here as well would insert it on top of whatever synced in.
    content: collab ? undefined : content,
    editable,
    onUpdate: ({ editor: e }) => onUpdate?.(e),
    editorProps: {
      attributes: { class: 'gd-editor' },
      handleDrop: (view, event, _slice, moved) => {
        if (moved || !uploadFile || !event.dataTransfer?.files?.length) return false;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        (async () => {
          for (const file of files) {
            const url = await uploadFile(file);
            if (!url) continue;
            insertUploaded(view, file, url, coords?.pos);
          }
        })();
        return true;
      },
      handlePaste: (view, event) => {
        if (!uploadFile || !event.clipboardData?.files?.length) return false;
        const files = Array.from(event.clipboardData.files);
        (async () => {
          for (const file of files) {
            const url = await uploadFile(file);
            if (!url) continue;
            insertUploaded(view, file, url);
          }
        })();
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
    if (pos != null) tr.insert(pos, node);
    else tr.replaceSelectionWith(node);
    view.dispatch(tr);
  }

  const peers = usePresence({ session: collab, editor, me, wrapRef, canWrite: editable });
  useSeedContent({ session: collab, editor, pageId, initialContent: content, canWrite: editable });
  useContentSnapshot({ session: collab, editor, pageId, canWrite: editable, onSaveState });

  const smoothCaret = editable && preferences.smoothCaret;

  return (
    <div
      ref={wrapRef}
      className={`gd-editor-wrap ${smoothCaret ? 'gd-caret-hidden' : ''}`}
      style={{
        '--gd-font-family': FONT_STACKS[preferences.fontFamily] || FONT_STACKS.system,
        '--gd-font-size': `${preferences.fontSize}px`,
        '--gd-line-height': preferences.lineHeight,
      }}
    >
      {editable && <BubbleToolbar editor={editor} />}
      {smoothCaret && <SmoothCaret editor={editor} />}
      <EditorContent editor={editor} />
      {collab && <PointerLayer peers={peers} />}
    </div>
  );
}
