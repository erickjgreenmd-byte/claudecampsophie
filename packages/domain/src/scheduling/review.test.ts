// Spec P8 (Thursday review), E4 (Scheduling), AC_LEARNING_08 (IANA/DST, no duplicate jobs on
// retries) and AC_LEARNING_09 (late uploads -> optional versioned top-ups, nothing overwritten).
import fc from 'fast-check';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MINIMUM_LEAD_MS,
  DEFAULT_REVIEW_LOCAL_TIME,
  DEFAULT_REVIEW_WEEKDAY,
  DEFAULT_SAFETY_MARGIN_MS,
  MAX_REVIEW_LEAD_MS,
  assessReviewLateness,
  defaultReviewSchedule,
  planReviewJob,
  parseReviewIdempotencyKey,
  planTopUp,
  reviewIdempotencyKey,
  reviewReleases,
  reviewWeekKey,
  topUpIdempotencyKey,
  validateReviewSchedule,
  type ReviewRelease,
  type ReviewSchedule,
} from './index.ts';

const at = (iso: string): Date => new Date(iso);
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NY = 'America/New_York';

function releasesOk(input: Parameters<typeof reviewReleases>[0]): readonly ReviewRelease[] {
  const result = reviewReleases(input);
  if (!result.ok) throw new Error(`unexpected error ${result.error.code}`);
  return result.value;
}

function releaseAtOf(releases: readonly ReviewRelease[], subject: string): Date | null {
  const found = releases.find((r) => r.subject === subject);
  if (!found) throw new Error(`no release for ${subject}`);
  return found.releaseAt;
}

