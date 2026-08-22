import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Container, Group, Text, ActionIcon, Menu, Tooltip, Breadcrumbs, Anchor, TextInput,
  Popover, Button, Switch, Stack, Loader, Center, CopyButton, UnstyledButton,
} from '@mantine/core';
import {
  IconStar, IconStarFilled, IconDots, IconHistory, IconMessageCircle, IconShare,
  IconTrash, IconDownload, IconPrinter, IconCheck, IconCopy, IconMoodSmile, IconSitemap,
  IconFileZip,
} from '@tabler/icons-react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import { api, emitPagesChanged, onAppEvent } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { WIDTH_TO_CONTAINER } from '../lib/prefs.js';
import { downloadFile } from '../lib/markdown.js';
import { exportPageZip } from '../lib/exportZip.js';
import Editor from '../editor/Editor.jsx';
import CommentsPanel from '../components/CommentsPanel.jsx';
import { scrollToComment, setActiveComment } from '../editor/CommentHighlight.js';
import HistoryModal from '../components/HistoryModal.jsx';
import FindBar from '../components/FindBar.jsx';
import PresenceBar from '../components/PresenceBar.jsx';
import { useCollabSession } from '../editor/collab/session.js';
import { usePeers } from '../editor/collab/presence.js';
import { pickUserColor } from '../lib/userColor.js';
import BacklinksPanel from '../components/BacklinksPanel.jsx';
import PagePicker from '../components/PagePicker.jsx';
import { elideCrumbs } from '../components/pageDepth.js';
import Emoji from '../components/Emoji.jsx';
import IconPickerModal from '../components/IconPickerModal.jsx';
import { onFocusEditor, onRequestSave } from '../lib/vimFocus.js';
import { useDocumentIdentity } from '../lib/documentTitle.js';

