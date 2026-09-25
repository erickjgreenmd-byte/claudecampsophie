import { describe, expect, it } from 'vitest';
import { SUPPORT_CASE_KINDS } from './cases.ts';
import {
  DEFAULT_SUPPORT_POLICY,
  hoursOverTarget,
  refundWindowSentence,
  supportPolicyFromStored,
  supportPolicyProblems,
  withinRefundWindow,
} from './policy.ts';

describe('support policy (Owner action #32)', () => {
  it('the default policy is valid and names every case kind', () => {
    expect(supportPolicyProblems(DEFAULT_SUPPORT_POLICY)).toEqual([]);
    expect(Object.keys(DEFAULT_SUPPORT_POLICY.responseTargetHours).sort()).toEqual(
      [...SUPPORT_CASE_KINDS].sort(),
    );
  });

  it('rejects out-of-range, fractional, missing, unknown and extra fields, naming each', () => {
    const problems = supportPolicyProblems({
      refundWindowDays: 0,
      responseTargetHours: { ...DEFAULT_SUPPORT_POLICY.responseTargetHours, bug: 1.5, bogus: 3 },
      partialRefunds: 'yes',
      extra: 1,
    });
    expect(problems.map((p) => p.field).sort()).toEqual(
      [
        'extra',
        'partialRefunds',
        'refundWindowDays',
        'responseTargetHours.bogus',
        'responseTargetHours.bug',
      ].sort(),
    );
    expect(supportPolicyProblems(null)).toEqual([
      { field: 'policy', problem: 'must be an object' },
    ]);
    expect(supportPolicyProblems({ refundWindowDays: 91, partialRefunds: true })).toEqual(
      expect.arrayContaining([
        { field: 'refundWindowDays', problem: 'must be between 1 and 90' },
        { field: 'responseTargetHours', problem: 'must name every case kind' },
      ]),
    );
  });

  it('a stored value that is absent or invalid falls back to the default and says so', () => {
    expect(supportPolicyFromStored(null)).toEqual({
      policy: DEFAULT_SUPPORT_POLICY,
      usedDefault: true,
    });
    expect(supportPolicyFromStored({ refundWindowDays: 7 })).toEqual({
      policy: DEFAULT_SUPPORT_POLICY,
      usedDefault: true,
    });
    const custom = { ...DEFAULT_SUPPORT_POLICY, refundWindowDays: 30 };
    expect(supportPolicyFromStored(custom)).toEqual({ policy: custom, usedDefault: false });
  });

  it('measures hours over target from the opening instant, never negative', () => {
    const opened = new Date('2026-09-25T00:00:00Z');
    const policy = DEFAULT_SUPPORT_POLICY; // safety_question target 24 h
    expect(
      hoursOverTarget('safety_question', opened, new Date('2026-09-25T23:59:00Z'), policy),
    ).toBe(0);
    expect(
      hoursOverTarget('safety_question', opened, new Date('2026-09-26T00:00:00Z'), policy),
    ).toBe(0);
    expect(
      hoursOverTarget('safety_question', opened, new Date('2026-09-26T05:30:00Z'), policy),
    ).toBe(5);
    expect(hoursOverTarget('bug', opened, new Date('2026-09-24T00:00:00Z'), policy)).toBe(0);
  });

  it('the refund window is inclusive of its last instant', () => {
    const charged = new Date('2026-09-01T12:00:00Z');
    const policy = { ...DEFAULT_SUPPORT_POLICY, refundWindowDays: 14 };
    expect(withinRefundWindow(charged, new Date('2026-09-15T12:00:00Z'), policy)).toBe(true);
    expect(withinRefundWindow(charged, new Date('2026-09-15T12:00:01Z'), policy)).toBe(false);
  });

  it('the parent sentence states the window and promises no refund', () => {
    const s = refundWindowSentence({ ...DEFAULT_SUPPORT_POLICY, refundWindowDays: 1 });
    expect(s).toMatch(/last 1 day;/);
    expect(refundWindowSentence(DEFAULT_SUPPORT_POLICY)).toMatch(/last 14 days;/);
    expect(s).not.toMatch(/guarantee|will be refunded/i);
  });
});
