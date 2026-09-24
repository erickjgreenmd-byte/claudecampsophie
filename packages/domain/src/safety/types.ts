// Vocabulary of the safety screen (spec P4; AC_SECURITY_02). See index.ts for the rules and limits.

export const SAFETY_LEVELS = ['none', 'sensitive_educational', 'severe'] as const;
/**
 * `severe`: must not reach or stay with a child unanswered (child text: safety template + system
 * report; model output: reviewed fallback). `sensitive_educational`: a sensitive topic word with
 * no risk statement (anatomy in science, war in history, "kill" in a food chain); it never blocks
 * tutoring. `none`: nothing matched.
 */
export type SafetyLevel = (typeof SAFETY_LEVELS)[number];

/** Severe-risk categories. The last three apply to child-facing model output only. */
export const SEVERE_SAFETY_CATEGORIES = [
  'self_harm',
  'abuse',
  'violence',
  'sexual',
  'secrecy',
  'personal_contact',
  'companion_persona',
  'diagnosis',
  'ungrounded_topic',
] as const;
export type SevereSafetyCategory = (typeof SEVERE_SAFETY_CATEGORIES)[number];

/** Sensitive but educational topics (never severe on their own). */
export const SENSITIVE_TOPICS = [
  'body',
  'violence',
  'death',
  'substances',
  'self_harm_topic',
  'sexual_violence_topic',
] as const;
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

/** Mirrors the child profile age bands (packages/contracts family.ts). */
export const SAFETY_AGE_BANDS = ['5-7', '8-10', '11-13', '14-18'] as const;
export type SafetyAgeBand = (typeof SAFETY_AGE_BANDS)[number];

/** Who wrote the text: the child (answers, printed prompts) or a model (child-facing output). */
export type ScreenSource = 'child' | 'ai';

/** The assignment the text belongs to: the printed question and its subject key. */
export interface ScreenContext {
  readonly prompt?: string | null;
  readonly subject?: string | null;
}

export interface ScreenOptions {
  /** Selects template wording only; no rule is relaxed for any age. */
  readonly ageBand: SafetyAgeBand | null;
  readonly source?: ScreenSource;
  readonly context?: ScreenContext;
}

export interface SafetyScreen {
  readonly level: SafetyLevel;
  /** Severe categories, sorted; non-empty exactly when `level` is `severe`. */
  readonly categories: readonly SevereSafetyCategory[];
  /** Sensitive educational topics seen, sorted (may be present at any level). */
  readonly topics: readonly SensitiveTopic[];
  /** Stable rule codes, sorted; safe to log (never the matched text). */
  readonly codes: readonly string[];
  /** True when the input exceeded MAX_SCREEN_CHARS or MAX_SCREEN_TOKENS; only its start was screened. */
  readonly truncated: boolean;
}

/** A documented rule (exported for tests and review; the matcher compiles `pattern`). */
export interface SafetyRuleDoc {
  readonly id: string;
  readonly kind: 'severe' | 'topic';
  readonly category: SevereSafetyCategory | null;
  readonly topic: SensitiveTopic | null;
  readonly sources: readonly ScreenSource[];
  readonly doc: string;
}
