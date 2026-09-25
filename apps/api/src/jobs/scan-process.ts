import { z } from 'zod';
import {
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  HOMEWORK_SCAN_MAX_TOTAL_BYTES,
} from '@pencillift/contracts';
import {
  checkChildDataGate,
  dataEnvelope,
  dataUrlBytes,
  imagePartFromDataUrl,
  MODERATION_TIMEOUT_MS,
  moderationFlagged,
  PROMPTS,
  PROPOSED_STAGE_LIMITS,
  providerModerationCodes,
  providerSafetyScreen,
  runStage,
  type AgeBand,
  type AttemptRecord,
  type CoachingPacket,
  type ExtractionOutput,
  type GradingOutput,
  type InputPart,
  type ModerationClient,
  type ModerationResultItem,
  type PromptDefinition,
  type ResponsesClient,
  type VerificationOutput,
} from '@pencillift/ai';
import {
  canonicalize,
  extractNumericMentions,
  guardChildContent,
  MAX_PROTECTED_ANSWERS,
  validateProtectedAnswers,
  type NumericMention,
  type ProtectedAnswer,
} from '@pencillift/domain/answer-guard';
import {
  formatRational,
  gradeObjectiveQuestion,
  parseMathAnswer,
  parseMathAnswerDetailed,
  parseQuantity,
  resolveGrading,
  type AnswerKind,
  type CaptureIssue,
  type DeterministicVerdict,
  type ModelJudgment,
  type ModelVerdict,
  type ObjectiveQuestion,
} from '@pencillift/domain/grading';
import { DEFAULT_RATE_TABLE_2026_09_18 } from '@pencillift/domain/quotas';
import {
  childSafetyMessage,
  heldFromFamily,
  mergeScreens,
  SAFETY_SCREEN_VERSION,
  SAFETY_TEMPLATES_VERSION,
  screenModelOutput,
  screenQuestion,
  type SafetyScreen,
} from '@pencillift/domain/safety';
import { acceptsTestProviderConsent } from '../config.ts';
import type { Tx } from '../db.ts';
import type { StorageProvider } from '../providers/index.ts';
import { hasVerifiedConsent } from '../services/consent.ts';
import { ImageFormatError, stripImageMetadata } from '../services/image-metadata.ts';
import type { DeadLetterReason, JobDeferral, JobDeps, JobHandler, JobRow } from './dispatcher.ts';
import {
  acquireSpendHold,
  inputTokenUpperBound,
  settleSpend,
  SpendCeilingReached,
  usageRows,
  type UsageRow,
} from './spend-ceiling.ts';
import { childRubricFeedback, exampleWordingSpans } from './rubric-feedback.ts';

/**
 * Homework scan processing (spec P5, P6, P12; AC_CAPTURE_*, AC_GRADING_*). One durable job per
 * finalized scan (or per parent transcription correction) runs:
 *
 *   extraction (images → typed questions)  → deterministic checks + private grading
 *   → independent verification → resolution → leak-guarded child coaching → usage commit.
 *
 * Every write is idempotent (upserts keyed by assignment/page/question, unique attempt keys), so a
 * crash at any point is repaired by the job retry; a retry never re-extracts a scan whose questions
 * are already stored. AI calls never run inside a DB transaction. Before every AI stage and inside
 * every write batch the run re-checks that it may still process this child's data (no deletion, not
 * archived, consent still verified), so a deletion stops it immediately (spec P4). Every stage is
 * admitted against the owner's spend ceiling first. Child-facing text is released only after the
 * answer guard passes; otherwise a reviewed template is shown. Nothing here logs homework text,
 * answers or child identifiers.
 *
 * Child safety (spec P4; AC_SECURITY_02), moderation before and after generation:
 * - Before grading, every extracted question's answer and printed prompt pass the deterministic
 *   screen (@pencillift/domain/safety). A severe-risk result gets NO further model call for that
 *   question (no grading, verification or coaching; RV-child-safety-5): the child sees the reviewed
 *   safety template (feedback kind 'safety') and an escalated SYSTEM safety report is filed (ids and
 *   screen codes only; runbook 5.1), before any grading call, so a failed or paused grading stage
 *   cannot delay or drop it. One of each per question per transcription, so a crash replay or
 *   recheck adds nothing. A question flagged for an earlier transcription keeps its notice after a
 *   grown-up's correction and is not tutored (RV-child-safety-7); the admin queue shows the edit.
 * - After generation, a coaching packet that screens severe (companion persona, diagnosis,
 *   secrecy, contact, an ungrounded sensitive topic, ...) falls back to the reviewed template, and a
 *   rubric label that screens severe is dropped. Only codes are logged.
 * - A report whose screen codes include abuse, sexual or secrecy starts held from the family's list
 *   (runbook 5.1: the concern may involve someone in the household); the owner releases it.
 * - Provider moderation (round 5, lead decision: a word list is not the safety control) is the
 *   second layer: the OpenAI moderation endpoint (@pencillift/ai moderation.ts), the labeled mock in
 *   development/test and the refusing client in staging/production without a key. It sends the
 *   child's words, so it runs only where grading may (assertActive and the same child-data gate).
 *   Before grading, every child ANSWER goes in one call (never the printed prompt: worksheets quote
 *   characters and lessons, and a held code on a printed prompt is a defect); a provider flag merges
 *   with the word-list screen (the most serious level wins, categories join) and is answered the
 *   same way, with PROVIDER_* codes in the logs and the report's audit row. A violence-type flag on
 *   the child's words maps to abuse and violence, so the report is held (a model cannot tell a
 *   victim's report from a threat); other flags on child input only log a code. After generation
 *   the coaching packet and each rubric criterion are moderated before use: a flagged packet falls
 *   back to the reviewed template and a flagged criterion is dropped before childRubricFeedback.
 *   FAIL CLOSED: a moderation error or timeout before grading grades nothing in this attempt (a
 *   retryable one retries the job; any other ends the scan failed_final like a missing provider),
 *   and the word-list flags of that attempt are answered at once with the report held from the
 *   family (the provider might have added a held category); after generation it means the template
 *   and no rubric rows. Moderation is free: no spend hold, one payload-free count logged per call.
 * - A reviewer may clear a report as a false match (round 3, CHK2-CS-5; PATCH
 *   /v1/admin/safety-reports/:id). The clearance is that question's transcription: its re-check
 *   grades it normally (no new report, no notice), and a corrected transcription is screened afresh.
 * Decision: a flagged question gets no verdict (it is not graded: no worked solution is written for
 * a disclosure) and does not move the scan to parent review, so a held flag is never announced to
 * the household as "needs your review"; the scan's status follows its other questions. The parent
 * sees the question as not checked; the escalated system report in the family's report list (once
 * visible) is the parent-facing signal, and no alert is claimed.
 */

export const GRADER_VERSION = 'scan.v1';
export const GUARD_VERSION = 'answer-guard.v1';

/** Advisory mapping of model-reported confidence (spec P5: never a calibrated guarantee). */
const CONFIDENCE: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 0.25,
  medium: 0.6,
  high: 0.9,
};

/** Page issues that mean "take the picture again" rather than guessing (spec P5). */
const RESCAN_PAGE_ISSUES = new Set(['blurry', 'glare', 'rotated', 'cut_off', 'not_homework']);

/** A scan paused by the spend ceiling is retried after this long (no attempt is spent). */
const SPEND_CEILING_RETRY_MS = 60 * 60_000;

/** Reviewed fallback when a coaching packet fails validation (spec P6: never show unchecked output). */
export const TEMPLATE_FALLBACK =
  "Let's look at this one again. Read the question slowly, check each step, and try once more. If you're stuck, ask a grown-up to help.";

const payloadSchema = z.object({
  assignmentId: z.uuid(),
  mode: z.enum(['initial', 'recheck']).default('initial'),
  reservationId: z.uuid().optional(),
  questionIds: z.array(z.uuid()).max(200).optional(),
});

type RateTable = typeof DEFAULT_RATE_TABLE_2026_09_18;
type ParentVerdict = 'correct' | 'incorrect' | 'unresolved';

export interface ScanProcessOptions {
  readonly ai: ResponsesClient;
  /**
   * Provider moderation (spec P4; AC_SECURITY_02): the child's answers before grading, coaching and
   * rubric criteria after it. Required: nothing is graded or shown without it (the labeled mock in
   * development/test, the refusing client in staging/production without OPENAI_API_KEY).
   */
  readonly moderation: ModerationClient;
  /** Reads a private homework object; bytes are sent inline, never as a storage URL. */
  readonly readObject: (storagePath: string) => Promise<Uint8Array>;
  readonly rates?: RateTable;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A failure that retrying cannot fix: the scan ends in failed_final and its allowance is released. */
class PermanentFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentFailure';
  }
}

/** A retryable failure with a payload-free code recorded on the assignment. */
class RetryableFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RetryableFailure';
  }
}

/** The assignment moved underneath us (deleted, cancelled): stop without writing anything. */
class Superseded extends Error {
  constructor() {
    super('superseded');
    this.name = 'Superseded';
  }
}

interface AssignmentCtx {
  readonly id: string;
  readonly familyId: string;
  readonly childId: string;
  status: string;
  readonly ageBand: AgeBand;
  readonly gradeLevel: number;
}

interface QuestionRow {
  readonly id: string;
  readonly page_number: number;
  readonly question_number: string;
  readonly prompt: string;
  readonly answer: string | null;
  readonly answer_kind: AnswerKind;
  readonly subject_key: string;
  readonly skill: string;
  readonly uncertainty: 'low' | 'medium' | 'high' | null;
  readonly corrected_by: string | null;
  /** A parent's override stays authoritative over any regrade (spec P5). */
  readonly parent_override: ParentVerdict | null;
}