export default function PageEditor() {
  const { pageId, slug } = useParams();
  const { preferences, user } = useAuth();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(null);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState('saved'); // saved | saving | error
  const [shareToken, setShareToken] = useState(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // The comment list lives here rather than in the panel, because the editor
  // needs it too: the highlights in the document are drawn from the same list,
  // and they have to be there whether the panel is open or not.
  const [comments, setComments] = useState([]);
  // The text a "Comment on this" click selected, waiting for someone to type
  // the comment itself.
  const [pendingAnchor, setPendingAnchor] = useState(null);
  // Which comments the editor could actually find in the document. Reported by
  // the highlight plugin rather than asked for, because the answer is only known
  // after the comment list has reached it — see its `view()`.
  const [resolvedIds, setResolvedIds] = useState(() => new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  // Ids the parent picker must not offer; filled in when the picker opens.
  const [parentBlocked, setParentBlocked] = useState([]);
  const [iconOpen, setIconOpen] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const editorRef = useRef(null);
  // Whether a cursor has been placed in the document since this page opened —
  // see the Ctrl+L handler below.
  const touched = useRef(false);
  const saveTimer = useRef(null);
  const titleTimer = useRef(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The page in hand, but only for as long as it is the page the URL names.
  //
  // `load()` clears the previous page from inside an effect, which runs a
  // render *after* the route changed — so for exactly one render the new page
  // id was paired with the previous page's document. Everything below acted on
  // that mismatch: the editor mounted with the wrong body, and the collab
  // session built alongside it claimed the *new* page's one-shot content seed
  // and spent it on a document that was about to be thrown away. The page
  // stayed marked as seeded with nothing in its CRDT, and opened blank from
  // then on. Deriving the pairing here makes "this data belongs to this page"
  // a property of the render rather than of when a fetch happens to resolve.
  const data = loaded?.page.id === pageId ? loaded : null;

  const load = useCallback(async () => {
    setLoaded(null);
    try {
      const d = await api.get(`/api/pages/${pageId}`);
      setLoaded(d);
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

  // Someone rearranged the tree while this page was open. Only a move that
  // touched *this* page matters here: its breadcrumbs are now wrong, and a move
  // between spaces has also renamed its URL, so the address bar is corrected in
  // place rather than leaving the reader on a link that names the old space.
  useEffect(
    () =>
      onAppEvent('page-moved', (e) => {
        const d = e.detail || {};
        if (!d.pageIds?.includes(pageId)) return;
        if (d.crossSpace && d.spaceSlug && d.spaceSlug !== slug) {
          navigate(`/s/${d.spaceSlug}/p/${pageId}`, { replace: true });
          return; // the slug is a load() dependency, so this refetches too
        }
        setReloadKey((k) => k + 1);
      }),
    [pageId, slug, navigate]
  );

  // The public link was switched on or off somewhere else — another tab, or a
  // colleague in this same page. The share state is a permission, so it is not
  // allowed to drift: the switch and the copyable URL here follow the server's
  // answer rather than whatever this tab last set.
  useEffect(
    () =>
      onAppEvent('page-share-changed', (e) => {
        const d = e.detail || {};
        if (d.pageId !== pageId) return;
        setShareToken(d.shared ? d.token || null : null);
      }),
    [pageId]
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

  const loadComments = useCallback(async () => {
    if (!pageId) return;
    try {
      const data = await api.get(`/api/pages/${pageId}/comments`);
      setComments(data.comments);
    } catch {
      // A page whose comments will not load is still a page worth reading. The
      // highlights are simply absent; the panel shows an empty list.
    }
  }, [pageId]);

  // Loaded with the page, not with the panel: the highlights are part of the
  // document as it is read, and waiting for someone to open the sidebar would
  // mean commented text looks uncommented until they do.
  useEffect(() => {
    setComments([]);
    setPendingAnchor(null);
    loadComments();
  }, [pageId, loadComments]);

  // "Comment on this text" from the selection toolbar. A null anchor means the
  // selection was not a phrase — the panel opens for a page-level comment,
  // which is the honest fallback rather than a silent no-op.
  const startComment = useCallback((anchor) => {
    setPendingAnchor(anchor);
    setCommentsOpen(true);
  }, []);

  // Hovering a comment sends the document to its text and lights it up; leaving
  // puts it back. Both are pure view state — no selection is moved, so an author
  // mid-sentence keeps their caret. See scrollToComment.
  const previewComment = useCallback((id) => {
    scrollToComment(editorRef.current, id);
  }, []);

  const endPreview = useCallback(() => {
    setActiveComment(editorRef.current, null);
  }, []);

  // Clicking the highlighted text is the same relationship read the other way.
  const activateComment = useCallback((id) => {
    setCommentsOpen(true);
    setActiveComment(editorRef.current, id);
  }, []);

  // Whether a comment's text can still be found in the document as it stands.
  const isResolvable = useCallback((id) => resolvedIds.has(id), [resolvedIds]);

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

  // Ctrl+S → immediate save, Ctrl+F → in-document find (replacing the browser's)
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        clearTimeout(saveTimer.current);
        saveContent(editorRef.current);
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'f') {
        e.preventDefault();
        setFindOpen(true);
        // Pressing it again with the bar already open re-selects the query.
        document.querySelector('.gd-findbar input')?.select();
      }
      if (e.key === 'Escape') setFindOpen(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [saveContent]);

  // A find bar left open across page switches would show stale match counts.
  useEffect(() => { setFindOpen(false); }, [pageId]);

  // Ctrl+L from anywhere, and `:w` from the editor's own command line.
  useEffect(() => {
    const offFocus = onFocusEditor(() => {
      const editor = editorRef.current;
      if (!editor) return;
      // A page opened from the tree has never had a cursor put in it. Plain
      // `focus()` restores the selection the document already carries, and for
      // a collaborative document that is wherever the CRDT sync left it — the
      // very end — so Ctrl+L into a page you just opened dropped you at the
      // bottom of it. Land at the top the first time; once the cursor has been
      // somewhere, Ctrl+L goes back to where you left it.
      if (touched.current) editor.commands.focus();
      else editor.commands.focus('start');
    });
    const offSave = onRequestSave(() => {
      clearTimeout(saveTimer.current);
      saveContent(editorRef.current);
    });
    return () => { offFocus(); offSave(); };
  }, [saveContent]);

  // flush pending save on unmount/page switch
  useEffect(() => () => clearTimeout(saveTimer.current), [pageId]);

  // Ids the parent picker must not offer: this page and everything under it.
  // Fetched when the picker opens rather than held all the time — one request,
  // and only when someone actually reparents. Above the `if (!data)` return
  // below, because every hook in this component has to run on every render.
  useEffect(() => {
    if (!parentPickerOpen) return undefined;
    let cancelled = false;
    setParentBlocked([pageId]);
    api
      .get(`/api/pages/${pageId}/subtree`)
      .then((res) => {
        if (!cancelled) setParentBlocked(res.pages.map((p) => p.id));
      })
      // The page itself is already excluded; failing to learn its descendants
      // leaves the picker slightly too permissive, which the server still
      // catches. Not worth an error banner over.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [parentPickerOpen, pageId]);

  // The tab wears the open document's name and icon, and follows the title
  // field as it is typed rather than waiting for the debounced save.
  useDocumentIdentity(data ? title : undefined, data?.page.icon);

  if (!data)
    return <Center h="60vh"><Loader /></Center>;

  const toggleFavorite = async () => {
    if (isFavorite) await api.del(`/api/pages/${pageId}/favorite`);
    else await api.put(`/api/pages/${pageId}/favorite`);
    setIsFavorite(!isFavorite);
  };

  const applyIcon = (icon) => {
    setIconOpen(false);
    api.patch(`/api/pages/${pageId}`, { title, icon }).then(() => {
      setLoaded((d) => ({ ...d, page: { ...d.page, icon } }));
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

  // The page plus everything nested under it, as one flat archive of markdown
  // files. Unlike the two exports above this cannot come off the open editor —
  // the descendants are not loaded here — so it fetches the subtree itself.
  const exportZip = async () => {
    try {
      const count = await exportPageZip(pageId);
      notifications.show({ message: `Exported ${count} page${count === 1 ? '' : 's'}` });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
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

  // Breadcrumbs, elided in the middle once the chain gets long.
  //
  // Pages nest to any depth now, and the header is one row: a six-deep page
  // rendered in full pushes the presence bar, save state and page menu off the
  // end of the bar, and the segments that get squeezed are the first and last —
  // the two that actually say where you are. So keep the first ancestor and the
  // last two, and put everything between them behind a menu, which is where a
  // reader would look for "the levels I skipped" anyway.
  const { leading, elided, trailing } = elideCrumbs(data.breadcrumbs);

  const crumbLink = (b) => (
    <Anchor key={b.id} component={Link} to={`/s/${slug}/p/${b.id}`} size="sm" c="dimmed">
      <Emoji char={b.icon} size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
      {b.title || 'Untitled'}
    </Anchor>
  );

  // Mantine's Breadcrumbs puts a separator between each child, so the elided
  // levels have to be one child in that list rather than a nested fragment —
  // otherwise the "…" arrives without its separators and reads as part of the
  // segment beside it.
  const crumbNodes = [
    ...leading.map(crumbLink),
    ...(elided.length
      ? [
          <Menu key="elided" withinPortal position="bottom-start" shadow="md">
            <Menu.Target>
              <UnstyledButton className="gd-crumb-more" aria-label={`${elided.length} more levels`}>
                <Text size="sm" c="dimmed">…</Text>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {elided.map((b) => (
                <Menu.Item key={b.id} onClick={() => navigate(`/s/${slug}/p/${b.id}`)}>
                  <Emoji char={b.icon} size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  {b.title || 'Untitled'}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>,
        ]
      : []),
    ...trailing.map(crumbLink),
  ];

  return (
    <div className="gd-page">
      <Group justify="space-between" py={8} className="gd-page-topbar" wrap="nowrap">
        <Breadcrumbs separator="›" styles={{ separator: { opacity: 0.5 } }}>
          <Anchor component={Link} to={`/s/${slug}`} size="sm" c="dimmed">
            <Emoji char={data.space.icon} size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            {data.space.name}
          </Anchor>
          {crumbNodes}
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
                <Menu.Item leftSection={<IconMoodSmile size={14} />} onClick={() => setIconOpen(true)}>
                  {data.page.icon ? 'Change icon' : 'Set icon'}
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
              <Menu.Item leftSection={<IconFileZip size={14} />} onClick={exportZip}>
                Export as ZIP (with subpages)
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
            <Emoji
              char={data.page.icon}
              size={40}
              style={{ marginTop: 4, cursor: canWrite ? 'pointer' : 'default' }}
              onClick={canWrite ? () => setIconOpen(true) : undefined}
            />
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
          comments={comments}
          onAddComment={startComment}
          onActivateComment={activateComment}
          onCommentsResolved={setResolvedIds}
          space={data.space}
          onUpdate={onEditorUpdate}
          onReady={(editor) => {
            editorRef.current = editor;
            // A fresh editor per page — the key above sees to that — so the
            // "has the cursor been anywhere" flag resets with it, and a click
            // into the document counts as much as a Ctrl+L does.
            touched.current = false;
            editor.on('focus', () => { touched.current = true; });
          }}
        />
        <BacklinksPanel pageId={pageId} spaceId={data.page.space_id} />
      </Container>

      <FindBar editor={editorRef.current} opened={findOpen} onClose={() => setFindOpen(false)} />

      <PagePicker
        opened={parentPickerOpen}
        onClose={() => setParentPickerOpen(false)}
        onPick={setParent}
        title="Set parent page"
        spaceId={data.page.space_id}
        exclude={parentBlocked}
        rootLabel="No parent (top level)"
        onlySpace
      />
      <IconPickerModal
        page={iconOpen ? { ...data.page, title } : null}
        onClose={() => setIconOpen(false)}
        onPick={applyIcon}
      />
      <CommentsPanel
        pageId={pageId}
        opened={commentsOpen}
        onClose={() => {
          setCommentsOpen(false);
          setPendingAnchor(null);
          setActiveComment(editorRef.current, null);
        }}
        comments={comments}
        onReload={loadComments}
        pendingAnchor={pendingAnchor}
        onClearPendingAnchor={() => setPendingAnchor(null)}
        onPreviewComment={previewComment}
        onEndPreview={endPreview}
        isResolvable={isResolvable}
      />
      <HistoryModal
        pageId={pageId}
        opened={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}
