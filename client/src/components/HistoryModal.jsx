import { useEffect, useState } from 'react';
import { Modal, Group, Stack, Text, Button, UnstyledButton, ScrollArea, Loader, Center } from '@mantine/core';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import Editor from '../editor/Editor.jsx';

export default function HistoryModal({ pageId, opened, onClose, onRestored }) {
  const [versions, setVersions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) { setSelected(null); setPreview(null); return; }
    api.get(`/api/pages/${pageId}/versions`).then((d) => setVersions(d.versions));
  }, [opened, pageId]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    api.get(`/api/pages/${pageId}/versions/${selected}`)
      .then((d) => setPreview(d.version))
      .finally(() => setLoading(false));
  }, [selected, pageId]);

  const restore = async () => {
    await api.post(`/api/pages/${pageId}/versions/${selected}/restore`);
    onClose();
    onRestored?.();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Page history" size="90%" >
      <Group align="stretch" wrap="nowrap" style={{ minHeight: 420 }}>
        <ScrollArea w={240} style={{ flexShrink: 0, borderRight: '1px solid var(--mantine-color-default-border)' }}>
          <Stack gap={2} pr="sm">
            {versions.length === 0 && <Text c="dimmed" size="sm">No versions yet. Snapshots are taken automatically as you edit.</Text>}
            {versions.map((v) => (
              <UnstyledButton
                key={v.id}
                className={`gd-version-row ${selected === v.id ? 'is-active' : ''}`}
                onClick={() => setSelected(v.id)}
              >
                <Text size="sm" fw={600}>{dayjs(v.created_at).format('MMM D, YYYY HH:mm')}</Text>
                <Text size="xs" c="dimmed">{v.title || 'Untitled'} — {v.created_by_name || 'unknown'}</Text>
              </UnstyledButton>
            ))}
          </Stack>
        </ScrollArea>
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selected && <Center h="100%"><Text c="dimmed">Select a version to preview</Text></Center>}
          {loading && <Center h="100%"><Loader /></Center>}
          {preview && !loading && (
            <>
              <Group justify="space-between" mb="xs">
                <Text fw={700}>{preview.title || 'Untitled'}</Text>
                <Button size="compact-sm" onClick={restore}>Restore this version</Button>
              </Group>
              <ScrollArea h={420}>
                <Editor key={preview.id} content={preview.content} editable={false} />
              </ScrollArea>
            </>
          )}
        </div>
      </Group>
    </Modal>
  );
}
