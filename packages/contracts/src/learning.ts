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

export const practiceSetsResponseSchema = z.strictObject({
  sets: z.array(parentPracticeSetSchema),
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
