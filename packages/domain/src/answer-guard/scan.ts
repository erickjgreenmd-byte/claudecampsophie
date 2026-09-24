// Orchestrates the detectors over a text and its decoded views (bounded recursion, fail closed).
//
// Known limitations (this is ONE defense-in-depth layer; spec E4: "Do not treat a simple
// substring filter or a second model's approval as proof that answers cannot leak"):
// - Semantic paraphrase ("the number of legs on a spider" for 8), riddles, rhymes, hints that let
//   the child infer the value, and arithmetic expressions that evaluate to it ("6 x 7") are NOT
//   detected; expressions are never evaluated (numbers are data, never code).
// - Translation beyond English/Spanish number words (e.g. French, CJK numerals, "aprender" for
//   "learn") is not detected; Spanish number words above 100 other than "ciento"/"mil" are not
//   read. Decimal digits of every script are read (canonicalize maps them to ASCII).
// - Unit conversions ("120 mm" for 12 cm), Roman numerals, ratios written "3:4", scientific
//   notation and repeating-decimal overlines are not read. "a in b" is read only when a <= b.
// - Bare "first"/"second" ("primero"/"segundo") are sequencing/time words and are not read as
//   1/2; other ordinals are ("fifth" -> 5). Numerals with more than 40 significant digits are
//   not compared; they fail closed when a numeric answer is protected.
// - Encoded bytes that are not clean text are recovered only within bounds (at most 1/4 junk
//   bytes, a 4-character clean run; word-shaped base64 tokens only when clean); heavier padding
//   is not decoded.
// - Letters that are not in the homoglyph table, leetspeak beyond the basic substitutions,
//   repeated letters ("leeearn"), last-letter acrostics and cross-field splits other than the
//   joined-packet scan are not detected.
// - Base64/hex shorter than the generic thresholds is caught only for the answers' own literal
//   forms; other ciphers (Caesar shifts other than 13, Morse, custom alphabets) are not decoded.
// - Content inside images, audio or any non-text asset is out of scope.
// Downstream controls (strict schemas, safe templates, human review, rate-limited retries) remain
// required.

import { normalizeProtectedAnswers, type NormalizedAnswer } from './answers.ts';
import { detectChoice } from './detect-choice.ts';
import { detectNumeric } from './detect-numeric.ts';
import { compileTargets, detectTargets, type CompiledTargets } from './detect-target.ts';
import { detectUrls } from './detect-url.ts';
import {
  detectEncodedLiterals,
  findEncodedSpans,
  markupView,
  rot13View,
  type DecodedCandidate,
} from './encodings.ts';
import type { MarkerState } from './numbers.ts';
import type {
  EncodingKind,
  LeakFinding,
  LeakScanResult,
  ProtectedAnswer,
  ScanOptions,
} from './types.ts';
import { makeView, maskedShape, viewOfCanonical, type RawFinding, type TextView } from './view.ts';

export const DEFAULT_SCAN_LIMITS = { maxTextLength: 20_000, maxEncodingDepth: 2 } as const;
const MAX_ENCODING_DEPTH = 2;
const MAX_VIEWS_PER_SCAN = 256;
const MAX_FINDINGS = 200;
/** NFKC can expand text; canonical text longer than this multiple of the limit fails closed. */
const EXPANSION_FACTOR = 4;

export interface InternalFinding extends LeakFinding {
  readonly start: number;
  readonly end: number;
}

export interface ScanContext {
  readonly answers: readonly NormalizedAnswer[];
  readonly compiled: CompiledTargets;
  readonly maxTextLength: number;
  readonly maxEncodingDepth: number;
}

export interface TextScanOptions {
  /** List-marker numbering carried across the strings of one packet. */
  readonly markerState?: MarkerState;
  /** Opaque identifiers/timestamps: skip numeric comparison only. */
  readonly skipNumeric?: boolean;
  /** The child's own submission: only URL detection applies. */
  readonly urlsOnly?: boolean;
  readonly maxEncodingDepth?: number;
  /** Report still-encoded content at the depth limit (default true). */
  readonly reportDepthExceeded?: boolean;
  readonly maxTextLength?: number;
}

