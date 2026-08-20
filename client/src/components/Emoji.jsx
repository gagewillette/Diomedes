import { lookupEmoji, spriteStyle } from '../lib/emoji.js';

/**
 * One emoji drawn from the Apple sprite sheet.
 *
 * Anything we have artwork for is a sprite, so the glyph is identical on every
 * platform. Anything we do not — an older icon, or a sequence the sheet drops,
 * such as a skin-tone variant — falls back to the system font rather than
 * disappearing.
 */
export default function Emoji({ char, size = 16, className, style, ...rest }) {
  if (!char) return null;
  const entry = lookupEmoji(char);
  if (!entry) {
    return (
      <span
        className={className}
        role="img"
        aria-label={char}
        style={{ fontSize: `${size}px`, lineHeight: 1, ...style }}
        {...rest}
      >
        {char}
      </span>
    );
  }
  return (
    <span
      className={className}
      role="img"
      aria-label={entry.k.split(' ')[0] || entry.n}
      title={entry.n}
      style={{
        display: 'inline-block',
        flex: '0 0 auto',
        backgroundRepeat: 'no-repeat',
        ...spriteStyle(entry, size),
        ...style,
      }}
      {...rest}
    />
  );
}
