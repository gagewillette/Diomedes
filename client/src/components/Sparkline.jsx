import { useMantineTheme } from '@mantine/core';

/**
 * A dependency-free sparkline. The performance panel needs to show a shape over
 * time — is p95 drifting up? — and pulling a charting library in for one line
 * would cost more bundle than the whole feature.
 *
 * Gaps (buckets with no samples) break the line rather than being drawn as
 * zero, because "nobody used the app at 4am" is not "the app was instant".
 */
export default function Sparkline({ points, height = 44, color, label }) {
  const theme = useMantineTheme();
  const stroke = color || theme.colors.blue[5];
  const values = points.map((p) => (Number.isFinite(p) ? p : null));
  const real = values.filter((v) => v !== null);

  if (real.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', fontSize: 11, opacity: 0.5 }}>
        Not enough samples yet
      </div>
    );
  }

  const max = Math.max(...real);
  const min = Math.min(...real);
  const span = max - min || 1;
  const width = 100; // viewBox units; the SVG scales to its container
  const x = (i) => (values.length === 1 ? 0 : (i / (values.length - 1)) * width);
  const y = (v) => height - ((v - min) / span) * (height - 6) - 3;

  // Each run of consecutive non-null values becomes its own path segment.
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) segments.push(current);
      current = [];
    } else {
      current.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    }
  });
  if (current.length > 1) segments.push(current);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
      role="img"
      aria-label={label}
    >
      {segments.map((seg, i) => (
        <polyline
          key={i}
          points={seg.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
