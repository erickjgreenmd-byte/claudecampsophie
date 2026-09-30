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
  /**
   * The recorded delivery: at least one active guardian's address accepted the flag email. CS-R2-06:
   * it says exactly that, because `sent` is recorded as soon as ONE verified address accepts. It used
   * to read "emailed the guardians on this account ... when it was filed", which told a guardian
   * whose address bounced, and an unverified co-guardian who was skipped without any record, that
   * they had been emailed, and claimed a filing-time delivery for an email that may have gone out on
   * a later retry.
   */
  emailSent:
    'PencilLift emailed at least one verified guardian address on this account about this flag, so a grown-up knows to look here. An address that is not verified, or that the email provider refused, was not reached: check your own email address in this account if you did not receive it. The email names no child, no question and no kind of concern.',
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
 * Parent-facing wording for a scan that consent withdrawal stopped (CS-R4-03). Withdrawing consent
 * cancels the scan_process jobs of the family's pending scans and settles each one
 * (guardians.ts settleScansAfterConsentWithdrawal): a queued or running initial scan ends
 * `failed_final` with `error_code = 'CONSENT_REQUIRED'` and its page allowance is released.
 *
 * The portal's `failed_final` state copy — "This scan could not be processed after several tries.
 * Please start a new scan with clear photos." — is untrue of this scan twice over (it was stopped
 * once, by the family's own withdrawal, and the photos were fine) and the advice cannot work: a new
 * upload re-checks consent and is refused 422 CONSENT_REQUIRED
 * (HOMEWORK_BUSINESS_RULES). So this outcome gets its own line, here rather than in a page, so the
 * portal and the app say the same thing. It also states the one good fact the settlement delivers,
 * that the pages were given back.
 */
export const CONSENT_WITHDRAWN_SCAN_COPY =
  'Checking stopped because parental consent for this child’s learning data was withdrawn, and this scan’s pages were given back to your monthly allowance. Nothing was wrong with the photos. Give consent again on your family dashboard before scanning this worksheet once more.';

/**
 * Parent-facing wording for the other two permanent outcomes of the same job (HUNT5-F-5): the child
 * was archived while the scan was in flight (scan-process.ts throws PermanentFailure
 * 'CHILD_ARCHIVED'), or the profile lost its paid slot, which a store downgrade does
 * (billing-sync.ts) and which ends a paid-AI scan 'CHILD_NOT_ACTIVE'. Both end `failed_final` and
 * release the page allowance, like the consent case above.
 *
 * Neither had its own line, so both fell back to the portal's generic `failed_final` copy — "This
 * scan could not be processed after several tries. Please start a new scan with clear photos." —
 * which is untrue twice over (the photos were fine, and the scan was stopped once rather than
 * retried) and cannot work: POST /v1/assignments answers CHILD_NOT_ACTIVE for an archived or
 * slotless child. On an archived child the parent read it directly under the page's own notice that
 * new scans are not taken.
 *
 * Both name the Children page, which is where a slot is assigned and an archived profile activated
 * again, and neither promises capacity this portal cannot sell (WEB-R1-04): with no unused slot that
 * page says where a slot comes from. Here rather than in a page so the portal and the app say the
 * same thing.
 */
export const ARCHIVED_CHILD_SCAN_COPY =
  'Checking stopped because this child’s profile was archived, and this scan’s pages were given back to your monthly allowance. Nothing was wrong with the photos. Earlier scans and their results stay readable. Activate the profile again on the Children page, while a paid slot is free, to scan this worksheet once more.';

