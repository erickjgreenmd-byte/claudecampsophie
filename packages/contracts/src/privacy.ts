// Contracts for deletion, export and safety-report routes (spec P4, P8, P10, P14, E4 Deletion;
// AC_ACCESS_10, AC_SECURITY_01, AC_SECURITY_05, AC_LEARNING_10). Owned by the privacy vertical.
//
// Requests are strict (unknown keys are rejected, so no family id, role, child id of another family
// or "include answers" switch can ride along). Responses are strict so a server change that adds a
// private field fails loudly in the client instead of being rendered.
import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common.ts';

// ---------------------------------------------------------------------------------------------
// Documented retention (mirrors migrations 0600/0620 and the public privacy page)
// ---------------------------------------------------------------------------------------------

export const PRIVACY_RETENTION = {
  /** Default raw homework-scan retention (spec P4). */
  rawScanDays: 30,
  /** Active-store deletion target after a request (spec P4: 30 days maximum proposed). */
  deletionTargetDays: 30,
} as const;

/** Stable `rule` codes returned with 403/422 by the privacy API. */
export const PRIVACY_RULES = {
  ownerOnlyFamilyDeletion: 'OWNER_ONLY_FAMILY_DELETION',
  childDeletionPending: 'CHILD_DELETION_PENDING',
  invalidTransition: 'INVALID_TRANSITION',
  resolutionNoteRequired: 'RESOLUTION_NOTE_REQUIRED',
} as const;

// ---------------------------------------------------------------------------------------------
// Deletion (spec P4, E4 Deletion)
// ---------------------------------------------------------------------------------------------

export const deletionScopeSchema = z.enum(['family', 'child']);
export type DeletionScope = z.infer<typeof deletionScopeSchema>;

export const deletionStatusSchema = z.enum(['requested', 'processing', 'completed', 'cancelled']);
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;

/** POST /v1/deletion. `childId` is required for a child deletion and forbidden for a family one. */
export const createDeletionRequestSchema = z
  .strictObject({
    scope: deletionScopeSchema,
    childId: uuidSchema.optional(),
  })
  .refine((v) => (v.scope === 'child') === (v.childId !== undefined), {
    message: 'childId is required for a child deletion and not allowed for a family deletion',
    path: ['childId'],
  });
export type CreateDeletionRequest = z.infer<typeof createDeletionRequestSchema>;

export const deletionRequestSchema = z.strictObject({
  id: uuidSchema,
  scope: deletionScopeSchema,
  /** The deleted child's pseudonymous id (kept after purge); null for a family deletion. */
  childId: uuidSchema.nullable(),
  status: deletionStatusSchema,
  requestedAt: isoDateTimeSchema,
  /** Active-store deletion completes by this instant (documented 30-day target). */
  completeBy: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});
export type DeletionRequest = z.infer<typeof deletionRequestSchema>;

export const deletionRequestResponseSchema = z.strictObject({ deletion: deletionRequestSchema });
export const deletionRequestsResponseSchema = z.strictObject({
  requests: z.array(deletionRequestSchema),
});
export type DeletionRequests = z.infer<typeof deletionRequestsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Private exports (spec P8, P10; AC_LEARNING_10 request side)
// ---------------------------------------------------------------------------------------------

export const EXPORT_KINDS = [
  'family_data',
  'progress_pdf',
  'progress_csv',
  'review_questions_pdf',
  'review_answer_key_pdf',
] as const;
export const exportKindSchema = z.enum(EXPORT_KINDS);
export type ExportKind = z.infer<typeof exportKindSchema>;

/**
 * Kinds accepted by POST /v1/exports. The answer key is deliberately absent: spec P8 requires a
 * distinct protected route (POST /v1/exports/answer-key), and there is no parameter on the
 * questions-only export that could switch a key on.
 */
export const STANDARD_EXPORT_KINDS = [
  'family_data',
  'progress_pdf',
  'progress_csv',
  'review_questions_pdf',
] as const;
export const standardExportKindSchema = z.enum(STANDARD_EXPORT_KINDS);
export type StandardExportKind = z.infer<typeof standardExportKindSchema>;

/** Kinds that describe one child's Thursday review and therefore need a child. */
export const CHILD_REQUIRED_EXPORT_KINDS: readonly ExportKind[] = [
  'review_questions_pdf',
  'review_answer_key_pdf',
];

export const createExportRequestSchema = z
  .strictObject({
    kind: standardExportKindSchema,
    childId: uuidSchema.optional(),
  })
  .refine((v) => !CHILD_REQUIRED_EXPORT_KINDS.includes(v.kind) || v.childId !== undefined, {
    message: 'Choose a child for a review export',
    path: ['childId'],
  });
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

/** POST /v1/exports/answer-key: the parent-only answer key for one child's review. */
export const createAnswerKeyExportRequestSchema = z.strictObject({ childId: uuidSchema });
export type CreateAnswerKeyExportRequest = z.infer<typeof createAnswerKeyExportRequestSchema>;

export const exportStatusSchema = z.enum(['queued', 'ready', 'failed', 'expired']);
export type ExportStatus = z.infer<typeof exportStatusSchema>;

/** An export as the family sees it. Storage paths are never returned. */
export const dataExportSchema = z.strictObject({
  id: uuidSchema,
  kind: exportKindSchema,
  childId: uuidSchema.nullable(),
  status: exportStatusSchema,
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.nullable(),
});
export type DataExport = z.infer<typeof dataExportSchema>;

