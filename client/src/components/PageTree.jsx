import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Group, Text, ActionIcon, Menu, UnstyledButton, Modal, TextInput, Button, Stack,
} from '@mantine/core';
import {
  IconChevronRight, IconDots, IconPlus, IconTrash, IconArrowUp, IconArrowDown,
  IconIndentIncrease, IconIndentDecrease, IconPencil, IconFileText, IconSitemap,
  IconFileImport,
} from '@tabler/icons-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { api, emitPagesChanged, onPagesChanged } from '../lib/api.js';
import PagePicker from './PagePicker.jsx';
import { markdownToJSON } from '../lib/markdown.js';

// Pull a leading `# Heading` off the markdown so it can seed the page title
// instead of being duplicated in the body.
function splitLeadingHeading(md) {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = lines[i]?.match(/^#\s+(.+?)\s*$/);
  if (!m) return { title: null, body: md };
  return { title: m[1].trim(), body: lines.slice(i + 1).join('\n') };
}

export default function PageTree({ space }) {
  const [pages, setPages] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [reparenting, setReparenting] = useState(null); // page whose parent is being chosen
  const [importParent, setImportParent] = useState(null);
  const [importDoc, setImportDoc] = useState(null); // { body, fallbackTitle }
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pathParts = pathname.split('/');
  const activePageId = pathParts[3] === 'p' ? pathParts[4] : null;
  const canWrite = ['admin', 'writer'].includes(space.my_role);

  const load = useCallback(async () => {
    const data = await api.get(`/api/spaces/${space.id}/pages`);
    setPages(data.pages);
  }, [space.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(
    () =>
      onPagesChanged((e) => {
        if (!e.detail.spaceId || e.detail.spaceId === space.id) load();
      }),
    [load, space.id]
  );

  const childrenOf = useMemo(() => {
    const map = new Map();
    for (const p of pages) {
      const key = p.parent_id || 'root';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return map;
  }, [pages]);

  // auto-expand ancestors of the active page
  useEffect(() => {
    if (!activePageId) return;
    const byId = new Map(pages.map((p) => [p.id, p]));
    const next = new Set(expanded);
    let cursor = byId.get(activePageId);
    while (cursor?.parent_id) {
      next.add(cursor.parent_id);
      cursor = byId.get(cursor.parent_id);
    }
    setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, pages]);

  const createPage = async (parentId = null) => {
    try {
      const data = await api.post('/api/pages', { spaceId: space.id, parentId });
      emitPagesChanged(space.id);
      if (parentId) setExpanded((s) => new Set([...s, parentId]));
      navigate(`/s/${space.slug}/p/${data.page.id}`);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const pickImportFile = (parentId) => {
    setImportParent(parentId);
    importInputRef.current?.click();
  };

  const readImportFile = async (file) => {
    try {
      const text = await file.text();
      const { title, body } = splitLeadingHeading(text);
      const fallbackTitle = title || file.name.replace(/\.(md|markdown|txt)$/i, '');
      setImportDoc({ body, fallbackTitle });
      setImportName(fallbackTitle);
    } catch (err) {
      notifications.show({ color: 'red', message: `${file.name}: ${err.message}` });
      setImportParent(null);
    }
  };

  const closeImport = () => {
    setImportDoc(null);
    setImportParent(null);
    setImportName('');
  };

  const runImport = async () => {
    if (!importDoc || importing) return;
    const title = importName.trim() || importDoc.fallbackTitle || 'Untitled';
    setImporting(true);
    try {
      // One request: the page comes into existence with its body already in
      // place, so the editor cannot open it during the window where it exists
      // but is still empty.
      const d = await api.post('/api/pages', {
        spaceId: space.id,
        parentId: importParent,
        title,
        content: markdownToJSON(importDoc.body),
      });
      emitPagesChanged(space.id);
      if (importParent) setExpanded((s) => new Set([...s, importParent]));
      closeImport();
      navigate(`/s/${space.slug}/p/${d.page.id}`);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    } finally {
      setImporting(false);
    }
  };

  const act = async (fn) => {
    try {
      await fn();
      emitPagesChanged(space.id);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const renderNode = (page, depth) => {
    const kids = childrenOf.get(page.id) || [];
    const isOpen = expanded.has(page.id);
    const siblings = childrenOf.get(page.parent_id || 'root') || [];
    const idx = siblings.findIndex((s) => s.id === page.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    // Only top-level pages take children, and only a childless page can become
    // one — the server enforces the same rule.
    const canNest = !page.parent_id;
    const canBeNested = !page.parent_id && kids.length === 0;

    return (
      <div key={page.id}>
        <Group
          gap={2}
          wrap="nowrap"
          className={`gd-tree-row ${page.id === activePageId ? 'is-active' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          <ActionIcon
            size="xs" variant="subtle" color="gray"
            style={{ visibility: kids.length ? 'visible' : 'hidden' }}
            onClick={() =>
              setExpanded((s) => {
                const next = new Set(s);
                next.has(page.id) ? next.delete(page.id) : next.add(page.id);
                return next;
              })
            }
          >
            <IconChevronRight size={13} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
          </ActionIcon>
          <UnstyledButton
            className="gd-tree-label"
            onClick={() => navigate(`/s/${space.slug}/p/${page.id}`)}
          >
            <Group gap={6} wrap="nowrap">
              {page.icon ? <span>{page.icon}</span> : <IconFileText size={14} opacity={0.6} />}
              <Text size="sm" truncate>{page.title || 'Untitled'}</Text>
            </Group>
          </UnstyledButton>
          {canWrite && (
            <span className="gd-tree-actions">
              <Menu withinPortal position="bottom-start" shadow="md">
                <Menu.Target>
                  <ActionIcon size="xs" variant="subtle" color="gray"><IconDots size={13} /></ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {/* The tree is one level deep, so a subpage takes no children
                      of its own — neither created nor imported. */}
                  {canNest && (
                    <>
                      <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => createPage(page.id)}>
                        New subpage
                      </Menu.Item>
                      <Menu.Item leftSection={<IconFileImport size={14} />} onClick={() => pickImportFile(page.id)}>
                        Import markdown file
                      </Menu.Item>
                    </>
                  )}
                  <Menu.Item
                    leftSection={<IconPencil size={14} />}
                    onClick={() => {
                      const title = window.prompt('Rename page', page.title);
                      if (title !== null) act(() => api.patch(`/api/pages/${page.id}`, { title }));
                    }}
                  >
                    Rename
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    leftSection={<IconArrowUp size={14} />} disabled={idx <= 0}
                    onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, {
                      parentId: page.parent_id, position: siblings[idx - 1].position - 1,
                    }))}
                  >
                    Move up
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconArrowDown size={14} />} disabled={idx === siblings.length - 1}
                    onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, {
                      parentId: page.parent_id, position: siblings[idx + 1].position + 1,
                    }))}
                  >
                    Move down
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconIndentIncrease size={14} />} disabled={idx <= 0 || !canBeNested}
                    onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, { parentId: siblings[idx - 1].id }))}
                  >
                    Nest under previous
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconSitemap size={14} />}
                    onClick={() => setReparenting(page)}
                  >
                    Set parent page…
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconIndentDecrease size={14} />} disabled={!page.parent_id}
                    onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, {
                      parentId: byId.get(page.parent_id)?.parent_id || null,
                    }))}
                  >
                    Move out one level
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    color="red" leftSection={<IconTrash size={14} />}
                    onClick={() => {
                      if (page.id === activePageId) navigate(`/s/${space.slug}`);
                      act(() => api.del(`/api/pages/${page.id}`));
                    }}
                  >
                    Move to trash
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </span>
          )}
        </Group>
        {isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const roots = childrenOf.get('root') || [];
  return (
    <div className="gd-tree">
      <input
        ref={importInputRef} type="file" accept=".md,.markdown,.txt" hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) readImportFile(file);
        }}
      />
      <Modal opened={!!importDoc} onClose={closeImport} title="Import markdown file" centered>
        <Stack gap="md">
          <TextInput
            label="Page name" data-autofocus value={importName}
            onChange={(e) => setImportName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runImport(); }}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={closeImport}>Cancel</Button>
            <Button onClick={runImport} loading={importing}>Import</Button>
          </Group>
        </Stack>
      </Modal>
      <PagePicker
        opened={Boolean(reparenting)}
        onClose={() => setReparenting(null)}
        onPick={(parent) => {
          const child = reparenting;
          act(() => api.post(`/api/pages/${child.id}/move`, { parentId: parent?.id ?? null }));
          if (parent) setExpanded((s) => new Set([...s, parent.id]));
        }}
        title={`Set parent of “${reparenting?.title || 'Untitled'}”`}
        spaceId={space.id}
        exclude={reparenting?.id}
        rootLabel="No parent (top level)"
        onlySpace
        topLevelOnly
      />
      {roots.map((p) => renderNode(p, 0))}
      {canWrite && (
        <UnstyledButton className="gd-tree-add" onClick={() => createPage(null)}>
          <Group gap={6}><IconPlus size={13} /><Text size="xs">New page</Text></Group>
        </UnstyledButton>
      )}
    </div>
  );
}