/**
 * G-DRAFT-COPY: the remedy this line ends with is printed WHOLE — `explainStatus` returns a code's own
 * line untrimmed (apps/web/src/pages/app/HomeworkPage.tsx) — to the parent of the profile that records
 * CHILD_NOT_ACTIVE: a draft `releaseSlotlessProfiles` demoted, and it demotes only a child whose slot
 * was released `'expired'` or `'downgrade'` (apps/api/src/services/billing-sync.ts), i.e. after the
 * family's paid capacity shrank. "Give the profile a paid slot again on the Children page" promised
 * that page can restore one whatever the capacity; it can only assign a slot the family still has
 * unused, and this portal cannot sell capacity (WEB-R1-04). Both sibling lines already hedge exactly
 * that ("while a paid slot is free", "while one is free"), and the same child's other rows print the
 * hedged wording, so two rows of one list offered the same remedy on different terms. It now names the
 * action the Children page really offers and keeps the hedge; with no slot free that page says where
 * one comes from.
 */
export const INACTIVE_CHILD_SCAN_COPY =
  'Checking stopped because this child no longer has a paid slot, and this scan’s pages were given back to your monthly allowance. Nothing was wrong with the photos. Earlier scans and their results stay readable. Assign one of your family’s unused paid slots to this profile on the Children page, while one is free, and this worksheet can be scanned again then.';

/**
 * HUNT6-H-2: what to say INSTEAD of "get a new scan" when the outcome's own advice is a new scan and
 * the child's profile makes one impossible. The two lines above cover the two permanent codes the
 * archive itself records; these two cover every OTHER outcome on the same screen — `needs_rescan`,
 * `uploading` and the permanent codes FORMAT_NEEDS_CONVERSION, SCAN_TOO_MANY_QUESTIONS and
 * AI_PAUSED_TOO_LONG — each of which used to end in "scan again", "send the pages again" or "start a
 * new one" whatever the profile's state.
 *
 * None of those can be acted on for a non-active profile: POST /v1/assignments goes through
 * `assertCanCollect` → `readPaidProfile`, whose `entitled` requires `status = 'active'` (apps/api/src/
 * routes/homework.ts), the portal offers no uploader for an archived child, and archiving revokes the
 * child's sessions so the tablet cannot scan either. Meanwhile the rows stay listed — GET /v1/assignments
 * drops only a child under an open deletion — so an archived child's history was printed under the
 * page's own "new scans are not taken" notice while telling the parent to go and get one.
 *
 * Both name the Children page, where a slot is assigned and an archived profile activated again, and
 * neither promises capacity this portal cannot sell (WEB-R1-04). Here rather than in a page so the
 * portal and the app say the same thing, beside the two lines they replace the advice of.
 *
 * HUNT7-I-1 / HUNT7-E-2: and both STOP at that step. They used to end "and these pages can go through
 * then", which asserts that the profile is the only thing left in the way. For three of the five
 * outcomes they are printed for it is not: a PDF or HEIC file is still unreadable after activation
 * (L-063 — NOT `HomeworkMimeType`, which ACCEPTS both: `HOMEWORK_MIME_TYPES` in
 * packages/contracts/src/homework.ts lists image/heic and application/pdf and
 * DEFAULT_HOMEWORK_UPLOAD_LIMITS.allowedMimeTypes is that same tuple. The refusal is `validatePages`
 * at POST /v1/assignments/:id/uploads, which throws BUSINESS_RULE FORMAT_NOT_SUPPORTED_YET for any
 * page outside `HOMEWORK_READABLE_MIME_TYPES` — jpeg and png only — apps/api/src/routes/homework.ts.
 * Refused before the pages are registered, so the conclusion is stronger: the scan never starts), a
 * worksheet with more questions than one check handles still exceeds the stage limit
 * (packages/ai/src/routing.ts), and the same blurred
 * photos are still blurred — while the composition that printed this line had just TRIMMED the one
 * instruction that would have worked. A parent who assigned or bought a slot on the strength of that
 * sentence re-sent the same pages and met the identical failure with no advice left on screen. Each
 * outcome's own requirement is re-appended AFTER this line instead, by
 * `OUTCOME_WITHOUT_NEW_SCAN_ADVICE` (apps/web/src/pages/app/HomeworkPage.tsx), so the condition that
 * makes the advice true survives without this line promising anything about these pages.
 */
