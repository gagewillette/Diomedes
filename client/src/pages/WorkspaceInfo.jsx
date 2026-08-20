import { useCallback, useEffect, useState } from 'react';
import {
  Container, Title, Text, Paper, Group, Stack, Badge, Table, Tabs, SegmentedControl,
  SimpleGrid, Alert, Loader, Center, Button, Tooltip, Progress, Anchor, Divider,
} from '@mantine/core';
import {
  IconGauge, IconDatabase, IconStack2, IconServer, IconInfoCircle, IconRefresh,
  IconTrash, IconAlertTriangle,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { modals } from '@mantine/modals';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { markPageReady } from '../lib/perf.js';
import { useDocumentIdentity } from '../lib/documentTitle.js';
import { formatBytes, formatMs, formatCount, formatDuration, formatDate } from '../lib/format.js';
import Sparkline from '../components/Sparkline.jsx';

const WINDOW_LABELS = { '1h': 'Last hour', '24h': 'Last 24h', '7d': 'Last 7 days', '30d': 'Last 30 days' };

/** One headline number with an optional caption. */
function Stat({ label, value, hint, color }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
      <Text size="xl" fw={700} c={color} lh={1.3}>{value}</Text>
      {hint && <Text size="xs" c="dimmed">{hint}</Text>}
    </Paper>
  );
}

/**
 * A metric row. The budget verdict is the point of the whole panel: a number on
 * its own does not tell you whether it regressed, a number against a stated
 * ceiling does.
 */
function budgetBadge(budget, unit) {
  if (!budget) return <Badge size="xs" variant="light" color="gray">No samples</Badge>;
  return (
    <Tooltip label={`Budget: p95 ≤ ${formatMs(budget.budget, { unit })}`} withArrow>
      <Badge size="xs" variant="light" color={budget.ok ? 'teal' : 'red'}>
        {budget.ok ? 'Within budget' : 'Over budget'}
      </Badge>
    </Tooltip>
  );
}

