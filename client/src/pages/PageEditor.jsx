import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Container, Group, Text, ActionIcon, Menu, Tooltip, Breadcrumbs, Anchor, TextInput,
  Popover, Button, Switch, Stack, Loader, Center, CopyButton,
} from '@mantine/core';
import {
  IconStar, IconStarFilled, IconDots, IconHistory, IconMessageCircle, IconShare,
  IconTrash, IconDownload, IconPrinter, IconCheck, IconCopy, IconMoodSmile, IconSitemap,
} from '@tabler/icons-react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import { api, emitPagesChanged, onAppEvent } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { WIDTH_TO_CONTAINER } from '../lib/prefs.js';
import { downloadFile } from '../lib/markdown.js';
import Editor from '../editor/Editor.jsx';
import CommentsPanel from '../components/CommentsPanel.jsx';
import HistoryModal from '../components/HistoryModal.jsx';
import PresenceBar from '../components/PresenceBar.jsx';
import { useCollabSession } from '../editor/collab/session.js';
import { usePeers } from '../editor/collab/presence.js';
import { pickUserColor } from '../lib/userColor.js';
import BacklinksPanel from '../components/BacklinksPanel.jsx';
import PagePicker from '../components/PagePicker.jsx';

export default function PageEditor() {
  const { pageId, slug } = useParams();
  const { preferences, user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState('saved'); // saved | saving | error
  const [shareToken, setShareToken] = useState(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  const titleTimer = useRef(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setData(null);
    try {
      const d = await api.get(`/api/pages/${pageId}`);
      setData(d);
      setTitle(d.page.title);
      setShareToken(d.page.share_token);
      setIsFavorite(d.isFavorite);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
      navigate(`/s/${slug}`);
    }
  }, [pageId, navigate, slug, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // If my own access to this page's space changes, re-fetch so the editor
  // reflects the new role (or bounces me out if it was revoked).
  useEffect(
    () =>
      onAppEvent('space-members-changed', (e) => {
        if (!data) return; // a load is already in flight and will be current
        const d = e.detail || {};
        if (d.userId && d.userId !== user?.id) return;
        if (d.spaceId && d.spaceId !== data.page.space_id) return;
        setReloadKey((k) => k + 1);
      }),
    [data, user?.id]
  );

  const canWrite = data && ['admin', 'writer'].includes(data.myRole);

  // Live collaboration session for this page. Readers join too — presence is
  // useful even when you cannot type, and the server refuses their edits.
  const collab = useCollabSession({ pageId, enabled: Boolean(data), resetKey: reloadKey });
  const peers = usePeers(collab);

  // Memoised: the identity object is part of the editor's extension config, so
  // a fresh object every render would tear the editor down mid-keystroke.
  const me = useMemo(
    () =>
      user
        ? { id: user.id, name: user.name || user.username, color: pickUserColor(user.id) }
        : null,
    [user]
  );

  const saveContent = useCallback(async (editor) => {
    if (!editor) return;
    setSaveState('saving');
    try {
      await api.patch(`/api/pages/${pageId}`, { content: editor.getJSON() });
      setSaveState('saved');
    } catch (err) {
      setSaveState('error');
      notifications.show({ color: 'red', message: `Save failed: ${err.message}` });
    }
  }, [pageId]);

  // Without a collab session (never, for a normal page load — but the component
  // has to survive one render before `data` arrives) fall back to debounced
  // whole-document saves. With one, Editor's snapshot writer owns saving and
  // reports its state back through onSaveState.
  const onEditorUpdate = useCallback((editor) => {
    if (collab) return;
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveContent(editor), 800);
  }, [saveContent, collab]);

  const onTitleChange = (value) => {
    setTitle(value);
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(async () => {
      try {
        await api.patch(`/api/pages/${pageId}`, { title: value });
        emitPagesChanged(data?.page.space_id);
      } catch (err) {
        notifications.show({ color: 'red', message: err.message });
      }
    }, 500);
  };

  // Ctrl+S → immediate save
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        clearTimeout(saveTimer.current);
        saveContent(editorRef.current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveContent]);

  // flush pending save on unmount/page switch
  useEffect(() => () => clearTimeout(saveTimer.current), [pageId]);

  if (!data)
    return <Center h="60vh"><Loader /></Center>;

  const toggleFavorite = async () => {
    if (isFavorite) await api.del(`/api/pages/${pageId}/favorite`);
    else await api.put(`/api/pages/${pageId}/favorite`);
    setIsFavorite(!isFavorite);
  };

  const setIcon = () => {
    const icon = window.prompt('Page icon (emoji, empty to clear)', data.page.icon || '');
    if (icon === null) return;
    api.patch(`/api/pages/${pageId}`, { title, icon }).then(() => {
      setData((d) => ({ ...d, page: { ...d.page, icon } }));
      emitPagesChanged(data.page.space_id);
    });
  };

  const enableShare = async (on) => {
    if (on) {
      const d = await api.post(`/api/pages/${pageId}/share`);
      setShareToken(d.token);
    } else {
      await api.del(`/api/pages/${pageId}/share`);
      setShareToken(null);
    }
  };

  const exportAs = (format) => {
    const editor = editorRef.current;
    if (!editor) return;
    const name = (title || 'untitled').replace(/[^\w\- ]/g, '_');
    if (format === 'md') {
      downloadFile(`${name}.md`, `# ${title}\n\n${editor.storage.markdown.getMarkdown()}`, 'text/markdown');
    } else if (format === 'html') {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${editor.getHTML()}</body></html>`;
      downloadFile(`${name}.html`, html, 'text/html');
    }
  };

  // Naming a parent is an explicit link, not a nudge: pick any page in the
  // space and the sidebar tree reflects the new nesting immediately.
  const setParent = async (parent) => {
    try {
      await api.post(`/api/pages/${pageId}/move`, { parentId: parent?.id ?? null });
      emitPagesChanged(data.page.space_id);
      setReloadKey((k) => k + 1);
      notifications.show({
        message: parent ? `Nested under “${parent.title || 'Untitled'}”` : 'Moved to the top level',
      });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const deletePage = async () => {
    if (!window.confirm(`Move "${title || 'Untitled'}" to trash?`)) return;
    await api.del(`/api/pages/${pageId}`);
    emitPagesChanged(data.page.space_id);
    navigate(`/s/${slug}`);
  };

  const shareUrl = shareToken ? `${location.origin}/share/${shareToken}` : null;

  return (
    <div className="gd-page">
      <Group justify="space-between" py={8} className="gd-page-topbar" wrap="nowrap">
        <Breadcrumbs separator="›" styles={{ separator: { opacity: 0.5 } }}>
          <Anchor component={Link} to={`/s/${slug}`} size="sm" c="dimmed">
            {data.space.icon} {data.space.name}
          </Anchor>
          {data.breadcrumbs.map((b) => (
            <Anchor key={b.id} component={Link} to={`/s/${slug}/p/${b.id}`} size="sm" c="dimmed">
              {b.icon} {b.title || 'Untitled'}
            </Anchor>
          ))}
          <Text size="sm">{title || 'Untitled'}</Text>
        </Breadcrumbs>
        <Group gap={4} wrap="nowrap">
          <PresenceBar peers={peers} status={collab?.status} />
          <Text size="xs" c={saveState === 'error' ? 'red' : 'dimmed'} mr={4} className="gd-savestate">
            {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Saved'}
          </Text>
          <Tooltip label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}>
            <ActionIcon variant="subtle" color={isFavorite ? 'yellow' : 'gray'} onClick={toggleFavorite}>
              {isFavorite ? <IconStarFilled size={17} /> : <IconStar size={17} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Comments">
            <ActionIcon variant="subtle" color="gray" onClick={() => setCommentsOpen(true)}>
              <IconMessageCircle size={17} />
            </ActionIcon>
          </Tooltip>
          {canWrite && (
            <Popover width={340} position="bottom-end" withArrow>
              <Popover.Target>
                <Tooltip label="Share">
                  <ActionIcon variant="subtle" color={shareToken ? 'blue' : 'gray'}>
                    <IconShare size={17} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Switch
                    label="Share to the web"
                    description="Anyone with the link can view this page"
                    checked={Boolean(shareToken)}
                    onChange={(e) => enableShare(e.currentTarget.checked)}
                  />
                  {shareUrl && (
                    <Group gap="xs" wrap="nowrap">
                      <TextInput value={shareUrl} readOnly size="xs" style={{ flex: 1 }} />
                      <CopyButton value={shareUrl}>
                        {({ copied, copy }) => (
                          <Button size="xs" variant="light" onClick={copy}
                            leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}>
                            {copied ? 'Copied' : 'Copy'}
                          </Button>
                        )}
                      </CopyButton>
                    </Group>
                  )}
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
          <Menu withinPortal position="bottom-end" shadow="md">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray"><IconDots size={17} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canWrite && (
                <Menu.Item leftSection={<IconMoodSmile size={14} />} onClick={setIcon}>
                  Change icon
                </Menu.Item>
              )}
              {canWrite && (
                <Menu.Item leftSection={<IconSitemap size={14} />} onClick={() => setParentPickerOpen(true)}>
                  Set parent page
                </Menu.Item>
              )}
              <Menu.Item leftSection={<IconHistory size={14} />} onClick={() => setHistoryOpen(true)}>
                Page history
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => exportAs('md')}>
                Export as Markdown
              </Menu.Item>
              <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => exportAs('html')}>
                Export as HTML
              </Menu.Item>
              <Menu.Item leftSection={<IconPrinter size={14} />} onClick={() => window.print()}>
                Print / PDF
              </Menu.Item>
              {canWrite && (
                <>
                  <Menu.Divider />
                  <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={deletePage}>
                    Move to trash
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      <Container size={WIDTH_TO_CONTAINER[preferences.editorWidth] || 'md'} px="lg" pb={120} className="gd-fade-in">
        <Group gap={8} mt="xl" mb={4} wrap="nowrap" align="flex-start">
          {data.page.icon && (
            <Text style={{ fontSize: 38, lineHeight: 1.2, cursor: canWrite ? 'pointer' : 'default' }}
              onClick={canWrite ? setIcon : undefined}>
              {data.page.icon}
            </Text>
          )}
          <TextInput
            value={title}
            onChange={(e) => canWrite && onTitleChange(e.target.value)}
            placeholder="Untitled"
            variant="unstyled"
            readOnly={!canWrite}
            styles={{ input: { fontSize: 34, fontWeight: 800, height: 'auto', lineHeight: 1.3 } }}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur(); // sync blur so fast typing can't leak into the title
                editorRef.current?.commands.focus('start');
              }
            }}
          />
        </Group>
        <Text size="xs" c="dimmed" mb="md">
          Last updated {dayjs(data.page.updated_at).format('MMM D, YYYY HH:mm')}
        </Text>
        <Editor
          key={`${pageId}-${reloadKey}`}
          content={data.page.content}
          editable={Boolean(canWrite)}
          pageId={pageId}
          collab={collab}
          me={me}
          onSaveState={setSaveState}
          space={data.space}
          onUpdate={onEditorUpdate}
          onReady={(editor) => { editorRef.current = editor; }}
        />
        <BacklinksPanel pageId={pageId} spaceId={data.page.space_id} />
      </Container>

      <PagePicker
        opened={parentPickerOpen}
        onClose={() => setParentPickerOpen(false)}
        onPick={setParent}
        title="Set parent page"
        spaceId={data.page.space_id}
        exclude={pageId}
        rootLabel="No parent (top level)"
        onlySpace
        topLevelOnly
      />
      <CommentsPanel pageId={pageId} opened={commentsOpen} onClose={() => setCommentsOpen(false)} />
      <HistoryModal
        pageId={pageId}
        opened={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}
