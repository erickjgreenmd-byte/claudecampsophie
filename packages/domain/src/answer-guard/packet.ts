// Deep, bounded walk over a child-facing packet (spec P3 "No answer keys in child network
// responses ... hidden UI fields ... signed asset metadata"; P6 alt text, filenames, URLs).

import { normalizeProtectedAnswers } from './answers.ts';
import { canonicalize } from './canonicalize.ts';
import {
  createScanContext,
  failClosed,
  scanTextWithContext,
  toLeakFinding,
  type InternalFinding,
} from './scan.ts';
import type {
  PacketFindingLocation,
  PacketLeakFinding,
  PacketScanOptions,
  PacketScanResult,
  ProtectedAnswer,
} from './types.ts';

export const DEFAULT_PACKET_LIMITS = {
  maxDepth: 24,
  maxNodes: 2_000,
  maxTotalChars: 100_000,
} as const;

export type WalkProblem =
  | 'depth_limit'
  | 'node_limit'
  | 'total_chars_limit'
  | 'cycle'
  | 'unsupported_value'
  | 'accessor_property'
  | 'scan_error';

interface WalkLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxTotalChars: number;
}

interface WalkHooks {
  /** Called for each own enumerable key. Return true to redact the key in descendant paths. */
  key(key: string, index: number, parentPath: string): boolean;
  value(value: string, path: string, isNumber: boolean): void;
  problem(problem: WalkProblem, path: string): void;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

function segment(key: string, index: number, redact: boolean): string {
  return !redact && IDENTIFIER_RE.test(key) ? `.${key}` : `[#${index}]`;
}

function limitsFrom(options: PacketScanOptions): WalkLimits {
  const pick = (v: number | undefined, d: number) =>
    v !== undefined && Number.isSafeInteger(v) && v > 0 ? v : d;
  return {
    maxDepth: pick(options.maxDepth, DEFAULT_PACKET_LIMITS.maxDepth),
    maxNodes: pick(options.maxNodes, DEFAULT_PACKET_LIMITS.maxNodes),
    maxTotalChars: pick(options.maxTotalChars, DEFAULT_PACKET_LIMITS.maxTotalChars),
  };
}

/**
 * JSON-semantics walk: own enumerable string keys of plain objects and array elements. Getters
 * are reported, never invoked. Values JSON cannot carry faithfully (functions, symbols, class
 * instances such as Date/Map, boxed primitives) are reported as unsupported (fail closed).
 * Proxies may still run code; callers catch and fail closed.
 */
function walk(root: unknown, limits: WalkLimits, hooks: WalkHooks): void {
  let nodes = 0;
  let chars = 0;
  let stopped = false;
  const ancestors = new Set<object>();

  const countChars = (n: number, path: string): boolean => {
    chars += n;
    if (chars > limits.maxTotalChars) {
      hooks.problem('total_chars_limit', path);
      stopped = true;
      return false;
    }
    return true;
  };

  const visit = (value: unknown, path: string, depth: number): void => {
    if (stopped) return;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      hooks.problem('node_limit', path);
      stopped = true;
      return;
    }
    switch (typeof value) {
      case 'string':
        if (countChars(value.length, path)) hooks.value(value, path, false);
        return;
      case 'number':
        if (Number.isFinite(value)) hooks.value(String(value), path, true);
        return;
      case 'bigint':
        hooks.value(value.toString(), path, true);
        return;
      case 'boolean':
      case 'undefined':
        return;
      case 'symbol':
      case 'function':
        hooks.problem('unsupported_value', path);
        return;
      case 'object':
        break;
    }
    if (value === null) return;
    const obj: object = value;
    if (depth >= limits.maxDepth) {
      hooks.problem('depth_limit', path);
      return;
    }
    if (ancestors.has(obj)) {
      hooks.problem('cycle', path);
      return;
    }
    ancestors.add(obj);
    try {
      if (Array.isArray(obj)) {
        if (obj.length > limits.maxNodes) {
          hooks.problem('node_limit', path);
          stopped = true;
          return;
        }
        for (let i = 0; i < obj.length && !stopped; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(obj, String(i));
          if (descriptor === undefined) continue;
          const childPath = `${path}[${i}]`;
          if (descriptor.get !== undefined || descriptor.set !== undefined) {
            hooks.problem('accessor_property', childPath);
            continue;
          }
          visit(descriptor.value, childPath, depth + 1);
        }
        return;
      }
      const proto: unknown = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        hooks.problem('unsupported_value', path);
        return;
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length && !stopped; i++) {
        const key = keys[i] ?? '';
        if (!countChars(key.length, path)) return;
        const redact = hooks.key(key, i, path);
        const childPath = `${path}${segment(key, i, redact)}`;
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (descriptor === undefined) continue;
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          hooks.problem('accessor_property', childPath);
          continue;
        }
        visit(descriptor.value, childPath, depth + 1);
      }
    } finally {
      ancestors.delete(obj);
    }
  };

  visit(root, '$', 0);
}

// Decision: strings that are exactly a UUID or an ISO-8601 date/time are opaque identifiers or
// timestamps; they skip numeric comparison only (every other detector still runs). Without this,
// any packet carrying an ID would block for single-digit answers. Documented limitation: a value
// hidden inside such a string is not caught by the numeric detector.
const OPAQUE_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?)$/iu;

function packetFinding(
  f: InternalFinding,
  path: string,
  location: PacketFindingLocation,
): PacketLeakFinding {
  return { ...toLeakFinding(f), path, location };
}

