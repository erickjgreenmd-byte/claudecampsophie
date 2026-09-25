// Contracts for deletion, export and safety-report routes (spec P4, P8, P10, P14, E4 Deletion;
// AC_ACCESS_10, AC_SECURITY_01, AC_SECURITY_05, AC_LEARNING_10). Owned by the privacy vertical.
//
// Requests are strict (unknown keys are rejected, so no family id, role, child id of another family
// or "include answers" switch can ride along). Responses are strict so a server change that adds a
// private field fails loudly in the client instead of being rendered.
import { z } from 'zod';
import { freeTextSchema, isoDateTimeSchema, uuidSchema } from './common.ts';

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
  /** Only a system report (the safety screen's flag) can be cleared as a false match. */
  falseMatchSystemOnly: 'FALSE_MATCH_SYSTEM_ONLY',
  /** A held flag cleared as a false match is never released to the family (runbook 5.1). */
  falseMatchNotReleasable: 'FALSE_MATCH_NOT_RELEASABLE',
  /** The flagged question's scan is still being checked; clear the flag once it is ready. */
  scanStillChecking: 'SCAN_STILL_CHECKING',
  /** A parent's action on a report that is already resolved (by a guardian or a reviewer); 409. */
  reportAlreadyResolved: 'REPORT_ALREADY_RESOLVED',
  /** A parent's action applies to a flag or a child's report, not to the parent's own report. */
  parentActionNotForReport: 'PARENT_ACTION_NOT_FOR_REPORT',
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

/**
 * Categories only PencilLift's safety screen files (migration 0760: `reporter_kind = 'system'`).
 * They are never offered to, or accepted from, a parent or child.
 */
export const SYSTEM_SAFETY_REPORT_CATEGORIES = ['severe_risk'] as const;

/** Every category a listed report can carry. */
export const LISTED_SAFETY_REPORT_CATEGORIES = [
  ...SAFETY_REPORT_CATEGORIES,
  ...SYSTEM_SAFETY_REPORT_CATEGORIES,
] as const;
export const listedSafetyReportCategorySchema = z.enum(LISTED_SAFETY_REPORT_CATEGORIES);
export type ListedSafetyReportCategory = z.infer<typeof listedSafetyReportCategorySchema>;

/** Who filed a report. `system`: the safety screen flagged a child's answer (never a client). */
export const safetyReportReporterKindSchema = z.enum(['child', 'parent', 'system']);
export type SafetyReportReporterKind = z.infer<typeof safetyReportReporterKindSchema>;

/**
 * Screen category codes a system report may carry (mirrors the 0760 check and the child-text
 * categories of @pencillift/domain/safety). Shown to the owner admin only, never to the family.
 */
export const SAFETY_SCREEN_REPORT_CATEGORIES = [
  'self_harm',
  'abuse',
  'violence',
  'sexual',
  'secrecy',
  'personal_contact',
] as const;
export const safetyScreenReportCategorySchema = z.enum(SAFETY_SCREEN_REPORT_CATEGORIES);

/**
 * Parent-facing wording for a system report in the family's report list (spec P4; AC_SECURITY_02).
 * DRAFT: the owner and an educator must approve it before launch, with the child templates
 * (@pencillift/domain/safety SAFETY_TEMPLATES_STATUS). It lives here, not in the domain module, so
 * the parent web bundle never loads the safety screen's rules.
 *
 * Honest by construction (AC_SECURITY_02 "notification claims match actual deliveries"): it states
 * what the product does, never what the child saw (opening the results is not recorded), and
 * whether the guardian email a flag sends was accepted (`emailSent`), not sent (`emailNotSent`) or
 * refused by the provider (`emailFailed`) is taken from the recorded delivery (migration 0790),
 * never assumed. It does not name the kind of concern.
 *
 * Owner decision (2026-09-25): the parent is the only person PencilLift sends a safety message
 * to, and the parent addresses the concern. No flag is held from this list; every flag is emailed
 * to the active guardians, and a guardian can mark it looked into (`addressed`) or a false alarm
 * (`cleared`, the same clearing as a reviewer's).
 */
