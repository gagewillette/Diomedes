import { useCallback, useEffect, useState } from 'react';
import {
  Container, Title, Paper, TextInput, PasswordInput, Button, Stack, Text, Select,
  Slider, SegmentedControl, Switch, Group, Table, ActionIcon, Modal, Code, CopyButton,
  Tooltip, Alert, Badge,
} from '@mantine/core';
import { IconTrash, IconCopy, IconCheck, IconPlugConnected } from '@tabler/icons-react';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useDocumentIdentity } from '../lib/documentTitle.js';
import {
  FONT_LABELS, FONT_STACKS, KEYMAP_LABELS, VIM_CHALLENGE, isVimQuitAnswer,
} from '../lib/prefs.js';

export default function Settings() {
  const { user, refresh, preferences, updatePreferences } = useAuth();
  useDocumentIdentity('Settings', '⚙️');
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });

  const savePref = (partial) =>
    updatePreferences(partial).catch((err) =>
      notifications.show({ color: 'red', message: err.message })
    );

  const saveName = async () => {
    try {
      await api.patch('/api/auth/profile', { name });
      await refresh();
      notifications.show({ color: 'green', message: 'Profile updated' });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const changePassword = async () => {
    if (pw.next !== pw.confirm) {
      notifications.show({ color: 'red', message: 'Passwords do not match' });
      return;
    }
    try {
      await api.post('/api/auth/change-password', { current: pw.current, next: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      notifications.show({ color: 'green', message: 'Password changed' });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  return (
    <Container size="sm" py="xl" className="gd-fade-in">
      <Title order={2} mb="lg">Account settings</Title>

      <Paper withBorder p="md" mb="lg">
        <Stack>
          <Text fw={700} size="sm">Editor preferences</Text>
          <Text size="xs" c="dimmed" mt={-10}>
            These apply only to your account — every user has their own.
          </Text>
          <Select
            label="Font"
            data={Object.entries(FONT_LABELS).map(([value, label]) => ({ value, label }))}
            value={preferences.fontFamily}
            onChange={(v) => v && savePref({ fontFamily: v })}
            allowDeselect={false}
          />
          <div>
            <Text size="sm" fw={500} mb={4}>Font size — {preferences.fontSize}px</Text>
            <Slider
              min={13} max={22} step={1}
              value={preferences.fontSize}
              onChangeEnd={(v) => savePref({ fontSize: v })}
              marks={[{ value: 14 }, { value: 16 }, { value: 18 }, { value: 20 }]}
            />
          </div>
          <div>
            <Text size="sm" fw={500} mb={4}>Line spacing — {preferences.lineHeight}</Text>
            <Slider
              min={1.3} max={2.2} step={0.05}
              value={preferences.lineHeight}
              onChangeEnd={(v) => savePref({ lineHeight: Math.round(v * 100) / 100 })}
              marks={[{ value: 1.5 }, { value: 1.65 }, { value: 2.0 }]}
            />
          </div>
          <div>
            <Text size="sm" fw={500} mb={4}>Page width</Text>
            <SegmentedControl
              fullWidth
              data={[
                { value: 'narrow', label: 'Narrow' },
                { value: 'normal', label: 'Normal' },
                { value: 'wide', label: 'Wide' },
              ]}
              value={preferences.editorWidth}
              onChange={(v) => savePref({ editorWidth: v })}
            />
          </div>
          <Switch
            label="Smooth caret"
            description="Word-style gliding cursor while typing"
            checked={preferences.smoothCaret}
            onChange={(e) => savePref({ smoothCaret: e.currentTarget.checked })}
          />
          <KeymapSetting value={preferences.keymap} onChange={(keymap) => savePref({ keymap })} />
          <Switch
            label="Interface animations"
            description="Fades, sidebar transitions and hover effects"
            checked={preferences.animations}
            onChange={(e) => savePref({ animations: e.currentTarget.checked })}
          />
          <Paper withBorder p="sm" radius="md">
            <Text size="xs" c="dimmed" mb={4}>Preview</Text>
            <Text
              style={{
                fontFamily: FONT_STACKS[preferences.fontFamily],
                fontSize: preferences.fontSize,
                lineHeight: preferences.lineHeight,
              }}
            >
              The quick brown fox jumps over the lazy dog — 0123456789.
            </Text>
          </Paper>
        </Stack>
      </Paper>

      <ApiTokens />

      <Paper withBorder p="md" mb="lg">
        <Stack>
          <Text fw={700} size="sm">Profile</Text>
          <TextInput label="Username" value={user.username} disabled />
          <TextInput label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={saveName} disabled={!name.trim() || name === user.name}>Save</Button>
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack>
          <Text fw={700} size="sm">Change password</Text>
          <PasswordInput label="Current password" value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <PasswordInput label="New password" description="At least 8 characters" value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <PasswordInput label="Confirm new password" value={pw.confirm}
            onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          <Button onClick={changePassword} disabled={pw.next.length < 8 || !pw.current}>
            Change password
          </Button>
        </Stack>
      </Paper>
    </Container>
  );
}

function ApiTokens() {
  const [tokens, setTokens] = useState([]);
  const [createOpen, createHandlers] = useDisclosure(false);
  const [tokenName, setTokenName] = useState('');
  const [freshToken, setFreshToken] = useState(null);

  const load = useCallback(async () => {
    const d = await api.get('/api/tokens');
    setTokens(d.tokens);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    try {
      const d = await api.post('/api/tokens', { name: tokenName });
      setFreshToken(d.token);
      setTokenName('');
      load();
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const revoke = async (id) => {
    await api.del(`/api/tokens/${id}`);
    load();
  };

  return (
    <Paper withBorder p="md" mb="lg">
      <Stack>
        <Group justify="space-between">
          <Group gap={6}>
            <IconPlugConnected size={16} />
            <Text fw={700} size="sm">API tokens</Text>
          </Group>
          <Button size="compact-sm" variant="light" onClick={() => { setFreshToken(null); createHandlers.open(); }}>
            New token
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={-8}>
          For scripts and MCP integrations. Send as <Code>Authorization: Bearer &lt;token&gt;</Code> —
          see docs/API.md in the repo. Tokens act as you, with your exact permissions.
        </Text>
        {tokens.length > 0 && (
          <Table verticalSpacing={4}>
            <Table.Tbody>
              {tokens.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td><Text size="sm" fw={500}>{t.name}</Text></Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">created {dayjs(t.created_at).format('MMM D, YYYY')}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {t.last_used_at ? `used ${dayjs(t.last_used_at).format('MMM D, HH:mm')}` : 'never used'}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Tooltip label="Revoke">
                      <ActionIcon size="sm" color="red" variant="subtle" onClick={() => revoke(t.id)}>
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>

      <Modal opened={createOpen} onClose={createHandlers.close} title="Create API token">
        {freshToken ? (
          <Stack>
            <Alert color="yellow" p="xs">
              Copy this token now — it will not be shown again.
            </Alert>
            <Group wrap="nowrap" gap="xs">
              <Code style={{ flex: 1, wordBreak: 'break-all' }}>{freshToken}</Code>
              <CopyButton value={freshToken}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" onClick={copy}
                    leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Button onClick={createHandlers.close}>Done</Button>
          </Stack>
        ) : (
          <Stack>
            <TextInput
              label="Token name" placeholder="mcp-token" data-autofocus
              value={tokenName} onChange={(e) => setTokenName(e.target.value)}
            />
            <Button onClick={create} disabled={!tokenName.trim()}>Create</Button>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}

/**
 * Emulation type. Turning vim on asks the one question that separates people
 * who want modal editing from people who are about to be trapped in it — get
 * it wrong and the setting does not change.
 */
function KeymapSetting({ value, onChange }) {
  const [askOpen, askHandlers] = useDisclosure(false);
  const [answer, setAnswer] = useState('');
  const [wrong, setWrong] = useState(0);

  const openChallenge = () => {
    setAnswer('');
    setWrong(0);
    askHandlers.open();
  };

  const submit = () => {
    if (!isVimQuitAnswer(answer)) {
      setWrong((n) => n + 1);
      return;
    }
    askHandlers.close();
    onChange('vim');
    notifications.show({ color: 'green', message: 'Vim bindings enabled — the editor starts in normal mode.' });
  };

  return (
    <div>
      <Select
        label={(
          <Group gap={8} align="center" wrap="nowrap">
            <span>Keyboard emulation</span>
            <Badge color="red" variant="filled" size="xs" radius="xl">
              Experimental Feature
            </Badge>
          </Group>
        )}
        description="Vim gives the document modal editing and the page tree j/k navigation. It covers most of vim, not all of it — expect rough edges."
        data={Object.entries(KEYMAP_LABELS).map(([v, label]) => ({ value: v, label }))}
        value={value}
        onChange={(v) => {
          if (!v || v === value) return;
          if (v === 'vim') openChallenge();
          else onChange(v);
        }}
        allowDeselect={false}
      />

      {value === 'vim' && (
        <Paper withBorder p="sm" radius="md" mt="sm">
          <Group gap={8} align="center" mb={6}>
            <Text size="xs" fw={700}>Vim bindings</Text>
            <Badge color="red" variant="filled" size="xs" radius="xl">
              Experimental Feature
            </Badge>
          </Group>
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              <Code>Ctrl+H</Code> / <Code>Ctrl+L</Code> — jump to the page tree / back to the editor
            </Text>
            <Text size="xs" c="dimmed">
              Page tree: <Code>j</Code> <Code>k</Code> walk every page (a parent opens as you reach
              it), <Code>{'{'}</Code> <Code>{'}'}</Code> jump between top-level pages,{' '}
              <Code>Enter</Code> opens the page
            </Text>
            <Text size="xs" c="dimmed">
              Motions: <Code>h j k l w W b B e E 0 ^ $ {'{'} {'}'} % gg G</Code>,{' '}
              <Code>f F t T</Code> with <Code>;</Code> <Code>,</Code>, and{' '}
              <Code>Ctrl+D</Code> <Code>Ctrl+U</Code> — all take a count
            </Text>
            <Text size="xs" c="dimmed">
              Operators: <Code>d c y</Code> over any motion or a text object{' '}
              (<Code>diw</Code> <Code>ci(</Code> <Code>ya&quot;</Code>), doubled for the line{' '}
              (<Code>dd cc yy</Code>), plus <Code>D C Y S s x X r ~ J</Code>
            </Text>
            <Text size="xs" c="dimmed">
              Insert with <Code>i a I A o O</Code>, select with <Code>v</Code> <Code>V</Code>{' '}
              (<Code>o</Code> swaps ends), <Code>p P u Ctrl+R</Code>, and{' '}
              <Code>:w</Code> <Code>:q</Code> <Code>:q!</Code> <Code>:wq</Code> <Code>:x</Code>
            </Text>
          </Stack>
        </Paper>
      )}

      <Modal opened={askOpen} onClose={askHandlers.close} title="One question first">
        <Stack>
          <Text size="sm">{VIM_CHALLENGE}</Text>
          <TextInput
            data-autofocus
            placeholder="Type the command"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            error={wrong > 0 ? 'Not quite — that would not get you out.' : null}
          />
          {wrong > 1 && (
            <Alert color="yellow" p="xs">
              Hint: an ex command, starting with a colon. Add the character that means
              “I mean it” if you like — both spellings count.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={askHandlers.close}>Cancel</Button>
            <Button onClick={submit} disabled={!answer.trim()}>Enable vim</Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
