// Contracts for the learning vertical (spec P6-P9, P13; AC_LEARNING_01..10, AC_REWARDS_01/02,
// AC_GRADING_06). Requests are strict (unknown keys are rejected, so no family id, role or "show
// the key" switch can ride along). Child responses are strict allowlists: a server change that adds
// a key/solution field fails loudly instead of being rendered.
import { z } from 'zod';
import {
  calendarDateSchema,
  freeTextSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  uuidSchema,
} from './common.ts';
// The child-status predicate the planner copy below answers to. It lives in family.ts beside
// `CHILD_PROFILE_STATUSES`, `childStatusCopy` and `childPickerSuffixCopy` (BUG-410) because it is a
// fact about a CHILD PROFILE, not about learning: a fourth status and every sentence keyed to the
// status set then land in one file. This module owns the learning COPY that consumes it.
import { receivesPractice } from './family.ts';

// ---------------------------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------------------------

export const SUPPORTED_SUBJECT_KEYS = [
  'math',
  'reading',
  'spelling_vocabulary',
  'grammar_writing',
  'science',
  'social_studies',
] as const;
export const supportedSubjectKeySchema = z.enum(SUPPORTED_SUBJECT_KEYS);
export type SupportedSubjectKey = z.infer<typeof supportedSubjectKeySchema>;

export const subjectKeySchema = z.enum([...SUPPORTED_SUBJECT_KEYS, 'custom']);
export type SubjectKey = z.infer<typeof subjectKeySchema>;

export const SUBJECT_DISPLAY_NAMES: Readonly<Record<SupportedSubjectKey, string>> = {
  math: 'Math',
  reading: 'Reading',
  spelling_vocabulary: 'Spelling & Vocabulary',
  grammar_writing: 'Grammar & Writing',
  science: 'Science',
  social_studies: 'Social Studies',
};

export const childSubjectSchema = z.strictObject({
  id: uuidSchema,
  subjectKey: subjectKeySchema,
  displayName: z.string(),
  enabled: z.boolean(),
  /** False for custom subjects: PencilLift generates no practice for them (see coverage). */
  generatedPractice: z.boolean(),
});
export type ChildSubject = z.infer<typeof childSubjectSchema>;

export const childSubjectsResponseSchema = z.strictObject({
  subjects: z.array(childSubjectSchema),
});
export type ChildSubjects = z.infer<typeof childSubjectsResponseSchema>;

const displayNameSchema = freeTextSchema({ max: 60 });