export const PARENT_SAFETY_FLAG_COPY = {
  category: 'Answer flagged for a grown-up',
  reporter: 'Flagged by PencilLift',
  summary:
    'PencilLift flagged an answer for a grown-up to look at. For that question, your child’s results show a calm message about talking with a grown-up they trust instead of a hint, and PencilLift gives no hints on it. Please check in with your child.',
  /** The recorded delivery: at least one active guardian's address accepted the flag email. */
  emailSent:
    'PencilLift emailed the guardians on this account about this flag when it was filed, so they know to look here. The email names no child, no question and no kind of concern.',
  /**
   * No email left PencilLift for this report (a flag's email has not been sent yet or no guardian
   * address exists; nothing is sent for a child's or a parent's report).
   */
  emailNotSent: 'No email has been sent about this report; this list is where it appears.',
  /** The email provider refused every guardian address (recorded; a bounded retry follows). */
  emailFailed:
    'PencilLift tried to email the guardians on this account about this flag, but the email could not be sent; this list is where it appears.',
  resources:
    'If your child may be in danger, call 911. Support is available any time from the 988 Suicide & Crisis Lifeline (call or text 988) and the Childhelp National Child Abuse Hotline (1-800-422-4453).',
  /**
   * A guardian marked the flag looked into ("I've looked into this"). The child's notice for that
   * question stays and PencilLift keeps giving no hints on it: nothing changes for the child.
   */
  addressed:
    'A guardian on this account looked into this flag. Your child’s results keep showing the message about talking with a grown-up for that question, and PencilLift still gives no hints on it.',
  /** A guardian marked a child's own report looked into (nothing changes for the child). */
  childReportAddressed: 'A guardian on this account looked into this report.',
  /** Under the two actions: the server checks the unlock (spec P3). */
  actionsNeedUnlock: 'Both need a recent parent PIN unlock.',
  /**
   * A flag cleared as a false match, by a guardian ("This was a false alarm") or a reviewer
   * (round 3, CHK2-CS-5). It replaces `summary`, which would no longer be true: the child's results
   * stop showing the message for that question and the question is checked like the rest of the
   * scan.
   */
  cleared:
    'This flag was checked and found not a concern. Your child’s results no longer show the message about talking with a grown-up for that question, and the question is checked like the rest of the scan.',
} as const;

/**
 * The two actions a guardian can take on an unresolved flag (portal and app; both need a recent PIN
 * unlock, and the report must be the family's own). Same wording on every surface. DRAFT with the
 * copy above.
 */
export const PARENT_SAFETY_FLAG_ACTIONS = {
  addressed: {
    label: 'I’ve looked into this',
    effect:
      'Marks the report resolved. Your child’s results keep the message about talking with a grown-up for that question, and PencilLift gives no hints on it.',
  },
  falseMatch: {
    label: 'This was a false alarm, check the question normally',
    effect:
      'Removes the message from your child’s results for that question and has PencilLift check the question like the rest of the scan. Choose this only when you are sure the answer is not a concern.',
  },
} as const;

export const safetyReportStatusSchema = z.enum(['open', 'triaged', 'escalated', 'resolved']);
export type SafetyReportStatus = z.infer<typeof safetyReportStatusSchema>;

/**
 * How a report was resolved, beyond the reviewer's note (migrations 0760 and 0790 `resolution`).
 * `false_match`: the safety screen's word match was wrong for that question and transcription; the
 * child's notice is hidden and the question is graded normally (a reviewer's or a guardian's
 * clearing). `addressed`: a guardian looked into the flag or the child's report; the child's notice
 * stays and no AI runs on that question.
 */
export const SAFETY_REPORT_RESOLUTIONS = ['false_match', 'addressed'] as const;
export const safetyReportResolutionSchema = z.enum(SAFETY_REPORT_RESOLUTIONS);
export type SafetyReportResolution = z.infer<typeof safetyReportResolutionSchema>;

