// School payout batches (spec P17: statuses accrued, approved, paid, failed, adjusted; recipient
// verification; no duplicate submission; external transfer references; transfers disabled in
// development). Accrual does not mean payment.
import type { Cents } from '../shared/money.ts';
import { err, ok, assertNever, type Result } from '../shared/result.ts';
import { parseCalendarMonth, type CalendarMonth } from '../shared/time.ts';
import { DONATION_CENTS } from './eligibility.ts';
import { assertId, containsHiddenCharacters, hasReadableContent } from './validation.ts';

export const PAYOUT_STATUSES = ['accrued', 'approved', 'paid', 'failed', 'adjusted'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_ERROR_CODES = [
  'RECIPIENT_NOT_VERIFIED',
  'TRANSFERS_DISABLED',
  'MISSING_TRANSFER_REFERENCE',
  'INVALID_TRANSFER_REFERENCE',
  'INVALID_TRANSITION',
] as const;
export type PayoutErrorCode = (typeof PAYOUT_ERROR_CODES)[number];
export type BuildPayoutErrorCode = Extract<
  PayoutErrorCode,
  'RECIPIENT_NOT_VERIFIED' | 'TRANSFERS_DISABLED'
>;

/** An unpaid accrual approved for payout to this school. */
export interface PayoutAccrualInput {
  readonly id: string;
  readonly schoolId: string;
  readonly donationMonth: CalendarMonth;
  readonly amountCents: number;
}

/** An adjustment not yet applied to any payout (e.g. a reversal carried forward after payment). */
export interface PayoutAdjustmentInput {
  readonly idempotencyKey: string;
  readonly accrualId: string;
  readonly schoolId: string;
  readonly amountCents: number;
}

export type PayoutLine =
  | {
      readonly kind: 'accrual';
      readonly accrualId: string;
      readonly donationMonth: CalendarMonth;
      readonly amountCents: Cents;
    }
  | {
      readonly kind: 'adjustment';
      readonly adjustmentKey: string;
      readonly accrualId: string;
      readonly amountCents: Cents;
    };

export interface PayoutPreviewInput {
  readonly schoolId: string;
  /** Stable batch key; it is also the transfer idempotency key for every submission attempt. */
  readonly batchKey: string;
  readonly accruals: readonly PayoutAccrualInput[];
  readonly adjustments: readonly PayoutAdjustmentInput[];
}

export interface PayoutPreview {
  readonly schoolId: string;
  readonly batchKey: string;
  readonly totalCents: Cents;
  /** Accrual lines by (donationMonth, id), then adjustment lines by key: a stable reconciliation. */
  readonly lines: readonly PayoutLine[];
}

export interface BuildPayoutBatchInput extends PayoutPreviewInput {
  readonly recipientVerified: boolean;
  readonly transfersEnabled: boolean;
}

export type PayoutBatchPlan =
  | (PayoutPreview & { readonly status: 'accrued' })
  /** Total <= 0: no transfer; the lines stay unapplied and roll into the next batch. */
  | (PayoutPreview & { readonly status: 'carried_forward' });

/**
 * Computes a school's payout lines and total without any gating (admin "owed" view; works while
 * transfers are disabled). Throws on cross-school lines, duplicates or non-$1 amounts.
 */
export function previewPayoutBatch(input: PayoutPreviewInput): PayoutPreview {
  assertId(input.schoolId, 'schoolId');
  assertId(input.batchKey, 'batchKey');
  const accrualIds = new Set<string>();
  for (const a of input.accruals) {
    assertId(a.id, 'accrual.id');
    parseCalendarMonth(a.donationMonth);
    if (a.schoolId !== input.schoolId) {
      throw new RangeError(`Accrual ${a.id} belongs to another school`);
    }
    if (a.amountCents !== DONATION_CENTS) {
      throw new RangeError(`Accrual ${a.id} must be exactly ${DONATION_CENTS} cents`);
    }
    if (accrualIds.has(a.id)) throw new RangeError(`Duplicate accrual ${a.id} in payout batch`);
    accrualIds.add(a.id);
  }
  const adjustmentKeys = new Set<string>();
  for (const adj of input.adjustments) {
    assertId(adj.idempotencyKey, 'adjustment.idempotencyKey');
    assertId(adj.accrualId, 'adjustment.accrualId');
    if (adj.schoolId !== input.schoolId) {
      throw new RangeError(`Adjustment ${adj.idempotencyKey} belongs to another school`);
    }
    if (adj.amountCents !== DONATION_CENTS && adj.amountCents !== -DONATION_CENTS) {
      throw new RangeError(`Adjustment ${adj.idempotencyKey} must be ±${DONATION_CENTS} cents`);
    }
    if (adjustmentKeys.has(adj.idempotencyKey)) {
      throw new RangeError(`Duplicate adjustment ${adj.idempotencyKey} in payout batch`);
    }
    adjustmentKeys.add(adj.idempotencyKey);
  }

  const accrualLines: PayoutLine[] = [...input.accruals]
    .sort((a, b) => compareText(a.donationMonth, b.donationMonth) || compareText(a.id, b.id))
    .map((a) => ({
      kind: 'accrual',
      accrualId: a.id,
      donationMonth: a.donationMonth,
      amountCents: a.amountCents,
    }));
  const adjustmentLines: PayoutLine[] = [...input.adjustments]
    .sort((a, b) => compareText(a.idempotencyKey, b.idempotencyKey))
    .map((adj) => ({
      kind: 'adjustment',
      adjustmentKey: adj.idempotencyKey,
      accrualId: adj.accrualId,
      amountCents: adj.amountCents,
    }));
  const lines = [...accrualLines, ...adjustmentLines];
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return { schoolId: input.schoolId, batchKey: input.batchKey, totalCents, lines };
}

/**
 * Builds a payable batch in status `accrued`.
 *
 * Decision: a total <= 0 returns `carried_forward` before any gate is checked, because no
 * transfer will happen. A positive total requires a verified recipient (RECIPIENT_NOT_VERIFIED)
 * and enabled transfers (TRANSFERS_DISABLED, the development default): a batch is only created
 * when it could actually be submitted, so no payable batch can exist for an unverified school.
 */
export function buildPayoutBatch(
  input: BuildPayoutBatchInput,
): Result<PayoutBatchPlan, BuildPayoutErrorCode> {
  const preview = previewPayoutBatch(input);
  if (preview.totalCents <= 0) return ok({ ...preview, status: 'carried_forward' });
  if (!input.recipientVerified) {
    return err('RECIPIENT_NOT_VERIFIED', 'The school payout recipient has not been verified');
  }
  if (!input.transfersEnabled) {
    return err('TRANSFERS_DISABLED', 'School transfers are disabled in this environment');
  }
  return ok({ ...preview, status: 'accrued' });
}

export type PayoutEvent =
  | {
      readonly type: 'approve';
      readonly batchKey: string;
      readonly recipientVerified: boolean;
      readonly transfersEnabled: boolean;
    }
  | { readonly type: 'mark_paid'; readonly transferReference: string }
  | { readonly type: 'mark_failed' }
  | { readonly type: 'adjust' };

export type PayoutTransition =
  /** Submit the transfer with `transferIdempotencyKey` (= batchKey on every attempt). */
  | { readonly status: 'approved'; readonly transferIdempotencyKey: string }
  | { readonly status: 'paid'; readonly transferReference: string }
  | { readonly status: 'failed' }
  | { readonly status: 'adjusted' };

const MAX_TRANSFER_REFERENCE_LENGTH = 200;

/**
 * Payout state machine:
 *   accrued --approve--> approved --mark_paid--> paid --adjust--> adjusted (--adjust--> adjusted)
 *                        approved --mark_failed--> failed --approve--> approved (retry)
 *
 * Approval (including a retry) re-checks recipient verification and the transfer switch, and
 * always returns the batch key as the transfer idempotency key: a retry after a failure or an
 * ambiguous timeout resubmits the SAME transfer, so it can never become a second transfer.
 * Approving an approved/paid/adjusted batch is INVALID_TRANSITION (no duplicate submission).
 * Marking paid requires the external transfer reference.
 * Decision: the reference is the audit record of the transfer, so it must be readable as stored.
 * One with no letter or digit once invisible characters are ignored (e.g. only U+200B) is
 * MISSING_TRANSFER_REFERENCE; one that contains control or invisible characters anywhere, or is
 * longer than 200 characters, is INVALID_TRANSFER_REFERENCE (RV-donations-3). Nothing is stripped
 * silently: only surrounding whitespace is trimmed.
 * Decision: `adjusted --adjust--> adjusted` is allowed so several post-payment adjustments can be
 * recorded against one paid batch; paid history itself is never rewritten.
 */
export function transitionPayout(
  status: PayoutStatus,
  event: PayoutEvent,
): Result<PayoutTransition, PayoutErrorCode> {
  const invalid = () =>
    err('INVALID_TRANSITION', `Cannot ${event.type} a payout batch in status ${status}`, {
      status,
      event: event.type,
    });
  switch (event.type) {
    case 'approve': {
      if (status !== 'accrued' && status !== 'failed') return invalid();
      assertId(event.batchKey, 'batchKey');
      if (!event.recipientVerified) {
        return err('RECIPIENT_NOT_VERIFIED', 'The school payout recipient has not been verified');
      }
      if (!event.transfersEnabled) {
        return err('TRANSFERS_DISABLED', 'School transfers are disabled in this environment');
      }
      return ok({ status: 'approved', transferIdempotencyKey: event.batchKey });
    }
    case 'mark_paid': {
      if (status !== 'approved') return invalid();
      const reference = event.transferReference.trim();
      if (!hasReadableContent(reference)) {
        return err('MISSING_TRANSFER_REFERENCE', 'An external transfer reference is required');
      }
      if (reference.length > MAX_TRANSFER_REFERENCE_LENGTH || containsHiddenCharacters(reference)) {
        return err('INVALID_TRANSFER_REFERENCE', 'The transfer reference is malformed');
      }
      return ok({ status: 'paid', transferReference: reference });
    }
    case 'mark_failed':
      return status === 'approved' ? ok({ status: 'failed' }) : invalid();
    case 'adjust':
      return status === 'paid' || status === 'adjusted' ? ok({ status: 'adjusted' }) : invalid();
    default:
      return assertNever(event, 'payout event');
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