/** POST /v1/children/:childId/subjects. A custom subject needs a display name. */
export const createChildSubjectRequestSchema = z
  .strictObject({
    subjectKey: subjectKeySchema,
    displayName: displayNameSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.subjectKey !== 'custom' || v.displayName !== undefined, {
    message: 'Name the custom subject',
    path: ['displayName'],
  });
export type CreateChildSubjectRequest = z.infer<typeof createChildSubjectRequestSchema>;

/** PATCH /v1/children/:childId/subjects: enable/disable or rename one subject. */
export const updateChildSubjectRequestSchema = z
  .strictObject({
    subjectId: uuidSchema,
    enabled: z.boolean().optional(),
    displayName: displayNameSchema.optional(),
  })
  .refine((v) => v.enabled !== undefined || v.displayName !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateChildSubjectRequest = z.infer<typeof updateChildSubjectRequestSchema>;

export const childSubjectResponseSchema = z.strictObject({ subject: childSubjectSchema });

// ---------------------------------------------------------------------------------------------
// Learning schedule (daily practice + Thursday review; spec P7, P8)
// ---------------------------------------------------------------------------------------------

export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

export const LEARNING_LIMITS = {
  reviewQuestionsPerSubject: { min: 4, max: 20, default: 8 },
  dailyQuestionCount: { min: 3, max: 10, default: 5 },
} as const;

const scheduleFields = {
  /** ISO weekday 1 (Monday) .. 7 (Sunday); default 4 (Thursday). */
  reviewWeekday: z.number().int().min(1).max(7),
  reviewLocalTime: localTimeSchema,
  reviewQuestionsPerSubject: z
    .number()
    .int()
    .min(LEARNING_LIMITS.reviewQuestionsPerSubject.min)
    .max(LEARNING_LIMITS.reviewQuestionsPerSubject.max),
  dailyLocalTime: localTimeSchema,
  dailyQuestionCount: z
    .number()
    .int()
    .min(LEARNING_LIMITS.dailyQuestionCount.min)
    .max(LEARNING_LIMITS.dailyQuestionCount.max),
  /** Inclusive local-date pause/vacation range: no new daily sets; earned points are kept. */
  pause: z.strictObject({ from: calendarDateSchema, to: calendarDateSchema }).nullable(),
  quietHours: z.strictObject({ start: localTimeSchema, end: localTimeSchema }).nullable(),
  childRemindersPermitted: z.boolean(),
};

export const learningScheduleSchema = z.strictObject({
  ...scheduleFields,
  /** Increases whenever the review day/time or a test date changes (part of the review job key). */
  scheduleVersion: z.number().int().min(1),
});
export type LearningSchedule = z.infer<typeof learningScheduleSchema>;

/** PUT /v1/children/:childId/learning-schedule (the version is server-maintained). */
export const updateLearningScheduleRequestSchema = z
  .strictObject(scheduleFields)
  .refine((v) => v.pause === null || v.pause.from <= v.pause.to, {
    message: 'A pause must not end before it starts',
    path: ['pause'],
  });
export type UpdateLearningScheduleRequest = z.infer<typeof updateLearningScheduleRequestSchema>;

export const reviewReleaseSchema = z.strictObject({
  subjectKey: supportedSubjectKeySchema,
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
  releaseAt: isoDateTimeSchema.nullable(),
  reason: z.enum(['default_schedule', 'test_date_eve', 'skipped_week']),
  testDate: calendarDateSchema.nullable(),
});

export const dailyPracticeStatusSchema = z.strictObject({
  localDate: calendarDateSchema,
  state: z.enum(['available', 'not_yet_released', 'paused', 'vacation']),
  releaseAt: isoDateTimeSchema,
});

export const learningScheduleResponseSchema = z.strictObject({
  schedule: learningScheduleSchema,
  timezone: z.string(),
  nextReviewReleases: z.array(reviewReleaseSchema),
  dailyPractice: dailyPracticeStatusSchema,
  /** Pausing or missing days never removes or expires earned points (spec P7). */
  pointsPolicy: z.strictObject({
    expireEarnedPoints: z.literal(false),
    penalizeMissedDays: z.literal(false),
  }),
});
export type LearningScheduleResponse = z.infer<typeof learningScheduleResponseSchema>;

export type ReviewRelease = z.infer<typeof reviewReleaseSchema>;
export type DailyPracticeStatus = z.infer<typeof dailyPracticeStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Parent-facing planner copy — ONE definition, both surfaces
// ---------------------------------------------------------------------------------------------

/**
 * PLANNER COPY THE PORTAL AND THE APP BOTH PRINT — ONE DEFINITION, NOT TWO THAT AGREE.
 *
 * Every sentence below existed TWICE until BUG-411: once in
 * apps/web/src/components/learning/format.ts and once in apps/mobile/src/learning/planner-form.ts,
 * tied together by tests that read the other surface's source text. A source pin guards the WORDS and
 * not the MEANING (L-070) — it catches a reworded sentence and misses a widened predicate, and
 * reverting one portal sentence once left the entire mobile suite green — and two identical table
 * bodies are a coincidence with good odds (L-066), not an invariant. They were not even identical:
 * the phone's release-reason table mapped each reason to a plain STRING, so it discarded the
 * `testDate` the same contract carries and the portal prints, and said 'before a test' where the
 * portal said 'moved before the test on Thu, Oct 1, 2026'.
 *
 * So the decisions live here, in the package both apps already import, and NEITHER app keeps a copy.
 *
 * Each one is a FUNCTION OVER THE STATE THAT DECIDES IT, not a table the caller indexes, because
 * indexing is how both defects got in: the phone dropped an argument it could not see it needed, and
 * a card picked the promising variant for a profile that receives nothing. `dailyPracticeCopy` and
 * `noWeeklyReviewsCopy` ask `receivesPractice` themselves rather than take a `prepared` boolean, and
 * `reviewReleaseReasonCopy` takes the RELEASE rather than its `reason`, so the wrong call is hard to
 * write instead of merely tested against (L-071: extracting a rule proves the rule, not the call).
 *
 * The lookup tables stay exported so a test can assert their key set is exactly the schema's enum: a
 * fifth daily state or a fourth release reason is then a compile error here and a red test, never a
 * silent fall-through onto a sentence written for something else (L-057).
 */

/** A calendar date (YYYY-MM-DD) as "Fri, Oct 2, 2026", with no time-zone shift. */
export function formatCalendarDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(utc);
  } catch {
    return date;
  }
}

