import { z } from 'zod';
import {
  SUPPORT_CASE_KINDS,
  SUPPORT_CASE_PRIORITIES,
  SUPPORT_CASE_RESOLUTIONS,
  SUPPORT_CASE_STATUSES,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFERENCE_MAX_LENGTH,
  SUPPORT_SUBJECT_MAX_LENGTH,
} from '@pencillift/domain/ops';
import { channelSchema, freeTextSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

// Support cases between a family and the owner's staff (parent-facing routes under /v1/support).
// A case is about the family's account, plan or the app, never about a child: the intake copy
// tells parents so, the server caps lengths, and no case links a child, a question or a feedback
// row. Refunds are issued by the stores, never by PencilLift; a refund request names one of the
// family's own provider billing periods so what the provider later reports can be shown on it.

export { SUPPORT_MESSAGE_MAX_LENGTH, SUPPORT_REFERENCE_MAX_LENGTH, SUPPORT_SUBJECT_MAX_LENGTH };

export const supportCaseKindSchema = z.enum(SUPPORT_CASE_KINDS);
export type SupportCaseKind = z.infer<typeof supportCaseKindSchema>;
export const supportCaseStatusSchema = z.enum(SUPPORT_CASE_STATUSES);
export type SupportCaseStatus = z.infer<typeof supportCaseStatusSchema>;
export const supportCasePrioritySchema = z.enum(SUPPORT_CASE_PRIORITIES);
export type SupportCasePriority = z.infer<typeof supportCasePrioritySchema>;
export const supportCaseResolutionSchema = z.enum(SUPPORT_CASE_RESOLUTIONS);
export type SupportCaseResolution = z.infer<typeof supportCaseResolutionSchema>;
export const supportAuthorKindSchema = z.enum(['parent', 'admin']);
export type SupportAuthorKind = z.infer<typeof supportAuthorKindSchema>;

/**
 * What a provider billing period's money IS (public.billing_periods.kind). It is not decoration: one
 * renewal invoice can write TWO rows — its subscription charge, and, when the provider listed a
 * mid-cycle change on it as pending, a derived '<invoice>:proration' row that holds the money
 * collected for that item. The derived row is spread from the subscription period, so it repeats that
 * period's dates and paid_slots and differs only in its provider id, this kind and its amount
 * (HUNT7-C-3). Without the kind a parent's picker showed two entries for the same dates with nothing
 * to tell them apart, and picking the wrong one linked their case to the wrong row's figures. The
 * admin contract has carried this enum since the row existed; the parent's did not.
 */
export const billingPeriodKindSchema = z.enum([
  'subscription_period',
  'proration',
  'addon',
  'tax_only',
]);
export type BillingPeriodKind = z.infer<typeof billingPeriodKindSchema>;

/**
 * What a parent-facing surface calls each kind, lower case so it composes inside a label. ONE wording
 * for the portal and the app: the round-6 divergence this fixes was a row that reached one surface's
 * label and not the other's, so both read these from here rather than each spelling their own.
 */
export const SUPPORT_BILLING_PERIOD_KIND_LABELS: Readonly<Record<BillingPeriodKind, string>> = {
  subscription_period: 'subscription charge',
  proration: 'mid-cycle adjustment',
  addon: 'add-on charge',
  tax_only: 'tax-only charge',
};

/**
 * The words a parent needs BESIDE the amount when the row is not an ordinary subscription charge, and
 * null when it is (a subscription charge needs no qualifier; saying so on every row is noise).
 */
export function supportBillingPeriodKindNote(kind: BillingPeriodKind): string | null {
  return kind === 'subscription_period' ? null : SUPPORT_BILLING_PERIOD_KIND_LABELS[kind];
}

/**
 * How a surface names money that is NOT a charge for the period's dates: it was billed WITH that
 * charge. `chargeDate` is already formatted by the surface (the portal and the app format dates
 * differently, and the app formats in the family's own zone), and `note` comes from
 * `supportBillingPeriodKindNote`. Saying "Sep 19 – Oct 19 · $10.00" of a DERIVED mid-cycle item states
 * something false about it — that $10 covers a part of the PREVIOUS period, and it is not a charge for
 * a number of children either.
 *
 * Use it only where `derivedFromProviderPeriodId` is non-null. A row that is its own invoice — a
 * standalone mid-cycle adjustment, an add-on, a tax-only charge — has its own dates, and this label
 * would both assert a billing relationship it does not have and throw those dates away.
 */
export function supportDerivedChargeLabel(note: string, chargeDate: string): string {
  return `${note} billed with the ${chargeDate} charge`;
}

/** Settlement states of a provider billing period (public.billing_periods.settlement). */
export const billingSettlementSchema = z.enum([
  'pending',
  'settled',
  'failed',
  'refunded',
  'partially_refunded',
  'chargeback',
]);
export type BillingSettlement = z.infer<typeof billingSettlementSchema>;

/** Shown above the intake form and the reply box (portal and app). */
export const SUPPORT_INTAKE_NOTICE =
  'Tell us about your account, your plan or the app. Please don’t include your child’s name, homework text or answers.';

/** Shown on a refund request: PencilLift never moves money for a store purchase. */
export const SUPPORT_REFUND_NOTICE =
  'App Store, Google Play and Amazon Appstore refunds are issued by the store, not by PencilLift. We’ll point you to the store’s refund path and update this case when the store reports the refund.';

export const SUPPORT_CASE_KIND_LABELS: Readonly<Record<SupportCaseKind, string>> = {
  complaint: 'Complaint',
  refund_request: 'Refund request',
  billing_issue: 'Billing issue',
  bug: 'Something isn’t working',
  safety_question: 'Safety question',
  other: 'Something else',
};

export const SUPPORT_CASE_STATUS_LABELS: Readonly<Record<SupportCaseStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_parent: 'Waiting on you',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const SUPPORT_CASE_RESOLUTION_LABELS: Readonly<Record<SupportCaseResolution, string>> = {
  answered: 'Answered',
  fixed: 'Fixed',
  refunded_by_store: 'Refunded by the store',
  stripe_refund_issued: 'Refunded (web billing)',
  no_refund: 'No refund',
  duplicate: 'Duplicate of another case',
};

const subjectSchema = freeTextSchema({ max: SUPPORT_SUBJECT_MAX_LENGTH });
const messageBodySchema = freeTextSchema({ max: SUPPORT_MESSAGE_MAX_LENGTH });

/** Natural key of a provider billing period (public.billing_periods unique (channel, provider_period_id)). */
export const supportBillingPeriodRefSchema = z.strictObject({
  channel: channelSchema,
  providerPeriodId: z.string().min(1).max(200),
});
export type SupportBillingPeriodRef = z.infer<typeof supportBillingPeriodRefSchema>;

/** A family's own billing period as the parent picks it for a refund request, and as the case shows it. */
export const supportBillingPeriodSchema = z.strictObject({
  id: uuidSchema,
  channel: channelSchema,
  providerPeriodId: z.string().min(1).max(200),
  /** What this row's money is; a derived 'proration' row repeats a subscription period's dates. */
  kind: billingPeriodKindSchema,
  /**
   * Set ONLY when this row's money was billed with ANOTHER row's charge, and then it is that row's
   * provider id. The API states it because the API created the row; a surface must never infer it from
   * `kind` or from the shape of `providerPeriodId` (HUNT7-C-3, the checker's finding on the first fix):
   * a mid-cycle adjustment can equally arrive as an invoice of its OWN, with its own dates, and
   * "billed with the <date> charge" is false of that one. `addon` and `tax_only` rows are their own
   * invoices too. Null means this row's own dates are the truth about it.
   */
  derivedFromProviderPeriodId: z.string().min(1).max(200).nullable(),
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  paidSlots: z.number().int().min(1).max(12),
  chargedCents: z.number().int().min(0),
  /** What the provider has reported refunded so far (0 until the store reports a refund). */
  refundedCents: z.number().int().min(0),
  settlement: billingSettlementSchema,
});
export type SupportBillingPeriod = z.infer<typeof supportBillingPeriodSchema>;

/** GET /v1/support/billing-periods: the family's periods, newest first (empty without a purchase). */
export const supportBillingPeriodsResponseSchema = z.strictObject({
  periods: z.array(supportBillingPeriodSchema),
});
export type SupportBillingPeriodsResponse = z.infer<typeof supportBillingPeriodsResponseSchema>;

/** POST /v1/support/cases. The family and the author are derived server-side. */
export const createSupportCaseRequestSchema = z
  .strictObject({
    kind: supportCaseKindSchema,
    subject: subjectSchema,
    message: messageBodySchema,
    /** A refund request may name one of the family's own billing periods (from GET billing-periods). */
    billingPeriodId: uuidSchema.optional(),
  })
  .refine((body) => body.kind === 'refund_request' || body.billingPeriodId === undefined, {
    message: 'Only a refund request names a billing period',
    path: ['billingPeriodId'],
  });
export type CreateSupportCaseRequest = z.infer<typeof createSupportCaseRequestSchema>;

/** POST /v1/support/cases/:id/messages (allowed while the case is not closed). */
export const replySupportCaseRequestSchema = z.strictObject({ message: messageBodySchema });
export type ReplySupportCaseRequest = z.infer<typeof replySupportCaseRequestSchema>;

/** A thread message as the family sees it: staff internal notes are never included. */
export const supportCaseMessageSchema = z.strictObject({
  id: uuidSchema,
  authorKind: supportAuthorKindSchema,
  body: z.string().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
  createdAt: isoDateTimeSchema,
});
export type SupportCaseMessage = z.infer<typeof supportCaseMessageSchema>;

const supportCaseShape = {
  id: uuidSchema,
  kind: supportCaseKindSchema,
  status: supportCaseStatusSchema,
  subject: z.string().min(1).max(SUPPORT_SUBJECT_MAX_LENGTH),
  body: z.string().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
  /** The linked billing period of a refund request, with what the provider reports; else null. */
  billingPeriod: supportBillingPeriodSchema.nullable(),
  resolution: supportCaseResolutionSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  /** False once the case is closed. */
  canReply: z.boolean(),
  /** Non-internal messages on the thread (the opening message is `body`, not a message). */
  messageCount: z.number().int().min(0),
} as const;

export const supportCaseSchema = z.strictObject(supportCaseShape);
export type SupportCase = z.infer<typeof supportCaseSchema>;

export const supportCaseDetailSchema = z.strictObject({
  ...supportCaseShape,
  messages: z.array(supportCaseMessageSchema),
});
export type SupportCaseDetail = z.infer<typeof supportCaseDetailSchema>;

/** GET /v1/support/cases: the family's cases, newest first. */
/**
 * GET /v1/support/policy: what a parent may know of the owner's support policy — the refund window
 * and the response-time targets; nothing about how the owner decides.
 */
export const parentSupportPolicyResponseSchema = z.strictObject({
  refundWindowDays: z.number().int().min(1).max(90),
  responseTargetHours: z.record(supportCaseKindSchema, z.number().int().min(1).max(336)),
  refundWindowSentence: z.string().min(1).max(400),
});
export type ParentSupportPolicyResponse = z.infer<typeof parentSupportPolicyResponseSchema>;

export const supportCasesResponseSchema = z.strictObject({ cases: z.array(supportCaseSchema) });
export type SupportCasesResponse = z.infer<typeof supportCasesResponseSchema>;

/** POST /v1/support/cases (201), GET /v1/support/cases/:id and POST .../messages (200). */
export const supportCaseResponseSchema = z.strictObject({ case: supportCaseDetailSchema });
export type SupportCaseResponse = z.infer<typeof supportCaseResponseSchema>;
