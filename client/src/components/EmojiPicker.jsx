import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Box, Group, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { IconSearch, IconTrash } from '@tabler/icons-react';
import { EMOJI_CATEGORIES, searchEmoji, spriteStyle } from '../lib/emoji.js';

// The grid is a fixed nine columns so the popover has one width and the cells
// stay on the pixel grid — a sprite drawn at a fractional size is fuzzy.
const COLS = 9;
const CELL = 36;
const HEADER = 26;
const VIEWPORT = 288;
// Rows drawn past the edge of the viewport, so a fast scroll never shows a gap.
const OVERSCAN = 2;

/**
 * Lay the results out as rows, keeping the category headings that make the
 * unfiltered grid browsable. Searching drops the headings: the results are
 * ranked across categories by then, so grouping them would fight the ranking.
 */
function buildRows(results, grouped) {
  const rows = [];
  if (!grouped) {
    for (let i = 0; i < results.length; i += COLS) {
      rows.push({ type: 'emoji', items: results.slice(i, i + COLS), height: CELL });
    }
    return rows;
  }
  for (const [group, label] of EMOJI_CATEGORIES.entries()) {
    const inGroup = results.filter((e) => e.g === group);
    if (!inGroup.length) continue;
    rows.push({ type: 'header', label, group, height: HEADER });
    for (let i = 0; i < inGroup.length; i += COLS) {
      rows.push({ type: 'emoji', items: inGroup.slice(i, i + COLS), height: CELL });
    }
  }
  return rows;
}

/**
 * A grid of every emoji we have Apple artwork for, narrowed by typing.
 *
 * Nineteen hundred cells is more than React wants to keep in the DOM while you
 * scroll, so only the rows in view are rendered; the rest are accounted for by
 * a spacer of the right height.
 */
export default function EmojiPicker({ value, onSelect, onRemove }) {
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [active, setActive] = useState(0); // index into `results`, for arrow keys
  const viewportRef = useRef(null);
  const inputRef = useRef(null);

  // The picker is opened from a menu, and a Mantine menu hands focus back to
  // the button that opened it as it closes -- which happens after the modal has
  // autofocused. Claim focus again once that is over, so you can just type.
  useEffect(() => {
    inputRef.current?.focus();
    const t = setTimeout(() => inputRef.current?.focus(), 200);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => searchEmoji(query), [query]);
  const grouped = !query.trim();
  const rows = useMemo(() => buildRows(results, grouped), [results, grouped]);

  // Cumulative row offsets, so a scroll position maps to a row without walking
  // the whole list on every frame.
  const offsets = useMemo(() => {
    const out = [0];
    for (const row of rows) out.push(out[out.length - 1] + row.height);
    return out;
  }, [rows]);
  const total = offsets[offsets.length - 1];

  // A new query means new results: back to the top, with the first hit primed
  // so Enter picks the obvious thing.
  useLayoutEffect(() => {
    setActive(0);
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [query]);

  // Keep the arrow-key selection in view.
  useEffect(() => {
    if (!query.trim() || !viewportRef.current) return;
    const row = Math.floor(active / COLS);
    const top = row * CELL;
    const el = viewportRef.current;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + CELL > el.scrollTop + VIEWPORT) el.scrollTop = top + CELL - VIEWPORT;
  }, [active, query]);

  let first = 0;
  while (first < rows.length && offsets[first + 1] <= scrollTop - OVERSCAN * CELL) first++;
  let last = first;
  while (last < rows.length && offsets[last] < scrollTop + VIEWPORT + OVERSCAN * CELL) last++;
  const visible = rows.slice(first, last);

  function onKeyDown(e) {
    if (!results.length) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (step) {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, Math.max(0, i + step)));
      return;
    }
    if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      onSelect(results[active].c);
    }
  }

  return (
    <Box>
      <Group gap={6} wrap="nowrap" mb={8}>
        <TextInput
          ref={inputRef}
          data-autofocus
          flex={1}
          size="xs"
          placeholder="Search emoji"
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {onRemove && (
          <Tooltip label="Remove icon" withArrow>
            <ActionIcon variant="subtle" color="gray" onClick={onRemove} aria-label="Remove icon">
              <IconTrash size={15} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <div
        ref={viewportRef}
        className="gd-emoji-viewport"
        style={{ height: VIEWPORT }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {results.length === 0 ? (
          <Text size="xs" c="dimmed" ta="center" pt="lg">
            No emoji match “{query}”
          </Text>
        ) : (
          <div style={{ height: total, position: 'relative' }}>
            {visible.map((row, i) => {
              const top = offsets[first + i];
              if (row.type === 'header') {
                return (
                  <Text
                    key={`h-${row.group}`}
                    className="gd-emoji-heading"
                    size="xs"
                    fw={600}
                    c="dimmed"
                    style={{ top, height: row.height }}
                  >
                    {row.label}
                  </Text>
                );
              }
              return (
                <div key={`r-${top}`} className="gd-emoji-row" style={{ top, height: row.height }}>
                  {row.items.map((entry) => {
                    const isActive = !grouped && results[active] === entry;
                    return (
                      <UnstyledButton
                        key={entry.c}
                        className="gd-emoji-cell"
                        data-active={isActive || undefined}
                        data-current={entry.c === value || undefined}
                        title={entry.n}
                        aria-label={entry.n}
                        onClick={() => onSelect(entry.c)}
                        style={{ width: CELL, height: CELL }}
                      >
                        <span style={{ ...spriteStyle(entry, 24), backgroundRepeat: 'no-repeat' }} />
                      </UnstyledButton>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Box>
  );
}
