import { Avatar, Group, Text, Tooltip } from '@mantine/core';
import { contrastInk, initials } from '../lib/userColor.js';

const MAX_SHOWN = 4;

/**
 * Who else is on this page, in the page's top bar.
 *
 * Each avatar carries the same colour as that person's caret and pointer, which
 * is the whole point: the colour is the identity, so a stray cursor in the
 * middle of a paragraph can be traced back to a name without hovering it.
 */
export default function PresenceBar({ peers, status }) {
  if (status === 'denied') {
    return (
      <Text size="xs" c="dimmed" className="gd-presence-status">
        Offline
      </Text>
    );
  }
  if (!peers.length) return null;

  const shown = peers.slice(0, MAX_SHOWN);
  const overflow = peers.length - shown.length;

  return (
    <Group gap={0} className="gd-presence" wrap="nowrap">
      {shown.map(({ clientId, user }) => (
        <Tooltip key={clientId} label={`${user.name}${user.mode === 'typing' ? ' — typing…' : ''}`}>
          <Avatar
            size={26}
            radius="xl"
            className={`gd-presence__avatar ${user.mode === 'typing' ? 'is-typing' : ''}`}
            styles={{
              placeholder: {
                background: user.color,
                color: contrastInk(user.color),
                fontSize: 11,
                fontWeight: 700,
              },
            }}
            style={{ '--gd-peer-color': user.color }}
          >
            {initials(user.name)}
          </Avatar>
        </Tooltip>
      ))}
      {overflow > 0 && (
        <Tooltip label={peers.slice(MAX_SHOWN).map((p) => p.user.name).join(', ')}>
          <Avatar size={26} radius="xl" className="gd-presence__avatar" styles={{ placeholder: { fontSize: 11 } }}>
            +{overflow}
          </Avatar>
        </Tooltip>
      )}
    </Group>
  );
}
