import { useCallback, useEffect, useState } from 'react';
import { Text, Group, Stack, UnstyledButton, Divider, Badge } from '@mantine/core';
import { IconLink, IconFileText, IconChevronRight } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { api, onPagesChanged } from '../lib/api.js';

// "What points here?" — the other half of a wiki link. Sits under the document
// so a page shows its inbound references without anyone maintaining a list.
export default function BacklinksPanel({ pageId, spaceId }) {
  const [backlinks, setBacklinks] = useState([]);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/pages/${pageId}/backlinks`, { noRedirect: true });
      setBacklinks(data.backlinks);
    } catch {
      setBacklinks([]);
    }
  }, [pageId]);

  useEffect(() => { load(); }, [load]);
  useEffect(
    () => onPagesChanged((e) => {
      if (!e.detail.spaceId || e.detail.spaceId === spaceId) load();
    }),
    [load, spaceId]
  );

  if (!backlinks.length) return null;

  return (
    <div className="gd-backlinks">
      <Divider my="xl" />
      <UnstyledButton onClick={() => setOpen((o) => !o)} className="gd-backlinks-head">
        <Group gap={6}>
          <IconChevronRight
            size={14}
            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}
          />
          <IconLink size={15} opacity={0.7} />
          <Text size="sm" fw={600}>Linked references</Text>
          <Badge size="sm" variant="light">{backlinks.length}</Badge>
        </Group>
      </UnstyledButton>
      {open && (
        <Stack gap={2} mt="xs">
          {backlinks.map((b) => (
            <UnstyledButton
              key={b.id}
              component={Link}
              to={`/s/${b.space_slug}/p/${b.id}`}
              className="gd-picker-item"
            >
              <Group gap={8} wrap="nowrap">
                {b.icon ? <span>{b.icon}</span> : <IconFileText size={15} opacity={0.6} />}
                <Text size="sm" truncate style={{ flex: 1 }}>{b.title || 'Untitled'}</Text>
                <Text size="xs" c="dimmed">{b.space_name}</Text>
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
      )}
    </div>
  );
}
