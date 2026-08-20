import { useEffect, useState } from 'react';
import { Paper, Stack, Text, Progress, Group } from '@mantine/core';
import { subscribeUploads, getUploads } from '../lib/uploadStore.js';

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// A fixed panel, separate from Mantine's Notifications stack, so a large
// upload's progress stays visible (and the user can see it's still working
// instead of clicking upload again) rather than disappearing like a toast.
export default function UploadProgress() {
  const [uploads, setUploads] = useState(getUploads());

  useEffect(() => subscribeUploads(setUploads), []);

  if (uploads.length === 0) return null;

  return (
    <Stack
      gap="xs"
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        zIndex: 400,
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {uploads.map((u) => (
        <Paper key={u.id} withBorder shadow="sm" radius="md" p="sm">
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="sm" fw={500} truncate="end">
              {u.name}
            </Text>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {u.status === 'error' ? 'Failed' : u.status === 'done' ? 'Done' : formatBytes(u.size)}
            </Text>
          </Group>
          <Progress
            mt={6}
            value={Math.round(u.progress * 100)}
            color={u.status === 'error' ? 'red' : u.status === 'done' ? 'green' : 'blue'}
            animated={u.status === 'uploading'}
            size="sm"
          />
          {u.status === 'error' && (
            <Text size="xs" c="red" mt={4}>
              {u.error}
            </Text>
          )}
        </Paper>
      ))}
    </Stack>
  );
}