/**
 * An instant in the family's IANA zone, e.g. "Thu, Sep 24, 4:00 PM EDT".
 *
 * The fallback is the APP's, kept over the portal's on purpose. Where the runtime cannot resolve the
 * zone, the portal reformatted in the DEVICE's zone and still printed a zone abbreviation, so a New
 * York family on a device set to Los Angeles read a Los Angeles instant under a heading naming
 * New York — a wrong time that looks right. Naming UTC is visibly not the family zone, which is the
 * honest answer to "this runtime has no zone data" (Hermes without full ICU is the real case).
 */
export function formatInZone(iso: string, zone: string): string {
  const date = new Date(iso);
  // An unparseable instant would make BOTH branches below throw; echo it rather than crash the card.
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: zone,
    }).format(date);
  } catch {
    return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}

/**
 * The subject's name for this child — the parent's own name for it where there is one, falling back to
 * the standard name. Shared because the phone printed `SUBJECT_DISPLAY_NAMES[key]` for the very same
 * release line the portal rendered through this function, so a parent who renamed Mathematics read
 * their name in the portal and "Math" on the phone.
 */
export function subjectName(subjectKey: string | null, subjects: readonly ChildSubject[]): string {
  if (subjectKey === null) return 'Mixed subjects';
  const own = subjects.find((s) => s.subjectKey === subjectKey && s.subjectKey !== 'custom');
  if (own) return own.displayName;
  return (SUBJECT_DISPLAY_NAMES as Readonly<Record<string, string>>)[subjectKey] ?? subjectKey;
}

/**
 * The two sentences a daily-practice state has: what is true for a profile PencilLift prepares
 * practice for, and what is true for one it does not. Both variants exist for every state on purpose
 * (HUNT7-H-1): the old table held one string per state and only `not_yet_released` carried an instant,
 * so the planner notice's framing sentence — which speaks about "the times below" — could not reach
 * the other three, and 'available' asserted in the present tense that today's practice is ready for a
 * profile that receives none.
 *
 * The hypothetical keeps the instant wherever the plain sentence has one (HUNT5-F-10: the stored plan
 * is what the parent came to read) and says nothing about WHY the profile is not active. "again" would
 * assert that it once was, which is true of an archived profile and only of SOME drafts —
 * `releaseSlotlessProfiles` (apps/api/src/services/billing-sync.ts) returns a previously active child
 * to 'draft' — and deriving that here would be a second status question in a card that has one.
 */
export interface DailyPracticeStateCopy {
  readonly prepared: (releaseAt: string, zone: string) => string;
  readonly hypothetical: (releaseAt: string, zone: string, childName: string) => string;
}

export const DAILY_PRACTICE_COPY: Readonly<
  Record<DailyPracticeStatus['state'], DailyPracticeStateCopy>
> = {
  available: {
    prepared: () => 'Today’s daily practice is available.',
    hypothetical: (_releaseAt, _zone, childName) =>
      `Today’s daily practice would be available if ${childName}’s profile were active.`,
  },
  not_yet_released: {
    prepared: (releaseAt, zone) => `Today’s daily practice opens ${formatInZone(releaseAt, zone)}.`,
    hypothetical: (releaseAt, zone, childName) =>
      `Today’s daily practice would open at ${formatInZone(releaseAt, zone)} if ${childName}’s profile were active.`,
  },
  paused: {
    prepared: () => 'Daily practice is paused today.',
    hypothetical: (_releaseAt, _zone, childName) =>
      `Daily practice would be paused today even if ${childName}’s profile were active.`,
  },
  vacation: {
    prepared: () => 'Daily practice is paused today (vacation).',
    hypothetical: (_releaseAt, _zone, childName) =>
      `Daily practice would be paused today (vacation) even if ${childName}’s profile were active.`,
  },
};

/**
 * Today's daily-practice sentence. It takes the STATUS and asks `receivesPractice` itself, so no
 * screen can hand it a `prepared` flag of its own making: a card that computed that flag from
 * "can this plan be edited" is exactly how a draft profile — writable on purpose, and receiving
 * nothing — was told today's practice was ready.
 */
