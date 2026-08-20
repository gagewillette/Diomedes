import { useEffect, useState } from 'react';
import { Modal, TextInput, Stack, Group, Text, UnstyledButton, Loader, Center } from '@mantine/core';
import { IconSearch, IconFileText, IconHome } from '@tabler/icons-react';
import { api } from '../lib/api.js';
import Emoji from './Emoji.jsx';

// Search-and-pick dialog over every page the user can read. Used to choose a
// page's parent, so nesting is an explicit choice rather than something you
// nudge into place with "move up" / "indent" one step at a time.
//
// `exclude` is a page id or a list of them. As a parent picker it should be the
// whole subtree of the page being moved: pages nest to any depth now, so a
// descendant is a plausible-looking destination that the server can only refuse
// after the user has picked it.
export default function PagePicker({
  opened,
  onClose,
  onPick,
  title = 'Link to a page',
  spaceId = null,
  exclude = null,
  rootLabel = null,
  onlySpace = false,
}) {
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const excludeKey = [].concat(exclude || []).join(',');

  useEffect(() => {
    if (!opened) return undefined;
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query });
        if (spaceId) params.set('spaceId', spaceId);
        if (onlySpace) params.set('onlySpace', '1');
        for (const id of [].concat(exclude || [])) params.append('exclude', id);
        const data = await api.get(`/api/pages/link-search?${params}`);
        if (!cancelled) setPages(data.pages);
      } catch {
        if (!cancelled) setPages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  // Joined rather than passed straight through: `exclude` is usually a freshly
  // built array, and a raw array in the dependency list would refetch on every
  // render of the parent.
  }, [opened, query, spaceId, excludeKey, onlySpace]);

  // Start each visit from a clean search rather than the last one's leftovers.
  useEffect(() => {
    if (opened) setQuery('');
  }, [opened]);

  const pick = (page) => {
    onPick(page);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg">
      <TextInput
        data-autofocus
        placeholder="Search pages…"
        leftSection={<IconSearch size={15} />}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        mb="sm"
      />
      <Stack gap={2} mih={200}>
        {rootLabel && (
          <UnstyledButton className="gd-picker-item" onClick={() => pick(null)}>
            <Group gap={8} wrap="nowrap">
              <IconHome size={15} opacity={0.6} />
              <Text size="sm">{rootLabel}</Text>
            </Group>
          </UnstyledButton>
        )}
        {loading && !pages.length ? (
          <Center py="lg"><Loader size="sm" /></Center>
        ) : (
          pages.map((page) => (
            <UnstyledButton key={page.id} className="gd-picker-item" onClick={() => pick(page)}>
              <Group gap={8} wrap="nowrap">
                {page.icon ? <span>{page.icon}</span> : <IconFileText size={15} opacity={0.6} />}
                <Text size="sm" truncate style={{ flex: 1 }}>{page.title || 'Untitled'}</Text>
                <Text size="xs" c="dimmed"><Emoji char={page.space_icon} size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />{page.space_name}</Text>
              </Group>
            </UnstyledButton>
          ))
        )}
        {!loading && !pages.length && (
          <Center py="lg"><Text size="sm" c="dimmed">No pages found</Text></Center>
        )}
      </Stack>
    </Modal>
  );
}
