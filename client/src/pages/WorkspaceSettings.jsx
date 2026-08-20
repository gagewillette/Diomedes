import { useState } from 'react';
import { Container, Title, Paper, Stack, Text, Switch, Group, Alert, Badge } from '@mantine/core';
import { IconInfoCircle, IconPointer, IconUpload } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useAuth } from '../lib/AuthContext.jsx';

/**
 * Workspace-wide settings. Unlike /settings (which is per-account), everything
 * here applies to every member at once, so only owners and admins can change it.
 */
export default function WorkspaceSettings() {
  const { workspaceName, dataSavings, updateDataSavings, isAdmin } = useAuth();
  const [saving, setSaving] = useState(null);

  const toggle = async (key, enabled) => {
    setSaving(key);
    try {
      await updateDataSavings({ [key]: enabled });
      notifications.show({ color: 'green', message: 'Workspace settings updated' });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Container size="sm" py="xl" className="gd-fade-in">
      <Title order={2}>Workspace settings</Title>
      <Text c="dimmed" size="sm" mb="lg">
        These apply to {workspaceName} and everyone in it.
      </Text>

      {!isAdmin && (
        <Alert icon={<IconInfoCircle size={16} />} color="gray" mb="lg">
          Only workspace owners and admins can change these settings.
        </Alert>
      )}

      <Paper withBorder p="md">
        <Stack>
          <div>
            <Group gap={6}>
              <Text fw={700} size="sm">Data savings</Text>
              {(!dataSavings.livePointers || !dataSavings.fileUploads) && (
                <Badge size="xs" variant="light" color="teal">On</Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Turn off the parts of the workspace that move the most data around.
            </Text>
          </div>

          <Switch
            label={
              <Group gap={6}>
                <IconPointer size={14} />
                <span>Turn off live pointers</span>
              </Group>
            }
            description="Stops broadcasting and drawing other people's mouse pointers as they move around a page. Live text cursors, selections and edits are unaffected."
            checked={!dataSavings.livePointers}
            disabled={!isAdmin || saving === 'livePointers'}
            onChange={(e) => toggle('livePointers', !e.currentTarget.checked)}
          />

          <Switch
            label={
              <Group gap={6}>
                <IconUpload size={14} />
                <span>Turn off file uploads</span>
              </Group>
            }
            description="Stops new images, videos, attachments and documents from being uploaded anywhere in this workspace. Files that are already here stay in place and keep working — they can still be viewed and downloaded."
            checked={!dataSavings.fileUploads}
            disabled={!isAdmin || saving === 'fileUploads'}
            onChange={(e) => toggle('fileUploads', !e.currentTarget.checked)}
          />
        </Stack>
      </Paper>
    </Container>
  );
}