function MetricsTable({ metrics }) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Metric</Table.Th>
            <Table.Th ta="right">Samples</Table.Th>
            <Table.Th ta="right">p50</Table.Th>
            <Table.Th ta="right">p75</Table.Th>
            <Table.Th ta="right">p95</Table.Th>
            <Table.Th ta="right">p99</Table.Th>
            <Table.Th ta="right">Max</Table.Th>
            <Table.Th>Budget</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {metrics.map((m) => (
            <Table.Tr key={m.metric}>
              <Table.Td><Text size="sm" fw={600}>{m.label}</Text></Table.Td>
              <Table.Td ta="right">{formatCount(m.count)}</Table.Td>
              <Table.Td ta="right">{formatMs(m.p50, { unit: m.unit })}</Table.Td>
              <Table.Td ta="right">{formatMs(m.p75, { unit: m.unit })}</Table.Td>
              <Table.Td ta="right" fw={700} c={m.budget && !m.budget.ok ? 'red' : undefined}>
                {formatMs(m.p95, { unit: m.unit })}
              </Table.Td>
              <Table.Td ta="right">{formatMs(m.p99, { unit: m.unit })}</Table.Td>
              <Table.Td ta="right">{formatMs(m.max, { unit: m.unit })}</Table.Td>
              <Table.Td>{budgetBadge(m.budget, m.unit)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** A ranked list of names with a bar showing each one's share of the total. */
function ShareTable({ rows, columns, valueKey }) {
  const total = rows.reduce((sum, r) => sum + (Number(r[valueKey]) || 0), 0) || 1;
  return (
    <Table.ScrollContainer minWidth={520}>
      <Table verticalSpacing="xs" fz="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th key={c.key} ta={c.align || 'left'}>{c.label}</Table.Th>
            ))}
            <Table.Th w={90}>Share</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={r.name || i}>
              {columns.map((c) => (
                <Table.Td key={c.key} ta={c.align || 'left'}>
                  {c.render ? c.render(r) : r[c.key]}
                </Table.Td>
              ))}
              <Table.Td>
                <Progress value={((Number(r[valueKey]) || 0) / total) * 100} size="sm" radius="xl" />
              </Table.Td>
            </Table.Tr>
          ))}
          {!rows.length && (
            <Table.Tr>
              <Table.Td colSpan={columns.length + 1}>
                <Text size="sm" c="dimmed">Nothing recorded in this window.</Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/**
 * Everything an owner or admin can know about this workspace: what is in it,
 * how much room it takes, and how fast it is for the people using it.
 */
export default function WorkspaceInfo() {
  const { isAdmin, workspaceName, performanceSettings } = useAuth();
  useDocumentIdentity(`${workspaceName} info`, '📊');
  const [info, setInfo] = useState(null);
  const [perf, setPerf] = useState(null);
  const [range, setRange] = useState('24h');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [i, p] = await Promise.all([
        api.get('/api/workspace/info'),
        api.get(`/api/perf/overview?window=${range}`),
      ]);
      setInfo(i);
      setPerf(p);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      // This screen's own open time is worth measuring like any other.
      markPageReady();
    }
  }, [range]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const clearLogs = () =>
    modals.openConfirmModal({
      title: 'Delete all performance logs',
      children: (
        <Text size="sm">
          Every recorded sample is removed and the metrics below reset to empty.
          Collection carries on unless you also turn logging off in workspace settings.
        </Text>
      ),
      labels: { confirm: 'Delete logs', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await api.del('/api/perf/samples?mode=all');
          notifications.show({ color: 'green', message: 'Performance logs cleared' });
          load();
        } catch (err) {
          notifications.show({ color: 'red', message: err.message });
        }
      },
    });

  if (!isAdmin) {
    return (
      <Container size="sm" py="xl">
        <Alert icon={<IconInfoCircle size={16} />} color="gray">
          Only workspace owners and admins can see workspace info.
        </Alert>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="md" py="xl">
        <Alert icon={<IconAlertTriangle size={16} />} color="red" title="Could not load workspace info">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!info || !perf) {
    return (
      <Center h={300}>
        <Loader />
      </Center>
    );
  }

  const { totals, storage, activity, spaces, runtime } = info;
  const overBudget = perf.metrics.filter((m) => m.budget && !m.budget.ok);
  // A gap between what attachment rows claim and what is on the volume means
  // orphaned files — worth surfacing, since nothing else would ever report it.
  const orphanBytes = storage.diskBytes - storage.attachmentBytes;

  return (
    <Container size="lg" py="xl" className="gd-fade-in">
      <Group justify="space-between" align="flex-start" mb="xs">
        <div>
          <Title order={2}>Workspace info</Title>
          <Text c="dimmed" size="sm">
            Everything in {workspaceName}, and how fast it is for the people using it.
          </Text>
        </div>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={range}
            onChange={setRange}
            data={perf.windows.map((w) => ({ value: w, label: WINDOW_LABELS[w] || w }))}
          />
          <Tooltip label="Reload">
            <Button size="xs" variant="default" loading={busy} onClick={load} leftSection={<IconRefresh size={14} />}>
              Refresh
            </Button>
          </Tooltip>
        </Group>
      </Group>

      {!performanceSettings.logging && (
        <Alert icon={<IconInfoCircle size={16} />} color="yellow" mb="md">
          Performance logging is off, so nothing new is being recorded. Anything below is
          historical. Turn it back on in{' '}
          <Anchor component={Link} to="/settings/workspace">workspace settings</Anchor>.
        </Alert>
      )}

      {performanceSettings.logging && performanceSettings.sampleRate < 1 && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" mb="md">
          Sampling at {Math.round(performanceSettings.sampleRate * 100)}% — counts below are a
          fraction of real traffic, but the percentiles still hold.
        </Alert>
      )}

      <Tabs defaultValue="performance" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="performance" leftSection={<IconGauge size={14} />}>Performance</Tabs.Tab>
          <Tabs.Tab value="transfer" leftSection={<IconServer size={14} />}>Data transfer</Tabs.Tab>
          <Tabs.Tab value="content" leftSection={<IconStack2 size={14} />}>Content</Tabs.Tab>
          <Tabs.Tab value="storage" leftSection={<IconDatabase size={14} />}>Storage &amp; runtime</Tabs.Tab>
        </Tabs.List>

        {/* ------------------------------------------------------------ */}
        <Tabs.Panel value="performance">
          <Stack>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Stat
                label="Budgets met"
                value={`${perf.metrics.filter((m) => m.budget?.ok).length}/${perf.metrics.filter((m) => m.budget).length}`}
                hint={overBudget.length ? `${overBudget.length} over` : 'all within budget'}
                color={overBudget.length ? 'red' : 'teal'}
              />
              <Stat label="Requests" value={formatCount(perf.reliability.requests)} hint={WINDOW_LABELS[range]} />
              <Stat
                label="Error rate"
                value={`${perf.reliability.errorRate}%`}
                hint={`${formatCount(perf.reliability.serverErrors)} server, ${formatCount(perf.reliability.clientErrors)} client`}
                color={perf.reliability.errorRate > 1 ? 'red' : undefined}
              />
              <Stat label="Active users" value={formatCount(perf.reliability.activeUsers)} hint="seen in this window" />
            </SimpleGrid>

            <Paper withBorder p="md" radius="md">
              <Group justify="space-between" mb={4}>
                <Text fw={700} size="sm">p95 latency over time</Text>
                <Group gap="lg">
                  <Text size="xs" c="blue.5">Server handler</Text>
                  <Text size="xs" c="grape.5">Page open (browser)</Text>
                </Group>
              </Group>
              <Sparkline points={perf.timeline.map((t) => t.serverP95)} label="Server p95 over time" />
              <Sparkline
                points={perf.timeline.map((t) => t.clientP95)}
                color="var(--mantine-color-grape-5)"
                label="Client page-open p95 over time"
              />
            </Paper>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb={2}>Metrics against budget</Text>
              <Text size="xs" c="dimmed" mb="sm">
                Budgets are the explicit ceilings this app is held to. p95 is the number that
                matters — it is the experience of the slowest one interaction in twenty, not the
                average that hides it.
              </Text>
              <MetricsTable metrics={perf.metrics} />
            </Paper>

            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Paper withBorder p="md" radius="md">
                <Text fw={700} size="sm" mb="sm">Slowest API routes (server time)</Text>
                <ShareTable
                  rows={perf.slowestRoutes}
                  valueKey="p95"
                  columns={[
                    { key: 'name', label: 'Route', render: (r) => <Text size="xs" ff="monospace">{r.name}</Text> },
                    { key: 'count', label: 'Calls', align: 'right', render: (r) => formatCount(r.count) },
                    { key: 'p95', label: 'p95', align: 'right', render: (r) => formatMs(r.p95) },
                    { key: 'errors', label: 'Errors', align: 'right', render: (r) => (r.errors ? <Text size="xs" c="red">{r.errors}</Text> : '—') },
                  ]}
                />
              </Paper>

              <Paper withBorder p="md" radius="md">
                <Text fw={700} size="sm" mb="sm">Slowest screens (browser)</Text>
                <ShareTable
                  rows={perf.slowestScreens}
                  valueKey="p95"
                  columns={[
                    { key: 'name', label: 'Screen', render: (r) => <Text size="xs" ff="monospace">{r.name}</Text> },
                    { key: 'count', label: 'Opens', align: 'right', render: (r) => formatCount(r.count) },
                    { key: 'p50', label: 'p50', align: 'right', render: (r) => formatMs(r.p50) },
                    { key: 'p95', label: 'p95', align: 'right', render: (r) => formatMs(r.p95) },
                  ]}
                />
              </Paper>
            </SimpleGrid>

            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {formatCount(perf.storedSamples)} samples stored, kept for {perf.retentionDays} days
                {perf.oldestSample ? ` · oldest ${formatDate(perf.oldestSample)}` : ''}
              </Text>
              <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={clearLogs}>
                Clear logs
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------------------------------------ */}
        <Tabs.Panel value="transfer">
          <Stack>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Stat
                label="Sent by server"
                value={formatBytes(perf.transfer.server.bytes)}
                hint={`${formatCount(perf.transfer.server.requests)} responses`}
              />
              <Stat
                label="Received by browsers"
                value={formatBytes(perf.transfer.client.bytes)}
                hint="over the wire, cache included"
              />
              <Stat
                label="After decompression"
                value={formatBytes(perf.transfer.client.decodedBytes)}
                hint="what the browser actually parsed"
              />
              <Stat
                label="Avg response"
                value={formatBytes(
                  perf.transfer.server.requests
                    ? perf.transfer.server.bytes / perf.transfer.server.requests
                    : 0
                )}
                hint="server-side mean"
              />
            </SimpleGrid>

            <Alert icon={<IconInfoCircle size={16} />} color="gray" variant="light">
              The server figure counts bytes actually written to a socket. The browser figure
              includes everything fetched from any origin and is reported by the browser itself,
              so the two never match exactly — a big gap usually means caching is working.
            </Alert>

            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Paper withBorder p="md" radius="md">
                <Text fw={700} size="sm" mb="sm">Heaviest routes (server)</Text>
                <ShareTable
                  rows={perf.transfer.heaviestRoutes}
                  valueKey="bytes"
                  columns={[
                    { key: 'name', label: 'Route', render: (r) => <Text size="xs" ff="monospace">{r.name}</Text> },
                    { key: 'requests', label: 'Reqs', align: 'right', render: (r) => formatCount(r.requests) },
                    { key: 'bytes', label: 'Bytes', align: 'right', render: (r) => formatBytes(r.bytes) },
                  ]}
                />
              </Paper>

              <Paper withBorder p="md" radius="md">
                <Text fw={700} size="sm" mb="sm">By resource type (browser)</Text>
                <ShareTable
                  rows={perf.transfer.byInitiator}
                  valueKey="bytes"
                  columns={[
                    { key: 'name', label: 'Type' },
                    { key: 'requests', label: 'Reqs', align: 'right', render: (r) => formatCount(r.requests) },
                    { key: 'bytes', label: 'Wire', align: 'right', render: (r) => formatBytes(r.bytes) },
                    { key: 'decodedBytes', label: 'Decoded', align: 'right', render: (r) => formatBytes(r.decodedBytes) },
                  ]}
                />
              </Paper>
            </SimpleGrid>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb={4}>Bytes served over time</Text>
              <Sparkline
                points={perf.timeline.map((t) => t.bytes)}
                color="var(--mantine-color-teal-5)"
                label="Bytes served over time"
              />
              <Text size="xs" c="dimmed" mt={4}>
                Peak {formatBytes(Math.max(0, ...perf.timeline.map((t) => t.bytes)))} in one bucket.
              </Text>
            </Paper>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb="sm">API vs static assets</Text>
              <ShareTable
                rows={perf.transfer.byKind}
                valueKey="bytes"
                columns={[
                  { key: 'name', label: 'Kind' },
                  { key: 'requests', label: 'Requests', align: 'right', render: (r) => formatCount(r.requests) },
                  { key: 'bytes', label: 'Bytes', align: 'right', render: (r) => formatBytes(r.bytes) },
                ]}
              />
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------------------------------------ */}
        <Tabs.Panel value="content">
          <Stack>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Stat label="Pages" value={formatCount(totals.pages)} hint={`${formatCount(totals.trashedPages)} in trash`} />
              <Stat label="Spaces" value={formatCount(totals.spaces)} />
              <Stat label="Users" value={formatCount(totals.activeUsers)} hint={`${formatCount(totals.admins)} admins`} />
              <Stat label="Comments" value={formatCount(totals.comments)} hint={`${formatCount(totals.openComments)} unresolved`} />
              <Stat label="Versions" value={formatCount(totals.versions)} hint="page history entries" />
              <Stat label="Attachments" value={formatCount(totals.attachments)} hint={formatBytes(storage.attachmentBytes)} />
              <Stat label="Shared pages" value={formatCount(totals.sharedPages)} hint="public share links" />
              <Stat label="Page links" value={formatCount(totals.pageLinks)} hint={`${formatCount(totals.contentChars)} chars of text`} />
            </SimpleGrid>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb="sm">Last 7 days</Text>
              <SimpleGrid cols={{ base: 2, sm: 5 }}>
                <Stat label="New pages" value={formatCount(activity.pages7d)} />
                <Stat label="Pages edited" value={formatCount(activity.edits7d)} />
                <Stat label="Comments" value={formatCount(activity.comments7d)} />
                <Stat label="Uploads" value={formatCount(activity.uploads7d)} />
                <Stat label="Versions saved" value={formatCount(activity.versions7d)} />
              </SimpleGrid>
              <Divider my="sm" />
              <Group gap="xl">
                <Text size="xs" c="dimmed">Last edit: {formatDate(activity.lastEdit)}</Text>
                <Text size="xs" c="dimmed">Workspace created: {formatDate(activity.createdAt)}</Text>
              </Group>
            </Paper>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb="sm">Spaces</Text>
              <ShareTable
                rows={spaces}
                valueKey="pages"
                columns={[
                  { key: 'name', label: 'Space', render: (s) => <Text size="sm">{s.icon} {s.name}</Text> },
                  { key: 'pages', label: 'Pages', align: 'right', render: (s) => formatCount(s.pages) },
                  { key: 'members', label: 'Members', align: 'right', render: (s) => formatCount(s.members) },
                  { key: 'bytes', label: 'Files', align: 'right', render: (s) => formatBytes(s.bytes) },
                  { key: 'last_edit', label: 'Last edit', render: (s) => <Text size="xs" c="dimmed">{formatDate(s.last_edit)}</Text> },
                ]}
              />
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------------------------------------ */}
        <Tabs.Panel value="storage">
          <Stack>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Stat label="Database" value={formatBytes(storage.databaseBytes)} hint="postgres, this database" />
              <Stat label="File storage" value={formatBytes(storage.diskBytes)} hint="on the storage volume" />
              <Stat label="Tracked files" value={formatBytes(storage.attachmentBytes)} hint={`${formatCount(totals.attachments)} attachments`} />
              <Stat
                label="Untracked on disk"
                value={formatBytes(Math.max(0, orphanBytes))}
                hint={orphanBytes > 1e7 ? 'files with no attachment row' : 'converted PDFs and temp files'}
                color={orphanBytes > 1e8 ? 'orange' : undefined}
              />
            </SimpleGrid>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb="sm">Largest tables</Text>
              <ShareTable
                rows={storage.tables}
                valueKey="bytes"
                columns={[
                  { key: 'name', label: 'Table', render: (t) => <Text size="xs" ff="monospace">{t.name}</Text> },
                  { key: 'bytes', label: 'Size', align: 'right', render: (t) => formatBytes(t.bytes) },
                ]}
              />
            </Paper>

            <Paper withBorder p="md" radius="md">
              <Text fw={700} size="sm" mb={2}>Runtime</Text>
              <Text size="xs" c="dimmed" mb="sm">
                Reported by whichever app instance answered this request.
              </Text>
              <SimpleGrid cols={{ base: 2, sm: 4 }}>
                <Stat label="Uptime" value={formatDuration(runtime.uptimeSeconds)} />
                <Stat label="Node" value={runtime.nodeVersion} hint={runtime.platform} />
                <Stat label="Heap used" value={formatBytes(runtime.memory.heapUsed)} hint={`RSS ${formatBytes(runtime.memory.rss)}`} />
                <Stat
                  label="DB pool"
                  value={`${runtime.pool.total - runtime.pool.idle}/${runtime.pool.total}`}
                  hint={runtime.pool.waiting ? `${runtime.pool.waiting} waiting` : 'none waiting'}
                  color={runtime.pool.waiting ? 'orange' : undefined}
                />
              </SimpleGrid>
              <Divider my="sm" />
              <Group gap="xs">
                <Badge size="sm" variant="light" color={runtime.vectorAvailable ? 'teal' : 'gray'}>
                  pgvector {runtime.vectorAvailable ? 'available' : 'unavailable'}
                </Badge>
                {runtime.search && (
                  <Badge size="sm" variant="light" color={runtime.search.mode === 'hybrid' ? 'teal' : 'gray'}>
                    Search: {runtime.search.mode === 'hybrid' ? 'hybrid (full-text + semantic)' : 'full-text only'}
                  </Badge>
                )}
              </Group>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}
