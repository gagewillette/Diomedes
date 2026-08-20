import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Group, Text, ActionIcon, Menu, UnstyledButton, Modal, TextInput, Button, Stack,
} from '@mantine/core';
import {
  IconChevronRight, IconDots, IconPlus, IconTrash, IconArrowUp, IconArrowDown,
  IconIndentIncrease, IconIndentDecrease, IconPencil, IconFileText, IconSitemap,
  IconFileImport, IconX, IconFileZip,
} from '@tabler/icons-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import { api, emitPagesChanged, onPagesChanged } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { focusEditor, onFocusFileTree } from '../lib/vimFocus.js';
import { jumpParent, moveDown, moveUp } from './vimTreeNav.js';
import PagePicker from './PagePicker.jsx';
import { markdownToJSON } from '../lib/markdown.js';
import { exportPageZip } from '../lib/exportZip.js';
import { dragState, dropIntent, multiDragImage } from '../lib/pageDrag.js';
import { dragPayload, inTreeOrder, nextSelection, treeOrder, visibleOrder } from './pageSelection.js';

// How long a collapsed page has to be hovered before it opens to accept a drop
// inside it. Long enough that dragging *past* a page never disturbs the tree,
// short enough that aiming for a grandchild is not a chore.
const HOVER_EXPAND_MS = 550;

// "Nothing is being dragged", shared so that ending a drag that never started
// does not hand React a new Set and re-render every row for nothing.
const EMPTY_SET = new Set();

