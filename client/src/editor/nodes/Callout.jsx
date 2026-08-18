import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import { Menu, ActionIcon } from '@mantine/core';

const VARIANTS = {
  info: { emoji: 'ℹ️', label: 'Info' },
  success: { emoji: '✅', label: 'Success' },
  warning: { emoji: '⚠️', label: 'Warning' },
  danger: { emoji: '🚨', label: 'Danger' },
  note: { emoji: '📝', label: 'Note' },
};

function CalloutView({ node, updateAttributes, editor }) {
  const variant = VARIANTS[node.attrs.variant] ? node.attrs.variant : 'info';
  return (
    <NodeViewWrapper className={`gd-callout gd-callout-${variant}`}>
      <div className="gd-callout-icon" contentEditable={false}>
        {editor.isEditable ? (
          <Menu withinPortal position="bottom-start">
            <Menu.Target>
              <ActionIcon variant="subtle" size="md" title="Change callout type">
                <span style={{ fontSize: 16 }}>{VARIANTS[variant].emoji}</span>
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {Object.entries(VARIANTS).map(([key, v]) => (
                <Menu.Item key={key} onClick={() => updateAttributes({ variant: key })}>
                  {v.emoji} {v.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        ) : (
          <span style={{ fontSize: 16 }}>{VARIANTS[variant].emoji}</span>
        )}
      </div>
      <NodeViewContent className="gd-callout-body" />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { variant: { default: 'info' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'callout',
        class: `gd-callout gd-callout-${node.attrs.variant}`,
      }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