export function dailyPracticeCopy(input: {
  readonly dailyPractice: Pick<DailyPracticeStatus, 'state' | 'releaseAt'>;
  readonly zone: string;
  readonly childName: string;
  /** `undefined` is legal and fails closed: a caller with no status gets the hedged sentence. */
  readonly childStatus: string | undefined;
}): string {
  const copy = DAILY_PRACTICE_COPY[input.dailyPractice.state];
  return receivesPractice(input.childStatus)
    ? copy.prepared(input.dailyPractice.releaseAt, input.zone)
    : copy.hypothetical(input.dailyPractice.releaseAt, input.zone, input.childName);
}

/** When a release lands, or "not this week" for a week the stored schedule skips. */
export function reviewReleaseWhen(release: Pick<ReviewRelease, 'releaseAt'>, zone: string): string {
  return release.releaseAt === null ? 'not this week' : formatInZone(release.releaseAt, zone);
}

export const REVIEW_RELEASE_REASON_COPY: Readonly<
  Record<ReviewRelease['reason'], (testDate: string | null) => string>
> = {
  default_schedule: () => 'regular review day',
  test_date_eve: (testDate) =>
    testDate ? `moved before the test on ${formatCalendarDate(testDate)}` : 'moved before a test',
  skipped_week: () => 'no review this week',
};

/**
 * Why this release lands when it does. It takes the RELEASE, not the release's `reason`, which is the
 * whole repair: the phone wrote `RELEASE_REASON[r.reason]` and printed 'before a test' for a release
 * whose `testDate` the API had filled in and the portal was naming. `reviewReleaseSchema` carries
 * `testDate` beside `reason`, so a caller that has the reason has the date, and this signature is what
 * stops it being left behind again.
 */
export function reviewReleaseReasonCopy(
  release: Pick<ReviewRelease, 'reason' | 'testDate'>,
): string {
  return REVIEW_RELEASE_REASON_COPY[release.reason](release.testDate);
}

/** What `noWeeklyReviewsCopy` reads of a subject: the two fields the Subjects card renders. */
export type WeeklyReviewSubject = Pick<ChildSubject, 'enabled' | 'generatedPractice'>;

export interface NoWeeklyReviewsState {
  readonly childName: string;
  /** The profile's status as GET /v1/family reports it; `undefined` is legal and fails closed. */
  readonly childStatus: string | undefined;
  /**
   * The child's subjects AS THE SUBJECTS CARD RENDERS THEM — the array, not a precomputed flag
   * (L-071), because the flag is what a caller could get wrong: the portal once claimed "no subject is
   * on" for a child whose only enabled subject was CUSTOM, which the Subjects card beside it printed
   * as "On". `generatedPractice` is false for a custom subject (the subjects GET computes it as
   * `isBankSubject(row.subject_key)`, apps/api/src/routes/learning.ts), and a custom-only child is
   * precisely the one with subjects on and no weekly review.
   *
   * `undefined` means this surface has not loaded them — the app's planner renders the Coming up card
   * as soon as the SCHEDULE arrives, and the subjects are a second request that can still be in flight
   * or have failed. No cause is then claimed at all, rather than the cause an empty array would imply.
   */
  readonly subjects: readonly WeeklyReviewSubject[] | undefined;
}

/**
 * The line printed in place of the review list when `nextReviewReleases` is empty — the portal's four
 * sentences, now the app's too. The app had two, and its hedged one said "No weekly reviews are
 * scheduled." where the portal said "…scheduled yet.", named no subject at all, and had no archived
 * arm: HUNT7-H-1 agreed the DAILY line across the surfaces and left this weekly half behind.
 *
 * The list is empty when the child has no enabled BANK subject — `storedPlan` builds the set from
 * `child_subjects … and enabled` and keeps only `BANK_SUBJECTS`, `scheduleResponse` drops any release
 * whose subject is not a bank subject, and with an enabled bank subject it always iterates the current
 * AND next ISO week, so a future release exists (apps/api/src/routes/learning.ts). It is ALSO empty
 * with such a subject on, when `reviewReleases` answers !ok for both weeks on an invalid stored
 * schedule or week key — the state nobody enumerated (L-057). That arm is first, and it claims no
 * cause, because neither "no subject is on" nor "turn one on" is true of it.
 *
 * The instruction is printed only where the control it names can be pressed. For an archived profile
 * the subject checkbox is permanently disabled and the add-subject form is not rendered, so
 * "Turn on at least one subject" pointed at a dead control and contradicted the section that owns it;
 * that arm names the parent's real move instead. A DRAFT profile keeps the instruction — the same
 * guard keeps its subjects writable — but not the PROMISE, because no non-active profile receives a
 * review.
 */
