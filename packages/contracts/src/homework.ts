// Contracts for the homework vertical (spec P5 capture/processing, P6 child display rules, P3 step-up
// for answers, P11 page allowance, P14 states). Owned by the homework feature agent.
//
// Role separation is structural: child DTOs are separate strict schemas that have no field able to
// carry an answer key, worked solution, rubric, confidence, grading route or disagreement flag, so a
// server change that adds one fails client validation instead of rendering it (AC_GRADING_06).
import { z } from 'zod';
import { idempotencyKeySchema, isoDateTimeSchema, uuidSchema } from './common.ts';

// ---------------------------------------------------------------------------------------------
// Limits (spec P5: configurable, visible before upload) and allowance (spec P11 prototype)
// ---------------------------------------------------------------------------------------------

export const HOMEWORK_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/pdf',
] as const;
export const homeworkMimeTypeSchema = z.enum(HOMEWORK_MIME_TYPES);
export type HomeworkMimeType = z.infer<typeof homeworkMimeTypeSchema>;

export interface HomeworkUploadLimits {
  readonly maxPages: number;
  readonly maxPageBytes: number;
  readonly allowedMimeTypes: readonly HomeworkMimeType[];
}

/** Spec P5 proposed defaults: 10 pages per submission, 15 MB per page, JPEG/PNG/HEIC/PDF. */
export const DEFAULT_HOMEWORK_UPLOAD_LIMITS: HomeworkUploadLimits = {
  maxPages: 10,
  maxPageBytes: 15 * 1024 * 1024,
  allowedMimeTypes: HOMEWORK_MIME_TYPES,
};

/**
 * Spec P11 prototype allowance: 40 homework pages per paid child per billing period. A configurable
 * proposal for pilot validation, not an owner-approved advertised limit.
 */
export const DEFAULT_HOMEWORK_PAGE_ALLOWANCE_PER_CHILD = 40;

/** Absolute schema ceilings (database checks). Configured limits are enforced as business rules. */
const PAGE_NUMBER_CEILING = 50;
const BYTE_SIZE_CEILING = 2_147_483_647;

// ---------------------------------------------------------------------------------------------
// State machine vocabulary (migration 0100)
// ---------------------------------------------------------------------------------------------

export const ASSIGNMENT_STATUSES = [
  'draft',
  'uploading',
  'queued',
  'extracting',
  'checking',
  'verifying',
  'ready',
  'needs_rescan',
  'needs_parent_review',
  'failed_retryable',
  'failed_final',
  'cancelled',
  'deleted',
] as const;
export const assignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

/** Statuses from which a scan may be cancelled (mirrors app.guard_assignment_transition). */
export const CANCELLABLE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'draft',
  'uploading',
  'queued',
  'failed_retryable',
  'needs_rescan',
];

/** Statuses in which a parent may correct a transcription (the result is then re-checked). */
export const CORRECTABLE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'ready',
  'needs_parent_review',
];

export const GRADED_VERDICTS = [
  'correct',
  'incorrect',
  'unresolved',
  'unanswered',
  'rubric',
  'needs_parent_review',
] as const;
export const gradedVerdictSchema = z.enum(GRADED_VERDICTS);
export type GradedVerdict = z.infer<typeof gradedVerdictSchema>;

export const OVERRIDE_VERDICTS = ['correct', 'incorrect', 'unresolved'] as const;
export const overrideVerdictSchema = z.enum(OVERRIDE_VERDICTS);
export type OverrideVerdict = z.infer<typeof overrideVerdictSchema>;

export const gradingRouteSchema = z.enum([
  'deterministic',
  'agreement',
  'escalated',
  'parent_review',
]);
export type GradingRoute = z.infer<typeof gradingRouteSchema>;

export const answerKindSchema = z.enum([
  'numeric',
  'quantity',
  'division_remainder',
  'multiple_choice',
  'spelling',
  'exact_text',
  'open_response',
  'writing',
]);

export const childFeedbackKindSchema = z.enum([
  'hint',
  'method_step',
  'analogous_example',
  'encouragement',
  'template_fallback',
]);

/** Stable `rule` codes returned with 422 BUSINESS_RULE by the homework API. */
export const HOMEWORK_BUSINESS_RULES = [
  'CONSENT_REQUIRED',
  'CHILD_NOT_ACTIVE',
  'QUOTA_EXCEEDED',
  'TOO_MANY_PAGES',
  'PAGE_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
  'PAGE_COUNT_MISMATCH',
  'UPLOAD_INCOMPLETE',
  'NO_PAGES',
  'INVALID_TRANSITION',
  'START_NEW_SCAN',
] as const;
export type HomeworkBusinessRule = (typeof HOMEWORK_BUSINESS_RULES)[number];

/**
 * Keys that must never appear anywhere in a child homework response (AC_GRADING_06). Exported so
 * API, web and mobile tests assert the same list against serialized payloads.
 */