export const ARCHIVED_CHILD_NO_NEW_SCAN_COPY =
  'A new scan can’t help while this child’s profile is archived: PencilLift takes no new scans for them and their paired devices are signed out. Activate the profile again on the Children page, while a paid slot is free.';

/**
 * G-DRAFT: `draft` is the only status this line is printed for — the family contract has three
 * (draft, active, archived) and the archived line above covers the other non-active one — and it
 * asserts no history of the slot, because a draft has two populations. Adding a child creates an
 * uncharged draft that becomes active when one of the family's unused slots is assigned to it
 * (apps/web/src/pages/app/ChildrenPage.tsx), which is why every picker spells such a child "(no paid
 * slot yet)"; and `releaseSlotlessProfiles` puts a previously ACTIVE child back into 'draft' whenever
 * verified provider state releases its slot — an expiry or a store-confirmed downgrade
 * (apps/api/src/services/billing-sync.ts) — which is the commoner case here, since that is also what
 * makes a scan record CHILD_NOT_ACTIVE.
 *
 * G-DRAFT-COPY: so this line may claim neither history. "Give the profile a paid slot AGAIN" asserted
 * a slot a new draft never had; "a draft has never held a paid slot", which this comment used to
 * assert, is false of a demoted one, and a line resting on it could tell a family whose plan lapsed
 * that their child had never been paid for. What is said instead is the present state and the action
 * the Children page actually offers a draft ("Assign one of your family's unused paid slots"), which
 * is true of both populations and still promises no capacity this portal cannot sell (WEB-R1-04):
 * that page says where a slot comes from when none is free.
 */
export const INACTIVE_CHILD_NO_NEW_SCAN_COPY =
  'A new scan can’t help while this child has no paid slot: PencilLift takes no new scans for them. Assign one of your family’s unused paid slots to this profile on the Children page, while one is free.';

/**
 * HUNT7-I-3: the permanent outcomes where nothing about the pages is wrong and no parent action
 * changes anything, so the generic `failed_final` line — "This scan could not be processed after
 * several tries. Please start a new scan with clear photos." — is false in both halves. The codes
 * (apps/web/src/pages/app/HomeworkPage.tsx names them) are AI_NOT_AVAILABLE, thrown when
 * `checkChildDataGate` refuses: a missing, switch-like or future-dated ZDR approval reference, or a
 * mock provider configured in production (packages/ai/src/gate.ts, via scan-process.ts's
 * `assertMayProcess`); MODERATION_NOT_AVAILABLE, the same gate refusing the safety screen or a
 * moderation provider that is non-retryably unavailable (apps/api/src/jobs/scan-process.ts); and
 * UNKNOWN_MODEL, router configuration (packages/ai/src/run.ts). Each is one refusal, not several
 * tries, and none of them is about these pages — so when the owner's ZDR evidence lapses, the old line
 * told every parent in the product that their child's homework photos were not clear enough. It asks
 * for nothing, because nothing the parent does helps. The pages are not lost either way — every
 * PermanentFailure settles the reservation to `failed_final`, which releases the allowance.
 *
 * The OUTCOME is separate from what follows it, because what follows depends on the profile. For a
 * child who cannot scan at all, the page appends that child's own blocker instead (HUNT7-I-3's repair:
 * the first version put these codes in the page's code table only, so an archived child's row claimed
 * "new scans stop the same way until that is fixed. There is nothing for you to change" directly under
 * the page's own "new scans are not taken … Activate Riley again on the Children page" — two regions,
 * opposite causes, opposite calls to action, and false besides, since that child's scans stop before
 * any provider is reached and keep stopping after the outage is over).
 */
export const PROVIDER_UNAVAILABLE_SCAN_OUTCOME =
  'PencilLift could not check this scan, and its pages were given back to your monthly allowance. Nothing was wrong with the photos: the check stopped on PencilLift’s side.';