export function noWeeklyReviewsCopy(state: NoWeeklyReviewsState): string {
  const { childName, childStatus, subjects } = state;
  const prepared = receivesPractice(childStatus);
  // The cause is claimable only when the subjects are KNOWN and none of them bears a weekly review.
  const noReviewSubject =
    subjects !== undefined && !subjects.some((s) => s.enabled && s.generatedPractice);
  if (!noReviewSubject) {
    return prepared
      ? 'No weekly review is scheduled for this week or next.'
      : `No weekly review is scheduled for this week or next. A review is prepared once ${childName}’s profile is active.`;
  }
  // 'archived' is the one status whose subject writes the API refuses (422 CHILD_ARCHIVED), i.e. the
  // negation of `childPlanEditable`; it is NOT `receivesPractice`, which a draft also fails.
  if (childStatus === 'archived') {
    return `No weekly reviews are scheduled: no subject that gets a weekly review is on, and subjects can’t be turned on or off while ${childName}’s profile is archived. Activate ${childName} again on the Children page, while a paid slot is free, to change that.`;
  }
  return prepared
    ? 'No weekly reviews are scheduled yet. Turn on at least one subject that PencilLift makes practice for to get a review.'
    : `No weekly reviews are scheduled yet. Turn on at least one subject that PencilLift makes practice for; a review is prepared once ${childName}’s profile is active.`;
}

// ---------------------------------------------------------------------------------------------
// Test dates and study material
// ---------------------------------------------------------------------------------------------

export const testDateSchema = z.strictObject({
  id: uuidSchema,
  subjectId: uuidSchema,
  subjectKey: subjectKeySchema,
  testDate: calendarDateSchema,
  scopeNotes: z.string().nullable(),
  /** Bank skills recognized in the scope notes (transparent keyword matching). */
  matchedSkills: z.array(z.strictObject({ skill: z.string(), label: z.string() })),
});
export type TestDate = z.infer<typeof testDateSchema>;

export const testDatesResponseSchema = z.strictObject({ testDates: z.array(testDateSchema) });

export const createTestDateRequestSchema = z.strictObject({
  subjectId: uuidSchema,
  testDate: calendarDateSchema,
  scopeNotes: freeTextSchema({ min: 0, max: 2000 }).optional(),
});
export type CreateTestDateRequest = z.infer<typeof createTestDateRequestSchema>;

export const testDateResponseSchema = z.strictObject({ testDate: testDateSchema });

export const STUDY_MATERIAL_KINDS = ['spelling_list', 'taught_notes', 'reading_passage'] as const;
export const studyMaterialKindSchema = z.enum(STUDY_MATERIAL_KINDS);

/** Per-kind text limits (characters). */
export const STUDY_MATERIAL_MAX_CHARS: Readonly<
  Record<(typeof STUDY_MATERIAL_KINDS)[number], number>
> = {
  spelling_list: 2000,
  taught_notes: 4000,
  reading_passage: 4000,
};

export const createStudyMaterialRequestSchema = z
  .strictObject({
    kind: studyMaterialKindSchema,
    subjectId: uuidSchema.optional(),
    text: freeTextSchema({ max: 4000 }),
  })
  .refine((v) => v.text.length <= STUDY_MATERIAL_MAX_CHARS[v.kind], {
    message: 'That is too long for this kind of material',
    path: ['text'],
  });
export type CreateStudyMaterialRequest = z.infer<typeof createStudyMaterialRequestSchema>;

export const studyMaterialResponseSchema = z.strictObject({
  material: z.strictObject({
    id: uuidSchema,
    kind: studyMaterialKindSchema,
    subjectId: uuidSchema.nullable(),
    createdAt: isoDateTimeSchema,
    /** Words recognized in a spelling list (null for other kinds). */
    spellingWords: z.number().int().min(0).nullable(),
    matchedSkills: z.array(z.strictObject({ skill: z.string(), label: z.string() })),
  }),
});
export type StudyMaterialResponse = z.infer<typeof studyMaterialResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Skill evidence (parent dashboard; AC_LEARNING_01/02)
// ---------------------------------------------------------------------------------------------

export const skillStatusSchema = z.enum([
  'not_enough_evidence',
  'needs_practice',
  'developing',
  'strong',
]);

