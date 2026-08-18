import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Text, ActionIcon, Menu, UnstyledButton } from '@mantine/core';
import {
  IconChevronRight, IconDots, IconPlus, IconTrash, IconArrowUp, IconArrowDown,
  IconIndentIncrease, IconIndentDecrease, IconPencil, IconFileText,
} from '@tabler/icons-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { api, emitPagesChanged, onPagesChanged } from '../lib/api.js';

export default function PageTree({ space }) {
  const [pages, setPages] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
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
                  <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => createPage(page.id)}>
                    New subpage
                  </Menu.Item>
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
                    leftSection={<IconIndentIncrease size={14} />} disabled={idx <= 0}
                    onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, { parentId: siblings[idx - 1].id }))}
                  >
                    Nest under previous
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
      {roots.map((p) => renderNode(p, 0))}
      {canWrite && (
        <UnstyledButton className="gd-tree-add" onClick={() => createPage(null)}>
          <Group gap={6}><IconPlus size={13} /><Text size="xs">New page</Text></Group>
        </UnstyledButton>
      )}
    </div>
  );
}
