// Spec P14: default notifications go to the parent's opted-in devices; child reminders require
// parent permission; respect quiet hours, local time and opt-outs. AC_LEARNING_03 (quiet hours).
import fc from 'fast-check';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { scheduleNotification, type NotificationRequest } from './index.ts';

const at = (iso: string): Date => new Date(iso);
const NY = 'America/New_York';

const request = (overrides: Partial<NotificationRequest> = {}): NotificationRequest => ({
  desiredAt: at('2026-10-01T20:00:00Z'),
  zone: NY,
  quietHours: null,
  audience: 'parent',
  childRemindersPermitted: false,
  optedIn: true,
  ...overrides,
});

function decide(overrides: Partial<NotificationRequest> = {}) {
  const r = scheduleNotification(request(overrides));
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe('P14 opt-outs and child reminder permission', () => {
  it('an opted-in parent device is sent at the desired time when there are no quiet hours', () => {
    expect(decide()).toEqual({ send: true, sendAt: at('2026-10-01T20:00:00Z') });
  });

  it('opted-out recipients receive nothing', () => {
    expect(decide({ optedIn: false })).toEqual({ send: false, reason: 'opted_out' });
    expect(decide({ optedIn: false, audience: 'child', childRemindersPermitted: true })).toEqual({
      send: false,
      reason: 'opted_out',
    });
  });

  it('child reminders are sent only with parent permission', () => {
    expect(decide({ audience: 'child', childRemindersPermitted: false })).toEqual({
      send: false,
      reason: 'child_reminders_not_permitted',
    });
    expect(decide({ audience: 'child', childRemindersPermitted: true })).toEqual({
      send: true,
      sendAt: at('2026-10-01T20:00:00Z'),
    });
  });

  it('RV-scheduling-2: out-of-domain audience or flags (runtime data) are errors, never sends', () => {
    const code = (overrides: Record<string, unknown>) => {
      // Values outside the declared types, as they could arrive from storage or JSON.
      const r = scheduleNotification({ ...request(), ...overrides });
      return r.ok ? r.value : r.error.code;
    };
    for (const audience of ['Child', 'CHILD', 'children', '', null, undefined]) {
      expect(code({ audience, childRemindersPermitted: true })).toBe('INVALID_AUDIENCE');
    }
    for (const flag of ['false', 'true', 0, 1, null, undefined]) {
      expect(code({ audience: 'child', childRemindersPermitted: flag })).toBe(
        'INVALID_NOTIFICATION_FLAG',
      );
      expect(code({ optedIn: flag })).toBe('INVALID_NOTIFICATION_FLAG');
    }
  });
});

describe('P14 quiet hours in the family zone', () => {
  const overnight = { start: '21:00', end: '07:00' };

  it('outside quiet hours sends immediately', () => {
    // 20:59 EDT
    expect(decide({ desiredAt: at('2026-10-02T00:59:00Z'), quietHours: overnight })).toEqual({
      send: true,
      sendAt: at('2026-10-02T00:59:00Z'),
    });
  });

  it('quiet hours spanning midnight: late evening shifts to 07:00 the next local morning', () => {
    // 22:00 EDT Oct 1 -> 07:00 EDT Oct 2
    expect(decide({ desiredAt: at('2026-10-02T02:00:00Z'), quietHours: overnight })).toEqual({
      send: true,
      sendAt: at('2026-10-02T11:00:00Z'),
    });
  });

  it('quiet hours spanning midnight: early morning shifts to 07:00 the same local day', () => {
    // 06:30 EDT Oct 2 -> 07:00 EDT Oct 2
    expect(decide({ desiredAt: at('2026-10-02T10:30:00Z'), quietHours: overnight })).toEqual({
      send: true,
      sendAt: at('2026-10-02T11:00:00Z'),
    });
  });

  it('quiet start is inclusive and quiet end is exclusive', () => {
    expect(decide({ desiredAt: at('2026-10-02T01:00:00Z'), quietHours: overnight })).toEqual({
      send: true,
      sendAt: at('2026-10-02T11:00:00Z'),
    });
    expect(decide({ desiredAt: at('2026-10-02T11:00:00Z'), quietHours: overnight })).toEqual({
      send: true,
      sendAt: at('2026-10-02T11:00:00Z'),
    });
  });

  it('same-day quiet hours (13:00-15:00) shift to 15:00', () => {
    expect(
      decide({
        desiredAt: at('2026-10-01T17:30:00Z'),
        quietHours: { start: '13:00', end: '15:00' },
      }),
    ).toEqual({ send: true, sendAt: at('2026-10-01T19:00:00Z') });
  });

  it('child reminders also respect quiet hours', () => {
    expect(
      decide({
        audience: 'child',
        childRemindersPermitted: true,
        desiredAt: at('2026-10-02T02:00:00Z'),
        quietHours: overnight,
      }),
    ).toEqual({ send: true, sendAt: at('2026-10-02T11:00:00Z') });
  });

  it('DST: overnight quiet hours ending on spring-forward morning end at 07:00 EDT', () => {
    // 23:00 EST Mar 7 -> 07:00 EDT Mar 8 (11:00Z, not 12:00Z)
    expect(decide({ desiredAt: at('2026-03-08T04:00:00Z'), quietHours: overnight })).toEqual({
      send: true,
      sendAt: at('2026-03-08T11:00:00Z'),
    });
  });

  it('DST: a quiet end inside the spring-forward gap sends at the first valid instant after it', () => {
    // quiet 23:00-02:30; 01:00 EST Mar 8 -> 02:30 does not exist -> 03:00 EDT = 07:00Z
    expect(
      decide({
        desiredAt: at('2026-03-08T06:00:00Z'),
        quietHours: { start: '23:00', end: '02:30' },
      }),
    ).toEqual({ send: true, sendAt: at('2026-03-08T07:00:00Z') });
  });

  it('DST: during the repeated fall-back hour the send never moves backwards in time', () => {
    const quiet = { start: '00:00', end: '01:30' };
    // 01:10 EDT (first pass) -> 01:30 EDT
    expect(decide({ desiredAt: at('2026-11-01T05:10:00Z'), quietHours: quiet })).toEqual({
      send: true,
      sendAt: at('2026-11-01T05:30:00Z'),
    });
    // 01:10 EST (second pass, wall clock is back in quiet hours) -> 01:30 EST, not the earlier EDT
    expect(decide({ desiredAt: at('2026-11-01T06:10:00Z'), quietHours: quiet })).toEqual({
      send: true,
      sendAt: at('2026-11-01T06:30:00Z'),
    });
  });

  it('Decision: identical start and end quiet times are rejected as ambiguous', () => {
    const r = scheduleNotification(request({ quietHours: { start: '22:00', end: '22:00' } }));
    expect(r.ok ? null : r.error.code).toBe('INVALID_QUIET_HOURS');
  });

  it('rejects malformed inputs', () => {
    const code = (overrides: Partial<NotificationRequest>) => {
      const r = scheduleNotification(request(overrides));
      return r.ok ? 'OK' : r.error.code;
    };
    expect(code({ zone: 'Moon/Base' })).toBe('INVALID_TIME_ZONE');
    expect(code({ desiredAt: new Date(Number.NaN) })).toBe('INVALID_INSTANT');
    expect(code({ quietHours: { start: '9pm', end: '07:00' } })).toBe('INVALID_QUIET_HOURS');
  });

  it('property: sendAt is never earlier than desired, never in quiet hours, and is the first allowed instant', () => {
    const zones = [
      NY,
      'America/Los_Angeles',
      'Australia/Lord_Howe',
      'Pacific/Kiritimati',
      'Europe/London',
    ];
    const hhmm = fc
      .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
      .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    const quietArb = fc.tuple(hhmm, hhmm).filter(([s, e]) => s !== e);
    const isQuiet = (instant: Date, zone: string, start: string, end: string): boolean => {
      const local = DateTime.fromJSDate(instant, { zone }).toFormat('HH:mm:ss.SSS');
      return start < end ? local >= start && local < end : local >= start || local < end;
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        quietArb,
        (zone, ms, [start, end]) => {
          const desiredAt = new Date(ms);
          const d = decide({ zone, desiredAt, quietHours: { start, end } });
          if (!d.send) throw new Error('expected a send');
          expect(d.sendAt.getTime()).toBeGreaterThanOrEqual(ms);
          expect(isQuiet(d.sendAt, zone, start, end)).toBe(false);
          if (!isQuiet(desiredAt, zone, start, end)) expect(d.sendAt).toEqual(desiredAt);
          else expect(isQuiet(new Date(d.sendAt.getTime() - 1), zone, start, end)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