export const skillSummarySchema = z.strictObject({
  subjectKey: z.string(),
  skill: z.string(),
  label: z.string(),
  status: skillStatusSchema,
  /** "Not enough evidence" under five distinct independent questions; never "mastered". */
  statusLabel: z.string(),
  distinctQuestions: z.number().int().min(0),
  distinctIndependentQuestions: z.number().int().min(0),
  /** First unaided tries answered correctly / first tries. */
  initialAccuracy: z.number().min(0).max(1).nullable(),
  /** Questions eventually answered correctly (after hints/retries) / questions with a graded try. */
  eventualCompletionRate: z.number().min(0).max(1).nullable(),
  lastPracticedAt: isoDateTimeSchema.nullable(),
});
export type SkillSummaryDto = z.infer<typeof skillSummarySchema>;

export const skillsResponseSchema = z.strictObject({
  childId: uuidSchema,
  skills: z.array(skillSummarySchema),
  /** Plain-language statement of the evidence rule (not a psychometric test). */
  evidenceRule: z.string(),
  coverage: z.strictObject({
    subjects: z.array(
      z.strictObject({
        subjectKey: supportedSubjectKeySchema,
        supportedSkills: z.array(z.strictObject({ skill: z.string(), label: z.string() })),
        unsupported: z.array(z.string()),
      }),
    ),
    general: z.array(z.string()),
  }),
});
export type SkillsResponse = z.infer<typeof skillsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Practice sets: child-safe question DTOs (AC_GRADING_06: no key, explanation or grading fields)
// ---------------------------------------------------------------------------------------------

export const practiceSetKindSchema = z.enum(['daily', 'thursday_review', 'top_up']);
export const practiceSetStatusSchema = z.enum(['ready', 'in_progress', 'completed']);

export const childPromptSchema = z.strictObject({
  text: z.string(),
  choices: z.array(z.string()).nullable(),
  passage: z.strictObject({ title: z.string(), text: z.string() }).nullable(),
  responseFormat: z.enum(['number', 'division', 'choice', 'word', 'text']),
  unitHint: z.string().nullable(),
});
export type ChildPromptDto = z.infer<typeof childPromptSchema>;

export const itemStatusSchema = z.enum(['not_started', 'correct', 'try_again', 'help_offered']);

export const childPracticeItemSchema = z.strictObject({
  id: uuidSchema,
  position: z.number().int().min(1),
  subjectKey: z.string(),
  topic: z.string(),
  prompt: childPromptSchema,
  progress: z.strictObject({ status: itemStatusSchema, attempts: z.number().int().min(0) }),
});
export type ChildPracticeItem = z.infer<typeof childPracticeItemSchema>;

export const childPracticeSetSchema = z.strictObject({
  id: uuidSchema,
  kind: practiceSetKindSchema,
  status: practiceSetStatusSchema,
  subjectKey: z.string().nullable(),
  localDate: calendarDateSchema.nullable(),
  reviewWeek: z.string().nullable(),
  version: z.number().int().min(1),
  /** Top-ups are optional extra practice. */
  optional: z.boolean(),
  /** Guarded, child-safe welcome line (AI personalization) or null. */
  intro: z.string().nullable(),
  items: z.array(childPracticeItemSchema),
});
export type ChildPracticeSet = z.infer<typeof childPracticeSetSchema>;

export const childPracticeTodayResponseSchema = z.strictObject({
  state: z.enum(['available', 'preparing', 'paused', 'not_scheduled']),
  localDate: calendarDateSchema,
  releaseAt: isoDateTimeSchema.nullable(),
  set: childPracticeSetSchema.nullable(),
});
export type ChildPracticeToday = z.infer<typeof childPracticeTodayResponseSchema>;

export const childReviewsResponseSchema = z.strictObject({
  weekKey: z.string(),
  state: z.enum(['available', 'preparing', 'not_scheduled']),
  sections: z.array(
    z.strictObject({
      subjectKey: z.string(),
      displayName: z.string(),
      sets: z.array(childPracticeSetSchema),
    }),
  ),
});
export type ChildReviews = z.infer<typeof childReviewsResponseSchema>;

/** POST /v1/child/practice/items/:itemId/answer */
export const practiceAnswerRequestSchema = z.strictObject({
  answer: freeTextSchema({ max: 200, trim: false }),
  idempotencyKey: idempotencyKeySchema,
});
export type PracticeAnswerRequest = z.infer<typeof practiceAnswerRequestSchema>;

