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
import { channelSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

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

const subjectSchema = z.string().trim().min(1).max(SUPPORT_SUBJECT_MAX_LENGTH);
const messageBodySchema = z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH);

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
export const supportCasesResponseSchema = z.strictObject({ cases: z.array(supportCaseSchema) });
export type SupportCasesResponse = z.infer<typeof supportCasesResponseSchema>;

/** POST /v1/support/cases (201), GET /v1/support/cases/:id and POST .../messages (200). */
export const supportCaseResponseSchema = z.strictObject({ case: supportCaseDetailSchema });
export type SupportCaseResponse = z.infer<typeof supportCaseResponseSchema>;
