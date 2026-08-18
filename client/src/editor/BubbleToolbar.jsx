import { BubbleMenu } from '@tiptap/react';
import { ActionIcon, Group, Menu, Paper, Divider } from '@mantine/core';
import {
  IconBold, IconItalic, IconUnderline, IconStrikethrough, IconCode, IconLink,
  IconHighlight, IconLetterCase, IconAlignLeft, IconAlignCenter, IconAlignRight,
  IconChevronDown, IconClearFormatting, IconSuperscript, IconSubscript, IconPalette,
} from '@tabler/icons-react';

const COLORS = ['#e03131', '#e8590c', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5', '#495057'];
const HIGHLIGHTS = ['#fff3bf', '#ffe3e3', '#d3f9d8', '#d0ebff', '#eebefa', '#ffd8a8'];

function Btn({ active, onClick, title, children }) {
  return (
    <ActionIcon variant={active ? 'filled' : 'subtle'} color={active ? 'blue' : 'gray'} onClick={onClick} title={title} size="md">
      {children}
    </ActionIcon>
  );
}

export default function BubbleToolbar({ editor }) {
  if (!editor) return null;

  const setLink = () => {
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('Link URL', prev);
    if (url === null) return;
    if (url === '') editor.chain().focus().unsetLink().run();
    else editor.chain().focus().setLink({ href: url }).run();
  };

  const blockLabel = editor.isActive('heading', { level: 1 }) ? 'Heading 1'
    : editor.isActive('heading', { level: 2 }) ? 'Heading 2'
    : editor.isActive('heading', { level: 3 }) ? 'Heading 3'
    : editor.isActive('bulletList') ? 'Bullet list'
    : editor.isActive('orderedList') ? 'Numbered list'
    : editor.isActive('blockquote') ? 'Quote'
    : 'Text';

  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 100, maxWidth: 'none' }}
      shouldShow={({ editor: e, state }) => {
        if (state.selection.empty) return false;
        if (!e.isEditable) return false;
        for (const name of ['codeBlock', 'image', 'mermaidDiagram', 'excalidraw', 'iframeEmbed', 'videoBlock']) {
          if (e.isActive(name)) return false;
        }
        return true;
      }}
    >
      <Paper shadow="md" p={4} withBorder>
        <Group gap={2} wrap="nowrap">
          <Menu withinPortal position="bottom-start">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="md" w={90} title="Block type"
                style={{ width: 'auto', paddingInline: 6, fontSize: 12, fontWeight: 600 }}>
                {blockLabel} <IconChevronDown size={12} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => editor.chain().focus().setParagraph().run()}>Text</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().setNode('heading', { level: 1 }).run()}>Heading 1</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().setNode('heading', { level: 2 }).run()}>Heading 2</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().setNode('heading', { level: 3 }).run()}>Heading 3</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().toggleBulletList().run()}>Bullet list</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().toggleOrderedList().run()}>Numbered list</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().toggleTaskList().run()}>To-do list</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().toggleBlockquote().run()}>Quote</Menu.Item>
              <Menu.Item onClick={() => editor.chain().focus().toggleCodeBlock().run()}>Code block</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Divider orientation="vertical" />
          <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (Ctrl+B)"><IconBold size={16} /></Btn>
          <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (Ctrl+I)"><IconItalic size={16} /></Btn>
          <Btn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (Ctrl+U)"><IconUnderline size={16} /></Btn>
          <Btn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough"><IconStrikethrough size={16} /></Btn>
          <Btn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Inline code"><IconCode size={16} /></Btn>
          <Btn active={editor.isActive('superscript')} onClick={() => editor.chain().focus().toggleSuperscript().run()} title="Superscript"><IconSuperscript size={16} /></Btn>
          <Btn active={editor.isActive('subscript')} onClick={() => editor.chain().focus().toggleSubscript().run()} title="Subscript"><IconSubscript size={16} /></Btn>
          <Btn active={editor.isActive('link')} onClick={setLink} title="Link"><IconLink size={16} /></Btn>
          <Divider orientation="vertical" />
          <Menu withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="md" title="Text color"><IconPalette size={16} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Group gap={4} p={4}>
                {COLORS.map((c) => (
                  <ActionIcon key={c} size="sm" style={{ background: c }} onClick={() => editor.chain().focus().setColor(c).run()} />
                ))}
                <ActionIcon size="sm" variant="default" onClick={() => editor.chain().focus().unsetColor().run()} title="Clear">
                  <IconClearFormatting size={12} />
                </ActionIcon>
              </Group>
            </Menu.Dropdown>
          </Menu>
          <Menu withinPortal>
            <Menu.Target>
              <ActionIcon variant={editor.isActive('highlight') ? 'filled' : 'subtle'} color="gray" size="md" title="Highlight"><IconHighlight size={16} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Group gap={4} p={4}>
                {HIGHLIGHTS.map((c) => (
                  <ActionIcon key={c} size="sm" style={{ background: c }} onClick={() => editor.chain().focus().setHighlight({ color: c }).run()} />
                ))}
                <ActionIcon size="sm" variant="default" onClick={() => editor.chain().focus().unsetHighlight().run()} title="Clear">
                  <IconClearFormatting size={12} />
                </ActionIcon>
              </Group>
            </Menu.Dropdown>
          </Menu>
          <Divider orientation="vertical" />
          <Btn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} title="Align left"><IconAlignLeft size={16} /></Btn>
          <Btn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} title="Align center"><IconAlignCenter size={16} /></Btn>
          <Btn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} title="Align right"><IconAlignRight size={16} /></Btn>
          <Btn onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} title="Clear formatting"><IconLetterCase size={16} /></Btn>
        </Group>
      </Paper>
    </BubbleMenu>
  );
}