/** Never contains the correct answer (AC_GRADING_06). */
export const practiceAnswerResponseSchema = z.strictObject({
  result: z.enum(['correct', 'try_again', 'unresolved']),
  /** Graded attempts on this question so far, including this one when it was graded. */
  attemptNumber: z.number().int().min(0),
  /** After three unsuccessful tries: offer method practice or a grown-up's help (spec P6). */
  offerHelp: z.boolean(),
  itemStatus: itemStatusSchema,
  pointsAwarded: z.number().int().min(0),
  setCompleted: z.boolean(),
});
export type PracticeAnswerResponse = z.infer<typeof practiceAnswerResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Parent views of practice sets, the protected answer key and review PDF exports
// ---------------------------------------------------------------------------------------------

export const parentPracticeItemSchema = z.strictObject({
  id: uuidSchema,
  position: z.number().int().min(1),
  subjectKey: z.string(),
  skill: z.string(),
  topic: z.string(),
  category: z.string(),
  prompt: childPromptSchema,
  progress: z.strictObject({
    status: itemStatusSchema,
    attempts: z.number().int().min(0),
    firstTry: z.enum(['correct', 'incorrect']).nullable(),
  }),
});

export const parentPracticeSetSchema = z.strictObject({
  id: uuidSchema,
  kind: practiceSetKindSchema,
  status: z.enum(['generating', 'ready', 'in_progress', 'completed', 'expired', 'failed']),
  subjectKey: z.string().nullable(),
  localDate: calendarDateSchema.nullable(),
  reviewWeek: z.string().nullable(),
  version: z.number().int().min(1),
  optional: z.boolean(),
  readyAt: isoDateTimeSchema.nullable(),
  releaseAt: isoDateTimeSchema.nullable(),
  /** How the set was composed (weak/spaced/confidence...), for the parent. */
  mix: z.record(z.string(), z.number()),
  /** Parent-facing explanations of the mix (fills, shortfalls, fallbacks). */
  notes: z.array(z.strictObject({ code: z.string(), message: z.string() })),
  items: z.array(parentPracticeItemSchema),
});
export type ParentPracticeSet = z.infer<typeof parentPracticeSetSchema>;

/** `<created_at in epoch microseconds>_<id>` of the last set on a page (…/practice-sets?after=). */
export const practiceSetCursorSchema = z
  .string()
  .regex(/^[0-9]{1,19}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const PARENT_PRACTICE_SET_PAGE_SIZE = 30;

/**
 * GET /v1/children/:childId/practice-sets[?kind=][&week=][&after=<nextCursor>]. Newest first, at
 * most 30 per page. `nextCursor` is set while older sets exist (API-AUTH-R2-04): the list used to be
 * a hard cap of 30, so after about a month of daily sets the older ones — and the answer keys and
 * review PDFs reached through their ids — could not be listed at all. The API always sends it;
 * optional so payloads from before it existed still parse.
 */
export const practiceSetsResponseSchema = z.strictObject({
  sets: z.array(parentPracticeSetSchema).max(PARENT_PRACTICE_SET_PAGE_SIZE),
  nextCursor: practiceSetCursorSchema.nullable().optional(),
});
export type PracticeSets = z.infer<typeof practiceSetsResponseSchema>;

/** GET /v1/practice-sets/:id/answer-key (parent + recent step-up). */
export const answerKeyResponseSchema = z.strictObject({
  setId: uuidSchema,
  items: z.array(
    z.strictObject({
      itemId: uuidSchema,
      position: z.number().int().min(1),
      answer: z.string(),
      explanation: z.string().nullable(),
    }),
  ),
});
export type AnswerKeyResponse = z.infer<typeof answerKeyResponseSchema>;

/** POST /v1/exports/review-pdf. `answer_key` needs a recent step-up (spec P8). */
export const reviewPdfExportRequestSchema = z.strictObject({
  setId: uuidSchema,
  variant: z.enum(['questions', 'answer_key']),
});
export type ReviewPdfExportRequest = z.infer<typeof reviewPdfExportRequestSchema>;

export const reviewPdfExportResponseSchema = z.strictObject({
  exportId: uuidSchema,
  kind: z.enum(['review_questions_pdf', 'review_answer_key_pdf']),
  status: z.literal('queued'),
});
export type ReviewPdfExportResponse = z.infer<typeof reviewPdfExportResponseSchema>;