// Pull a leading `# Heading` off the markdown so it can seed the page title
// instead of being duplicated in the body.
function splitLeadingHeading(md) {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = lines[i]?.match(/^#\s+(.+?)\s*$/);
  if (!m) return { title: null, body: md };
  return { title: m[1].trim(), body: lines.slice(i + 1).join('\n') };
}

export default function PageTree({ space }) {
  const [pages, setPages] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [reparenting, setReparenting] = useState(null); // page whose parent is being chosen
  const [dragging, setDragging] = useState(EMPTY_SET); // ids this tree is dragging
  const [dropAt, setDropAt] = useState(null); // { id, zone } | { id: null, zone: 'root' }
  const [selected, setSelected] = useState([]); // multi-selected ids, in tree order
  const [anchorId, setAnchorId] = useState(null); // where the next shift-click measures from
  const [confirmTrash, setConfirmTrash] = useState(false);
  const hoverTimer = useRef(null);
  const [importParent, setImportParent] = useState(null);
  const [importDoc, setImportDoc] = useState(null); // { body, fallbackTitle }
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pathParts = pathname.split('/');
  const activePageId = pathParts[3] === 'p' ? pathParts[4] : null;
  const canWrite = ['admin', 'writer'].includes(space.my_role);
  const { preferences } = useAuth();
  const vim = preferences.keymap === 'vim';
  // Ctrl+H lands in the tree of the space you are reading, not in whichever
  // other space happens to be open in the sidebar.
  const isCurrentSpace = pathParts[2] === space.slug;
  const treeRef = useRef(null);
  const [cursorId, setCursorId] = useState(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);

  const load = useCallback(async () => {
    const data = await api.get(`/api/spaces/${space.id}/pages`);
    setPages(data.pages);
  }, [space.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(
    () =>
      onPagesChanged((e) => {
        if (!e.detail.spaceId || e.detail.spaceId === space.id) load();
      }),
    [load, space.id]
  );

  const childrenOf = useMemo(() => {
    const map = new Map();
    for (const p of pages) {
      const key = p.parent_id || 'root';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return map;
  }, [pages]);

  // The two orders multi-select works in: every page top to bottom, and the
  // rows actually on screen. See pageSelection.js for why they are not one.
  const order = useMemo(() => treeOrder(childrenOf), [childrenOf]);
  const visible = useMemo(() => visibleOrder(childrenOf, expanded), [childrenOf, expanded]);

  // A selection outlives the list it was made from: someone else can trash or
  // move away a page while it is selected, and a stale id would go on to be
  // moved or deleted as part of a batch that no longer makes sense.
  useEffect(() => {
    setSelected((current) => {
      if (!current.length) return current;
      const pruned = inTreeOrder(order, current);
      return pruned.length === current.length ? current : pruned;
    });
  }, [order]);

  // Escape gives the selection back, from anywhere — the sidebar is rarely what
  // has focus when you decide you did not mean to select five pages.
  useEffect(() => {
    // Not while the confirmation is up: there, Escape means "not that" about the
    // dialog, and throwing the selection away as well would leave the dialog
    // counting zero pages on its way out.
    if (!selected.length || confirmTrash) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.length, confirmTrash]);

  // auto-expand ancestors of the active page
  useEffect(() => {
    if (!activePageId) return;
    const byId = new Map(pages.map((p) => [p.id, p]));
    const next = new Set(expanded);
    let cursor = byId.get(activePageId);
    while (cursor?.parent_id) {
      next.add(cursor.parent_id);
      cursor = byId.get(cursor.parent_id);
    }
    setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, pages]);

  // Ctrl+H: take focus, starting from the page being read.
  useEffect(() => {
    if (!vim || !isCurrentSpace) return undefined;
    return onFocusFileTree(() => {
      setCursorId((current) => current || activePageId || null);
      treeRef.current?.focus({ preventScroll: true });
    });
  }, [vim, isCurrentSpace, activePageId]);

  // Follow the route: opening a page from anywhere puts the cursor on it.
  useEffect(() => {
    if (vim && activePageId) setCursorId(activePageId);
  }, [vim, activePageId]);

  // Keep the cursor row on screen as it walks past the edge of the sidebar.
  useEffect(() => {
    if (!vim || !cursorId || !keyboardFocus) return;
    treeRef.current
      ?.querySelector(`[data-page-id="${cursorId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [vim, cursorId, keyboardFocus, expanded, pages]);

  const applyMove = (move) => {
    if (!move) return;
    if (move.expand.length) setExpanded((s) => new Set([...s, ...move.expand]));
    setCursorId(move.id);
  };

  const onTreeKeyDown = (e) => {
    if (!vim || e.metaKey || e.ctrlKey || e.altKey) return;
    const cursor = cursorId || activePageId;
    switch (e.key) {
      case 'j':
        applyMove(moveDown(childrenOf, expanded, cursor));
        break;
      case 'k':
        applyMove(moveUp(childrenOf, expanded, cursor));
        break;
      case '}':
        applyMove(jumpParent(childrenOf, pages, cursor, 1));
        break;
      case '{':
        applyMove(jumpParent(childrenOf, pages, cursor, -1));
        break;
      case 'Enter':
        if (cursor) navigate(`/s/${space.slug}/p/${cursor}`);
        break;
      case 'Escape':
        treeRef.current?.blur();
        focusEditor();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const createPage = async (parentId = null) => {
    try {
      const data = await api.post('/api/pages', { spaceId: space.id, parentId });
      emitPagesChanged(space.id);
      if (parentId) setExpanded((s) => new Set([...s, parentId]));
      navigate(`/s/${space.slug}/p/${data.page.id}`);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const pickImportFile = (parentId) => {
    setImportParent(parentId);
    importInputRef.current?.click();
  };

  const readImportFile = async (file) => {
    try {
      const text = await file.text();
      const { title, body } = splitLeadingHeading(text);
      const fallbackTitle = title || file.name.replace(/\.(md|markdown|txt)$/i, '');
      setImportDoc({ body, fallbackTitle });
      setImportName(fallbackTitle);
    } catch (err) {
      notifications.show({ color: 'red', message: `${file.name}: ${err.message}` });
      setImportParent(null);
    }
  };

  const closeImport = () => {
    setImportDoc(null);
    setImportParent(null);
    setImportName('');
  };

  const runImport = async () => {
    if (!importDoc || importing) return;
    const title = importName.trim() || importDoc.fallbackTitle || 'Untitled';
    setImporting(true);
    try {
      // One request: the page comes into existence with its body already in
      // place, so the editor cannot open it during the window where it exists
      // but is still empty.
      const d = await api.post('/api/pages', {
        spaceId: space.id,
        parentId: importParent,
        title,
        content: markdownToJSON(importDoc.body),
      });
      emitPagesChanged(space.id);
      if (importParent) setExpanded((s) => new Set([...s, importParent]));
      closeImport();
      navigate(`/s/${space.slug}/p/${d.page.id}`);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    } finally {
      setImporting(false);
    }
  };

  // The one row action a reader gets: export is a read. The work — every page
  // in the subtree, rendered and zipped — happens here in the browser, so say
  // how much of it there was when the file lands.
  const exportZip = async (page) => {
    try {
      const count = await exportPageZip(page.id);
      notifications.show({ message: `Exported ${count} page${count === 1 ? '' : 's'}` });
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  const act = async (fn) => {
    try {
      await fn();
      emitPagesChanged(space.id);
    } catch (err) {
      notifications.show({ color: 'red', message: err.message });
    }
  };

  // The tree's own list of a page's siblings, minus the pages being moved — the
  // same list the server rebuilds when it resolves an index, so "put it third"
  // means the same thing on both ends. A whole selection is excluded rather
  // than one page, because the pages already sitting in the destination list are
  // about to leave it and must not be counted as neighbours of themselves.
  const siblingsWithout = useCallback(
    (parentId, excludeIds) =>
      (childrenOf.get(parentId || 'root') || []).filter((p) => !excludeIds.has(p.id)),
    [childrenOf]
  );

  // ---- selecting several pages ----

  const clearSelection = () => {
    setSelected([]);
    setAnchorId(null);
  };

  // A click on a row is either navigation or selection, never both: ⌘ or shift
  // means you are gathering pages, and opening one under the cursor would throw
  // away the editor you were about to move things next to.
  const onRowClick = (page) => (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta && !e.shiftKey) {
      clearSelection();
      setAnchorId(page.id);
      setCursorId(page.id);
      navigate(`/s/${space.slug}/p/${page.id}`);
      return;
    }
    // Shift-clicking inside a button otherwise paints a text selection across
    // half the sidebar.
    e.preventDefault();
    window.getSelection?.()?.removeAllRanges();
    const next = nextSelection({
      visible, order, selected, anchorId, id: page.id, meta, shift: e.shiftKey,
    });
    setSelected(next.selected);
    setAnchorId(next.anchorId);
  };

  const trashSelection = () => {
    const ids = selected;
    setConfirmTrash(false);
    clearSelection();
    // Subpages go into the trash with their parents, so the page being read can
    // be on its way out without being in the selection itself.
    const activeParent = pages.find((p) => p.id === activePageId)?.parent_id;
    if (ids.includes(activePageId) || (activeParent && ids.includes(activeParent))) {
      navigate(`/s/${space.slug}`);
    }
    act(async () => {
      await api.post('/api/pages/delete-many', { pageIds: ids });
      notifications.show({ message: `Moved ${ids.length} pages to trash` });
    });
  };

  // ---- dragging ----

  const clearHoverTimer = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  const endDrag = useCallback(() => {
    clearHoverTimer();
    dragState.current = null;
    setDragging(EMPTY_SET);
    setDropAt(null);
  }, []);

  // `dragend` only fires on the element the drag started from, so a tree that
  // merely showed a drop hint for someone else's page would keep it forever.
  useEffect(() => {
    const clear = () => {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
      setDragging(EMPTY_SET);
      setDropAt(null);
    };
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  const onDragStart = (page) => (e) => {
    // Grabbing a row that is part of the selection picks the whole selection
    // up, in tree order — which is the order it will be put back down in.
    const ids = dragPayload(selected, page.id);
    if (ids.length === 1 && selected.length) clearSelection();

    // Descendants travel with their page, so they are also the set the batch can
    // never be dropped into. Collected up front: the tree that owns them is not
    // necessarily the tree being dragged over.
    const blockedIds = new Set(ids);
    const walk = (id) => {
      for (const child of childrenOf.get(id) || []) {
        blockedIds.add(child.id);
        walk(child.id);
      }
    };
    for (const id of ids) walk(id);

    const byId = new Map(pages.map((p) => [p.id, p]));
    const titles = ids.map((id) => byId.get(id)?.title || 'Untitled');
    dragState.current = {
      pageIds: ids,
      spaceId: space.id,
      titles,
      // Whether *anything* in the batch is carrying subpages. One flag rather
      // than a per-page answer, because the whole batch lands in one place and
      // so is refused or allowed as one.
      hasChildren: blockedIds.size > ids.length,
      blockedIds,
    };
    setDragging(new Set(ids));
    e.dataTransfer.effectAllowed = 'move';
    // A plain-text payload keeps the cursor showing a move rather than the
    // "no drop" badge in browsers that want *some* data on the transfer.
    e.dataTransfer.setData('text/plain', titles.join('\n'));
    if (ids.length > 1) {
      const ghost = multiDragImage(titles, ids.length);
      e.dataTransfer.setDragImage(ghost, 24, 22);
      // The browser has taken its snapshot by the time this runs; leaving the
      // node in the document would pile up an off-screen stack per drag.
      setTimeout(() => ghost.remove(), 0);
    }
  };

  // Hovering a collapsed page opens it, so a drop can be aimed at a child
  // without breaking the drag to click the chevron first.
  const scheduleExpand = (page) => {
    if (expanded.has(page.id) || !(childrenOf.get(page.id) || []).length) return;
    if (hoverTimer.current) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setExpanded((s) => new Set([...s, page.id]));
    }, HOVER_EXPAND_MS);
  };

  // The tree is one level of subpages deep, so a drop that would make a third
  // level is refused here as well as on the server: dropping *into* a page only
  // works when that page is top level, and a page carrying subpages of its own
  // can only ever land back at the top level. Refusing during dragover is what
  // shows the "no drop" cursor rather than letting the drop fail after the fact.
  const dropAllowed = (page, zone, drag) => {
    if (zone === 'inside') return !page.parent_id && !drag.hasChildren;
    return !page.parent_id || !drag.hasChildren;
  };

  const onDragOverRow = (page) => (e) => {
    const drag = dragState.current;
    if (!drag || !canWrite) return;
    // A page cannot land on itself, and landing beside or inside one of its own
    // descendants would cut the branch out of the tree entirely — the parent
    // chain would loop and nothing would ever render it again.
    if (drag.blockedIds.has(page.id)) return;
    const zone = dropIntent(e.currentTarget.getBoundingClientRect(), e.clientY);
    if (!dropAllowed(page, zone, drag)) {
      clearHoverTimer();
      setDropAt((prev) => (prev?.id === page.id ? null : prev));
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (zone === 'inside') scheduleExpand(page);
    else clearHoverTimer();
    setDropAt((prev) => (prev?.id === page.id && prev.zone === zone ? prev : { id: page.id, zone }));
  };

  // `dragleave` also fires on the way into a child element, so the hint is only
  // dropped when the cursor has genuinely left the row — otherwise it would
  // flicker off every time the pointer crossed the page's own label.
  const onDragLeaveRow = (page) => (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    clearHoverTimer();
    setDropAt((prev) => (prev?.id === page.id ? null : prev));
  };

  const onDropRow = (page) => (e) => {
    const drag = dragState.current;
    if (!drag || !canWrite || drag.blockedIds.has(page.id)) return;
    const zone = dropIntent(e.currentTarget.getBoundingClientRect(), e.clientY);
    if (!dropAllowed(page, zone, drag)) return;
    e.preventDefault();
    e.stopPropagation();

    const moving = new Set(drag.pageIds);
    if (zone === 'inside') {
      commitMove(drag, { parentId: page.id, index: siblingsWithout(page.id, moving).length });
      setExpanded((s) => new Set([...s, page.id]));
      return;
    }
    const siblings = siblingsWithout(page.parent_id, moving);
    const at = siblings.findIndex((s) => s.id === page.id);
    commitMove(drag, {
      parentId: page.parent_id || null,
      index: at < 0 ? siblings.length : at + (zone === 'after' ? 1 : 0),
    });
  };

  // The strip below the last root page: the only way to say "top level of this
  // space, at the end", which is otherwise unreachable once every root page is
  // occupied by its own before/after zones.
  const onDragOverRoot = (e) => {
    if (!dragState.current || !canWrite) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearHoverTimer();
    setDropAt((prev) => (prev?.zone === 'root' ? prev : { id: null, zone: 'root' }));
  };

  const onDropRoot = (e) => {
    const drag = dragState.current;
    if (!drag || !canWrite) return;
    e.preventDefault();
    commitMove(drag, {
      parentId: null,
      index: siblingsWithout(null, new Set(drag.pageIds)).length,
    });
  };

  const commitMove = (drag, { parentId, index }) => {
    endDrag();
    const crossSpace = drag.spaceId !== space.id;
    const ids = drag.pageIds;
    act(async () => {
      // One page still goes down the single-page endpoint. It is the path every
      // other way of moving a page uses, and a batch of one has nothing to gain
      // from the batch endpoint's extra bookkeeping.
      if (ids.length === 1) {
        await api.post(`/api/pages/${ids[0]}/move`, { parentId, index, spaceId: space.id });
      } else {
        await api.post('/api/pages/move-many', {
          pageIds: ids, parentId, index, spaceId: space.id,
        });
      }
      // A cross-space move empties a slot in a tree this component does not
      // own, so both sides have to be told; same-space moves are covered by the
      // caller's own emit.
      if (crossSpace) emitPagesChanged(drag.spaceId);
    });
  };

  const rowDropClass = (pageId) =>
    dropAt?.id === pageId ? `is-drop-${dropAt.zone}` : '';

  // Where each page sits in the pile being carried, so the shuffle animation
  // can stagger down the stack instead of every row twitching in unison.
  const dragIndex = useMemo(() => new Map([...dragging].map((id, i) => [id, i])), [dragging]);

  const renderNode = (page, depth) => {
    const kids = childrenOf.get(page.id) || [];
    const isOpen = expanded.has(page.id);
    const siblings = childrenOf.get(page.parent_id || 'root') || [];
    const idx = siblings.findIndex((s) => s.id === page.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    // Only top-level pages take children, and only a childless page can become
    // one — the server enforces the same rule.
    const canNest = !page.parent_id;
    const canBeNested = !page.parent_id && kids.length === 0;
    const inSelection = selected.length > 1 && selected.includes(page.id);
    const reorder = (index) =>
      act(() => api.post(`/api/pages/${page.id}/move`, { parentId: page.parent_id || null, index }));

    return (
      <div key={page.id}>
        <Group
          gap={2}
          wrap="nowrap"
          data-page-id={page.id}
          className={[
            'gd-tree-row',
            page.id === activePageId ? 'is-active' : '',
            selected.includes(page.id) ? 'is-selected' : '',
            dragging.has(page.id) ? 'is-dragging' : '',
            dragging.size > 1 && dragging.has(page.id) ? 'is-jumbling' : '',
            rowDropClass(page.id),
            vim && keyboardFocus && page.id === (cursorId || activePageId) ? 'is-vim-cursor' : '',
          ].filter(Boolean).join(' ')}
          style={{ paddingLeft: 4 + depth * 14, '--jumble-i': dragIndex.get(page.id) ?? 0 }}
          draggable={canWrite}
          onDragStart={canWrite ? onDragStart(page) : undefined}
          onDragEnd={endDrag}
          onDragOver={onDragOverRow(page)}
          onDragLeave={onDragLeaveRow(page)}
          onDrop={onDropRow(page)}
        >
          <ActionIcon
            size="xs" variant="subtle" color="gray"
            style={{ visibility: kids.length ? 'visible' : 'hidden' }}
            onClick={() =>
              setExpanded((s) => {
                const next = new Set(s);
                next.has(page.id) ? next.delete(page.id) : next.add(page.id);
                return next;
              })
            }
          >
            <IconChevronRight size={13} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
          </ActionIcon>
          <UnstyledButton
            className="gd-tree-label"
            title={page.title || 'Untitled'}
            onClick={onRowClick(page)}
          >
            <Group gap={6} wrap="nowrap">
              <span className="gd-tree-icon">
                {page.icon ? page.icon : <IconFileText size={14} opacity={0.6} />}
              </span>
              <Text size="sm" truncate>{page.title || 'Untitled'}</Text>
            </Group>
          </UnstyledButton>
          <span className="gd-tree-actions">
            <Menu withinPortal position="bottom-start" shadow="md">
              <Menu.Target>
                <ActionIcon size="xs" variant="subtle" color="gray"><IconDots size={13} /></ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {/* Export is a read, so this one item is here for readers too —
                    the rest of the menu changes the page and is not. */}
                <Menu.Item
                  leftSection={<IconFileZip size={14} />}
                  onClick={() => exportZip(page)}
                >
                  Export as ZIP
                </Menu.Item>
                {canWrite && (
                  <>
                    <Menu.Divider />
                    {/* The tree is one level deep, so a subpage takes no children
                        of its own — neither created nor imported. */}
                    {canNest && (
                      <>
                        <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => createPage(page.id)}>
                          New subpage
                        </Menu.Item>
                        <Menu.Item leftSection={<IconFileImport size={14} />} onClick={() => pickImportFile(page.id)}>
                          Import markdown file
                        </Menu.Item>
                      </>
                    )}
                    <Menu.Item
                      leftSection={<IconPencil size={14} />}
                      onClick={() => {
                        const title = window.prompt('Rename page', page.title);
                        if (title !== null) act(() => api.patch(`/api/pages/${page.id}`, { title }));
                      }}
                    >
                      Rename
                    </Menu.Item>
                    <Menu.Divider />
                    {/* Slots, not sort keys: the server places the page among the
                        siblings it can see, so these agree with a drag that
                        landed in the same gap a moment earlier. */}
                    <Menu.Item
                      leftSection={<IconArrowUp size={14} />} disabled={idx <= 0}
                      onClick={() => reorder(idx - 1)}
                    >
                      Move up
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconArrowDown size={14} />} disabled={idx === siblings.length - 1}
                      onClick={() => reorder(idx + 1)}
                    >
                      Move down
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconIndentIncrease size={14} />} disabled={idx <= 0 || !canBeNested}
                      onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, { parentId: siblings[idx - 1].id }))}
                    >
                      Nest under previous
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconSitemap size={14} />}
                      onClick={() => setReparenting(page)}
                    >
                      Set parent page…
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconIndentDecrease size={14} />} disabled={!page.parent_id}
                      onClick={() => act(() => api.post(`/api/pages/${page.id}/move`, {
                        parentId: byId.get(page.parent_id)?.parent_id || null,
                      }))}
                    >
                      Move out one level
                    </Menu.Item>
                    <Menu.Divider />
                    {/* On a row that is part of a selection, the menu acts on the
                        selection — trashing just this one out from under a
                        highlighted group is never what the click meant. */}
                    {inSelection ? (
                      <Menu.Item
                        color="red" leftSection={<IconTrash size={14} />}
                        onClick={() => setConfirmTrash(true)}
                      >
                        Move {selected.length} pages to trash
                      </Menu.Item>
                    ) : (
                      <Menu.Item
                        color="red" leftSection={<IconTrash size={14} />}
                        onClick={() => {
                          if (page.id === activePageId) navigate(`/s/${space.slug}`);
                          act(() => api.del(`/api/pages/${page.id}`));
                        }}
                      >
                        Move to trash
                      </Menu.Item>
                    )}
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          </span>
        </Group>
        {isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const roots = childrenOf.get('root') || [];
  return (
    <div
      className={`gd-tree ${vim && keyboardFocus ? 'is-vim-focus' : ''}`}
      ref={treeRef}
      tabIndex={vim ? -1 : undefined}
      onKeyDown={vim ? onTreeKeyDown : undefined}
      onFocus={vim ? () => setKeyboardFocus(true) : undefined}
      onBlur={vim ? (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setKeyboardFocus(false);
      } : undefined}
    >
      <input
        ref={importInputRef} type="file" accept=".md,.markdown,.txt" hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) readImportFile(file);
        }}
      />
      <Modal opened={!!importDoc} onClose={closeImport} title="Import markdown file" centered>
        <Stack gap="md">
          <TextInput
            label="Page name" data-autofocus value={importName}
            onChange={(e) => setImportName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runImport(); }}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={closeImport}>Cancel</Button>
            <Button onClick={runImport} loading={importing}>Import</Button>
          </Group>
        </Stack>
      </Modal>
      <PagePicker
        opened={Boolean(reparenting)}
        onClose={() => setReparenting(null)}
        onPick={(parent) => {
          const child = reparenting;
          act(() => api.post(`/api/pages/${child.id}/move`, { parentId: parent?.id ?? null }));
          if (parent) setExpanded((s) => new Set([...s, parent.id]));
        }}
        title={`Set parent of “${reparenting?.title || 'Untitled'}”`}
        spaceId={space.id}
        exclude={reparenting?.id}
        rootLabel="No parent (top level)"
        onlySpace
        topLevelOnly
      />
      {/* Trashing several pages at once is the one thing here that cannot be
          undone by dragging them back, so it asks first — and says how many,
          because the whole risk is a selection being bigger than you thought. */}
      <Modal
        opened={confirmTrash} onClose={() => setConfirmTrash(false)}
        title="Move pages to trash?" centered
      >
        <Stack gap="md">
          <Text size="sm">
            {selected.length} pages and their subpages will be moved to the trash.
            You can restore them from the space’s trash.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setConfirmTrash(false)}>Cancel</Button>
            <Button color="red" onClick={trashSelection}>
              Move {selected.length} pages to trash
            </Button>
          </Group>
        </Stack>
      </Modal>
      {canWrite && selected.length > 1 && (
        <Group className="gd-tree-selbar" gap={4} wrap="nowrap">
          <Text size="xs" fw={600}>{selected.length} selected</Text>
          <span style={{ flex: 1 }} />
          <ActionIcon
            size="sm" variant="subtle" color="red" title="Move to trash"
            onClick={() => setConfirmTrash(true)}
          >
            <IconTrash size={14} />
          </ActionIcon>
          <ActionIcon
            size="sm" variant="subtle" color="gray" title="Clear selection (Esc)"
            onClick={clearSelection}
          >
            <IconX size={14} />
          </ActionIcon>
        </Group>
      )}
      {roots.map((p) => renderNode(p, 0))}
      {canWrite && (
        <div
          className={`gd-tree-root-drop ${dropAt?.zone === 'root' ? 'is-drop-root' : ''}`}
          onDragOver={onDragOverRoot}
          onDragLeave={() => setDropAt((prev) => (prev?.zone === 'root' ? null : prev))}
          onDrop={onDropRoot}
        >
          <UnstyledButton className="gd-tree-add" onClick={() => createPage(null)}>
            <Group gap={6}><IconPlus size={13} /><Text size="xs">New page</Text></Group>
          </UnstyledButton>
        </div>
      )}
    </div>
  );
}
