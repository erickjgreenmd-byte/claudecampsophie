// Answer-leak guard for child-facing content (spec P6, P3 last paragraph, P12, E4 "Answer
// protection"; AC_GRADING_06/07/08, AC_MON_02). One defense-in-depth layer: it fails closed but
// does not prove that answers cannot leak (known limitations are listed in scan.ts).
export {
  ANSWER_GUARD_ERROR_CODES,
  ENCODING_KINDS,
  GUARD_REASON_CODES,
  LEAK_DETECTORS,
  PROTECTED_ANSWER_KINDS,
  type AnswerGuardErrorCode,
  type EncodingKind,
  type GuardDecision,
  type GuardDecisionKind,
  type GuardInput,
  type GuardReason,
  type GuardReasonCode,
  type LeakDetector,
  type LeakFinding,
  type LeakScanResult,
  type PacketFindingLocation,
  type PacketLeakFinding,
  type PacketScanOptions,
  type PacketScanResult,
  type ProtectedAnswer,
  type ProtectedAnswerKind,
  type ScanOptions,
} from './types.ts';
export { canonicalize } from './canonicalize.ts';
export { extractNumericMentions, type NumericMention, type NumericReading } from './numbers.ts';
export type { Rational } from './rational.ts';
export {
  MAX_ALTERNATES,
  MAX_ANSWER_LENGTH,
  MAX_PROTECTED_ANSWERS,
  validateProtectedAnswers,
} from './answers.ts';
export { DEFAULT_SCAN_LIMITS, scanForLeaks } from './scan.ts';
export {
  DEFAULT_PACKET_LIMITS,
  FORBIDDEN_KEY_FRAGMENTS,
  findForbiddenFields,
  scanChildPacket,
} from './packet.ts';
export { analogousExampleIsSafe, guardChildContent } from './guard.ts';
