import { describe, expect, it } from 'vitest';
import { divideRoundHalfUp, formatUsd } from './money.ts';
import { addMonths, calendarMonthOf, monthBoundsUtc } from './time.ts';
import { randomInt } from './random.ts';

describe('money helpers', () => {
  it('rounds half up exactly like Decimal ROUND_HALF_UP', () => {
    // 25% off $49.98: 4998 * 75 / 100 = 3748.5 -> 3749 (finance model shows $37.49)
    expect(divideRoundHalfUp(4998 * 75, 100)).toBe(3749);
    // 75% off $49.98: 4998 * 25 / 100 = 1249.5 -> 1250 ($12.50)
    expect(divideRoundHalfUp(4998 * 25, 100)).toBe(1250);
    // 5% off $49.98: 4748.1 -> 4748 ($47.48)
    expect(divideRoundHalfUp(4998 * 95, 100)).toBe(4748);
  });

  it('formats cents for display', () => {
    expect(formatUsd(4998)).toBe('$49.98');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-100)).toBe('-$1.00');
  });
});

describe('calendar months', () => {
  it('uses the zone, not UTC, to pick the month', () => {
    const instant = new Date('2026-10-01T03:00:00Z');
    expect(calendarMonthOf(instant, 'UTC')).toBe('2026-10');
    expect(calendarMonthOf(instant, 'America/Los_Angeles')).toBe('2026-09');
  });

  it('adds months across year boundaries', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('computes DST-correct month bounds', () => {
    const { start, end } = monthBoundsUtc('2026-11', 'America/New_York');
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });
});

describe('randomInt', () => {
  it('rejects biased bytes via rejection sampling', () => {
    const bytes = [255, 254, 7];
    const source = () => new Uint8Array([bytes.shift() ?? 0]);
    // limit for 10 buckets is 250: 255 and 254 rejected, 7 accepted
    expect(randomInt(10, source)).toBe(7);
  });
});