describe('P8 default review schedule', () => {
  it('defaults to Thursday (ISO weekday 4) at 16:00, schedule version 1', () => {
    expect(DEFAULT_REVIEW_WEEKDAY).toBe(4);
    expect(DEFAULT_REVIEW_LOCAL_TIME).toBe('16:00');
    expect(defaultReviewSchedule()).toEqual({ weekday: 4, localTime: '16:00', scheduleVersion: 1 });
  });

  it('AC_LEARNING_08: Thursday 16:00 local holds across the March 2026 DST week in New York', () => {
    const schedule = defaultReviewSchedule();
    // ISO week 10 (Mar 2-8) is still EST; DST starts Sunday Mar 8; week 11 is EDT.
    const w10 = releasesOk({ schedule, zone: NY, subjects: ['math'], weekKey: '2026-W10' });
    const w11 = releasesOk({ schedule, zone: NY, subjects: ['math'], weekKey: '2026-W11' });
    expect(releaseAtOf(w10, 'math')).toEqual(at('2026-03-05T21:00:00Z'));
    expect(releaseAtOf(w11, 'math')).toEqual(at('2026-03-12T20:00:00Z'));
  });

  it('AC_LEARNING_08: Thursday 16:00 local holds across the November 2026 fall-back week', () => {
    const schedule = defaultReviewSchedule();
    const w44 = releasesOk({ schedule, zone: NY, subjects: ['math'], weekKey: '2026-W44' });
    const w45 = releasesOk({ schedule, zone: NY, subjects: ['math'], weekKey: '2026-W45' });
    expect(releaseAtOf(w44, 'math')).toEqual(at('2026-10-29T20:00:00Z'));
    expect(releaseAtOf(w45, 'math')).toEqual(at('2026-11-05T21:00:00Z'));
  });

  it('AC_LEARNING_08: Los Angeles Thursday 16:00 across both 2026 transitions', () => {
    const schedule = defaultReviewSchedule();
    const zone = 'America/Los_Angeles';
    const get = (weekKey: string) =>
      releaseAtOf(releasesOk({ schedule, zone, subjects: ['reading'], weekKey }), 'reading');
    expect(get('2026-W10')).toEqual(at('2026-03-06T00:00:00Z'));
    expect(get('2026-W11')).toEqual(at('2026-03-12T23:00:00Z'));
    expect(get('2026-W44')).toEqual(at('2026-10-29T23:00:00Z'));
    expect(get('2026-W45')).toEqual(at('2026-11-06T00:00:00Z'));
  });

  it('AC_LEARNING_08: Lord Howe 30-minute DST shifts the UTC release by 30 minutes', () => {
    const schedule = defaultReviewSchedule();
    const zone = 'Australia/Lord_Howe';
    const get = (weekKey: string) =>
      releaseAtOf(releasesOk({ schedule, zone, subjects: ['science'], weekKey }), 'science');
    expect(get('2026-W40')).toEqual(at('2026-10-01T05:30:00Z')); // +10:30
    expect(get('2026-W41')).toEqual(at('2026-10-08T05:00:00Z')); // +11:00
  });

  it('AC_LEARNING_08: date-line zones release on their own local Thursday', () => {
    const schedule = defaultReviewSchedule();
    const kiri = releasesOk({
      schedule,
      zone: 'Pacific/Kiritimati',
      subjects: ['math'],
      weekKey: '2026-W40',
    });
    const pago = releasesOk({
      schedule,
      zone: 'Pacific/Pago_Pago',
      subjects: ['math'],
      weekKey: '2026-W40',
    });
    expect(releaseAtOf(kiri, 'math')).toEqual(at('2026-10-01T02:00:00Z'));
    expect(releaseAtOf(pago, 'math')).toEqual(at('2026-10-02T03:00:00Z'));
  });

  it('ISO week 53 of 2026 has a Thursday review on 2026-12-31', () => {
    const r = releasesOk({
      schedule: defaultReviewSchedule(),
      zone: NY,
      subjects: ['math'],
      weekKey: '2026-W53',
    });
    expect(releaseAtOf(r, 'math')).toEqual(at('2026-12-31T21:00:00Z'));
    expect(r[0]?.localDate).toBe('2026-12-31');
  });

  it('P8: the parent can move the review day and time', () => {
    const schedule: ReviewSchedule = { weekday: 3, localTime: '18:30', scheduleVersion: 2 };
    const r = releasesOk({ schedule, zone: NY, subjects: ['math'], weekKey: '2026-W40' });
    expect(releaseAtOf(r, 'math')).toEqual(at('2026-09-30T22:30:00Z'));
    expect(r[0]?.reason).toBe('default_schedule');
  });

  it('property: every default release is on the configured local weekday/time inside its week', () => {
    const zones = [NY, 'America/Los_Angeles', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'UTC'];
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 2024, max: 2030 }),
        fc.integer({ min: 1, max: 52 }),
        (zone, weekday, h, m, year, week) => {
          const localTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          const weekKey = `${year}-W${String(week).padStart(2, '0')}`;
          const [release] = releasesOk({
            schedule: { weekday, localTime, scheduleVersion: 1 },
            zone,
            subjects: ['math'],
            weekKey,
          });
          const local = DateTime.fromJSDate(release!.releaseAt!, { zone });
          expect(local.weekday).toBe(weekday);
          expect(reviewWeekKey(release!.releaseAt!, zone)).toBe(weekKey);
          // Equal unless the time fell in a DST gap (then it is moved later, never earlier).
          expect(local.toFormat('HH:mm') >= localTime).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('P8 subject test-date overrides and skipped weeks', () => {
  const schedule: ReviewSchedule = {
    weekday: 4,
    localTime: '16:00',
    scheduleVersion: 3,
    subjectOverrides: {
      math: { testDates: ['2026-10-02'] }, // Friday of 2026-W40
      reading: { testDates: ['2026-09-30'] }, // Wednesday of 2026-W40
      science: { skipWeeks: ['2026-W40'] },
      spelling: { testDates: ['2026-10-05'] }, // Monday of 2026-W41
      writing: { testDates: ['2026-10-01', '2026-09-29'] }, // Thu and Tue of W40
    },
  };
  const subjects = ['math', 'reading', 'science', 'social_studies', 'writing'];
  const w40 = releasesOk({ schedule, zone: NY, subjects, weekKey: '2026-W40' });

  it('a Friday test releases on Thursday at the configured local time', () => {
    expect(w40.find((r) => r.subject === 'math')).toMatchObject({
      releaseAt: at('2026-10-01T20:00:00Z'),
      localDate: '2026-10-01',
      reason: 'test_date_eve',
      testDate: '2026-10-02',
    });
  });

  it('a Wednesday test releases on Tuesday', () => {
    expect(w40.find((r) => r.subject === 'reading')).toMatchObject({
      releaseAt: at('2026-09-29T20:00:00Z'),
      localDate: '2026-09-29',
      reason: 'test_date_eve',
    });
  });

  it('Decision: with two test dates in one week, the review is ready before the earliest one', () => {
    expect(w40.find((r) => r.subject === 'writing')).toMatchObject({
      localDate: '2026-09-28',
      testDate: '2026-09-29',
    });
  });

  it('a skipped week produces no release for that subject only', () => {
    expect(w40.find((r) => r.subject === 'science')).toMatchObject({
      releaseAt: null,
      localDate: null,
      reason: 'skipped_week',
    });
    expect(w40.find((r) => r.subject === 'social_studies')).toMatchObject({
      releaseAt: at('2026-10-01T20:00:00Z'),
      reason: 'default_schedule',
      testDate: null,
    });
  });

  it('a test date outside the ISO week does not affect that week', () => {
    // spelling's Monday test belongs to W41, so W40 uses the default Thursday.
    const r = releasesOk({ schedule, zone: NY, subjects: ['spelling'], weekKey: '2026-W40' });
    expect(r[0]).toMatchObject({ reason: 'default_schedule', localDate: '2026-10-01' });
  });

  it('a Monday test releases on the Sunday before, keyed to the test week', () => {
    const r = releasesOk({ schedule, zone: NY, subjects: ['spelling'], weekKey: '2026-W41' });
    expect(r[0]).toMatchObject({
      weekKey: '2026-W41',
      localDate: '2026-10-04',
      releaseAt: at('2026-10-04T20:00:00Z'),
      reason: 'test_date_eve',
    });
  });

  it('P8: a Friday test-date change reschedules only the corresponding subject', () => {
    const moved: ReviewSchedule = {
      ...schedule,
      scheduleVersion: 4,
      subjectOverrides: { ...schedule.subjectOverrides, math: { testDates: ['2026-09-30'] } },
    };
    const after = releasesOk({ schedule: moved, zone: NY, subjects, weekKey: '2026-W40' });
    expect(releaseAtOf(after, 'math')).toEqual(at('2026-09-29T20:00:00Z'));
    for (const subject of subjects.filter((s) => s !== 'math')) {
      expect(releaseAtOf(after, subject)).toEqual(releaseAtOf(w40, subject));
    }
  });

  it('Decision: an explicit skipped week wins over a test date, and the conflict is reported', () => {
    const conflicting: ReviewSchedule = {
      ...schedule,
      subjectOverrides: { math: { testDates: ['2026-10-02'], skipWeeks: ['2026-W40'] } },
    };
    const r = releasesOk({
      schedule: conflicting,
      zone: NY,
      subjects: ['math'],
      weekKey: '2026-W40',
    });
    expect(r[0]).toMatchObject({ releaseAt: null, reason: 'skipped_week', testDate: '2026-10-02' });
  });

  it('subject names are looked up as own keys only (no prototype lookups)', () => {
    const r = releasesOk({
      schedule: { ...schedule, subjectOverrides: {} },
      zone: NY,
      subjects: ['constructor', 'toString'],
      weekKey: '2026-W40',
    });
    expect(r.map((x) => x.reason)).toEqual(['default_schedule', 'default_schedule']);
  });
});

describe('P8 review schedule validation (parent-configured values are untrusted)', () => {
  const base = defaultReviewSchedule();
  const code = (input: Parameters<typeof reviewReleases>[0]) => {
    const result = reviewReleases(input);
    return result.ok ? 'OK' : result.error.code;
  };

  it('rejects invalid zones, weekdays, times, versions, week keys and subjects', () => {
    const ok = { schedule: base, zone: NY, subjects: ['math'], weekKey: '2026-W40' };
    expect(code(ok)).toBe('OK');
    expect(code({ ...ok, zone: 'Nowhere/Land' })).toBe('INVALID_TIME_ZONE');
    expect(code({ ...ok, zone: '-05:00' })).toBe('INVALID_TIME_ZONE');
    expect(code({ ...ok, schedule: { ...base, weekday: 0 } })).toBe('INVALID_WEEKDAY');
    expect(code({ ...ok, schedule: { ...base, weekday: 4.5 } })).toBe('INVALID_WEEKDAY');
    expect(code({ ...ok, schedule: { ...base, localTime: '25:00' } })).toBe('INVALID_LOCAL_TIME');
    expect(code({ ...ok, schedule: { ...base, scheduleVersion: 0 } })).toBe(
      'INVALID_SCHEDULE_VERSION',
    );
    expect(code({ ...ok, weekKey: '2027-W53' })).toBe('INVALID_WEEK_KEY');
    expect(code({ ...ok, subjects: [''] })).toBe('INVALID_SUBJECT');
    expect(code({ ...ok, subjects: ['math', 'math'] })).toBe('DUPLICATE_SUBJECT');
    expect(
      code({
        ...ok,
        schedule: { ...base, subjectOverrides: { math: { testDates: ['2026-02-30'] } } },
      }),
    ).toBe('INVALID_CALENDAR_DATE');
    expect(
      code({
        ...ok,
        schedule: { ...base, subjectOverrides: { math: { skipWeeks: ['2026-40'] } } },
      }),
    ).toBe('INVALID_WEEK_KEY');
  });

  it('validateReviewSchedule accepts the defaults and reports the first problem', () => {
    expect(validateReviewSchedule(base).ok).toBe(true);
    const bad = validateReviewSchedule({ ...base, localTime: '4pm' });
    expect(bad.ok ? null : bad.error.code).toBe('INVALID_LOCAL_TIME');
  });

  it('an empty subject list yields no releases', () => {
    expect(releasesOk({ schedule: base, zone: NY, subjects: [], weekKey: '2026-W40' })).toEqual([]);
  });
});

describe('AC_LEARNING_08 idempotency key (child, subject, review_week, schedule_version)', () => {
  const child = '5b8f7a52-6a3c-4b61-9a8e-0d0c1f2e3a4b';

  it('is stable for worker retries and differs when any component changes', () => {
    const k = reviewIdempotencyKey(child, 'math', '2026-W40', 3);
    expect(reviewIdempotencyKey(child, 'math', '2026-W40', 3)).toBe(k);
    expect(reviewIdempotencyKey(child, 'reading', '2026-W40', 3)).not.toBe(k);
    expect(reviewIdempotencyKey(child, 'math', '2026-W41', 3)).not.toBe(k);
    expect(reviewIdempotencyKey(child, 'math', '2026-W40', 4)).not.toBe(k);
  });

  it('property: distinct tuples never collide even when components contain separators', () => {
    const idArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0);
    const printable = (s: string) =>
      [...s].every((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '\u007f');
    const piece = idArb.filter(printable);
    const tuple = fc.tuple(
      piece,
      piece,
      fc.constantFrom('2026-W40', '2026-W53'),
      fc.integer({ min: 1, max: 5 }),
    );
    fc.assert(
      fc.property(tuple, tuple, (a, b) => {
        const ka = reviewIdempotencyKey(...a);
        const kb = reviewIdempotencyKey(...b);
        const same = a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
        expect(ka === kb).toBe(same);
      }),
      { numRuns: 500 },
    );
    expect(reviewIdempotencyKey('a:b', 'c', '2026-W40', 1)).not.toBe(
      reviewIdempotencyKey('a', 'b:c', '2026-W40', 1),
    );
  });

  it('top-up keys extend the base key with the review version', () => {
    const base = reviewIdempotencyKey(child, 'math', '2026-W40', 3);
    expect(topUpIdempotencyKey(base, 2)).toBe(topUpIdempotencyKey(base, 2));
    expect(topUpIdempotencyKey(base, 2)).not.toBe(topUpIdempotencyKey(base, 3));
    expect(topUpIdempotencyKey(base, 2).startsWith(base)).toBe(true);
    expect(() => topUpIdempotencyKey(base, 1)).toThrow(RangeError);
  });

  it('RV-scheduling-3: base keys parse back to their tuple; anything non-canonical is rejected', () => {
    const tuple = ['sam:%a/b \u00e9', 'social studies', '2026-W53', 12] as const;
    const key = reviewIdempotencyKey(...tuple);
    expect(parseReviewIdempotencyKey(key)).toEqual({
      childId: tuple[0],
      subject: tuple[1],
      weekKey: tuple[2],
      scheduleVersion: tuple[3],
    });
    const base = reviewIdempotencyKey(child, 'math', '2026-W40', 3);
    for (const bad of [
      topUpIdempotencyKey(base, 2),
      'review:',
      'review::v2',
      'Review:a:b:2026-W40:s1',
      'review:a:b:2026-W40:s01',
      'review:a:b:2026-W40:s0',
      'review:a:b:2026-W54:s1',
      'review:%41:b:2026-W40:s1',
      'review:a%3:b:2026-W40:s1',
      'review:%ED%A0%80:b:2026-W40:s1',
      'review:a:b:2026-W40:s1:',
    ]) {
      expect(parseReviewIdempotencyKey(bad)).toBeNull();
      expect(() => topUpIdempotencyKey(bad, 3)).toThrow(RangeError);
    }
  });

  it('rejects malformed components (programmer error)', () => {
    expect(() => reviewIdempotencyKey('', 'math', '2026-W40', 1)).toThrow(RangeError);
    expect(() => reviewIdempotencyKey(child, 'math\n', '2026-W40', 1)).toThrow(RangeError);
    expect(() => reviewIdempotencyKey(child, 'math', '2026-W54', 1)).toThrow(RangeError);
    expect(() => reviewIdempotencyKey(child, 'math', '2026-W40', 1.5)).toThrow(RangeError);
  });
});

describe('E4 review job lead time and evidence cutoff', () => {
  const releaseAt = at('2026-10-01T20:00:00Z');
  const plan = (input: Omit<Parameters<typeof planReviewJob>[0], 'releaseAt'>) => {
    const result = planReviewJob({ releaseAt, ...input });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };

  it('defaults: 30-minute margin and a 2-hour minimum lead', () => {
    expect(DEFAULT_SAFETY_MARGIN_MS).toBe(30 * MINUTE);
    expect(DEFAULT_MINIMUM_LEAD_MS).toBe(2 * HOUR);
  });

  it('without measurements the job starts the default minimum lead before release', () => {
    const p = plan({ measuredP95ProcessingMs: null, queueLagP95Ms: null });
    expect(p).toMatchObject({
      jobStartAt: at('2026-10-01T18:00:00Z'),
      evidenceCutoffAt: at('2026-10-01T18:00:00Z'),
      leadMs: 2 * HOUR,
      basis: 'default_minimum',
      latenessRisk: false,
    });
  });

  it('measured p95 + queue lag + margin sets the lead when it exceeds the minimum', () => {
    const p = plan({ measuredP95ProcessingMs: 2 * HOUR, queueLagP95Ms: 20 * MINUTE });
    expect(p.leadMs).toBe(2 * HOUR + 20 * MINUTE + 30 * MINUTE);
    expect(p.basis).toBe('measured');
    expect(p.jobStartAt).toEqual(at('2026-10-01T17:10:00Z'));
    expect(p.evidenceCutoffAt).toEqual(p.jobStartAt);
  });

  it('fast measured processing never shortens the lead below the minimum', () => {
    const p = plan({ measuredP95ProcessingMs: 5 * MINUTE, queueLagP95Ms: MINUTE });
    expect(p.leadMs).toBe(2 * HOUR);
    expect(p.basis).toBe('default_minimum');
  });

  it('Decision: an unknown queue lag counts as zero but the measured processing still applies', () => {
    const p = plan({ measuredP95ProcessingMs: 3 * HOUR, queueLagP95Ms: null });
    expect(p.leadMs).toBe(3 * HOUR + 30 * MINUTE);
    expect(p.basis).toBe('measured');
  });

  it('Decision: the lead is capped and a runaway measurement is flagged as a lateness risk', () => {
    const p = plan({ measuredP95ProcessingMs: 40 * HOUR, queueLagP95Ms: 0 });
    expect(p.leadMs).toBe(MAX_REVIEW_LEAD_MS);
    expect(p.requiredLeadMs).toBe(40 * HOUR + 30 * MINUTE);
    expect(p.latenessRisk).toBe(true);
  });

  it('a job planned too late starts now, uses now as the cutoff and is flagged at risk', () => {
    const now = at('2026-10-01T19:00:00Z');
    const p = plan({ measuredP95ProcessingMs: null, queueLagP95Ms: null, now });
    expect(p.jobStartAt).toEqual(now);
    expect(p.evidenceCutoffAt).toEqual(now);
    expect(p.latenessRisk).toBe(true);
  });

  it('rejects invalid durations and instants', () => {
    const code = (input: Parameters<typeof planReviewJob>[0]) => {
      const r = planReviewJob(input);
      return r.ok ? 'OK' : r.error.code;
    };
    const base = { releaseAt, measuredP95ProcessingMs: null, queueLagP95Ms: null };
    expect(code({ ...base, measuredP95ProcessingMs: -1 })).toBe('INVALID_DURATION');
    expect(code({ ...base, queueLagP95Ms: Number.NaN })).toBe('INVALID_DURATION');
    expect(code({ ...base, minimumLeadMs: 0 })).toBe('INVALID_DURATION');
    expect(code({ ...base, safetyMarginMs: -5 })).toBe('INVALID_DURATION');
    expect(code({ ...base, releaseAt: new Date(Number.NaN) })).toBe('INVALID_INSTANT');
  });

  it('property: the job never starts at or after release (when planned ahead) and honours the floor', () => {
    const dur = fc.option(fc.integer({ min: 0, max: 30 * HOUR }), { nil: null });
    fc.assert(
      fc.property(
        dur,
        dur,
        fc.integer({ min: 0, max: 2 * HOUR }),
        fc.integer({ min: 1, max: 6 * HOUR }),
        (p95, lag, margin, minimum) => {
          const r = planReviewJob({
            releaseAt,
            measuredP95ProcessingMs: p95,
            queueLagP95Ms: lag,
            safetyMarginMs: margin,
            minimumLeadMs: minimum,
          });
          if (!r.ok) throw new Error(r.error.code);
          const p = r.value;
          expect(p.jobStartAt.getTime()).toBeLessThan(releaseAt.getTime());
          expect(p.evidenceCutoffAt).toEqual(p.jobStartAt);
          expect(p.leadMs).toBeGreaterThanOrEqual(Math.min(minimum, MAX_REVIEW_LEAD_MS));
          expect(p.requiredLeadMs).toBeGreaterThanOrEqual((p95 ?? 0) + (lag ?? 0) + margin);
          expect(p.latenessRisk).toBe(p.requiredLeadMs > p.leadMs);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('E4 lateness monitoring', () => {
  const releaseAt = at('2026-10-01T20:00:00Z');
  it('reports on-time, late, pending and overdue reviews', () => {
    expect(
      assessReviewLateness({ releaseAt, readyAt: at('2026-10-01T19:00:00Z'), now: releaseAt }),
    ).toEqual({ status: 'on_time', latenessMs: 0 });
    expect(
      assessReviewLateness({ releaseAt, readyAt: at('2026-10-01T20:05:00Z'), now: releaseAt }),
    ).toEqual({ status: 'late', latenessMs: 5 * MINUTE });
    expect(
      assessReviewLateness({ releaseAt, readyAt: null, now: at('2026-10-01T19:00:00Z') }),
    ).toEqual({ status: 'pending', latenessMs: 0 });
    expect(
      assessReviewLateness({ releaseAt, readyAt: null, now: at('2026-10-01T20:10:00Z') }),
    ).toEqual({ status: 'overdue', latenessMs: 10 * MINUTE });
  });
});

describe('AC_LEARNING_09 optional versioned top-ups', () => {
  const decide = (input: Parameters<typeof planTopUp>[0]) => {
    const r = planTopUp(input);
    if (!r.ok) throw new Error(r.error.code);
    return r.value;
  };

  it('late evidence after a completed review creates version 2 as optional', () => {
    expect(
      decide({ existingVersions: [{ version: 1, status: 'completed' }], lateEvidenceCount: 3 }),
    ).toEqual({
      create: true,
      version: 2,
      optional: true,
    });
  });

  it('an in-progress review is never overwritten: the top-up is a new version', () => {
    expect(
      decide({ existingVersions: [{ version: 1, status: 'in_progress' }], lateEvidenceCount: 1 }),
    ).toEqual({
      create: true,
      version: 2,
      optional: true,
    });
  });

  it('no late evidence means no top-up', () => {
    expect(
      decide({ existingVersions: [{ version: 1, status: 'completed' }], lateEvidenceCount: 0 }),
    ).toEqual({
      create: false,
      reason: 'no_late_evidence',
    });
  });

  it('no base review yet means the evidence belongs to the base review, not a top-up', () => {
    expect(decide({ existingVersions: [], lateEvidenceCount: 4 })).toEqual({
      create: false,
      reason: 'no_base_review',
    });
  });

  it('Decision: at most one unstarted optional top-up at a time', () => {
    expect(
      decide({
        existingVersions: [
          { version: 1, status: 'completed' },
          { version: 2, status: 'ready' },
        ],
        lateEvidenceCount: 2,
      }),
    ).toEqual({ create: false, reason: 'pending_top_up_exists' });
    expect(
      decide({
        existingVersions: [
          { version: 2, status: 'completed' },
          { version: 1, status: 'completed' },
        ],
        lateEvidenceCount: 2,
      }),
    ).toEqual({ create: true, version: 3, optional: true });
  });

  it('Decision: versions per subject-week are capped (cost control)', () => {
    expect(
      decide({
        existingVersions: [
          { version: 1, status: 'completed' },
          { version: 2, status: 'completed' },
        ],
        lateEvidenceCount: 1,
        maxVersions: 2,
      }),
    ).toEqual({ create: false, reason: 'top_up_limit_reached' });
  });

  it('rejects malformed version lists and counts', () => {
    const code = (input: Parameters<typeof planTopUp>[0]) => {
      const r = planTopUp(input);
      return r.ok ? 'OK' : r.error.code;
    };
    expect(
      code({
        existingVersions: [
          { version: 1, status: 'completed' },
          { version: 1, status: 'ready' },
        ],
        lateEvidenceCount: 1,
      }),
    ).toBe('INVALID_REVIEW_VERSIONS');
    expect(
      code({ existingVersions: [{ version: 0, status: 'completed' }], lateEvidenceCount: 1 }),
    ).toBe('INVALID_REVIEW_VERSIONS');
    expect(
      code({ existingVersions: [{ version: 1, status: 'completed' }], lateEvidenceCount: -1 }),
    ).toBe('INVALID_COUNT');
    expect(
      code({
        existingVersions: [{ version: 1, status: 'completed' }],
        lateEvidenceCount: 1,
        maxVersions: 0,
      }),
    ).toBe('INVALID_COUNT');
  });

  it('property: a created top-up never reuses an existing version number', () => {
    const statusArb = fc.constantFrom(
      'ready' as const,
      'in_progress' as const,
      'completed' as const,
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 6 }),
        fc.array(statusArb, { minLength: 6, maxLength: 6 }),
        fc.integer({ min: 0, max: 10 }),
        (versions, statuses, late) => {
          const existingVersions = versions.map((version, i) => ({
            version,
            status: statuses[i]!,
          }));
          const r = planTopUp({ existingVersions, lateEvidenceCount: late, maxVersions: 100 });
          if (!r.ok) throw new Error(r.error.code);
          if (r.value.create) {
            expect(versions).not.toContain(r.value.version);
            expect(r.value.version).toBe(Math.max(...versions) + 1);
            expect(late).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Independent adversarial review (REVIEW-SCHEDULING). Appended section; nothing above is changed.
// `[RV-scheduling-<n>]` tests are regression tests for confirmed defects and are expected to FAIL
// until the implementation is fixed. `[RV-scheduling-sound]` tests probe risky behaviour that was
// verified correct and must keep passing.
// ---------------------------------------------------------------------------------------------
import {
  assertSchedulingZone,
  dailyPracticeState,
  isSchedulingZone,
  localDateTimeToUtc,
  scheduleNotification,
  type NotificationAudience,
  type NotificationRequest,
} from './index.ts';

describe('RV-scheduling: adversarial review regressions', () => {
  it('[RV-scheduling-1] a U+2212 (unicode minus) UTC offset is rejected like an ASCII fixed offset', () => {
    // P8: "The scheduler must use the family time zone and daylight-saving rules, not server UTC
    // or a fixed offset." local-time.ts documents that raw offsets such as `-05:00` are rejected,
    // but Intl also accepts the U+2212 spelling, which OFFSET_ZONE_RE (/^[+-]/) does not catch.
    // Accepted, `−05:00` pins New York families to EST all summer: the 2026-W11 Thursday review
    // releases at 21:00Z (17:00 EDT) instead of 20:00Z.
    const zone = '−05:00';
    let assertRejects = false;
    try {
      assertSchedulingZone(zone);
    } catch (error) {
      assertRejects = error instanceof RangeError;
    }
    const review = reviewReleases({
      schedule: defaultReviewSchedule(),
      zone,
      subjects: ['math'],
      weekKey: '2026-W11',
    });
    const daily = dailyPracticeState({
      zone,
      now: at('2026-07-01T20:00:00Z'),
      settings: { localTime: '15:30', paused: null, vacationDates: [], excludedSubjects: [] },
    });
    expect({
      isSchedulingZone: isSchedulingZone(zone),
      assertSchedulingZoneThrows: assertRejects,
      reviewReleases: review.ok ? 'OK' : review.error.code,
      dailyPracticeState: daily.ok ? 'OK' : daily.error.code,
    }).toEqual({
      isSchedulingZone: false,
      assertSchedulingZoneThrows: true,
      reviewReleases: 'INVALID_TIME_ZONE',
      dailyPracticeState: 'INVALID_TIME_ZONE',
    });
  });

  it('[RV-scheduling-2] notification gates fail closed on values outside audience/boolean domains', () => {
    // P14: "Default notifications go to the parent's opted-in devices; child reminders require
    // parent permission ... Respect ... opt-outs". The gate is a deny-list (`audience === 'child'`)
    // plus truthiness checks, so any other audience spelling skips the permission check and a
    // non-boolean flag read from storage/JSON ('false') counts as consent. Sibling planners in this
    // module validate their enum inputs at runtime (planTopUp, planReviewReschedule); this one
    // must too, and must never answer send: true for these requests.
    const base: NotificationRequest = {
      desiredAt: at('2026-10-01T20:00:00Z'),
      zone: NY,
      quietHours: null,
      audience: 'parent',
      childRemindersPermitted: false,
      optedIn: true,
    };
    const sends = (overrides: Partial<NotificationRequest>): boolean => {
      const result = scheduleNotification({ ...base, ...overrides });
      return result.ok && result.value.send;
    };
    expect({
      unknownAudience: sends({
        audience: 'Child' as unknown as NotificationAudience,
        childRemindersPermitted: false,
      }),
      stringPermission: sends({
        audience: 'child',
        childRemindersPermitted: 'false' as unknown as boolean,
      }),
      stringOptIn: sends({ optedIn: 'false' as unknown as boolean }),
    }).toEqual({ unknownAudience: false, stringPermission: false, stringOptIn: false });
  });

  it('[RV-scheduling-3] top-up keys are only derived from a base review key', () => {
    // P8 idempotency key `(child, subject, review_week, schedule_version)`; AC_LEARNING_08 (no
    // duplicates on worker retries) and AC_LEARNING_09 (versioned top-ups, no double awards).
    // topUpIdempotencyKey documents "reviewKey must come from reviewIdempotencyKey" but only checks
    // the `review:` prefix, so a worker that derives version 3 from the latest (v2) key gets
    // `<base>:v2:v3`, a second distinct key for the same top-up version as `<base>:v3`.
    const base = reviewIdempotencyKey('child-riley', 'math', '2026-W40', 1);
    const v2 = topUpIdempotencyKey(base, 2);
    expect(() => topUpIdempotencyKey(v2, 3)).toThrow(RangeError);
    expect(() => topUpIdempotencyKey('review:', 2)).toThrow(RangeError);
  });
});

describe('RV-scheduling: verified-sound edge cases (must keep passing)', () => {
  it('[RV-scheduling-sound] a test on 2027-01-01 belongs to 2026-W53; a 2027-W01 Monday test releases on 2027-01-03', () => {
    const schedule: ReviewSchedule = {
      weekday: 4,
      localTime: '16:00',
      scheduleVersion: 2,
      subjectOverrides: {
        math: { testDates: ['2027-01-01'] },
        reading: { testDates: ['2027-01-04'] },
      },
    };
    const subjects = ['math', 'reading'];
    const w53 = releasesOk({ schedule, zone: NY, subjects, weekKey: '2026-W53' });
    const w01 = releasesOk({ schedule, zone: NY, subjects, weekKey: '2027-W01' });
    expect(w53.map((r) => [r.subject, r.reason, r.releaseAt?.toISOString()])).toEqual([
      ['math', 'test_date_eve', '2026-12-31T21:00:00.000Z'],
      ['reading', 'default_schedule', '2026-12-31T21:00:00.000Z'],
    ]);
    expect(w01.map((r) => [r.subject, r.reason, r.localDate])).toEqual([
      ['math', 'default_schedule', '2027-01-07'],
      ['reading', 'test_date_eve', '2027-01-03'],
    ]);
  });

  it('[RV-scheduling-sound] midnight fall-back (Asia/Beirut) and a 2-hour gap (Antarctica/Troll)', () => {
    // Beirut falls back 2026-10-25 00:00 -> 2026-10-24 23:00: 23:30 on Oct 24 happens twice.
    expect(localDateTimeToUtc('Asia/Beirut', '2026-10-24', '23:30')).toEqual(
      at('2026-10-24T20:30:00Z'),
    );
    // Troll jumps +00 -> +02 at 01:00Z on 2026-03-29: 01:30 local does not exist.
    expect(localDateTimeToUtc('Antarctica/Troll', '2026-03-29', '01:30')).toEqual(
      at('2026-03-29T01:00:00Z'),
    );
    // Quiet hours around the Beirut repeat: the send is the first allowed instant, never earlier.
    const decide = (desiredAt: Date, start: string, end: string) =>
      scheduleNotification({
        desiredAt,
        zone: 'Asia/Beirut',
        quietHours: { start, end },
        audience: 'parent',
        childRemindersPermitted: false,
        optedIn: true,
      });
    expect(decide(at('2026-10-24T20:10:00Z'), '23:00', '00:30')).toEqual({
      ok: true,
      value: { send: true, sendAt: at('2026-10-24T22:30:00Z') },
    });
    expect(decide(at('2026-10-24T21:10:00Z'), '22:00', '23:30')).toEqual({
      ok: true,
      value: { send: true, sendAt: at('2026-10-24T21:30:00Z') },
    });
  });
});