/**
 * PATCH /v1/safety-reports/:id (a guardian; recent PIN unlock; the family's own report).
 * `addressed` resolves a flag or a child's report and changes nothing for the child; `false_match`
 * clears a flag exactly as the reviewer's clearing does (system reports only).
 */
export const PARENT_REPORT_OUTCOMES = ['addressed', 'false_match'] as const;
export const parentReportOutcomeSchema = z.enum(PARENT_REPORT_OUTCOMES);
export type ParentReportOutcome = z.infer<typeof parentReportOutcomeSchema>;

export const parentSafetyReportActionRequestSchema = z.strictObject({
  outcome: parentReportOutcomeSchema,
});
export type ParentSafetyReportActionRequest = z.infer<typeof parentSafetyReportActionRequestSchema>;

/**
 * The recorded state of the guardian email a flag sends (migration 0790): `not_sent` until the job
 * runs or when no guardian address exists, `sent` once at least one address accepted it, `failed`
 * when the provider refused. Always `not_sent` for parent reports (nothing is sent for them).
 */
export const SAFETY_FLAG_EMAIL_STATUSES = ['sent', 'not_sent', 'failed'] as const;
export const safetyFlagEmailStatusSchema = z.enum(SAFETY_FLAG_EMAIL_STATUSES);
export type SafetyFlagEmailStatus = z.infer<typeof safetyFlagEmailStatusSchema>;

export const SAFETY_NOTE_MAX_LENGTH = 500;
export const RESOLUTION_NOTE_MAX_LENGTH = 1000;

/** POST /v1/safety-reports (parent). The family and reporter are derived server-side. */
export const createSafetyReportRequestSchema = z.strictObject({
  category: safetyReportCategorySchema,
  questionId: uuidSchema.optional(),
  note: freeTextSchema({ max: SAFETY_NOTE_MAX_LENGTH }).optional(),
});
export type CreateSafetyReportRequest = z.infer<typeof createSafetyReportRequestSchema>;

/**
 * A report as the family's guardians see it. A system report (`reporterKind: 'system'`,
 * `category: 'severe_risk'`) links the flagged question; it never carries a note or homework text,
 * and which kind of concern the screen matched is not included.
 */
