import { Button, Group, Paper, RemoveScroll, Stack, Text, Title } from '@mantine/core';
import { useAuth } from '../lib/AuthContext.jsx';

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
 *
 * Three things keep the window underneath genuinely out of reach while this is
 * up. `inert` on the app (see App.jsx) takes pointer and keyboard out of it;
 * this fixed layer covers the whole viewport, so a click anywhere lands here
 * and does nothing; and RemoveScroll — the same scroll lock Mantine's own Modal
 * uses — stops the page scrolling behind it, which `inert` does not do on its
 * own. What is left is one button.
 */
export default function InactiveWindowOverlay({ holder, switching, onSwitch }) {
  const { preferences } = useAuth();
  const since = formatSince(holder?.since);
  const where = holder?.label;
  // The overlay mounts outside Layout, so the `gd-anim-off` class that Layout
  // puts on the app when someone turns interface animations off never reaches
  // it — the preference has to be read here instead. (A reduced-motion setting
  // at the OS level is handled in the stylesheet.)
  const animate = preferences?.animations !== false;

  return (
    <RemoveScroll forwardProps>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="inactive-window-title"
        className={animate ? 'gd-inactive-overlay gd-inactive-overlay-anim' : 'gd-inactive-overlay'}
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
              {/* The only live control on the screen, so it takes the focus:
                  whoever hit a key and found the app frozen can press Enter. */}
              <Button onClick={onSwitch} loading={switching} autoFocus>
                Use this window
              </Button>
            </Group>
          </Stack>
        </Paper>
      </div>
    </RemoveScroll>
  );
}
