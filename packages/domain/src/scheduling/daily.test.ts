// Spec P7 (daily extra credit every day incl. weekends at a parent-selected local time; pause,
// vacation and subject exclusions; no missed-day penalty or point expiry) and AC_LEARNING_03.
import fc from 'fast-check';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  DAILY_PRACTICE_POINTS_POLICY,
  DEFAULT_DAILY_PRACTICE_LOCAL_TIME,
  dailyPracticeState,
  dailyPracticeSubjects,
  dailySetKey,
  type DailyPracticeSettings,
} from './index.ts';

const at = (iso: string): Date => new Date(iso);
const NY = 'America/New_York';
const settings = (overrides: Partial<DailyPracticeSettings> = {}): DailyPracticeSettings => ({
  localTime: DEFAULT_DAILY_PRACTICE_LOCAL_TIME,
  paused: null,
  vacationDates: [],
  excludedSubjects: [],
  ...overrides,
});

function state(zone: string, now: Date, s: DailyPracticeSettings = settings()) {
  const r = dailyPracticeState({ zone, now, settings: s });
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe('AC_LEARNING_03 daily practice is available every local day, including weekends', () => {
  it('defaults to 15:30 local', () => {
    expect(DEFAULT_DAILY_PRACTICE_LOCAL_TIME).toBe('15:30');
  });

  it('Saturday: not yet before 15:30 local, available from 15:30 local', () => {
    // 2026-10-03 is a Saturday; 15:30 EDT = 19:30Z.
    expect(state(NY, at('2026-10-03T19:29:00Z'))).toMatchObject({
      localDate: '2026-10-03',
      available: false,
      reason: 'not_yet_released',
      releaseAt: at('2026-10-03T19:30:00Z'),
    });
    expect(state(NY, at('2026-10-03T19:30:00Z'))).toMatchObject({
      localDate: '2026-10-03',
      available: true,
      reason: 'available',
    });
  });

  it('Sunday is available after release, until local midnight', () => {
    expect(state(NY, at('2026-10-05T03:59:00Z'))).toMatchObject({
      localDate: '2026-10-04',
      available: true,
      reason: 'available',
      releaseAt: at('2026-10-04T19:30:00Z'),
    });
    // Local midnight starts Monday, whose set is not released until 15:30.
    expect(state(NY, at('2026-10-05T04:00:00Z'))).toMatchObject({
      localDate: '2026-10-05',
      available: false,
      reason: 'not_yet_released',
    });
  });

  it('property: at or after the local release time the set is available on every weekday', () => {
    const zones = [NY, 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'];
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        (zone, ms) => {
          const now = new Date(ms);
          const s = state(zone, now);
          expect(s.localDate).toBe(DateTime.fromJSDate(now, { zone }).toISODate());
          expect(s.available).toBe(now.getTime() >= s.releaseAt.getTime());
          expect(s.reason).toBe(s.available ? 'available' : 'not_yet_released');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('uses the family local date across the date line', () => {
    const now = at('2026-10-01T02:00:00Z');
    expect(state('Pacific/Kiritimati', now)).toMatchObject({
      localDate: '2026-10-01',
      available: true,
    });
    expect(state('Pacific/Pago_Pago', now)).toMatchObject({
      localDate: '2026-09-30',
      available: false,
      releaseAt: at('2026-10-01T02:30:00Z'),
    });
  });

  it('follows DST: 15:30 local is 20:30Z on Saturday Mar 7 and 19:30Z on Sunday Mar 8 2026', () => {
    expect(state(NY, at('2026-03-07T21:00:00Z')).releaseAt).toEqual(at('2026-03-07T20:30:00Z'));
    expect(state(NY, at('2026-03-08T21:00:00Z')).releaseAt).toEqual(at('2026-03-08T19:30:00Z'));
  });

  it('a parent time inside the spring-forward gap releases at the first valid instant', () => {
    const s = state(NY, at('2026-03-08T12:00:00Z'), settings({ localTime: '02:30' }));
    expect(s.releaseAt).toEqual(at('2026-03-08T07:00:00Z'));
    expect(s.available).toBe(true);
  });
});

describe('AC_LEARNING_03 pause and vacation without point loss', () => {
  it('a pause covers its from..to local dates inclusive', () => {
    const paused = settings({ paused: { from: '2026-10-01', to: '2026-10-04' } });
    expect(state(NY, at('2026-10-01T20:00:00Z'), paused)).toMatchObject({
      available: false,
      reason: 'paused',
    });
    expect(state(NY, at('2026-10-04T20:00:00Z'), paused)).toMatchObject({
      available: false,
      reason: 'paused',
    });
    expect(state(NY, at('2026-10-05T20:00:00Z'), paused)).toMatchObject({
      available: true,
      reason: 'available',
    });
    expect(state(NY, at('2026-09-30T20:00:00Z'), paused)).toMatchObject({ available: true });
  });

  it('a vacation date suppresses only that local date', () => {
    const vac = settings({ vacationDates: ['2026-10-03'] });
    expect(state(NY, at('2026-10-03T20:00:00Z'), vac)).toMatchObject({
      available: false,
      reason: 'vacation',
    });
    expect(state(NY, at('2026-10-04T20:00:00Z'), vac)).toMatchObject({
      available: true,
      reason: 'available',
    });
  });

  it('pause and vacation never expire earned points or penalize missed days', () => {
    expect(DAILY_PRACTICE_POINTS_POLICY).toEqual({
      expireEarnedPoints: false,
      penalizeMissedDays: false,
    });
    const paused = settings({ paused: { from: '2026-10-01', to: '2026-10-31' } });
    expect(state(NY, at('2026-10-10T20:00:00Z'), paused).pointsPolicy).toEqual(
      DAILY_PRACTICE_POINTS_POLICY,
    );
  });

  it('rejects malformed settings', () => {
    const code = (s: DailyPracticeSettings, zone = NY, now = at('2026-10-10T20:00:00Z')) => {
      const r = dailyPracticeState({ zone, now, settings: s });
      return r.ok ? 'OK' : r.error.code;
    };
    expect(code(settings())).toBe('OK');
    expect(code(settings(), 'Etc/Nowhere')).toBe('INVALID_TIME_ZONE');
    expect(code(settings(), NY, new Date(Number.NaN))).toBe('INVALID_INSTANT');
    expect(code(settings({ localTime: '3:30' }))).toBe('INVALID_LOCAL_TIME');
    expect(code(settings({ paused: { from: '2026-10-05', to: '2026-10-01' } }))).toBe(
      'INVALID_DATE_RANGE',
    );
    expect(code(settings({ paused: { from: '2026-10-01', to: '2026-10-32' } }))).toBe(
      'INVALID_CALENDAR_DATE',
    );
    expect(code(settings({ vacationDates: ['10/03/2026'] }))).toBe('INVALID_CALENDAR_DATE');
    expect(code(settings({ excludedSubjects: [' '] }))).toBe('INVALID_SUBJECT');
  });
});

describe('P7 subject exclusions and daily set identity', () => {
  it('excluded subjects are removed from the enabled list, preserving order', () => {
    const r = dailyPracticeSubjects(['math', 'reading', 'science', 'spelling'], ['science']);
    expect(r).toEqual({ ok: true, value: ['math', 'reading', 'spelling'] });
  });

  it('excluding every subject leaves nothing to practise', () => {
    expect(dailyPracticeSubjects(['math'], ['math'])).toEqual({ ok: true, value: [] });
  });

  it('rejects malformed subject names', () => {
    const r = dailyPracticeSubjects(['math', ''], []);
    expect(r.ok ? null : r.error.code).toBe('INVALID_SUBJECT');
  });

  it('dailySetKey is stable per child and local date so retries reuse the same saved set', () => {
    const k = dailySetKey('child-riley', '2026-10-03');
    expect(dailySetKey('child-riley', '2026-10-03')).toBe(k);
    expect(dailySetKey('child-riley', '2026-10-04')).not.toBe(k);
    expect(dailySetKey('child-sam', '2026-10-03')).not.toBe(k);
    expect(() => dailySetKey('child-riley', '2026-10-32')).toThrow(RangeError);
    expect(() => dailySetKey('', '2026-10-03')).toThrow(RangeError);
  });
});
