import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import { IconChevronRight } from '@tabler/icons-react';

function ToggleView({ node, updateAttributes, editor }) {
  const { open, title } = node.attrs;
  return (
    <NodeViewWrapper className={`gd-toggle ${open ? 'is-open' : ''}`}>
      <div className="gd-toggle-header" contentEditable={false}>
        <button
          className="gd-toggle-chevron"
          onClick={() => updateAttributes({ open: !open })}
          title={open ? 'Collapse' : 'Expand'}
          type="button"
        >
          <IconChevronRight size={16} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
        </button>
        {editor.isEditable ? (
          <input
            className="gd-toggle-title"
            value={title}
            placeholder="Toggle title"
            onChange={(e) => updateAttributes({ title: e.target.value })}
          />
        ) : (
          <span className="gd-toggle-title">{title || 'Toggle'}</span>
        )}
      </div>
      <NodeViewContent className="gd-toggle-body" style={{ display: open ? undefined : 'none' }} />
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      title: { default: '' },
      open: { default: true },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="toggle"]', getAttrs: (el) => ({ title: el.getAttribute('data-title') || '' }) }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'toggle', 'data-title': node.attrs.title }),
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
});