export const safetyReportSchema = z.strictObject({
  id: uuidSchema,
  reporterKind: safetyReportReporterKindSchema,
  category: listedSafetyReportCategorySchema,
  childId: uuidSchema.nullable(),
  questionId: uuidSchema.nullable(),
  note: z.string().nullable(),
  status: safetyReportStatusSchema,
  createdAt: isoDateTimeSchema,
  triagedAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  /**
   * A system report cleared as a false match, by a reviewer or a guardian (show
   * PARENT_SAFETY_FLAG_COPY.cleared, not the summary). Always false for parent and child reports.
   */
  clearedAsFalseMatch: z.boolean(),
  /** When a guardian acted on this report from the portal or the app; null otherwise. */
  parentActionAt: isoDateTimeSchema.nullable(),
  /** The guardian's outcome; null when no guardian acted (a reviewer may still have resolved it). */
  parentOutcome: parentReportOutcomeSchema.nullable(),
  /** When the flag email was accepted for at least one guardian; null otherwise. */
  emailedAt: isoDateTimeSchema.nullable(),
  /** The recorded delivery state of the flag email (never assumed). */
  emailStatus: safetyFlagEmailStatusSchema,
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
// child nicknames or the parent's free-text note (it may quote homework). System reports add the
// screen's category codes so reviewers can follow the right escalation step.
// ---------------------------------------------------------------------------------------------

export const adminSafetyReportSchema = z.strictObject({
  id: uuidSchema,
  familyId: uuidSchema,
  childId: uuidSchema.nullable(),
  reporterKind: safetyReportReporterKindSchema,
  category: listedSafetyReportCategorySchema,
  /** System reports only: the screen's category codes (never the matched text); else null. */
  screenCategories: z.array(safetyScreenReportCategorySchema).nullable(),
  /**
   * False while a report is held from the family's list (migration 0760). Owner decision
   * (2026-09-25): the API never files a held report, so this is true for every report it files;
   * the mechanism and the release stay as a support tool.
   */
  familyVisible: z.boolean(),
  /**
   * System reports only: a grown-up corrected the flagged answer's transcription after the screen
   * read it (the child keeps the safety notice; the corrected text is not in this report). Else false.
   */
  transcriptionCorrected: z.boolean(),
  questionId: uuidSchema.nullable(),
  feedbackId: uuidSchema.nullable(),
  hasNote: z.boolean(),
  status: safetyReportStatusSchema,
  createdAt: isoDateTimeSchema,
  triagedAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolutionNote: z.string().nullable(),
  /**
   * `false_match` once a reviewer or a guardian cleared a flag, `addressed` once a guardian looked
   * into a flag or a child's report; else null.
   */
  resolution: safetyReportResolutionSchema.nullable(),
});
export type AdminSafetyReport = z.infer<typeof adminSafetyReportSchema>;

/** Reports per page of the owner admin queue (oldest first; RV-child-safety-9). */
export const ADMIN_SAFETY_REPORTS_PAGE_SIZE = 200;

/**
 * GET /v1/admin/safety-reports[?status=…][&after=<nextCursor>]. Oldest first; `nextCursor` is set
 * when more reports follow, so every report in the queue can be reached however many are open.
 */
export const adminSafetyReportsResponseSchema = z.strictObject({
  reports: z.array(adminSafetyReportSchema).max(ADMIN_SAFETY_REPORTS_PAGE_SIZE),
  nextCursor: z.string().max(80).nullable(),
});
/**
 * What a false-match clearance did to the flagged question's scan: `queued`, a recheck grades it
 * now; `on_retry`, the scan's pending retry grades it; `none`, the scan cannot be graded (it
 * failed for good, was cancelled, sent back for a retake, or the family is being deleted).
 */
export const SAFETY_CLEARANCE_RECHECKS = ['queued', 'on_retry', 'none'] as const;
export const safetyClearanceRecheckSchema = z.enum(SAFETY_CLEARANCE_RECHECKS);
export type SafetyClearanceRecheck = z.infer<typeof safetyClearanceRecheckSchema>;

export const adminSafetyReportResponseSchema = z.strictObject({
  report: adminSafetyReportSchema,
  /** Present only on the request that cleared a false match. */
  recheck: safetyClearanceRecheckSchema.optional(),
});

/**
 * PATCH /v1/admin/safety-reports/:id. A status move, a release of a held system report to the
 * family's list (`familyVisible: true`; forward only, a report is never hidden again), or both.
 * `resolution: 'false_match'` (round 3, CHK2-CS-5) clears a system report's flag in the request
 * that resolves it: the child's notice is hidden, the question is graded normally for that
 * transcription, and a held report stays held (it cannot be combined with `familyVisible`).
 */
export const updateSafetyReportRequestSchema = z
  .strictObject({
    status: z.enum(['triaged', 'escalated', 'resolved']).optional(),
    resolutionNote: freeTextSchema({ max: RESOLUTION_NOTE_MAX_LENGTH }).optional(),
    familyVisible: z.literal(true).optional(),
    /** The reviewer's clearing only; `addressed` is the guardian's outcome (PATCH /v1/safety-reports/:id). */
    resolution: z.literal('false_match').optional(),
  })
  .refine((b) => b.status !== undefined || b.familyVisible !== undefined, {
    message: 'Provide a status or familyVisible',
  })
  .refine((b) => b.resolution === undefined || b.status === 'resolved', {
    message: 'A false match is cleared in the request that resolves the report',
    path: ['resolution'],
  })
  .refine((b) => b.resolution === undefined || b.familyVisible === undefined, {
    message: 'A cleared flag is not released to the family',
    path: ['familyVisible'],
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
