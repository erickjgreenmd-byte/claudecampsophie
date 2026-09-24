// Spec P8/E4: schedules use the family's IANA zone and its daylight-saving rules, never server UTC or
// a fixed offset. These tests pin the documented DST resolution rules with real 2026 transitions.
import fc from 'fast-check';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { IANAZone } from 'luxon';
import {
  addCalendarDays,
  assertSchedulingZone,
  isSchedulingZone,
  isValidCalendarDate,
  isValidLocalTime,
  isValidWeekKey,
  isoWeekDates,
  localDateOf,
  localDateTimeToUtc,
  reviewWeekKey,
  weekKeyOfDate,
} from './index.ts';

const at = (iso: string): Date => new Date(iso);

/** Zones with DST, half-hour DST, midnight transitions, and both sides of the date line. */
const ZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Santiago',
  'America/Havana',
  'Europe/London',
  'Asia/Beirut',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Pacific/Chatham',
] as const;

const wallClock = (instant: Date, zone: string): string =>
  DateTime.fromJSDate(instant, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");

describe('localDateTimeToUtc: ordinary local times', () => {
  it('converts a New York afternoon using the offset in force on that date', () => {
    expect(localDateTimeToUtc('America/New_York', '2026-01-15', '16:00')).toEqual(
      at('2026-01-15T21:00:00Z'),
    );
    expect(localDateTimeToUtc('America/New_York', '2026-07-15', '16:00')).toEqual(
      at('2026-07-15T20:00:00Z'),
    );
  });

  it('handles both sides of the date line (Kiritimati +14, Pago Pago -11)', () => {
    expect(localDateTimeToUtc('Pacific/Kiritimati', '2026-10-01', '16:00')).toEqual(
      at('2026-10-01T02:00:00Z'),
    );
    expect(localDateTimeToUtc('Pacific/Pago_Pago', '2026-10-01', '16:00')).toEqual(
      at('2026-10-02T03:00:00Z'),
    );
  });
});

describe('localDateTimeToUtc: spring-forward gap moves to the first valid instant after the gap', () => {
  it('America/New_York 2026-03-08 02:30 (does not exist) resolves to 03:00 EDT', () => {
    expect(localDateTimeToUtc('America/New_York', '2026-03-08', '02:30')).toEqual(
      at('2026-03-08T07:00:00Z'),
    );
    expect(localDateTimeToUtc('America/New_York', '2026-03-08', '02:00')).toEqual(
      at('2026-03-08T07:00:00Z'),
    );
  });

  it('America/Los_Angeles 2026-03-08 02:30 resolves to 03:00 PDT', () => {
    expect(localDateTimeToUtc('America/Los_Angeles', '2026-03-08', '02:30')).toEqual(
      at('2026-03-08T10:00:00Z'),
    );
  });

  it('the minute just before the gap is unaffected', () => {
    expect(localDateTimeToUtc('America/New_York', '2026-03-08', '01:59')).toEqual(
      at('2026-03-08T06:59:00Z'),
    );
    expect(localDateTimeToUtc('America/New_York', '2026-03-08', '03:00')).toEqual(
      at('2026-03-08T07:00:00Z'),
    );
  });

  it('Australia/Lord_Howe 30-minute gap: 2026-10-04 02:15 resolves to 02:30 (+11:00)', () => {
    expect(localDateTimeToUtc('Australia/Lord_Howe', '2026-10-04', '02:15')).toEqual(
      at('2026-10-03T15:30:00Z'),
    );
  });

  it('a skipped local midnight (America/Santiago 2026-09-06) starts at 01:00', () => {
    expect(localDateTimeToUtc('America/Santiago', '2026-09-06', '00:00')).toEqual(
      at('2026-09-06T04:00:00Z'),
    );
  });
});

describe('localDateTimeToUtc: fall-back ambiguity resolves to the EARLIER occurrence', () => {
  it('America/New_York 2026-11-01 01:30 resolves to 01:30 EDT, not EST', () => {
    expect(localDateTimeToUtc('America/New_York', '2026-11-01', '01:30')).toEqual(
      at('2026-11-01T05:30:00Z'),
    );
  });

  it('America/Los_Angeles 2026-11-01 01:30 resolves to 01:30 PDT', () => {
    expect(localDateTimeToUtc('America/Los_Angeles', '2026-11-01', '01:30')).toEqual(
      at('2026-11-01T08:30:00Z'),
    );
  });

  it('Australia/Lord_Howe 30-minute overlap: 2026-04-05 01:45 resolves to +11:00', () => {
    expect(localDateTimeToUtc('Australia/Lord_Howe', '2026-04-05', '01:45')).toEqual(
      at('2026-04-04T14:45:00Z'),
    );
  });
});

describe('localDateTimeToUtc: input validation (programmer errors throw)', () => {
  it('throws on an invalid IANA zone', () => {
    expect(() => localDateTimeToUtc('Mars/Olympus_Mons', '2026-10-01', '16:00')).toThrow(
      RangeError,
    );
  });

  it('Decision: raw fixed-offset strings are rejected even where Intl would accept them', () => {
    expect(isSchedulingZone('+05:00')).toBe(false);
    expect(isSchedulingZone('-0800')).toBe(false);
    expect(() => localDateTimeToUtc('+05:00', '2026-10-01', '16:00')).toThrow(RangeError);
    expect(isSchedulingZone('America/New_York')).toBe(true);
    expect(isSchedulingZone('UTC')).toBe(true);
  });

  it('RV-scheduling-1: offsets are rejected in every sign spelling Intl accepts (incl. U+2212)', () => {
    // Premise: Intl (and so luxon) accepts the U+2212 MINUS SIGN spelling as a fixed offset.
    expect(IANAZone.isValidZone('\u221205:00')).toBe(true);
    for (const zone of ['\u221205:00', '\u22120500', '\u221205', '\u221200:00', '+00:00', '-05']) {
      expect(isSchedulingZone(zone)).toBe(false);
      expect(() => assertSchedulingZone(zone)).toThrow(RangeError);
      expect(() => localDateTimeToUtc(zone, '2026-07-02', '16:00')).toThrow(RangeError);
    }
    // Real IANA names, including legacy aliases and Etc/*, are unaffected.
    for (const zone of [...ZONES, 'Etc/UTC', 'Etc/GMT+5', 'EST5EDT', 'america/new_york']) {
      expect(isSchedulingZone(zone)).toBe(true);
      expect(assertSchedulingZone(zone)).toBe(zone);
    }
  });

  it('throws on impossible dates and times', () => {
    expect(() => localDateTimeToUtc('UTC', '2026-02-29', '16:00')).toThrow(RangeError);
    expect(() => localDateTimeToUtc('UTC', '2026-10-01', '24:00')).toThrow(RangeError);
    expect(() => localDateTimeToUtc('UTC', '2026-10-01', '4pm')).toThrow(RangeError);
    expect(() => localDateTimeToUtc('UTC', '2026-1-01', '16:00')).toThrow(RangeError);
  });

  it('validates HH:mm and YYYY-MM-DD strictly', () => {
    expect(isValidLocalTime('00:00')).toBe(true);
    expect(isValidLocalTime('23:59')).toBe(true);
    expect(isValidLocalTime('7:00')).toBe(false);
    expect(isValidLocalTime('16:00:00')).toBe(false);
    expect(isValidLocalTime(' 16:00')).toBe(false);
    expect(isValidCalendarDate('2028-02-29')).toBe(true);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(isValidCalendarDate('2026-04-31')).toBe(false);
  });
});

describe('localDateTimeToUtc: universal properties', () => {
  const zoneArb = fc.constantFrom(...ZONES);
  const instantArb = fc
    .integer({ min: Date.UTC(2020, 0, 1) / 60_000, max: Date.UTC(2032, 0, 1) / 60_000 })
    .map((minutes) => new Date(minutes * 60_000));

  it('an existing wall time maps back to itself, choosing the earliest occurrence', () => {
    fc.assert(
      fc.property(zoneArb, instantArb, (zone, instant) => {
        const local = DateTime.fromJSDate(instant, { zone });
        const resolved = localDateTimeToUtc(zone, local.toISODate()!, local.toFormat('HH:mm'));
        expect(wallClock(resolved, zone)).toBe(wallClock(instant, zone));
        expect(resolved.getTime()).toBeLessThanOrEqual(instant.getTime());
      }),
      { numRuns: 400 },
    );
  });

  it('any requested wall time resolves to itself or to the first instant after a gap', () => {
    const dateArb = fc
      .integer({ min: 0, max: 365 * 12 })
      .map((d) =>
        DateTime.fromObject({ year: 2020, month: 1, day: 1 }, { zone: 'UTC' })
          .plus({ days: d })
          .toISODate()!,
      );
    const timeArb = fc
      .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
      .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    fc.assert(
      fc.property(zoneArb, dateArb, timeArb, (zone, date, time) => {
        const resolved = localDateTimeToUtc(zone, date, time);
        const requested = `${date}T${time}`;
        const got = wallClock(resolved, zone);
        if (got !== requested) {
          // Gap: the resolved instant is after the requested wall time and the instant before it is
          // still before the requested wall time (so nothing earlier would have been valid).
          expect(got > requested).toBe(true);
          expect(wallClock(new Date(resolved.getTime() - 1), zone) < requested).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('ISO week keys in the family zone', () => {
  it('2026 has ISO week 53 (Mon 2026-12-28 .. Sun 2027-01-03)', () => {
    expect(reviewWeekKey(at('2027-01-01T12:00:00Z'), 'America/New_York')).toBe('2026-W53');
    expect(reviewWeekKey(at('2026-12-28T12:00:00Z'), 'America/New_York')).toBe('2026-W53');
    expect(reviewWeekKey(at('2027-01-04T12:00:00Z'), 'America/New_York')).toBe('2027-W01');
    expect(isValidWeekKey('2026-W53')).toBe(true);
    expect(isValidWeekKey('2027-W53')).toBe(false);
    expect(isValidWeekKey('2025-W53')).toBe(false);
    expect(isValidWeekKey('2026-W00')).toBe(false);
    expect(isValidWeekKey('2026-w10')).toBe(false);
    expect(isoWeekDates('2026-W53')).toEqual({ monday: '2026-12-28', sunday: '2027-01-03' });
  });

  it('the week key is computed in the family zone, not UTC (date line)', () => {
    const sundayNoonUtc = at('2026-10-04T12:00:00Z');
    expect(reviewWeekKey(sundayNoonUtc, 'Pacific/Kiritimati')).toBe('2026-W41'); // Mon 02:00 local
    expect(reviewWeekKey(sundayNoonUtc, 'Pacific/Pago_Pago')).toBe('2026-W40'); // Sun 01:00 local
    expect(reviewWeekKey(sundayNoonUtc, 'UTC')).toBe('2026-W40');
  });

  it('a New York Sunday evening is still the same ISO week although UTC is already Monday', () => {
    expect(reviewWeekKey(at('2026-10-05T02:00:00Z'), 'America/New_York')).toBe('2026-W40');
    expect(reviewWeekKey(at('2026-10-05T02:00:00Z'), 'UTC')).toBe('2026-W41');
  });

  it('throws on an invalid zone or instant', () => {
    expect(() => reviewWeekKey(at('2026-10-05T02:00:00Z'), 'Not/AZone')).toThrow(RangeError);
    expect(() => reviewWeekKey(new Date(Number.NaN), 'UTC')).toThrow(RangeError);
  });

  it('property: the local date of any instant lies inside the week its key names', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2032, 0, 1) }),
        (zone, ms) => {
          const instant = new Date(ms);
          const key = reviewWeekKey(instant, zone);
          const localDate = localDateOf(instant, zone);
          const { monday, sunday } = isoWeekDates(key);
          expect(monday <= localDate && localDate <= sunday).toBe(true);
          expect(weekKeyOfDate(localDate)).toBe(key);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('calendar-day arithmetic crosses month, year and leap-day boundaries', () => {
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addCalendarDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
