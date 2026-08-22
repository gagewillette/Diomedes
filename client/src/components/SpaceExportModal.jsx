// Share a slice of a space with another workspace.
//
// Two jobs live behind one segmented control: choosing pages and minting a code
// ("New key"), and looking after the codes already minted ("Manage"). They are
// laid out side by side and slid between rather than swapped, so the control
// reads as two positions of one surface instead of two unrelated screens.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal, Stack, Group, Text, Button, TextInput, Select, Checkbox, ActionIcon, Tooltip,
  ScrollArea, Badge, SegmentedControl, Loader, Center, Code, Alert, Divider, Box,
} from '@mantine/core';
import {
  IconChevronDown, IconChevronRight, IconCopy, IconCheck, IconTrash, IconKey,
  IconAlertCircle, IconSitemap, IconFileText,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { buildTree, descendantIds, placeholderIds, selectionSummary } from '../lib/spaceSelection.js';
import Emoji from './Emoji.jsx';

// "last used 3 days ago" is the reading that matters on a key list. Extended
// here rather than relied on from whichever screen happened to load first.
dayjs.extend(relativeTime);

const EXPIRY_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'Never expires' },
];

const STATUS_COLOR = { active: 'green', revoked: 'gray', expired: 'orange' };

/**
 * One row of the selection tree.
 *
 * The checkbox governs this page's *content* only. Ticking a parent therefore
 * does not tick its children — "just the parent page" is a case the feature has
 * to support — so a separate control handles the common bulk case of taking a
 * branch wholesale. Two explicit affordances beat one checkbox with surprising
 * reach.
 */
function TreeRow({ page, childMap, depth, selected, placeholders, expanded, onToggle, onToggleSubtree, onExpand }) {
  const kids = childMap.get(page.id) ?? [];
  const isSelected = selected.has(page.id);
  const isPlaceholder = !isSelected && placeholders.has(page.id);
  const isOpen = expanded.has(page.id);

  return (
    <>
      <Group gap={4} wrap="nowrap" className="gd-export-row" style={{ paddingLeft: depth * 16 }}>
        {kids.length ? (
          <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => onExpand(page.id)}
            aria-label={isOpen ? 'Collapse' : 'Expand'}>
            {isOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </ActionIcon>
        ) : (
          <span style={{ width: 18, flex: '0 0 18px' }} />
        )}

        <Checkbox
          size="xs"
          checked={isSelected}
          // Indeterminate is doing real work here: it is how a parent says "I am
          // coming along, but only to hold your selection together".
          indeterminate={isPlaceholder}
          onChange={() => onToggle(page.id)}
          aria-label={`Include ${page.title || 'Untitled'}`}
        />

        <span className="gd-tree-icon">
          {page.icon ? <Emoji char={page.icon} size={14} /> : <IconFileText size={13} opacity={0.5} />}
        </span>

        <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }} c={isSelected || isPlaceholder ? undefined : 'dimmed'}>
          {page.title || 'Untitled'}
        </Text>

        {isPlaceholder && (
          <Tooltip label="Its title keeps the tree intact on the other side. The page content is not shared." multiline w={240}>
            <Badge size="xs" variant="light" color="gray" style={{ flex: '0 0 auto' }}>structure only</Badge>
          </Tooltip>
        )}

        {kids.length > 0 && (
          <Tooltip label="Select this page and everything under it">
            <ActionIcon
              size="xs" variant="subtle" color="gray" className="gd-export-subtree"
              onClick={() => onToggleSubtree(page.id)} aria-label="Select page and all children"
            >
              <IconSitemap size={13} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {isOpen &&
        kids.map((kid) => (
          <TreeRow
            key={kid.id} page={kid} childMap={childMap} depth={depth + 1}
            selected={selected} placeholders={placeholders} expanded={expanded}
            onToggle={onToggle} onToggleSubtree={onToggleSubtree} onExpand={onExpand}
          />
        ))}
    </>
  );
}

