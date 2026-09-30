import { z } from 'zod';

/**
 * Strict output schemas (spec P12: versioned prompts with strict JSON schemas). OpenAI structured
 * outputs in strict mode need every property required and no additional properties, so optional
 * values are modelled as nullable. `toStrictJsonSchema` verifies that at load time.
 */

const answerKind = z.enum([
  'numeric',
  'quantity',
  'division_remainder',
  'multiple_choice',
  'spelling',
  'exact_text',
  'open_response',
  'writing',
]);
const subject = z.enum([
  'math',
  'reading',
  'spelling_vocabulary',
  'grammar_writing',
  'science',
  'social_studies',
  'other',
]);
const level = z.enum(['low', 'medium', 'high']);

export const extractionOutputSchema = z.strictObject({
  pages: z.array(
    z.strictObject({
      pageNumber: z.number().int().min(1),
      readable: z.boolean(),
      issues: z.array(
        z.enum(['blurry', 'glare', 'rotated', 'cut_off', 'missing_passage', 'not_homework']),
      ),
    }),
  ),
  questions: z.array(
    z.strictObject({
      pageNumber: z.number().int().min(1),
      questionNumber: z.string().min(1).max(20),
      boundingBox: z
        .strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullable(),
      promptText: z.string().max(4000),
      studentAnswerText: z.string().max(4000).nullable(),
      answerKind,
      subject,
      skill: z.string().min(1).max(120),
      gradeEstimate: z.number().int().min(0).max(12).nullable(),
      uncertainty: level,
    }),
  ),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/** PRIVATE: parent-only content. Never serialized to a child DTO. */
export const gradingOutputSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      questionNumber: z.string().min(1).max(20),
      verdict: z.enum(['correct', 'incorrect', 'unresolved', 'unanswered', 'rubric']),
      correctAnswer: z.string().max(2000),
      workedSolution: z.string().max(4000),
      misconception: z.string().max(1000).nullable(),
      rubric: z
        .array(z.strictObject({ criterion: z.string(), met: z.boolean(), note: z.string() }))
        .nullable(),
      evidence: z.string().max(2000),
      confidence: level,
    }),
  ),
});
export type GradingOutput = z.infer<typeof gradingOutputSchema>;

export const verificationOutputSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      questionNumber: z.string().min(1).max(20),
      agrees: z.boolean(),
      verdict: z.enum(['correct', 'incorrect', 'unresolved', 'unanswered', 'rubric']),
      reason: z.string().max(1000),
      confidence: level,
    }),
  ),
});
export type VerificationOutput = z.infer<typeof verificationOutputSchema>;

/** Child-facing coaching packet: method guidance only; there is no field for an answer. */
export const coachingPacketSchema = z.strictObject({
  steps: z
    .array(
      z.strictObject({
        kind: z.enum([
          'concept',
          'next_step_question',
          'hint',
          'analogous_example',
          'encouragement',
        ]),
        text: z.string().min(1).max(600),
      }),
    )
    .min(1)
    .max(8),
  retryPrompt: z.string().min(1).max(200),
});
export type CoachingPacket = z.infer<typeof coachingPacketSchema>;

export const adultSummarySchema = z.strictObject({
  highlights: z.array(z.string().max(300)).max(6),
  practiceAreas: z
    .array(z.strictObject({ skill: z.string().max(120), note: z.string().max(300) }))
    .max(6),
  suggestions: z.array(z.string().max(300)).max(6),
});
export type AdultSummary = z.infer<typeof adultSummarySchema>;

/**
 * Child-facing practice personalization (daily sets and Thursday reviews). The model never sees or
 * returns an answer: it may only propose a story context for listed word problems (re-rendered by
 * the bank with the SAME numbers and re-validated) and one short intro line (leak-guarded).
 */
export const practicePersonalizationSchema = z.strictObject({
  intro: z.string().min(1).max(200),
  items: z
    .array(
      z.strictObject({
        ref: z.string().min(1).max(8),
        context: z
          .strictObject({
            name: z.string().min(1).max(20),
            things: z.string().min(1).max(40),
            place: z.string().min(1).max(40),
          })
          .nullable(),
      }),
    )
    .max(40),
});
export type PracticePersonalization = z.infer<typeof practicePersonalizationSchema>;

type JsonSchema = Record<string, unknown>;

function assertStrict(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const schema = node as JsonSchema;
  if (schema.type === 'object' || schema.properties !== undefined) {
    const props = Object.keys((schema.properties as JsonSchema | undefined) ?? {});
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const missing = props.filter((p) => !required.has(p));
    if (missing.length > 0)
      throw new Error(`Strict schema ${path}: properties not required: ${missing.join(', ')}`);
    if (schema.additionalProperties !== false)
      throw new Error(`Strict schema ${path}: additionalProperties must be false`);
  }
  for (const [key, value] of Object.entries(schema)) assertStrict(value, `${path}.${key}`);
}

/** JSON Schema for OpenAI strict structured outputs; throws if the zod schema is not strict-compatible. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as JsonSchema;
  delete json.$schema;
  assertStrict(json, '$');
  return json;
}

/**
 * What the adult ID check asks the vision model for, and the whole of it (migration 0980).
 *
 * Note what it does NOT ask for: no name, no address, no document number, no photograph description
 * and no face comparison. The model returns the date of birth and the expiry date because the SERVER
 * has to compute adulthood and currency against its own clock rather than trust a model's arithmetic;
 * `apps/api/src/providers/identity-openai.ts` uses both and returns only booleans, so neither date
 * reaches the database, a log or the response. Asking for less than this would mean trusting the model
 * to do date arithmetic; asking for more would mean carrying identity data the product does not need.
 */
export const identityDocumentReadSchema = z.strictObject({
  /** Is this a genuine government-issued photo identity document (licence, state ID, passport)? */
  isGovernmentPhotoId: z.boolean(),
  /** Which kind, for the audit trail's provider reference only. 'other' covers anything unlisted. */
  documentKind: z.enum(['drivers_licence', 'state_id', 'passport', 'other']),
  /** Could the model read the document at all? False means retake the photo, not that it failed. */
  readable: z.boolean(),
  /** The printed date of birth, `YYYY-MM-DD`, or null when it is absent or unreadable. */
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** The printed expiry date, `YYYY-MM-DD`, or null for a document that carries none. */
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

/**
 * What the face comparison asks for. It is a SEPARATE call from the document read, for two reasons
 * that both matter: the two questions have different answers available to different providers, and a
 * provider that refuses the comparison must not take the document read down with it.
 *
 * `refused` is a first-class answer. OpenAI's usage policies prohibit biometric identification and
 * their vision models decline to compare faces, so that adapter records `refused` and the check cannot
 * confirm — by construction, since `adult_confirmed` in migration 0980 is generated and requires
 * `matched`. A dedicated identity vendor answers `same_person` or `different_person`.
 */
export const identityFaceCompareSchema = z.strictObject({
  verdict: z.enum(['same_person', 'different_person', 'cannot_tell', 'declined']),
});
