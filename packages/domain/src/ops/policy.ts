import { SUPPORT_CASE_KINDS, type SupportCaseKind } from './cases.ts';

/**
 * The owner's support policy (Owner action #32), edited in the admin dashboard and stored in
 * `ops_settings` under `support_policy`. Pure rules: no I/O, `now` is an input.
 *
 * - `refundWindowDays`: how long after a charge a refund request is considered in-window; the
 *   parent page states it, the console marks late requests. Store refunds are still the store's.
 * - `responseTargetHours`: per case kind, the owner's own response-time commitment; the queue marks
 *   a case over target from its opening instant (never from the last reply).
 * - `partialRefunds`: whether the owner grants partial refunds (informational for staff copy).
 */
export interface SupportPolicy {
  readonly refundWindowDays: number;
  readonly responseTargetHours: Readonly<Record<SupportCaseKind, number>>;
  readonly partialRefunds: boolean;
}

export const REFUND_WINDOW_DAYS_MIN = 1;
export const REFUND_WINDOW_DAYS_MAX = 90;
export const RESPONSE_TARGET_HOURS_MIN = 1;
export const RESPONSE_TARGET_HOURS_MAX = 336; // two weeks

export const DEFAULT_SUPPORT_POLICY: SupportPolicy = {
  refundWindowDays: 14,
  responseTargetHours: {
    refund_request: 48,
    complaint: 48,
    billing_issue: 48,
    bug: 72,
    safety_question: 24,
    other: 72,
  },
  partialRefunds: true,
};

export interface PolicyProblem {
  readonly field: string;
  readonly problem: string;
}

function wholeNumberIn(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be a whole number';
  if (value < min || value > max) return `must be between ${min} and ${max}`;
  return null;
}

/** Every problem with a candidate policy; an empty list means it can be saved. */
export function supportPolicyProblems(candidate: unknown): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (typeof candidate !== 'object' || candidate === null) {
    return [{ field: 'policy', problem: 'must be an object' }];
  }
  const c = candidate as Record<string, unknown>;
  const window = wholeNumberIn(
    c['refundWindowDays'],
    REFUND_WINDOW_DAYS_MIN,
    REFUND_WINDOW_DAYS_MAX,
  );
  if (window) problems.push({ field: 'refundWindowDays', problem: window });
  const targets = c['responseTargetHours'];
  if (typeof targets !== 'object' || targets === null) {
    problems.push({ field: 'responseTargetHours', problem: 'must name every case kind' });
  } else {
    const t = targets as Record<string, unknown>;
    for (const kind of SUPPORT_CASE_KINDS) {
      const p = wholeNumberIn(t[kind], RESPONSE_TARGET_HOURS_MIN, RESPONSE_TARGET_HOURS_MAX);
      if (p) problems.push({ field: `responseTargetHours.${kind}`, problem: p });
    }
    for (const key of Object.keys(t)) {
      if (!(SUPPORT_CASE_KINDS as readonly string[]).includes(key)) {
        problems.push({ field: `responseTargetHours.${key}`, problem: 'is not a case kind' });
      }
    }
  }
  if (typeof c['partialRefunds'] !== 'boolean') {
    problems.push({ field: 'partialRefunds', problem: 'must be true or false' });
  }
  for (const key of Object.keys(c)) {
    if (!['refundWindowDays', 'responseTargetHours', 'partialRefunds'].includes(key)) {
      problems.push({ field: key, problem: 'is not a policy field' });
    }
  }
  return problems;
}

/**
 * Reads a stored value, falling back to the default policy when the row is absent or (after a
 * schema change) no longer valid; the fallback is reported so the console can say so.
 */
export function supportPolicyFromStored(value: unknown): {
  policy: SupportPolicy;
  usedDefault: boolean;
} {
  if (value === null || value === undefined)
    return { policy: DEFAULT_SUPPORT_POLICY, usedDefault: true };
  if (supportPolicyProblems(value).length > 0) {
    return { policy: DEFAULT_SUPPORT_POLICY, usedDefault: true };
  }
  return { policy: value as SupportPolicy, usedDefault: false };
}

/** Hours a case is over its kind's target; 0 while within target. Negative ages count as 0. */
export function hoursOverTarget(
  kind: SupportCaseKind,
  openedAt: Date,
  now: Date,
  policy: SupportPolicy,
): number {
  const ageHours = Math.max(0, (now.getTime() - openedAt.getTime()) / 3_600_000);
  return Math.max(0, Math.floor(ageHours - policy.responseTargetHours[kind]));
}

/** Whether a charge settled at `chargedAt` is still inside the refund window at `now`. */
export function withinRefundWindow(chargedAt: Date, now: Date, policy: SupportPolicy): boolean {
  const windowMs = policy.refundWindowDays * 86_400_000;
  return now.getTime() - chargedAt.getTime() <= windowMs;
}

/** Parent-facing sentence for the support page; states the window, promises nothing else. */
export function refundWindowSentence(policy: SupportPolicy): string {
  const days = policy.refundWindowDays;
  return `Refund requests are reviewed for charges from the last ${days} ${days === 1 ? 'day' : 'days'}; the store or Stripe issues any refund, and PencilLift records the outcome on your case.`;
}