/**
 * The same outcome for a profile that CAN scan, with what follows from it.
 *
 * "Sending these pages again" rather than the first draft's "new scans stop the same way": that draft
 * asserted a standing product-wide state, and MODERATION_NOT_AVAILABLE is also the code for a
 * moderation provider answering non-retryably about THIS request — moderation.ts maps a 400 or 401 to
 * `retryable: false` and apps/api/src/jobs/scan-process.ts turns that into the same PermanentFailure.
 * Resending the identical pages meets the identical refusal in every one of the three cases, which is
 * the part the parent needs (it spends allowance), so the narrower claim is the true one.
 */
export const PROVIDER_UNAVAILABLE_SCAN_COPY = `${PROVIDER_UNAVAILABLE_SCAN_OUTCOME} Sending these pages again would stop the same way until that is fixed. There is nothing for you to change — you can ask support about this scan.`;

/**
 * HUNT7-I-6: the FALL-THROUGH of the two lines above, for a status that is neither 'active' nor one of
 * the two the family contract has today (packages/contracts/src/family.ts). The page used to print no
 * blocker at all for such a value while its uploader asserted "needs a paid child slot" in the next
 * region — two regions of one screen keyed differently on one profile. This says only what the gate
 * really establishes: `readPaidProfile`'s `entitled` requires `status = 'active'`
 * (apps/api/src/routes/homework.ts), so anything else takes no new scan, and it names neither of the
 * two reasons it cannot know to be the one.
 */
export const NO_NEW_SCAN_WITHOUT_ACTIVE_PROFILE_COPY =
  'A new scan can’t help while this child’s profile is not active: PencilLift takes no new scans for them. You can check this child’s profile on the Children page.';

/**
 * HUNT7-I-2: why "Fix transcription" is not offered for a scan that HAS finished checking. The
 * correction route re-runs a paid AI check of child data, so POST /v1/questions/:id/correction calls
 * `assertCanCollect` (apps/api/src/routes/homework.ts) exactly as a new scan does, and
 * `readPaidProfile`'s `entitled` requires `status = 'active'` plus an unreleased paid slot — so for an
 * archived or slotless profile the parent retyped an answer, saved, and was answered "Assign a paid
 * slot to this child before scanning homework", in reply to a correction. The sibling controls are NOT
 * affected and stay offered: POST /questions/:id/override, the cancel route and GET
 * /assignments/:id/solutions call no such gate.
 *
 * Three lines rather than one because the blocker differs, and the third is the FALL-THROUGH: it is
 * what any status this page does not recognise gets, and it asserts no particular reason — "archived"
 * and "no paid slot" are the two non-active values the family contract has today
 * (packages/contracts/src/family.ts), and a future one must not be described as either. All three say
 * the results already on screen stay readable, because they do (AC_CAPACITY_08).
 *
 * One condition none of them can see: an ACTIVE profile whose paid slot was released still fails
 * `entitled`, and the child's status alone cannot tell. That case keeps the API's own refusal, which
 * the panel renders verbatim.
 */
export const ARCHIVED_CHILD_NO_CORRECTION_COPY =
  'Fixing a transcription has PencilLift check the work again, and no check runs while this child’s profile is archived. The answers and results already here stay readable. Activate the profile again on the Children page, while a paid slot is free, to fix a transcription.';

export const INACTIVE_CHILD_NO_CORRECTION_COPY =
  'Fixing a transcription has PencilLift check the work again, and no check runs while this child has no paid slot. The answers and results already here stay readable. Assign one of your family’s unused paid slots to this profile on the Children page, while one is free, to fix a transcription.';

export const NO_CORRECTION_WITHOUT_ACTIVE_PROFILE_COPY =
  'Fixing a transcription has PencilLift check the work again, which needs a profile that is active and holds a paid slot. The answers and results already here stay readable. You can check this child’s profile on the Children page.';

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