interface Graded {
  readonly question: QuestionRow;
  readonly final:
    'correct' | 'incorrect' | 'unresolved' | 'unanswered' | 'rubric' | 'needs_parent_review';
  readonly route: 'deterministic' | 'agreement' | 'escalated' | 'parent_review';
  readonly disagreement: boolean;
  readonly private: GradingOutput['results'][number] | null;
  /** The model-free key computed from the printed prompt, when there is one. */
  readonly promptKey: string | null;
  readonly provenance: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** The one child-facing step a graded question gets after grading. */
export type FeedbackStep = 'safety' | 'coach' | 'rubric' | 'none';

/**
 * Exactly one step per question. A severe screen always wins (spec P4: moderation before
 * generation), so nothing is sent to a model for that question and no coaching or rubric rows can
 * follow the safety template, whatever the verdict or a parent's override. Otherwise a parent's
 * override is authoritative (no "try again" on an answer a grown-up settled, RV-lead-jobs-ai-19),
 * incorrect answers are coached and written work gets its rubric rows (AC_GRADING_03).
 */
export function feedbackStep(input: {
  readonly severe: boolean;
  readonly final: Graded['final'];
  readonly hasPrivate: boolean;
  readonly parentOverride: ParentVerdict | null;
}): FeedbackStep {
  if (input.severe) return 'safety';
  if (!input.hasPrivate || input.parentOverride !== null) return 'none';
  if (input.final === 'incorrect') return 'coach';
  if (input.final === 'rubric') return 'rubric';
  return 'none';
}

/**
 * An answer key computed WITHOUT any model: a printed prompt that is a bare arithmetic expression
 * ("3/4 + 1/8 =", "12 × 7 = ___") is evaluated with the safe rational parser. Anything else
 * (words, variables, ambiguous notation) returns null and grading falls back to model agreement.
 */
export function computePromptKey(prompt: string): string | null {
  let text = prompt.trim();
  text = text.replace(/^\(?[0-9]{1,3}[.)]\s+/, ''); // leading "4." / "4)" numbering
  text = text.replace(/\s*=\s*(?:\?|_+|□|\.{2,})?\s*$/u, '').replace(/\?\s*$/, '');
  if (text.length === 0 || text.length > 120) return null;
  if (!/^[0-9\s+\-−–×x*÷/:().,^²³]+$/u.test(text)) return null;
  if (!/[0-9]\s*[+\-−–×x*÷/:^]\s*[0-9(]/u.test(text) && !/[²³]/u.test(text)) return null;
  const parsed = parseMathAnswerDetailed(text.replace(/:/g, '÷'));
  if (!parsed.ok || parsed.value.form.kind !== 'expression') return null;
  return formatRational(parsed.value.value);
}

function isBlank(answer: string | null): boolean {
  return answer === null || answer.trim().length === 0;
}

/** True when a model key is a single written value (7, 3/4, 0.5), not an expression like 3 × 4. */
function plainValueKey(key: string | null | undefined): boolean {
  if (!key) return false;
  const parsed = parseMathAnswerDetailed(key);
  return parsed.ok && parsed.value.form.kind !== 'expression';
}

/** Builds a deterministic question from a key; null when the key cannot be represented safely. */
export function objectiveQuestion(
  kind: AnswerKind,
  studentAnswer: string,
  key: string,
  captureIssues: readonly CaptureIssue[],
): ObjectiveQuestion | null {
  const base = { studentAnswer, captureIssues };
  switch (kind) {
    case 'numeric':
      return parseMathAnswer(key).ok ? { ...base, kind, expected: { value: key } } : null;
    case 'quantity': {
      const q = parseQuantity(key);
      if (!q.ok) return null;
      const value = formatRational(q.value.value);
      // A unitless key is compared as a plain number.
      return q.value.unit === null
        ? { ...base, kind: 'numeric', expected: { value } }
        : { ...base, kind, expected: { value, unit: q.value.unit } };
    }
    case 'multiple_choice': {
      const letter = key.trim().replace(/^\(?([A-Za-z])[).:]?$/, '$1');
      return /^[A-Za-z]$/.test(letter)
        ? { ...base, kind, expected: { letters: [letter.toUpperCase()] } }
        : null;
    }
    case 'spelling':
      return key.trim().length > 0 ? { ...base, kind, expected: { target: key.trim() } } : null;
    case 'division_remainder':
    case 'exact_text':
    case 'open_response':
    case 'writing':
      // Division keys need a structured quotient/remainder; text answers need semantic judgment.
      // These stay with model agreement.
      return null;
  }
}

function decisive(verdict: string): verdict is 'correct' | 'incorrect' {
  return verdict === 'correct' || verdict === 'incorrect';
}

function modelVerdict(verdict: string): ModelVerdict {
  return decisive(verdict) ? verdict : 'unresolved';
}

const NUMERIC_KINDS: ReadonlySet<AnswerKind> = new Set([
  'numeric',
  'quantity',
  'division_remainder',
]);
const CHOICE_PREFIX = /^(?:option|choice|letter|answer)\s*[:.]?\s*/i;
/** "B", "(B)", "B)", "B.", "B:", "B) 3/6", "(B) 3/6", "B. 3/6", "Choice B" … */
const CHOICE_LETTER = /^\(?([A-Za-z])(?:[).:]|\s|$)/;
/** A single letter standing alone ("and C", "(C)", "C)"); not a letter of a word or "it's". */
const STANDALONE_LETTER = /(?<![\p{L}\p{N}'\u2019])([A-Za-z])(?![\p{L}\p{N}])/gu;

/**
 * Letters a multiple-choice key names after its leading letter ("A and C", "(A) or (C)",
 * "C. 10 or A. 4"). The English article "a" in option text ("B) a right angle") is not an option
 * when the key's own letter is a capital. Any other standalone letter counts, so an ambiguous key
 * fails closed rather than leaving a second correct letter unprotected (RV-lead-jobs-ai-8).
 */
function otherChoiceLetters(rest: string, first: string): string[] {
  const capitalKey = first !== first.toLowerCase();
  return [...rest.matchAll(STANDALONE_LETTER)]
    .map((m) => m[1]!)
    .filter((letter) => !(capitalKey && letter === 'a'));
}

/** Mentions not strictly contained in a longer mention (the guard's own reading of a key). */
function maximalMentions(mentions: readonly NumericMention[]): NumericMention[] {
  return mentions.filter(
    (m) =>
      !mentions.some(
        (o) => o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start,
      ),
  );
}

/** Every number a key states ("x = 4", "The answer is 84.", "B) 3/6"), as guard values. */
function keyNumbers(key: string, includeWordNumbers: boolean): string[] {
  const canon = canonicalize(key);
  const mentions = maximalMentions(extractNumericMentions(canon, { maskMarkers: false }));
  const values = new Set<string>();
  for (const m of mentions) {
    if (!includeWordNumbers && !/[0-9]/.test(canon.slice(m.start, m.end))) continue;
    values.add(m.value.den === 1n ? m.value.num.toString() : `${m.value.num}/${m.value.den}`);
  }
  return [...values];
}

/**
 * Protected answers for the leak guard, derived from a free-text key (RV-lead-jobs-ai-8): the literal
 * key as text, every number it states (a leading option letter, "<var> =" and sentences included),
 * a multiple-choice letter written with or without its option text, and a spelling word.
 *
 * Fails closed: returns [] when the key cannot be turned into a protectable form (a multiple-choice
 * key without a readable letter or naming more than one letter, a numeric key without a readable
 * number, or more forms than the guard accepts). The caller then shows the reviewed template instead
 * of calling the tutor.
 */
export function protectedAnswers(kind: AnswerKind, key: string): ProtectedAnswer[] {
  const trimmed = key.trim();
  if (trimmed.length === 0) return [];
  const answers: ProtectedAnswer[] = [{ kind: 'text', value: trimmed.slice(0, 200) }];
  const numbers = keyNumbers(trimmed, NUMERIC_KINDS.has(kind));
  if (NUMERIC_KINDS.has(kind) && numbers.length === 0) return [];
  for (const value of numbers) answers.push({ kind: 'numeric', value });
  if (kind === 'multiple_choice') {
    const choice = trimmed.replace(CHOICE_PREFIX, '');
    const match = CHOICE_LETTER.exec(choice);
    const letter = match?.[1];
    if (match === null || letter === undefined) return [];
    // A select-all key ("A and C") names more letters than the guard can withhold as one answer.
    if (otherChoiceLetters(choice.slice(match[0].length), letter).length > 0) return [];
    answers.push({ kind: 'multiple_choice', value: letter.toUpperCase() });
  }
  if (kind === 'spelling' && /^[\p{L}'-]+$/u.test(trimmed))
    answers.push({ kind: 'spelling', value: trimmed });
  if (answers.length > MAX_PROTECTED_ANSWERS || !validateProtectedAnswers(answers).ok) return [];
  return answers;
}

/**
 * True when the model's free-text key states exactly the model-free prompt key: "84", "84.0",
 * "x = 84", "12 × 7 = 84" (the value after the last "="). Anything else — another value, several
 * candidate values, no readable value — is a disagreement.
 */
export function keysAgree(promptKey: string, modelKey: string): boolean {
  const trimmed = modelKey.trim();
  const direct = parseMathAnswer(trimmed);
  if (direct.ok) return formatRational(direct.value) === promptKey;
  const expected = parseMathAnswer(promptKey);
  if (!expected.ok || expected.value.num < 0n) return false; // signs are not compared below
  const target =
    expected.value.den === 1n
      ? expected.value.num.toString()
      : `${expected.value.num}/${expected.value.den}`;
  const stated = keyNumbers(trimmed.slice(trimmed.lastIndexOf('=') + 1), true);
  return stated.length === 1 && stated[0] === target;
}

function uniqueAnswers(answers: readonly ProtectedAnswer[]): ProtectedAnswer[] {
  const seen = new Set<string>();
  return answers.filter((a) => {
    const id = `${a.kind}:${a.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Quoted wording ("…", “…”, «…», '…') with at least three letters: an example a label must not copy. */
const QUOTED_SPAN =
  /["“„«]([^"“”„«»\n]{3,400})["”»]|(?<![\p{L}\p{N}])['‘]([^'‘’\n]{3,400})['’](?![\p{L}\p{N}])/gu;

/** Where a sentence splits into clauses: punctuation and common joining words. */
const CLAUSE_BREAK =
  /[,;:()—–]|\s(?:because|so|and|but|or|when|if|since|after|before|while|although|until|that)\s/iu;

/**
 * Everything a child-facing rubric row must not state (LJA-F1; spec P6 "no complete spelling
 * target, completed sentence, or essay response"): the private key and every quoted example, or
 * unquoted example ("A good answer: ..."; exampleWordingSpans), in the key, the worked
 * solution or a criterion's note, each whole, per sentence and per clause of three
 * or more words, in the protected forms `protectedAnswers` derives (text, and any number written in
 * digits). Returns null when a form cannot be protected, so the caller shows no rubric rows (fail
 * closed).
 */
export function rubricProtectedAnswers(solution: {
  readonly correctAnswer: string;
  readonly workedSolution: string;
  readonly rubric: readonly { readonly note: string }[] | null;
}): ProtectedAnswer[] | null {
  const texts = new Set<string>();
  const add = (raw: string, minLetters: number) => {
    const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (text.length > 0 && (letters >= minLetters || /\p{N}/u.test(text))) texts.add(text);
  };
  // A sentence, and each clause of it with at least three words: a label may copy the completion
  // ("it was raining") without the rest of the example sentence.
  const addExample = (raw: string, minLetters: number) => {
    add(raw, minLetters);
    for (const sentence of raw.split(/(?<=[.!?])\s+|\n+/u)) {
      add(sentence, minLetters);
      for (const clause of sentence.split(CLAUSE_BREAK)) {
        if (clause.trim().split(/\s+/u).length >= 3) add(clause, minLetters);
      }
    }
  };
  const key = solution.correctAnswer;
  addExample(key, 1);
  for (const source of [
    key,
    solution.workedSolution,
    ...(solution.rubric ?? []).map((r) => r.note),
  ]) {
    for (const match of source.matchAll(QUOTED_SPAN)) addExample(match[1] ?? match[2] ?? '', 3);
    for (const span of exampleWordingSpans(source)) addExample(span, 3);
  }
  const answers: ProtectedAnswer[] = [];
  for (const text of texts) {
    const forms = protectedAnswers('writing', text);
    if (forms.length === 0) return null;
    answers.push(...forms);
  }
  return uniqueAnswers(answers);
}

/** Screen categories a system report may carry (child text; mirrors migration 0760). */
const REPORT_CATEGORIES: ReadonlySet<string> = new Set([
  'self_harm',
  'abuse',
  'violence',
  'sexual',
  'secrecy',
  'personal_contact',
]);

function isReportCategory(category: string): boolean {
  return REPORT_CATEGORIES.has(category);
}

/** A payload-free log code for a severe screen (its first category). */
function safetyCode(screen: SafetyScreen): string {
  return `SAFETY_${(screen.categories[0] ?? 'unknown').toUpperCase()}`;
}

/** Which layer found a question's severe categories (the report's audit row names it). */
export type InputScreenSource =
  'safety_screen' | 'provider_moderation' | 'safety_screen+provider_moderation';

/** One question's input screen: the word-list screen merged with the provider's flag. */
export interface InputScreen {
  readonly screen: SafetyScreen;
  /** Null when nothing is severe. */
  readonly source: InputScreenSource | null;
  /** PROVIDER_* codes of the child's answer (logged; never text). */
  readonly providerCodes: readonly string[];
}

/**
 * Merges the word-list screen of a question with the provider's result for the child's answer
 * (null: no answer was sent, e.g. a blank one). The most serious level wins and categories and
 * codes join (mergeScreens); a violence-type provider flag on the child's words adds abuse, so the
 * report is held (moderation.ts providerSafetyCategories). Exported for tests.
 */
export function childInputScreen(
  words: SafetyScreen,
  provider: ModerationResultItem | null,
): InputScreen {
  const flagged = provider === null ? null : providerSafetyScreen(provider, 'child');
  const layers: string[] = [];
  if (words.level === 'severe') layers.push('safety_screen');
  if (flagged?.level === 'severe') layers.push('provider_moderation');
  return {
    screen: flagged === null ? words : mergeScreens([words, flagged]),
    source: layers.length > 0 ? (layers.join('+') as InputScreenSource) : null,
    providerCodes: flagged?.codes ?? [],
  };
}

const FEEDBACK_KIND: Readonly<
  Record<
    CoachingPacket['steps'][number]['kind'],
    'hint' | 'method_step' | 'analogous_example' | 'encouragement'
  >
> = {
  concept: 'method_step',
  next_step_question: 'method_step',
  hint: 'hint',
  analogous_example: 'analogous_example',
  encouragement: 'encouragement',
};

/** Reads a private object through a short-lived signed URL (Supabase Storage in production). */
/** A stored page larger than any page registration allows: never read into memory in full. */
export class StoredPageTooLarge extends Error {
  constructor() {
    super('STORED_PAGE_TOO_LARGE');
    this.name = 'StoredPageTooLarge';
  }
}

/**
 * Reads a stored page through a short-lived signed URL, stopping at `maxBytes` (the page cap every
 * registration is held to): an object that is somehow larger (a misconfigured bucket, a replaced
 * object) is refused from its declared length or while streaming, never buffered whole.
 */
export function storageReader(
  storage: StorageProvider,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
  maxBytes = DEFAULT_HOMEWORK_UPLOAD_LIMITS.maxPageBytes,
): (path: string) => Promise<Uint8Array> {
  return async (path) => {
    const { url } = await storage.createSignedReadUrl(path, 60);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`storage read failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new StoredPageTooLarge();
    }
    if (!response.body) {
      const whole = new Uint8Array(await response.arrayBuffer());
      if (whole.length > maxBytes) throw new StoredPageTooLarge();
      return whole;
    }
    const reader = response.body.getReader();
    // A declared length (of an unencoded body) is read straight into one buffer (JOBS-R1-02: no
    // second page-sized copy); a body that turns out longer continues in chunks, as without one.
    let buffer =
      Number.isFinite(declared) && declared > 0 && !response.headers.get('content-encoding')
        ? new Uint8Array(declared)
        : null;
    let filled = 0;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new StoredPageTooLarge();
      }
      if (buffer !== null && filled + value.length <= buffer.length) {
        buffer.set(value, filled);
        filled += value.length;
        continue;
      }
      if (buffer !== null) {
        chunks.push(buffer.subarray(0, filled));
        buffer = null;
      }
      chunks.push(value);
    }
    if (buffer !== null) return filled === buffer.length ? buffer : buffer.slice(0, filled);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  };
}

/**
 * Strips a page's metadata and makes its image part, letting go of each copy as soon as the next
 * exists (JOBS-R1-02): the stored bytes once they are stripped, the stripped bytes once their data
 * URL is encoded. At most two page-sized buffers are alive at any point. Throws ImageFormatError
 * for content that is not the declared image type.
 */
function strippedImagePart(
  held: { bytes: Uint8Array | null },
  mimeType: 'image/jpeg' | 'image/png',
): InputPart {
  const clean: { bytes: Uint8Array | null } = {
    bytes: stripImageMetadata(held.bytes ?? new Uint8Array(), mimeType),
  };
  held.bytes = null;
  const url = dataUrlBytes(mimeType, clean.bytes ?? new Uint8Array());
  clean.bytes = null;
  return imagePartFromDataUrl(url);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Digested in place when the bytes sit on a plain ArrayBuffer (JOBS-R1-02: no page-sized copy);
  // a view of shared memory, which digest does not accept, is copied first.
  const data: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

export function createScanProcessHandler(options: ScanProcessOptions): JobHandler {
  const rates = options.rates ?? DEFAULT_RATE_TABLE_2026_09_18;

  const handler = async (deps: JobDeps, job: JobRow): Promise<void | JobDeferral> => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || !job.family_id) {
      deps.log({ level: 'error', event: 'scan_invalid_job', code: 'INVALID_JOB' });
      return; // a malformed job can never succeed; do not burn retries on it
    }
    const payload = parsed.data;
    const ctx = await loadAssignment(deps, job.family_id, payload.assignmentId);
    if (!ctx) return; // deleted/purged family, child being deleted, or assignment gone

    const run = new ScanRun(
      deps,
      options,
      rates,
      job,
      ctx,
      payload.mode,
      payload.reservationId ?? null,
    );
    try {
      if (payload.mode === 'recheck') await run.recheck(payload.questionIds ?? []);
      else await run.initial();
    } catch (error) {
      if (error instanceof Superseded) return;
      if (error instanceof SpendCeilingReached) return await run.pause();
      await run.fail(error);
    } finally {
      await run.recordUsage(true);
    }
  };
  return Object.assign(handler, {
    onDeadLetter: (deps: JobDeps, job: JobRow, reason: DeadLetterReason) =>
      settleDeadLetteredScan(deps, job, reason),
  });
}

/**
 * Compensation for a scan job that was dead-lettered without its handler settling it (the worker
 * died on the final attempt): the scan ends failed_final and its allowance is released, instead of
 * sitting in "checking" forever (RV-lead-jobs-ai-2). A dead recheck keeps the earlier results and
 * goes to a grown-up. Idempotent; a deleted or already settled scan is left alone.
 */
export async function settleDeadLetteredScan(
  deps: JobDeps,
  job: JobRow,
  reason: DeadLetterReason,
): Promise<void> {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.family_id) return;
  const familyId = job.family_id;
  const { assignmentId, mode, reservationId } = parsed.data;
  const code = reason === 'LOCK_EXPIRED' ? 'PROCESSING_TIMEOUT' : 'PROCESSING_ERROR';
  await deps.db.asService(async (tx) => {
    const [row] = await tx<{ status: string }[]>`
      select status from public.assignments where id = ${assignmentId} and family_id = ${familyId}
       for update`;
    if (!row) return;
    const move = (to: string) => tx`
      update public.assignments set status = ${to}, error_code = ${code}
       where id = ${assignmentId} and family_id = ${familyId}`;
    if (mode === 'recheck') {
      if (row.status === 'checking' || row.status === 'verifying') {
        await move('needs_parent_review');
      }
      return;
    }
    let status = row.status;
    if (status === 'queued') {
      await move('extracting');
      status = 'extracting';
    }
    if (!['extracting', 'checking', 'verifying', 'failed_retryable'].includes(status)) return;
    await move('failed_final');
    await tx`
      update public.usage_reservations set status = 'released', release_reason = 'failed_final'
       where family_id = ${familyId} and status = 'reserved'
         and ${reservationId ? tx`id = ${reservationId}` : tx`idempotency_key like ${`scan-usage:${assignmentId}:v%`}`}`;
  });
  deps.log({ level: 'error', event: 'scan_failed_final', code });
}

async function loadAssignment(
  deps: JobDeps,
  familyId: string,
  assignmentId: string,
): Promise<AssignmentCtx | null> {
  const [row] = await deps.db.asService(
    (tx) => tx<
      {
        id: string;
        family_id: string;
        child_id: string;
        status: string;
        age_band: AgeBand;
        grade_level: number;
      }[]
    >`
      select a.id, a.family_id, a.child_id, a.status, c.age_band, c.grade_level
        from public.assignments a
        join public.child_profiles c on c.id = a.child_id and c.family_id = a.family_id
        join public.families f on f.id = a.family_id and f.deleted_at is null
       where a.id = ${assignmentId} and a.family_id = ${familyId}
         and not exists (
           select 1 from public.deletion_requests d
            where d.family_id = a.family_id and d.status in ('requested', 'processing')
              and (d.scope = 'family' or d.target_child_id = a.child_id))
    `,
  );
  return row
    ? {
        id: row.id,
        familyId: row.family_id,
        childId: row.child_id,
        status: row.status,
        ageBand: row.age_band,
        gradeLevel: row.grade_level,
      }
    : null;
}

class ScanRun {
  private readonly usage: AttemptRecord[] = [];
  /**
   * Questions whose severe screen a reviewer cleared as a false match for their current
   * transcription (round 3, CHK2-CS-5): screenBeforeGrading lets them through and the post-grading
   * backstop must not flag them again.
   */
  private readonly clearedFlags = new Set<string>();
  /**
   * Each screened question's input screen (word list merged with provider moderation), kept from
   * screenBeforeGrading for the post-grading backstop, so both decide on the same flags.
   */
  private readonly inputScreens = new Map<string, InputScreen>();

  constructor(
    private readonly deps: JobDeps,
    private readonly options: ScanProcessOptions,
    private readonly rates: RateTable,
    private readonly job: JobRow,
    private readonly ctx: AssignmentCtx,
    private readonly mode: 'initial' | 'recheck',
    private readonly reservationId: string | null,
  ) {}

  // ---- state ---------------------------------------------------------------------------------

  /** Compare-and-set transition; a concurrent change (deletion, cancel) stops the run. */
  private async transition(to: string, errorCode: string | null = null): Promise<void> {
    const from = this.ctx.status;
    const rows = await this.deps.db.asService(
      (tx) => tx`
        update public.assignments
           set status = ${to}, error_code = ${errorCode},
               processing_attempts = processing_attempts + ${to === 'extracting' ? 1 : 0}
         where id = ${this.ctx.id} and family_id = ${this.ctx.familyId} and status = ${from}
        returning id
      `,
    );
    if (rows.length === 0) throw new Superseded();
    this.ctx.status = to;
  }

  private async settleReservation(
    outcome: 'committed' | 'unreadable' | 'failed_final',
  ): Promise<void> {
    if (!this.reservationId) return;
    await this.deps.db.asService(
      (tx) => tx`
        update public.usage_reservations
           set status = ${outcome === 'committed' ? 'committed' : 'released'},
               release_reason = ${outcome === 'committed' ? null : outcome}
         where id = ${this.reservationId} and family_id = ${this.ctx.familyId} and status = 'reserved'
      `,
    );
  }

  /** Brings a new, retried or crashed initial run to `extracting`. */
  private async enterExtracting(): Promise<boolean> {
    const s = this.ctx.status;
    if (s === 'extracting' || s === 'checking' || s === 'verifying') {
      // A previous worker died mid-run; restart cleanly (all writes below are idempotent).
      await this.transition('failed_retryable', 'RESTARTED');
    }
    if (this.ctx.status === 'failed_retryable') await this.transition('queued');
    if (this.ctx.status === 'needs_rescan') {
      // A retry after the scan was sent back for a retake: the allowance release may have failed
      // after the transition committed; it is idempotent, so release it now (spec P11; LJA-F11).
      await this.settleReservation('unreadable');
      return false;
    }
    if (this.ctx.status !== 'queued') return false; // ready, cancelled, deleted, ... : done
    await this.transition('extracting');
    return true;
  }

  async fail(error: unknown): Promise<void> {
    const permanent = error instanceof PermanentFailure;
    const code = permanent || error instanceof RetryableFailure ? error.code : 'PROCESSING_ERROR';
    const final = permanent || this.job.attempts >= this.job.max_attempts;
    const active = () => ['extracting', 'checking', 'verifying'].includes(this.ctx.status);
    try {
      if (final && this.mode === 'recheck') {
        // A failed recheck keeps the earlier results; a grown-up reviews instead of losing them.
        if (this.ctx.status === 'checking' || this.ctx.status === 'verifying')
          await this.transition('needs_parent_review', code);
      } else if (final) {
        if (this.ctx.status === 'queued') await this.transition('extracting');
        if (active()) await this.transition('failed_final', code);
        await this.settleReservation('failed_final');
      } else if (this.mode === 'initial' && active()) {
        await this.transition('failed_retryable', code);
      }
    } catch (transitionError) {
      if (!(transitionError instanceof Superseded)) throw transitionError;
    }
    if (final) {
      this.deps.log({ level: 'error', event: 'scan_failed_final', code });
      return; // nothing left to retry
    }
    this.deps.log({ level: 'warn', event: 'scan_retry', code });
    throw error instanceof Error ? error : new Error(code);
  }

  /**
   * The owner's spend ceiling is reached: keep every result written so far and run again later
   * without spending an attempt. A retried initial run skips extraction (its questions are stored).
   */
  async pause(): Promise<JobDeferral> {
    try {
      if (
        this.mode === 'initial' &&
        ['extracting', 'checking', 'verifying'].includes(this.ctx.status)
      )
        await this.transition('failed_retryable', 'SPEND_CEILING');
    } catch (error) {
      if (!(error instanceof Superseded)) throw error;
    }
    this.deps.log({ level: 'warn', event: 'scan_paused', code: 'SPEND_CEILING' });
    return {
      kind: 'defer',
      runAfter: new Date(this.deps.clock().getTime() + SPEND_CEILING_RETRY_MS),
      code: 'SPEND_CEILING',
    };
  }

  /**
   * Meters the attempts so far (append-only cost rows). Inside a spend hold, rows that cannot be
   * written now stay queued: the hold's settlement retries them in the transaction that releases
   * the hold, and keeps the hold counting their cost if they still cannot be written (LJA-F5).
   * `final` is the handler's last flush (no hold left): a failure there is only logged.
   */
  async recordUsage(final = false): Promise<void> {
    if (this.usage.length === 0) return;
    const attempts = this.usage.splice(0);
    const rows = usageRows(attempts, this.ctx.familyId, this.ctx.childId);
    try {
      await this.deps.db.asService((tx) => tx`insert into public.ai_usage_events ${tx(rows)}`);
    } catch {
      // Metering must never hide the processing outcome; the gap is visible in the logs.
      if (final) {
        this.deps.log({ level: 'error', event: 'ai_usage_record_failed', code: 'METERING' });
        return;
      }
      this.usage.unshift(...attempts);
      this.deps.log({ level: 'warn', event: 'ai_usage_record_deferred', code: 'METERING' });
    }
  }

  // ---- gates ---------------------------------------------------------------------------------

  /**
   * May this run still touch this child's data? The assignment must still be in the state this run
   * put it in, the family live, no deletion open for the family or child, the child not archived and
   * consent still verified. `lock` holds the assignment row for the rest of a write transaction, so a
   * concurrent deletion (which moves the assignment to 'deleted') serialises with the write.
   *
   * `paidAi` is set right before an AI stage (and before its spend hold): the profile must still be
   * `active`, i.e. hold a paid slot (spec P11 "stop paid AI for inactive profiles"; LJA-F3). A
   * profile moved to draft when billing released its slot gets no further model call, even for a
   * scan finalized, paused at the spend ceiling or a recheck queued before the downgrade. Model-free
   * work stays allowed: the safety screen still answers a severe-risk answer, and when the downgrade
   * lands after verification was sent, the verified results are still written (coaching falls back
   * to the template). A downgrade while grading is in flight stops the run before verification: an
   * initial scan then ends failed_final with CHILD_NOT_ACTIVE and its unverified grading is not
   * kept (round-2 check CHK-LJA-F3-claim).
   */
  private async assertActive(tx: Tx, lock: boolean, paidAi = false): Promise<void> {
    const [row] = await tx<
      { status: string; family_deleted: boolean; child_status: string | null; deleting: boolean }[]
    >`
      select a.status, f.deleted_at is not null as family_deleted, c.status as child_status,
             exists (select 1 from public.deletion_requests d
                      where d.family_id = a.family_id and d.status in ('requested', 'processing')
                        and (d.scope = 'family' or d.target_child_id = a.child_id)) as deleting
        from public.assignments a
        join public.families f on f.id = a.family_id
        left join public.child_profiles c on c.id = a.child_id and c.family_id = a.family_id
       where a.id = ${this.ctx.id} and a.family_id = ${this.ctx.familyId}
       ${lock ? tx`for share of a` : tx``}
    `;
    if (
      !row ||
      row.status !== this.ctx.status ||
      row.family_deleted ||
      row.deleting ||
      row.child_status === null
    ) {
      throw new Superseded();
    }
    if (row.child_status === 'archived') throw new PermanentFailure('CHILD_ARCHIVED');
    if (paidAi && row.child_status !== 'active') throw new PermanentFailure('CHILD_NOT_ACTIVE');
    const consent = await hasVerifiedConsent(tx, this.ctx.familyId, {
      // A test provider's record is consent only where the labeled mock may run (LRD-1).
      allowTestProvider: acceptsTestProviderConsent(this.deps.config.environment),
    });
    if (!consent) throw new PermanentFailure('CONSENT_REQUIRED');
  }

  /** Runs a batch of child-data writes only while processing is still allowed (spec P4). */
  private guardedWrite<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.deps.db.asService(async (tx) => {
      await this.assertActive(tx, true);
      return fn(tx);
    });
  }

  private async assertMayProcess(): Promise<void> {
    await this.deps.db.asService((tx) => this.assertActive(tx, false));
    const { config } = this.deps;
    const gate = checkChildDataGate({
      containsChildPersonalData: true,
      ageBand: this.ctx.ageBand,
      zdrEvidence: config.zdrEvidence,
      environment: config.environment,
      providerIsMock: this.options.ai.isMock,
      now: this.deps.clock(),
    });
    if (!gate.ok) throw new PermanentFailure('AI_NOT_AVAILABLE');
  }

  /**
   * Provider moderation of `texts` for one step (spec P4; AC_SECURITY_02). It sends the child's words
   * (or output that may quote them) to the provider, so it runs only where grading may: this run may
   * still process the child's data (assertActive: deletion, archive, consent) and the moderation
   * client passes the same child-data gate as the model (ZDR approval, no mock in production). Free:
   * no spend hold; one payload-free count is logged per call. Any error, timeout or a result that
   * does not match the texts one to one is returned as a failure: callers fail closed.
   */
  private async moderate(
    texts: readonly string[],
    step: 'child_answers' | 'coaching' | 'rubric_criteria',
  ): Promise<
    | { readonly ok: true; readonly results: readonly ModerationResultItem[] }
    | { readonly ok: false; readonly code: string; readonly retryable: boolean }
  > {
    if (texts.length === 0) return { ok: true, results: [] };
    await this.deps.db.asService((tx) => this.assertActive(tx, false));
    const { config } = this.deps;
    const gate = checkChildDataGate({
      containsChildPersonalData: true,
      ageBand: this.ctx.ageBand,
      zdrEvidence: config.zdrEvidence,
      environment: config.environment,
      providerIsMock: this.options.moderation.isMock,
      now: this.deps.clock(),
    });
    if (!gate.ok) {
      this.deps.log({
        level: 'error',
        event: 'moderation_failed',
        code: 'MODERATION_NOT_AVAILABLE',
      });
      return { ok: false, code: 'MODERATION_NOT_AVAILABLE', retryable: false };
    }
    const result = await this.options.moderation.moderate(texts, {
      timeoutMs: MODERATION_TIMEOUT_MS,
      metadata: { stage: `moderation_${step}` },
    });
    if (result.kind === 'error' || result.results.length !== texts.length) {
      const failure =
        result.kind === 'ok'
          ? { code: 'MODERATION_FAILED', retryable: true }
          : {
              code: result.timedOut
                ? 'MODERATION_TIMEOUT'
                : result.retryable
                  ? 'MODERATION_FAILED'
                  : 'MODERATION_NOT_AVAILABLE',
              retryable: result.retryable,
            };
      this.deps.log({
        level: 'warn',
        event: 'moderation_failed',
        code: failure.code,
        ...(result.kind === 'error' && result.status !== null ? { status: result.status } : {}),
        durationMs: result.latencyMs,
      });
      return { ok: false, ...failure };
    }
    this.deps.log({
      level: 'info',
      event: 'moderation_checked',
      code: step.toUpperCase(),
      count: texts.length,
      durationMs: result.latencyMs,
    });
    return { ok: true, results: result.results };
  }

  /**
   * Admits a group of AI stages against the owner's spend ceiling with their upper-bound cost, runs
   * them, then records their actual cost and releases the hold in one transaction; a cost that
   * cannot be recorded stays counted by the hold (RV-lead-jobs-ai-10, LJA-F5).
   */
  private async spending<T>(
    stages: readonly (keyof typeof PROPOSED_STAGE_LIMITS)[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const micros = stages.reduce((n, s) => n + PROPOSED_STAGE_LIMITS[s].maxCostMicros, 0);
    // No hold (and no wait at the ceiling) for a profile that may no longer use paid AI.
    await this.deps.db.asService((tx) => this.assertActive(tx, false, true));
    const hold = await acquireSpendHold(this.deps, micros);
    try {
      return await fn();
    } finally {
      const rows: UsageRow[] = usageRows(this.usage.splice(0), this.ctx.familyId, this.ctx.childId);
      await settleSpend(this.deps, hold, rows);
    }
  }

  /**
   * One AI stage. The pre-flight cost check uses an upper bound of the request actually sent
   * (instructions, schema and every text part at one token per byte, a bound per image), so an
   * oversized request is refused as STAGE_LIMIT before it is sent and no stage overshoots the hold
   * it was admitted with (LJA-F4).
   */
  private async stage<S extends z.ZodType>(
    prompt: PromptDefinition<S>,
    input: readonly InputPart[],
  ): Promise<z.infer<S>> {
    // Deletion, archiving, a released paid slot or a consent withdrawal since the last step stops
    // the run before any more child data goes to the provider (spec P4, P11; RV-lead-jobs-ai-3).
    await this.deps.db.asService((tx) => this.assertActive(tx, false, true));
    const out = await runStage<S>({
      prompt,
      input,
      client: this.options.ai,
      limits: PROPOSED_STAGE_LIMITS[prompt.stage],
      rates: this.rates,
      gate: {
        containsChildPersonalData: true,
        ageBand: this.ctx.ageBand,
        zdrEvidence: this.deps.config.zdrEvidence,
        environment: this.deps.config.environment,
        now: this.deps.clock(),
      },
      metadata: { stage: prompt.stage },
      estimatedInputTokens: inputTokenUpperBound(prompt, input),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    });
    this.usage.push(...out.attempts);
    // Recorded right away so the spend ceiling sees this stage before the next one is admitted.
    await this.recordUsage();
    if (out.result.ok) return out.result.value;
    const code = out.result.error.code;
    if (code === 'CHILD_DATA_GATE') throw new PermanentFailure('AI_NOT_AVAILABLE');
    if (code === 'STAGE_LIMIT' || code === 'UNKNOWN_MODEL') throw new PermanentFailure(code);
    // The provider refused the request itself (too large, an image it cannot read, a schema it
    // rejects): the same body would be refused again, so the scan ends now instead of five retries
    // re-sending it (JOBS-R1-02).
    if (code === 'PROVIDER_REJECTED') {
      throw new PermanentFailure(`${prompt.stage.toUpperCase()}_REQUEST_REJECTED`);
    }
    throw new RetryableFailure(`${prompt.stage.toUpperCase()}_${code}`);
  }

  // ---- initial run ---------------------------------------------------------------------------

  async initial(): Promise<void> {
    if (!(await this.enterExtracting())) return;
    await this.assertMayProcess();

    let missingPassage: ReadonlySet<number> = new Set();
    // Extract once (spec P12): a retry grades the stored questions instead of re-transcribing, so
    // it can neither pay for vision again nor leave the first run's questions behind as
    // duplicates of differently labelled ones (RV-lead-jobs-ai-9).
    if (!(await this.hasQuestions())) {
      const extracted = await this.extract();
      if (extracted === null) return;
      missingPassage = extracted;
    }
    const questions = await this.loadQuestions();
    if (questions.length === 0) {
      await this.transition('needs_parent_review', 'NO_QUESTIONS_FOUND');
      await this.settleReservation('committed');
      return;
    }
    await this.transition('checking');
    const graded = await this.grade(await this.screenBeforeGrading(questions), missingPassage);
    await this.finish(graded);
    await this.settleReservation('committed');
  }

  private async hasQuestions(): Promise<boolean> {
    const [row] = await this.deps.db.asService(
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from public.extracted_questions
         where assignment_id = ${this.ctx.id} and family_id = ${this.ctx.familyId}
      `,
    );
    return (row?.n ?? 0) > 0;
  }

  /** Extraction; returns the pages missing their source passage, or null when the scan ended. */
  private async extract(): Promise<ReadonlySet<number> | null> {
    const pages = await this.deps.db.asService(
      (tx) => tx<
        {
          id: string;
          page_number: number;
          storage_path: string;
          mime_type: string;
          byte_size: number;
          sha256: string;
        }[]
      >`
        select id, page_number, storage_path, mime_type, byte_size, sha256 from public.source_pages
         where assignment_id = ${this.ctx.id} and family_id = ${this.ctx.familyId} and deleted_at is null
         order by page_number
      `,
    );
    if (pages.length === 0) throw new PermanentFailure('NO_PAGES');
    // HEIC and PDF need the isolated converter (spec P5), which is not deployed yet.
    if (pages.some((p) => p.mime_type !== 'image/jpeg' && p.mime_type !== 'image/png')) {
      throw new PermanentFailure('FORMAT_NEEDS_CONVERSION');
    }
    // One request carries every page, so its size is bounded where pages are registered
    // (HOMEWORK_SCAN_MAX_TOTAL_BYTES, JOBS-R1-02). A scan registered before that bound, or with a
    // configuration above it, is refused here before any page is read into memory.
    const totalBytes = pages.reduce((n, p) => n + p.byte_size, 0);
    if (totalBytes > HOMEWORK_SCAN_MAX_TOTAL_BYTES) {
      this.deps.log({ level: 'warn', event: 'scan_too_large', code: 'SCAN_TOO_LARGE' });
      throw new PermanentFailure('SCAN_TOO_LARGE');
    }
    // Pages are handled one at a time and each is held once: its stored bytes until they are
    // checked and stripped, then only its data URL (JOBS-R1-02: no digest copy, no whole-page
    // binary string, the raw bytes dropped before the next page is read).
    const images: InputPart[] = [];
    for (const page of pages) {
      // The page's bytes live only in this holder, so they can be let go of mid-page.
      const held: { bytes: Uint8Array | null } = { bytes: null };
      try {
        held.bytes = await this.options.readObject(page.storage_path);
      } catch (error) {
        if (!(error instanceof StoredPageTooLarge))
          throw new RetryableFailure('STORAGE_READ_FAILED');
      }
      // What reaches the AI is exactly what was registered and finalized: the stored size and
      // sha256 must match the registration (a replaced or corrupted object is never sent).
      if (
        held.bytes === null ||
        held.bytes.length !== page.byte_size ||
        (await sha256Hex(held.bytes)) !== page.sha256
      ) {
        this.deps.log({ level: 'warn', event: 'scan_page_mismatch', code: 'PAGE_MISMATCH' });
        await this.transition('needs_rescan', 'PAGE_MISMATCH');
        await this.settleReservation('unreadable');
        return null;
      }
      let part: InputPart;
      try {
        // Location/camera metadata never leaves our systems (spec P4); content that is not the
        // declared image type is never forwarded "as is".
        part = strippedImagePart(held, page.mime_type as 'image/jpeg' | 'image/png');
      } catch (error) {
        if (!(error instanceof ImageFormatError)) throw error;
        await this.transition('needs_rescan', 'IMAGE_UNREADABLE');
        await this.settleReservation('unreadable');
        return null;
      }
      images.push(part);
    }

    const extraction = await this.spending(['extraction'], () =>
      this.stage<typeof PROMPTS.extraction.outputSchema>(PROMPTS.extraction, [
        dataEnvelope({
          pageNumbers: pages.map((p) => p.page_number),
          gradeLevel: this.ctx.gradeLevel,
        }),
        ...images,
      ]),
    );

    if (this.needsRescan(extraction, pages.length)) {
      await this.transition('needs_rescan', 'RETAKE_REQUESTED');
      // An unreadable scan never permanently consumes allowance (spec P11).
      await this.settleReservation('unreadable');
      return null;
    }
    const pageIds = new Map(pages.map((p) => [p.page_number, p.id]));
    const missingPassage = new Set(
      extraction.pages.filter((p) => p.issues.includes('missing_passage')).map((p) => p.pageNumber),
    );
    await this.guardedWrite((tx) => this.storeQuestions(tx, extraction, pageIds, missingPassage));
    return missingPassage;
  }

  private needsRescan(extraction: ExtractionOutput, pageCount: number): boolean {
    const reported = new Set(extraction.pages.map((p) => p.pageNumber));
    if (reported.size < pageCount) return true; // a page the model could not account for
    return extraction.pages.some(
      (p) => !p.readable || p.issues.some((issue) => RESCAN_PAGE_ISSUES.has(issue)),
    );
  }

  private async storeQuestions(
    tx: Tx,
    extraction: ExtractionOutput,
    pageIds: ReadonlyMap<number, string>,
    missingPassage: ReadonlySet<number>,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const q of extraction.questions) {
      const pageId = pageIds.get(q.pageNumber);
      const key = `${q.pageNumber}:${q.questionNumber}`;
      if (!pageId || seen.has(key)) continue; // unknown page or duplicate label: keep the first
      seen.add(key);
      // A missing source passage is stored as high uncertainty, so a retry that grades the stored
      // questions (without re-extracting) still refuses to decide them.
      const uncertainty = missingPassage.has(q.pageNumber) ? 'high' : q.uncertainty;
      await tx`
        insert into public.extracted_questions
          (assignment_id, family_id, child_id, page_id, question_number, bounding_box, prompt_text,
           student_answer_text, answer_kind, subject_key, skill, grade_estimate, uncertainty)
        values (${this.ctx.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${pageId}, ${q.questionNumber},
                ${q.boundingBox ? JSON.stringify(q.boundingBox) : null}::text::jsonb, ${q.promptText},
                ${q.studentAnswerText}, ${q.answerKind}, ${q.subject}, ${q.skill}, ${q.gradeEstimate},
                ${uncertainty})
        on conflict (assignment_id, page_id, question_number) do update
          set prompt_text = excluded.prompt_text, student_answer_text = excluded.student_answer_text,
              answer_kind = excluded.answer_kind, subject_key = excluded.subject_key,
              skill = excluded.skill, grade_estimate = excluded.grade_estimate,
              uncertainty = excluded.uncertainty, bounding_box = excluded.bounding_box
          where public.extracted_questions.corrected_at is null
      `;
    }
  }

  private async loadQuestions(ids?: readonly string[]): Promise<QuestionRow[]> {
    return this.deps.db.asService(
      (tx: Tx) => tx<QuestionRow[]>`
        select q.id, p.page_number, q.question_number,
               coalesce(q.corrected_prompt_text, q.prompt_text) as prompt,
               coalesce(q.corrected_student_answer_text, q.student_answer_text) as answer,
               q.answer_kind, q.subject_key, q.skill, q.uncertainty, q.corrected_by,
               r.parent_override_verdict as parent_override
          from public.extracted_questions q
          join public.source_pages p on p.id = q.page_id
          left join public.question_results r on r.question_id = q.id and r.family_id = q.family_id
         where q.assignment_id = ${this.ctx.id} and q.family_id = ${this.ctx.familyId}
           and (${ids === undefined}::boolean or q.id = any(${ids ? [...ids] : []}::uuid[]))
         order by p.page_number, q.created_at, q.question_number
      `,
    );
  }

  // ---- grading -------------------------------------------------------------------------------

  private async grade(
    questions: readonly QuestionRow[],
    missingPassage: ReadonlySet<number>,
  ): Promise<Graded[]> {
    if (questions.length === 0) {
      // Every question was flagged by the safety screen: nothing goes to a model (RV-child-safety-5).
      if (this.ctx.status === 'checking') await this.transition('verifying');
      return [];
    }
    // Synthetic refs: printed numbers repeat across pages, so the model never keys on them.
    const refs = questions.map((q, i) => ({ ref: `q${i + 1}`, q }));
    // Grading and its independent verification are admitted together: once grading is paid for,
    // the check that makes it usable is not refused halfway.
    const { verification, pending, early } = await this.spending(
      ['grading', 'verification'],
      async () => {
        const grading = await this.stage<typeof PROMPTS.grading.outputSchema>(PROMPTS.grading, [
          dataEnvelope({
            gradeLevel: this.ctx.gradeLevel,
            pagesMissingSourcePassage: [...missingPassage],
            questions: refs.map(({ ref, q }) => ({
              questionNumber: ref,
              prompt: q.prompt,
              studentAnswer: q.answer,
              answerKind: q.answer_kind,
              subject: q.subject_key,
            })),
          }),
        ]);
        const primaryByRef = new Map(grading.results.map((r) => [r.questionNumber, r]));
        if (this.ctx.status === 'checking') await this.transition('verifying');

        const pending: {
          ref: string;
          q: QuestionRow;
          primary: GradingOutput['results'][number];
        }[] = [];
        const early: Graded[] = [];
        for (const { ref, q } of refs) {
          const primary = primaryByRef.get(ref) ?? null;
          if (isBlank(q.answer)) {
            early.push(
              this.graded(q, 'unanswered', 'deterministic', false, primary, null, {
                reason: 'BLANK',
              }),
            );
          } else if (q.answer_kind === 'writing') {
            // Writing gets rubric feedback only; it is never forced into right/wrong (spec P5).
            early.push(
              this.graded(q, 'rubric', 'deterministic', false, primary, null, {
                reason: 'RUBRIC_FEEDBACK_ONLY',
              }),
            );
          } else if (primary === null) {
            early.push(
              this.graded(q, 'needs_parent_review', 'parent_review', false, null, null, {
                reason: 'NO_MODEL_RESULT',
              }),
            );
          } else {
            pending.push({ ref, q, primary });
          }
        }

        let verification: VerificationOutput | null = null;
        if (pending.length > 0) {
          try {
            verification = await this.stage<typeof PROMPTS.verification.outputSchema>(
              PROMPTS.verification,
              [
                dataEnvelope({
                  gradeLevel: this.ctx.gradeLevel,
                  questions: pending.map(({ ref, q, primary }) => ({
                    questionNumber: ref,
                    prompt: q.prompt,
                    studentAnswer: q.answer,
                    answerKind: q.answer_kind,
                    proposedVerdict: primary.verdict,
                  })),
                }),
              ],
            );
          } catch (error) {
            // Without an independent check nothing is accepted: those items go to a grown-up. That
            // includes a verification request too large for its stage budget (LJA-F4): the paid
            // grading is kept for review instead of failing the scan.
            const tooLarge = error instanceof PermanentFailure && error.code === 'STAGE_LIMIT';
            if (!(error instanceof RetryableFailure) && !tooLarge) throw error;
            verification = null;
          }
        }
        return { verification, pending, early };
      },
    );
    const verifierByRef = new Map((verification?.results ?? []).map((r) => [r.questionNumber, r]));

    const resolved = pending.map(({ ref, q, primary }) => {
      const capture: CaptureIssue[] = missingPassage.has(q.page_number)
        ? ['missing_passage']
        : q.uncertainty === 'high'
          ? ['answer_source_uncertain']
          : [];
      // Model-free key (bare arithmetic prompt): decisive evidence on its own (AC_GRADING_04).
      const promptKey = q.answer_kind === 'numeric' ? computePromptKey(q.prompt) : null;
      let deterministic: DeterministicVerdict | undefined;
      let deterministicReason: string | null = null;
      if (promptKey !== null) {
        const outcome = gradeObjectiveQuestion({
          kind: 'numeric',
          studentAnswer: q.answer ?? '',
          expected: { value: promptKey },
          captureIssues: capture,
        });
        deterministicReason = outcome.reason;
        if (decisive(outcome.verdict)) deterministic = outcome.verdict;
      }
      // The model's key compared with exact arithmetic (equivalent fractions, units, spelling
      // variants): replaces the model's own comparison, but is still model evidence, not proof.
      const keyed = objectiveQuestion(
        q.answer_kind,
        q.answer ?? '',
        primary.correctAnswer,
        capture,
      );
      const keyedOutcome = keyed ? gradeObjectiveQuestion(keyed) : null;
      const primaryVerdict: ModelVerdict =
        keyedOutcome && decisive(keyedOutcome.verdict)
          ? keyedOutcome.verdict
          : modelVerdict(primary.verdict);
      const primaryJudgment: ModelJudgment = {
        verdict: capture.length > 0 ? 'unresolved' : primaryVerdict,
        confidence: CONFIDENCE[primary.confidence],
      };
      const v = verifierByRef.get(ref);
      const verifier: ModelJudgment | undefined = v
        ? {
            verdict: capture.length > 0 ? 'unresolved' : modelVerdict(v.verdict),
            confidence: CONFIDENCE[v.confidence],
          }
        : undefined;
      // RV-grading-1 at scan level: an answer that only restates the computation ('35 ÷ 5' for
      // '35 ÷ 5 =') is not a final answer. When the key is a plain value (the prompt-computed key,
      // or a model key that is not itself an expression), no model agreement may grade it
      // correct; a grown-up decides. Prompts that ask for an expression keep an expression key.
      const restatesComputation =
        deterministicReason === 'UNEVALUATED_EXPRESSION' ||
        (promptKey === null &&
          keyedOutcome?.reason === 'UNEVALUATED_EXPRESSION' &&
          plainValueKey(primary.correctAnswer));
      const resolution = restatesComputation
        ? ({ final: 'needs_parent_review', route: 'parent_review', disagreement: false } as const)
        : resolveGrading({
            ...(deterministic ? { deterministic } : {}),
            primary: primaryJudgment,
            ...(verifier ? { verifier } : {}),
            // Escalation to a stronger model is not wired yet; unsettled items go to parent review.
            escalationBudgetRemaining: 0,
          });
      return this.graded(
        q,
        resolution.final,
        resolution.route,
        resolution.disagreement,
        primary,
        promptKey,
        {
          deterministic: deterministic ?? null,
          deterministicReason,
          modelKeyCheck: keyedOutcome?.reason ?? null,
          // The model's own verdict is kept for audit; exact comparison against its key replaces it.
          modelVerdict: primary.verdict,
          primary: primaryJudgment.verdict,
          verifier: verifier?.verdict ?? null,
          verifierAvailable: verification !== null,
          capture,
        },
      );
    });
    return [...early, ...resolved];
  }

  private graded(
    question: QuestionRow,
    final: Graded['final'],
    route: Graded['route'],
    disagreement: boolean,
    primary: GradingOutput['results'][number] | null,
    promptKey: string | null,
    detail: Record<string, unknown>,
  ): Graded {
    return {
      question,
      final,
      route,
      disagreement,
      private: primary,
      promptKey,
      provenance: {
        graderVersion: GRADER_VERSION,
        prompts: [
          PROMPTS.extraction.version,
          PROMPTS.grading.version,
          PROMPTS.verification.version,
        ],
        ...detail,
      },
    };
  }

  // ---- results, feedback, evidence ------------------------------------------------------------

  private async finish(graded: readonly Graded[], unsettledElsewhere = false): Promise<void> {
    await this.guardedWrite(async (tx) => {
      for (const g of graded) {
        if (g.private) {
          await tx`
            insert into private.question_solutions
              (question_id, family_id, correct_answer, worked_solution, rubric, misconception, evidence,
               grading_provenance, grader_version)
            values (${g.question.id}, ${this.ctx.familyId}, ${g.private.correctAnswer}, ${g.private.workedSolution},
                    ${g.private.rubric ? JSON.stringify(g.private.rubric) : null}::text::jsonb, ${g.private.misconception},
                    ${JSON.stringify({ summary: g.private.evidence })}::text::jsonb,
                    ${JSON.stringify(g.provenance)}::text::jsonb, ${GRADER_VERSION})
            on conflict (question_id) do update
              set correct_answer = excluded.correct_answer, worked_solution = excluded.worked_solution,
                  rubric = excluded.rubric, misconception = excluded.misconception, evidence = excluded.evidence,
                  grading_provenance = excluded.grading_provenance, grader_version = excluded.grader_version,
                  updated_at = now()
          `;
        }
        await tx`
          insert into public.question_results (question_id, family_id, child_id, verdict, route, disagreement, grader_version)
          values (${g.question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${g.final}, ${g.route}, ${g.disagreement}, ${GRADER_VERSION})
          on conflict (question_id) do update
            set verdict = excluded.verdict, route = excluded.route, disagreement = excluded.disagreement,
                grader_version = excluded.grader_version, graded_at = now()
        `;
        await this.recordAttempt(tx, g);
      }
    });

    for (const g of graded) {
      // Moderation before generation: a severe-risk answer or prompt is never sent to the tutor.
      // screenBeforeGrading already kept flagged questions out of grading; this is the backstop, on
      // the same word-list and provider flags (every graded question was screened in this run).
      const input =
        this.inputScreens.get(g.question.id) ??
        childInputScreen(
          screenQuestion({
            prompt: g.question.prompt,
            answer: g.question.answer,
            subject: g.question.subject_key,
            ageBand: this.ctx.ageBand,
          }),
          null,
        );
      const step = feedbackStep({
        severe: input.screen.level === 'severe' && !this.clearedFlags.has(g.question.id),
        final: g.final,
        hasPrivate: g.private !== null,
        parentOverride: g.question.parent_override,
      });
      if (step === 'safety') await this.safetyResponse(g.question, input);
      else if (step === 'coach') await this.coach(g);
      else if (step === 'rubric') await this.rubricFeedback(g);
    }

    const needsReview =
      unsettledElsewhere ||
      graded.some((g) => {
        const shown = g.question.parent_override ?? g.final;
        return shown === 'needs_parent_review' || shown === 'unresolved';
      });
    await this.transition(needsReview ? 'needs_parent_review' : 'ready');
  }

  /** First-attempt evidence (spec P7); a regrade after a correction is an override, never a rewrite. */
  private async recordAttempt(tx: Tx, g: Graded): Promise<void> {
    // The parent's override already corrected this question's evidence; a machine regrade never
    // overrules it, so the verdict shown and the evidence learned from stay the same.
    if (g.question.parent_override !== null) return;
    const correctness =
      g.final === 'correct' || g.final === 'incorrect'
        ? g.final
        : g.final === 'needs_parent_review' || g.final === 'unresolved'
          ? 'unresolved'
          : null;
    if (correctness === null) return; // blank or rubric-only work is not skill evidence
    const [existing] = await tx<{ id: string; correctness: string }[]>`
      select id, correctness from public.attempts
       where question_instance_id = ${g.question.id} and attempt_number = 1
    `;
    if (!existing) {
      await tx`
        insert into public.attempts (family_id, child_id, question_instance_id, source, subject_key, skill,
                                     attempt_number, correctness, grader_version, idempotency_key, occurred_at)
        values (${this.ctx.familyId}, ${this.ctx.childId}, ${g.question.id}, 'homework', ${g.question.subject_key},
                ${g.question.skill}, 1, ${correctness}, ${GRADER_VERSION}, ${`homework:${g.question.id}:1`}, ${this.deps.clock()})
        on conflict (idempotency_key) do nothing
      `;
      return;
    }
    const [latest] = await tx<{ correctness: string }[]>`
      select correctness from public.attempt_overrides where attempt_id = ${existing.id}
       order by created_at desc limit 1
    `;
    const current = latest?.correctness ?? existing.correctness;
    if (current !== correctness && g.question.corrected_by) {
      await tx`
        insert into public.attempt_overrides (attempt_id, family_id, correctness, reason, overridden_by)
        values (${existing.id}, ${this.ctx.familyId}, ${correctness}, 'Regraded after a parent transcription correction',
                ${g.question.corrected_by})
      `;
    }
  }

  /**
   * The key the tutor may see and every form of it the guard must withhold, or null when coaching
   * must fall back to the reviewed template. When the model-free prompt key decided the question,
   * that key is the one protected and given to the tutor; a model key that disagrees with it means
   * the model's solution and misconception are unreliable, so no tutor call is made (RV-7).
   */
  private coachingKey(g: Graded): { tutorKey: string; answers: ProtectedAnswer[] } | null {
    const kind = g.question.answer_kind;
    const modelKey = g.private?.correctAnswer ?? '';
    if (g.promptKey !== null) {
      if (!keysAgree(g.promptKey, modelKey)) {
        this.deps.log({ level: 'warn', event: 'coaching_key_mismatch', code: 'TEMPLATE' });
        return null;
      }
      const fromPrompt = protectedAnswers(kind, g.promptKey);
      const fromModel = protectedAnswers(kind, modelKey);
      if (fromPrompt.length === 0 || fromModel.length === 0) return null;
      const answers = uniqueAnswers([...fromPrompt, ...fromModel]);
      if (answers.length > MAX_PROTECTED_ANSWERS) return null;
      return { tutorKey: g.promptKey, answers };
    }
    const answers = protectedAnswers(kind, modelKey);
    return answers.length > 0 ? { tutorKey: modelKey, answers } : null;
  }

  private async coach(g: Graded): Promise<void> {
    const [existing] = await this.deps.db.asService(
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from public.child_feedback f
          join public.extracted_questions q on q.id = f.question_id
         where f.question_id = ${g.question.id} and f.created_at >= coalesce(q.corrected_at, '-infinity'::timestamptz)
           -- A safety notice a reviewer cleared as a false match is not coaching (round 3).
           and f.kind <> 'safety'
      `,
    );
    if ((existing?.n ?? 0) > 0) return; // already coached for this transcription (crash replay)

    let rows: { kind: string; body: string }[] | null = null;
    const key = this.coachingKey(g);
    if (key !== null) {
      try {
        rows = await this.spending(['coaching'], async () => {
          const packet = await this.stage<typeof PROMPTS.coaching.outputSchema>(PROMPTS.coaching, [
            dataEnvelope({
              gradeLevel: this.ctx.gradeLevel,
              ageBand: this.ctx.ageBand,
              skill: g.question.skill,
              question: g.question.prompt,
              studentAnswer: g.question.answer,
              likelyMisconception: g.private?.misconception ?? null,
              // Given so hints are accurate; the guard below blocks any leak of it.
              answerForTutorOnly: key.tutorKey,
            }),
          ]);
          // Expressions are read as their value ("6 × 7" discloses 42), explicitly (L-012).
          const decision = guardChildContent({
            packet,
            answers: key.answers,
            options: { evaluateExpressions: true },
          });
          if (decision.decision === 'release') {
            // Moderation after generation, grounded in the printed question and its subject.
            const safety = screenModelOutput(
              [...packet.steps.map((s) => s.text), packet.retryPrompt],
              {
                ageBand: this.ctx.ageBand,
                context: { prompt: g.question.prompt, subject: g.question.subject_key },
              },
            );
            if (safety.level === 'severe') {
              this.deps.log({
                level: 'warn',
                event: 'coaching_blocked_by_safety',
                code: safetyCode(safety),
              });
              return null;
            }
            return [
              ...packet.steps.map((s) => ({ kind: FEEDBACK_KIND[s.kind], body: s.text })),
              { kind: 'encouragement', body: packet.retryPrompt },
            ];
          }
          this.deps.log({
            level: 'warn',
            event: 'coaching_blocked_by_guard',
            code: decision.reasons[0]?.code ?? 'BLOCKED',
          });
          return null;
        });
        // Provider moderation after generation: the packet as the child would read it.
        if (rows !== null) rows = await this.moderatedCoaching(rows);
      } catch (error) {
        if (error instanceof SpendCeilingReached) {
          // Coaching is optional: past the ceiling the child gets the reviewed template instead.
          this.deps.log({ level: 'warn', event: 'coaching_skipped', code: 'SPEND_CEILING' });
        } else if (!(error instanceof RetryableFailure) && !(error instanceof PermanentFailure)) {
          throw error;
        }
      }
    }
    // Never unchecked output: a blocked, failed or unguardable packet becomes the reviewed template.
    const feedback = rows ?? [{ kind: 'template_fallback', body: TEMPLATE_FALLBACK }];
    await this.guardedWrite(async (tx) => {
      for (const row of feedback) {
        await tx`
          insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
          values (${g.question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${row.kind}, ${row.body}, ${GUARD_VERSION})
        `;
      }
    });
  }

  /**
   * Provider moderation of a released coaching packet (spec P4; AC_SECURITY_02): the rows, or null
   * (the reviewed template) when any text is flagged or moderation fails: exactly as a word-list
   * severe output. Only codes are logged.
   */
  private async moderatedCoaching(
    rows: { kind: string; body: string }[],
  ): Promise<{ kind: string; body: string }[] | null> {
    const checked = await this.moderate(
      rows.map((r) => r.body),
      'coaching',
    );
    if (!checked.ok) {
      this.deps.log({ level: 'warn', event: 'coaching_blocked_by_moderation', code: checked.code });
      return null;
    }
    const flagged = checked.results.find(moderationFlagged);
    if (flagged !== undefined) {
      this.deps.log({
        level: 'warn',
        event: 'coaching_blocked_by_safety',
        code: `SAFETY_${providerModerationCodes(flagged)[0] ?? 'PROVIDER_FLAGGED'}`,
      });
      return null;
    }
    return rows;
  }

  /**
   * The rubric criteria a child may be shown after provider moderation (spec P4; AC_SECURITY_02),
   * checked BEFORE childRubricFeedback turns them into labels: a flagged criterion is dropped (a
   * SAFETY_PROVIDER_* code is logged) and a moderation failure drops them all (null). Rubric labels
   * fail closed: a dropped label costs only a missing row.
   */
  private async moderatedCriteria<T extends { readonly criterion: string }>(
    rubric: readonly T[] | null,
  ): Promise<readonly T[] | null> {
    if (rubric === null || rubric.length === 0) return rubric;
    const checked = await this.moderate(
      rubric.map((r) => r.criterion),
      'rubric_criteria',
    );
    if (!checked.ok) {
      this.deps.log({
        level: 'warn',
        event: 'rubric_label_blocked_by_moderation',
        code: checked.code,
      });
      return null;
    }
    return rubric.filter((_, i) => {
      const item = checked.results[i]!;
      if (!moderationFlagged(item)) return true;
      this.deps.log({
        level: 'warn',
        event: 'rubric_label_blocked_by_safety',
        code: `SAFETY_${providerModerationCodes(item)[0] ?? 'PROVIDER_FLAGGED'}`,
      });
      return false;
    });
  }

  /**
   * Rubric feedback for written work: criterion labels in fixed wording, never the model's notes or
   * any example text (rubric-feedback.ts). No AI call; when no label is safe to show, the child app
   * asks the child to go over the writing with a grown-up.
   */
  private async rubricFeedback(g: Graded): Promise<void> {
    // Labels are model output: each row is checked against the private key and the example wording
    // in the parent-only solution before a child can read it (LJA-F1).
    const answers = g.private ? rubricProtectedAnswers(g.private) : null;
    if (answers === null) {
      this.deps.log({
        level: 'warn',
        event: 'rubric_label_blocked_by_guard',
        code: 'UNPROTECTABLE',
      });
      return;
    }
    // Provider moderation of the criteria first; the word-list screen and the leak guard follow.
    const criteria = await this.moderatedCriteria(g.private?.rubric ?? null);
    if (criteria === null) return;
    const rows = childRubricFeedback(criteria, {
      ageBand: this.ctx.ageBand,
      context: { prompt: g.question.prompt, subject: g.question.subject_key },
      onSafetyReject: (code) =>
        this.deps.log({ level: 'warn', event: 'rubric_label_blocked_by_safety', code }),
      protectedAnswers: answers,
      onLeak: (code) =>
        this.deps.log({ level: 'warn', event: 'rubric_label_blocked_by_guard', code }),
    });
    if (rows.length === 0) return;
    await this.guardedWrite(async (tx) => {
      const [existing] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.child_feedback f
          join public.extracted_questions q on q.id = f.question_id
         where f.question_id = ${g.question.id} and f.created_at >= coalesce(q.corrected_at, '-infinity'::timestamptz)
           -- A safety notice a reviewer cleared as a false match is not a rubric row (round 3).
           and f.kind <> 'safety'
      `;
      if ((existing?.n ?? 0) > 0) return; // already written for this transcription (crash replay)
      for (const row of rows) {
        await tx`
          insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
          values (${g.question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, ${row.kind}, ${row.body}, ${GUARD_VERSION})
        `;
      }
    });
  }

  /**
   * Moderation before generation (spec P4; RV-child-safety-5): screens every question before any
   * grading call and answers the flagged ones here, so a grading failure, a spend-ceiling pause or
   * a dead-lettered job can neither send the text to a model nor delay the template and report.
   * Returns the questions that may be graded. A question flagged for an earlier transcription keeps
   * its notice (RV-child-safety-7). A reviewer's false-match clearance (round 3, CHK2-CS-5) is
   * honoured per question and transcription: a severe screen of the transcription the reviewer
   * cleared is graded normally, and a notice kept from an earlier transcription is dropped once
   * every flag on the question was cleared. A corrected transcription is screened afresh. Round 4
   * (CHK3-CS-8): a question is graded only once EVERY system report on it is cleared, so clearing
   * one of two reports (the original and a corrected transcription's) keeps the notice and grades
   * nothing: the child never gets hints next to a notice, and the child route shows the notice
   * until the last report is cleared (homework.ts). Round 5: the screen is the word list merged
   * with provider moderation of the child's answers (one call per run; see `moderate`); when that
   * call fails nothing is graded, the flags found are answered (held), and the run fails closed.
   */
  private async screenBeforeGrading(questions: readonly QuestionRow[]): Promise<QuestionRow[]> {
    const ids = questions.map((q) => q.id);
    const state = new Map(
      (
        await this.deps.db.asService(
          (tx) => tx<
            {
              id: string;
              flagged: boolean;
              cleared_now: boolean;
              all_cleared: boolean;
            }[]
          >`
            select q.id,
                   exists (select 1 from public.child_feedback f
                            where f.question_id = q.id and f.family_id = q.family_id
                              and f.kind = 'safety') as flagged,
                   exists (select 1 from public.safety_reports s
                            where s.question_id = q.id and s.family_id = q.family_id
                              and s.reporter_kind = 'system' and s.resolution = 'false_match'
                              and s.transcription_at = coalesce(q.corrected_at, q.created_at)) as cleared_now,
                   exists (select 1 from public.safety_reports s
                            where s.question_id = q.id and s.family_id = q.family_id
                              and s.reporter_kind = 'system')
                   and not exists (select 1 from public.safety_reports s
                                    where s.question_id = q.id and s.family_id = q.family_id
                                      and s.reporter_kind = 'system'
                                      and s.resolution is distinct from 'false_match') as all_cleared
              from public.extracted_questions q
             where q.family_id = ${this.ctx.familyId} and q.id = any(${ids}::uuid[])`,
        )
      ).map((r) => [r.id, r] as const),
    );
    // Provider moderation of the child's own words, all answers in one call. Never the printed
    // prompt: worksheets quote characters and lessons, and a held code on a printed prompt is a
    // defect (round 5, CHK4-CS-4/5). A blank answer has nothing to send.
    const answered = questions.filter((q) => !isBlank(q.answer));
    const moderated = await this.moderate(
      answered.map((q) => q.answer ?? ''),
      'child_answers',
    );
    const flags = new Map<string, ModerationResultItem>(
      moderated.ok ? answered.map((q, i) => [q.id, moderated.results[i]!] as const) : [],
    );
    const toGrade: QuestionRow[] = [];
    for (const question of questions) {
      const known = state.get(question.id);
      const input = childInputScreen(
        screenQuestion({
          prompt: question.prompt,
          answer: question.answer,
          subject: question.subject_key,
          ageBand: this.ctx.ageBand,
        }),
        flags.get(question.id) ?? null,
      );
      this.inputScreens.set(question.id, input);
      // Every provider flag on the child's words is logged as a code, including those without a
      // PencilLift category (harassment, hate, illicit), which only log.
      for (const code of input.providerCodes) {
        this.deps.log({ level: 'warn', event: 'moderation_flag_child_input', code });
      }
      const screen = input.screen;
      if (screen.level === 'severe' && known?.cleared_now && known.all_cleared) {
        if (!moderated.ok) continue; // cleared, but nothing is graded unmoderated
        this.clearedFlags.add(question.id);
        this.deps.log({
          level: 'info',
          event: 'safety_flag_cleared_graded',
          code: 'SAFETY_CLEARED',
        });
        toGrade.push(question);
      } else if (screen.level === 'severe') {
        // Without the provider's answer the word-list flag is still answered at once, held from
        // the family: the provider might have added a held category the report cannot get later.
        await this.safetyResponse(question, input, !moderated.ok);
      } else if (known?.flagged && !known.all_cleared) {
        await this.keepSafetyNotice(question);
      } else {
        toGrade.push(question);
      }
    }
    if (!moderated.ok) {
      // FAIL CLOSED: no model call and no model output in this attempt. A retryable failure retries
      // the job (the stored questions are screened again); any other ends it like a missing provider.
      throw moderated.retryable
        ? new RetryableFailure(moderated.code)
        : new PermanentFailure(moderated.code);
    }
    return toGrade;
  }

  /**
   * A grown-up corrected the transcription of a flagged answer (RV-child-safety-7). The child keeps
   * the reviewed template (a copy for the current transcription: the child route shows only feedback
   * written for it), the tutor is not called, and no new report is filed for the corrected text; the
   * earlier report stays in the owner's queue, which shows that the flagged answer was corrected.
   */
  private async keepSafetyNotice(question: QuestionRow): Promise<void> {
    const copied = await this.guardedWrite(async (tx) => {
      const [current] = await tx<{ corrected_at: Date | null }[]>`
        select corrected_at from public.extracted_questions
         where id = ${question.id} and family_id = ${this.ctx.familyId}`;
      if (!current) return false;
      const [shown] = await tx<{ id: string }[]>`
        select id from public.child_feedback
         where question_id = ${question.id} and kind = 'safety'
           and created_at >= coalesce(${current.corrected_at}::timestamptz, '-infinity'::timestamptz)
         limit 1`;
      if (shown) return false;
      const [latest] = await tx<{ body: string; guard_version: string }[]>`
        select body, guard_version from public.child_feedback
         where question_id = ${question.id} and kind = 'safety'
         order by created_at desc limit 1`;
      if (!latest) return false;
      await tx`
        insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
        values (${question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, 'safety', ${latest.body},
                ${latest.guard_version})`;
      return true;
    });
    if (copied) {
      this.deps.log({ level: 'warn', event: 'safety_notice_kept', code: 'SAFETY_CORRECTED' });
    }
  }

  /**
   * A severe-risk answer (spec P4; AC_SECURITY_02): the reviewed safety template for the child and
   * an escalated system report for the owner's queue, in one transaction, once per question per
   * transcription (a replay finds both and adds nothing). No model call is made for the question.
   * The report holds ids, the screen's category codes and versions: never homework text. Its audit
   * row names the layer that flagged it (word list, provider moderation or both) and the PROVIDER_*
   * codes.
   */
  private async safetyResponse(
    question: QuestionRow,
    input: InputScreen,
    moderationUnavailable = false,
  ): Promise<void> {
    const screen = input.screen;
    const categories = screen.categories.filter(isReportCategory);
    // Owner decision (2026-09-25): the parent is the sole recipient of every flag, so no report is
    // held from the family (FAMILY_HOLD_CATEGORIES is empty and heldFromFamily() is always false;
    // the hold mechanism stays in the schema as a support tool). A word-list flag answered while
    // provider moderation failed is filed visible like any other; the outage is recorded in the
    // audit row's metadata (providerModeration: 'unavailable') for the reviewer, never as a hold.
    const held = heldFromFamily(screen.categories);
    const body = childSafetyMessage(screen.categories, this.ctx.ageBand);
    const filed = await this.guardedWrite(async (tx) => {
      const [current] = await tx<{ corrected_at: Date | null }[]>`
        select corrected_at from public.extracted_questions
         where id = ${question.id} and family_id = ${this.ctx.familyId}`;
      if (!current) return false;
      const [existing] = await tx<{ id: string }[]>`
        select id from public.child_feedback
         where question_id = ${question.id} and kind = 'safety'
           and created_at >= coalesce(${current.corrected_at}::timestamptz, '-infinity'::timestamptz)
         order by created_at desc limit 1`;
      let feedbackId = existing?.id;
      if (feedbackId === undefined) {
        const [created] = await tx<{ id: string }[]>`
          insert into public.child_feedback (question_id, family_id, child_id, kind, body, guard_version)
          values (${question.id}, ${this.ctx.familyId}, ${this.ctx.childId}, 'safety', ${body},
                  ${SAFETY_TEMPLATES_VERSION})
          returning id`;
        feedbackId = created!.id;
      }
      if (categories.length === 0) return false;
      const [report] = await tx<{ id: string }[]>`
        insert into public.safety_reports
          (family_id, child_id, reporter_kind, category, question_id, feedback_id, status,
           transcription_at, screen_categories, screen_version, family_visible)
        values (${this.ctx.familyId}, ${this.ctx.childId}, 'system', 'severe_risk', ${question.id},
                ${feedbackId}, 'escalated',
                -- Read in SQL, not through a JS Date: microseconds are kept, so the admin queue can
                -- tell a later correction from this transcription.
                (select coalesce(q.corrected_at, q.created_at) from public.extracted_questions q
                  where q.id = ${question.id}),
                ${categories}::text[], ${SAFETY_SCREEN_VERSION}, ${!held})
        on conflict (question_id, transcription_at) where reporter_kind = 'system' do nothing
        returning id`;
      if (!report) return false;
      await tx`
        insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
        values (${held ? null : this.ctx.familyId}, 'system', 'safety_report.created', 'safety_report', ${report.id},
                ${JSON.stringify({
                  category: 'severe_risk',
                  // Which layer flagged it, so reviewers see the source (PROVIDER_* codes).
                  source: input.source ?? 'safety_screen',
                  screenVersion: SAFETY_SCREEN_VERSION,
                  ...(input.providerCodes.length > 0 ? { providerCodes: input.providerCodes } : {}),
                  ...(moderationUnavailable ? { providerModeration: 'unavailable' } : {}),
                })}::text::jsonb)`;
      // Owner decision (2026-09-25): the parent is the only person PencilLift sends a safety
      // message to. A report in the family's list is announced to the active guardians by email,
      // as durable work in the job ledger (dispatcher.ts safetyFlagEmailHandler), once per report
      // and with the report id only; due at this job's clock like the other inserts of this run.
      // A held report has nothing for the family to look at (none is filed held since the
      // decision; the mechanism stays as a support tool).
      if (!held) {
        await tx`
          insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, run_after)
          values ('safety_flag_email', ${`safety-flag-email:${report.id}`}, ${this.ctx.familyId},
                  ${this.ctx.childId}, ${tx.json({ reportId: report.id })}, ${this.deps.clock()})
          on conflict (idempotency_key) do nothing`;
      }
      return true;
    });
    if (filed) {
      for (const category of screen.categories) {
        this.deps.log({
          level: 'warn',
          event: 'safety_screen_severe',
          code: `SAFETY_${category.toUpperCase()}`,
        });
      }
      for (const code of input.providerCodes) {
        this.deps.log({ level: 'warn', event: 'safety_screen_severe', code });
      }
    }
  }

  // ---- recheck after a parent correction ------------------------------------------------------

  async recheck(questionIds: readonly string[]): Promise<void> {
    // `verifying` means a previous worker died after grading started; grading is idempotent.
    if (this.ctx.status !== 'checking' && this.ctx.status !== 'verifying') return;
    await this.assertMayProcess();
    const questions = await this.loadQuestions(questionIds.length > 0 ? questionIds : undefined);
    if (questions.length === 0) {
      await this.transition('needs_parent_review', 'NO_QUESTIONS_FOUND');
      return;
    }
    const graded = await this.grade(await this.screenBeforeGrading(questions), new Set());
    // Other questions keep their results; the assignment state reflects all of them.
    const ids = new Set(graded.map((g) => g.question.id));
    const others = await this.deps.db.asService(
      (tx) => tx<
        { question_id: string; verdict: string; parent_override_verdict: string | null }[]
      >`
        select r.question_id, r.verdict, r.parent_override_verdict from public.question_results r
          join public.extracted_questions q on q.id = r.question_id
         where q.assignment_id = ${this.ctx.id} and q.family_id = ${this.ctx.familyId}
      `,
    );
    const unsettledElsewhere = others.some(
      (r) =>
        !ids.has(r.question_id) &&
        r.parent_override_verdict === null &&
        (r.verdict === 'needs_parent_review' || r.verdict === 'unresolved'),
    );
    await this.finish(graded, unsettledElsewhere);
  }
}