interface Budget {
  views: number;
  decodedChars: number;
  readonly maxDecodedChars: number;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createScanContext(
  answers: readonly NormalizedAnswer[],
  options: ScanOptions = {},
): ScanContext {
  const depth = options.maxEncodingDepth;
  return {
    answers,
    compiled: compileTargets(answers),
    maxTextLength: positiveIntegerOr(options.maxTextLength, DEFAULT_SCAN_LIMITS.maxTextLength),
    // Decision: an invalid depth falls back to the maximum (more decoding, never less).
    maxEncodingDepth:
      depth !== undefined && Number.isInteger(depth) && depth >= 0 && depth <= MAX_ENCODING_DEPTH
        ? depth
        : MAX_ENCODING_DEPTH,
  };
}

export function failClosed(technique: string): InternalFinding {
  return {
    detector: 'fail_closed',
    answerIndex: null,
    technique,
    evidence: '',
    via: [],
    start: 0,
    end: 0,
  };
}

function directFindings(
  view: TextView,
  ctx: ScanContext,
  opts: TextScanOptions,
  markerState: MarkerState,
): RawFinding[] {
  if (opts.urlsOnly === true) return detectUrls(view);
  return [
    ...(opts.skipNumeric === true ? [] : detectNumeric(view, ctx.answers, markerState)),
    ...detectChoice(view, ctx.answers),
    ...detectTargets(view, ctx.compiled),
    ...detectUrls(view),
    ...detectEncodedLiterals(view, ctx.answers),
  ];
}

function kindKey(f: { detector: string; answerIndex: number | null; technique: string }): string {
  return `${f.detector}|${f.answerIndex ?? '-'}|${f.technique}`;
}

function wrap(candidate: DecodedCandidate, inner: InternalFinding): InternalFinding {
  const via: EncodingKind[] = [candidate.kind, ...inner.via];
  const start = candidate.aligned ? inner.start : candidate.start;
  const end = candidate.aligned ? inner.end : candidate.end;
  if (inner.detector === 'fail_closed') return { ...inner, via, start, end };
  return {
    detector: 'encoding',
    answerIndex: inner.answerIndex,
    technique:
      inner.detector === 'encoding' ? inner.technique : `${inner.detector}:${inner.technique}`,
    evidence: inner.evidence,
    via,
    start,
    end,
  };
}

function scanView(
  view: TextView,
  ctx: ScanContext,
  opts: TextScanOptions,
  depth: number,
  budget: Budget,
  markerState: MarkerState,
  parentKind: EncodingKind | null,
): InternalFinding[] {
  const findings: InternalFinding[] = directFindings(view, ctx, opts, markerState).map((r) => ({
    detector: r.detector,
    answerIndex: r.answerIndex,
    technique: r.technique,
    evidence: maskedShape(view.text, r.start, r.end),
    via: r.via ?? [],
    start: r.start,
    end: r.end,
  }));
  if (opts.urlsOnly === true) return findings;

  const maxDepth = opts.maxEncodingDepth ?? ctx.maxEncodingDepth;
  const encoded = findEncodedSpans(view);
  if (depth >= maxDepth) {
    // Decision: content still encoded at the decode limit is itself a finding (fail closed).
    if (encoded.length > 0 && opts.reportDepthExceeded !== false) {
      findings.push(failClosed('encoding_depth_exceeded'));
    }
    return findings;
  }

  const derived: DecodedCandidate[] = [...encoded];
  if (parentKind !== 'markup') {
    const markup = markupView(view);
    if (markup !== null) derived.push(markup);
  }
  if (parentKind !== 'rot13') {
    const rot = rot13View(view);
    if (rot !== null) derived.push(rot);
  }

  const directKinds = new Set(findings.map(kindKey));
  for (const candidate of derived) {
    budget.views += 1;
    budget.decodedChars += candidate.decoded.length;
    if (budget.views > MAX_VIEWS_PER_SCAN || budget.decodedChars > budget.maxDecodedChars) {
      findings.push(failClosed('decode_budget_exceeded'));
      break;
    }
    const inner = candidate.aligned
      ? viewOfCanonical(candidate.decoded)
      : makeView(candidate.decoded);
    if (inner.text.length > budget.maxDecodedChars) {
      findings.push(failClosed('decode_budget_exceeded'));
      break;
    }
    const innerFindings = scanView(
      inner,
      ctx,
      opts,
      depth + 1,
      budget,
      new Map<string, number>(),
      candidate.kind,
    );
    for (const f of innerFindings) {
      if (candidate.kind === 'rot13' || candidate.kind === 'markup') {
        // Views that keep most of the original text: report only what the original did not.
        if (directKinds.has(kindKey(f))) continue;
        // ROT13 changes letters only; a span without letters is an original finding.
        if (
          candidate.kind === 'rot13' &&
          f.detector !== 'fail_closed' &&
          !/[a-z]/iu.test(inner.text.slice(f.start, f.end))
        ) {
          continue;
        }
      }
      findings.push(wrap(candidate, f));
    }
  }
  return findings;
}

function dedupe(findings: readonly InternalFinding[]): InternalFinding[] {
  const seen = new Set<string>();
  const out: InternalFinding[] = [];
  for (const f of findings) {
    const key = `${kindKey(f)}|${f.evidence}|${f.via.join('>')}|${f.start}|${f.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Scans one string with a prepared context. Never throws for string input. */
export function scanTextWithContext(
  text: unknown,
  ctx: ScanContext,
  opts: TextScanOptions = {},
): InternalFinding[] {
  if (typeof text !== 'string') return [failClosed('not_a_string')];
  const maxLength = opts.maxTextLength ?? ctx.maxTextLength;
  if (text.length > maxLength) return [failClosed('text_too_long')];
  const view = makeView(text);
  if (view.text.length > maxLength * EXPANSION_FACTOR) return [failClosed('text_too_long')];
  const budget: Budget = {
    views: 0,
    decodedChars: 0,
    maxDecodedChars: maxLength * EXPANSION_FACTOR,
  };
  const findings = scanView(
    view,
    ctx,
    opts,
    0,
    budget,
    opts.markerState ?? new Map<string, number>(),
    null,
  );
  const unique = dedupe(findings);
  if (unique.length > MAX_FINDINGS)
    return [...unique.slice(0, MAX_FINDINGS), failClosed('findings_limit')];
  return unique;
}

export function toLeakFinding(f: InternalFinding): LeakFinding {
  return {
    detector: f.detector,
    answerIndex: f.answerIndex,
    technique: f.technique,
    evidence: f.evidence,
    via: f.via,
  };
}

/**
 * Scans child-facing text for any disclosure of the protected answers, plus answer-independent
 * URL findings. `safe` is true only when there are no findings; invalid answers or oversized
 * input produce a `fail_closed` finding instead of a pass.
 */
export function scanForLeaks(
  text: string,
  answers: readonly ProtectedAnswer[],
  options: ScanOptions = {},
): LeakScanResult {
  const normalized = normalizeProtectedAnswers(answers);
  const findings = normalized.ok
    ? scanTextWithContext(text, createScanContext(normalized.value, options)).map(toLeakFinding)
    : [toLeakFinding(failClosed(`invalid_answer:${normalized.error.code}`))];
  return { safe: findings.length === 0, findings };
}