export const CHILD_FORBIDDEN_HOMEWORK_KEYS = [
  'correctAnswer',
  'correct_answer',
  'workedSolution',
  'worked_solution',
  'rubric',
  'misconception',
  'confidence',
  'uncertainty',
  'route',
  'disagreement',
  'solutions',
  'answerKey',
  'answer_key',
  'evidence',
  'gradingProvenance',
  'grading_provenance',
] as const;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const createAssignmentRequestSchema = z.strictObject({
  /** Required for parents; forbidden for children (a child only ever scans for itself). */
  childId: uuidSchema.optional(),
  subjectId: uuidSchema.optional(),
  pageCount: z.number().int().min(1).max(PAGE_NUMBER_CEILING),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateAssignmentRequest = z.infer<typeof createAssignmentRequestSchema>;

export const uploadPageSchema = z.strictObject({
  pageNumber: z.number().int().min(1).max(PAGE_NUMBER_CEILING),
  /** Any declared type is accepted here so an unsupported type gets an explicit rule, not a 400. */
  mimeType: z.string().trim().min(1).max(100),
  byteSize: z.number().int().min(1).max(BYTE_SIZE_CEILING),
  /** Lower-case hex SHA-256 of the exact bytes the device will upload. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lower-case hex SHA-256'),
});
export type UploadPage = z.infer<typeof uploadPageSchema>;

export const uploadPagesRequestSchema = z.strictObject({
  pages: z.array(uploadPageSchema).min(1).max(PAGE_NUMBER_CEILING),
});
export type UploadPagesRequest = z.infer<typeof uploadPagesRequestSchema>;

export const finalizeAssignmentRequestSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});
export type FinalizeAssignmentRequest = z.infer<typeof finalizeAssignmentRequestSchema>;

export const OVERRIDE_REASON_MAX_LENGTH = 300;
export const overrideResultRequestSchema = z.strictObject({
  verdict: overrideVerdictSchema,
  reason: z.string().trim().min(1).max(OVERRIDE_REASON_MAX_LENGTH),
});
export type OverrideResultRequest = z.infer<typeof overrideResultRequestSchema>;

export const TRANSCRIPTION_TEXT_MAX_LENGTH = 4000;
export const correctTranscriptionRequestSchema = z
  .strictObject({
    promptText: z.string().trim().min(1).max(TRANSCRIPTION_TEXT_MAX_LENGTH).optional(),
    /** An empty string records that the student left the question blank. */
    studentAnswerText: z.string().trim().max(TRANSCRIPTION_TEXT_MAX_LENGTH).optional(),
  })
  .refine(
    (v) => v.promptText !== undefined || v.studentAnswerText !== undefined,
    'Nothing to correct',
  );
export type CorrectTranscriptionRequest = z.infer<typeof correctTranscriptionRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Shared responses
// ---------------------------------------------------------------------------------------------

export const uploadLimitsSchema = z.strictObject({
  maxPages: z.number().int().min(1),
  maxPageBytes: z.number().int().min(1),
  allowedMimeTypes: z.array(homeworkMimeTypeSchema).min(1),
});
export const uploadLimitsResponseSchema = z.strictObject({ limits: uploadLimitsSchema });
export type UploadLimitsResponse = z.infer<typeof uploadLimitsResponseSchema>;

/** Role-neutral assignment state returned by capture mutations to both parents and children. */
export const assignmentStateSchema = z.strictObject({
  id: uuidSchema,
  subjectId: uuidSchema.nullable(),
  status: assignmentStatusSchema,
  pageCount: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AssignmentState = z.infer<typeof assignmentStateSchema>;
export const assignmentStateResponseSchema = z.strictObject({ assignment: assignmentStateSchema });
export type AssignmentStateResponse = z.infer<typeof assignmentStateResponseSchema>;

export const uploadTargetSchema = z.strictObject({
  pageId: uuidSchema,
  pageNumber: z.number().int().min(1),
  /** Signed single-object URL; the device sends the bytes there directly, never through the API. */
  uploadUrl: z.url(),
  method: z.literal('PUT'),
  expiresAt: isoDateTimeSchema,
  /** True when storage already holds this page (resume after an interrupted upload). */
  alreadyUploaded: z.boolean(),
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const uploadPagesResponseSchema = z.strictObject({
  assignment: assignmentStateSchema,
  uploads: z.array(uploadTargetSchema),
});
export type UploadPagesResponse = z.infer<typeof uploadPagesResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Parent views (no solutions: those need the step-up route below)
// ---------------------------------------------------------------------------------------------

export const pageAllowanceSchema = z.strictObject({
  /** Placeholder period: calendar month in the family time zone until provider periods drive it. */
  periodKey: z.string(),
  childPagesUsed: z.number().int().min(0),
  childPagesAllowed: z.number().int().min(0),
  familyPagesUsed: z.number().int().min(0),
  familyPagesAllowed: z.number().int().min(0),
});
export type PageAllowance = z.infer<typeof pageAllowanceSchema>;

export const assignmentSummarySchema = z.strictObject({
  id: uuidSchema,
  childId: uuidSchema,
  subjectId: uuidSchema.nullable(),
  status: assignmentStatusSchema,
  pageCount: z.number().int().min(0),
  createdByKind: z.enum(['parent', 'child']),
  errorCode: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AssignmentSummary = z.infer<typeof assignmentSummarySchema>;

export const assignmentListResponseSchema = z.strictObject({
  assignments: z.array(assignmentSummarySchema),
  /** Present when the list is filtered to one child. */
  allowance: pageAllowanceSchema.nullable(),
});
export type AssignmentListResponse = z.infer<typeof assignmentListResponseSchema>;

export const parentQuestionResultSchema = z.strictObject({
  /** The verdict to act on: the parent override when present, otherwise the graded verdict. */
  verdict: gradedVerdictSchema,
  gradedVerdict: gradedVerdictSchema,
  route: gradingRouteSchema,
  disagreement: z.boolean(),
  gradedAt: isoDateTimeSchema,
  override: z
    .strictObject({
      verdict: overrideVerdictSchema,
      reason: z.string().nullable(),
      at: isoDateTimeSchema,
    })
    .nullable(),
});
export type ParentQuestionResult = z.infer<typeof parentQuestionResultSchema>;

export const parentQuestionSchema = z.strictObject({
  id: uuidSchema,
  pageNumber: z.number().int().min(1),
  questionNumber: z.string(),
  /** Original transcription (kept distinguishable from any parent correction, spec P5). */
  promptText: z.string(),
  studentAnswerText: z.string().nullable(),
  correctedPromptText: z.string().nullable(),
  correctedStudentAnswerText: z.string().nullable(),
  correctedAt: isoDateTimeSchema.nullable(),
  answerKind: answerKindSchema,
  subjectKey: z.string(),
  skill: z.string(),
  /** Advisory reading uncertainty, never a calibrated correctness guarantee (spec P5). */
  uncertainty: z.enum(['low', 'medium', 'high']).nullable(),
  result: parentQuestionResultSchema.nullable(),
});
export type ParentQuestion = z.infer<typeof parentQuestionSchema>;

export const assignmentDetailResponseSchema = z.strictObject({
  assignment: assignmentSummarySchema,
  pages: z.array(
    z.strictObject({
      id: uuidSchema,
      pageNumber: z.number().int().min(1),
      mimeType: homeworkMimeTypeSchema,
    }),
  ),
  questions: z.array(parentQuestionSchema),
});
export type AssignmentDetailResponse = z.infer<typeof assignmentDetailResponseSchema>;

/** Parent-only, after a server-verified recent step-up (AC_GRADING_05). */
export const questionSolutionSchema = z.strictObject({
  questionId: uuidSchema,
  questionNumber: z.string(),
  correctAnswer: z.string(),
  workedSolution: z.string(),
  rubric: z.json().nullable(),
  misconception: z.string().nullable(),
});
export type QuestionSolution = z.infer<typeof questionSolutionSchema>;

export const assignmentSolutionsResponseSchema = z.strictObject({
  assignmentId: uuidSchema,
  solutions: z.array(questionSolutionSchema),
});
export type AssignmentSolutionsResponse = z.infer<typeof assignmentSolutionsResponseSchema>;

export const overrideResultResponseSchema = z.strictObject({
  questionId: uuidSchema,
  result: parentQuestionResultSchema,
});
export type OverrideResultResponse = z.infer<typeof overrideResultResponseSchema>;

export const correctTranscriptionResponseSchema = z.strictObject({
  assignment: assignmentStateSchema,
  question: parentQuestionSchema,
});
export type CorrectTranscriptionResponse = z.infer<typeof correctTranscriptionResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Child views: prompt, own answer, verdict, guarded feedback bodies — nothing else (spec P6)
// ---------------------------------------------------------------------------------------------

export const childAssignmentSummarySchema = z.strictObject({
  id: uuidSchema,
  subjectId: uuidSchema.nullable(),
  status: assignmentStatusSchema,
  pageCount: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ChildAssignmentSummary = z.infer<typeof childAssignmentSummarySchema>;

export const childAssignmentListResponseSchema = z.strictObject({
  assignments: z.array(childAssignmentSummarySchema),
});
export type ChildAssignmentListResponse = z.infer<typeof childAssignmentListResponseSchema>;

export const childQuestionSchema = z.strictObject({
  id: uuidSchema,
  questionNumber: z.string(),
  promptText: z.string(),
  /** The child's own submitted answer (spec P6 allows showing it). */
  studentAnswerText: z.string().nullable(),
  /** Null while the scan is still being checked. */
  verdict: gradedVerdictSchema.nullable(),
  feedback: z.array(
    z.strictObject({
      id: uuidSchema,
      kind: childFeedbackKindSchema,
      body: z.string(),
    }),
  ),
});
export type ChildQuestion = z.infer<typeof childQuestionSchema>;

export const childAssignmentDetailResponseSchema = z.strictObject({
  assignment: childAssignmentSummarySchema,
  questions: z.array(childQuestionSchema),
});
export type ChildAssignmentDetailResponse = z.infer<typeof childAssignmentDetailResponseSchema>;
