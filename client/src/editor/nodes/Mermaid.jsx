import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Textarea, Button, Group, Text, Tooltip } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconZoomScan } from '@tabler/icons-react';
import { DiagramLightbox, useZoomClickHandlers } from '../DiagramLightbox';

let mermaidPromise = null;
let renderCounter = 0;
async function getMermaid(dark) {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  return mermaid;
}

function MermaidView({ node, updateAttributes, editor, selected }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [draft, setDraft] = useState(node.attrs.code);
  const colorScheme = useComputedColorScheme('light');
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await getMermaid(colorScheme === 'dark');
        const id = `gd-mermaid-${++renderCounter}`;
        const { svg: out } = await mermaid.render(id, node.attrs.code || 'graph TD\n  A[empty]');
        if (!cancelled && alive.current) { setSvg(out); setError(null); }
      } catch (err) {
        // mermaid leaves an orphan error div behind on failure
        document.querySelector(`#dgd-mermaid-${renderCounter}`)?.remove();
        if (!cancelled && alive.current) setError(String(err?.message || err));
      }
    })();
    return () => { cancelled = true; };
  }, [node.attrs.code, colorScheme]);

  const save = () => {
    updateAttributes({ code: draft });
    setEditing(false);
    setTimeout(() => editor.commands.focus(), 0);
  };

  const zoomHandlers = useZoomClickHandlers({
    editable: editor.isEditable,
    onZoom: () => setZoomOpen(true),
    onEdit: () => { setDraft(node.attrs.code); setEditing(true); },
  });

  return (
    <NodeViewWrapper className={`gd-mermaid ${selected ? 'is-selected' : ''}`} contentEditable={false}>
      {error ? (
        <Text c="red" size="sm" p="sm" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          Mermaid error: {error}
        </Text>
      ) : (
        <div
          className="gd-mermaid-preview"
          {...zoomHandlers}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <div className="gd-node-actions">
        {!error && svg && (
          <Tooltip label="Open full screen">
            <ActionIcon
              size="sm"
              variant="light"
              aria-label="Open diagram full screen"
              onClick={() => setZoomOpen(true)}
            >
              <IconZoomScan size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {editor.isEditable && !editing && (
          <Button size="compact-xs" variant="light"
            onClick={() => { setDraft(node.attrs.code); setEditing(true); }}>
            Edit diagram
          </Button>
        )}
      </div>
      <DiagramLightbox
        opened={zoomOpen}
        onClose={() => setZoomOpen(false)}
        title="Mermaid diagram"
        html={svg}
      />
      {editing && (
        <div className="gd-mermaid-editor">
          <Textarea
            autosize minRows={4} maxRows={16} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            styles={{ input: { fontFamily: 'ui-monospace, monospace', fontSize: 13 } }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
              e.stopPropagation();
            }}
          />
          <Group gap="xs" mt="xs">
            <Button size="compact-sm" onClick={save}>Save</Button>
            <Button size="compact-sm" variant="subtle" onClick={() => setEditing(false)}>Cancel</Button>
          </Group>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const MermaidDiagram = Node.create({
  name: 'mermaidDiagram',
  group: 'block',
  atom: true,
  addAttributes() {
    return { code: { default: 'graph TD\n  A --> B' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="mermaid"]', getAttrs: (el) => ({ code: el.getAttribute('data-code') || '' }) }];
  },
  renderHTML({ node }) {
    return ['div', { 'data-type': 'mermaid', 'data-code': node.attrs.code }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MermaidView);
  },
});
