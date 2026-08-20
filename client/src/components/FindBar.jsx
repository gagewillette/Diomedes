import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Paper, Group, TextInput, ActionIcon, Text, Tooltip, SegmentedControl, Popover, Stack, Code, Kbd,
} from '@mantine/core';
import {
  IconChevronUp, IconChevronDown, IconX, IconLetterCase, IconHelp, IconSearch,
} from '@tabler/icons-react';
import { getFindState } from '../editor/FindInPage.js';
import { MAX_MATCHES } from '../lib/findText.js';

const REGEX_EXAMPLES = [
  ['\\bTODO\\b', 'the word TODO on its own'],
  ['colou?r', 'color or colour'],
  ['^#+ ', 'lines starting with a heading marker'],
  ['\\d{4}-\\d{2}-\\d{2}', 'dates like 2026-08-19'],
];

/**
 * In-document find bar. Rendered by whichever page owns an editor; it drives the
 * FindInPage extension and never touches the document itself.
 */
export default function FindBar({ editor, opened, onClose }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('text'); // text | regex
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState({ matches: [], active: -1, error: null, truncated: false });
  const inputRef = useRef(null);

  const isRegex = mode === 'regex';

  const sync = useCallback(() => {
    const s = getFindState(editor);
    // Transactions fire constantly while typing; only re-render on real changes.
    setStatus((prev) =>
      prev.matches === s.matches && prev.active === s.active && prev.error === s.error
        ? prev
        : { matches: s.matches, active: s.active, error: s.error, truncated: s.truncated });
  }, [editor]);

  // Push the query into the editor whenever it or the options change.
  useEffect(() => {
    if (!editor || !opened) return;
    editor.commands.setFindQuery({ query, regex: isRegex, caseSensitive });
    sync();
  }, [editor, opened, query, isRegex, caseSensitive, sync]);

  // Keep the counter honest while the document is being edited.
  useEffect(() => {
    if (!editor) return undefined;
    editor.on('transaction', sync);
    return () => { editor.off('transaction', sync); };
  }, [editor, sync]);

  useEffect(() => {
    if (opened) inputRef.current?.select();
    else editor?.commands.clearFind();
  }, [opened, editor]);

  // Bring the current match into view once decorations have been painted.
  useEffect(() => {
    if (!opened) return;
    const id = requestAnimationFrame(() => {
      document
        .querySelector('.gd-find-match-active')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [opened, status.active, status.matches.length]);

  const step = (delta) => {
    editor?.commands.stepFindMatch(delta);
    sync();
  };

  if (!opened) return null;

  const total = status.matches.length;
  const counter = status.error
    ? 'invalid'
    : total === 0
      ? (query ? 'no results' : '')
      : `${status.active + 1}/${total}${status.truncated ? `+ (first ${MAX_MATCHES})` : ''}`;

  return (
    <Paper className="gd-findbar" shadow="md" withBorder p={8} radius="md">
      <Group gap={6} wrap="nowrap" align="flex-start">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={setMode}
          data={[
            { value: 'text', label: 'Text' },
            { value: 'regex', label: '.*' },
          ]}
          aria-label="Search mode: plain text or regular expression"
        />
        <div style={{ width: 230 }}>
          <TextInput
            ref={inputRef}
            autoFocus
            size="xs"
            leftSection={<IconSearch size={14} />}
            placeholder={isRegex ? 'Regular expression…' : 'Find in page…'}
            value={query}
            error={Boolean(status.error)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              // Alt+R flips modes without leaving the keyboard.
              if (e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                setMode(isRegex ? 'text' : 'regex');
              }
            }}
            styles={{ input: isRegex ? { fontFamily: 'var(--mantine-font-family-monospace)' } : undefined }}
          />
          <Text size="10px" c={status.error ? 'red' : 'dimmed'} mt={3} lineClamp={1}>
            {status.error
              ? status.error
              : isRegex
                ? 'Regex mode — Alt+R for plain text'
                : 'Plain text — Alt+R or .* for regex'}
          </Text>
        </div>
        <Text size="xs" c="dimmed" w={80} ta="right" mt={6} style={{ whiteSpace: 'nowrap' }}>
          {counter}
        </Text>
        <Tooltip label={caseSensitive ? 'Case sensitive' : 'Ignoring case'}>
          <ActionIcon
            size="sm" mt={3}
            variant={caseSensitive ? 'filled' : 'subtle'}
            color={caseSensitive ? 'blue' : 'gray'}
            onClick={() => setCaseSensitive((v) => !v)}
            aria-label="Toggle case sensitivity"
          >
            <IconLetterCase size={15} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Previous (Shift+Enter)">
          <ActionIcon size="sm" mt={3} variant="subtle" color="gray" disabled={!total} onClick={() => step(-1)}>
            <IconChevronUp size={15} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Next (Enter)">
          <ActionIcon size="sm" mt={3} variant="subtle" color="gray" disabled={!total} onClick={() => step(1)}>
            <IconChevronDown size={15} />
          </ActionIcon>
        </Tooltip>
        <Popover width={300} position="bottom-end" withArrow shadow="md">
          <Popover.Target>
            <ActionIcon size="sm" mt={3} variant="subtle" color="gray" aria-label="Search help">
              <IconHelp size={15} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap={6}>
              <Text size="xs">
                <b>Text</b> matches exactly what you type. <b>.*</b> treats the query as a
                JavaScript regular expression.
              </Text>
              {REGEX_EXAMPLES.map(([pattern, desc]) => (
                <Group key={pattern} gap={6} wrap="nowrap">
                  <Code fz={11}>{pattern}</Code>
                  <Text size="xs" c="dimmed">{desc}</Text>
                </Group>
              ))}
              <Text size="xs" c="dimmed">
                <Kbd size="xs">Enter</Kbd> next · <Kbd size="xs">Shift</Kbd>+<Kbd size="xs">Enter</Kbd> previous ·{' '}
                <Kbd size="xs">Alt</Kbd>+<Kbd size="xs">R</Kbd> toggle regex · <Kbd size="xs">Esc</Kbd> close
              </Text>
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <Tooltip label="Close (Esc)">
          <ActionIcon size="sm" mt={3} variant="subtle" color="gray" onClick={onClose} aria-label="Close find bar">
            <IconX size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Paper>
  );
}
