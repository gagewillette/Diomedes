import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Title, Text, Group, Button, Stack, UnstyledButton, Modal, Table, Select,
  TextInput, ActionIcon, Tooltip, Menu, Loader, Center, Paper, SimpleGrid, Divider,
  Progress, Badge, Box,
} from '@mantine/core';
import {
  IconPlus, IconTrash, IconUsers, IconSettings, IconFileImport, IconRestore,
  IconFileText, IconDots, IconX, IconInfoCircle, IconPaperclip, IconDatabase,
  IconHistory, IconMessage,
} from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import { api, emitPagesChanged, onAppEvent } from '../lib/api.js';
import { markdownToJSON } from '../lib/markdown.js';
import { useAuth } from '../lib/AuthContext.jsx';

export default function SpaceHome() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { isAdmin, user } = useAuth();
  const [space, setSpace] = useState(null);
  const [pages, setPages] = useState([]);
  const [membersOpen, membersHandlers] = useDisclosure(false);
  const [trashOpen, trashHandlers] = useDisclosure(false);
  const [settingsOpen, settingsHandlers] = useDisclosure(false);
  const [infoOpen, infoHandlers] = useDisclosure(false);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/api/spaces/${slug}`);
      setSpace(d.space);
      const p = await api.get(`/api/spaces/${d.space.id}/pages`);
      setPages(p.pages.filter((x) => !x.parent_id));
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
      navigate('/');
    }
  }, [slug, navigate]);

  useEffect(() => { load(); }, [load]);

  // Live permission changes. A membership event with no spaceId is a broad
  // "something moved" signal (reconnect or a workspace role change); one naming
  // another user only matters to the members list, which reloads on its own.
  useEffect(
    () =>
      onAppEvent('space-members-changed', (e) => {
        const d = e.detail || {};
        const mine = !d.userId || d.userId === user?.id;
        if (mine && (!d.spaceId || !space || d.spaceId === space.id)) load();
      }),
    [load, space, user?.id]
  );
  useEffect(() => onAppEvent('spaces-changed', load), [load]);

  if (!space) return <Center h="60vh"><Loader /></Center>;
  const canWrite = ['admin', 'writer'].includes(space.my_role);
  const isSpaceAdmin = space.my_role === 'admin';

  const newPage = async () => {
    const d = await api.post('/api/pages', { spaceId: space.id });
    emitPagesChanged(space.id);
    navigate(`/s/${slug}/p/${d.page.id}`);
  };

  const importMarkdown = async (files) => {
    let imported = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        const title = file.name.replace(/\.(md|markdown|txt)$/i, '');
        const d = await api.post('/api/pages', { spaceId: space.id, title });
        await api.patch(`/api/pages/${d.page.id}`, { content: markdownToJSON(text), title });
        imported++;
      } catch (err) {
        notifications.show({ color: 'red', message: `${file.name}: ${err.message}` });
      }
    }
    if (imported) {
      notifications.show({ color: 'green', message: `Imported ${imported} page${imported === 1 ? '' : 's'}` });
      emitPagesChanged(space.id);
      load();
    }
  };

  return (
    <Container size="md" py="xl" px="lg" className="gd-fade-in">
      <Group justify="space-between" mb="xs">
        <Group gap={10}>
          <Text style={{ fontSize: 34 }}>{space.icon}</Text>
          <div>
            <Title order={2}>{space.name}</Title>
            {space.description && <Text c="dimmed" size="sm">{space.description}</Text>}
          </div>
        </Group>
        <Group gap={6}>
          {canWrite && (
            <>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={newPage}>New page</Button>
              <Tooltip label="Import documents">
                <ActionIcon variant="default" onClick={() => fileInputRef.current?.click()}>
                  <IconFileImport size={16} />
                </ActionIcon>
              </Tooltip>
              <input
                ref={fileInputRef} type="file" accept=".md,.markdown,.txt" multiple hidden
                onChange={(e) => { importMarkdown(Array.from(e.target.files)); e.target.value = ''; }}
              />
            </>
          )}
          {isSpaceAdmin && (
            <Tooltip label="Members">
              <ActionIcon variant="default" onClick={membersHandlers.open}><IconUsers size={16} /></ActionIcon>
            </Tooltip>
          )}
          <Tooltip label="Space information">
            <ActionIcon variant="default" onClick={infoHandlers.open}><IconInfoCircle size={16} /></ActionIcon>
          </Tooltip>
          {isSpaceAdmin && (
            <Tooltip label="Space settings">
              <ActionIcon variant="default" onClick={settingsHandlers.open}><IconSettings size={16} /></ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>

      <Stack gap={2} mt="lg">
        {pages.map((p) => (
          <UnstyledButton key={p.id} className="gd-page-row" onClick={() => navigate(`/s/${slug}/p/${p.id}`)}>
            <Group gap={8} wrap="nowrap">
              <span style={{ fontSize: 15 }}>{p.icon || <IconFileText size={15} opacity={0.6} />}</span>
              <Text size="sm" fw={500} truncate style={{ flex: 1 }}>{p.title || 'Untitled'}</Text>
              <Text size="xs" c="dimmed">{dayjs(p.updated_at).format('MMM D, YYYY')}</Text>
            </Group>
          </UnstyledButton>
        ))}
        {pages.length === 0 && (
          <Text c="dimmed" size="sm" mt="md">
            No pages yet.{canWrite ? ' Click "New page" to start writing.' : ''}
          </Text>
        )}
      </Stack>

      <MembersModal space={space} opened={membersOpen} onClose={membersHandlers.close} />
      <SpaceInfoModal
        space={space} opened={infoOpen} onClose={infoHandlers.close}
        onOpenTrash={canWrite ? () => { infoHandlers.close(); trashHandlers.open(); } : null}
      />
      <TrashModal space={space} opened={trashOpen} onClose={trashHandlers.close} onChanged={load} />
      <SpaceSettingsModal
        space={space} opened={settingsOpen} onClose={settingsHandlers.close}
        onSaved={load} canDelete={isAdmin}
        onDeleted={() => { window.dispatchEvent(new Event('spaces-changed')); navigate('/'); }}
      />
    </Container>
  );
}

// Renders bytes with the largest unit that keeps the number readable.
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function StatTile({ icon, label, value, hint }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Group gap={6} mb={4}>
        {icon}
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: 0.4 }}>{label}</Text>
      </Group>
      <Text fw={700} style={{ fontSize: 22, lineHeight: 1.2 }}>{value}</Text>
      {hint && <Text size="xs" c="dimmed">{hint}</Text>}
    </Paper>
  );
}

function InfoRow({ label, value }) {
  return (
    <Group justify="space-between" gap="lg" wrap="nowrap">
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="sm" ta="right">{value}</Text>
    </Group>
  );
}

function SpaceInfoModal({ space, opened, onClose, onOpenTrash }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setStats(null);
    setError(null);
    api.get(`/api/spaces/${space.id}/stats`)
      .then((d) => { if (!cancelled) setStats(d.stats); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [opened, space.id]);

  const roleLabel = { admin: 'Full access', writer: 'Can edit', reader: 'Can view' }[space.my_role] || space.my_role;

  return (
    <Modal opened={opened} onClose={onClose} title="Space information" size="lg">
      {error && <Text c="red" size="sm">{error}</Text>}
      {!stats && !error && <Center py="xl"><Loader size="sm" /></Center>}
      {stats && (
        <Stack gap="md">
          <Group gap={12} wrap="nowrap" align="flex-start">
            <Text style={{ fontSize: 34, lineHeight: 1 }}>{stats.space.icon}</Text>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text fw={600}>{stats.space.name}</Text>
              <Text size="sm" c="dimmed">
                {stats.space.description || 'No description'}
              </Text>
              <Group gap={6} mt={6}>
                <Badge size="sm" variant="light">/{stats.space.slug}</Badge>
                <Badge size="sm" variant="light" color="gray">Your role: {roleLabel}</Badge>
              </Group>
            </div>
          </Group>

          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
            <StatTile
              icon={<IconUsers size={14} />} label="Members" value={stats.members.total}
              hint={`${stats.members.admins} admin${stats.members.admins === 1 ? '' : 's'}`}
            />
            <StatTile
              icon={<IconFileText size={14} />} label="Documents" value={stats.pages.active}
              hint={formatBytes(stats.pages.bytes)}
            />
            <StatTile
              icon={<IconPaperclip size={14} />} label="Files" value={stats.files.count}
              hint={formatBytes(stats.files.bytes)}
            />
            <StatTile
              icon={<IconDatabase size={14} />} label="Total size" value={formatBytes(stats.totalBytes)}
              hint="docs + files + history"
            />
          </SimpleGrid>

          <div>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={6} style={{ letterSpacing: 0.4 }}>
              Storage breakdown
            </Text>
            <Progress.Root size="lg" radius="sm">
              <Progress.Section
                value={pct(stats.pages.bytes, stats.totalBytes)} color="blue"
                tooltip={`Documents — ${formatBytes(stats.pages.bytes)}`}
              />
              <Progress.Section
                value={pct(stats.files.bytes, stats.totalBytes)} color="grape"
                tooltip={`Files — ${formatBytes(stats.files.bytes)}`}
              />
              <Progress.Section
                value={pct(stats.versions.bytes, stats.totalBytes)} color="gray"
                tooltip={`Version history — ${formatBytes(stats.versions.bytes)}`}
              />
            </Progress.Root>
            <Group gap="md" mt={6}>
              <LegendDot color="blue" label={`Documents ${formatBytes(stats.pages.bytes)}`} />
              <LegendDot color="grape" label={`Files ${formatBytes(stats.files.bytes)}`} />
              <LegendDot color="gray" label={`History ${formatBytes(stats.versions.bytes)}`} />
            </Group>
          </div>

          <Divider />

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" verticalSpacing={6}>
            <InfoRow label="Top-level documents" value={stats.pages.topLevel} />
            <InfoRow label="Characters written" value={stats.pages.characters.toLocaleString()} />
            <InfoRow label="Publicly shared pages" value={stats.pages.shared} />
            <InfoRow label="File types" value={stats.files.mimeTypes} />
            <InfoRow
              label="Version snapshots"
              value={<><IconHistory size={12} style={{ verticalAlign: -1 }} /> {stats.versions.count}</>}
            />
            <InfoRow
              label="Comments"
              value={
                <><IconMessage size={12} style={{ verticalAlign: -1 }} /> {stats.comments.total}
                  {stats.comments.open > 0 && <Text span c="dimmed"> ({stats.comments.open} open)</Text>}
                </>
              }
            />
            <InfoRow
              label="Last edited"
              value={stats.pages.lastUpdatedAt ? dayjs(stats.pages.lastUpdatedAt).format('MMM D, YYYY h:mm A') : '—'}
            />
            <InfoRow
              label="Last file upload"
              value={stats.files.lastUploadedAt ? dayjs(stats.files.lastUploadedAt).format('MMM D, YYYY') : '—'}
            />
            <InfoRow label="Created" value={dayjs(stats.space.created_at).format('MMM D, YYYY')} />
            <InfoRow label="Created by" value={stats.space.created_by_name || 'Unknown'} />
          </SimpleGrid>

          {stats.topContributors.length > 0 && (
            <>
              <Divider />
              <div>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={6} style={{ letterSpacing: 0.4 }}>
                  Top contributors
                </Text>
                <Stack gap={4}>
                  {stats.topContributors.map((c) => (
                    <Group key={c.username} justify="space-between" gap="lg" wrap="nowrap">
                      <Text size="sm" truncate>
                        {c.name} <Text span c="dimmed" size="xs">@{c.username}</Text>
                      </Text>
                      <Text size="sm" c="dimmed">
                        {c.pages} doc{c.pages === 1 ? '' : 's'}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </div>
            </>
          )}

          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {stats.pages.trashed} document{stats.pages.trashed === 1 ? '' : 's'} in trash
            </Text>
            {onOpenTrash && (
              <Button
                size="xs" variant="default" leftSection={<IconTrash size={14} />}
                onClick={onOpenTrash}
              >
                View trash
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function pct(part, total) {
  const t = Number(total) || 0;
  if (!t) return 0;
  return (Number(part) / t) * 100;
}

function LegendDot({ color, label }) {
  return (
    <Group gap={5} wrap="nowrap">
      <Box w={8} h={8} style={{ borderRadius: 2, background: `var(--mantine-color-${color}-6)` }} />
      <Text size="xs" c="dimmed">{label}</Text>
    </Group>
  );
}

function MembersModal({ space, opened, onClose }) {
  const [members, setMembers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [addUser, setAddUser] = useState(null);
  const [addRole, setAddRole] = useState('reader');

  const load = useCallback(async () => {
    const d = await api.get(`/api/spaces/${space.id}/members`);
    setMembers(d.members);
    const u = await api.get('/api/users');
    setAllUsers(u.users);
  }, [space.id]);

  useEffect(() => { if (opened) load(); }, [opened, load]);
  useEffect(() => {
    if (!opened) return undefined;
    const reload = (e) => {
      const spaceId = e.detail?.spaceId;
      if (!spaceId || spaceId === space.id) load();
    };
    const offMembers = onAppEvent('space-members-changed', reload);
    const offUsers = onAppEvent('users-changed', reload);
    return () => { offMembers(); offUsers(); };
  }, [opened, load, space.id]);

  const nonMembers = allUsers.filter((u) => !members.some((m) => m.user_id === u.id));

  return (
    <Modal opened={opened} onClose={onClose} title={`Members of ${space.name}`} size="lg">
      <Group mb="md" align="flex-end">
        <Select
          label="Add user" placeholder="Pick a user" searchable style={{ flex: 1 }}
          data={nonMembers.map((u) => ({ value: u.id, label: `${u.name} (@${u.username})` }))}
          value={addUser} onChange={setAddUser}
        />
        <Select
          label="Role" w={130}
          data={[
            { value: 'reader', label: 'Can view' },
            { value: 'writer', label: 'Can edit' },
            { value: 'admin', label: 'Full access' },
          ]}
          value={addRole} onChange={setAddRole}
        />
        <Button
          disabled={!addUser}
          onClick={async () => {
            await api.post(`/api/spaces/${space.id}/members`, { userId: addUser, role: addRole });
            setAddUser(null);
            load();
          }}
        >
          Add
        </Button>
      </Group>
      <Table>
        <Table.Thead>
          <Table.Tr><Table.Th>User</Table.Th><Table.Th>Role</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {members.map((m) => (
            <Table.Tr key={m.user_id}>
              <Table.Td>{m.name} <Text span c="dimmed" size="xs">@{m.username}</Text></Table.Td>
              <Table.Td>
                <Select
                  size="xs" w={130}
                  data={[
                    { value: 'reader', label: 'Can view' },
                    { value: 'writer', label: 'Can edit' },
                    { value: 'admin', label: 'Full access' },
                  ]}
                  value={m.role}
                  onChange={async (role) => {
                    await api.patch(`/api/spaces/${space.id}/members/${m.user_id}`, { role });
                    load();
                  }}
                />
              </Table.Td>
              <Table.Td>
                <ActionIcon variant="subtle" color="red" size="sm"
                  onClick={async () => {
                    await api.del(`/api/spaces/${space.id}/members/${m.user_id}`);
                    load();
                  }}>
                  <IconX size={14} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" mt="sm">
        Workspace owners and admins always have full access to every space.
      </Text>
    </Modal>
  );
}

function TrashModal({ space, opened, onClose, onChanged }) {
  const [items, setItems] = useState([]);
  const load = useCallback(async () => {
    const d = await api.get(`/api/spaces/${space.id}/trash`);
    setItems(d.pages);
  }, [space.id]);
  useEffect(() => { if (opened) load(); }, [opened, load]);

  const act = async (fn) => { await fn(); load(); onChanged(); emitPagesChanged(space.id); };

  return (
    <Modal opened={opened} onClose={onClose} title="Trash" size="md">
      <Stack gap={4}>
        {items.length === 0 && <Text c="dimmed" size="sm">Trash is empty.</Text>}
        {items.map((p) => (
          <Group key={p.id} justify="space-between" wrap="nowrap" className="gd-page-row">
            <Text size="sm" truncate>{p.icon} {p.title || 'Untitled'}</Text>
            <Group gap={4} wrap="nowrap">
              <Text size="xs" c="dimmed">{dayjs(p.deleted_at).fromNow?.() || ''}</Text>
              <Tooltip label="Restore">
                <ActionIcon size="sm" variant="subtle" onClick={() => act(() => api.post(`/api/pages/${p.id}/restore`))}>
                  <IconRestore size={14} />
                </ActionIcon>
              </Tooltip>
              {space.my_role === 'admin' && (
                <Tooltip label="Delete forever">
                  <ActionIcon size="sm" variant="subtle" color="red"
                    onClick={() => window.confirm('Delete forever? This cannot be undone.') &&
                      act(() => api.del(`/api/pages/${p.id}/permanent`))}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Group>
        ))}
      </Stack>
    </Modal>
  );
}

function SpaceSettingsModal({ space, opened, onClose, onSaved, canDelete, onDeleted }) {
  const [form, setForm] = useState({ name: space.name, icon: space.icon, description: space.description });
  useEffect(() => {
    setForm({ name: space.name, icon: space.icon, description: space.description });
  }, [space, opened]);

  return (
    <Modal opened={opened} onClose={onClose} title="Space settings">
      <Stack>
        <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextInput label="Icon (emoji)" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} />
        <TextInput label="Description" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Button
          onClick={async () => {
            await api.patch(`/api/spaces/${space.id}`, form);
            window.dispatchEvent(new Event('spaces-changed'));
            onSaved();
            onClose();
          }}
        >
          Save
        </Button>
        {canDelete && (
          <Button
            color="red" variant="light"
            onClick={async () => {
              if (!window.confirm(`Delete space "${space.name}" and ALL its pages? This cannot be undone.`)) return;
              await api.del(`/api/spaces/${space.id}`);
              onDeleted();
            }}
          >
            Delete this space
          </Button>
        )}
      </Stack>
    </Modal>
  );
}
