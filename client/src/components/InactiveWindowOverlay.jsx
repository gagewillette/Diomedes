import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';

// "Active since 3:42 PM" / "Active since Aug 21, 3:42 PM" once it is not today.
function formatSince(since) {
  if (!since) return null;
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * Shown over the app when another window holds this account. Deliberately not
 * a Mantine Modal: this cannot be dismissed with Escape or a click outside,
 * and the only way past it is to take the session over.
 */
export default function InactiveWindowOverlay({ holder, switching, onSwitch }) {
  const since = formatSince(holder?.since);
  const where = holder?.label;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="inactive-window-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        // The app stays visible underneath, drained of colour, so it reads as
        // "this window is paused" rather than "you have been signed out".
        backgroundColor: 'light-dark(rgba(248, 249, 250, 0.72), rgba(26, 27, 30, 0.78))',
        backdropFilter: 'saturate(0.25) blur(2px)',
      }}
    >
      <Paper withBorder shadow="md" radius="md" p="xl" style={{ maxWidth: 460, width: '100%' }}>
        <Stack gap="sm">
          <Title order={4} id="inactive-window-title">
            You&rsquo;re signed in somewhere else
          </Title>
          <Text size="sm" c="dimmed">
            This account can only be used in one window at a time
            {where ? ` — it’s currently open in ${where}` : ''}
            {since ? `, active since ${since}` : ''}. Move the session here to keep working; the
            other window will be paused.
          </Text>
          <Group justify="flex-end" mt="xs">
            <Button onClick={onSwitch} loading={switching}>
              Use this window
            </Button>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}
