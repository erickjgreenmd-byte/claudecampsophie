import { useId } from 'react';
import { formatUsd } from '@pencillift/domain';
import { monthLabel } from './admin-ui.tsx';

/**
 * Net revenue by month as a small SVG column chart drawn to scale. One series (the month's net
 * across every channel) in the teal token, values labelled at the cap from the real cents, month
 * names under the baseline; a negative month (refunds above charges) hangs below the baseline.
 * The per-channel breakdown lives in the table next to it, so the chart never carries a
 * categorical palette (the brand token set has no colour-blind-safe categorical set).
 */

export interface RevenueBar {
  readonly month: string;
  readonly netCents: number;
}

const SLOT = 72;
const BAR = 24;
const RADIUS = 4;
const TOP = 28;
const BOTTOM = 40;
const HEIGHT = 220;
const LEFT = 8;

/** A whole-dollar label that never rounds up: exact under $10,000, else truncated to $12.3K. */
export function compactUsd(cents: number): string {
  const abs = Math.abs(cents);
  if (abs < 1_000_000) return formatUsd(cents);
  const thousands = Math.floor(abs / 10_000) / 10;
  return `${cents < 0 ? '-' : ''}$${thousands.toFixed(1)}K`;
}

function shortMonth(month: string): string {
  const label = monthLabel(month);
  const [name, year] = label.split(' ');
  return name && year ? `${name.slice(0, 3)} ${year.slice(2)}` : month;
}

/** A column with a 4px rounded data end and a square base on the baseline. */
function columnPath(x: number, baseline: number, tip: number): string {
  const r = Math.min(RADIUS, Math.abs(baseline - tip));
  if (tip <= baseline) {
    return [
      `M${x},${baseline}`,
      `V${tip + r}`,
      `Q${x},${tip} ${x + r},${tip}`,
      `H${x + BAR - r}`,
      `Q${x + BAR},${tip} ${x + BAR},${tip + r}`,
      `V${baseline}`,
      'Z',
    ].join(' ');
  }
  return [
    `M${x},${baseline}`,
    `V${tip - r}`,
    `Q${x},${tip} ${x + r},${tip}`,
    `H${x + BAR - r}`,
    `Q${x + BAR},${tip} ${x + BAR},${tip - r}`,
    `V${baseline}`,
    'Z',
  ].join(' ');
}

export function RevenueChart({ title, bars }: { title: string; bars: readonly RevenueBar[] }) {
  const titleId = useId();
  const width = LEFT * 2 + bars.length * SLOT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const maxPositive = Math.max(0, ...bars.map((b) => b.netCents));
  const maxNegative = Math.max(0, ...bars.map((b) => -b.netCents));
  const range = maxPositive + maxNegative;
  const scale = range === 0 ? 0 : plotHeight / range;
  const baseline = TOP + (range === 0 ? plotHeight : maxPositive * scale);
  return (
    <svg
      role="img"
      aria-labelledby={titleId}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      style={{ width: '100%', maxWidth: width, height: 'auto', display: 'block' }}
    >
      <title id={titleId}>{title}</title>
      <line
        x1={LEFT}
        x2={width - LEFT}
        y1={baseline}
        y2={baseline}
        stroke="var(--muted)"
        strokeWidth={1}
      />
      {bars.map((bar, index) => {
        const x = LEFT + index * SLOT + (SLOT - BAR) / 2;
        const tip = baseline - bar.netCents * scale;
        const positive = bar.netCents >= 0;
        const labelY = positive ? Math.min(tip, baseline) - 6 : tip + 14;
        const value = formatUsd(bar.netCents);
        return (
          <g key={bar.month}>
            <title>{`${monthLabel(bar.month)}: ${value} net`}</title>
            {bar.netCents !== 0 ? (
              <path d={columnPath(x, baseline, tip)} fill="var(--teal)" />
            ) : null}
            <text
              x={x + BAR / 2}
              y={labelY}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              fill="var(--navy)"
            >
              {compactUsd(bar.netCents)}
            </text>
            <text
              x={x + BAR / 2}
              y={HEIGHT - 14}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted)"
            >
              {shortMonth(bar.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
