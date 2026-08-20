import { contrastInk } from '../../lib/userColor.js';

/**
 * Miro-style mouse pointers for everyone who is not currently typing.
 *
 * Positions arrive in content coordinates (see presence.js) and are mapped back
 * onto this client's layout, so the pointer lands next to the same words no
 * matter how each person's window is sized or scrolled. The layer itself is
 * absolutely positioned inside the editor wrap and never takes pointer events.
 *
 * Smoothing is left to CSS: peers publish roughly 20 positions a second and a
 * short transform transition turns that into continuous motion, which is
 * cheaper and steadier than interpolating in JavaScript.
 */
export default function PointerLayer({ peers }) {
  const visible = peers.filter((p) => p.pointer && p.user?.mode !== 'typing');
  if (!visible.length) return null;

  return (
    <div className="gd-pointer-layer" aria-hidden="true">
      {visible.map(({ clientId, user, pointer }) => {
        const color = user.color || '#FF2D55';
        return (
          <div
            key={clientId}
            className="gd-pointer"
            style={{
              left: `${pointer.x * 100}%`,
              top: `${pointer.y}px`,
              '--gd-peer-color': color,
            }}
          >
            <svg viewBox="0 0 16 18" width="18" height="20" className="gd-pointer__arrow">
              <path
                d="M1 1 L1 15.5 L4.9 11.8 L7.2 17 L10.2 15.7 L7.9 10.6 L13.2 10.4 Z"
                fill={color}
                stroke="#FFFFFF"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="gd-pointer__label"
              style={{ background: color, color: contrastInk(color) }}
            >
              {user.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
