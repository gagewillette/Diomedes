import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Textarea, Button, Group, Text, Tooltip } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { IconZoomScan } from '@tabler/icons-react';
import { openDiagramLightbox, useZoomClickHandlers } from '../DiagramLightbox';
import { nextRenderId, removeRenderScratch } from '../../lib/mermaidRender.js';
import { focusBelowDiagram, selectDiagramNode } from '../diagramFlow.js';

let mermaidPromise = null;
async function getMermaid(dark) {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  return mermaid;
}

function MermaidView({ node, updateAttributes, editor, selected, getPos }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.attrs.code);
  const colorScheme = useComputedColorScheme('light');
  const alive = useRef(true);

  // remount has to revive the flag — StrictMode runs mount/cleanup/mount, and a
  // flag left false there would silently swallow every later render
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = nextRenderId();
      try {
        const mermaid = await getMermaid(colorScheme === 'dark');
        const { svg: out } = await mermaid.render(id, node.attrs.code || 'graph TD\n  A[empty]');
        if (!cancelled && alive.current) { setSvg(out); setError(null); }
      } catch (err) {
        // mermaid leaves an orphan error div behind on failure — this render's,
        // not whichever one the counter has reached by now
        removeRenderScratch(id);
        if (!cancelled && alive.current) { setSvg(''); setError(String(err?.message || err)); }
      }
    })();
    return () => { cancelled = true; };
  }, [node.attrs.code, colorScheme]);

  const save = () => {
    updateAttributes({ code: draft });
    setEditing(false);
    // A saved diagram is finished: hand the author a fresh line under it rather
    // than a selected atom they cannot type into.
    setTimeout(() => focusBelowDiagram(editor, getPos), 0);
  };

  const openZoom = () => openDiagramLightbox({ key: `mermaid-${node.attrs.code}`, title: 'Mermaid diagram', html: svg });

  const zoomHandlers = useZoomClickHandlers({
    editable: editor.isEditable,
    onZoom: () => openZoom(),
    onEdit: () => { setDraft(node.attrs.code); setEditing(true); },
    onSelect: () => selectDiagramNode(editor, getPos),
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
              onClick={openZoom}
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
  // No content expression at all: a diagram block holds its diagram and has no
  // position inside it where anything else could be typed or pasted.
  atom: true,
  // Selectable and draggable so the block can be copied and the copy dropped.
  // Attributes are per-node and blockId.js renames a colliding id, so the two
  // copies drift apart the moment one of them is edited.
  selectable: true,
  draggable: true,
  addAttributes() {
    return { code: { default: 'graph TD\n  A --> B' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="mermaid"]', getAttrs: (el) => ({ code: el.getAttribute('data-code') || '' }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Merging HTMLAttributes is what carries the global block id through the
    // HTML round trip ProseMirror uses for copy/paste and for saving.
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mermaid', 'data-code': node.attrs.code })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MermaidView);
  },
});
