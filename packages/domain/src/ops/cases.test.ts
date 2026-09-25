import { describe, expect, it } from 'vitest';
import {
  CASE_AGE_FILTERS,
  CASE_AGE_FILTER_KEYS,
  SUPPORT_CASE_RESOLUTIONS,
  SUPPORT_CASE_STATUSES,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_SUBJECT_MAX_LENGTH,
  applyCasePatch,
  caseAgeBucket,
  caseAgeHours,
  caseIsClosedOut,
  caseOpenedAtOrBefore,
  caseUpdateProblems,
  nextResolvedAt,
  parentCanReply,
  resolutionIsStoreRefund,
  resolutionRequiresReference,
  statusAfterParentReply,
  type CaseStateFacts,
} from './index.ts';

const NOW = new Date('2026-09-24T15:00:00Z');

describe('case ageing', () => {
  it('caps subject and message lengths as the product decided', () => {
    expect(SUPPORT_SUBJECT_MAX_LENGTH).toBe(120);
    expect(SUPPORT_MESSAGE_MAX_LENGTH).toBe(2000);
  });

  it('ages in whole hours, rounded down', () => {
    expect(caseAgeHours(new Date('2026-09-24T12:30:00Z'), NOW)).toBe(2);
    expect(caseAgeHours(NOW, NOW)).toBe(0);
    expect(caseAgeHours(new Date('2026-09-25T00:00:00Z'), NOW)).toBe(0);
  });

  it('buckets ages at 24h, 3 days and 7 days', () => {
    expect(caseAgeBucket(0)).toBe('under_24h');
    expect(caseAgeBucket(23)).toBe('under_24h');
    expect(caseAgeBucket(24)).toBe('1_to_3_days');
    expect(caseAgeBucket(71)).toBe('1_to_3_days');
    expect(caseAgeBucket(72)).toBe('3_to_7_days');
    expect(caseAgeBucket(167)).toBe('3_to_7_days');
    expect(caseAgeBucket(168)).toBe('over_7_days');
    expect(() => caseAgeBucket(-1)).toThrow(RangeError);
  });

  it('age filters give the SQL cutoff for "opened at least N hours ago"', () => {
    expect(CASE_AGE_FILTER_KEYS).toEqual(['over_24h', 'over_72h', 'over_7d']);
    expect(CASE_AGE_FILTERS.over_7d).toBe(168);
    expect(caseOpenedAtOrBefore(NOW, 'over_24h')).toEqual(new Date('2026-09-23T15:00:00Z'));
    expect(caseOpenedAtOrBefore(NOW, 'over_7d')).toEqual(new Date('2026-09-17T15:00:00Z'));
  });
});

describe('who may act', () => {
  it('a parent replies until the case is closed; a reply reopens a resolved or waiting case', () => {
    for (const status of SUPPORT_CASE_STATUSES) {
      expect(parentCanReply(status)).toBe(status !== 'closed');
    }
    expect(statusAfterParentReply('resolved')).toBe('open');
    expect(statusAfterParentReply('waiting_on_parent')).toBe('open');
    expect(statusAfterParentReply('in_progress')).toBe('in_progress');
    expect(statusAfterParentReply('open')).toBe('open');
    expect(() => statusAfterParentReply('closed')).toThrow(RangeError);
  });

  it('resolved and closed leave the queue', () => {
    expect(SUPPORT_CASE_STATUSES.filter(caseIsClosedOut)).toEqual(['resolved', 'closed']);
  });

  it('only a Stripe refund needs a reference; only refunded_by_store is a store refund', () => {
    expect(SUPPORT_CASE_RESOLUTIONS.filter(resolutionRequiresReference)).toEqual([
      'stripe_refund_issued',
    ]);
    expect(SUPPORT_CASE_RESOLUTIONS.filter(resolutionIsStoreRefund)).toEqual(['refunded_by_store']);
  });
});

describe('staff update rules', () => {
  const open: CaseStateFacts = { status: 'open', resolution: null, resolutionReference: null };

  it('resolving needs a resolution; a resolution needs a closed-out status', () => {
    expect(caseUpdateProblems(open, { status: 'resolved' })).toEqual(['RESOLUTION_REQUIRED']);
    expect(caseUpdateProblems(open, { status: 'resolved', resolution: 'answered' })).toEqual([]);
    expect(caseUpdateProblems(open, { resolution: 'answered' })).toEqual([
      'RESOLUTION_NEEDS_CLOSED_OUT_STATUS',
    ]);
    expect(caseUpdateProblems(open, { status: 'closed' })).toEqual([]);
    expect(caseUpdateProblems(open, { status: 'closed', resolution: 'duplicate' })).toEqual([]);
  });

  it('a Stripe refund records its reference; a reference alone is meaningless', () => {
    expect(
      caseUpdateProblems(open, { status: 'resolved', resolution: 'stripe_refund_issued' }),
    ).toEqual(['REFERENCE_REQUIRED']);
    expect(
      caseUpdateProblems(open, {
        status: 'resolved',
        resolution: 'stripe_refund_issued',
        resolutionReference: 're_synthetic_1',
      }),
    ).toEqual([]);
    expect(caseUpdateProblems(open, { resolutionReference: 're_synthetic_1' })).toEqual([
      'REFERENCE_WITHOUT_RESOLUTION',
    ]);
  });

  it('reopening a resolved case keeps its recorded resolution only if the status stays closed out', () => {
    const resolved: CaseStateFacts = {
      status: 'resolved',
      resolution: 'answered',
      resolutionReference: null,
    };
    expect(caseUpdateProblems(resolved, { status: 'in_progress' })).toEqual([
      'RESOLUTION_NEEDS_CLOSED_OUT_STATUS',
    ]);
    expect(caseUpdateProblems(resolved, { status: 'in_progress', resolution: null })).toEqual([]);
    expect(applyCasePatch(resolved, { status: 'closed' })).toEqual({
      ...resolved,
      status: 'closed',
    });
  });

  it('resolved_at is stamped once, kept while closed out, cleared on reopen', () => {
    const earlier = new Date('2026-09-20T00:00:00Z');
    expect(nextResolvedAt('open', 'resolved', null, NOW)).toEqual(NOW);
    expect(nextResolvedAt('resolved', 'closed', earlier, NOW)).toEqual(earlier);
    expect(nextResolvedAt('resolved', 'open', earlier, NOW)).toBeNull();
    expect(nextResolvedAt('open', 'in_progress', null, NOW)).toBeNull();
    expect(nextResolvedAt('closed', 'closed', null, NOW)).toEqual(NOW);
  });
});
