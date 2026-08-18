import { useEffect, useRef, useState } from 'react';
import { Modal, TextInput, Stack, UnstyledButton, Group, Text, Loader, Center } from '@mantine/core';
import { IconSearch, IconFileText } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const renderSnippet = (snippet) =>
  escapeHtml(snippet || '')
    .replaceAll('[[[', '<mark>')
    .replaceAll(']]]', '</mark>');

export default function SearchModal({ opened, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const timer = useRef(null);

  useEffect(() => {
    if (!opened) { setQuery(''); setResults([]); }
  }, [opened]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const data = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
        setResults(data.results);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  const go = (r) => {
    onClose();
    navigate(`/s/${r.space_slug}/p/${r.id}`);
  };

  return (
    <Modal opened={opened} onClose={onClose} size="lg" withCloseButton={false} padding="sm">
      <TextInput
        data-autofocus
        leftSection={<IconSearch size={16} />}
        rightSection={loading ? <Loader size="xs" /> : null}
        placeholder="Search all pages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) go(results[0]);
        }}
        size="md"
        mb="sm"
      />
      <Stack gap={4} mah={420} style={{ overflowY: 'auto' }}>
        {!loading && query.trim() && results.length === 0 && (
          <Center p="md"><Text c="dimmed" size="sm">No results</Text></Center>
        )}
        {results.map((r) => (
          <UnstyledButton key={r.id} className="gd-search-result" onClick={() => go(r)}>
            <Group gap="xs" wrap="nowrap">
              <span style={{ fontSize: 16 }}>{r.icon || <IconFileText size={16} />}</span>
              <div style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text fw={600} size="sm" truncate>{r.title || 'Untitled'}</Text>
                  <Text c="dimmed" size="xs">{r.space_name}</Text>
                </Group>
                <Text
                  size="xs" c="dimmed" lineClamp={2}
                  dangerouslySetInnerHTML={{ __html: renderSnippet(r.snippet) }}
                />
              </div>
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
    </Modal>
  );
}
