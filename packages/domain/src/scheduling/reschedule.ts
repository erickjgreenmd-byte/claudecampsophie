// Schedule changes for one (child, subject, ISO week) review job (spec P8, E4). A parent change
// bumps `scheduleVersion`, which changes the idempotency key; this decides whether the existing
// job is kept, replaced, cancelled or newly created, and never touches started work.
import { err, ok, type Result } from '../shared/result.ts';
import type { SchedulingErrorCode } from './errors.ts';
import { isValidInstant } from './local-time.ts';
import type { ReviewRelease } from './review.ts';

export const REVIEW_JOB_STATUSES = [
  'scheduled',
  'processing',
  'ready',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ReviewJobStatus = (typeof REVIEW_JOB_STATUSES)[number];

/** Generation has begun or the review exists: preserved (late changes use top-ups instead). */
const STARTED: ReadonlySet<ReviewJobStatus> = new Set([
  'processing',
  'ready',
  'in_progress',
  'completed',
]);

export type ReviewRescheduleDecision =
  | { readonly action: 'none' }
  | { readonly action: 'create'; readonly releaseAt: Date }
  | { readonly action: 'keep'; readonly reason: 'unchanged' | 'already_started' }
  /** Cancel the not-started job and create one keyed by the new schedule version. */
  | { readonly action: 'replace'; readonly releaseAt: Date }
  | { readonly action: 'cancel' };

/**
 * `existing` is the live job for the same child/subject/week (any schedule version) or null;
 * `next` is that subject's release under the new schedule (from `reviewReleases`).
 * Decision: once generation has started (processing, ready, in progress, completed) the review is
 * kept even if the parent later skips the week or moves the test, so in-progress sets and earned
 * rewards are never discarded; a failed or scheduled job has no child-visible work and may be
 * replaced or cancelled.
 */
export function planReviewReschedule(input: {
  readonly existing: { readonly releaseAt: Date; readonly status: ReviewJobStatus } | null;
  readonly next: ReviewRelease;
}): Result<ReviewRescheduleDecision, SchedulingErrorCode> {
  const { existing, next } = input;
  if (next.releaseAt !== null && !isValidInstant(next.releaseAt)) {
    return err('INVALID_INSTANT', 'next.releaseAt is invalid');
  }
  if (existing !== null) {
    if (!isValidInstant(existing.releaseAt)) {
      return err('INVALID_INSTANT', 'existing.releaseAt is invalid');
    }
    if (!(REVIEW_JOB_STATUSES as readonly string[]).includes(existing.status)) {
      return err('INVALID_JOB_STATUS', 'Unknown review job status');
    }
  }
  if (existing === null || existing.status === 'cancelled') {
    return ok(
      next.releaseAt === null
        ? { action: 'none' }
        : { action: 'create', releaseAt: next.releaseAt },
    );
  }
  if (STARTED.has(existing.status)) return ok({ action: 'keep', reason: 'already_started' });
  if (next.releaseAt === null) return ok({ action: 'cancel' });
  if (next.releaseAt.getTime() === existing.releaseAt.getTime()) {
    return ok({ action: 'keep', reason: 'unchanged' });
  }
  return ok({ action: 'replace', releaseAt: next.releaseAt });
}
