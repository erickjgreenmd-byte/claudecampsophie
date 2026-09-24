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
