/**
 * Support case rules shared by the API and the queue UI: ageing, who may reply, and what a staff
 * update must carry before a case can be resolved. Pure; `now` is an input.
 */

export const SUPPORT_CASE_KINDS = [
  'complaint',
  'refund_request',
  'billing_issue',
  'bug',
  'safety_question',
  'other',
] as const;
export type SupportCaseKind = (typeof SUPPORT_CASE_KINDS)[number];

export const SUPPORT_CASE_STATUSES = [
  'open',
  'in_progress',
  'waiting_on_parent',
  'resolved',
  'closed',
] as const;
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number];

export const SUPPORT_CASE_PRIORITIES = ['normal', 'high'] as const;
export type SupportCasePriority = (typeof SUPPORT_CASE_PRIORITIES)[number];

export const SUPPORT_CASE_RESOLUTIONS = [
  'answered',
  'fixed',
  'refunded_by_store',
  'stripe_refund_issued',
  'no_refund',
  'duplicate',
] as const;
export type SupportCaseResolution = (typeof SUPPORT_CASE_RESOLUTIONS)[number];

export const SUPPORT_SUBJECT_MAX_LENGTH = 120;
export const SUPPORT_MESSAGE_MAX_LENGTH = 2000;
export const SUPPORT_REFERENCE_MAX_LENGTH = 200;

/** Age filters for the staff queue: cases opened at least this many hours ago. */
export const CASE_AGE_FILTERS = {
  over_24h: 24,
  over_72h: 72,
  over_7d: 168,
} as const;
export type CaseAgeFilter = keyof typeof CASE_AGE_FILTERS;
export const CASE_AGE_FILTER_KEYS = Object.keys(CASE_AGE_FILTERS) as CaseAgeFilter[];

export const CASE_AGE_BUCKETS = ['under_24h', '1_to_3_days', '3_to_7_days', 'over_7_days'] as const;
export type CaseAgeBucket = (typeof CASE_AGE_BUCKETS)[number];

const HOUR_MS = 3_600_000;

function assertInstant(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
}

/** Whole hours since the case was opened, rounded down and never negative. */
export function caseAgeHours(createdAt: Date, now: Date): number {
  assertInstant(createdAt, 'createdAt');
  assertInstant(now, 'now');
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / HOUR_MS));
}

export function caseAgeBucket(ageHours: number): CaseAgeBucket {
  if (!Number.isInteger(ageHours) || ageHours < 0)
    throw new RangeError('ageHours must be whole hours');
  if (ageHours < 24) return 'under_24h';
  if (ageHours < 72) return '1_to_3_days';
  if (ageHours < 168) return '3_to_7_days';
  return 'over_7_days';
}

/** The latest created_at a case may have to satisfy an age filter at `now` (inclusive). */
export function caseOpenedAtOrBefore(now: Date, filter: CaseAgeFilter): Date {
  assertInstant(now, 'now');
  return new Date(now.getTime() - CASE_AGE_FILTERS[filter] * HOUR_MS);
}

/** A case has left the queue once it is resolved or closed. */
export function caseIsClosedOut(status: SupportCaseStatus): boolean {
  return status === 'resolved' || status === 'closed';
}

/** A parent may reply while the case is not closed (a resolved case can be reopened by a reply). */
export function parentCanReply(status: SupportCaseStatus): boolean {
  return status !== 'closed';
}

/** A Stripe refund is issued in the Stripe dashboard; the case records its refund reference. */
export function resolutionRequiresReference(resolution: SupportCaseResolution): boolean {
  return resolution === 'stripe_refund_issued';
}

/** Store refunds belong to the store: these outcomes never mean PencilLift moved money. */
export function resolutionIsStoreRefund(resolution: SupportCaseResolution): boolean {
  return resolution === 'refunded_by_store';
}

export interface CaseStateFacts {
  readonly status: SupportCaseStatus;
  readonly resolution: SupportCaseResolution | null;
  readonly resolutionReference: string | null;
}

export interface CaseUpdatePatch {
  readonly status?: SupportCaseStatus;
  readonly resolution?: SupportCaseResolution | null;
  readonly resolutionReference?: string | null;
}

export const CASE_UPDATE_PROBLEMS = [
  'RESOLUTION_REQUIRED',
  'RESOLUTION_NEEDS_CLOSED_OUT_STATUS',
  'REFERENCE_REQUIRED',
  'REFERENCE_WITHOUT_RESOLUTION',
] as const;
export type CaseUpdateProblem = (typeof CASE_UPDATE_PROBLEMS)[number];

/** Explicit patch keys win; keys left out keep the current value. */
export function applyCasePatch(current: CaseStateFacts, patch: CaseUpdatePatch): CaseStateFacts {
  return {
    status: patch.status ?? current.status,
    resolution: patch.resolution === undefined ? current.resolution : patch.resolution,
    resolutionReference:
      patch.resolutionReference === undefined
        ? current.resolutionReference
        : patch.resolutionReference,
  };
}

/**
 * What stops a staff update from being saved (the schema enforces the same rules as a second
 * layer). Empty when the resulting state is consistent.
 */
export function caseUpdateProblems(
  current: CaseStateFacts,
  patch: CaseUpdatePatch,
): CaseUpdateProblem[] {
  const next = applyCasePatch(current, patch);
  const problems: CaseUpdateProblem[] = [];
  if (next.status === 'resolved' && next.resolution === null) problems.push('RESOLUTION_REQUIRED');
  if (next.resolution !== null && !caseIsClosedOut(next.status)) {
    problems.push('RESOLUTION_NEEDS_CLOSED_OUT_STATUS');
  }
  if (
    next.resolution !== null &&
    resolutionRequiresReference(next.resolution) &&
    next.resolutionReference === null
  ) {
    problems.push('REFERENCE_REQUIRED');
  }
  if (next.resolution === null && next.resolutionReference !== null) {
    problems.push('REFERENCE_WITHOUT_RESOLUTION');
  }
  return problems;
}

/**
 * The resolved_at stamp after a status change: set when the case leaves the queue, kept while
 * it stays out, cleared when it is reopened.
 */
export function nextResolvedAt(
  currentStatus: SupportCaseStatus,
  nextStatus: SupportCaseStatus,
  currentResolvedAt: Date | null,
  now: Date,
): Date | null {
  assertInstant(now, 'now');
  if (!caseIsClosedOut(nextStatus)) return null;
  if (caseIsClosedOut(currentStatus) && currentResolvedAt !== null) return currentResolvedAt;
  return now;
}

/** A parent's reply on a resolved case reopens it; other statuses are unchanged. */
export function statusAfterParentReply(status: SupportCaseStatus): SupportCaseStatus {
  if (status === 'closed') throw new RangeError('a closed case takes no replies');
  if (status === 'resolved' || status === 'waiting_on_parent') return 'open';
  return status;
}