export const dataExportResponseSchema = z.strictObject({ export: dataExportSchema });
export const dataExportsResponseSchema = z.strictObject({ exports: z.array(dataExportSchema) });
export type DataExports = z.infer<typeof dataExportsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Safety reports (spec P4 help/report button and adult report management; AC_SECURITY_01)
// ---------------------------------------------------------------------------------------------

export const SAFETY_REPORT_CATEGORIES = [
  'unsafe_content',
  'wrong_or_confusing',
  'upsetting',
  'answer_revealed',
  'other',
] as const;
export const safetyReportCategorySchema = z.enum(SAFETY_REPORT_CATEGORIES);
export type SafetyReportCategory = z.infer<typeof safetyReportCategorySchema>;

/** Categories a child can choose ("Something upsetting", "This seems wrong", …). */
export const CHILD_REPORT_CATEGORIES = [
  'upsetting',
  'wrong_or_confusing',
  'answer_revealed',
  'other',
] as const;
export const childReportCategorySchema = z.enum(CHILD_REPORT_CATEGORIES);
export type ChildReportCategory = z.infer<typeof childReportCategorySchema>;

export const safetyReportStatusSchema = z.enum(['open', 'triaged', 'escalated', 'resolved']);
export type SafetyReportStatus = z.infer<typeof safetyReportStatusSchema>;

export const SAFETY_NOTE_MAX_LENGTH = 500;
export const RESOLUTION_NOTE_MAX_LENGTH = 1000;

/** POST /v1/safety-reports (parent). The family and reporter are derived server-side. */
export const createSafetyReportRequestSchema = z.strictObject({
  category: safetyReportCategorySchema,
  questionId: uuidSchema.optional(),
  note: z.string().trim().min(1).max(SAFETY_NOTE_MAX_LENGTH).optional(),
});
export type CreateSafetyReportRequest = z.infer<typeof createSafetyReportRequestSchema>;

/** A report as the family's guardians see it. */
export const safetyReportSchema = z.strictObject({
  id: uuidSchema,
  reporterKind: z.enum(['child', 'parent']),
  category: safetyReportCategorySchema,
  childId: uuidSchema.nullable(),
  questionId: uuidSchema.nullable(),
  note: z.string().nullable(),
  status: safetyReportStatusSchema,
  createdAt: isoDateTimeSchema,
  triagedAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
});
export type SafetyReport = z.infer<typeof safetyReportSchema>;

export const safetyReportResponseSchema = z.strictObject({ report: safetyReportSchema });
export const safetyReportsResponseSchema = z.strictObject({
  reports: z.array(safetyReportSchema),
});
export type SafetyReports = z.infer<typeof safetyReportsResponseSchema>;

/** POST /v1/child/reports. The child and family come from the child session, never the body. */
export const childReportRequestSchema = z.strictObject({
  category: childReportCategorySchema,
  questionId: uuidSchema.optional(),
  feedbackId: uuidSchema.optional(),
});
export type ChildReportRequest = z.infer<typeof childReportRequestSchema>;

/** Calm acknowledgement. It never claims that a parent was alerted (spec P4). */
export const childReportResponseSchema = z.strictObject({
  received: z.literal(true),
  message: z.string().max(200),
});
export type ChildReportResponse = z.infer<typeof childReportResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Owner admin report queue: ids, category, status and timestamps only — never homework text,
// child nicknames or the parent's free-text note (it may quote homework).
// ---------------------------------------------------------------------------------------------

export const adminSafetyReportSchema = z.strictObject({
  id: uuidSchema,
  familyId: uuidSchema,
  childId: uuidSchema.nullable(),
  reporterKind: z.enum(['child', 'parent']),
  category: safetyReportCategorySchema,
  questionId: uuidSchema.nullable(),
  feedbackId: uuidSchema.nullable(),
  hasNote: z.boolean(),
  status: safetyReportStatusSchema,
  createdAt: isoDateTimeSchema,
  triagedAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolutionNote: z.string().nullable(),
});
export type AdminSafetyReport = z.infer<typeof adminSafetyReportSchema>;

export const adminSafetyReportsResponseSchema = z.strictObject({
  reports: z.array(adminSafetyReportSchema),
});
export const adminSafetyReportResponseSchema = z.strictObject({ report: adminSafetyReportSchema });

export const updateSafetyReportRequestSchema = z.strictObject({
  status: z.enum(['triaged', 'escalated', 'resolved']),
  resolutionNote: z.string().trim().min(1).max(RESOLUTION_NOTE_MAX_LENGTH).optional(),
});
export type UpdateSafetyReportRequest = z.infer<typeof updateSafetyReportRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Minimal view of GET /v1/family used by the privacy screens (child picker for deletion/exports).
// Decision: non-strict on purpose — the family vertical owns that response, and unknown fields are
// stripped (never rendered) rather than coupling privacy screens to every family field.
// ---------------------------------------------------------------------------------------------

export const privacyFamilyViewSchema = z.object({
  id: uuidSchema,
  children: z.array(
    z.object({
      id: uuidSchema,
      nickname: z.string(),
      status: z.string(),
    }),
  ),
});
export type PrivacyFamilyView = z.infer<typeof privacyFamilyViewSchema>;
