// Spec P8: "A Friday test-date change reschedules the corresponding subject" and E4: "preserve
// in-progress sets". A schedule change bumps schedule_version; this decides what happens to the
// existing job for one (child, subject, week) without ever overwriting started work.
import { describe, expect, it } from 'vitest';
import {
  planReviewReschedule,
  reviewReleases,
  type ReviewJobStatus,
  type ReviewRelease,
  type ReviewSchedule,
} from './index.ts';

const at = (iso: string): Date => new Date(iso);
const NY = 'America/New_York';

function releaseFor(schedule: ReviewSchedule, subject: string): ReviewRelease {
  const r = reviewReleases({ schedule, zone: NY, subjects: [subject], weekKey: '2026-W40' });
  if (!r.ok || r.value[0] === undefined) throw new Error('release expected');
  return r.value[0];
}

const v3: ReviewSchedule = { weekday: 4, localTime: '16:00', scheduleVersion: 3 };
const thursday = at('2026-10-01T20:00:00Z');

function decide(status: ReviewJobStatus | null, next: ReviewRelease) {
  const r = planReviewReschedule({
    existing: status === null ? null : { releaseAt: thursday, status },
    next,
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe('P8 test-date change reschedules only a not-yet-started review job', () => {
  const movedToWednesdayTest = releaseFor(
    { ...v3, scheduleVersion: 4, subjectOverrides: { math: { testDates: ['2026-09-30'] } } },
    'math',
  );
  const unchanged = releaseFor({ ...v3, scheduleVersion: 4 }, 'math');
  const skipped = releaseFor(
    { ...v3, scheduleVersion: 4, subjectOverrides: { math: { skipWeeks: ['2026-W40'] } } },
    'math',
  );

  it('a scheduled job whose release moved is replaced under the new schedule version', () => {
    expect(decide('scheduled', movedToWednesdayTest)).toEqual({
      action: 'replace',
      releaseAt: at('2026-09-29T20:00:00Z'),
    });
    expect(decide('failed', movedToWednesdayTest)).toMatchObject({ action: 'replace' });
  });

  it('a scheduled job whose release did not move is kept (no duplicate job)', () => {
    expect(decide('scheduled', unchanged)).toEqual({ action: 'keep', reason: 'unchanged' });
  });

  it('a newly skipped week cancels a job that has not started', () => {
    expect(decide('scheduled', skipped)).toEqual({ action: 'cancel' });
  });

  it('started, ready, in-progress and completed reviews are preserved whatever changes', () => {
    for (const status of ['processing', 'ready', 'in_progress', 'completed'] as const) {
      expect(decide(status, movedToWednesdayTest)).toEqual({
        action: 'keep',
        reason: 'already_started',
      });
      expect(decide(status, skipped)).toEqual({ action: 'keep', reason: 'already_started' });
    }
  });

  it('no job (or a cancelled one) creates a job unless the week is skipped', () => {
    expect(decide(null, movedToWednesdayTest)).toEqual({
      action: 'create',
      releaseAt: at('2026-09-29T20:00:00Z'),
    });
    expect(decide('cancelled', unchanged)).toEqual({ action: 'create', releaseAt: thursday });
    expect(decide(null, skipped)).toEqual({ action: 'none' });
  });

  it('rejects malformed existing jobs', () => {
    const bad = planReviewReschedule({
      existing: { releaseAt: new Date(Number.NaN), status: 'scheduled' },
      next: unchanged,
    });
    expect(bad.ok ? null : bad.error.code).toBe('INVALID_INSTANT');
    const badStatus = planReviewReschedule({
      existing: { releaseAt: thursday, status: 'bogus' as ReviewJobStatus },
      next: unchanged,
    });
    expect(badStatus.ok ? null : badStatus.error.code).toBe('INVALID_JOB_STATUS');
  });
});
