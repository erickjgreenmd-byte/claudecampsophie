import { describe, expect, it } from 'vitest';
import {
  DELETION_OVERDUE_AFTER_DAYS,
  DELETION_TARGET_DAYS,
  FAILED_JOBS_WINDOW_DAYS,
  ageHours,
  attentionItem,
  deletionOverdueBefore,
  failedJobsWindowStart,
  needsAttention,
} from './index.ts';

const NOW = new Date('2026-09-24T15:00:00Z');

describe('attention windows', () => {
  it('names its constants: 7-day job window, 25 of the 30-day deletion target', () => {
    expect(FAILED_JOBS_WINDOW_DAYS).toBe(7);
    expect(DELETION_OVERDUE_AFTER_DAYS).toBe(25);
    expect(DELETION_TARGET_DAYS).toBe(30);
    expect(DELETION_OVERDUE_AFTER_DAYS).toBeLessThan(DELETION_TARGET_DAYS);
  });

  it('derives the cutoffs from the injected instant', () => {
    expect(failedJobsWindowStart(NOW)).toEqual(new Date('2026-09-17T15:00:00Z'));
    expect(deletionOverdueBefore(NOW)).toEqual(new Date('2026-08-30T15:00:00Z'));
    expect(() => failedJobsWindowStart(new Date('nope'))).toThrow(RangeError);
  });
});

describe('age in hours', () => {
  it('rounds down and never goes negative', () => {
    expect(ageHours(new Date('2026-09-24T13:59:59Z'), NOW)).toBe(1);
    expect(ageHours(new Date('2026-09-23T15:00:00Z'), NOW)).toBe(24);
    expect(ageHours(new Date('2026-09-24T15:30:00Z'), NOW)).toBe(0);
  });
});

describe('attention items', () => {
  it('carries the count, the oldest instant and its age; empty rules have no oldest item', () => {
    const item = attentionItem('jobs_failed', 3, new Date('2026-09-20T15:00:00Z'), NOW);
    expect(item).toEqual({
      kind: 'jobs_failed',
      key: null,
      count: 3,
      oldestAt: new Date('2026-09-20T15:00:00Z'),
      oldestAgeHours: 96,
    });
    expect(attentionItem('safety_reports_open', 0, null, NOW)).toEqual({
      kind: 'safety_reports_open',
      key: null,
      count: 0,
      oldestAt: null,
      oldestAgeHours: null,
    });
    expect(attentionItem('support_cases_open', 1, NOW, NOW, 'refund_request').key).toBe(
      'refund_request',
    );
  });

  it('refuses inconsistent counts; a rule without timestamps carries a count and no age', () => {
    expect(() => attentionItem('jobs_failed', 0, NOW, NOW)).toThrow(RangeError);
    expect(() => attentionItem('jobs_failed', -1, null, NOW)).toThrow(RangeError);
    expect(attentionItem('readiness_blocked', 2, null, NOW)).toMatchObject({
      count: 2,
      oldestAt: null,
      oldestAgeHours: null,
    });
  });

  it('needsAttention keeps non-empty rules, oldest first', () => {
    const items = [
      attentionItem('jobs_failed', 0, null, NOW),
      attentionItem('safety_reports_open', 1, new Date('2026-09-24T10:00:00Z'), NOW),
      attentionItem('deletions_overdue', 2, new Date('2026-08-20T10:00:00Z'), NOW),
      attentionItem('readiness_blocked', 4, NOW, NOW),
    ];
    expect(needsAttention(items).map((i) => i.kind)).toEqual([
      'deletions_overdue',
      'safety_reports_open',
      'readiness_blocked',
    ]);
    expect(needsAttention([])).toEqual([]);
  });
});