export default function SpaceExportModal({ space, opened, onClose }) {
  const { preferences } = useAuth();
  const [tab, setTab] = useState('create');

  const [pages, setPages] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [minting, setMinting] = useState(false);
  const [code, setCode] = useState(null);
  const [copied, setCopied] = useState(false);

  const [keys, setKeys] = useState(null);

  const { byId, children, roots } = useMemo(() => buildTree(pages ?? []), [pages]);
  const placeholders = useMemo(() => placeholderIds(byId, selected), [byId, selected]);
  const summary = useMemo(() => selectionSummary(byId, selected), [byId, selected]);

  const loadKeys = useCallback(async () => {
    try {
      const d = await api.get(`/api/spaces/${space.id}/export-keys`);
      setKeys(d.keys);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
      setKeys([]);
    }
  }, [space.id]);

  // Reset on every open. A modal that reopens holding the previous session's
  // ticks would invite minting a key over a selection nobody looked at.
  useEffect(() => {
    if (!opened) return;
    setTab('create');
    setSelected(new Set());
    setCode(null);
    setCopied(false);
    setName('');
    setExpiry('30');
    setPages(null);
    setKeys(null);
    api
      .get(`/api/spaces/${space.id}/pages`)
      .then((d) => {
        setPages(d.pages);
        // Open the first level so the tree does not present as a single row.
        setExpanded(new Set(d.pages.filter((p) => !p.parent_id).map((p) => p.id)));
      })
      .catch((err) => {
        notifications.show({ color: 'red', message: err.message });
        setPages([]);
      });
    loadKeys();
  }, [opened, space.id, loadKeys]);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleSubtree = (id) =>
    setSelected((prev) => {
      const branch = [id, ...descendantIds(children, id)];
      const next = new Set(prev);
      // Whole branch already in? Then this is the undo. Otherwise take all of
      // it — a half-selected branch reads as "I meant to take this branch".
      const whole = branch.every((pid) => prev.has(pid));
      for (const pid of branch) (whole ? next.delete(pid) : next.add(pid));
      return next;
    });

  const expand = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectAll = () => setSelected(new Set((pages ?? []).map((p) => p.id)));
  const clearAll = () => setSelected(new Set());

  const mint = async () => {
    setMinting(true);
    try {
      const d = await api.post(`/api/spaces/${space.id}/export-keys`, {
        name: name.trim(),
        pageIds: [...selected],
        expiresInDays: expiry === '' ? null : Number(expiry),
      });
      setCode(d.code);
      setCopied(false);
      loadKeys();
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    } finally {
      setMinting(false);
    }
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => notifications.show({ color: 'red', message: 'Could not copy — select the code and copy it manually' })
    );
  };

  const revoke = async (key) => {
    try {
      await api.del(`/api/spaces/${space.id}/export-keys/${key.id}`);
      notifications.show({ color: 'green', message: `“${key.name}” revoked` });
      loadKeys();
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const startAnother = () => {
    setCode(null);
    setSelected(new Set());
    setName('');
  };

  const animate = preferences.animations;

  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={
      <Group gap={8}>
        <IconKey size={17} />
        <Text fw={600}>Share “{space.name}” with another workspace</Text>
      </Group>
    }>
      <SegmentedControl
        fullWidth size="sm" value={tab} onChange={setTab} mb="md"
        data={[
          { value: 'create', label: 'New key' },
          { value: 'manage', label: `Manage${keys?.length ? ` (${keys.length})` : ''}` },
        ]}
      />

      {/* Both panels stay mounted and the strip slides, so switching back does
          not throw away a half-finished selection. */}
      <div className="gd-slider-viewport">
        <div
          className={`gd-slider-strip ${animate ? '' : 'is-instant'}`}
          style={{ transform: tab === 'create' ? 'translateX(0)' : 'translateX(-50%)' }}
        >
          <div className="gd-slider-panel" aria-hidden={tab !== 'create'} inert={tab !== 'create' ? '' : undefined}>
            {code ? (
              <Stack gap="sm">
                <Alert color="green" icon={<IconCheck size={16} />} title="Import code created">
                  Copy it now — this is the only time it is shown. Paste it into the other
                  workspace under <b>Spaces → + → Import space</b>.
                </Alert>
                <Group gap={6} wrap="nowrap" align="stretch">
                  <Code block style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', fontSize: 12 }}>{code}</Code>
                  <Tooltip label={copied ? 'Copied' : 'Copy code'}>
                    <ActionIcon variant="light" size="lg" onClick={copyCode} aria-label="Copy import code">
                      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <Text size="xs" c="dimmed">
                  Anyone holding this code can read the {summary.withContent} page
                  {summary.withContent === 1 ? '' : 's'} it covers, from any workspace. Revoke it
                  under Manage if it goes somewhere it should not.
                </Text>
                <Group justify="flex-end" gap="xs">
                  <Button variant="default" onClick={startAnother}>Create another</Button>
                  <Button onClick={onClose}>Done</Button>
                </Group>
              </Stack>
            ) : (
              <Stack gap="sm">
                <Group justify="space-between" align="flex-end" gap="sm">
                  <TextInput
                    label="Key name" placeholder="e.g. Design handbook for the Berlin workspace"
                    value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} maxLength={60}
                  />
                  <Select label="Expires" data={EXPIRY_OPTIONS} value={expiry} onChange={(v) => setExpiry(v ?? '')}
                    allowDeselect={false} w={150} />
                </Group>

                <Divider label="Pages to include" labelPosition="left" />

                <Group justify="space-between" gap="xs">
                  <Text size="xs" c="dimmed">
                    Tick a page to share its content. Use <IconSitemap size={11} style={{ verticalAlign: -1 }} /> to
                    take a page and everything under it.
                  </Text>
                  <Group gap={4}>
                    <Button size="compact-xs" variant="subtle" onClick={selectAll}>All</Button>
                    <Button size="compact-xs" variant="subtle" onClick={clearAll}>None</Button>
                  </Group>
                </Group>

                <ScrollArea.Autosize mah={280} type="auto" className="gd-export-tree">
                  {pages === null ? (
                    <Center py="xl"><Loader size="sm" /></Center>
                  ) : roots.length === 0 ? (
                    <Center py="xl"><Text size="sm" c="dimmed">This space has no pages yet.</Text></Center>
                  ) : (
                    roots.map((page) => (
                      <TreeRow
                        key={page.id} page={page} childMap={children} depth={0}
                        selected={selected} placeholders={placeholders} expanded={expanded}
                        onToggle={toggle} onToggleSubtree={toggleSubtree} onExpand={expand}
                      />
                    ))
                  )}
                </ScrollArea.Autosize>

                <Group justify="space-between" wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    {summary.withContent === 0
                      ? 'Nothing selected yet'
                      : `${summary.withContent} page${summary.withContent === 1 ? '' : 's'} with content` +
                        (summary.placeholders
                          ? ` · ${summary.placeholders} kept for structure`
                          : '')}
                  </Text>
                  <Button onClick={mint} loading={minting} disabled={!selected.size || !name.trim()}>
                    Create import code
                  </Button>
                </Group>
              </Stack>
            )}
          </div>

          <div className="gd-slider-panel" aria-hidden={tab !== 'manage'} inert={tab !== 'manage' ? '' : undefined}>
            {keys === null ? (
              <Center py="xl"><Loader size="sm" /></Center>
            ) : keys.length === 0 ? (
              <Center py="xl">
                <Stack gap={4} align="center">
                  <Text size="sm" c="dimmed">No export keys for this space yet.</Text>
                  <Button size="compact-sm" variant="subtle" onClick={() => setTab('create')}>Create one</Button>
                </Stack>
              </Center>
            ) : (
              <ScrollArea.Autosize mah={380} type="auto">
                <Stack gap={6}>
                  {keys.map((key) => (
                    <Group key={key.id} justify="space-between" wrap="nowrap" className="gd-export-key">
                      <Box style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" fw={600} truncate>{key.name}</Text>
                          <Badge size="xs" variant="light" color={STATUS_COLOR[key.status]}>{key.status}</Badge>
                        </Group>
                        <Text size="xs" c="dimmed">
                          {/* The prefix is all that is kept of the secret; it is
                              here so two keys can be told apart, not to be used. */}
                          <Code style={{ fontSize: 11 }}>{key.prefix}…</Code>
                          {' · '}{key.contentCount} page{key.contentCount === 1 ? '' : 's'}
                          {key.pageCount > key.contentCount && ` (+${key.pageCount - key.contentCount} structural)`}
                          {' · created '}{dayjs(key.createdAt).format('D MMM YYYY')}
                          {key.createdByName ? ` by ${key.createdByName}` : ''}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {key.useCount
                            ? `Imported ${key.useCount} time${key.useCount === 1 ? '' : 's'}, last ${dayjs(key.lastUsedAt).fromNow()}`
                            : 'Never used'}
                          {key.revokedAt
                            ? ` · revoked ${dayjs(key.revokedAt).format('D MMM YYYY')}`
                            : key.expiresAt
                              ? ` · ${key.status === 'expired' ? 'expired' : 'expires'} ${dayjs(key.expiresAt).format('D MMM YYYY')}`
                              : ' · no expiry'}
                        </Text>
                      </Box>
                      {key.status === 'active' && (
                        <Tooltip label="Revoke — imports using this code stop working immediately">
                          <ActionIcon variant="subtle" color="red" onClick={() => revoke(key)} aria-label={`Revoke ${key.name}`}>
                            <IconTrash size={15} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Group>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            )}

            {keys?.length > 0 && (
              <Alert mt="sm" color="gray" variant="light" icon={<IconAlertCircle size={15} />}>
                <Text size="xs">
                  Codes cannot be shown again after they are created. If one is lost, revoke it and
                  create a new one.
                </Text>
              </Alert>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
