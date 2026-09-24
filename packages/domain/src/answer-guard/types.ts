// Public vocabulary of the answer-leak guard (spec P6, P12, E4 "Answer protection").

export const PROTECTED_ANSWER_KINDS = ['numeric', 'multiple_choice', 'spelling', 'text'] as const;
export type ProtectedAnswerKind = (typeof PROTECTED_ANSWER_KINDS)[number];

/** A withheld answer. Lives only in the protected backend; never serialized to a child. */
export interface ProtectedAnswer {
  readonly kind: ProtectedAnswerKind;
  readonly value: string;
  readonly alternates?: readonly string[];
}

export const LEAK_DETECTORS = [
  'numeric',
  'multiple_choice',
  'spelling',
  'text',
  'encoding',
  'url',
  'fail_closed',
] as const;
export type LeakDetector = (typeof LEAK_DETECTORS)[number];

export const ENCODING_KINDS = ['base64', 'hex', 'percent', 'rot13', 'markup'] as const;
export type EncodingKind = (typeof ENCODING_KINDS)[number];

/**
 * One reason content is unsafe.
 *
 * Decision: `evidence` is payload-free: only the offset and length in canonical text plus a
 * masked shape (letters -> '*', digits -> '#'). It never contains the child-facing text or any
 * part of a protected answer, so findings can be logged (spec P4 "operational logs
 * payload-free").
 */
export interface LeakFinding {
  readonly detector: LeakDetector;
  /** Index into the `answers` array, or null for answer-independent findings (URLs, limits). */
  readonly answerIndex: number | null;
  /** Stable machine name of the rule that fired, e.g. `fraction`, `acrostic_lines`. */
  readonly technique: string;
  readonly evidence: string;
  /** Decoding chain for findings inside encoded content, outermost first. Empty if direct. */
  readonly via: readonly EncodingKind[];
}

export interface LeakScanResult {
  readonly safe: boolean;
  readonly findings: readonly LeakFinding[];
}

export interface ScanOptions {
  /** Maximum input length in UTF-16 code units. Longer input fails closed. Default 20 000. */
  readonly maxTextLength?: number;
  /** Maximum decode depth for nested encodings (0..2). Default and maximum 2. */
  readonly maxEncodingDepth?: number;
}

export interface PacketScanOptions extends ScanOptions {
  /** Maximum object/array nesting depth. Default 24. */
  readonly maxDepth?: number;
  /** Maximum number of visited values (objects, arrays, primitives). Default 2 000. */
  readonly maxNodes?: number;
  /** Maximum total characters across all strings and keys. Default 100 000. */
  readonly maxTotalChars?: number;
  /**
   * Exact JSON paths (as reported in findings, e.g. `$.submittedAnswer`) whose string values are
   * the child's OWN submitted answer. Spec P6/E4 let a child see their own answer, so these values
   * skip answer-comparison detectors; URL detection and forbidden-key checks still apply.
   * Populate only from server-side constants, never from model output.
   */
  readonly ownSubmissionPaths?: readonly string[];
}

export type PacketFindingLocation = 'value' | 'key' | 'combined' | 'structure';

export interface PacketLeakFinding extends LeakFinding {
  /** JSON path, e.g. `$.hintSteps[2]`. Keys that are not plain identifiers appear as `[#i]`. */
  readonly path: string;
  readonly location: PacketFindingLocation;
}

export interface PacketScanResult {
  readonly safe: boolean;
  readonly findings: readonly PacketLeakFinding[];
}

export const ANSWER_GUARD_ERROR_CODES = [
  'INVALID_ANSWER_LIST',
  'TOO_MANY_ANSWERS',
  'INVALID_ANSWER_KIND',
  'EMPTY_ANSWER_VALUE',
  'ANSWER_TOO_LONG',
  'INVALID_ALTERNATES',
  'UNPARSEABLE_NUMERIC_ANSWER',
  'INVALID_MULTIPLE_CHOICE_VALUE',
] as const;
export type AnswerGuardErrorCode = (typeof ANSWER_GUARD_ERROR_CODES)[number];

export const GUARD_REASON_CODES = [
  'LEAK_DETECTED',
  'FORBIDDEN_FIELD',
  'LIMIT_EXCEEDED',
  'UNSUPPORTED_VALUE',
  'INVALID_PROTECTED_ANSWER',
  'NO_PROTECTED_ANSWERS',
  'SCAN_ERROR',
] as const;
export type GuardReasonCode = (typeof GUARD_REASON_CODES)[number];

export interface GuardInput {
  readonly packet: unknown;
  readonly answers: readonly ProtectedAnswer[];
  readonly options?: PacketScanOptions;
  /**
   * Decision: an empty `answers` list blocks by default, because a forgotten answer list would
   * otherwise silently disable every comparison. Content with genuinely nothing to protect
   * (e.g. encouragement) must say so explicitly.
   */
  readonly allowNoProtectedAnswers?: boolean;
}

export interface GuardReason {
  readonly code: GuardReasonCode;
  readonly path: string;
  readonly detector: LeakDetector | null;
  readonly answerIndex: number | null;
  /** Payload-free description: rule name plus masked evidence. */
  readonly detail: string;
}

export type GuardDecisionKind = 'release' | 'block';

export interface GuardDecision {
  readonly decision: GuardDecisionKind;
  readonly reasons: readonly GuardReason[];
}
