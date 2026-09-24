// Release gate for child-facing content (spec P6 "Validate each packet before releasing it. If
// validation fails, use a safe template or ask for parent assistance; do not show unchecked
// output"; P12 "validate role-safe payloads and output leakage; fail closed").

import { normalizeProtectedAnswers } from './answers.ts';
import { scanChildPacket, scanForbiddenFields } from './packet.ts';
import { scanForLeaks } from './scan.ts';
import type {
  GuardDecision,
  GuardInput,
  GuardReason,
  GuardReasonCode,
  PacketLeakFinding,
  ProtectedAnswer,
} from './types.ts';

const LIMIT_TECHNIQUES = new Set([
  'text_too_long',
  'depth_limit',
  'node_limit',
  'total_chars_limit',
  'decode_budget_exceeded',
  'encoding_depth_exceeded',
  'findings_limit',
]);
const UNSUPPORTED_TECHNIQUES = new Set([
  'cycle',
  'unsupported_value',
  'accessor_property',
  'not_a_string',
]);

function reasonCode(f: PacketLeakFinding): GuardReasonCode {
  if (f.detector !== 'fail_closed') return 'LEAK_DETECTED';
  if (f.technique.startsWith('invalid_answer')) return 'INVALID_PROTECTED_ANSWER';
  if (f.technique === 'scan_error') return 'SCAN_ERROR';
  if (LIMIT_TECHNIQUES.has(f.technique)) return 'LIMIT_EXCEEDED';
  if (UNSUPPORTED_TECHNIQUES.has(f.technique)) return 'UNSUPPORTED_VALUE';
  return 'LEAK_DETECTED';
}

function reason(
  code: GuardReasonCode,
  path: string,
  detail: string,
  extra: Pick<GuardReason, 'detector' | 'answerIndex'> = { detector: null, answerIndex: null },
): GuardReason {
  return { code, path, detector: extra.detector, answerIndex: extra.answerIndex, detail };
}

function block(reasons: readonly GuardReason[]): GuardDecision {
  return { decision: 'block', reasons };
}

/**
 * Decides whether a child-facing packet may be released. Blocks on any leak finding, forbidden
 * field, limit, unsupported value, invalid or missing protected answers, and on any exception
 * while scanning (fail closed). Reasons are payload-free (rule names and masked evidence only).
 */
export function guardChildContent(input: GuardInput): GuardDecision {
  try {
    const answers: unknown = input.answers;
    const normalized = normalizeProtectedAnswers(answers);
    if (!normalized.ok) {
      return block([reason('INVALID_PROTECTED_ANSWER', '$', normalized.error.code)]);
    }
    const options = input.options ?? {};
    const reasons: GuardReason[] = [];
    if (normalized.value.length === 0 && input.allowNoProtectedAnswers !== true) {
      reasons.push(reason('NO_PROTECTED_ANSWERS', '$', 'no protected answers supplied'));
    }
    for (const path of scanForbiddenFields(input.packet, options).forbidden) {
      reasons.push(reason('FORBIDDEN_FIELD', path, 'forbidden key'));
    }
    const scan = scanChildPacket(input.packet, input.answers, options);
    for (const f of scan.findings) {
      const via = f.via.length > 0 ? ` via ${f.via.join('>')}` : '';
      reasons.push(
        reason(reasonCode(f), f.path, `${f.technique}${via} ${f.evidence}`.trim(), {
          detector: f.detector,
          answerIndex: f.answerIndex,
        }),
      );
    }
    return reasons.length === 0 ? { decision: 'release', reasons: [] } : block(reasons);
  } catch {
    // Decision: any exception (hostile proxy, exhausted resources, defect) blocks the release.
    return block([reason('SCAN_ERROR', '$', 'scan failed; content withheld')]);
  }
}

/**
 * True only when an analogous worked example (spec P6: "different numbers/context whose solution
 * does not reveal the target answer") passes the same scan. Fails closed: non-string input, an
 * empty or invalid answer list, or any exception returns false.
 */
export function analogousExampleIsSafe(input: {
  readonly exampleText: string;
  readonly answers: readonly ProtectedAnswer[];
}): boolean {
  try {
    if (typeof input.exampleText !== 'string') return false;
    if (!Array.isArray(input.answers) || input.answers.length === 0) return false;
    return scanForLeaks(input.exampleText, input.answers).safe;
  } catch {
    return false;
  }
}