/**
 * Scans every string value, number value and key of a child-facing packet, then the joined text
 * of all values (catches acrostics and splits across fields such as hint steps). Findings carry
 * JSON paths. Invalid answers, limits, cycles and unsupported values fail closed.
 */
export function scanChildPacket(
  packet: unknown,
  answers: readonly ProtectedAnswer[],
  options: PacketScanOptions = {},
): PacketScanResult {
  const normalized = normalizeProtectedAnswers(answers);
  if (!normalized.ok) {
    const f = failClosed(`invalid_answer:${normalized.error.code}`);
    return { safe: false, findings: [packetFinding(f, '$', 'structure')] };
  }
  const ctx = createScanContext(normalized.value, options);
  const limits = limitsFrom(options);
  const own = new Set(options.ownSubmissionPaths ?? []);
  const markerState = new Map<string, number>();
  const findings: PacketLeakFinding[] = [];
  const joined: string[] = [];

  // Decision: an exception while walking (e.g. a throwing Proxy trap) is a fail-closed finding,
  // not an exception, so every caller gets an unsafe result rather than an unhandled error.
  try {
    walk(packet, limits, {
      key(key, index, parentPath) {
        const keyFindings = scanTextWithContext(key, ctx);
        const path = `${parentPath}[#${index}]`;
        for (const f of keyFindings) findings.push(packetFinding(f, path, 'key'));
        return keyFindings.length > 0;
      },
      value(value, path, isNumber) {
        const ownSubmission = own.has(path);
        const opaque = !isNumber && OPAQUE_RE.test(value);
        const valueFindings = scanTextWithContext(value, ctx, {
          markerState,
          skipNumeric: opaque,
          urlsOnly: ownSubmission,
        });
        for (const f of valueFindings) findings.push(packetFinding(f, path, 'value'));
        if (!ownSubmission && !opaque) joined.push(value);
      },
      problem(problem, path) {
        findings.push(packetFinding(failClosed(problem), path, 'structure'));
      },
    });
  } catch {
    findings.push(packetFinding(failClosed('scan_error'), '$', 'structure'));
    return { safe: false, findings };
  }

  if (joined.length > 1) {
    // Decision: the joined scan reads list markers afresh, does not re-decode (each field was
    // decoded on its own) and reports only rule/answer combinations no single field produced.
    const seen = new Set(findings.map((f) => `${f.detector}|${f.answerIndex}|${f.technique}`));
    const combined = scanTextWithContext(joined.join('\n'), ctx, {
      maxEncodingDepth: 0,
      reportDepthExceeded: false,
      maxTextLength: limits.maxTotalChars,
    });
    for (const f of combined) {
      if (seen.has(`${f.detector}|${f.answerIndex}|${f.technique}`)) continue;
      findings.push(packetFinding(f, '$', 'combined'));
    }
  }
  return { safe: findings.length === 0, findings };
}

/**
 * Normalized fragments of key names that must never appear in a child DTO (AC_GRADING_06 withheld
 * keys/solutions and model internals; AC_MON_02 commercial fields). Keys are compared after
 * canonicalization with case, separators and homoglyphs removed, as substrings.
 *
 * Decision: substring matching is intentionally broad ("imageResolution" contains "solution",
 * "unexpected" contains "expected"); child DTO schemas must avoid such names rather than the guard
 * narrowing its net. "answer" alone is allowed so the child's own submitted answer can be shown.
 */
export const FORBIDDEN_KEY_FRAGMENTS = [
  'solution',
  'answerkey',
  'correctanswer',
  'workedsolution',
  'rubric',
  'expected',
  'grader',
  'confidence',
  'private',
  'parentonly',
  'modelconfidence',
  'sponsor',
  'affiliate',
  'advertis',
  'campaign',
  'rightanswer',
  'finalanswer',
  'targetanswer',
  'trueanswer',
  'acceptedanswer',
  'answersheet',
  'markscheme',
  'chainofthought',
  'withheld',
  'adunit',
  'adslot',
  'adcreative',
  'adnetwork',
  'adplacement',
  'amazon',
  'monetiz',
  'coupon',
  'promocode',
] as const;

function isForbiddenKey(key: string): boolean {
  const normalized = canonicalize(key).replace(/[^a-z0-9]/gu, '');
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export interface ForbiddenFieldScan {
  readonly forbidden: readonly string[];
  readonly problems: readonly { readonly problem: WalkProblem; readonly path: string }[];
}

export function scanForbiddenFields(
  dto: unknown,
  options: PacketScanOptions = {},
): ForbiddenFieldScan {
  const forbidden: string[] = [];
  const problems: { problem: WalkProblem; path: string }[] = [];
  try {
    walk(dto, limitsFrom(options), {
      key(key, index, parentPath) {
        if (isForbiddenKey(key)) forbidden.push(`${parentPath}${segment(key, index, false)}`);
        return false;
      },
      value() {},
      problem(problem, path) {
        problems.push({ problem, path });
      },
    });
  } catch {
    problems.push({ problem: 'scan_error', path: '$' });
  }
  return { forbidden, problems };
}

/**
 * JSON paths of keys a child DTO must not carry (withheld solutions, grading internals, private
 * or parent-only data, commercial/sponsor/affiliate fields). A DTO that cannot be fully walked
 * (cycle, limits, unsupported values, getters) yields `"<path> [unscannable:<reason>]"` entries,
 * so the result is never empty for an unverifiable DTO.
 */
export function findForbiddenFields(dto: unknown, options: PacketScanOptions = {}): string[] {
  const { forbidden, problems } = scanForbiddenFields(dto, options);
  return [...forbidden, ...problems.map((p) => `${p.path} [unscannable:${p.problem}]`)];
}
