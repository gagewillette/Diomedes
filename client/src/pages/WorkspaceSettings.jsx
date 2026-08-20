import { useEffect, useState } from 'react';
import {
  Container, Title, Paper, Stack, Text, Switch, Group, Alert, Badge, Slider, Anchor,
  TextInput, Button,
} from '@mantine/core';
import { IconInfoCircle, IconPointer, IconUpload, IconGauge } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';
import { WORKSPACE_NAME_MAX } from '../lib/workspace.js';
import { useDocumentIdentity } from '../lib/documentTitle.js';

/**
 * Workspace-wide settings. Unlike /settings (which is per-account), everything
 * here applies to every member at once, so only owners and admins can change it.
 */
export default function WorkspaceSettings() {
  const {
    workspaceName, dataSavings, updateDataSavings, performanceSettings, updatePerformance,
    updateWorkspaceName, isAdmin,
  } = useAuth();
  useDocumentIdentity(`${workspaceName} settings`, '⚙️');
  const [saving, setSaving] = useState(null);
  // The slider is dragged locally and only written on release; every drag step
  // would otherwise be a PATCH and an SSE fan-out to every browser.
  const [rate, setRate] = useState(performanceSettings.sampleRate);
  // Draft name, written on Save. It follows the workspace name whenever that
  // changes underneath us — another admin renaming it, or /api/auth/me landing
  // after this screen has already mounted.
  const [name, setName] = useState(workspaceName);
  useEffect(() => setName(workspaceName), [workspaceName]);

  const save = async (key, run) => {
    setSaving(key);
    try {
      await run();
      notifications.show({ color: 'green', message: 'Workspace settings updated' });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    } finally {
      setSaving(null);
    }
  };

  const toggle = (key, enabled) => save(key, () => updateDataSavings({ [key]: enabled }));

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === workspaceName) return;
    save('name', () => updateWorkspaceName(trimmed));
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

      <Paper withBorder p="md" mb="md">
        <Stack>
          <div>
            <Text fw={700} size="sm">Name</Text>
            <Text size="xs" c="dimmed">
              What this workspace is called in the sidebar, on the login screen and on shared pages.
            </Text>
          </div>
          <TextInput
            label="Workspace name"
            value={name}
            maxLength={WORKSPACE_NAME_MAX}
            disabled={!isAdmin || saving === 'name'}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveName()}
          />
          <Group justify="flex-end">
            <Button
              onClick={saveName}
              loading={saving === 'name'}
              disabled={!isAdmin || !name.trim() || name.trim() === workspaceName}
            >
              Save name
            </Button>
          </Group>
        </Stack>
      </Paper>

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

      <Paper withBorder p="md" mt="md">
        <Stack>
          <div>
            <Group gap={6}>
              <Text fw={700} size="sm">Performance</Text>
              {!performanceSettings.logging && (
                <Badge size="xs" variant="light" color="gray">Off</Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              How long pages take to open, how long the server takes to answer, and how many
              bytes move — computed on{' '}
              <Anchor component={Link} to="/settings/workspace/info" size="xs">Workspace info</Anchor>.
            </Text>
          </div>

          <Switch
            label={
              <Group gap={6}>
                <IconGauge size={14} />
                <span>Turn off performance logging</span>
              </Group>
            }
            description="Stops the browser and the server from recording timing samples. Nothing new is measured and no new rows are written; the metrics already collected stay until they age out or you clear them."
            checked={!performanceSettings.logging}
            disabled={!isAdmin || saving === 'logging'}
            onChange={(e) => save('logging', () => updatePerformance({ logging: !e.currentTarget.checked }))}
          />

          {performanceSettings.logging && (
            <div>
              <Text size="sm" fw={500}>Sample rate — {Math.round(rate * 100)}%</Text>
              <Text size="xs" c="dimmed" mb="xs">
                The share of browser samples actually recorded. Turn it down on a busy
                workspace: percentiles stay honest on a fraction of the traffic, and the table
                stays small. Page opens and web vitals are always kept.
              </Text>
              <Slider
                min={0.05}
                max={1}
                step={0.05}
                value={rate}
                disabled={!isAdmin || saving === 'sampleRate'}
                label={(v) => `${Math.round(v * 100)}%`}
                marks={[
                  { value: 0.05, label: '5%' },
                  { value: 0.5, label: '50%' },
                  { value: 1, label: '100%' },
                ]}
                onChange={setRate}
                onChangeEnd={(v) => save('sampleRate', () => updatePerformance({ sampleRate: v }))}
                mb="lg"
              />
            </div>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}
