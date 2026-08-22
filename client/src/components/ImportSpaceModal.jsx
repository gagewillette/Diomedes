// Bring a space in from another workspace using an import code.
//
// Two steps on purpose. Pasting a code and immediately having a space full of
// someone else's pages appear is not a decision anyone got to make; the preview
// turns it into one — here is the space, here is its tree, here is how much of
// it is real content — with the actual write behind a second, named button.
import { useEffect, useState } from 'react';
import {
  Modal, Stack, Group, Text, Button, Textarea, TextInput, Alert, Badge, ScrollArea,
  Divider, Box, Center, Loader,
} from '@mantine/core';
import { IconDownload, IconAlertCircle, IconFileText } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import Emoji from './Emoji.jsx';

export default function ImportSpaceModal({ opened, onClose }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!opened) return;
    setCode('');
    setPreview(null);
    setError(null);
    setName('');
  }, [opened]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const d = await api.post('/api/spaces/import/preview', { code: code.trim() });
      setPreview(d.preview);
      setName(d.preview.space?.name || '');
    } catch (err) {
      // Shown inline rather than as a toast: the code is still on screen and
      // the message is usually about the code itself.
      setError(err.message);
      setPreview(null);
    } finally {
      setChecking(false);
    }
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const d = await api.post('/api/spaces/import', { code: code.trim(), name: name.trim() });
      notifications.show({
        color: 'green',
        message: `Imported ${d.imported.withContent} page${d.imported.withContent === 1 ? '' : 's'} into “${d.space.name}”`,
      });
      window.dispatchEvent(new CustomEvent('spaces-changed'));
      onClose();
      navigate(`/s/${d.space.slug}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  // The outline arrives flat with parent ids; indent by walking up, which is
  // cheap at preview sizes and avoids building a tree for a read-only list.
  const depthOf = (page, byId, seen = new Set()) => {
    let depth = 0;
    let cursor = page.parentId;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      depth++;
      cursor = byId.get(cursor).parentId;
    }
    return depth;
  };
  const byId = new Map((preview?.outline ?? []).map((p) => [p.id, p]));

  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={
      <Group gap={8}><IconDownload size={17} /><Text fw={600}>Import a space</Text></Group>
    }>
      <Stack gap="sm">
        <Textarea
          label="Import code"
          description="Paste the code created in the other workspace under Space → Share."
          placeholder="DIO1.aHR0cHM6Ly8…"
          value={code}
          onChange={(e) => { setCode(e.target.value); setPreview(null); setError(null); }}
          autosize minRows={2} maxRows={4} data-autofocus
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
        />

        {error && (
          <Alert color="red" icon={<IconAlertCircle size={16} />} title="Cannot import">
            <Text size="sm">{error}</Text>
          </Alert>
        )}

        {!preview && (
          <Group justify="flex-end">
            <Button onClick={check} loading={checking} disabled={!code.trim()}>
              Check code
            </Button>
          </Group>
        )}

        {preview && (
          <>
            <Divider label="What this code contains" labelPosition="left" />
            <Group gap={10} wrap="nowrap">
              <Emoji char={preview.space?.icon || '📚'} size={28} />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text fw={600} truncate>{preview.space?.name}</Text>
                <Text size="xs" c="dimmed">
                  {preview.withContent} page{preview.withContent === 1 ? '' : 's'} with content
                  {preview.placeholders > 0 && ` · ${preview.placeholders} kept for structure`}
                  {preview.exportName && ` · from the key “${preview.exportName}”`}
                </Text>
              </Box>
            </Group>

            <ScrollArea.Autosize mah={220} type="auto" className="gd-export-tree">
              <Stack gap={1}>
                {preview.outline.map((page) => (
                  <Group key={page.id} gap={6} wrap="nowrap" className="gd-export-row"
                    style={{ paddingLeft: depthOf(page, byId) * 16 }}>
                    <span className="gd-tree-icon">
                      {page.icon ? <Emoji char={page.icon} size={14} /> : <IconFileText size={13} opacity={0.5} />}
                    </span>
                    <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}
                      c={page.includeContent ? undefined : 'dimmed'}>
                      {page.title || 'Untitled'}
                    </Text>
                    {!page.includeContent && (
                      <Badge size="xs" variant="light" color="gray">structure only</Badge>
                    )}
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>

            <TextInput
              label="Import as"
              description="A new space is created here — nothing existing is touched."
              value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            />

            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => { setPreview(null); setError(null); }}>
                Back
              </Button>
              <Button onClick={runImport} loading={importing} disabled={!name.trim()}>
                Import {preview.pages} page{preview.pages === 1 ? '' : 's'}
              </Button>
            </Group>
          </>
        )}

        {checking && !preview && (
          <Center py="xs"><Loader size="xs" /></Center>
        )}
      </Stack>
    </Modal>
  );
}
